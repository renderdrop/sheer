// owned by package B2
//! Crash-safe autosave (ADR-053 section 2, ARCHITECTURE section 11.2).
//!
//! A dirty document is written as snapshot bytes (`export::snapshot`, a Full, plain PDF) into the session directory
//! `<app data>/autosave/<session>/`, as `<doc>.pdf` plus a small manifest `<doc>.json`:
//! `{ v: 1, original: { path, len, mtime } | null, displayName, pageCount, savedAt, appVersion }`. Nothing else: no password, no
//! history, no UI state. The original path stays in the manifest on disk; every answer to the UI names a record by a session-scoped id.
//!
//! The session holds an exclusive lock on `<session>/lock` for its lifetime, so at startup a session whose lock can be taken is dead
//! (it crashed). Its records are listed for recovery, swept when older than `limits::AUTOSAVE_RETENTION`, and quarantined when
//! corrupt; nothing here ever fails startup. Every file is written atomically and privately (`storage::atomic`: 0600/0700 on Unix,
//! the profile's ACL on Windows). This module knows nothing of `AppState`: `commands::recovery` feeds it the bytes.

use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use super::atomic::write_atomic;
use crate::documents::{sanitize_text, DocumentId};
use crate::error::{AppError, ErrorCode};
use crate::limits;

/// The autosave store inside the app data directory.
pub const DIR_NAME: &str = "autosave";
const LOCK_NAME: &str = "lock";
const QUARANTINE_DIR: &str = "quarantine";
/// A manifest is a few hundred bytes; anything bigger is not ours.
const MANIFEST_MAX: u64 = 64 * 1024;
const MANIFEST_VERSION: u32 = 1;
/// A session directory without a lock file is dead only when it is older than this (a session that is starting has not made it yet).
const NO_LOCK_GRACE: Duration = Duration::from_secs(60);

/// Whether a document is covered by autosave right now (`DocumentInfo.autosave`, shown in the status bar).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AutosaveStatus {
    /// Dirty and written on schedule.
    On,
    /// Never written: the file is encrypted, or a protection change is pending (a snapshot would be unencrypted).
    OffEncrypted,
    /// Skipped: the snapshot would exceed `limits::AUTOSAVE_DOC_MAX`.
    OffTooLarge,
    /// Nothing to protect: no unsaved changes.
    Clean,
}

/// Whether the file a recovered document was opened from still is what it was.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum OriginalState {
    Unchanged,
    Changed,
    Missing,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OriginalRef {
    path: PathBuf,
    len: u64,
    mtime: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    v: u32,
    original: Option<OriginalRef>,
    display_name: String,
    page_count: u32,
    /// Seconds since the Unix epoch.
    saved_at: u64,
    app_version: String,
}

/// A record of a dead session.
#[derive(Debug, Clone)]
struct Dead {
    id: u32,
    dir: PathBuf,
    n: u32,
    manifest: Manifest,
    bytes: u64,
}

/// What the UI may know of a record (no path).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecoveryView {
    pub id: u32,
    pub display_name: String,
    pub saved_at: u64,
    pub page_count: u32,
    pub original: OriginalState,
}

/// A record copied into this session and ready to open (`Autosave::stage_restore`).
#[derive(Debug, Clone)]
pub struct Staged {
    pub id: u32,
    pub path: PathBuf,
    pub display_name: String,
    original: Option<PathBuf>,
}

/// The state of a document for [`Autosave::write`].
pub struct Snapshot<'a> {
    pub id: DocumentId,
    pub rev: u64,
    pub bytes: &'a [u8],
    pub display_name: &'a str,
    pub original: Option<&'a Path>,
    pub page_count: u32,
}

/// How a write went.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Written {
    Done,
    /// Over `limits::AUTOSAVE_DOC_MAX`: nothing was written and the status is `OffTooLarge`.
    TooLarge,
}

#[derive(Debug)]
struct Track {
    rev: u64,
    written_rev: Option<u64>,
    dirty_since: Option<Instant>,
    last_change: Instant,
}

#[derive(Debug)]
struct Restored {
    rec_id: u32,
    copy: PathBuf,
    original: Option<PathBuf>,
}

#[derive(Debug, Default)]
struct Inner {
    tracks: HashMap<DocumentId, Track>,
    status: HashMap<DocumentId, AutosaveStatus>,
    too_large: HashSet<DocumentId>,
    dead: Vec<Dead>,
    restored: HashMap<DocumentId, Restored>,
}

