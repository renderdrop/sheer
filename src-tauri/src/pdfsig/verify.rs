//! Verifying one CMS signature of a PDF (ADR-121 section 4 steps i, iii to vi; SECURITY P22).
//!
//! [`check`] takes the decoded `/Contents` and the signed byte ranges as a reader and answers with a typed [`SignatureCheck`]: bytes
//! in, typed values out, no lopdf. The CMS is hostile input. It is size-capped before it is looked at, BER (indefinite lengths,
//! constructed octet strings) is normalized to DER by a bounded pass, and decoding is typed (`cms`, `x509-cert`; an `Any` is only
//! decoded as the one type expected). A panic inside is caught and answers `malformed`.
//!
//! Supported: ECDSA P-256 and P-384, RSA PKCS#1 v1.5, with SHA-256, SHA-384 and SHA-512; SHA-1 is verified and flagged weak. RSA-PSS
//! and signatures without signed attributes are `unsupportedAlgorithm`. No chain is built, nothing is fetched: the signer is the
//! certificate the CMS names, and what is known of it is whether it is self-signed and whether it was valid at the claimed time.

use std::io::Read;
use std::panic::{catch_unwind, AssertUnwindSafe};

use cms::cert::{CertificateChoices, IssuerAndSerialNumber};
use cms::content_info::ContentInfo;
use cms::signed_data::{SignedData, SignerIdentifier, SignerInfo};
use der::asn1::{Any, ObjectIdentifier, OctetString, UintRef};
use der::{Decode, Encode, Sequence};
use rsa::pkcs1v15::Pkcs1v15Sign;
use rsa::traits::PublicKeyParts;
use rsa::{BigUint, RsaPublicKey};
use sha1::Sha1;
use sha2::{Digest, Sha256, Sha384, Sha512};
use spki::AlgorithmIdentifierOwned;
use x509_cert::name::Name;
use x509_cert::time::Time;
use x509_cert::Certificate;

use crate::documents::sanitize_text;
use crate::limits;
use crate::pdfsig::types::{CertName, CertSummary, Cryptographic, SubFilter};

/// Longest text of a certificate name that is shown.
const NAME_MAX: usize = 128;
/// Deepest nesting of the BER normalizer.
const BER_DEPTH_MAX: usize = 32;
/// Longest tag (in bytes) the BER normalizer takes.
const TAG_BYTES_MAX: usize = 6;

const OID_SIGNED_DATA: &str = "1.2.840.113549.1.7.2";
const OID_DATA: &str = "1.2.840.113549.1.7.1";
const OID_CONTENT_TYPE: &str = "1.2.840.113549.1.9.3";
const OID_MESSAGE_DIGEST: &str = "1.2.840.113549.1.9.4";
const OID_SIGNING_TIME: &str = "1.2.840.113549.1.9.5";
const OID_SIGNING_CERT: &str = "1.2.840.113549.1.9.16.2.12";
const OID_SIGNING_CERT_V2: &str = "1.2.840.113549.1.9.16.2.47";
const OID_TIMESTAMP_TOKEN: &str = "1.2.840.113549.1.9.16.2.14";
const OID_COMMON_NAME: &str = "2.5.4.3";
const OID_ORGANIZATION: &str = "2.5.4.10";
const OID_EMAIL: &str = "1.2.840.113549.1.9.1";
const OID_SKI: &str = "2.5.29.14";
const OID_RSA: &str = "1.2.840.113549.1.1.1";
const OID_EC: &str = "1.2.840.10045.2.1";
const OID_P256: &str = "1.2.840.10045.3.1.7";
const OID_P384: &str = "1.3.132.0.34";

fn oid(text: &str) -> ObjectIdentifier {
    // The constants above are well-formed; a mistake would make every comparison fail, never panic.
    ObjectIdentifier::new(text).unwrap_or(ObjectIdentifier::new_unwrap("0.0.0"))
}

// --- The result ---------------------------------------------------------------------------------------------------------

/// One signature as the file holds it.
#[derive(Debug, Clone, Copy)]
pub struct RawSignature<'a> {
    pub sub_filter: SubFilter,
    /// The decoded `/Contents` (with its zero padding).
    pub contents: &'a [u8],
    /// The claimed time (`/M`) as Unix seconds; the CMS signing time is the fallback for the validity check.
    pub claimed_unix: Option<i64>,
}

/// What was found out about one signature.
#[derive(Debug, Clone, PartialEq)]
pub struct SignatureCheck {
    pub cryptographic: Cryptographic,
    pub weak_algorithm: bool,
    pub signer: Option<CertSummary>,
    /// SHA-256 of the signer certificate, 64 lowercase hex digits (what a pin holds).
    pub signer_fingerprint: Option<String>,
    /// The CMS signing-time attribute as ISO 8601 (UTC), if the signer wrote one.
    pub cms_signing_time: Option<String>,
    pub timestamp_present: bool,
    pub cert_valid_at_claimed_time: bool,
}

