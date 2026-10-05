//! Certificate signatures, written and read back (ADR-121 section 1, SECURITY I18): the CMS is decoded and verified here, the
//! `/ByteRange` covers everything but `/Contents`, the bytes before the new revision are the original ones, and the real PDFium
//! reopens and draws the signed file. The PDFium tests skip, loudly, when the library is not fetched.

#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use std::path::PathBuf;
use std::str::FromStr;
use std::sync::OnceLock;
use std::time::{Duration, SystemTime};

use cms::content_info::ContentInfo;
use cms::signed_data::SignedData;
use der::{Decode, Encode};
use p256::ecdsa::signature::Verifier;
use p256::pkcs8::DecodePublicKey;
use sha2::{Digest, Sha256};
use sheer_lib::commands::save::SaveAck;
use sheer_lib::commands::sign::SignJob;
use sheer_lib::commands::AppState;
use sheer_lib::documents::DocumentId;
use sheer_lib::engine::{self, Engine, Priority, RenderKey, RenderSpec};
use sheer_lib::error::ErrorCode;
use sheer_lib::menu::spec::MenuLocale;
use sheer_lib::model::geometry::Rect;
use sheer_lib::pdfsig::cms_build;
use sheer_lib::pdfsig::material::{SignerKey, SignerMaterial};
use sheer_lib::pdfsig::types::{SealPlacement, SignLock, SignRequest, SignatureLock};
use sheer_lib::pdfwrite::sign::{self, SignPlan, Stamp};
use sheer_lib::pdfwrite::{load_untrusted, sigread};
use support::fixtures::{add_pages, page_id, Page};
use support::PdfBuilder;
use x509_cert::builder::{Builder, CertificateBuilder, Profile};
use x509_cert::name::Name;
use x509_cert::serial_number::SerialNumber;
use x509_cert::time::Validity;
use x509_cert::Certificate;

type Res<T> = Result<T, Box<dyn std::error::Error>>;

fn certificate<K>(key: &K, name: &str, serial: u32) -> Res<Certificate>
where
    K: p256::ecdsa::signature::Keypair
        + spki::DynSignatureAlgorithmIdentifier
        + p256::ecdsa::signature::Signer<p256::ecdsa::DerSignature>,
    K::VerifyingKey: spki::EncodePublicKey,
{
    let spki = spki::SubjectPublicKeyInfoOwned::from_key(key.verifying_key())?;
    Ok(CertificateBuilder::new(
        Profile::Manual { issuer: None },
        SerialNumber::from(serial),
        Validity::from_now(Duration::from_secs(30 * 86_400))?,
        Name::from_str(&format!("CN={name}"))?,
        spki,
        key,
    )?
    .build::<p256::ecdsa::DerSignature>()?)
}

fn p256_material(name: &str, seed: u8) -> Res<SignerMaterial> {
    let key = p256::ecdsa::SigningKey::from_slice(&[seed; 32])?;
    let cert = certificate(&key, name, 11)?;
    Ok(SignerMaterial {
        key: SignerKey::EcdsaP256(key),
        chain: vec![cert],
    })
}

fn p384_material(name: &str) -> Res<SignerMaterial> {
    let key = p384::ecdsa::SigningKey::from_slice(&[9u8; 48])?;
    let spki = spki::SubjectPublicKeyInfoOwned::from_key(*key.verifying_key())?;
    let cert = CertificateBuilder::new(
        Profile::Manual { issuer: None },
        SerialNumber::from(12u32),
        Validity::from_now(Duration::from_secs(30 * 86_400))?,
        Name::from_str(&format!("CN={name}"))?,
        spki,
        &key,
    )?
    .build::<p384::ecdsa::DerSignature>()?;
    Ok(SignerMaterial {
        key: SignerKey::EcdsaP384(key),
        chain: vec![cert],
    })
}

/// A one-page document with some text.
fn fixture() -> Vec<u8> {
    let mut builder = PdfBuilder::new();
    add_pages(
        &mut builder,
        &[Page::new("BT /F1 14 Tf 72 700 Td (Contract text) Tj ET")],
    );
    builder.object(1, "<< /Type /Catalog /Pages 2 0 R >>");
    builder.finish(1)
}

