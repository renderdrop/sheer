//! Writing a PDF: the only module that uses lopdf (ADR-004). It turns the model's annotation changes into objects appended to the
//! original file (`save`), with their dictionaries (`annots`) and appearance streams (`appearance`) in the page's user space
//! (`coords`). It knows nothing of the engine: the caller reads the file, hands the bytes over, and writes what comes back.

pub mod annots;
pub mod appearance;
pub mod bibliography;
pub mod compress;
pub mod content;
pub mod coords;
pub mod crypt;
pub mod export;
pub mod field_ap;
pub mod flatten;
pub mod forms;
pub mod header_footer;
pub mod images_pdf;
pub mod inspect;
pub mod lines;
pub mod metadata;
pub mod ocr_font;
pub mod ocr_layer;
pub mod ocr_probe;
pub mod ops_walk;
pub mod page_layer;
pub mod pagetree;
pub mod prescan;
pub mod produce;
pub mod redact;
pub mod redact_content;
pub mod redact_image;
pub mod reviews;
pub mod save;
pub mod seal;
pub mod sheer_keys;
pub mod sign;
pub mod sigread;
pub mod stamp_ap;
pub mod summary;
pub mod text_fonts;
pub mod text_io;
pub mod text_lines;
pub mod text_refuse;
pub mod text_save;
pub mod text_splice;
pub mod textedit;
pub mod unsign;

pub use prescan::load_untrusted;
pub use save::{append_annotations, validate, Built, Change, Plan, SavePlan};

/// Writes what [`SavePlan`] holds on top of `bytes` (see `save::apply_extras`), then the bibliographic record as `/SHR_Bib` in an
/// incremental `/Info` (ADR-119). A pending removal of the metadata drops the record: it is not written.
pub fn apply_extras(bytes: Vec<u8>, plan: &SavePlan) -> Result<Vec<u8>, crate::error::AppError> {
    let bytes = save::apply_extras(bytes, plan)?;
    match &plan.bibliography {
        Some(record)
            if !matches!(
                plan.metadata,
                Some(crate::model::metadata::MetadataChange::Strip)
            ) =>
        {
            bibliography::apply(bytes, record)
        }
        _ => Ok(bytes),
    }
}
