//! Export a copy (ARCHITECTURE §5 "Convert and output", ADR-049 §5).
//!
//! | Command | Arguments | Returns |
//! |---|---|---|
//! | `export_pdf` | `docId`, `opts: { annotations: keep \| flatten \| remove, removeMetadata }`, `ack: SaveAck`, `onEvent: Channel<JobEvent>` | `JobId`, or `null` (Save As cancelled); the open document and its path stay as they are, nothing opens |
//!
//! The copy is made from the snapshot of the document (what the user sees, unsaved edits included, never written to disk), always as a
//! whole new file with a new `/ID`, and written atomically to the file the Save As dialog of Rust gave. An encrypted document's copy is
//! encrypted again with the same key and passwords.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use tauri::ipc::Channel;
use tauri::{State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

use super::jobs::{channel_sink, file_stem, jobs, EventSink, JobDone, JobEvent, JobId};
use super::save::{fingerprint_changed, read_all, SaveAck};
use super::{blocking, AppState};
use crate::documents::intake;
use crate::documents::DocumentId;
use crate::error::{AppError, ErrorCode, UiError};
use crate::export::snapshot;
use crate::pdfwrite::crypt;
use crate::pdfwrite::export::{export_copy, PdfExportOptions};
use crate::pdfwrite::produce::{Control, Phase, Warning};
use crate::storage::atomic;

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

impl AppState {
    /// Asks for the target and starts the export of a copy of document `id`. The checks that can fail come before the dialog, so that a
    /// request that cannot run does not ask for a file name. `None` when the dialog was cancelled.
    pub fn start_export_pdf(
        &self,
        window: &WebviewWindow,
        id: DocumentId,
        opts: &PdfExportOptions,
        ack: SaveAck,
        sink: Arc<dyn EventSink>,
    ) -> Result<Option<JobId>, AppError> {
        let stem = self.check_export(id, opts, ack)?;
        let dialog = window
            .dialog()
            .file()
            .set_parent(window)
            .add_filter("PDF", &["pdf"])
            .set_file_name(format!("{stem} copy.pdf"));
        let Some(chosen) = dialog.blocking_save_file() else {
            return Ok(None);
        };
        let path: PathBuf = chosen
            .into_path()
            .map_err(|error| AppError::logged(ErrorCode::Internal, error))?;
        self.start_export_pdf_to(id, opts, ack, &path, sink)
            .map(Some)
    }

    /// What has to hold before a copy is asked for: the document exists, the restrictions of its file allow the options, an encrypted
    /// file is rewritten with the say of the user. Answers the stem of the display name.
    fn check_export(
        &self,
        id: DocumentId,
        opts: &PdfExportOptions,
        ack: SaveAck,
    ) -> Result<String, AppError> {
        let info = self.info(id).ok_or(AppError::not_found("document"))?;
        if opts.changes_content() {
            self.check_may_edit(id)?;
        }
        if info.flags.encrypted && !ack.rewrite_encrypted {
            return Err(AppError::needs_confirmation("rewriteEncrypted"));
        }
        Ok(file_stem(&info.display_name))
    }

    /// [`AppState::start_export_pdf`] with the target chosen: judged by [`intake::admit_target`], never a document that is open.
    pub fn start_export_pdf_to(
        &self,
        id: DocumentId,
        opts: &PdfExportOptions,
        ack: SaveAck,
        target: &Path,
        sink: Arc<dyn EventSink>,
    ) -> Result<JobId, AppError> {
        self.check_export(id, opts, ack)?;
        let target = intake::admit_target(target)?;
        let source = self
            .registry
            .path(id)
            .ok_or(AppError::not_found("document"))?;
        let same =
            std::fs::canonicalize(&source).map_or(source == target, |source| source == target);
        if same || self.registry.is_open_path(&target) {
            return Err(AppError::invalid("exportTarget"));
        }
        let state = self.clone();
        let opts = *opts;
        jobs().start(sink, move |ctx| state.run_export(id, &opts, &target, ctx))
    }

    /// The job: snapshot, copy, write.
    fn run_export(
        &self,
        id: DocumentId,
        opts: &PdfExportOptions,
        target: &Path,
        ctx: &dyn Control,
    ) -> Result<JobDone, AppError> {
        ctx.check()?;
        ctx.progress(Phase::Snapshot, 0, 1);
        let info = self.info(id).ok_or(AppError::not_found("document"))?;
        let source = self
            .registry
            .path(id)
            .ok_or(AppError::not_found("document"))?;
        let snapshot = snapshot::current_bytes(self, id)?;
        // An encrypted document: the file's own encryption (key, passwords) is what the copy gets again, so the file is read for it
        // even when the snapshot holds the plain current state.
        let mut plain: Option<Vec<u8>> = None;
        let mut state = None;
        if snapshot.is_none() || info.flags.encrypted {
            let (file, fingerprint) = read_all(intake::admit(&source)?)?;
            if fingerprint_changed(self.registry.fingerprint(id), fingerprint) {
                return Err(AppError::needs_confirmation("fileChangedOnDisk"));
            }
            if info.flags.encrypted {
                let session = self.session_password(id);
                let (decrypted, kept) =
                    crypt::decrypt_for_rewrite(&file, session.as_ref().map(|s| s.as_str()))?;
                plain = Some(decrypted);
                state = kept;
            } else {
                plain = Some(file);
            }
        }
        ctx.progress(Phase::Snapshot, 1, 1);
        let exported = {
            let input: &[u8] = match (&snapshot, &plain) {
                (Some(bytes), _) => bytes,
                (None, Some(plain)) => plain,
                (None, None) => return Err(AppError::new(ErrorCode::Internal)),
            };
            export_copy(input, opts, state.is_some(), ctx).map(|exported| (input.len(), exported))
        };
        let (before, exported) = exported?;
        drop(plain);
        let mut warnings = exported.warnings;
        let bytes = match &state {
            Some(kept) => crypt::encrypt_again(&exported.bytes, kept)?,
            None => exported.bytes,
        };
        // The copy is written whole, so what a signature covered is not what the file is: it no longer verifies.
        if info.flags.signed && !warnings.contains(&Warning::SignaturesRemoved) {
            warnings.push(Warning::SignaturesRemoved);
        }
        ctx.check()?;
        atomic::replace_atomic(target, &bytes).map_err(write_error)?;
        Ok(JobDone {
            outputs: 1,
            bytes_before: before as u64,
            bytes_after: bytes.len() as u64,
            warnings,
            ..JobDone::default()
        })
    }
}

/// Writes a copy of the document as it is now, with or without annotations and metadata, to a file chosen in Rust's Save As dialog.
#[tauri::command]
pub async fn export_pdf(
    window: WebviewWindow,
    state: State<'_, AppState>,
    doc_id: DocumentId,
    opts: PdfExportOptions,
    ack: SaveAck,
    on_event: Channel<JobEvent>,
) -> Result<Option<JobId>, UiError> {
    let state = state.inner().clone();
    blocking(move || state.start_export_pdf(&window, doc_id, &opts, ack, channel_sink(on_event)))
        .await
}
