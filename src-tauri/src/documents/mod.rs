//! Document registry: opaque document id → file path.
//!
//! Paths only ever enter through the native file dialog (backend) and never leave the backend. The frontend works
//! with [`DocumentId`] and [`PageId`] values alone.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, PoisonError};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, ErrorCode};
use crate::limits;

/// Opaque handle for an open document. Serialized as a plain number.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct DocumentId(u32);

/// Opaque handle for a page of an open document. Serialized as a plain number.
///
/// Until pages can be reordered, inserted or deleted (M3) the id of a page is its position, so the registry maps ids
/// to indices with the identity function ([`Registry::page_index`]). Commands already take a `PageId` so that
/// nothing on the wire changes when the mapping becomes real.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct PageId(u32);

impl PageId {
    pub const fn new(value: u32) -> Self {
        Self(value)
    }
}

/// What the frontend learns about a document it just opened.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentInfo {
    pub id: DocumentId,
    pub page_count: u32,
    /// The file's name for the status bar, see [`display_name`]. Never contains a directory.
    pub display_name: String,
}

/// The name of the file at `path` as the UI may show it: the last path component only (the frontend never learns
/// directories, SECURITY I2), without the characters that can reorder or hide the text around them or break the layout
/// (see `is_unsafe_in_display_name`), at most `limits::MAX_DISPLAY_NAME_CHARS` characters. Empty when the path has no
/// file name; the UI then shows a neutral placeholder. Invalid UTF-8 in the name becomes U+FFFD.
pub fn display_name(path: &Path) -> String {
    let Some(name) = path.file_name() else {
        return String::new();
    };
    name.to_string_lossy()
        .chars()
        .filter(|&c| !is_unsafe_in_display_name(c))
        .take(limits::MAX_DISPLAY_NAME_CHARS)
        .collect()
}

/// Zero width non-joiner and joiner. Format characters (Cf), but scripts need them (Persian, the Indic scripts) and
/// emoji sequences are built with them (family and profession sequences), so a name keeps them. They neither reorder
/// text nor hide anything but themselves.
const KEPT_FORMAT_CHARS: [char; 2] = ['\u{200C}', '\u{200D}'];

/// Every character of the Unicode general category Cf (format) as of Unicode 17, as inclusive ranges in order.
/// The standard library has `char::is_control` (Cc) but no table for Cf, and one table is not worth a dependency.
/// `tests/display_name.rs` holds an independent copy and compares both over every scalar value. Cf has the direction
/// marks, embeddings, overrides and isolates (the "gpj.exe" trick), the zero-width and invisible-operator characters, the
/// soft hyphen, the byte order mark, the interlinear annotation marks, the Arabic number signs and the tag characters
/// (invisible text that survives copy and paste).
const FORMAT_CHARS: [(char, char); 21] = [
    ('\u{00AD}', '\u{00AD}'),
    ('\u{0600}', '\u{0605}'),
    ('\u{061C}', '\u{061C}'),
    ('\u{06DD}', '\u{06DD}'),
    ('\u{070F}', '\u{070F}'),
    ('\u{0890}', '\u{0891}'),
    ('\u{08E2}', '\u{08E2}'),
    ('\u{180E}', '\u{180E}'),
    ('\u{200B}', '\u{200F}'),
    ('\u{202A}', '\u{202E}'),
    ('\u{2060}', '\u{2064}'),
    ('\u{2066}', '\u{206F}'),
    ('\u{FEFF}', '\u{FEFF}'),
    ('\u{FFF9}', '\u{FFFB}'),
    ('\u{110BD}', '\u{110BD}'),
    ('\u{110CD}', '\u{110CD}'),
    ('\u{13430}', '\u{1343F}'),
    ('\u{1BCA0}', '\u{1BCA3}'),
    ('\u{1D173}', '\u{1D17A}'),
    ('\u{E0001}', '\u{E0001}'),
    ('\u{E0020}', '\u{E007F}'),
];

/// What a display name never shows: the general categories Cc (C0 and C1 controls, DEL) and Cf (format characters, see
/// [`FORMAT_CHARS`]) except U+200C and U+200D; the line and paragraph separators (U+2028 and U+2029, categories Zl and
/// Zp, which break a line like a newline does); and the object replacement character (U+FFFC, a placeholder for
/// something that is not there).
fn is_unsafe_in_display_name(c: char) -> bool {
    c.is_control()
        || (!KEPT_FORMAT_CHARS.contains(&c)
            && FORMAT_CHARS
                .iter()
                .any(|&(first, last)| (first..=last).contains(&c)))
        || matches!(c, '\u{2028}' | '\u{2029}' | '\u{FFFC}')
}
#[derive(Debug)]
struct Entry {
    path: PathBuf,
    /// `None` until the engine has loaded the document.
    page_count: Option<u32>,
}

#[derive(Debug, Default)]
struct Inner {
    next_id: u32,
    entries: HashMap<DocumentId, Entry>,
}

/// Thread-safe registry. Ids are never reused within a session.
#[derive(Debug, Default)]
pub struct Registry {
    inner: Mutex<Inner>,
}

