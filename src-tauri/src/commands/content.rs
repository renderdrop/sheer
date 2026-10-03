//! Text boxes and images on the page (ARCHITECTURE §5 "Edit and protect", ADR-047 §1). owned by package A.
//!
//! | Command | Arguments | Returns |
//! |---|---|---|
//! | `insert_image_dialog` | `docId` | `ImageAssetInfo`, or `null` if the native dialog was cancelled; PNG or JPEG, the pixels become a document asset. The UI then sends `createAnnotation` with `kind: "image"` |
//! | `get_asset_preview` | `docId`, `assetId`, `maxPx` (16 to 2 048) | an `SHR1` frame (PNG) of the image asset |
//!
//! Text boxes and images are created, updated, moved and deleted with the annotation commands of `commands::pages::apply_command`
//! (`kind: "textBox"` and `"image"`); they are page content burned in by the next save, never comments. No path crosses IPC.

use tauri::ipc::Response;
use tauri::{State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

use super::{blocking, AppState};
use crate::content::image::{self, ImageAssetInfo};
use crate::documents::DocumentId;
use crate::error::{AppError, ErrorCode, UiError};
use crate::limits;
use crate::model::ids::AssetId;

impl AppState {
    /// Asks for an image in a native dialog, judges and imports it, and stores it as an asset of document `id`. `None`: the dialog was
    /// cancelled. Package A.
    pub fn insert_image_dialog(
        &self,
        id: DocumentId,
        window: &WebviewWindow,
    ) -> Result<Option<ImageAssetInfo>, AppError> {
        self.info(id).ok_or(AppError::not_found("document"))?;
        self.check_may_edit(id)?;
        let picked = window
            .dialog()
            .file()
            .set_parent(window)
            .add_filter("Image", &["png", "jpg", "jpeg"])
            .blocking_pick_file();
        let Some(file) = picked else {
            return Ok(None);
        };
        let path = file
            .into_path()
            .map_err(|error| AppError::logged(ErrorCode::Internal, error))?;
        self.import_image_file(id, &path).map(Some)
    }

    /// Imports the picture at `path` (as the dialog gave it) into the assets of document `id`. The file is judged on its handle and
    /// decoded outside the document lock.
    pub fn import_image_file(
        &self,
        id: DocumentId,
        path: &std::path::Path,
    ) -> Result<ImageAssetInfo, AppError> {
        let asset = image::prepare(image::open_picked(path)?)?;
        self.model(id, |state| image::store(state, asset))
    }

    /// The `SHR1` frame of image asset `asset` of document `id`, at most `max_px` on the long side.
    pub fn asset_preview(
        &self,
        id: DocumentId,
        asset: AssetId,
        max_px: u16,
    ) -> Result<Vec<u8>, AppError> {
        if !(limits::MIN_ASSET_PREVIEW_PX..=limits::MAX_ASSET_PREVIEW_PX).contains(&max_px) {
            return Err(AppError::invalid("maxPx"));
        }
        self.model(id, |state| image::preview(state, asset, max_px))
    }
}

/// Chooses an image in the native dialog and adds it to the document's assets.
#[tauri::command]
pub async fn insert_image_dialog(
    window: WebviewWindow,
    state: State<'_, AppState>,
    doc_id: DocumentId,
) -> Result<Option<ImageAssetInfo>, UiError> {
    let state = state.inner().clone();
    blocking(move || state.insert_image_dialog(doc_id, &window)).await
}

/// A frame of an image asset.
#[tauri::command]
pub async fn get_asset_preview(
    state: State<'_, AppState>,
    doc_id: DocumentId,
    asset_id: AssetId,
    max_px: u16,
) -> Result<Response, UiError> {
    let state = state.inner().clone();
    blocking(move || state.asset_preview(doc_id, asset_id, max_px))
        .await
        .map(Response::new)
}
