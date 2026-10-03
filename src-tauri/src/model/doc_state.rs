//! The editable state of one open document (ADR-003): its annotations, the revision counter and the history.
//!
//! The state is only ever changed through [`DocState::execute`], [`DocState::undo`] and [`DocState::redo`] (and filled by
//! [`DocState::import_page`] when a page is first looked at). Each returns a [`ChangeSet`], the delta the UI applies to its replica.
//! The state is plain data: no PDFium, no lopdf, no clock (the caller passes a [`Stamp`]), so all of it is tested without a PDF.

use std::collections::{BTreeMap, BTreeSet, HashSet};

use serde::Serialize;

use super::annotation::{Annotation, Imported, PdfOrigin};
use super::command::DocCommand;
use super::history::{History, HistoryState};
use super::ids::AnnotId;
use crate::documents::PageId;
use crate::error::AppError;
use crate::limits;

/// What a command needs to know about the moment it runs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Stamp {
    /// Milliseconds on a monotonic clock, for coalescing.
    pub now_ms: u64,
    /// The `modified` date given to what the command touches (ISO 8601, UTC).
    pub modified: String,
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
    /// The page list, once page commands exist (M3); `null` until then.
    pub pages: Option<Vec<PageId>>,
    pub history: HistoryState,
}

#[derive(Debug)]
pub struct DocState {
    page_count: u32,
    entries: BTreeMap<AnnotId, Entry>,
    next_id: u32,
    rev: u64,
    history: History,
    /// The pages whose annotations were read from the file.
    imported: HashSet<u32>,
}

impl DocState {
    pub fn new(page_count: u32) -> Self {
        Self {
            page_count,
            entries: BTreeMap::new(),
            next_id: 1,
            rev: 0,
            history: History::new(),
            imported: HashSet::new(),
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

    pub(crate) fn page_count(&self) -> u32 {
        self.page_count
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
        self.entries
            .values()
            .filter(|entry| !entry.tombstone)
            .filter(|entry| {
                entry
                    .annotation
                    .in_reply_to
                    .is_some_and(|parent| ids.contains(&parent))
            })
            .map(|entry| entry.annotation.id)
            .collect()
    }

    /// Whether one more annotation fits on `page` and in the document.
    pub(crate) fn check_room(&self, page: PageId) -> Result<(), AppError> {
        let mut total = 0usize;
        let mut on_page = 0usize;
        for entry in self.entries.values().filter(|entry| !entry.tombstone) {
            total += 1;
            on_page += usize::from(entry.annotation.page_id == page);
        }
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
                    self.entries.insert(id, entry)
                }
                None => {
                    delta.remove(id);
                    self.entries.remove(&id)
                }
            };
            inverse.push((id, old));
        }
        inverse.reverse();
        inverse
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

    /// Whether the annotations of `page` have been read from the file.
    pub fn is_imported(&self, page: PageId) -> bool {
        self.imported.contains(&page.get())
    }

    /// Adds the annotations the engine read from the file for `page`, once: later calls for the same page do nothing, so a page that
    /// was read twice (two requests at the same time) is not doubled. What does not pass the checks, and what does not fit under the
    /// limits, is left out. Returns how many were added. Not a change: the revision and the history stay as they are.
    pub fn import_page(&mut self, page: PageId, items: &[Imported]) -> usize {
        if page.get() >= self.page_count || !self.imported.insert(page.get()) {
            return 0;
        }
        let mut added = 0;
        for item in items.iter().take(limits::MAX_IMPORT_PER_PAGE) {
            if self.check_room(page).is_err() {
                break;
            }
            let Ok(id) = self.alloc_id() else { break };
            if let Some(annotation) = Annotation::from_import(id, page, item) {
                self.entries.insert(
                    id,
                    Entry {
                        annotation,
                        persisted: Some(item.origin.clone()),
                        tombstone: false,
                    },
                );
                added += 1;
            }
        }
        added
    }

    fn change_set(&self, delta: Delta) -> ChangeSet {
        ChangeSet {
            rev: self.rev,
            upserted: delta.upserted.into_values().collect(),
            removed: delta.removed.into_iter().collect(),
            pages: None,
            history: self.history.state(),
        }
    }

    /// Runs `command` as one undo step. It either happens completely or not at all (`invalid_argument`, `not_found`,
    /// `limit_exceeded`).
    pub fn execute(&mut self, command: DocCommand, stamp: &Stamp) -> Result<ChangeSet, AppError> {
        command.check_shape()?;
        let (inverse, delta) = command.run(self, stamp)?;
        self.rev += 1;
        self.history.record(
            command.label(),
            DocCommand::Restore { slots: inverse },
            command.coalesce_key(),
            stamp.now_ms,
        );
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
                self.history
                    .push_redo(entry, DocCommand::Restore { slots: inverse });
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
                self.history
                    .push_undo(entry, DocCommand::Restore { slots: inverse });
                Ok(self.change_set(delta))
            }
            Err(error) => {
                self.history.restore_redo(entry);
                Err(error)
            }
        }
    }
}
