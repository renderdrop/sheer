// owned by package A
//! Rendering a page for an export or a print (ADR-049 §2, §4). Only the worker calls this.

use super::snapshot::Snapshots;
use super::worker::Documents;
use crate::error::AppError;
use crate::export::snapshot::EngineDocRef;
use crate::pdfwrite::redact::RasterPage;

/// Draws page `engine_index` of `doc` at `dpi` as RGB8 on white, annotations on or off (off also hides widgets), turned by
/// `rotate_quarter` quarter turns. Stub (package A): `not_yet`.
pub(super) fn render(
    _documents: &Documents<'_>,
    _snapshots: &Snapshots<'_>,
    _doc: EngineDocRef,
    _engine_index: u32,
    _dpi: f32,
    _annotations: bool,
    _rotate_quarter: u8,
) -> Result<RasterPage, AppError> {
    Err(AppError::not_yet())
}
