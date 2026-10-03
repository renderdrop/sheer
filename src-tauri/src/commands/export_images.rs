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
use crate::error::UiError;
use crate::export::images::{self, ConflictChoice, ExportStart, ImageExportOptions};

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
