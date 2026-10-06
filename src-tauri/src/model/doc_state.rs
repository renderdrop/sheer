//! The editable state of one open document (ADR-003): its annotations, the revision counter and the history.
//!
//! The state is only ever changed through [`DocState::execute`], [`DocState::undo`] and [`DocState::redo`] (and filled by
//! [`DocState::import_page`] when a page is first looked at). Each returns a [`ChangeSet`], the delta the UI applies to its replica.
//! The state is plain data: no PDFium, no lopdf, no clock (the caller passes a [`Stamp`]), so all of it is tested without a PDF.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use serde::Serialize;

use super::annotation::{Annotation, AnnotationBody, Imported, PdfOrigin, Sync};
use super::command::{DocCommand, LABEL_PROTECT_REMOVE};
use super::form::{FieldId, FieldState, FieldUndo, FieldValue, FormInfo, FormModel, ReadForm};
use super::history::{History, HistoryState};
use super::ids::AnnotId;
use super::metadata::MetadataState;
use super::page::{PageSlot, PageSlotInfo, PageSource};
use crate::documents::PageId;
use crate::error::AppError;
use crate::limits;
use crate::pdfwrite::reviews::ReviewLink;
use crate::pdfwrite::sheer_keys::SheerKeys;
use crate::security::secret::{PendingProtection, SecretSlots, Ticket};

/// What a command needs to know about the moment it runs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Stamp {
    /// Milliseconds on a monotonic clock, for coalescing.
    pub now_ms: u64,
    /// The `modified` date given to what the command touches (ISO 8601, UTC).
    pub modified: String,
}

/// Something the import of a file's annotations could not do completely (never an error: the file is unchanged and still has them).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum ImportWarning {
    /// `skipped` annotations of `page` were not taken into the model: the page, the document or the string budget was full. They
    /// stay in the file as they are (drawn by PDFium, kept on save) but cannot be edited here.
    PageTruncated { page: u32, skipped: u32 },
}

/// A part of the document that is not an annotation, page or field, and that a command changed (ADR-047): the UI reads it again with
/// `get_metadata` or `get_protection`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DocPart {
    Metadata,
    Protection,
    /// The bibliographic record (ADR-119): the UI re-reads `get_bibliography`.
    Bibliography,
}

/// An annotation in the state, with what only Rust knows about it.
#[derive(Debug, Clone, PartialEq)]
pub struct Entry {
    pub annotation: Annotation,
    /// Where it is in the file it was imported from; `None` for one created in this session.
    pub persisted: Option<PdfOrigin>,
    /// Deleted in this session but in the file: kept, so that saving removes it from the file and undo brings it back.
    pub tombstone: bool,
}

/// The content of one id: `None` is no entry at all. The universal exact inverse of any change is a list of these.
pub type Slot = (AnnotId, Option<Entry>);

/// What a command changed, for the UI replica.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct Delta {
    pub upserted: BTreeMap<AnnotId, Annotation>,
    pub removed: BTreeSet<AnnotId>,
    /// The list of pages changed (order, members or a page's look).
    pub pages: bool,
    /// Engine pages that must be turned to this rotation (`(engine index, degrees)`) for the engine's copy to match.
    pub engine_rotations: Vec<(u32, u16)>,
    /// Engine pages whose CropBox must be set (`(engine index, [x0, y0, x1, y1])`) for the engine's copy to match.
    pub engine_crops: Vec<(u32, [f32; 4])>,
    /// Form fields whose value changed.
    pub fields: BTreeSet<FieldId>,
    /// Metadata or protection changed.
    pub doc: BTreeSet<DocPart>,
}

impl Delta {
    pub fn upsert(&mut self, annotation: Annotation) {
        self.removed.remove(&annotation.id);
        self.upserted.insert(annotation.id, annotation);
    }

    pub fn remove(&mut self, id: AnnotId) {
        self.upserted.remove(&id);
        self.removed.insert(id);
    }

    pub fn merge(&mut self, other: Delta) {
        self.pages |= other.pages;
        self.engine_rotations.extend(other.engine_rotations);
        self.engine_crops.extend(other.engine_crops);
        self.fields.extend(other.fields);
        self.doc.extend(other.doc);
        for annotation in other.upserted.into_values() {
            self.upsert(annotation);
        }
        for id in other.removed {
            self.remove(id);
        }
    }
}