fn plan(material: &SignerMaterial, lock: SignLock) -> SignPlan {
    let stamp = Stamp::of(
        &jiff::civil::date(2026, 10, 5)
            .at(14, 5, 9, 0)
            .in_tz("Europe/Berlin")
            .unwrap(),
    );
    SignPlan {
        placement: Some((
            0,
            Rect {
                x: 72.0,
                y: 100.0,
                w: 192.0,
                h: 64.0,
            },
        )),
        name: cms_build::signer_name(material).unwrap(),
        signed_at: stamp.pdf,
        date_line: stamp.seal,
        signed_label: "Digitally signed".into(),
        reason_line: Some("Reason: I approve".into()),
        reason: Some("I approve".into()),
        location: Some("Berlin".into()),
        art: None,
        lock,
        contents_len: cms_build::contents_capacity(material).unwrap(),
    }
}

/// Signs `bytes` with `material`: one appended revision.
fn sign_bytes(bytes: &[u8], material: &SignerMaterial, lock: SignLock) -> Vec<u8> {
    let doc = load_untrusted(bytes).unwrap();
    let prepared = sign::prepare(bytes.to_vec(), doc, &plan(material, lock)).unwrap();
    let digest = cms_build::digest_ranges(&prepared.bytes, &prepared.gap).unwrap();
    let cms = cms_build::sign(&digest, material).unwrap();
    sign::finish(prepared, &cms).unwrap()
}

/// The length of the DER element at the start of `bytes` (the CMS is followed by the zeros of the placeholder).
fn der_len(bytes: &[u8]) -> usize {
    assert_eq!(bytes[0], 0x30, "a SEQUENCE");
    if bytes[1] < 0x80 {
        return 2 + usize::from(bytes[1]);
    }
    let count = usize::from(bytes[1] & 0x7F);
    let len = bytes[2..2 + count]
        .iter()
        .fold(0usize, |acc, b| (acc << 8) | usize::from(*b));
    2 + count + len
}

fn unhex(text: &[u8]) -> Vec<u8> {
    text.chunks(2)
        .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
        .collect()
}

/// What the file says about its signature number `index` and what a verifier computes from it.
struct Checked {
    signer: Certificate,
    range: [usize; 4],
    sub_filter: String,
    cert_p: Option<u8>,
    attribute_count: usize,
}

/// Verifies signature `index`: the ByteRange, the digest of the covered bytes, the ESS binding and the signature over the attributes.
fn verify(file: &[u8], index: usize) -> Checked {
    let scan = sigread::scan_bytes(file).unwrap();
    let field = &scan.fields[index];
    let range: Vec<usize> = field
        .byte_range
        .clone()
        .unwrap()
        .iter()
        .map(|n| usize::try_from(*n).unwrap())
        .collect();
    let [zero, a, b, c] = range[..] else {
        panic!("four numbers")
    };
    assert_eq!(zero, 0);
    assert!(a < b && b + c <= file.len());
    // The gap is exactly the /Contents string: both brackets, nothing else.
    assert_eq!(file[a], b'<');
    assert_eq!(file[b - 1], b'>');
    assert_eq!(b - a, field.contents_len.unwrap() * 2 + 2);
    let hex = &file[a + 1..b - 1];
    assert!(hex.iter().all(u8::is_ascii_hexdigit));
    let covered = [&file[..a], &file[b..b + c]].concat();
    assert_eq!(covered.len(), file.len() - (b - a) - (file.len() - b - c));

    let der = unhex(hex);
    let der = &der[..der_len(&der)];
    let info = ContentInfo::from_der(der).unwrap();
    let signed: SignedData = info.content.decode_as().unwrap();
    assert_eq!(signed.signer_infos.0.len(), 1);
    assert!(signed.encap_content_info.econtent.is_none(), "detached");
    let signer_info = signed.signer_infos.0.iter().next().unwrap();
    assert_eq!(
        signer_info.digest_alg.oid.to_string(),
        "2.16.840.1.101.3.4.2.1"
    );
    let attrs = signer_info.signed_attrs.as_ref().unwrap();
    let find = |oid: &str| {
        attrs
            .iter()
            .find(|attr| attr.oid.to_string() == oid)
            .unwrap_or_else(|| panic!("attribute {oid}"))
    };
    // message-digest is SHA-256 of the covered bytes.
    let digest_value = find("1.2.840.113549.1.9.4")
        .values
        .iter()
        .next()
        .unwrap()
        .decode_as::<der::asn1::OctetString>()
        .unwrap();
    assert_eq!(digest_value.as_bytes(), Sha256::digest(&covered).as_slice());
    assert_eq!(
        find("1.2.840.113549.1.9.3")
            .values
            .iter()
            .next()
            .unwrap()
            .decode_as::<der::asn1::ObjectIdentifier>()
            .unwrap()
            .to_string(),
        "1.2.840.113549.1.7.1"
    );
    assert!(
        attrs
            .iter()
            .all(|attr| attr.oid.to_string() != "1.2.840.113549.1.9.5"),
        "no signing time"
    );
    // The signer certificate is the one the issuerAndSerialNumber names, and ESS binds its hash.
    let cms::signed_data::SignerIdentifier::IssuerAndSerialNumber(sid) = &signer_info.sid else {
        panic!("issuerAndSerialNumber")
    };
    let certs = signed.certificates.as_ref().unwrap();
    let signer = certs
        .0
        .iter()
        .find_map(|choice| match choice {
            cms::cert::CertificateChoices::Certificate(cert)
                if cert.tbs_certificate.serial_number == sid.serial_number
                    && cert.tbs_certificate.issuer == sid.issuer =>
            {
                Some(cert.clone())
            }
            _ => None,
        })
        .expect("the signer certificate is in the CMS");
    let ess = find("1.2.840.113549.1.9.16.2.47")
        .values
        .iter()
        .next()
        .unwrap()
        .to_der()
        .unwrap();
    let cert_hash = Sha256::digest(signer.to_der().unwrap());
    assert!(
        ess.windows(32).any(|w| w == cert_hash.as_slice()),
        "signing-certificate-v2 holds the SHA-256 of the signer certificate"
    );
    // The signature is over the DER SET OF signed attributes.
    let spki_der = signer
        .tbs_certificate
        .subject_public_key_info
        .to_der()
        .unwrap();
    let alg = signer_info.signature_algorithm.oid.to_string();
    match alg.as_str() {
        "1.2.840.10045.4.3.2" => {
            let key = p256::ecdsa::VerifyingKey::from_public_key_der(&spki_der).unwrap();
            let signature =
                p256::ecdsa::DerSignature::from_bytes(signer_info.signature.as_bytes()).unwrap();
            key.verify(&attrs.to_der().unwrap(), &signature)
                .expect("ECDSA P-256 verifies");
        }
        "1.2.840.10045.4.3.3" => {
            let key = p384::ecdsa::VerifyingKey::from_public_key_der(&spki_der).unwrap();
            let signature =
                p384::ecdsa::DerSignature::from_bytes(signer_info.signature.as_bytes()).unwrap();
            key.verify(&attrs.to_der().unwrap(), &signature)
                .expect("ECDSA P-384 verifies");
        }
        other => panic!("unexpected signature algorithm {other}"),
    }
    Checked {
        signer,
        range: [zero, a, b, c],
        sub_filter: field.sub_filter.clone().unwrap(),
        cert_p: field.cert_p,
        attribute_count: attrs.len(),
    }
}

