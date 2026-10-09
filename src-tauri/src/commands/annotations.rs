//! The annotations of a document and the commands that change them (ARCHITECTURE §5 annotations, ADR-003).
//!
//! | Command | Arguments | Returns |
//! |---|---|---|
//! | `list_annotations` | `docId: number`, `pageId: number` | `Annotation[]` of the page, by id. The first call for a page reads its annotations from the file (an `Interactive` engine job) |
//! | `list_document_annotations` | `docId: number` | `AnnotationSummary[]` of every page (at most 20 000) by page then id, for the comments panel. Pages not read yet are read at `Background` priority |
//! | `get_annotation_quote` | `docId: number`, `annotationId: number` | `string | null`: the text of the page under a highlight, underline or strikeout (characters whose centre is inside a quad, whitespace collapsed, at most 280 characters, `…` last if cut); `null` for another kind or no text. `not_found` (`annotation`) for an id the model does not have |
//! | `import_warnings` | `docId: number` | `ImportWarning[]` (`{type: "pageTruncated", page, skipped}`): annotations of the pages read so far that did not fit the model caps; they stay in the file |
//! | `apply_command` | `docId: number`, `command: DocCommand` | moved to `pages`: the `ChangeSet` of an annotation or page command; the whole command happened or nothing did |
//! | `undo`, `redo` | `docId: number` | the `ChangeSet` of the step taken back or done again; empty (same `rev`) if there is none |
//!
//! There is no event channel: every change of the model is the answer to a command of the UI, which applies the delta to its replica
//! (`src/stores/annotations.ts`). Nothing else changes the model while a document is open, so the replica cannot miss a change.
//!
//! The model lives in `model::doc_state::DocState`, one per open document, created on first use and dropped when the document is closed.
//! The clock and the file are the only things that are not in the model: this module stamps the commands (`modified`, a monotonic
//! time for coalescing) and asks the engine for the annotations of a page the first time the page is listed.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Mutex, MutexGuard};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::State;

use super::{blocking, AppState};
use crate::documents::{DocumentId, PageId};
use crate::error::{AppError, UiError};
use crate::limits;
use crate::model::annotation::{Annotation, AnnotationBody, ReviewState, Rgb};
use crate::model::doc_state::{ChangeSet, DocState, Stamp};
use crate::model::history::HistoryList;
use crate::model::ids::AnnotId;
use crate::model::page::unrotated;
use crate::model::quote::{quote_of, CARD_QUOTE_MAX};
use crate::pdfwrite::foreign::{self, ForeignRead};
use crate::pdfwrite::reviews::ReviewLink;
use crate::pdfwrite::sheer_keys::{self, SheerKeys};

/// The Sheer keys of several pages: by page index, then by annotation position.
type KeysByPage = HashMap<u32, HashMap<u32, SheerKeys>>;

/// Longest excerpt of an annotation's contents in a summary, in characters.
pub const SUMMARY_EXCERPT_CHARS: usize = 240;

/// What the comments panel needs of an annotation: no geometry, and only the start of the contents. The strings come from the file
/// and are shown as text only.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnnotationSummary {
    pub id: AnnotId,
    pub page_id: PageId,
    /// The `kind` tag of the annotation (`highlight`, `note`, `opaque`, ...).
    pub kind: &'static str,
    pub color: Rgb,
    /// The first [`SUMMARY_EXCERPT_CHARS`] characters of the contents.
    pub contents: String,
    pub author: Option<String>,
    pub modified: Option<String>,
    pub in_reply_to: Option<AnnotId>,
    /// The review state a reply gives its parent; absent on every other annotation.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<ReviewState>,
    /// What a `mark`, `signature` or `line` is: `check`, `cross`, `dot`; `signature`, `initials`; `arrow` (a line with an end) (ADR-057).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<&'static str>,
    /// The tag names of the annotation (ADR-119).
    pub tags: Vec<String>,
    /// The annotation is a citation (ADR-119).
    pub cite: bool,
}

fn kind_of(body: &AnnotationBody) -> &'static str {
    match body {
        AnnotationBody::Highlight { .. } => "highlight",
        AnnotationBody::Underline { .. } => "underline",
        AnnotationBody::Strikeout { .. } => "strikeout",
        AnnotationBody::Note { .. } => "note",
        AnnotationBody::FreeText { .. } => "freeText",
        AnnotationBody::Ink { .. } => "ink",
        AnnotationBody::Rect { .. } => "rect",
        AnnotationBody::Ellipse { .. } => "ellipse",
        AnnotationBody::Line { .. } => "line",
        AnnotationBody::Signature { .. } => "signature",
        AnnotationBody::Mark { .. } => "mark",
        AnnotationBody::Stamp { .. } => "stamp",
        AnnotationBody::TextBox { .. } => "textBox",
        AnnotationBody::Image { .. } => "image",
        AnnotationBody::RedactMark { .. } => "redactMark",
        AnnotationBody::Opaque { .. } => "opaque",
    }
}

/// Runs `read` over the bytes of the file at `path` and page `page_index`, on a thread of its own, with a deadline.
/// What a page reader answers: a value per annotation position.
type PageReader<T> = fn(&[u8], u32) -> Result<HashMap<u32, T>, AppError>;

fn read_page_file<T: Send + 'static>(
    path: std::path::PathBuf,
    page_index: u32,
    read: PageReader<T>,
) -> Result<HashMap<u32, T>, AppError> {
    let (sender, receiver) = std::sync::mpsc::channel();
    let spawned = std::thread::Builder::new()
        .name("sheer-review".into())
        .stack_size(limits::SAVE_STACK_BYTES)
        .spawn(move || {
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let (bytes, _) = super::save::read_all(crate::documents::intake::admit(&path)?)?;
                read(&bytes, page_index)
            }))
            .unwrap_or_else(|_| {
                Err(AppError::logged(
                    crate::error::ErrorCode::Internal,
                    "reading the review links panicked",
                ))
            });
            let _ = sender.send(result);
        });
    if spawned.is_err() {
        return Ok(HashMap::new());
    }
    receiver
        .recv_timeout(limits::FORM_READ_TIMEOUT)
        .unwrap_or_else(|_| Ok(HashMap::new()))
}