/// The answer to every command, undo and redo (ADR-003 §8).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeSet {
    /// The revision of the document after the change. It grows with every change, undo and redo.
    pub rev: u64,
    pub upserted: Vec<Annotation>,
    pub removed: Vec<AnnotId>,
    /// The full page list, only when it changed (ADR-036 §7); `null` otherwise.
    pub pages: Option<Vec<PageSlotInfo>>,
    /// Not sent: the rotations the engine's copy has to be given (`commands` does it before it answers).
    #[serde(skip)]
    pub engine_rotations: Vec<(u32, u16)>,
    /// Not sent: the CropBoxes the engine's copy has to be given, `(engine index, [x0, y0, x1, y1])` (ADR-047 §2).
    #[serde(skip)]
    pub engine_crops: Vec<(u32, [f32; 4])>,
    /// The form fields whose value changed (empty when none did), ADR-041.
    pub fields: Vec<FieldState>,
    /// What else changed: the UI re-reads `get_metadata` and `get_protection` (ADR-047).
    pub doc: Vec<DocPart>,
    /// Notes of the change (`textOverflow`, `fontFallback`, ADR-125); empty when there are none.
    pub warnings: Vec<crate::model::text_edit::ChangeWarning>,
    pub history: HistoryState,
}

#[derive(Debug)]
pub struct DocState {
    /// The pages in their order (ADR-036 §1).
    pub(super) pages: Vec<PageSlot>,
    /// The id the next new page gets; never goes back.
    pub(super) next_page_id: u32,
    /// How many pages the file has now (set when the document is opened and by every save).
    pub(super) file_pages: u32,
    pub(super) entries: BTreeMap<AnnotId, Entry>,
    next_id: u32,
    pub(super) rev: u64,
    pub(super) history: History,
    /// The pages whose annotations were read from the file.
    pub(super) imported: HashSet<u32>,
    /// Per page id, how many of the annotations read from the file did not fit (see [`ImportWarning`]).
    truncated: BTreeMap<u32, u32>,
    /// Where (page index, position) the file itself marks an annotation Hidden: PDFium keeps it hidden, so undo never shows it.
    file_hidden: BTreeSet<(u32, u32)>,
    /// Bytes of strings taken from the file so far (`limits::MAX_IMPORT_BYTES_PER_DOC`).
    imported_bytes: usize,
    /// Live (not deleted) entries in all and per page, kept by [`DocState::track`]; the limits are checked against these.
    pub(super) live_total: usize,
    pub(super) live_per_page: HashMap<u32, usize>,
    /// Live replies by the annotation they reply to.
    pub(super) replies: HashMap<AnnotId, BTreeSet<AnnotId>>,
    /// The form fields, once read from the file (`get_form_fields`, ADR-041).
    pub(super) form: Option<FormModel>,
    /// The signature art the document uses (ADR-041 §5, `use_signature`); dropped with the document.
    assets: crate::signatures::AssetStore,
    /// The passwords of staged protection changes, by ticket (ADR-047 §4); cleared on save and close, and when a step leaves the history.
    pub(super) secrets: SecretSlots,
    /// The staged protection change the next save writes (a ticket of `secrets`), if any; the history holds tickets only.
    pub(super) pending_protection: Option<Ticket>,
    /// The metadata as read from the file and as the session has it, and a staged removal (ADR-047 §5).
    pub(super) metadata: MetadataState,
    /// The page labels by file page index, once `Job::PageLabels` has run (ADR-119); `None` before. An entry is `None` for a page
    /// without a label.
    pub page_labels: Option<Vec<Option<String>>>,
    /// The bibliographic record the session has (ADR-119).
    pub bibliography: super::bibliography::BibliographyState,
    /// The pages (ids) read from the file whose Sheer keys could not be read (an encrypted file, a read that failed): their annotations
    /// keep the `/SHR_Cite` and `/SHR_Tags` the file has when they are saved (ADR-119).
    keys_unread: HashSet<u32>,
}

