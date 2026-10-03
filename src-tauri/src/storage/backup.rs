//! Backups of the originals (ADR-004 §3): the first save over a file in a session copies the file as it was to
//! `<app data>/backups/<timestamp>-<name>-<hash>.pdf`. They are kept for 30 days or up to 2 GB in all, whichever is less.
//!
//! The name is made of the time of the save, the file's name cut to plain ASCII, and eight hex digits of a hash of its full path, so two
//! files of one name in different folders do not collide and a name with odd characters cannot do anything in the backup folder.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use super::atomic::write_atomic;

/// Longest stem kept in the name of a backup, in characters.
const MAX_STEM_CHARS: usize = 40;

/// Eight hex digits that tell paths apart (FNV-1a over the path's text; not a security measure).
fn path_hash(path: &Path) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in path.to_string_lossy().bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{:08x}", hash & 0xffff_ffff)
}

/// `<stamp>-<stem>-<hash>.pdf` for the file at `source`; `stamp` is the time as digits and `T`/`Z` only.
pub fn backup_name(stamp: &str, source: &Path) -> String {
    let stem: String = source
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .unwrap_or_default()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' {
                c
            } else {
                '_'
            }
        })
        .take(MAX_STEM_CHARS)
        .collect();
    let stamp: String = stamp
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect();
    format!("{stamp}-{stem}-{}.pdf", path_hash(source))
}

/// Writes `bytes`, the original of `source`, into `directory` (made if it is missing) and returns where.
pub fn write_backup(
    directory: &Path,
    stamp: &str,
    source: &Path,
    bytes: &[u8],
) -> io::Result<PathBuf> {
    let target = directory.join(backup_name(stamp, source));
    write_atomic(&target, bytes)?;
    Ok(target)
}

/// Removes the backups in `directory` that are older than `keep` as of `now`, then the oldest ones until the rest take at most
/// `max_bytes`. Only regular files named `*.pdf` are looked at. Best effort: what cannot be read or removed is left. Returns how many
/// were removed.
pub fn prune(directory: &Path, now: SystemTime, keep: Duration, max_bytes: u64) -> usize {
    let Ok(listing) = fs::read_dir(directory) else {
        return 0;
    };
    let mut files: Vec<(SystemTime, u64, PathBuf)> = listing
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let path = entry.path();
            let metadata = entry.metadata().ok()?;
            let is_backup = metadata.is_file()
                && path
                    .extension()
                    .is_some_and(|extension| extension.eq_ignore_ascii_case("pdf"));
            is_backup.then(|| (metadata.modified().unwrap_or(now), metadata.len(), path))
        })
        .collect();
    files.sort_by_key(|(modified, _, _)| *modified);
    let mut removed = 0;
    let mut total: u64 = files.iter().map(|(_, len, _)| *len).sum();
    for (modified, len, path) in files {
        let too_old = now.duration_since(modified).is_ok_and(|age| age > keep);
        if (too_old || total > max_bytes) && fs::remove_file(&path).is_ok() {
            total = total.saturating_sub(len);
            removed += 1;
        }
    }
    removed
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::atomic::testutil::TempDir;

    #[test]
    fn a_name_has_the_time_a_plain_stem_and_a_hash_of_the_path() {
        let a = backup_name(
            "20261003T120000Z",
            Path::new("/home/ada/Rechnung \u{E4}.pdf"),
        );
        assert!(a.starts_with("20261003T120000Z-Rechnung__-"), "{a}");
        assert!(a.ends_with(".pdf"));
        let b = backup_name(
            "20261003T120000Z",
            Path::new("/home/bob/Rechnung \u{E4}.pdf"),
        );
        assert_ne!(a, b, "the folder is part of the hash");
        let odd = backup_name("x", Path::new("/a/../..\\evil.pdf"));
        assert!(!odd.contains('/') && !odd.contains('\\') && !odd.contains(".."));
    }

    #[test]
    fn a_backup_is_written_and_old_or_surplus_ones_are_pruned() {
        let dir = TempDir::new();
        let source = Path::new("/docs/a.pdf");
        let first = write_backup(dir.path(), "20261003T120000Z", source, &[1; 100]).unwrap();
        assert_eq!(fs::read(&first).unwrap(), vec![1; 100]);
        write_backup(dir.path(), "20261004T120000Z", source, &[2; 100]).unwrap();
        let now = SystemTime::now();
        // Nothing is old; the budget fits both.
        assert_eq!(prune(dir.path(), now, Duration::from_secs(60), 1000), 0);
        // Over budget: the oldest goes.
        assert_eq!(prune(dir.path(), now, Duration::from_secs(60), 150), 1);
        // The rest is older than the limit a day on.
        let later = now + Duration::from_secs(86_400);
        assert_eq!(prune(dir.path(), later, Duration::from_secs(60), 1000), 1);
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[test]
    fn pruning_leaves_other_files_alone() {
        let dir = TempDir::new();
        fs::write(dir.path().join("notes.txt"), b"keep me").unwrap();
        let later = SystemTime::now() + Duration::from_secs(86_400);
        assert_eq!(prune(dir.path(), later, Duration::from_secs(1), 0), 0);
        assert!(dir.path().join("notes.txt").exists());
    }
}
