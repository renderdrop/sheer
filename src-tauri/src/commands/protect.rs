//! Password protection and permissions (ARCHITECTURE §5 "Edit and protect", ADR-047 §4). owned by package D.
//!
//! | Command | Arguments | Returns |
//! |---|---|---|
//! | `get_protection` | `docId` | `ProtectionInfo { encrypted, method, ownerRights, allow, pending }` |
//! | `stage_protection` | `docId`, `opts: { openPassword, permissionsPassword, allow }` | the `ChangeSet` (`doc: ["protection"]`); one undo step (`protect.set`), written by the next save |
//! | `stage_unprotection` | `docId`, `permissionsPassword?` | the `ChangeSet` (`protect.remove`); owner rights are checked now, a wrong password is `password_required` |
//!
//! The passwords are `Secret`s from the moment they are deserialized: never in a log, an error, the history or `Debug`. lopdf work runs
//! on the blocking pool.

use std::time::Instant;

use tauri::State;
use zeroize::Zeroizing;

use super::save::read_all;
use super::{blocking, AppState};
use crate::documents::{intake, DocumentId};
use crate::error::{AppError, ErrorCode, UiError};
use crate::model::command::DocCommand;
use crate::model::doc_state::ChangeSet;
use crate::model::protection::{
    self, PendingKind, PermissionSet, ProtectOptions, ProtectionInfo, ProtectionMethod,
};
use crate::pdfwrite::crypt::{self, ProtectionRead};
use crate::security::secret::{PendingProtection, Secret};

impl AppState {
    /// The file of document `id` as it is on disk, read through an admitted handle.
    fn file_bytes(&self, id: DocumentId) -> Result<Vec<u8>, AppError> {
        let path = self
            .registry
            .path(id)
            .ok_or(AppError::not_found("document"))?;
        Ok(read_all(intake::admit(&path)?)?.0)
    }

    /// The password document `id` was opened with, if one was needed.
    pub(super) fn session_password(&self, id: DocumentId) -> Option<Zeroizing<String>> {
        self.model(id, |state| Ok(state.secrets().session().map(str::to_owned)))
            .ok()
            .flatten()
            .map(Zeroizing::new)
    }

    /// How the file of document `id` is encrypted, read once and kept until the next save (`DocState.secrets`). Reads the file on the
    /// calling (blocking) thread, without holding the model.
    fn protection_facts(&self, id: DocumentId) -> Result<ProtectionRead, AppError> {
        let cached = self.model(id, |state| Ok(state.secrets().facts().cloned()))?;
        if let Some(facts) = cached {
            return Ok(facts);
        }
        let session = self.session_password(id);
        let bytes = self.file_bytes(id)?;
        let facts = crypt::read_protection_with(&bytes, session.as_ref().map(|s| s.as_str()))?;
        self.model(id, |state| {
            state.secrets_mut().set_facts(facts.clone());
            Ok(())
        })?;
        Ok(facts)
    }

    /// Remembers the password document `id` was opened with, for the saves that keep its encryption and the reopen after them.
    pub(super) fn note_session_password(
        &self,
        id: DocumentId,
        password: Option<Zeroizing<String>>,
    ) {
        let _ = self.model(id, |state| {
            state.secrets_mut().set_session(password);
            Ok(())
        });
    }

    /// Tells the engine what the open file's permissions allow an honest reader (`DocFlags.permissions`, ADR-047 §4): `None` for a
    /// file that is not encrypted or was opened with owner rights. Best effort: a failure is logged and leaves the document editable
    /// as it was.
    pub(super) fn refresh_permissions(&self, id: DocumentId) {
        let Some(info) = self.info(id) else {
            return;
        };
        let allow = if info.flags.encrypted {
            match self.protection_facts(id) {
                Ok(facts) => (!facts.owner_rights).then_some(facts.allow),
                Err(error) => {
                    error.log();
                    None
                }
            }
        } else {
            None
        };
        let _ = self.engine.set_permissions(id, allow);
    }