/// Bytes of the strings an imported annotation brings.
fn import_bytes(item: &Imported) -> usize {
    let lines = match &item.body {
        AnnotationBody::FreeText { lines, .. } => lines.iter().map(String::len).sum(),
        _ => 0,
    };
    item.contents.len()
        + lines
        + item.author.as_ref().map_or(0, String::len)
        + item.modified.as_ref().map_or(0, String::len)
        + item.origin.name.as_ref().map_or(0, String::len)
}

impl DocState {
    /// A state for a document of `page_count` pages whose size is not known (US Letter): tests, and documents the engine has no sizes for.
    pub fn new(page_count: u32) -> Self {
        Self::from_file(
            (0..page_count)
                .map(|_| (crate::limits::DEFAULT_PAGE_SIZE_PT, 0))
                .collect(),
        )
    }

    /// A state for a document just opened: one `(size before rotation, rotation)` per page of the file, in order. Page *i* gets id *i*.
    pub fn from_file(pages: Vec<([f32; 2], u16)>) -> Self {
        let count = u32::try_from(pages.len()).unwrap_or(u32::MAX);
        let slots = (0..count)
            .zip(pages)
            .map(|(index, (size, rotation))| PageSlot {
                id: PageId::new(index),
                source: PageSource::File { index },
                engine_index: index,
                rotation,
                saved_rotation: rotation,
                rev: 0,
                size,
                media: [0.0, 0.0, size[0], size[1]],
                crop: None,
                saved_crop: None,
            })
            .collect();
        Self {
            pages: slots,
            next_page_id: count,
            file_pages: count,
            entries: BTreeMap::new(),
            next_id: 1,
            rev: 0,
            history: History::new(),
            imported: HashSet::new(),
            truncated: BTreeMap::new(),
            imported_bytes: 0,
            file_hidden: BTreeSet::new(),
            live_total: 0,
            live_per_page: HashMap::new(),
            replies: HashMap::new(),
            form: None,
            assets: crate::signatures::AssetStore::default(),
            secrets: SecretSlots::default(),
            pending_protection: None,
            metadata: MetadataState::default(),
            page_labels: None,
            bibliography: super::bibliography::BibliographyState::default(),
            keys_unread: HashSet::new(),
        }
    }

    /// Updates the counters and the reply index for an entry that comes into (`add`) or leaves the state. Deleted entries are not in them.
    fn track(&mut self, entry: &Entry, add: bool) {
        if entry.tombstone {
            return;
        }
        let annotation = &entry.annotation;
        let page = self
            .live_per_page
            .entry(annotation.page_id.get())
            .or_insert(0);
        if add {
            *page += 1;
            self.live_total += 1;
        } else {
            *page = page.saturating_sub(1);
            self.live_total = self.live_total.saturating_sub(1);
        }
        if let Some(parent) = annotation.in_reply_to {
            if add {
                self.replies
                    .entry(parent)
                    .or_default()
                    .insert(annotation.id);
            } else if let Some(set) = self.replies.get_mut(&parent) {
                set.remove(&annotation.id);
                if set.is_empty() {
                    self.replies.remove(&parent);
                }
            }
        }
    }

    pub const fn rev(&self) -> u64 {
        self.rev
    }

    pub fn history_state(&self) -> HistoryState {
        self.history.state()
    }

    /// There are changes that are not saved.
    pub fn is_dirty(&self) -> bool {
        self.history.state().dirty
    }

    /// The document was saved: what it holds now is the clean state.
    pub fn mark_clean(&mut self) {
        self.history.mark_clean();
    }

    /// The state as a change set that changes nothing: the revision and the history now.
    pub fn current(&self) -> ChangeSet {
        self.change_set(Delta::default())
    }

