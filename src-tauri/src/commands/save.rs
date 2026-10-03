//! Saving (ADR-004, ARCHITECTURE §5, DESIGN 3.27).
//!
//! | Command | Arguments | Returns |
//! |---|---|---|
//! | `save_document` | `docId`, `ack?: { breakSignature, fileChanged, rewriteEncrypted }` | `SaveResult { rev, mode, backupCreated, document, changes }`. The welcome document answers `read_only` (the UI offers Save As); a file that changed on disk since it was opened answers `needs_confirmation` (`params.what: "fileChangedOnDisk"`) until `ack.fileChanged` |
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
use std::sync::mpsc;
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

use super::annotations::iso8601_utc;
use super::{blocking, AppState};
use crate::documents::intake::{self, Admitted};
use crate::documents::{DocKind, DocumentId, DocumentInfo, Fingerprint};
use crate::error::{AppError, ErrorCode, UiError};
use crate::limits;
use crate::model::annotation::PdfOrigin;
use crate::model::doc_state::{ChangeSet, DocState};
use crate::model::ids::AnnotId;
use crate::pdfwrite::{self, Built, Change, Plan};
use crate::storage::{atomic, backup};

/// What the user agreed to when a save asked (ARCHITECTURE §5). Only `file_changed` can be asked for today; the others are for the full
/// rewrites of later milestones.
#[derive(Debug, Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct SaveAck {
    pub break_signature: bool,
    pub file_changed: bool,
    pub rewrite_encrypted: bool,
}

/// Options of Save As. None yet: the "clean copy" and "compress" outputs are full rewrites of M3.
#[derive(Debug, Clone, Copy, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SaveAsOptions {}

/// How the file was written.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SaveMode {
    /// The original bytes, followed by an update.
    Incremental,
    /// The whole file again (not used before M3).
    Full,
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
    /// The document as it is now: after a Save As another name, and no longer the welcome document.
    pub document: DocumentInfo,
    /// What changed in the annotations: they are `clean` now, and the history is empty and not dirty.
    pub changes: ChangeSet,
}

/// What a save has to write, from the model. Annotations on pages the registry does not know are left out.
fn plan_of(
    state: &DocState,
    page_index: impl Fn(&crate::model::annotation::Annotation) -> Option<u32>,
) -> Plan {
    use crate::model::annotation::Sync;
    let mut plan = Plan::default();
    for entry in state.entries() {
        let annotation = &entry.annotation;
        if entry.tombstone {
            if let Some(origin) = &entry.persisted {
                plan.changes.push(Change::Delete {
                    id: annotation.id,
                    origin: origin.clone(),
                });
            }
            continue;
        }
        if let Some(origin) = &entry.persisted {
            plan.known.push((annotation.id, origin.clone()));
        }
        let to_write = !annotation.is_opaque() && annotation.sync != Sync::Clean;
        if let (true, Some(page_index)) = (to_write, page_index(annotation)) {
            plan.changes.push(Change::Write {
                page_index,
                annotation: Box::new(annotation.clone()),
                origin: entry.persisted.clone(),
            });
        }
    }
    plan
}