/// The autosave of one app session.
#[derive(Debug)]
pub struct Autosave {
    root: PathBuf,
    dir: PathBuf,
    /// Held for the life of the session: its lock marks the session as alive.
    lock: File,
    inner: Mutex<Inner>,
    saves: AtomicU32,
    running: AtomicBool,
    /// An upper bound of the bytes in the store: every write adds what it changes, deletions are not subtracted. Only when it
    /// would put the store over its cap is the real size measured (a walk of the directory) and this value reset to it.
    store_estimate: AtomicU64,
}

/// While alive, no autosave write starts (a save is running).
#[derive(Debug)]
pub struct SaveGuard(Arc<Autosave>);

impl Drop for SaveGuard {
    fn drop(&mut self) {
        self.0.saves.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Held by whoever runs a round of writes; one round at a time.
#[derive(Debug)]
pub struct RunGuard(Arc<Autosave>);

impl Drop for RunGuard {
    fn drop(&mut self) {
        self.0.running.store(false, Ordering::SeqCst);
    }
}

fn seconds(time: SystemTime) -> u64 {
    time.duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

fn mtime_of(metadata: &fs::Metadata) -> Option<u64> {
    metadata.modified().ok().map(seconds)
}

fn create_private_dir(path: &Path) -> io::Result<()> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path)
}

fn remove_record_files(dir: &Path, n: u32) {
    // Best effort: the manifest goes first, so a half-deleted record is an orphan pdf, never a manifest without its file.
    let _ = fs::remove_file(dir.join(format!("{n}.json")));
    let _ = fs::remove_file(dir.join(format!("{n}.pdf")));
}

/// Moves the files of a record that cannot be used into the quarantine folder (deleted when that fails). Never an error.
fn quarantine(root: &Path, dir: &Path, n: u32) {
    let session = dir.file_name().map_or_else(
        || "session".to_owned(),
        |name| name.to_string_lossy().into_owned(),
    );
    let target = root.join(QUARANTINE_DIR);
    let moved = create_private_dir(&target).is_ok()
        && ["json", "pdf"].iter().all(|extension| {
            let from = dir.join(format!("{n}.{extension}"));
            !from.exists()
                || fs::rename(&from, target.join(format!("{session}-{n}.{extension}.bad"))).is_ok()
        });
    if !moved {
        remove_record_files(dir, n);
    }
}

/// Reads `<n>.json` from `dir`; `None` when it is not a valid manifest (too big, not JSON, an unknown shape or version).
fn read_manifest(dir: &Path, n: u32) -> Option<Manifest> {
    use std::io::Read;
    let file = File::open(dir.join(format!("{n}.json"))).ok()?;
    let metadata = file.metadata().ok()?;
    if !metadata.is_file() || metadata.len() > MANIFEST_MAX {
        return None;
    }
    let mut text = Vec::new();
    file.take(MANIFEST_MAX).read_to_end(&mut text).ok()?;
    let manifest: Manifest = serde_json::from_slice(&text).ok()?;
    (manifest.v == MANIFEST_VERSION).then_some(manifest)
}

/// The size of `<n>.pdf` in `dir` when it is a regular, non-empty file within the cap.
fn pdf_len(dir: &Path, n: u32) -> Option<u64> {
    let metadata = fs::symlink_metadata(dir.join(format!("{n}.pdf"))).ok()?;
    (metadata.is_file() && metadata.len() > 0 && metadata.len() <= limits::AUTOSAVE_DOC_MAX)
        .then_some(metadata.len())
}

/// The size of a regular file, 0 when there is none.
fn file_len(path: &Path) -> u64 {
    fs::symlink_metadata(path)
        .ok()
        .filter(|metadata| metadata.is_file())
        .map_or(0, |metadata| metadata.len())
}

fn store_bytes(root: &Path) -> u64 {
    fn walk(directory: &Path, depth: u32) -> u64 {
        let Ok(entries) = fs::read_dir(directory) else {
            return 0;
        };
        entries
            .flatten()
            .map(|entry| match fs::symlink_metadata(entry.path()) {
                Ok(metadata) if metadata.is_file() => metadata.len(),
                Ok(metadata) if metadata.is_dir() && depth < 2 => walk(&entry.path(), depth + 1),
                _ => 0,
            })
            .sum()
    }
    walk(root, 0)
}

/// The numbers `<n>` of the manifests in `dir`.
fn record_numbers(dir: &Path) -> Vec<u32> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut numbers: Vec<u32> = entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name();
            let stem = name.to_str()?.strip_suffix(".json")?;
            stem.parse().ok()
        })
        .collect();
    numbers.sort_unstable();
    numbers
}

