//! Validating signatures (ADR-121 section 4; SECURITY P21 to P24, I19, I20, D10): valid signatures made in this test with the stable
//! RustCrypto crates (ECDSA P-256, P-384, RSA PKCS#1 v1.5), the revision diff against DocMDP, and a hostile corpus generated here (empty
//! and null `/Contents`, wrapped and overlapping byte ranges, oversized `/Contents`, truncated and BER CMS, shadow attacks). Nothing may
//! panic, whatever the bytes. The command layer (`open_signed_revision`, the pins) runs against the real PDFium and skips without it.

// Test code: panicking on a broken fixture is the point (clippy.toml only exempts `#[test]` functions, not helpers).
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use std::path::PathBuf;
use std::str::FromStr;
use std::time::{Duration, Instant};

use cms::builder::{SignedDataBuilder, SignerInfoBuilder};
use cms::cert::{CertificateChoices, IssuerAndSerialNumber};
use cms::signed_data::{EncapsulatedContentInfo, SignerIdentifier};
use der::asn1::{Any, OctetString, SetOfVec};
use der::{Decode, Encode, Sequence};
use p256::ecdsa::signature::Keypair;
use sha2::{Digest, Sha256, Sha384};
use sheer_lib::commands::AppState;
use sheer_lib::documents::DocKind;
use sheer_lib::engine::{self, Engine};
use sheer_lib::error::ErrorCode;
use sheer_lib::events::AppEvent;
use sheer_lib::pdfsig::types::{
    Coverage, Cryptographic, SignatureKind, SignatureLock, SubFilter, Trust, Verdict,
};
use sheer_lib::pdfwrite::sigread::{validate_bytes, Validation};
use spki::{AlgorithmIdentifierOwned, ObjectIdentifier, SubjectPublicKeyInfoOwned};
use support::PdfBuilder;
use x509_cert::attr::Attribute;
use x509_cert::builder::{Builder, CertificateBuilder, Profile};
use x509_cert::name::Name;
use x509_cert::serial_number::SerialNumber;
use x509_cert::time::Validity;
use x509_cert::Certificate;

// --- Making signatures --------------------------------------------------------------------------------------------------

#[derive(Sequence)]
struct EssCertIdV2 {
    cert_hash: OctetString,
}

#[derive(Sequence)]
struct SigningCertificateV2 {
    certs: Vec<EssCertIdV2>,
}

fn oid(text: &str) -> ObjectIdentifier {
    ObjectIdentifier::new_unwrap(text)
}

fn validity() -> Validity {
    Validity::from_now(Duration::from_secs(3 * 365 * 86_400)).unwrap()
}

/// What signs: a key and its self-signed certificate.
#[allow(clippy::large_enum_variant)]
enum Keys {
    P256(p256::ecdsa::SigningKey, Certificate),
    P384(p384::ecdsa::SigningKey, Certificate),
    Rsa(rsa::pkcs1v15::SigningKey<Sha256>, Certificate),
}

/// A deterministic RNG for the RSA test key (a test key; not secret, not random).
struct Det(u64);

impl rsa::rand_core::RngCore for Det {
    fn next_u32(&mut self) -> u32 {
        self.next_u64() as u32
    }

    fn next_u64(&mut self) -> u64 {
        // SplitMix64.
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    fn fill_bytes(&mut self, dest: &mut [u8]) {
        for chunk in dest.chunks_mut(8) {
            let bytes = self.next_u64().to_le_bytes();
            chunk.copy_from_slice(&bytes[..chunk.len()]);
        }
    }

    fn try_fill_bytes(&mut self, dest: &mut [u8]) -> Result<(), rsa::rand_core::Error> {
        self.fill_bytes(dest);
        Ok(())
    }
}

impl rsa::rand_core::CryptoRng for Det {}

macro_rules! self_signed {
    ($key:expr, $sig:ty, $name:expr) => {{
        let key = $key;
        let spki = SubjectPublicKeyInfoOwned::from_key(key.verifying_key().clone()).unwrap();
        let builder = CertificateBuilder::new(
            Profile::Manual { issuer: None },
            SerialNumber::from(7u32),
            validity(),
            Name::from_str(&format!("CN={},O=Test Org", $name)).unwrap(),
            spki,
            key,
        )
        .unwrap();
        builder.build::<$sig>().unwrap()
    }};
}

impl Keys {
    fn p256(seed: u8) -> Self {
        let key = p256::ecdsa::SigningKey::from_slice(&[seed; 32]).unwrap();
        let cert = self_signed!(&key, p256::ecdsa::DerSignature, "Ada P256");
        Self::P256(key, cert)
    }

    fn p384(seed: u8) -> Self {
        let key = p384::ecdsa::SigningKey::from_slice(&[seed; 48]).unwrap();
        let cert = self_signed!(&key, p384::ecdsa::DerSignature, "Ada P384");
        Self::P384(key, cert)
    }

    fn rsa() -> Self {
        let private = rsa::RsaPrivateKey::new(&mut Det(42), 1024).unwrap();
        let key = rsa::pkcs1v15::SigningKey::<Sha256>::new(private);
        let cert = self_signed!(&key, rsa::pkcs1v15::Signature, "Ada RSA");
        Self::Rsa(key, cert)
    }