/// The Sheer keys of the pages `page_indices` of the file at `path`, read in one pass (one parse) on a thread of its own, with a
/// deadline. `None` when the file cannot be read or parsed again, or the reader panicked (the keys are unknown: a save leaves the ones the
/// file has); a read that does not finish is `engine_timeout`, and the pages stay unread so the next list tries again.
fn read_keys_file(
    path: std::path::PathBuf,
    page_indices: Vec<u32>,
) -> Result<Option<KeysByPage>, AppError> {
    let (sender, receiver) = std::sync::mpsc::channel();
    let spawned = std::thread::Builder::new()
        .name("sheer-keys".into())
        .stack_size(limits::SAVE_STACK_BYTES)
        .spawn(move || {
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let (bytes, _) = super::save::read_all(crate::documents::intake::admit(&path)?)?;
                sheer_keys::read_pages(&bytes, &page_indices)
            }))
            .unwrap_or_else(|_| Err(AppError::new(crate::error::ErrorCode::Internal)));
            let _ = sender.send(result.ok());
        });
    if spawned.is_err() {
        return Ok(None);
    }
    receiver
        .recv_timeout(limits::FORM_READ_TIMEOUT)
        .map_err(|_| AppError::new(crate::error::ErrorCode::EngineTimeout))
}

impl AnnotationSummary {
    fn of(annotation: &Annotation) -> Self {
        Self {
            id: annotation.id,
            page_id: annotation.page_id,
            kind: kind_of(&annotation.body),
            color: annotation.color,
            contents: annotation
                .contents
                .chars()
                .take(SUMMARY_EXCERPT_CHARS)
                .collect(),
            author: annotation.author.clone(),
            modified: annotation.modified.clone(),
            in_reply_to: annotation.in_reply_to,
            state: annotation.state,
            detail: detail_of(&annotation.body),
            tags: annotation.tags.clone(),
            cite: annotation.cite.is_some(),
        }
    }
}

fn detail_of(body: &AnnotationBody) -> Option<&'static str> {
    use crate::model::annotation::{MarkGlyph, SignatureRole};
    match body {
        AnnotationBody::Stamp { stamp, .. } => Some(stamp.word()),
        AnnotationBody::Mark { glyph, .. } => Some(match glyph {
            MarkGlyph::Check => "check",
            MarkGlyph::Cross => "cross",
            MarkGlyph::Dot => "dot",
        }),
        AnnotationBody::Signature { role, .. } => Some(match role {
            SignatureRole::Signature => "signature",
            SignatureRole::Initials => "initials",
        }),
        AnnotationBody::Line { head, tail, .. }
            if *head != crate::model::annotation::LineEnd::None
                || *tail != crate::model::annotation::LineEnd::None =>
        {
            Some("arrow")
        }
        _ => None,
    }
}

/// The models of the open documents, and the ids of the documents that were closed (an id is never reused, so a late command for a
/// closed document finds it there and is refused instead of getting a model of its own).
#[derive(Default)]
struct Models {
    docs: HashMap<DocumentId, DocState>,
    closed: Remembered,
    /// Documents whose model was dropped after a panic: refused with a reason the UI can explain (`not_found`, `annotation_state`).
    lost: Remembered,
}

/// How many ids [`Remembered`] keeps.
const REMEMBERED_IDS: usize = 4096;

/// A set of document ids that forgets the oldest once it holds [`REMEMBERED_IDS`] (ids are never reused and only a few documents are
/// open at once, so an id that old is not asked for any more; the set must not grow with every document opened in a long session).
#[derive(Default)]
struct Remembered {
    set: HashSet<DocumentId>,
    order: VecDeque<DocumentId>,
}

impl Remembered {
    fn insert(&mut self, id: DocumentId) {
        if self.set.insert(id) {
            self.order.push_back(id);
            while self.order.len() > REMEMBERED_IDS {
                if let Some(oldest) = self.order.pop_front() {
                    self.set.remove(&oldest);
                }
            }
        }
    }

    fn contains(&self, id: &DocumentId) -> bool {
        self.set.contains(id)
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.set.len()
    }
}

/// The models of the open documents.
pub struct AnnotationStore {
    docs: Mutex<Models>,
    started: Instant,
}

impl Default for AnnotationStore {
    fn default() -> Self {
        Self {
            docs: Mutex::new(Models::default()),
            started: Instant::now(),
        }
    }
}

