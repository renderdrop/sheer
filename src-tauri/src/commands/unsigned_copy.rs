//! Saving an unsigned copy (ADR-121 section 1, ARCHITECTURE section 5 "Certificate signatures (v1.4)").
//!
//! | Command | Arguments | Returns |
//! |---|---|---|
//! | `save_unsigned_copy` | `docId: number` | `AppEvent \| null` (`opened` for the new document; `null` = the save dialog was cancelled) |
//!
//! Seam of package W0: a stub that answers `unsupported_feature` (`what: "notYet"`). Package B4 fills it in: a Full rewrite of the
//! current state without `/Perms`, signature values, signature dictionaries and signed widgets.

use tauri::State;

use super::{blocking, AppState};
use crate::documents::DocumentId;
use crate::error::{AppError, UiError};
use crate::events::AppEvent;

/// Writes a copy of document `doc_id` without its signatures and opens it. Stub (package B4): `not_yet`.
#[tauri::command]
pub async fn save_unsigned_copy(
    state: State<'_, AppState>,
    doc_id: DocumentId,
) -> Result<Option<AppEvent>, UiError> {
    let _ = (&state, doc_id);
    blocking(|| Err::<Option<AppEvent>, _>(AppError::not_yet())).await
}