impl SignatureCheck {
    fn new(cryptographic: Cryptographic) -> Self {
        Self {
            cryptographic,
            weak_algorithm: false,
            signer: None,
            signer_fingerprint: None,
            cms_signing_time: None,
            timestamp_present: false,
            cert_valid_at_claimed_time: false,
        }
    }
}

/// Step (iii) to (vi) for one signature. `ranges` yields the signed bytes (the two byte ranges, in order); it is read once, in
/// 64 KiB pieces. Never panics: a panic is `malformed`.
pub fn check(sig: &RawSignature<'_>, ranges: &mut dyn Read) -> SignatureCheck {
    let mut out = SignatureCheck::new(Cryptographic::Unverifiable);
    let result = catch_unwind(AssertUnwindSafe(|| check_inner(sig, ranges, &mut out)));
    out.cryptographic = match result {
        Ok(Ok(())) => Cryptographic::Valid,
        Ok(Err(verdict)) => verdict,
        Err(_) => Cryptographic::Malformed,
    };
    out
}

type Verdict<T> = Result<T, Cryptographic>;

fn check_inner(
    sig: &RawSignature<'_>,
    ranges: &mut dyn Read,
    out: &mut SignatureCheck,
) -> Verdict<()> {
    match sig.sub_filter {
        SubFilter::EtsiCadesDetached | SubFilter::AdbePkcs7Detached | SubFilter::AdbePkcs7Sha1 => {}
        // A document timestamp: reported as such, not verified.
        SubFilter::EtsiRfc3161 => {
            out.timestamp_present = true;
            return Err(Cryptographic::Unverifiable);
        }
        SubFilter::Other => return Err(Cryptographic::UnsupportedAlgorithm),
    }
    if sig.contents.len() > limits::SIG_CONTENTS_READ_MAX {
        return Err(Cryptographic::Malformed);
    }
    let der = ber_to_der(sig.contents).ok_or(Cryptographic::Malformed)?;
    let info = ContentInfo::from_der(&der).map_err(|_| Cryptographic::Malformed)?;
    if info.content_type != oid(OID_SIGNED_DATA) {
        return Err(Cryptographic::Malformed);
    }
    let signed: SignedData = info
        .content
        .decode_as()
        .map_err(|_| Cryptographic::Malformed)?;
    if signed.signer_infos.0.len() != 1 {
        return Err(Cryptographic::Malformed);
    }
    let signer = signed
        .signer_infos
        .0
        .iter()
        .next()
        .ok_or(Cryptographic::Malformed)?;
    let mut certs: Vec<Certificate> = Vec::new();
    if let Some(set) = &signed.certificates {
        if set.0.len() > limits::SIG_CMS_CERTS_MAX {
            return Err(Cryptographic::Malformed);
        }
        for choice in set.0.iter() {
            if let CertificateChoices::Certificate(cert) = choice {
                certs.push(cert.clone());
            }
        }
    }
    let attrs = signer
        .signed_attrs
        .as_ref()
        .ok_or(Cryptographic::UnsupportedAlgorithm)?;
    if attrs.len() > limits::SIG_ATTRS_MAX {
        return Err(Cryptographic::Malformed);
    }
    for attr in attrs.iter() {
        if attr
            .values
            .iter()
            .any(|value| value.value().len() > limits::SIG_ATTR_VALUE_MAX)
        {
            return Err(Cryptographic::Malformed);
        }
    }
    if signer
        .unsigned_attrs
        .as_ref()
        .is_some_and(|unsigned| unsigned.iter().any(|a| a.oid == oid(OID_TIMESTAMP_TOKEN)))
    {
        out.timestamp_present = true;
    }

    // The signer's certificate is the one the SignerInfo names; without it nothing can be verified.
    let cert = find_signer_cert(&certs, &signer.sid).ok_or(Cryptographic::Unverifiable)?;
    let cert_der = cert.to_der().map_err(|_| Cryptographic::Malformed)?;
    out.signer = Some(summarize(cert, &cert_der));
    out.signer_fingerprint = Some(hex(&Sha256::digest(&cert_der)));

    let digest_alg =
        HashAlg::from_oid(&signer.digest_alg.oid).ok_or(Cryptographic::UnsupportedAlgorithm)?;
    out.weak_algorithm = digest_alg == HashAlg::Sha1;

    // The signed time and the validity of the certificate at the claimed time.
    let cms_time = attr_value(attrs.iter(), OID_SIGNING_TIME)
        .and_then(|any| any.to_der().ok().and_then(|der| Time::from_der(&der).ok()));
    let cms_unix = cms_time.map(|t| unix_of(&t));
    out.cms_signing_time = cms_unix.and_then(iso_utc);
    if let Some(at) = sig.claimed_unix.or(cms_unix) {
        let validity = &cert.tbs_certificate.validity;
        out.cert_valid_at_claimed_time =
            unix_of(&validity.not_before) <= at && at <= unix_of(&validity.not_after);
    }

    // What the message-digest attribute has to equal.
    let content_digest = match sig.sub_filter {
        SubFilter::AdbePkcs7Sha1 => {
            // The signed content is the SHA-1 of the ranges, encapsulated in the CMS.
            out.weak_algorithm = true;
            let embedded = signed
                .encap_content_info
                .econtent
                .as_ref()
                .and_then(|any| any.decode_as::<OctetString>().ok())
                .ok_or(Cryptographic::Malformed)?;
            let ranges_hash = hash_stream(HashAlg::Sha1, ranges)?;
            if embedded.as_bytes() != ranges_hash.as_slice() {
                return Err(Cryptographic::Invalid);
            }
            hash_bytes(digest_alg, embedded.as_bytes())
        }
        _ => hash_stream(digest_alg, ranges)?,
    };
    let claimed_digest = single_attr(attrs.iter(), OID_MESSAGE_DIGEST)?
        .decode_as::<OctetString>()
        .map_err(|_| Cryptographic::Malformed)?;
    let content_type = single_attr(attrs.iter(), OID_CONTENT_TYPE)?
        .decode_as::<ObjectIdentifier>()
        .map_err(|_| Cryptographic::Malformed)?;
    if content_type != oid(OID_DATA) {
        return Err(Cryptographic::Malformed);
    }
    if claimed_digest.as_bytes() != content_digest.as_slice() {
        return Err(Cryptographic::Invalid);
    }
    check_ess(attrs.iter(), &cert_der)?;

    // The signature covers the DER of the signed attributes as a SET OF.
    let signed_bytes = attrs.to_der().map_err(|_| Cryptographic::Malformed)?;
    verify_signature(cert, signer, digest_alg, &signed_bytes, out)
}