#[test]
fn a_p256_certification_signature_verifies_and_covers_all_but_contents() {
    let original = fixture();
    let material = p256_material("Ada Lovelace", 7).unwrap();
    let signed = sign_bytes(&original, &material, SignLock::AllowFillAndSign);
    // One appended revision: the original bytes are the first bytes of the file.
    assert_eq!(&signed[..original.len()], &original[..]);
    assert!(signed.len() > original.len());
    let checked = verify(&signed, 0);
    assert_eq!(checked.sub_filter, "ETSI.CAdES.detached");
    assert_eq!(checked.cert_p, Some(2));
    assert_eq!(checked.attribute_count, 3);
    assert_eq!(
        checked.range[3] + checked.range[2],
        signed.len(),
        "to the end of the file"
    );
    // The tail of the file is a revision end.
    assert!(signed.ends_with(b"%%EOF"));
    // A byte flipped outside the gap changes the digest the signature carries.
    let mut tampered = signed.clone();
    tampered[original.len() / 2] ^= 1;
    let (a, b) = (checked.range[1], checked.range[2]);
    let digest = cms_build::digest_ranges(&tampered, &(a..b)).unwrap();
    let original_digest = cms_build::digest_ranges(&signed, &(a..b)).unwrap();
    assert_ne!(digest, original_digest);
    // The signer certificate in the file is the identity's.
    assert_eq!(checked.signer, material.chain[0]);
}

#[test]
fn a_p384_signature_verifies() {
    let material = p384_material("Grace Hopper").unwrap();
    let signed = sign_bytes(&fixture(), &material, SignLock::NoChanges);
    let checked = verify(&signed, 0);
    assert_eq!(checked.cert_p, Some(1));
}