    /// The document was written to a file (ADR-004 §1 step 8): `origins` says where each annotation that is in the file now is. What
    /// was deleted is gone for good, every annotation that was written is `clean`, and the history is dropped (see
    /// `History::clear`; ADR-033). The answer is the delta for the UI replica: the annotations whose `sync` changed, and a history that
    /// is empty and clean.
    pub fn finish_save(&mut self, origins: &HashMap<AnnotId, PdfOrigin>) -> ChangeSet {
        let mut delta = Delta::default();
        self.entries.retain(|_, entry| !entry.tombstone);
        // The text boxes and images were burned into the pages: they are page content now, no longer objects of the model (ADR-047 §1).
        let burned: Vec<Slot> = self
            .entries
            .iter()
            .filter(|(_, entry)| entry.annotation.body.is_content())
            .map(|(id, _)| (*id, None))
            .collect();
        self.set_slots(burned, &mut delta);
        // The pages are the file's pages now, in this order: page *i* of the list is page *i* of the file. Where an annotation that
        // was not written is in the file moves with its page.
        let mut moved: HashMap<u32, u32> = HashMap::new();
        // Pages that came from an import source: their annotations, if the model holds them, keep their ids.
        let mut brought: HashMap<u32, u32> = HashMap::new();
        let holding: HashSet<u32> = self
            .entries
            .values()
            .map(|entry| entry.annotation.page_id.get())
            .collect();
        for (position, slot) in self.pages.iter_mut().enumerate() {
            let position = u32::try_from(position).unwrap_or(u32::MAX);
            if matches!(slot.source, PageSource::File { .. }) {
                moved.insert(slot.engine_index, position);
            } else if holding.contains(&slot.id.get()) {
                brought.insert(slot.engine_index, position);
            } else {
                // A page of the file now: its annotations are read from the file like those of any page.
                self.imported.remove(&slot.id.get());
                self.keys_unread.remove(&slot.id.get());
            }
            slot.source = PageSource::File { index: position };
            slot.engine_index = position;
            slot.saved_rotation = slot.rotation;
            slot.saved_crop = slot.crop;
        }
        self.file_pages = self.page_count();
        // The positions in the file moved with the write (deleted and rewritten annotations): what was Hidden in the old file is not
        // known by position any more.
        self.file_hidden.clear();
        for entry in self.entries.values_mut() {
            if let Some(origin) = &mut entry.persisted {
                if let Some(position) = moved.get(&origin.page_index) {
                    origin.page_index = *position;
                } else if let Some(position) = brought.get(&origin.page_index) {
                    // Where it is in the saved page is known by its `/NM` only: the copy of the page may have dropped entries before it.
                    if origin.name.is_some() {
                        origin.page_index = *position;
                    } else {
                        entry.persisted = None;
                    }
                }
            }
        }
        delta.pages = true;
        for (id, entry) in &mut self.entries {
            if let Some(origin) = origins.get(id) {
                entry.persisted = Some(origin.clone());
                if entry.annotation.sync != Sync::Clean {
                    entry.annotation.sync = Sync::Clean;
                    delta.upsert(entry.annotation.clone());
                }
            }
        }
        if let Some(form) = &mut self.form {
            delta
                .fields
                .extend(form.changed().into_iter().map(|field| field.id));
            form.finish_save();
        }
        // What a save wrote of the protection and the metadata is the file's now; the passwords are dropped, the metadata is read again.
        self.secrets.clear();
        self.pending_protection = None;
        self.metadata = MetadataState::default();
        // The record a save wrote is in the file now (a removal of the metadata dropped it): it is read again.
        self.bibliography = super::bibliography::BibliographyState::default();
        // The labels were keyed by the old file's page indices (and a failed read was cached): the engine is asked again.
        self.page_labels = None;
        delta.doc.insert(DocPart::Bibliography);
        delta.doc.insert(DocPart::Metadata);
        delta.doc.insert(DocPart::Protection);
        self.history.clear();
        self.rev += 1;
        self.change_set(delta)
    }

    // --- Signature assets (ADR-041 §5) ---

    /// The art of the document's signatures.
    pub fn assets(&self) -> &crate::signatures::AssetStore {
        &self.assets
    }

    pub fn assets_mut(&mut self) -> &mut crate::signatures::AssetStore {
        &mut self.assets
    }

    // --- Protection and metadata (ADR-047 §4, §5) ---

    /// The passwords of the staged protection changes.
    pub fn secrets(&self) -> &SecretSlots {
        &self.secrets
    }

    pub fn secrets_mut(&mut self) -> &mut SecretSlots {
        &mut self.secrets
    }

