//! The macOS menu bar as data: its layout, its texts and the ids it may send to the UI.
//!
//! The layout is `src/actions/menu.json` (shared with the frontend's tests, which tie it to the command registry) and the
//! texts are the UI catalogs `src/i18n/locales/{en,de}.json` (the `menu.*` keys), both compiled in with `include_str!`.
//! Nothing here needs Tauri, so it is all unit-tested without a window: the layout parses, every label exists in both
//! languages, every accelerator is one muda can read, and the allowlist of ids is exactly the layout's commands.

use std::collections::HashMap;
use std::sync::OnceLock;

use serde::Deserialize;

use crate::error::{AppError, ErrorCode};
use crate::limits;
use crate::storage::settings::Language;

const LAYOUT_JSON: &str = include_str!("../../../src/actions/menu.json");
const EN_JSON: &str = include_str!("../../../src/i18n/locales/en.json");
const DE_JSON: &str = include_str!("../../../src/i18n/locales/de.json");

/// The ids of the commands the menu bar can send to the UI, which are the custom items of the layout. This is the allowlist:
/// [`is_action_id`] is the only gate between a menu event and the channel, so an id that is not listed here (a system item,
/// something a future layout names by mistake) never reaches the webview. A test keeps it equal to the layout, and the
/// frontend's `src/actions/menu.test.ts` keeps the layout equal to its registry.
pub const ACTION_IDS: [&str; 60] = [
    "settings",
    "open",
    "restore-recovery",
    "close-document",
    "save",
    "save-as",
    "compress-document",
    "undo",
    "redo",
    "toggle-left-panel",
    "zoom-in",
    "zoom-out",
    "actual-size",
    "fit-width",
    "fit-page",
    "scroll-continuous",
    "scroll-single",
    "scroll-spread",
    "toggle-margin-comments",
    "toggle-smart-links",
    "next-page",
    "previous-page",
    "next-tab",
    "previous-tab",
    "find",
    "find-next",
    "find-previous",
    "go-to-page",
    "rotate-view-right",
    "rotate-view-left",
    "rotate-view-reset",
    "flatten-form",
    "protect",
    "document-properties",
    "signatures",
    "images-to-pdf",
    "export-copy",
    "export-images",
    "print",
    "exit",
    "fullscreen",
    "delete-selection",
    "add-comment",
    "cite-selection",
    "place-stamp",
    "copy-citation-list",
    "save-citation-list",
    "export-comments",
    "sidebar-tab-pages",
    "sidebar-tab-outline",
    "sidebar-tab-comments",
    "sidebar-tab-search",
    "form-highlight",
    "manage-signatures",
    "recognize-text",
    "save-text-pdf",
    "header-footer",
    "welcome-tour",
    "reset-tips",
    "about",
];

/// Whether `id` is a command the menu bar may send to the UI.
pub fn is_action_id(id: &str) -> bool {
    ACTION_IDS.contains(&id)
}

/// A language the menu bar has texts for: the languages of the UI catalogs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum MenuLocale {
    En,
    De,
}

impl MenuLocale {
    pub const ALL: [MenuLocale; 2] = [MenuLocale::En, MenuLocale::De];

    /// The locale an OS language tag names, like `resolveLocale` in `src/i18n/locale.ts`: German when the primary subtag
    /// is `de` (`de`, `de-AT`, `de_CH`, `DE`), English for everything else. A string that is not a plain tag (longer than
    /// `limits::MAX_LANGUAGE_TAG_LEN`, or with anything but ASCII letters, digits, `-` and `_`) is unknown, so English:
    /// the value comes from the webview, and all it may do is pick between two languages.
    pub fn from_tag(tag: &str) -> Self {
        let well_formed = tag.len() <= limits::MAX_LANGUAGE_TAG_LEN
            && tag
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_');
        let primary = tag.split(['-', '_']).next().unwrap_or_default();
        if well_formed && primary.eq_ignore_ascii_case("de") {
            Self::De
        } else {
            Self::En
        }
    }

