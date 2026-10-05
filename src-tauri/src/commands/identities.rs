//! Signing identities (ADR-121 section 3, ARCHITECTURE section 5 "Certificate signatures (v1.4)", SECURITY I16 and I17).
//!
//! | Command | Arguments | Returns |
//! |---|---|---|
//! | `list_signing_identities` | none | `SigningIdentities` (status, at most 8 items) |
//! | `create_signing_identity` | `spec: NewIdentitySpec` | `SigningIdentityInfo` (ECDSA P-256, self-signed, 3 years) |
//! | `pick_identity_file` | none | `IdentityImportTicket \| null` (Rust open dialog; `null` = cancelled) |
//! | `import_signing_identity` | `ticket: number`, `password: string` | `SigningIdentityInfo` |
//! | `discard_identity_import` | `ticket: number` | nothing |
//! | `delete_signing_identity` | `identityId: string` (32 hex) | nothing |
//! | `export_signing_certificate` | `identityId: string` | `boolean` (`false` = dialog cancelled) |
//!
//! Private keys, PKCS#12 bytes and the password never go to the webview: it sees [`SigningIdentityInfo`] only. The commands are thin;
//! [`Identities`] holds the logic so it runs in tests without a window. The `.p12` password is asked once, at import, held in a
//! [`Secret`] (wiped on drop) and never stored. A picked file waits in memory under a ticket (one at a time, ten minutes, five wrong
//! passwords), and from the fourth wrong password on each try waits a second, in Rust, so the webview cannot skip it.
//! [`signer_material`] is the seam to the signer (package B2): a key lives for one signature only.
//!
//! Errors: a wrong password is `password_required` (the code `unlock_document` uses for the same thing); a file without one key and its
//! certificate is `invalid_argument` `identityFile`; another key kind is `unsupported_feature` `signingKey`; no keychain is
//! `keychain_unavailable`; a ninth identity is `limit_exceeded` `identities`; an expired identity cannot sign (`identityExpired`).

use std::io::Read;
use std::path::Path;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tauri::{State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

use super::blocking;
use crate::error::{AppError, ErrorCode, UiError};
use crate::limits;
use crate::pdfsig::material::SignerMaterial;
use crate::pdfsig::types::{
    IdentityImportTicket, IdentitySource, NewIdentitySpec, SigningIdentities, SigningIdentityInfo,
    StoreStatus,
};
use crate::pdfsig::{certgen, identity, p12};
use crate::security::secret::Secret;
use crate::storage::atomic::write_atomic;
use crate::storage::identities::{self, IdentityStore, Stored};
use crate::storage::open_without_blocking;

/// The identity store and the one pending import, shared by the commands (managed by Tauri, created in `lib.rs`).
pub type IdentitiesState = Arc<Identities>;

/// A picked file that waits for its password.
struct Pending {
    ticket: u32,
    bytes: Vec<u8>,
    picked: Instant,
    wrong: u8,
    last_wrong: Option<Instant>,
}

/// The identities of the user: the encrypted store and the pending import.
pub struct Identities {
    store: IdentityStore,
    pending: Mutex<Option<Pending>>,
    next_ticket: AtomicU32,
}

/// How long the next password try has to wait: nothing for the first three wrong ones, then `IDENTITY_PASSWORD_DELAY` after the last.
fn wait_for(wrong: u8, last_wrong: Option<Instant>, now: Instant) -> Duration {
    match last_wrong {
        Some(last) if wrong >= 3 => {
            (last + limits::IDENTITY_PASSWORD_DELAY).saturating_duration_since(now)
        }
        _ => Duration::ZERO,
    }
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs())
}

/// An id as the UI sends it: 32 lowercase hex digits. Anything else is refused before the store is read.
fn checked_id(id: &str) -> Result<&str, AppError> {
    if identities::is_id(id) {
        Ok(id)
    } else {
        Err(AppError::invalid("identity"))
    }
}

