//! Saving the citation list to a file (ADR-119 section 8, ARCHITECTURE section 5 "Citations (v1.3)").
//!
//! | Command | Arguments | Returns |
//! |---|---|---|
//! | `save_citation_list` | `docId`, `format: txt\|html\|md\|ris\|bib`, `blocks: StyledBlock[]`, `style: CitationStyle` | `boolean`: `false` if the save dialog was cancelled |
//!
//! Seam of package W0: a stub that answers `unsupported_feature` (`what: "notYet"`) and validates nothing. Package C4 fills it in.

use tauri::State;

use super::{blocking, AppState};
use crate::documents::DocumentId;
use crate::error::{AppError, UiError};
use crate::export::citations::{CitationFileFormat, CitationStyle, StyledBlock};

/// Writes the list as a file the user picks in a native dialog. Stub (package C4): `not_yet`.
#[tauri::command]
pub async fn save_citation_list(
    state: State<'_, AppState>,
    doc_id: DocumentId,
    format: CitationFileFormat,
    blocks: Vec<StyledBlock>,
    style: CitationStyle,
) -> Result<bool, UiError> {
    let _ = (&state, doc_id, format, blocks, style);
    blocking(|| Err::<bool, _>(AppError::not_yet())).await
}
