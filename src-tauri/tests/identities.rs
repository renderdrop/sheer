//! Signing identities end to end (ADR-121 section 3; SECURITY I16, I17, D9, P23): create, list, delete, export, the PKCS#12 import with
//! generated files (AES and the legacy 3DES and RC2 schemes), the password rules, the hostile-file caps, and the encrypted store with a
//! keychain double. No window and no real keychain.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use p12_keystore::{
    Certificate, EncryptionAlgorithm, KeyStore, KeyStoreEntry, MacAlgorithm, PrivateKeyChain,
};
use p256::ecdsa::signature::{Signer, Verifier};
use p256::ecdsa::{Signature, VerifyingKey};
use sheer_lib::commands::identities::{signer_material, Identities};
use sheer_lib::error::ErrorCode;
use sheer_lib::limits;
use sheer_lib::pdfsig::certgen;
use sheer_lib::pdfsig::material::SignerKey;
use sheer_lib::pdfsig::types::{IdentitySource, KeyKind, NewIdentitySpec, StoreStatus};
use sheer_lib::security::secret::Secret;
use sheer_lib::storage::identities::IdentityStore;
use sheer_lib::storage::keychain::{Keychain, SecretStore, StoreError};
use zeroize::Zeroizing;

// --- helpers ------------------------------------------------------------------------------------------------------------

struct TempDir(PathBuf);

