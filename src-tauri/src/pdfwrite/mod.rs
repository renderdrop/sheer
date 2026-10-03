//! Writing a PDF: the only module that uses lopdf (ADR-004). It turns the model's annotation changes into objects appended to the
//! original file (`save`), with their dictionaries (`annots`) and appearance streams (`appearance`) in the page's user space
//! (`coords`). It knows nothing of the engine: the caller reads the file, hands the bytes over, and writes what comes back.

pub mod annots;
pub mod appearance;
pub mod coords;
pub mod inspect;
pub mod save;

pub use save::{append_annotations, validate, Built, Change, Plan};
