// owned by package B2
//! Crash recovery (ARCHITECTURE section 5 "Ship (M7)", ADR-053 section 2).
//!
//! | Command | Arguments | Returns |
//! |---|---|---|
//! | `list_recoveries` | none | `RecoveryEntry[]` of dead sessions |
//! | `restore_recovery` | `id: RecoveryId` | `AppEvent` (`opened`, `needsPassword`, `openFailed`), the document as `DocKind::Recovered` |
//! | `discard_recovery` | `id: RecoveryId` | nothing; the record is never listed again (its files wait in the trash until exit) |
//! | `undo_discard_recovery` | `id: RecoveryId` | nothing; lists the record again, `not_found` when it is gone |
//! | `discard_all_recoveries` | none | how many were removed |
//!
//! Every answer names a record by a session-scoped [`RecoveryId`], never by path. This module also holds the `AppState` side of autosave:
//! the timer round that feeds `storage::autosave` with snapshot bytes, and the hooks of save and close.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use super::{blocking, AppState, Opened};
use crate::documents::{DocKind, DocumentId};
use crate::error::{AppError, ErrorCode, UiError};
use crate::events::AppEvent;
use crate::export::snapshot;
pub use crate::storage::autosave::OriginalState;
use crate::storage::autosave::{Autosave, AutosaveStatus, SaveGuard, Snapshot, Written};

/// Names one recovery record for the lifetime of the app session; not a path, not stable across runs.
pub type RecoveryId = u32;

/// How often the timer looks at the open documents.
const TICK: Duration = Duration::from_secs(5);

/// A document the last session left behind.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryEntry {
    pub id: RecoveryId,
    pub display_name: String,
    /// ISO 8601, UTC.
    pub saved_at: String,
    pub page_count: u32,
    pub original: OriginalState,
    /// Not shown by an earlier start: the banner appears only when at least one entry is fresh.
    pub fresh: bool,
}

impl AppState {
    /// Hands the session's autosave to the state. `false` when it has one already.
    pub fn attach_autosave(&self, autosave: Arc<Autosave>) -> bool {
        self.autosave.set(autosave).is_ok()
    }

    /// The session's autosave, where there is one.
    pub fn autosave(&self) -> Option<&Arc<Autosave>> {
        self.autosave.get()
    }

    /// What `DocumentInfo.autosave` says about `id`.
    pub(super) fn autosave_status_of(&self, id: DocumentId) -> AutosaveStatus {
        self.autosave
            .get()
            .map_or(AutosaveStatus::Clean, |autosave| autosave.status_of(id))
    }

    /// A save or close of `id` is done: its records go (and the one a recovered document came from).
    pub(super) fn autosave_forget(&self, id: DocumentId) {
        if let Some(autosave) = self.autosave.get() {
            autosave.forget(id);
        }
    }

    /// Held while a save runs: no autosave write starts meanwhile.
    pub(super) fn autosave_save_guard(&self) -> Option<SaveGuard> {
        self.autosave.get().map(Autosave::begin_save)
    }

    /// The folder a save dialog for a copy of `id` opens in (ADR-123): the folder of the file the document came from, for a recovered
    /// document the folder of its original. `None` (the dialog's own last folder) when it is unknown or gone. Never sent to the UI.
    pub(super) fn source_dir(&self, id: DocumentId) -> Option<PathBuf> {
        let own = self
            .info(id)
            .filter(|info| info.kind == crate::documents::DocKind::User)
            .and_then(|_| self.registry.path(id))
            .and_then(|path| path.parent().map(PathBuf::from));
        own.or_else(|| self.autosave_original_dir(id))
            .filter(|dir| dir.is_dir())
    }

    /// The folder a recovered document's original was in, for the Save As dialog; never sent to the UI.
    pub(super) fn autosave_original_dir(&self, id: DocumentId) -> Option<PathBuf> {
        self.autosave.get()?.original_dir(id)
    }

