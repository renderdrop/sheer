//! Pinned signer certificates: `<app data>/signing/trusted.json` (ADR-121 section 4 "Trust"; SECURITY D10, I20, R16).
//!
//! Sheer builds no chain and asks nobody, so the only way a signer becomes trusted is that the user pins that very certificate. A pin is
//! the SHA-256 of the DER certificate (64 lowercase hex digits), the common name it showed and the day it was added; at most
//! `limits::TRUSTED_SIGNERS_MAX`. The fingerprint is read from the document in Rust, never taken from the UI (`commands::sig_validate`).
//!
//! The file is user-writable, so nothing in it is trusted: it is read bounded and entry by entry (a bad entry, a duplicate or an entry
//! past the cap is dropped; a damaged file is an empty list, so a pin is never *invented* by damage). Every write is atomic
//! (`storage::atomic`) and the read-modify-write is serialized in the process.

use std::fs::File;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};

use serde::{Deserialize, Serialize};

use crate::documents::sanitize_text;
use crate::error::{AppError, ErrorCode};
use crate::limits;
use crate::pdfsig::types::TrustedSigner;
use crate::storage::atomic::write_atomic;
use crate::storage::open_without_blocking;

/// Folder and file name inside the app data directory.
pub const DIR_NAME: &str = "signing";
pub const FILE_NAME: &str = "trusted.json";
/// Most bytes of the file that are read: far more than 256 entries need.
const FILE_MAX: u64 = 256 * 1024;
/// Longest common name and date text kept.
const NAME_MAX: usize = 128;
const DATE_MAX: usize = 40;

/// Serializes the read-modify-write of the file in this process.
static WRITE: Mutex<()> = Mutex::new(());

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Stored {
    version: u32,
    signers: Vec<TrustedSigner>,
}

/// The pin store at `<data dir>/signing/trusted.json`.
#[derive(Debug, Clone)]
pub struct TrustStore {
    path: PathBuf,
}