    /// The staged protection change, as the secrets hold it.
    pub fn pending_protection(&self) -> Option<(Ticket, &PendingProtection)> {
        let ticket = self.pending_protection?;
        Some((ticket, self.secrets.get(ticket)?))
    }

    pub fn set_pending_protection(&mut self, ticket: Option<Ticket>) {
        self.pending_protection = ticket;
    }

    /// The metadata the model holds.
    pub fn metadata(&self) -> &MetadataState {
        &self.metadata
    }

    pub fn metadata_mut(&mut self) -> &mut MetadataState {
        &mut self.metadata
    }

    // --- The form (ADR-041) ---

    /// The form has not been read from the file yet, or has to be read again (after a save).
    pub fn form_needs_read(&self) -> bool {
        self.form.as_ref().is_none_or(FormModel::needs_reread)
    }

    /// Takes what was read from the file: the first time the whole model, later the file side of every field (ids stay).
    pub fn install_form(&mut self, read: ReadForm) {
        match &mut self.form {
            Some(form) => form.refresh(read),
            None => {
                self.form = Some(FormModel::from_read(read));
                // The widgets were read from the file, in the space of its crops; the session may have other ones.
                self.align_widgets_to_crops();
            }
        }
    }

    /// The form as the UI sees it, with the widgets on the pages the document has now.
    pub fn form_info(&self) -> FormInfo {
        let Some(form) = &self.form else {
            return FormInfo::empty();
        };
        form.info(|file_page| {
            self.pages.iter().find_map(|slot| match slot.source {
                PageSource::File { index } if index == file_page => Some(slot.id),
                _ => None,
            })
        })
    }

    pub fn form(&self) -> Option<&FormModel> {
        self.form.as_ref()
    }

    /// Sets a form value (checked), returning what it replaces. Nothing changes if it is refused.
    pub(crate) fn set_field_value(
        &mut self,
        field: FieldId,
        value: &FieldValue,
        delta: &mut Delta,
    ) -> Result<FieldUndo, AppError> {
        let form = self.form.as_mut().ok_or(AppError::not_found("field"))?;
        let old = form.set_value(field, value)?;
        delta.fields.insert(field);
        Ok(vec![(field, old)])
    }

    /// Puts form values back (the inverse of a change) and returns what they replace.
    pub(crate) fn restore_fields(
        &mut self,
        values: &[(FieldId, FieldValue)],
        delta: &mut Delta,
    ) -> FieldUndo {
        let Some(form) = self.form.as_mut() else {
            return Vec::new();
        };
        let inverse = form.restore(values);
        delta.fields.extend(inverse.iter().map(|(id, _)| *id));
        inverse
    }

    /// How many pages the document has now.
    pub(crate) fn page_count(&self) -> u32 {
        u32::try_from(self.pages.len()).unwrap_or(u32::MAX)
    }

    pub(crate) fn alloc_id(&mut self) -> Result<AnnotId, AppError> {
        let id = self.next_id;
        self.next_id = id
            .checked_add(1)
            .ok_or(AppError::limit("annotations", u64::from(u32::MAX)))?;
        Ok(AnnotId::new(id))
    }

    /// The entry of `id` if it exists and was not deleted.
    pub(crate) fn live(&self, id: AnnotId) -> Result<&Entry, AppError> {
        self.entries
            .get(&id)
            .filter(|entry| !entry.tombstone)
            .ok_or(AppError::not_found("annotation"))
    }

    /// The live entries that reply (directly) to one of `ids`.
    pub(crate) fn replies_to(&self, ids: &BTreeSet<AnnotId>) -> Vec<AnnotId> {
        ids.iter()
            .filter_map(|id| self.replies.get(id))
            .flatten()
            .copied()
            .collect()
    }

    /// Whether one more annotation fits on `page` and in the document.
    pub(crate) fn check_room(&self, page: PageId) -> Result<(), AppError> {
        let total = self.live_total;
        let on_page = self.live_per_page.get(&page.get()).copied().unwrap_or(0);
        if total >= limits::MAX_ANNOTATIONS_PER_DOC {
            return Err(AppError::limit(
                "annotations",
                limits::MAX_ANNOTATIONS_PER_DOC as u64,
            ));
        }
        if on_page >= limits::MAX_ANNOTATIONS_PER_PAGE {
            return Err(AppError::limit(
                "annotations",
                limits::MAX_ANNOTATIONS_PER_PAGE as u64,
            ));
        }
        Ok(())
    }