fn find_signer_cert<'a>(
    certs: &'a [Certificate],
    sid: &SignerIdentifier,
) -> Option<&'a Certificate> {
    match sid {
        SignerIdentifier::IssuerAndSerialNumber(IssuerAndSerialNumber {
            issuer,
            serial_number,
        }) => certs.iter().find(|cert| {
            &cert.tbs_certificate.issuer == issuer
                && &cert.tbs_certificate.serial_number == serial_number
        }),
        SignerIdentifier::SubjectKeyIdentifier(ski) => certs
            .iter()
            .find(|cert| subject_key_id(cert).is_some_and(|id| id.as_slice() == ski.0.as_bytes())),
    }
}

fn subject_key_id(cert: &Certificate) -> Option<Vec<u8>> {
    let extension = cert
        .tbs_certificate
        .extensions
        .as_ref()?
        .iter()
        .find(|e| e.extn_id == oid(OID_SKI))?;
    let id = OctetString::from_der(extension.extn_value.as_bytes()).ok()?;
    Some(id.as_bytes().to_vec())
}

fn attr_value<'a>(
    mut attrs: impl Iterator<Item = &'a x509_cert::attr::Attribute>,
    which: &str,
) -> Option<&'a Any> {
    let which = oid(which);
    attrs
        .find(|attr| attr.oid == which)
        .and_then(|attr| attr.values.iter().next())
}

/// The one value of an attribute that must be present exactly once with exactly one value.
fn single_attr<'a>(
    attrs: impl Iterator<Item = &'a x509_cert::attr::Attribute>,
    which: &str,
) -> Verdict<&'a Any> {
    let which = oid(which);
    let mut found = None;
    for attr in attrs.filter(|attr| attr.oid == which) {
        if found.is_some() || attr.values.len() != 1 {
            return Err(Cryptographic::Malformed);
        }
        found = attr.values.iter().next();
    }
    found.ok_or(Cryptographic::Malformed)
}

// --- signing-certificate (ESS) --------------------------------------------------------------------------------------------

#[derive(Sequence)]
struct EssCertIdV2 {
    #[asn1(optional = "true")]
    hash_alg: Option<AlgorithmIdentifierOwned>,
    cert_hash: OctetString,
    #[asn1(optional = "true")]
    issuer_serial: Option<Any>,
}

#[derive(Sequence)]
struct SigningCertificateV2 {
    certs: Vec<EssCertIdV2>,
    #[asn1(optional = "true")]
    policies: Option<Any>,
}

#[derive(Sequence)]
struct EssCertId {
    cert_hash: OctetString,
    #[asn1(optional = "true")]
    issuer_serial: Option<Any>,
}

