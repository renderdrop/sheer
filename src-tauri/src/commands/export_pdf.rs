// owned by package C
//! Export a copy (ARCHITECTURE §5 "Convert and output", ADR-049 §5).
//!
//! | Command | Arguments | Returns |
//! |---|---|---|
//! | `export_pdf` | `docId`, `opts: { annotations: keep \| flatten \| remove, removeMetadata }`, `ack: SaveAck`, `onEvent: Channel<JobEvent>` | `JobId`, or `null` (Save As cancelled); the open document and its path stay as they are, nothing opens |

use tauri::ipc::Channel;
use tauri::{State, WebviewWindow};

use super::jobs::{channel_sink, EventSink, JobEvent, JobId};
use super::save::SaveAck;
use super::{blocking, AppState};
use crate::documents::DocumentId;
use crate::error::{AppError, UiError};
use crate::pdfwrite::export::PdfExportOptions;

impl AppState {
    /// Asks for the target and starts the export of a copy of document `id`. Stub (package C): `not_yet`.
    pub fn start_export_pdf(
        &self,
        _window: &WebviewWindow,
        _id: DocumentId,
        _opts: &PdfExportOptions,
        _ack: SaveAck,
        _sink: std::sync::Arc<dyn EventSink>,
    ) -> Result<Option<JobId>, AppError> {
        Err(AppError::not_yet())
    }
}

/// Writes a copy of the document as it is now, with or without annotations and metadata, to a file chosen in Rust's Save As dialog.
#[tauri::command]
pub async fn export_pdf(
    window: WebviewWindow,
    state: State<'_, AppState>,
    doc_id: DocumentId,
    opts: PdfExportOptions,
    ack: SaveAck,
    on_event: Channel<JobEvent>,
) -> Result<Option<JobId>, UiError> {
    let state = state.inner().clone();
    blocking(move || state.start_export_pdf(&window, doc_id, &opts, ack, channel_sink(on_event)))
        .await
}
