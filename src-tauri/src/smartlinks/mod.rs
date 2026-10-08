//! Smart links: footnotes, contents, references and sources detected in the text and shown as an overlay (ADR-132, DESIGN §3.11).
//! Nothing here writes to a document; detectors are pure functions over [`model::DocText`].

pub mod footnotes;
pub mod index;
pub mod model;
pub mod outline;
pub mod pages;
pub mod toc;

pub mod literature;
pub mod references;
