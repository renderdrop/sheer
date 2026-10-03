//! Encryption of the saved file (ADR-047 §4).
//!
//! New protection is AES-256 R6 through lopdf (`EncryptionVersion::V5`); a save of an encrypted document keeps its own `/Encrypt` and file
//! key: the file is decrypted first ([`decrypt_for_rewrite`]), goes through the rest of the save as a plain file, and is encrypted again
//! with the state it had ([`encrypt_again`]).

use std::collections::BTreeMap;
use std::sync::Arc;

use lopdf::encryption::crypt_filters::{Aes256CryptFilter, CryptFilter};
use lopdf::encryption::{EncryptionState, EncryptionVersion, Permissions};
use lopdf::{Document, Error as LopdfError, Object};
use serde::Serialize;
use zeroize::Zeroizing;

use super::prescan;
use crate::error::{AppError, ErrorCode};
use crate::model::protection::{Permission, PermissionSet, ProtectionMethod};
use crate::security::secret::{PendingProtection, Secret};

/// What reading the encryption of a file found.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProtectionRead {
    pub encrypted: bool,
    pub method: ProtectionMethod,
    /// The password given (or none needed) is the owner's, or the file's permissions are unrestricted.
    pub owner_rights: bool,
    pub allow: PermissionSet,
}

/// The name of the one crypt filter of a file we encrypt.
const FILTER_NAME: &[u8] = b"StdCF";

/// The permission bits of a restriction (ADR-047 §4): print is print and high quality; copy is copy; edit is modify, annotate, fill and
/// assemble. Extraction for assistive technology stays allowed.
pub fn permissions_of(allow: PermissionSet) -> Permissions {
    let mut bits = Permissions::COPYABLE_FOR_ACCESSIBILITY;
    if allow.contains(Permission::Print) {
        bits |= Permissions::PRINTABLE | Permissions::PRINTABLE_IN_HIGH_QUALITY;
    }
    if allow.contains(Permission::Copy) {
        bits |= Permissions::COPYABLE;
    }
    if allow.contains(Permission::Edit) {
        bits |= Permissions::MODIFIABLE
            | Permissions::ANNOTABLE
            | Permissions::FILLABLE
            | Permissions::ASSEMBLABLE;
    }
    bits
}

/// What a file's permission bits allow: print if the print bit is set, copy if the copy bit is, edit if both modify and annotate are.
pub fn allowed_by(bits: Permissions) -> PermissionSet {
    let mut list = Vec::new();
    if bits.contains(Permissions::PRINTABLE) {
        list.push(Permission::Print);
    }
    if bits.contains(Permissions::COPYABLE) {
        list.push(Permission::Copy);
    }
    if bits.contains(Permissions::MODIFIABLE | Permissions::ANNOTABLE) {
        list.push(Permission::Edit);
    }
    PermissionSet::from_list(&list)
}

fn lopdf_failed(error: impl std::fmt::Display) -> AppError {
    AppError::logged(ErrorCode::SaveFailed, format!("lopdf: {error}"))
}

fn password_required() -> AppError {
    AppError::new(ErrorCode::PasswordRequired)
}

/// Encrypts `doc` with AES-256 R6: a fresh 32-byte file key from `getrandom`, `Aes256CryptFilter` for streams and strings,
/// `encrypt_metadata = true`. `p` is a `Protect`; a `Remove` is an error (the caller writes no `/Encrypt` instead).
pub fn encrypt_r6(doc: &mut Document, p: &PendingProtection) -> Result<(), AppError> {
    let PendingProtection::Protect { open, owner, allow } = p else {
        return Err(AppError::invalid("protection"));
    };
    let mut key = Zeroizing::new([0u8; 32]);
    getrandom::fill(&mut *key)
        .map_err(|_| AppError::logged(ErrorCode::Internal, "no randomness"))?;
    let filter: Arc<dyn CryptFilter> = Arc::new(Aes256CryptFilter);
    let version = EncryptionVersion::V5 {
        encrypt_metadata: true,
        crypt_filters: BTreeMap::from([(FILTER_NAME.to_vec(), filter)]),
        file_encryption_key: &*key,
        stream_filter: FILTER_NAME.to_vec(),
        string_filter: FILTER_NAME.to_vec(),
        owner_password: owner.expose(),
        user_password: open.as_ref().map_or("", Secret::expose),
        permissions: permissions_of(*allow),
    };
    let state = EncryptionState::try_from(version).map_err(lopdf_failed)?;
    doc.encrypt(&state).map_err(lopdf_failed)
}

