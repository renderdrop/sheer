//! The native menu bar (macOS) and the channel that carries its commands to the UI.
//!
//! macOS needs a menu bar: HIG wants every command in it, and without an Edit menu the webview's Cmd+C and Cmd+V do not
//! work. Windows has none (the window has custom chrome, ADR-014, ADR-016): there the commands are on the toolbar, in More
//! and on the keyboard, and nothing in this module installs anything. The layout and the texts are in [`spec`].
//!
//! **To the UI.** A choice in the menu is a [`MenuEvent`] with the item's id. The webview has no event permission
//! (SECURITY T3, ADR-013), so the id reaches it on a `tauri::ipc::Channel<String>` that the UI handed over with the
//! `subscribe_menu` command, like `watch_transparency`. The only things that are ever sent are ids of [`spec::ACTION_IDS`]:
//! [`MenuBridge::forward`] drops every other id (the system items, which AppKit handles itself, and anything unexpected). The
//! UI in turn runs only ids it has an action for, so neither side trusts the other.
//!
//! **Language.** The labels follow the language setting: the menu is rebuilt when `update_settings` changes it ([`refresh`]).
//! "System" needs the OS language, which only the webview knows (`navigator.language`); it hands it over with
//! `subscribe_menu`. Until then, and whenever it is not known, the menu is English.

pub mod spec;

use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use tauri::ipc::Channel;
use tauri::menu::{
    AboutMetadata, IsMenuItem, Menu, MenuEvent, MenuItemBuilder, MenuItemKind, PredefinedMenuItem,
    Submenu, HELP_SUBMENU_ID, WINDOW_SUBMENU_ID,
};
use tauri::{AppHandle, Manager, Runtime};

use crate::error::{AppError, ErrorCode};
use crate::storage::settings::SettingsStore;
use spec::{ItemSpec, MenuKind, MenuLocale, Predefined};

/// Whether this platform has a menu bar for the app to fill. Only macOS: on Windows the window has no native menu (the custom
/// caption row replaces the title bar), and nothing is installed.
pub const HAS_MENU_BAR: bool = cfg!(target_os = "macos");

/// The receiver of the menu's commands, and what the menu needs to know about the UI. Managed state (`Arc<MenuBridge>`).
pub struct MenuBridge(Mutex<BridgeState>);

#[derive(Default)]
struct BridgeState {
    /// Where the commands go. There is one window, so one receiver: a new one replaces the old.
    receiver: Option<Channel<String>>,
    /// The language of the OS as the UI reported it (`navigator.language`), for the language setting "system". Only the
    /// locale it names is kept, never the string.
    system: Option<MenuLocale>,
    /// What the installed menu bar was built for, `None` before the first one: its language and whether a document was open.
    installed: Option<(MenuLocale, bool)>,
    /// Whether the UI has a document open (`set_menu_state`): the commands that need one are greyed without it.
    has_document: bool,
}

impl MenuBridge {
    pub fn new() -> Self {
        Self(Mutex::new(BridgeState::default()))
    }

    /// Makes `channel` the receiver of the commands, replacing an earlier one, and remembers the language the UI reported.
    pub fn subscribe(&self, channel: Channel<String>, system_language: Option<&str>) {
        let mut state = self.lock();
        state.receiver = Some(channel);
        state.system = system_language.map(MenuLocale::from_tag);
    }

    /// Sends a command to the UI if `id` is on the allowlist and somebody listens. Returns whether it was sent. The send
    /// only queues a script for the webview and never waits; a receiver that cannot be reached (the webview is gone) just
    /// means the command is lost, which is right: nothing is left to act on it.
    pub fn forward(&self, id: &str) -> bool {
        if !spec::is_action_id(id) {
            return false;
        }
        let state = self.lock();
        let Some(channel) = &state.receiver else {
            return false;
        };
        channel.send(id.to_owned()).is_ok()
    }

    fn system(&self) -> Option<MenuLocale> {
        self.lock().system
    }

    /// Whether the menu bar installed now is not yet in `locale`, or was built for another document state.
    fn needs(&self, locale: MenuLocale) -> bool {
        let state = self.lock();
        state.installed != Some((locale, state.has_document))
    }

    /// Notes that the menu bar was installed in `locale` for the document state `has_document` read at the build.
    fn installed(&self, locale: MenuLocale, has_document: bool) {
        self.lock().installed = Some((locale, has_document));
    }

    fn has_document(&self) -> bool {
        self.lock().has_document
    }

    /// Records whether a document is open. Returns whether that changed anything.
    fn set_has_document(&self, has_document: bool) -> bool {
        let mut state = self.lock();
        let changed = state.has_document != has_document;
        state.has_document = has_document;
        changed
    }