    /// The locale for the language setting: an explicit choice is that language, and "system" is the language the OS
    /// reported (`system`, from [`MenuLocale::from_tag`]), English while it is not known.
    pub fn resolve(language: Language, system: Option<MenuLocale>) -> Self {
        match language {
            Language::En => Self::En,
            Language::De => Self::De,
            Language::System => system.unwrap_or(Self::En),
        }
    }
}

/// The system-provided items of the layout, which AppKit labels and acts on itself (the UI never hears of them).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Predefined {
    About,
    Services,
    Hide,
    HideOthers,
    ShowAll,
    Quit,
    Undo,
    Redo,
    Cut,
    Copy,
    Paste,
    SelectAll,
    Minimize,
    Maximize,
    Fullscreen,
    BringAllToFront,
    CloseWindow,
}

/// The platform an item is for. An item without one is on both; the Windows menu bar (the caption row, DESIGN 3.56) and the macOS
/// one are built from the same file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Only {
    Windows,
    Macos,
}

/// Whether an item with this restriction is part of the macOS menu bar.
fn on_macos(only: Option<Only>) -> bool {
    only != Some(Only::Windows)
}

/// The seven menus of the macOS menu bar, in HIG order. Window and Help are told apart because AppKit has a role for them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MenuKind {
    App,
    File,
    Edit,
    View,
    Tools,
    Window,
    Help,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Layout {
    pub menus: Vec<MenuSpec>,
    /// The catalog key of the Windows menu bar's accessible name (the macOS bar has none).
    #[serde(default, rename = "barLabel")]
    pub bar_label: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MenuSpec {
    pub id: MenuKind,
    /// The catalog key of the title. The app menu has none: macOS shows the app's name there.
    #[serde(default)]
    pub label: Option<String>,
    /// The catalog key of the access key letter of the Windows menu bar (Alt plus this letter opens the menu).
    #[serde(default)]
    pub access: Option<String>,
    pub items: Vec<ItemSpec>,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub enum ItemSpec {
    Action(ActionItem),
    Predefined(PredefinedItem),
    Separator(SeparatorItem),
    Submenu(SubmenuItem),
}

impl ItemSpec {
    /// Whether the macOS menu bar has this item (the Windows-only ones are for the caption row).
    pub fn on_macos(&self) -> bool {
        match self {
            Self::Action(item) => on_macos(item.platform),
            Self::Separator(item) => on_macos(item.platform),
            Self::Submenu(item) => on_macos(item.platform),
            Self::Predefined(_) => true,
        }
    }
}

/// A command of the app: choosing it sends `action` to the UI.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActionItem {
    pub action: String,
    pub label: String,
    /// In Tauri's syntax (`CmdOrCtrl+O`), which names physical keys.
    #[serde(default)]
    pub accelerator: Option<String>,
    /// The command needs a document: the item is greyed while none is open (`set_menu_state`).
    #[serde(default, rename = "requiresDocument")]
    pub requires_document: bool,
    /// What stands in the item's place while no document is open (macOS: Cmd+W closes the window then), with its own label.
    #[serde(default, rename = "withoutDocument")]
    pub without_document: Option<Predefined>,
    #[serde(default, rename = "withoutDocumentLabel")]
    pub without_document_label: Option<String>,
    #[serde(default)]
    pub platform: Option<Only>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PredefinedItem {
    pub predefined: Predefined,
    pub label: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SeparatorItem {
    pub separator: bool,
    #[serde(default)]
    pub platform: Option<Only>,
}

/// A submenu that the Windows menu bar fills at run time (Open recent). The macOS bar has none.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SubmenuItem {
    pub submenu: String,
    pub label: String,
    #[serde(default, rename = "clearLabel")]
    pub clear_label: Option<String>,
    #[serde(default)]
    pub platform: Option<Only>,
}

/// The layout, parsed once. `None` if the compiled-in file is damaged (a test fails first), in which case there is no menu bar
/// rather than a broken one.
pub fn layout() -> Option<&'static Layout> {
    static LAYOUT: OnceLock<Option<Layout>> = OnceLock::new();
    LAYOUT
        .get_or_init(|| match serde_json::from_str(LAYOUT_JSON) {
            Ok(layout) => Some(layout),
            Err(error) => {
                AppError::logged(ErrorCode::Internal, format!("menu layout: {error}")).log();
                None
            }
        })
        .as_ref()
}

type Catalog = HashMap<String, String>;

/// The catalog of `name` (the file it came from) as a map. A damaged file gives an empty catalog, so the texts fall back to
/// English and then to the key itself, and the damage is logged like that of the layout in [`layout`] (a test fails first).
fn parse_catalog(json: &str, name: &str) -> Catalog {
    serde_json::from_str(json).unwrap_or_else(|error| {
        AppError::logged(ErrorCode::Internal, format!("menu catalog {name}: {error}")).log();
        Catalog::new()
    })
}

fn catalog(locale: MenuLocale) -> &'static Catalog {
    static EN: OnceLock<Catalog> = OnceLock::new();
    static DE: OnceLock<Catalog> = OnceLock::new();
    match locale {
        MenuLocale::En => EN.get_or_init(|| parse_catalog(EN_JSON, "en")),
        MenuLocale::De => DE.get_or_init(|| parse_catalog(DE_JSON, "de")),
    }
}