    /// One round of the timer at `now`: looks at every open document and writes the ones that are due. Answers how many were written.
    pub fn autosave_tick(&self, now: Instant) -> usize {
        self.autosave_round(now, false)
    }

    /// The window lost focus: writes every document with changes that are not written yet.
    pub fn autosave_flush(&self, now: Instant) -> usize {
        self.autosave_round(now, true)
    }

    fn autosave_round(&self, now: Instant, force: bool) -> usize {
        let Some(autosave) = self.autosave.get() else {
            return 0;
        };
        let Some(_run) = autosave.begin_run() else {
            return 0;
        };
        for id in self.registry.open_ids() {
            self.autosave_observe(autosave, id, now);
        }
        let ids = if force {
            autosave.unwritten_all()
        } else {
            autosave.due(now)
        };
        let mut written = 0;
        for id in ids {
            // One at a time, and never during a save.
            if autosave.saving() {
                break;
            }
            if self.registry.kind(id).is_none() {
                autosave.clear_own(id);
                continue;
            }
            match self.autosave_write(autosave, id) {
                Ok(true) => written += 1,
                Ok(false) => {}
                // Logged, never a banner (ADR-053 section 2).
                Err(error) => error.log(),
            }
        }
        written
    }

    /// Decides what autosave does with `id` now: nothing to protect, withheld (encrypted or a protection change is staged), or tracked.
    fn autosave_observe(&self, autosave: &Autosave, id: DocumentId, now: Instant) {
        let Some(info) = self.info(id) else {
            return;
        };
        // The bundled tour sample is a throw-away: there is nothing of the user's in it.
        if info.kind == DocKind::Welcome {
            return;
        }
        if !self.annotations.is_dirty(id) {
            autosave.settle_clean(id);
            return;
        }
        let Ok((rev, pending)) = self.model(id, |state| {
            Ok((state.rev(), state.pending_protection().is_some()))
        }) else {
            return;
        };
        if info.flags.encrypted || pending {
            autosave.withhold(id);
            return;
        }
        autosave.observe(id, rev, now);
        if autosave.status_of(id) == AutosaveStatus::Clean {
            autosave.set_status(id, AutosaveStatus::On);
        }
    }

    /// Writes the snapshot of `id`. `true` when a record was written.
    fn autosave_write(&self, autosave: &Autosave, id: DocumentId) -> Result<bool, AppError> {
        let info = self.info(id).ok_or(AppError::not_found("document"))?;
        let rev = autosave
            .observed_rev(id)
            .ok_or(AppError::not_found("document"))?;
        let bytes = match snapshot::current_bytes(self, id) {
            Ok(Some(bytes)) => bytes,
            Ok(None) => {
                autosave.settle_clean(id);
                return Ok(false);
            }
            Err(error) if error.code() == ErrorCode::LimitExceeded => {
                autosave.mark_too_large(id, rev);
                return Ok(false);
            }
            Err(error) => {
                autosave.note_failed(id, rev);
                return Err(error);
            }
        };
        let original = autosave.original_of(id).or_else(|| self.registry.path(id));
        let written = autosave.write(&Snapshot {
            id,
            rev,
            bytes: &bytes,
            display_name: &info.display_name,
            original: original.as_deref(),
            page_count: self.registry.page_count(id).unwrap_or(info.page_count),
        });
        match written {
            Ok(Written::Done) => Ok(true),
            Ok(Written::TooLarge) => Ok(false),
            Err(error) => {
                autosave.note_failed(id, rev);
                Err(error)
            }
        }
    }

    /// The records of dead sessions (newest first). Without an autosave there are none.
    pub fn list_recoveries(&self) -> Result<Vec<RecoveryEntry>, AppError> {
        let Some(autosave) = self.autosave.get() else {
            return Ok(Vec::new());
        };
        let views = autosave.list();
        // Showing marks them: the next start lists the records again (Decide later keeps them) but without a banner of its own.
        autosave.mark_shown();
        Ok(views
            .into_iter()
            .map(|view| RecoveryEntry {
                fresh: view.fresh,
                id: view.id,
                display_name: view.display_name,
                saved_at: super::annotations::iso8601_utc(view.saved_at),
                page_count: view.page_count,
                original: view.original,
            })
            .collect())
    }