    /// Sets the content of each id and returns the slots that put everything back (in the order that restores them correctly), and
    /// what changed for the UI.
    pub(crate) fn set_slots(&mut self, slots: Vec<Slot>, delta: &mut Delta) -> Vec<Slot> {
        let mut inverse = Vec::with_capacity(slots.len());
        for (id, slot) in slots {
            let old = match slot {
                Some(entry) => {
                    if entry.tombstone {
                        delta.remove(id);
                    } else {
                        delta.upsert(entry.annotation.clone());
                    }
                    self.track(&entry, true);
                    self.entries.insert(id, entry)
                }
                None => {
                    delta.remove(id);
                    self.entries.remove(&id)
                }
            };
            if let Some(old) = &old {
                self.track(old, false);
            }
            inverse.push((id, old));
        }
        inverse.reverse();
        inverse
    }

    /// The live annotation `id`, if the model has it.
    pub fn annotation(&self, id: AnnotId) -> Option<&Annotation> {
        self.entries
            .get(&id)
            .filter(|entry| !entry.tombstone)
            .map(|entry| &entry.annotation)
    }

    /// The live annotations of `page`, by id.
    pub fn list(&self, page: PageId) -> Vec<Annotation> {
        self.entries
            .values()
            .filter(|entry| !entry.tombstone && entry.annotation.page_id == page)
            .map(|entry| entry.annotation.clone())
            .collect()
    }

    /// Every entry, including the deleted ones that are in the file: what saving works from.
    pub fn entries(&self) -> impl Iterator<Item = &Entry> {
        self.entries.values()
    }

    /// Where (page index, position in the page) the originals are that PDFium must not draw: annotations of the file that were changed
    /// or deleted in this session. The overlay draws the changed ones; undo makes an original `Clean` again, which shows it.
    ///
    /// The ones the file itself marks Hidden are always in the set, so that going back to `Clean` (undo) never shows them.
    pub fn hidden_origins(&self) -> BTreeSet<(u32, u32)> {
        self.entries
            .values()
            .filter(|entry| entry.tombstone || entry.annotation.sync == Sync::Modified)
            .filter_map(|entry| entry.persisted.as_ref())
            .map(|origin| (origin.page_index, origin.annot_index))
            .chain(self.file_hidden.iter().copied())
            .collect()
    }

    /// Whether the annotations of `page` have been read from the file.
    pub fn is_imported(&self, page: PageId) -> bool {
        self.imported.contains(&page.get())
    }

    /// Adds the annotations the engine read from the file for `page`, once: later calls for the same page do nothing, so a page that
    /// was read twice (two requests at the same time) is not doubled. What does not pass the checks, and what does not fit under the
    /// limits, is left out. Returns how many were added. Not a change: the revision and the history stay as they are.
    pub fn import_page(&mut self, page: PageId, items: &[Imported]) -> usize {
        self.import_page_linked(page, items, &HashMap::new())
    }

