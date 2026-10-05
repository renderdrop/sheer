//! Wire types of the certificate signatures (ADR-121, ARCHITECTURE section 5 "Certificate signatures (v1.4)").
//!
//! Plain data, no engine and no lopdf: the commands, the validator and the field scan all speak these. Every type that arrives from the
//! UI has serde defaults for what is optional and refuses unknown fields; every type that goes to the UI is camelCase. Nothing here holds
//! key material or a path: private keys, PKCS#12 bytes and passwords never cross IPC (SECURITY I16 to I18).

use serde::{Deserialize, Serialize};

use crate::commands::signatures::SignatureRef;
use crate::documents::PageId;
use crate::model::geometry::Rect;

// --- Identities ------------------------------------------------------------------------------------------------------

/// The kind of a private key.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum KeyKind {
    EcP256,
    EcP384,
    Rsa { bits: u32 },
}

/// A certificate name as the UI may show it (display-name filter, at most 128 characters each).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CertName {
    pub common_name: String,
    pub organization: Option<String>,
    pub email: Option<String>,
}

/// What the UI learns about a certificate. Times are ISO 8601, the serial and the fingerprint lowercase hex.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CertSummary {
    pub subject: CertName,
    pub issuer: CertName,
    pub self_signed: bool,
    pub not_before: String,
    pub not_after: String,
    /// At most 64 hex digits.
    pub serial_hex: String,
    /// SHA-256 of the DER certificate, 64 hex digits.
    pub fingerprint_sha256: String,
}

/// Where an identity came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum IdentitySource {
    Generated,
    Imported,
}

/// A signing identity as the UI sees it: no key bytes, ever.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SigningIdentityInfo {
    #[serde(flatten)]
    pub cert: CertSummary,
    /// 32 lowercase hex digits.
    pub id: String,
    pub source: IdentitySource,
    pub key: KeyKind,
    pub chain_length: u32,
    pub expired: bool,
}

/// State of the identity store, like the signature library's.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StoreStatus {
    Ready,
    Empty,
    Unavailable,
    Locked,
}

/// The answer of `list_signing_identities`: at most `limits::IDENTITIES_MAX` items.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SigningIdentities {
    pub status: StoreStatus,
    pub items: Vec<SigningIdentityInfo>,
}

/// The argument of `create_signing_identity`. `name` is 1..=64 characters; the optional parts default to none.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NewIdentitySpec {
    pub name: String,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub organization: Option<String>,
}

/// A picked identity file waiting under `ticket` for its password. `display_name` is the file's name, never a path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdentityImportTicket {
    pub ticket: u32,
    pub display_name: String,
}

// --- Signing ---------------------------------------------------------------------------------------------------------

/// Where the seal goes: a page and a rectangle in page space (at least 72 x 24 pt, inside the CropBox).
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SealPlacement {
    pub page_id: PageId,
    pub rect: Rect,
}

/// What the certification signature allows later: DocMDP P=2 or P=1. Only the first signature of a document certifies.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SignLock {
    #[default]
    AllowFillAndSign,
    NoChanges,
}

/// The argument of `sign_document`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SignRequest {
    /// 32 lowercase hex digits.
    pub identity_id: String,
    /// `None`: an invisible signature.
    #[serde(default)]
    pub placement: Option<SealPlacement>,
    #[serde(default)]
    pub art: Option<SignatureRef>,
    /// At most `limits::SEAL_REASON_MAX` characters.
    #[serde(default)]
    pub reason: Option<String>,
    /// At most `limits::SEAL_LOCATION_MAX` characters.
    #[serde(default)]
    pub location: Option<String>,
    #[serde(default)]
    pub lock: SignLock,
}

// --- The lock and the report -----------------------------------------------------------------------------------------

/// What Sheer lets the user change in a document that is signed (ADR-121 section 1). Derived from the file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SignatureLock {
    /// Not signed.
    #[default]
    None,
    /// DocMDP P=2, or approval signatures only: fields and further signatures.
    FillAndSign,
    /// DocMDP P=3: also annotations.
    AnnotateFillAndSign,
    /// DocMDP P=1: nothing.
    Locked,
}

