//! Encryption of the saved file (ADR-047 §4). owned by package D.
//!
//! New protection is AES-256 R6 through lopdf (`EncryptionVersion::V5`); a save of an encrypted document keeps its own `/Encrypt`.

use lopdf::Document;
use serde::Serialize;

use crate::error::AppError;
use crate::model::protection::{PermissionSet, ProtectionMethod};
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

/// Encrypts `doc` with AES-256 R6: a fresh 32-byte file key from `getrandom`, `Aes256CryptFilter` for streams and strings,
/// `encrypt_metadata = true`. `p` is a `Protect`; a `Remove` is an error (the caller writes no `/Encrypt` instead).
pub fn encrypt_r6(_doc: &mut Document, _p: &PendingProtection) -> Result<(), AppError> {
    Err(AppError::not_yet())
}

/// Reads how `bytes` is encrypted, authenticating with `password` if given (`password_required` when it is needed and wrong).
pub fn read_protection(
    _bytes: &[u8],
    _password: Option<&Secret>,
) -> Result<ProtectionRead, AppError> {
    Err(AppError::not_yet())
}
