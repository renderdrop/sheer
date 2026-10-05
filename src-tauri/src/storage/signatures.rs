//! The signature library: saved signatures and initials, encrypted at rest (ADR-041 section 7, ADR-042 section 5, SECURITY D2).
//!
//! One file, `<app data>/signatures/library.bin`:
//!
//! ```text
//! "SHLB" | u8 version = 1 | 24-byte nonce | XChaCha20-Poly1305(JSON)     AAD = the first 5 bytes
//! ```
//!
//! A new random nonce per write. The plaintext is `{ "v": 1, "items": [..] }`. The key comes from the OS credential store
//! (`storage::keychain`). Rules:
//!
//! - **At most [`MAX_PER_ROLE`] entries per role** (signature, initials) and [`MAX_ART_BYTES`] of art per entry; the file is
//!   at most [`MAX_FILE_BYTES`], checked before decrypting. Names are 1 to [`MAX_NAME_CHARS`] characters.
//! - **Never plaintext.** Without a usable keychain nothing is written: entries live in memory for the session
//!   ([`Status::Unavailable`]). A file that does not open (key gone, wrong key, tampered, damaged, from a newer version) makes
//!   the library [`Status::Locked`]: it is never read as anything else, never overwritten, and only
//!   [`Library::forget_all`] (file and key) gets out. There the file that did not open is quarantined, not deleted: renamed aside to
//!   `library.bin.quarantine-<seconds>` (never over another file; the newest [`KEEP_QUARANTINED`] are kept), its key gone with the
//!   rest. A keychain that fails a call ([`KeyError::Unreadable`]) is no evidence about the file: the library behaves as without a
//!   keychain for that call and the file is not touched.
//! - Deleting an entry rewrites the file without it (the old ciphertext is unreadable without the key; no secure wipe is claimed).
//! - Key material and art are never logged and appear in no error.

use std::fs::File;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::{SystemTime, UNIX_EPOCH};

use chacha20poly1305::aead::{Aead, Payload};
use chacha20poly1305::{Key as CipherKey, KeyInit, XChaCha20Poly1305, XNonce};
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::error::{AppError, ErrorCode};
use crate::signatures::vector::{self, DrawCmd};
use crate::storage::atomic::write_atomic;
use crate::storage::keychain::{Key, KeyError, Keychain};
use crate::storage::open_without_blocking;

/// File name inside `<app data>/signatures/`.
pub const FILE_NAME: &str = "library.bin";
/// Directory inside the app data directory.
pub const DIRECTORY: &str = "signatures";

const MAGIC: &[u8; 4] = b"SHLB";
const VERSION: u8 = 1;
const HEADER_LEN: usize = 5;
const NONCE_LEN: usize = 24;
const TAG_LEN: usize = 16;

/// Most entries of one role.
pub const MAX_PER_ROLE: usize = 8;
/// Most bytes of art (its JSON) in one entry.
pub const MAX_ART_BYTES: usize = 4 * 1024 * 1024;
/// Largest library file that is read at all.
pub const MAX_FILE_BYTES: usize = 64 * 1024 * 1024;
/// Longest name of an entry, in characters.
pub const MAX_NAME_CHARS: usize = 64;
/// Largest side of the art's box, in its own units.
const MAX_ART_UNITS: u32 = 1_000_000;
/// Commands in a preview of vector art (the list never carries more of an entry).
const PREVIEW_COMMANDS: usize = 1_500;
/// Longest side of the thumbnail of raster art in the list, in pixels, and the most bytes of its PNG.
const PREVIEW_PX: u32 = 96;
const PREVIEW_PNG_BYTES: usize = 24 * 1024;
/// Quarantined library files that are kept.
pub const KEEP_QUARANTINED: usize = 2;
/// Name of a quarantined file up to the timestamp.
const QUARANTINE_PREFIX: &str = "library.bin.quarantine-";

/// What an entry is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Role {
    Signature,
    Initials,
}

/// The art of an entry (ADR-041 section 7, ADR-051). Vector: path commands in a box of `w` x `h` units (entries saved before 0.8.1
/// hold polygons: they load as `M`, `L`... `Z` paths). Raster: a PNG as standard base64.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub enum Art {
    Vector {
        w: u32,
        h: u32,
        #[serde(deserialize_with = "paths_or_polygons")]
        paths: Vec<Vec<DrawCmd>>,
    },
    Raster {
        w: u32,
        h: u32,
        png: String,
    },
}

