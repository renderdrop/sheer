//! Document metadata (ARCHITECTURE §5 "Edit and protect", ADR-047 §5). owned by package D.
//!
//! | Command | Arguments | Returns |
//! |---|---|---|
//! | `get_metadata` | `docId` | `DocMetadata`. The first call reads the file (blocking pool, `load_untrusted`, 30 s); later calls answer from the model |
//!
//! The edits are `apply_command` commands (`setMetadata`, `removeMetadata`) and take effect on the next save.

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
use crate::model::metadata::{DocMetadata, FileMeta, MetadataPending, XmpInfo};
use crate::pdfwrite::{crypt, metadata};

impl AppState {
    /// The metadata of document `id` with what is staged. The first call reads the file (the model keeps what it read, until a save).
    pub fn get_metadata(&self, id: DocumentId) -> Result<DocMetadata, AppError> {
        self.info(id).ok_or(AppError::not_found("document"))?;
        if self.model(id, |state| Ok(state.metadata().file.is_some()))? {
            return self.model(id, |state| Ok(answer(state)));
        }
        let session = self.session_password(id);
        let path = self
            .registry
            .path(id)
            .ok_or(AppError::not_found("document"))?;
        let (read, file_bytes) = with_deadline(limits::METADATA_READ_TIMEOUT, move || {
            let (bytes, _) = read_all(intake::admit(&path)?)?;
            let file_bytes = u64::try_from(bytes.len()).unwrap_or(u64::MAX);
            let (doc, _) = crypt::load_decrypted(&bytes, session.as_ref().map(|s| s.as_str()))?;
            drop(bytes);
            Ok((metadata::read(&doc)?, file_bytes))
        })?;
        self.model(id, |state| {
            let meta = state.metadata_mut();
            // Another call may have read it meanwhile; what the session changed since is not overwritten.
            if meta.file.is_none() {
                meta.clean = Some(read.values.clone());
                if meta.current.is_none() {
                    meta.current = Some(read.values.clone());
                }
                meta.had_xmp = read.xmp_present;
                meta.file = Some(FileMeta {
                    created: read.created.clone(),
                    modified: read.modified.clone(),
                    pdf_version: read.pdf_version.clone(),
                    file_bytes,
                    xmp_bytes: read.xmp_bytes,
                    truncated: read.truncated,
                });
            }
            Ok(answer(state))
        })
    }
}

fn answer(state: &crate::model::doc_state::DocState) -> DocMetadata {
    let meta = state.metadata();
    let values = meta
        .current
        .clone()
        .or_else(|| meta.clean.clone())
        .unwrap_or_default();
    let file = meta.file.clone().unwrap_or_default();
    let pending = if meta.strip {
        MetadataPending::Remove
    } else if meta.current != meta.clean {
        MetadataPending::Edited
    } else {
        MetadataPending::None
    };
    DocMetadata {
        title: values.title,
        author: values.author,
        subject: values.subject,
        keywords: values.keywords,
        creator: values.creator,
        producer: values.producer,
        created: file.created,
        modified: file.modified,
        pdf_version: file.pdf_version,
        file_bytes: file.file_bytes,
        xmp: XmpInfo {
            present: meta.had_xmp,
            bytes: file.xmp_bytes,
        },
        truncated: file.truncated,
        pending,
    }
}

/// The document's metadata.
#[tauri::command]
pub async fn get_metadata(
    state: State<'_, AppState>,
    doc_id: DocumentId,
) -> Result<DocMetadata, UiError> {
    let state = state.inner().clone();
    blocking(move || state.get_metadata(doc_id)).await
}

/// Runs `work` on a thread of its own (with the stack the save thread has) and stops waiting after `timeout` (`engine_timeout`); a panic
/// is `internal`. The thread ends by itself, and its answer is dropped.
fn with_deadline<T: Send + 'static>(
    timeout: Duration,
    work: impl FnOnce() -> Result<T, AppError> + Send + 'static,
) -> Result<T, AppError> {
    let (sender, receiver) = mpsc::channel();
    let spawned = thread::Builder::new()
        .name("sheer-metadata".into())
        .stack_size(limits::SAVE_STACK_BYTES)
        .spawn(move || {
            let result = catch_unwind(AssertUnwindSafe(work)).unwrap_or_else(|_| {
                Err(AppError::logged(
                    ErrorCode::Internal,
                    "reading the metadata panicked",
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
            "reading the metadata took too long",
        )
    })?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_read_that_takes_too_long_is_an_engine_timeout() {
        let slow = with_deadline(Duration::from_millis(20), || {
            thread::sleep(Duration::from_millis(500));
            Ok(1)
        });
        assert_eq!(slow.unwrap_err().code(), ErrorCode::EngineTimeout);
        assert_eq!(with_deadline(Duration::from_secs(5), || Ok(2)).unwrap(), 2);
        let panicked: Result<u8, _> =
            with_deadline(Duration::from_secs(5), || panic!("hostile file"));
        assert_eq!(panicked.unwrap_err().code(), ErrorCode::Internal);
    }
}
