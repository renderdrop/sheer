//! The key of the signature library in the OS credential store (ADR-041 section 7, SECURITY D2).
//!
//! The key is 256 random bits from `getrandom`, created on first use and kept as a binary secret under service
//! [`SERVICE`] and user [`USER`]. It lives in a [`Zeroizing`] array only while a call runs and is never logged or put in an
//! error. Everything that touches the OS sits behind [`SecretStore`], so the rest of the app, and every test, runs against an
//! in-memory double and never against a real keychain. `keyring-core` is used per store (`CredentialStoreApi::build`), not
//! through its global default store, so nothing else in the process can swap the store under us.
//!
//! A store that cannot be reached (no store on this platform, a locked or missing keychain service, access refused) is
//! [`KeyError::Unavailable`]: the library then keeps nothing on disk, and entries live for the session only. A store that is there
//! but failed this one call (a platform failure, access refused, several candidates) is [`KeyError::Unreadable`]: the same for the
//! library, but it is not evidence about the key. Only a secret that is there and is not a 256-bit key is [`KeyError::Invalid`].
//! The platform store is wrapped in [`DeadlineStore`]: a call that takes longer than [`DEADLINE`] (an OS prompt nobody answers, a
//! hung service) is `Unavailable` and never blocks a command.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::time::Duration;

use zeroize::Zeroizing;

/// Service name of the credential (ADR-041 section 7).
pub const SERVICE: &str = "app.sheer.desktop";
/// User name of the credential: the key of the library, version 1.
pub const USER: &str = "signature-library-key-v1";
/// How long one call to the OS store may take.
pub const DEADLINE: Duration = Duration::from_secs(60);
/// Length of the key in bytes.
pub const KEY_LEN: usize = 32;

/// The key of the library. Wiped when dropped.
pub type Key = Zeroizing<[u8; KEY_LEN]>;

/// Why the credential store did not do what was asked.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StoreError {
    /// There is no store, or it cannot be used now (service missing, call timed out).
    Unavailable,
    /// The store is there and this call failed (platform failure, access refused, ambiguous entry).
    Failed,
    /// What the store holds is not usable data (wrong encoding).
    Damaged,
}

/// The one secret this app keeps in the OS credential store. Implemented by the platform store and by test doubles.
pub trait SecretStore: Send + Sync {
    /// The secret, or `None` if there is none.
    fn get(&self) -> Result<Option<Zeroizing<Vec<u8>>>, StoreError>;
    /// Stores `secret`, replacing any earlier one.
    fn set(&self, secret: &[u8]) -> Result<(), StoreError>;
    /// Removes the secret. A secret that is not there is not an error.
    fn delete(&self) -> Result<(), StoreError>;
}

/// Why the key could not be had.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyError {
    /// No usable credential store: nothing is stored, entries live for the session only.
    Unavailable,
    /// The store failed this call. Says nothing about the key: nothing is locked, replaced or deleted because of it.
    Unreadable,
    /// The store answered with something that is not a 256-bit key, or the system has no randomness.
    Invalid,
}

impl From<StoreError> for KeyError {
    fn from(error: StoreError) -> Self {
        match error {
            StoreError::Unavailable => KeyError::Unavailable,
            StoreError::Failed => KeyError::Unreadable,
            StoreError::Damaged => KeyError::Invalid,
        }
    }
}

/// The key of the library, kept in a [`SecretStore`].
pub struct Keychain {
    store: Box<dyn SecretStore>,
}

impl Keychain {
    pub fn new(store: Box<dyn SecretStore>) -> Self {
        Self { store }
    }

    /// The store of this platform (Keychain on macOS, Credential Manager on Windows), each call under the [`DEADLINE`]. Anywhere
    /// else, or when the store cannot be opened, the keychain is unavailable.
    pub fn platform() -> Self {
        Self::with_deadline(platform_store(), DEADLINE)
    }

