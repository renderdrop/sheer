//! Atomic file replacement: write a temp file next to the target, flush it to disk, then rename it over the target.
//!
//! A crash or power loss leaves either the old file or the new one, never a half-written mix. The temp file lives in
//! the same directory (a rename across volumes is not atomic) and is removed again if any step fails.
//!
//! Hardening, because the directory may hold files an attacker (or a crash) put there:
//! - The temp file is named `.<name>.<pid>.<n>.tmp`: the process id plus a counter that grows with every write of the
//!   process. Two writers (threads, or two instances of the app) never share a temp file, and an attacker cannot plant
//!   a link at a fixed, guessable name beforehand.
//! - It is created with `create_new` (`O_CREAT | O_EXCL`): it never truncates or writes through an existing file and
//!   never follows a symlink. Whatever already sits at a name (a leftover of a crashed process whose pid came round
//!   again, or something planted) is skipped untouched and the next name is tried. A leftover is hidden, never read and
//!   never reused.
//! - On Unix the temp file is created with mode `0o600` and missing directories with `0o700`, so what is written is
//!   private from the first byte. The replaced file therefore ends up `0o600`: a caller that replaces a file the user
//!   owns (a document) has to restore the original mode itself. Existing directories are never touched.
//! - The file is fsynced before the rename and, on Unix, the directory after it, so the rename survives power loss.

use std::ffi::{OsStr, OsString};
use std::fs::{self, DirBuilder, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

#[cfg(unix)]
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};

/// Mode of the temp file (and so of the replaced file) on Unix: owner read and write only.
#[cfg(unix)]
const FILE_MODE: u32 = 0o600;
/// Mode of directories this module creates on Unix: owner only.
#[cfg(unix)]
const DIRECTORY_MODE: u32 = 0o700;

/// How many temp names are tried before giving up. Each name that is already taken costs one attempt; that is rare
/// (a leftover with a reused pid, or something planted), so running out means something is wrong with the directory.
const TEMP_ATTEMPTS: u32 = 16;

/// The counter in the next temp name of this process.
static NEXT_TEMP: AtomicU32 = AtomicU32::new(0);

/// Replaces the file at `path` with `bytes`. Creates missing parent directories.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    write_atomic_with(path, bytes, || NEXT_TEMP.fetch_add(1, Ordering::Relaxed))
}

/// `write_atomic` with the temp file counter passed in, so a test can know which names will be tried.
fn write_atomic_with(
    path: &Path,
    bytes: &[u8],
    mut next_sequence: impl FnMut() -> u32,
) -> io::Result<()> {
    let (Some(directory), Some(name)) = (path.parent(), path.file_name()) else {
        return Err(io::Error::from(io::ErrorKind::InvalidInput));
    };
    // A bare file name has the empty path as its parent; `.` is the directory it means.
    let directory = if directory.as_os_str().is_empty() {
        Path::new(".")
    } else {
        directory
    };
    create_directories(directory)?;

    // If this fails there is nothing of ours to clean up: no temp file was made.
    let (mut file, temp) = create_temp(directory, name, &mut next_sequence)?;
    let written = file.write_all(bytes).and_then(|()| file.sync_all());
    // Close the handle before the rename; Windows refuses to replace an open file in some sharing modes.
    drop(file);
    let result = written.and_then(|()| fs::rename(&temp, path));
    if result.is_err() {
        // Best effort: the original error is the one the caller needs. The file at `temp` is ours: `create_new` made it.
        let _ = fs::remove_file(&temp);
        return result;
    }
    sync_directory(directory);
    Ok(())
}

/// `<directory>/.<name>.<pid>.<sequence>.tmp`: hidden, unique to this process and write, and recognisable if a crash
/// ever leaves one behind.
fn temp_path(directory: &Path, name: &OsStr, sequence: u32) -> PathBuf {
    let mut temp_name = OsString::from(".");
    temp_name.push(name);
    temp_name.push(format!(".{}.{sequence}.tmp", std::process::id()));
    directory.join(temp_name)
}