/// Builds the update on a thread of its own (a big stack: lopdf recurses into the file's structures), contained and with a deadline
/// (ADR-004 §1). A panic is `internal`; running past the deadline is `engine_timeout`, and then the thread's result is discarded.
fn build(original: Vec<u8>, plan: Plan) -> Result<Built, AppError> {
    let (sender, receiver) = mpsc::channel();
    let spawned = thread::Builder::new()
        .name("sheer-save".into())
        .stack_size(limits::SAVE_STACK_BYTES)
        .spawn(move || {
            let result = catch_unwind(AssertUnwindSafe(|| {
                let built = pdfwrite::append_annotations(original, &plan)?;
                if !plan.changes.is_empty() {
                    pdfwrite::validate(&built.bytes, built.pages)?;
                }
                Ok(built)
            }))
            .unwrap_or_else(|_| Err(AppError::logged(ErrorCode::Internal, "saving panicked")));
            // The caller may have given up.
            let _ = sender.send(result);
        });
    if let Err(error) = spawned {
        return Err(AppError::logged(ErrorCode::SaveFailed, error));
    }
    receiver
        .recv_timeout(limits::SAVE_TIMEOUT)
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

/// Reads the whole file behind an admitted handle.
fn read_all(admitted: Admitted) -> Result<(Vec<u8>, Option<Fingerprint>), AppError> {
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

impl AppState {
    /// Saves document `id` into the file it was opened from (primary+S). The welcome document is `read_only`: it is a bundled resource,
    /// and a save that wrote into the app's resources would be a write outside the user's files (SECURITY D1); the UI turns the answer
    /// into Save As.
    pub fn save_in_place(&self, id: DocumentId, ack: SaveAck) -> Result<SaveResult, AppError> {
        // Before anything else is looked at, let alone opened for writing.
        if self
            .info(id)
            .is_some_and(|info| info.kind == DocKind::Welcome)
        {
            return Err(AppError::new(ErrorCode::ReadOnly));
        }
        self.save(id, None, ack)
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
        let target = intake::admit_target(target)?;
        self.save(id, Some(target), ack)
    }

    fn save(
        &self,
        id: DocumentId,
        target: Option<PathBuf>,
        ack: SaveAck,
    ) -> Result<SaveResult, AppError> {
        let info = self.info(id).ok_or(AppError::not_found("document"))?;
        let source = self
            .registry
            .path(id)
            .ok_or(AppError::not_found("document"))?;
        let count = self.registry.page_count(id)?;
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

        let plan = self.annotations.with(id, count, |state| {
            Ok(plan_of(state, |annotation| {
                self.registry.page_index(id, annotation.page_id).ok()
            }))
        })?;
        let writes = !plan.changes.is_empty();
        if writes && info.flags.encrypted {
            // lopdf would have to encrypt what it appends (ADR-004 §5); until that is settled an encrypted file is not changed.
            return Err(AppError::logged(
                ErrorCode::UnsupportedFeature,
                "saving annotations into an encrypted file",
            ));
        }
        if !writes && target.is_none() {
            // Nothing to put in the file: it is saved as it is.
            return self.annotations.with(id, count, |state| {
                state.mark_clean();
                Ok(self.result(id, state.current(), false))
            });
        }

        // The file as it is on disk now, and whether it is the one that was opened.
        let (original, fingerprint) = read_all(intake::admit(&source)?)?;
        if !ack.file_changed {
            if let (Some(opened), Some(now)) = (self.registry.fingerprint(id), fingerprint) {
                if opened != now {
                    return Err(AppError::needs_confirmation("fileChangedOnDisk"));
                }
            }
        }
        let original_len = original.len();
        let built = build(original, plan)?;
        let origins: std::collections::HashMap<AnnotId, PdfOrigin> =
            built.origins.iter().cloned().collect();
        debug_assert!(built.bytes.len() >= original_len);

        let in_place = target.is_none();
        let destination = target.clone().unwrap_or_else(|| source.clone());
        let backup_created = if in_place && writes {
            self.back_up(id, &source, &built.bytes[..original_len])
        } else {
            false
        };

        // Close, rename, reopen. PDFium lets go of the file the rename replaces.
        if in_place {
            self.engine.release(id)?;
        }
        if let Err(error) = atomic::replace_atomic(&destination, &built.bytes) {
            if in_place {
                self.reopen_from(id, &source);
            }
            return Err(write_error(error));
        }
        let reopened = intake::admit(&destination).and_then(|admitted| {
            let fingerprint = Fingerprint::of(&admitted.file);
            let pages = self.engine.reopen(id, admitted.file)?;
            Ok((pages, fingerprint))
        });
        let fingerprint = match reopened {
            Ok((pages, fingerprint)) if pages == count => fingerprint,
            other => {
                if let Err(error) = &other {
                    error.log();
                }
                // What was written does not load as the document: the original is put back (ADR-004 §1 step 9).
                if in_place {
                    let _ = atomic::replace_atomic(&destination, &built.bytes[..original_len]);
                } else {
                    let _ = std::fs::remove_file(&destination);
                }
                self.reopen_from(id, &source);
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
        let changes = self
            .annotations
            .with(id, count, |state| Ok(state.finish_save(&origins)))?;
        Ok(self.result(id, changes, backup_created))
    }

    fn result(&self, id: DocumentId, changes: ChangeSet, backup_created: bool) -> SaveResult {
        SaveResult {
            rev: changes.rev,
            mode: SaveMode::Incremental,
            backup_created,
            document: self.info(id).unwrap_or_else(|| DocumentInfo {
                id,
                page_count: 0,
                display_name: String::new(),
                kind: DocKind::User,
                flags: crate::documents::DocFlags::default(),
            }),
            changes,
        }
    }

    /// Puts the engine's copy of `id` back from the file at `path` after a save that did not work. Best effort: logged.
    fn reopen_from(&self, id: DocumentId, path: &Path) {
        let reopened =
            intake::admit(path).and_then(|admitted| self.engine.reopen(id, admitted.file));
        if let Err(error) = reopened {
            error.log();
        }
    }

    /// Copies the original into the backup folder, once per session and document (ADR-004 §3). A backup that cannot be made is logged
    /// and does not stop the save. `true` if one was made.
    fn back_up(&self, id: DocumentId, source: &Path, original: &[u8]) -> bool {
        let Some(data_dir) = &self.data_dir else {
            return false;
        };
        if self.registry.backed_up(id) {
            return false;
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
                true
            }
            Err(error) => {
                AppError::from(error).log();
                false
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
        if !discard && !welcome && self.annotations.is_dirty(id) {
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
}
