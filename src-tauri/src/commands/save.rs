//! Saving (ADR-004, ARCHITECTURE §5, DESIGN 3.27).
//!
//! | Command | Arguments | Returns |
//! |---|---|---|
//! | `save_document` | `docId`, `ack?: { breakSignature, fileChanged }` | `SaveResult { rev, mode, backupCreated, warnings, document, changes }`. The welcome document answers `read_only` (the UI offers Save As); a file that changed on disk since it was opened answers `needs_confirmation` (`params.what: "fileChangedOnDisk"`) until `ack.fileChanged` |
//! | `save_document_as` | `docId`, `opts?: {}`, `ack?` | the same, or `null` if the user cancelled the dialog. The path comes from the native dialog in Rust and goes through `intake::admit_target`; it never reaches the webview |
//! | `close_document` | `docId`, `discard?: boolean` | nothing; a document with changes that are not saved answers `unsaved_changes` unless `discard` (the welcome document never does) |
//!
//! The save is an incremental update of the file as it is on disk (`pdfwrite`): the original bytes stay, the changed annotations and
//! their appearance streams follow. It is written to a temp file next to the target and renamed over it (`storage::atomic`), after
//! the original was copied to the backup folder once per session. PDFium lets go of the file for the rename and loads the result
//! again under the same id; if that fails the original bytes are put back. Afterwards the model holds the annotations as `clean`
//! with their new positions in the file, and its history is empty (ADR-033).

use std::io::Read;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc, Mutex, PoisonError};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

use super::annotations::iso8601_utc;
use super::{blocking, AppState};
use crate::content::ContentObject;
use crate::documents::intake::{self, Admitted};
use crate::documents::sources::SourceBytes;
use crate::documents::{DocKind, DocumentId, DocumentInfo, Fingerprint, PageId};
use crate::error::{AppError, ErrorCode, UiError};
use crate::limits;
use crate::model::annotation::PdfOrigin;
use crate::model::doc_state::{ChangeSet, DocState};
use crate::model::ids::AnnotId;
use crate::model::page::SourceId;
use crate::model::page_ops::PagePlan;
use crate::pdfsig::types::SignatureLock;
use crate::pdfwrite::{self, crypt, pagetree, sigread, Built, Change, Plan, SavePlan};
use crate::security::secret::PendingProtection;
use crate::storage::{atomic, backup};
use zeroize::Zeroizing;

/// What the user agreed to when a save asked (ARCHITECTURE §5): `file_changed` (the file changed on disk), `break_signature` (the save
/// rewrites a signed file) and `rewrite_encrypted` (the save rewrites an encrypted file, ADR-047 §4; asked for once package D lets such a
/// save through, until then an encrypted file is not changed: `unsupported_feature`).
#[derive(Debug, Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct SaveAck {
    pub break_signature: bool,
    pub file_changed: bool,
    pub rewrite_encrypted: bool,
}

/// Options of Save As: `clean_copy` writes the whole file again without the pages that were deleted (ADR-036 §5).
#[derive(Debug, Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct SaveAsOptions {
    pub clean_copy: bool,
}

/// How the file was written.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SaveMode {
    /// The original bytes, followed by an update.
    Incremental,
    /// The whole file again: a clean copy, redaction, a change of the protection, a removal of the metadata, an encrypted document.
    Full,
}

/// A save that worked but not completely.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SaveWarning {
    /// The original could not be copied to the backup folder (no data folder, or the copy failed); the file was saved anyway.
    BackupSkipped,
    /// A hybrid form was filled: its XFA data was removed so that other viewers do not show stale values (ADR-041 §3).
    XfaRemoved,
}

/// How a backup attempt went.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BackupOutcome {
    Created,
    /// This session has one already, or the save writes no original (Save As).
    NotNeeded,
    Skipped,
}

/// Documents with a save build that is still running, also one that was given up on after the deadline (its thread cannot be stopped).
/// A new save of such a document is refused until the thread is done, instead of starting a second one next to it.
static BUILDING: Mutex<Vec<(usize, DocumentId)>> = Mutex::new(Vec::new());

/// Tells the app states apart in [`BUILDING`] (there is one in the app; the tests make several, whose document ids overlap): the address of
/// the registry, which all clones of a state share.
type Owner = usize;

/// Holds the document's place in [`BUILDING`] until dropped (by the build thread, when it ends).
struct BuildSlot(Owner, DocumentId);

impl BuildSlot {
    fn take(owner: Owner, id: DocumentId) -> Result<Self, AppError> {
        let mut building = BUILDING.lock().unwrap_or_else(PoisonError::into_inner);
        if building.contains(&(owner, id)) {
            return Err(AppError::logged(
                ErrorCode::SaveFailed,
                "an earlier save of the document is still being built",
            ));
        }
        building.push((owner, id));
        Ok(Self(owner, id))
    }
}

impl Drop for BuildSlot {
    fn drop(&mut self) {
        BUILDING
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .retain(|other| *other != (self.0, self.1));
    }
}

/// The answer to a save.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveResult {
    /// The revision of the model after the save.
    pub rev: u64,
    pub mode: SaveMode,
    /// The original was copied to the backup folder by this save.
    pub backup_created: bool,
    /// What went less well than it should have, though the file is saved.
    pub warnings: Vec<SaveWarning>,
    /// The document as it is now: after a Save As another name, and no longer the welcome document.
    pub document: DocumentInfo,
    /// What changed in the annotations: they are `clean` now, and the history is empty and not dirty.
    pub changes: ChangeSet,
}