    /// The platform store under another service name (the real-store round-trip test only).
    #[cfg(test)]
    pub(crate) fn platform_for_service(service: &str) -> Self {
        Self::with_deadline(platform_store_for(service), DEADLINE)
    }

    /// `store` with every call limited to `deadline`.
    pub fn with_deadline(store: Box<dyn SecretStore>, deadline: Duration) -> Self {
        Self::new(Box::new(DeadlineStore::new(store, deadline)))
    }

    /// A keychain that is not there: every call is [`KeyError::Unavailable`].
    pub fn unavailable() -> Self {
        Self::new(Box::new(UnavailableStore))
    }

    /// The key if there is one. `Ok(None)`: the store works and holds none.
    pub fn existing_key(&self) -> Result<Option<Key>, KeyError> {
        match self.store.get() {
            Ok(None) => Ok(None),
            Ok(Some(secret)) => key_from(&secret).map(Some),
            Err(error) => Err(error.into()),
        }
    }

    /// The key, created and stored if there is none yet.
    pub fn key_or_create(&self) -> Result<Key, KeyError> {
        if let Some(key) = self.existing_key()? {
            return Ok(key);
        }
        let mut key: Key = Zeroizing::new([0; KEY_LEN]);
        getrandom::fill(key.as_mut_slice()).map_err(|_| KeyError::Invalid)?;
        self.store.set(key.as_slice())?;
        Ok(key)
    }

    /// Removes the key from the store.
    pub fn forget(&self) -> Result<(), KeyError> {
        Ok(self.store.delete()?)
    }
}

/// A secret of exactly [`KEY_LEN`] bytes as a key.
fn key_from(secret: &[u8]) -> Result<Key, KeyError> {
    let bytes: [u8; KEY_LEN] = secret.try_into().map_err(|_| KeyError::Invalid)?;
    Ok(Zeroizing::new(bytes))
}

/// A store whose every call runs on a thread of its own and is given up on after the deadline (`Unavailable`). At most one call is
/// ever outstanding: while an earlier call is still stuck, the next ones are `Unavailable` at once, so a hung service costs one thread.
pub struct DeadlineStore {
    inner: Arc<dyn SecretStore>,
    deadline: Duration,
    busy: Arc<AtomicBool>,
}

impl DeadlineStore {
    pub fn new(inner: Box<dyn SecretStore>, deadline: Duration) -> Self {
        Self {
            inner: Arc::from(inner),
            deadline,
            busy: Arc::new(AtomicBool::new(false)),
        }
    }

    fn run<T: Send + 'static>(
        &self,
        call: impl FnOnce(&dyn SecretStore) -> Result<T, StoreError> + Send + 'static,
    ) -> Result<T, StoreError> {
        if self.busy.swap(true, Ordering::AcqRel) {
            return Err(StoreError::Unavailable);
        }
        let (sender, receiver) = mpsc::channel();
        let inner = Arc::clone(&self.inner);
        let busy = Arc::clone(&self.busy);
        let spawned = std::thread::Builder::new()
            .name("sheer-keychain".into())
            .spawn(move || {
                let answer = call(inner.as_ref());
                busy.store(false, Ordering::Release);
                // The receiver is gone after a timeout: the answer (a secret, wiped on drop) is dropped here.
                let _ = sender.send(answer);
            });
        if spawned.is_err() {
            self.busy.store(false, Ordering::Release);
            return Err(StoreError::Unavailable);
        }
        receiver
            .recv_timeout(self.deadline)
            .unwrap_or(Err(StoreError::Unavailable))
    }
}

impl SecretStore for DeadlineStore {
    fn get(&self) -> Result<Option<Zeroizing<Vec<u8>>>, StoreError> {
        self.run(|store| store.get())
    }
    fn set(&self, secret: &[u8]) -> Result<(), StoreError> {
        let secret = Zeroizing::new(secret.to_vec());
        self.run(move |store| store.set(&secret))
    }
    fn delete(&self) -> Result<(), StoreError> {
        self.run(|store| store.delete())
    }
}

/// No store at all.
pub struct UnavailableStore;

