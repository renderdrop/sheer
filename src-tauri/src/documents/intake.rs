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
    // Symlinks and `..` are resolved here, so two names of one file are one path and a link to a directory is a directory.
    let path = std::fs::canonicalize(path)?;
    let mut file = open_without_blocking(&path)?;
    check_handle(&mut file, max_bytes)?;
    Ok(Admitted { path, file })
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

/// The files named on a command line: `args` without the program name. Flags (a leading `-`) and empty arguments are not
/// files and are skipped; the OS and the shell put nothing else there. A relative path is relative to `cwd`, the working
/// directory of the process that was started (the second instance's, for one forwarded to the running app). At most
/// `MAX_OPEN_BATCH + 1` are returned, one more than may be opened, so the caller can tell that there were too many.
pub fn paths_from_args(
    args: impl IntoIterator<Item = OsString>,
    cwd: Option<&Path>,
) -> Vec<PathBuf> {
    args.into_iter()
        .filter(|arg| !arg.is_empty() && !arg.to_string_lossy().starts_with('-'))
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
