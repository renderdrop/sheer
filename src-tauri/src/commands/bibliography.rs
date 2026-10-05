//! The bibliographic record (ADR-119, ARCHITECTURE section 5 "Citations (v1.3)").
//!
//! | Command | Arguments | Returns |
//! |---|---|---|
//! | `get_bibliography` | `docId: number` | the `BibliographyInfo`: the merged record and where each field came from |
//!
//! The first call reads the file (`/SHR_Bib`, XMP, Info; blocking pool, `load_untrusted`, 30 s) and, if the title, the authors or the
//! year is still empty, asks the engine for the first-page hints; the model keeps what it read until a save. Later calls answer from
//! the model. The record is changed with `apply_command` (`DocCommand::SetBibliography`) and written by the next save.

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::mpsc;
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
        let read = with_deadline(limits::METADATA_READ_TIMEOUT, move || {
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
        let wanted = |layers: &BibLayers| {
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
            title.is_none() || !authors || year.is_none()
        };
        if wanted(&layers) {
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

/// Runs `work` on a thread of its own (with the stack the save thread has) and stops waiting after `timeout` (`engine_timeout`); a panic
/// is `internal`. The thread ends by itself, and its answer is dropped.
fn with_deadline<T: Send + 'static>(
    timeout: Duration,
    work: impl FnOnce() -> Result<T, AppError> + Send + 'static,
) -> Result<T, AppError> {
    let (sender, receiver) = mpsc::channel();
    let spawned = thread::Builder::new()
        .name("sheer-bibliography".into())
        .stack_size(limits::SAVE_STACK_BYTES)
        .spawn(move || {
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