impl SecretStore for UnavailableStore {
    fn get(&self) -> Result<Option<Zeroizing<Vec<u8>>>, StoreError> {
        Err(StoreError::Unavailable)
    }
    fn set(&self, _secret: &[u8]) -> Result<(), StoreError> {
        Err(StoreError::Unavailable)
    }
    fn delete(&self) -> Result<(), StoreError> {
        Err(StoreError::Unavailable)
    }
}

/// The secret as `keyring-core` holds it, in the store it was built from.
struct EntryStore {
    entry: keyring_core::Entry,
}

fn map_error(error: &keyring_core::Error) -> StoreError {
    use keyring_core::Error;
    match error {
        Error::BadEncoding(_) | Error::BadDataFormat(..) | Error::BadStoreFormat(_) => {
            StoreError::Damaged
        }
        // The store is there and this call failed: not evidence about the key.
        Error::PlatformFailure(_) | Error::NoStorageAccess(_) | Error::Ambiguous(_) => {
            StoreError::Failed
        }
        // No store, or it does not do this: "not here". Nothing is written.
        _ => StoreError::Unavailable,
    }
}

impl SecretStore for EntryStore {
    fn get(&self) -> Result<Option<Zeroizing<Vec<u8>>>, StoreError> {
        match self.entry.get_secret() {
            Ok(secret) => Ok(Some(Zeroizing::new(secret))),
            Err(keyring_core::Error::NoEntry) => Ok(None),
            Err(error) => Err(map_error(&error)),
        }
    }

    fn set(&self, secret: &[u8]) -> Result<(), StoreError> {
        self.entry.set_secret(secret).map_err(|e| map_error(&e))
    }

    fn delete(&self) -> Result<(), StoreError> {
        match self.entry.delete_credential() {
            Ok(()) | Err(keyring_core::Error::NoEntry) => Ok(()),
            Err(error) => Err(map_error(&error)),
        }
    }
}

/// The entry of the library key in `store`.
fn entry_in(
    store: &dyn keyring_core::api::CredentialStoreApi,
    service: &str,
) -> Result<EntryStore, keyring_core::Error> {
    Ok(EntryStore {
        entry: store.build(service, USER, None)?,
    })
}

fn platform_store() -> Box<dyn SecretStore> {
    platform_store_for(SERVICE)
}

#[cfg(windows)]
fn platform_store_for(service: &str) -> Box<dyn SecretStore> {
    match windows_native_keyring_store::Store::new()
        .and_then(|store| entry_in(store.as_ref(), service))
    {
        Ok(store) => Box::new(store),
        Err(_) => Box::new(UnavailableStore),
    }
}

#[cfg(target_os = "macos")]
fn platform_store_for(service: &str) -> Box<dyn SecretStore> {
    match apple_native_keyring_store::keychain::Store::new()
        .and_then(|store| entry_in(store.as_ref(), service))
    {
        Ok(store) => Box::new(store),
        Err(_) => Box::new(UnavailableStore),
    }
}

/// Linux builds are for development only: no store.
#[cfg(not(any(windows, target_os = "macos")))]
fn platform_store_for(_service: &str) -> Box<dyn SecretStore> {
    let _ = entry_in;
    Box::new(UnavailableStore)
}

#[cfg(test)]
pub(crate) mod testutil {
    use std::sync::{Arc, Mutex, PoisonError};

    use super::*;

    /// An in-memory credential store, shared between clones so a test can look at it and hand it to a [`Keychain`].
    #[derive(Clone, Default)]
    pub struct MemoryStore {
        secret: Arc<Mutex<Option<Vec<u8>>>>,
    }

    impl MemoryStore {
        pub fn keychain(&self) -> Keychain {
            Keychain::new(Box::new(self.clone()))
        }

        pub fn peek(&self) -> Option<Vec<u8>> {
            self.secret
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .clone()
        }

        pub fn put(&self, secret: Option<Vec<u8>>) {
            *self.secret.lock().unwrap_or_else(PoisonError::into_inner) = secret;
        }
    }

