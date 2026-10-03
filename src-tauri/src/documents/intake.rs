//! Intake: the one door a path walks through before a document is loaded (SECURITY I3, ARCHITECTURE §4).
//!
//! A path reaches the backend only from the Rust side: the native open dialog, a file dropped on the window, the OS asking
//! the app to open a file (macOS), or the command line of a launch or of a second instance (Windows). Whatever the source,
//! [`admit`] does the same: it canonicalizes the path, opens the file **once**, and judges that open handle: a regular file
//! of at most 2 GiB with `%PDF-` in its first 1024 bytes. The handle goes on to PDFium as it is (`Engine::open`), so the file
//! that was judged is the file that is loaded. Checking a path and then opening it by path would leave a gap in which
//! something else could be put at that path (a different file, a FIFO, a link); there is no such gap here.
//!
//! The registry then dedupes by the canonical path (`Registry::claim`) and the engine loads the handle.

use std::ffi::OsString;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use crate::error::{AppError, ErrorCode};
use crate::limits;
use crate::storage::open_without_blocking;

/// A file that passed intake: its canonical path (the registry's key, never sent to the UI) and the open handle that was
/// judged, positioned at the start.
#[derive(Debug)]
pub struct Admitted {
    pub path: PathBuf,
    pub file: File,
}

/// Canonicalizes `path`, opens it and checks the open handle (see the module documentation).
///
/// Errors: `io_not_found`, `io_permission_denied`, `io_in_use` from the OS; `not_a_pdf` for a directory, a device, a FIFO,
/// an empty file or one without the signature; `too_large` above 2 GiB.
pub fn admit(path: &Path) -> Result<Admitted, AppError> {
    admit_within(path, limits::MAX_PDF_FILE_BYTES)
}

/// [`admit`] with another size limit, so a test can cross it without a file of 2 GiB.
fn admit_within(path: &Path, max_bytes: u64) -> Result<Admitted, AppError> {
    // Before the file system is touched at all: a remote or device path would make the open wait on a network or a driver.
    // A mapped drive (`Z:\` for a share) cannot be told from a local one by its spelling, and the drive type needs `unsafe` or a
    // dependency; so the first open may wait on the network, and the canonical path (a `\\?\UNC\` one) refuses it afterwards
    // (ADR-027).
    refuse_unsafe_spelling(path)?;
    // The handle comes first and is judged; the registry key is derived afterwards and must name the very file the handle is
    // (below), so the key is the handle's and not whatever the path pointed at a moment earlier.
    let mut file = open_without_blocking(path)?;
    check_handle(&mut file, max_bytes)?;
    // Symlinks and `..` are resolved here, so two names of one file are one path and a link to a directory is a directory.
    let canonical = std::fs::canonicalize(path)?;
    refuse_unsafe_spelling(&canonical)?;
    let other = open_without_blocking(&canonical)?;
    if !same_file(&file, &other)? {
        return Err(AppError::logged(
            ErrorCode::IoInUse,
            "the path changed while it was being opened",
        ));
    }
    Ok(Admitted {
        path: canonical,
        file,
    })
}

/// Whether two open handles are one file: the file's identity from the OS, never its size or times (a file swapped for one of the
/// same size and times would pass those). Unix: device and inode. Windows: volume serial number and file index, read from the
/// handles by the `same-file` crate (which keeps the `unsafe` that `std` does not offer; this crate forbids it). Elsewhere, where
/// neither exists, size and times of last write and of creation.
fn same_file(a: &File, b: &File) -> std::io::Result<bool> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let (a, b) = (a.metadata()?, b.metadata()?);
        Ok(a.dev() == b.dev() && a.ino() == b.ino())
    }
    #[cfg(windows)]
    {
        // `Handle::from_file` takes the file: clones are used so that the judged handle stays ours.
        Ok(same_file::Handle::from_file(a.try_clone()?)?
            == same_file::Handle::from_file(b.try_clone()?)?)
    }
    #[cfg(not(any(unix, windows)))]
    {
        let (a, b) = (a.metadata()?, b.metadata()?);
        Ok(a.len() == b.len()
            && a.modified().ok() == b.modified().ok()
            && a.created().ok() == b.created().ok())
    }
}

