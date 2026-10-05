// owned by package A
//! Convert and output (ADR-049, ARCHITECTURE §5 "Convert and output"): PDF to images, images to PDF, and the snapshot of a document's
//! current state that every output starts from. The commands live in `commands/{export_images,images_pdf,export_pdf,print}.rs`.

pub mod citations;
pub mod from_images;
pub mod images;
pub mod names;
pub mod snapshot;