/// What the UI may know about a stored identity.
fn info_of(stored: &Stored) -> Result<SigningIdentityInfo, AppError> {
    let leaf = stored
        .chain
        .first()
        .ok_or_else(|| AppError::new(ErrorCode::Internal))?;
    Ok(SigningIdentityInfo {
        cert: identity::summarize(leaf)?,
        id: stored.id.clone(),
        source: stored.source,
        key: identity::check_key(&stored.key, leaf)?,
        chain_length: u32::try_from(stored.chain.len()).unwrap_or(u32::MAX),
        expired: identity::is_expired(leaf, SystemTime::now()),
    })
}

impl Identities {
    pub fn new(store: IdentityStore) -> Self {
        Self {
            store,
            pending: Mutex::new(None),
            next_ticket: AtomicU32::new(1),
        }
    }

    /// The identities under the app data directory, with the key in the OS keychain.
    pub fn in_data_dir(data_dir: &Path) -> Self {
        Self::new(IdentityStore::in_data_dir(data_dir))
    }

    /// The status and the identities (metadata only). An entry that cannot be read is left out.
    pub fn list(&self) -> Result<SigningIdentities, AppError> {
        let (status, items) = self.store.list(|status, items| {
            (
                status,
                items
                    .iter()
                    .filter_map(|s| info_of(s).ok())
                    .collect::<Vec<_>>(),
            )
        })?;
        Ok(SigningIdentities { status, items })
    }

    /// Makes a self-signed ECDSA P-256 identity and stores it.
    pub fn create(&self, spec: &NewIdentitySpec) -> Result<SigningIdentityInfo, AppError> {
        // Refuse before any work when the store cannot take it (no keychain, locked, full).
        match self.store.list(|status, items| (status, items.len()))? {
            (StoreStatus::Unavailable, _) => {
                return Err(AppError::new(ErrorCode::KeychainUnavailable))
            }
            (StoreStatus::Locked, _) => return Err(AppError::invalid("identities")),
            (_, count) if count >= limits::IDENTITIES_MAX => {
                return Err(AppError::limit("identities", limits::IDENTITIES_MAX as u64))
            }
            _ => {}
        }
        let made = certgen::generate(spec)?;
        let stored = Stored {
            id: identities::random_id()?,
            label: identity::common_name(&made.chain[0]),
            source: IdentitySource::Generated,
            created: unix_now(),
            chain: made.chain,
            key: made.key_pkcs8,
        };
        let info = info_of(&stored)?;
        self.store.add(stored)?;
        Ok(info)
    }

    /// Holds a picked file's bytes under a new ticket (replacing an earlier pending import). `too_large` over
    /// `limits::IDENTITY_FILE_MAX`.
    pub fn begin_import(
        &self,
        bytes: Vec<u8>,
        display_name: String,
    ) -> Result<IdentityImportTicket, AppError> {
        if bytes.len() > limits::IDENTITY_FILE_MAX {
            return Err(AppError::too_large(
                "identityFile",
                limits::IDENTITY_FILE_MAX as u64,
            ));
        }
        let mut ticket = self.next_ticket.fetch_add(1, Ordering::Relaxed);
        if ticket == 0 {
            ticket = self.next_ticket.fetch_add(1, Ordering::Relaxed);
        }
        *self.pending.lock().unwrap_or_else(PoisonError::into_inner) = Some(Pending {
            ticket,
            bytes,
            picked: Instant::now(),
            wrong: 0,
            last_wrong: None,
        });
        Ok(IdentityImportTicket {
            ticket,
            display_name,
        })
    }

    /// Takes the pending import `ticket` out of its slot (so one try runs at a time). `not_found` for an unknown or expired ticket.
    fn take_pending(&self, ticket: u32) -> Result<Pending, AppError> {
        let mut slot = self.pending.lock().unwrap_or_else(PoisonError::into_inner);
        let taken = slot.take_if(|pending| pending.ticket == ticket);
        match taken {
            Some(pending) if pending.picked.elapsed() <= limits::IDENTITY_TICKET_TTL => Ok(pending),
            _ => Err(AppError::not_found("importTicket")),
        }
    }

