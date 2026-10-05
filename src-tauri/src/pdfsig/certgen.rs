//! The self-signed identity of `create_signing_identity` (ADR-121 section 3): an ECDSA P-256 key and a v3 certificate valid for three years.
//!
//! The key comes from 32 bytes of OS randomness (`getrandom`), the certificate from the `x509-cert` builder with the extensions the
//! ADR lists. Names are built as typed attribute values, never parsed from text, so no input can add or change a name component.

use std::time::{Duration, SystemTime};

use der::asn1::{Ia5String, ObjectIdentifier, SetOfVec};
use der::{Any, Encode, Tag};
use p256::ecdsa::{DerSignature, SigningKey};
use p256::pkcs8::EncodePrivateKey;
use spki::SubjectPublicKeyInfoOwned;
use x509_cert::attr::AttributeTypeAndValue;
use x509_cert::builder::{Builder, CertificateBuilder, Profile};
use x509_cert::ext::pkix::name::GeneralName;
use x509_cert::ext::pkix::{
    BasicConstraints, ExtendedKeyUsage, KeyUsage, KeyUsages, SubjectAltName, SubjectKeyIdentifier,
};
use x509_cert::name::{Name, RdnSequence, RelativeDistinguishedName};
use x509_cert::serial_number::SerialNumber;
use x509_cert::time::{Time, Validity};
use zeroize::Zeroizing;

use super::types::NewIdentitySpec;
use crate::error::{AppError, ErrorCode};
use crate::limits;

const OID_CN: ObjectIdentifier = ObjectIdentifier::new_unwrap("2.5.4.3");
const OID_ORG: ObjectIdentifier = ObjectIdentifier::new_unwrap("2.5.4.10");
const OID_EMAIL: ObjectIdentifier = ObjectIdentifier::new_unwrap("1.2.840.113549.1.9.1");
/// id-kp-documentSigning (RFC 9336) and id-kp-emailProtection.
const OID_EKU_DOCUMENT_SIGNING: ObjectIdentifier =
    ObjectIdentifier::new_unwrap("1.3.6.1.5.5.7.3.36");
const OID_EKU_EMAIL: ObjectIdentifier = ObjectIdentifier::new_unwrap("1.3.6.1.5.5.7.3.4");

/// Three years, with the leap day.
const VALIDITY: Duration = Duration::from_secs(1_096 * 86_400);
/// The certificate starts slightly in the past, so a clock that is a little behind does not make it "not yet valid".
const BACKDATE: Duration = Duration::from_secs(5 * 60);

/// A new identity: the certificate chain (the one self-signed certificate) and the private key as PKCS#8 DER.
pub struct Generated {
    pub chain: Vec<Vec<u8>>,
    pub key_pkcs8: Zeroizing<Vec<u8>>,
}

/// The checked parts of `NewIdentitySpec`.
#[derive(Debug, PartialEq, Eq)]
pub struct Subject {
    pub name: String,
    pub organization: Option<String>,
    pub email: Option<String>,
}

fn clean(text: &str, max: usize, what: &'static str) -> Result<String, AppError> {
    let text = text.trim();
    if text.chars().count() > max || text.chars().any(|c| c.is_control()) {
        return Err(AppError::invalid(what));
    }
    // The same filter the UI applies to names from files: nothing that reorders or hides text.
    if crate::documents::sanitize_text(text, usize::MAX) != text {
        return Err(AppError::invalid(what));
    }
    Ok(text.to_owned())
}

/// An e-mail address in the one shape that is safe to put into a certificate: ASCII, one `@`, no spaces.
fn clean_email(text: &str) -> Result<String, AppError> {
    let text = text.trim();
    let valid = text.len() <= limits::IDENTITY_EMAIL_MAX
        && text.is_ascii()
        && text.bytes().all(|b| b.is_ascii_graphic())
        && text.matches('@').count() == 1
        && !text.starts_with('@')
        && !text.ends_with('@');
    if valid {
        Ok(text.to_owned())
    } else {
        Err(AppError::invalid("email"))
    }
}

impl Subject {
    /// `invalid_argument` (`name`, `organization` or `email`) for a part that is empty, too long or has control or invisible characters.
    pub fn parse(spec: &NewIdentitySpec) -> Result<Self, AppError> {
        let name = clean(&spec.name, limits::IDENTITY_NAME_MAX, "name")?;
        if name.is_empty() {
            return Err(AppError::invalid("name"));
        }
        let organization = spec
            .organization
            .as_deref()
            .map(|text| clean(text, limits::IDENTITY_ORG_MAX, "organization"))
            .transpose()?
            .filter(|text| !text.is_empty());
        let email = spec
            .email
            .as_deref()
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(clean_email)
            .transpose()?;
        Ok(Self {
            name,
            organization,
            email,
        })
    }
}

