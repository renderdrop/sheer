//! Citation commands (ADR-119, ARCHITECTURE section 5 "Citations (v1.3)").
//!
//! | Command | Arguments | Returns |
//! |---|---|---|
//! | `create_citations` | `docId: number`, `drafts: CitationDraft[]` (at most 64, one page each) | the `ChangeSet` of one `Batch` (`citation.create`) |
//! | `list_citations` | `docId: number` | `CitationInfo[]` (at most 20 000), page order then position, the locator resolved now |
//!
//! Seam of package W0: both are stubs that answer `unsupported_feature` (`what: "notYet"`) and validate nothing. Package C1 fills them in.

use tauri::State;

use super::{blocking, AppState};
use crate::documents::DocumentId;
use crate::error::{AppError, UiError};
use crate::model::doc_state::ChangeSet;
use crate::model::quote::{CitationDraft, CitationInfo};

/// Makes one citation (a Highlight with its quote and page) of each draft, as one undo step. Stub (package C1): `not_yet`.
#[tauri::command]
pub async fn create_citations(
    state: State<'_, AppState>,
    doc_id: DocumentId,
    drafts: Vec<CitationDraft>,
) -> Result<ChangeSet, UiError> {
    let _ = (&state, doc_id, drafts);
    blocking(|| Err::<ChangeSet, _>(AppError::not_yet())).await
}

/// The citations of a document with their page labels. Stub (package C1): `not_yet`.
#[tauri::command]
pub async fn list_citations(
    state: State<'_, AppState>,
    doc_id: DocumentId,
) -> Result<Vec<CitationInfo>, UiError> {
    let _ = (&state, doc_id);
    blocking(|| Err::<Vec<CitationInfo>, _>(AppError::not_yet())).await
}
