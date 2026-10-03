// owned by package B
//! A fresh PDF from images (ADR-049 §3): one page per image, one image XObject each, `/Producer` only.

use crate::content::image::ImageAsset;
use crate::error::AppError;
use crate::model::geometry::Rect;

/// One page: the stored image (`content::image` output), the page size and where the image sits, both in points.
#[derive(Debug, Clone, PartialEq)]
pub struct ImagePage {
    pub image: ImageAsset,
    pub size_pt: [f32; 2],
    pub place: Rect,
}

/// Writes the document. Stub (package B): `not_yet`.
pub fn build(_pages: &[ImagePage], _producer: &str) -> Result<Vec<u8>, AppError> {
    Err(AppError::not_yet())
}
