//! Writing a PDF: the only module that uses lopdf (ADR-004). It turns the model's annotation changes into objects appended to the
//! original file (`save`), with their dictionaries (`annots`) and appearance streams (`appearance`) in the page's user space
//! (`coords`). It knows nothing of the engine: the caller reads the file, hands the bytes over, and writes what comes back.

pub mod annots;
pub mod appearance;
pub mod compress;
pub mod content;
pub mod coords;
pub mod crypt;
pub mod export;
pub mod field_ap;
pub mod flatten;
pub mod forms;
pub mod images_pdf;
pub mod inspect;
pub mod metadata;
pub mod pagetree;
pub mod prescan;
pub mod produce;
pub mod redact;
pub mod redact_content;
pub mod redact_image;
pub mod reviews;
pub mod save;

pub use prescan::load_untrusted;
pub use save::{append_annotations, apply_extras, validate, Built, Change, Plan, SavePlan};