impl AnnotationStore {
    /// The lock. A poisoned lock means a command panicked while it held the models, which then may be half changed: every model is
    /// dropped and its document refused from then on (`not_found`) rather than trusted; the lock is usable again for new documents.
    fn lock(&self) -> MutexGuard<'_, Models> {
        self.docs.lock().unwrap_or_else(|poisoned| {
            let mut models = poisoned.into_inner();
            let ids: Vec<DocumentId> = models.docs.keys().copied().collect();
            for id in ids {
                models.lost.insert(id);
            }
            models.docs.clear();
            self.docs.clear_poison();
            models
        })
    }

    /// Runs `f` on the model of document `id` (of `page_count` pages), which is created if the document has none yet. A document that
    /// was closed (or whose model was dropped after a panic) is `not_found`.
    pub(super) fn with<T>(
        &self,
        id: DocumentId,
        page_count: u32,
        f: impl FnOnce(&mut DocState) -> Result<T, AppError>,
    ) -> Result<T, AppError> {
        self.with_init(id, || DocState::new(page_count), f)
    }

    /// [`AnnotationStore::with`] where a document that has no model yet gets the one `init` makes (the sizes and rotations of its pages).
    pub(super) fn with_init<T>(
        &self,
        id: DocumentId,
        init: impl FnOnce() -> DocState,
        f: impl FnOnce(&mut DocState) -> Result<T, AppError>,
    ) -> Result<T, AppError> {
        let mut models = self.lock();
        if models.lost.contains(&id) {
            return Err(AppError::not_found("annotation_state"));
        }
        if models.closed.contains(&id) {
            return Err(AppError::not_found("document"));
        }
        f(models.docs.entry(id).or_insert_with(init))
    }

    /// Runs `f` on the model of document `id` if it has one (none is made); `None` for a document without a model, a closed one, or when
    /// `f` has no answer. For readers that must not read the file just to find out that nothing was changed.
    pub(super) fn peek<T>(
        &self,
        id: DocumentId,
        f: impl FnOnce(&DocState) -> Option<T>,
    ) -> Option<T> {
        self.lock().docs.get(&id).and_then(f)
    }

    /// Forgets the model of a document that is closed, and refuses it from now on.
    pub fn remove(&self, id: DocumentId) {
        let mut models = self.lock();
        models.docs.remove(&id);
        models.closed.insert(id);
    }

    /// Whether document `id` has changes that are not saved. A document without a model has none.
    pub fn is_dirty(&self, id: DocumentId) -> bool {
        self.lock().docs.get(&id).is_some_and(DocState::is_dirty)
    }

    /// How many documents have a model.
    pub fn len(&self) -> usize {
        self.lock().docs.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// The stamp for a command that runs now.
    fn stamp(&self) -> Stamp {
        let now_ms = u64::try_from(self.started.elapsed().as_millis()).unwrap_or(u64::MAX);
        let secs = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |since| since.as_secs());
        Stamp {
            now_ms,
            modified: iso8601_utc(secs),
        }
    }
}

/// `secs` since the Unix epoch as `YYYY-MM-DDTHH:MM:SSZ` (the proleptic Gregorian calendar, UTC).
pub fn iso8601_utc(secs: u64) -> String {
    let days = i64::try_from(secs / 86_400).unwrap_or(i64::MAX / 2);
    let rest = secs % 86_400;
    // Days since 0000-03-01, then era, year of era, day of year (Howard Hinnant's civil_from_days).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let day_of_era = z.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let shifted_month = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * shifted_month + 2) / 5 + 1;
    let month = if shifted_month < 10 {
        shifted_month + 3
    } else {
        shifted_month - 9
    };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rest / 3_600,
        rest % 3_600 / 60,
        rest % 60
    )
}

/// How to take a step back when the engine could not follow it (see `AppState::change_and_sync`).
#[derive(Debug, Clone, Copy)]
pub(super) enum Revert {
    /// The step was a new command or a redo: undo it.
    Undo,
    /// The step was an undo: redo it.
    Redo,
}

impl AppState {
    /// Runs `f` on the model of document `id`, which is made from the pages the engine read if it has none yet.
    pub(crate) fn model<T>(
        &self,
        id: DocumentId,
        f: impl FnOnce(&mut DocState) -> Result<T, AppError>,
    ) -> Result<T, AppError> {
        let count = self.registry.page_count(id)?;
        self.annotations
            .with_init(id, || self.initial_model(id, count), f)
    }

    /// The model of a document that was just opened: the size and rotation the engine read for each of its `count` pages.
    fn initial_model(&self, id: DocumentId, count: u32) -> DocState {
        let sizes = self.engine.page_sizes(id).ok();
        let rotations = self.engine.page_rotations(id).ok();
        let pages = (0..usize::try_from(count).unwrap_or(0))
            .map(|index| {
                let rotation = rotations
                    .as_ref()
                    .and_then(|rotations| rotations.get(index))
                    .copied()
                    .unwrap_or(0);
                let drawn = sizes
                    .as_ref()
                    .and_then(|sizes| sizes.get(index))
                    .copied()
                    .unwrap_or(limits::DEFAULT_PAGE_SIZE_PT);
                (unrotated(drawn, rotation), rotation)
            })
            .collect();
        let mut state = DocState::from_file(pages);
        if let Ok(boxes) = self.engine.page_boxes(id) {
            state.set_boxes(&boxes);
        }
        state
    }

    /// The annotations of a page, by id. The first call for a page reads them from the file; later calls answer from the model, which
    /// by then is the truth (it has the session's changes). `invalid_argument` (`page`) for a page the document does not have,
    /// `not_found` for a document that is not open.
    pub fn list_annotations(
        &self,
        id: DocumentId,
        page: PageId,
    ) -> Result<Vec<Annotation>, AppError> {
        let page_index = self.registry.page_index(id, page)?;
        if !self.model(id, |state| Ok(state.is_imported(page)))? {
            // Not under the lock: a read of a page takes the worker's time, and the model must stay available meanwhile. Two
            // requests at once read twice; the model keeps the first answer (`DocState::import_page`).
            let items = self.engine.import_annotations(id, page_index)?;
            self.import_read(id, page, page_index, items)?;
        }
        self.model(id, |state| Ok(state.list(page)))
    }

    /// Puts what the engine read of page `page` (at `page_index` of the file) into the model, with the lines, the review links and the
    /// Sheer keys the file has for it. A page whose keys could not be read in time is not imported (`engine_timeout`: ask again), so
    /// the model never rewrites an annotation without the keys it has in the file.
    pub(super) fn import_read(
        &self,
        id: DocumentId,
        page: PageId,
        page_index: u32,
        items: Vec<crate::model::annotation::Imported>,
    ) -> Result<(), AppError> {
        let keys = self.sheer_keys(id, page_index, &items)?;
        self.import_with_keys(id, page, page_index, items, keys)
    }