#[derive(Sequence)]
struct SigningCertificate {
    certs: Vec<EssCertId>,
    #[asn1(optional = "true")]
    policies: Option<Any>,
}

/// The signing-certificate attribute, when present, has to name the signer's certificate (a swap of the certificate is otherwise
/// not covered by the signature).
fn check_ess<'a>(
    attrs: impl Iterator<Item = &'a x509_cert::attr::Attribute> + Clone,
    cert_der: &[u8],
) -> Verdict<()> {
    if let Some(any) = attr_value(attrs.clone(), OID_SIGNING_CERT_V2) {
        let ess: SigningCertificateV2 = any.decode_as().map_err(|_| Cryptographic::Malformed)?;
        let first = ess.certs.first().ok_or(Cryptographic::Malformed)?;
        let alg = match &first.hash_alg {
            Some(alg) => HashAlg::from_oid(&alg.oid).ok_or(Cryptographic::UnsupportedAlgorithm)?,
            None => HashAlg::Sha256,
        };
        if first.cert_hash.as_bytes() != hash_bytes(alg, cert_der).as_slice() {
            return Err(Cryptographic::Invalid);
        }
    }
    if let Some(any) = attr_value(attrs, OID_SIGNING_CERT) {
        let ess: SigningCertificate = any.decode_as().map_err(|_| Cryptographic::Malformed)?;
        let first = ess.certs.first().ok_or(Cryptographic::Malformed)?;
        if first.cert_hash.as_bytes() != hash_bytes(HashAlg::Sha1, cert_der).as_slice() {
            return Err(Cryptographic::Invalid);
        }
    }
    Ok(())
}

// --- hashes ---------------------------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HashAlg {
    Sha1,
    Sha256,
    Sha384,
    Sha512,
}

impl HashAlg {
    fn from_oid(id: &ObjectIdentifier) -> Option<Self> {
        [
            ("1.3.14.3.2.26", Self::Sha1),
            ("2.16.840.1.101.3.4.2.1", Self::Sha256),
            ("2.16.840.1.101.3.4.2.2", Self::Sha384),
            ("2.16.840.1.101.3.4.2.3", Self::Sha512),
        ]
        .into_iter()
        .find(|(text, _)| *id == oid(text))
        .map(|(_, alg)| alg)
    }

    /// The DigestInfo prefix of PKCS#1 v1.5 (RFC 8017 section 9.2, note 1) and the hash length.
    fn digest_info(self) -> (&'static [u8], usize) {
        match self {
            Self::Sha1 => (
                &[
                    0x30, 0x21, 0x30, 0x09, 0x06, 0x05, 0x2b, 0x0e, 0x03, 0x02, 0x1a, 0x05, 0x00,
                    0x04, 0x14,
                ],
                20,
            ),
            Self::Sha256 => (
                &[
                    0x30, 0x31, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04,
                    0x02, 0x01, 0x05, 0x00, 0x04, 0x20,
                ],
                32,
            ),
            Self::Sha384 => (
                &[
                    0x30, 0x41, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04,
                    0x02, 0x02, 0x05, 0x00, 0x04, 0x30,
                ],
                48,
            ),
            Self::Sha512 => (
                &[
                    0x30, 0x51, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04,
                    0x02, 0x03, 0x05, 0x00, 0x04, 0x40,
                ],
                64,
            ),
        }
    }
}

enum Hasher {
    S1(Sha1),
    S256(Sha256),
    S384(Sha384),
    S512(Sha512),
}

impl Hasher {
    fn new(alg: HashAlg) -> Self {
        match alg {
            HashAlg::Sha1 => Self::S1(Sha1::new()),
            HashAlg::Sha256 => Self::S256(Sha256::new()),
            HashAlg::Sha384 => Self::S384(Sha384::new()),
            HashAlg::Sha512 => Self::S512(Sha512::new()),
        }
    }

    fn update(&mut self, data: &[u8]) {
        match self {
            Self::S1(h) => h.update(data),
            Self::S256(h) => h.update(data),
            Self::S384(h) => h.update(data),
            Self::S512(h) => h.update(data),
        }
    }

    fn finish(self) -> Vec<u8> {
        match self {
            Self::S1(h) => h.finalize().to_vec(),
            Self::S256(h) => h.finalize().to_vec(),
            Self::S384(h) => h.finalize().to_vec(),
            Self::S512(h) => h.finalize().to_vec(),
        }
    }
}

fn hash_bytes(alg: HashAlg, data: &[u8]) -> Vec<u8> {
    let mut hasher = Hasher::new(alg);
    hasher.update(data);
    hasher.finish()
}