/// Whether `text` is a SHA-256 fingerprint as this store writes it: 64 lowercase hex digits.
pub fn is_fingerprint(text: &str) -> bool {
    text.len() == 64 && text.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

impl TrustStore {
    pub fn in_data_dir(data_dir: &Path) -> Self {
        Self {
            path: data_dir.join(DIR_NAME).join(FILE_NAME),
        }
    }

    /// The pins, oldest first. Never fails: a missing, oversized or damaged file is an empty list.
    pub fn list(&self) -> Vec<TrustedSigner> {
        let bytes = match read_bounded(&self.path) {
            Ok(bytes) => bytes,
            Err(_) => return Vec::new(),
        };
        let Ok(stored) = serde_json::from_slice::<Stored>(&bytes) else {
            return Vec::new();
        };
        let mut out: Vec<TrustedSigner> = Vec::new();
        for signer in stored.signers {
            if out.len() >= limits::TRUSTED_SIGNERS_MAX {
                break;
            }
            if !is_fingerprint(&signer.fingerprint)
                || out.iter().any(|s| s.fingerprint == signer.fingerprint)
            {
                continue;
            }
            out.push(TrustedSigner {
                fingerprint: signer.fingerprint,
                common_name: sanitize_text(&signer.common_name, NAME_MAX),
                added: sanitize_text(&signer.added, DATE_MAX),
            });
        }
        out
    }

    /// The pinned fingerprints.
    pub fn fingerprints(&self) -> std::collections::HashSet<String> {
        self.list().into_iter().map(|s| s.fingerprint).collect()
    }

    /// Pins `fingerprint` (shown as `common_name`, added `added`, ISO 8601). A pin that exists is kept as it is. A 257th is
    /// `limit_exceeded` (`trustedSigners`); a fingerprint that is not 64 lowercase hex digits is `invalid_argument`.
    pub fn add(&self, fingerprint: &str, common_name: &str, added: &str) -> Result<(), AppError> {
        if !is_fingerprint(fingerprint) {
            return Err(AppError::invalid("fingerprint"));
        }
        let _guard = WRITE.lock().unwrap_or_else(PoisonError::into_inner);
        let mut signers = self.list();
        if signers.iter().any(|s| s.fingerprint == fingerprint) {
            return Ok(());
        }
        if signers.len() >= limits::TRUSTED_SIGNERS_MAX {
            return Err(AppError::limit(
                "trustedSigners",
                limits::TRUSTED_SIGNERS_MAX as u64,
            ));
        }
        signers.push(TrustedSigner {
            fingerprint: fingerprint.to_owned(),
            common_name: sanitize_text(common_name, NAME_MAX),
            added: sanitize_text(added, DATE_MAX),
        });
        self.write(signers)
    }

    /// Removes a pin; an unknown fingerprint is `not_found` (`trustedSigner`).
    pub fn remove(&self, fingerprint: &str) -> Result<(), AppError> {
        if !is_fingerprint(fingerprint) {
            return Err(AppError::invalid("fingerprint"));
        }
        let _guard = WRITE.lock().unwrap_or_else(PoisonError::into_inner);
        let mut signers = self.list();
        let before = signers.len();
        signers.retain(|s| s.fingerprint != fingerprint);
        if signers.len() == before {
            return Err(AppError::not_found("trustedSigner"));
        }
        self.write(signers)
    }

    fn write(&self, signers: Vec<TrustedSigner>) -> Result<(), AppError> {
        let bytes = serde_json::to_vec_pretty(&Stored {
            version: 1,
            signers,
        })
        .map_err(|error| AppError::logged(ErrorCode::Internal, format!("trusted.json: {error}")))?;
        write_atomic(&self.path, &bytes)?;
        Ok(())
    }
}

/// Reads at most [`FILE_MAX`] bytes of a regular file, judged on the opened handle.
fn read_bounded(path: &Path) -> io::Result<Vec<u8>> {
    let file: File = open_without_blocking(path)?;
    if !file.metadata()?.is_file() {
        return Err(io::Error::from(io::ErrorKind::InvalidData));
    }
    let mut bytes = Vec::new();
    file.take(FILE_MAX + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > FILE_MAX {
        return Err(io::Error::from(io::ErrorKind::InvalidData));
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::atomic::testutil::TempDir;

    fn fp(n: u32) -> String {
        format!("{n:064x}")
    }

    #[test]
    fn pins_are_added_listed_and_removed() {
        let dir = TempDir::new();
        let store = TrustStore::in_data_dir(dir.path());
        assert!(store.list().is_empty());
        store.add(&fp(1), "Ada", "2026-10-05T10:00:00Z").unwrap();
        store.add(&fp(2), "Bob", "2026-10-06T10:00:00Z").unwrap();
        // A pin that exists stays as it was.
        store
            .add(&fp(1), "Someone else", "2030-01-01T00:00:00Z")
            .unwrap();
        let list = store.list();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].common_name, "Ada");
        assert!(store.fingerprints().contains(&fp(2)));
        store.remove(&fp(1)).unwrap();
        assert_eq!(store.list().len(), 1);
        assert_eq!(
            store.remove(&fp(1)).unwrap_err().code(),
            ErrorCode::NotFound
        );
        assert_eq!(
            store.remove("ABC").unwrap_err().code(),
            ErrorCode::InvalidArgument
        );
        assert!(store.add("G".repeat(64).as_str(), "x", "y").is_err());
        assert!(store.add(&fp(0xabc).to_uppercase(), "x", "y").is_err());
    }

    #[test]
    fn the_cap_is_enforced() {
        let dir = TempDir::new();
        let store = TrustStore::in_data_dir(dir.path());
        for n in 0..limits::TRUSTED_SIGNERS_MAX as u32 {
            store.add(&fp(n), "x", "d").unwrap();
        }
        assert_eq!(
            store.add(&fp(9999), "x", "d").unwrap_err().code(),
            ErrorCode::LimitExceeded
        );
        assert_eq!(store.list().len(), limits::TRUSTED_SIGNERS_MAX);
    }

    #[test]
    fn a_damaged_or_hand_edited_file_never_invents_a_pin() {
        let dir = TempDir::new();
        let store = TrustStore::in_data_dir(dir.path());
        let path = dir.path().join(DIR_NAME).join(FILE_NAME);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        for bad in [&b"{"[..], b"[]", b"", b"\xff\xfe", b"null"] {
            std::fs::write(&path, bad).unwrap();
            assert!(store.list().is_empty());
        }
        let entries = serde_json::json!({
            "version": 1,
            "signers": [
                { "fingerprint": fp(1), "commonName": "ok\u{202e}x", "added": "d" },
                { "fingerprint": fp(1), "commonName": "dup", "added": "d" },
                { "fingerprint": "nothex", "commonName": "bad", "added": "d" },
                { "fingerprint": fp(0xabc).to_uppercase(), "commonName": "upper", "added": "d" },
            ]
        });
        std::fs::write(&path, entries.to_string()).unwrap();
        let list = store.list();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].common_name, "okx", "bidi override stripped");
        // An oversized file is refused whole.
        std::fs::write(&path, vec![b' '; FILE_MAX as usize + 1]).unwrap();
        assert!(store.list().is_empty());
    }
}