/// Windows only: refuses a path that is not a plain local file name before anything is opened. That is a path that begins with two
/// separators other than the verbatim drive form `\\?\C:\` (a network share, `\\?\UNC\`, a device such as `\\.\COM1` or
/// `\\.\pipe\x`), and a name with a colon after the drive (an NTFS alternate data stream, `file.pdf:stream`, which is data
/// hidden in a file, not a document). Everywhere else every path passes.
fn refuse_unsafe_spelling(path: &Path) -> Result<(), AppError> {
    if !spelling_is_plain(path) {
        return Err(AppError::logged(
            ErrorCode::NotAPdf,
            "a network, device or stream path",
        ));
    }
    Ok(())
}

/// The path a Save As writes to, judged like an opened one (SECURITY I3, ADR-004): the spelling is plain, the folder exists and is
/// resolved (so `..` and links in the folder are gone), the name ends in `.pdf` (added if the dialog left it out), and what is there
/// already, if anything, is a regular file that is not a link: a folder, a device or a link is never written to. Nothing is created.
pub fn admit_target(path: &Path) -> Result<PathBuf, AppError> {
    refuse_unsafe_spelling(path)?;
    let Some(name) = path.file_name() else {
        return Err(AppError::invalid("path"));
    };
    let folder = match path.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent,
        _ => Path::new("."),
    };
    let folder = std::fs::canonicalize(folder)?;
    refuse_unsafe_spelling(&folder)?;
    let mut file_name = OsString::from(name);
    let is_pdf = Path::new(name)
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("pdf"));
    if !is_pdf {
        file_name.push(".pdf");
    }
    let target = folder.join(file_name);
    match std::fs::symlink_metadata(&target) {
        Ok(metadata) if metadata.is_file() => {}
        Ok(_) => {
            return Err(AppError::logged(
                ErrorCode::InvalidArgument,
                "the save target is a folder, a link or a device",
            ))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    Ok(target)
}

/// Whether the spelling of `path` is one the file system may be asked about: on Windows not a network, device or stream path (see
/// [`refuse_unsafe_spelling`]), elsewhere always. Shared with the recent files, which must never stat such a path (an SMB
/// connection leaks the user's NTLM hash).
pub fn spelling_is_plain(path: &Path) -> bool {
    !cfg!(windows) || windows_spelling_is_plain(&path.to_string_lossy())
}

/// The rule of [`refuse_unsafe_spelling`] on the text of a path (apart from the platform, so that it is tested everywhere).
fn windows_spelling_is_plain(text: &str) -> bool {
    let text = text.replace('/', "\\");
    let rest = match text.strip_prefix(r"\\?\") {
        Some(verbatim) if has_drive(verbatim) => verbatim,
        Some(_) => return false,
        None => text.as_str(),
    };
    if rest.starts_with(r"\\") {
        return false;
    }
    let after_drive = if has_drive(rest) { &rest[2..] } else { rest };
    !after_drive.contains(':')
}

/// Whether `text` begins with a drive letter and a colon.
fn has_drive(text: &str) -> bool {
    let bytes = text.as_bytes();
    bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
}

/// Judges an open handle and leaves it at the start. Everything is read from the handle, nothing from the path.
fn check_handle(file: &mut File, max_bytes: u64) -> Result<(), AppError> {
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Err(AppError::logged(
            ErrorCode::NotAPdf,
            "not a regular file (directory, device or pipe)",
        ));
    }
    if metadata.len() > max_bytes {
        return Err(AppError::too_large("file_size", max_bytes));
    }
    let mut head = Vec::with_capacity(limits::PDF_SNIFF_BYTES);
    file.by_ref()
        .take(limits::PDF_SNIFF_BYTES as u64)
        .read_to_end(&mut head)?;
    if !has_signature(&head) {
        return Err(AppError::logged(
            ErrorCode::NotAPdf,
            "no %PDF- signature in the first 1024 bytes",
        ));
    }
    // PDFium seeks to absolute positions, but the handle is handed on as it is: leave it where a fresh one would be.
    file.seek(SeekFrom::Start(0))?;
    Ok(())
}

