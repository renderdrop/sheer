//! The startup sweep of crash leftovers (`sweep_stale_temp_files`) through the public API.
//!
//! The unit tests in `storage::atomic` cover the name pattern and the common negative cases. These tests add what the sweep
//! must never do to the data directory around it: touch the settings file or a user's file, go into or above a directory,
//! follow a link out of the directory, damage the content a hard link shares with another file, or disturb a write that is
//! running. Links to directories need a privilege on Windows; a test that cannot make one says so and stops there.

// Test code: panicking on a broken fixture is the point (clippy.toml only exempts `#[test]` functions, not helpers).
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::fs::{self, File};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, SystemTime};

use sheer_lib::storage::atomic::{sweep_stale_temp_files, write_atomic, STALE_TEMP_AGE};
use sheer_lib::storage::settings::{Settings, SettingsStore, ThemeMode, FILE_NAME};

/// A process id that is not this one: what a crashed earlier run of the app left in the name.
const OTHER_PID: u32 = 4242;
const HOUR: Duration = STALE_TEMP_AGE;
const DAY: Duration = Duration::from_secs(24 * 60 * 60);

/// A scratch directory under the system temp dir, removed on drop.
struct TempDir(PathBuf);

impl TempDir {
    fn new() -> Self {
        static NEXT: AtomicU32 = AtomicU32::new(0);
        let path = std::env::temp_dir().join(format!(
            "sheer-sweep-it-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }

    fn join(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// A regular file with `content` that was last modified `age` ago.
fn aged(path: &Path, content: &[u8], age: Duration) -> PathBuf {
    fs::write(path, content).unwrap();
    File::options()
        .write(true)
        .open(path)
        .unwrap()
        .set_modified(SystemTime::now() - age)
        .unwrap();
    path.to_owned()
}

/// `.<target>.<pid>.<n>.tmp` in `directory`, the name `write_atomic` gives its temp file.
fn leftover_name(target: &str, pid: u32, sequence: u32) -> String {
    format!(".{target}.{pid}.{sequence}.tmp")
}

/// Sets the modification time of a directory to `age` ago, so only its type keeps the sweep from removing it.
fn age_directory(path: &Path, age: Duration) {
    #[cfg(windows)]
    let directory = {
        use std::os::windows::fs::OpenOptionsExt;
        // FILE_FLAG_BACKUP_SEMANTICS: the only way to open a directory handle.
        File::options()
            .write(true)
            .custom_flags(0x0200_0000)
            .open(path)
            .unwrap()
    };
    #[cfg(unix)]
    let directory = File::open(path).unwrap();
    directory.set_modified(SystemTime::now() - age).unwrap();
}

fn names(directory: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(directory)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

/// A symlink to a directory; `false` when the platform does not let this user make one (Windows without the privilege).
fn link_dir(target: &Path, link: &Path) -> bool {
    #[cfg(unix)]
    let made = std::os::unix::fs::symlink(target, link);
    #[cfg(windows)]
    let made = std::os::windows::fs::symlink_dir(target, link);
    if let Err(error) = &made {
        eprintln!("no symlink here ({error}): the test stops without checking");
    }
    made.is_ok()
}

/// A symlink to a file; `false` when the platform does not let this user make one.
fn link_file(target: &Path, link: &Path) -> bool {
    #[cfg(unix)]
    let made = std::os::unix::fs::symlink(target, link);
    #[cfg(windows)]
    let made = std::os::windows::fs::symlink_file(target, link);
    if let Err(error) = &made {
        eprintln!("no symlink here ({error}): the test stops without checking");
    }
    made.is_ok()
}

// --- what goes, and what the app lives on ------------------------------------------------------------------------

#[test]
fn old_leftovers_go_and_the_settings_file_survives_even_when_it_is_old() {
    let dir = TempDir::new();
    let own = std::process::id();
    let settings = aged(&dir.join(FILE_NAME), br#"{"theme":"dark"}"#, 30 * DAY);
    let stale_of_another_run = aged(
        &dir.join(&leftover_name(FILE_NAME, OTHER_PID, 3)),
        b"half a wri",
        HOUR + Duration::from_secs(300),
    );
    let stale_of_this_pid = aged(&dir.join(&leftover_name(FILE_NAME, own, 9)), b"", 2 * HOUR);
    let young = aged(
        &dir.join(&leftover_name(FILE_NAME, OTHER_PID, 4)),
        b"in use",
        Duration::from_secs(60),
    );
    let almost_stale = aged(
        &dir.join(&leftover_name(FILE_NAME, OTHER_PID, 5)),
        b"in use",
        HOUR - Duration::from_secs(300),
    );

    assert_eq!(sweep_stale_temp_files(dir.path()), 2);

    assert!(!stale_of_another_run.exists());
    assert!(!stale_of_this_pid.exists());
    assert!(young.exists());
    assert!(almost_stale.exists());
    assert_eq!(fs::read(&settings).unwrap(), br#"{"theme":"dark"}"#);
    // The app starts from what is left and reads the real file, as it does after the sweep in `lib.rs`.
    assert_eq!(
        SettingsStore::load(settings).get(),
        Settings {
            theme: ThemeMode::Dark,
            ..Settings::default()
        }
    );
}

#[test]
fn a_second_sweep_finds_nothing_and_a_write_after_the_sweep_works() {
    let dir = TempDir::new();
    aged(
        &dir.join(&leftover_name(FILE_NAME, OTHER_PID, 0)),
        b"x",
        DAY,
    );
    aged(
        &dir.join(&leftover_name("other.json", OTHER_PID, 1)),
        b"x",
        DAY,
    );
    assert_eq!(sweep_stale_temp_files(dir.path()), 2);
    assert_eq!(sweep_stale_temp_files(dir.path()), 0);
    assert!(names(dir.path()).is_empty());

    write_atomic(&dir.join(FILE_NAME), b"{}\n").unwrap();

    assert_eq!(names(dir.path()), [FILE_NAME.to_owned()]);
    assert_eq!(sweep_stale_temp_files(dir.path()), 0);
}

#[test]
fn a_directory_full_of_leftovers_is_cleaned_to_the_last_one() {
    let dir = TempDir::new();
    for sequence in 0..300 {
        aged(
            &dir.join(&leftover_name(FILE_NAME, OTHER_PID, sequence)),
            b"x",
            DAY,
        );
    }
    let keep = aged(&dir.join("keep.pdf"), b"%PDF", DAY);

    assert_eq!(sweep_stale_temp_files(dir.path()), 300);

    assert_eq!(names(dir.path()), ["keep.pdf".to_owned()]);
    assert!(keep.exists());
}

#[test]
fn files_that_only_look_like_a_leftover_stay_however_old_they_are() {
    let dir = TempDir::new();
    let lookalikes = [
        "report.tmp",
        ".report.tmp",
        "settings.json.4242.7.tmp",
        ".settings.json.4242.7.tmp.bak",
        ".settings.json.4242.7.tmp~",
        " .settings.json.4242.7.tmp", // a trailing space would not survive on Windows, a leading one does
        ".settings.json.4242.7.TMP",
        ".settings.json.4242.tmp",
        ".settings.json.4242.7.8.tmp.old",
        ".settings.json.4242.-7.tmp",
        ".settings.json.4242.7 .tmp",
        // Digits of another script are not plain decimal numbers.
        ".settings.json.\u{663}.\u{663}.tmp",
        ".4242.7.tmp",
        "..4242.7.tmp",
        "Thumbs.db.tmp",
        "~$report.docx",
    ];
    for name in lookalikes {
        aged(&dir.join(name), b"user data", 365 * DAY);
    }
    let mut expected: Vec<String> = lookalikes.iter().map(|name| (*name).to_owned()).collect();
    expected.sort();

    assert_eq!(sweep_stale_temp_files(dir.path()), 0);

    assert_eq!(names(dir.path()), expected);
    for name in lookalikes {
        assert_eq!(fs::read(dir.join(name)).unwrap(), b"user data", "{name}");
    }
}

// --- where it looks ----------------------------------------------------------------------------------------------

#[test]
fn it_looks_into_the_one_directory_it_is_given_and_neither_below_nor_above() {
    let data = TempDir::new();
    let beside = aged(
        &data.join(&leftover_name(FILE_NAME, OTHER_PID, 0)),
        b"x",
        DAY,
    );
    let sub = data.join("sub");
    fs::create_dir(&sub).unwrap();
    let below = aged(&sub.join(leftover_name(FILE_NAME, OTHER_PID, 1)), b"x", DAY);
    let deep = sub.join("deeper");
    fs::create_dir(&deep).unwrap();
    let deeper = aged(
        &deep.join(leftover_name(FILE_NAME, OTHER_PID, 2)),
        b"x",
        DAY,
    );

    // Given the subdirectory: its own leftover goes, the one above and the one below do not.
    assert_eq!(sweep_stale_temp_files(&sub), 1);
    assert!(beside.exists());
    assert!(!below.exists());
    assert!(deeper.exists());

    // Given the data directory: only its own leftover goes, the one two levels down stays.
    assert_eq!(sweep_stale_temp_files(data.path()), 1);
    assert!(!beside.exists());
    assert!(deeper.exists());
}

#[test]
fn a_directory_at_a_leftover_name_stays_with_everything_in_it() {
    let dir = TempDir::new();
    let blocker = dir.join(&leftover_name(FILE_NAME, OTHER_PID, 0));
    fs::create_dir(&blocker).unwrap();
    let inside = aged(
        &blocker.join(leftover_name(FILE_NAME, OTHER_PID, 1)),
        b"x",
        DAY,
    );
    let empty = dir.join(&leftover_name("empty", OTHER_PID, 2));
    fs::create_dir(&empty).unwrap();
    age_directory(&blocker, DAY);
    age_directory(&empty, DAY);

    assert_eq!(sweep_stale_temp_files(dir.path()), 0);

    assert!(blocker.is_dir());
    assert!(empty.is_dir());
    assert!(inside.exists());
}

#[test]
fn a_symlinked_directory_is_not_followed_out_of_the_data_directory() {
    let data = TempDir::new();
    let outside = TempDir::new();
    let outside_leftover = aged(
        &outside.join(&leftover_name(FILE_NAME, OTHER_PID, 0)),
        b"not ours to touch",
        DAY,
    );
    let outside_file = aged(&outside.join("notes.txt"), b"notes", DAY);
    // Once under an ordinary name, once under a leftover name.
    if !link_dir(outside.path(), &data.join("linked")) {
        return;
    }
    let named_like_a_leftover = data.join(&leftover_name(FILE_NAME, OTHER_PID, 1));
    assert!(link_dir(outside.path(), &named_like_a_leftover));

    assert_eq!(sweep_stale_temp_files(data.path()), 0);

    assert!(fs::symlink_metadata(data.join("linked")).is_ok());
    assert!(fs::symlink_metadata(&named_like_a_leftover).is_ok());
    assert!(outside_leftover.exists());
    assert_eq!(fs::read(&outside_file).unwrap(), b"notes");
    assert_eq!(fs::read(&outside_leftover).unwrap(), b"not ours to touch");
}

#[test]
fn a_symlink_to_a_file_outside_is_left_alone_and_so_is_the_file() {
    let data = TempDir::new();
    let outside = TempDir::new();
    let precious = aged(&outside.join("precious.pdf"), b"precious", 365 * DAY);
    let link = data.join(&leftover_name(FILE_NAME, OTHER_PID, 0));
    if !link_file(&precious, &link) {
        return;
    }
    let dangling = data.join(&leftover_name(FILE_NAME, OTHER_PID, 1));
    assert!(link_file(&outside.join("missing"), &dangling));

    assert_eq!(sweep_stale_temp_files(data.path()), 0);

    assert!(fs::symlink_metadata(&link).is_ok());
    assert!(fs::symlink_metadata(&dangling).is_ok());
    assert_eq!(fs::read(&precious).unwrap(), b"precious");
}

#[test]
fn a_leftover_that_is_a_second_name_for_another_file_loses_only_its_name() {
    let data = TempDir::new();
    let outside = TempDir::new();
    let precious = aged(&outside.join("precious.pdf"), b"precious", 365 * DAY);
    let second_name = data.join(&leftover_name(FILE_NAME, OTHER_PID, 0));
    if fs::hard_link(&precious, &second_name).is_err() {
        eprintln!("no hard links on this volume: the test stops without checking");
        return;
    }

    // The two names share one file, so the modification time is old for both and the name in the data directory is swept.
    assert_eq!(sweep_stale_temp_files(data.path()), 1);

    assert!(!second_name.exists());
    assert_eq!(fs::read(&precious).unwrap(), b"precious");
}

#[cfg(unix)]
#[test]
fn a_name_that_is_not_valid_text_is_never_taken_for_a_leftover() {
    use std::ffi::OsStr;
    use std::os::unix::ffi::OsStrExt;

    let dir = TempDir::new();
    let mut bytes = b".settings.json.4242.7".to_vec();
    bytes.push(0xFF);
    bytes.extend_from_slice(b".tmp");
    let odd = dir.path().join(OsStr::from_bytes(&bytes));
    aged(&odd, b"x", DAY);

    assert_eq!(sweep_stale_temp_files(dir.path()), 0);

    assert!(odd.exists());
}

// --- around it ---------------------------------------------------------------------------------------------------

#[test]
fn a_missing_directory_or_a_file_in_its_place_is_not_an_error_and_changes_nothing() {
    let dir = TempDir::new();
    let file = aged(&dir.join("a-file"), b"x", DAY);
    let beside = aged(
        &dir.join(&leftover_name(FILE_NAME, OTHER_PID, 0)),
        b"x",
        DAY,
    );

    assert_eq!(sweep_stale_temp_files(&dir.join("missing")), 0);
    assert_eq!(sweep_stale_temp_files(&file), 0);
    assert_eq!(
        sweep_stale_temp_files(&dir.join("a-file").join("deeper")),
        0
    );

    assert!(file.exists());
    assert!(beside.exists());
}

#[test]
fn an_empty_directory_sweeps_nothing() {
    let dir = TempDir::new();
    assert_eq!(sweep_stale_temp_files(dir.path()), 0);
    assert!(names(dir.path()).is_empty());
}

#[test]
fn a_sweep_while_other_threads_write_never_breaks_a_write() {
    let dir = TempDir::new();
    let stale = aged(
        &dir.join(&leftover_name("old.json", OTHER_PID, 0)),
        b"x",
        DAY,
    );
    let done = Arc::new(AtomicBool::new(false));
    let writers: Vec<_> = (0..4)
        .map(|writer| {
            let target = dir.join(&format!("file-{writer}.json"));
            thread::spawn(move || {
                for round in 0..100 {
                    write_atomic(&target, format!("{writer}:{round}").as_bytes()).unwrap();
                }
            })
        })
        .collect();
    let sweeper = {
        let directory = dir.path().to_owned();
        let done = Arc::clone(&done);
        thread::spawn(move || {
            let mut removed = 0;
            while !done.load(Ordering::Relaxed) {
                removed += sweep_stale_temp_files(&directory);
            }
            removed + sweep_stale_temp_files(&directory)
        })
    };
    for writer in writers {
        writer.join().unwrap();
    }
    done.store(true, Ordering::Relaxed);
    // Only the planted leftover is ever removed: the temp files of the writers are minutes younger than the age.
    assert_eq!(sweeper.join().unwrap(), 1);

    assert!(!stale.exists());
    for writer in 0..4 {
        assert_eq!(
            fs::read(dir.join(&format!("file-{writer}.json"))).unwrap(),
            format!("{writer}:99").into_bytes()
        );
    }
    assert_eq!(names(dir.path()).len(), 4);
}
