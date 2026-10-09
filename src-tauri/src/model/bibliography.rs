//! The bibliographic record of a document (ADR-119 section 4): shapes, the model's session state, and what the first-page heuristic finds.
//!
//! Validation, the merge of the layers (user record, XMP, Info, first page) and the undoable command live here; the file side is
//! `pdfwrite::bibliography`.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use super::command::DocCommand;
use super::doc_state::{Delta, DocPart, DocState};
use crate::documents::sanitize_text;
use crate::error::AppError;
use crate::limits;

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
    /// A valid ISBN-13 or ISBN-10 (checksum), stored as digits only (a final `X` allowed on a ten); `normalized` strips hyphens/spaces.
    #[serde(default)]
    pub isbn: Option<String>,
    /// At most `limits::BIB_URL_MAX` characters. Never opened.
    #[serde(default)]
    pub url: Option<String>,
    /// `YYYY-MM-DD`.
    #[serde(default)]
    pub accessed: Option<String>,
    /// The short title of the Deutsche Zitierweise (`/SHR_Bib /ST`, at most `limits::BIB_SHORT_TITLE_MAX` characters); `None` = derived
    /// from the title by the formatter. The user's record only: XMP and Info never have one.
    #[serde(default)]
    pub short_title: Option<String>,
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
    Isbn,
    Url,
    Accessed,
    ShortTitle,
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

/// What `Job::FirstPageHints` finds on the first pages and the imprint (`limits::BIB_FIRST_PAGE_CHARS_MAX` characters a page,
/// `BIB_FIRST_PAGE_BUDGET`). Every field is optional; `engine/imprint.rs` fills them.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct FirstPageHints {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub year: Option<String>,
    #[serde(default)]
    pub doi: Option<String>,
    #[serde(default)]
    pub authors: Vec<Person>,
    #[serde(default)]
    pub edition: Option<String>,
    #[serde(default)]
    pub publisher: Option<String>,
    #[serde(default)]
    pub place: Option<String>,
    /// A valid ISBN-10 or ISBN-13 (checksum), digits only. It fills the record's `isbn` and decides the kind.
    #[serde(default)]
    pub isbn: Option<String>,
    #[serde(default)]
    pub kind: Option<BibKind>,
    #[serde(default)]
    pub container_title: Option<String>,
    #[serde(default)]
    pub volume: Option<String>,
    #[serde(default)]
    pub issue: Option<String>,
    #[serde(default)]
    pub pages: Option<String>,
}

impl FirstPageHints {
    /// Whether every field is within the record limits (the reply of the engine process is checked, not trusted).
    pub fn within_limits(&self) -> bool {
        let fits = |text: &Option<String>, max: usize| {
            text.as_deref().is_none_or(|t| t.chars().count() <= max)
        };
        fits(&self.title, limits::BIB_HEURISTIC_TITLE_MAX)
            && fits(&self.year, limits::BIB_YEAR_MAX)
            && fits(&self.doi, limits::BIB_DOI_MAX)
            && self.isbn.as_deref().is_none_or(|i| {
                (10..=13).contains(&i.len()) && i.bytes().all(|b| b.is_ascii_digit() || b == b'X')
            })
            && [
                &self.edition,
                &self.publisher,
                &self.place,
                &self.container_title,
                &self.volume,
                &self.issue,
                &self.pages,
            ]
            .into_iter()
            .all(|text| fits(text, limits::BIB_FIELD_MAX))
            && self.authors.len() <= limits::BIB_AUTHORS_MAX
            && self.authors.iter().all(|p| {
                p.family.chars().count() <= limits::BIB_PERSON_MAX
                    && p.given.chars().count() <= limits::BIB_PERSON_MAX
            })
    }
}

/// What a file says about its bibliographic record, layer by layer (read once by `get_bibliography`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BibLayers {
    /// The file's own `/SHR_Bib`, if it has a valid one.
    pub file: Option<BibRecord>,
    /// What the XMP packet says (`kind` is not used).
    pub xmp: BibRecord,
    /// What `/Info` says (`kind` is not used).
    pub info: BibRecord,
    /// What the first-page heuristic found, once it ran (it runs only for an empty title, authors or year).
    pub hints: Option<FirstPageHints>,
}