/// Whether `head` (the first bytes of a file) holds the PDF signature.
fn has_signature(head: &[u8]) -> bool {
    head.windows(limits::PDF_SIGNATURE.len())
        .any(|window| window == limits::PDF_SIGNATURE)
}

/// The files named on a command line: `args` without the program name. Flags (a leading `-`), empty arguments and the bare word
/// (no dot, no separator) right after a `--option` (its value) are not files and are skipped; the OS
/// and the shell put nothing else there. A relative path is relative to `cwd`, the working
/// directory of the process that was started (the second instance's, for one forwarded to the running app). At most
/// `MAX_OPEN_BATCH + 1` are returned, one more than may be opened, so the caller can tell that there were too many.
pub fn paths_from_args(
    args: impl IntoIterator<Item = OsString>,
    cwd: Option<&Path>,
) -> Vec<PathBuf> {
    let mut after_option = false;
    args.into_iter()
        .filter(|arg| {
            let text = arg.to_string_lossy();
            if text.starts_with('-') {
                // `--name value`: the bare word after a long option is its value, not a file.
                after_option = text.starts_with("--") && !text.contains('=');
                return false;
            }
            let stray = after_option && !text.contains(['.', '/', '\\']);
            after_option = false;
            !arg.is_empty() && !stray
        })
        .map(|arg| match cwd {
            // `join` keeps an absolute path as it is.
            Some(cwd) => cwd.join(arg),
            None => PathBuf::from(arg),
        })
        .take(limits::MAX_OPEN_BATCH + 1)
        .collect()
}