    /// [`AppState::import_read`] for a page of a list that read the keys of all its unread pages at once (`prefetch_keys`).
    pub(super) fn import_read_prefetched(
        &self,
        id: DocumentId,
        page: PageId,
        page_index: u32,
        items: Vec<crate::model::annotation::Imported>,
        prefetched: &Option<KeysByPage>,
    ) -> Result<(), AppError> {
        let keys = prefetched
            .as_ref()
            .map(|all| all.get(&page_index).cloned().unwrap_or_default());
        self.import_with_keys(id, page, page_index, items, keys)
    }

    fn import_with_keys(
        &self,
        id: DocumentId,
        page: PageId,
        page_index: u32,
        items: Vec<crate::model::annotation::Imported>,
        keys: Option<HashMap<u32, SheerKeys>>,
    ) -> Result<(), AppError> {
        let mut items = items;
        let links = self.lift_foreign(id, page_index, &mut items);
        self.model(id, |state| {
            if !state.is_imported(page) {
                state.import_page_linked(page, &items, &links);
                state.apply_sheer_keys(page, keys.as_ref());
            }
            Ok(())
        })
    }

    /// The engine indices of the pages of `order` the model has not read yet.
    pub(super) fn unread_pages(
        &self,
        id: DocumentId,
        order: &[(PageId, u32)],
    ) -> Result<Vec<u32>, AppError> {
        self.model(id, |state| {
            Ok(order
                .iter()
                .filter(|(page, _)| !state.is_imported(*page))
                .map(|(_, index)| *index)
                .collect())
        })
    }

    /// The Sheer keys of the pages `unread` of the file in one pass (one parse), for the lists that read every page: `None` when they
    /// cannot be read (an encrypted document, a file that cannot be parsed again), `engine_timeout` when the read takes too long.
    pub(super) fn prefetch_keys(
        &self,
        id: DocumentId,
        unread: &[u32],
    ) -> Result<Option<KeysByPage>, AppError> {
        if unread.is_empty() {
            return Ok(Some(HashMap::new()));
        }
        let readable = self.info(id).is_some_and(|info| !info.flags.encrypted);
        let Some(path) = self.registry.path(id).filter(|_| readable) else {
            return Ok(None);
        };
        read_keys_file(path, unread.to_vec())
    }

    /// The citation records and tags the file has for the annotations of a page (see `pdfwrite::sheer_keys`). Only a page with an
    /// annotation the model can tag is looked at (the others have none); `None` for an encrypted document or a file that cannot be
    /// parsed again: their keys are unknown, and a save leaves the ones the file has. A read that takes too long is `engine_timeout`.
    fn sheer_keys(
        &self,
        id: DocumentId,
        page_index: u32,
        items: &[crate::model::annotation::Imported],
    ) -> Result<Option<HashMap<u32, SheerKeys>>, AppError> {
        let taggable = items
            .iter()
            .any(|item| !matches!(item.body, AnnotationBody::Opaque { .. }));
        if !taggable {
            return Ok(Some(HashMap::new()));
        }
        Ok(self
            .prefetch_keys(id, &[page_index])?
            .map(|mut all| all.remove(&page_index).unwrap_or_default()))
    }

    /// Reads what other programs wrote into the annotations of a page and PDFium does not report (`pdfwrite::foreign`), lifts it onto
    /// the imported annotations (text from `/RC`, dates, opacity, icons, shapes, strokes, lines, ...) and answers the reply links and
    /// review states. A page without annotations, an encrypted document, a file that cannot be read again or one that takes too long has
    /// none of it: its comments are then listed as PDFium reports them, without threads.
    fn lift_foreign(
        &self,
        id: DocumentId,
        page_index: u32,
        items: &mut [crate::model::annotation::Imported],
    ) -> HashMap<u32, ReviewLink> {
        let readable = self.info(id).is_some_and(|info| !info.flags.encrypted);
        if items.is_empty() || !readable {
            return HashMap::new();
        }
        let Some(path) = self.registry.path(id) else {
            return HashMap::new();
        };
        let found: HashMap<u32, ForeignRead> =
            read_page_file(path, page_index, foreign::read_page).unwrap_or_default();
        for item in items.iter_mut() {
            if let Some(read) = found.get(&item.origin.annot_index) {
                foreign::lift(item, read);
            }
        }
        found
            .into_iter()
            .filter(|(_, read)| read.link != ReviewLink::default())
            .map(|(position, read)| (position, read.link))
            .collect()
    }

    /// What the reading of the file's annotations left out so far (a page, the document or the string budget was full). The pages
    /// concerned are those read already; the annotations stay in the file.
    pub fn import_warnings(
        &self,
        id: DocumentId,
    ) -> Result<Vec<crate::model::doc_state::ImportWarning>, AppError> {
        self.model(id, |state| Ok(state.import_warnings()))
    }

    /// The annotations of every page as summaries, by page and id (at most `MAX_ANNOTATIONS_PER_DOC`). Pages not read yet are read
    /// from the file one by one at `Background` priority, so a render or a page the user asked for goes first. A failed read fails
    /// the call (`engine_timeout` when the engine was busy: ask again; the pages read stay read).
    pub fn list_document_annotations(
        &self,
        id: DocumentId,
    ) -> Result<Vec<AnnotationSummary>, AppError> {
        let mut summaries = Vec::new();
        let order = self.registry.page_order(id)?;
        let unread = self.unread_pages(id, &order)?;
        let keys = self.prefetch_keys(id, &unread)?;
        for (page, index) in order {
            if !self.model(id, |state| Ok(state.is_imported(page)))? {
                let items = self.engine.import_annotations_background(id, index)?;
                self.import_read_prefetched(id, page, index, items, &keys)?;
            }
            let listed = self.model(id, |state| Ok(state.list(page)))?;
            let room = limits::MAX_ANNOTATIONS_PER_DOC.saturating_sub(summaries.len());
            // Text boxes, images and redaction marks are page content or model-only objects, not comments: not listed.
            summaries.extend(
                listed
                    .iter()
                    .filter(|a| a.body.is_written_as_annotation())
                    .take(room)
                    .map(AnnotationSummary::of),
            );
        }
        Ok(summaries)
    }

