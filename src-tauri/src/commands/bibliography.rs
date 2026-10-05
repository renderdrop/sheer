//! The bibliographic record (ADR-119, ARCHITECTURE section 5 "Citations (v1.3)").
//!
//! | Command | Arguments | Returns |
//! |---|---|---|
//! | `get_bibliography` | `docId: number` | the `BibliographyInfo`: the merged record and where each field came from |
//!
//! The first call reads the file (`/SHR_Bib`, XMP, Info; blocking pool, `load_untrusted`, 30 s) and, if the title, the authors, the
//! year or the DOI is still empty, asks the engine for the first-page hints; the model keeps what it read until a save. Later calls answer from
//! the model. The record is changed with `apply_command` (`DocCommand::SetBibliography`) and written by the next save.

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::{mpsc, Mutex, PoisonError};
use std::thread;
use std::time::Duration;

use tauri::State;

use super::save::read_all;
use super::{blocking, AppState};
use crate::documents::{intake, DocumentId};
use crate::error::{AppError, ErrorCode, UiError};
use crate::limits;
use crate::model::bibliography::{BibLayers, BibliographyInfo};
use crate::model::doc_state::DocState;
use crate::pdfwrite::{bibliography, crypt};

impl AppState {
    /// The record of document `id`, merged from the user's record, XMP, Info and the first page, with the source of each field. The first
    /// call reads the file.
    pub fn get_bibliography(&self, id: DocumentId) -> Result<BibliographyInfo, AppError> {
        self.info(id).ok_or(AppError::not_found("document"))?;
        if self.model(id, |state| Ok(state.bibliography.layers.is_some()))? {
            return self.model(id, |state| Ok(answer(state)));
        }
        let session = self.session_password(id);
        let path = self
            .registry
            .path(id)
            .ok_or(AppError::not_found("document"))?;
        let read = with_deadline(id, limits::METADATA_READ_TIMEOUT, move || {
            let (bytes, _) = read_all(intake::admit(&path)?)?;
            let (doc, _) = crypt::load_decrypted(&bytes, session.as_ref().map(|s| s.as_str()))?;
            drop(bytes);
            bibliography::read(&doc)
        })?;
        let mut layers = BibLayers {
            file: read.record,
            xmp: read.xmp,
            info: read.info,
            hints: None,
        };
        // The heuristic runs only for what is still empty; a failing job is no hints (the answer stays usable).
        if hints_wanted(&layers) {
            layers.hints = Some(self.engine.first_page_hints(id, 0).unwrap_or_default());
        }
        self.model(id, |state| {
            // Another call may have read it meanwhile; what the session changed since is not overwritten.
            if state.bibliography.layers.is_none() {
                state.bibliography.layers = Some(layers);
                state.bibliography.refresh();
            }
            Ok(answer(state))
        })
    }
}

/// Whether the first-page heuristic is worth running: a field it can fill (title, authors, year, DOI) is still empty.
fn hints_wanted(layers: &BibLayers) -> bool {
    let title = layers
        .file
        .as_ref()
        .and_then(|r| r.title.as_ref())
        .or(layers.xmp.title.as_ref())
        .or(layers.info.title.as_ref());
    let authors = layers.file.as_ref().is_some_and(|r| !r.authors.is_empty())
        || !layers.xmp.authors.is_empty()
        || !layers.info.authors.is_empty();
    let year = layers
        .file
        .as_ref()
        .and_then(|r| r.year.as_ref())
        .or(layers.xmp.year.as_ref())
        .or(layers.info.year.as_ref());
    let doi = layers
        .file
        .as_ref()
        .and_then(|r| r.doi.as_ref())
        .or(layers.xmp.doi.as_ref())
        .or(layers.info.doi.as_ref());
    title.is_none() || !authors || year.is_none() || doi.is_none()
}

fn answer(state: &DocState) -> BibliographyInfo {
    let bib = &state.bibliography;
    let strip = state.metadata().strip;
    BibliographyInfo {
        record: bib.record.clone().unwrap_or_default(),
        sources: bib.sources.clone(),
        pending: bib.is_pending(),
        dropped_by_strip: strip && bib.has_user(),
    }
}

/// The record of a document, merged from the user's record, XMP, Info and the first page.
#[tauri::command]
pub async fn get_bibliography(
    state: State<'_, AppState>,
    doc_id: DocumentId,
) -> Result<BibliographyInfo, UiError> {
    let state = state.inner().clone();
    blocking(move || state.get_bibliography(doc_id)).await
}