fn attribute(
    oid: ObjectIdentifier,
    tag: Tag,
    text: &str,
) -> Result<RelativeDistinguishedName, AppError> {
    let value = Any::new(tag, text.as_bytes()).map_err(internal)?;
    let set = SetOfVec::try_from(vec![AttributeTypeAndValue { oid, value }]).map_err(internal)?;
    Ok(RelativeDistinguishedName(set))
}

fn internal(error: impl std::fmt::Display) -> AppError {
    AppError::logged(ErrorCode::Internal, error)
}

fn subject_name(subject: &Subject) -> Result<Name, AppError> {
    let mut rdns = Vec::with_capacity(3);
    if let Some(organization) = &subject.organization {
        rdns.push(attribute(OID_ORG, Tag::Utf8String, organization)?);
    }
    rdns.push(attribute(OID_CN, Tag::Utf8String, &subject.name)?);
    if let Some(email) = &subject.email {
        rdns.push(attribute(OID_EMAIL, Tag::Ia5String, email)?);
    }
    Ok(RdnSequence(rdns))
}

/// A fresh P-256 key from OS randomness. A draw outside the curve order (about 2^-32) is drawn again.
fn new_key() -> Result<SigningKey, AppError> {
    for _ in 0..8 {
        let mut seed = Zeroizing::new([0u8; 32]);
        getrandom::fill(seed.as_mut_slice()).map_err(|_| AppError::new(ErrorCode::Internal))?;
        if let Ok(key) = SigningKey::from_slice(seed.as_slice()) {
            return Ok(key);
        }
    }
    Err(AppError::new(ErrorCode::Internal))
}

/// A positive 16-byte serial number from OS randomness.
fn new_serial() -> Result<SerialNumber, AppError> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| AppError::new(ErrorCode::Internal))?;
    // Positive (top bit clear) and without a leading zero byte (a bit set in the top two).
    bytes[0] = (bytes[0] & 0x3f) | 0x40;
    SerialNumber::new(&bytes).map_err(internal)
}

