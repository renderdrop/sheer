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
//! - A crash between create and rename leaves the temp file behind. `sweep_stale_temp_files` removes such leftovers at
//!   startup, but only files of exactly this naming pattern and only when they are older than an hour.

use std::ffi::{OsStr, OsString};
use std::fs::{self, DirBuilder, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, SystemTime};

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

/// How old a temp file must be before [`sweep_stale_temp_files`] counts it as a leftover. A write takes milliseconds, so
/// an hour is far beyond any write still in progress (this process or another instance of the app).
pub const STALE_TEMP_AGE: Duration = Duration::from_secs(60 * 60);

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

/// Whether `name` has the shape [`temp_path`] gives: `.<name>.<pid>.<sequence>.tmp`, with a non-empty target name and two
/// plain decimal numbers (each fitting the `u32` they came from). Nothing else in the directory is ever ours to remove.
fn is_temp_name(name: &OsStr) -> bool {
    let Some(body) = name
        .to_str()
        .and_then(|name| name.strip_prefix('.'))
        .and_then(|name| name.strip_suffix(".tmp"))
    else {
        return false;
    };
    let mut parts = body.rsplitn(3, '.');
    let (Some(sequence), Some(pid), Some(target)) = (parts.next(), parts.next(), parts.next())
    else {
        return false;
    };
    let is_number =
        |text: &str| text.bytes().all(|byte| byte.is_ascii_digit()) && text.parse::<u32>().is_ok();
    !target.is_empty() && is_number(pid) && is_number(sequence)
}

/// Removes the temp files a crash left in `directory` (not its subdirectories): regular files named `.<name>.<pid>.<n>.tmp`
/// that were last modified more than [`STALE_TEMP_AGE`] ago. Returns how many were removed.
///
/// Best effort, for the start of the app: a missing directory, an entry that cannot be read or a file that cannot be removed
/// (read-only, in use) is skipped, never an error. Only the pattern of this module is touched, so a user's file that ends in
/// `.tmp` stays. Directories and links are left alone (a link is judged as itself, never followed), and so is a file dated
/// in the future (a wrong clock must not make a fresh file look old).
pub fn sweep_stale_temp_files(directory: &Path) -> usize {
    sweep_older_than(directory, SystemTime::now(), STALE_TEMP_AGE)
}

