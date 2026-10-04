//! Document registry: opaque document id → file path.
//!
//! Paths enter the backend only from the Rust side (the native open dialog, a file dropped on the window, the OS asking the
//! app to open a file, see `documents::intake` and `sources`) and never leave it. The frontend works with [`DocumentId`] and
//! [`PageId`] values alone.

pub mod image_batch;
pub mod intake;
pub mod sources;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant, SystemTime};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, ErrorCode};
use crate::limits;
use crate::model::protection::PermissionSet;

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

    /// The number of the page id (its position until M3).
    pub const fn get(self) -> u32 {
        self.0
    }
}

/// What PDFium says about a document, as far as it can tell: best effort, nothing here is a security promise. Read once, when the
/// document is loaded (`engine::worker`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocFlags {
    /// The file has a security handler (a password or permissions): `/Encrypt` in the trailer.
    pub encrypted: bool,
    /// The form is an XFA form (`/XFA` in the AcroForm dictionary). This build of PDFium has no XFA support, so such a document
    /// shows its fallback page or none at all.
    pub xfa: bool,
    /// The document has an interactive form (AcroForm or XFA).
    pub has_forms: bool,
    /// The document has at least one digital signature field that is signed. Whether the signature is valid is not checked.
    pub signed: bool,
    /// What the file's permissions still allow when it was opened with the open password of a restricted file (ADR-047 §4); `None`: not
    /// encrypted, or opened with owner rights, so nothing is restricted. `apply_command` refuses edits when `edit` is missing.
    pub permissions: Option<PermissionSet>,
}

/// Where a document comes from. `Welcome` is the bundled tour sample (ADR-023): read-only (Save acts as Save As, closing never
/// asks to discard) and never a recent. Everything the user opens is `User`; `Recovered` is an autosave snapshot (ADR-053).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DocKind {
    #[default]
    User,
    Welcome,
    /// A crash-recovery snapshot opened from the autosave store (ADR-053 §2): Save acts as Save As, like `Welcome`, but proposes the
    /// original folder and name (kept in the registry entry, not here: this enum stays `Copy` and a plain word on the wire).
    Recovered,
}

/// What the frontend learns about a document it just opened.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentInfo {
    pub id: DocumentId,
    pub page_count: u32,
    /// The file's name for the status bar, see [`display_name`]. Never contains a directory. The welcome document has its own
    /// localized name instead of its file's.
    pub display_name: String,
    pub kind: DocKind,
    pub flags: DocFlags,
}

/// The name of the file at `path` as the UI may show it: the last path component only (the frontend never learns
/// directories, SECURITY I2), without the characters that can reorder or hide the text around them or break the layout
/// (see `is_unsafe_in_display_name`), at most `limits::MAX_DISPLAY_NAME_CHARS` characters. Empty when the path has no
/// file name; the UI then shows a neutral placeholder. Invalid UTF-8 in the name becomes U+FFFD.
pub fn display_name(path: &Path) -> String {
    let Some(name) = path.file_name() else {
        return String::new();
    };
    sanitize_text(&name.to_string_lossy(), limits::MAX_DISPLAY_NAME_CHARS)
}

/// `text` as the UI may show a string that came from a file: without the characters of [`display_name`]'s filter (see
/// `is_unsafe_in_display_name`), at most `max_chars` characters. The name of a file and the title of an outline entry are
/// both strings of the document, and both get this treatment, so the UI has one rule for what it may be shown.
pub fn sanitize_text(text: &str, max_chars: usize) -> String {
    text.chars()
        .filter(|&c| !is_unsafe_in_display_name(c))
        .take(max_chars)
        .collect()
}

/// Zero width non-joiner and joiner. Format characters (Cf), but scripts need them (Persian, the Indic scripts) and
/// emoji sequences are built with them (family and profession sequences), so a name keeps them. They neither reorder
/// text nor hide anything but themselves.
const KEPT_FORMAT_CHARS: [char; 2] = ['\u{200C}', '\u{200D}'];

/// Every character of the Unicode general category Cf (format) as of Unicode 17, as inclusive ranges in order.
/// The standard library has `char::is_control` (Cc) but no table for Cf, and one table is not worth a dependency.
/// `tests/display_name.rs` checks it over every scalar value against an oracle that is not a copy of it (the standard
/// library's table of printable characters, known Cf characters by name, and the size of the category: 170). Cf has the direction
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

/// What a file looked like when it was opened or last saved: its size and the time it was last changed. A save that finds another
/// file at the path asks the user first (ADR-004 §1 step 2). Size and time are a hint for the user, not a security measure.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Fingerprint {
    pub len: u64,
    pub modified: Option<SystemTime>,
}