    /// The text under a text markup (highlight, underline, strikeout), for the quote of a comment card: the characters of the page whose
    /// centre is inside one of the markup's quads, in reading order, whitespace collapsed, at most [`CARD_QUOTE_MAX`] characters.
    /// `None` for another kind of annotation or a page without text there. `not_found` for an annotation the document does not have.
    pub fn annotation_quote(
        &self,
        id: DocumentId,
        annotation: AnnotId,
    ) -> Result<Option<String>, AppError> {
        let found = self.model(id, |state| Ok(state.annotation(annotation).cloned()))?;
        let found = found.ok_or(AppError::not_found("annotation"))?;
        // A citation answers the quote it stores (the user may have edited it), cut to the card's length.
        if let Some(cite) = &found.cite {
            let mut quote: String = cite.quote.chars().take(CARD_QUOTE_MAX).collect();
            if cite.quote.chars().count() > CARD_QUOTE_MAX {
                quote.pop();
                quote.push('…');
            }
            return Ok(Some(quote));
        }
        let (AnnotationBody::Highlight { quads }
        | AnnotationBody::Underline { quads }
        | AnnotationBody::Strikeout { quads }) = &found.body
        else {
            return Ok(None);
        };
        let layer = self.text_layer(id, found.page_id)?;
        let quote = quote_of(&layer.text, &layer.boxes, quads, CARD_QUOTE_MAX);
        Ok((!quote.is_empty()).then_some(quote))
    }

    /// Runs `step` on the model of `id`, then makes PDFium's copy match: the originals the model changed or deleted are hidden in the
    /// engine's copy, the ones that are `Clean` again (undo) shown, and the pages that were turned get their new rotation. The
    /// frontend re-renders the page on the change set (`pageRev`). A failure to hide or show is not the command's (the page then keeps
    /// showing the original under the overlay until the next change); a failure to turn a page is: the step is taken back (`revert`)
    /// and the error is the answer.
    pub(super) fn change_and_sync(
        &self,
        id: DocumentId,
        revert: Revert,
        step: impl FnOnce(&mut DocState, &Stamp) -> Result<ChangeSet, AppError>,
    ) -> Result<ChangeSet, AppError> {
        let stamp = self.annotations.stamp();
        let (changes, before, after) = self.model(id, |state| {
            let before = state.hidden_origins();
            let changes = step(state, &stamp)?;
            if changes.pages.is_some() {
                self.registry.set_pages(
                    id,
                    state
                        .pages()
                        .iter()
                        .map(|slot| (slot.id, slot.engine_index)),
                );
            }
            Ok((changes, before, state.hidden_origins()))
        })?;
        // The rotations and crops are mirrored in the engine's copy; a failure of either takes the step back.
        let mirrored = if changes.engine_rotations.is_empty() {
            Ok(())
        } else {
            self.engine
                .set_page_rotations(id, changes.engine_rotations.clone())
        }
        .and_then(|()| {
            changes
                .engine_crops
                .iter()
                .try_for_each(|(index, crop)| self.engine.set_crop_box(id, *index, *crop))
        });
        if let Err(error) = mirrored {
            let boxes = self.model(id, |state| {
                let _ = match revert {
                    Revert::Undo => state.undo(&stamp),
                    Revert::Redo => state.redo(&stamp),
                };
                self.registry.set_pages(
                    id,
                    state
                        .pages()
                        .iter()
                        .map(|slot| (slot.id, slot.engine_index)),
                );
                Ok(state.crop_mirror(changes.engine_crops.iter().map(|(index, _)| *index)))
            })?;
            // Best effort: the engine's copy goes back to the boxes of the model.
            for (index, crop) in boxes {
                let _ = self.engine.set_crop_box(id, index, crop);
            }
            return Err(error);
        }
        let hide: Vec<(u32, u32)> = after.difference(&before).copied().collect();
        let show: Vec<(u32, u32)> = before.difference(&after).copied().collect();
        if !hide.is_empty() || !show.is_empty() {
            let _ = self.engine.set_annotations_hidden(id, hide, show);
        }
        Ok(changes)
    }

    /// Takes back the last step; an empty change set if there is none.
    pub fn undo(&self, id: DocumentId) -> Result<ChangeSet, AppError> {
        self.change_and_sync(id, Revert::Redo, DocState::undo)
    }

    /// Does the last undone step again; an empty change set if there is none.
    pub fn redo(&self, id: DocumentId) -> Result<ChangeSet, AppError> {
        self.change_and_sync(id, Revert::Undo, DocState::redo)
    }
}

/// The annotations of a page.
#[tauri::command]
pub async fn list_annotations(
    state: State<'_, AppState>,
    doc_id: DocumentId,
    page_id: PageId,
) -> Result<Vec<Annotation>, UiError> {
    let state = state.inner().clone();
    blocking(move || state.list_annotations(doc_id, page_id)).await
}

/// The annotations of all pages of a document as summaries, for the comments panel.
#[tauri::command]
pub async fn list_document_annotations(
    state: State<'_, AppState>,
    doc_id: DocumentId,
) -> Result<Vec<AnnotationSummary>, UiError> {
    let state = state.inner().clone();
    blocking(move || state.list_document_annotations(doc_id)).await
}