/// Whether the session directory `dir` is dead; holds the lock of the dead session until the returned file is dropped.
fn take_dead_lock(dir: &Path, now: SystemTime) -> Option<Option<File>> {
    match OpenOptions::new().write(true).open(dir.join(LOCK_NAME)) {
        Ok(file) => file.try_lock().is_ok().then_some(Some(file)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            let age = fs::metadata(dir)
                .ok()
                .and_then(|metadata| metadata.modified().ok())
                .and_then(|modified| now.duration_since(modified).ok())?;
            (age >= NO_LOCK_GRACE).then_some(None)
        }
        Err(_) => None,
    }
}

/// Dead sessions: their usable records (newest first, ids not yet set), after the sweep of what is old or corrupt.
fn scan(root: &Path, own: &Path, now: SystemTime) -> Vec<Dead> {
    let mut found = Vec::new();
    let Ok(entries) = fs::read_dir(root) else {
        return found;
    };
    let retention = limits::AUTOSAVE_RETENTION;
    let too_old = |saved_at: u64| seconds(now).saturating_sub(saved_at) > retention.as_secs();
    for entry in entries.flatten() {
        let dir = entry.path();
        let is_dir = fs::symlink_metadata(&dir).is_ok_and(|metadata| metadata.is_dir());
        if !is_dir || dir == own || entry.file_name() == QUARANTINE_DIR {
            continue;
        }
        let Some(lock) = take_dead_lock(&dir, now) else {
            continue;
        };
        // A crash in the middle of a snapshot write leaves its hidden temp file here (SECURITY D1).
        super::atomic::sweep_stale_temp_files(&dir);
        let mut kept = 0;
        for n in record_numbers(&dir) {
            match (read_manifest(&dir, n), pdf_len(&dir, n)) {
                (Some(manifest), Some(bytes)) => {
                    if too_old(manifest.saved_at) {
                        remove_record_files(&dir, n);
                    } else {
                        kept += 1;
                        found.push(Dead {
                            id: 0,
                            dir: dir.clone(),
                            n,
                            manifest,
                            bytes,
                        });
                    }
                }
                _ => quarantine(root, &dir, n),
            }
        }
        // Nothing left to recover: the session directory (its orphans and its lock) goes. The lock is released first, Windows
        // does not delete an open file.
        drop(lock);
        if kept == 0 {
            let _ = fs::remove_dir_all(&dir);
        }
    }
    sweep_quarantine(root, now);
    found.sort_by_key(|record| std::cmp::Reverse(record.manifest.saved_at));
    found
}

/// Quarantined files older than the retention are deleted.
fn sweep_quarantine(root: &Path, now: SystemTime) {
    let Ok(entries) = fs::read_dir(root.join(QUARANTINE_DIR)) else {
        return;
    };
    for entry in entries.flatten() {
        let old = fs::symlink_metadata(entry.path())
            .ok()
            .filter(fs::Metadata::is_file)
            .and_then(|metadata| metadata.modified().ok())
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age > limits::AUTOSAVE_RETENTION);
        if old {
            let _ = fs::remove_file(entry.path());
        }
    }
}

fn original_state(original: Option<&OriginalRef>) -> OriginalState {
    let Some(original) = original else {
        return OriginalState::Missing;
    };
    match fs::metadata(&original.path) {
        Err(_) => OriginalState::Missing,
        Ok(metadata) if metadata.len() == original.len && mtime_of(&metadata) == original.mtime => {
            OriginalState::Unchanged
        }
        Ok(_) => OriginalState::Changed,
    }
}

fn hex_id() -> Result<String, AppError> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes)
        .map_err(|error| AppError::logged(ErrorCode::Internal, format!("autosave id: {error}")))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

impl Autosave {
    /// Creates this session's directory (private) under `<app_data>/autosave`, takes its lock and finds the records of dead sessions
    /// (sweeping the old and quarantining the corrupt ones).
    pub fn start(app_data: &Path) -> Result<Self, AppError> {
        Self::start_at(app_data, SystemTime::now())
    }