fn hash_stream(alg: HashAlg, reader: &mut dyn Read) -> Verdict<Vec<u8>> {
    let mut hasher = Hasher::new(alg);
    let mut buffer = vec![0u8; 64 * 1024];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(n) => hasher.update(&buffer[..n]),
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
            Err(_) => return Err(Cryptographic::Unverifiable),
        }
    }
    Ok(hasher.finish())
}

// --- the signature --------------------------------------------------------------------------------------------------------

#[derive(Sequence)]
struct RsaPublicKeyDer<'a> {
    n: UintRef<'a>,
    e: UintRef<'a>,
}

/// Which family and, if the algorithm names it, which hash a signature algorithm OID stands for.
fn signature_algorithm(id: &ObjectIdentifier) -> Option<(bool /* rsa */, Option<HashAlg>)> {
    const TABLE: [(&str, bool, Option<HashAlg>); 10] = [
        ("1.2.840.113549.1.1.1", true, None),
        ("1.2.840.113549.1.1.5", true, Some(HashAlg::Sha1)),
        ("1.2.840.113549.1.1.11", true, Some(HashAlg::Sha256)),
        ("1.2.840.113549.1.1.12", true, Some(HashAlg::Sha384)),
        ("1.2.840.113549.1.1.13", true, Some(HashAlg::Sha512)),
        ("1.2.840.10045.2.1", false, None),
        ("1.2.840.10045.4.1", false, Some(HashAlg::Sha1)),
        ("1.2.840.10045.4.3.2", false, Some(HashAlg::Sha256)),
        ("1.2.840.10045.4.3.3", false, Some(HashAlg::Sha384)),
        ("1.2.840.10045.4.3.4", false, Some(HashAlg::Sha512)),
    ];
    TABLE
        .iter()
        .find(|(text, _, _)| *id == oid(text))
        .map(|(_, rsa, hash)| (*rsa, *hash))
}

fn verify_signature(
    cert: &Certificate,
    signer: &SignerInfo,
    digest_alg: HashAlg,
    message: &[u8],
    out: &mut SignatureCheck,
) -> Verdict<()> {
    let (rsa_alg, hash) = signature_algorithm(&signer.signature_algorithm.oid)
        .ok_or(Cryptographic::UnsupportedAlgorithm)?;
    let hash = hash.unwrap_or(digest_alg);
    if hash == HashAlg::Sha1 {
        out.weak_algorithm = true;
    }
    let digest = hash_bytes(hash, message);
    let key_info = &cert.tbs_certificate.subject_public_key_info;
    let key_bytes = key_info.subject_public_key.raw_bytes();
    let signature = signer.signature.as_bytes();
    let key_oid = &key_info.algorithm.oid;
    if *key_oid == oid(OID_RSA) {
        if !rsa_alg {
            return Err(Cryptographic::UnsupportedAlgorithm);
        }
        let key = RsaPublicKeyDer::from_der(key_bytes).map_err(|_| Cryptographic::Malformed)?;
        let public = RsaPublicKey::new(
            BigUint::from_bytes_be(key.n.as_bytes()),
            BigUint::from_bytes_be(key.e.as_bytes()),
        )
        .map_err(|_| Cryptographic::UnsupportedAlgorithm)?;
        if public.size() < 256 {
            out.weak_algorithm = true;
        }
        let (prefix, hash_len) = hash.digest_info();
        let scheme = Pkcs1v15Sign {
            hash_len: Some(hash_len),
            prefix: prefix.to_vec().into_boxed_slice(),
        };
        public
            .verify(scheme, &digest, signature)
            .map_err(|_| Cryptographic::Invalid)
    } else if *key_oid == oid(OID_EC) {
        if rsa_alg {
            return Err(Cryptographic::UnsupportedAlgorithm);
        }
        let curve = key_info
            .algorithm
            .parameters
            .as_ref()
            .and_then(|any| any.decode_as::<ObjectIdentifier>().ok())
            .ok_or(Cryptographic::Malformed)?;
        verify_ecdsa(&curve, key_bytes, &digest, signature)
    } else {
        Err(Cryptographic::UnsupportedAlgorithm)
    }
}

fn verify_ecdsa(
    curve: &ObjectIdentifier,
    point: &[u8],
    digest: &[u8],
    signature: &[u8],
) -> Verdict<()> {
    use p256::ecdsa::signature::hazmat::PrehashVerifier;
    if *curve == oid(OID_P256) {
        let key = p256::ecdsa::VerifyingKey::from_sec1_bytes(point)
            .map_err(|_| Cryptographic::Malformed)?;
        let sig =
            p256::ecdsa::Signature::from_der(signature).map_err(|_| Cryptographic::Invalid)?;
        key.verify_prehash(digest, &sig)
            .map_err(|_| Cryptographic::Invalid)
    } else if *curve == oid(OID_P384) {
        let key = p384::ecdsa::VerifyingKey::from_sec1_bytes(point)
            .map_err(|_| Cryptographic::Malformed)?;
        let sig =
            p384::ecdsa::Signature::from_der(signature).map_err(|_| Cryptographic::Invalid)?;
        key.verify_prehash(digest, &sig)
            .map_err(|_| Cryptographic::Invalid)
    } else {
        Err(Cryptographic::UnsupportedAlgorithm)
    }
}