/// The text under a text markup, for the quote of its card in the comments panel (`null` for another kind or no text).
#[tauri::command]
pub async fn get_annotation_quote(
    state: State<'_, AppState>,
    doc_id: DocumentId,
    annotation_id: AnnotId,
) -> Result<Option<String>, UiError> {
    let state = state.inner().clone();
    blocking(move || state.annotation_quote(doc_id, annotation_id)).await
}

/// What the reading of a document's annotations left out so far (`PageTruncated`), for a note in the UI.
#[tauri::command]
pub async fn import_warnings(
    state: State<'_, AppState>,
    doc_id: DocumentId,
) -> Result<Vec<crate::model::doc_state::ImportWarning>, UiError> {
    let state = state.inner().clone();
    blocking(move || state.import_warnings(doc_id)).await
}

/// Takes back the last step of a document's history.
#[tauri::command]
pub async fn undo(state: State<'_, AppState>, doc_id: DocumentId) -> Result<ChangeSet, UiError> {
    let state = state.inner().clone();
    blocking(move || state.undo(doc_id)).await
}

impl AppState {
    /// The steps of the document's undo history (oldest first) and how many are applied, for the history panel. Read only; at most
    /// `MAX_HISTORY_ENTRIES` entries.
    pub fn get_history(&self, id: DocumentId) -> Result<HistoryList, AppError> {
        self.model(id, |state| Ok(state.history_list()))
    }
}

/// The undo history of a document as a list: `{ entries: [{ id, labelKey, kind, page, annotationId, annotationKind, isTextEdit }], cursor }`.
#[tauri::command]
pub async fn get_history(
    state: State<'_, AppState>,
    doc_id: DocumentId,
) -> Result<HistoryList, UiError> {
    let state = state.inner().clone();
    blocking(move || state.get_history(doc_id)).await
}