    /// The state is a few plain values; a panic elsewhere cannot leave it half-updated, so a poisoned lock is safe to use.
    fn lock(&self) -> MutexGuard<'_, BridgeState> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

impl Default for MenuBridge {
    fn default() -> Self {
        Self::new()
    }
}

/// The hook for `Builder::on_menu_event`: a chosen item goes to the UI if it is a command ([`MenuBridge::forward`]).
pub fn on_menu_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    if let Some(bridge) = app.try_state::<Arc<MenuBridge>>() {
        bridge.forward(event.id().as_ref());
    }
}

/// The language the menu bar should be in now: the language setting, and the OS language for "system".
fn wanted_locale<R: Runtime>(app: &AppHandle<R>, bridge: &MenuBridge) -> MenuLocale {
    let language = app
        .try_state::<Arc<SettingsStore>>()
        .map(|store| store.get().language)
        .unwrap_or_default();
    MenuLocale::resolve(language, bridge.system())
}

/// The language of the interface texts that Rust shows itself (the menu bar, the dialog that asks whether to open a link): the
/// language setting, and the OS language the UI reported for "system"; English until it is known.
pub fn ui_locale<R: Runtime>(app: &AppHandle<R>) -> MenuLocale {
    match app.try_state::<Arc<MenuBridge>>() {
        Some(bridge) => wanted_locale(app, &bridge),
        None => MenuLocale::En,
    }
}

/// Installs the menu bar at startup (macOS; nothing elsewhere). Must run on the main thread, as `setup` does.
pub fn install<R: Runtime>(app: &AppHandle<R>) {
    rebuild(app);
}

/// Brings the menu bar in step with the language setting: called when the setting changes and when the UI has told its
/// language. Does nothing where there is no menu bar or the menu is already in the right language; otherwise the menu is
/// built again on the main thread (menu objects belong to it) and replaces the old one.
pub fn refresh<R: Runtime>(app: &AppHandle<R>) {
    if !HAS_MENU_BAR {
        return;
    }
    let handle = app.clone();
    if let Err(error) = app.run_on_main_thread(move || rebuild(&handle)) {
        AppError::logged(ErrorCode::Internal, format!("menu refresh: {error}")).log();
    }
}

/// Tells the menu bar whether the UI has a document open (`set_menu_state`): the commands that need one are greyed without it, and
/// Cmd+W closes the window instead of a document. The menu is built again when the state changed (macOS; nothing elsewhere).
pub fn set_has_document<R: Runtime>(app: &AppHandle<R>, has_document: bool) {
    if let Some(bridge) = app.try_state::<Arc<MenuBridge>>() {
        if bridge.set_has_document(has_document) {
            refresh(app);
        }
    }
}

fn rebuild<R: Runtime>(app: &AppHandle<R>) {
    if !HAS_MENU_BAR {
        return;
    }
    let Some(bridge) = app.try_state::<Arc<MenuBridge>>() else {
        return;
    };
    // A damaged layout was logged when it was read: no menu bar rather than a broken one.
    let Some(layout) = spec::layout() else {
        return;
    };
    let locale = wanted_locale(app, &bridge);
    if !bridge.needs(locale) {
        return;
    }
    // Read once, so the menu is built and recorded for the same state even if the UI reports another one meanwhile.
    let has_document = bridge.has_document();
    match build(app, layout, locale, has_document).and_then(|menu| app.set_menu(menu)) {
        Ok(_) => bridge.installed(locale, has_document),
        // A menu bar that cannot be built leaves the app usable: the commands are on the toolbar and the keyboard.
        Err(error) => AppError::logged(ErrorCode::Internal, format!("menu: {error}")).log(),
    }
}

/// The name macOS shows for the app: the product name of the config (and the name in the texts that Rust shows itself).
pub(crate) fn app_name<R: Runtime>(app: &AppHandle<R>) -> String {
    app.config()
        .product_name
        .clone()
        .unwrap_or_else(|| app.package_info().name.clone())
}

/// Builds the menu bar of the layout in `locale`.
fn build<R: Runtime>(
    app: &AppHandle<R>,
    layout: &spec::Layout,
    locale: MenuLocale,
    has_document: bool,
) -> tauri::Result<Menu<R>> {
    let name = app_name(app);
    let text = |key: &str| spec::text(locale, key, &name);

    let mut submenus = Vec::with_capacity(layout.menus.len());
    for menu in &layout.menus {
        let mut kinds = Vec::with_capacity(menu.items.len());
        for item in &menu.items {
            kinds.push(build_item(app, item, &text, &name, has_document)?);
        }
        let items: Vec<&dyn IsMenuItem<R>> = kinds
            .iter()
            .map(|kind| kind as &dyn IsMenuItem<R>)
            .collect();
        let title = menu.label.as_deref().map_or_else(|| name.clone(), text);
        // AppKit has a role for the Window and the Help menu, and Tauri finds them by these ids.
        let submenu = match menu.id {
            MenuKind::Window => {
                Submenu::with_id_and_items(app, WINDOW_SUBMENU_ID, title, true, &items)?
            }
            MenuKind::Help => {
                Submenu::with_id_and_items(app, HELP_SUBMENU_ID, title, true, &items)?
            }
            _ => Submenu::with_items(app, title, true, &items)?,
        };
        submenus.push(submenu);
    }
    let refs: Vec<&dyn IsMenuItem<R>> = submenus
        .iter()
        .map(|submenu| submenu as &dyn IsMenuItem<R>)
        .collect();
    Menu::with_items(app, &refs)
}