/// Makes the identity of `spec`: ECDSA P-256, self-signed, valid from five minutes ago for three years. Extensions: basicConstraints
/// CA=false (critical), keyUsage digitalSignature and contentCommitment (critical), extendedKeyUsage documentSigning and
/// emailProtection, the subject key identifier and, with an e-mail, a subjectAltName `rfc822Name`.
pub fn generate(spec: &NewIdentitySpec) -> Result<Generated, AppError> {
    let subject = Subject::parse(spec)?;
    let name = subject_name(&subject)?;
    let key = new_key()?;
    let spki = SubjectPublicKeyInfoOwned::from_key(*key.verifying_key()).map_err(internal)?;

    let now = SystemTime::now();
    let validity = Validity {
        not_before: Time::try_from(now - BACKDATE).map_err(internal)?,
        not_after: Time::try_from(now + VALIDITY).map_err(internal)?,
    };
    let mut builder = CertificateBuilder::new(
        Profile::Manual { issuer: None },
        new_serial()?,
        validity,
        name,
        spki.clone(),
        &key,
    )
    .map_err(internal)?;
    builder
        .add_extension(&BasicConstraints {
            ca: false,
            path_len_constraint: None,
        })
        .map_err(internal)?;
    builder
        .add_extension(&KeyUsage(
            KeyUsages::DigitalSignature | KeyUsages::NonRepudiation,
        ))
        .map_err(internal)?;
    builder
        .add_extension(&ExtendedKeyUsage(vec![
            OID_EKU_DOCUMENT_SIGNING,
            OID_EKU_EMAIL,
        ]))
        .map_err(internal)?;
    builder
        .add_extension(
            &SubjectKeyIdentifier::try_from(der::referenced::OwnedToRef::owned_to_ref(&spki))
                .map_err(internal)?,
        )
        .map_err(internal)?;
    if let Some(email) = &subject.email {
        let address = Ia5String::new(email).map_err(internal)?;
        builder
            .add_extension(&SubjectAltName(vec![GeneralName::Rfc822Name(address)]))
            .map_err(internal)?;
    }
    let cert = builder.build::<DerSignature>().map_err(internal)?;
    let der = cert.to_der().map_err(internal)?;
    let key_pkcs8 = Zeroizing::new(key.to_pkcs8_der().map_err(internal)?.as_bytes().to_vec());
    Ok(Generated {
        chain: vec![der],
        key_pkcs8,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use der::Decode;
    use x509_cert::Certificate;

    fn spec(name: &str, org: Option<&str>, email: Option<&str>) -> NewIdentitySpec {
        NewIdentitySpec {
            name: name.into(),
            email: email.map(Into::into),
            organization: org.map(Into::into),
        }
    }

    #[test]
    fn the_certificate_has_the_profile_of_the_adr() {
        let made = generate(&spec("Ada", Some("Org"), Some("ada@example.org"))).expect("generate");
        let cert = Certificate::from_der(&made.chain[0]).expect("parse");
        let tbs = &cert.tbs_certificate;
        assert_eq!(tbs.version, x509_cert::certificate::Version::V3);
        assert_eq!(tbs.subject, tbs.issuer);
        let serial = tbs.serial_number.as_bytes();
        assert_eq!(serial.len(), 16);
        assert_eq!(serial[0] & 0x80, 0);
        let start = tbs.validity.not_before.to_unix_duration();
        let end = tbs.validity.not_after.to_unix_duration();
        let years = (end - start).as_secs() as f64 / (365.0 * 86_400.0);
        assert!((2.99..3.02).contains(&years), "{years}");
        let now = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .expect("clock");
        assert!(start <= now && now - start < Duration::from_secs(10 * 60));
        let extensions = tbs.extensions.as_ref().expect("extensions");
        let ids: Vec<String> = extensions.iter().map(|e| e.extn_id.to_string()).collect();
        for want in [
            "2.5.29.19",
            "2.5.29.15",
            "2.5.29.37",
            "2.5.29.14",
            "2.5.29.17",
        ] {
            assert!(ids.iter().any(|id| id == want), "{want} in {ids:?}");
        }
        let critical = |oid: &str| {
            extensions
                .iter()
                .find(|e| e.extn_id.to_string() == oid)
                .map(|e| e.critical)
        };
        assert_eq!(critical("2.5.29.19"), Some(true));
        assert_eq!(critical("2.5.29.15"), Some(true));
    }

    #[test]
    fn every_identity_has_its_own_key_and_serial() {
        let a = generate(&spec("Ada", None, None)).expect("a");
        let b = generate(&spec("Ada", None, None)).expect("b");
        assert_ne!(*a.key_pkcs8, *b.key_pkcs8);
        assert_ne!(a.chain[0], b.chain[0]);
        // Without an e-mail there is no subjectAltName.
        let cert = Certificate::from_der(&a.chain[0]).expect("parse");
        let ids: Vec<String> = cert
            .tbs_certificate
            .extensions
            .iter()
            .flatten()
            .map(|e| e.extn_id.to_string())
            .collect();
        assert!(!ids.iter().any(|id| id == "2.5.29.17"));
    }

    #[test]
    fn input_is_checked_and_cannot_change_the_name_structure() {
        assert!(generate(&spec("", None, None)).is_err());
        assert!(generate(&spec("   ", None, None)).is_err());
        assert!(generate(&spec(&"x".repeat(65), None, None)).is_err());
        assert!(generate(&spec(&"x".repeat(64), None, None)).is_ok());
        assert!(generate(&spec("a\nb", None, None)).is_err());
        assert!(generate(&spec("a\u{202e}b", None, None)).is_err());
        assert!(generate(&spec("A", Some(&"o".repeat(65)), None)).is_err());
        for bad in ["no-at", "a@b@c", "@x", "x@", "a b@c", "ü@x.de", "a\n@b"] {
            assert!(generate(&spec("A", None, Some(bad))).is_err(), "{bad}");
        }
        // Empty optional parts are none.
        let subject = Subject::parse(&spec("A", Some(" "), Some(""))).expect("subject");
        assert_eq!((subject.organization, subject.email), (None, None));
        // Separators in a name stay inside the one common name.
        let made = generate(&spec("Ada, O=Evil + CN=Mallory", None, None)).expect("generate");
        let summary = crate::pdfsig::identity::summarize(&made.chain[0]).expect("summary");
        assert_eq!(summary.subject.common_name, "Ada, O=Evil + CN=Mallory");
        assert_eq!(summary.subject.organization, None);
    }
}
