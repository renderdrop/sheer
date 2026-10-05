//! Validating signatures (ADR-121 section 4, ARCHITECTURE section 5 "Certificate signatures (v1.4)", SECURITY I19, I20, P21 to P24).
//!
//! | Command | Arguments | Returns |
//! |---|---|---|
//! | `validate_signatures` | `docId: number` | `SignatureReport` (at most 32 signatures, 60 s) |
//! | `open_signed_revision` | `docId: number`, `signature: number` | `AppEvent` (`opened` as a read-only `signedRevision`, or `openFailed`) |
//! | `set_signer_trust` | `docId: number`, `signature: number`, `trusted: boolean` | `SignatureReport` |
//! | `list_trusted_signers` | none | `TrustedSigner[]` (at most 256) |
//! | `remove_trusted_signer` | `fingerprint: string` (64 lowercase hex) | nothing; unknown is `not_found` |
//!
//! Validation reads the file the document was opened from (judged on the handle, like every read) and runs in this process on the
//! blocking pool, not in the PDFium child: the parsers are safe Rust (`pdfwrite::sigread`, `pdfsig::verify`), bounded, and every check
//! runs under `catch_unwind` with a 60 s budget. The report is computed again on each call (a pin changes only the trust column).
//!
//! Trust: `ownIdentity` for a certificate in the user's own identity store, `trustedByYou` for a pinned fingerprint
//! (`storage::trust`), else `notTrusted`; only for a signature that verifies. The fingerprint of a pin is read here from the
//! document's certificate, never taken from the UI. `open_signed_revision` writes the bytes `[0, b + c)` (exactly what was signed) to a
//! file of this app's own folder and opens it as `DocKind::SignedRevision`: read-only, never a recent. That is the remedy for shadow
//! attacks, which change what a page shows after the signature.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};

use sha2::{Digest, Sha256};
use tauri::State;

use super::identities::IdentitiesState;
use super::save::read_all;
use super::{blocking, AppState, Opened};
use crate::documents::intake;
use crate::documents::{DocKind, DocumentId};
use crate::error::{AppError, ErrorCode, UiError};
use crate::events::AppEvent;
use crate::limits;
use crate::model::geometry::Rect;
use crate::pdfsig::types::{Cryptographic, SealWidget, SignatureReport, Trust, TrustedSigner};
use crate::pdfwrite::sigread::{self, Validation};
use crate::storage::atomic::write_atomic;
use crate::storage::trust::{self, TrustStore};

/// Signed revisions older than this are deleted from their folder when another is opened.
const REVISION_FILE_TTL: Duration = Duration::from_secs(7 * 24 * 60 * 60);
const REVISION_DIR: &str = "revisions";

impl AppState {
    /// The pin store, where there is an app data directory.
    fn trust_store(&self) -> Option<TrustStore> {
        self.data_dir
            .as_deref()
            .map(|dir| TrustStore::in_data_dir(dir))
    }

    /// The bytes of the file document `id` was opened from (the signatures are the file's, not the open model's) and its display name.
    fn signed_file(&self, id: DocumentId) -> Result<(Vec<u8>, String), AppError> {
        let path = self
            .registry
            .path(id)
            .ok_or(AppError::not_found("document"))?;
        let admitted = intake::admit(&path)?;
        let (bytes, _) = read_all(admitted)?;
        let name = self
            .info(id)
            .map(|info| info.display_name)
            .unwrap_or_default();
        Ok((bytes, name))
    }

    fn validate_file(&self, bytes: &[u8]) -> Result<Validation, AppError> {
        sigread::validate_bytes(bytes, Instant::now() + limits::SIG_VALIDATE_TIMEOUT)
    }

    /// Checks every signature of document `id`. `own` yields the fingerprints of the user's own identities; it is called only when a
    /// signature verified.
    pub fn validate_signatures_with(
        &self,
        id: DocumentId,
        own: impl FnOnce() -> HashSet<String>,
    ) -> Result<SignatureReport, AppError> {
        let (bytes, _) = self.signed_file(id)?;
        let validation = self.validate_file(&bytes)?;
        Ok(self.report_of(id, validation, own))
    }