fn build_item<R: Runtime>(
    app: &AppHandle<R>,
    item: &ItemSpec,
    text: &dyn Fn(&str) -> String,
    app_name: &str,
    has_document: bool,
) -> tauri::Result<MenuItemKind<R>> {
    Ok(match item {
        ItemSpec::Action(action) => {
            // While no document is open some commands are the system's instead (Cmd+W then closes the window), with a label of
            // their own.
            if let (false, Some(predefined), Some(label)) = (
                has_document,
                action.without_document,
                action.without_document_label.as_deref(),
            ) {
                let label = text(label);
                return Ok(MenuItemKind::Predefined(build_predefined(
                    app, predefined, &label, app_name,
                )?));
            }
            let builder = MenuItemBuilder::with_id(action.action.as_str(), text(&action.label))
                .enabled(has_document || !action.requires_document);
            let builder = match &action.accelerator {
                Some(accelerator) => builder.accelerator(accelerator),
                None => builder,
            };
            MenuItemKind::MenuItem(builder.build(app)?)
        }
        ItemSpec::Predefined(item) => MenuItemKind::Predefined(build_predefined(
            app,
            item.predefined,
            &text(&item.label),
            app_name,
        )?),
        ItemSpec::Separator(_) => MenuItemKind::Predefined(PredefinedMenuItem::separator(app)?),
    })
}

/// A system item (AppKit labels and acts on it) with `label`.
fn build_predefined<R: Runtime>(
    app: &AppHandle<R>,
    predefined: Predefined,
    label: &str,
    app_name: &str,
) -> tauri::Result<PredefinedMenuItem<R>> {
    let label = Some(label);
    match predefined {
        Predefined::About => PredefinedMenuItem::about(
            app,
            label,
            Some(AboutMetadata {
                name: Some(app_name.to_owned()),
                version: Some(env!("CARGO_PKG_VERSION").to_owned()),
                license: Some(env!("CARGO_PKG_LICENSE").to_owned()),
                ..Default::default()
            }),
        ),
        Predefined::Services => PredefinedMenuItem::services(app, label),
        Predefined::Hide => PredefinedMenuItem::hide(app, label),
        Predefined::HideOthers => PredefinedMenuItem::hide_others(app, label),
        Predefined::ShowAll => PredefinedMenuItem::show_all(app, label),
        Predefined::Quit => PredefinedMenuItem::quit(app, label),
        Predefined::Undo => PredefinedMenuItem::undo(app, label),
        Predefined::Redo => PredefinedMenuItem::redo(app, label),
        Predefined::Cut => PredefinedMenuItem::cut(app, label),
        Predefined::Copy => PredefinedMenuItem::copy(app, label),
        Predefined::Paste => PredefinedMenuItem::paste(app, label),
        Predefined::SelectAll => PredefinedMenuItem::select_all(app, label),
        Predefined::Minimize => PredefinedMenuItem::minimize(app, label),
        Predefined::Maximize => PredefinedMenuItem::maximize(app, label),
        Predefined::Fullscreen => PredefinedMenuItem::fullscreen(app, label),
        Predefined::BringAllToFront => PredefinedMenuItem::bring_all_to_front(app, label),
        Predefined::CloseWindow => PredefinedMenuItem::close_window(app, label),
    }
}

#[cfg(test)]
mod tests {
    use tauri::ipc::InvokeResponseBody;

    use super::*;