/// Loads `bytes` through the pre-scan, decrypting with `password` (the empty password is tried first, as every reader does). The state
/// is `None` for a file that is not encrypted. A file that needs a password it did not get, or got wrong, is `password_required`.
pub fn load_decrypted(
    bytes: &[u8],
    password: Option<&str>,
) -> Result<(Document, Option<EncryptionState>), AppError> {
    let loaded = prescan::load_with_password(bytes, password)?;
    let mut doc = loaded.map_err(|error| match error {
        LopdfError::InvalidPassword
        | LopdfError::Decryption(lopdf::encryption::DecryptionError::IncorrectPassword) => {
            password_required()
        }
        other => AppError::logged(ErrorCode::DamagedFile, format!("lopdf: {other}")),
    })?;
    // Still encrypted: nobody could open it.
    if doc.is_encrypted() {
        return Err(password_required());
    }
    let state = doc.encryption_state.take();
    Ok((doc, state))
}

fn method_of(state: &EncryptionState) -> ProtectionMethod {
    if state.version() < 4 {
        return ProtectionMethod::Rc4;
    }
    match state.get_stream_filter().method() {
        b"AESV3" => ProtectionMethod::Aes256,
        b"AESV2" => ProtectionMethod::Aes128,
        b"V2" => ProtectionMethod::Rc4,
        _ => ProtectionMethod::Unknown,
    }
}

/// Whether `password` is the owner password of the file `state` and `doc` describe. The `/Encrypt` dictionary is rebuilt from the state
/// into a scratch document (with the file's `/ID`, which the old revisions hash) so that lopdf's own check can run.
fn is_owner(doc: &Document, state: &EncryptionState, password: &str) -> bool {
    let Ok(dictionary) = state.encode() else {
        return false;
    };
    let mut probe = Document::new();
    let id = probe.add_object(dictionary);
    probe.trailer.set("Encrypt", Object::Reference(id));
    if let Ok(file_id) = doc.trailer.get(b"ID") {
        probe.trailer.set("ID", file_id.clone());
    }
    probe.authenticate_owner_password(password).is_ok()
}

/// Reads how `bytes` is encrypted, authenticating with `password` if given (`password_required` when it is needed and wrong).
pub fn read_protection(
    bytes: &[u8],
    password: Option<&Secret>,
) -> Result<ProtectionRead, AppError> {
    read_protection_with(bytes, password.map(Secret::expose))
}

/// [`read_protection`] with the password the document was opened with, which is the file's and not bound by the new-password rules.
pub fn read_protection_with(
    bytes: &[u8],
    password: Option<&str>,
) -> Result<ProtectionRead, AppError> {
    let (doc, state) = load_decrypted(bytes, password)?;
    let Some(state) = state else {
        return Ok(ProtectionRead {
            encrypted: false,
            method: ProtectionMethod::None,
            owner_rights: true,
            allow: PermissionSet::ALL,
        });
    };
    let allow = allowed_by(state.permissions());
    let owner = is_owner(&doc, &state, password.unwrap_or(""));
    Ok(ProtectionRead {
        encrypted: true,
        method: method_of(&state),
        owner_rights: owner || allow == PermissionSet::ALL,
        allow,
    })
}

/// Whether `password` is the owner password of the encrypted file `bytes` (opened with `session`).
pub fn is_owner_password(
    bytes: &[u8],
    session: Option<&str>,
    password: &Secret,
) -> Result<bool, AppError> {
    let (doc, state) = load_decrypted(bytes, session)?;
    let state = state.ok_or(AppError::invalid("protection"))?;
    Ok(is_owner(&doc, &state, password.expose()))
}

/// The file `bytes` as a plain file, and the encryption it had (for [`encrypt_again`]), if any.
pub fn decrypt_for_rewrite(
    bytes: &[u8],
    password: Option<&str>,
) -> Result<(Vec<u8>, Option<EncryptionState>), AppError> {
    let (mut doc, state) = load_decrypted(bytes, password)?;
    let mut out = Vec::with_capacity(bytes.len());
    doc.save_to(&mut out).map_err(lopdf_failed)?;
    Ok((out, state))
}

/// Encrypts the plain file `bytes` with the `state` it had before [`decrypt_for_rewrite`]: same file key, same passwords.
pub fn encrypt_again(bytes: &[u8], state: &EncryptionState) -> Result<Vec<u8>, AppError> {
    let mut doc = prescan::load_untrusted(bytes)?;
    doc.encrypt(state).map_err(lopdf_failed)?;
    let mut out = Vec::with_capacity(bytes.len());
    doc.save_to(&mut out).map_err(lopdf_failed)?;
    Ok(out)
}

