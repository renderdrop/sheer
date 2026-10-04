//! Images to PDF (ARCHITECTURE §5 "Convert and output", ADR-049 §3).
//!
//! | Command | Arguments | Returns |
//! |---|---|---|
//! | `images_to_pdf` | `opts: ImagesToPdfOptions`, `order?: u32[]` (batch source only: indices into the batch to use, in page order; a permutation or subset, at most 500, no repeats), `onEvent: Channel<JobEvent>` | `JobId`, or `null` (a dialog was cancelled); `done.opened` is the new document, `done.skipped` the images left out |
//! | `pick_images` | `batch?` | `{ batch, count, added, skipped }` or `null` (cancelled, or no usable image): the Rust open dialog appends PNG/JPEG files to `batch` (a new batch when absent); `count` is the batch size now |
//! | `list_image_batch` | `batch` | `[{ index, name, width, height }]`; `name` is the file name only (at most 120 characters), the size is what the header declares (`0` if unreadable); `not_found` `imageBatch` when expired |
//! | `get_image_batch_preview` | `batch`, `index`, `maxPx` (16 to 512) | an `SHR1` frame (PNG), decoded under the M5 intake limits and cached per batch |
//! | `release_image_batch` | `batch` | nothing; an unknown id is not an error |
//!
//! The images come from Rust's open dialog or from a dropped batch; the target from Rust's Save As dialog.

use tauri::ipc::{Channel, Response};
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
    order: Option<Vec<u32>>,
    on_event: Channel<JobEvent>,
) -> Result<Option<JobId>, UiError> {
    let state = state.inner().clone();
    blocking(move || {
        from_images::start(
            &state,
            &window,
            &opts,
            order.as_deref(),
            channel_sink(on_event),
        )
    })
    .await
}

/// Lets go of a dropped image batch.
#[tauri::command]
pub async fn release_image_batch(state: State<'_, AppState>, batch: u32) -> Result<(), UiError> {
    let state = state.inner().clone();
    blocking(move || from_images::release_batch(&state, batch)).await
}

/// Opens the image dialog and adds the picked images to a batch.
#[tauri::command]
pub async fn pick_images(
    window: WebviewWindow,
    batch: Option<u32>,
) -> Result<Option<from_images::PickedImages>, UiError> {
    blocking(move || from_images::pick_images(&window, batch)).await
}

/// The images of a batch: index, display name, declared size.
#[tauri::command]
pub async fn list_image_batch(batch: u32) -> Result<Vec<from_images::BatchItem>, UiError> {
    blocking(move || from_images::list_batch(batch)).await
}

/// A thumbnail frame of one image of a batch.
#[tauri::command]
pub async fn get_image_batch_preview(
    batch: u32,
    index: u32,
    max_px: u16,
) -> Result<Response, UiError> {
    blocking(move || from_images::batch_preview(batch, index, max_px))
        .await
        .map(|frame| Response::new(frame.as_ref().clone()))
}