    /// [`DocState::import_page`] with what the file says about threads: `links` by position in the page's annotations (the engine's
    /// `annot_index`) gives the annotation a reply points at and the review state it gives. A link only applies to a note and only to
    /// a parent that was imported (the parent is on the same page).
    pub fn import_page_linked(
        &mut self,
        page: PageId,
        items: &[Imported],
        links: &HashMap<u32, ReviewLink>,
    ) -> usize {
        let Some(engine_index) = self.slot(page).map(|slot| slot.engine_index) else {
            return 0;
        };
        if !self.imported.insert(page.get()) {
            return 0;
        }
        let mut added = 0;
        let mut page_bytes = 0usize;
        // Annotations created on a page that was not read yet and then saved are in the file now: reading the page must not add them twice.
        let known: HashSet<u32> = self
            .entries
            .values()
            .filter_map(|entry| entry.persisted.as_ref())
            .filter(|origin| origin.page_index == engine_index)
            .map(|origin| origin.annot_index)
            .collect();
        for item in items.iter().filter(|item| item.hidden) {
            if self.file_hidden.len() < limits::MAX_ANNOTATIONS_PER_DOC {
                self.file_hidden
                    .insert((item.origin.page_index, item.origin.annot_index));
            }
        }
        let wanted: Vec<&Imported> = items
            .iter()
            .filter(|item| !known.contains(&item.origin.annot_index))
            .collect();
        // Where the loop stopped for want of room: what is left over is reported, not dropped silently.
        let mut stopped_at = wanted.len().min(limits::MAX_IMPORT_PER_PAGE);
        for (position, item) in wanted
            .iter()
            .copied()
            .enumerate()
            .take(limits::MAX_IMPORT_PER_PAGE)
        {
            if self.check_room(page).is_err() {
                stopped_at = position;
                break;
            }
            // The strings of a page and of a document are budgeted: many annotations at the size limit would add up to much more.
            let bytes = import_bytes(item);
            if page_bytes.saturating_add(bytes) > limits::MAX_IMPORT_BYTES_PER_PAGE
                || self.imported_bytes.saturating_add(bytes) > limits::MAX_IMPORT_BYTES_PER_DOC
            {
                stopped_at = position;
                break;
            }
            let Ok(id) = self.alloc_id() else {
                stopped_at = position;
                break;
            };
            if let Some(annotation) = Annotation::from_import(id, page, item) {
                let entry = Entry {
                    annotation,
                    persisted: Some(item.origin.clone()),
                    tombstone: false,
                };
                self.track(&entry, true);
                self.entries.insert(id, entry);
                page_bytes += bytes;
                self.imported_bytes += bytes;
                added += 1;
            }
        }
        self.link_replies(page, items, links);
        let skipped = wanted.len().saturating_sub(stopped_at);
        if skipped > 0 {
            self.truncated
                .insert(page.get(), u32::try_from(skipped).unwrap_or(u32::MAX));
        }
        added
    }

    /// Applies the reply links and states of a page that was just read (see [`DocState::import_page_linked`]).
    fn link_replies(&mut self, page: PageId, items: &[Imported], links: &HashMap<u32, ReviewLink>) {
        if links.is_empty() {
            return;
        }
        let by_position: HashMap<u32, AnnotId> = self
            .entries
            .iter()
            .filter(|(_, entry)| !entry.tombstone && entry.annotation.page_id == page)
            .filter_map(|(id, entry)| Some((entry.persisted.as_ref()?.annot_index, *id)))
            .collect();
        for item in items {
            let Some(link) = links.get(&item.origin.annot_index) else {
                continue;
            };
            let Some(id) = by_position.get(&item.origin.annot_index).copied() else {
                continue;
            };
            let parent = link
                .reply_to
                .and_then(|position| by_position.get(&position).copied())
                .filter(|parent| *parent != id);
            let is_note = self
                .entries
                .get(&id)
                .is_some_and(|entry| matches!(entry.annotation.body, AnnotationBody::Note { .. }));
            // Only a note replies in the model; a state without a parent is not a review reply.
            if parent.is_none() || !is_note {
                continue;
            }
            let Some(mut entry) = self.entries.remove(&id) else {
                continue;
            };
            self.track(&entry, false);
            entry.annotation.in_reply_to = parent;
            entry.annotation.state = link.state;
            self.track(&entry, true);
            self.entries.insert(id, entry);
        }
    }

    /// Gives the annotations of `page` that were just read from the file (still `Clean`) the `/SHR_Cite` and `/SHR_Tags` the file has,
    /// by position in the page's annotations (ADR-119, `pdfwrite::sheer_keys`). Not a change: no revision, no history.
    /// `None`: the keys could not be read (the page's annotations keep the keys the file has when saved, see [`DocState::keys_known`]).
    pub fn apply_sheer_keys(&mut self, page: PageId, keys: Option<&HashMap<u32, SheerKeys>>) {
        let Some(keys) = keys else {
            self.keys_unread.insert(page.get());
            return;
        };
        self.keys_unread.remove(&page.get());
        if keys.is_empty() {
            return;
        }
        for entry in self.entries.values_mut() {
            if entry.tombstone || entry.annotation.page_id != page {
                continue;
            }
            let Some(found) = entry
                .persisted
                .as_ref()
                .and_then(|origin| keys.get(&origin.annot_index))
            else {
                continue;
            };
            if entry.annotation.sync == Sync::Clean {
                entry
                    .annotation
                    .apply_file_keys(found.cite.as_ref(), &found.tags);
            }
        }
    }