/// The files of the URLs the OS asks the app to open (macOS `RunEvent::Opened`). Only `file:` URLs name a file; any other
/// scheme is ignored. Bounded like [`paths_from_args`].
pub fn paths_from_urls(urls: &[tauri::Url]) -> Vec<PathBuf> {
    urls.iter()
        .filter(|url| url.scheme() == "file")
        .filter_map(|url| url.to_file_path().ok())
        .take(limits::MAX_OPEN_BATCH + 1)
        .collect()
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::io::Read;

    use super::*;
    use crate::storage::atomic::testutil::TempDir;

    /// The smallest thing that passes the signature check; whether PDFium can load it is not intake's business.
    const MINIMAL: &[u8] = b"%PDF-1.4\n%%EOF\n";

    fn write(dir: &TempDir, name: &str, bytes: &[u8]) -> PathBuf {
        let path = dir.path().join(name);
        fs::write(&path, bytes).unwrap();
        path
    }

    fn code(result: Result<Admitted, AppError>) -> ErrorCode {
        result.unwrap_err().code()
    }

    fn canonical(path: &Path) -> PathBuf {
        fs::canonicalize(path).unwrap()
    }

    #[test]
    fn a_pdf_is_admitted_with_its_canonical_path_and_a_handle_at_the_start() {
        let dir = TempDir::new();
        let path = write(&dir, "a.pdf", MINIMAL);
        let mut admitted = admit(&path).unwrap();
        assert_eq!(admitted.path, canonical(&path));
        let mut bytes = Vec::new();
        admitted.file.read_to_end(&mut bytes).unwrap();
        assert_eq!(bytes, MINIMAL);
    }

    #[test]
    fn the_extension_does_not_matter_the_signature_does() {
        let dir = TempDir::new();
        assert!(admit(&write(&dir, "no-extension", MINIMAL)).is_ok());
        assert!(admit(&write(&dir, "a.txt", MINIMAL)).is_ok());
        let renamed = write(&dir, "fake.pdf", b"plain text, not a PDF at all");
        assert_eq!(code(admit(&renamed)), ErrorCode::NotAPdf);
    }

    #[test]
    fn a_file_that_is_not_a_pdf_is_refused() {
        let dir = TempDir::new();
        for (name, bytes) in [
            ("empty.pdf", &b""[..]),
            ("text.pdf", b"hello"),
            ("png.pdf", b"\x89PNG\r\n\x1a\n"),
            ("short.pdf", b"%PDF"),
            ("lower.pdf", b"%pdf-1.7"),
        ] {
            assert_eq!(
                code(admit(&write(&dir, name, bytes))),
                ErrorCode::NotAPdf,
                "{name}"
            );
        }
    }

    #[test]
    fn the_signature_may_follow_some_junk_but_only_inside_the_first_kilobyte() {
        let dir = TempDir::new();
        let sniff = limits::PDF_SNIFF_BYTES;
        let sig = limits::PDF_SIGNATURE.len();
        let with_signature_at = |at: usize| {
            let mut bytes = vec![b' '; at];
            bytes.extend_from_slice(limits::PDF_SIGNATURE);
            bytes.extend_from_slice(b"1.7\n");
            bytes
        };
        // Starting at byte 0 and ending exactly at byte 1024: still inside.
        for at in [0, 1, 100, sniff - sig] {
            let path = write(&dir, &format!("at-{at}.pdf"), &with_signature_at(at));
            assert!(admit(&path).is_ok(), "signature at {at}");
        }
        // One byte further it is cut by the end of the window.
        for at in [sniff - sig + 1, sniff, sniff + 100, 100_000] {
            let path = write(&dir, &format!("at-{at}.pdf"), &with_signature_at(at));
            assert_eq!(code(admit(&path)), ErrorCode::NotAPdf, "signature at {at}");
        }
    }

    #[test]
    fn a_file_over_the_size_limit_is_refused_before_it_is_read() {
        let dir = TempDir::new();
        let mut bytes = MINIMAL.to_vec();
        bytes.resize(100, b'\n');
        let path = write(&dir, "big.pdf", &bytes);
        // The limit is inclusive: a file of exactly the limit is fine, one byte more is not.
        assert!(admit_within(&path, 100).is_ok());
        let error = admit_within(&path, 99).unwrap_err();
        assert_eq!(error.code(), ErrorCode::TooLarge);
        // The real limit is 2 GiB (`limits::file_size_is_capped` pins the number).
        assert!(admit(&path).is_ok());
    }

    #[test]
    fn a_directory_is_not_a_pdf() {
        let dir = TempDir::new();
        let folder = dir.path().join("folder.pdf");
        fs::create_dir(&folder).unwrap();
        assert_eq!(code(admit(&folder)), ErrorCode::NotAPdf);
        assert_eq!(code(admit(dir.path())), ErrorCode::NotAPdf);
    }

    #[test]
    fn a_missing_file_is_not_found() {
        let dir = TempDir::new();
        assert_eq!(
            code(admit(&dir.path().join("missing.pdf"))),
            ErrorCode::IoNotFound
        );
    }

    #[test]
    fn dot_dot_names_the_same_file() {
        let dir = TempDir::new();
        fs::create_dir(dir.path().join("sub")).unwrap();
        let path = write(&dir, "a.pdf", MINIMAL);
        let roundabout = dir.path().join("sub").join("..").join("a.pdf");
        assert_eq!(admit(&roundabout).unwrap().path, admit(&path).unwrap().path);
    }

    /// A symlink, or `None` when the platform refuses (Windows needs a privilege or developer mode for it).
    fn symlink(target: &Path, link: &Path) -> Option<()> {
        #[cfg(unix)]
        let made = std::os::unix::fs::symlink(target, link);
        #[cfg(windows)]
        let made = if target.is_dir() {
            std::os::windows::fs::symlink_dir(target, link)
        } else {
            std::os::windows::fs::symlink_file(target, link)
        };
        #[cfg(not(any(unix, windows)))]
        let made: std::io::Result<()> = Err(std::io::Error::from(std::io::ErrorKind::Unsupported));
        match made {
            Ok(()) => Some(()),
            Err(error) => {
                eprintln!("skipping the symlink part: {error}");
                None
            }
        }
    }

    #[test]
    fn a_symlink_is_followed_to_the_file_it_names() {
        let dir = TempDir::new();
        let target = write(&dir, "real.pdf", MINIMAL);
        let link = dir.path().join("link.pdf");
        if symlink(&target, &link).is_none() {
            return;
        }
        // Its identity is the target's, so opening the link and the file is opening one document.
        assert_eq!(admit(&link).unwrap().path, canonical(&target));
        assert_eq!(admit(&link).unwrap().path, admit(&target).unwrap().path);

        // A link to something that is not a PDF is judged by what it points to.
        let text = write(&dir, "text.txt", b"not a pdf");
        let text_link = dir.path().join("text-link.pdf");
        if symlink(&text, &text_link).is_some() {
            assert_eq!(code(admit(&text_link)), ErrorCode::NotAPdf);
        }
    }

    #[test]
    fn a_symlink_to_a_directory_or_to_nothing_is_refused() {
        let dir = TempDir::new();
        let folder = dir.path().join("folder");
        fs::create_dir(&folder).unwrap();
        let folder_link = dir.path().join("folder-link.pdf");
        if symlink(&folder, &folder_link).is_some() {
            assert_eq!(code(admit(&folder_link)), ErrorCode::NotAPdf);
        }
        let dangling = dir.path().join("dangling.pdf");
        if symlink(&dir.path().join("gone.pdf"), &dangling).is_some() {
            assert_eq!(code(admit(&dangling)), ErrorCode::IoNotFound);
        }
    }

    /// The point of opening once: what was judged is what is handed on, even if the path is pointed at something else
    /// afterwards.
    #[test]
    fn the_handle_keeps_the_file_that_was_judged_when_the_path_is_swapped() {
        let dir = TempDir::new();
        let path = write(&dir, "swap.pdf", MINIMAL);
        let mut admitted = admit(&path).unwrap();

        // Move the judged file away (a rename works on every platform while it is open) and put something else at the path.
        fs::rename(&path, dir.path().join("moved.pdf")).unwrap();
        fs::write(&path, b"not a pdf any more").unwrap();
        assert_eq!(code(admit(&path)), ErrorCode::NotAPdf);

        let mut bytes = Vec::new();
        admitted.file.read_to_end(&mut bytes).unwrap();
        assert_eq!(bytes, MINIMAL, "the handle still reads the judged file");
    }

    #[cfg(unix)]
    #[test]
    fn a_fifo_is_refused_without_waiting_for_a_writer() {
        let dir = TempDir::new();
        let path = dir.path().join("pipe.pdf");
        // std has no `mkfifo`, and the crate forbids `unsafe`: use the tool, and skip where it is not at hand.
        let made = std::process::Command::new("mkfifo").arg(&path).status();
        if !made.is_ok_and(|status| status.success()) {
            return;
        }
        assert_eq!(code(admit(&path)), ErrorCode::NotAPdf);
    }

    #[test]
    fn the_size_is_judged_before_the_content_and_an_empty_file_is_never_a_pdf() {
        let dir = TempDir::new();
        // Over the limit and not a PDF: the size is what is reported, because it is checked first and nothing is read.
        let text = write(&dir, "big-text.pdf", &[b'x'; 64]);
        assert_eq!(code(admit_within(&text, 63)), ErrorCode::TooLarge);
        assert_eq!(code(admit_within(&text, 64)), ErrorCode::NotAPdf);
        // Empty is not over any limit, not even a limit of zero: it is refused for having no signature.
        let empty = write(&dir, "empty.pdf", b"");
        assert_eq!(code(admit_within(&empty, 0)), ErrorCode::NotAPdf);
        // The public door applies the real limit (2 GiB), not a smaller one.
        assert_eq!(code(admit(&text)), ErrorCode::NotAPdf);
    }

    #[test]
    fn a_file_over_the_limit_reaches_the_ui_as_a_code_and_the_limit_and_nothing_else() {
        let dir = TempDir::new();
        let path = write(&dir, "confidential-4711.pdf", MINIMAL);
        let error = admit_within(&path, 5).unwrap_err();
        let event = crate::events::AppEvent::open_failed(error);
        assert_eq!(
            serde_json::to_string(&event).unwrap(),
            r#"{"type":"openFailed","code":"too_large","key":"error.too_large","retryable":false,"params":{"what":"file_size","limit":5}}"#
        );
    }

    /// Windows file names are case-insensitive, and a path can be spelled with either slash or with the verbatim prefix. All
    /// of those are one file, so intake has to hand the registry one path for them (`canonicalize` returns the name as the
    /// disk has it). Skipped where the file system distinguishes case.
    #[cfg(windows)]
    #[test]
    fn spellings_that_differ_in_case_or_slashes_are_one_path_on_windows() {
        let dir = TempDir::new();
        fs::create_dir(dir.path().join("Sub")).unwrap();
        let path = dir.path().join("Sub").join("Report.PDF");
        fs::write(&path, MINIMAL).unwrap();
        let expected = admit(&path).unwrap().path;
        assert_eq!(expected, canonical(&path));

        let text = path.to_string_lossy().into_owned();
        let upper = dir.path().join("SUB").join("REPORT.pdf");
        let lower = PathBuf::from(text.to_lowercase());
        if !upper.exists() || !lower.exists() {
            eprintln!("skipping: this directory is case-sensitive");
            return;
        }
        let spellings = [
            upper,
            lower,
            PathBuf::from(text.replace('\\', "/")),
            dir.path().join("sub").join(".").join("report.pdf"),
            dir.path()
                .join("Sub")
                .join("..")
                .join("SUB")
                .join("Report.pdf"),
            PathBuf::from(format!(r"\\?\{text}")),
        ];
        for spelling in spellings {
            assert_eq!(
                admit(&spelling).unwrap().path,
                expected,
                "{}",
                spelling.display()
            );
        }
    }

    #[test]
    fn a_chain_of_links_ends_at_the_file_and_a_link_to_a_link_to_a_directory_is_refused() {
        let dir = TempDir::new();
        let target = write(&dir, "real.pdf", MINIMAL);
        let (first, second) = (dir.path().join("first.pdf"), dir.path().join("second.pdf"));
        if symlink(&target, &first).is_none() || symlink(&first, &second).is_none() {
            return;
        }
        assert_eq!(admit(&second).unwrap().path, canonical(&target));

        let folder = dir.path().join("folder");
        fs::create_dir(&folder).unwrap();
        let (to_folder, to_link) = (dir.path().join("to-folder"), dir.path().join("to-link.pdf"));
        if symlink(&folder, &to_folder).is_some() && symlink(&to_folder, &to_link).is_some() {
            assert_eq!(code(admit(&to_link)), ErrorCode::NotAPdf);
        }
    }

    /// The identity is the file's, not its look: two files of one size and one modification time are two files, and two names of
    /// one file (a hard link) are one.
    #[test]
    fn file_identity_is_not_size_and_times() {
        let dir = TempDir::new();
        let a = write(&dir, "a.pdf", MINIMAL);
        let b = write(&dir, "b.pdf", MINIMAL);
        let (fa, fb) = (File::open(&a).unwrap(), File::open(&b).unwrap());
        // Same size; give both the same times as far as the platform lets us.
        if let Ok(modified) = fa.metadata().and_then(|m| m.modified()) {
            let _ = fb.set_modified(modified);
        }
        assert!(!same_file(&fa, &fb).unwrap(), "two files of one look");
        assert!(same_file(&fa, &File::open(&a).unwrap()).unwrap());
        let link = dir.path().join("hard.pdf");
        if fs::hard_link(&a, &link).is_ok() {
            assert!(same_file(&fa, &File::open(&link).unwrap()).unwrap());
        }
    }

    /// A mapped network drive canonicalizes to `\\?\UNC\...`; that is refused (after the open, see ADR-027).
    #[test]
    fn a_canonical_unc_path_is_refused() {
        assert!(!windows_spelling_is_plain(r"\\?\UNC\nas\share\a.pdf"));
    }

    // --- command line and URLs ---

    fn os(args: &[&str]) -> Vec<OsString> {
        args.iter().map(OsString::from).collect()
    }

    #[test]
    fn flags_and_empty_arguments_are_not_files() {
        let paths = paths_from_args(os(&["--flag", "", "-x", "a.pdf", "b.pdf"]), None);
        assert_eq!(paths, [PathBuf::from("a.pdf"), PathBuf::from("b.pdf")]);
    }

    #[test]
    fn a_bare_value_after_a_long_option_is_not_a_file() {
        let paths = paths_from_args(
            os(&["--mode", "dark", "a.pdf", "--x=1", "b", "--y", "c.pdf"]),
            None,
        );
        assert_eq!(
            paths,
            [
                PathBuf::from("a.pdf"),
                PathBuf::from("b"),
                PathBuf::from("c.pdf")
            ]
        );
    }

    #[test]
    fn network_device_and_stream_spellings_are_not_plain_on_windows() {
        for bad in [
            r"\\server\share\a.pdf",
            r"\\?\UNC\server\share\a.pdf",
            r"\\localhost\c$\a.pdf",
            "//server/share/a.pdf",
            r"\\.\COM1",
            r"\\.\NUL",
            r"\\.\pipe\x",
            r"\\?\GLOBALROOT\Device\x",
            r"C:\dir\a.pdf:stream",
            r"C:\dir\a.pdf::$DATA",
            r"\\?\C:\dir\a.pdf:s",
            "a.pdf:s",
        ] {
            assert!(!windows_spelling_is_plain(bad), "{bad}");
        }
        for good in [
            r"C:\dir\a.pdf",
            r"\\?\C:\dir\a.pdf",
            "C:/dir/a.pdf",
            r"rel\a.pdf",
            "a.pdf",
        ] {
            assert!(windows_spelling_is_plain(good), "{good}");
        }
    }

    /// Device paths never become documents: on Windows by the spelling or by the check of the handle.
    #[cfg(windows)]
    #[test]
    fn windows_device_paths_are_refused() {
        for device in [
            r"\\.\NUL",
            r"\\.\COM1",
            r"\\.\pipe\sheer-test",
            "NUL",
            "CON",
            r"\\?\UNC\localhost\c$\x.pdf",
        ] {
            assert!(admit(Path::new(device)).is_err(), "{device}");
        }
    }

    #[cfg(windows)]
    #[test]
    fn an_alternate_data_stream_is_refused_even_when_it_holds_a_pdf() {
        let dir = TempDir::new();
        let path = write(&dir, "host.pdf", MINIMAL);
        let stream = PathBuf::from(format!("{}:hidden", path.display()));
        assert!(admit(&stream).is_err());
    }

    #[test]
    fn relative_paths_follow_the_working_directory_of_the_launch() {
        let cwd = canonical(&std::env::temp_dir());
        let absolute = cwd.join("abs.pdf");
        let arguments = vec![OsString::from("rel.pdf"), absolute.clone().into_os_string()];
        let paths = paths_from_args(arguments, Some(&cwd));
        assert_eq!(paths, [cwd.join("rel.pdf"), absolute]);
    }

    #[test]
    fn a_command_line_is_cut_one_past_the_batch_limit() {
        let many: Vec<OsString> = (0..100)
            .map(|i| OsString::from(format!("{i}.pdf")))
            .collect();
        assert_eq!(
            paths_from_args(many, None).len(),
            limits::MAX_OPEN_BATCH + 1
        );
    }

    #[test]
    fn only_file_urls_name_files() {
        let from = |text: &str| tauri::Url::parse(text).unwrap();
        #[cfg(windows)]
        let (url, expected) = (
            from("file:///C:/Users/a/Report.pdf"),
            PathBuf::from(r"C:\Users\a\Report.pdf"),
        );
        #[cfg(not(windows))]
        let (url, expected) = (
            from("file:///Users/a/Report.pdf"),
            PathBuf::from("/Users/a/Report.pdf"),
        );
        let urls = [
            url,
            from("https://example.com/a.pdf"),
            from("sheer://open?x=1"),
        ];
        assert_eq!(paths_from_urls(&urls), [expected]);
    }
}