/// Creates directory `directory` and its missing parents; owner-only on Unix. Directories that already exist are left
/// as they are, so the mode of a folder the user chose is never changed.
fn create_directories(directory: &Path) -> io::Result<()> {
    let mut builder = DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    builder.mode(DIRECTORY_MODE);
    builder.create(directory)
}

/// A new, empty, private file next to the target, and its path. `create_new` guarantees this call made the file: a name
/// that is taken, by whatever (file, hard link, directory, symlink, even a dangling one), is left alone and the next
/// name is tried, so nothing at a planted path is ever truncated or written through.
fn create_temp(
    directory: &Path,
    name: &OsStr,
    next_sequence: &mut impl FnMut() -> u32,
) -> io::Result<(File, PathBuf)> {
    for _ in 0..TEMP_ATTEMPTS {
        let temp = temp_path(directory, name, next_sequence());
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        options.mode(FILE_MODE);
        match options.open(&temp) {
            Ok(file) => return Ok((file, temp)),
            Err(error) if is_taken(&error, &temp) => {}
            Err(error) => return Err(error),
        }
    }
    Err(io::Error::from(io::ErrorKind::AlreadyExists))
}

/// Whether `error` from creating the file at `temp` means "something is already there". Unix and Windows report that as
/// `AlreadyExists`, except that Windows says "access denied" when the thing is a directory; there, the name being
/// occupied (looked at without following a link) tells that error from a directory that really cannot be written to.
fn is_taken(error: &io::Error, temp: &Path) -> bool {
    match error.kind() {
        io::ErrorKind::AlreadyExists => true,
        io::ErrorKind::PermissionDenied => fs::symlink_metadata(temp).is_ok(),
        _ => false,
    }
}

/// Makes the rename itself durable. POSIX needs the directory flushed; Windows cannot open a directory as a file and
/// flushes the rename with the file system journal.
#[cfg(unix)]
fn sync_directory(directory: &Path) {
    if let Ok(handle) = File::open(directory) {
        let _ = handle.sync_all();
    }
}

#[cfg(not(unix))]
fn sync_directory(_directory: &Path) {}