/// The record as the session has it (`DocState.bibliography`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BibliographyState {
    /// The merged record, kept current by `get_bibliography` and `SetBibliography`; `None` until the file is read.
    pub record: Option<BibRecord>,
    /// Where each field of `record` comes from.
    pub sources: HashMap<BibField, BibSource>,
    /// What the file says; `None` until `get_bibliography` has read it.
    pub layers: Option<BibLayers>,
    /// Set by `DocCommand::SetBibliography`, cleared by a save: the user record the next save writes.
    pub pending: Option<BibRecord>,
}

impl BibliographyState {
    /// The user's record as the session has it: the staged one, else the file's, else an empty one.
    pub fn user(&self) -> BibRecord {
        self.pending
            .clone()
            .or_else(|| self.layers.as_ref().and_then(|layers| layers.file.clone()))
            .unwrap_or_default()
    }

    /// The user's record exists (staged or in the file) and is not empty.
    pub fn has_user(&self) -> bool {
        self.user() != BibRecord::default()
    }

    /// Something is staged for the next save.
    pub fn is_pending(&self) -> bool {
        self.pending.is_some()
    }

    /// Computes `record` and `sources` again from the layers and the staged record.
    pub fn refresh(&mut self) {
        let Some(layers) = &self.layers else {
            return;
        };
        let user = self.user();
        let user = (user != BibRecord::default()).then_some(&user);
        let (record, sources) = merge(user, &layers.xmp, &layers.info, layers.hints.as_ref());
        self.record = Some(record);
        self.sources = sources;
    }
}

fn is_clean_text(text: &str) -> bool {
    sanitize_text(text, usize::MAX) == text
}

fn check_text(text: &Option<String>, max: usize) -> Result<(), AppError> {
    let Some(text) = text else {
        return Ok(());
    };
    if text.chars().count() > max {
        return Err(AppError::limit("bibliography", max as u64));
    }
    if !is_clean_text(text) {
        return Err(AppError::invalid("bibliography"));
    }
    Ok(())
}

fn days_in_month(year: u32, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        _ if year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400)) => {
            29
        }
        _ => 28,
    }
}

/// `YYYY-MM-DD` with a real calendar date.
pub fn is_iso_date(text: &str) -> bool {
    let bytes = text.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return false;
    }
    let digits = |range: std::ops::Range<usize>| -> Option<u32> {
        let part = text.get(range)?;
        if part.bytes().all(|b| b.is_ascii_digit()) {
            part.parse().ok()
        } else {
            None
        }
    };
    match (digits(0..4), digits(5..7), digits(8..10)) {
        (Some(year), Some(month), Some(day)) => {
            (1..=12).contains(&month) && day >= 1 && day <= days_in_month(year, month)
        }
        _ => false,
    }
}

/// A DOI in its bare form: `10.` and a registrant, a slash and a suffix, no white space.
pub fn is_doi_shape(text: &str) -> bool {
    text.starts_with("10.")
        && text.contains('/')
        && !text.chars().any(|c| c.is_whitespace() || c.is_control())
}

/// An ISBN as digits only (hyphens and spaces removed, `x` upper-cased): a valid ISBN-13 or ISBN-10 by its check digit, else `None`.
pub fn normalize_isbn(text: &str) -> Option<String> {
    let digits: String = text
        .trim()
        .chars()
        .filter(|c| *c != '-' && *c != ' ')
        .map(|c| c.to_ascii_uppercase())
        .collect();
    let bytes = digits.as_bytes();
    let valid = match bytes.len() {
        13 => {
            bytes.iter().all(u8::is_ascii_digit)
                && bytes
                    .iter()
                    .enumerate()
                    .map(|(i, b)| u32::from(b - b'0') * if i % 2 == 0 { 1 } else { 3 })
                    .sum::<u32>()
                    % 10
                    == 0
        }
        10 => {
            bytes[..9].iter().all(u8::is_ascii_digit)
                && (bytes[9].is_ascii_digit() || bytes[9] == b'X')
                && bytes
                    .iter()
                    .enumerate()
                    .map(|(i, b)| {
                        let v = if *b == b'X' { 10 } else { u32::from(b - b'0') };
                        v * (10 - i as u32)
                    })
                    .sum::<u32>()
                    % 11
                    == 0
        }
        _ => false,
    };
    valid.then_some(digits)
}