impl SignatureLock {
    /// The lock of a signed document from its DocMDP value (`None`: no certification, so approval signatures allow fill and sign).
    pub const fn from_doc_mdp(p: Option<u8>) -> Self {
        match p {
            Some(1) => Self::Locked,
            Some(3) => Self::AnnotateFillAndSign,
            _ => Self::FillAndSign,
        }
    }
}

/// What changed after a signature, by class (the revision diff of package B3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaterChanges {
    pub signatures: bool,
    pub form_fill: bool,
    pub annotations: bool,
    pub other: bool,
}

/// The kind of a signature.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum SignatureKind {
    Certification { p: u8 },
    Approval,
    DocTimestamp,
}

/// The `/SubFilter` of a signature.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SubFilter {
    EtsiCadesDetached,
    AdbePkcs7Detached,
    AdbePkcs7Sha1,
    EtsiRfc3161,
    Other,
}

impl SubFilter {
    /// From the name in the file (without the slash).
    pub fn from_name(name: &[u8]) -> Self {
        match name {
            b"ETSI.CAdES.detached" => Self::EtsiCadesDetached,
            b"adbe.pkcs7.detached" => Self::AdbePkcs7Detached,
            b"adbe.pkcs7.sha1" => Self::AdbePkcs7Sha1,
            b"ETSI.RFC3161" => Self::EtsiRfc3161,
            _ => Self::Other,
        }
    }
}

/// The cryptographic verdict of one signature.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Cryptographic {
    Valid,
    Invalid,
    UnsupportedAlgorithm,
    Malformed,
    Unverifiable,
}

/// The verdict against the DocMDP permission.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Verdict {
    Allowed,
    Disallowed,
}

/// Which bytes the signature covers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Coverage {
    WholeFile,
    EarlierRevision {
        revision: u32,
        later: LaterChanges,
        verdict: Verdict,
    },
}

/// How far the signer is trusted: only by Sheer's own identities or a local pin, never by a chain.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Trust {
    OwnIdentity,
    TrustedByYou,
    NotTrusted,
}

/// Where a seal is on its page.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SealWidget {
    pub page_id: PageId,
    pub rect: Rect,
}

/// One signature of a document, as validated.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignatureInfo {
    pub index: u32,
    /// At most `limits::SIG_FIELD_NAME_MAX` characters.
    pub field_name: String,
    pub kind: SignatureKind,
    pub sub_filter: SubFilter,
    pub signer: Option<CertSummary>,
    /// `/M`, else the CMS signing time; always "claimed by the signer".
    pub claimed_time: Option<String>,
    pub reason: Option<String>,
    pub location: Option<String>,
    pub cryptographic: Cryptographic,
    pub weak_algorithm: bool,
    pub timestamp_present: bool,
    pub coverage: Coverage,
    pub cert_valid_at_claimed_time: bool,
    pub trust: Trust,
    pub widget: Option<SealWidget>,
}

/// The answer of `validate_signatures` and `set_signer_trust`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignatureReport {
    pub signatures: Vec<SignatureInfo>,
    /// A cap (`limits::SIGS_PER_DOC_MAX`, revisions, objects) cut the report short.
    pub truncated: bool,
    pub lock: SignatureLock,
}

/// A pinned signer certificate (`trusted.json`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrustedSigner {
    /// SHA-256 of the DER certificate, 64 lowercase hex digits.
    pub fingerprint: String,
    pub common_name: String,
    /// ISO 8601.
    pub added: String,
}

// --- The field scan (pdfwrite/sigread) -------------------------------------------------------------------------------

/// An object of the file: number and generation.
pub type ObjId = (u32, u16);