#[cfg(test)]
pub(crate) mod testutil {
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU32, Ordering};

    /// A scratch directory under the system temp dir, removed on drop. No `tempfile` crate: one fewer dependency.
    pub struct TempDir(PathBuf);

    impl TempDir {
        pub fn new() -> Self {
            static NEXT: AtomicU32 = AtomicU32::new(0);
            let path = std::env::temp_dir().join(format!(
                "sheer-test-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir_all(&path).expect("create scratch directory");
            Self(path)
        }

        pub fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::testutil::TempDir;
    use super::*;

    fn entries(directory: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(directory)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    /// The temp counter of a test: 0, 1, 2, ... so the test knows which names are tried and can occupy them.
    fn counting() -> impl FnMut() -> u32 {
        let mut next = 0;
        move || {
            next += 1;
            next - 1
        }
    }

    /// The temp path a write with the counter at `sequence` tries first.
    fn temp_of(target: &Path, sequence: u32) -> PathBuf {
        temp_path(
            target.parent().unwrap(),
            target.file_name().unwrap(),
            sequence,
        )
    }

    /// The name of the temp file at `sequence`, as it appears in a directory listing.
    fn temp_name(target: &Path, sequence: u32) -> String {
        temp_of(target, sequence)
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned()
    }

    #[test]
    fn creates_the_file_and_missing_directories() {
        let dir = TempDir::new();
        let target = dir.path().join("a").join("b").join("settings.json");
        write_atomic(&target, b"one").unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"one");
    }

    #[test]
    fn replaces_an_existing_file_and_leaves_no_temp_file() {
        let dir = TempDir::new();
        let target = dir.path().join("settings.json");
        write_atomic(&target, b"old contents, longer than the new ones").unwrap();
        write_atomic(&target, b"new").unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"new");
        assert_eq!(entries(dir.path()), ["settings.json"]);
    }

    #[test]
    fn a_failed_write_keeps_the_original_and_cleans_up() {
        let dir = TempDir::new();
        let target = dir.path().join("settings.json");
        write_atomic(&target, b"keep me").unwrap();
        // A directory in the way of the rename makes the last step fail after the temp file has been written.
        let blocked = dir.path().join("blocked");
        fs::create_dir(&blocked).unwrap();
        fs::write(blocked.join("child"), b"x").unwrap();
        assert!(write_atomic(&blocked, b"new").is_err());
        assert_eq!(fs::read(&target).unwrap(), b"keep me");
        assert_eq!(entries(dir.path()), ["blocked", "settings.json"]);
    }

    #[test]
    fn rejects_a_path_without_a_file_name() {
        assert!(write_atomic(Path::new(""), b"x").is_err());
    }

    // --- the temp file: a unique name, created with create_new ---

    #[test]
    fn the_temp_file_is_hidden_named_after_the_target_and_unique_to_process_and_write() {
        let target = Path::new("some").join("settings.json");
        let first = temp_of(&target, 7);
        assert_eq!(
            first.file_name().unwrap().to_string_lossy(),
            format!(".settings.json.{}.7.tmp", std::process::id())
        );
        assert_eq!(first.parent(), target.parent());
        assert_ne!(first, temp_of(&target, 8));
        assert_ne!(
            first,
            temp_of(&Path::new("some").join("other.json"), 7),
            "files in one directory do not share a temp file either"
        );
    }

    #[test]
    fn every_write_of_the_process_takes_a_new_temp_name() {
        let dir = TempDir::new();
        let target = dir.path().join("settings.json");
        let before = NEXT_TEMP.load(Ordering::Relaxed);
        write_atomic(&target, b"one").unwrap();
        write_atomic(&target, b"two").unwrap();
        // Other tests write in parallel, so "at least two more" is what can be said.
        assert!(NEXT_TEMP.load(Ordering::Relaxed).wrapping_sub(before) >= 2);
        assert_eq!(fs::read(&target).unwrap(), b"two");
    }

    #[test]
    fn a_taken_temp_name_is_skipped_and_what_is_there_stays_untouched() {
        let dir = TempDir::new();
        let target = dir.path().join("settings.json");
        let leftover = temp_of(&target, 0);
        fs::write(&leftover, b"half a wri").unwrap();

        write_atomic_with(&target, b"new", counting()).unwrap();

        assert_eq!(fs::read(&target).unwrap(), b"new");
        assert_eq!(fs::read(&leftover).unwrap(), b"half a wri");
        assert_eq!(
            entries(dir.path()),
            [temp_name(&target, 0), "settings.json".to_owned()]
        );
    }

    #[test]
    fn a_temp_name_that_is_a_second_name_for_another_file_is_never_written_through() {
        // Truncating or appending to it would damage the other file; skipping it leaves both alone.
        let dir = TempDir::new();
        let target = dir.path().join("settings.json");
        let victim = dir.path().join("victim.txt");
        fs::write(&victim, b"precious").unwrap();
        if fs::hard_link(&victim, temp_of(&target, 0)).is_err() {
            return; // a file system without hard links: nothing to test
        }

        write_atomic_with(&target, b"new", counting()).unwrap();

        assert_eq!(fs::read(&victim).unwrap(), b"precious");
        assert_eq!(fs::read(&target).unwrap(), b"new");
        assert_eq!(
            entries(dir.path()),
            [
                temp_name(&target, 0),
                "settings.json".to_owned(),
                "victim.txt".to_owned()
            ]
        );
    }

    #[test]
    fn a_directory_at_a_temp_name_is_skipped_and_left_alone() {
        let dir = TempDir::new();
        let target = dir.path().join("settings.json");
        write_atomic(&target, b"keep me").unwrap();
        let blocker = temp_of(&target, 0);
        fs::create_dir(&blocker).unwrap();
        fs::write(blocker.join("child"), b"x").unwrap();

        write_atomic_with(&target, b"new", counting()).unwrap();

        assert_eq!(fs::read(&target).unwrap(), b"new");
        assert_eq!(fs::read(blocker.join("child")).unwrap(), b"x");
    }

    #[test]
    fn a_read_only_leftover_does_not_block_the_write() {
        let dir = TempDir::new();
        let target = dir.path().join("settings.json");
        let leftover = temp_of(&target, 0);
        fs::write(&leftover, b"half a wri").unwrap();
        let mut permissions = fs::metadata(&leftover).unwrap().permissions();
        permissions.set_readonly(true);
        fs::set_permissions(&leftover, permissions).unwrap();

        write_atomic_with(&target, b"new", counting()).unwrap();

        assert_eq!(fs::read(&target).unwrap(), b"new");
        assert_eq!(fs::read(&leftover).unwrap(), b"half a wri");
    }

    #[test]
    fn several_taken_names_in_a_row_are_all_skipped() {
        let dir = TempDir::new();
        let target = dir.path().join("settings.json");
        for sequence in 0..TEMP_ATTEMPTS - 1 {
            fs::write(temp_of(&target, sequence), b"taken").unwrap();
        }

        write_atomic_with(&target, b"new", counting()).unwrap();

        assert_eq!(fs::read(&target).unwrap(), b"new");
    }

    #[test]
    fn when_every_name_is_taken_it_fails_and_changes_nothing() {
        let dir = TempDir::new();
        let target = dir.path().join("settings.json");
        write_atomic(&target, b"keep me").unwrap();
        for sequence in 0..TEMP_ATTEMPTS {
            fs::write(temp_of(&target, sequence), b"taken").unwrap();
        }

        let error = write_atomic_with(&target, b"new", counting()).unwrap_err();

        assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(fs::read(&target).unwrap(), b"keep me");
        for sequence in 0..TEMP_ATTEMPTS {
            assert_eq!(fs::read(temp_of(&target, sequence)).unwrap(), b"taken");
        }
    }

    #[test]
    fn a_failed_write_removes_only_its_own_temp_file() {
        let dir = TempDir::new();
        let leftover = temp_of(&dir.path().join("blocked"), 0);
        fs::write(&leftover, b"taken").unwrap();
        let blocked = dir.path().join("blocked");
        fs::create_dir(&blocked).unwrap();
        fs::write(blocked.join("child"), b"x").unwrap();

        // The rename fails (a non-empty directory is the target); the temp file of this write is removed, the one that
        // was already there is not.
        assert!(write_atomic_with(&blocked, b"new", counting()).is_err());

        assert_eq!(fs::read(&leftover).unwrap(), b"taken");
        assert_eq!(
            entries(dir.path()),
            [temp_name(&blocked, 0), "blocked".to_owned()]
        );
    }

    #[test]
    fn an_empty_payload_replaces_the_file_with_an_empty_one() {
        let dir = TempDir::new();
        let target = dir.path().join("settings.json");
        write_atomic(&target, b"something").unwrap();
        write_atomic(&target, b"").unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"");
        assert_eq!(entries(dir.path()), ["settings.json"]);
    }

    #[test]
    fn a_large_payload_is_written_whole() {
        let dir = TempDir::new();
        let target = dir.path().join("big.bin");
        let bytes: Vec<u8> = (0..(1024 * 1024 + 7)).map(|n| (n % 251) as u8).collect();
        write_atomic(&target, &bytes).unwrap();
        assert_eq!(fs::read(&target).unwrap(), bytes);
        assert_eq!(entries(dir.path()), ["big.bin"]);
    }

    #[test]
    fn files_in_one_directory_do_not_share_a_temp_file() {
        let dir = TempDir::new();
        write_atomic(&dir.path().join("a.json"), b"A").unwrap();
        write_atomic(&dir.path().join("b.json"), b"B").unwrap();
        assert_eq!(fs::read(dir.path().join("a.json")).unwrap(), b"A");
        assert_eq!(fs::read(dir.path().join("b.json")).unwrap(), b"B");
        assert_eq!(entries(dir.path()), ["a.json", "b.json"]);
    }

    #[test]
    fn a_parent_that_is_a_file_fails_and_leaves_it_alone() {
        let dir = TempDir::new();
        let not_a_directory = dir.path().join("not-a-directory");
        fs::write(&not_a_directory, b"x").unwrap();
        assert!(write_atomic(&not_a_directory.join("settings.json"), b"new").is_err());
        assert_eq!(fs::read(&not_a_directory).unwrap(), b"x");
        assert_eq!(entries(dir.path()), ["not-a-directory"]);
    }

    #[test]
    fn a_path_that_ends_in_dot_dot_has_no_file_name_and_creates_nothing() {
        let dir = TempDir::new();
        assert!(write_atomic(Path::new(".."), b"x").is_err());
        assert!(write_atomic(&dir.path().join("sub").join(".."), b"x").is_err());
        assert!(entries(dir.path()).is_empty());
    }

    #[cfg(unix)]
    mod unix {
        use std::os::unix::fs::{symlink, PermissionsExt};

        use super::*;

        fn mode(path: &Path) -> u32 {
            fs::metadata(path).unwrap().permissions().mode() & 0o777
        }

        #[test]
        fn the_written_file_is_private_to_the_owner() {
            let dir = TempDir::new();
            let target = dir.path().join("settings.json");
            write_atomic(&target, b"one").unwrap();
            assert_eq!(mode(&target), 0o600);
            // Replacing keeps it private, even if it was made world-readable in between.
            fs::set_permissions(&target, fs::Permissions::from_mode(0o644)).unwrap();
            write_atomic(&target, b"two").unwrap();
            assert_eq!(mode(&target), 0o600);
        }

        #[test]
        fn created_directories_are_owner_only_and_existing_ones_are_left_alone() {
            let dir = TempDir::new();
            let existing = dir.path().join("existing");
            fs::create_dir(&existing).unwrap();
            fs::set_permissions(&existing, fs::Permissions::from_mode(0o755)).unwrap();

            let target = existing.join("a").join("b").join("settings.json");
            write_atomic(&target, b"x").unwrap();

            assert_eq!(mode(&existing), 0o755);
            assert_eq!(mode(&existing.join("a")), 0o700);
            assert_eq!(mode(&existing.join("a").join("b")), 0o700);
        }

        #[test]
        fn a_symlink_at_a_temp_name_is_skipped_not_followed() {
            let dir = TempDir::new();
            let target = dir.path().join("settings.json");
            let victim = dir.path().join("victim.txt");
            fs::write(&victim, b"precious").unwrap();
            symlink(&victim, temp_of(&target, 0)).unwrap();

            write_atomic_with(&target, b"new", counting()).unwrap();

            assert_eq!(fs::read(&victim).unwrap(), b"precious");
            assert_eq!(fs::read(&target).unwrap(), b"new");
            assert!(fs::symlink_metadata(temp_of(&target, 0))
                .unwrap()
                .file_type()
                .is_symlink());
        }

        #[test]
        fn a_dangling_symlink_at_a_temp_name_does_not_create_its_destination() {
            let dir = TempDir::new();
            let target = dir.path().join("settings.json");
            let destination = dir.path().join("planted.txt");
            symlink(&destination, temp_of(&target, 0)).unwrap();

            write_atomic_with(&target, b"new", counting()).unwrap();

            assert!(!destination.exists());
            assert_eq!(fs::read(&target).unwrap(), b"new");
        }

        #[test]
        fn a_symlink_at_the_target_is_replaced_and_what_it_pointed_to_is_untouched() {
            let dir = TempDir::new();
            let target = dir.path().join("settings.json");
            let elsewhere = dir.path().join("elsewhere.txt");
            fs::write(&elsewhere, b"other").unwrap();
            symlink(&elsewhere, &target).unwrap();

            write_atomic(&target, b"new").unwrap();

            assert!(fs::symlink_metadata(&target).unwrap().is_file());
            assert_eq!(fs::read(&target).unwrap(), b"new");
            assert_eq!(fs::read(&elsewhere).unwrap(), b"other");
        }
    }
}
