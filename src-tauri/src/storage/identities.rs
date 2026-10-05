//! The signing identities: certificate chains with their private keys, encrypted at rest (ADR-121 section 3, SECURITY D9).
//!
//! One file, `<app data>/signing/identities.bin`:
//!
//! ```text
//! "SHID" | u8 version = 1 | 24-byte nonce | XChaCha20-Poly1305(records)     AAD = the first 5 bytes
//! ```
//!
//! The key (256 random bits) sits in the OS credential store under its own user name ([`keychain::IDENTITIES_USER`]), so deleting
//! the key of the signature library never locks this store. The plaintext is a small length-prefixed binary record list, built in one
//! pre-sized [`Zeroizing`] buffer so no copy of a private key is left behind by a growing vector. Rules (they follow the library's):
//!
//! - At most `limits::IDENTITIES_MAX` identities; the file is at most `limits::IDENTITIES_FILE_MAX`, checked before decrypting.
//! - **Never plaintext, never in memory only.** Without a usable keychain nothing is written: a new identity is refused
//!   ([`IdentityStoreError::Keychain`]) and the status is `unavailable`. A file that does not open (key gone, wrong, tampered, newer
//!   version) makes the store `locked`: it is never read as anything else and never overwritten.
//! - Writes are atomic (`storage::atomic`). Key bytes appear in no error and no log; [`Stored`] has a redacting `Debug`.
//! - This module never parses a certificate or a key: that is `pdfsig::identity`, which alone names the crypto crates.

use std::fmt;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, PoisonError};

use chacha20poly1305::aead::{Aead, Payload};
use chacha20poly1305::{Key as CipherKey, KeyInit, XChaCha20Poly1305, XNonce};
use zeroize::Zeroizing;

use crate::error::{AppError, ErrorCode};
use crate::limits;
use crate::pdfsig::types::{IdentitySource, StoreStatus};
use crate::storage::atomic::write_atomic;
use crate::storage::keychain::{Key, KeyError, Keychain};
use crate::storage::open_without_blocking;

/// File name inside `<app data>/signing/`.
pub const FILE_NAME: &str = "identities.bin";
/// Directory inside the app data directory.
pub const DIRECTORY: &str = "signing";

const MAGIC: &[u8; 4] = b"SHID";
const VERSION: u8 = 1;
const HEADER_LEN: usize = 5;
const NONCE_LEN: usize = 24;
const TAG_LEN: usize = 16;
/// Longest label, certificate or key (DER) in a record.
const LABEL_MAX: usize = 256;
const BLOB_MAX: usize = 64 * 1024;

/// An identity as it is stored. Private: only this module's callers hand it on; the UI sees `SigningIdentityInfo`.
#[derive(Clone)]
pub struct Stored {
    /// 32 lowercase hex digits; random.
    pub id: String,
    /// The common name at creation (for file names; the certificate is the truth).
    pub label: String,
    pub source: IdentitySource,
    /// Seconds since 1970.
    pub created: u64,
    /// DER certificates, the signer's first; at most `limits::SIG_CHAIN_MAX`.
    pub chain: Vec<Vec<u8>>,
    /// The private key as PKCS#8 DER.
    pub key: Zeroizing<Vec<u8>>,
}

impl fmt::Debug for Stored {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Stored")
            .field("id", &self.id)
            .field("key", &"<key>")
            .finish_non_exhaustive()
    }
}

/// Why the file or its plaintext was refused. Says nothing about content.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SealError {
    /// Not an identities file: too short, too long or the wrong magic.
    Format,
    /// A version this build does not know.
    Version,
    /// The tag did not verify: wrong key, or the file was changed.
    Decrypt,
    /// The plaintext is not what the store writes, or a record is over a cap.
    Content,
    /// No randomness for the nonce.
    Random,
    /// The cipher refused.
    Encrypt,
}

/// What a store call can fail with.
#[derive(Debug)]
pub enum IdentityStoreError {
    /// The store is locked (the file does not open).
    Locked,
    /// No OS keychain now (missing, refused, failed, timed out), so nothing can be stored.
    Keychain,
    /// The key store gave something unusable, or the system has no randomness, or a record is over a cap.
    Key,
    /// `limits::IDENTITIES_MAX` identities exist already.
    Full,
    /// No such identity.
    NotFound,
    Io(io::Error),
}