/// What a save has to write, from the model: `page_index` is the page's position in the file being written, and `origin_of` says where the
/// annotation that is in the file now will be (`None`: its page is not in the file any more, so there is nothing to write or delete).
pub(super) fn plan_with_origins(
    state: &DocState,
    page_index: impl Fn(&crate::model::annotation::Annotation) -> Option<u32>,
    origin_of: impl Fn(&PdfOrigin) -> Option<PdfOrigin>,
) -> Plan {
    use crate::model::annotation::Sync;
    let mut plan = Plan {
        assets: state.assets().snapshot(),
        ..Plan::default()
    };
    for entry in state.entries() {
        let annotation = &entry.annotation;
        let origin = entry.persisted.as_ref().and_then(&origin_of);
        if entry.tombstone {
            if let Some(origin) = origin {
                plan.changes.push(Change::Delete {
                    id: annotation.id,
                    origin,
                });
            }
            continue;
        }
        if let Some(origin) = &origin {
            plan.known.push((annotation.id, origin.clone()));
            if !state.keys_known(annotation.page_id) {
                plan.keys_unread.insert(annotation.id);
            }
        }
        // Text boxes and images are burned in, redaction marks are never written (ADR-047): neither is an annotation of the file.
        let to_write = !annotation.is_opaque()
            && annotation.body.is_written_as_annotation()
            && annotation.sync != Sync::Clean;
        if let (true, Some(page_index)) = (to_write, page_index(annotation)) {
            plan.changes.push(Change::Write {
                page_index,
                annotation: Box::new(annotation.clone()),
                origin,
            });
        }
    }
    plan
}

/// What the model stages besides the annotations and the pages (ADR-047): text boxes and images of the pages, crops, whether a page was
/// redacted, the staged protection and metadata. `keep_encryption` is set by the caller.
pub(super) fn save_plan_of(state: &DocState, pages: &PagePlan, keep_encryption: bool) -> SavePlan {
    let mut content: Vec<(PageId, Vec<ContentObject>)> = Vec::new();
    // `entries` is in creation order (ids only grow), which is the order the objects are drawn in.
    for entry in state.entries() {
        if entry.tombstone || !entry.annotation.body.is_content() {
            continue;
        }
        let page_id = entry.annotation.page_id;
        let object = ContentObject {
            annotation: entry.annotation.clone(),
            index: pages
                .pages
                .iter()
                .position(|page| page.id == page_id)
                .and_then(|position| u32::try_from(position).ok())
                .unwrap_or(u32::MAX),
            image: match &entry.annotation.body {
                crate::model::annotation::AnnotationBody::Image { asset_id, .. } => {
                    state.assets().image(*asset_id).cloned()
                }
                _ => None,
            },
        };
        match content
            .iter_mut()
            .find(|(page, _)| *page == entry.annotation.page_id)
        {
            Some((_, objects)) => objects.push(object),
            None => content.push((entry.annotation.page_id, vec![object])),
        }
    }
    SavePlan {
        content,
        // Crops are written with the page list (`pagetree::rewrite_pages`), not by `apply_extras`.
        crops: Vec::new(),
        redacted: pages.redacted,
        protection: state
            .pending_protection()
            .map(|(_, pending)| pending.clone()),
        metadata: state.metadata().change(),
        keep_encryption,
        // The staged record is dropped by a staged removal of the metadata (`pdfwrite::apply_extras` skips it too).
        bibliography: if state.metadata().strip {
            None
        } else {
            state.bibliography.pending.clone()
        },
    }
}

/// What [`AppState::stage`] reads from the model: pages, annotation plan, extras, changed form fields, XFA to strip.
type Staged = (
    PagePlan,
    Plan,
    SavePlan,
    Vec<crate::model::form::FormField>,
    bool,
);

/// What `build_pages` writes: the annotations, the pages, the bytes of the import sources the pages come from, and whether the result is
/// a full rewrite ("clean copy").
struct BuildPlan {
    plan: Plan,
    /// Everything else the model stages (see [`save_plan_of`]).
    extras: SavePlan,
    /// The form fields whose value changed, and whether the form is a hybrid one (its `/XFA` goes).
    form: Vec<crate::model::form::FormField>,
    strip_xfa: bool,
    pages: PagePlan,
    sources: std::collections::HashMap<SourceId, Arc<SourceBytes>>,
    clean_copy: bool,
    /// The password the document was opened with, to decrypt a protected file for the rewrite (ADR-047 §4).
    session: Option<Zeroizing<String>>,
}