impl Art {
    /// `invalid_argument` words: what is wrong with the art.
    fn check(&self) -> Result<(), LibraryError> {
        let (w, h) = match self {
            Art::Vector { w, h, paths } => {
                // Counts, structure and range as the art is held (commands may lie a margin outside the box).
                if vector::validate_art(*w as f32, *h as f32, paths).is_err() {
                    return Err(LibraryError::Invalid("art"));
                }
                (*w, *h)
            }
            Art::Raster { w, h, png } => {
                let alphabet = png
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'='));
                if png.is_empty() || !alphabet {
                    return Err(LibraryError::Invalid("art"));
                }
                (*w, *h)
            }
        };
        if w == 0 || h == 0 || w > MAX_ART_UNITS || h > MAX_ART_UNITS {
            return Err(LibraryError::Invalid("art"));
        }
        // Measured as it is written, into a counter that stops at the limit: no copy of the art is made.
        let mut counter = Counter { bytes: 0 };
        match serde_json::to_writer(&mut counter, self) {
            Ok(()) => Ok(()),
            Err(error) if error.is_io() => Err(LibraryError::TooLarge),
            Err(_) => Err(LibraryError::Invalid("art")),
        }
    }

    /// A PNG thumbnail of raster art in a box of [`PREVIEW_PX`], at most [`PREVIEW_PNG_BYTES`] (re-encoded, so nothing of the
    /// original file but pixels). `None` when the art does not decode or no thumbnail fits.
    fn thumbnail(png: &str) -> Option<Art> {
        use crate::signatures::{convert, raster};
        let picture = raster::decode_art(&convert::decode_base64(png)?).ok()?;
        let mut side = PREVIEW_PX;
        loop {
            let longest = picture.width().max(picture.height());
            let small = if longest <= side {
                picture.clone()
            } else {
                let factor = side as f32 / longest as f32;
                let scaled = |v: u32| ((v as f32 * factor).round() as u32).max(1);
                image::imageops::resize(
                    &picture,
                    scaled(picture.width()),
                    scaled(picture.height()),
                    image::imageops::FilterType::Triangle,
                )
            };
            let bytes = raster::encode_png(&small).ok()?;
            if bytes.len() <= PREVIEW_PNG_BYTES {
                return Some(Art::Raster {
                    w: small.width(),
                    h: small.height(),
                    png: convert::encode_base64(&bytes),
                });
            }
            if side <= 16 {
                return None;
            }
            side = side * 3 / 4;
        }
    }

    fn aspect(&self) -> f32 {
        let (Art::Vector { w, h, .. } | Art::Raster { w, h, .. }) = self;
        *w as f32 / (*h).max(1) as f32
    }

    /// The art as is when it is small; else cut down to its end points (curves become lines), a few hundred of them, for the list.
    fn preview(&self) -> Option<Art> {
        let (w, h, paths) = match self {
            Art::Vector { w, h, paths } => (w, h, paths),
            Art::Raster { png, .. } => return Self::thumbnail(png),
        };
        let total: usize = paths.iter().map(Vec::len).sum();
        if total <= PREVIEW_COMMANDS {
            return Some(self.clone());
        }
        let step = total.div_ceil(PREVIEW_COMMANDS / 2).max(1);
        let paths = paths
            .iter()
            .map(|path| {
                let ends: Vec<DrawCmd> = path
                    .iter()
                    .map(|cmd| match *cmd {
                        DrawCmd::M(x, y) => DrawCmd::M(x, y),
                        DrawCmd::L(x, y) | DrawCmd::C(_, _, _, _, x, y) => DrawCmd::L(x, y),
                        DrawCmd::Z => DrawCmd::Z,
                    })
                    .collect();
                // Every start and close stays; the lines in between are thinned.
                let mut kept = Vec::new();
                let mut run = 0usize;
                for cmd in ends {
                    match cmd {
                        DrawCmd::L(..) => {
                            if run.is_multiple_of(step) {
                                kept.push(cmd);
                            }
                            run += 1;
                        }
                        _ => {
                            run = 0;
                            kept.push(cmd);
                        }
                    }
                }
                kept
            })
            .collect();
        Some(Art::Vector {
            w: *w,
            h: *h,
            paths,
        })
    }
}

/// Reads `paths` as path commands, or as the polygons older versions saved (ADR-051 consequences).
fn paths_or_polygons<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Vec<Vec<DrawCmd>>, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Paths {
        Commands(Vec<Vec<DrawCmd>>),
        Polygons(Vec<Vec<[f32; 2]>>),
    }
    Ok(match Paths::deserialize(deserializer)? {
        Paths::Commands(paths) => paths,
        Paths::Polygons(polygons) => vector::from_polygons(&polygons),
    })
}

/// Counts the bytes written to it and refuses the ones past [`MAX_ART_BYTES`].
struct Counter {
    bytes: usize,
}

impl Write for Counter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.bytes = self.bytes.saturating_add(buf.len());
        if self.bytes > MAX_ART_BYTES {
            return Err(io::Error::from(io::ErrorKind::WriteZero));
        }
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// An entry as it is stored.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Item {
    /// 32 lowercase hex characters; random, never an index.
    pub id: String,
    pub role: Role,
    pub name: String,
    /// Seconds since 1970.
    pub created: u64,
    pub art: Art,
}

/// An entry as the list shows it: metadata and a small preview, never the art itself.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemInfo {
    pub id: String,
    pub role: Role,
    pub name: String,
    pub created: u64,
    /// Width over height of the art.
    pub aspect: f32,
    /// `vector` or `raster`.
    pub kind: &'static str,
    /// Vector art cut down to at most about 400 points, or a PNG thumbnail (at most 96 px, 24 KiB) of raster art.
    pub preview: Option<Art>,
}

impl From<&Item> for ItemInfo {
    fn from(item: &Item) -> Self {
        Self {
            id: item.id.clone(),
            role: item.role,
            name: item.name.clone(),
            created: item.created,
            aspect: item.art.aspect(),
            kind: match item.art {
                Art::Vector { .. } => "vector",
                Art::Raster { .. } => "raster",
            },
            preview: item.art.preview(),
        }
    }
}

/// The state of the library as the UI is told.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Status {
    /// Stored encrypted; the key is in the keychain.
    Ready,
    /// No keychain: nothing is stored, entries live for this session.
    Unavailable,
    /// The file does not open (key gone or wrong, file damaged or changed). Only `forget_all` gets out.
    Locked,
}

/// What `list` answers.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    pub status: Status,
    pub items: Vec<ItemInfo>,
}

/// An entry chosen for placing: what the model takes as a signature source.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub id: String,
    pub role: Role,
    pub art: Art,
}

/// Why the file or its plaintext was refused. Says nothing about content.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SealError {
    /// Not a library file: too short, too long or the wrong magic.
    Format,
    /// A version this build does not know.
    Version,
    /// The tag did not verify: wrong key, or the file was changed.
    Decrypt,
    /// The plaintext is not what the library writes.
    Content,
    /// No randomness for the nonce.
    Random,
    /// The cipher refused (input too long).
    Encrypt,
}