/// The documents whose bibliography is being read by a thread of [`with_deadline`] (the thread outlives a caller that gave up).
static READING: Mutex<Vec<DocumentId>> = Mutex::new(Vec::new());

/// Held by the reading thread of one document; the entry goes when the thread ends, however it ends.
struct Reading(DocumentId);

impl Reading {
    /// `None` while a read of `id` is still running.
    fn begin(id: DocumentId) -> Option<Self> {
        let mut reading = READING.lock().unwrap_or_else(PoisonError::into_inner);
        if reading.contains(&id) {
            return None;
        }
        reading.push(id);
        Some(Self(id))
    }
}

impl Drop for Reading {
    fn drop(&mut self) {
        READING
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .retain(|other| *other != self.0);
    }
}

/// Runs `work` on a thread of its own (with the stack the save thread has) and stops waiting after `timeout` (`engine_timeout`); a panic
/// is `internal`. The thread ends by itself, and its answer is dropped. At most one such thread runs per document: a call while one is
/// still running is `engine_timeout` at once, so slow reads cannot pile up threads.
fn with_deadline<T: Send + 'static>(
    id: DocumentId,
    timeout: Duration,
    work: impl FnOnce() -> Result<T, AppError> + Send + 'static,
) -> Result<T, AppError> {
    let Some(reading) = Reading::begin(id) else {
        return Err(AppError::logged(
            ErrorCode::EngineTimeout,
            "the bibliography of the document is still being read",
        ));
    };
    let (sender, receiver) = mpsc::channel();
    let spawned = thread::Builder::new()
        .name("sheer-bibliography".into())
        .stack_size(limits::SAVE_STACK_BYTES)
        .spawn(move || {
            let _reading = reading;
            let result = catch_unwind(AssertUnwindSafe(work)).unwrap_or_else(|_| {
                Err(AppError::logged(
                    ErrorCode::Internal,
                    "reading the bibliography panicked",
                ))
            });
            // The caller may have given up.
            let _ = sender.send(result);
        });
    if let Err(error) = spawned {
        return Err(AppError::logged(ErrorCode::Internal, error));
    }
    receiver.recv_timeout(timeout).map_err(|_| {
        AppError::logged(
            ErrorCode::EngineTimeout,
            "reading the bibliography took too long",
        )
    })?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_first_page_is_read_while_the_doi_is_empty_even_if_the_rest_is_full() {
        use crate::model::bibliography::Person;
        let mut layers = BibLayers::default();
        assert!(hints_wanted(&layers));
        layers.info.title = Some("T".into());
        layers.info.authors = vec![Person {
            family: "A".into(),
            given: "B".into(),
        }];
        layers.info.year = Some("2020".into());
        assert!(hints_wanted(&layers), "no DOI: the page may print one");
        layers.info.doi = Some("10.1000/x".into());
        assert!(!hints_wanted(&layers));
    }

    #[test]
    fn a_second_read_of_a_document_waits_for_none_and_is_refused_while_one_runs() {
        let id: DocumentId = serde_json::from_value(serde_json::json!(4_000_001)).unwrap();
        let other: DocumentId = serde_json::from_value(serde_json::json!(4_000_002)).unwrap();
        let (release, gate) = mpsc::channel::<()>();
        let (started, running) = mpsc::channel::<()>();
        let first = thread::spawn(move || {
            with_deadline(id, Duration::from_millis(100), move || {
                let _ = started.send(());
                let _ = gate.recv();
                Ok(1)
            })
        });
        running.recv().unwrap();
        // The first call gave up after its deadline, but its thread still runs: no second thread for the document.
        assert_eq!(
            first.join().unwrap().unwrap_err().code(),
            ErrorCode::EngineTimeout
        );
        let refused = with_deadline(id, Duration::from_secs(5), || Ok(2)).unwrap_err();
        assert_eq!(refused.code(), ErrorCode::EngineTimeout);
        // Another document is not held up.
        assert_eq!(
            with_deadline(other, Duration::from_secs(5), || Ok(3)).unwrap(),
            3
        );
        // When the thread ends the document can be read again.
        release.send(()).unwrap();
        let mut done = false;
        for _ in 0..200 {
            if with_deadline(id, Duration::from_secs(5), || Ok(4)).is_ok() {
                done = true;
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        assert!(done);
    }
}
