//! Images to PDF (ARCHITECTURE §5 "Convert and output", ADR-049 §3).
//!
//! | Command | Arguments | Returns |
//! |---|---|---|
//! | `images_to_pdf` | `opts: ImagesToPdfOptions`, `onEvent: Channel<JobEvent>` | `JobId`, or `null` (a dialog was cancelled); `done.opened` is the new document, `done.skipped` the images left out |
//! | `release_image_batch` | `batch` | nothing; an unknown id is not an error |
//!
//! The images come from Rust's open dialog or from a dropped batch; the target from Rust's Save As dialog.

use tauri::ipc::Channel;
use tauri::{State, WebviewWindow};

use super::jobs::{channel_sink, JobEvent, JobId};
use super::{blocking, AppState};
use crate::error::UiError;
use crate::export::from_images::{self, ImagesToPdfOptions};

/// Builds a PDF from images and opens it.
#[tauri::command]
pub async fn images_to_pdf(
    window: WebviewWindow,
    state: State<'_, AppState>,
    opts: ImagesToPdfOptions,
    on_event: Channel<JobEvent>,
) -> Result<Option<JobId>, UiError> {
    let state = state.inner().clone();
    blocking(move || from_images::start(&state, &window, &opts, channel_sink(on_event))).await
}

/// Lets go of a dropped image batch.
#[tauri::command]
pub async fn release_image_batch(state: State<'_, AppState>, batch: u32) -> Result<(), UiError> {
    let state = state.inner().clone();
    blocking(move || from_images::release_batch(&state, batch)).await
}