    /// Puts a pending import back unless another file was picked meanwhile.
    fn keep_pending(&self, pending: Pending) {
        let mut slot = self.pending.lock().unwrap_or_else(PoisonError::into_inner);
        if slot.is_none() {
            *slot = Some(pending);
        }
    }

    /// Decrypts the picked file with `password` and stores its identity. The password is used for this one call.
    pub fn import(&self, ticket: u32, password: &Secret) -> Result<SigningIdentityInfo, AppError> {
        let mut pending = self.take_pending(ticket)?;
        let wait = wait_for(pending.wrong, pending.last_wrong, Instant::now());
        if !wait.is_zero() {
            std::thread::sleep(wait);
        }
        let decoded = match p12::decode(&pending.bytes, password.expose()) {
            Ok(decoded) => decoded,
            Err(p12::P12Error::WrongPassword) => {
                pending.wrong += 1;
                pending.last_wrong = Some(Instant::now());
                if pending.wrong < limits::IDENTITY_PASSWORD_TRIES {
                    self.keep_pending(pending);
                }
                return Err(AppError::new(ErrorCode::PasswordRequired));
            }
            // A file that cannot work is dropped: another password would not help.
            Err(p12::P12Error::Invalid) => return Err(AppError::invalid("identityFile")),
        };
        let leaf = decoded
            .chain
            .first()
            .ok_or_else(|| AppError::invalid("identityFile"))?;
        // Kind and match are checked before anything is stored; a failure drops the file.
        identity::check_key(&decoded.key_pkcs8, leaf)?;
        let stored = Stored {
            id: identities::random_id()?,
            label: identity::common_name(leaf),
            source: IdentitySource::Imported,
            created: unix_now(),
            chain: decoded.chain,
            key: decoded.key_pkcs8,
        };
        let info = info_of(&stored)?;
        match self.store.add(stored) {
            Ok(()) => Ok(info),
            Err(error) => {
                // The store said no (no keychain, full, locked): the file stays pending so the user can try again.
                self.keep_pending(pending);
                Err(error.into())
            }
        }
    }

    /// Drops a pending import. An unknown ticket is not an error.
    pub fn discard(&self, ticket: u32) {
        let mut slot = self.pending.lock().unwrap_or_else(PoisonError::into_inner);
        drop(slot.take_if(|pending| pending.ticket == ticket));
    }

    /// Deletes an identity. `not_found` for an unknown id.
    pub fn delete(&self, id: &str) -> Result<(), AppError> {
        Ok(self.store.remove(checked_id(id)?)?)
    }

    /// The public certificate (DER) of an identity and a file name stem for it. Never the key.
    pub fn certificate(&self, id: &str) -> Result<(String, Vec<u8>), AppError> {
        self.store.with(checked_id(id)?, |stored| {
            let leaf = stored
                .chain
                .first()
                .cloned()
                .ok_or_else(|| AppError::new(ErrorCode::Internal))?;
            Ok((file_stem(&stored.label), leaf))
        })?
    }

    /// The key and chain of identity `id` for one signature (package B2). `identityExpired` for an expired certificate.
    pub fn signer_material(&self, id: &str) -> Result<SignerMaterial, AppError> {
        self.store.with(checked_id(id)?, |stored| {
            let leaf = stored
                .chain
                .first()
                .ok_or_else(|| AppError::new(ErrorCode::Internal))?;
            if identity::is_expired(leaf, SystemTime::now()) {
                return Err(AppError::invalid("identityExpired"));
            }
            identity::material(&stored.chain, &stored.key)
        })?
    }
}

/// The seam to the signer: the key and the certificate chain of identity `id`, for one signature. The key types wipe themselves when
/// dropped; nothing of this reaches IPC. Errors: `invalid_argument` `identity` (malformed id), `not_found` `identity`,
/// `invalid_argument` `identityExpired`, `keychain_unavailable`, `invalid_argument` `identities` (the store is locked).
pub fn signer_material(identities: &Identities, id: &str) -> Result<SignerMaterial, AppError> {
    identities.signer_material(id)
}