impl Fingerprint {
    /// The fingerprint of an open file.
    pub fn of(file: &std::fs::File) -> Option<Self> {
        let metadata = file.metadata().ok()?;
        Some(Self {
            len: metadata.len(),
            modified: metadata.modified().ok(),
        })
    }
}

/// How often a password was wrong for a locked document, and when last (ADR-026). Never the passwords themselves.
#[derive(Debug, Default, Clone, Copy)]
struct PasswordTries {
    wrong: u32,
    last_wrong: Option<Instant>,
}

/// Which engine page each live page of a document is (ADR-036 §1). The model decides the order; this is the copy of it that the commands
/// translate ids with, set by `AppState` after every change of the page list. A document without one (never changed) has the identity.
#[derive(Debug, Clone, Default)]
struct PageMap {
    /// The pages in order: (id, engine index).
    order: Vec<(u32, u32)>,
    to_engine: HashMap<u32, u32>,
    to_page: HashMap<u32, u32>,
}

#[derive(Debug)]
struct Entry {
    /// The page list once it was changed (`None`: page *i* is id *i* is engine page *i*).
    pages: Option<PageMap>,
    path: PathBuf,
    /// What the UI is told about the file, see [`display_name`].
    display_name: String,
    kind: DocKind,
    /// `None` until the engine has loaded the document.
    page_count: Option<u32>,
    /// What PDFium said about the document when it loaded it (`set_flags`); all `false` until then.
    flags: DocFlags,
    /// The UI closed the document, but the engine has not confirmed that it released it (`Registry::begin_close`). The entry stays
    /// so that the release is tried again and the engine's copy is never lost; to everybody else the document is gone.
    closing: bool,
    /// The file needs a password and has not been unlocked: the entry waits for `unlock_document` (it has no page count yet), and
    /// counts the wrong tries. Cleared when the document is loaded.
    locked: Option<PasswordTries>,
    /// The file as it was when it was opened or last saved (`set_fingerprint`), `None` when unknown.
    fingerprint: Option<Fingerprint>,
    /// The original was copied to the backup folder in this session (ADR-004 §3: only the first save does it).
    backed_up: bool,
}

#[derive(Debug, Default)]
struct Inner {
    next_id: u32,
    entries: HashMap<DocumentId, Entry>,
}

impl Inner {
    /// Adds an entry under a fresh id, within the limit on open documents.
    fn insert(
        &mut self,
        path: PathBuf,
        kind: DocKind,
        name: Option<String>,
    ) -> Result<DocumentId, AppError> {
        if self.entries.len() >= limits::MAX_OPEN_DOCUMENTS {
            return Err(AppError::limit(
                "documents",
                limits::MAX_OPEN_DOCUMENTS as u64,
            ));
        }
        let id = DocumentId(self.next_id);
        self.next_id = self
            .next_id
            .checked_add(1)
            .ok_or(AppError::new(ErrorCode::Internal))?;
        let display_name = match name {
            Some(name) => sanitize_text(&name, limits::MAX_DISPLAY_NAME_CHARS),
            None => display_name(&path),
        };
        self.entries.insert(
            id,
            Entry {
                pages: None,
                path,
                display_name,
                kind,
                page_count: None,
                flags: DocFlags::default(),
                closing: false,
                locked: None,
                fingerprint: None,
                backed_up: false,
            },
        );
        Ok(id)
    }
}

/// The answer to [`Registry::claim`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Claim {
    /// The path was not registered: this is its new id, and the caller has to load the document (or give the id back with
    /// [`Registry::abandon`]).
    New(DocumentId),
    /// The path is registered already, loaded or still loading: nothing to load, the document keeps its id.
    Existing(DocumentId),
}