    /// Opens record `id` through intake as `DocKind::Recovered`: a copy in this session's directory is what is opened, the record stays
    /// until the document is saved (as another file) or closed. A record that is open already answers with its document.
    pub fn restore_recovery(&self, id: RecoveryId) -> Result<AppEvent, AppError> {
        let autosave = self.autosave.get().ok_or(AppError::not_found("recovery"))?;
        if let Some(open) = autosave
            .restored_doc(id)
            .and_then(|document| self.info(document))
        {
            return Ok(AppEvent::opened(open));
        }
        let staged = autosave.stage_restore(id)?;
        let opened = self.open_as(
            staged.path.clone(),
            DocKind::Recovered,
            Some(staged.display_name.clone()),
        );
        Ok(match opened {
            Ok(Opened::Ready(info)) => {
                autosave.adopt(info.id, &staged);
                AppEvent::opened(info)
            }
            // A snapshot is never encrypted: a record that asks for a password is not ours.
            Ok(Opened::Locked { id: document, .. }) => {
                self.registry.remove_locked(document);
                autosave.unstage(&staged);
                autosave.quarantine_dead(id);
                AppEvent::open_failed(AppError::new(ErrorCode::DamagedFile))
            }
            Ok(Opened::Pending) => AppEvent::open_failed(AppError::new(ErrorCode::Internal)),
            Err(error) => {
                autosave.unstage(&staged);
                if matches!(error.code(), ErrorCode::DamagedFile | ErrorCode::NotAPdf) {
                    autosave.quarantine_dead(id);
                }
                AppEvent::open_failed(error)
            }
        })
    }

    /// Deletes record `id`; `not_found` (`recovery`) for an id that is not listed.
    pub fn discard_recovery(&self, id: RecoveryId) -> Result<(), AppError> {
        self.autosave
            .get()
            .ok_or(AppError::not_found("recovery"))?
            .discard(id)
    }

    /// Takes a discard back while the session lives.
    pub fn undo_discard_recovery(&self, id: RecoveryId) -> Result<(), AppError> {
        self.autosave
            .get()
            .ok_or(AppError::not_found("recovery"))?
            .undo_discard(id)
    }

    /// Deletes every record and answers how many there were.
    pub fn discard_all_recoveries(&self) -> Result<u32, AppError> {
        Ok(self
            .autosave
            .get()
            .map_or(0, |autosave| autosave.discard_all()))
    }
}

/// The hook of `storage::autosave::start`: takes the session lock under the app data directory, hands the autosave to the managed
/// `AppState` and starts the timer. A failure is logged and leaves the app without autosave, never without a window.
pub fn start_autosave(app: &AppHandle) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let Ok(data_dir) = app.path().app_data_dir() else {
        return;
    };
    let autosave = match Autosave::start(&data_dir) {
        Ok(autosave) => Arc::new(autosave),
        Err(error) => {
            error.log();
            return;
        }
    };
    if !state.attach_autosave(autosave) {
        return;
    }
    let state = state.inner().clone();
    let timer = std::thread::Builder::new()
        .name("sheer-autosave".to_owned())
        .spawn(move || loop {
            std::thread::sleep(TICK);
            let round = state.clone();
            // A panic in one round must not end autosave for the session.
            let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
                round.autosave_tick(Instant::now())
            }));
            if outcome.is_err() {
                // The payload is not logged: it could carry document text. The panic hook has printed the location.
                AppError::logged(ErrorCode::Internal, "autosave round panicked").log();
            }
        });
    if let Err(error) = timer {
        AppError::logged(ErrorCode::Internal, error).log();
    }
}

