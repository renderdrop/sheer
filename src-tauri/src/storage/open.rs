//! Opening a file the user pointed at, without ever waiting on it.

use std::fs::{File, OpenOptions};
use std::io;
use std::path::Path;

/// Opens `path` for reading without waiting, whatever is there. `open` on a FIFO blocks until a writer appears, which would
/// hang the caller (the start of the app, an intake worker); `O_NONBLOCK` makes it return at once (it has no effect on a
/// regular file). `O_NOCTTY` keeps a terminal device from becoming the controlling terminal. Neither is read: a handle that
/// is not a regular file is turned down by the caller, on the opened handle (`storage::settings`, `documents::intake`).
#[cfg(unix)]
pub(crate) fn open_without_blocking(path: &Path) -> io::Result<File> {
    use std::os::unix::fs::OpenOptionsExt;

    OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK | libc::O_NOCTTY)
        .open(path)
}

/// Opens `path` for reading. `FILE_FLAG_BACKUP_SEMANTICS` lets a directory be opened, so that one is turned down by the
/// type check on the handle like on Unix instead of failing at the open with "access denied".
#[cfg(windows)]
pub(crate) fn open_without_blocking(path: &Path) -> io::Result<File> {
    use std::os::windows::fs::OpenOptionsExt;

    const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
    OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
        .open(path)
}

#[cfg(not(any(unix, windows)))]
pub(crate) fn open_without_blocking(path: &Path) -> io::Result<File> {
    OpenOptions::new().read(true).open(path)
}