// --- certificates and times ----------------------------------------------------------------------------------------------

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn unix_of(time: &Time) -> i64 {
    i64::try_from(time.to_unix_duration().as_secs()).unwrap_or(i64::MAX)
}

fn iso_utc(unix: i64) -> Option<String> {
    jiff::Timestamp::from_second(unix)
        .ok()
        .map(|t| t.to_string())
}

fn name_text(any: &Any) -> String {
    use der::asn1::{Ia5StringRef, PrintableStringRef, TeletexStringRef, Utf8StringRef};
    let text = any
        .decode_as::<Utf8StringRef>()
        .map(|s| s.as_str().to_owned())
        .or_else(|_| {
            any.decode_as::<PrintableStringRef>()
                .map(|s| s.as_str().to_owned())
        })
        .or_else(|_| {
            any.decode_as::<Ia5StringRef>()
                .map(|s| s.as_str().to_owned())
        })
        .or_else(|_| {
            any.decode_as::<TeletexStringRef>()
                .map(|s| s.as_str().to_owned())
        })
        .unwrap_or_else(|_| String::from_utf8_lossy(any.value()).into_owned());
    sanitize_text(&text, NAME_MAX)
}

fn cert_name(name: &Name) -> CertName {
    let (cn, org, email) = (oid(OID_COMMON_NAME), oid(OID_ORGANIZATION), oid(OID_EMAIL));
    let mut out = CertName {
        common_name: String::new(),
        organization: None,
        email: None,
    };
    for rdn in &name.0 {
        for atv in rdn.0.iter() {
            let text = name_text(&atv.value);
            if text.is_empty() {
                continue;
            }
            if atv.oid == cn && out.common_name.is_empty() {
                out.common_name = text;
            } else if atv.oid == org && out.organization.is_none() {
                out.organization = Some(text);
            } else if atv.oid == email && out.email.is_none() {
                out.email = Some(text);
            }
        }
    }
    if out.common_name.is_empty() {
        out.common_name = sanitize_text(&name.to_string(), NAME_MAX);
    }
    out
}

/// What the UI may learn about a certificate.
pub fn summarize(cert: &Certificate, cert_der: &[u8]) -> CertSummary {
    let tbs = &cert.tbs_certificate;
    let iso = |time: &Time| iso_utc(unix_of(time)).unwrap_or_default();
    CertSummary {
        subject: cert_name(&tbs.subject),
        issuer: cert_name(&tbs.issuer),
        self_signed: tbs.subject == tbs.issuer,
        not_before: iso(&tbs.validity.not_before),
        not_after: iso(&tbs.validity.not_after),
        serial_hex: hex(tbs.serial_number.as_bytes()).chars().take(64).collect(),
        fingerprint_sha256: hex(&Sha256::digest(cert_der)),
    }
}

/// A PDF date (`D:YYYYMMDDHHmmSSOHH'mm'`, every part after the year optional) as ISO 8601 in UTC and Unix seconds. `None` when it
/// does not parse.
pub fn parse_pdf_date(text: &str) -> Option<(String, i64)> {
    let text = text.trim();
    let text = text.strip_prefix("D:").unwrap_or(text).as_bytes();
    struct Digits<'a> {
        text: &'a [u8],
        at: usize,
    }
    impl Digits<'_> {
        /// `digits` ASCII digits as a number; `default` once the text has ended.
        fn number(&mut self, digits: usize, default: i32) -> Option<i32> {
            if self.at >= self.text.len() {
                return Some(default);
            }
            let part = self.text.get(self.at..self.at + digits)?;
            if !part.iter().all(u8::is_ascii_digit) {
                return None;
            }
            self.at += digits;
            std::str::from_utf8(part).ok()?.parse().ok()
        }
    }
    let mut cursor = Digits { text, at: 0 };
    let year = cursor.number(4, -1)?;
    if year < 0 {
        return None;
    }
    let month = cursor.number(2, 1)?;
    let day = cursor.number(2, 1)?;
    let hour = cursor.number(2, 0)?;
    let minute = cursor.number(2, 0)?;
    let second = cursor.number(2, 0)?;
    let mut offset_seconds = 0i32;
    if let Some(&sign) = text.get(cursor.at) {
        cursor.at += 1;
        if sign != b'Z' {
            let factor = match sign {
                b'+' => 1,
                b'-' => -1,
                _ => return None,
            };
            let oh = cursor.number(2, 0)?;
            if text.get(cursor.at) == Some(&b'\'') {
                cursor.at += 1;
            }
            let om = cursor.number(2, 0)?;
            offset_seconds = factor * (oh * 3600 + om * 60);
        }
    }
    let civil = jiff::civil::DateTime::new(
        i16::try_from(year).ok()?,
        i8::try_from(month).ok()?,
        i8::try_from(day).ok()?,
        i8::try_from(hour).ok()?,
        i8::try_from(minute).ok()?,
        i8::try_from(second.min(59)).ok()?,
        0,
    )
    .ok()?;
    let offset = jiff::tz::Offset::from_seconds(offset_seconds).ok()?;
    let stamp = offset.to_timestamp(civil).ok()?;
    Some((stamp.to_string(), stamp.as_second()))
}

