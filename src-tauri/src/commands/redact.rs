//! True redaction (ARCHITECTURE §5 "Edit and protect", ADR-047 §3). owned by package C.
//!
//! | Command | Arguments | Returns |
//! |---|---|---|
//! | `apply_redactions` | `docId`, `opts: { pages: PageId[] or null, removeMetadata }`, `onEvent: Channel<JobEvent>` | `JobId`. No dialog. `progress` has `phase: "redact"`; `done.changes` is the `ChangeSet` of the one undo step (`redact.apply`); `done.warnings` may hold `unsavedEditsDropped`; a cancel changes nothing |
//!
//! The marks are made with `apply_command` (`markRedactions`, or `createAnnotation` of kind `redactMark`).

use std::sync::Arc;

use tauri::ipc::Channel;
use tauri::State;

use super::jobs::{channel_sink, jobs, EventSink, JobEvent, JobId, JobRegistry};
use super::{blocking, AppState};
use crate::documents::DocumentId;
use crate::error::{AppError, UiError};
use crate::model::redaction::RedactOptions;

impl AppState {
    /// Starts the redaction job of document `id` (see the module documentation). Package C.
    pub fn start_redaction(
        &self,
        _jobs: &Arc<JobRegistry>,
        id: DocumentId,
        _opts: &RedactOptions,
        _sink: Arc<dyn EventSink>,
    ) -> Result<JobId, AppError> {
        self.info(id).ok_or(AppError::not_found("document"))?;
        self.check_may_edit(id)?;
        Err(AppError::not_yet())
    }
}

/// Burns the marked areas into raster pages (a job).
#[tauri::command]
pub async fn apply_redactions(
    state: State<'_, AppState>,
    doc_id: DocumentId,
    opts: RedactOptions,
    on_event: Channel<JobEvent>,
) -> Result<JobId, UiError> {
    let state = state.inner().clone();
    blocking(move || state.start_redaction(jobs(), doc_id, &opts, channel_sink(on_event))).await
}
