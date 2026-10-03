//! The key of the signature library in the OS credential store (ADR-041 section 7, SECURITY D2).
//!
//! The key is 256 random bits from `getrandom`, created on first use and kept as a binary secret under service
//! [`SERVICE`] and user [`USER`]. It lives in a [`Zeroizing`] array only while a call runs and is never logged or put in an
//! error. Everything that touches the OS sits behind [`SecretStore`], so the rest of the app, and every test, runs against an
//! in-memory double and never against a real keychain. `keyring-core` is used per store (`CredentialStoreApi::build`), not
//! through its global default store, so nothing else in the process can swap the store under us.
//!
//! A store that cannot be reached (no store on this platform, a locked or missing keychain service, access refused) is
//! [`KeyError::Unavailable`]: the library then keeps nothing on disk, and entries live for the session only.

use zeroize::Zeroizing;

/// Service name of the credential (ADR-041 section 7).
pub const SERVICE: &str = "app.sheer.desktop";
/// User name of the credential: the key of the library, version 1.
pub const USER: &str = "signature-library-key-v1";
/// Length of the key in bytes.
pub const KEY_LEN: usize = 32;

/// The key of the library. Wiped when dropped.
pub type Key = Zeroizing<[u8; KEY_LEN]>;

/// Why the credential store did not do what was asked.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StoreError {
    /// There is no store, or it cannot be used now (locked, refused, service missing).
    Unavailable,
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
    /// The store answered with something that is not a 256-bit key, or the system has no randomness.
    Invalid,
}

/// The key of the library, kept in a [`SecretStore`].
pub struct Keychain {
    store: Box<dyn SecretStore>,
}

impl Keychain {
    pub fn new(store: Box<dyn SecretStore>) -> Self {
        Self { store }
    }

    /// The store of this platform (Keychain on macOS, Credential Manager on Windows). Anywhere else, or when the store cannot be
    /// opened, the keychain is unavailable.
    pub fn platform() -> Self {
        Self::new(platform_store())
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
            Err(StoreError::Unavailable) => Err(KeyError::Unavailable),
            Err(StoreError::Damaged) => Err(KeyError::Invalid),
        }
    }

    /// The key, created and stored if there is none yet.
    pub fn key_or_create(&self) -> Result<Key, KeyError> {
        if let Some(key) = self.existing_key()? {
            return Ok(key);
        }
        let mut key: Key = Zeroizing::new([0; KEY_LEN]);
        getrandom::fill(key.as_mut_slice()).map_err(|_| KeyError::Invalid)?;
        self.store
            .set(key.as_slice())
            .map_err(|error| match error {
                StoreError::Unavailable => KeyError::Unavailable,
                StoreError::Damaged => KeyError::Invalid,
            })?;
        Ok(key)
    }

    /// Removes the key from the store.
    pub fn forget(&self) -> Result<(), KeyError> {
        self.store.delete().map_err(|error| match error {
            StoreError::Unavailable => KeyError::Unavailable,
            StoreError::Damaged => KeyError::Invalid,
        })
    }
}

/// A secret of exactly [`KEY_LEN`] bytes as a key.
fn key_from(secret: &[u8]) -> Result<Key, KeyError> {
    let bytes: [u8; KEY_LEN] = secret.try_into().map_err(|_| KeyError::Invalid)?;
    Ok(Zeroizing::new(bytes))
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
        // No store, no access, the service is down or refused: all of it means "not now, not here". Nothing is written.
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
) -> Result<EntryStore, keyring_core::Error> {
    Ok(EntryStore {
        entry: store.build(SERVICE, USER, None)?,
    })
}

#[cfg(windows)]
fn platform_store() -> Box<dyn SecretStore> {
    match windows_native_keyring_store::Store::new().and_then(|store| entry_in(store.as_ref())) {
        Ok(store) => Box::new(store),
        Err(_) => Box::new(UnavailableStore),
    }
}

#[cfg(target_os = "macos")]
fn platform_store() -> Box<dyn SecretStore> {
    match apple_native_keyring_store::keychain::Store::new()
        .and_then(|store| entry_in(store.as_ref()))
    {
        Ok(store) => Box::new(store),
        Err(_) => Box::new(UnavailableStore),
    }
}

/// Linux builds are for development only: no store.
#[cfg(not(any(windows, target_os = "macos")))]
fn platform_store() -> Box<dyn SecretStore> {
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
    use super::testutil::MemoryStore;
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
    }
}