    /// Whether `page` is a page of the file as it is (its PDF page label is then the page's label); a blank, imported or redacted page is
    /// not.
    pub fn is_file_page(&self, page: PageId) -> bool {
        self.slot(page)
            .is_some_and(|slot| matches!(slot.source, PageSource::File { .. }))
    }

    /// Whether the model knows the Sheer keys of the annotations of `page`: false for a page read from the file whose keys could not be
    /// read; the writer then leaves the keys the file has as they are.
    pub fn keys_known(&self, page: PageId) -> bool {
        !self.keys_unread.contains(&page.get())
    }

    /// What the reading of the file's annotations left out so far, by page (pages that are gone are not listed).
    pub fn import_warnings(&self) -> Vec<ImportWarning> {
        self.truncated
            .iter()
            .filter(|(page, _)| self.slot(PageId::new(**page)).is_some())
            .map(|(page, skipped)| ImportWarning::PageTruncated {
                page: *page,
                skipped: *skipped,
            })
            .collect()
    }

    fn change_set(&self, delta: Delta) -> ChangeSet {
        ChangeSet {
            rev: self.rev,
            upserted: delta.upserted.into_values().collect(),
            removed: delta.removed.into_iter().collect(),
            pages: delta.pages.then(|| self.page_infos()),
            engine_rotations: delta.engine_rotations,
            engine_crops: delta.engine_crops,
            fields: delta
                .fields
                .iter()
                .filter_map(|id| self.form.as_ref().and_then(|form| form.state(*id)))
                .collect(),
            doc: delta.doc.iter().copied().collect(),
            warnings: Vec::new(),
            history: self.history.state(),
        }
    }

    /// Runs `command` as one undo step. It either happens completely or not at all (`invalid_argument`, `not_found`,
    /// `limit_exceeded`).
    pub fn execute(&mut self, command: DocCommand, stamp: &Stamp) -> Result<ChangeSet, AppError> {
        command.check_shape()?;
        // A removal of the protection has a label of its own; the command holds the ticket only.
        let label = match &command {
            DocCommand::SetProtection { ticket }
                if matches!(self.secrets.get(*ticket), Some(PendingProtection::Remove)) =>
            {
                LABEL_PROTECT_REMOVE.to_owned()
            }
            other => other.label(),
        };
        let (inverse, delta) = command.run(self, stamp)?;
        self.rev += 1;
        self.history
            .record(label, inverse, command.coalesce_key(), stamp.now_ms);
        Ok(self.change_set(delta))
    }

    /// Takes back the last step. With nothing to undo the change set is empty.
    pub fn undo(&mut self, stamp: &Stamp) -> Result<ChangeSet, AppError> {
        let Some(entry) = self.history.pop_undo() else {
            return Ok(self.change_set(Delta::default()));
        };
        match entry.command.clone().run(self, stamp) {
            Ok((inverse, delta)) => {
                self.rev += 1;
                self.history.push_redo(entry, inverse);
                Ok(self.change_set(delta))
            }
            Err(error) => {
                self.history.restore_undo(entry);
                Err(error)
            }
        }
    }

    /// Does the last undone step again. With nothing to redo the change set is empty.
    pub fn redo(&mut self, stamp: &Stamp) -> Result<ChangeSet, AppError> {
        let Some(entry) = self.history.pop_redo() else {
            return Ok(self.change_set(Delta::default()));
        };
        match entry.command.clone().run(self, stamp) {
            Ok((inverse, delta)) => {
                self.rev += 1;
                self.history.push_undo(entry, inverse);
                Ok(self.change_set(delta))
            }
            Err(error) => {
                self.history.restore_redo(entry);
                Err(error)
            }
        }
    }
}