/// One signature field of the AcroForm with what its `/V` dictionary says, as read. Nothing is verified: every value is the file's claim
/// and bounded (text at most `limits::SIG_TEXT_READ_MAX` characters).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct SigField {
    /// The field's own object.
    pub object: Option<ObjId>,
    /// The fully qualified name (`parent.child`), at most `limits::SIG_FIELD_NAME_MAX` characters.
    pub name: String,
    /// The `/P` page of the field (or of its first widget), when the file gives one.
    pub page: Option<ObjId>,
    /// The widget rectangle as written, `[llx lly urx ury]`.
    pub rect: Option<[f32; 4]>,
    /// The object of the `/V` signature dictionary; `None` when the value is absent or written inline.
    pub value: Option<ObjId>,
    /// The field has a `/V` dictionary (a referenced one or an inline one): it is signed.
    pub signed: bool,
    /// `/Type` of the value is `/DocTimeStamp`.
    pub doc_timestamp: bool,
    /// `/SubFilter` of the value (the name without the slash).
    pub sub_filter: Option<String>,
    /// `/ByteRange` as written: `None` when absent or not an array of integers.
    pub byte_range: Option<Vec<i64>>,
    /// Length in bytes of the string `/Contents` (decoded); `None` when absent or not a string.
    pub contents_len: Option<usize>,
    /// `/M` as written (`D:...`).
    pub signed_at: Option<String>,
    pub reason: Option<String>,
    pub location: Option<String>,
    pub name_text: Option<String>,
    /// The DocMDP `/P` of this signature's `/Reference`, if it is a certification signature.
    pub cert_p: Option<u8>,
}

/// The signature fields of a document and its certification level.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct SigScan {
    pub fields: Vec<SigField>,
    /// `/Perms /DocMDP` of the catalog: the `/P` of the certification signature (1..=3, 2 when absent); `None`: not certified.
    pub doc_mdp: Option<u8>,
    /// A cap cut the scan short (at most `limits::SIGS_PER_DOC_MAX` fields are kept).
    pub truncated: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn sign_request_takes_defaults_and_refuses_unknown_fields() {
        let request: SignRequest = serde_json::from_value(json!({ "identityId": "00" }))
            .expect("defaults fill the optional parts");
        assert_eq!(request.placement, None);
        assert_eq!(request.lock, SignLock::AllowFillAndSign);
        assert!(
            serde_json::from_value::<SignRequest>(json!({ "identityId": "a", "key": 1 })).is_err()
        );
        let spec: NewIdentitySpec =
            serde_json::from_value(json!({ "name": "Ada" })).expect("defaults");
        assert_eq!((spec.email, spec.organization), (None, None));
        assert!(
            serde_json::from_value::<NewIdentitySpec>(json!({ "name": "Ada", "p12": "x" }))
                .is_err()
        );
    }

    #[test]
    fn wire_shapes_match_the_architecture() {
        assert_eq!(
            serde_json::to_value(KeyKind::EcP256).ok(),
            Some(json!({ "type": "ecP256" }))
        );
        assert_eq!(
            serde_json::to_value(KeyKind::Rsa { bits: 3072 }).ok(),
            Some(json!({ "type": "rsa", "bits": 3072 }))
        );
        assert_eq!(
            serde_json::to_value(SignatureKind::Certification { p: 2 }).ok(),
            Some(json!({ "type": "certification", "p": 2 }))
        );
        assert_eq!(
            serde_json::to_value(Coverage::EarlierRevision {
                revision: 1,
                later: LaterChanges {
                    form_fill: true,
                    ..LaterChanges::default()
                },
                verdict: Verdict::Allowed,
            })
            .ok(),
            Some(json!({
                "type": "earlierRevision", "revision": 1, "verdict": "allowed",
                "later": { "signatures": false, "formFill": true, "annotations": false, "other": false }
            }))
        );
        assert_eq!(
            serde_json::to_value(SignatureLock::AnnotateFillAndSign).ok(),
            Some(json!("annotateFillAndSign"))
        );
        assert_eq!(
            serde_json::to_value(SubFilter::EtsiCadesDetached).ok(),
            Some(json!("etsiCadesDetached"))
        );
    }

    #[test]
    fn the_lock_follows_doc_mdp() {
        assert_eq!(
            SignatureLock::from_doc_mdp(None),
            SignatureLock::FillAndSign
        );
        assert_eq!(SignatureLock::from_doc_mdp(Some(1)), SignatureLock::Locked);
        assert_eq!(
            SignatureLock::from_doc_mdp(Some(2)),
            SignatureLock::FillAndSign
        );
        assert_eq!(
            SignatureLock::from_doc_mdp(Some(3)),
            SignatureLock::AnnotateFillAndSign
        );
    }

    #[test]
    fn sub_filters_are_read_by_name() {
        assert_eq!(
            SubFilter::from_name(b"ETSI.CAdES.detached"),
            SubFilter::EtsiCadesDetached
        );
        assert_eq!(
            SubFilter::from_name(b"adbe.x509.rsa_sha1"),
            SubFilter::Other
        );
    }
}
