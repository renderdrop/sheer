//! Content objects: text boxes and images that a save burns into the page (ADR-047 §1). owned by package A.
//!
//! They live in the model like annotations (`AnnotationBody::{TextBox, Image}`), are editable until a save, and are never listed as
//! comments. This module is engine-free: Rust lays the text out ([`text`], with the AFM widths of the three fonts in [`std14`]) and
//! prepares the pictures ([`image`]); `pdfwrite::content` writes them.

pub mod image;
pub mod std14;
pub mod text;

use crate::model::annotation::Annotation;

/// A text box or an image of one page, as the save plan hands it to `pdfwrite::content::burn`. The annotation's body is a `TextBox`
/// or an `Image`; objects are drawn in creation order.
#[derive(Debug, Clone, PartialEq)]
pub struct ContentObject {
    pub annotation: Annotation,
    /// The zero-based position of the page in the saved file.
    pub index: u32,
    /// The pixels of an image object (`None` for a text box).
    pub image: Option<std::sync::Arc<image::ImageAsset>>,
}
