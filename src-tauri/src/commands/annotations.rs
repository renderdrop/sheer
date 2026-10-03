//! The annotations of a document and the commands that change them (ARCHITECTURE §5 annotations, ADR-003).
//!
//! | Command | Arguments | Returns |
//! |---|---|---|
//! | `list_annotations` | `docId: number`, `pageId: number` | `Annotation[]` of the page, by id. The first call for a page reads its annotations from the file (an `Interactive` engine job) |
//! | `apply_annotation_command` | `docId: number`, `command: DocCommand` | the `ChangeSet` `{ rev, upserted, removed, pages, history }`; the whole command happened or nothing did |
//! | `undo`, `redo` | `docId: number` | the `ChangeSet` of the step taken back or done again; empty (same `rev`) if there is none |
//!
//! There is no event channel: every change of the model is the answer to a command of the UI, which applies the delta to its replica
//! (`src/stores/annotations.ts`). Nothing else changes the model while a document is open, so the replica cannot miss a change.
//!
//! The model lives in `model::doc_state::DocState`, one per open document, created on first use and dropped when the document is closed.
//! The clock and the file are the only things that are not in the model: this module stamps the commands (`modified`, a monotonic
//! time for coalescing) and asks the engine for the annotations of a page the first time the page is listed.

use std::collections::HashMap;
use std::sync::{Mutex, PoisonError};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use tauri::State;

use super::{blocking, AppState};
use crate::documents::{DocumentId, PageId};
use crate::error::{AppError, UiError};
use crate::model::annotation::Annotation;
use crate::model::command::DocCommand;
use crate::model::doc_state::{ChangeSet, DocState, Stamp};

/// The models of the open documents.
pub struct AnnotationStore {
    docs: Mutex<HashMap<DocumentId, DocState>>,
    started: Instant,
}

impl Default for AnnotationStore {
    fn default() -> Self {
        Self {
            docs: Mutex::new(HashMap::new()),
            started: Instant::now(),
        }
    }
}

impl AnnotationStore {
    /// Runs `f` on the model of document `id` (of `page_count` pages), which is created if the document has none yet.
    fn with<T>(
        &self,
        id: DocumentId,
        page_count: u32,
        f: impl FnOnce(&mut DocState) -> Result<T, AppError>,
    ) -> Result<T, AppError> {
        // A poisoned lock means a command panicked in the model; the blocking pool turned that into `internal`, and the model's
        // maps are never left half-written between statements that can panic.
        let mut docs = self.docs.lock().unwrap_or_else(PoisonError::into_inner);
        f(docs.entry(id).or_insert_with(|| DocState::new(page_count)))
    }

    /// Forgets the model of a document that is closed.
    pub fn remove(&self, id: DocumentId) {
        self.docs
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&id);
    }

    /// How many documents have a model.
    pub fn len(&self) -> usize {
        self.docs
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .len()
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

impl AppState {
    /// The annotations of a page, by id. The first call for a page reads them from the file; later calls answer from the model, which
    /// by then is the truth (it has the session's changes). `invalid_argument` (`page`) for a page the document does not have,
    /// `not_found` for a document that is not open.
    pub fn list_annotations(
        &self,
        id: DocumentId,
        page: PageId,
    ) -> Result<Vec<Annotation>, AppError> {
        let page_index = self.registry.page_index(id, page)?;
        let count = self.registry.page_count(id)?;
        if !self
            .annotations
            .with(id, count, |state| Ok(state.is_imported(page)))?
        {
            // Not under the lock: a read of a page takes the worker's time, and the model must stay available meanwhile. Two
            // requests at once read twice; the model keeps the first answer (`DocState::import_page`).
            let items = self.engine.import_annotations(id, page_index)?;
            self.annotations.with(id, count, |state| {
                state.import_page(page, &items);
                Ok(())
            })?;
        }
        self.annotations
            .with(id, count, |state| Ok(state.list(page)))
    }

    /// Runs a command on the model of a document as one undo step (ADR-003 §6). `not_found` for an unknown document, annotation or reply
    /// target, `invalid_argument` for a page, a value or a field that does not fit, `limit_exceeded` for a count that is too large.
    pub fn apply_annotation_command(
        &self,
        id: DocumentId,
        command: DocCommand,
    ) -> Result<ChangeSet, AppError> {
        let count = self.registry.page_count(id)?;
        let stamp = self.annotations.stamp();
        self.annotations
            .with(id, count, |state| state.execute(command, &stamp))
    }

    /// Takes back the last step; an empty change set if there is none.
    pub fn undo(&self, id: DocumentId) -> Result<ChangeSet, AppError> {
        let count = self.registry.page_count(id)?;
        let stamp = self.annotations.stamp();
        self.annotations.with(id, count, |state| state.undo(&stamp))
    }

    /// Does the last undone step again; an empty change set if there is none.
    pub fn redo(&self, id: DocumentId) -> Result<ChangeSet, AppError> {
        let count = self.registry.page_count(id)?;
        let stamp = self.annotations.stamp();
        self.annotations.with(id, count, |state| state.redo(&stamp))
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

/// Runs a command on the annotations of a document as one undo step and answers with what changed.
#[tauri::command]
pub async fn apply_annotation_command(
    state: State<'_, AppState>,
    doc_id: DocumentId,
    command: DocCommand,
) -> Result<ChangeSet, UiError> {
    let state = state.inner().clone();
    blocking(move || state.apply_annotation_command(doc_id, command)).await
}

/// Takes back the last step of a document's history.
#[tauri::command]
pub async fn undo(state: State<'_, AppState>, doc_id: DocumentId) -> Result<ChangeSet, UiError> {
    let state = state.inner().clone();
    blocking(move || state.undo(doc_id)).await
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
            state
                .apply_annotation_command(unknown, create(0))
                .unwrap_err()
                .code(),
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
        let created = state.apply_annotation_command(id, create(1)).unwrap();
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
            state
                .apply_annotation_command(id, create(2))
                .unwrap_err()
                .code(),
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
            .apply_annotation_command(
                id,
                command(json!({"type": "deleteAnnotations", "ids": [listed[0].id]})),
            )
            .unwrap();
        assert_eq!(removed.removed, [listed[0].id]);
        assert!(removed.history.dirty);
        // The opaque one cannot be touched.
        let refused = state.apply_annotation_command(
            id,
            command(json!({"type": "deleteAnnotations", "ids": [listed[1].id]})),
        );
        assert_eq!(refused.unwrap_err().code(), ErrorCode::InvalidArgument);
    }

    #[test]
    fn closing_a_document_drops_its_model() {
        let (state, id, _) = state_with_import(1, vec![]);
        state.apply_annotation_command(id, create(0)).unwrap();
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
        let changes = state.apply_annotation_command(id, create(0)).unwrap();
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
}