/// Encrypts the plain file `bytes` as `p` says ([`encrypt_r6`]).
pub fn encrypt_bytes(bytes: &[u8], p: &PendingProtection) -> Result<Vec<u8>, AppError> {
    let mut doc = prescan::load_untrusted(bytes)?;
    encrypt_r6(&mut doc, p)?;
    let mut out = Vec::with_capacity(bytes.len());
    doc.save_to(&mut out).map_err(lopdf_failed)?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn permissions_map_both_ways_for_what_we_write() {
        for list in [
            vec![],
            vec![Permission::Print],
            vec![Permission::Copy],
            vec![Permission::Edit],
            vec![Permission::Print, Permission::Edit],
            vec![Permission::Print, Permission::Copy, Permission::Edit],
        ] {
            let set = PermissionSet::from_list(&list);
            assert_eq!(allowed_by(permissions_of(set)), set);
        }
        assert!(
            permissions_of(PermissionSet::NONE).contains(Permissions::COPYABLE_FOR_ACCESSIBILITY)
        );
        assert!(!permissions_of(PermissionSet::NONE).contains(Permissions::PRINTABLE));
    }

    #[test]
    fn a_plain_file_is_not_protected() {
        let bytes = std::fs::read(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/minimal.pdf"),
        )
        .unwrap();
        let read = read_protection(&bytes, None).unwrap();
        assert!(!read.encrypted && read.owner_rights);
        assert_eq!(read.method, ProtectionMethod::None);
    }
}

/// What the integration tests need of lopdf (the guard keeps lopdf out of `tests/`): fixtures in the old revisions and a look at the
/// result. Not part of the app.
#[doc(hidden)]
pub mod testing {
    use super::*;
    use lopdf::encryption::crypt_filters::Aes128CryptFilter;

    /// `bytes` with an `/ID` (R2 to R4 hash it) and encrypted as R2 (`revision` 2), R3 (3) or R4 with AES-128 (anything else), with
    /// every permission.
    pub fn encrypt_legacy(
        bytes: &[u8],
        revision: u8,
        open: &str,
        owner: &str,
    ) -> Result<Vec<u8>, AppError> {
        let mut doc = prescan::load_untrusted(bytes)?;
        let id = Object::string_literal(b"0123456789abcdef".to_vec());
        doc.trailer.set("ID", Object::Array(vec![id.clone(), id]));
        let permissions = Permissions::all();
        let version = match revision {
            2 => EncryptionVersion::V1 {
                document: &doc,
                owner_password: owner,
                user_password: open,
                permissions,
            },
            3 => EncryptionVersion::V2 {
                document: &doc,
                owner_password: owner,
                user_password: open,
                key_length: 128,
                permissions,
            },
            _ => {
                let filter: Arc<dyn CryptFilter> = Arc::new(Aes128CryptFilter);
                EncryptionVersion::V4 {
                    document: &doc,
                    encrypt_metadata: true,
                    crypt_filters: BTreeMap::from([(b"StdCF".to_vec(), filter)]),
                    stream_filter: b"StdCF".to_vec(),
                    string_filter: b"StdCF".to_vec(),
                    owner_password: owner,
                    user_password: open,
                    permissions,
                }
            }
        };
        let state = EncryptionState::try_from(version).map_err(lopdf_failed)?;
        doc.encrypt(&state).map_err(lopdf_failed)?;
        let mut out = Vec::new();
        doc.save_to(&mut out).map_err(lopdf_failed)?;
        Ok(out)
    }

    /// The trailer names an `/Encrypt` dictionary (a file that does not load counts as encrypted: the caller wants "not plain").
    pub fn is_encrypted(bytes: &[u8]) -> bool {
        prescan::load_untrusted(bytes).map_or(true, |doc| doc.is_encrypted() || doc.was_encrypted())
    }

    /// The raw bytes of the string `key` of the trailer's `/Info` of a plain file.
    pub fn info_string(bytes: &[u8], key: &[u8]) -> Option<Vec<u8>> {
        let doc = prescan::load_untrusted(bytes).ok()?;
        let (_, info) = doc.dereference(doc.trailer.get(b"Info").ok()?).ok()?;
        match info.as_dict().ok()?.get(key).ok()? {
            Object::String(text, _) => Some(text.clone()),
            _ => None,
        }
    }

    /// Whether the trailer of a plain file has an `/Info`, and how many pages it has.
    pub fn has_info_and_pages(bytes: &[u8]) -> Option<(bool, usize)> {
        let doc = prescan::load_untrusted(bytes).ok()?;
        Some((doc.trailer.get(b"Info").is_ok(), doc.get_pages().len()))
    }

    /// The text of the catalog's `/Metadata` stream of a plain file.
    pub fn xmp_text(bytes: &[u8]) -> Option<String> {
        let doc = prescan::load_untrusted(bytes).ok()?;
        let catalog = doc.catalog().ok()?;
        let (_, xmp) = doc.dereference(catalog.get(b"Metadata").ok()?).ok()?;
        String::from_utf8(xmp.as_stream().ok()?.content.clone()).ok()
    }
}
