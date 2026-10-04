//! The parent's table of open intake handles (ADR-053 §1.5): the engine child never opens a path, it reads through a [`FileToken`].
//!
//! Handles cannot cross a process boundary without unsafe, and opening a path again in the child would break "open once, judge the
//! handle" (`documents::intake`). So the parent keeps the `File` that passed intake here, and the child's `RemoteFile` asks for ranges
//! of it (`WireReply::ReadAt`), which the parent answers on its reader thread with [`FileTable::read_at`]. `release` drops the handle
//! in the parent too, so a later `ReplaceFile` still works on Windows. Parent only.

use std::collections::HashMap;
use std::fs::File;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, ErrorCode};
use crate::limits;

/// Names one handle of a [`FileTable`] on the wire. Opaque and never reused within a process, so a stale token from a child that
/// outlived its release finds nothing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct FileToken(u64);

impl FileToken {
    pub const fn get(self) -> u64 {
        self.0
    }
}

/// The open handles, by token. Shared by the pump (insert, release) and the reader thread (`read_at`).
#[derive(Debug, Default)]
pub struct FileTable {
    next: AtomicU64,
    files: Mutex<HashMap<FileToken, Arc<File>>>,
}

impl FileTable {
    pub fn new() -> Self {
        Self::default()
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<FileToken, Arc<File>>> {
        // A poisoned lock only means a holder panicked; the map stays consistent.
        self.files.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Takes over `file` and names it.
    pub fn insert(&self, file: File) -> FileToken {
        let token = FileToken(self.next.fetch_add(1, Ordering::Relaxed) + 1);
        self.lock().insert(token, Arc::new(file));
        token
    }

    /// The handle of `token`, if it is still held.
    pub fn get(&self, token: FileToken) -> Option<Arc<File>> {
        self.lock().get(&token).map(Arc::clone)
    }

    /// Drops the handle of `token` (the file is closed once nobody else holds it). `true` if there was one.
    pub fn release(&self, token: FileToken) -> bool {
        self.lock().remove(&token).is_some()
    }

    /// How many handles are held.
    pub fn len(&self) -> usize {
        self.lock().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Up to `len` bytes of the file at `offset`, fewer at its end (empty at or past it). The child is hostile input: `len` over
    /// [`limits::READ_AT_MAX`] is `invalid_argument` and an unknown token is `not_found`, both before any read.
    pub fn read_at(&self, token: FileToken, offset: u64, len: u32) -> Result<Vec<u8>, AppError> {
        let wanted = usize::try_from(len).map_err(|_| AppError::invalid("read"))?;
        if wanted > limits::READ_AT_MAX {
            return Err(AppError::invalid("read"));
        }
        let file = self.get(token).ok_or(AppError::not_found("file"))?;
        let mut buffer = vec![0u8; wanted];
        let mut filled = 0usize;
        while filled < wanted {
            let at = offset
                .checked_add(filled as u64)
                .ok_or(AppError::invalid("read"))?;
            let read = read_some(&file, &mut buffer[filled..], at)
                .map_err(|error| AppError::logged(ErrorCode::Internal, error))?;
            if read == 0 {
                break;
            }
            filled += read;
        }
        buffer.truncate(filled);
        Ok(buffer)
    }
}

#[cfg(unix)]
fn read_some(file: &File, buffer: &mut [u8], offset: u64) -> std::io::Result<usize> {
    std::os::unix::fs::FileExt::read_at(file, buffer, offset)
}

#[cfg(windows)]
fn read_some(file: &File, buffer: &mut [u8], offset: u64) -> std::io::Result<usize> {
    std::os::windows::fs::FileExt::seek_read(file, buffer, offset)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn table_with(bytes: &[u8]) -> (FileTable, FileToken, std::path::PathBuf) {
        let path = std::env::temp_dir().join(format!(
            "sheer-files-{}-{}.bin",
            std::process::id(),
            bytes.len()
        ));
        let mut file = File::create(&path).unwrap();
        file.write_all(bytes).unwrap();
        drop(file);
        let table = FileTable::new();
        let token = table.insert(File::open(&path).unwrap());
        (table, token, path)
    }

    #[test]
    fn reads_ranges_and_stops_at_the_end() {
        let (table, token, path) = table_with(b"0123456789");
        assert_eq!(table.read_at(token, 2, 4).unwrap(), b"2345");
        assert_eq!(table.read_at(token, 8, 10).unwrap(), b"89");
        assert!(table.read_at(token, 10, 4).unwrap().is_empty());
        assert!(
            table.read_at(token, u64::MAX, 4).is_err()
                || table.read_at(token, u64::MAX, 4).unwrap().is_empty()
        );
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn refuses_oversized_reads_and_unknown_tokens() {
        let (table, token, path) = table_with(b"abc");
        let too_long = u32::try_from(limits::READ_AT_MAX + 1).unwrap();
        assert_eq!(
            table.read_at(token, 0, too_long).unwrap_err().code(),
            ErrorCode::InvalidArgument
        );
        assert!(table.release(token));
        assert!(!table.release(token));
        assert_eq!(
            table.read_at(token, 0, 1).unwrap_err().code(),
            ErrorCode::NotFound
        );
        assert!(table.is_empty());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn tokens_are_never_reused() {
        let (table, first, path) = table_with(b"x");
        table.release(first);
        let second = table.insert(File::open(&path).unwrap());
        assert_ne!(first, second);
        assert_eq!(table.len(), 1);
        let _ = std::fs::remove_file(path);
    }
}
