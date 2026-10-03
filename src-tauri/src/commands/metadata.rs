//! Document metadata (ARCHITECTURE §5 "Edit and protect", ADR-047 §5). owned by package D.
//!
//! | Command | Arguments | Returns |
//! |---|---|---|
//! | `get_metadata` | `docId` | `DocMetadata`. The first call reads the file (blocking pool, `load_untrusted`, 30 s); later calls answer from the model |
//!
//! The edits are `apply_command` commands (`setMetadata`, `removeMetadata`) and take effect on the next save.

use tauri::State;

use super::{blocking, AppState};
use crate::documents::DocumentId;
use crate::error::{AppError, UiError};
use crate::model::metadata::DocMetadata;

impl AppState {
    /// The metadata of document `id` with what is staged. Package D.
    pub fn get_metadata(&self, id: DocumentId) -> Result<DocMetadata, AppError> {
        self.info(id).ok_or(AppError::not_found("document"))?;
        Err(AppError::not_yet())
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