impl From<io::Error> for IdentityStoreError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<IdentityStoreError> for AppError {
    fn from(error: IdentityStoreError) -> Self {
        match error {
            IdentityStoreError::Locked => AppError::invalid("identities"),
            IdentityStoreError::Keychain => AppError::new(ErrorCode::KeychainUnavailable),
            IdentityStoreError::Key => AppError::new(ErrorCode::Internal),
            IdentityStoreError::Full => {
                AppError::limit("identities", limits::IDENTITIES_MAX as u64)
            }
            IdentityStoreError::NotFound => AppError::not_found("identity"),
            IdentityStoreError::Io(error) => AppError::from(error),
        }
    }
}

fn header() -> [u8; HEADER_LEN] {
    let mut header = [0; HEADER_LEN];
    header[..4].copy_from_slice(MAGIC);
    header[4] = VERSION;
    header
}

/// Whether `id` is 32 lowercase hex digits.
pub fn is_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn unhex(id: &str) -> Option<[u8; 16]> {
    if !is_id(id) {
        return None;
    }
    let mut out = [0u8; 16];
    for (slot, pair) in out.iter_mut().zip(id.as_bytes().as_chunks::<2>().0) {
        let digit = |b: u8| char::from(b).to_digit(16);
        *slot = u8::try_from(digit(pair[0])? << 4 | digit(pair[1])?).ok()?;
    }
    Some(out)
}

fn enc_blob(out: &mut Vec<u8>, bytes: &[u8]) -> Option<()> {
    out.extend_from_slice(&u32::try_from(bytes.len()).ok()?.to_be_bytes());
    out.extend_from_slice(bytes);
    Some(())
}

/// The records of `items`: `count u8` then, per item, `id[16] | source u8 | created u64 | label (u16 len) | chain count u8 | chain
/// (u32 len each) | key (u32 len)`. `None` if a cap is exceeded.
fn encode(items: &[Stored]) -> Option<Zeroizing<Vec<u8>>> {
    if items.len() > limits::IDENTITIES_MAX {
        return None;
    }
    let size = 1 + items
        .iter()
        .map(|item| {
            16 + 1
                + 8
                + 2
                + item.label.len()
                + 1
                + item.chain.iter().map(|c| 4 + c.len()).sum::<usize>()
                + 4
                + item.key.len()
        })
        .sum::<usize>();
    // Pre-sized: the buffer never grows, so a reallocation cannot leave a copy of a key behind.
    let mut out = Zeroizing::new(Vec::with_capacity(size));
    out.push(u8::try_from(items.len()).ok()?);
    for item in items {
        if item.label.len() > LABEL_MAX
            || item.chain.is_empty()
            || item.chain.len() > limits::SIG_CHAIN_MAX
            || item.chain.iter().any(|c| c.len() > BLOB_MAX)
            || item.key.len() > BLOB_MAX
        {
            return None;
        }
        out.extend_from_slice(&unhex(&item.id)?);
        out.push(match item.source {
            IdentitySource::Generated => 0,
            IdentitySource::Imported => 1,
        });
        out.extend_from_slice(&item.created.to_be_bytes());
        out.extend_from_slice(&u16::try_from(item.label.len()).ok()?.to_be_bytes());
        out.extend_from_slice(item.label.as_bytes());
        out.push(u8::try_from(item.chain.len()).ok()?);
        for cert in &item.chain {
            enc_blob(&mut out, cert)?;
        }
        enc_blob(&mut out, &item.key)?;
    }
    Some(out)
}

/// A reader over the plaintext that never reads past its end.
struct Reader<'a>(&'a [u8]);

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Option<&'a [u8]> {
        if n > self.0.len() {
            return None;
        }
        let (head, tail) = self.0.split_at(n);
        self.0 = tail;
        Some(head)
    }
    fn u8(&mut self) -> Option<u8> {
        self.take(1).map(|b| b[0])
    }
    fn u16(&mut self) -> Option<usize> {
        self.take(2)
            .map(|b| usize::from(u16::from_be_bytes([b[0], b[1]])))
    }
    fn u32(&mut self) -> Option<usize> {
        let b = self.take(4)?;
        usize::try_from(u32::from_be_bytes([b[0], b[1], b[2], b[3]])).ok()
    }
    fn u64(&mut self) -> Option<u64> {
        let b = self.take(8)?;
        Some(u64::from_be_bytes([
            b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7],
        ]))
    }
    fn blob(&mut self) -> Option<&'a [u8]> {
        let len = self.u32()?;
        if len > BLOB_MAX {
            return None;
        }
        self.take(len)
    }
}

