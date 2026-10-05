//! The bibliographic record (ADR-119, ARCHITECTURE section 5 "Citations (v1.3)").
//!
//! | Command | Arguments | Returns |
//! |---|---|---|
//! | `get_bibliography` | `docId: number` | the `BibliographyInfo`: the merged record and where each field came from |
//!
//! The record is changed with `apply_command` (`DocCommand::SetBibliography`). Seam of package W0: a stub that answers
//! `unsupported_feature` (`what: "notYet"`). Package C2 fills it in.

use tauri::State;

use super::{blocking, AppState};
use crate::documents::DocumentId;
use crate::error::{AppError, UiError};
use crate::model::bibliography::BibliographyInfo;

/// The record of a document, merged from the user's record, XMP, Info and the first page. Stub (package C2): `not_yet`.
#[tauri::command]
pub async fn get_bibliography(
    state: State<'_, AppState>,
    doc_id: DocumentId,
) -> Result<BibliographyInfo, UiError> {
    let _ = (&state, doc_id);
    blocking(|| Err::<BibliographyInfo, _>(AppError::not_yet())).await
}
