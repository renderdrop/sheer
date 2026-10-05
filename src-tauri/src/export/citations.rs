//! Citation list export (ADR-119 section 8): the typed blocks the UI sends and the file formats Rust writes.
//!
//! Seam of package W0; package C4 writes txt, html, md (escaping in Rust), ris and bib.

use serde::Deserialize;

/// The citation style the list was made in (it only names the file; the text comes formatted).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CitationStyle {
    Apa7,
    Mla9,
    Chicago17AuthorDate,
    DinIso690,
}

/// The file formats of `save_citation_list`: `Txt`, `Html` and `Md` are written from the blocks, `Ris` and `Bib` from the stored record.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CitationFileFormat {
    Txt,
    Html,
    Md,
    Ris,
    Bib,
}

/// A piece of a block in one face.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    pub text: String,
    #[serde(default)]
    pub italic: bool,
}

/// A paragraph of formatted text: at most `limits::STYLED_RUNS_MAX` runs of at most `STYLED_RUN_CHARS_MAX` characters. Never markup.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StyledBlock {
    pub runs: Vec<Run>,
}
