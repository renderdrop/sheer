//! What a signing identity is made of, read from DER (ADR-121 section 3): the summary the UI sees, the key kind and the check that a
//! private key belongs to its certificate, and the [`SignerMaterial`] for one signature.
//!
//! Bytes in, typed values out. A stored identity is a certificate chain (DER, signer first) and a PKCS#8 private key; the storage layer
//! never parses either. Nothing here logs or returns key bytes: errors are fixed words.

use std::time::SystemTime;

use der::asn1::ObjectIdentifier;
use der::{Decode, Encode, Tag, Tagged};
use p256::pkcs8::DecodePrivateKey;
use pkcs8::PrivateKeyInfo;
use rsa::pkcs8::DecodePublicKey;
use rsa::traits::PublicKeyParts;
use sha2::{Digest, Sha256};
use x509_cert::name::Name;
use x509_cert::Certificate;

use super::material::{SignerKey, SignerMaterial};
use super::types::{CertName, CertSummary, KeyKind};
use crate::documents::sanitize_text;
use crate::error::AppError;
use crate::limits;

const OID_CN: ObjectIdentifier = ObjectIdentifier::new_unwrap("2.5.4.3");
const OID_ORG: ObjectIdentifier = ObjectIdentifier::new_unwrap("2.5.4.10");
const OID_EMAIL: ObjectIdentifier = ObjectIdentifier::new_unwrap("1.2.840.113549.1.9.1");
const OID_EC_PUBLIC_KEY: ObjectIdentifier = ObjectIdentifier::new_unwrap("1.2.840.10045.2.1");
const OID_P256: ObjectIdentifier = ObjectIdentifier::new_unwrap("1.2.840.10045.3.1.7");
const OID_P384: ObjectIdentifier = ObjectIdentifier::new_unwrap("1.3.132.0.34");
const OID_RSA: ObjectIdentifier = ObjectIdentifier::new_unwrap("1.2.840.113549.1.1.1");

/// Smallest and largest RSA modulus an import accepts (ADR-121 section 3).
const RSA_BITS_MIN: usize = 2048;
const RSA_BITS_MAX: usize = 4096;
/// Longest part of a name that is sent to the UI, in characters.
const NAME_PART_MAX: usize = 128;

/// `invalid_argument` `identityFile`: not a certificate or key this app can use.
fn bad_file() -> AppError {
    AppError::invalid("identityFile")
}

fn parse_cert(der: &[u8]) -> Result<Certificate, AppError> {
    Certificate::from_der(der).map_err(|_| bad_file())
}