/// What a library call can fail with.
#[derive(Debug)]
pub enum LibraryError {
    /// The library is locked.
    Locked,
    /// An argument is not acceptable (`what` names it).
    Invalid(&'static str),
    /// The art is bigger than [`MAX_ART_BYTES`].
    TooLarge,
    /// The role already has [`MAX_PER_ROLE`] entries.
    Full,
    /// No such entry.
    NotFound,
    /// The key store gave something unusable, or the system has no randomness.
    Key,
    /// The OS keychain cannot be used now (missing, refused, failed, timed out), so nothing could be stored. A save says so
    /// instead of keeping the entry in memory and losing it at exit (ADR-107).
    Keychain,
    /// The file could not be read or written.
    Io(io::Error),
}

impl From<LibraryError> for AppError {
    fn from(error: LibraryError) -> Self {
        match error {
            LibraryError::Locked => AppError::invalid("library"),
            LibraryError::Invalid(what) => AppError::invalid(what),
            LibraryError::TooLarge => AppError::too_large("art", MAX_ART_BYTES as u64),
            LibraryError::Full => AppError::limit("signatures", MAX_PER_ROLE as u64),
            LibraryError::NotFound => AppError::not_found("signature"),
            LibraryError::Key => AppError::new(ErrorCode::Internal),
            LibraryError::Keychain => AppError::new(ErrorCode::KeychainUnavailable),
            LibraryError::Io(error) => AppError::from(error),
        }
    }
}

impl From<io::Error> for LibraryError {
    fn from(error: io::Error) -> Self {
        LibraryError::Io(error)
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Plain {
    v: u8,
    items: Vec<Item>,
}

fn header() -> [u8; HEADER_LEN] {
    let mut header = [0; HEADER_LEN];
    header[..4].copy_from_slice(MAGIC);
    header[4] = VERSION;
    header
}

/// Encrypts `items` under `key`: header, a fresh random nonce, ciphertext with the header as associated data.
pub fn seal(key: &Key, items: &[Item]) -> Result<Vec<u8>, SealError> {
    let plain = Zeroizing::new(
        serde_json::to_vec(&PlainRef { v: VERSION, items }).map_err(|_| SealError::Content)?,
    );
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
    if file.len() > MAX_FILE_BYTES {
        return Err(SealError::Format);
    }
    Ok(file)
}

#[derive(Serialize)]
struct PlainRef<'a> {
    v: u8,
    items: &'a [Item],
}

/// Decrypts a library file with `key`. Every failure is a [`SealError`]; there is no plaintext fallback.
pub fn open(key: &Key, file: &[u8]) -> Result<Vec<Item>, SealError> {
    if file.len() > MAX_FILE_BYTES || file.len() < HEADER_LEN + NONCE_LEN + TAG_LEN {
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
    let plain: Plain = serde_json::from_slice(&plain).map_err(|_| SealError::Content)?;
    if plain.v != VERSION || !items_acceptable(&plain.items) {
        return Err(SealError::Content);
    }
    Ok(plain.items)
}

/// What a file that decrypted must still satisfy: ids, names and art are as the library writes them, within the caps.
fn items_acceptable(items: &[Item]) -> bool {
    let count = |role| items.iter().filter(|item| item.role == role).count();
    count(Role::Signature) <= MAX_PER_ROLE
        && count(Role::Initials) <= MAX_PER_ROLE
        && items.iter().all(|item| {
            is_id(&item.id) && clean_name(&item.name).is_some() && item.art.check().is_ok()
        })
}

fn is_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// The name trimmed, or `None` if it is empty, too long or has control characters.
fn clean_name(name: &str) -> Option<String> {
    let name = name.trim();
    let chars = name.chars().count();
    ((1..=MAX_NAME_CHARS).contains(&chars) && !name.chars().any(char::is_control))
        .then(|| name.to_owned())
}

fn new_id() -> Result<String, LibraryError> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| LibraryError::Key)?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs())
}