/// A web address in shape only (it is never opened): `http://` or `https://`, a host, no white space.
pub fn is_url_shape(text: &str) -> bool {
    let rest = text
        .strip_prefix("https://")
        .or_else(|| text.strip_prefix("http://"));
    rest.is_some_and(|rest| {
        !rest.is_empty() && !text.chars().any(|c| c.is_whitespace() || c.is_control())
    })
}

impl BibRecord {
    /// Checks what the UI sent: lengths (`limit_exceeded`), control and format characters, the year, the date, and the shape of the
    /// DOI and the address (`invalid_argument`, `what: "bibliography"`).
    pub fn check(&self) -> Result<(), AppError> {
        if self.authors.len() > limits::BIB_AUTHORS_MAX {
            return Err(AppError::limit(
                "bibliography",
                limits::BIB_AUTHORS_MAX as u64,
            ));
        }
        for person in &self.authors {
            for part in [&person.family, &person.given] {
                if part.chars().count() > limits::BIB_PERSON_MAX {
                    return Err(AppError::limit(
                        "bibliography",
                        limits::BIB_PERSON_MAX as u64,
                    ));
                }
                if !is_clean_text(part) {
                    return Err(AppError::invalid("bibliography"));
                }
            }
        }
        for text in [
            &self.title,
            &self.container_title,
            &self.volume,
            &self.issue,
            &self.pages,
            &self.edition,
            &self.publisher,
            &self.place,
        ] {
            check_text(text, limits::BIB_FIELD_MAX)?;
        }
        check_text(&self.year, limits::BIB_YEAR_MAX)?;
        check_text(&self.doi, limits::BIB_DOI_MAX)?;
        check_text(&self.isbn, 24)?;
        check_text(&self.url, limits::BIB_URL_MAX)?;
        check_text(&self.accessed, limits::BIB_YEAR_MAX)?;
        check_text(&self.short_title, limits::BIB_SHORT_TITLE_MAX)?;
        let filled = |text: &Option<String>| -> Option<String> {
            text.as_deref()
                .map(str::trim)
                .filter(|text| !text.is_empty())
                .map(str::to_owned)
        };
        if filled(&self.doi).is_some_and(|doi| !is_doi_shape(&doi)) {
            return Err(AppError::invalid("bibliography"));
        }
        if filled(&self.isbn).is_some_and(|isbn| normalize_isbn(&isbn).is_none()) {
            return Err(AppError::invalid("bibliography"));
        }
        if filled(&self.url).is_some_and(|url| !is_url_shape(&url)) {
            return Err(AppError::invalid("bibliography"));
        }
        if filled(&self.accessed).is_some_and(|date| !is_iso_date(&date)) {
            return Err(AppError::invalid("bibliography"));
        }
        Ok(())
    }

    /// The record with every text trimmed, an empty text as `None` and an author with no name left out.
    pub fn normalized(&self) -> Self {
        let tidy = |text: &Option<String>| {
            text.as_deref()
                .map(str::trim)
                .filter(|text| !text.is_empty())
                .map(str::to_owned)
        };
        Self {
            kind: self.kind,
            authors: self
                .authors
                .iter()
                .map(|person| Person {
                    family: person.family.trim().to_owned(),
                    given: person.given.trim().to_owned(),
                })
                .filter(|person| !person.family.is_empty() || !person.given.is_empty())
                .collect(),
            title: tidy(&self.title),
            year: tidy(&self.year),
            container_title: tidy(&self.container_title),
            volume: tidy(&self.volume),
            issue: tidy(&self.issue),
            pages: tidy(&self.pages),
            edition: tidy(&self.edition),
            publisher: tidy(&self.publisher),
            place: tidy(&self.place),
            doi: tidy(&self.doi),
            isbn: tidy(&self.isbn).map(|isbn| normalize_isbn(&isbn).unwrap_or(isbn)),
            url: tidy(&self.url),
            accessed: tidy(&self.accessed),
            short_title: tidy(&self.short_title),
        }
    }
}