/// SHA-256 of `der` as 64 lowercase hex digits.
pub fn sha256_hex(der: &[u8]) -> String {
    hex(&Sha256::digest(der))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The text of a string-typed attribute value: UTF8String, PrintableString, IA5String, TeletexString, VisibleString or BMPString.
fn any_text(value: &der::Any) -> Option<String> {
    match value.tag() {
        Tag::Utf8String
        | Tag::PrintableString
        | Tag::Ia5String
        | Tag::TeletexString
        | Tag::VisibleString => Some(String::from_utf8_lossy(value.value()).into_owned()),
        Tag::BmpString => {
            let units: Vec<u16> = value
                .value()
                .as_chunks::<2>()
                .0
                .iter()
                .map(|pair| u16::from_be_bytes(*pair))
                .collect();
            Some(String::from_utf16_lossy(&units))
        }
        _ => None,
    }
}

/// The first value of attribute `oid` in `name`, filtered for display (no control, bidi or invisible characters, at most 128 chars).
fn name_part(name: &Name, oid: &ObjectIdentifier) -> Option<String> {
    name.0
        .iter()
        .flat_map(|rdn| rdn.0.iter())
        .find(|atv| atv.oid == *oid)
        .and_then(|atv| any_text(&atv.value))
        .map(|text| sanitize_text(&text, NAME_PART_MAX))
        .filter(|text| !text.is_empty())
}

fn cert_name(name: &Name) -> CertName {
    CertName {
        common_name: name_part(name, &OID_CN).unwrap_or_default(),
        organization: name_part(name, &OID_ORG),
        email: name_part(name, &OID_EMAIL),
    }
}

fn unix_seconds(time: &x509_cert::time::Time) -> i64 {
    i64::try_from(time.to_unix_duration().as_secs()).unwrap_or(i64::MAX)
}

fn iso(seconds: i64) -> String {
    jiff::Timestamp::from_second(seconds)
        .map(|stamp| stamp.to_string())
        .unwrap_or_default()
}

/// The certificate as the UI may see it.
pub fn summarize(cert_der: &[u8]) -> Result<CertSummary, AppError> {
    let cert = parse_cert(cert_der)?;
    let tbs = &cert.tbs_certificate;
    let mut serial = hex(tbs.serial_number.as_bytes());
    serial.truncate(64);
    Ok(CertSummary {
        subject: cert_name(&tbs.subject),
        issuer: cert_name(&tbs.issuer),
        self_signed: tbs.subject == tbs.issuer,
        not_before: iso(unix_seconds(&tbs.validity.not_before)),
        not_after: iso(unix_seconds(&tbs.validity.not_after)),
        serial_hex: serial,
        fingerprint_sha256: sha256_hex(cert_der),
    })
}

/// Whether the certificate's validity ended before `now`. A certificate that cannot be read counts as expired.
pub fn is_expired(cert_der: &[u8], now: SystemTime) -> bool {
    let Ok(cert) = parse_cert(cert_der) else {
        return true;
    };
    let end = unix_seconds(&cert.tbs_certificate.validity.not_after);
    let now = now
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_or(0, |elapsed| {
            i64::try_from(elapsed.as_secs()).unwrap_or(i64::MAX)
        });
    now > end
}

/// The common name of the certificate (display filtered; empty when it has none).
pub fn common_name(cert_der: &[u8]) -> String {
    parse_cert(cert_der)
        .map(|cert| cert_name(&cert.tbs_certificate.subject).common_name)
        .unwrap_or_default()
}

/// The kind of the PKCS#8 key and whether it belongs to `leaf_der`.
///
/// `invalid_argument` (`identityFile`) for a key that does not parse or does not match the certificate; `unsupported_feature`
/// (`signingKey`) for a kind outside RSA 2048..=4096, EC P-256 and P-384.
pub fn check_key(pkcs8_der: &[u8], leaf_der: &[u8]) -> Result<KeyKind, AppError> {
    let cert = parse_cert(leaf_der)?;
    let spki = &cert.tbs_certificate.subject_public_key_info;
    let info = PrivateKeyInfo::try_from(pkcs8_der).map_err(|_| bad_file())?;
    let algorithm = info.algorithm.oid;
    if algorithm == OID_EC_PUBLIC_KEY {
        let curve = info.algorithm.parameters_oid().map_err(|_| bad_file())?;
        let point = spki.subject_public_key.raw_bytes();
        if curve == OID_P256 {
            let key = p256::ecdsa::SigningKey::from_pkcs8_der(pkcs8_der).map_err(|_| bad_file())?;
            let theirs =
                p256::ecdsa::VerifyingKey::from_sec1_bytes(point).map_err(|_| bad_file())?;
            return (theirs == *key.verifying_key())
                .then_some(KeyKind::EcP256)
                .ok_or_else(bad_file);
        }
        if curve == OID_P384 {
            let key = p384::ecdsa::SigningKey::from_pkcs8_der(pkcs8_der).map_err(|_| bad_file())?;
            let theirs =
                p384::ecdsa::VerifyingKey::from_sec1_bytes(point).map_err(|_| bad_file())?;
            return (theirs == *key.verifying_key())
                .then_some(KeyKind::EcP384)
                .ok_or_else(bad_file);
        }
        return Err(AppError::unsupported("signingKey"));
    }
    if algorithm == OID_RSA {
        let key = rsa::RsaPrivateKey::from_pkcs8_der(pkcs8_der).map_err(|_| bad_file())?;
        let bits = key.n().bits();
        if !(RSA_BITS_MIN..=RSA_BITS_MAX).contains(&bits) {
            return Err(AppError::unsupported("signingKey"));
        }
        let spki_der = spki.to_der().map_err(|_| bad_file())?;
        let theirs = rsa::RsaPublicKey::from_public_key_der(&spki_der).map_err(|_| bad_file())?;
        return (theirs == key.to_public_key())
            .then_some(KeyKind::Rsa {
                bits: u32::try_from(bits).unwrap_or(u32::MAX),
            })
            .ok_or_else(bad_file);
    }
    Err(AppError::unsupported("signingKey"))
}

/// The key and the certificate chain of a stored identity as [`SignerMaterial`] for one signature. The key wipes itself when dropped.
pub fn material(chain_der: &[Vec<u8>], pkcs8_der: &[u8]) -> Result<SignerMaterial, AppError> {
    let chain = chain_der
        .iter()
        .take(limits::SIG_CHAIN_MAX)
        .map(|der| parse_cert(der))
        .collect::<Result<Vec<_>, _>>()?;
    if chain.is_empty() {
        return Err(bad_file());
    }
    let info = PrivateKeyInfo::try_from(pkcs8_der).map_err(|_| bad_file())?;
    let key = if info.algorithm.oid == OID_EC_PUBLIC_KEY {
        match info.algorithm.parameters_oid().map_err(|_| bad_file())? {
            curve if curve == OID_P256 => SignerKey::EcdsaP256(
                p256::ecdsa::SigningKey::from_pkcs8_der(pkcs8_der).map_err(|_| bad_file())?,
            ),
            curve if curve == OID_P384 => SignerKey::EcdsaP384(
                p384::ecdsa::SigningKey::from_pkcs8_der(pkcs8_der).map_err(|_| bad_file())?,
            ),
            _ => return Err(AppError::unsupported("signingKey")),
        }
    } else if info.algorithm.oid == OID_RSA {
        SignerKey::Rsa(Box::new(
            rsa::RsaPrivateKey::from_pkcs8_der(pkcs8_der).map_err(|_| bad_file())?,
        ))
    } else {
        return Err(AppError::unsupported("signingKey"));
    };
    Ok(SignerMaterial { key, chain })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pdfsig::certgen;
    use crate::pdfsig::types::NewIdentitySpec;

    fn spec(name: &str) -> NewIdentitySpec {
        NewIdentitySpec {
            name: name.into(),
            email: Some("ada@example.org".into()),
            organization: Some("Analytical, Inc.".into()),
        }
    }

    #[test]
    fn a_generated_identity_summarizes_and_matches_its_key() {
        let made = certgen::generate(&spec("Ada Lovelace")).expect("generate");
        let summary = summarize(&made.chain[0]).expect("summary");
        assert_eq!(summary.subject.common_name, "Ada Lovelace");
        assert_eq!(
            summary.subject.organization.as_deref(),
            Some("Analytical, Inc.")
        );
        assert_eq!(summary.subject.email.as_deref(), Some("ada@example.org"));
        assert!(summary.self_signed);
        assert_eq!(summary.fingerprint_sha256, sha256_hex(&made.chain[0]));
        assert_eq!(summary.fingerprint_sha256.len(), 64);
        assert!(summary.not_before < summary.not_after);
        assert!(summary.not_after.ends_with('Z'));
        assert_eq!(
            check_key(&made.key_pkcs8, &made.chain[0]).ok(),
            Some(KeyKind::EcP256)
        );
        assert!(!is_expired(&made.chain[0], SystemTime::now()));
        assert!(is_expired(
            &made.chain[0],
            SystemTime::now() + std::time::Duration::from_secs(4 * 365 * 86_400)
        ));
        assert_eq!(common_name(&made.chain[0]), "Ada Lovelace");
    }

    #[test]
    fn a_key_of_another_certificate_does_not_match() {
        let a = certgen::generate(&spec("A")).expect("a");
        let b = certgen::generate(&spec("B")).expect("b");
        let error = check_key(&a.key_pkcs8, &b.chain[0]).expect_err("mismatch");
        assert_eq!(error.code(), crate::error::ErrorCode::InvalidArgument);
    }

    #[test]
    fn other_key_kinds_are_unsupported_and_garbage_is_invalid() {
        let a = certgen::generate(&spec("A")).expect("a");
        // An Ed25519 PrivateKeyInfo.
        let mut ed25519 = vec![
            0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22,
            0x04, 0x20,
        ];
        ed25519.extend_from_slice(&[7; 32]);
        let error = check_key(&ed25519, &a.chain[0]).expect_err("ed25519");
        assert_eq!(error.code(), crate::error::ErrorCode::UnsupportedFeature);
        assert!(check_key(b"junk", &a.chain[0]).is_err());
        assert!(check_key(&a.key_pkcs8, b"junk").is_err());
        assert!(material(&[], &a.key_pkcs8).is_err());
        assert!(summarize(b"junk").is_err());
    }

    #[test]
    fn material_carries_the_p256_key_and_the_chain() {
        let made = certgen::generate(&spec("Ada")).expect("generate");
        let material = material(&made.chain, &made.key_pkcs8).expect("material");
        assert!(matches!(material.key, SignerKey::EcdsaP256(_)));
        assert_eq!(material.chain.len(), 1);
        assert!(material.signer_certificate().is_some());
    }
}
