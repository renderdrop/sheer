//! Image import for the page (ADR-047 §1). owned by package A.
//!
//! The file is judged at its opened handle, its header is read before it is decoded, EXIF orientation applies, all metadata is
//! dropped, and the result is stored as a document asset (opaque: JPEG q90; alpha: Flate RGB + `/SMask`).

use std::fs::File;

use serde::Serialize;

use crate::error::AppError;
use crate::model::doc_state::DocState;
use crate::model::ids::AssetId;

/// What the UI is told about an inserted image (`ImageAssetInfo`). `height` is in pixels after downsizing; `aspect` is width over height.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageAssetInfo {
    pub asset_id: AssetId,
    pub width: u32,
    pub height: u32,
    pub aspect: f32,
}

/// Reads the opened PNG or JPEG `file`, stores it as an asset of `state` and describes it.
pub fn import(_state: &mut DocState, _file: File) -> Result<ImageAssetInfo, AppError> {
    Err(AppError::not_yet())
}

/// A frame for `get_asset_preview`: the SHR1 PNG of asset `id`, at most `max_px` on the long side.
pub fn preview(_state: &DocState, _id: AssetId, _max_px: u16) -> Result<Vec<u8>, AppError> {
    Err(AppError::not_yet())
}

/// Whether the asset of a new image exists and has this aspect (checked when the image annotation is created).
pub fn check_asset(_state: &DocState, _id: AssetId, _aspect: f32) -> Result<(), AppError> {
    Err(AppError::not_yet())
}