impl Registry {
    pub fn new() -> Self {
        Self::default()
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        // A poisoned lock only means another thread panicked mid-update; the map itself stays consistent.
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Registers a path and returns its new id.
    pub fn register(&self, path: PathBuf) -> Result<DocumentId, AppError> {
        let mut inner = self.lock();
        if inner.entries.len() >= limits::MAX_OPEN_DOCUMENTS {
            return Err(AppError::limit(
                "documents",
                limits::MAX_OPEN_DOCUMENTS as u64,
            ));
        }
        let id = DocumentId(inner.next_id);
        inner.next_id = inner
            .next_id
            .checked_add(1)
            .ok_or(AppError::new(ErrorCode::Internal))?;
        inner.entries.insert(
            id,
            Entry {
                path,
                page_count: None,
            },
        );
        Ok(id)
    }

    /// Records the page count once the engine has loaded the document.
    pub fn set_page_count(&self, id: DocumentId, page_count: u32) -> Result<(), AppError> {
        match self.lock().entries.get_mut(&id) {
            Some(entry) => {
                entry.page_count = Some(page_count);
                Ok(())
            }
            None => Err(AppError::not_found("document")),
        }
    }

    /// Page count of a loaded document. Unknown or not yet loaded ids are `not_found`.
    pub fn page_count(&self, id: DocumentId) -> Result<u32, AppError> {
        self.lock()
            .entries
            .get(&id)
            .and_then(|entry| entry.page_count)
            .ok_or(AppError::not_found("document"))
    }

    /// Position of `page` in the loaded document `id`. Identity mapping until M3 (see [`PageId`]); fails with
    /// `invalid_argument` if the page does not exist and with `not_found` if the document is unknown.
    pub fn page_index(&self, id: DocumentId, page: PageId) -> Result<u32, AppError> {
        limits::validate_page_index(page.0, self.page_count(id)?)
    }

    /// Path of a registered document (for reload and save in later milestones).
    pub fn path(&self, id: DocumentId) -> Option<PathBuf> {
        self.lock().entries.get(&id).map(|entry| entry.path.clone())
    }

    /// Removes a document. Returns `true` if it was registered.
    pub fn remove(&self, id: DocumentId) -> bool {
        self.lock().entries.remove(&id).is_some()
    }

    pub fn len(&self) -> usize {
        self.lock().entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn path(name: &str) -> PathBuf {
        PathBuf::from(name)
    }

    #[test]
    fn ids_are_unique_and_not_reused_after_removal() {
        let registry = Registry::new();
        let a = registry.register(path("a.pdf")).unwrap();
        let b = registry.register(path("b.pdf")).unwrap();
        assert_ne!(a, b);
        assert!(registry.remove(a));
        let c = registry.register(path("c.pdf")).unwrap();
        assert_ne!(a, c);
        assert_ne!(b, c);
    }

    #[test]
    fn page_count_requires_a_loaded_document() {
        let registry = Registry::new();
        let id = registry.register(path("a.pdf")).unwrap();
        assert_eq!(
            registry.page_count(id).unwrap_err().code(),
            ErrorCode::NotFound
        );
        registry.set_page_count(id, 7).unwrap();
        assert_eq!(registry.page_count(id).unwrap(), 7);
        assert_eq!(registry.path(id), Some(path("a.pdf")));
    }

    #[test]
    fn unknown_ids_are_rejected() {
        let registry = Registry::new();
        let id = registry.register(path("a.pdf")).unwrap();
        assert!(registry.remove(id));
        assert!(!registry.remove(id));
        assert_eq!(
            registry.set_page_count(id, 1).unwrap_err().code(),
            ErrorCode::NotFound
        );
        assert_eq!(registry.path(id), None);
    }

    #[test]
    fn open_documents_are_capped() {
        let registry = Registry::new();
        for i in 0..limits::MAX_OPEN_DOCUMENTS {
            registry.register(path(&format!("{i}.pdf"))).unwrap();
        }
        assert_eq!(
            registry.register(path("extra.pdf")).unwrap_err().code(),
            ErrorCode::LimitExceeded
        );
        assert_eq!(registry.len(), limits::MAX_OPEN_DOCUMENTS);
    }

    #[test]
    fn page_ids_resolve_by_identity_within_the_page_count() {
        let registry = Registry::new();
        let id = registry.register(path("a.pdf")).unwrap();
        // Not loaded yet: the document is unknown to callers.
        assert_eq!(
            registry.page_index(id, PageId::new(0)).unwrap_err().code(),
            ErrorCode::NotFound
        );
        registry.set_page_count(id, 3).unwrap();
        assert_eq!(registry.page_index(id, PageId::new(0)).unwrap(), 0);
        assert_eq!(registry.page_index(id, PageId::new(2)).unwrap(), 2);
        for out_of_range in [3, 4, u32::MAX] {
            assert_eq!(
                registry
                    .page_index(id, PageId::new(out_of_range))
                    .unwrap_err()
                    .code(),
                ErrorCode::InvalidArgument
            );
        }
    }

    #[test]
    fn page_ids_deserialize_from_plain_numbers() {
        let page: PageId = serde_json::from_str("7").unwrap();
        assert_eq!(page, PageId::new(7));
        assert!(serde_json::from_str::<PageId>("-1").is_err());
        assert!(serde_json::from_str::<PageId>("\"7\"").is_err());
    }

    #[test]
    fn document_info_serializes_camel_case() {
        let registry = Registry::new();
        let id = registry.register(path("a.pdf")).unwrap();
        let info = DocumentInfo {
            id,
            page_count: 3,
            display_name: "a.pdf".to_owned(),
        };
        assert_eq!(
            serde_json::to_string(&info).unwrap(),
            r#"{"id":0,"pageCount":3,"displayName":"a.pdf"}"#
        );
    }

    // --- display names ---

    #[test]
    fn a_display_name_is_the_file_name_without_any_directory() {
        assert_eq!(display_name(&path("report.pdf")), "report.pdf");
        assert_eq!(
            display_name(&PathBuf::from("some").join("dir").join("Q3 report.pdf")),
            "Q3 report.pdf"
        );
        // Windows drive and verbatim prefixes (what `canonicalize` returns) are directory, not name.
        #[cfg(windows)]
        {
            assert_eq!(
                display_name(Path::new(r"C:\Users\user\secret\a.pdf")),
                "a.pdf"
            );
            assert_eq!(display_name(Path::new(r"\\?\C:\Users\user\a.pdf")), "a.pdf");
        }
        for name in ["日本語.pdf", "Überschrift – final.pdf", "emoji 📄.pdf"] {
            assert_eq!(display_name(&path(name)), name);
        }
    }

    #[test]
    fn a_path_without_a_file_name_has_an_empty_display_name() {
        assert_eq!(display_name(Path::new("")), "");
        assert_eq!(display_name(Path::new("..")), "");
        assert_eq!(display_name(Path::new("/")), "");
    }

    #[test]
    fn control_and_direction_characters_are_removed_from_a_display_name() {
        // Right-to-left override: "gpj.exe" would show as "exe.jpg"; a newline or NUL would break the layout.
        for (raw, shown) in [
            ("a\u{202E}fdp.exe", "afdp.exe"),
            ("a\u{2066}b\u{2069}.pdf", "ab.pdf"),
            ("line\nbreak\r.pdf", "linebreak.pdf"),
            ("nul\0.pdf", "nul.pdf"),
            ("tab\there.pdf", "tabhere.pdf"),
            ("zero\u{200B}width\u{FEFF}.pdf", "zerowidth.pdf"),
            ("sep\u{2028}\u{2029}.pdf", "sep.pdf"),
            ("esc\u{1B}[31m.pdf", "esc[31m.pdf"),
            ("c1\u{85}.pdf", "c1.pdf"),
            ("\u{061C}x.pdf", "x.pdf"),
            // The rest of the format characters (category Cf), block by block: soft hyphen, Arabic number sign,
            // interlinear annotation marks, tag characters (the invisible letters of a subdivision flag); and the object
            // replacement character, a placeholder of category So.
            ("soft\u{AD}hyphen.pdf", "softhyphen.pdf"),
            ("\u{0600}1.pdf", "1.pdf"),
            ("a\u{FFF9}b\u{FFFA}c\u{FFFB}.pdf", "abc.pdf"),
            ("flag\u{E0067}\u{E0062}\u{E007F}.pdf", "flag.pdf"),
            ("\u{E0001}tagged.pdf", "tagged.pdf"),
            ("obj\u{FFFC}.pdf", "obj.pdf"),
        ] {
            assert_eq!(display_name(&path(raw)), shown, "{raw:?}");
        }
    }

    #[test]
    fn the_joiners_stay_because_scripts_and_emoji_need_them() {
        for name in [
            // Persian: the zero width non-joiner keeps letters apart that would otherwise join.
            "می\u{200C}خواهم.pdf",
            // Devanagari conjunct with a zero width joiner.
            "क्\u{200D}ष.pdf",
            // Emoji sequences are glued with the zero width joiner.
            "family 👨\u{200D}👩\u{200D}👧.pdf",
            "\u{1F469}\u{200D}\u{1F4BB} work.pdf",
        ] {
            assert_eq!(display_name(&path(name)), name, "{name:?}");
        }
        // The other zero-width characters between them still go.
        assert_eq!(
            display_name(&path("a\u{200B}\u{200C}\u{200D}\u{200E}b.pdf")),
            "a\u{200C}\u{200D}b.pdf"
        );
    }

    #[test]
    fn a_display_name_is_capped() {
        let long = "x".repeat(limits::MAX_DISPLAY_NAME_CHARS + 50);
        let shown = display_name(&path(&long));
        assert_eq!(shown.chars().count(), limits::MAX_DISPLAY_NAME_CHARS);
        // Counted in characters, not bytes: a multi-byte name is cut on a character boundary.
        let wide = "é".repeat(limits::MAX_DISPLAY_NAME_CHARS + 1);
        assert_eq!(
            display_name(&path(&wide)).chars().count(),
            limits::MAX_DISPLAY_NAME_CHARS
        );
    }
}