    fn start_at(app_data: &Path, now: SystemTime) -> Result<Self, AppError> {
        let root = app_data.join(DIR_NAME);
        let dir = root.join(hex_id()?);
        create_private_dir(&dir)?;
        let lock = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(dir.join(LOCK_NAME))?;
        lock.try_lock().map_err(|error| {
            AppError::logged(ErrorCode::Internal, format!("autosave lock: {error}"))
        })?;
        let mut dead = scan(&root, &dir, now);
        for (index, record) in (1u32..).zip(dead.iter_mut()) {
            record.id = index;
        }
        let autosave = Self {
            root,
            dir,
            lock,
            inner: Mutex::new(Inner {
                dead,
                ..Inner::default()
            }),
            saves: AtomicU32::new(0),
            running: AtomicBool::new(false),
            store_estimate: AtomicU64::new(0),
        };
        autosave.enforce_store_cap(0);
        autosave
            .store_estimate
            .store(store_bytes(&autosave.root), Ordering::Relaxed);
        Ok(autosave)
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// This session's directory (its records, and the copies of restored documents).
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Releases the session lock and removes the session directory: the normal quit. What is still in it is gone.
    pub fn shutdown(&self) {
        let _ = self.lock.unlock();
        let _ = fs::remove_dir_all(&self.dir);
    }

    // --- cadence ---

    /// Notes that document `id` is at revision `rev` and has unsaved changes (the timer calls it for every dirty document; a changed
    /// revision restarts the debounce).
    pub fn observe(&self, id: DocumentId, rev: u64, now: Instant) {
        let mut inner = self.lock();
        match inner.tracks.get_mut(&id) {
            None => {
                inner.tracks.insert(
                    id,
                    Track {
                        rev,
                        written_rev: None,
                        dirty_since: Some(now),
                        last_change: now,
                    },
                );
            }
            Some(track) if track.rev != rev => {
                track.rev = rev;
                track.last_change = now;
                track.dirty_since.get_or_insert(now);
            }
            Some(_) => {}
        }
    }

    /// The documents whose last change is `AUTOSAVE_DEBOUNCE` ago or whose first unsaved change is `AUTOSAVE_MAX_INTERVAL` ago.
    pub fn due(&self, now: Instant) -> Vec<DocumentId> {
        self.unwritten(|track| {
            let quiet =
                now.saturating_duration_since(track.last_change) >= limits::AUTOSAVE_DEBOUNCE;
            let long = track.dirty_since.is_some_and(|since| {
                now.saturating_duration_since(since) >= limits::AUTOSAVE_MAX_INTERVAL
            });
            quiet || long
        })
    }

    /// Every document with changes that are not written yet (the window lost focus).
    pub fn unwritten_all(&self) -> Vec<DocumentId> {
        self.unwritten(|_| true)
    }

    fn unwritten(&self, pick: impl Fn(&Track) -> bool) -> Vec<DocumentId> {
        let inner = self.lock();
        let mut ids: Vec<(u32, DocumentId)> = inner
            .tracks
            .iter()
            .filter(|(_, track)| track.written_rev != Some(track.rev) && pick(track))
            .map(|(&id, _)| (id.get(), id))
            .collect();
        ids.sort_unstable_by_key(|&(number, _)| number);
        ids.into_iter().map(|(_, id)| id).collect()
    }

    /// A write for `id` at `rev` failed: it is not tried again before the next change (the failure was logged by the caller).
    pub fn note_failed(&self, id: DocumentId, rev: u64) {
        if let Some(track) = self.lock().tracks.get_mut(&id) {
            track.written_rev = Some(rev);
            track.dirty_since = None;
        }
    }

    /// The revision of `id` as last observed.
    pub fn observed_rev(&self, id: DocumentId) -> Option<u64> {
        self.lock().tracks.get(&id).map(|track| track.rev)
    }

    /// Takes the right to write a round; `None` while another round or a save runs.
    pub fn begin_run(self: &Arc<Self>) -> Option<RunGuard> {
        if self.saves.load(Ordering::SeqCst) > 0 {
            return None;
        }
        self.running
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .ok()
            .map(|_| RunGuard(Arc::clone(self)))
    }

    /// Marks a save as running until the guard is dropped: no autosave write starts meanwhile.
    pub fn begin_save(self: &Arc<Self>) -> SaveGuard {
        self.saves.fetch_add(1, Ordering::SeqCst);
        SaveGuard(Arc::clone(self))
    }

    /// Whether `id` is tracked or has a record: a document that came back to its saved state loses it.
    pub fn settle_clean(&self, id: DocumentId) {
        let known = {
            let inner = self.lock();
            inner.tracks.contains_key(&id)
                || inner.status.contains_key(&id)
                || inner.too_large.contains(&id)
        };
        if known {
            self.clear_own(id);
        }
    }

    /// Whether a save is running (no write starts then).
    pub fn saving(&self) -> bool {
        self.saves.load(Ordering::SeqCst) > 0
    }

    // --- status ---

    pub fn set_status(&self, id: DocumentId, status: AutosaveStatus) {
        let mut inner = self.lock();
        if status == AutosaveStatus::Clean {
            inner.status.remove(&id);
        } else {
            inner.status.insert(id, status);
        }
    }

    /// What `DocumentInfo.autosave` says about `id`.
    pub fn status_of(&self, id: DocumentId) -> AutosaveStatus {
        let inner = self.lock();
        if inner.too_large.contains(&id) {
            return AutosaveStatus::OffTooLarge;
        }
        inner
            .status
            .get(&id)
            .copied()
            .unwrap_or(AutosaveStatus::Clean)
    }

    /// The snapshot of `id` is over the cap: it is not written, and says so.
    pub fn mark_too_large(&self, id: DocumentId, rev: u64) {
        self.lock().too_large.insert(id);
        self.note_failed(id, rev);
    }

    // --- records of this session ---

    fn own_paths(&self, id: DocumentId) -> (PathBuf, PathBuf) {
        (
            self.dir.join(format!("{}.pdf", id.get())),
            self.dir.join(format!("{}.json", id.get())),
        )
    }

    /// Writes the snapshot of a document: the PDF, then its manifest, both atomically and privately. Over `AUTOSAVE_DOC_MAX` nothing is
    /// written. Past `AUTOSAVE_STORE_MAX` in all, the oldest records of dead sessions make room, and `limit_exceeded` is the answer if
    /// that is not enough.
    pub fn write(&self, snapshot: &Snapshot<'_>) -> Result<Written, AppError> {
        let len = snapshot.bytes.len() as u64;
        if len > limits::AUTOSAVE_DOC_MAX {
            self.mark_too_large(snapshot.id, snapshot.rev);
            return Ok(Written::TooLarge);
        }
        self.lock().too_large.remove(&snapshot.id);
        let (pdf, manifest_path) = self.own_paths(snapshot.id);
        let replaced = file_len(&pdf) + file_len(&manifest_path);
        if self
            .store_estimate
            .load(Ordering::Relaxed)
            .saturating_sub(replaced)
            + len
            > limits::AUTOSAVE_STORE_MAX
        {
            // The estimate may be high (deletions are not counted): measure before refusing anything.
            self.enforce_store_cap(len);
            let actual = store_bytes(&self.root);
            self.store_estimate.store(actual, Ordering::Relaxed);
            if actual.saturating_sub(replaced) + len > limits::AUTOSAVE_STORE_MAX {
                return Err(AppError::limit("autosave", limits::AUTOSAVE_STORE_MAX));
            }
        }
        let original = snapshot.original.and_then(|path| {
            let metadata = fs::metadata(path).ok()?;
            Some(OriginalRef {
                path: path.to_path_buf(),
                len: metadata.len(),
                mtime: mtime_of(&metadata),
            })
        });
        let mut manifest = Manifest {
            v: MANIFEST_VERSION,
            original,
            display_name: sanitize_text(snapshot.display_name, limits::MAX_DISPLAY_NAME_CHARS),
            page_count: snapshot.page_count,
            saved_at: seconds(SystemTime::now()),
            app_version: env!("CARGO_PKG_VERSION").to_owned(),
        };
        let mut json = serde_json::to_vec(&manifest).unwrap_or_default();
        if json.is_empty() || json.len() as u64 > MANIFEST_MAX {
            // A path that cannot be stored (not UTF-8, absurdly long) is left out; the record is still worth having.
            manifest.original = None;
            json = serde_json::to_vec(&manifest)
                .map_err(|error| AppError::logged(ErrorCode::Internal, error))?;
        }
        write_atomic(&pdf, snapshot.bytes)?;
        write_atomic(&manifest_path, &json)?;
        self.store_estimate.fetch_add(
            (len + json.len() as u64).saturating_sub(replaced),
            Ordering::Relaxed,
        );
        let mut inner = self.lock();
        if let Some(track) = inner.tracks.get_mut(&snapshot.id) {
            track.written_rev = Some(snapshot.rev);
            if track.rev == snapshot.rev {
                track.dirty_since = None;
            }
        }
        inner.status.insert(snapshot.id, AutosaveStatus::On);
        Ok(Written::Done)
    }

    /// The document has nothing to protect any more (or must not be written): its record of this session goes, and the document is
    /// not tracked. A recovered document keeps the record it was restored from.
    pub fn clear_own(&self, id: DocumentId) {
        {
            let mut inner = self.lock();
            inner.tracks.remove(&id);
            inner.status.remove(&id);
            inner.too_large.remove(&id);
        }
        let (pdf, manifest) = self.own_paths(id);
        let _ = fs::remove_file(manifest);
        let _ = fs::remove_file(pdf);
    }

    /// Saved or closed: everything held for `id` goes, including the record a recovered document came from.
    pub fn forget(&self, id: DocumentId) {
        self.clear_own(id);
        let restored = self.lock().restored.remove(&id);
        if let Some(restored) = restored {
            let _ = fs::remove_file(&restored.copy);
            self.drop_dead(restored.rec_id);
        }
    }

    /// Marks the status of an encrypted document or one with a pending protection change: nothing is written, and an earlier
    /// snapshot (which would be unprotected) is deleted.
    pub fn withhold(&self, id: DocumentId) {
        if self.status_of(id) == AutosaveStatus::OffEncrypted && self.observed_rev(id).is_none() {
            return;
        }
        self.clear_own(id);
        self.set_status(id, AutosaveStatus::OffEncrypted);
    }

    /// The directory of the file a recovered document came from (for the Save As dialog); `None` for any other.
    pub fn original_dir(&self, id: DocumentId) -> Option<PathBuf> {
        let inner = self.lock();
        inner
            .restored
            .get(&id)?
            .original
            .as_deref()?
            .parent()
            .map(Path::to_path_buf)
    }

    /// The original path of a recovered document (for its manifest, so a second crash still knows).
    pub fn original_of(&self, id: DocumentId) -> Option<PathBuf> {
        self.lock().restored.get(&id)?.original.clone()
    }

    // --- records of dead sessions ---

    /// The records of dead sessions, newest first, without a path. A record that is open as a recovered document is not listed.
    pub fn list(&self) -> Vec<RecoveryView> {
        let inner = self.lock();
        let open: HashSet<u32> = inner.restored.values().map(|r| r.rec_id).collect();
        inner
            .dead
            .iter()
            .filter(|record| !open.contains(&record.id))
            .map(|record| RecoveryView {
                id: record.id,
                display_name: record.manifest.display_name.clone(),
                saved_at: record.manifest.saved_at,
                page_count: record.manifest.page_count,
                original: original_state(record.manifest.original.as_ref()),
            })
            .collect()
    }

    fn drop_dead(&self, id: u32) -> bool {
        let mut inner = self.lock();
        match inner.dead.iter().position(|record| record.id == id) {
            Some(position) => {
                let record = inner.dead.remove(position);
                drop(inner);
                remove_record_files(&record.dir, record.n);
                true
            }
            None => false,
        }
    }

    /// Deletes record `id`; `not_found` (`recovery`) for an id that is not listed.
    pub fn discard(&self, id: u32) -> Result<(), AppError> {
        if self.drop_dead(id) {
            Ok(())
        } else {
            Err(AppError::not_found("recovery"))
        }
    }

    /// Deletes every record that is not open as a recovered document; answers how many.
    pub fn discard_all(&self) -> u32 {
        let ids: Vec<u32> = self.list().iter().map(|view| view.id).collect();
        let mut removed = 0;
        for id in ids {
            if self.drop_dead(id) {
                removed += 1;
            }
        }
        removed
    }

    /// The document that is open from record `id`, if one is.
    pub fn restored_doc(&self, id: u32) -> Option<DocumentId> {
        self.lock()
            .restored
            .iter()
            .find(|(_, restored)| restored.rec_id == id)
            .map(|(&doc, _)| doc)
    }

    /// Copies record `id` into this session's directory so it can be opened (the dead session's directory is never opened by the
    /// engine). A record whose files are not as the manifest says is quarantined and is `damaged_file`.
    pub fn stage_restore(&self, id: u32) -> Result<Staged, AppError> {
        let record = self
            .lock()
            .dead
            .iter()
            .find(|record| record.id == id)
            .cloned()
            .ok_or(AppError::not_found("recovery"))?;
        let source = record.dir.join(format!("{}.pdf", record.n));
        let target = self.dir.join(format!("restore-{id}.pdf"));
        let copied = pdf_len(&record.dir, record.n)
            .ok_or(io::Error::from(io::ErrorKind::InvalidData))
            .and_then(|len| {
                let _ = fs::remove_file(&target);
                fs::copy(&source, &target).and_then(|copied| {
                    if copied == len {
                        Ok(())
                    } else {
                        Err(io::Error::from(io::ErrorKind::InvalidData))
                    }
                })
            });
        if copied.is_err() {
            let _ = fs::remove_file(&target);
            self.quarantine_dead(id);
            return Err(AppError::new(ErrorCode::DamagedFile));
        }
        Ok(Staged {
            id,
            path: target,
            display_name: record.manifest.display_name.clone(),
            original: record.manifest.original.map(|original| original.path),
        })
    }

    /// Takes back a staged copy that did not open.
    pub fn unstage(&self, staged: &Staged) {
        let _ = fs::remove_file(&staged.path);
    }

    /// The staged record is open as document `doc`: it is kept until that document is saved or closed.
    pub fn adopt(&self, doc: DocumentId, staged: &Staged) {
        self.lock().restored.insert(
            doc,
            Restored {
                rec_id: staged.id,
                copy: staged.path.clone(),
                original: staged.original.clone(),
            },
        );
    }

    /// Moves record `id` to the quarantine (the engine could not open it).
    pub fn quarantine_dead(&self, id: u32) {
        let mut inner = self.lock();
        if let Some(position) = inner.dead.iter().position(|record| record.id == id) {
            let record = inner.dead.remove(position);
            drop(inner);
            quarantine(&self.root, &record.dir, record.n);
        }
    }

    /// Makes room for `extra` more bytes: the oldest records of dead sessions are deleted while the store is over its cap.
    fn enforce_store_cap(&self, extra: u64) {
        loop {
            if store_bytes(&self.root) + extra <= limits::AUTOSAVE_STORE_MAX {
                return;
            }
            let oldest = self
                .lock()
                .dead
                .iter()
                .min_by_key(|record| record.manifest.saved_at)
                .map(|record| (record.id, record.bytes));
            match oldest {
                Some((id, _)) if self.drop_dead(id) => {}
                _ => return,
            }
        }
    }
}

/// The hook `run` calls once `AppState` is managed: takes the session lock, hands the autosave to the state and starts the timer.
pub fn start(app: &tauri::AppHandle) {
    crate::commands::recovery::start_autosave(app);
}

/// Normal quit: the session directory goes (`RunEvent::Exit`).
pub fn on_run_event(app: &tauri::AppHandle, event: &tauri::RunEvent) {
    if matches!(event, tauri::RunEvent::Exit) {
        crate::commands::recovery::stop_autosave(app);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::atomic::testutil::TempDir;

    fn id(n: u32) -> DocumentId {
        serde_json::from_str(&n.to_string()).unwrap()
    }

    fn snapshot(doc: DocumentId, bytes: &[u8]) -> Snapshot<'_> {
        Snapshot {
            id: doc,
            rev: 1,
            bytes,
            display_name: "a.pdf",
            original: None,
            page_count: 1,
        }
    }

    #[test]
    fn statuses_use_the_wire_names_of_architecture() {
        let names: Vec<String> = [
            AutosaveStatus::On,
            AutosaveStatus::OffEncrypted,
            AutosaveStatus::OffTooLarge,
            AutosaveStatus::Clean,
        ]
        .iter()
        .map(|status| serde_json::to_string(status).unwrap())
        .collect();
        assert_eq!(
            names,
            [
                r#""on""#,
                r#""offEncrypted""#,
                r#""offTooLarge""#,
                r#""clean""#
            ]
        );
    }

    #[test]
    fn a_change_is_due_after_the_debounce_or_the_max_interval() {
        let dir = TempDir::new();
        let auto = Autosave::start(dir.path()).unwrap();
        let t0 = Instant::now();
        auto.observe(id(1), 1, t0);
        assert!(auto.due(t0 + Duration::from_secs(29)).is_empty());
        assert_eq!(auto.due(t0 + limits::AUTOSAVE_DEBOUNCE), [id(1)]);
        // Edits keep restarting the debounce, but not the max interval.
        for step in 1..=12 {
            auto.observe(
                id(2),
                step,
                t0 + Duration::from_secs(u64::from(step as u32) * 10),
            );
        }
        // The first change was seen at 10 s: the max interval ends at 130 s.
        assert!(!auto.due(t0 + Duration::from_secs(129)).contains(&id(2)));
        assert!(auto
            .due(t0 + Duration::from_secs(10) + limits::AUTOSAVE_MAX_INTERVAL)
            .contains(&id(2)));
        // Written: nothing is due until the next change.
        auto.write(&Snapshot {
            rev: 12,
            ..snapshot(id(2), b"%PDF-1.4")
        })
        .unwrap();
        assert!(!auto.due(t0 + Duration::from_secs(1000)).contains(&id(2)));
        auto.observe(id(2), 13, t0 + Duration::from_secs(1000));
        assert!(auto.due(t0 + Duration::from_secs(1030)).contains(&id(2)));
    }

    #[test]
    fn a_record_is_two_private_files_and_forget_removes_both() {
        let dir = TempDir::new();
        let auto = Autosave::start(dir.path()).unwrap();
        auto.write(&snapshot(id(7), b"%PDF-1.4 x")).unwrap();
        assert!(auto.dir.join("7.pdf").is_file() && auto.dir.join("7.json").is_file());
        assert_eq!(auto.status_of(id(7)), AutosaveStatus::On);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = |path: &Path| fs::metadata(path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode(&auto.dir.join("7.pdf")), 0o600);
            assert_eq!(mode(&auto.dir.join("7.json")), 0o600);
            assert_eq!(mode(&auto.dir), 0o700);
        }
        auto.forget(id(7));
        assert!(!auto.dir.join("7.pdf").exists() && !auto.dir.join("7.json").exists());
        assert_eq!(auto.status_of(id(7)), AutosaveStatus::Clean);
    }

