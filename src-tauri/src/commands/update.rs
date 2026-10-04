// owned by package B3
//! Updates (ARCHITECTURE section 5 "Ship (M7)", ADR-053 section 3): the only commands that reach the network, and only through `update/`.
//!
//! | Command | Arguments | Returns |
//! |---|---|---|
//! | `check_for_update` | none | `UpdateInfo` or `null` (up to date); `unsupported_feature` while the signing key is the placeholder |
//! | `download_update` | `onEvent: Channel<UpdateEvent>` | nothing; downloads and verifies, keeps the package in memory |
//! | `install_update_on_quit` | none | nothing; marks it, the quit flow installs after dirty documents resolve |
//! | `skip_update_version` | `version: string` | nothing; at most 32 characters, semver checked |

use tauri::ipc::Channel;
use tauri::{AppHandle, State};

use super::{blocking, AppState};
use crate::error::{AppError, UiError};
use crate::update::{UpdateEvent, UpdateInfo};

impl AppState {
    /// Asks the update endpoint whether a newer version exists. Stub (package B3): `not_yet`.
    pub fn check_for_update(&self, _app: &AppHandle) -> Result<Option<UpdateInfo>, AppError> {
        Err(AppError::not_yet())
    }

    /// Downloads and verifies the update, reporting on `on_event`. Stub (package B3): `not_yet`.
    pub fn download_update(
        &self,
        _app: &AppHandle,
        _on_event: &Channel<UpdateEvent>,
    ) -> Result<(), AppError> {
        Err(AppError::not_yet())
    }

    /// Marks the downloaded update for installation when the app quits. Stub (package B3): `not_yet`.
    pub fn install_update_on_quit(&self) -> Result<(), AppError> {
        Err(AppError::not_yet())
    }

    /// Remembers `version` as skipped. Stub (package B3): `not_yet`.
    pub fn skip_update_version(&self, _version: &str) -> Result<(), AppError> {
        Err(AppError::not_yet())
    }
}

/// Looks for a newer version; the one request goes to the fixed endpoint of `update/`.
#[tauri::command]
pub async fn check_for_update(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<UpdateInfo>, UiError> {
    let state = state.inner().clone();
    blocking(move || state.check_for_update(&app)).await
}

/// Downloads and verifies the update; a bad signature deletes it.
#[tauri::command]
pub async fn download_update(
    app: AppHandle,
    state: State<'_, AppState>,
    on_event: Channel<UpdateEvent>,
) -> Result<(), UiError> {
    let state = state.inner().clone();
    blocking(move || state.download_update(&app, &on_event)).await
}

/// Installs the downloaded update when the app quits.
#[tauri::command]
pub async fn install_update_on_quit(state: State<'_, AppState>) -> Result<(), UiError> {
    let state = state.inner().clone();
    blocking(move || state.install_update_on_quit()).await
}

/// Does not offer `version` again.
#[tauri::command]
pub async fn skip_update_version(
    state: State<'_, AppState>,
    version: String,
) -> Result<(), UiError> {
    let state = state.inner().clone();
    blocking(move || state.skip_update_version(&version)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::Engine;
    use crate::error::ErrorCode;

    #[test]
    fn the_stubs_that_need_no_app_answer_not_yet_until_package_b3() {
        let state = AppState::new(Engine::with_handler(|_| {}));
        assert_eq!(
            state.install_update_on_quit().unwrap_err().code(),
            ErrorCode::UnsupportedFeature
        );
        assert_eq!(
            state.skip_update_version("1.0.1").unwrap_err().code(),
            ErrorCode::UnsupportedFeature
        );
    }
}
