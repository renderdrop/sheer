//! Engine-free domain types (ARCHITECTURE §2, ADR-003): what the backend tells the UI about a document's content, in page space.
//!
//! Nothing here names PDFium or lopdf (a CI grep keeps it so). The engine reads a document and produces these shapes, the
//! commands turn page positions into page ids and send them, and the tests build them without a PDF.
//!
//! The annotation model ([`annotation`]) with its command stack ([`command`], [`history`], [`doc_state`]) is the editable half: the
//! UI changes annotations only by sending a [`command::DocCommand`], and [`doc_state::DocState`] answers with the delta.

pub mod annotation;
pub mod command;
pub mod doc_state;
pub mod find;
pub mod form;
pub mod geometry;
pub mod history;
pub mod ids;
pub mod metadata;
pub mod page;
pub mod page_ops;
pub mod protection;
pub mod reading;
pub mod redaction;
