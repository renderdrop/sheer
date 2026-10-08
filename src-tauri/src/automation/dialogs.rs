//! The dialog seam. Every call site names these functions instead of `blocking_pick_file` and friends (a test greps for the rest).
//!
//! Each function takes the configured builder (title, filters, parent, start folder) and answers like the native call, plus an error:
//! `Ok(None)` is a cancelled dialog. Without the feature the error never occurs.

use tauri::{Runtime, WebviewWindow};
use tauri_plugin_dialog::{FileDialogBuilder, FilePath, MessageDialogBuilder};

use crate::error::AppError;

/// Shows the open dialog for one file.
pub fn pick_file<R: Runtime>(builder: FileDialogBuilder<R>) -> Result<Option<FilePath>, AppError> {
    #[cfg(feature = "automation")]
    {
        drop(builder);
        automation::path(super::queue::DialogKind::Open)
    }
    #[cfg(not(feature = "automation"))]
    Ok(builder.blocking_pick_file())
}

/// Shows the open dialog for any number of files.
pub fn pick_files<R: Runtime>(
    builder: FileDialogBuilder<R>,
) -> Result<Option<Vec<FilePath>>, AppError> {
    #[cfg(feature = "automation")]
    {
        drop(builder);
        automation::paths(super::queue::DialogKind::OpenMany)
    }
    #[cfg(not(feature = "automation"))]
    Ok(builder.blocking_pick_files())
}

/// Shows the folder picker.
pub fn pick_folder<R: Runtime>(
    builder: FileDialogBuilder<R>,
) -> Result<Option<FilePath>, AppError> {
    #[cfg(feature = "automation")]
    {
        drop(builder);
        automation::path(super::queue::DialogKind::Folder)
    }
    #[cfg(not(feature = "automation"))]
    Ok(builder.blocking_pick_folder())
}

/// Shows the save dialog.
pub fn save_file<R: Runtime>(builder: FileDialogBuilder<R>) -> Result<Option<FilePath>, AppError> {
    #[cfg(feature = "automation")]
    {
        drop(builder);
        automation::path(super::queue::DialogKind::Save)
    }
    #[cfg(not(feature = "automation"))]
    Ok(builder.blocking_save_file())
}

/// Shows a message or confirm dialog; `true` is the confirming button.
pub fn message<R: Runtime>(builder: MessageDialogBuilder<R>) -> Result<bool, AppError> {
    #[cfg(feature = "automation")]
    {
        drop(builder);
        let entry = super::queue::global().take(super::queue::DialogKind::Message)?;
        Ok(entry.confirms())
    }
    #[cfg(not(feature = "automation"))]
    Ok(builder.blocking_show())
}

/// Opens the print dialog of the webview for the set `print_id` of `pages` pages. With the feature nothing is opened and nothing is
/// printed: the set is recorded for `automation_state` (a `print` entry must be queued) and the answer is `true` ("recorded"), so the
/// frontend does not wait for an `afterprint` that never comes. Without the feature the answer is `false`.
pub fn print<R: Runtime>(
    window: &WebviewWindow<R>,
    print_id: u32,
    pages: usize,
) -> Result<bool, AppError> {
    #[cfg(feature = "automation")]
    {
        let _ = window;
        super::queue::global().record_print(print_id, pages)?;
        Ok(true)
    }
    #[cfg(not(feature = "automation"))]
    {
        let _ = (print_id, pages);
        window.print().map(|()| false).map_err(|error| {
            AppError::logged(crate::error::ErrorCode::Internal, error).log();
            AppError::unsupported("printDialog")
        })
    }
}

/// Opens the default-apps page of the OS through `open`. With the feature nothing is opened (`Ok(false)`, "recorded"); otherwise
/// `Ok(true)` after `open` ran.
pub fn open_os_settings<F: FnOnce() -> Result<(), AppError>>(open: F) -> Result<bool, AppError> {
    #[cfg(feature = "automation")]
    {
        drop(open);
        Ok(false)
    }
    #[cfg(not(feature = "automation"))]
    open().map(|()| true)
}

/// A save dialog that has no document to take its folder from starts in the user's documents folder, not wherever the last dialog
/// left the OS. Without a documents folder the builder is returned as it is.
pub fn in_documents_folder<R: Runtime>(
    builder: FileDialogBuilder<R>,
    window: &WebviewWindow<R>,
) -> FileDialogBuilder<R> {
    use tauri::Manager;
    match window.path().document_dir() {
        Ok(folder) => builder.set_directory(folder),
        Err(_) => builder,
    }
}

/// The call sites chain the seam onto the builder where they chained `blocking_*` before: `.seam_pick_file()?` for `.blocking_pick_file()`.
/// `tests/automation_seam.rs` fails when a `blocking_*` dialog call appears outside this module.
pub trait DialogSeam: Sized {
    fn seam_pick_file(self) -> Result<Option<FilePath>, AppError>;
    fn seam_pick_files(self) -> Result<Option<Vec<FilePath>>, AppError>;
    fn seam_pick_folder(self) -> Result<Option<FilePath>, AppError>;
    fn seam_save_file(self) -> Result<Option<FilePath>, AppError>;
}

/// The same for message dialogs: `.seam_show()` for `.blocking_show()`.
pub trait MessageSeam: Sized {
    fn seam_show(self) -> Result<bool, AppError>;
}

impl<R: Runtime> MessageSeam for MessageDialogBuilder<R> {
    fn seam_show(self) -> Result<bool, AppError> {
        message(self)
    }
}

impl<R: Runtime> DialogSeam for FileDialogBuilder<R> {
    fn seam_pick_file(self) -> Result<Option<FilePath>, AppError> {
        pick_file(self)
    }
    fn seam_pick_files(self) -> Result<Option<Vec<FilePath>>, AppError> {
        pick_files(self)
    }
    fn seam_pick_folder(self) -> Result<Option<FilePath>, AppError> {
        pick_folder(self)
    }
    fn seam_save_file(self) -> Result<Option<FilePath>, AppError> {
        save_file(self)
    }
}

#[cfg(feature = "automation")]
mod automation {
    use std::path::PathBuf;

    use tauri_plugin_dialog::FilePath;

    use crate::automation::queue::{global, DialogKind};
    use crate::error::AppError;

    fn file_path(path: String) -> FilePath {
        FilePath::Path(PathBuf::from(path))
    }

    /// One path (open, folder, save); `None` when the entry cancels.
    pub fn path(kind: DialogKind) -> Result<Option<FilePath>, AppError> {
        let entry = global().take(kind)?;
        if entry.cancel {
            return Ok(None);
        }
        let first = entry.paths.into_iter().next();
        first
            .map(|path| Some(file_path(path)))
            .ok_or_else(|| AppError::invalid("paths"))
    }

    /// Several paths (open many); `None` when the entry cancels.
    pub fn paths(kind: DialogKind) -> Result<Option<Vec<FilePath>>, AppError> {
        let entry = global().take(kind)?;
        if entry.cancel {
            return Ok(None);
        }
        Ok(Some(entry.paths.into_iter().map(file_path).collect()))
    }
}

#[cfg(all(test, not(feature = "automation")))]
mod tests {
    use super::*;

    #[test]
    fn without_the_feature_the_settings_opener_runs_and_reports_true() {
        let mut ran = false;
        assert!(open_os_settings(|| {
            ran = true;
            Ok(())
        })
        .unwrap());
        assert!(ran);
    }

    #[test]
    fn without_the_feature_an_opener_error_is_passed_on() {
        assert!(open_os_settings(|| Err(AppError::unsupported("x"))).is_err());
    }
}