/// [`build`] for a document whose pages may have changed: the page tree is written first (`pdfwrite::pagetree`), the annotations on the
/// result (their positions are those of the new file), and a clean copy is then made of what is reachable.
fn build_pages(
    owner: Owner,
    id: DocumentId,
    original: Vec<u8>,
    work: BuildPlan,
) -> Result<(Built, bool), AppError> {
    let slot = BuildSlot::take(owner, id)?;
    build_with(slot, limits::SAVE_TIMEOUT, move || {
        let BuildPlan {
            plan,
            extras,
            form,
            strip_xfa,
            pages,
            sources,
            clean_copy,
            session,
        } = work;
        let expected = u32::try_from(pages.pages.len())
            .map_err(|_| AppError::logged(ErrorCode::SaveFailed, "page count"))?;
        // A protected file goes through the save as a plain one and is encrypted again at the end (ADR-047 §4): with the state it had
        // (same file key and passwords), or as the staged protection says. A removal ends here.
        let removes = matches!(extras.protection, Some(PendingProtection::Remove));
        let (original, kept) = if extras.keep_encryption || removes {
            crypt::decrypt_for_rewrite(&original, session.as_ref().map(|s| s.as_str()))?
        } else {
            (original, None)
        };
        let (bytes, deleted) = if pages.changed() {
            let rewritten = pagetree::rewrite_pages(original, &pages, &sources)?;
            (rewritten.bytes, rewritten.deleted_pages)
        } else {
            (original, Vec::new())
        };
        let full = clean_copy || extras.requires_full();
        let mut built = pdfwrite::append_annotations(bytes, &plan)?;
        // The form values follow the annotations: a second update on top of the first (the `/Annots` positions do not change).
        let mut xfa_removed = false;
        if !form.is_empty() {
            let written = pdfwrite::forms::write_values(built.bytes, &form, strip_xfa)?;
            built.bytes = written.bytes;
            xfa_removed = written.xfa_removed;
        }
        // Content objects, crops, redaction scrubbing, encryption and metadata (packages A to D).
        if !extras.is_empty() {
            built.bytes = pdfwrite::apply_extras(built.bytes, &extras)?;
        }
        if full {
            built.bytes = pagetree::compact(built.bytes, &deleted)?;
        }
        if !plan.changes.is_empty()
            || pages.changed()
            || full
            || !form.is_empty()
            || !extras.is_empty()
        {
            pdfwrite::validate(&built.bytes, expected)?;
        }
        match (&extras.protection, &kept) {
            (Some(protect @ PendingProtection::Protect { .. }), _) => {
                built.bytes = crypt::encrypt_bytes(&built.bytes, protect)?;
            }
            (Some(PendingProtection::Remove), _) => {}
            (None, Some(state)) => built.bytes = crypt::encrypt_again(&built.bytes, state)?,
            (None, None) => {}
        }
        built.pages = expected;
        Ok((built, xfa_removed))
    })
}

/// Runs `work` on the build thread, which owns `slot` until it ends.
fn build_with<T: Send + 'static>(
    slot: BuildSlot,
    timeout: std::time::Duration,
    work: impl FnOnce() -> Result<T, AppError> + Send + 'static,
) -> Result<T, AppError> {
    let (sender, receiver) = mpsc::channel();
    let spawned = thread::Builder::new()
        .name("sheer-save".into())
        .stack_size(limits::SAVE_STACK_BYTES)
        .spawn(move || {
            let result = catch_unwind(AssertUnwindSafe(work))
                .unwrap_or_else(|_| Err(AppError::logged(ErrorCode::Internal, "saving panicked")));
            // The work is done: give the slot back before the answer, so a caller that saves again right after it is not refused
            // (CI run #80: a second snapshot raced the first thread's drop).
            drop(slot);
            // The caller may have given up.
            let _ = sender.send(result);
        });
    if let Err(error) = spawned {
        return Err(AppError::logged(ErrorCode::SaveFailed, error));
    }
    receiver
        .recv_timeout(timeout)
        .map_err(|_| AppError::logged(ErrorCode::EngineTimeout, "saving took too long"))?
}

/// A failure to write the file: the specific code if the OS gave one a person can act on, else `save_failed`.
fn write_error(error: std::io::Error) -> AppError {
    let error = AppError::from(error);
    match error.code() {
        ErrorCode::IoInUse
        | ErrorCode::IoPermissionDenied
        | ErrorCode::IoNotFound
        | ErrorCode::IoDiskFull => error,
        _ => AppError::logged(ErrorCode::SaveFailed, error),
    }
}

/// `20261003T123045Z`, the time as the backup names write it.
fn compact_stamp() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_secs());
    iso8601_utc(secs).replace(['-', ':'], "")
}

/// Whether a file is not what it was when `opened` was taken. A fingerprint that is missing on either side counts as changed: what cannot be
/// compared is not known to be the same (fail closed).
pub(super) fn fingerprint_changed(opened: Option<Fingerprint>, now: Option<Fingerprint>) -> bool {
    match (opened, now) {
        (Some(opened), Some(now)) => opened != now,
        _ => true,
    }
}

/// Reads the whole file behind an admitted handle.
pub(super) fn read_all(admitted: Admitted) -> Result<(Vec<u8>, Option<Fingerprint>), AppError> {
    let Admitted { mut file, .. } = admitted;
    let fingerprint = Fingerprint::of(&file);
    let mut bytes = Vec::with_capacity(
        fingerprint
            .and_then(|f| usize::try_from(f.len).ok())
            .unwrap_or(0),
    );
    file.read_to_end(&mut bytes)?;
    Ok((bytes, fingerprint))
}

/// Largest file whose signatures are read for the lock; a larger one with a signature is `locked` (the safe side).
const LOCK_SCAN_MAX_BYTES: u64 = 512 * 1024 * 1024;

/// Whether the stream holds the token `/ByteRange`, also written with `#xx` name escapes (`/Byte#52ange` is the same name to a PDF
/// reader): a signature dictionary cannot be without it (it is never in an object stream), so a file without it has no signature and is
/// not parsed for the lock. Reads in 64 KiB blocks.
pub(super) fn has_byte_range<R: Read>(mut reader: R) -> std::io::Result<bool> {
    const TOKEN: &[u8] = b"/ByteRange";
    // Every character of the name may be written as three bytes.
    const TAIL: usize = TOKEN.len() * 3;
    let mut buffer = vec![0u8; 64 * 1024 + TAIL];
    let mut kept = 0usize;
    loop {
        let read = reader.read(&mut buffer[kept..])?;
        if read == 0 {
            return Ok(false);
        }
        let end = kept + read;
        let plain = &buffer[..end];
        if plain.windows(TOKEN.len()).any(|w| w == TOKEN)
            || unescape_names(plain)
                .windows(TOKEN.len())
                .any(|w| w == TOKEN)
        {
            return Ok(true);
        }
        // Keep the tail, so a token across two blocks is found.
        let tail = TAIL.min(end);
        buffer.copy_within(end - tail..end, 0);
        kept = tail;
    }
}