/// The first non-empty value of `layers`, strongest first, with the source it came from.
fn pick(layers: [(&Option<String>, BibSource); 4]) -> (Option<String>, BibSource) {
    for (value, source) in layers {
        if let Some(value) = value.as_ref().filter(|value| !value.is_empty()) {
            return (Some(value.clone()), source);
        }
    }
    (None, BibSource::None)
}

/// Merges the layers per field, strongest first: the user's record, XMP, Info, the first-page heuristic. An empty field of a layer
/// does not count. The record is what the UI shows; `sources` says where each field came from (`none` for an empty one).
pub fn merge(
    user: Option<&BibRecord>,
    xmp: &BibRecord,
    info: &BibRecord,
    hints: Option<&FirstPageHints>,
) -> (BibRecord, HashMap<BibField, BibSource>) {
    let mut sources = HashMap::new();
    let empty = BibRecord::default();
    let u = user.unwrap_or(&empty);
    let none: Option<String> = None;
    let hint = |value: Option<&Option<String>>| value.cloned().flatten();
    let hint_title = hint(hints.map(|h| &h.title));
    let hint_year = hint(hints.map(|h| &h.year));
    let hint_doi = hint(hints.map(|h| &h.doi));
    let hint_container = hint(hints.map(|h| &h.container_title));
    let hint_volume = hint(hints.map(|h| &h.volume));
    let hint_issue = hint(hints.map(|h| &h.issue));
    let hint_pages = hint(hints.map(|h| &h.pages));
    let hint_edition = hint(hints.map(|h| &h.edition));
    let hint_publisher = hint(hints.map(|h| &h.publisher));
    let hint_place = hint(hints.map(|h| &h.place));
    let hint_isbn = hint(hints.map(|h| &h.isbn));
    let mut field = |field: BibField,
                     u: &Option<String>,
                     x: &Option<String>,
                     i: &Option<String>,
                     h: &Option<String>| {
        let (value, source) = pick([
            (u, BibSource::User),
            (x, BibSource::Xmp),
            (i, BibSource::Info),
            (h, BibSource::Heuristic),
        ]);
        sources.insert(field, source);
        value
    };
    let title = field(
        BibField::Title,
        &u.title,
        &xmp.title,
        &info.title,
        &hint_title,
    );
    let year = field(BibField::Year, &u.year, &xmp.year, &info.year, &hint_year);
    let doi = field(BibField::Doi, &u.doi, &xmp.doi, &info.doi, &hint_doi);
    let container_title = field(
        BibField::ContainerTitle,
        &u.container_title,
        &xmp.container_title,
        &info.container_title,
        &hint_container,
    );
    let volume = field(
        BibField::Volume,
        &u.volume,
        &xmp.volume,
        &info.volume,
        &hint_volume,
    );
    let issue = field(
        BibField::Issue,
        &u.issue,
        &xmp.issue,
        &info.issue,
        &hint_issue,
    );
    let pages = field(
        BibField::Pages,
        &u.pages,
        &xmp.pages,
        &info.pages,
        &hint_pages,
    );
    let edition = field(
        BibField::Edition,
        &u.edition,
        &xmp.edition,
        &info.edition,
        &hint_edition,
    );
    let publisher = field(
        BibField::Publisher,
        &u.publisher,
        &xmp.publisher,
        &info.publisher,
        &hint_publisher,
    );
    let place = field(
        BibField::Place,
        &u.place,
        &xmp.place,
        &info.place,
        &hint_place,
    );
    let isbn = field(BibField::Isbn, &u.isbn, &xmp.isbn, &info.isbn, &hint_isbn);
    let url = field(BibField::Url, &u.url, &xmp.url, &info.url, &none);
    let accessed = field(
        BibField::Accessed,
        &u.accessed,
        &xmp.accessed,
        &info.accessed,
        &none,
    );
    let (authors, author_source) = if !u.authors.is_empty() {
        (u.authors.clone(), BibSource::User)
    } else if !xmp.authors.is_empty() {
        (xmp.authors.clone(), BibSource::Xmp)
    } else if !info.authors.is_empty() {
        (info.authors.clone(), BibSource::Info)
    } else if let Some(found) = hints.filter(|h| !h.authors.is_empty()) {
        (found.authors.clone(), BibSource::Heuristic)
    } else {
        (Vec::new(), BibSource::None)
    };
    sources.insert(BibField::Authors, author_source);
    let short_title = u.short_title.clone().filter(|text| !text.is_empty());
    sources.insert(
        BibField::ShortTitle,
        if short_title.is_some() {
            BibSource::User
        } else {
            BibSource::None
        },
    );
    let hint_kind = hints.and_then(|h| h.kind).filter(|_| user.is_none());
    sources.insert(
        BibField::Kind,
        if user.is_some() {
            BibSource::User
        } else if hint_kind.is_some() {
            BibSource::Heuristic
        } else {
            BibSource::None
        },
    );
    let record = BibRecord {
        kind: hint_kind.unwrap_or(u.kind),
        authors,
        title,
        year,
        container_title,
        volume,
        issue,
        pages,
        edition,
        publisher,
        place,
        doi,
        isbn,
        url,
        accessed,
        short_title,
    };
    (record, sources)
}

