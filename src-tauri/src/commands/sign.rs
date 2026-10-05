//! Signing a document (ADR-121 section 1, ARCHITECTURE section 5 "Certificate signatures (v1.4)").
//!
//! | Command | Arguments | Returns |
//! |---|---|---|
//! | `sign_document` | `docId: number`, `request: SignRequest` | `SaveResult \| null` (`null` = the save dialog was cancelled) |
//!
//! PAdES B-B: the file is the current one plus ONE appended revision (`pdfwrite::sign`), written to a new file the user picks in a Rust
//! save dialog (default `<stem> (signed).pdf`; the open file itself is allowed, atomically). Never a Full save, and the original bytes
//! stay byte-identical. The key is read for this one call (`commands::identities::signer_material`) and never crosses IPC (SECURITY I18).
//!
//! The document must be clean (`unsaved_changes`), unchanged on disk (`needs_confirmation` `fileChangedOnDisk`), not encrypted
//! (`unsupported_feature` `signEncrypted`) and without XFA (`unsupported_feature` `xfa`); a document that a certification signature
//! locks answers `read_only` `certified`; an expired certificate `invalid_argument` `identityExpired`.
//!
//! The answer is a `SaveResult`: for the open file itself the document as it is now (reloaded, history empty, the lock refreshed); for
//! another file the new document that was opened from it (its `document.id` differs from `docId`), and the original document keeps its
//! state. Cancelling the dialog or a failure writes nothing and changes nothing.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::SystemTime;

