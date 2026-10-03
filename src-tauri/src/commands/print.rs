// owned by package D
//! Print (ARCHITECTURE §5 "Convert and output", ADR-049 §4).
//!
//! | Command | Arguments | Returns |
//! |---|---|---|
//! | `prepare_print` | `docId`, `opts: PrintOptions`, `onEvent: Channel<JobEvent>` | `JobId`; `done.print` is `{ printId, pages }` |
//! | `get_print_page` | `printId`, `index` | an SHR1 JPEG frame (binary); `index < done.print.pages` |
//! | `open_print_dialog` | `printId` | `PrintRoute`: `system` or `webview`; main window only, the set must be complete |
//! | `release_print` | `printId` | nothing; also on `close_document` and after ten minutes |

use tauri::ipc::{Channel, Response};
use tauri::{State, WebviewWindow};

use super::jobs::{channel_sink, JobEvent, JobId};
use super::{blocking, AppState};
use crate::documents::DocumentId;
use crate::error::UiError;
use crate::print::{self, PrintOptions, PrintRoute};

/// Renders the pages to be printed into a print set.
#[tauri::command]
pub async fn prepare_print(
    state: State<'_, AppState>,
    doc_id: DocumentId,
    opts: PrintOptions,
    on_event: Channel<JobEvent>,
) -> Result<JobId, UiError> {
    let state = state.inner().clone();
    blocking(move || print::prepare(&state, doc_id, &opts, channel_sink(on_event))).await
}

/// One page of a print set, as a frame.
#[tauri::command]
pub async fn get_print_page(
    state: State<'_, AppState>,
    print_id: u32,
    index: u32,
) -> Result<Response, UiError> {
    let state = state.inner().clone();
    blocking(move || print::page(&state, print_id, index))
        .await
        .map(Response::new)
}

/// Opens the print dialog for a complete set.
#[tauri::command]
pub async fn open_print_dialog(
    window: WebviewWindow,
    state: State<'_, AppState>,
    print_id: u32,
) -> Result<PrintRoute, UiError> {
    let state = state.inner().clone();
    blocking(move || print::open_dialog(&state, &window, print_id)).await
}

/// Drops a print set.
#[tauri::command]
pub async fn release_print(state: State<'_, AppState>, print_id: u32) -> Result<(), UiError> {
    let state = state.inner().clone();
    blocking(move || print::release(&state, print_id)).await
}
