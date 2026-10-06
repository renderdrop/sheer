//! App-level commands: what the frontend needs before it can render (`app_ready`) and the user's settings.
//!
//! | Command | Arguments | Returns |
//! |---|---|---|
//! | `app_ready` | none | `AppBootstrap { platform, paper, version, authorSuggestion }` |
//! | `get_settings` | none | `Settings { language, leftPanelWidth, welcomeTour, authorName, authorPrompt, updates, skippedVersion, tipsSeen, pageSidebarCollapsed, tags }` |
//! | `update_settings` | `patch: { language?, leftPanelWidth?, welcomeTour?, authorName?, authorPrompt?, updates?, skippedVersion?, tipsSeen?, pageSidebarCollapsed?, tags? }` | the settings after the update; a bad `tags` list is `invalid_argument` (`what: "tags"`) |
//! | `subscribe_menu` | `onAction: Channel<string>`, `systemLanguage?: string` | nothing; the channel then carries the id of each command chosen in the macOS menu bar |
//! | `subscribe_app` | `onEvent: Channel<AppEvent>` | nothing; the channel then carries the backend's pushes (`dropHover`, `opened`, `openFailed`, see `events::AppEvent`), first those that waited for it |
//! | `open_default_apps_settings` | none | nothing (Windows: opens the default-apps page; macOS: `unsupported_feature`); stub until M7 package B4 |
//!
//! `update_settings` takes the patch as raw JSON on purpose: a bad value is then a normal `invalid_argument` with
//! `what: "settings"` (see `storage::settings`), not a deserialization failure that bypasses the error model.

use std::sync::Arc;

use serde::Serialize;
use serde_json::Value;
use tauri::ipc::Channel;
use tauri::{AppHandle, State};

use super::blocking;
use crate::error::{AppError, UiError};
use crate::events::{AppEvent, AppEvents};
use crate::menu::{self, MenuBridge};
use crate::platform::{self, Paper, Platform};
use crate::storage::settings::{AuthorName, Settings, SettingsPatch, SettingsStore};

/// What the frontend asks once at startup.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppBootstrap {
    pub platform: Platform,
    pub version: &'static str,
    /// The OS account name, only as a suggestion for the author prompt (ADR-034); never stored. Empty when unknown.
    pub author_suggestion: String,
    /// Default page size of Create PDF from images, from the OS region (ADR-049 §3).
    pub paper: Paper,
}

impl AppBootstrap {
    /// Reads the live OS state.
    pub fn current() -> Self {
        Self {
            platform: platform::current(),
            version: env!("CARGO_PKG_VERSION"),
            author_suggestion: AuthorName::os_suggestion(),
            paper: platform::paper_default(),
        }
    }
}

/// Platform, paper and version for the first render.
#[tauri::command]
pub async fn app_ready() -> Result<AppBootstrap, UiError> {
    blocking(|| Ok(AppBootstrap::current())).await
}

/// The current settings (in memory; the file was read at startup).
#[tauri::command]
pub async fn get_settings(store: State<'_, Arc<SettingsStore>>) -> Result<Settings, UiError> {
    Ok(store.get())
}

/// Validates `patch`, persists it atomically and returns the resulting settings. A change of the language also relabels the
/// native menu bar (macOS).
#[tauri::command]
pub async fn update_settings(
    app: AppHandle,
    store: State<'_, Arc<SettingsStore>>,
    patch: Value,
) -> Result<Settings, UiError> {
    let store = Arc::clone(store.inner());
    let before = store.get().language;
    let settings = blocking(move || store.update(SettingsPatch::from_value(&patch)?)).await?;
    if settings.language != before {
        menu::refresh(&app);
    }
    Ok(settings)
}

/// Opens the OS page where the user picks the default PDF app (Windows: the `ms-settings:` deep link; macOS: `unsupported_feature`).
/// Stub (package B4 / frontend F4): `not_yet`.
#[tauri::command]
pub async fn open_default_apps_settings(_app: AppHandle) -> Result<(), UiError> {
    // ADR-131: the seam opens no OS window in the acceptance build (the call is only answered).
    blocking(|| {
        crate::automation::dialogs::open_os_settings(|| Err(AppError::not_yet())).map(|_| ())
    })
    .await
}

/// Starts sending the commands chosen in the macOS menu bar to `on_action`, each as the bare id of the item (`open`,
/// `zoom-in`, ...). Only ids of the backend's allowlist (`menu::spec::ACTION_IDS`) are ever sent, never a system item or
/// anything else. `system_language` is the OS language (`navigator.language`), which labels the menu while the language
/// setting is "system"; a value that is not a plain language tag counts as unknown (English). Where there is no menu bar
/// (Windows) the channel is kept and nothing ever arrives.
///
/// This is how a menu click reaches the UI without any event permission: the channel is an argument the UI hands over. A
/// second call replaces the first channel. See [`MenuBridge`].
#[tauri::command]
pub async fn subscribe_menu(
    app: AppHandle,
    bridge: State<'_, Arc<MenuBridge>>,
    on_action: Channel<String>,
    system_language: Option<String>,
) -> Result<(), UiError> {
    bridge.subscribe(on_action, system_language.as_deref());
    menu::refresh(&app);
    Ok(())
}

/// Starts sending the backend's pushes to `on_event`: whether files are being dragged over the window (`dropHover`), and the
/// result of every open that did not start with the UI's own request, a file dropped on the window or opened by the OS
/// (`opened`, `openFailed`). What happened before the UI subscribed (a file the app was started with) is sent first, in order,
/// exactly once. A second call replaces the first channel.
///
/// This is how the backend reaches the UI without any event permission: the channel is an argument the UI hands over, and
/// a message carries no path (see [`AppEvent`]).
#[tauri::command]
pub async fn subscribe_app(
    events: State<'_, Arc<AppEvents>>,
    on_event: Channel<AppEvent>,
) -> Result<(), UiError> {
    events.subscribe(on_event);
    Ok(())
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
        assert_eq!(keys, ["authorSuggestion", "paper", "platform", "version"]);
        assert!(["macos", "windows", "linux"].contains(&object["platform"].as_str().unwrap()));
        assert!(["a4", "letter"].contains(&object["paper"].as_str().unwrap()));
        assert_eq!(object["version"], env!("CARGO_PKG_VERSION"));
    }

    #[test]
    fn app_ready_answers_through_the_blocking_pool() {
        let bootstrap = tauri::async_runtime::block_on(app_ready()).unwrap();
        assert_eq!(bootstrap.version, env!("CARGO_PKG_VERSION"));
    }
}
