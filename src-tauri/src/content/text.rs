//! Text box layout (ADR-047 §1). owned by package A.

use crate::error::AppError;
use crate::model::annotation::{StdFont, TextAlign};
use crate::model::geometry::Rect;

/// Breaks `text` (LF breaks) into lines that fit `width` points set in `font` at `size`, and returns them with the height they need.
/// A character the font has no WinAnsi code for is `AppError::bad_char`.
pub fn layout(
    _text: &str,
    _font: StdFont,
    _size: f32,
    _width: f32,
) -> Result<(Vec<String>, f32), AppError> {
    Err(AppError::not_yet())
}

/// What `model::annotation` calls on create and update: lays `text` out in `bounds`, stores the `lines`, and grows `bounds.h` to fit.
pub fn layout_box(
    _bounds: &mut Rect,
    _text: &str,
    _lines: &mut Vec<String>,
    _font: StdFont,
    _size: f32,
    _align: TextAlign,
) -> Result<(), AppError> {
    Err(AppError::not_yet())
}
