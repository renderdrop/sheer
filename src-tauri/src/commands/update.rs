// owned by package B3
//! Updates (ARCHITECTURE section 5 "Ship (M7)", ADR-053 section 3): the only commands that reach the network, and only through `update/`.
//!
//! | Command | Arguments | Returns |
//! |---|---|---|
//! | `check_for_update` | none | `UpdateInfo` or `null` (up to date); `unsupported_feature` while the signing key is the placeholder. The user's click: it works with the setting off |
//! | `download_update` | `onEvent: Channel<UpdateEvent>` | nothing; downloads and verifies, keeps the package in memory; a bad signature is `damaged_file` and drops it |
//! | `install_update_on_quit` | none | nothing; marks it, the quit hook installs after dirty documents resolve |
//! | `updater_configured` | none | `boolean`: the embedded signing key is a real one (no network, no state; false while it is the placeholder) |
//! | `skip_update_version` | `version: string` | nothing; at most 32 characters, version characters only |

use std::sync::Arc;

use tauri::ipc::Channel;
use tauri::{AppHandle, State};

use crate::error::{AppError, UiError};
use crate::storage::settings::SettingsStore;
use crate::update::state::{Trigger, UpdateState};
use crate::update::{self, UpdateEvent, UpdateInfo};

/// Marks the downloaded update for installation at exit. `not_found` when nothing was downloaded and verified.
fn mark_install_on_quit(state: &UpdateState) -> Result<(), AppError> {
    if state.mark_install_on_quit() {
        Ok(())
    } else {
        Err(AppError::not_found("update"))
    }
}

/// Looks for a newer version; the one request goes to the fixed endpoint of `update/`. Only the user's click calls this.
#[tauri::command]
pub async fn check_for_update(app: AppHandle) -> Result<Option<UpdateInfo>, UiError> {
    update::check(&app, Trigger::Manual)
        .await
        .map_err(UiError::from)
}

/// Downloads and verifies the update; a bad signature deletes it.
#[tauri::command]
pub async fn download_update(
    app: AppHandle,
    on_event: Channel<UpdateEvent>,
) -> Result<(), UiError> {
    update::download(&app, &on_event)
        .await
        .map_err(UiError::from)
}

/// Installs the downloaded update when the app quits.
#[tauri::command]
pub async fn install_update_on_quit(state: State<'_, Arc<UpdateState>>) -> Result<(), UiError> {
    mark_install_on_quit(&state).map_err(UiError::from)
}

/// Whether the updater can run at all: the embedded public key is real. Reads only the compiled-in key file; no network, no state.
#[tauri::command]
pub async fn updater_configured() -> Result<bool, UiError> {
    Ok(update::configured_key().is_ok())
}

/// Does not offer `version` again.
#[tauri::command]
pub async fn skip_update_version(
    store: State<'_, Arc<SettingsStore>>,
    version: String,
) -> Result<(), UiError> {
    let store = store.inner().clone();
    update::skip_version(&store, &version).map_err(UiError::from)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorCode;

    #[test]
    fn the_shipped_placeholder_key_is_not_configured() {
        assert!(update::configured_key().is_err());
    }

    #[test]
    fn installing_needs_a_verified_package() {
        let state = UpdateState::default();
        assert_eq!(
            mark_install_on_quit(&state).unwrap_err().code(),
            ErrorCode::NotFound
        );
    }
}
