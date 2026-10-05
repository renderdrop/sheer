//! Saving an unsigned copy (ADR-121 section 1, ARCHITECTURE section 5 "Certificate signatures (v1.4)").
//!
//! | Command | Arguments | Returns |
//! |---|---|---|
//! | `save_unsigned_copy` | `docId: number` | `AppEvent \| null` (`opened` for the new document; `null` = the save dialog was cancelled) |
//!
//! A signed document is locked (`SignatureLock`) and saved incrementally only. This is the way out: a Full rewrite of the current state
//! (the session's form fills and annotations included) without `/Perms`, signature values, signature dictionaries and the widgets of the
//! signed fields (`pdfwrite::unsign`). The target comes from a Rust save dialog and goes through `intake::admit_target`; it is never the
//! file of the document itself, so the original, which stays open and as it is, is never touched. The copy is opened as a new document
//! and is editable (nothing in it is signed).

use std::path::Path;

use tauri::{State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

use super::jobs::file_stem;
use super::{blocking, AppState};
use crate::documents::intake;
use crate::documents::{DocKind, DocumentId};
use crate::error::{AppError, ErrorCode, UiError};
use crate::events::AppEvent;
use crate::pdfwrite::unsign;
use crate::storage::atomic;

impl AppState {
    /// Writes the current state of document `id` without signatures to `target` (a path from the dialog) and opens the result.
    /// `invalid_argument` (`target`) for the document's own file, `io_in_use` for a file that is open as another document,
    /// `unsupported_feature` for an encrypted document (the copy would silently drop its protection), `needs_confirmation`
    /// (`fileChangedOnDisk`) when the file changed since it was opened. Nothing is written on a failure.
    pub fn save_unsigned_copy_to(
        &self,
        id: DocumentId,
        target: &Path,
    ) -> Result<AppEvent, AppError> {
        let info = self.info(id).ok_or(AppError::not_found("document"))?;
        if info.flags.encrypted {
            return Err(AppError::unsupported("encrypted"));
        }
        let source = self
            .registry
            .path(id)
            .ok_or(AppError::not_found("document"))?;
        let target = intake::admit_target(target)?;
        let target = std::fs::canonicalize(&target).unwrap_or(target);
        if target == source {
            return Err(AppError::invalid("target"));
        }
        if self.registry.is_open_elsewhere(id, &target) {
            return Err(AppError::new(ErrorCode::IoInUse));
        }
        let snapshot = self.snapshot_bytes(id)?;
        let bytes = unsign::strip_signatures(snapshot)?;
        // The result has to be a document before it replaces anything.
        crate::pdfwrite::load_untrusted(&bytes)?;
        // Only a file this call made may be taken back (a chosen file that was already there is the user's).
        let existed = target.exists();
        atomic::replace_atomic(&target, &bytes)?;
        let opened = self
            .open_as(target.clone(), DocKind::User, None)
            .and_then(|opened| {
                opened
                    .into_event()
                    .ok_or_else(|| AppError::new(ErrorCode::Internal))
            });
        if opened.is_err() && !existed {
            // What was written does not open: it is not left behind as a copy the user would trust.
            let _ = std::fs::remove_file(&target);
        }
        opened
    }
}

/// Asks where to save (a native dialog, shown from Rust) and writes a copy of document `doc_id` without signatures there, then opens
/// it. `null` if the user cancelled the dialog.
#[tauri::command]
pub async fn save_unsigned_copy(
    window: WebviewWindow,
    state: State<'_, AppState>,
    doc_id: DocumentId,
) -> Result<Option<AppEvent>, UiError> {
    let state = state.inner().clone();
    blocking(move || {
        let info = state.info(doc_id).ok_or(AppError::not_found("document"))?;
        let mut dialog = window
            .dialog()
            .file()
            .set_parent(&window)
            .add_filter("PDF", &["pdf"]);
        if !info.display_name.is_empty() {
            dialog =
                dialog.set_file_name(format!("{} (unsigned).pdf", file_stem(&info.display_name)));
        }
        let Some(chosen) = dialog.blocking_save_file() else {
            return Ok(None);
        };
        let path = chosen
            .into_path()
            .map_err(|error| AppError::logged(ErrorCode::Internal, error))?;
        state.save_unsigned_copy_to(doc_id, &path).map(Some)
    })
    .await
}
