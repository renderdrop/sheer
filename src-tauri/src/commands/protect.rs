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

use tauri::State;

use super::{blocking, AppState};
use crate::documents::DocumentId;
use crate::error::{AppError, UiError};
use crate::model::command::DocCommand;
use crate::model::doc_state::ChangeSet;
use crate::model::protection::{self, ProtectOptions, ProtectionInfo};
use crate::security::secret::Secret;

impl AppState {
    /// How document `id` is protected now, and what is staged. Package D.
    pub fn get_protection(&self, id: DocumentId) -> Result<ProtectionInfo, AppError> {
        self.info(id).ok_or(AppError::not_found("document"))?;
        Err(AppError::not_yet())
    }

    /// Stages a new protection as one undo step. Package D.
    pub fn stage_protection(
        &self,
        id: DocumentId,
        opts: ProtectOptions,
    ) -> Result<ChangeSet, AppError> {
        self.info(id).ok_or(AppError::not_found("document"))?;
        self.check_may_edit(id)?;
        let ticket = self.model(id, |state| protection::stage(state, Some(&opts), None))?;
        self.execute(id, DocCommand::SetProtection { ticket })
    }

    /// Stages the removal of the protection as one undo step. Package D.
    pub fn stage_unprotection(
        &self,
        id: DocumentId,
        permissions_password: Option<Secret>,
    ) -> Result<ChangeSet, AppError> {
        self.info(id).ok_or(AppError::not_found("document"))?;
        let ticket = self.model(id, |state| {
            protection::stage(state, None, permissions_password.as_ref())
        })?;
        self.execute(id, DocCommand::SetProtection { ticket })
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