impl TempDir {
    fn new() -> Self {
        static NEXT: AtomicU32 = AtomicU32::new(0);
        let path = std::env::temp_dir().join(format!(
            "sheer-identities-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&path).expect("temp dir");
        Self(path)
    }
    fn file(&self) -> PathBuf {
        self.0.join("signing").join("identities.bin")
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// A keychain double that several `Keychain`s (a "restart") can share.
#[derive(Clone, Default)]
struct Mem(Arc<Mutex<Option<Vec<u8>>>>);

impl Mem {
    fn peek(&self) -> Option<Vec<u8>> {
        self.0
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }
    fn keychain(&self) -> Keychain {
        Keychain::new(Box::new(self.clone()))
    }
}

impl SecretStore for Mem {
    fn get(&self) -> Result<Option<Zeroizing<Vec<u8>>>, StoreError> {
        Ok(self.peek().map(Zeroizing::new))
    }
    fn set(&self, secret: &[u8]) -> Result<(), StoreError> {
        *self.0.lock().unwrap_or_else(PoisonError::into_inner) = Some(secret.to_vec());
        Ok(())
    }
    fn delete(&self) -> Result<(), StoreError> {
        *self.0.lock().unwrap_or_else(PoisonError::into_inner) = None;
        Ok(())
    }
}

fn identities(dir: &TempDir, mem: &Mem) -> Identities {
    Identities::new(IdentityStore::new(dir.file(), mem.keychain()))
}

fn spec(name: &str) -> NewIdentitySpec {
    NewIdentitySpec {
        name: name.into(),
        email: Some("ada@example.org".into()),
        organization: Some("Analytical Engines".into()),
    }
}

fn secret(text: &str) -> Secret {
    Secret::new(text).expect("secret")
}

fn code<T>(result: Result<T, sheer_lib::error::AppError>) -> Option<ErrorCode> {
    result.err().map(|error| error.code())
}

/// A P-256 identity made by the generator, as a PKCS#12 file written by `p12-keystore` with the given scheme.
struct Made {
    chain: Vec<Vec<u8>>,
    key: Zeroizing<Vec<u8>>,
}

fn generated(name: &str) -> Made {
    let made = certgen::generate(&spec(name)).expect("generate");
    Made {
        chain: made.chain,
        key: made.key_pkcs8,
    }
}

fn keychain_entry(key: &[u8], id: &[u8], chain: &[Vec<u8>]) -> KeyStoreEntry {
    let certs = chain
        .iter()
        .map(|der| Certificate::from_der(der).expect("cert"));
    KeyStoreEntry::PrivateKeyChain(PrivateKeyChain::new(key, id, certs))
}

fn p12_with(
    made: &Made,
    password: &str,
    encryption: EncryptionAlgorithm,
    mac: MacAlgorithm,
) -> Vec<u8> {
    let mut store = KeyStore::new();
    store.add_entry("ada", keychain_entry(&made.key, b"id-1", &made.chain));
    store
        .writer(password)
        .encryption_algorithm(encryption)
        .mac_algorithm(mac)
        .write()
        .expect("write p12")
}

fn aes_p12(made: &Made, password: &str) -> Vec<u8> {
    p12_with(
        made,
        password,
        EncryptionAlgorithm::PbeWithHmacSha256AndAes256,
        MacAlgorithm::HmacSha256,
    )
}

// --- create, list, delete, export ----------------------------------------------------------------------------------------

#[test]
fn a_created_identity_signs_with_its_own_certificate_and_survives_a_restart() {
    let dir = TempDir::new();
    let mem = Mem::default();
    let first = identities(&dir, &mem);
    let info = first.create(&spec("Ada Lovelace")).expect("create");
    assert_eq!(info.key, KeyKind::EcP256);
    assert_eq!(info.source, IdentitySource::Generated);

    // "Restart": every in-memory object is new; the file and the keychain are the same.
    let second = identities(&dir, &mem);
    let listed = second.list().expect("list");
    assert_eq!(listed.status, StoreStatus::Ready);
    assert_eq!(listed.items, vec![info.clone()]);

    // The material signs, and the signature verifies with the public key of the certificate.
    let material = signer_material(&second, &info.id).expect("material");
    let SignerKey::EcdsaP256(key) = &material.key else {
        panic!("a P-256 key");
    };
    let signature: Signature = key.sign(b"the signed attributes");
    let (stem, der) = second.certificate(&info.id).expect("certificate");
    assert_eq!(stem, "Ada Lovelace");
    let cert = <x509_cert::Certificate as der::Decode>::from_der(&der).expect("cert");
    let point = cert
        .tbs_certificate
        .subject_public_key_info
        .subject_public_key
        .raw_bytes();
    let verifying = VerifyingKey::from_sec1_bytes(point).expect("public key");
    verifying
        .verify(b"the signed attributes", &signature)
        .expect("signature verifies");
    assert_eq!(material.chain.len(), 1);
}

#[test]
fn the_store_file_is_ciphertext_and_its_key_is_32_random_bytes_in_the_keychain() {
    let dir = TempDir::new();
    let mem = Mem::default();
    let ids = identities(&dir, &mem);
    let info = ids.create(&spec("Secret Name Qx")).expect("create");
    let bytes = std::fs::read(dir.file()).expect("file");
    assert_eq!(&bytes[..4], b"SHID");
    let text = String::from_utf8_lossy(&bytes);
    assert!(!text.contains("Secret Name Qx") && !text.contains("example.org"));
    assert_eq!(mem.peek().expect("key in the keychain").len(), 32);
    // Without that key the file cannot be read, and nothing is overwritten.
    let other = Mem::default();
    other.set(&[9u8; 32]).expect("another install's key");
    let locked = identities(&dir, &other);
    assert_eq!(locked.list().expect("list").status, StoreStatus::Locked);
    assert_eq!(
        code(locked.create(&spec("B"))),
        Some(ErrorCode::InvalidArgument)
    );
    assert_eq!(std::fs::read(dir.file()).expect("file"), bytes);
    assert!(ids.certificate(&info.id).is_ok());
}

#[test]
fn eight_at_most_and_a_missing_keychain_is_a_typed_error() {
    let dir = TempDir::new();
    let ids = identities(&dir, &Mem::default());
    for n in 0..limits::IDENTITIES_MAX {
        ids.create(&spec(&format!("Name {n}"))).expect("create");
    }
    assert_eq!(
        code(ids.create(&spec("Nine"))),
        Some(ErrorCode::LimitExceeded)
    );
    let first = ids.list().expect("list").items[0].id.clone();
    ids.delete(&first).expect("delete");
    ids.create(&spec("Nine")).expect("room again");

    let dir = TempDir::new();
    let none = Identities::new(IdentityStore::new(dir.file(), Keychain::unavailable()));
    assert_eq!(none.list().expect("list").status, StoreStatus::Unavailable);
    assert_eq!(
        code(none.create(&spec("A"))),
        Some(ErrorCode::KeychainUnavailable)
    );
    assert!(!dir.file().exists());
}

// --- import --------------------------------------------------------------------------------------------------------------

#[test]
fn a_generated_p12_round_trips_through_every_supported_scheme() {
    let schemes = [
        (
            EncryptionAlgorithm::PbeWithHmacSha256AndAes256,
            MacAlgorithm::HmacSha256,
        ),
        (
            EncryptionAlgorithm::PbeWithShaAnd3KeyTripleDesCbc,
            MacAlgorithm::HmacSha1,
        ),
        // The crate's name for PBE-SHA1-RC2-40.
        (
            EncryptionAlgorithm::PbeWithShaAnd40BitRc4Cbc,
            MacAlgorithm::HmacSha1,
        ),
    ];
    for (encryption, mac) in schemes {
        let made = generated("Imported Ada");
        let file = p12_with(&made, "correct horse", encryption, mac);
        let dir = TempDir::new();
        let mem = Mem::default();
        let ids = identities(&dir, &mem);
        let ticket = ids.begin_import(file, "ada.p12".into()).expect("ticket");
        assert_eq!(ticket.display_name, "ada.p12");
        let info = ids
            .import(ticket.ticket, &secret("correct horse"))
            .unwrap_or_else(|e| panic!("{encryption:?}: {e}"));
        assert_eq!(info.source, IdentitySource::Imported);
        assert_eq!(info.key, KeyKind::EcP256);
        assert_eq!(info.cert.subject.common_name, "Imported Ada");
        assert_eq!(
            info.cert.fingerprint_sha256,
            sheer_lib::pdfsig::identity::sha256_hex(&made.chain[0])
        );
        // The password is not kept: the ticket is used up, and the stored key signs without it.
        assert_eq!(
            code(ids.import(ticket.ticket, &secret("correct horse"))),
            Some(ErrorCode::NotFound)
        );
        let material = signer_material(&ids, &info.id).expect("material");
        assert!(matches!(material.key, SignerKey::EcdsaP256(_)));
        // The PKCS#8 bytes are not in the file.
        let bytes = std::fs::read(dir.file()).expect("file");
        assert!(!bytes
            .windows(32)
            .any(|w| w == &made.key[made.key.len() - 32..]));
        assert_eq!(ids.list().expect("list").items, vec![info]);
    }
}

#[test]
fn the_chain_of_a_p12_is_kept() {
    let leaf = generated("Leaf");
    let other = generated("Other CA");
    let mut chain = leaf.chain.clone();
    chain.extend(other.chain.clone());
    let made = Made {
        chain,
        key: leaf.key,
    };
    // `p12-keystore` follows issuer names, so a self-signed "Other CA" is not pulled into Leaf's chain: one certificate stays.
    let dir = TempDir::new();
    let ids = identities(&dir, &Mem::default());
    let ticket = ids
        .begin_import(aes_p12(&made, "pw"), "x.p12".into())
        .expect("ticket");
    let info = ids.import(ticket.ticket, &secret("pw")).expect("import");
    assert!(info.chain_length >= 1);
    assert_eq!(info.cert.subject.common_name, "Leaf");
}

#[test]
fn a_wrong_password_is_typed_keeps_the_ticket_and_the_right_one_then_works() {
    let made = generated("Ada");
    let dir = TempDir::new();
    let ids = identities(&dir, &Mem::default());
    let ticket = ids
        .begin_import(aes_p12(&made, "right"), "a.p12".into())
        .expect("ticket");
    for _ in 0..2 {
        assert_eq!(
            code(ids.import(ticket.ticket, &secret("wrong"))),
            Some(ErrorCode::PasswordRequired)
        );
    }
    assert!(ids.import(ticket.ticket, &secret("right")).is_ok());
}

#[test]
fn from_the_fourth_try_each_wrong_password_waits_and_the_fifth_drops_the_ticket() {
    let made = generated("Ada");
    let dir = TempDir::new();
    let ids = identities(&dir, &Mem::default());
    let ticket = ids
        .begin_import(aes_p12(&made, "right"), "a.p12".into())
        .expect("ticket");
    let started = Instant::now();
    for _ in 0..5 {
        assert_eq!(
            code(ids.import(ticket.ticket, &secret("wrong"))),
            Some(ErrorCode::PasswordRequired)
        );
    }
    // The 4th and the 5th try each waited out the delay after the wrong one before them.
    assert!(started.elapsed() >= limits::IDENTITY_PASSWORD_DELAY * 2 - Duration::from_millis(100));
    // Dropped after the fifth: even the right password finds no ticket.
    assert_eq!(
        code(ids.import(ticket.ticket, &secret("right"))),
        Some(ErrorCode::NotFound)
    );
}

#[test]
fn files_that_are_not_one_key_with_its_certificate_are_refused() {
    let dir = TempDir::new();
    let ids = identities(&dir, &Mem::default());
    let try_import = |file: Vec<u8>| {
        let ticket = ids.begin_import(file, "x.p12".into()).expect("ticket");
        code(ids.import(ticket.ticket, &secret("pw")))
    };

    // Two private keys.
    let (a, b) = (generated("A"), generated("B"));
    let mut two = KeyStore::new();
    two.add_entry("a", keychain_entry(&a.key, b"id-a", &a.chain));
    two.add_entry("b", keychain_entry(&b.key, b"id-b", &b.chain));
    assert_eq!(
        try_import(two.writer("pw").write().expect("write")),
        Some(ErrorCode::InvalidArgument)
    );

    // A key with another certificate than its own.
    let mismatched = Made {
        chain: b.chain.clone(),
        key: Zeroizing::new(a.key.to_vec()),
    };
    assert_eq!(
        try_import(aes_p12(&mismatched, "pw")),
        Some(ErrorCode::InvalidArgument)
    );

    // A key without any certificate.
    let mut bare = KeyStore::new();
    bare.add_entry("a", keychain_entry(&a.key, b"id-a", &[]));
    assert_eq!(
        try_import(bare.writer("pw").write().expect("write")),
        Some(ErrorCode::InvalidArgument)
    );

    // An Ed25519 key is not a signing key of this app.
    let mut ed25519 = vec![
        0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04,
        0x20,
    ];
    ed25519.extend_from_slice(&[7u8; 32]);
    let odd = Made {
        chain: a.chain.clone(),
        key: Zeroizing::new(ed25519),
    };
    assert_eq!(
        try_import(aes_p12(&odd, "pw")),
        Some(ErrorCode::UnsupportedFeature)
    );
    assert_eq!(ids.list().expect("list").items.len(), 0);
}

// --- hostile files -------------------------------------------------------------------------------------------------------

#[test]
fn iteration_counts_over_the_cap_are_refused_before_any_work() {
    let made = generated("Ada");
    let dir = TempDir::new();
    let ids = identities(&dir, &Mem::default());
    let mut store = KeyStore::new();
    store.add_entry("ada", keychain_entry(&made.key, b"id-1", &made.chain));

    // The MAC asks for one round too many.
    let hostile_mac = store
        .writer("pw")
        .mac_iterations(limits::P12_ITER_MAX + 1)
        .encryption_iterations(1_000)
        .write()
        .expect("write");
    // The key derivation asks for one round too many.
    let hostile_kdf = store
        .writer("pw")
        .mac_iterations(1_000)
        .encryption_iterations(limits::P12_ITER_MAX + 1)
        .write()
        .expect("write");
    for file in [hostile_mac, hostile_kdf] {
        let ticket = ids.begin_import(file, "h.p12".into()).expect("ticket");
        let started = Instant::now();
        assert_eq!(
            code(ids.import(ticket.ticket, &secret("pw"))),
            Some(ErrorCode::InvalidArgument)
        );
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "refused up front"
        );
    }
    // At the cap the file is still read.
    let at_cap = store
        .writer("pw")
        .mac_iterations(1_000)
        .encryption_iterations(5_000)
        .write()
        .expect("write");
    let ticket = ids.begin_import(at_cap, "ok.p12".into()).expect("ticket");
    assert!(ids.import(ticket.ticket, &secret("pw")).is_ok());
}

#[test]
fn garbage_truncations_and_flipped_bytes_never_panic_or_import() {
    let made = generated("Ada");
    let good = aes_p12(&made, "pw");
    let dir = TempDir::new();
    let ids = identities(&dir, &Mem::default());

    let mut cases: Vec<Vec<u8>> = vec![
        Vec::new(),
        b"not a pkcs12 file".to_vec(),
        vec![0x30, 0x80, 0, 0],
        vec![0x30, 0x84, 0xff, 0xff, 0xff, 0xff, 0],
        vec![0u8; 4096],
    ];
    for cut in (0..good.len()).step_by(37) {
        cases.push(good[..cut].to_vec());
    }
    for at in (0..good.len()).step_by(11) {
        let mut flipped = good.clone();
        flipped[at] ^= 0x55;
        cases.push(flipped);
    }
    for case in cases {
        let ticket = ids.begin_import(case, "x.p12".into()).expect("ticket");
        // Any answer but a panic; a flipped byte may still be an identity only if the file is intact where it counts.
        let _ = ids.import(ticket.ticket, &secret("pw"));
    }
    // Over the size cap: refused when picked.
    assert_eq!(
        code(ids.begin_import(vec![0; limits::IDENTITY_FILE_MAX + 1], "big.p12".into())),
        Some(ErrorCode::TooLarge)
    );
    // The untouched file still imports (the loop did not poison the store).
    let ticket = ids.begin_import(good, "good.p12".into()).expect("ticket");
    ids.import(ticket.ticket, &secret("pw"))
        .unwrap_or_else(|error| panic!("the untouched file did not import: {error:?}"));
}

#[test]
fn a_store_that_refuses_keeps_the_picked_file_for_another_try() {
    let made = generated("Ada");
    let dir = TempDir::new();
    let none = Identities::new(IdentityStore::new(dir.file(), Keychain::unavailable()));
    let ticket = none
        .begin_import(aes_p12(&made, "pw"), "a.p12".into())
        .expect("ticket");
    for _ in 0..2 {
        assert_eq!(
            code(none.import(ticket.ticket, &secret("pw"))),
            Some(ErrorCode::KeychainUnavailable)
        );
    }
    none.discard(ticket.ticket);
    assert_eq!(
        code(none.import(ticket.ticket, &secret("pw"))),
        Some(ErrorCode::NotFound)
    );
}

#[test]
fn a_secret_never_shows_in_debug_and_the_wire_type_has_no_key() {
    assert_eq!(format!("{:?}", secret("hunter2")), "<secret>");
    let dir = TempDir::new();
    let ids = identities(&dir, &Mem::default());
    let info = ids.create(&spec("Ada")).expect("create");
    let json = serde_json::to_string(&info).expect("json");
    for forbidden in ["key\":\"", "pkcs8", "private", "BEGIN"] {
        assert!(!json.contains(forbidden), "{forbidden} in {json}");
    }
    assert!(json.contains("\"key\":{\"type\":\"ecP256\"}"));
}