    /// A channel that records what is sent over it, as the JSON text the webview would receive.
    fn recording() -> (Channel<String>, Arc<Mutex<Vec<String>>>) {
        let log = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&log);
        let channel = Channel::new(move |body| {
            let text = match body {
                InvokeResponseBody::Json(json) => json,
                InvokeResponseBody::Raw(bytes) => format!("raw:{}", bytes.len()),
            };
            sink.lock().unwrap().push(text);
            Ok(())
        });
        (channel, log)
    }

    fn seen(log: &Arc<Mutex<Vec<String>>>) -> Vec<String> {
        log.lock().unwrap().clone()
    }

    #[test]
    fn a_command_of_the_allowlist_is_sent_as_its_bare_id() {
        let bridge = MenuBridge::new();
        let (channel, log) = recording();
        bridge.subscribe(channel, None);
        for id in spec::ACTION_IDS {
            assert!(bridge.forward(id), "{id}");
        }
        let expected: Vec<String> = spec::ACTION_IDS
            .iter()
            .map(|id| format!("\"{id}\""))
            .collect();
        assert_eq!(seen(&log), expected);
    }

    #[test]
    fn an_id_that_is_not_on_the_allowlist_never_reaches_the_ui() {
        let bridge = MenuBridge::new();
        let (channel, log) = recording();
        bridge.subscribe(channel, None);
        // The system items (AppKit acts on them itself), Tauri's own menu ids, and plain junk.
        for id in [
            "about",
            "quit",
            "copy",
            "paste",
            "__tauri_window_menu__",
            "__tauri_help_menu__",
            "",
            "Open",
            "open\0",
            "close_document",
            "<script>alert(1)</script>",
            "C:\\Users\\someone\\secret.pdf",
        ] {
            assert!(!bridge.forward(id), "{id:?}");
        }
        assert!(seen(&log).is_empty());
    }

    #[test]
    fn nothing_is_sent_while_nobody_listens() {
        let bridge = MenuBridge::new();
        assert!(!bridge.forward("open"));
    }

    #[test]
    fn a_new_receiver_replaces_the_old_one() {
        let bridge = MenuBridge::new();
        let (first, first_log) = recording();
        let (second, second_log) = recording();
        bridge.subscribe(first, None);
        bridge.subscribe(second, None);
        assert!(bridge.forward("zoom-in"));
        assert!(seen(&first_log).is_empty());
        assert_eq!(seen(&second_log), ["\"zoom-in\""]);
    }

    #[test]
    fn a_receiver_that_cannot_be_reached_never_breaks_the_menu() {
        let bridge = MenuBridge::new();
        let gone = Channel::new(|_| Err(tauri::Error::WebviewNotFound));
        bridge.subscribe(gone, None);
        assert!(!bridge.forward("open"));
        // A live receiver still works afterwards.
        let (channel, log) = recording();
        bridge.subscribe(channel, None);
        assert!(bridge.forward("open"));
        assert_eq!(seen(&log), ["\"open\""]);
    }

    #[test]
    fn a_message_is_a_bare_json_string() {
        // Nothing else rides on the channel: no object, no path, no document data.
        let (channel, log) = recording();
        channel.send("open".to_owned()).unwrap();
        assert_eq!(seen(&log), ["\"open\""]);
    }

    #[test]
    fn the_ui_language_is_kept_for_the_system_setting() {
        let bridge = MenuBridge::new();
        assert_eq!(bridge.system(), None);
        for (tag, expected) in [("de-AT", MenuLocale::De), ("fr-FR", MenuLocale::En)] {
            let (channel, _log) = recording();
            bridge.subscribe(channel, Some(tag));
            assert_eq!(bridge.system(), Some(expected), "{tag}");
        }
        // A hostile value is unknown, and the string is not kept.
        let (channel, _log) = recording();
        bridge.subscribe(channel, Some(&"de".repeat(100_000)));
        assert_eq!(bridge.system(), Some(MenuLocale::En));
        let (channel, _log) = recording();
        bridge.subscribe(channel, None);
        assert_eq!(bridge.system(), None);
    }

    #[test]
    fn the_menu_is_rebuilt_only_when_its_language_changes() {
        let bridge = MenuBridge::new();
        assert!(bridge.needs(MenuLocale::En), "nothing is installed yet");
        bridge.installed(MenuLocale::En, false);
        assert!(!bridge.needs(MenuLocale::En));
        assert!(bridge.needs(MenuLocale::De));
        bridge.installed(MenuLocale::De, false);
        assert!(!bridge.needs(MenuLocale::De));
        assert!(bridge.needs(MenuLocale::En));
    }

    #[test]
    fn the_menu_is_rebuilt_when_a_document_opens_or_the_last_one_closes() {
        let bridge = MenuBridge::new();
        assert!(!bridge.has_document(), "no document at the start");
        bridge.installed(MenuLocale::En, false);
        assert!(!bridge.needs(MenuLocale::En));
        // The same state again is nothing; a changed one is a rebuild.
        assert!(!bridge.set_has_document(false));
        assert!(!bridge.needs(MenuLocale::En));
        assert!(bridge.set_has_document(true));
        assert!(bridge.needs(MenuLocale::En));
        bridge.installed(MenuLocale::En, true);
        assert!(!bridge.needs(MenuLocale::En));
        assert!(bridge.set_has_document(false));
        assert!(bridge.needs(MenuLocale::En));
    }

    #[test]
    fn only_macos_has_a_menu_bar() {
        assert_eq!(HAS_MENU_BAR, cfg!(target_os = "macos"));
    }
}
