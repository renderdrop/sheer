//! The bibliographic record of a document (ADR-119 section 4): shapes, the model's session state, and what the first-page heuristic finds.
//!
//! Seam of package W0; package C2 fills in validation, the command, and the merge with Info and XMP.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

/// The kind of work a record describes.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BibKind {
    Book,
    #[default]
    Article,
    Chapter,
    Report,
    WebPage,
    Thesis,
}

/// An author: at most `limits::BIB_PERSON_MAX` characters each. An empty `given` means an organisation.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Person {
    #[serde(default)]
    pub family: String,
    #[serde(default)]
    pub given: String,
}

/// The editable record (file: `/SHR_Bib` in `/Info`). Every field has a default, so older data and partial records read.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BibRecord {
    #[serde(default)]
    pub kind: BibKind,
    /// At most `limits::BIB_AUTHORS_MAX`.
    #[serde(default)]
    pub authors: Vec<Person>,
    #[serde(default)]
    pub title: Option<String>,
    /// At most `limits::BIB_YEAR_MAX` characters ("2020a", "n.d.").
    #[serde(default)]
    pub year: Option<String>,
    #[serde(default)]
    pub container_title: Option<String>,
    #[serde(default)]
    pub volume: Option<String>,
    #[serde(default)]
    pub issue: Option<String>,
    #[serde(default)]
    pub pages: Option<String>,
    #[serde(default)]
    pub edition: Option<String>,
    #[serde(default)]
    pub publisher: Option<String>,
    #[serde(default)]
    pub place: Option<String>,
    /// At most `limits::BIB_DOI_MAX` characters.
    #[serde(default)]
    pub doi: Option<String>,
    /// At most `limits::BIB_URL_MAX` characters. Never opened.
    #[serde(default)]
    pub url: Option<String>,
    /// `YYYY-MM-DD`.
    #[serde(default)]
    pub accessed: Option<String>,
}

/// A field of a record, for `BibliographyInfo.sources`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BibField {
    Kind,
    Authors,
    Title,
    Year,
    ContainerTitle,
    Volume,
    Issue,
    Pages,
    Edition,
    Publisher,
    Place,
    Doi,
    Url,
    Accessed,
}

/// Where the value of a field comes from, strongest first: the user's record, XMP, Info, the first-page heuristic.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BibSource {
    User,
    Xmp,
    Info,
    Heuristic,
    None,
}

/// `get_bibliography`'s answer: the merged record and where each filled field came from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BibliographyInfo {
    pub record: BibRecord,
    pub sources: HashMap<BibField, BibSource>,
    /// The record has a change the next save writes.
    pub pending: bool,
    /// A pending strip of all metadata drops the record: it will not be written.
    pub dropped_by_strip: bool,
}

/// What `Job::FirstPageHints` finds on page 1 (`limits::BIB_FIRST_PAGE_CHARS_MAX` characters, `BIB_FIRST_PAGE_BUDGET`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct FirstPageHints {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub year: Option<String>,
    #[serde(default)]
    pub doi: Option<String>,
}

/// The record as the session has it (`DocState.bibliography`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BibliographyState {
    /// The merged record once `get_bibliography` has read the file; `None` before.
    pub record: Option<BibRecord>,
    /// Set by `DocCommand::SetBibliography`, cleared by a save: the record the next save writes.
    pub pending: Option<BibRecord>,
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn a_partial_record_reads_with_defaults() {
        let record: BibRecord = serde_json::from_value(json!({"title": "T"})).unwrap();
        assert_eq!(record.kind, BibKind::Article);
        assert!(record.authors.is_empty());
        assert_eq!(record.title.as_deref(), Some("T"));
        let web: BibKind = serde_json::from_value(json!("webPage")).unwrap();
        assert_eq!(web, BibKind::WebPage);
    }

    #[test]
    fn hints_and_labels_cross_the_wire_with_defaults() {
        let hints: FirstPageHints = serde_json::from_value(json!({})).unwrap();
        assert_eq!(hints, FirstPageHints::default());
    }
}