/// A file name stem from a common name: letters, digits, space, dash, dot and underscore; anything else becomes `_`; at most 64 chars.
fn file_stem(name: &str) -> String {
    let stem: String = name
        .chars()
        .take(64)
        .map(|c| {
            if c.is_alphanumeric() || matches!(c, ' ' | '-' | '.' | '_') {
                c
            } else {
                '_'
            }
        })
        .collect();
    let stem = stem.trim_matches(|c: char| c == '.' || c == ' ').to_owned();
    if stem.is_empty() {
        "certificate".to_owned()
    } else {
        stem
    }
}

/// Reads a picked identity file: a regular file of at most `limits::IDENTITY_FILE_MAX` bytes (`too_large` otherwise), opened without
/// waiting on a FIFO. Returns the bytes and the file's name (never a directory).
fn read_identity_file(path: &Path) -> Result<(Vec<u8>, String), AppError> {
    let file = open_without_blocking(path)?;
    if !file.metadata()?.is_file() {
        return Err(AppError::invalid("identityFile"));
    }
    let mut bytes = Vec::new();
    file.take(limits::IDENTITY_FILE_MAX as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > limits::IDENTITY_FILE_MAX {
        return Err(AppError::too_large(
            "identityFile",
            limits::IDENTITY_FILE_MAX as u64,
        ));
    }
    Ok((bytes, crate::documents::display_name(path)))
}

/// The identity store with its status.
#[tauri::command]
pub async fn list_signing_identities(
    state: State<'_, IdentitiesState>,
) -> Result<SigningIdentities, UiError> {
    let identities = Arc::clone(state.inner());
    blocking(move || identities.list()).await
}

/// Makes a self-signed ECDSA P-256 identity valid for three years.
#[tauri::command]
pub async fn create_signing_identity(
    state: State<'_, IdentitiesState>,
    spec: NewIdentitySpec,
) -> Result<SigningIdentityInfo, UiError> {
    let identities = Arc::clone(state.inner());
    blocking(move || identities.create(&spec)).await
}

/// Lets the user pick a `.p12` or `.pfx` file in a Rust dialog; the file is held in memory under a ticket. `null` if cancelled.
#[tauri::command]
pub async fn pick_identity_file(
    window: WebviewWindow,
    state: State<'_, IdentitiesState>,
) -> Result<Option<IdentityImportTicket>, UiError> {
    let identities = Arc::clone(state.inner());
    blocking(move || {
        let picked = window
            .dialog()
            .file()
            .set_parent(&window)
            .add_filter("PKCS #12", &["p12", "pfx"])
            .blocking_pick_file();
        let Some(file) = picked else {
            return Ok(None);
        };
        let path = file
            .into_path()
            .map_err(|error| AppError::logged(ErrorCode::Internal, error))?;
        let (bytes, display_name) = read_identity_file(&path)?;
        identities.begin_import(bytes, display_name).map(Some)
    })
    .await
}

/// Decrypts the picked file with `password` and stores its identity.
#[tauri::command]
pub async fn import_signing_identity(
    state: State<'_, IdentitiesState>,
    ticket: u32,
    password: Secret,
) -> Result<SigningIdentityInfo, UiError> {
    let identities = Arc::clone(state.inner());
    blocking(move || identities.import(ticket, &password)).await
}

/// Drops a picked file. An unknown ticket is not an error.
#[tauri::command]
pub async fn discard_identity_import(
    state: State<'_, IdentitiesState>,
    ticket: u32,
) -> Result<(), UiError> {
    let identities = Arc::clone(state.inner());
    blocking(move || {
        identities.discard(ticket);
        Ok(())
    })
    .await
}

/// Deletes an identity.
#[tauri::command]
pub async fn delete_signing_identity(
    state: State<'_, IdentitiesState>,
    identity_id: String,
) -> Result<(), UiError> {
    let identities = Arc::clone(state.inner());
    blocking(move || identities.delete(&identity_id)).await
}

/// Writes the public certificate of an identity (`<CN>.cer`, DER) to a file the user picks. `false` if the dialog was cancelled.
#[tauri::command]
pub async fn export_signing_certificate(
    window: WebviewWindow,
    state: State<'_, IdentitiesState>,
    identity_id: String,
) -> Result<bool, UiError> {
    let identities = Arc::clone(state.inner());
    blocking(move || {
        let (stem, der) = identities.certificate(&identity_id)?;
        let picked = window
            .dialog()
            .file()
            .set_parent(&window)
            .add_filter("Certificate", &["cer"])
            .set_file_name(format!("{stem}.cer"))
            .blocking_save_file();
        let Some(file) = picked else {
            return Ok(false);
        };
        let path = file
            .into_path()
            .map_err(|error| AppError::logged(ErrorCode::Internal, error))?;
        // Always a certificate extension: this can never replace a PDF or another document by its name.
        let path = if path
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("cer"))
        {
            path
        } else {
            let mut name = path.into_os_string();
            name.push(".cer");
            name.into()
        };
        write_atomic(&path, &der)?;
        Ok(true)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::atomic::testutil::TempDir;
    use crate::storage::keychain::testutil::MemoryStore;
    use crate::storage::keychain::Keychain;

    fn identities(dir: &TempDir) -> Identities {
        Identities::new(IdentityStore::new(
            dir.path().join("signing").join("identities.bin"),
            MemoryStore::default().keychain(),
        ))
    }

    fn spec(name: &str) -> NewIdentitySpec {
        NewIdentitySpec {
            name: name.into(),
            email: None,
            organization: None,
        }
    }

    #[test]
    fn the_password_delay_starts_with_the_fourth_try() {
        let now = Instant::now();
        let d = limits::IDENTITY_PASSWORD_DELAY;
        assert_eq!(wait_for(0, None, now), Duration::ZERO);
        for wrong in 1..3 {
            assert_eq!(wait_for(wrong, Some(now), now), Duration::ZERO);
        }
        assert_eq!(wait_for(3, Some(now), now), d);
        assert_eq!(wait_for(4, Some(now), now), d);
        assert_eq!(wait_for(4, Some(now), now + d), Duration::ZERO);
    }

    #[test]
    fn ids_must_be_32_lowercase_hex() {
        assert!(checked_id(&"a".repeat(32)).is_ok());
        for bad in ["", "abc", &"A".repeat(32), &"g".repeat(32), "../../x"] {
            assert!(checked_id(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn file_stems_are_safe_names() {
        assert_eq!(file_stem("Ada Lovelace"), "Ada Lovelace");
        assert_eq!(file_stem("a/b\\c:d"), "a_b_c_d");
        assert_eq!(file_stem("..."), "certificate");
        assert_eq!(file_stem(""), "certificate");
        assert_eq!(file_stem(&"x".repeat(100)).len(), 64);
    }

    #[test]
    fn create_list_export_delete() {
        let dir = TempDir::new();
        let identities = identities(&dir);
        let listed = identities.list().expect("list");
        assert_eq!((listed.status, listed.items.len()), (StoreStatus::Empty, 0));

        let made = identities.create(&spec("Ada Lovelace")).expect("create");
        assert_eq!(made.cert.subject.common_name, "Ada Lovelace");
        assert_eq!(made.source, IdentitySource::Generated);
        assert_eq!(made.key, crate::pdfsig::types::KeyKind::EcP256);
        assert!(made.cert.self_signed && !made.expired && made.chain_length == 1);
        assert_eq!(made.id.len(), 32);
        let listed = identities.list().expect("list");
        assert_eq!(listed.status, StoreStatus::Ready);
        assert_eq!(listed.items, vec![made.clone()]);

        let (stem, der) = identities.certificate(&made.id).expect("certificate");
        assert_eq!(stem, "Ada Lovelace");
        assert_eq!(identity::sha256_hex(&der), made.cert.fingerprint_sha256);
        // The public certificate holds no key bytes.
        assert!(der.len() < 1024);

        let material = signer_material(&identities, &made.id).expect("material");
        assert!(matches!(
            material.key,
            crate::pdfsig::material::SignerKey::EcdsaP256(_)
        ));
        assert!(matches!(
            signer_material(&identities, &"0".repeat(32))
                .err()
                .map(|e| e.code()),
            Some(ErrorCode::NotFound)
        ));
        assert!(signer_material(&identities, "zz").is_err());

        identities.delete(&made.id).expect("delete");
        assert_eq!(identities.list().expect("list").status, StoreStatus::Empty);
        assert_eq!(
            identities.delete(&made.id).err().map(|e| e.code()),
            Some(ErrorCode::NotFound)
        );
        assert!(identities.certificate(&made.id).is_err());
    }

    #[test]
    fn create_refuses_without_a_keychain_and_at_the_cap_and_for_bad_input() {
        let dir = TempDir::new();
        let none = Identities::new(IdentityStore::new(
            dir.path().join("signing").join("identities.bin"),
            Keychain::unavailable(),
        ));
        assert_eq!(none.list().expect("list").status, StoreStatus::Unavailable);
        assert_eq!(
            none.create(&spec("A")).err().map(|e| e.code()),
            Some(ErrorCode::KeychainUnavailable)
        );
        assert!(!dir.path().join("signing").exists());

        let dir = TempDir::new();
        let identities = identities(&dir);
        assert_eq!(
            identities.create(&spec("")).err().map(|e| e.code()),
            Some(ErrorCode::InvalidArgument)
        );
        for n in 0..limits::IDENTITIES_MAX {
            identities
                .create(&spec(&format!("Name {n}")))
                .expect("create");
        }
        assert_eq!(
            identities.create(&spec("One more")).err().map(|e| e.code()),
            Some(ErrorCode::LimitExceeded)
        );
    }

    #[test]
    fn tickets_are_single_and_unknown_ones_are_harmless() {
        let dir = TempDir::new();
        let identities = identities(&dir);
        let first = identities
            .begin_import(vec![1, 2, 3], "a.p12".into())
            .expect("first");
        let second = identities
            .begin_import(vec![4], "b.p12".into())
            .expect("second");
        assert_ne!(first.ticket, second.ticket);
        assert_eq!(second.display_name, "b.p12");
        // One at a time: the first is gone.
        let pw = Secret::new("pw").expect("secret");
        assert_eq!(
            identities.import(first.ticket, &pw).err().map(|e| e.code()),
            Some(ErrorCode::NotFound)
        );
        identities.discard(first.ticket);
        identities.discard(12345);
        // Garbage in a ticket drops it.
        assert_eq!(
            identities
                .import(second.ticket, &pw)
                .err()
                .map(|e| e.code()),
            Some(ErrorCode::InvalidArgument)
        );
        assert_eq!(
            identities
                .import(second.ticket, &pw)
                .err()
                .map(|e| e.code()),
            Some(ErrorCode::NotFound)
        );
        let big = vec![0u8; limits::IDENTITY_FILE_MAX + 1];
        assert_eq!(
            identities
                .begin_import(big, String::new())
                .err()
                .map(|e| e.code()),
            Some(ErrorCode::TooLarge)
        );
    }

    #[test]
    fn picked_files_are_size_bounded_and_named_without_a_directory() {
        let dir = TempDir::new();
        let path = dir.path().join("id.p12");
        std::fs::write(&path, [1u8; 100]).expect("write");
        let (bytes, name) = read_identity_file(&path).expect("read");
        assert_eq!((bytes.len(), name.as_str()), (100, "id.p12"));
        std::fs::write(&path, vec![0u8; limits::IDENTITY_FILE_MAX + 1]).expect("write");
        assert_eq!(
            read_identity_file(&path).err().map(|e| e.code()),
            Some(ErrorCode::TooLarge)
        );
        assert!(read_identity_file(dir.path()).is_err(), "a directory");
        assert!(read_identity_file(&dir.path().join("missing.p12")).is_err());
    }
}
