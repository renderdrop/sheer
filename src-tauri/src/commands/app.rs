//! App-level commands: what the frontend needs before it can render (`app_ready`) and the user's settings.
//!
//! | Command | Arguments | Returns |
//! |---|---|---|
//! | `app_ready` | none | `AppBootstrap { platform, reducedTransparency, version }` |
//! | `get_settings` | none | `Settings { glass, theme, language, leftPanelWidth }` |
//! | `update_settings` | `patch: { glass?, theme?, language?, leftPanelWidth? }` | the settings after the update |
//! | `watch_transparency` | `onChange: Channel<boolean>` | nothing; the channel then carries each change of the OS "Reduce transparency" flag |
//!
//! `update_settings` takes the patch as raw JSON on purpose: a bad value is then a normal `invalid_argument` with
//! `what: "settings"` (see `storage::settings`), not a deserialization failure that bypasses the error model.

use std::sync::Arc;

use serde::Serialize;
use serde_json::Value;
use tauri::ipc::Channel;
use tauri::State;

use super::blocking;
use crate::error::UiError;
use crate::platform::{self, Platform, TransparencyWatch};
use crate::storage::settings::{Settings, SettingsPatch, SettingsStore};

/// What the frontend asks once at startup.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppBootstrap {
    pub platform: Platform,
    /// The OS "reduce transparency" flag (macOS only for now; `false` elsewhere).
    pub reduced_transparency: bool,
    pub version: &'static str,
}

impl AppBootstrap {
    /// Reads the live OS state.
    pub fn current() -> Self {
        Self {
            platform: platform::current(),
            reduced_transparency: platform::reduced_transparency(),
            version: env!("CARGO_PKG_VERSION"),
        }
    }
}

/// Platform, accessibility flags and version for the first render.
#[tauri::command]
pub async fn app_ready() -> Result<AppBootstrap, UiError> {
    blocking(|| Ok(AppBootstrap::current())).await
}

/// The current settings (in memory; the file was read at startup).
#[tauri::command]
pub async fn get_settings(store: State<'_, Arc<SettingsStore>>) -> Result<Settings, UiError> {
    Ok(store.get())
}

/// Validates `patch`, persists it atomically and returns the resulting settings.
#[tauri::command]
pub async fn update_settings(
    store: State<'_, Arc<SettingsStore>>,
    patch: Value,
) -> Result<Settings, UiError> {
    let store = Arc::clone(store.inner());
    blocking(move || store.update(SettingsPatch::from_value(&patch)?)).await
}

/// Starts pushing changes of the OS "Reduce transparency" flag to `on_change` (on macOS, when the window regains focus;
/// elsewhere the flag never changes). A value that already differs from what `app_ready` reported is sent at once.
///
/// This is how the backend reaches the UI without any event permission: the channel is an argument the UI hands over,
/// and each message is a bare boolean. A second call replaces the first channel. See [`TransparencyWatch`].
#[tauri::command]
pub async fn watch_transparency(
    watch: State<'_, Arc<TransparencyWatch>>,
    on_change: Channel<bool>,
) -> Result<(), UiError> {
    let watch = Arc::clone(watch.inner());
    blocking(move || {
        watch.subscribe(on_change, platform::reduced_transparency());
        Ok(())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_bootstrap_has_the_wire_shape_the_frontend_parses() {
        let value = serde_json::to_value(AppBootstrap::current()).unwrap();
        let object = value.as_object().unwrap();
        let mut keys: Vec<&str> = object.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(keys, ["platform", "reducedTransparency", "version"]);
        assert!(["macos", "windows", "linux"].contains(&object["platform"].as_str().unwrap()));
        assert!(object["reducedTransparency"].is_boolean());
        assert_eq!(object["version"], env!("CARGO_PKG_VERSION"));
    }

    #[test]
    fn app_ready_answers_through_the_blocking_pool() {
        let bootstrap = tauri::async_runtime::block_on(app_ready()).unwrap();
        assert_eq!(bootstrap.version, env!("CARGO_PKG_VERSION"));
    }
}