/// Runs `DocCommand::SetBibliography`: stages `record` as the user's record (equal to the file's: nothing staged) and returns the
/// command that puts the previous one back. The file must have been read (`get_bibliography`).
pub(crate) fn set(
    state: &mut DocState,
    record: &BibRecord,
    delta: &mut Delta,
) -> Result<DocCommand, AppError> {
    record.check()?;
    let bib = &mut state.bibliography;
    let Some(layers) = &bib.layers else {
        return Err(AppError::invalid("bibliography"));
    };
    let previous = bib.user();
    let clean = layers.file.clone().unwrap_or_default();
    let next = record.normalized();
    bib.pending = (next != clean).then_some(next);
    bib.refresh();
    delta.doc.insert(DocPart::Bibliography);
    Ok(DocCommand::SetBibliography { record: previous })
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
    fn the_short_title_is_checked_trimmed_and_comes_from_the_user_record_only() {
        let long = BibRecord {
            short_title: Some("x".repeat(limits::BIB_SHORT_TITLE_MAX + 1)),
            ..BibRecord::default()
        };
        assert!(long.check().is_err());
        let spaced = BibRecord {
            short_title: Some("  Kurz  ".into()),
            ..BibRecord::default()
        };
        assert!(spaced.check().is_ok());
        assert_eq!(spaced.normalized().short_title.as_deref(), Some("Kurz"));
        let xmp = BibRecord {
            short_title: Some("not from xmp".into()),
            ..BibRecord::default()
        };
        let (merged, sources) = merge(
            Some(&spaced.normalized()),
            &xmp,
            &BibRecord::default(),
            None,
        );
        assert_eq!(merged.short_title.as_deref(), Some("Kurz"));
        assert_eq!(sources[&BibField::ShortTitle], BibSource::User);
        let (merged, sources) = merge(None, &xmp, &BibRecord::default(), None);
        assert_eq!(merged.short_title, None);
        assert_eq!(sources[&BibField::ShortTitle], BibSource::None);
        // The wire name is camelCase; an older record has none.
        let wire: BibRecord = serde_json::from_value(json!({"shortTitle": "S"})).unwrap();
        assert_eq!(wire.short_title.as_deref(), Some("S"));
        assert_eq!(
            serde_json::to_value(BibField::ShortTitle).unwrap(),
            json!("shortTitle")
        );
    }

    #[test]
    fn page_hints_fill_what_metadata_leaves_empty_and_never_override_it() {
        let hints = FirstPageHints {
            title: Some("From the page".into()),
            authors: vec![Person {
                family: "Page".into(),
                given: "A".into(),
            }],
            publisher: Some("Press".into()),
            place: Some("Berlin".into()),
            edition: Some("3".into()),
            kind: Some(BibKind::Book),
            ..FirstPageHints::default()
        };
        let info = BibRecord {
            title: Some("From Info".into()),
            ..BibRecord::default()
        };
        let (record, sources) = merge(None, &BibRecord::default(), &info, Some(&hints));
        assert_eq!(record.title.as_deref(), Some("From Info"));
        assert_eq!(record.publisher.as_deref(), Some("Press"));
        assert_eq!(record.place.as_deref(), Some("Berlin"));
        assert_eq!(record.edition.as_deref(), Some("3"));
        assert_eq!(record.authors[0].family, "Page");
        assert_eq!(record.kind, BibKind::Book);
        assert_eq!(sources[&BibField::Title], BibSource::Info);
        assert_eq!(sources[&BibField::Publisher], BibSource::Heuristic);
        assert_eq!(sources[&BibField::Authors], BibSource::Heuristic);
        assert_eq!(sources[&BibField::Kind], BibSource::Heuristic);
        // A record of the user's keeps its own kind.
        let user = BibRecord {
            title: Some("Mine".into()),
            ..BibRecord::default()
        };
        let (record, sources) = merge(Some(&user), &BibRecord::default(), &info, Some(&hints));
        assert_eq!(record.kind, BibKind::Article);
        assert_eq!(sources[&BibField::Kind], BibSource::User);
    }

    #[test]
    fn the_isbn_is_validated_normalized_and_filled_from_the_page() {
        assert_eq!(
            normalize_isbn("978-3-16-148410-0").as_deref(),
            Some("9783161484100")
        );
        assert_eq!(
            normalize_isbn("0-8044-2957-x").as_deref(),
            Some("080442957X")
        );
        assert_eq!(normalize_isbn("978-3-16-148410-1"), None);
        assert_eq!(normalize_isbn("12345"), None);
        let bad = BibRecord {
            isbn: Some("978-3-16-148410-1".into()),
            ..BibRecord::default()
        };
        assert!(bad.check().is_err());
        let good = BibRecord {
            isbn: Some(" 978-3-16-148410-0 ".into()),
            ..BibRecord::default()
        };
        assert!(good.check().is_ok());
        assert_eq!(good.normalized().isbn.as_deref(), Some("9783161484100"));
        let wire = serde_json::to_value(good.normalized()).unwrap();
        assert_eq!(wire["isbn"], json!("9783161484100"));
        let back: BibRecord = serde_json::from_value(wire).unwrap();
        assert_eq!(back, good.normalized());
        let old: BibRecord = serde_json::from_value(json!({"title": "T"})).unwrap();
        assert_eq!(old.isbn, None);
        let hints = FirstPageHints {
            isbn: Some("9783161484100".into()),
            ..FirstPageHints::default()
        };
        let empty = BibRecord::default();
        let (record, sources) = merge(None, &empty, &empty, Some(&hints));
        assert_eq!(record.isbn.as_deref(), Some("9783161484100"));
        assert_eq!(sources[&BibField::Isbn], BibSource::Heuristic);
        let other = FirstPageHints {
            isbn: Some("0306406152".into()),
            ..hints
        };
        let (record, _) = merge(Some(&good.normalized()), &empty, &empty, Some(&other));
        assert_eq!(record.isbn.as_deref(), Some("9783161484100"));
    }

    #[test]
    fn hints_and_labels_cross_the_wire_with_defaults() {
        let hints: FirstPageHints = serde_json::from_value(json!({})).unwrap();
        assert_eq!(hints, FirstPageHints::default());
    }
}