fn decode(plain: &[u8]) -> Option<Vec<Stored>> {
    let mut r = Reader(plain);
    let count = usize::from(r.u8()?);
    if count > limits::IDENTITIES_MAX {
        return None;
    }
    let mut items = Vec::with_capacity(count);
    for _ in 0..count {
        let id: String = r.take(16)?.iter().map(|b| format!("{b:02x}")).collect();
        let source = match r.u8()? {
            0 => IdentitySource::Generated,
            1 => IdentitySource::Imported,
            _ => return None,
        };
        let created = r.u64()?;
        let label_len = r.u16()?;
        if label_len > LABEL_MAX {
            return None;
        }
        let label = String::from_utf8(r.take(label_len)?.to_vec()).ok()?;
        let chain_len = usize::from(r.u8()?);
        if chain_len == 0 || chain_len > limits::SIG_CHAIN_MAX {
            return None;
        }
        let mut chain = Vec::with_capacity(chain_len);
        for _ in 0..chain_len {
            chain.push(r.blob()?.to_vec());
        }
        let key = Zeroizing::new(r.blob()?.to_vec());
        items.push(Stored {
            id,
            label,
            source,
            created,
            chain,
            key,
        });
    }
    r.0.is_empty().then_some(items)
}

/// Encrypts `items` under `key`: header, a fresh random nonce, ciphertext with the header as associated data.
pub fn seal(key: &Key, items: &[Stored]) -> Result<Vec<u8>, SealError> {
    let plain = encode(items).ok_or(SealError::Content)?;
    let mut nonce = [0u8; NONCE_LEN];
    getrandom::fill(&mut nonce).map_err(|_| SealError::Random)?;
    let header = header();
    let cipher = XChaCha20Poly1305::new(&CipherKey::from(**key));
    let sealed = cipher
        .encrypt(
            &XNonce::from(nonce),
            Payload {
                msg: &plain,
                aad: &header,
            },
        )
        .map_err(|_| SealError::Encrypt)?;
    let mut file = Vec::with_capacity(HEADER_LEN + NONCE_LEN + sealed.len());
    file.extend_from_slice(&header);
    file.extend_from_slice(&nonce);
    file.extend_from_slice(&sealed);
    if file.len() > limits::IDENTITIES_FILE_MAX {
        return Err(SealError::Format);
    }
    Ok(file)
}

/// Decrypts an identities file with `key`. Every failure is a [`SealError`]; there is no plaintext fallback.
pub fn open(key: &Key, file: &[u8]) -> Result<Vec<Stored>, SealError> {
    if file.len() > limits::IDENTITIES_FILE_MAX || file.len() < HEADER_LEN + NONCE_LEN + TAG_LEN {
        return Err(SealError::Format);
    }
    let (header, rest) = file.split_at(HEADER_LEN);
    if &header[..4] != MAGIC {
        return Err(SealError::Format);
    }
    if header[4] != VERSION {
        return Err(SealError::Version);
    }
    let (nonce, sealed) = rest.split_at(NONCE_LEN);
    let nonce: [u8; NONCE_LEN] = nonce.try_into().map_err(|_| SealError::Format)?;
    let cipher = XChaCha20Poly1305::new(&CipherKey::from(**key));
    let plain = Zeroizing::new(
        cipher
            .decrypt(
                &XNonce::from(nonce),
                Payload {
                    msg: sealed,
                    aad: header,
                },
            )
            .map_err(|_| SealError::Decrypt)?,
    );
    decode(&plain).ok_or(SealError::Content)
}

fn new_id() -> Result<String, IdentityStoreError> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| IdentityStoreError::Key)?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// A fresh random identity id.
pub fn random_id() -> Result<String, AppError> {
    Ok(new_id()?)
}