/// The text for the catalog key `key` in `locale`, with `{app}` replaced by `app_name`. A key the language lacks falls back
/// to English, and one that nobody has is the key itself, so a gap shows up as a key and never as a blank menu title (the same
/// rule as the frontend's `t`).
pub fn text(locale: MenuLocale, key: &str, app_name: &str) -> String {
    catalog(locale)
        .get(key)
        .or_else(|| catalog(MenuLocale::En).get(key))
        .map_or_else(|| key.to_owned(), |text| text.replace("{app}", app_name))
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use super::*;

    fn layout_or_fail() -> &'static Layout {
        layout().expect("src/actions/menu.json parses")
    }

    fn items() -> impl Iterator<Item = &'static ItemSpec> {
        layout_or_fail().menus.iter().flat_map(|menu| &menu.items)
    }

    fn actions() -> Vec<&'static ActionItem> {
        items()
            .filter_map(|item| match item {
                ItemSpec::Action(action) => Some(action),
                _ => None,
            })
            .collect()
    }

    /// Every catalog key the layout uses: menu titles and item labels.
    fn label_keys() -> Vec<&'static str> {
        let titles = layout_or_fail()
            .menus
            .iter()
            .filter_map(|menu| menu.label.as_deref());
        let labels = items().filter_map(|item| match item {
            ItemSpec::Action(action) => Some(action.label.as_str()),
            ItemSpec::Predefined(predefined) => Some(predefined.label.as_str()),
            ItemSpec::Separator(_) => None,
            ItemSpec::Submenu(submenu) => Some(submenu.label.as_str()),
        });
        let extras = layout_or_fail()
            .menus
            .iter()
            .filter_map(|menu| menu.access.as_deref())
            .chain(layout_or_fail().bar_label.as_deref())
            .chain(items().filter_map(|item| match item {
                ItemSpec::Submenu(submenu) => submenu.clear_label.as_deref(),
                _ => None,
            }));
        let fallbacks = actions()
            .into_iter()
            .filter_map(|action| action.without_document_label.as_deref());
        titles
            .chain(labels)
            .chain(extras)
            .chain(fallbacks)
            .collect()
    }

    // --- the allowlist ------------------------------------------------------------------------------------------

    #[test]
    fn the_allowlist_is_exactly_the_commands_of_the_layout() {
        let in_layout: BTreeSet<&str> = actions()
            .into_iter()
            .map(|action| action.action.as_str())
            .collect();
        let allowed: BTreeSet<&str> = ACTION_IDS.iter().copied().collect();
        assert_eq!(in_layout, allowed);
        assert_eq!(ACTION_IDS.len(), allowed.len(), "an id is listed twice");
    }

    #[test]
    fn only_listed_ids_pass_the_allowlist() {
        for id in ACTION_IDS {
            assert!(is_action_id(id), "{id}");
        }
        for id in [
            "",
            "Open",
            "OPEN",
            " open",
            "open ",
            "open\n",
            "quit",
            "copy",
            "undo_all",
            "close_document",
            "close-document-",
            "toggle-left-panel\0",
            "../open",
            "settings,open",
            "\u{0430}pen",
            "__tauri_window_menu__",
            "__tauri_help_menu__",
        ] {
            assert!(!is_action_id(id), "{id:?} must not pass");
        }
    }

    #[test]
    fn ids_are_short_kebab_case_names_the_ui_accepts() {
        for id in ACTION_IDS {
            assert!(id.len() <= 64, "{id}");
            assert!(!id.starts_with('-') && !id.ends_with('-'), "{id}");
            assert!(
                id.bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-'),
                "{id}"
            );
        }
    }

    // --- the layout ---------------------------------------------------------------------------------------------

    #[test]
    fn the_layout_is_app_file_edit_view_tools_window_help() {
        let kinds: Vec<MenuKind> = layout_or_fail().menus.iter().map(|menu| menu.id).collect();
        assert_eq!(
            kinds,
            [
                MenuKind::App,
                MenuKind::File,
                MenuKind::Edit,
                MenuKind::View,
                MenuKind::Tools,
                MenuKind::Window,
                MenuKind::Help
            ]
        );
        // macOS names the first menu after the app; every other menu has a title.
        for menu in &layout_or_fail().menus {
            assert_eq!(
                menu.label.is_none(),
                menu.id == MenuKind::App,
                "{:?}",
                menu.id
            );
        }
    }

    /// The ids of the action items of one menu, in order, for the macOS bar.
    fn menu_actions(kind: MenuKind) -> Vec<&'static str> {
        layout_or_fail()
            .menus
            .iter()
            .filter(|menu| menu.id == kind)
            .flat_map(|menu| &menu.items)
            .filter(|item| item.on_macos())
            .filter_map(|item| match item {
                ItemSpec::Action(action) => Some(action.action.as_str()),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn the_tools_menu_lists_form_highlight_and_signatures() {
        // F22.2: no mode items; the categories are static captions of the tool strip.
        assert_eq!(
            menu_actions(MenuKind::Tools),
            [
                "form-highlight",
                "manage-signatures",
                "recognize-text",
                "save-text-pdf",
                "header-footer"
            ]
        );
        assert!(!ACTION_IDS.iter().any(|id| id.starts_with("tool-")));
    }

    #[test]
    fn the_file_menu_holds_the_commands_that_are_not_in_a_mode() {
        assert_eq!(
            menu_actions(MenuKind::File),
            [
                "open",
                "restore-recovery",
                "save",
                "save-as",
                "export-copy",
                "export-images",
                "images-to-pdf",
                "compress-document",
                "flatten-form",
                "protect",
                "document-properties",
                "signatures",
                "copy-citation-list",
                "save-citation-list",
                "export-comments",
                "print",
                "close-document"
            ]
        );
        // Settings and Exit are Windows-only items of Datei.
        let windows: Vec<&str> = layout_or_fail()
            .menus
            .iter()
            .filter(|menu| menu.id == MenuKind::File)
            .flat_map(|menu| &menu.items)
            .filter_map(|item| match item {
                ItemSpec::Action(action) => Some(action.action.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(windows[windows.len() - 2..], ["settings", "exit"]);
    }

    #[test]
    fn the_view_menu_has_no_inspector_item() {
        assert!(!menu_actions(MenuKind::View).contains(&"toggle-inspector"));
    }

    #[test]
    fn every_item_of_the_layout_was_understood() {
        // `deny_unknown_fields` and the untagged enum make an item that matches nothing a parse error, so a typo cannot
        // turn into a silently missing menu item; this counts what the file says against what was parsed.
        let written = LAYOUT_JSON.matches("\"action\"").count()
            + LAYOUT_JSON.matches("\"predefined\"").count()
            + LAYOUT_JSON.matches("\"separator\"").count()
            + LAYOUT_JSON.matches("\"submenu\"").count();
        assert_eq!(items().count(), written);
        assert!(items().all(|item| !matches!(
            item,
            ItemSpec::Separator(SeparatorItem {
                separator: false,
                ..
            })
        )));
    }

    #[test]
    fn the_system_items_are_where_the_hig_puts_them() {
        let predefined = |kind: MenuKind| -> Vec<Predefined> {
            layout_or_fail()
                .menus
                .iter()
                .filter(|menu| menu.id == kind)
                .flat_map(|menu| &menu.items)
                .filter_map(|item| match item {
                    ItemSpec::Predefined(item) => Some(item.predefined),
                    _ => None,
                })
                .collect()
        };
        assert_eq!(
            predefined(MenuKind::App),
            [
                Predefined::About,
                Predefined::Services,
                Predefined::Hide,
                Predefined::HideOthers,
                Predefined::ShowAll,
                Predefined::Quit
            ]
        );
        // The webview takes Cmd+C, Cmd+V and the others from the Edit menu: without these items they would not work.
        assert_eq!(
            predefined(MenuKind::Edit),
            [
                Predefined::Cut,
                Predefined::Copy,
                Predefined::Paste,
                Predefined::SelectAll
            ]
        );
        assert_eq!(
            predefined(MenuKind::Window),
            [
                Predefined::Minimize,
                Predefined::Maximize,
                Predefined::BringAllToFront
            ]
        );
    }

    #[test]
    fn the_predefined_names_are_the_ones_the_frontend_test_knows() {
        // The same list as PREDEFINED in src/actions/menu.test.ts.
        let names = [
            "about",
            "services",
            "hide",
            "hide_others",
            "show_all",
            "quit",
            "undo",
            "redo",
            "cut",
            "copy",
            "paste",
            "select_all",
            "minimize",
            "maximize",
            "fullscreen",
            "bring_all_to_front",
            "close_window",
        ];
        for name in names {
            let parsed: Result<Predefined, _> = serde_json::from_value(serde_json::json!(name));
            assert!(parsed.is_ok(), "{name}");
        }
        let unknown: Result<Predefined, _> =
            serde_json::from_value(serde_json::json!("frobnicate"));
        assert!(unknown.is_err());
    }

    // --- which commands need a document ------------------------------------------------------------------------

    #[test]
    fn close_document_becomes_close_window_while_no_document_is_open() {
        let close = actions()
            .into_iter()
            .find(|action| action.action == "close-document")
            .expect("the File menu closes a document");
        assert!(close.requires_document);
        assert_eq!(close.without_document, Some(Predefined::CloseWindow));
        assert_eq!(
            close.without_document_label.as_deref(),
            Some("menu.file.closeWindow")
        );
        // Both are one key: Cmd+W (AppKit's own close-window item has it, so the action item hands it over).
        assert_eq!(close.accelerator.as_deref(), Some("CmdOrCtrl+W"));
    }

    #[test]
    fn a_fallback_has_its_label_and_only_a_command_needing_a_document_has_one() {
        for action in actions() {
            assert_eq!(
                action.without_document.is_some(),
                action.without_document_label.is_some(),
                "{}",
                action.action
            );
            if action.without_document.is_some() {
                assert!(action.requires_document, "{}", action.action);
            }
        }
    }

    #[test]
    fn the_commands_that_work_without_a_document_are_the_few_that_need_none() {
        let free: BTreeSet<&str> = actions()
            .into_iter()
            .filter(|action| !action.requires_document)
            .map(|action| action.action.as_str())
            .collect();
        assert_eq!(
            free,
            BTreeSet::from([
                "about",
                "exit",
                "fullscreen",
                "images-to-pdf",
                "manage-signatures",
                "open",
                "reset-tips",
                "restore-recovery",
                "settings",
                "toggle-margin-comments",
                "welcome-tour"
            ])
        );
    }

    // --- the accelerators ---------------------------------------------------------------------------------------

    #[test]
    fn every_accelerator_is_one_muda_can_read() {
        // Tauri drops an accelerator that does not parse without any error, so the menu item would just lack its key.
        for action in actions() {
            if let Some(accelerator) = &action.accelerator {
                let parsed = accelerator.parse::<muda::accelerator::Accelerator>();
                assert!(
                    parsed.is_ok(),
                    "{}: {accelerator:?} is not an accelerator muda reads: {parsed:?}",
                    action.action
                );
            }
        }
    }

    #[test]
    fn no_accelerator_is_a_bare_key_or_used_twice() {
        let mut seen = BTreeSet::new();
        for action in actions() {
            let Some(accelerator) = &action.accelerator else {
                continue;
            };
            // A key equivalent without Cmd or Alt would take its letter from every text field.
            assert!(
                accelerator.starts_with("CmdOrCtrl+") || accelerator.starts_with("Alt+"),
                "{accelerator}"
            );
            assert!(seen.insert(accelerator.as_str()), "{accelerator} twice");
        }
    }

    // --- the texts ----------------------------------------------------------------------------------------------

    #[test]
    fn both_catalogs_parse_and_have_every_label_of_the_menu() {
        for locale in MenuLocale::ALL {
            let catalog = catalog(locale);
            assert!(!catalog.is_empty(), "{locale:?} catalog is empty");
            for key in label_keys() {
                let text = catalog.get(key);
                assert!(
                    text.is_some_and(|text| !text.trim().is_empty()),
                    "{locale:?} lacks {key}"
                );
            }
        }
    }

    #[test]
    fn a_damaged_catalog_is_an_empty_one_and_not_a_panic() {
        // Not valid JSON, and valid JSON of the wrong shape (a value that is not a string): both are logged and empty.
        assert!(parse_catalog("{ not json", "test").is_empty());
        assert!(parse_catalog(r#"{ "menu.file": 1 }"#, "test").is_empty());
        assert!(parse_catalog("", "test").is_empty());
        let parsed = parse_catalog(r#"{ "menu.file": "File" }"#, "test");
        assert_eq!(parsed.get("menu.file").map(String::as_str), Some("File"));
    }

    #[test]
    fn the_catalogs_have_no_menu_key_the_layout_does_not_use_and_the_layout_no_label_twice() {
        let used: BTreeSet<&str> = label_keys().into_iter().collect();
        assert_eq!(used.len(), label_keys().len(), "a label is used twice");
        for locale in MenuLocale::ALL {
            let in_catalog: BTreeSet<&str> = catalog(locale)
                .keys()
                .map(String::as_str)
                .filter(|key| key.starts_with("menu."))
                .collect();
            assert_eq!(in_catalog, used, "{locale:?}");
        }
    }

    #[test]
    fn only_the_app_menu_has_the_app_name_placeholder_and_nothing_else_is_a_placeholder() {
        // The app menu, and the Windows-only About of the Help menu (it has no app menu there).
        let app_menu_labels: BTreeSet<&str> = layout_or_fail().menus[0]
            .items
            .iter()
            .filter_map(|item| match item {
                ItemSpec::Predefined(item) => Some(item.label.as_str()),
                ItemSpec::Action(item) => Some(item.label.as_str()),
                ItemSpec::Separator(_) | ItemSpec::Submenu(_) => None,
            })
            .chain(["menu.help.about"])
            .collect();
        for locale in MenuLocale::ALL {
            for key in label_keys() {
                let text = &catalog(locale)[key];
                let without_app = text.replace("{app}", "");
                assert!(
                    !without_app.contains('{') && !without_app.contains('}'),
                    "{locale:?} {key}: {text}"
                );
                if text.contains("{app}") {
                    assert!(app_menu_labels.contains(key), "{locale:?} {key}");
                }
            }
        }
    }

    #[test]
    fn text_fills_in_the_app_name_and_follows_the_language() {
        assert_eq!(text(MenuLocale::En, "menu.app.quit", "Sheer"), "Quit Sheer");
        assert_eq!(
            text(MenuLocale::De, "menu.app.quit", "Sheer"),
            "Sheer beenden"
        );
        assert_eq!(text(MenuLocale::En, "menu.file", "Sheer"), "File");
        assert_eq!(text(MenuLocale::De, "menu.file", "Sheer"), "Datei");
        assert_eq!(text(MenuLocale::De, "menu.file.open", "Sheer"), "Öffnen…");
    }

    #[test]
    fn text_shows_the_key_when_nobody_has_it_and_inserts_the_name_as_it_is() {
        assert_eq!(
            text(MenuLocale::De, "menu.no.such.key", "Sheer"),
            "menu.no.such.key"
        );
        assert_eq!(text(MenuLocale::En, "", "Sheer"), "");
        assert_eq!(
            text(MenuLocale::En, "menu.app.hide", "$& {app}"),
            "Hide $& {app}"
        );
    }

    // --- the language -------------------------------------------------------------------------------------------

    fn system(tag: &str) -> Option<MenuLocale> {
        Some(MenuLocale::from_tag(tag))
    }

    #[test]
    fn an_explicit_language_is_that_language_whatever_the_os_says() {
        assert_eq!(
            MenuLocale::resolve(Language::En, system("de-DE")),
            MenuLocale::En
        );
        assert_eq!(
            MenuLocale::resolve(Language::De, system("en-US")),
            MenuLocale::De
        );
        assert_eq!(MenuLocale::resolve(Language::De, None), MenuLocale::De);
        assert_eq!(MenuLocale::resolve(Language::En, None), MenuLocale::En);
    }

    #[test]
    fn system_follows_the_os_language_and_is_english_until_it_is_known() {
        assert_eq!(
            MenuLocale::resolve(Language::System, system("de-AT")),
            MenuLocale::De
        );
        assert_eq!(
            MenuLocale::resolve(Language::System, system("fr")),
            MenuLocale::En
        );
        assert_eq!(MenuLocale::resolve(Language::System, None), MenuLocale::En);
    }

    #[test]
    fn a_tag_names_german_by_its_primary_subtag_like_the_frontend() {
        // The same cases as `resolveLocale` in src/i18n/i18n.test.ts.
        for tag in ["de", "de-DE", "de-AT", "de_CH", "DE", "De-at", "de-1996"] {
            assert_eq!(MenuLocale::from_tag(tag), MenuLocale::De, "{tag}");
        }
        for tag in [
            "en", "en-US", "fr", "fr-DE", "deu", "d", "", "-de", "x-de", "ja-JP",
        ] {
            assert_eq!(MenuLocale::from_tag(tag), MenuLocale::En, "{tag}");
        }
    }

    #[test]
    fn a_language_tag_that_is_not_one_counts_as_unknown() {
        let longest = format!("de-{}", "x".repeat(limits::MAX_LANGUAGE_TAG_LEN - 3));
        let too_long = format!("{longest}x");
        assert_eq!(longest.len(), limits::MAX_LANGUAGE_TAG_LEN);
        assert_eq!(
            MenuLocale::from_tag(&longest),
            MenuLocale::De,
            "the longest tag is still read"
        );
        for tag in [
            "de DE",
            "de;de",
            "de-\u{202e}",
            "de\0",
            "de-DE\n",
            "de/../..",
            "de-\u{e4}",
            too_long.as_str(),
        ] {
            assert_eq!(MenuLocale::from_tag(tag), MenuLocale::En, "{tag:?}");
        }
        // A hostile value is bounded however big it is.
        assert_eq!(
            MenuLocale::from_tag(&"de".repeat(1_000_000)),
            MenuLocale::En
        );
    }
}