use tauri::{Manager, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

use super::identities::{signer_material, IdentitiesState};
use super::library::LibraryState;
use super::save::{fingerprint_changed, read_all, SaveMode, SaveResult};
use super::{blocking, AppState};
use crate::documents::intake;
use crate::documents::{DocKind, DocumentId, Fingerprint};
use crate::error::{AppError, ErrorCode, UiError};
use crate::limits;
use crate::menu::spec::MenuLocale;
use crate::pdfsig::cms_build;
use crate::pdfsig::material::SignerMaterial;
use crate::pdfsig::types::SignRequest;
use crate::pdfwrite::seal::{REASON_DE, REASON_EN, SIGNED_DE, SIGNED_EN};
use crate::pdfwrite::sign::{self, clean_text, SignPlan, Stamp};
use crate::signatures::Art;
use crate::storage::{atomic, backup};

/// What the seal and the dialog say, in the language of the interface.
struct Words {
    signed: &'static str,
    reason: &'static str,
    file_suffix: &'static str,
}

fn words(locale: MenuLocale) -> Words {
    match locale {
        MenuLocale::En => Words {
            signed: SIGNED_EN,
            reason: REASON_EN,
            file_suffix: "signed",
        },
        MenuLocale::De => Words {
            signed: SIGNED_DE,
            reason: REASON_DE,
            file_suffix: "signiert",
        },
    }
}

/// The name the save dialog proposes: `<stem> (signed).pdf`.
fn default_file_name(display_name: &str, locale: MenuLocale) -> String {
    let stem = display_name
        .strip_suffix(".pdf")
        .or_else(|| display_name.strip_suffix(".PDF"))
        .unwrap_or(display_name);
    let stem = if stem.is_empty() { "Document" } else { stem };
    format!("{stem} ({}).pdf", words(locale).file_suffix)
}

/// What [`AppState::sign_into`] needs besides the document: everything that was decided or looked up before.
pub struct SignJob {
    pub request: SignRequest,
    pub material: SignerMaterial,
    /// The art of the seal, if the request names one.
    pub art: Option<Art>,
    pub locale: MenuLocale,
    pub stamp: Stamp,
    pub now: SystemTime,
}

impl AppState {
    /// The art the request names, resolved to a copy that the seal draws (the same lookup the visual signatures use).
    pub fn seal_art(
        &self,
        doc_id: DocumentId,
        request: &SignRequest,
        library: &LibraryState,
    ) -> Result<Option<Art>, AppError> {
        let Some(reference) = &request.art else {
            return Ok(None);
        };
        let asset = self.use_signature(doc_id, reference, Some(library))?;
        let art = self.model(doc_id, |state| {
            state
                .assets()
                .get(asset.asset_id)
                .cloned()
                .ok_or_else(|| AppError::not_found("asset"))
        })?;
        Ok(Some((*art).clone()))
    }

    /// What can be refused before the user is asked for a file: the state of the document and the request.
    pub fn check_signable(&self, id: DocumentId, request: &SignRequest) -> Result<(), AppError> {
        let info = self.info(id).ok_or(AppError::not_found("document"))?;
        if info.kind != DocKind::User {
            return Err(AppError::new(ErrorCode::ReadOnly));
        }
        if self.has_unsaved_changes(id) {
            return Err(AppError::new(ErrorCode::UnsavedChanges));
        }
        if info.flags.encrypted {
            return Err(AppError::unsupported("signEncrypted"));
        }
        let hybrid_or_full = self.model(id, |state| {
            Ok(state
                .form()
                .is_some_and(|form| form.xfa() != crate::model::form::Xfa::None))
        })?;
        if hybrid_or_full {
            return Err(AppError::unsupported("xfa"));
        }
        if info.signature_lock == crate::pdfsig::types::SignatureLock::Locked {
            return Err(AppError::read_only("certified"));
        }
        clean_text(request.reason.as_deref(), limits::SEAL_REASON_MAX, "reason")?;
        clean_text(
            request.location.as_deref(),
            limits::SEAL_LOCATION_MAX,
            "location",
        )?;
        Ok(())
    }

    /// Signs document `id` into `target` (a path from the save dialog, judged by `intake::admit_target`) and answers as the module
    /// documentation says. Blocking.
    pub fn sign_into(
        &self,
        id: DocumentId,
        target: &Path,
        job: SignJob,
    ) -> Result<SaveResult, AppError> {
        self.check_signable(id, &job.request)?;
        let SignJob {
            request,
            material,
            art,
            locale,
            stamp,
            now,
        } = job;
        let target = intake::admit_target(target)?;
        let target = std::fs::canonicalize(&target).unwrap_or(target);
        let source = self
            .registry
            .path(id)
            .ok_or(AppError::not_found("document"))?;
        let in_place = target == source;
        if !in_place && self.registry.is_open_elsewhere(id, &target) {
            return Err(AppError::new(ErrorCode::IoInUse));
        }

        // Where the seal goes, as a position in the file (the model is clean, so the page list is the file's).
        let plan_pages = self.model(id, |state| Ok(state.page_plan()))?;
        if plan_pages.changed() {
            return Err(AppError::new(ErrorCode::UnsavedChanges));
        }
        let expected = u32::try_from(plan_pages.pages.len())
            .map_err(|_| AppError::new(ErrorCode::Internal))?;
        let placement = match &request.placement {
            Some(placement) => {
                let index = plan_pages
                    .pages
                    .iter()
                    .position(|page| page.id == placement.page_id)
                    .and_then(|index| u32::try_from(index).ok())
                    .ok_or(AppError::invalid("placement"))?;
                Some((index, placement.rect))
            }
            None => None,
        };

        // The file as it is on disk now, and whether it is the one that was opened.
        let (original, read_fingerprint) = read_all(intake::admit(&source)?)?;
        if fingerprint_changed(self.registry.fingerprint(id), read_fingerprint) {
            return Err(AppError::needs_confirmation("fileChangedOnDisk"));
        }

        // The key is used here and nowhere else; it is dropped with `material` at the end of this block.
        cms_build::check_valid_at(&material, now)?;
        let name = cms_build::signer_name(&material).ok_or(AppError::invalid("identity"))?;
        let reason = clean_text(request.reason.as_deref(), limits::SEAL_REASON_MAX, "reason")?;
        let location = clean_text(
            request.location.as_deref(),
            limits::SEAL_LOCATION_MAX,
            "location",
        )?;
        let words = words(locale);
        let signed_bytes = {
            let plan = SignPlan {
                placement,
                name,
                signed_at: stamp.pdf.clone(),
                date_line: stamp.seal.clone(),
                signed_label: words.signed.to_owned(),
                reason_line: reason
                    .as_ref()
                    .map(|reason| words.reason.replace("{reason}", reason)),
                reason,
                location,
                art,
                lock: request.lock,
                contents_len: cms_build::contents_capacity(&material)?,
            };
            let doc = crate::pdfwrite::load_untrusted(&original)?;
            let prepared = sign::prepare(original.clone(), doc, &plan)?;
            let digest = cms_build::digest_ranges(&prepared.bytes, &prepared.gap)?;
            let cms = cms_build::sign(&digest, &material)?;
            drop(material);
            sign::finish(prepared, &cms)?
        };
        // What was made must be a PDF with the same pages, and the old bytes must still be the first ones.
        crate::pdfwrite::validate(&signed_bytes, expected)?;
        if signed_bytes.get(..original.len()) != Some(original.as_slice()) {
            return Err(AppError::logged(
                ErrorCode::SaveFailed,
                "the signed file does not start with the original",
            ));
        }

        if in_place {
            self.sign_in_place(id, &source, &original, &signed_bytes, expected)
        } else {
            self.sign_to_new_file(&target, &signed_bytes)
        }
    }

    /// The signed file replaces the open one: PDFium lets go of it for the rename and loads the result again under the same id; if that
    /// does not work the original is put back.
    fn sign_in_place(
        &self,
        id: DocumentId,
        source: &Path,
        original: &[u8],
        signed: &[u8],
        expected: u32,
    ) -> Result<SaveResult, AppError> {
        let _guard = self.autosave_save_guard();
        let mut backup_created = false;
        if let Some(data_dir) = &self.data_dir {
            if !self.registry.backed_up(id) {
                let directory = data_dir.join("backups");
                let stamp = Stamp::now().pdf.replace([':', '\'', '+', '-'], "");
                match backup::write_backup(&directory, &stamp, source, original) {
                    Ok(_) => {
                        self.registry.set_backed_up(id, true);
                        backup_created = true;
                    }
                    Err(error) => AppError::from(error).log(),
                }
            }
        }
        if self.changed_since_read(id, source)? {
            return Err(AppError::needs_confirmation("fileChangedOnDisk"));
        }
        self.engine.release(id)?;
        if let Err(error) = atomic::replace_atomic(source, signed) {
            self.reopen_after_failure(id, source);
            return Err(AppError::logged(ErrorCode::SaveFailed, error));
        }
        let reopened = intake::admit(source).and_then(|admitted| {
            let fingerprint = Fingerprint::of(&admitted.file);
            let pages = self.engine.reopen(id, admitted.file)?;
            Ok((pages, fingerprint))
        });
        let fingerprint = match reopened {
            Ok((pages, fingerprint)) if pages == expected => fingerprint,
            other => {
                if let Err(error) = &other {
                    error.log();
                }
                if let Err(error) = atomic::replace_atomic(source, original) {
                    AppError::logged(ErrorCode::SaveFailed, error).log();
                }
                self.reopen_after_failure(id, source);
                return Err(AppError::logged(
                    ErrorCode::SaveFailed,
                    "the signed file did not load again",
                ));
            }
        };
        self.registry.set_fingerprint(id, fingerprint);
        // Appended widgets come after every earlier annotation, so the model's positions stay right; the history is dropped.
        let changes = self.model(id, |state| Ok(state.finish_save(&HashMap::new())))?;
        self.refresh_signature_lock(id);
        self.cache_thumbnail(id);
        Ok(SaveResult {
            rev: changes.rev,
            mode: SaveMode::Incremental,
            backup_created,
            warnings: Vec::new(),
            document: self.info(id).ok_or(AppError::not_found("document"))?,
            changes,
        })
    }

    /// The signed file is a new one: written atomically, then opened as a document of its own. The original document is not touched.
    fn sign_to_new_file(&self, target: &Path, signed: &[u8]) -> Result<SaveResult, AppError> {
        atomic::replace_atomic(target, signed)
            .map_err(|error| AppError::logged(ErrorCode::SaveFailed, error))?;
        let document = match self.open_path(PathBuf::from(target)) {
            Ok(Some(document)) => document,
            other => {
                let _ = std::fs::remove_file(target);
                return Err(match other {
                    Err(error) => error,
                    _ => AppError::logged(ErrorCode::SaveFailed, "the signed file did not open"),
                });
            }
        };
        let changes = self.model(document.id, |state| Ok(state.current()))?;
        Ok(SaveResult {
            rev: changes.rev,
            mode: SaveMode::Incremental,
            backup_created: false,
            warnings: Vec::new(),
            document,
            changes,
        })
    }

    /// Whether the file of `id` is not what it was when it was opened.
    fn changed_since_read(&self, id: DocumentId, source: &Path) -> Result<bool, AppError> {
        let now = Fingerprint::of(&intake::admit(source)?.file);
        Ok(fingerprint_changed(self.registry.fingerprint(id), now))
    }

    /// Puts the engine's copy of `id` back from the file at `path` after a write that did not work. Best effort: logged.
    fn reopen_after_failure(&self, id: DocumentId, path: &Path) {
        let reopened =
            intake::admit(path).and_then(|admitted| self.engine.reopen(id, admitted.file));
        if let Err(error) = reopened {
            error.log();
        }
    }
}

/// Signs document `doc_id` into a file the user picks. `null` if the user cancelled the dialog.
#[tauri::command]
pub async fn sign_document(
    window: WebviewWindow,
    state: State<'_, AppState>,
    identities: State<'_, IdentitiesState>,
    library: State<'_, LibraryState>,
    doc_id: DocumentId,
    request: SignRequest,
) -> Result<Option<SaveResult>, UiError> {
    let state = state.inner().clone();
    let identities = Arc::clone(identities.inner());
    let library = Arc::clone(library.inner());
    blocking(move || {
        let locale = crate::menu::ui_locale(window.app_handle());
        // Refused before the user is asked for a file.
        state.check_signable(doc_id, &request)?;
        let info = state.info(doc_id).ok_or(AppError::not_found("document"))?;
        let dialog = window
            .dialog()
            .file()
            .set_parent(&window)
            .add_filter("PDF", &["pdf"])
            .set_file_name(default_file_name(&info.display_name, locale));
        let Some(chosen) = dialog.blocking_save_file() else {
            return Ok(None);
        };
        let path = chosen
            .into_path()
            .map_err(|error| AppError::logged(ErrorCode::Internal, error))?;
        // The key is loaded now, after the dialog: it lives for this one signature.
        let material = signer_material(&identities, &request.identity_id)?;
        let art = state.seal_art(doc_id, &request, &library)?;
        let job = SignJob {
            request,
            material,
            art,
            locale,
            stamp: Stamp::now(),
            now: SystemTime::now(),
        };
        state.sign_into(doc_id, &path, job).map(Some)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_dialog_proposes_the_stem_with_signed_in_the_language() {
        assert_eq!(
            default_file_name("Report.pdf", MenuLocale::En),
            "Report (signed).pdf"
        );
        assert_eq!(
            default_file_name("Bericht", MenuLocale::De),
            "Bericht (signiert).pdf"
        );
        assert_eq!(
            default_file_name(".pdf", MenuLocale::En),
            "Document (signed).pdf"
        );
    }
}