/// `bytes` with every `#xx` (two hex digits) replaced by the byte it stands for.
fn unescape_names(bytes: &[u8]) -> Vec<u8> {
    let hex = |b: u8| char::from(b).to_digit(16);
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] == b'#' {
            if let (Some(hi), Some(lo)) = (
                bytes.get(at + 1).copied().and_then(hex),
                bytes.get(at + 2).copied().and_then(hex),
            ) {
                out.push(u8::try_from(hi * 16 + lo).unwrap_or(b'#'));
                at += 3;
                continue;
            }
        }
        out.push(bytes[at]);
        at += 1;
    }
    out
}

/// The lock of a file that holds the token `/ByteRange`: what its signatures allow, and the strictest lock when they cannot be read
/// (encrypted, damaged or hostile: a signature may be in there, and not knowing must not unlock).
pub(super) fn lock_of_bytes(bytes: &[u8]) -> SignatureLock {
    match sigread::scan_bytes(bytes) {
        Ok(scan) => crate::model::sig_policy::lock_of(&scan),
        Err(_) => SignatureLock::Locked,
    }
}

/// The lock of the file at `path` (see [`AppState::refresh_signature_lock`]). A file that cannot be opened has none (nothing is known
/// about it); one that holds the token `/ByteRange` and cannot be read or scanned is `locked`.
pub(super) fn signature_lock_of_file(path: &Path) -> SignatureLock {
    let Ok(Admitted { mut file, .. }) = intake::admit(path) else {
        return SignatureLock::None;
    };
    match has_byte_range(&mut file) {
        Ok(false) => return SignatureLock::None,
        Ok(true) => {}
        // Could not even look: it may have one.
        Err(_) => return SignatureLock::Locked,
    }
    let len = file.metadata().map_or(u64::MAX, |meta| meta.len());
    if len > LOCK_SCAN_MAX_BYTES {
        return SignatureLock::Locked;
    }
    let mut bytes = Vec::new();
    if std::io::Seek::seek(&mut file, std::io::SeekFrom::Start(0)).is_err()
        || file.read_to_end(&mut bytes).is_err()
    {
        return SignatureLock::Locked;
    }
    lock_of_bytes(&bytes)
}

impl AppState {
    /// Saves document `id` into the file it was opened from (primary+S). The welcome document is `read_only`: it is a bundled resource,
    /// and a save that wrote into the app's resources would be a write outside the user's files (SECURITY D1); the UI turns the answer
    /// into Save As.
    pub fn save_in_place(&self, id: DocumentId, ack: SaveAck) -> Result<SaveResult, AppError> {
        // Before anything else is looked at, let alone opened for writing.
        // A recovered document has no file of its own yet: Save acts as Save As (ADR-053 section 2).
        if self.info(id).is_some_and(|info| {
            matches!(
                info.kind,
                DocKind::Welcome | DocKind::Recovered | DocKind::SignedRevision
            )
        }) {
            return Err(AppError::new(ErrorCode::ReadOnly));
        }
        let _guard = self.autosave_save_guard();
        let mut result = self.save(id, None, ack, false)?;
        self.autosave_forget(id);
        result.document.autosave = self.autosave_status_of(id);
        Ok(result)
    }

    /// Saves document `id` into `target`, a path the user chose in the dialog (Save As). The path is judged by
    /// [`intake::admit_target`]. The document is the file at `target` from then on: another name, a document of the user's, saved in
    /// place from now on. Choosing the file the document already is saves in place.
    pub fn save_as(
        &self,
        id: DocumentId,
        target: &Path,
        ack: SaveAck,
    ) -> Result<SaveResult, AppError> {
        self.save_as_with(id, target, ack, SaveAsOptions::default())
    }

    /// [`AppState::save_as`] with the options of the dialog: `clean_copy` writes the whole file again, without the pages that were deleted.
    pub fn save_as_with(
        &self,
        id: DocumentId,
        target: &Path,
        ack: SaveAck,
        options: SaveAsOptions,
    ) -> Result<SaveResult, AppError> {
        let target = intake::admit_target(target)?;
        let _guard = self.autosave_save_guard();
        let mut result = self.save(id, Some(target), ack, options.clean_copy)?;
        self.autosave_forget(id);
        result.document.autosave = self.autosave_status_of(id);
        Ok(result)
    }

    /// What the file has to become, from the model: the pages in their order (ADR-036 §5), the annotations on them, the extras, the form
    /// fields that changed and whether the form is a hybrid one.
    fn stage(&self, id: DocumentId) -> Result<Staged, AppError> {
        self.model(id, |state| {
            let pages = state.page_plan();
            let position: std::collections::HashMap<u32, u32> = pages
                .pages
                .iter()
                .zip(0u32..)
                .map(|(page, position)| (page.id.get(), position))
                .collect();
            // Pages of an import source: the annotations the model holds for them are found in the copy by their `/NM`.
            let plan = plan_with_origins(
                state,
                |annotation| position.get(&annotation.page_id.get()).copied(),
                |origin| {
                    let page_index = match pages.brought_position(origin.page_index) {
                        Some(page_index) => origin.name.as_ref().map(|_| page_index),
                        None => pages.file_position(origin.page_index),
                    }?;
                    Some(PdfOrigin {
                        page_index,
                        ..origin.clone()
                    })
                },
            );
            // The form fields whose value is not the file's (ADR-041 §3).
            let form: Vec<crate::model::form::FormField> = state
                .form()
                .map(|form| form.changed().into_iter().cloned().collect())
                .unwrap_or_default();
            let strip_xfa = state
                .form()
                .is_some_and(|form| form.xfa() == crate::model::form::Xfa::Hybrid);
            let extras = save_plan_of(state, &pages, false);
            Ok((pages, plan, extras, form, strip_xfa))
        })
    }

