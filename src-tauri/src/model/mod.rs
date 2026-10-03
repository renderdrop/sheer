//! Engine-free domain types (ARCHITECTURE §2, ADR-003): what the backend tells the UI about a document's content, in page space.
//!
//! Nothing here names PDFium or lopdf (a CI grep keeps it so). The engine reads a document and produces these shapes, the
//! commands turn page positions into page ids and send them, and the tests build them without a PDF.

pub mod find;
pub mod geometry;
pub mod reading;