#[test]
fn a_second_signature_approves_and_leaves_the_first_intact() {
    let original = fixture();
    let first = sign_bytes(
        &original,
        &p256_material("Ada", 7).unwrap(),
        SignLock::AllowFillAndSign,
    );
    let second = sign_bytes(
        &first,
        &p384_material("Grace").unwrap(),
        SignLock::AllowFillAndSign,
    );
    assert_eq!(&second[..first.len()], &first[..]);
    let one = verify(&second, 0);
    let two = verify(&second, 1);
    assert_eq!(one.cert_p, Some(2));
    assert_eq!(
        two.cert_p, None,
        "an approval signature has no DocMDP reference"
    );
    // The first signature covers its own revision only; the second covers the whole file.
    assert_eq!(one.range[3] + one.range[2], first.len());
    assert_eq!(two.range[3] + two.range[2], second.len());
    let scan = sigread::scan_bytes(&second).unwrap();
    assert_eq!(scan.doc_mdp, Some(2));
    assert_eq!(scan.fields[1].name, "Signature2");
}

#[test]
fn the_size_of_contents_follows_the_chain() {
    let mut material = p256_material("Ada", 7).unwrap();
    let alone = cms_build::contents_capacity(&material).unwrap();
    let root = material.chain[0].clone();
    material.chain.push(root);
    assert!(cms_build::contents_capacity(&material).unwrap() >= alone);
    let signed = sign_bytes(&fixture(), &material, SignLock::AllowFillAndSign);
    verify(&signed, 0);
}

// --- With the real PDFium ----------------------------------------------------------------------------------------------

struct Scratch(PathBuf);

impl Scratch {
    fn new(name: &str) -> Self {
        let path = std::env::temp_dir().join(format!("sheer-sign-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }
    fn file(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn state() -> Option<&'static AppState> {
    static STATE: OnceLock<Option<AppState>> = OnceLock::new();
    STATE
        .get_or_init(|| {
            let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("pdfium");
            let library = engine::library_path(&root);
            if !library.is_file() {
                eprintln!(
                    "SKIPPED: PDFium is not fetched ({} not found); the sign round-trip tests with PDFium did not run",
                    library.display()
                );
                return None;
            }
            Some(AppState::new(Engine::start(library)))
        })
        .as_ref()
}

fn open(state: &AppState, scratch: &Scratch, name: &str, bytes: &[u8]) -> DocumentId {
    let path = scratch.file(name);
    std::fs::write(&path, bytes).unwrap();
    state.open_path(path).unwrap().expect("loaded").id
}

fn job(state: &AppState, id: DocumentId, placed: bool, lock: SignLock) -> SignJob {
    let page = state.pages(id).unwrap()[0].id;
    SignJob {
        request: SignRequest {
            identity_id: "0".repeat(32),
            placement: placed.then_some(SealPlacement {
                page_id: page,
                rect: Rect {
                    x: 72.0,
                    y: 100.0,
                    w: 192.0,
                    h: 64.0,
                },
            }),
            art: None,
            reason: Some("I approve".into()),
            location: Some("Berlin".into()),
            lock,
        },
        material: p256_material("Ada Lovelace", 7).unwrap(),
        art: None,
        locale: MenuLocale::En,
        stamp: Stamp::now(),
        now: SystemTime::now(),
    }
}

fn render(state: &AppState, id: DocumentId) -> Vec<u8> {
    state
        .engine()
        .render(RenderSpec {
            key: RenderKey {
                id,
                page_index: 0,
                bucket: 0,
                tile: None,
            },
            priority: Priority::Visible,
            generation: 1,
        })
        .unwrap()
        .to_vec()
}

#[test]
fn pdfium_reopens_the_signed_copy_and_draws_the_seal() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("copy");
    let original = fixture();
    let id = open(state, &scratch, "a.pdf", &original);
    let before = render(state, id);

    let target = scratch.file("a (signed).pdf");
    let result = state
        .sign_into(
            id,
            &target,
            job(state, id, true, SignLock::AllowFillAndSign),
        )
        .unwrap();
    // A new document was opened from the new file; the original stays open and untouched.
    assert_ne!(result.document.id, id);
    assert_eq!(result.document.page_count, 1);
    assert_eq!(result.document.signature_lock, SignatureLock::FillAndSign);
    assert_eq!(std::fs::read(scratch.file("a.pdf")).unwrap(), original);
    let signed = std::fs::read(&target).unwrap();
    assert_eq!(&signed[..original.len()], &original[..]);
    verify(&signed, 0);
    assert_ne!(
        render(state, result.document.id),
        before,
        "the seal is on the page"
    );
    assert_eq!(render(state, id), before);
}

#[test]
fn signing_in_place_reloads_the_document_and_keeps_the_original_bytes_first() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("inplace");
    let original = fixture();
    let id = open(state, &scratch, "b.pdf", &original);
    let path = scratch.file("b.pdf");
    let result = state
        .sign_into(id, &path, job(state, id, false, SignLock::NoChanges))
        .unwrap();
    assert_eq!(result.document.id, id);
    assert_eq!(result.document.signature_lock, SignatureLock::Locked);
    let signed = std::fs::read(&path).unwrap();
    assert_eq!(&signed[..original.len()], &original[..]);
    verify(&signed, 0);
    assert!(
        render(state, id).len() > 16,
        "the engine has the signed file"
    );
    // Signed with P=1, the document refuses another signature.
    let error = state
        .sign_into(
            id,
            &scratch.file("c.pdf"),
            job(state, id, false, SignLock::AllowFillAndSign),
        )
        .unwrap_err();
    assert_eq!(error.code(), ErrorCode::ReadOnly);
}

#[test]
fn a_dirty_document_and_a_changed_file_are_refused_and_nothing_is_written() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("refuse");
    let original = fixture();
    let id = open(state, &scratch, "d.pdf", &original);
    let target = scratch.file("d (signed).pdf");
    // The file changed on disk since it was opened.
    let mut changed = original.clone();
    changed.extend_from_slice(b"\n%changed\n");
    std::fs::write(scratch.file("d.pdf"), &changed).unwrap();
    let error = state
        .sign_into(
            id,
            &target,
            job(state, id, true, SignLock::AllowFillAndSign),
        )
        .unwrap_err();
    assert_eq!(error.code(), ErrorCode::NeedsConfirmation);
    assert!(!target.exists());
    std::fs::write(scratch.file("d.pdf"), &original).unwrap();

    // Unsaved edits.
    let rotate = serde_json::from_value(
        serde_json::json!({"type": "rotatePages", "pages": [0], "quarterTurns": 1}),
    )
    .unwrap();
    state.apply_command(id, rotate).unwrap();
    let error = state
        .sign_into(
            id,
            &target,
            job(state, id, true, SignLock::AllowFillAndSign),
        )
        .unwrap_err();
    assert_eq!(error.code(), ErrorCode::UnsavedChanges);
    assert!(!target.exists());
}

/// One page and a text field `name` in an AcroForm.
fn form_fixture() -> Vec<u8> {
    let mut builder = PdfBuilder::new();
    add_pages(
        &mut builder,
        &[Page::new("BT /F1 14 Tf 72 700 Td (Form) Tj ET").with("/Annots [100 0 R]")],
    );
    let page = page_id(0);
    builder.object(
        100,
        &format!(
            "<< /Type /Annot /Subtype /Widget /FT /Tx /T (name) /V (Ada) /Rect [72 500 272 520] /P {page} 0 R >>"
        ),
    );
    builder.object(
        1,
        "<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [100 0 R] >> >>",
    );
    builder.finish(1)
}

/// ADR-123: a certification signature with P=2 (the "fill in forms" choice) allows form entries and a second signature, and nothing else.
#[test]
fn p2_allows_form_fill_and_a_second_signature_but_no_other_edit() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("p2");
    let id = open(state, &scratch, "f.pdf", &form_fixture());
    let path = scratch.file("f.pdf");
    let first = state
        .sign_into(id, &path, job(state, id, false, SignLock::AllowFillAndSign))
        .unwrap();
    assert_eq!(first.document.id, id);
    assert_eq!(first.document.signature_lock, SignatureLock::FillAndSign);

