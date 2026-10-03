//! The pages true redaction leaves behind (ADR-047 §3). owned by package C.

use lopdf::{Document, ObjectId};

use crate::error::AppError;

/// The bitmap of a page as PDFium drew it, with the marks filled in black.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RasterPixels {
    Rgb8(Vec<u8>),
    Gray8(Vec<u8>),
}

/// A rendered page for [`raster_page`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RasterPage {
    pub pixels: RasterPixels,
    pub width: u32,
    pub height: u32,
}

/// Builds a one-page PDF in memory: MediaBox = `size_pt`, the page's `/Rotate`, one image (DeviceGray Flate if every pixel is grey,
/// else DeviceRGB JPEG q90), no text, no annotations.
pub fn raster_page(
    _img: RasterPage,
    _size_pt: [f32; 2],
    _rotate: u16,
) -> Result<Vec<u8>, AppError> {
    Err(AppError::not_yet())
}

/// Removes what still holds content of the redacted pages: `/StructTreeRoot`, `/MarkInfo`, `/Thumb` and `/PieceInfo` of `redacted`,
/// fields whose every widget was on them, and writes a new `/ID`.
pub fn scrub(_doc: &mut Document, _redacted: &[ObjectId]) -> Result<(), AppError> {
    Err(AppError::not_yet())
}