    /// How document `id` is protected now, and what is staged.
    pub fn get_protection(&self, id: DocumentId) -> Result<ProtectionInfo, AppError> {
        let info = self.info(id).ok_or(AppError::not_found("document"))?;
        let facts = if info.flags.encrypted {
            self.protection_facts(id)?
        } else {
            ProtectionRead {
                encrypted: false,
                method: ProtectionMethod::None,
                owner_rights: true,
                allow: PermissionSet::ALL,
            }
        };
        let pending = self.model(id, |state| {
            Ok(match state.pending_protection() {
                Some((_, PendingProtection::Protect { .. })) => PendingKind::Protect,
                Some((_, PendingProtection::Remove)) => PendingKind::Remove,
                None => PendingKind::None,
            })
        })?;
        Ok(ProtectionInfo {
            encrypted: facts.encrypted,
            method: facts.method,
            owner_rights: facts.owner_rights,
            allow: facts.allow.to_list(),
            pending,
        })
    }

    /// Stages a new protection as one undo step.
    pub fn stage_protection(
        &self,
        id: DocumentId,
        opts: ProtectOptions,
    ) -> Result<ChangeSet, AppError> {
        self.info(id).ok_or(AppError::not_found("document"))?;
        self.check_may_edit(id)?;
        let ticket = self.model(id, |state| protection::stage_protect(state, &opts))?;
        self.execute(id, DocCommand::SetProtection { ticket })
    }

    /// Stages the removal of the protection as one undo step. It needs owner rights, not the `edit` permission: a file that forbids
    /// editing is still the owner's to unlock, and `check_may_edit` would refuse exactly the person who may. The rights are the ones
    /// the file was opened with, or the permissions password given now (`password_required` if it is not the owner's).
    pub fn stage_unprotection(
        &self,
        id: DocumentId,
        permissions_password: Option<Secret>,
    ) -> Result<ChangeSet, AppError> {
        let info = self.info(id).ok_or(AppError::not_found("document"))?;
        let encrypted = info.flags.encrypted;
        if encrypted {
            let facts = self.protection_facts(id)?;
            if !facts.owner_rights {
                let Some(password) = &permissions_password else {
                    return Err(AppError::new(ErrorCode::PasswordRequired));
                };
                self.check_owner_password(id, password)?;
            }
        }
        let ticket = self.model(id, |state| protection::stage_remove(state, encrypted))?;
        self.execute(id, DocCommand::SetProtection { ticket })
    }

    /// `password_required` unless `password` is the owner password of the file (a wrong one is counted, and after the third each
    /// attempt waits a second, in Rust).
    fn check_owner_password(&self, id: DocumentId, password: &Secret) -> Result<(), AppError> {
        let wait = self.model(id, |state| Ok(state.secrets().wait(Instant::now())))?;
        if !wait.is_zero() {
            std::thread::sleep(wait);
        }
        let session = self.session_password(id);
        let bytes = self.file_bytes(id)?;
        let right =
            crypt::is_owner_password(&bytes, session.as_ref().map(|s| s.as_str()), password)?;
        self.model(id, |state| {
            if right {
                state.secrets_mut().note_right();
            } else {
                state.secrets_mut().note_wrong(Instant::now());
            }
            Ok(())
        })?;
        if right {
            Ok(())
        } else {
            Err(AppError::new(ErrorCode::PasswordRequired))
        }
    }
}

/// How the document is protected.
#[tauri::command]
pub async fn get_protection(
    state: State<'_, AppState>,
    doc_id: DocumentId,
) -> Result<ProtectionInfo, UiError> {
    let state = state.inner().clone();
    blocking(move || state.get_protection(doc_id)).await
}

/// Stages a password and permissions for the next save.
#[tauri::command]
pub async fn stage_protection(
    state: State<'_, AppState>,
    doc_id: DocumentId,
    opts: ProtectOptions,
) -> Result<ChangeSet, UiError> {
    let state = state.inner().clone();
    blocking(move || state.stage_protection(doc_id, opts)).await
}

/// Stages the removal of the password protection for the next save.
#[tauri::command]
pub async fn stage_unprotection(
    state: State<'_, AppState>,
    doc_id: DocumentId,
    permissions_password: Option<Secret>,
) -> Result<ChangeSet, UiError> {
    let state = state.inner().clone();
    blocking(move || state.stage_unprotection(doc_id, permissions_password)).await
}
