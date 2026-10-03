// owned by package A
//! PDF to images (ARCHITECTURE §5 "Convert and output", ADR-049 §2).
//!
//! | Command | Arguments | Returns |
//! |---|---|---|
//! | `export_images` | `docId`, `opts: ImageExportOptions`, `onEvent: Channel<JobEvent>` | `ExportStart`: `started { jobId }`, `cancelled` (folder dialog), or `conflicts { ticket, count, names }` |
//! | `resolve_export_conflicts` | `ticket`, `choice: replace \| keepBoth \| cancel`, `onEvent` | `JobId`, or `null` (cancel, expired ticket) |
//!
//! The folder comes from Rust's dialog after validation; paths never reach the webview.

use tauri::ipc::Channel;
use tauri::{State, WebviewWindow};

use super::jobs::{channel_sink, JobEvent, JobId};
use super::{blocking, AppState};
use crate::documents::DocumentId;
use crate::error::{AppError, UiError};
use crate::export::images::{
    self, ConflictChoice, ExportFacts, ExportStart, ImageExportOptions, PageFact,
};
use crate::model::protection::Permission;

/// Validates, asks for a folder and renders the pages to image files.
#[tauri::command]
pub async fn export_images(
    window: WebviewWindow,
    state: State<'_, AppState>,
    doc_id: DocumentId,
    opts: ImageExportOptions,
    on_event: Channel<JobEvent>,
) -> Result<ExportStart, UiError> {
    let state = state.inner().clone();
    blocking(move || images::start(&state, &window, doc_id, &opts, channel_sink(on_event))).await
}

/// Carries out the user's choice for files that exist already.
#[tauri::command]
pub async fn resolve_export_conflicts(
    state: State<'_, AppState>,
    ticket: u32,
    choice: ConflictChoice,
    on_event: Channel<JobEvent>,
) -> Result<Option<JobId>, UiError> {
    let state = state.inner().clone();
    blocking(move || images::resolve(&state, ticket, choice, channel_sink(on_event))).await
}

impl AppState {
    /// What an image export needs to know about document `id`: its display name and its pages as the model has them now (id, place in
    /// PDFium's live copy, drawn size). A restricted document that does not allow copying is `read_only` (`permission`).
    pub fn export_facts(&self, id: DocumentId) -> Result<ExportFacts, AppError> {
        let info = self.info(id).ok_or(AppError::not_found("document"))?;
        if let Some(allowed) = info.flags.permissions {
            if !allowed.contains(Permission::Copy) {
                return Err(AppError::read_only("permission"));
            }
        }
        let pages = self.model(id, |state| {
            Ok(state
                .pages()
                .iter()
                .map(|slot| PageFact {
                    id: slot.id,
                    engine_index: slot.engine_index,
                    drawn: if slot.rotation % 180 == 90 {
                        [slot.size[1], slot.size[0]]
                    } else {
                        slot.size
                    },
                })
                .collect())
        })?;
        Ok(ExportFacts {
            doc: id,
            display_name: info.display_name,
            pages,
        })
    }
}