// --- BER to DER -----------------------------------------------------------------------------------------------------------

/// Rewrites BER as DER where a CMS from the field differs: indefinite lengths become definite, a constructed OCTET STRING becomes one
/// primitive, lengths are minimal. Bounded (depth, input size) and iterative per level. Trailing bytes after the one top-level value
/// must be zero (the padding of `/Contents`); anything else is refused.
fn ber_to_der(input: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(input.len() + 16);
    let mut at = 0usize;
    convert(input, &mut at, input.len(), &mut out, 0)?;
    input[at..].iter().all(|b| *b == 0).then_some(out)
}

fn emit(out: &mut Vec<u8>, tag: &[u8], content: &[u8]) {
    out.extend_from_slice(tag);
    let len = content.len();
    if len < 0x80 {
        out.push(len as u8);
    } else {
        let bytes = len.to_be_bytes();
        let skip = bytes.iter().take_while(|b| **b == 0).count();
        out.push(0x80 | (bytes.len() - skip) as u8);
        out.extend_from_slice(&bytes[skip..]);
    }
    out.extend_from_slice(content);
}

fn convert(
    input: &[u8],
    at: &mut usize,
    end: usize,
    out: &mut Vec<u8>,
    depth: usize,
) -> Option<()> {
    if depth > BER_DEPTH_MAX {
        return None;
    }
    let tag_start = *at;
    let first = *input.get(*at)?;
    *at += 1;
    if first & 0x1f == 0x1f {
        loop {
            let byte = *input.get(*at)?;
            *at += 1;
            if byte & 0x80 == 0 {
                break;
            }
            if *at - tag_start > TAG_BYTES_MAX {
                return None;
            }
        }
    }
    let tag = &input[tag_start..*at];
    let constructed = first & 0x20 != 0;
    let l0 = *input.get(*at)?;
    *at += 1;
    let definite = if l0 == 0x80 {
        if !constructed {
            return None;
        }
        None
    } else if l0 < 0x80 {
        Some(usize::from(l0))
    } else {
        let count = usize::from(l0 & 0x7f);
        if count == 0 || count > 4 {
            return None;
        }
        let mut value = 0usize;
        for _ in 0..count {
            value = value << 8 | usize::from(*input.get(*at)?);
            *at += 1;
        }
        Some(value)
    };
    let mut body: Vec<u8> = Vec::new();
    match definite {
        Some(len) => {
            let stop = at.checked_add(len)?;
            if stop > end {
                return None;
            }
            if constructed {
                while *at < stop {
                    convert(input, at, stop, &mut body, depth + 1)?;
                }
                if *at != stop {
                    return None;
                }
            } else {
                body.extend_from_slice(&input[*at..stop]);
                *at = stop;
            }
        }
        None => loop {
            if input.get(*at..*at + 2) == Some(&[0, 0]) {
                *at += 2;
                break;
            }
            if *at >= end {
                return None;
            }
            convert(input, at, end, &mut body, depth + 1)?;
        },
    }
    if tag == [0x24] {
        // A constructed OCTET STRING: its pieces (already primitive) are joined.
        let mut joined = Vec::new();
        let mut pos = 0usize;
        while pos < body.len() {
            if body[pos] != 0x04 {
                return None;
            }
            let (len, header) = der_length(&body[pos + 1..])?;
            let start = pos + 1 + header;
            joined.extend_from_slice(body.get(start..start.checked_add(len)?)?);
            pos = start + len;
        }
        emit(out, &[0x04], &joined);
    } else {
        emit(out, tag, &body);
    }
    Some(())
}