/// Reads the file: at most `limits::IDENTITIES_FILE_MAX`, a regular file. `Ok(None)` if there is none; anything else that is wrong
/// with it is `InvalidData`.
fn read_file(path: &Path) -> io::Result<Option<Vec<u8>>> {
    let file = match open_without_blocking(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    if !file.metadata()?.is_file() {
        return Err(io::Error::from(io::ErrorKind::InvalidData));
    }
    let mut bytes = Vec::new();
    file.take(limits::IDENTITIES_FILE_MAX as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > limits::IDENTITIES_FILE_MAX {
        return Err(io::Error::from(io::ErrorKind::InvalidData));
    }
    Ok(Some(bytes))
}

enum Loaded {
    /// In the file, opened with `key`.
    Stored {
        key: Key,
        items: Vec<Stored>,
    },
    /// No file and no key yet.
    Fresh,
    /// No usable keychain.
    Unavailable,
    Locked,
}

/// The identity store: a file and a keychain.
pub struct IdentityStore {
    path: PathBuf,
    keychain: Keychain,
    /// Serialises every call.
    gate: Mutex<()>,
}

impl IdentityStore {
    pub fn new(path: PathBuf, keychain: Keychain) -> Self {
        Self {
            path,
            keychain,
            gate: Mutex::new(()),
        }
    }

    /// The store under the app data directory, with its key in the OS keychain.
    pub fn in_data_dir(data_dir: &Path) -> Self {
        Self::new(
            data_dir.join(DIRECTORY).join(FILE_NAME),
            Keychain::platform_identities(),
        )
    }

    fn lock(&self) -> MutexGuard<'_, ()> {
        self.gate.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn load(&self) -> Result<Loaded, IdentityStoreError> {
        let key = match self.keychain.existing_key() {
            Ok(key) => key,
            // No keychain, or one that failed this call: the file is not judged and not touched.
            Err(KeyError::Unavailable | KeyError::Unreadable) => return Ok(Loaded::Unavailable),
            Err(KeyError::Invalid) => return Ok(Loaded::Locked),
        };
        let file = match read_file(&self.path) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::InvalidData => return Ok(Loaded::Locked),
            Err(error) => return Err(error.into()),
        };
        match (key, file) {
            (None, None) => Ok(Loaded::Fresh),
            // The key is gone and the file is not: it can never be opened again.
            (None, Some(_)) => Ok(Loaded::Locked),
            (Some(key), None) => Ok(Loaded::Stored {
                key,
                items: Vec::new(),
            }),
            (Some(key), Some(bytes)) => match open(&key, &bytes) {
                Ok(items) => Ok(Loaded::Stored { key, items }),
                Err(_) => Ok(Loaded::Locked),
            },
        }
    }

    /// Calls `read` with the status and the stored identities (key bytes included: `read` must not let them out).
    pub fn list<R>(
        &self,
        read: impl FnOnce(StoreStatus, &[Stored]) -> R,
    ) -> Result<R, IdentityStoreError> {
        let _gate = self.lock();
        Ok(match self.load()? {
            Loaded::Stored { items, .. } if items.is_empty() => read(StoreStatus::Empty, &items),
            Loaded::Stored { items, .. } => read(StoreStatus::Ready, &items),
            Loaded::Fresh => read(StoreStatus::Empty, &[]),
            Loaded::Unavailable => read(StoreStatus::Unavailable, &[]),
            Loaded::Locked => read(StoreStatus::Locked, &[]),
        })
    }

    /// Calls `read` with the identity `id`.
    pub fn with<R>(
        &self,
        id: &str,
        read: impl FnOnce(&Stored) -> R,
    ) -> Result<R, IdentityStoreError> {
        let _gate = self.lock();
        match self.load()? {
            Loaded::Stored { items, .. } => items
                .iter()
                .find(|item| item.id == id)
                .map(read)
                .ok_or(IdentityStoreError::NotFound),
            Loaded::Fresh => Err(IdentityStoreError::NotFound),
            Loaded::Unavailable => Err(IdentityStoreError::Keychain),
            Loaded::Locked => Err(IdentityStoreError::Locked),
        }
    }

    /// Adds an identity. `Full` at `limits::IDENTITIES_MAX`; `Keychain` when there is no usable keychain (nothing is stored then).
    pub fn add(&self, item: Stored) -> Result<(), IdentityStoreError> {
        let _gate = self.lock();
        match self.load()? {
            Loaded::Locked => Err(IdentityStoreError::Locked),
            Loaded::Unavailable => Err(IdentityStoreError::Keychain),
            Loaded::Stored { key, mut items } => {
                if items.len() >= limits::IDENTITIES_MAX {
                    return Err(IdentityStoreError::Full);
                }
                items.push(item);
                self.write(&key, &items)
            }
            Loaded::Fresh => {
                // The key is created only now that there is something to protect.
                let key = match self.keychain.key_or_create() {
                    Ok(key) => key,
                    Err(KeyError::Unavailable | KeyError::Unreadable) => {
                        return Err(IdentityStoreError::Keychain)
                    }
                    Err(KeyError::Invalid) => return Err(IdentityStoreError::Key),
                };
                self.write(&key, &[item])
            }
        }
    }

    /// Removes an identity. `NotFound` if there is none with that id.
    pub fn remove(&self, id: &str) -> Result<(), IdentityStoreError> {
        let _gate = self.lock();
        match self.load()? {
            Loaded::Locked => Err(IdentityStoreError::Locked),
            Loaded::Unavailable => Err(IdentityStoreError::Keychain),
            Loaded::Fresh => Err(IdentityStoreError::NotFound),
            Loaded::Stored { key, mut items } => {
                let at = items
                    .iter()
                    .position(|item| item.id == id)
                    .ok_or(IdentityStoreError::NotFound)?;
                items.remove(at);
                self.write(&key, &items)
            }
        }
    }

    /// Deletes the file and the key: the way out of `locked`. Not exposed as a command.
    pub fn forget_all(&self) -> Result<(), IdentityStoreError> {
        let _gate = self.lock();
        match std::fs::remove_file(&self.path) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        match self.keychain.forget() {
            Ok(()) | Err(KeyError::Unavailable) => Ok(()),
            Err(KeyError::Invalid | KeyError::Unreadable) => Err(IdentityStoreError::Key),
        }
    }

    fn write(&self, key: &Key, items: &[Stored]) -> Result<(), IdentityStoreError> {
        let bytes = seal(key, items).map_err(|_| IdentityStoreError::Key)?;
        write_atomic(&self.path, &bytes)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::atomic::testutil::TempDir;
    use crate::storage::keychain::testutil::MemoryStore;

    fn key(byte: u8) -> Key {
        Zeroizing::new([byte; 32])
    }

    fn item(n: u8) -> Stored {
        Stored {
            id: format!("{n:032x}"),
            label: format!("Name {n}"),
            source: if n.is_multiple_of(2) {
                IdentitySource::Generated
            } else {
                IdentitySource::Imported
            },
            created: 1_700_000_000 + u64::from(n),
            chain: vec![vec![n; 300], vec![n.wrapping_add(1); 200]],
            key: Zeroizing::new(vec![n ^ 0x5a; 138]),
        }
    }

    fn store(dir: &TempDir, memory: &MemoryStore) -> IdentityStore {
        IdentityStore::new(
            dir.path().join(DIRECTORY).join(FILE_NAME),
            memory.keychain(),
        )
    }

    fn path(dir: &TempDir) -> PathBuf {
        dir.path().join(DIRECTORY).join(FILE_NAME)
    }

    fn same(a: &Stored, b: &Stored) -> bool {
        (&a.id, &a.label, a.source, a.created, &a.chain, &*a.key)
            == (&b.id, &b.label, b.source, b.created, &b.chain, &*b.key)
    }

    #[test]
    fn what_is_sealed_opens_again_and_holds_no_plaintext() {
        let items = vec![item(1), item(2)];
        let file = seal(&key(7), &items).expect("seal");
        assert_eq!(&file[..5], b"SHID\x01");
        let back = open(&key(7), &file).expect("open");
        assert!(back.len() == 2 && same(&back[0], &items[0]) && same(&back[1], &items[1]));
        assert!(open(&key(7), &seal(&key(7), &[]).expect("empty"))
            .expect("open")
            .is_empty());
        let again = seal(&key(7), &items).expect("seal");
        assert_ne!(file[5..29], again[5..29], "a new nonce per write");
        assert!(!String::from_utf8_lossy(&file).contains("Name 1"));
        // The key bytes (0x5b repeated) are not in the file as they are.
        assert!(!file.windows(16).any(|w| w == [0x5b; 16]));
    }

    #[test]
    fn a_wrong_key_a_changed_byte_or_a_new_header_fail() {
        let file = seal(&key(7), &[item(1)]).expect("seal");
        assert_eq!(open(&key(8), &file).err(), Some(SealError::Decrypt));
        for at in 0..file.len() {
            let mut bad = file.clone();
            bad[at] ^= 1;
            assert!(open(&key(7), &bad).is_err(), "byte {at}");
        }
        let mut newer = file.clone();
        newer[4] = 2;
        assert_eq!(open(&key(7), &newer).err(), Some(SealError::Version));
        for cut in [0, 4, 5, 28, 44, file.len() - 1] {
            assert!(open(&key(7), &file[..cut]).is_err(), "{cut}");
        }
        assert_eq!(
            open(&key(7), &vec![0; limits::IDENTITIES_FILE_MAX + 1]).err(),
            Some(SealError::Format)
        );
    }

    #[test]
    fn a_file_that_decrypts_but_breaks_the_rules_is_refused() {
        let too_many: Vec<Stored> = (0..=limits::IDENTITIES_MAX as u8).map(item).collect();
        assert_eq!(seal(&key(7), &too_many).err(), Some(SealError::Content));
        let mut bad_id = item(1);
        bad_id.id = "../../etc/passwd".into();
        assert_eq!(seal(&key(7), &[bad_id]).err(), Some(SealError::Content));
        let mut empty_chain = item(1);
        empty_chain.chain.clear();
        assert_eq!(
            seal(&key(7), &[empty_chain]).err(),
            Some(SealError::Content)
        );
        // Trailing bytes after the records are refused on read.
        let mut plain = encode(&[item(1)]).expect("encode");
        plain.push(0);
        assert!(decode(&plain).is_none());
        assert!(decode(&[9]).is_none(), "more records than the cap");
    }

    #[test]
    fn add_list_get_remove_and_the_cap() {
        let dir = TempDir::new();
        let memory = MemoryStore::default();
        let store = store(&dir, &memory);
        assert_eq!(
            store
                .list(|status, items| (status, items.len()))
                .expect("list"),
            (StoreStatus::Empty, 0)
        );
        assert_eq!(memory.peek(), None, "no key before the first identity");

        store.add(item(1)).expect("add");
        assert_eq!(memory.peek().expect("key").len(), 32);
        assert_eq!(
            store
                .list(|status, items| (status, items.len()))
                .expect("list"),
            (StoreStatus::Ready, 1)
        );
        assert_eq!(
            store.with(&item(1).id, |s| s.label.clone()).expect("with"),
            "Name 1"
        );
        // A second store over the same file and key sees the same (a restart).
        assert_eq!(
            super::tests::store(&dir, &memory)
                .list(|_, items| items.len())
                .expect("list"),
            1
        );

        for n in 2..=limits::IDENTITIES_MAX as u8 {
            store.add(item(n)).expect("add");
        }
        assert!(matches!(store.add(item(99)), Err(IdentityStoreError::Full)));
        store.remove(&item(1).id).expect("remove");
        store.add(item(99)).expect("room again");
        assert!(matches!(
            store.remove(&item(1).id),
            Err(IdentityStoreError::NotFound)
        ));
        assert!(matches!(
            store.with("nope", |_| ()),
            Err(IdentityStoreError::NotFound)
        ));
    }

    #[test]
    fn the_stored_file_is_ciphertext_and_writes_leave_no_temp_file() {
        let dir = TempDir::new();
        let store = store(&dir, &MemoryStore::default());
        for n in 1..4 {
            store.add(item(n)).expect("add");
        }
        let bytes = std::fs::read(path(&dir)).expect("read");
        assert_eq!(&bytes[..4], b"SHID");
        assert!(!String::from_utf8_lossy(&bytes).contains("Name"));
        let names: Vec<String> = std::fs::read_dir(dir.path().join(DIRECTORY))
            .expect("dir")
            .map(|e| e.expect("entry").file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, [FILE_NAME]);
    }

    #[test]
    fn a_missing_keychain_refuses_new_identities_and_writes_nothing() {
        let dir = TempDir::new();
        let store = IdentityStore::new(path(&dir), Keychain::unavailable());
        assert_eq!(
            store
                .list(|status, items| (status, items.len()))
                .expect("list"),
            (StoreStatus::Unavailable, 0)
        );
        assert!(matches!(
            store.add(item(1)),
            Err(IdentityStoreError::Keychain)
        ));
        assert!(matches!(
            store.remove("x"),
            Err(IdentityStoreError::Keychain)
        ));
        assert!(!dir.path().join(DIRECTORY).exists(), "nothing on disk");
        assert_eq!(
            AppError::from(IdentityStoreError::Keychain).code(),
            ErrorCode::KeychainUnavailable
        );
        // An existing file is never touched without the keychain.
        let memory = MemoryStore::default();
        super::tests::store(&dir, &memory)
            .add(item(1))
            .expect("add");
        let before = std::fs::read(path(&dir)).expect("read");
        let no_keys = IdentityStore::new(path(&dir), Keychain::unavailable());
        assert!(matches!(
            no_keys.add(item(2)),
            Err(IdentityStoreError::Keychain)
        ));
        assert_eq!(std::fs::read(path(&dir)).expect("read"), before);
    }

    #[test]
    fn a_lost_wrong_or_corrupt_key_locks_and_nothing_is_overwritten() {
        let dir = TempDir::new();
        let memory = MemoryStore::default();
        let store = store(&dir, &memory);
        store.add(item(1)).expect("add");
        let before = std::fs::read(path(&dir)).expect("read");
        for replace in [None, Some(vec![9u8; 32]), Some(vec![9u8; 5])] {
            let original = memory.peek();
            memory.put(replace.clone());
            assert_eq!(
                store
                    .list(|status, items| (status, items.len()))
                    .expect("list"),
                (StoreStatus::Locked, 0)
            );
            assert!(matches!(
                store.add(item(2)),
                Err(IdentityStoreError::Locked)
            ));
            assert!(matches!(
                store.remove(&item(1).id),
                Err(IdentityStoreError::Locked)
            ));
            assert!(matches!(
                store.with(&item(1).id, |_| ()),
                Err(IdentityStoreError::Locked)
            ));
            assert_eq!(std::fs::read(path(&dir)).expect("read"), before);
            assert_eq!(memory.peek(), replace, "the key is not replaced either");
            memory.put(original);
        }
        assert_eq!(
            store.list(|status, _| status).expect("list"),
            StoreStatus::Ready
        );
        // A tampered file and a plaintext file lock too.
        let mut bytes = before.clone();
        let last = bytes.len() - 1;
        bytes[last] ^= 0xff;
        std::fs::write(path(&dir), &bytes).expect("write");
        assert_eq!(
            store.list(|status, _| status).expect("list"),
            StoreStatus::Locked
        );
        std::fs::write(path(&dir), b"{\"identities\":[]}").expect("write");
        assert_eq!(
            store.list(|status, _| status).expect("list"),
            StoreStatus::Locked
        );
        // forget_all ends the lock.
        store.forget_all().expect("forget");
        assert_eq!(memory.peek(), None);
        assert_eq!(
            store.list(|status, _| status).expect("list"),
            StoreStatus::Empty
        );
    }

    #[test]
    fn debug_never_shows_key_bytes() {
        let text = format!("{:?}", item(3));
        assert!(text.contains("<key>") && !text.contains("89"));
    }

    #[test]
    fn errors_map_to_the_fixed_vocabulary() {
        let code = |e: IdentityStoreError| AppError::from(e).code();
        assert_eq!(code(IdentityStoreError::Locked), ErrorCode::InvalidArgument);
        assert_eq!(code(IdentityStoreError::Full), ErrorCode::LimitExceeded);
        assert_eq!(code(IdentityStoreError::NotFound), ErrorCode::NotFound);
        assert_eq!(code(IdentityStoreError::Key), ErrorCode::Internal);
    }
}