    #[test]
    fn a_document_over_the_cap_is_not_written_and_says_so() {
        let dir = TempDir::new();
        let auto = Autosave::start(dir.path()).unwrap();
        auto.mark_too_large(id(3), 1);
        assert_eq!(auto.status_of(id(3)), AutosaveStatus::OffTooLarge);
        auto.clear_own(id(3));
        assert_eq!(auto.status_of(id(3)), AutosaveStatus::Clean);
    }

    #[test]
    fn withholding_deletes_an_earlier_snapshot() {
        let dir = TempDir::new();
        let auto = Autosave::start(dir.path()).unwrap();
        auto.write(&snapshot(id(1), b"%PDF-1.4")).unwrap();
        auto.withhold(id(1));
        assert!(!auto.dir.join("1.pdf").exists());
        assert_eq!(auto.status_of(id(1)), AutosaveStatus::OffEncrypted);
    }

    #[test]
    fn a_save_blocks_a_round_and_one_round_runs_at_a_time() {
        let dir = TempDir::new();
        let auto = Arc::new(Autosave::start(dir.path()).unwrap());
        let guard = auto.begin_save();
        assert!(auto.begin_run().is_none());
        drop(guard);
        let run = auto.begin_run().unwrap();
        assert!(auto.begin_run().is_none());
        drop(run);
        assert!(auto.begin_run().is_some());
    }

    #[test]
    fn original_states_follow_the_file() {
        let dir = TempDir::new();
        let file = dir.path().join("o.pdf");
        fs::write(&file, b"abc").unwrap();
        let metadata = fs::metadata(&file).unwrap();
        let original = OriginalRef {
            path: file.clone(),
            len: 3,
            mtime: mtime_of(&metadata),
        };
        assert_eq!(original_state(Some(&original)), OriginalState::Unchanged);
        let grown = OriginalRef {
            len: 9,
            ..original.clone()
        };
        assert_eq!(original_state(Some(&grown)), OriginalState::Changed);
        fs::remove_file(&file).unwrap();
        assert_eq!(original_state(Some(&original)), OriginalState::Missing);
        assert_eq!(original_state(None), OriginalState::Missing);
    }
}
