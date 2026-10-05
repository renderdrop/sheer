//! Signing identities (ADR-121 section 3, ARCHITECTURE section 5 "Certificate signatures (v1.4)").
//!
//! | Command | Arguments | Returns |
//! |---|---|---|
//! | `list_signing_identities` | none | `SigningIdentities` (status, at most 8 items) |
//! | `create_signing_identity` | `spec: NewIdentitySpec` | `SigningIdentityInfo` (ECDSA P-256, self-signed, 3 years) |
//! | `pick_identity_file` | none | `IdentityImportTicket \| null` (Rust open dialog; `null` = cancelled) |
//! | `import_signing_identity` | `ticket: number`, `password: string` | `SigningIdentityInfo` |
//! | `discard_identity_import` | `ticket: number` | nothing |
//! | `delete_signing_identity` | `identityId: string` (32 hex) | nothing |
//! | `export_signing_certificate` | `identityId: string` | `boolean` (`false` = dialog cancelled) |
//!
//! Seam of package W0: every command is a stub that answers `unsupported_feature` (`what: "notYet"`) and validates nothing. Package B1
//! fills them in. Private keys, PKCS#12 bytes and the password never go to the webview.

use tauri::State;

use super::{blocking, AppState};
use crate::error::{AppError, UiError};
use crate::pdfsig::types::{
    IdentityImportTicket, NewIdentitySpec, SigningIdentities, SigningIdentityInfo,
};
use crate::security::secret::Secret;

/// The identity store with its status. Stub (package B1): `not_yet`.
#[tauri::command]
pub async fn list_signing_identities(
    state: State<'_, AppState>,
) -> Result<SigningIdentities, UiError> {
    let _ = &state;
    blocking(|| Err::<SigningIdentities, _>(AppError::not_yet())).await
}

/// Makes a self-signed ECDSA P-256 identity. Stub (package B1): `not_yet`.
#[tauri::command]
pub async fn create_signing_identity(
    state: State<'_, AppState>,
    spec: NewIdentitySpec,
) -> Result<SigningIdentityInfo, UiError> {
    let _ = (&state, spec);
    blocking(|| Err::<SigningIdentityInfo, _>(AppError::not_yet())).await
}

/// Lets the user pick a `.p12` or `.pfx` file in a Rust dialog. Stub (package B1): `not_yet`.
#[tauri::command]
pub async fn pick_identity_file(
    state: State<'_, AppState>,
) -> Result<Option<IdentityImportTicket>, UiError> {
    let _ = &state;
    blocking(|| Err::<Option<IdentityImportTicket>, _>(AppError::not_yet())).await
}

/// Decrypts the picked file with `password` and stores its identity. Stub (package B1): `not_yet`.
#[tauri::command]
pub async fn import_signing_identity(
    state: State<'_, AppState>,
    ticket: u32,
    password: Secret,
) -> Result<SigningIdentityInfo, UiError> {
    let _ = (&state, ticket, password);
    blocking(|| Err::<SigningIdentityInfo, _>(AppError::not_yet())).await
}

/// Drops a picked file. An unknown ticket is not an error. Stub (package B1): `not_yet`.
#[tauri::command]
pub async fn discard_identity_import(
    state: State<'_, AppState>,
    ticket: u32,
) -> Result<(), UiError> {
    let _ = (&state, ticket);
    blocking(|| Err::<(), _>(AppError::not_yet())).await
}

/// Deletes an identity. Stub (package B1): `not_yet`.
#[tauri::command]
pub async fn delete_signing_identity(
    state: State<'_, AppState>,
    identity_id: String,
) -> Result<(), UiError> {
    let _ = (&state, identity_id);
    blocking(|| Err::<(), _>(AppError::not_yet())).await
}

/// Writes the public certificate of an identity (`<CN>.cer`, DER) to a file the user picks. Stub (package B1): `not_yet`.
#[tauri::command]
pub async fn export_signing_certificate(
    state: State<'_, AppState>,
    identity_id: String,
) -> Result<bool, UiError> {
    let _ = (&state, identity_id);
    blocking(|| Err::<bool, _>(AppError::not_yet())).await
}
