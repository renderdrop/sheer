//! Validating signatures (ADR-121 section 4, ARCHITECTURE section 5 "Certificate signatures (v1.4)").
//!
//! | Command | Arguments | Returns |
//! |---|---|---|
//! | `validate_signatures` | `docId: number` | `SignatureReport` (at most 32 signatures, 60 s, cached until reload) |
//! | `open_signed_revision` | `docId: number`, `signature: number` | `AppEvent` (`opened` as a read-only `signedRevision`, or `openFailed`) |
//! | `set_signer_trust` | `docId: number`, `signature: number`, `trusted: boolean` | `SignatureReport` |
//! | `list_trusted_signers` | none | `TrustedSigner[]` (at most 256) |
//! | `remove_trusted_signer` | `fingerprint: string` (64 hex) | nothing |
//!
//! Seam of package W0: every command is a stub that answers `unsupported_feature` (`what: "notYet"`) and validates nothing.
//! Package B3 fills them in.

use tauri::State;

use super::{blocking, AppState};
use crate::documents::DocumentId;
use crate::error::{AppError, UiError};
use crate::events::AppEvent;
use crate::pdfsig::types::{SignatureReport, TrustedSigner};

/// Checks every signature of document `doc_id`. Stub (package B3): `not_yet`.
#[tauri::command]
pub async fn validate_signatures(
    state: State<'_, AppState>,
    doc_id: DocumentId,
) -> Result<SignatureReport, UiError> {
    let _ = (&state, doc_id);
    blocking(|| Err::<SignatureReport, _>(AppError::not_yet())).await
}

/// Opens the bytes a signature covers as a read-only document. Stub (package B3): `not_yet`.
#[tauri::command]
pub async fn open_signed_revision(
    state: State<'_, AppState>,
    doc_id: DocumentId,
    signature: u32,
) -> Result<AppEvent, UiError> {
    let _ = (&state, doc_id, signature);
    blocking(|| Err::<AppEvent, _>(AppError::not_yet())).await
}

/// Pins or unpins the signer certificate of a signature (read in Rust, never taken from the UI). Stub (package B3): `not_yet`.
#[tauri::command]
pub async fn set_signer_trust(
    state: State<'_, AppState>,
    doc_id: DocumentId,
    signature: u32,
    trusted: bool,
) -> Result<SignatureReport, UiError> {
    let _ = (&state, doc_id, signature, trusted);
    blocking(|| Err::<SignatureReport, _>(AppError::not_yet())).await
}

/// The pinned signer certificates. Stub (package B3): `not_yet`.
#[tauri::command]
pub async fn list_trusted_signers(
    state: State<'_, AppState>,
) -> Result<Vec<TrustedSigner>, UiError> {
    let _ = &state;
    blocking(|| Err::<Vec<TrustedSigner>, _>(AppError::not_yet())).await
}

/// Removes a pin. An unknown fingerprint is `not_found`. Stub (package B3): `not_yet`.
#[tauri::command]
pub async fn remove_trusted_signer(
    state: State<'_, AppState>,
    fingerprint: String,
) -> Result<(), UiError> {
    let _ = (&state, fingerprint);
    blocking(|| Err::<(), _>(AppError::not_yet())).await
}