/// Reads the library file: at most [`MAX_FILE_BYTES`], a regular file. `Ok(None)` if there is none; a file that is not a regular
/// file or is too large is `InvalidData`.
fn read_file(path: &Path) -> io::Result<Option<Vec<u8>>> {
    let file = match open_without_blocking(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    read_regular(file).map(Some)
}

fn read_regular(file: File) -> io::Result<Vec<u8>> {
    if !file.metadata()?.is_file() {
        return Err(io::Error::from(io::ErrorKind::InvalidData));
    }
    let mut bytes = Vec::new();
    file.take(MAX_FILE_BYTES as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > MAX_FILE_BYTES {
        return Err(io::Error::from(io::ErrorKind::InvalidData));
    }
    Ok(bytes)
}

/// Where the entries are right now.
enum Loaded {
    /// In the file, opened with `key`.
    Stored {
        key: Key,
        items: Vec<Item>,
    },
    /// There is no file and no key yet: an empty library the first save creates.
    Fresh,
    /// No keychain: the session's entries.
    Session,
    Locked,
}

/// The signature library: a file, a keychain, and the entries of the session when the keychain is not there.
pub struct Library {
    path: PathBuf,
    keychain: Keychain,
    /// Entries kept in memory while there is no keychain. Also what serialises every call.
    session: Mutex<Vec<Item>>,
}

impl Library {
    /// A library in `path` (the file) with its key in `keychain`.
    pub fn new(path: PathBuf, keychain: Keychain) -> Self {
        Self {
            path,
            keychain,
            session: Mutex::new(Vec::new()),
        }
    }

    /// The library under the app data directory, with the key in the OS keychain.
    pub fn in_data_dir(data_dir: &Path) -> Self {
        Self::new(
            data_dir.join(DIRECTORY).join(FILE_NAME),
            Keychain::platform(),
        )
    }

    fn lock(&self) -> MutexGuard<'_, Vec<Item>> {
        self.session.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn load(&self) -> Result<Loaded, LibraryError> {
        let key = match self.keychain.existing_key() {
            Ok(key) => key,
            // No keychain, or one that failed this call: the file is not judged and not touched.
            Err(KeyError::Unavailable | KeyError::Unreadable) => return Ok(Loaded::Session),
            // A stored secret that is not a key: the file (if any) cannot be opened with it.
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
            // A key without a file: a library that was emptied, or never written.
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

    /// The status and the entries (metadata and previews only).
    pub fn list(&self) -> Result<Listing, LibraryError> {
        let session = self.lock();
        Ok(match self.load()? {
            Loaded::Stored { items, .. } => listing(Status::Ready, &items),
            Loaded::Fresh => listing(Status::Ready, &[]),
            Loaded::Session => listing(Status::Unavailable, &session),
            Loaded::Locked => listing(Status::Locked, &[]),
        })
    }

    /// Saves a new entry. Without a keychain it lives for the session only. `Locked` if the file does not open; `Full` at
    /// [`MAX_PER_ROLE`] entries of the role.
    pub fn save(&self, role: Role, name: &str, art: Art) -> Result<ItemInfo, LibraryError> {
        let name = clean_name(name).ok_or(LibraryError::Invalid("name"))?;
        art.check()?;
        let item = Item {
            id: new_id()?,
            role,
            name,
            created: now(),
            art,
        };
        let info = ItemInfo::from(&item);
        self.change(false, |items| {
            if items.iter().filter(|other| other.role == role).count() >= MAX_PER_ROLE {
                return Err(LibraryError::Full);
            }
            items.push(item);
            Ok(())
        })?;
        Ok(info)
    }

    /// Renames an entry.
    pub fn rename(&self, id: &str, name: &str) -> Result<(), LibraryError> {
        let name = clean_name(name).ok_or(LibraryError::Invalid("name"))?;
        self.change(true, |items| {
            let item = find_mut(items, id)?;
            item.name = name;
            Ok(())
        })
    }

    /// Removes an entry.
    pub fn delete(&self, id: &str) -> Result<(), LibraryError> {
        self.change(true, |items| {
            let at = items
                .iter()
                .position(|item| item.id == id)
                .ok_or(LibraryError::NotFound)?;
            items.remove(at);
            Ok(())
        })
    }

    /// The entry `id` as a source for the model to place (its full art). Never changes anything.
    pub fn source(&self, id: &str) -> Result<Source, LibraryError> {
        let session = self.lock();
        let found = |items: &[Item]| {
            items
                .iter()
                .find(|item| item.id == id)
                .map(|item| Source {
                    id: item.id.clone(),
                    role: item.role,
                    art: item.art.clone(),
                })
                .ok_or(LibraryError::NotFound)
        };
        match self.load()? {
            Loaded::Stored { items, .. } => found(&items),
            Loaded::Fresh => Err(LibraryError::NotFound),
            Loaded::Session => found(&session),
            Loaded::Locked => Err(LibraryError::Locked),
        }
    }

    /// Deletes the file, the key and the entries of the session: the way out of `Locked`, and "forget all".
    pub fn forget_all(&self) -> Result<(), LibraryError> {
        let mut session = self.lock();
        session.clear();
        // A file that does not open is kept aside, not deleted; one that does is deleted.
        if matches!(self.load(), Ok(Loaded::Locked)) {
            self.quarantine()?;
        }
        match std::fs::remove_file(&self.path) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        match self.keychain.forget() {
            // No keychain: there was no key to delete.
            Ok(()) | Err(KeyError::Unavailable) => Ok(()),
            Err(KeyError::Invalid | KeyError::Unreadable) => Err(LibraryError::Key),
        }
    }

    /// Renames the library file aside (never over an existing file) and keeps the newest [`KEEP_QUARANTINED`] such files.
    fn quarantine(&self) -> Result<(), LibraryError> {
        let (Some(dir), Some(_)) = (self.path.parent(), self.path.file_name()) else {
            return Ok(());
        };
        if !self.path.exists() {
            return Ok(());
        }
        let stamp = now();
        let mut target = None;
        for attempt in 0..100u32 {
            let name = if attempt == 0 {
                format!("{QUARANTINE_PREFIX}{stamp:012}")
            } else {
                format!("{QUARANTINE_PREFIX}{stamp:012}-{attempt}")
            };
            let candidate = dir.join(name);
            if !candidate.exists() {
                target = Some(candidate);
                break;
            }
        }
        let target = target.ok_or_else(|| io::Error::from(io::ErrorKind::AlreadyExists))?;
        std::fs::rename(&self.path, &target)?;
        let mut kept: Vec<PathBuf> = std::fs::read_dir(dir)?
            .flatten()
            .filter(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(QUARANTINE_PREFIX)
            })
            .map(|entry| entry.path())
            .collect();
        kept.sort();
        let excess = kept.len().saturating_sub(KEEP_QUARANTINED);
        for old in kept.into_iter().take(excess) {
            // Best effort: an old copy that cannot be removed now is removed by the next forget.
            let _ = std::fs::remove_file(old);
        }
        Ok(())
    }

    /// Applies `edit` to the entries wherever they are, and stores the result: encrypted into the file, or in the session.
    /// `session_ok` is false for a call that adds something: without a usable keychain it fails with [`LibraryError::Keychain`]
    /// instead of keeping the new entry in memory only (ADR-107).
    fn change(
        &self,
        session_ok: bool,
        edit: impl FnOnce(&mut Vec<Item>) -> Result<(), LibraryError>,
    ) -> Result<(), LibraryError> {
        let mut session = self.lock();
        match self.load()? {
            Loaded::Locked => Err(LibraryError::Locked),
            Loaded::Session if !session_ok => Err(LibraryError::Keychain),
            Loaded::Session => edit(&mut session),
            Loaded::Stored { key, mut items } => {
                edit(&mut items)?;
                self.write(&key, &items)
            }
            Loaded::Fresh => {
                let mut items = Vec::new();
                edit(&mut items)?;
                // The key is created only now that there is something to protect.
                match self.keychain.key_or_create() {
                    Ok(key) => self.write(&key, &items),
                    Err(KeyError::Unavailable | KeyError::Unreadable) if session_ok => {
                        *session = items;
                        Ok(())
                    }
                    Err(KeyError::Unavailable | KeyError::Unreadable) => {
                        Err(LibraryError::Keychain)
                    }
                    Err(KeyError::Invalid) => Err(LibraryError::Key),
                }
            }
        }
    }

    fn write(&self, key: &Key, items: &[Item]) -> Result<(), LibraryError> {
        let bytes = seal(key, items).map_err(|_| LibraryError::Key)?;
        write_atomic(&self.path, &bytes)?;
        Ok(())
    }
}

fn listing(status: Status, items: &[Item]) -> Listing {
    Listing {
        status,
        items: items.iter().map(ItemInfo::from).collect(),
    }
}

fn find_mut<'a>(items: &'a mut [Item], id: &str) -> Result<&'a mut Item, LibraryError> {
    items
        .iter_mut()
        .find(|item| item.id == id)
        .ok_or(LibraryError::NotFound)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::atomic::testutil::TempDir;
    use crate::storage::keychain::testutil::MemoryStore;

    fn art() -> Art {
        Art::Vector {
            w: 3000,
            h: 1000,
            paths: vec![square()],
        }
    }

    fn square() -> Vec<DrawCmd> {
        vec![
            DrawCmd::M(0.0, 0.0),
            DrawCmd::L(10.0, 0.0),
            DrawCmd::C(10.0, 5.0, 10.0, 8.0, 10.0, 10.0),
            DrawCmd::L(0.0, 10.0),
            DrawCmd::Z,
        ]
    }

    fn dense_path(at: f32) -> Vec<DrawCmd> {
        let mut path = vec![DrawCmd::M(at, at)];
        path.extend(std::iter::repeat_n(DrawCmd::L(at, at), 5000));
        path.push(DrawCmd::Z);
        path
    }

    #[test]
    fn an_entry_saved_before_curves_loads_its_polygons_as_line_paths() {
        // The format of 0.8.0: `paths` is a list of polygons, each a list of [x, y].
        let old = r#"{"id":"00000000000000000000000000000001","role":"signature","name":"Old","created":1700000000,
            "art":{"vector":{"w":3000,"h":1000,"paths":[[[0.0,0.0],[10.5,0.0],[10.5,10.0]],[[1.0,1.0],[2.0,1.0],[2.0,2.0]]]}}}"#;
        let item: Item = serde_json::from_str(old).unwrap();
        let Art::Vector { paths, .. } = &item.art else {
            panic!("vector");
        };
        assert_eq!(paths.len(), 2);
        assert_eq!(
            paths[0],
            vec![
                DrawCmd::M(0.0, 0.0),
                DrawCmd::L(10.5, 0.0),
                DrawCmd::L(10.5, 10.0),
                DrawCmd::Z
            ]
        );
        assert!(item.art.check().is_ok());
        // New entries read back as they were written.
        let new = serde_json::to_string(&item).unwrap();
        assert!(new.contains(r#"["M",0.0,0.0]"#));
        assert_eq!(serde_json::from_str::<Item>(&new).unwrap(), item);
    }

    fn key(byte: u8) -> Key {
        Zeroizing::new([byte; 32])
    }

    fn item(n: u32, role: Role) -> Item {
        Item {
            id: format!("{n:032x}"),
            role,
            name: format!("Name {n}"),
            created: 1,
            art: art(),
        }
    }

    fn library(dir: &TempDir, store: &MemoryStore) -> Library {
        Library::new(dir.path().join(DIRECTORY).join(FILE_NAME), store.keychain())
    }

    // --- crypto ---

    #[test]
    fn what_is_sealed_opens_again() {
        let items = vec![item(1, Role::Signature), item(2, Role::Initials)];
        let file = seal(&key(7), &items).unwrap();
        assert_eq!(&file[..5], b"SHLB\x01");
        assert_eq!(open(&key(7), &file).unwrap(), items);
        assert_eq!(open(&key(7), &seal(&key(7), &[]).unwrap()).unwrap(), []);
    }

    #[test]
    fn the_file_holds_no_plaintext_and_every_write_has_a_new_nonce() {
        let items = vec![item(1, Role::Signature)];
        let a = seal(&key(7), &items).unwrap();
        let b = seal(&key(7), &items).unwrap();
        assert_ne!(a[5..29], b[5..29], "nonce");
        assert_ne!(a, b);
        let text = String::from_utf8_lossy(&a);
        assert!(!text.contains("Name 1") && !text.contains("vector"));
    }

    #[test]
    fn a_wrong_key_is_an_error_not_garbage() {
        let file = seal(&key(7), &[item(1, Role::Signature)]).unwrap();
        assert_eq!(open(&key(8), &file).unwrap_err(), SealError::Decrypt);
    }

    #[test]
    fn flipping_any_byte_is_detected() {
        let file = seal(&key(7), &[item(1, Role::Signature)]).unwrap();
        for at in 0..file.len() {
            let mut bad = file.clone();
            bad[at] ^= 0x01;
            assert!(open(&key(7), &bad).is_err(), "byte {at}");
        }
    }

    #[test]
    fn a_header_change_fails_even_with_the_ciphertext_intact() {
        let file = seal(&key(7), &[]).unwrap();
        let mut newer = file.clone();
        newer[4] = 2;
        assert_eq!(open(&key(7), &newer).unwrap_err(), SealError::Version);
        let mut other = file;
        other[0] = b'X';
        assert_eq!(open(&key(7), &other).unwrap_err(), SealError::Format);
    }

    #[test]
    fn truncated_empty_and_oversized_files_are_refused() {
        let file = seal(&key(7), &[item(1, Role::Signature)]).unwrap();
        for cut in [0, 4, 5, 28, 44, file.len() - 1] {
            assert!(open(&key(7), &file[..cut]).is_err(), "{cut}");
        }
        assert_eq!(
            open(&key(7), &vec![0; MAX_FILE_BYTES + 1]).unwrap_err(),
            SealError::Format
        );
    }

    #[test]
    fn a_file_that_decrypts_but_breaks_the_rules_is_refused() {
        // Sealed by this key, so the tag is fine: the content is judged on its own.
        let too_many: Vec<Item> = (0..=MAX_PER_ROLE as u32)
            .map(|n| item(n, Role::Signature))
            .collect();
        let file = seal(&key(7), &too_many).unwrap();
        assert_eq!(open(&key(7), &file).unwrap_err(), SealError::Content);
        let mut bad = item(1, Role::Signature);
        bad.id = "../../etc/passwd".into();
        let file = seal(&key(7), &[bad]).unwrap();
        assert_eq!(open(&key(7), &file).unwrap_err(), SealError::Content);
    }

    // --- the library ---

    #[test]
    fn save_list_rename_delete_and_source() {
        let dir = TempDir::new();
        let store = MemoryStore::default();
        let lib = library(&dir, &store);
        assert_eq!(lib.list().unwrap().status, Status::Ready);
        assert_eq!(store.peek(), None, "no key before the first save");

        let saved = lib.save(Role::Signature, "  Work ", art()).unwrap();
        assert_eq!(saved.name, "Work");
        assert_eq!(saved.kind, "vector");
        assert!((saved.aspect - 3.0).abs() < 1e-6);
        assert_eq!(store.peek().unwrap().len(), 32);
        let listing = lib.list().unwrap();
        assert_eq!(listing.status, Status::Ready);
        assert_eq!(listing.items, vec![saved.clone()]);

        lib.rename(&saved.id, "Home").unwrap();
        assert_eq!(lib.list().unwrap().items[0].name, "Home");
        let source = lib.source(&saved.id).unwrap();
        assert_eq!(source.role, Role::Signature);
        assert_eq!(source.art, art());

        // A second library over the same file and key sees the same entries.
        assert_eq!(library(&dir, &store).list().unwrap().items.len(), 1);

        lib.delete(&saved.id).unwrap();
        assert!(lib.list().unwrap().items.is_empty());
        assert!(matches!(lib.delete(&saved.id), Err(LibraryError::NotFound)));
        assert!(matches!(
            lib.rename("nope", "x"),
            Err(LibraryError::NotFound)
        ));
        assert!(matches!(lib.source(&saved.id), Err(LibraryError::NotFound)));
    }

    #[test]
    fn the_stored_file_is_ciphertext() {
        let dir = TempDir::new();
        let store = MemoryStore::default();
        let lib = library(&dir, &store);
        lib.save(Role::Signature, "Secret name", art()).unwrap();
        let bytes = std::fs::read(dir.path().join(DIRECTORY).join(FILE_NAME)).unwrap();
        assert_eq!(&bytes[..4], b"SHLB");
        assert!(!String::from_utf8_lossy(&bytes).contains("Secret name"));
    }

    #[test]
    fn at_most_eight_per_role_and_the_roles_count_apart() {
        let dir = TempDir::new();
        let store = MemoryStore::default();
        let lib = library(&dir, &store);
        for n in 0..MAX_PER_ROLE {
            lib.save(Role::Signature, &format!("s{n}"), art()).unwrap();
        }
        assert!(matches!(
            lib.save(Role::Signature, "one more", art()),
            Err(LibraryError::Full)
        ));
        for n in 0..MAX_PER_ROLE {
            lib.save(Role::Initials, &format!("i{n}"), art()).unwrap();
        }
        assert!(matches!(
            lib.save(Role::Initials, "one more", art()),
            Err(LibraryError::Full)
        ));
        assert_eq!(lib.list().unwrap().items.len(), 16);
        // Deleting makes room again.
        let first = lib.list().unwrap().items[0].id.clone();
        lib.delete(&first).unwrap();
        lib.save(Role::Signature, "again", art()).unwrap();
    }

    #[test]
    fn entry_sizes_names_and_art_are_bounded() {
        let dir = TempDir::new();
        let lib = library(&dir, &MemoryStore::default());
        let big = Art::Raster {
            w: 10,
            h: 10,
            png: "A".repeat(MAX_ART_BYTES),
        };
        assert!(matches!(
            lib.save(Role::Signature, "x", big),
            Err(LibraryError::TooLarge)
        ));
        let bad_arts = [
            Art::Vector {
                w: 0,
                h: 10,
                paths: vec![square()],
            },
            Art::Vector {
                w: 10,
                h: 10,
                paths: vec![],
            },
            Art::Vector {
                w: 10,
                h: 10,
                paths: vec![vec![DrawCmd::L(0.0, 0.0), DrawCmd::L(1.0, 1.0)]],
            },
            Art::Vector {
                w: 10,
                h: 10,
                paths: vec![vec![
                    DrawCmd::M(f32::NAN, 0.0),
                    DrawCmd::L(1.0, 1.0),
                    DrawCmd::Z,
                ]],
            },
            Art::Raster {
                w: 10,
                h: 10,
                png: "not base64!".into(),
            },
            Art::Raster {
                w: 10,
                h: 10,
                png: String::new(),
            },
        ];
        for bad in bad_arts {
            assert!(matches!(
                lib.save(Role::Signature, "x", bad),
                Err(LibraryError::Invalid("art"))
            ));
        }
        for name in ["", "   ", "a\nb", &"x".repeat(MAX_NAME_CHARS + 1)] {
            assert!(matches!(
                lib.save(Role::Signature, name, art()),
                Err(LibraryError::Invalid("name"))
            ));
        }
        lib.save(Role::Signature, &"x".repeat(MAX_NAME_CHARS), art())
            .unwrap();
        let raster = Art::Raster {
            w: 300,
            h: 100,
            png: "iVBORw0KGgo=".into(),
        };
        let saved = lib.save(Role::Initials, "r", raster).unwrap();
        assert_eq!(saved.kind, "raster");
        // Not a decodable PNG: no thumbnail, and the entry still saves.
        assert!(saved.preview.is_none());
    }

    fn picture(w: u32, h: u32) -> Art {
        let mut image = image::RgbaImage::new(w, h);
        for (x, y, pixel) in image.enumerate_pixels_mut() {
            *pixel = image::Rgba([(x % 251) as u8, (y % 241) as u8, ((x * y) % 239) as u8, 255]);
        }
        let png = crate::signatures::raster::encode_png(&image).unwrap();
        Art::Raster {
            w,
            h,
            png: crate::signatures::convert::encode_base64(&png),
        }
    }

    #[test]
    fn raster_art_gets_a_small_re_encoded_thumbnail_in_the_list() {
        let dir = TempDir::new();
        let lib = library(&dir, &MemoryStore::default());
        let saved = lib
            .save(Role::Signature, "photo", picture(600, 200))
            .unwrap();
        let Some(Art::Raster { w, h, png }) = saved.preview.clone() else {
            panic!("raster preview");
        };
        assert_eq!((w, h), (PREVIEW_PX, 32));
        let bytes = crate::signatures::convert::decode_base64(&png).unwrap();
        assert!(bytes.len() <= PREVIEW_PNG_BYTES);
        assert!(bytes.starts_with(b"\x89PNG"));
        // The same through the list, and the full art still places.
        assert_eq!(lib.list().unwrap().items[0].preview, saved.preview);
        let Art::Raster { w, .. } = lib.source(&saved.id).unwrap().art else {
            panic!("raster");
        };
        assert_eq!(w, 600);
        // Art smaller than the box is not enlarged.
        let tiny = lib.save(Role::Signature, "tiny", picture(40, 20)).unwrap();
        assert!(matches!(
            tiny.preview,
            Some(Art::Raster { w: 40, h: 20, .. })
        ));
    }

    #[test]
    fn a_noisy_picture_is_shrunk_until_its_thumbnail_fits() {
        // Noise does not compress: 96 px of it is over the byte bound, so the thumbnail steps down or is left out; it never exceeds it.
        let mut image = image::RgbaImage::new(400, 400);
        let mut state = 0x1234_5678_u32;
        for pixel in image.pixels_mut() {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            *pixel = image::Rgba(state.to_le_bytes());
        }
        let png = crate::signatures::raster::encode_png(&image).unwrap();
        let art = Art::Raster {
            w: 400,
            h: 400,
            png: crate::signatures::convert::encode_base64(&png),
        };
        if let Some(Art::Raster { png, .. }) = art.preview() {
            let bytes = crate::signatures::convert::decode_base64(&png).unwrap();
            assert!(bytes.len() <= PREVIEW_PNG_BYTES);
        }
    }

    #[test]
    fn art_is_measured_without_a_copy_and_the_limit_is_exact() {
        let fits = Art::Raster {
            w: 10,
            h: 10,
            png: "A".repeat(MAX_ART_BYTES - 100),
        };
        assert!(fits.check().is_ok());
        let over = Art::Raster {
            w: 10,
            h: 10,
            png: "A".repeat(MAX_ART_BYTES),
        };
        assert!(matches!(over.check(), Err(LibraryError::TooLarge)));
    }

    #[test]
    fn the_list_carries_a_small_preview_never_the_whole_art() {
        let dir = TempDir::new();
        let lib = library(&dir, &MemoryStore::default());
        let dense = Art::Vector {
            w: 10,
            h: 10,
            paths: vec![dense_path(1.0), dense_path(2.0)],
        };
        let saved = lib.save(Role::Signature, "dense", dense).unwrap();
        let Some(Art::Vector { paths, .. }) = saved.preview else {
            panic!("vector preview");
        };
        let commands: usize = paths.iter().map(Vec::len).sum();
        assert!(commands <= PREVIEW_COMMANDS + 16, "{commands}");
        assert!(paths
            .iter()
            .all(|path| matches!(path.first(), Some(DrawCmd::M(..)))));
        // The full art is still what places.
        let Art::Vector { paths, .. } = lib.source(&saved.id).unwrap().art else {
            panic!("vector");
        };
        assert_eq!(paths[0].len(), 5002);
    }

    #[test]
    fn a_missing_keychain_says_so_on_save_and_writes_nothing() {
        let dir = TempDir::new();
        let lib = Library::new(
            dir.path().join(DIRECTORY).join(FILE_NAME),
            Keychain::unavailable(),
        );
        assert_eq!(lib.list().unwrap().status, Status::Unavailable);
        // Not kept in memory only and lost at exit: the caller is told.
        assert!(matches!(
            lib.save(Role::Signature, "tmp", art()),
            Err(LibraryError::Keychain)
        ));
        assert!(lib.list().unwrap().items.is_empty());
        assert!(!dir.path().join(DIRECTORY).exists(), "nothing on disk");
        assert_eq!(
            AppError::from(LibraryError::Keychain).code(),
            ErrorCode::KeychainUnavailable
        );
        lib.forget_all().unwrap();
    }

    #[test]
    fn a_missing_keychain_never_touches_an_existing_file() {
        let dir = TempDir::new();
        let store = MemoryStore::default();
        library(&dir, &store)
            .save(Role::Signature, "kept", art())
            .unwrap();
        let path = dir.path().join(DIRECTORY).join(FILE_NAME);
        let before = std::fs::read(&path).unwrap();
        let lib = Library::new(path.clone(), Keychain::unavailable());
        assert!(matches!(
            lib.save(Role::Signature, "session", art()),
            Err(LibraryError::Keychain)
        ));
        assert_eq!(std::fs::read(&path).unwrap(), before);
    }

    #[test]
    fn a_lost_or_wrong_key_locks_the_library_and_nothing_is_overwritten() {
        let dir = TempDir::new();
        let store = MemoryStore::default();
        let lib = library(&dir, &store);
        let saved = lib.save(Role::Signature, "a", art()).unwrap();
        let path = dir.path().join(DIRECTORY).join(FILE_NAME);
        let before = std::fs::read(&path).unwrap();

        for replace in [None, Some(vec![9u8; 32]), Some(vec![9u8; 5])] {
            let original = store.peek();
            store.put(replace.clone());
            assert_eq!(lib.list().unwrap().status, Status::Locked);
            assert!(lib.list().unwrap().items.is_empty());
            assert!(matches!(
                lib.save(Role::Signature, "b", art()),
                Err(LibraryError::Locked)
            ));
            assert!(matches!(lib.delete(&saved.id), Err(LibraryError::Locked)));
            assert!(matches!(
                lib.rename(&saved.id, "z"),
                Err(LibraryError::Locked)
            ));
            assert!(matches!(lib.source(&saved.id), Err(LibraryError::Locked)));
            assert_eq!(std::fs::read(&path).unwrap(), before);
            assert_eq!(store.peek(), replace, "the key is not replaced either");
            store.put(original);
        }
        assert_eq!(lib.list().unwrap().status, Status::Ready);
    }

    #[test]
    fn a_tampered_or_garbage_file_locks_the_library() {
        let dir = TempDir::new();
        let store = MemoryStore::default();
        let lib = library(&dir, &store);
        lib.save(Role::Signature, "a", art()).unwrap();
        let path = dir.path().join(DIRECTORY).join(FILE_NAME);
        let mut bytes = std::fs::read(&path).unwrap();
        let last = bytes.len() - 1;
        bytes[last] ^= 0xff;
        std::fs::write(&path, &bytes).unwrap();
        assert_eq!(lib.list().unwrap().status, Status::Locked);
        std::fs::write(&path, b"{\"v\":1,\"items\":[]}").unwrap();
        assert_eq!(
            lib.list().unwrap().status,
            Status::Locked,
            "plaintext is not read"
        );
        std::fs::remove_file(&path).unwrap();
        std::fs::create_dir(&path).unwrap();
        assert_eq!(lib.list().unwrap().status, Status::Locked);
    }

    #[test]
    fn a_keychain_read_error_neither_locks_nor_touches_the_file() {
        use crate::storage::keychain::{SecretStore, StoreError};
        struct Failing;
        impl SecretStore for Failing {
            fn get(&self) -> Result<Option<Zeroizing<Vec<u8>>>, StoreError> {
                Err(StoreError::Failed)
            }
            fn set(&self, _: &[u8]) -> Result<(), StoreError> {
                Err(StoreError::Failed)
            }
            fn delete(&self) -> Result<(), StoreError> {
                Err(StoreError::Failed)
            }
        }
        let dir = TempDir::new();
        let store = MemoryStore::default();
        library(&dir, &store)
            .save(Role::Signature, "kept", art())
            .unwrap();
        let path = dir.path().join(DIRECTORY).join(FILE_NAME);
        let before = std::fs::read(&path).unwrap();
        let lib = Library::new(path.clone(), Keychain::new(Box::new(Failing)));
        assert_eq!(lib.list().unwrap().status, Status::Unavailable);
        assert!(matches!(
            lib.save(Role::Signature, "session", art()),
            Err(LibraryError::Keychain)
        ));
        assert_eq!(std::fs::read(&path).unwrap(), before);
        // A corrupt key, on the other hand, locks.
        store.put(Some(vec![1, 2, 3]));
        assert_eq!(library(&dir, &store).list().unwrap().status, Status::Locked);
    }

    #[test]
    fn a_tampered_file_is_quarantined_by_forget_all_never_overwritten_or_dropped_silently() {
        let dir = TempDir::new();
        let store = MemoryStore::default();
        let lib = library(&dir, &store);
        lib.save(Role::Signature, "a", art()).unwrap();
        let path = dir.path().join(DIRECTORY).join(FILE_NAME);
        let mut bytes = std::fs::read(&path).unwrap();
        let last = bytes.len() - 1;
        bytes[last] ^= 0xff;
        std::fs::write(&path, &bytes).unwrap();
        // Locked: every write is refused and the bytes stay as they are.
        assert!(matches!(
            lib.save(Role::Signature, "b", art()),
            Err(LibraryError::Locked)
        ));
        assert_eq!(std::fs::read(&path).unwrap(), bytes);

        lib.forget_all().unwrap();
        assert!(!path.exists());
        let aside: Vec<PathBuf> = std::fs::read_dir(path.parent().unwrap())
            .unwrap()
            .map(|e| e.unwrap().path())
            .collect();
        assert_eq!(aside.len(), 1, "{aside:?}");
        assert!(aside[0]
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with(QUARANTINE_PREFIX));
        assert_eq!(std::fs::read(&aside[0]).unwrap(), bytes);
        assert_eq!(store.peek(), None, "the key goes");
        // The library works again, and a second tamper does not overwrite the first copy.
        lib.save(Role::Signature, "new", art()).unwrap();
        let mut again = std::fs::read(&path).unwrap();
        again[10] ^= 0xff;
        std::fs::write(&path, &again).unwrap();
        lib.forget_all().unwrap();
        let count = || std::fs::read_dir(path.parent().unwrap()).unwrap().count();
        assert_eq!(count(), 2);
        // Only the newest ones are kept.
        for _ in 0..3 {
            lib.save(Role::Signature, "x", art()).unwrap();
            std::fs::write(&path, b"junk").unwrap();
            lib.forget_all().unwrap();
        }
        assert_eq!(count(), KEEP_QUARANTINED);
        // A healthy library is deleted, not quarantined.
        lib.save(Role::Signature, "ok", art()).unwrap();
        lib.forget_all().unwrap();
        assert_eq!(count(), KEEP_QUARANTINED);
    }

    #[test]
    fn forget_all_deletes_file_and_key_and_ends_the_lock() {
        let dir = TempDir::new();
        let store = MemoryStore::default();
        let lib = library(&dir, &store);
        lib.save(Role::Signature, "a", art()).unwrap();
        store.put(Some(vec![1; 32]));
        assert_eq!(lib.list().unwrap().status, Status::Locked);

        lib.forget_all().unwrap();
        assert!(!dir.path().join(DIRECTORY).join(FILE_NAME).exists());
        assert_eq!(store.peek(), None);
        assert_eq!(lib.list().unwrap().status, Status::Ready);
        // A new key on the next save.
        lib.save(Role::Signature, "new", art()).unwrap();
        assert_eq!(lib.list().unwrap().items.len(), 1);
        lib.forget_all().unwrap();
        lib.forget_all().unwrap();
    }

    /// A restart: every in-memory object is dropped, a new keychain and library are built over the same file and the same store.
    #[test]
    fn a_saved_signature_is_listed_after_a_simulated_restart() {
        let dir = TempDir::new();
        let store = MemoryStore::default();
        let saved = library(&dir, &store)
            .save(Role::Signature, "Kept", art())
            .unwrap();
        let again = library(&dir, &store).list().unwrap();
        assert_eq!(again.status, Status::Ready);
        assert_eq!(again.items, vec![saved.clone()]);
        assert_eq!(library(&dir, &store).source(&saved.id).unwrap().art, art());
    }

    /// The same with the real OS store (and `DeadlineStore`). Run explicitly: `cargo test real_keychain -- --ignored`.
    #[test]
    #[ignore = "touches the real OS credential store; run explicitly (CI does)"]
    fn real_keychain_library_survives_a_restart() {
        let dir = TempDir::new();
        let mut tag = [0u8; 8];
        getrandom::fill(&mut tag).unwrap();
        let tag: String = tag.iter().map(|b| format!("{b:02x}")).collect();
        let service = format!("app.sheer.desktop.test-lib-{tag}");
        let path = dir.path().join(DIRECTORY).join(FILE_NAME);
        // Removes the credential when the test ends, also on a panic.
        let _cleanup =
            crate::storage::keychain::testutil::Cleanup(Keychain::platform_for_service(&service));
        let first = Library::new(path.clone(), Keychain::platform_for_service(&service));
        let saved = first.save(Role::Signature, "Kept", art());
        drop(first);
        let second = Library::new(path.clone(), Keychain::platform_for_service(&service));
        let listing = second.list();
        let cleaned = second.forget_all();
        let saved = saved.unwrap();
        let listing = listing.unwrap();
        assert_eq!(listing.status, Status::Ready);
        assert_eq!(listing.items, vec![saved]);
        cleaned.unwrap();
    }

    #[test]
    fn writes_are_atomic_and_leave_no_temp_file() {
        let dir = TempDir::new();
        let lib = library(&dir, &MemoryStore::default());
        for n in 0..4 {
            lib.save(Role::Signature, &format!("s{n}"), art()).unwrap();
        }
        let names: Vec<String> = std::fs::read_dir(dir.path().join(DIRECTORY))
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, [FILE_NAME]);
    }

    #[cfg(unix)]
    #[test]
    fn the_file_and_its_directory_are_private() {
        use std::os::unix::fs::PermissionsExt;
        let dir = TempDir::new();
        let lib = library(&dir, &MemoryStore::default());
        lib.save(Role::Signature, "a", art()).unwrap();
        let mode = |p: PathBuf| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(dir.path().join(DIRECTORY).join(FILE_NAME)), 0o600);
        assert_eq!(mode(dir.path().join(DIRECTORY)), 0o700);
    }

    #[test]
    fn errors_map_to_the_fixed_vocabulary_without_content() {
        let code = |error: LibraryError| AppError::from(error).code();
        assert_eq!(code(LibraryError::Locked), ErrorCode::InvalidArgument);
        assert_eq!(code(LibraryError::Full), ErrorCode::LimitExceeded);
        assert_eq!(code(LibraryError::NotFound), ErrorCode::NotFound);
        assert_eq!(code(LibraryError::TooLarge), ErrorCode::TooLarge);
        assert_eq!(code(LibraryError::Key), ErrorCode::Internal);
    }
}