/// What [`Registry::abandon`] found.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Abandoned {
    /// The engine had loaded the document and reported it here before the caller gave up: the open succeeded after all, and
    /// the entry stays.
    Loaded(u32),
    /// The document was not reported loaded; its entry is gone now, so a load that finishes later is refused
    /// ([`Registry::set_page_count`] fails) and the engine releases the document.
    Removed,
    /// There was no such entry.
    Gone,
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

    /// Registers a path and returns its new id, without looking whether the path is registered already (the intake uses
    /// [`Registry::claim`], which does).
    pub fn register(&self, path: PathBuf) -> Result<DocumentId, AppError> {
        self.lock().insert(path, DocKind::User, None)
    }

    /// Registers `path`, which must be canonical (`std::fs::canonicalize`, so two names of one file are one path), unless it
    /// is registered already: a file is open once. Looking and registering are one step under one lock, so two opens of the
    /// same file at the same time cannot both get a new id. The limit on open documents applies to new ids only: a document
    /// that is open can always be "opened" again.
    ///
    /// A document that is being closed (see [`Registry::begin_close`]) is not open any more: its path is claimed anew and gets
    /// a new id, but the entry still counts against the limit, because the engine still holds the document.
    pub fn claim(&self, path: PathBuf) -> Result<Claim, AppError> {
        self.claim_as(path, DocKind::User, None)
    }

    /// [`Registry::claim`] for a document of `kind`, shown under `name` (when given) instead of its file's name. The kind and the
    /// name only apply to a new entry: a document that is open already keeps what it has.
    pub fn claim_as(
        &self,
        path: PathBuf,
        kind: DocKind,
        name: Option<String>,
    ) -> Result<Claim, AppError> {
        let mut inner = self.lock();
        if let Some((&id, _)) = inner
            .entries
            .iter()
            .find(|(_, entry)| !entry.closing && entry.path == path)
        {
            return Ok(Claim::Existing(id));
        }
        inner.insert(path, kind, name).map(Claim::New)
    }

    /// The open welcome documents (not the ones being closed), oldest first.
    pub fn welcome_ids(&self) -> Vec<DocumentId> {
        let inner = self.lock();
        let mut ids: Vec<DocumentId> = inner
            .entries
            .iter()
            .filter(|(_, entry)| !entry.closing && entry.kind == DocKind::Welcome)
            .map(|(&id, _)| id)
            .collect();
        ids.sort_by_key(|id| id.0);
        ids
    }

    /// Whether a document is open that the UI shows (loaded and not being closed). A document waiting for its password is not.
    pub fn has_loaded(&self) -> bool {
        self.lock()
            .entries
            .values()
            .any(|entry| !entry.closing && entry.page_count.is_some())
    }

    /// What the UI is told about a document that is loaded; `None` for an unknown one, one still loading, or one being closed.
    pub fn info(&self, id: DocumentId) -> Option<DocumentInfo> {
        let inner = self.lock();
        let entry = inner.entries.get(&id).filter(|entry| !entry.closing)?;
        Some(DocumentInfo {
            id,
            page_count: entry.page_count?,
            display_name: entry.display_name.clone(),
            kind: entry.kind,
            flags: entry.flags,
        })
    }

    /// Records the page count once the engine has loaded the document. Fails with `not_found` if the entry is gone, which is
    /// how the engine learns that nobody waits for the document any more (see [`Registry::abandon`]).
    pub fn set_page_count(&self, id: DocumentId, page_count: u32) -> Result<(), AppError> {
        match self.lock().entries.get_mut(&id) {
            Some(entry) => {
                entry.page_count = Some(page_count);
                // The pages of the file are the pages of the document (a save does this too): identity again.
                entry.pages = None;
                entry.locked = None;
                Ok(())
            }
            None => Err(AppError::not_found("document")),
        }
    }

    /// Marks a document that is still loading as waiting for its password (the engine answered `password_required`): it keeps its
    /// id and its path, so `unlock_document` can try again, and counts against the limit on open documents. `false` for an
    /// unknown, loaded or closing entry.
    pub fn lock_for_password(&self, id: DocumentId) -> bool {
        match self.lock().entries.get_mut(&id) {
            Some(entry) if entry.page_count.is_none() && !entry.closing => {
                entry.locked.get_or_insert_with(PasswordTries::default);
                true
            }
            _ => false,
        }
    }

    /// The name to show for a document that waits for its password; `None` for any other.
    pub fn locked_name(&self, id: DocumentId) -> Option<String> {
        let inner = self.lock();
        let entry = inner.entries.get(&id)?;
        (entry.locked.is_some() && !entry.closing).then(|| entry.display_name.clone())
    }

    /// The path and kind of a document that waits for its password, for the next attempt; `None` for any other.
    pub fn locked_path(&self, id: DocumentId) -> Option<(PathBuf, DocKind)> {
        let inner = self.lock();
        let entry = inner.entries.get(&id)?;
        (entry.locked.is_some() && !entry.closing).then(|| (entry.path.clone(), entry.kind))
    }

    /// How long an attempt at `id` made at `now` has to wait (ADR-026): nothing for the first `FREE_PASSWORD_ATTEMPTS` wrong
    /// passwords, then `PASSWORD_RETRY_DELAY` after the last wrong one. The registry keeps the count, so the webview cannot
    /// skip the wait.
    pub fn password_wait(&self, id: DocumentId, now: Instant) -> Duration {
        let inner = self.lock();
        let Some(tries) = inner.entries.get(&id).and_then(|entry| entry.locked) else {
            return Duration::ZERO;
        };
        match tries.last_wrong {
            Some(last) if tries.wrong >= limits::FREE_PASSWORD_ATTEMPTS => {
                (last + limits::PASSWORD_RETRY_DELAY).saturating_duration_since(now)
            }
            _ => Duration::ZERO,
        }
    }

    /// Counts a wrong password for a locked document, made at `now`.
    pub fn note_wrong_password(&self, id: DocumentId, now: Instant) {
        if let Some(tries) = self
            .lock()
            .entries
            .get_mut(&id)
            .and_then(|entry| entry.locked.as_mut())
        {
            tries.wrong = tries.wrong.saturating_add(1);
            tries.last_wrong = Some(now);
        }
    }

    /// Forgets a document that waits for its password (the user cancelled, or the file turned out to be unusable). Returns
    /// `true` if there was one. A loaded document is not touched: it is closed with [`Registry::begin_close`].
    pub fn remove_locked(&self, id: DocumentId) -> bool {
        let mut inner = self.lock();
        match inner.entries.get(&id) {
            Some(entry) if entry.locked.is_some() => inner.entries.remove(&id).is_some(),
            _ => false,
        }
    }

    /// Records what PDFium said about a document it loaded. Fails with `not_found` if the entry is gone.
    pub fn set_flags(&self, id: DocumentId, flags: DocFlags) -> Result<(), AppError> {
        match self.lock().entries.get_mut(&id) {
            Some(entry) => {
                entry.flags = flags;
                Ok(())
            }
            None => Err(AppError::not_found("document")),
        }
    }

    /// The caller of an open that failed (or stopped waiting) takes the entry back, unless the engine reported the document
    /// loaded in the meantime. This is the arbiter between the two ends of an open that outlives its deadline: either the
    /// engine's [`Registry::set_page_count`] comes first and the document is open (`Loaded`), or this comes first and the
    /// engine's later call fails, so it drops the document instead of leaving it behind without an entry (`Removed`). Both
    /// happen under the one lock, so there is no third outcome.
    pub fn abandon(&self, id: DocumentId) -> Abandoned {
        let mut inner = self.lock();
        match inner.entries.get(&id).map(|entry| entry.page_count) {
            None => Abandoned::Gone,
            Some(Some(page_count)) => Abandoned::Loaded(page_count),
            Some(None) => {
                inner.entries.remove(&id);
                Abandoned::Removed
            }
        }
    }

    /// Marks a loaded document as being closed, which is the moment the UI is done with it: from now on it is `not_found`
    /// everywhere (`info`, `page_count`, `path`) and its path is free to be opened again. The entry itself stays until the engine
    /// has released the document and the caller says so with [`Registry::remove`], so a release that failed can be tried again
    /// ([`Registry::closing`]) instead of the engine holding a document nobody can name. Returns `true` if there was a loaded
    /// document to close, `false` for an unknown id, one that is still loading (its opener owns it, see [`Registry::abandon`]),
    /// or one that is being closed already.
    pub fn begin_close(&self, id: DocumentId) -> bool {
        match self.lock().entries.get_mut(&id) {
            Some(entry) if entry.page_count.is_some() && !entry.closing => {
                entry.closing = true;
                true
            }
            _ => false,
        }
    }

    /// The documents that are being closed and have not been released yet, oldest first.
    pub fn closing(&self) -> Vec<DocumentId> {
        let mut ids: Vec<DocumentId> = self
            .lock()
            .entries
            .iter()
            .filter(|(_, entry)| entry.closing)
            .map(|(&id, _)| id)
            .collect();
        ids.sort_by_key(|id| id.0);
        ids
    }

    /// Number of pages a loaded document has now (deleted pages are not counted, inserted ones are). Unknown, not yet loaded and
    /// closing ids are `not_found`.
    pub fn page_count(&self, id: DocumentId) -> Result<u32, AppError> {
        self.lock()
            .entries
            .get(&id)
            .filter(|entry| !entry.closing)
            .and_then(|entry| match &entry.pages {
                Some(map) => u32::try_from(map.order.len()).ok(),
                None => entry.page_count,
            })
            .ok_or(AppError::not_found("document"))
    }

    /// The engine's page index for `page` of the loaded document `id` (ADR-036 §1; the identity until the page list is changed). Fails with
    /// `invalid_argument` if the page does not exist and with `not_found` if the document is unknown.
    pub fn page_index(&self, id: DocumentId, page: PageId) -> Result<u32, AppError> {
        let inner = self.lock();
        let entry = inner
            .entries
            .get(&id)
            .filter(|entry| !entry.closing)
            .ok_or(AppError::not_found("document"))?;
        match &entry.pages {
            Some(map) => map
                .to_engine
                .get(&page.0)
                .copied()
                .ok_or(AppError::invalid("page")),
            None => limits::validate_page_index(
                page.0,
                entry.page_count.ok_or(AppError::not_found("document"))?,
            ),
        }
    }

    /// The id of the page at engine index `index` of the loaded document `id`: the inverse of [`Registry::page_index`]. Fails with
    /// `invalid_argument` if the engine page is not a page of the document (deleted or unknown) and with `not_found` if the document
    /// is unknown.
    pub fn page_id(&self, id: DocumentId, index: u32) -> Result<PageId, AppError> {
        let inner = self.lock();
        let entry = inner
            .entries
            .get(&id)
            .filter(|entry| !entry.closing)
            .ok_or(AppError::not_found("document"))?;
        match &entry.pages {
            Some(map) => map
                .to_page
                .get(&index)
                .copied()
                .map(PageId)
                .ok_or(AppError::invalid("page")),
            None => limits::validate_page_index(
                index,
                entry.page_count.ok_or(AppError::not_found("document"))?,
            )
            .map(PageId),
        }
    }

    /// The pages of the loaded document `id` in their order, each as (id, engine index).
    pub fn page_order(&self, id: DocumentId) -> Result<Vec<(PageId, u32)>, AppError> {
        let inner = self.lock();
        let entry = inner
            .entries
            .get(&id)
            .filter(|entry| !entry.closing)
            .ok_or(AppError::not_found("document"))?;
        match &entry.pages {
            Some(map) => Ok(map
                .order
                .iter()
                .map(|&(page, engine)| (PageId(page), engine))
                .collect()),
            None => Ok(
                (0..entry.page_count.ok_or(AppError::not_found("document"))?)
                    .map(|index| (PageId(index), index))
                    .collect(),
            ),
        }
    }

    /// Records the page list of `id` as the model has it now: each page's id and engine index, in order. A no-op for an unknown id.
    pub fn set_pages(&self, id: DocumentId, pages: impl IntoIterator<Item = (PageId, u32)>) {
        let order: Vec<(u32, u32)> = pages
            .into_iter()
            .map(|(page, engine)| (page.0, engine))
            .collect();
        let map = PageMap {
            to_engine: order.iter().copied().collect(),
            to_page: order.iter().map(|&(page, engine)| (engine, page)).collect(),
            order,
        };
        if let Some(entry) = self.lock().entries.get_mut(&id) {
            entry.pages = Some(map);
        }
    }

    /// Path of a registered document that is not being closed (for reload and save in later milestones).
    pub fn path(&self, id: DocumentId) -> Option<PathBuf> {
        self.lock()
            .entries
            .get(&id)
            .filter(|entry| !entry.closing)
            .map(|entry| entry.path.clone())
    }

    /// Remembers what the file of `id` looks like now. A no-op for an unknown id.
    pub fn set_fingerprint(&self, id: DocumentId, fingerprint: Option<Fingerprint>) {
        if let Some(entry) = self.lock().entries.get_mut(&id) {
            entry.fingerprint = fingerprint;
        }
    }

    /// What the file of `id` looked like when it was opened or last saved.
    pub fn fingerprint(&self, id: DocumentId) -> Option<Fingerprint> {
        self.lock().entries.get(&id)?.fingerprint
    }

    /// Whether the original of `id` was backed up in this session.
    pub fn backed_up(&self, id: DocumentId) -> bool {
        self.lock()
            .entries
            .get(&id)
            .is_some_and(|entry| entry.backed_up)
    }

    pub fn set_backed_up(&self, id: DocumentId, done: bool) {
        if let Some(entry) = self.lock().entries.get_mut(&id) {
            entry.backed_up = done;
        }
    }

    /// Whether any open document is the file at `path`.
    pub fn is_open_path(&self, path: &Path) -> bool {
        self.lock()
            .entries
            .values()
            .any(|entry| !entry.closing && entry.path == path)
    }

    /// Whether another open document (not `id`) is the file at `path`.
    pub fn is_open_elsewhere(&self, id: DocumentId, path: &Path) -> bool {
        self.lock()
            .entries
            .iter()
            .any(|(&other, entry)| other != id && !entry.closing && entry.path == path)
    }

    /// The document `id` now lives in the file at `path` (Save As): it is a document of the user's from here on, shown under the name of
    /// the file, and can be saved in place. `io_in_use` if another open document has that path; `not_found` for an unknown id.
    pub fn rebind(&self, id: DocumentId, path: PathBuf) -> Result<(), AppError> {
        let mut inner = self.lock();
        if inner
            .entries
            .iter()
            .any(|(&other, entry)| other != id && !entry.closing && entry.path == path)
        {
            return Err(AppError::new(ErrorCode::IoInUse));
        }
        let entry = inner
            .entries
            .get_mut(&id)
            .filter(|entry| !entry.closing)
            .ok_or(AppError::not_found("document"))?;
        entry.display_name = display_name(&path);
        entry.path = path;
        entry.kind = DocKind::User;
        entry.backed_up = false;
        Ok(())
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
            kind: DocKind::User,
            flags: DocFlags {
                encrypted: true,
                xfa: false,
                has_forms: true,
                signed: false,
                permissions: None,
            },
        };
        assert_eq!(
            serde_json::to_string(&info).unwrap(),
            r#"{"id":0,"pageCount":3,"displayName":"a.pdf","kind":"user","flags":{"encrypted":true,"xfa":false,"hasForms":true,"signed":false,"permissions":null}}"#
        );
    }

    // --- claim, info, abandon ---

    #[test]
    fn only_a_loaded_document_counts_as_open_for_the_window_close() {
        let registry = Registry::new();
        assert!(!registry.has_loaded());
        let id = registry.register(path("a.pdf")).unwrap();
        assert!(!registry.has_loaded(), "still loading");
        registry.set_page_count(id, 1).unwrap();
        assert!(registry.has_loaded());
        assert!(registry.begin_close(id));
        assert!(!registry.has_loaded(), "closing");
    }

    #[test]
    fn a_welcome_document_has_its_kind_and_its_own_name_and_is_found_by_kind() {
        let registry = Registry::new();
        let user = registry.register(path("a.pdf")).unwrap();
        let Claim::New(welcome) = registry
            .claim_as(
                path("welcome-en.pdf"),
                DocKind::Welcome,
                Some("Welcome to Sheer.pdf".to_owned()),
            )
            .unwrap()
        else {
            panic!("expected a new id");
        };
        registry.set_page_count(user, 1).unwrap();
        registry.set_page_count(welcome, 4).unwrap();
        let info = registry.info(welcome).unwrap();
        assert_eq!(info.kind, DocKind::Welcome);
        assert_eq!(info.display_name, "Welcome to Sheer.pdf");
        assert_eq!(registry.info(user).unwrap().kind, DocKind::User);
        assert!(serde_json::to_string(&info)
            .unwrap()
            .contains(r#""kind":"welcome""#));
        assert_eq!(registry.welcome_ids(), [welcome]);
        registry.begin_close(welcome);
        assert!(registry.welcome_ids().is_empty(), "a closing one is gone");
    }

    #[test]
    fn a_path_is_registered_once_and_claiming_it_again_returns_its_id() {
        let registry = Registry::new();
        let a = match registry.claim(path("a.pdf")).unwrap() {
            Claim::New(id) => id,
            other => panic!("expected a new id, got {other:?}"),
        };
        // Still loading or loaded, the answer is the same.
        assert_eq!(registry.claim(path("a.pdf")).unwrap(), Claim::Existing(a));
        registry.set_page_count(a, 2).unwrap();
        assert_eq!(registry.claim(path("a.pdf")).unwrap(), Claim::Existing(a));
        // Another path is another document.
        assert!(matches!(
            registry.claim(path("b.pdf")).unwrap(),
            Claim::New(b) if b != a
        ));
        assert_eq!(registry.len(), 2);
    }

    #[test]
    fn a_closed_path_gets_a_new_id_when_it_is_opened_again() {
        let registry = Registry::new();
        let Claim::New(first) = registry.claim(path("a.pdf")).unwrap() else {
            panic!("new");
        };
        assert!(registry.remove(first));
        let Claim::New(second) = registry.claim(path("a.pdf")).unwrap() else {
            panic!("new");
        };
        assert_ne!(first, second);
    }

    #[test]
    fn claiming_stops_at_the_limit_for_new_paths_but_not_for_open_ones() {
        let registry = Registry::new();
        for i in 0..limits::MAX_OPEN_DOCUMENTS {
            registry.claim(path(&format!("{i}.pdf"))).unwrap();
        }
        let error = registry.claim(path("extra.pdf")).unwrap_err();
        assert_eq!(error.code(), ErrorCode::LimitExceeded);
        assert!(matches!(
            registry.claim(path("0.pdf")).unwrap(),
            Claim::Existing(_)
        ));
        assert_eq!(registry.len(), limits::MAX_OPEN_DOCUMENTS);
    }

    #[test]
    fn two_threads_claiming_one_path_get_one_new_id_between_them() {
        let registry = std::sync::Arc::new(Registry::new());
        let claims: Vec<Claim> = (0..8)
            .map(|_| {
                let registry = std::sync::Arc::clone(&registry);
                std::thread::spawn(move || registry.claim(path("same.pdf")).unwrap())
            })
            .collect::<Vec<_>>()
            .into_iter()
            .map(|thread| thread.join().unwrap())
            .collect();
        let new = claims.iter().filter(|c| matches!(c, Claim::New(_))).count();
        assert_eq!(new, 1);
        assert_eq!(registry.len(), 1);
    }

    #[test]
    fn info_is_there_once_the_document_is_loaded() {
        let registry = Registry::new();
        let id = registry
            .register(PathBuf::from("dir").join("a.pdf"))
            .unwrap();
        assert_eq!(registry.info(id), None, "still loading");
        registry.set_page_count(id, 4).unwrap();
        assert_eq!(
            registry.info(id),
            Some(DocumentInfo {
                id,
                page_count: 4,
                display_name: "a.pdf".to_owned(),
                kind: DocKind::User,
                flags: DocFlags::default(),
            })
        );
        registry.remove(id);
        assert_eq!(registry.info(id), None);
    }

    #[test]
    fn the_flags_of_a_document_are_recorded_for_the_info_and_only_for_an_entry_that_exists() {
        let registry = Registry::new();
        let id = registry.register(path("a.pdf")).unwrap();
        registry.set_page_count(id, 1).unwrap();
        let flags = DocFlags {
            encrypted: true,
            signed: true,
            ..DocFlags::default()
        };
        registry.set_flags(id, flags).unwrap();
        assert_eq!(registry.info(id).unwrap().flags, flags);
        registry.remove(id);
        assert_eq!(
            registry.set_flags(id, flags).unwrap_err().code(),
            ErrorCode::NotFound
        );
    }

    #[test]
    fn text_from_a_file_loses_what_could_reorder_or_hide_it_and_is_cut_at_the_limit() {
        assert_eq!(sanitize_text("Chapter 1", 512), "Chapter 1");
        // Direction override, zero width space, a control character, a line separator.
        assert_eq!(
            sanitize_text("a\u{202e}b\u{200b}c\u{7}d\u{2028}e", 512),
            "abcde"
        );
        // The joiners stay: scripts and emoji need them.
        assert_eq!(sanitize_text("a\u{200d}b", 512), "a\u{200d}b");
        assert_eq!(
            sanitize_text("\u{fc}ber \u{1f600}\u{1f600}", 6),
            "\u{fc}ber \u{1f600}"
        );
        assert_eq!(sanitize_text("", 5), "");
    }

    #[test]
    fn abandoning_an_open_that_was_not_reported_loaded_removes_it_and_refuses_a_late_report() {
        let registry = Registry::new();
        let id = registry.register(path("a.pdf")).unwrap();
        assert_eq!(registry.abandon(id), Abandoned::Removed);
        assert!(registry.is_empty());
        // The engine finishing later is told nobody wants the document (it releases it).
        assert_eq!(
            registry.set_page_count(id, 3).unwrap_err().code(),
            ErrorCode::NotFound
        );
        assert!(registry.is_empty());
        assert_eq!(registry.abandon(id), Abandoned::Gone);
    }

    #[test]
    fn abandoning_an_open_that_was_reported_loaded_keeps_it() {
        let registry = Registry::new();
        let id = registry.register(path("a.pdf")).unwrap();
        registry.set_page_count(id, 3).unwrap();
        assert_eq!(registry.abandon(id), Abandoned::Loaded(3));
        assert_eq!(registry.len(), 1, "the document is open and can be closed");
        assert_eq!(registry.page_count(id).unwrap(), 3);
    }

    // --- closing ---

    #[test]
    fn a_document_being_closed_is_gone_to_everybody_but_stays_until_it_is_released() {
        let registry = Registry::new();
        let id = registry.register(path("a.pdf")).unwrap();
        registry.set_page_count(id, 3).unwrap();
        assert!(registry.closing().is_empty());

        assert!(registry.begin_close(id));
        // Not found for the UI's calls, and not offered again by opening the same path ...
        assert_eq!(registry.info(id), None);
        assert_eq!(
            registry.page_count(id).unwrap_err().code(),
            ErrorCode::NotFound
        );
        assert_eq!(
            registry.page_index(id, PageId::new(0)).unwrap_err().code(),
            ErrorCode::NotFound
        );
        assert_eq!(registry.path(id), None);
        let Claim::New(again) = registry.claim(path("a.pdf")).unwrap() else {
            panic!("a closed path is a new document");
        };
        assert_ne!(again, id);
        // ... but it is still known, so the release can be tried again, and it still counts against the limit.
        assert_eq!(registry.closing(), [id]);
        assert_eq!(registry.len(), 2);
        // Closing it twice is nothing; the second call finds it closing already.
        assert!(!registry.begin_close(id));

        assert!(registry.remove(id));
        assert!(registry.closing().is_empty());
        assert_eq!(registry.len(), 1);
    }

    #[test]
    fn only_a_loaded_document_can_be_closed_and_the_documents_that_wait_for_release_come_oldest_first(
    ) {
        let registry = Registry::new();
        let unknown = registry.register(path("x.pdf")).unwrap();
        registry.remove(unknown);
        let loading = registry.register(path("loading.pdf")).unwrap();
        assert!(!registry.begin_close(unknown));
        // Whoever is loading a document owns it: nobody else can close it before it is loaded.
        assert!(!registry.begin_close(loading));
        assert_eq!(registry.abandon(loading), Abandoned::Removed);

        let ids: Vec<DocumentId> = (0..3)
            .map(|i| {
                let id = registry.register(path(&format!("{i}.pdf"))).unwrap();
                registry.set_page_count(id, 1).unwrap();
                id
            })
            .collect();
        for &id in ids.iter().rev() {
            assert!(registry.begin_close(id));
        }
        assert_eq!(registry.closing(), ids);
    }

    #[test]
    fn documents_being_closed_count_against_the_limit_on_open_documents() {
        let registry = Registry::new();
        let first = registry.register(path("0.pdf")).unwrap();
        registry.set_page_count(first, 1).unwrap();
        for i in 1..limits::MAX_OPEN_DOCUMENTS {
            registry.register(path(&format!("{i}.pdf"))).unwrap();
        }
        assert!(registry.begin_close(first));
        // The engine may still hold it: no room is made until it is released.
        assert_eq!(
            registry.claim(path("extra.pdf")).unwrap_err().code(),
            ErrorCode::LimitExceeded
        );
        registry.remove(first);
        assert!(registry.claim(path("extra.pdf")).is_ok());
    }

    // --- documents that wait for a password ---

    #[test]
    fn a_locked_document_keeps_its_entry_and_is_not_loaded() {
        let registry = Registry::new();
        let id = registry.register(path("secret.pdf")).unwrap();
        assert_eq!(registry.locked_name(id), None);
        assert!(registry.lock_for_password(id));
        assert_eq!(registry.locked_name(id).as_deref(), Some("secret.pdf"));
        assert_eq!(
            registry.locked_path(id),
            Some((path("secret.pdf"), DocKind::User))
        );
        // Not open yet: no info, no page count, and it cannot be closed like a loaded one.
        assert_eq!(registry.info(id), None);
        assert!(!registry.begin_close(id));
        // Loading it clears the lock.
        registry.set_page_count(id, 2).unwrap();
        assert_eq!(registry.locked_name(id), None);
        assert!(
            !registry.lock_for_password(id),
            "a loaded document is never locked"
        );
        assert!(
            !registry.remove_locked(id),
            "and never removed as a locked one"
        );
        assert!(registry.info(id).is_some());
    }

    #[test]
    fn cancelling_removes_a_locked_entry_and_nothing_else() {
        let registry = Registry::new();
        let locked = registry.register(path("a.pdf")).unwrap();
        let loaded = registry.register(path("b.pdf")).unwrap();
        registry.set_page_count(loaded, 1).unwrap();
        assert!(registry.lock_for_password(locked));
        assert!(registry.remove_locked(locked));
        assert!(!registry.remove_locked(locked));
        assert!(!registry.remove_locked(loaded));
        assert_eq!(registry.len(), 1);
    }

    #[test]
    fn after_the_third_wrong_password_each_try_waits_a_second() {
        let registry = Registry::new();
        let id = registry.register(path("a.pdf")).unwrap();
        registry.lock_for_password(id);
        let start = Instant::now();
        for _ in 0..limits::FREE_PASSWORD_ATTEMPTS {
            assert_eq!(registry.password_wait(id, start), Duration::ZERO);
            registry.note_wrong_password(id, start);
        }
        assert_eq!(
            registry.password_wait(id, start),
            limits::PASSWORD_RETRY_DELAY
        );
        assert_eq!(
            registry.password_wait(id, start + Duration::from_millis(400)),
            Duration::from_millis(600)
        );
        assert_eq!(
            registry.password_wait(id, start + limits::PASSWORD_RETRY_DELAY),
            Duration::ZERO
        );
        // Every further wrong one starts the second again.
        let later = start + Duration::from_secs(5);
        registry.note_wrong_password(id, later);
        assert_eq!(
            registry.password_wait(id, later),
            limits::PASSWORD_RETRY_DELAY
        );
    }

    #[test]
    fn a_document_that_is_not_locked_never_waits() {
        let registry = Registry::new();
        let id = registry.register(path("a.pdf")).unwrap();
        registry.note_wrong_password(id, Instant::now());
        assert_eq!(registry.password_wait(id, Instant::now()), Duration::ZERO);
        let gone = registry.register(path("b.pdf")).unwrap();
        registry.remove(gone);
        assert_eq!(registry.password_wait(gone, Instant::now()), Duration::ZERO);
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