/// Normal quit: the session's directory is removed.
pub fn stop_autosave(app: &AppHandle) {
    if let Some(autosave) = app
        .try_state::<AppState>()
        .and_then(|state| state.autosave().cloned())
    {
        autosave.shutdown();
    }
}

/// The window lost focus: what is not written yet is, on a thread of its own.
pub fn autosave_on_blur(app: &AppHandle) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    if state.autosave().is_none() {
        return;
    }
    let state = state.inner().clone();
    // Best effort: when no thread can be made the timer writes it a little later.
    let _ = std::thread::Builder::new()
        .name("sheer-autosave-blur".to_owned())
        .spawn(move || {
            state.autosave_flush(Instant::now());
        });
}

/// The documents a crashed session left behind, newest first.
#[tauri::command]
pub async fn list_recoveries(state: State<'_, AppState>) -> Result<Vec<RecoveryEntry>, UiError> {
    let state = state.inner().clone();
    blocking(move || state.list_recoveries()).await
}

/// Opens a recovered document; Save then acts as Save As.
#[tauri::command]
pub async fn restore_recovery(
    state: State<'_, AppState>,
    id: RecoveryId,
) -> Result<AppEvent, UiError> {
    let state = state.inner().clone();
    blocking(move || state.restore_recovery(id)).await
}

/// Deletes one record.
#[tauri::command]
pub async fn discard_recovery(state: State<'_, AppState>, id: RecoveryId) -> Result<(), UiError> {
    let state = state.inner().clone();
    blocking(move || state.discard_recovery(id)).await
}

/// Takes a discard back (the Undo of the toast).
#[tauri::command]
pub async fn undo_discard_recovery(
    state: State<'_, AppState>,
    id: RecoveryId,
) -> Result<(), UiError> {
    let state = state.inner().clone();
    blocking(move || state.undo_discard_recovery(id)).await
}

/// Deletes every record.
#[tauri::command]
pub async fn discard_all_recoveries(state: State<'_, AppState>) -> Result<u32, UiError> {
    let state = state.inner().clone();
    blocking(move || state.discard_all_recoveries()).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::Engine;
    use crate::storage::atomic::testutil::TempDir;
    use serde_json::json;

    #[test]
    fn without_an_autosave_there_is_nothing_to_list_restore_or_discard() {
        let state = AppState::new(Engine::with_handler(|_| {}));
        assert!(state.list_recoveries().unwrap().is_empty());
        assert_eq!(
            state.restore_recovery(1).unwrap_err().code(),
            ErrorCode::NotFound
        );
        assert_eq!(
            state.discard_recovery(1).unwrap_err().code(),
            ErrorCode::NotFound
        );
        assert_eq!(state.discard_all_recoveries().unwrap(), 0);
        assert_eq!(state.autosave_tick(Instant::now()), 0);
    }

    #[test]
    fn an_unknown_record_is_not_found_with_an_autosave_too() {
        let dir = TempDir::new();
        let state = AppState::new(Engine::with_handler(|_| {}));
        assert!(state.attach_autosave(Arc::new(Autosave::start(dir.path()).unwrap())));
        assert!(!state.attach_autosave(Arc::new(Autosave::start(dir.path()).unwrap())));
        assert_eq!(
            state.restore_recovery(9).unwrap_err().code(),
            ErrorCode::NotFound
        );
        assert_eq!(
            state.discard_recovery(9).unwrap_err().code(),
            ErrorCode::NotFound
        );
    }

    #[test]
    fn an_entry_serializes_without_a_path() {
        let entry = RecoveryEntry {
            id: 3,
            display_name: "a.pdf".into(),
            saved_at: "2026-10-04T10:00:00Z".into(),
            page_count: 2,
            original: OriginalState::Changed,
            fresh: true,
        };
        assert_eq!(
            serde_json::to_value(entry).unwrap(),
            json!({ "id": 3, "displayName": "a.pdf", "savedAt": "2026-10-04T10:00:00Z", "pageCount": 2, "original": "changed", "fresh": true })
        );
    }
}