    /// The current state of document `id` as a Full, plain PDF in memory (ADR-049 §1): what a save would write (content objects burned
    /// in, crops, redacted pages as rasters, form values), but unencrypted, never on disk, no backup, and without a staged protection
    /// change. Redaction marks are not part of it. Blocking; the caller checks the size.
    pub(crate) fn snapshot_bytes(&self, id: DocumentId) -> Result<Vec<u8>, AppError> {
        let info = self.info(id).ok_or(AppError::not_found("document"))?;
        let source = self
            .registry
            .path(id)
            .ok_or(AppError::not_found("document"))?;
        let (pages, plan, mut extras, form, strip_xfa) = self.stage(id)?;
        // A plain file: the build decrypts an encrypted original the way it does for a staged removal, so that is how the snapshot asks
        // for it. A staged protection is not part of what the user sees.
        extras.protection = info.flags.encrypted.then_some(PendingProtection::Remove);
        extras.keep_encryption = false;
        let mut sources = std::collections::HashMap::new();
        for source_id in pages.sources() {
            let bytes = self.sources.pinned(id, source_id).ok_or_else(|| {
                AppError::logged(ErrorCode::SaveFailed, "an import source is gone")
            })?;
            sources.insert(source_id, bytes);
        }
        let (original, fingerprint) = read_all(intake::admit(&source)?)?;
        if fingerprint_changed(self.registry.fingerprint(id), fingerprint) {
            return Err(AppError::needs_confirmation("fileChangedOnDisk"));
        }
        let session = self.session_password(id);
        let (built, _) = build_pages(
            Arc::as_ptr(&self.registry) as usize,
            id,
            original,
            BuildPlan {
                plan,
                extras,
                form,
                strip_xfa,
                pages,
                sources,
                clean_copy: true,
                session,
            },
        )?;
        Ok(built.bytes)
    }