/// `sweep_stale_temp_files` with the clock and the age passed in, so a test needs no file that is really an hour old.
fn sweep_older_than(directory: &Path, now: SystemTime, max_age: Duration) -> usize {
    let Ok(entries) = fs::read_dir(directory) else {
        return 0;
    };
    let mut removed = 0;
    for entry in entries.flatten() {
        if !is_temp_name(&entry.file_name()) {
            continue;
        }
        // `DirEntry::metadata` does not follow a symlink, so a link at a temp name is not a regular file here.
        let stale = entry.metadata().is_ok_and(|metadata| {
            metadata.is_file()
                && metadata
                    .modified()
                    .ok()
                    .and_then(|modified| now.duration_since(modified).ok())
                    .is_some_and(|age| age > max_age)
        });
        if stale && fs::remove_file(entry.path()).is_ok() {
            removed += 1;
        }
    }
    removed
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

    // --- the sweep of leftover temp files ---

    /// A regular file at `path` last modified `age` ago.
    fn file_aged(path: &Path, age: Duration) {
        let file = File::create(path).unwrap();
        file.set_modified(SystemTime::now() - age).unwrap();
    }

    const HOUR: Duration = STALE_TEMP_AGE;

    #[test]
    fn every_name_the_writer_makes_is_recognised_as_a_temp_name() {
        for name in ["settings.json", "a", "two words.pdf", "x.y.z", "ünï.json"] {
            for sequence in [0, 7, u32::MAX] {
                let temp = temp_path(Path::new("dir"), OsStr::new(name), sequence);
                assert!(is_temp_name(temp.file_name().unwrap()), "{temp:?}");
            }
        }
    }

    #[test]
    fn names_that_are_not_the_pattern_are_not_temp_names() {
        for name in [
            "settings.json",
            "notes.tmp",
            ".hidden.tmp",
            ".settings.json.tmp",
            ".settings.json.12.tmp",
            ".settings.json.12.x.tmp",
            ".settings.json.x.3.tmp",
            ".settings.json..3.tmp",
            ".settings.json.12..tmp",
            ".settings.json.-1.3.tmp",
            ".settings.json.+1.3.tmp",
            ".settings.json.12.3.TMP",
            ".settings.json.12.3.tmp.bak",
            "settings.json.12.3.tmp",
            "..12.3.tmp",
            ".settings.json.99999999999.3.tmp",
            ".settings.json.1.99999999999.tmp",
            "",
            ".tmp",
        ] {
            assert!(!is_temp_name(OsStr::new(name)), "{name:?}");
        }
    }

    #[test]
    fn the_sweep_removes_old_temp_files_and_nothing_else() {
        let dir = TempDir::new();
        let stale = temp_of(&dir.path().join("settings.json"), 3);
        let stale_other = temp_of(&dir.path().join("recent.json"), 0);
        let fresh = temp_of(&dir.path().join("settings.json"), 4);
        file_aged(&stale, HOUR + Duration::from_secs(60));
        file_aged(&stale_other, 24 * HOUR);
        file_aged(&fresh, Duration::from_secs(60));
        // Old, but not the pattern: the user's files and the app's own data stay.
        let kept = [
            "settings.json",
            "notes.tmp",
            ".hidden.tmp",
            ".settings.json.12.x.tmp",
            "settings.json.12.3.tmp",
        ];
        for name in kept {
            file_aged(&dir.path().join(name), 24 * HOUR);
        }

        assert_eq!(sweep_stale_temp_files(dir.path()), 2);

        // Each file is judged on its own by `exists()`. A listing of the directory is not a reliable witness for the ones that
        // went: Windows keeps listing a file whose delete is pending (a virus scanner or the indexer still has it open) until
        // the last handle closes, although every other call already says it is gone. So the listing is compared without the
        // two removed names, which still shows that nothing else was taken and nothing unexpected is there.
        assert!(!stale.exists());
        assert!(!stale_other.exists());
        assert!(fresh.exists());
        for name in kept {
            assert!(dir.path().join(name).exists(), "{name} was removed");
        }
        let removed = [
            temp_name(&dir.path().join("settings.json"), 3),
            temp_name(&dir.path().join("recent.json"), 0),
        ];
        let listed: Vec<String> = entries(dir.path())
            .into_iter()
            .filter(|name| !removed.contains(name))
            .collect();
        // Sorted like `entries`: where the fresh temp name falls among the others depends on the process id in it, so a
        // fixed order would only hold for some ids ("10392" sorts before "12").
        let mut expected = vec![
            ".hidden.tmp".to_owned(),
            ".settings.json.12.x.tmp".to_owned(),
            temp_name(&dir.path().join("settings.json"), 4),
            "notes.tmp".to_owned(),
            "settings.json".to_owned(),
            "settings.json.12.3.tmp".to_owned(),
        ];
        expected.sort();
        assert_eq!(listed, expected);
    }

    #[test]
    fn a_file_is_stale_only_when_it_is_older_than_the_age() {
        let dir = TempDir::new();
        let target = dir.path().join("settings.json");
        let just_under = temp_of(&target, 0);
        let just_over = temp_of(&target, 1);
        let now = SystemTime::now();
        file_aged(&just_under, HOUR - Duration::from_secs(30));
        file_aged(&just_over, HOUR + Duration::from_secs(30));

        assert_eq!(sweep_older_than(dir.path(), now, HOUR), 1);

        assert!(just_under.exists());
        assert!(!just_over.exists());
        // Later the same file qualifies too.
        assert_eq!(sweep_older_than(dir.path(), now + HOUR, HOUR), 1);
        assert!(entries(dir.path()).is_empty());
    }

    #[test]
    fn a_file_dated_in_the_future_is_left_alone() {
        let dir = TempDir::new();
        let leftover = temp_of(&dir.path().join("settings.json"), 0);
        let file = File::create(&leftover).unwrap();
        file.set_modified(SystemTime::now() + 24 * HOUR).unwrap();
        drop(file);

        assert_eq!(sweep_stale_temp_files(dir.path()), 0);

        assert!(leftover.exists());
    }

    #[test]
    fn a_directory_at_a_temp_name_and_what_is_in_subdirectories_stay() {
        let dir = TempDir::new();
        let target = dir.path().join("settings.json");
        let blocker = temp_of(&target, 0);
        fs::create_dir(&blocker).unwrap();
        let nested = blocker.join(temp_name(&target, 1));
        file_aged(&nested, 24 * HOUR);
        let sub = dir.path().join("sub");
        fs::create_dir(&sub).unwrap();
        let deep = temp_of(&sub.join("settings.json"), 2);
        file_aged(&deep, 24 * HOUR);

        assert_eq!(sweep_stale_temp_files(dir.path()), 0);

        assert!(blocker.is_dir());
        assert!(nested.exists());
        assert!(deep.exists());
    }

    #[test]
    fn a_missing_directory_or_a_file_in_its_place_sweeps_nothing() {
        let dir = TempDir::new();
        assert_eq!(sweep_stale_temp_files(&dir.path().join("missing")), 0);
        let file = dir.path().join("a-file");
        fs::write(&file, b"x").unwrap();
        assert_eq!(sweep_stale_temp_files(&file), 0);
        assert_eq!(fs::read(&file).unwrap(), b"x");
    }

    #[test]
    fn a_leftover_that_cannot_be_removed_does_not_stop_the_sweep() {
        let dir = TempDir::new();
        let target = dir.path().join("settings.json");
        let read_only = temp_of(&target, 0);
        let plain = temp_of(&target, 1);
        file_aged(&read_only, 24 * HOUR);
        file_aged(&plain, 24 * HOUR);
        let mut permissions = fs::metadata(&read_only).unwrap().permissions();
        permissions.set_readonly(true);
        fs::set_permissions(&read_only, permissions).unwrap();

        let removed = sweep_stale_temp_files(dir.path());

        // Windows refuses to delete a read-only file, Unix does not care; either way the other one goes.
        assert!(!plain.exists());
        assert_eq!(removed, if read_only.exists() { 1 } else { 2 });
        // Let the scratch directory be removed again.
        if let Ok(metadata) = fs::metadata(&read_only) {
            let mut permissions = metadata.permissions();
            #[allow(clippy::permissions_set_readonly_false)]
            permissions.set_readonly(false);
            let _ = fs::set_permissions(&read_only, permissions);
        }
    }

    #[test]
    fn the_sweep_does_not_touch_a_temp_file_a_write_is_still_using() {
        let dir = TempDir::new();
        let target = dir.path().join("settings.json");
        // The state `write_atomic` is in between create and rename: a brand-new, empty temp file.
        let (file, temp) =
            create_temp(dir.path(), target.file_name().unwrap(), &mut counting()).unwrap();

        assert_eq!(sweep_stale_temp_files(dir.path()), 0);

        drop(file);
        assert!(temp.exists());
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
        fn the_sweep_leaves_a_symlink_at_a_temp_name_alone_even_when_it_points_to_an_old_file() {
            let dir = TempDir::new();
            let target = dir.path().join("settings.json");
            let old = dir.path().join("old.txt");
            file_aged(&old, 24 * HOUR);
            let link = temp_of(&target, 0);
            symlink(&old, &link).unwrap();
            let dangling = temp_of(&target, 1);
            symlink(dir.path().join("missing.txt"), &dangling).unwrap();

            assert_eq!(sweep_stale_temp_files(dir.path()), 0);

            assert!(fs::symlink_metadata(&link).is_ok());
            assert!(fs::symlink_metadata(&dangling).is_ok());
            assert!(old.exists());
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
