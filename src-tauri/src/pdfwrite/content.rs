//! Burns content objects (text boxes, images) into a page at save (ADR-047 §1). owned by package A.

use lopdf::{Document, ObjectId};

use crate::content::ContentObject;
use crate::error::AppError;
use crate::signatures::AssetStore;

/// Wraps the page's content in `q … Q` and appends one stream that draws `objs` in creation order (text clipped to its box, images
/// with opacity through an `/ExtGState`). `doc` is a full rewrite or `IncrementalDocument::new_document`; the page dictionary and its
/// `/Resources` are re-appended.
pub fn burn(
    _doc: &mut Document,
    _page: ObjectId,
    _objs: &[ContentObject],
    _assets: &AssetStore,
) -> Result<(), AppError> {
    Err(AppError::not_yet())
}