    fn save(
        &self,
        id: DocumentId,
        target: Option<PathBuf>,
        ack: SaveAck,
        clean_copy: bool,
    ) -> Result<SaveResult, AppError> {
        let info = self.info(id).ok_or(AppError::not_found("document"))?;
        let source = self
            .registry
            .path(id)
            .ok_or(AppError::not_found("document"))?;
        // The file Save As means may be the one that is open: that is a plain save.
        let target = match target {
            Some(target) => {
                let target = std::fs::canonicalize(&target).unwrap_or(target);
                (target != source).then_some(target)
            }
            None => None,
        };
        if let Some(target) = &target {
            if self.registry.is_open_elsewhere(id, target) {
                return Err(AppError::new(ErrorCode::IoInUse));
            }
        }

        let (pages, plan, extras, form, strip_xfa) = self.stage(id)?;
        let expected =
            u32::try_from(pages.pages.len()).map_err(|_| AppError::new(ErrorCode::Internal))?;
        let page_changes = pages.changed();
        // An encrypted document stays encrypted unless the save removes the protection (ADR-047 §4): a save that has something to
        // write is a full rewrite with the file's own `/Encrypt` and key. One that has nothing to write leaves the file alone.
        let mut extras = extras;
        let would_write = clean_copy
            || page_changes
            || !plan.changes.is_empty()
            || !form.is_empty()
            || !extras.is_empty();
        extras.keep_encryption = info.flags.encrypted
            && would_write
            && !matches!(extras.protection, Some(PendingProtection::Remove));
        let full = clean_copy || extras.requires_full();
        // A signed document is only ever extended (ADR-121 section 1): a full rewrite or a change of the pages would break the signatures
        // the file carries. The way to such changes is `save_unsigned_copy`.
        if info.signature_lock != SignatureLock::None && (full || page_changes) {
            return Err(AppError::read_only("signed"));
        }
        let writes = !plan.changes.is_empty()
            || page_changes
            || full
            || !form.is_empty()
            || !extras.is_empty();
        // A protected file is written again as a whole (ADR-004 §5, ADR-047 §4): the user says yes first, unless the save is the very
        // change of its protection.
        if writes && info.flags.encrypted && extras.protection.is_none() && !ack.rewrite_encrypted {
            return Err(AppError::needs_confirmation("rewriteEncrypted"));
        }
        let session = self.session_password(id);
        // What the reopen after the save opens with: the staged open password, none after a removal, else the one it was opened with.
        let reopen_password = match &extras.protection {
            Some(PendingProtection::Protect { open, .. }) => open
                .as_ref()
                .map(|open| Zeroizing::new(open.expose().to_owned())),
            Some(PendingProtection::Remove) => None,
            None => session.clone(),
        };
        // Changes to the pages are not among the changes a signature allows (ADR-036 §5), and a new file is not the signed one.
        if (page_changes || full)
            && info.flags.signed
            && info.signature_lock == SignatureLock::None
            && !ack.break_signature
        {
            return Err(AppError::needs_confirmation("breaksSignature"));
        }
        if !writes && target.is_none() {
            // Nothing to put in the file: it is saved as it is.
            return self.model(id, |state| {
                state.mark_clean();
                Ok(self.result(
                    id,
                    state.current(),
                    false,
                    Vec::new(),
                    SaveMode::Incremental,
                ))
            });
        }
        let mut sources = std::collections::HashMap::new();
        for source_id in pages.sources() {
            let bytes = self.sources.pinned(id, source_id).ok_or_else(|| {
                AppError::logged(ErrorCode::SaveFailed, "an import source is gone")
            })?;
            sources.insert(source_id, bytes);
        }

        // The file as it is on disk now, and whether it is the one that was opened.
        let (original, read_fingerprint) = read_all(intake::admit(&source)?)?;
        if !ack.file_changed && fingerprint_changed(self.registry.fingerprint(id), read_fingerprint)
        {
            return Err(AppError::needs_confirmation("fileChangedOnDisk"));
        }
        let original_len = original.len();
        // A full rewrite shares nothing with the original, so what the backup and a rollback need is kept apart.
        let original_copy = full.then(|| original.clone());
        let (built, xfa_removed) = build_pages(
            Arc::as_ptr(&self.registry) as usize,
            id,
            original,
            BuildPlan {
                plan,
                extras: extras.clone(),
                form,
                strip_xfa,
                pages,
                sources,
                clean_copy,
                session,
            },
        )?;
        let original_bytes = |built: &Built| -> Vec<u8> {
            original_copy
                .clone()
                .unwrap_or_else(|| built.bytes[..original_len].to_vec())
        };
        let mode = if full {
            SaveMode::Full
        } else {
            SaveMode::Incremental
        };
        let origins: std::collections::HashMap<AnnotId, PdfOrigin> =
            built.origins.iter().cloned().collect();

        let in_place = target.is_none();
        let destination = target.clone().unwrap_or_else(|| source.clone());
        let backup = if in_place && writes && !extras.never_backed_up() {
            self.back_up(id, &source, &original_bytes(&built))
        } else {
            BackupOutcome::NotNeeded
        };
        let mut warnings = Vec::new();
        if backup == BackupOutcome::Skipped {
            warnings.push(SaveWarning::BackupSkipped);
        }
        if xfa_removed {
            warnings.push(SaveWarning::XfaRemoved);
        }

        // The build and the backup took time: look at the file again right before it is replaced, so that a change made by another
        // program meanwhile is not overwritten without the user's say.
        if !ack.file_changed && self.changed_on_disk(id, &source)? {
            return Err(AppError::needs_confirmation("fileChangedOnDisk"));
        }

        // Close, rename, reopen. PDFium lets go of the file the rename replaces.
        // A save that fails puts the engine's copy back as it was: with the pages of this session and their rotations, which the
        // original file does not have and the model's page list points at (engine indices). The copy is taken only when the session
        // changed the pages; a Save As without such changes leaves the engine's copy loaded.
        let snapshot = if page_changes {
            Some(self.engine.release_with_snapshot(id)?)
        } else {
            if in_place {
                self.engine.release(id)?;
            }
            None
        };
        let released = in_place || snapshot.is_some();
        if let Err(error) = atomic::replace_atomic(&destination, &built.bytes) {
            if released {
                self.put_back(id, &source, snapshot);
            }
            return Err(write_error(error));
        }
        let reopened = intake::admit(&destination).and_then(|admitted| {
            let fingerprint = Fingerprint::of(&admitted.file);
            let pages =
                self.engine
                    .reopen_with_password(id, admitted.file, reopen_password.clone())?;
            Ok((pages, fingerprint))
        });
        let fingerprint = match reopened {
            Ok((pages, fingerprint)) if pages == expected => fingerprint,
            other => {
                if let Err(error) = &other {
                    error.log();
                }
                // What was written does not load as the document: the original is put back (ADR-004 §1 step 9).
                let rollback = if in_place {
                    atomic::replace_atomic(&destination, &original_bytes(&built))
                } else {
                    std::fs::remove_file(&destination)
                };
                if let Err(error) = rollback {
                    // The user's file may now be the update that does not load: this must be findable in the log.
                    AppError::logged(ErrorCode::SaveFailed, error).log();
                }
                self.put_back(id, &source, snapshot);
                return Err(AppError::logged(
                    ErrorCode::SaveFailed,
                    "the saved file did not load again",
                ));
            }
        };

        if let Some(destination) = target {
            self.registry.rebind(id, destination.clone())?;
            self.note_recent(DocKind::User, &destination);
        }
        self.registry.set_fingerprint(id, fingerprint);
        // What a redaction (or a removal of the metadata) took out must not stay in a copy of ours (ADR-047 §3).
        if extras.never_backed_up() {
            if let Some(data_dir) = &self.data_dir {
                backup::forget_target(&data_dir.join("backups"), &destination);
            }
        }
        let changes = self.model(id, |state| Ok(state.finish_save(&origins)))?;
        // The file the document is now opens with the new password, if the save changed it (the reopen above used it).
        self.note_session_password(id, reopen_password);
        self.refresh_permissions(id);
        self.refresh_signature_lock(id);
        // The pages of the file are the pages of the document now, in this order: engine page i is page i, and what was held for the
        // inserts is in the file.
        self.registry.set_page_count(id, expected)?;
        // The ids of the pages survive the save (they are not renumbered), so the registry keeps the ids the model has: engine page i is
        // the page at position i, whatever its id.
        self.model(id, |state| {
            self.registry.set_pages(
                id,
                state
                    .pages()
                    .iter()
                    .map(|slot| (slot.id, slot.engine_index)),
            );
            Ok(())
        })?;
        self.sources.unpin_all(id);
        // The saved first page is the preview of the recents row (what a redaction took out is not in it: it is drawn from the saved file).
        self.cache_thumbnail(id);
        Ok(self.result(
            id,
            changes,
            backup == BackupOutcome::Created,
            warnings,
            mode,
        ))
    }

