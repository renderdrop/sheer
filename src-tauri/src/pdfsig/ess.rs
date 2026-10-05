//! The ESS `signing-certificate-v2` signed attribute (RFC 5035, PAdES B-B, ADR-121 section 1): it binds the CMS signature to the signer's
//! certificate by its SHA-256, so another certificate with the same name and serial cannot be swapped in.
//!
//! The `cms` builder adds content-type and message-digest itself (a second copy is refused), so this is the only attribute added by hand.

use der::asn1::{Any, OctetString, SetOfVec};
use der::{Decode, Encode, Sequence};
use sha2::{Digest, Sha256};
use spki::ObjectIdentifier;
use x509_cert::attr::Attribute;
use x509_cert::Certificate;

use crate::error::{AppError, ErrorCode};

/// `id-aa-signingCertificateV2` (RFC 5035).
pub const ID_AA_SIGNING_CERTIFICATE_V2: ObjectIdentifier =
    ObjectIdentifier::new_unwrap("1.2.840.113549.1.9.16.2.47");

/// `ESSCertIDv2` with the SHA-256 default and the optional issuer-serial left out, as PAdES writes it.
#[derive(Sequence)]
struct EssCertIdV2 {
    cert_hash: OctetString,
}

/// `SigningCertificateV2` without policies.
#[derive(Sequence)]
struct SigningCertificateV2 {
    certs: Vec<EssCertIdV2>,
}

fn failed(detail: impl std::fmt::Display) -> AppError {
    AppError::logged(
        ErrorCode::SaveFailed,
        format!("signing certificate: {detail}"),
    )
}

/// The `signing-certificate-v2` attribute for `signer`.
pub fn signing_certificate_v2(signer: &Certificate) -> Result<Attribute, AppError> {
    let der = signer.to_der().map_err(failed)?;
    let value = SigningCertificateV2 {
        certs: vec![EssCertIdV2 {
            cert_hash: OctetString::new(Sha256::digest(der).to_vec()).map_err(failed)?,
        }],
    };
    let any = Any::from_der(&value.to_der().map_err(failed)?).map_err(failed)?;
    let mut values = SetOfVec::new();
    values.insert(any).map_err(failed)?;
    Ok(Attribute {
        oid: ID_AA_SIGNING_CERTIFICATE_V2,
        values,
    })
}