/// Does the last undone step of a document's history again.
#[tauri::command]
pub async fn redo(state: State<'_, AppState>, doc_id: DocumentId) -> Result<ChangeSet, UiError> {
    let state = state.inner().clone();
    blocking(move || state.redo(doc_id)).await
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use serde_json::json;

    use super::*;
    use crate::commands::testutil::state_with_pages;
    use crate::engine::Job;
    use crate::error::ErrorCode;
    use crate::model::annotation::{AnnotationBody, Imported, PdfOrigin, Rgb, Sync};
    use crate::model::command::DocCommand;
    use crate::model::geometry::Rect;

    fn imported(subtype: &str) -> Imported {
        Imported {
            origin: PdfOrigin {
                page_index: 0,
                annot_index: 0,
                name: None,
            },
            body: AnnotationBody::Opaque {
                subtype: subtype.to_owned(),
            },
            rect: Rect {
                x: 1.0,
                y: 2.0,
                w: 3.0,
                h: 4.0,
            },
            color: Rgb([0, 0, 0]),
            opacity: 1.0,
            contents: String::new(),
            author: None,
            modified: None,
            locked: false,
            hidden: false,
        }
    }

    /// A state whose engine "imports" `items` for every page and counts how often it was asked (the pages it was asked for).
    fn state_with_import(
        pages: u32,
        items: Vec<Imported>,
    ) -> (AppState, DocumentId, Arc<Mutex<Vec<u32>>>) {
        let asked = Arc::new(Mutex::new(Vec::new()));
        let log = Arc::clone(&asked);
        let (state, id) = state_with_pages(pages, move |job| {
            if let Job::ImportAnnotations {
                page_index, reply, ..
            } = job
            {
                log.lock().unwrap().push(page_index);
                let _ = reply.send(Ok(items.clone()));
            } else if let Job::Close { reply, .. } = job {
                let _ = reply.send(Ok(()));
            }
        });
        (state, id, asked)
    }

    fn command(value: serde_json::Value) -> DocCommand {
        serde_json::from_value(value).unwrap()
    }

    fn create(page: u32) -> DocCommand {
        command(json!({"type": "createAnnotation", "draft": {
            "pageId": page, "kind": "note", "color": [255, 235, 0],
            "at": {"x": 10.0, "y": 10.0}, "icon": "comment", "contents": "hi"
        }}))
    }

    #[test]
    fn the_first_list_of_a_page_reads_the_file_and_later_ones_answer_from_the_model() {
        let (state, id, asked) = state_with_import(3, vec![imported("Ink"), imported("Stamp")]);
        let first = state.list_annotations(id, PageId::new(1)).unwrap();
        assert_eq!(first.len(), 2);
        assert!(first
            .iter()
            .all(|a| a.page_id == PageId::new(1) && a.sync == Sync::Clean));
        assert!(first[0].id < first[1].id);
        assert_eq!(state.list_annotations(id, PageId::new(1)).unwrap(), first);
        assert_eq!(*asked.lock().unwrap(), [1]);
        // Another page is read on its own.
        state.list_annotations(id, PageId::new(0)).unwrap();
        assert_eq!(*asked.lock().unwrap(), [1, 0]);
    }

    #[test]
    fn the_document_list_reads_every_page_once_and_summarizes_without_geometry() {
        let mut note = imported("x");
        note.body = AnnotationBody::Note {
            at: crate::model::geometry::Point { x: 5.0, y: 5.0 },
            icon: crate::model::annotation::NoteIcon::Note,
        };
        note.contents = "x".repeat(SUMMARY_EXCERPT_CHARS + 50);
        note.author = Some("Ann".to_owned());
        let (state, id, asked) = state_with_import(3, vec![note]);
        let all = state.list_document_annotations(id).unwrap();
        assert_eq!(all.len(), 3);
        assert_eq!(
            all.iter().map(|s| s.page_id.get()).collect::<Vec<_>>(),
            [0, 1, 2]
        );
        assert_eq!(all[0].kind, "note");
        assert_eq!(all[0].contents.chars().count(), SUMMARY_EXCERPT_CHARS);
        assert_eq!(all[0].author.as_deref(), Some("Ann"));
        let value = serde_json::to_value(&all[0]).unwrap();
        assert!(
            value.get("rect").is_none() && value["pageId"] == 0 && value["inReplyTo"].is_null()
        );
        // A second call and a page list answer from the model.
        assert_eq!(state.list_document_annotations(id).unwrap(), all);
        state.list_annotations(id, PageId::new(1)).unwrap();
        assert_eq!(*asked.lock().unwrap(), [0, 1, 2]);
        let unknown: DocumentId = serde_json::from_str("999").unwrap();
        assert_eq!(
            state.list_document_annotations(unknown).unwrap_err().code(),
            ErrorCode::NotFound
        );
    }

    #[test]
    fn the_document_list_has_marks_and_signatures_but_no_text_boxes_images_or_redaction_marks() {
        let (state, id, _) = state_with_import(1, vec![]);
        let page = |kind: serde_json::Value| {
            let mut draft = json!({"pageId": 0, "color": [10, 20, 30]});
            for (key, value) in kind.as_object().unwrap() {
                draft[key] = value.clone();
            }
            state
                .apply_command(
                    id,
                    command(json!({"type": "createAnnotation", "draft": draft})),
                )
                .unwrap();
        };
        let b = json!({"x": 10.0, "y": 10.0, "w": 40.0, "h": 40.0});
        page(json!({"kind": "mark", "box": b, "glyph": "check"}));
        page(json!({"kind": "note", "at": {"x": 5.0, "y": 5.0}, "icon": "note", "contents": "hi"}));
        page(
            json!({"kind": "textBox", "box": b, "text": "page text", "font": "sans", "fontSize": 12.0, "align": "left"}),
        );
        let kinds: Vec<_> = state
            .list_document_annotations(id)
            .unwrap()
            .iter()
            .map(|s| s.kind)
            .collect();
        assert_eq!(kinds, ["mark", "note"]);
    }
    #[test]
    fn a_page_or_document_that_does_not_exist_is_refused_before_the_engine_is_asked() {
        let (state, id, asked) = state_with_import(2, vec![imported("Ink")]);
        assert_eq!(
            state
                .list_annotations(id, PageId::new(2))
                .unwrap_err()
                .code(),
            ErrorCode::InvalidArgument
        );
        let unknown: DocumentId = serde_json::from_str("999").unwrap();
        assert_eq!(
            state
                .list_annotations(unknown, PageId::new(0))
                .unwrap_err()
                .code(),
            ErrorCode::NotFound
        );
        assert_eq!(
            state.apply_command(unknown, create(0)).unwrap_err().code(),
            ErrorCode::NotFound
        );
        assert_eq!(state.undo(unknown).unwrap_err().code(), ErrorCode::NotFound);
        assert_eq!(state.redo(unknown).unwrap_err().code(), ErrorCode::NotFound);
        assert!(asked.lock().unwrap().is_empty());
        assert!(
            state.annotations.is_empty(),
            "no model for a document that is not open"
        );
    }

    #[test]
    fn a_failed_read_imports_nothing_and_the_next_list_tries_again() {
        let fail = Arc::new(Mutex::new(true));
        let switch = Arc::clone(&fail);
        let (state, id) = state_with_pages(1, move |job| {
            if let Job::ImportAnnotations { reply, .. } = job {
                let _ = reply.send(if *switch.lock().unwrap() {
                    Err(AppError::new(ErrorCode::EngineTimeout))
                } else {
                    Ok(vec![imported("Ink")])
                });
            }
        });
        assert_eq!(
            state
                .list_annotations(id, PageId::new(0))
                .unwrap_err()
                .code(),
            ErrorCode::EngineTimeout
        );
        *fail.lock().unwrap() = false;
        assert_eq!(state.list_annotations(id, PageId::new(0)).unwrap().len(), 1);
    }

    #[test]
    fn commands_undo_and_redo_go_through_the_model_and_a_list_shows_the_result() {
        let (state, id, _) = state_with_import(2, vec![]);
        let created = state.apply_command(id, create(1)).unwrap();
        assert_eq!(created.rev, 1);
        let note = created.upserted[0].clone();
        assert_eq!(note.page_id, PageId::new(1));
        assert_eq!(note.rect.w, 20.0);
        assert!(note
            .modified
            .as_deref()
            .is_some_and(|m| m.ends_with('Z') && m.len() == 20));
        assert_eq!(
            state.list_annotations(id, PageId::new(1)).unwrap(),
            std::slice::from_ref(&note)
        );

        let undone = state.undo(id).unwrap();
        assert_eq!(undone.removed, [note.id]);
        assert!(state
            .list_annotations(id, PageId::new(1))
            .unwrap()
            .is_empty());
        let redone = state.redo(id).unwrap();
        assert_eq!(redone.upserted, [note]);
        assert_eq!(redone.rev, 3);
        // Nothing more to redo: an empty change set, the same revision.
        let none = state.redo(id).unwrap();
        assert!(none.upserted.is_empty() && none.removed.is_empty());
        assert_eq!(none.rev, 3);
    }

    #[test]
    fn a_command_for_a_page_the_document_does_not_have_changes_nothing() {
        let (state, id, _) = state_with_import(2, vec![]);
        assert_eq!(
            state.apply_command(id, create(2)).unwrap_err().code(),
            ErrorCode::InvalidArgument
        );
        assert_eq!(state.undo(id).unwrap().rev, 0);
    }

    #[test]
    fn imported_annotations_can_be_deleted_by_a_command_after_the_page_was_listed() {
        let mut deletable = imported("x");
        deletable.body = AnnotationBody::Note {
            at: crate::model::geometry::Point { x: 5.0, y: 5.0 },
            icon: crate::model::annotation::NoteIcon::Note,
        };
        let (state, id, _) = state_with_import(1, vec![deletable, imported("Ink")]);
        let listed = state.list_annotations(id, PageId::new(0)).unwrap();
        let removed = state
            .apply_command(
                id,
                command(json!({"type": "deleteAnnotations", "ids": [listed[0].id]})),
            )
            .unwrap();
        assert_eq!(removed.removed, [listed[0].id]);
        assert!(removed.history.dirty);
        // The opaque one cannot be touched.
        let refused = state.apply_command(
            id,
            command(json!({"type": "deleteAnnotations", "ids": [listed[1].id]})),
        );
        assert_eq!(refused.unwrap_err().code(), ErrorCode::InvalidArgument);
    }

    #[test]
    fn closing_a_document_drops_its_model() {
        let (state, id, _) = state_with_import(1, vec![]);
        state.apply_command(id, create(0)).unwrap();
        assert_eq!(state.annotations.len(), 1);
        state.close_document(id).unwrap();
        assert!(state.annotations.is_empty());
    }

    #[test]
    fn the_stamp_date_is_iso_8601_in_utc() {
        assert_eq!(iso8601_utc(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso8601_utc(951_782_400), "2000-02-29T00:00:00Z");
        assert_eq!(iso8601_utc(1_700_000_000), "2023-11-14T22:13:20Z");
        assert_eq!(iso8601_utc(4_102_444_799), "2099-12-31T23:59:59Z");
        assert!(iso8601_utc(u64::MAX).len() > 10);
    }

    #[test]
    fn the_wire_shape_of_the_commands_and_the_answer_is_what_the_frontend_parses() {
        let (state, id, _) = state_with_import(1, vec![]);
        let changes = state.apply_command(id, create(0)).unwrap();
        let value = serde_json::to_value(&changes).unwrap();
        assert_eq!(value["rev"], 1);
        assert_eq!(value["pages"], serde_json::Value::Null);
        assert_eq!(value["removed"], json!([]));
        assert_eq!(value["upserted"][0]["kind"], "note");
        assert_eq!(value["upserted"][0]["pageId"], 0);
        assert_eq!(
            value["history"],
            json!({"canUndo": true, "canRedo": false, "undoLabel": "annotation.create", "redoLabel": null, "dirty": true})
        );
    }

    #[test]
    fn a_closed_document_gets_no_model_again() {
        let store = AnnotationStore::default();
        let id: DocumentId = serde_json::from_str("7").unwrap();
        store.with(id, 1, |_| Ok(())).unwrap();
        assert_eq!(store.len(), 1);
        store.remove(id);
        assert_eq!(
            store.with(id, 1, |_| Ok(())).unwrap_err().code(),
            ErrorCode::NotFound
        );
        assert!(store.is_empty());
    }

    #[test]
    fn the_closed_ids_are_bounded_and_the_oldest_are_forgotten() {
        let mut closed = Remembered::default();
        let id = |n: usize| -> DocumentId { serde_json::from_str(&n.to_string()).unwrap() };
        for n in 0..REMEMBERED_IDS + 10 {
            closed.insert(id(n));
        }
        closed.insert(id(REMEMBERED_IDS + 9));
        assert_eq!(closed.len(), REMEMBERED_IDS);
        assert!(!closed.contains(&id(0)));
        assert!(closed.contains(&id(REMEMBERED_IDS + 9)));
    }

    #[test]
    fn a_poisoned_lock_drops_the_models_and_refuses_their_documents() {
        let store = Arc::new(AnnotationStore::default());
        let (a, b): (DocumentId, DocumentId) = (
            serde_json::from_str("1").unwrap(),
            serde_json::from_str("2").unwrap(),
        );
        store.with(a, 1, |_| Ok(())).unwrap();
        let thief = Arc::clone(&store);
        let crashed = std::thread::spawn(move || {
            let _ = thief.with(a, 1, |_| -> Result<(), AppError> { panic!("in the model") });
        })
        .join();
        assert!(crashed.is_err());
        let refused = store.with(a, 1, |_| Ok(())).unwrap_err();
        assert_eq!(refused.code(), ErrorCode::NotFound);
        // The UI can say why: `error.not_found.annotation_state`.
        let wire = serde_json::to_value(crate::error::UiError::from(refused)).unwrap();
        assert_eq!(wire["params"]["what"], "annotation_state");
        assert!(!store.is_dirty(a));
        // Another document works again.
        store.with(b, 1, |_| Ok(())).unwrap();
        assert_eq!(store.len(), 1);
    }
    #[test]
    fn a_summary_says_what_a_mark_and_a_signature_are_and_the_state_of_a_review_reply() {
        use crate::model::annotation::{MarkGlyph, ReviewState};
        let mut a = Annotation::from_draft(
            crate::model::ids::AnnotId::new(1),
            &serde_json::from_value(json!({"pageId": 0, "kind": "mark", "color": [0, 0, 0], "box": {"x": 0.0, "y": 0.0, "w": 10.0, "h": 10.0}, "glyph": "cross"})).unwrap(),
            "t",
        )
        .unwrap();
        assert!(matches!(
            a.body,
            AnnotationBody::Mark {
                glyph: MarkGlyph::Cross,
                ..
            }
        ));
        let summary = AnnotationSummary::of(&a);
        assert_eq!(summary.detail, Some("cross"));
        assert_eq!(serde_json::to_value(&summary).unwrap().get("state"), None);
        a.state = Some(ReviewState::Accepted);
        let value = serde_json::to_value(AnnotationSummary::of(&a)).unwrap();
        assert_eq!(value["state"], "accepted");
    }
}