/// A DER length at the start of `bytes`: (value, bytes the length itself takes).
fn der_length(bytes: &[u8]) -> Option<(usize, usize)> {
    let first = *bytes.first()?;
    if first < 0x80 {
        return Some((usize::from(first), 1));
    }
    let count = usize::from(first & 0x7f);
    if count == 0 || count > 4 {
        return None;
    }
    let mut value = 0usize;
    for byte in bytes.get(1..1 + count)? {
        value = value << 8 | usize::from(*byte);
    }
    Some((value, 1 + count))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pdf_dates_parse_with_their_offset() {
        assert_eq!(
            parse_pdf_date("D:20261005101500+02'00'"),
            Some(("2026-10-05T08:15:00Z".to_owned(), 1_791_188_100))
        );
        assert_eq!(
            parse_pdf_date("D:20261005101500Z").map(|(iso, _)| iso),
            Some("2026-10-05T10:15:00Z".to_owned())
        );
        assert_eq!(
            parse_pdf_date("D:2026").map(|(iso, _)| iso),
            Some("2026-01-01T00:00:00Z".to_owned())
        );
        assert_eq!(
            parse_pdf_date("D:20261005101500-0530").map(|(iso, _)| iso),
            Some("2026-10-05T15:45:00Z".to_owned())
        );
        for bad in [
            "",
            "D:",
            "D:20x6",
            "D:20261305",
            "D:202610051015+",
            "yesterday",
        ] {
            assert_eq!(parse_pdf_date(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn ber_is_normalized_to_der() {
        // SEQUENCE (indefinite) { OCTET STRING (constructed, indefinite) { "ab", "c" }, INTEGER 5 } plus zero padding.
        let ber = [
            0x30, 0x80, 0x24, 0x80, 0x04, 0x02, b'a', b'b', 0x04, 0x01, b'c', 0x00, 0x00, 0x02,
            0x01, 0x05, 0x00, 0x00, 0x00, 0x00,
        ];
        assert_eq!(
            ber_to_der(&ber),
            Some(vec![
                0x30, 0x08, 0x04, 0x03, b'a', b'b', b'c', 0x02, 0x01, 0x05
            ])
        );
        // Already DER is unchanged.
        let der = [0x30, 0x03, 0x02, 0x01, 0x05];
        assert_eq!(ber_to_der(&der), Some(der.to_vec()));
    }

    #[test]
    fn broken_ber_is_refused_not_followed() {
        let cases: [&[u8]; 8] = [
            &[],
            &[0x30],
            &[0x30, 0x05, 0x02],
            &[0x30, 0x80, 0x02, 0x01, 0x05],
            &[0x02, 0x80, 0x00, 0x00],
            &[0x30, 0x84, 0xff, 0xff, 0xff, 0xff],
            &[0x30, 0x03, 0x02, 0x01, 0x05, 0x01],
            &[0x1f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01, 0x00],
        ];
        for case in cases {
            assert_eq!(ber_to_der(case), None, "{case:02x?}");
        }
        // Nesting past the cap.
        let mut deep = Vec::new();
        for _ in 0..BER_DEPTH_MAX + 4 {
            deep.extend_from_slice(&[0x30, 0x80]);
        }
        deep.extend(std::iter::repeat_n(0, 2 * (BER_DEPTH_MAX + 4)));
        assert_eq!(ber_to_der(&deep), None);
    }

    #[test]
    fn garbage_contents_are_malformed_and_never_panic() {
        let junk: Vec<Vec<u8>> = vec![
            vec![],
            vec![0; 64],
            vec![0xff; 64],
            (0..=255u8).collect(),
            vec![0x30, 0x03, 0x02, 0x01, 0x05],
            vec![
                0x30, 0x80, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07, 0x02, 0x00,
                0x00,
            ],
        ];
        for contents in junk {
            let mut empty: &[u8] = &[];
            let result = check(
                &RawSignature {
                    sub_filter: SubFilter::EtsiCadesDetached,
                    contents: &contents,
                    claimed_unix: None,
                },
                &mut empty,
            );
            assert_eq!(
                result.cryptographic,
                Cryptographic::Malformed,
                "{contents:02x?}"
            );
        }
        let mut empty: &[u8] = &[];
        let oversized = vec![0x30; limits::SIG_CONTENTS_READ_MAX + 1];
        assert_eq!(
            check(
                &RawSignature {
                    sub_filter: SubFilter::EtsiCadesDetached,
                    contents: &oversized,
                    claimed_unix: None
                },
                &mut empty
            )
            .cryptographic,
            Cryptographic::Malformed
        );
        assert_eq!(
            check(
                &RawSignature {
                    sub_filter: SubFilter::Other,
                    contents: &[],
                    claimed_unix: None
                },
                &mut empty
            )
            .cryptographic,
            Cryptographic::UnsupportedAlgorithm
        );
        let timestamp = check(
            &RawSignature {
                sub_filter: SubFilter::EtsiRfc3161,
                contents: &[],
                claimed_unix: None,
            },
            &mut empty,
        );
        assert_eq!(timestamp.cryptographic, Cryptographic::Unverifiable);
        assert!(timestamp.timestamp_present);
    }
}
