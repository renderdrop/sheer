// owned by package B2
//! Crash recovery (ARCHITECTURE section 5 "Ship (M7)", ADR-053 section 2).
//!
//! | Command | Arguments | Returns |
//! |---|---|---|
//! | `list_recoveries` | none | `RecoveryEntry[]` of dead sessions |
//! | `restore_recovery` | `id: RecoveryId` | `AppEvent` (`opened`, `needsPassword`, `openFailed`), the document as `DocKind::Recovered` |
//! | `discard_recovery` | `id: RecoveryId` | nothing |
//! | `discard_all_recoveries` | none | how many were removed |
//!
//! Every answer names a record by a session-scoped [`RecoveryId`], never by path.

use serde::Serialize;
use tauri::State;

use super::{blocking, AppState};
use crate::error::{AppError, UiError};
use crate::events::AppEvent;

/// Names one recovery record for the lifetime of the app session; not a path, not stable across runs.
pub type RecoveryId = u32;

/// Whether the file the document was opened from still is what it was.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum OriginalState {
    Unchanged,
    Changed,
    Missing,
}

/// A document the last session left behind.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryEntry {
    pub id: RecoveryId,
    pub display_name: String,
    /// The last component of the folder the original was in; `None` when unknown.
    pub folder: Option<String>,
    /// ISO 8601, UTC.
    pub saved_at: String,
    pub page_count: u32,
    pub original: OriginalState,
}

impl AppState {
    /// The records of dead sessions. Stub (package B2): `not_yet`.
    pub fn list_recoveries(&self) -> Result<Vec<RecoveryEntry>, AppError> {
        Err(AppError::not_yet())
    }

    /// Opens record `id` through intake as `DocKind::Recovered`. Stub (package B2): `not_yet`.
    pub fn restore_recovery(&self, _id: RecoveryId) -> Result<AppEvent, AppError> {
        Err(AppError::not_yet())
    }

    /// Deletes record `id`. Stub (package B2): `not_yet`.
    pub fn discard_recovery(&self, _id: RecoveryId) -> Result<(), AppError> {
        Err(AppError::not_yet())
    }

    /// Deletes every record and answers how many there were. Stub (package B2): `not_yet`.
    pub fn discard_all_recoveries(&self) -> Result<u32, AppError> {
        Err(AppError::not_yet())
    }
}

/// The documents a crashed session left behind, newest first.
#[tauri::command]
pub async fn list_recoveries(state: State<'_, AppState>) -> Result<Vec<RecoveryEntry>, UiError> {
    let state = state.inner().clone();
    blocking(move || state.list_recoveries()).await
}

/// Opens a recovered document; Save then acts as Save As.
#[tauri::command]
pub async fn restore_recovery(
    state: State<'_, AppState>,
    id: RecoveryId,
) -> Result<AppEvent, UiError> {
    let state = state.inner().clone();
    blocking(move || state.restore_recovery(id)).await
}

/// Deletes one record.
#[tauri::command]
pub async fn discard_recovery(state: State<'_, AppState>, id: RecoveryId) -> Result<(), UiError> {
    let state = state.inner().clone();
    blocking(move || state.discard_recovery(id)).await
}

/// Deletes every record.
#[tauri::command]
pub async fn discard_all_recoveries(state: State<'_, AppState>) -> Result<u32, UiError> {
    let state = state.inner().clone();
    blocking(move || state.discard_all_recoveries()).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::Engine;
    use crate::error::ErrorCode;
    use serde_json::json;

    #[test]
    fn every_stub_answers_not_yet_until_package_b2() {
        let state = AppState::new(Engine::with_handler(|_| {}));
        let unsupported = ErrorCode::UnsupportedFeature;
        assert_eq!(state.list_recoveries().unwrap_err().code(), unsupported);
        assert_eq!(state.restore_recovery(1).unwrap_err().code(), unsupported);
        assert_eq!(state.discard_recovery(1).unwrap_err().code(), unsupported);
        assert_eq!(
            state.discard_all_recoveries().unwrap_err().code(),
            unsupported
        );
    }

    #[test]
    fn an_entry_serializes_without_a_path() {
        let entry = RecoveryEntry {
            id: 3,
            display_name: "a.pdf".into(),
            folder: Some("Taxes".into()),
            saved_at: "2026-10-04T10:00:00Z".into(),
            page_count: 2,
            original: OriginalState::Changed,
        };
        assert_eq!(
            serde_json::to_value(entry).unwrap(),
            json!({ "id": 3, "displayName": "a.pdf", "folder": "Taxes", "savedAt": "2026-10-04T10:00:00Z", "pageCount": 2, "original": "changed" })
        );
    }
}