    /// The wire report of `validation`: seals mapped to page ids, trust filled in.
    fn report_of(
        &self,
        id: DocumentId,
        validation: Validation,
        own: impl FnOnce() -> HashSet<String>,
    ) -> SignatureReport {
        let pins = self
            .trust_store()
            .map(|store| store.fingerprints())
            .unwrap_or_default();
        let any_valid = validation
            .signatures
            .iter()
            .any(|s| s.info.cryptographic == Cryptographic::Valid && s.fingerprint.is_some());
        let own = if any_valid { own() } else { HashSet::new() };
        let signatures = validation
            .signatures
            .into_iter()
            .map(|validated| {
                let mut info = validated.info;
                info.trust = match &validated.fingerprint {
                    Some(fp) if info.cryptographic == Cryptographic::Valid => {
                        trust_of(fp, &pins, &own)
                    }
                    _ => Trust::NotTrusted,
                };
                info.widget = match (validated.page_index, validated.rect) {
                    (Some(index), Some([x0, y0, x1, y1])) => self
                        .registry
                        .page_id(id, index)
                        .ok()
                        .map(|page_id| SealWidget {
                            page_id,
                            rect: Rect {
                                x: x0,
                                y: y0,
                                w: x1 - x0,
                                h: y1 - y0,
                            },
                        }),
                    _ => None,
                };
                info
            })
            .collect();
        SignatureReport {
            signatures,
            truncated: validation.truncated,
            lock: validation.lock,
        }
    }

    /// Opens the bytes signature `signature` covers as a read-only `DocKind::SignedRevision` (an `opened` or `openFailed` event).
    /// An unknown document or signature, and one whose byte range does not hold, is an error.
    pub fn open_signed_revision(
        &self,
        id: DocumentId,
        signature: u32,
    ) -> Result<AppEvent, AppError> {
        let (bytes, name) = self.signed_file(id)?;
        let validation = self.validate_file(&bytes)?;
        let end = usize::try_from(signature)
            .ok()
            .and_then(|index| validation.signatures.get(index))
            .ok_or(AppError::not_found("signature"))?
            .signed_end
            .and_then(|end| usize::try_from(end).ok())
            .filter(|end| *end <= bytes.len())
            .ok_or(AppError::invalid("signature"))?;
        let signed = &bytes[..end];
        let folder = self.revision_folder();
        sweep_old(&folder);
        let digest = Sha256::digest(signed);
        let stem: String = digest.iter().take(16).map(|b| format!("{b:02x}")).collect();
        let target = folder.join(format!("signed-{stem}.pdf"));
        write_atomic(&target, signed)?;
        Ok(
            match self.open_as(target.clone(), DocKind::SignedRevision, Some(name)) {
                Ok(Opened::Ready(info)) => AppEvent::opened(info),
                Ok(Opened::Locked { id: locked, .. }) => {
                    self.registry.remove_locked(locked);
                    AppEvent::open_failed(AppError::new(ErrorCode::DamagedFile))
                }
                Ok(Opened::Pending) => AppEvent::open_failed(AppError::new(ErrorCode::Internal)),
                Err(error) => {
                    let _ = std::fs::remove_file(&target);
                    AppEvent::open_failed(error)
                }
            },
        )
    }

    fn revision_folder(&self) -> PathBuf {
        match self.data_dir.as_deref() {
            Some(dir) => dir.join(trust::DIR_NAME).join(REVISION_DIR),
            None => std::env::temp_dir().join("sheer-signed-revisions"),
        }
    }

    /// Pins (`trusted`) or unpins the signer certificate of signature `signature`, read from the file here, and answers the new report.
    /// Pinning needs a signature that verifies (`invalid_argument` `signature` otherwise) and an app data directory.
    pub fn set_signer_trust_with(
        &self,
        id: DocumentId,
        signature: u32,
        trusted: bool,
        own: impl FnOnce() -> HashSet<String>,
    ) -> Result<SignatureReport, AppError> {
        let (bytes, _) = self.signed_file(id)?;
        let validation = self.validate_file(&bytes)?;
        let validated = usize::try_from(signature)
            .ok()
            .and_then(|index| validation.signatures.get(index))
            .ok_or(AppError::not_found("signature"))?;
        let fingerprint = validated
            .fingerprint
            .clone()
            .ok_or(AppError::invalid("signature"))?;
        let store = self.trust_store().ok_or(AppError::invalid("trust"))?;
        if trusted {
            if validated.info.cryptographic != Cryptographic::Valid {
                return Err(AppError::invalid("signature"));
            }
            let name = validated
                .info
                .signer
                .as_ref()
                .map(|signer| signer.subject.common_name.clone())
                .unwrap_or_default();
            store.add(&fingerprint, &name, &now_iso())?;
        } else {
            match store.remove(&fingerprint) {
                Ok(()) => {}
                // Not pinned: nothing to take back.
                Err(error) if error.code() == ErrorCode::NotFound => {}
                Err(error) => return Err(error),
            }
        }
        Ok(self.report_of(id, validation, own))
    }