    let field = state
        .get_form_fields(id)
        .unwrap()
        .fields
        .iter()
        .find(|f| f.name == "name")
        .map(|f| f.id.get())
        .expect("field");
    let fill: sheer_lib::model::command::DocCommand = serde_json::from_value(serde_json::json!(
        {"type": "setFieldValue", "field": field, "value": {"type": "text", "text": "Grace"}}
    ))
    .unwrap();
    state.apply_command(id, fill).unwrap();
    let rotate: sheer_lib::model::command::DocCommand = serde_json::from_value(
        serde_json::json!({"type": "rotatePages", "pages": [0], "quarterTurns": 1}),
    )
    .unwrap();
    assert_eq!(
        state.apply_command(id, rotate).unwrap_err().code(),
        ErrorCode::ReadOnly
    );

    // The entry is saved as an increment, then a second signature is allowed.
    state.save_in_place(id, SaveAck::default()).unwrap();
    let second_path = scratch.file("f2.pdf");
    let second = state
        .sign_into(id, &second_path, job(state, id, false, SignLock::NoChanges))
        .unwrap();
    assert_eq!(second.document.signature_lock, SignatureLock::FillAndSign);
    let bytes = std::fs::read(&second_path).unwrap();
    assert_eq!(sigread::scan_bytes(&bytes).unwrap().fields.len(), 2);
    verify(&bytes, 1);
}