    fn certificate(&self) -> &Certificate {
        match self {
            Self::P256(_, c) | Self::P384(_, c) | Self::Rsa(_, c) => c,
        }
    }

    /// The hash of the byte ranges for this key: SHA-384 for P-384, else SHA-256.
    fn hash(&self, data: &[u8]) -> (Vec<u8>, &'static str) {
        match self {
            Self::P384(..) => (Sha384::digest(data).to_vec(), "2.16.840.1.101.3.4.2.2"),
            _ => (Sha256::digest(data).to_vec(), "2.16.840.1.101.3.4.2.1"),
        }
    }

    /// A detached PAdES-style CMS over `digest`; `ess_hash` overrides the certificate hash of signing-certificate-v2.
    fn cms(&self, digest: &[u8], digest_oid: &str, ess_hash: Option<Vec<u8>>) -> Vec<u8> {
        let cert = self.certificate().clone();
        let eci = EncapsulatedContentInfo {
            econtent_type: oid("1.2.840.113549.1.7.1"),
            econtent: None,
        };
        let digest_alg = AlgorithmIdentifierOwned {
            oid: oid(digest_oid),
            parameters: None,
        };
        let sid = SignerIdentifier::IssuerAndSerialNumber(IssuerAndSerialNumber {
            issuer: cert.tbs_certificate.issuer.clone(),
            serial_number: cert.tbs_certificate.serial_number.clone(),
        });
        let ess = SigningCertificateV2 {
            certs: vec![EssCertIdV2 {
                cert_hash: OctetString::new(
                    ess_hash.unwrap_or_else(|| Sha256::digest(cert.to_der().unwrap()).to_vec()),
                )
                .unwrap(),
            }],
        };
        let mut values = SetOfVec::new();
        values
            .insert(Any::from_der(&ess.to_der().unwrap()).unwrap())
            .unwrap();
        let attribute = Attribute {
            oid: oid("1.2.840.113549.1.9.16.2.47"),
            values,
        };
        macro_rules! build {
            ($key:expr, $sig:ty, $ty:ty) => {{
                let mut signer = SignerInfoBuilder::new(
                    $key,
                    sid.clone(),
                    digest_alg.clone(),
                    &eci,
                    Some(digest),
                )
                .unwrap();
                signer.add_signed_attribute(attribute.clone()).unwrap();
                let mut builder = SignedDataBuilder::new(&eci);
                builder.add_digest_algorithm(digest_alg.clone()).unwrap();
                builder
                    .add_certificate(CertificateChoices::Certificate(cert.clone()))
                    .unwrap();
                builder.add_signer_info::<$ty, $sig>(signer).unwrap();
                builder.build().unwrap().to_der().unwrap()
            }};
        }
        match self {
            Self::P256(key, _) => {
                build!(key, p256::ecdsa::DerSignature, p256::ecdsa::SigningKey)
            }
            Self::P384(key, _) => {
                build!(key, p384::ecdsa::DerSignature, p384::ecdsa::SigningKey)
            }
            Self::Rsa(key, _) => {
                build!(
                    key,
                    rsa::pkcs1v15::Signature,
                    rsa::pkcs1v15::SigningKey<Sha256>
                )
            }
        }
    }
}

/// The signed PDF's `/M`: now, in UTC (the self-signed certificates are valid from now).
fn now_date() -> String {
    let now = jiff::Timestamp::now();
    let civil = now.to_zoned(jiff::tz::TimeZone::UTC).datetime();
    format!(
        "D:{:04}{:02}{:02}{:02}{:02}{:02}+00'00'",
        civil.year(),
        civil.month(),
        civil.day(),
        civil.hour(),
        civil.minute(),
        civil.second()
    )
}

const CONTENTS_BYTES: usize = 4096;

/// The unsigned document: a text field, an empty signature field, one blue square. Objects 1 to 7, the catalog is 1.
fn base_pdf() -> Vec<u8> {
    let mut builder = PdfBuilder::new();
    builder
        .object(1, "<< /Type /Catalog /Pages 2 0 R /AcroForm 7 0 R >>")
        .object(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>")
        .object(
            3,
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Annots [5 0 R 6 0 R] >>",
        )
        .stream(4, "", b"0 0 1 rg 10 10 50 50 re f")
        .object(
            5,
            "<< /Type /Annot /Subtype /Widget /FT /Tx /T (name) /V (Ada) /Rect [10 100 100 120] /P 3 0 R >>",
        )
        .object(
            6,
            "<< /Type /Annot /Subtype /Widget /FT /Sig /T (Signature1) /Rect [10 10 100 50] /P 3 0 R >>",
        )
        .object(7, "<< /Fields [5 0 R 6 0 R] /SigFlags 3 >>");
    builder.finish(1)
}

fn last_startxref(bytes: &[u8]) -> usize {
    let text = String::from_utf8_lossy(bytes);
    let at = text.rfind("startxref").unwrap();
    text[at + 9..]
        .split_whitespace()
        .next()
        .unwrap()
        .parse()
        .unwrap()
}

/// `previous` plus one incremental revision that holds `objects` (id, body), the way an editor appends it: its own xref section.
fn append_revision(previous: &[u8], objects: &[(u32, String)], size: u32) -> Vec<u8> {
    let prev = last_startxref(previous);
    let mut out = previous.to_vec();
    let mut offsets = Vec::new();
    for (id, body) in objects {
        offsets.push((*id, out.len()));
        out.extend_from_slice(format!("{id} 0 obj\n{body}\nendobj\n").as_bytes());
    }
    let xref = out.len();
    out.extend_from_slice(b"xref\n");
    for (id, offset) in &offsets {
        out.extend_from_slice(format!("{id} 1\n{offset:010} 00000 n \n").as_bytes());
    }
    out.extend_from_slice(
        format!("trailer\n<< /Size {size} /Root 1 0 R /Prev {prev} >>\nstartxref\n{xref}\n%%EOF\n")
            .as_bytes(),
    );
    out
}

/// The signature dictionary with placeholders for the byte range and the contents.
fn sig_dict(extra: &str) -> String {
    format!(
        "<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /ETSI.CAdES.detached /ByteRange @BR@ /Contents @CT@ \
         /M ({}) /Reason (I agree) /Location (Berlin) {extra} >>",
        now_date()
    )
}

/// How a test breaks a signature on purpose.
#[derive(Default, Clone)]
struct Options {
    /// Written instead of the real CMS (as raw bytes, zero padded); `None`: the real one.
    contents: Option<Vec<u8>>,
    /// Replaces the CMS DER before it is hex encoded (for the BER and truncation tests).
    transform: Option<fn(Vec<u8>) -> Vec<u8>>,
    /// Overrides the signing-certificate-v2 hash.
    ess_hash: Option<Vec<u8>>,
    /// The size of the contents in bytes.
    size: Option<usize>,
}

/// Appends a revision with `objects` (one of which holds the placeholders `@BR@` and `@CT@`) to `previous` and signs it.
fn sign_with(
    previous: &[u8],
    objects: Vec<(u32, String)>,
    size: u32,
    keys: &Keys,
    options: &Options,
) -> Vec<u8> {
    let contents_len = options.size.unwrap_or(CONTENTS_BYTES);
    let br = format!("[0 {0:010} {0:010} {0:010}]", 0);
    let ct = format!("<{}>", "0".repeat(contents_len * 2));
    let objects: Vec<(u32, String)> = objects
        .into_iter()
        .map(|(id, body)| (id, body.replace("@BR@", &br).replace("@CT@", &ct)))
        .collect();
    let mut bytes = append_revision(previous, &objects, size);
    // Where the contents token is, in the appended part only.
    let from = previous.len();
    let a = from + find(&bytes[from..], b"/Contents <") + b"/Contents ".len();
    let b = a + ct.len();
    let total = bytes.len();
    let range = format!("[0 {a:010} {b:010} {:010}]", total - b);
    let at = from + find(&bytes[from..], br.as_bytes());
    bytes[at..at + br.len()].copy_from_slice(range.as_bytes());
    let mut covered = bytes[..a].to_vec();
    covered.extend_from_slice(&bytes[b..]);
    let (digest, digest_oid) = keys.hash(&covered);
    let mut der = keys.cms(&digest, digest_oid, options.ess_hash.clone());
    if let Some(transform) = options.transform {
        der = transform(der);
    }
    if let Some(raw) = &options.contents {
        der = raw.clone();
    }
    assert!(
        der.len() <= contents_len,
        "the CMS ({} bytes) fits the placeholder ({contents_len})",
        der.len()
    );
    der.resize(contents_len, 0);
    let hex: String = der.iter().map(|byte| format!("{byte:02x}")).collect();
    bytes[a + 1..b - 1].copy_from_slice(hex.as_bytes());
    bytes
}

fn find(haystack: &[u8], needle: &[u8]) -> usize {
    haystack
        .windows(needle.len())
        .position(|w| w == needle)
        .expect("needle present")
}

/// The first signature: a certification signature (DocMDP `p`) on the empty field 6.
fn certify(base: &[u8], keys: &Keys, p: u8, options: &Options) -> Vec<u8> {
    let reference = format!(
        "/Reference [<< /Type /SigRef /TransformMethod /DocMDP /TransformParams << /Type /TransformParams /P {p} /V /1.2 >> >>]"
    );
    sign_with(
        base,
        vec![
            (
                1,
                "<< /Type /Catalog /Pages 2 0 R /AcroForm 7 0 R /Perms << /DocMDP 8 0 R >> >>"
                    .to_owned(),
            ),
            (
                6,
                "<< /Type /Annot /Subtype /Widget /FT /Sig /T (Signature1) /Rect [10 10 100 50] /P 3 0 R /V 8 0 R >>"
                    .to_owned(),
            ),
            (8, sig_dict(&reference)),
        ],
        9,
        keys,
        options,
    )
}

/// An approval signature in a new field (object 9) on a document that is signed already.
fn approve(previous: &[u8], keys: &Keys, field: u32, sig: u32) -> Vec<u8> {
    sign_with(
        previous,
        vec![
            (
                3,
                format!("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Annots [5 0 R 6 0 R {field} 0 R] >>"),
            ),
            (
                7,
                format!("<< /Fields [5 0 R 6 0 R {field} 0 R] /SigFlags 3 >>"),
            ),
            (
                field,
                format!("<< /Type /Annot /Subtype /Widget /FT /Sig /T (Signature2) /Rect [110 10 190 50] /P 3 0 R /V {sig} 0 R >>"),
            ),
            (sig, sig_dict("")),
        ],
        sig + 1,
        keys,
        &Options::default(),
    )
}

fn validate(bytes: &[u8]) -> Validation {
    validate_bytes(bytes, Instant::now() + Duration::from_secs(60)).unwrap()
}

fn only(bytes: &[u8]) -> sheer_lib::pdfsig::types::SignatureInfo {
    let mut validation = validate(bytes);
    assert_eq!(validation.signatures.len(), 1, "one signature");
    validation.signatures.remove(0).info
}

fn later_of(coverage: &Coverage) -> (sheer_lib::pdfsig::types::LaterChanges, Verdict) {
    match coverage {
        Coverage::EarlierRevision { later, verdict, .. } => (*later, *verdict),
        Coverage::WholeFile => panic!("expected an earlier revision"),
    }
}

// --- Valid signatures ---------------------------------------------------------------------------------------------------

#[test]
fn a_p256_certification_signature_verifies_over_the_whole_file() {
    let keys = Keys::p256(7);
    let signed = certify(&base_pdf(), &keys, 2, &Options::default());
    let validation = validate(&signed);
    assert_eq!(validation.lock, SignatureLock::FillAndSign);
    let info = &validation.signatures[0].info;
    assert_eq!(info.cryptographic, Cryptographic::Valid);
    assert_eq!(info.coverage, Coverage::WholeFile);
    assert_eq!(info.kind, SignatureKind::Certification { p: 2 });
    assert_eq!(info.sub_filter, SubFilter::EtsiCadesDetached);
    assert_eq!(info.field_name, "Signature1");
    assert_eq!(info.reason.as_deref(), Some("I agree"));
    assert_eq!(info.location.as_deref(), Some("Berlin"));
    assert!(!info.weak_algorithm && !info.timestamp_present);
    assert!(info.cert_valid_at_claimed_time);
    assert_eq!(info.trust, Trust::NotTrusted, "trust only comes from a pin");
    let signer = info.signer.as_ref().unwrap();
    assert_eq!(signer.subject.common_name, "Ada P256");
    assert_eq!(signer.subject.organization.as_deref(), Some("Test Org"));
    assert!(signer.self_signed);
    assert_eq!(signer.fingerprint_sha256.len(), 64);
    assert_eq!(
        validation.signatures[0].fingerprint.as_deref(),
        Some(signer.fingerprint_sha256.as_str())
    );
    assert!(info.claimed_time.as_deref().unwrap().ends_with('Z'));
    let visible = &validation.signatures[0];
    assert_eq!(visible.page_index, Some(0));
    assert_eq!(visible.rect, Some([10.0, 10.0, 100.0, 50.0]));
}

#[test]
fn p384_and_rsa_signatures_verify_too() {
    let signed = certify(&base_pdf(), &Keys::p384(9), 2, &Options::default());
    let info = only(&signed);
    assert_eq!(info.cryptographic, Cryptographic::Valid);
    assert_eq!(info.signer.unwrap().subject.common_name, "Ada P384");

    let signed = certify(&base_pdf(), &Keys::rsa(), 2, &Options::default());
    let info = only(&signed);
    assert_eq!(info.cryptographic, Cryptographic::Valid);
    assert!(info.weak_algorithm, "a 1024 bit RSA key is flagged weak");
}

#[test]
fn a_certificate_that_was_not_valid_at_the_claimed_time_is_said_so() {
    let keys = Keys::p256(7);
    let reference = "";
    let signed = sign_with(
        &base_pdf(),
        vec![
            (
                6,
                "<< /Type /Annot /Subtype /Widget /FT /Sig /T (Signature1) /Rect [10 10 100 50] /P 3 0 R /V 8 0 R >>".to_owned(),
            ),
            (
                8,
                sig_dict(reference).replace(&now_date(), "D:20200101000000Z"),
            ),
        ],
        9,
        &keys,
        &Options::default(),
    );
    let info = only(&signed);
    assert_eq!(info.cryptographic, Cryptographic::Valid);
    assert!(!info.cert_valid_at_claimed_time);
    assert_eq!(info.kind, SignatureKind::Approval);
}

#[test]
fn a_changed_byte_inside_the_signed_ranges_is_invalid() {
    let keys = Keys::p256(7);
    let mut signed = certify(&base_pdf(), &keys, 2, &Options::default());
    let at = find(&signed, b"0 0 1 rg");
    signed[at] = b'1';
    assert_eq!(only(&signed).cryptographic, Cryptographic::Invalid);
    // The signature cannot be moved to another certificate: the ESS hash no longer names the signer.
    let signed = certify(
        &base_pdf(),
        &keys,
        2,
        &Options {
            ess_hash: Some(vec![0; 32]),
            ..Options::default()
        },
    );
    assert_eq!(only(&signed).cryptographic, Cryptographic::Invalid);
}

// --- Coverage and DocMDP -------------------------------------------------------------------------------------------------

fn fill_form(previous: &[u8]) -> Vec<u8> {
    append_revision(
        previous,
        &[(
            5,
            "<< /Type /Annot /Subtype /Widget /FT /Tx /T (name) /V (Grace) /Rect [10 100 100 120] /P 3 0 R >>"
                .to_owned(),
        )],
        9,
    )
}

fn add_note(previous: &[u8]) -> Vec<u8> {
    append_revision(
        previous,
        &[
            (
                3,
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Annots [5 0 R 6 0 R 9 0 R] >>"
                    .to_owned(),
            ),
            (
                9,
                "<< /Type /Annot /Subtype /Square /Rect [0 0 200 200] /C [1 1 1] /IC [1 1 1] /F 4 >>"
                    .to_owned(),
            ),
        ],
        10,
    )
}

#[test]
fn a_form_fill_after_a_p2_signature_is_listed_and_allowed() {
    let keys = Keys::p256(7);
    let signed = certify(&base_pdf(), &keys, 2, &Options::default());
    let info = only(&fill_form(&signed));
    assert_eq!(
        info.cryptographic,
        Cryptographic::Valid,
        "the signed bytes are intact"
    );
    let (later, verdict) = later_of(&info.coverage);
    assert!(later.form_fill && !later.annotations && !later.other && !later.signatures);
    assert_eq!(verdict, Verdict::Allowed);
}

#[test]
fn a_form_fill_after_a_p1_signature_is_disallowed() {
    let keys = Keys::p256(7);
    let signed = certify(&base_pdf(), &keys, 1, &Options::default());
    let validation = validate(&fill_form(&signed));
    assert_eq!(validation.lock, SignatureLock::Locked);
    let (later, verdict) = later_of(&validation.signatures[0].info.coverage);
    assert!(later.form_fill);
    assert_eq!(verdict, Verdict::Disallowed);
}

#[test]
fn an_annotation_added_after_signing_is_listed_and_never_called_harmless() {
    let keys = Keys::p256(7);
    // The shadow-hide attack: a white rectangle over the page, in a revision after the signature.
    let hidden = add_note(&certify(&base_pdf(), &keys, 2, &Options::default()));
    let info = only(&hidden);
    assert_eq!(info.cryptographic, Cryptographic::Valid);
    let (later, verdict) = later_of(&info.coverage);
    assert!(later.annotations && !later.other);
    assert_eq!(
        verdict,
        Verdict::Disallowed,
        "P=2 does not allow annotations"
    );
    // P=3 allows it, and the change is still reported.
    let allowed = add_note(&certify(&base_pdf(), &keys, 3, &Options::default()));
    let (later, verdict) = later_of(&only(&allowed).coverage);
    assert!(later.annotations);
    assert_eq!(verdict, Verdict::Allowed);
}

#[test]
fn replaced_page_content_is_other_and_disallowed_under_every_level() {
    let keys = Keys::p256(7);
    for p in [1, 2, 3] {
        let signed = certify(&base_pdf(), &keys, p, &Options::default());
        // Incremental saving attack: the content stream of the page is redefined.
        let attacked = append_revision(
            &signed,
            &[(
                4,
                "<< /Length 25 >>\nstream\n1 0 0 rg 10 10 50 50 re f\nendstream".to_owned(),
            )],
            9,
        );
        let info = only(&attacked);
        assert_eq!(info.cryptographic, Cryptographic::Valid);
        let (later, verdict) = later_of(&info.coverage);
        assert!(later.other, "P = {p}");
        assert_eq!(verdict, Verdict::Disallowed);
    }
}

#[test]
fn a_shadow_replace_swapping_the_content_reference_is_other() {
    let keys = Keys::p256(7);
    let signed = certify(&base_pdf(), &keys, 2, &Options::default());
    // Hide-and-replace: a new page object points at a new content stream.
    let attacked = append_revision(
        &signed,
        &[
            (
                3,
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 9 0 R /Annots [5 0 R 6 0 R] >>"
                    .to_owned(),
            ),
            (
                9,
                "<< /Length 25 >>\nstream\n1 0 0 rg 10 10 50 50 re f\nendstream".to_owned(),
            ),
        ],
        10,
    );
    let (later, verdict) = later_of(&only(&attacked).coverage);
    assert!(later.other);
    assert_eq!(verdict, Verdict::Disallowed);
}

#[test]
fn a_universal_signature_forgery_replacing_the_field_value_is_other() {
    let keys = Keys::p256(7);
    let signed = certify(&base_pdf(), &keys, 2, &Options::default());
    // The signature dictionary is redefined (a different /Contents), and the file's last revision is not the signed one.
    let attacked = append_revision(
        &signed,
        &[(
            8,
            "<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /ETSI.CAdES.detached /ByteRange [0 1 2 3] /Contents <00> >>"
                .to_owned(),
        )],
        9,
    );
    let validation = validate(&attacked);
    let info = &validation.signatures[0].info;
    // What the file says now is not a signature that verifies.
    assert_ne!(info.cryptographic, Cryptographic::Valid);
}

#[test]
fn a_countersignature_is_listed_as_a_later_signature_and_both_verify() {
    let keys = Keys::p256(7);
    let first = certify(&base_pdf(), &keys, 2, &Options::default());
    let both = approve(&first, &Keys::p256(11), 9, 10);
    let validation = validate(&both);
    assert_eq!(validation.signatures.len(), 2);
    let (first, second) = (
        &validation.signatures[0].info,
        &validation.signatures[1].info,
    );
    assert_eq!(first.cryptographic, Cryptographic::Valid);
    assert_eq!(second.cryptographic, Cryptographic::Valid);
    assert_eq!(second.kind, SignatureKind::Approval);
    assert_eq!(second.coverage, Coverage::WholeFile);
    let (later, verdict) = later_of(&first.coverage);
    assert!(later.signatures && !later.other && !later.annotations && !later.form_fill);
    assert_eq!(verdict, Verdict::Allowed);
    assert_eq!(validation.signatures[1].info.field_name, "Signature2");
    // With P=1 a further signature is not allowed.
    let locked = approve(
        &certify(&base_pdf(), &keys, 1, &Options::default()),
        &Keys::p256(11),
        9,
        10,
    );
    let (_, verdict) = later_of(&validate(&locked).signatures[0].info.coverage);
    assert_eq!(verdict, Verdict::Disallowed);
}

// --- The hostile corpus -------------------------------------------------------------------------------------------------

fn expect_not_valid(bytes: &[u8], what: &str) {
    if let Ok(validation) = validate_bytes(bytes, Instant::now() + Duration::from_secs(60)) {
        for signature in &validation.signatures {
            assert_ne!(signature.info.cryptographic, Cryptographic::Valid, "{what}");
        }
    }
}

#[test]
fn empty_and_null_contents_are_malformed() {
    // Universal signature forgery: nothing to verify must never read as valid.
    let keys = Keys::p256(7);
    for contents in [vec![], vec![0u8; 32]] {
        let signed = certify(
            &base_pdf(),
            &keys,
            2,
            &Options {
                contents: Some(contents),
                ..Options::default()
            },
        );
        assert_eq!(only(&signed).cryptographic, Cryptographic::Malformed);
    }
}

#[test]
fn a_byte_range_that_is_wrapped_overlapping_negative_or_huge_is_malformed() {
    let keys = Keys::p256(7);
    let signed = certify(&base_pdf(), &keys, 2, &Options::default());
    let start = rfind_bytes(&signed, b"/ByteRange [") + "/ByteRange ".len();
    let original = String::from_utf8_lossy(&signed[start..start + 36]).into_owned();
    let original = original.as_str();
    let numbers: Vec<i64> = original
        .trim_matches(|c| c == '[' || c == ']')
        .split_whitespace()
        .map(|n| n.parse().unwrap())
        .collect();
    let (a, b, c) = (numbers[1], numbers[2], numbers[3]);
    let cases: Vec<(&str, [i64; 4])> = vec![
        ("starts late", [1, a, b, c]),
        ("overlap", [0, b, a, c]),
        ("second range overlaps the gap", [0, a, b - 40, c + 40]),
        (
            "signature wrapping: a range hidden before the gap",
            [0, a - 20, b, c],
        ),
        ("gap grown past the token", [0, a, b + 20, c - 20]),
        ("ends before the revision end", [0, a, b, c - 30]),
        ("beyond the file", [0, a, b, c + 1000]),
        ("negative", [0, -5, b, c]),
        ("negative length", [0, a, b, -1]),
        ("huge", [0, a, 2_147_483_647, 2_147_483_647]),
        ("zero", [0, 0, 0, 0]),
    ];
    for (what, [w, x, y, z]) in cases {
        // The new range is written with the same width, so no offset moves.
        let range = format!("[{w} {x} {y} {z}]");
        let padded = format!("{range:<36}");
        let mut bytes = signed.clone();
        let at = rfind_bytes(&signed, b"/ByteRange [") + "/ByteRange ".len();
        bytes[at..at + 36].copy_from_slice(padded.as_bytes());
        let validation = validate_bytes(&bytes, Instant::now() + Duration::from_secs(60)).unwrap();
        assert_eq!(
            validation.signatures[0].info.cryptographic,
            Cryptographic::Malformed,
            "{what}"
        );
    }
}

#[test]
fn an_oversized_contents_is_malformed_and_cheap() {
    let keys = Keys::p256(7);
    let signed = certify(
        &base_pdf(),
        &keys,
        2,
        &Options {
            size: Some(600 * 1024),
            ..Options::default()
        },
    );
    let started = Instant::now();
    assert_eq!(only(&signed).cryptographic, Cryptographic::Malformed);
    assert!(started.elapsed() < Duration::from_secs(20));
}

#[test]
fn a_truncated_cms_is_malformed() {
    let keys = Keys::p256(7);
    for keep in [0usize, 1, 4, 30, 120, 400] {
        let transform: fn(Vec<u8>) -> Vec<u8> = match keep {
            0 => |der| der[..0].to_vec(),
            1 => |der| der[..1].to_vec(),
            4 => |der| der[..4].to_vec(),
            30 => |der| der[..30].to_vec(),
            120 => |der| der[..120].to_vec(),
            _ => |der| der[..400].to_vec(),
        };
        let signed = certify(
            &base_pdf(),
            &keys,
            2,
            &Options {
                transform: Some(transform),
                ..Options::default()
            },
        );
        assert_ne!(
            only(&signed).cryptographic,
            Cryptographic::Valid,
            "{keep} bytes"
        );
    }
}

#[test]
fn a_ber_encoded_cms_is_accepted_through_the_normalizer() {
    // The same SignedData with indefinite lengths on the two outer levels: ContentInfo and its [0] wrapper.
    fn to_ber(der: Vec<u8>) -> Vec<u8> {
        // 30 <len> 06 09 <oid> A0 <len> <signed data>
        let (content_start, _) = header(&der);
        let oid_end = content_start + 2 + 9;
        let wrapper = &der[oid_end..];
        let (inner_start, _) = header(wrapper);
        let signed_data = &wrapper[inner_start..];
        let mut out = vec![0x30, 0x80];
        out.extend_from_slice(&der[content_start..oid_end]);
        out.extend_from_slice(&[0xA0, 0x80]);
        out.extend_from_slice(signed_data);
        out.extend_from_slice(&[0, 0, 0, 0]);
        out
    }
    /// (offset of the content, content length) of the TLV at the start of `bytes`.
    fn header(bytes: &[u8]) -> (usize, usize) {
        if bytes[1] < 0x80 {
            (2, usize::from(bytes[1]))
        } else {
            let count = usize::from(bytes[1] & 0x7f);
            let len = bytes[2..2 + count]
                .iter()
                .fold(0usize, |acc, b| acc << 8 | usize::from(*b));
            (2 + count, len)
        }
    }
    let keys = Keys::p256(7);
    let signed = certify(
        &base_pdf(),
        &keys,
        2,
        &Options {
            transform: Some(to_ber),
            ..Options::default()
        },
    );
    assert_eq!(only(&signed).cryptographic, Cryptographic::Valid);
}

#[test]
fn unknown_subfilters_and_missing_values_do_not_verify() {
    let keys = Keys::p256(7);
    let signed = certify(&base_pdf(), &keys, 2, &Options::default());
    // The SubFilter renamed to something else of the same length (byte level: the file is binary).
    let other = replace_same_len(&signed, b"/ETSI.CAdES.detached", b"/ETSI.CAdES.detachdd");
    let info = only(&other);
    assert_eq!(info.sub_filter, SubFilter::Other);
    assert_eq!(info.cryptographic, Cryptographic::UnsupportedAlgorithm);
    let rfc = replace_same_len(&signed, b"/ETSI.CAdES.detached", b"/ETSI.RFC3161       ");
    let info = only(&rfc);
    assert_eq!(info.sub_filter, SubFilter::EtsiRfc3161);
    assert_ne!(info.cryptographic, Cryptographic::Valid);
    // No /Contents key where the gap is.
    let renamed = replace_same_len(&signed, b"/Contents <", b"/Contents2<");
    expect_not_valid(&renamed, "renamed key");
}

#[test]
fn a_signed_file_cut_or_corrupted_anywhere_never_panics() {
    let keys = Keys::p256(7);
    let signed = approve(
        &certify(&base_pdf(), &keys, 2, &Options::default()),
        &Keys::p256(11),
        9,
        10,
    );
    // Every prefix on a coarse grid.
    let mut at = 0;
    while at < signed.len() {
        expect_not_valid_or_whole(&signed[..at]);
        at += 97;
    }
    // A flipped byte on a grid, and a zeroed run.
    let mut at = 0;
    while at < signed.len() {
        let mut copy = signed.clone();
        copy[at] ^= 0x5a;
        expect_not_valid_or_whole(&copy);
        at += 211;
    }
    for run in [0usize, 1000, 6000, 9000] {
        if run + 500 < signed.len() {
            let mut copy = signed.clone();
            copy[run..run + 500].fill(0);
            expect_not_valid_or_whole(&copy);
        }
    }
    // Plain garbage.
    for junk in [
        &b""[..],
        b"%PDF-1.7",
        b"%PDF-1.7\nstartxref\n0\n%%EOF",
        &[0xff; 4096],
    ] {
        expect_not_valid_or_whole(junk);
    }
}

/// Only that nothing panics and that a `Valid` verdict is never given to a file that was changed.
fn expect_not_valid_or_whole(bytes: &[u8]) {
    let _ = validate_bytes(bytes, Instant::now() + Duration::from_secs(60));
}

#[test]
fn a_past_deadline_leaves_the_rest_unverifiable_and_the_report_truncated() {
    let keys = Keys::p256(7);
    let signed = certify(&base_pdf(), &keys, 2, &Options::default());
    let validation = validate_bytes(&signed, Instant::now() - Duration::from_secs(1)).unwrap();
    assert!(validation.truncated);
    assert_eq!(
        validation.signatures[0].info.cryptographic,
        Cryptographic::Unverifiable
    );
}

#[test]
fn a_document_without_signatures_has_an_empty_report_and_no_lock() {
    let validation = validate(&base_pdf());
    assert!(validation.signatures.is_empty());
    assert_eq!(validation.lock, SignatureLock::None);
    assert!(!validation.truncated);
}

// --- The commands against the real PDFium ---------------------------------------------------------------------------------

struct Scratch(PathBuf);

impl Scratch {
    fn new(name: &str) -> Self {
        let path = std::env::temp_dir().join(format!("sheer-sigval-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn app(data: &std::path::Path) -> Option<AppState> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("pdfium");
    let library = engine::library_path(&root);
    if library.is_file() {
        Some(AppState::new(Engine::start(library)).with_data_dir(data.to_owned()))
    } else {
        eprintln!(
            "skipping the command tests: {} not found",
            library.display()
        );
        None
    }
}

#[test]
fn the_commands_validate_open_the_signed_revision_and_pin_a_signer() {
    let scratch = Scratch::new("commands");
    let data = scratch.0.join("data");
    let Some(state) = app(&data) else {
        return;
    };
    let keys = Keys::p256(7);
    let first = certify(&base_pdf(), &keys, 2, &Options::default());
    let both = fill_form(&approve(&first, &Keys::p256(11), 9, 10));
    let path = scratch.0.join("doc.pdf");
    std::fs::write(&path, &both).unwrap();
    let info = state
        .open_path(path)
        .unwrap_or_else(|error| panic!("open failed: {error:?}"))
        .expect("loaded");

    let report = state
        .validate_signatures_with(info.id, std::collections::HashSet::new)
        .unwrap();
    assert_eq!(report.signatures.len(), 2);
    assert_eq!(report.lock, SignatureLock::FillAndSign);
    assert!(!report.truncated);
    assert!(report
        .signatures
        .iter()
        .all(|s| s.trust == Trust::NotTrusted));
    let widget = report.signatures[0].widget.expect("a visible seal");
    assert_eq!(widget.rect.w, 90.0);

    // View signed version: the exact bytes of the first signature, read-only, no recent.
    let event = state.open_signed_revision(info.id, 0).unwrap();
    let AppEvent::Opened { document } = event else {
        panic!("expected opened, got {event:?}");
    };
    assert_eq!(document.kind, DocKind::SignedRevision);
    assert_eq!(document.page_count, 1);
    assert_ne!(document.id, info.id);
    // Saving it in place is refused; it is the signed bytes, not a document of the user's.
    assert_eq!(
        state
            .save_in_place(document.id, Default::default())
            .unwrap_err()
            .code(),
        ErrorCode::ReadOnly
    );
    assert_eq!(
        state.open_signed_revision(info.id, 7).unwrap_err().code(),
        ErrorCode::NotFound
    );
    // What was opened validates as exactly the first signature, over the whole file.
    let revision_report = state
        .validate_signatures_with(document.id, std::collections::HashSet::new)
        .unwrap();
    assert_eq!(revision_report.signatures.len(), 1);
    assert_eq!(revision_report.signatures[0].coverage, Coverage::WholeFile);
    assert_eq!(
        revision_report.signatures[0].cryptographic,
        Cryptographic::Valid
    );

    // Pins: taken from the document, listed, shown as trusted, removed.
    let pinned = state
        .set_signer_trust_with(info.id, 0, true, std::collections::HashSet::new)
        .unwrap();
    assert_eq!(pinned.signatures[0].trust, Trust::TrustedByYou);
    assert_eq!(pinned.signatures[1].trust, Trust::NotTrusted);
    let list = state.list_trusted_signers();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].common_name, "Ada P256");
    let own: std::collections::HashSet<String> =
        [list[0].fingerprint.clone()].into_iter().collect();
    let again = state
        .validate_signatures_with(info.id, move || own)
        .unwrap();
    assert_eq!(again.signatures[0].trust, Trust::OwnIdentity);
    assert_eq!(
        state
            .remove_trusted_signer("0".repeat(64).as_str())
            .unwrap_err()
            .code(),
        ErrorCode::NotFound
    );
    assert_eq!(
        state.remove_trusted_signer("xyz").unwrap_err().code(),
        ErrorCode::InvalidArgument
    );
    state.remove_trusted_signer(&list[0].fingerprint).unwrap();
    assert!(state.list_trusted_signers().is_empty());
    let unpinned = state
        .set_signer_trust_with(info.id, 0, false, std::collections::HashSet::new)
        .unwrap();
    assert_eq!(unpinned.signatures[0].trust, Trust::NotTrusted);
}

#[test]
fn a_signature_that_does_not_verify_cannot_be_pinned() {
    let scratch = Scratch::new("nopin");
    let data = scratch.0.join("data");
    let Some(state) = app(&data) else {
        return;
    };
    let keys = Keys::p256(7);
    let mut signed = certify(&base_pdf(), &keys, 2, &Options::default());
    let at = find(&signed, b"0 0 1 rg");
    signed[at] = b'1';
    let path = scratch.0.join("tampered.pdf");
    std::fs::write(&path, &signed).unwrap();
    let info = state
        .open_path(path)
        .unwrap_or_else(|error| panic!("open failed: {error:?}"))
        .expect("loaded");
    let error = state
        .set_signer_trust_with(info.id, 0, true, std::collections::HashSet::new)
        .unwrap_err();
    assert_eq!(error.code(), ErrorCode::InvalidArgument);
    assert!(state.list_trusted_signers().is_empty());
    // A document that is not open is not found.
    assert_eq!(
        state
            .validate_signatures_with(
                serde_json::from_value::<sheer_lib::documents::DocumentId>(serde_json::json!(9999))
                    .unwrap(),
                std::collections::HashSet::new
            )
            .unwrap_err()
            .code(),
        ErrorCode::NotFound
    );
}

fn rfind_bytes(haystack: &[u8], needle: &[u8]) -> usize {
    haystack
        .windows(needle.len())
        .rposition(|w| w == needle)
        .expect("needle present")
}

fn replace_same_len(bytes: &[u8], from: &[u8], to: &[u8]) -> Vec<u8> {
    assert_eq!(from.len(), to.len());
    let mut out = bytes.to_vec();
    let at = rfind_bytes(bytes, from);
    out[at..at + from.len()].copy_from_slice(to);
    out
}