    /// Forgets the key of a test service when dropped.
    pub(crate) struct Cleanup(pub Keychain);

    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = self.0.forget();
        }
    }

    impl SecretStore for MemoryStore {
        fn get(&self) -> Result<Option<Zeroizing<Vec<u8>>>, StoreError> {
            Ok(self.peek().map(Zeroizing::new))
        }
        fn set(&self, secret: &[u8]) -> Result<(), StoreError> {
            self.put(Some(secret.to_vec()));
            Ok(())
        }
        fn delete(&self) -> Result<(), StoreError> {
            self.put(None);
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::testutil::{Cleanup, MemoryStore};
    use super::*;

    #[test]
    fn the_key_is_created_once_and_is_256_bits() {
        let store = MemoryStore::default();
        let keychain = store.keychain();
        assert_eq!(keychain.existing_key().unwrap(), None);
        let first = keychain.key_or_create().unwrap();
        assert_eq!(store.peek().unwrap().len(), KEY_LEN);
        assert_ne!(*first, [0; KEY_LEN]);
        let second = keychain.key_or_create().unwrap();
        assert_eq!(*first, *second);
        assert_eq!(*keychain.existing_key().unwrap().unwrap(), *first);
    }

    #[test]
    fn two_installs_get_different_keys() {
        let a = MemoryStore::default().keychain().key_or_create().unwrap();
        let b = MemoryStore::default().keychain().key_or_create().unwrap();
        assert_ne!(*a, *b);
    }

    #[test]
    fn forget_removes_the_key_and_a_missing_one_is_fine() {
        let store = MemoryStore::default();
        let keychain = store.keychain();
        keychain.key_or_create().unwrap();
        keychain.forget().unwrap();
        assert_eq!(store.peek(), None);
        keychain.forget().unwrap();
    }

    #[test]
    fn a_stored_secret_of_the_wrong_size_is_invalid_and_is_never_replaced() {
        let store = MemoryStore::default();
        store.put(Some(vec![1, 2, 3]));
        let keychain = store.keychain();
        assert_eq!(keychain.existing_key().unwrap_err(), KeyError::Invalid);
        assert_eq!(keychain.key_or_create().unwrap_err(), KeyError::Invalid);
        assert_eq!(store.peek(), Some(vec![1, 2, 3]));
    }

    #[test]
    fn an_unavailable_keychain_says_so_for_every_call() {
        let keychain = Keychain::unavailable();
        assert_eq!(keychain.existing_key().unwrap_err(), KeyError::Unavailable);
        assert_eq!(keychain.key_or_create().unwrap_err(), KeyError::Unavailable);
        assert_eq!(keychain.forget().unwrap_err(), KeyError::Unavailable);
    }

    #[test]
    fn keyring_errors_map_to_unavailable_unless_the_data_is_bad() {
        use keyring_core::Error;
        assert_eq!(map_error(&Error::NoDefaultStore), StoreError::Unavailable);
        assert_eq!(
            map_error(&Error::NotSupportedByStore("x".into())),
            StoreError::Unavailable
        );
        assert_eq!(map_error(&Error::BadEncoding(vec![1])), StoreError::Damaged);
        assert_eq!(
            map_error(&Error::NoStorageAccess("denied".into())),
            StoreError::Failed
        );
    }

    /// A store that fails every call the way it is told to.
    struct Failing(StoreError);

    impl SecretStore for Failing {
        fn get(&self) -> Result<Option<Zeroizing<Vec<u8>>>, StoreError> {
            Err(self.0)
        }
        fn set(&self, _secret: &[u8]) -> Result<(), StoreError> {
            Err(self.0)
        }
        fn delete(&self) -> Result<(), StoreError> {
            Err(self.0)
        }
    }

    #[test]
    fn a_read_error_is_not_a_corrupt_key() {
        let read = Keychain::new(Box::new(Failing(StoreError::Failed)));
        assert_eq!(read.existing_key().unwrap_err(), KeyError::Unreadable);
        assert_eq!(read.key_or_create().unwrap_err(), KeyError::Unreadable);
        assert_eq!(read.forget().unwrap_err(), KeyError::Unreadable);
        let bad = Keychain::new(Box::new(Failing(StoreError::Damaged)));
        assert_eq!(bad.existing_key().unwrap_err(), KeyError::Invalid);
        // A secret that is there and is not a key is the third state.
        let store = MemoryStore::default();
        store.put(Some(vec![0; 7]));
        assert_eq!(
            store.keychain().existing_key().unwrap_err(),
            KeyError::Invalid
        );
    }

    /// Real OS credential store round trip (Credential Manager on Windows, Keychain on macOS). Run explicitly:
    /// `cargo test platform_store_round_trip -- --ignored`. Uses a unique service name and removes it afterwards.
    #[test]
    #[ignore = "touches the real OS credential store; run explicitly (CI does)"]
    fn platform_store_round_trip() {
        let mut tag = [0u8; 8];
        getrandom::fill(&mut tag).unwrap();
        let tag: String = tag.iter().map(|b| format!("{b:02x}")).collect();
        let service = format!("app.sheer.desktop.test-{tag}");
        let first = Keychain::platform_for_service(&service);
        // Removes the credential when the test ends, also on a panic.
        let _cleanup = Cleanup(Keychain::platform_for_service(&service));
        assert_eq!(first.existing_key().unwrap(), None);
        let key = first.key_or_create().unwrap();
        // A new instance (a restart) reads the same key.
        let again = Keychain::platform_for_service(&service);
        let read = again.existing_key();
        let same = matches!(&read, Ok(Some(k)) if **k == *key);
        let cleaned = first.forget();
        assert!(
            same,
            "the key must survive a new keychain instance: {read:?}"
        );
        cleaned.unwrap();
        assert_eq!(again.existing_key().unwrap(), None);
    }

    /// A store that never answers (until released).
    struct Hung(Arc<AtomicBool>);

    impl SecretStore for Hung {
        fn get(&self) -> Result<Option<Zeroizing<Vec<u8>>>, StoreError> {
            while !self.0.load(Ordering::Acquire) {
                std::thread::sleep(Duration::from_millis(5));
            }
            Ok(None)
        }
        fn set(&self, _secret: &[u8]) -> Result<(), StoreError> {
            self.get().map(|_| ())
        }
        fn delete(&self) -> Result<(), StoreError> {
            self.get().map(|_| ())
        }
    }

    #[test]
    fn a_hung_store_is_unavailable_after_the_deadline_and_costs_one_thread() {
        let release = Arc::new(AtomicBool::new(false));
        let keychain = Keychain::with_deadline(
            Box::new(Hung(Arc::clone(&release))),
            Duration::from_millis(50),
        );
        let started = std::time::Instant::now();
        assert_eq!(keychain.existing_key().unwrap_err(), KeyError::Unavailable);
        assert!(started.elapsed() < Duration::from_secs(5));
        // The stuck call still runs: the next ones do not wait or start another thread.
        assert_eq!(keychain.key_or_create().unwrap_err(), KeyError::Unavailable);
        assert_eq!(keychain.forget().unwrap_err(), KeyError::Unavailable);
        // Once it ended, the store is used again.
        release.store(true, Ordering::Release);
        std::thread::sleep(Duration::from_millis(150));
        assert_eq!(keychain.existing_key().unwrap(), None);
    }

    #[test]
    fn a_working_store_behind_a_deadline_behaves_the_same() {
        let store = MemoryStore::default();
        let keychain = Keychain::with_deadline(Box::new(store.clone()), DEADLINE);
        let key = keychain.key_or_create().unwrap();
        assert_eq!(*keychain.existing_key().unwrap().unwrap(), *key);
        assert_eq!(store.peek().unwrap().len(), KEY_LEN);
        keychain.forget().unwrap();
        assert_eq!(store.peek(), None);
    }
}