    /// Reads what the signatures of the file of `id` allow and records it (ADR-121 section 1), for a document just opened, unlocked or
    /// saved. A document signed elsewhere is locked as well. Best effort: a file that cannot be read or is encrypted has no lock here (a
    /// signed encrypted file keeps the `breaksSignature` confirmation).
    pub(super) fn refresh_signature_lock(&self, id: DocumentId) {
        let Some(path) = self.registry.path(id) else {
            return;
        };
        self.registry
            .set_signature_lock(id, signature_lock_of_file(&path));
    }

    /// Whether the file `id` was opened from is no longer what it was (or cannot be looked at: not knowing counts as changed).
    fn changed_on_disk(&self, id: DocumentId, source: &Path) -> Result<bool, AppError> {
        let now = Fingerprint::of(&intake::admit(source)?.file);
        Ok(fingerprint_changed(self.registry.fingerprint(id), now))
    }

    fn result(
        &self,
        id: DocumentId,
        changes: ChangeSet,
        backup_created: bool,
        warnings: Vec<SaveWarning>,
        mode: SaveMode,
    ) -> SaveResult {
        SaveResult {
            rev: changes.rev,
            mode,
            backup_created,
            warnings,
            document: self.info(id).unwrap_or_else(|| DocumentInfo {
                id,
                page_count: 0,
                display_name: String::new(),
                kind: DocKind::User,
                flags: crate::documents::DocFlags::default(),
                autosave: crate::storage::autosave::AutosaveStatus::Clean,
                signature_lock: crate::pdfsig::types::SignatureLock::None,
            }),
            changes,
        }
    }

    /// Puts the engine's copy of `id` back after a save that did not work: from the snapshot taken before it was released if there is
    /// one (it has the pages added and the rotations set in this session), else from the original file. Best effort: logged.
    fn put_back(&self, id: DocumentId, path: &Path, snapshot: Option<Vec<u8>>) {
        if let Some(bytes) = snapshot {
            match self.engine.restore(id, bytes) {
                Ok(_) => return,
                Err(error) => error.log(),
            }
        }
        self.reopen_from(id, path);
    }

    /// Puts the engine's copy of `id` back from the file at `path` after a save that did not work. Best effort: logged.
    fn reopen_from(&self, id: DocumentId, path: &Path) {
        let session = self.session_password(id);
        let reopened = intake::admit(path)
            .and_then(|admitted| self.engine.reopen_with_password(id, admitted.file, session));
        if let Err(error) = reopened {
            error.log();
        }
    }

    /// Copies the original into the backup folder, once per session and document (ADR-004 §3). A backup that cannot be made is logged
    /// and does not stop the save, but is reported (`SaveWarning::BackupSkipped`).
    fn back_up(&self, id: DocumentId, source: &Path, original: &[u8]) -> BackupOutcome {
        let Some(data_dir) = &self.data_dir else {
            return BackupOutcome::Skipped;
        };
        if self.registry.backed_up(id) {
            return BackupOutcome::NotNeeded;
        }
        let directory = data_dir.join("backups");
        match backup::write_backup(&directory, &compact_stamp(), source, original) {
            Ok(_) => {
                self.registry.set_backed_up(id, true);
                backup::prune(
                    &directory,
                    SystemTime::now(),
                    limits::BACKUP_KEEP,
                    limits::BACKUP_MAX_BYTES,
                );
                BackupOutcome::Created
            }
            Err(error) => {
                AppError::from(error).log();
                BackupOutcome::Skipped
            }
        }
    }

    /// Closes a document the way the UI asks to (ADR-004, DESIGN 3.27): a document with changes that are not saved is
    /// `unsaved_changes` unless the user chose to `discard` them. The welcome document has nothing to lose.
    pub fn close_document_checked(&self, id: DocumentId, discard: bool) -> Result<(), AppError> {
        let welcome = self
            .registry
            .info(id)
            .is_some_and(|info| info.kind == DocKind::Welcome);
        // A recovered document is unsaved by nature: its only other copy is the autosave record that closing deletes.
        let recovered = self.registry.kind(id) == Some(DocKind::Recovered);
        if !discard && !welcome && (recovered || self.annotations.is_dirty(id)) {
            return Err(AppError::new(ErrorCode::UnsavedChanges));
        }
        self.close_document(id)
    }
}

/// Saves a document into the file it came from.
#[tauri::command]
pub async fn save_document(
    state: State<'_, AppState>,
    doc_id: DocumentId,
    ack: Option<SaveAck>,
) -> Result<SaveResult, UiError> {
    let state = state.inner().clone();
    blocking(move || state.save_in_place(doc_id, ack.unwrap_or_default())).await
}

