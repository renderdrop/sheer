//! Rendering a page for true redaction (ADR-047 §3). Only the worker calls this. owned by package C.

use pdfium_render::prelude::*;

use crate::error::AppError;
use crate::model::geometry::Rect;
use crate::pdfwrite::redact::RasterPage;

/// Draws page `engine_index` as PDFium shows it (file content, file annotations and form widgets with their file appearances, crop
/// applied) at `dpi`, fills every rectangle of `burn` (page space, grown by 1 px) with opaque black in the bitmap, and returns the bitmap
/// (Gray8 if every pixel is grey, else RGB8). A page that would need less than 72 dpi to stay within 4 096 px per side and 16 MP is
/// `limit_exceeded` (`redactPage`).
pub(super) fn render_for_redaction(
    _document: &PdfDocument<'_>,
    _engine_index: u32,
    _dpi: f32,
    _burn: &[Rect],
) -> Result<RasterPage, AppError> {
    Err(AppError::not_yet())
}