    /// The pinned signers (empty without an app data directory).
    pub fn list_trusted_signers(&self) -> Vec<TrustedSigner> {
        self.trust_store()
            .map(|store| store.list())
            .unwrap_or_default()
    }

    /// Takes a pin back. `invalid_argument` for something that is not 64 lowercase hex digits, `not_found` for a pin that is not there.
    pub fn remove_trusted_signer(&self, fingerprint: &str) -> Result<(), AppError> {
        if !trust::is_fingerprint(fingerprint) {
            return Err(AppError::invalid("fingerprint"));
        }
        self.trust_store()
            .ok_or(AppError::not_found("trustedSigner"))?
            .remove(fingerprint)
    }
}

/// The trust of a signer that verifies.
pub fn trust_of(fingerprint: &str, pins: &HashSet<String>, own: &HashSet<String>) -> Trust {
    if own.contains(fingerprint) {
        Trust::OwnIdentity
    } else if pins.contains(fingerprint) {
        Trust::TrustedByYou
    } else {
        Trust::NotTrusted
    }
}

fn now_iso() -> String {
    jiff::Timestamp::now().to_string()
}

/// Deletes files of the folder that were last written more than [`REVISION_FILE_TTL`] ago. Best effort.
fn sweep_old(folder: &std::path::Path) {
    let Ok(entries) = std::fs::read_dir(folder) else {
        return;
    };
    let now = SystemTime::now();
    for entry in entries.flatten() {
        let old = entry
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age > REVISION_FILE_TTL);
        let name = entry.file_name();
        let ours = name.to_string_lossy();
        if old && ours.starts_with("signed-") && ours.ends_with(".pdf") {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// The fingerprints of the user's own identities (empty when the store is unavailable: that only means `trustedByYou` or `notTrusted`).
fn own_fingerprints(identities: &IdentitiesState) -> HashSet<String> {
    identities
        .list()
        .map(|list| {
            list.items
                .into_iter()
                .map(|item| item.cert.fingerprint_sha256)
                .collect()
        })
        .unwrap_or_default()
}

/// Checks every signature of document `doc_id`.
#[tauri::command]
pub async fn validate_signatures(
    state: State<'_, AppState>,
    identities: State<'_, IdentitiesState>,
    doc_id: DocumentId,
) -> Result<SignatureReport, UiError> {
    let state = state.inner().clone();
    let identities = Arc::clone(identities.inner());
    blocking(move || state.validate_signatures_with(doc_id, || own_fingerprints(&identities))).await
}

/// Opens the bytes a signature covers as a read-only document.
#[tauri::command]
pub async fn open_signed_revision(
    state: State<'_, AppState>,
    doc_id: DocumentId,
    signature: u32,
) -> Result<AppEvent, UiError> {
    let state = state.inner().clone();
    blocking(move || state.open_signed_revision(doc_id, signature)).await
}

/// Pins or unpins the signer certificate of a signature (read in Rust, never taken from the UI).
#[tauri::command]
pub async fn set_signer_trust(
    state: State<'_, AppState>,
    identities: State<'_, IdentitiesState>,
    doc_id: DocumentId,
    signature: u32,
    trusted: bool,
) -> Result<SignatureReport, UiError> {
    let state = state.inner().clone();
    let identities = Arc::clone(identities.inner());
    blocking(move || {
        state.set_signer_trust_with(doc_id, signature, trusted, || own_fingerprints(&identities))
    })
    .await
}

/// The pinned signer certificates.
#[tauri::command]
pub async fn list_trusted_signers(
    state: State<'_, AppState>,
) -> Result<Vec<TrustedSigner>, UiError> {
    let state = state.inner().clone();
    blocking(move || Ok(state.list_trusted_signers())).await
}

/// Removes a pin. An unknown fingerprint is `not_found`.
#[tauri::command]
pub async fn remove_trusted_signer(
    state: State<'_, AppState>,
    fingerprint: String,
) -> Result<(), UiError> {
    let state = state.inner().clone();
    blocking(move || state.remove_trusted_signer(&fingerprint)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn own_identities_beat_pins_and_both_beat_nothing() {
        let own: HashSet<String> = ["a".repeat(64)].into_iter().collect();
        let pins: HashSet<String> = ["a".repeat(64), "b".repeat(64)].into_iter().collect();
        assert_eq!(trust_of(&"a".repeat(64), &pins, &own), Trust::OwnIdentity);
        assert_eq!(trust_of(&"b".repeat(64), &pins, &own), Trust::TrustedByYou);
        assert_eq!(trust_of(&"c".repeat(64), &pins, &own), Trust::NotTrusted);
    }
}