/// Asks where to save (a native dialog, shown from Rust) and saves a document there. `null` if the user cancelled.
#[tauri::command]
pub async fn save_document_as(
    window: WebviewWindow,
    state: State<'_, AppState>,
    doc_id: DocumentId,
    opts: Option<SaveAsOptions>,
    ack: Option<SaveAck>,
) -> Result<Option<SaveResult>, UiError> {
    let _ = opts;
    let state = state.inner().clone();
    blocking(move || {
        let info = state.info(doc_id).ok_or(AppError::not_found("document"))?;
        let mut dialog = window
            .dialog()
            .file()
            .set_parent(&window)
            .add_filter("PDF", &["pdf"]);
        if !info.display_name.is_empty() {
            let name = if info.display_name.to_ascii_lowercase().ends_with(".pdf") {
                info.display_name.clone()
            } else {
                format!("{}.pdf", info.display_name)
            };
            dialog = dialog.set_file_name(name);
        }
        // The folder of the source file (a recovered document: of its original), known to Rust only.
        if let Some(folder) = state.source_dir(doc_id) {
            dialog = dialog.set_directory(folder);
        }
        let Some(chosen) = dialog.blocking_save_file() else {
            return Ok(None);
        };
        let path = chosen
            .into_path()
            .map_err(|error| AppError::logged(ErrorCode::Internal, error))?;
        state
            .save_as(doc_id, &path, ack.unwrap_or_default())
            .map(Some)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::testutil::state_with_pages;
    use crate::engine::Job;

    fn welcome_state() -> (AppState, DocumentId) {
        state_with_pages(1, |job| {
            if let Job::Close { reply, .. } = job {
                let _ = reply.send(Ok(()));
            }
        })
    }

    #[test]
    fn an_unknown_document_is_not_found_and_nothing_is_written() {
        let (state, _) = welcome_state();
        let unknown: DocumentId = serde_json::from_str("999").unwrap();
        assert_eq!(
            state
                .save_in_place(unknown, SaveAck::default())
                .unwrap_err()
                .code(),
            ErrorCode::NotFound
        );
    }

    #[test]
    fn the_acknowledgement_and_options_reject_unknown_keys() {
        assert!(
            serde_json::from_str::<SaveAck>(r#"{"fileChanged":true}"#)
                .unwrap()
                .file_changed
        );
        assert!(serde_json::from_str::<SaveAck>(r#"{"path":"x"}"#).is_err());
        assert!(serde_json::from_str::<SaveAsOptions>("{}").is_ok());
        assert!(serde_json::from_str::<SaveAsOptions>(r#"{"path":"x"}"#).is_err());
    }

    #[test]
    fn a_close_without_discard_refuses_a_document_with_unsaved_changes_but_not_a_clean_one() {
        let (state, id) = welcome_state();
        state.close_document_checked(id, false).unwrap();
    }

    #[test]
    fn a_missing_fingerprint_counts_as_a_change() {
        let some = Fingerprint {
            len: 3,
            modified: None,
        };
        let other = Fingerprint {
            len: 4,
            modified: None,
        };
        assert!(!fingerprint_changed(Some(some), Some(some)));
        assert!(fingerprint_changed(Some(some), Some(other)));
        assert!(fingerprint_changed(None, Some(some)));
        assert!(fingerprint_changed(Some(some), None));
        assert!(fingerprint_changed(None, None));
    }

    #[test]
    fn a_build_that_ran_past_its_deadline_blocks_a_second_one_until_it_ends() {
        let id: DocumentId = serde_json::from_str("424242").unwrap();
        let slot = BuildSlot::take(1, id).unwrap();
        let (release, gate) = mpsc::channel::<()>();
        let slow = build_with(slot, std::time::Duration::from_millis(20), move || {
            let _ = gate.recv();
            Ok(())
        });
        assert_eq!(slow.unwrap_err().code(), ErrorCode::EngineTimeout);
        // The thread is still there: no second build for the document, but one for another.
        assert_eq!(
            BuildSlot::take(1, id).err().map(|e| e.code()),
            Some(ErrorCode::SaveFailed)
        );
        let other: DocumentId = serde_json::from_str("424243").unwrap();
        drop(BuildSlot::take(1, other).unwrap());
        drop(release);
        let mut free = false;
        for _ in 0..200 {
            if let Ok(slot) = BuildSlot::take(1, id) {
                drop(slot);
                free = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert!(free, "the slot is given back when the thread ends");
    }
}

#[cfg(test)]
mod lock_scan_tests {
    use super::{has_byte_range, lock_of_bytes, signature_lock_of_file};
    use crate::pdfsig::types::SignatureLock;

    #[test]
    fn the_token_is_found_across_block_edges_and_absent_otherwise() {
        let token = b"/ByteRange [0 1 2 3]";
        for offset in [0usize, 5, 65_535, 65_536, 65_540, 131_071, 200_000] {
            let mut data = vec![b'x'; 300_000];
            data[offset..offset + token.len()].copy_from_slice(token);
            assert!(has_byte_range(&data[..]).unwrap(), "offset {offset}");
        }
        assert!(!has_byte_range(&vec![b'x'; 300_000][..]).unwrap());
        assert!(!has_byte_range(&b"/Byte"[..]).unwrap());
    }

    #[test]
    fn an_escaped_name_is_the_token_too_even_across_block_edges() {
        for token in [
            &b"/Byte#52ange"[..],
            b"/#42yteRange",
            b"/#42#79#74#65#52#61#6e#67#65",
        ] {
            for offset in [0usize, 65_530, 65_536, 131_000] {
                let mut data = vec![b'x'; 300_000];
                data[offset..offset + token.len()].copy_from_slice(token);
                assert!(has_byte_range(&data[..]).unwrap(), "{token:?} at {offset}");
            }
        }
        assert!(!has_byte_range(&b"/Byte#5ange #zz"[..]).unwrap());
    }

    #[test]
    fn a_signature_that_cannot_be_read_locks_the_file_instead_of_freeing_it() {
        // A file with the token that is not a document (damaged, or encrypted: the same refusal).
        assert_eq!(
            lock_of_bytes(b"%PDF-1.7\n/ByteRange [0 1 2 3]\ngarbage"),
            SignatureLock::Locked
        );
        let dir = std::env::temp_dir().join(format!("sheer-lock-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let hostile = dir.join("hostile.pdf");
        std::fs::write(&hostile, b"%PDF-1.7\n/Byte#52ange [0 1 2 3]\ngarbage").unwrap();
        assert_eq!(signature_lock_of_file(&hostile), SignatureLock::Locked);
        let plain = dir.join("plain.pdf");
        std::fs::write(&plain, b"%PDF-1.7\ngarbage without the name").unwrap();
        assert_eq!(signature_lock_of_file(&plain), SignatureLock::None);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
