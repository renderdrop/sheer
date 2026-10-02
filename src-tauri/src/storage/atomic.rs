//! Atomic file replacement: write a temp file next to the target, flush it to disk, then rename it over the target.
//!
//! A crash or power loss leaves either the old file or the new one, never a half-written mix. The temp file lives in
//! the same directory (a rename across volumes is not atomic) and is removed again if any step fails.

use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

/// Replaces the file at `path` with `bytes`. Creates missing parent directories.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let (Some(directory), Some(name)) = (path.parent(), path.file_name()) else {
        return Err(io::Error::from(io::ErrorKind::InvalidInput));
    };
    fs::create_dir_all(directory)?;

    let temp = temp_path(directory, name);
    let result = write_synced(&temp, bytes).and_then(|()| fs::rename(&temp, path));
    if result.is_err() {
        // Best effort: the original error is the one the caller needs.
        let _ = fs::remove_file(&temp);
        return result;
    }
    sync_directory(directory);
    Ok(())
}

/// `<directory>/.<name>.tmp`: hidden, and recognisable if a crash ever leaves one behind.
fn temp_path(directory: &Path, name: &std::ffi::OsStr) -> PathBuf {
    let mut temp_name = std::ffi::OsString::from(".");
    temp_name.push(name);
    temp_name.push(".tmp");
    directory.join(temp_name)
}

fn write_synced(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut file = File::create(path)?;
    file.write_all(bytes)?;
    file.sync_all()
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
}
