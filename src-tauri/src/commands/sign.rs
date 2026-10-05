//! Signing a document (ADR-121 section 1, ARCHITECTURE section 5 "Certificate signatures (v1.4)").
//!
//! | Command | Arguments | Returns |
//! |---|---|---|
//! | `sign_document` | `docId: number`, `request: SignRequest` | `SaveResult \| null` (`null` = the save dialog was cancelled) |
//!
//! Seam of package W0: a stub that answers `unsupported_feature` (`what: "notYet"`) and validates nothing. Package B2 fills it in:
//! PAdES B-B, one appended revision, never a Full save; the dialog and the file are Rust's, and no key crosses IPC.

use tauri::State;

use super::save::SaveResult;
use super::{blocking, AppState};
use crate::documents::DocumentId;
use crate::error::{AppError, UiError};
use crate::pdfsig::types::SignRequest;

/// Signs document `doc_id` into a file the user picks. Stub (package B2): `not_yet`.
#[tauri::command]
pub async fn sign_document(
    state: State<'_, AppState>,
    doc_id: DocumentId,
    request: SignRequest,
) -> Result<Option<SaveResult>, UiError> {
    let _ = (&state, doc_id, request);
    blocking(|| Err::<Option<SaveResult>, _>(AppError::not_yet())).await
}
