//! User settings: a small JSON file in the app data directory, mirrored in memory.
//!
//! Wire shape (camelCase, enum values lowercase):
//! `{ "glass": "auto" | "solid", "theme": "system" | "light" | "dark", "language": "system" | "en" | "de",
//! "leftPanelWidth": 192..=400, "welcomeTour": "pending" | "shown" }`.
//!
//! - **Reading** never fails: a missing, oversized, damaged or hand-edited file falls back to the defaults, field by
//!   field. The file is user-writable, so nothing in it is trusted beyond the enum values and the width range it can
//!   hold. Only a regular file is read (a directory, FIFO or device at the path counts as damaged), judged on the opened
//!   handle and not on the path, and the open never waits (`O_NONBLOCK`); never more than
//!   `limits::MAX_SETTINGS_FILE_BYTES` of it is read.
//! - **Updating** validates the whole patch first (unknown keys, unknown enum values and a width outside the range are
//!   `invalid_argument` with `what: "settings"`), then writes atomically and only then changes the in-memory copy, so a
//!   failed write leaves memory and disk in agreement. Updates are serialised, but reads are not: `get` never waits for
//!   the disk.

use std::fs::File;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, PoisonError};

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

use crate::error::{AppError, ErrorCode};
use crate::limits;
use crate::storage::atomic::write_atomic;
use crate::storage::open_without_blocking;

/// File name inside the app data directory.
pub const FILE_NAME: &str = "settings.json";

/// "Glass: Auto / Solid" (DESIGN §1). `Solid` forces the opaque surfaces; `Auto` follows the OS and the browser.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GlassMode {
    #[default]
    Auto,
    Solid,
}

/// Colour theme (DESIGN §1). `System` follows the OS.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ThemeMode {
    #[default]
    System,
    Light,
    Dark,
}

/// Interface language. `System` follows the OS language (the frontend resolves it: `de*` is German, everything else English);
/// `En` and `De` are the two shipped translations (`src/i18n/locales`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Language {
    #[default]
    System,
    En,
    De,
}

/// Whether the welcome tour (ADR-023, DESIGN 3.14) still has to run on a first launch. The UI writes `Shown` *before* it opens the
/// welcome document, so the tour never starts twice on its own.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WelcomeTour {
    #[default]
    Pending,
    Shown,
}

/// Width of the left panel in px (DESIGN 2, 3.8). Always within `limits::LEFT_PANEL_MIN_WIDTH..=LEFT_PANEL_MAX_WIDTH`:
/// the only ways in are [`PanelWidth::new`] and `Deserialize`, and both check the range. It is a plain number on the wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct PanelWidth(u16);

impl PanelWidth {
    /// `None` outside the allowed range.
    pub const fn new(pixels: u16) -> Option<Self> {
        if pixels >= limits::LEFT_PANEL_MIN_WIDTH && pixels <= limits::LEFT_PANEL_MAX_WIDTH {
            Some(Self(pixels))
        } else {
            None
        }
    }

    pub const fn get(self) -> u16 {
        self.0
    }
}

impl Default for PanelWidth {
    fn default() -> Self {
        Self(limits::LEFT_PANEL_DEFAULT_WIDTH)
    }
}

impl<'de> Deserialize<'de> for PanelWidth {
    /// An integer in range. A float, a string, a negative or an oversized number is an error, never clamped: a value that
    /// is not valid is a bad request (patch) or a damaged field (file), and the callers handle both.
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let pixels = u16::deserialize(deserializer)?;
        Self::new(pixels).ok_or_else(|| serde::de::Error::custom("panel width out of range"))
    }
}

/// Every persisted setting. Add a field here, to [`SettingsPatch`] and to `src/api/app.ts` together.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub glass: GlassMode,
    pub theme: ThemeMode,
    pub language: Language,
    pub left_panel_width: PanelWidth,
    pub welcome_tour: WelcomeTour,
}

impl Settings {
    /// Settings from stored bytes: every field that is missing or invalid becomes its default, unknown keys are
    /// ignored (a newer version may have written them).
    fn from_stored(bytes: &[u8]) -> Self {
        let Ok(Value::Object(map)) = serde_json::from_slice::<Value>(bytes) else {
            return Self::default();
        };
        Self {
            glass: map
                .get("glass")
                .and_then(|value| GlassMode::deserialize(value).ok())
                .unwrap_or_default(),
            theme: map
                .get("theme")
                .and_then(|value| ThemeMode::deserialize(value).ok())
                .unwrap_or_default(),
            language: map
                .get("language")
                .and_then(|value| Language::deserialize(value).ok())
                .unwrap_or_default(),
            left_panel_width: map
                .get("leftPanelWidth")
                .and_then(|value| PanelWidth::deserialize(value).ok())
                .unwrap_or_default(),
            welcome_tour: map
                .get("welcomeTour")
                .and_then(|value| WelcomeTour::deserialize(value).ok())
                .unwrap_or_default(),
        }
    }

    /// These settings with every field the patch names replaced.
    pub fn apply(self, patch: SettingsPatch) -> Self {
        Self {
            glass: patch.glass.unwrap_or(self.glass),
            theme: patch.theme.unwrap_or(self.theme),
            language: patch.language.unwrap_or(self.language),
            left_panel_width: patch.left_panel_width.unwrap_or(self.left_panel_width),
            welcome_tour: patch.welcome_tour.unwrap_or(self.welcome_tour),
        }
    }
}

/// A partial update: at most the five settings, each optional. Parsed only by [`SettingsPatch::from_value`], which
/// rejects every unknown key (`deny_unknown_fields`), so a patch can never name more than these five fields.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SettingsPatch {
    #[serde(default, deserialize_with = "present")]
    pub glass: Option<GlassMode>,
    #[serde(default, deserialize_with = "present")]
    pub theme: Option<ThemeMode>,
    #[serde(default, deserialize_with = "present")]
    pub language: Option<Language>,
    #[serde(default, deserialize_with = "present")]
    pub left_panel_width: Option<PanelWidth>,
    #[serde(default, deserialize_with = "present")]
    pub welcome_tour: Option<WelcomeTour>,
}

/// A field that is present must hold a valid value. Plain `Option` would read `null` as "absent" and accept it.
fn present<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

impl SettingsPatch {
    /// Validates the JSON the webview sent. It must be an object whose keys are known settings and whose values are
    /// valid for them. An empty object is a valid no-op. Anything else is `invalid_argument` (`what: "settings"`),
    /// so a bad request never reaches the file.
    pub fn from_value(value: &Value) -> Result<Self, AppError> {
        // A struct also deserializes from an array (field by field, in order), so the shape is checked first.
        if !value.is_object() {
            return Err(AppError::invalid("settings"));
        }
        Self::deserialize(value).map_err(|_| AppError::invalid("settings"))
    }
}

/// The settings of the running app: in memory, backed by one file.
#[derive(Debug)]
pub struct SettingsStore {
    path: PathBuf,
    /// The current settings. Locked only for the instant of a read or an assignment, never across file IO, so `get`
    /// cannot be held up by a slow disk.
    current: Mutex<Settings>,
    /// Serialises `update`: one writer at a time keeps the file in the same order as memory. This is the lock that is
    /// held across fsync and rename.
    writer: Mutex<()>,
}

impl SettingsStore {
    /// Loads the settings at `path`. Never fails; see the module docs.
    pub fn load(path: PathBuf) -> Self {
        let current = match read_bounded(&path) {
            Ok(bytes) => Settings::from_stored(&bytes),
            // First start: nothing stored yet.
            Err(error) if error.kind() == io::ErrorKind::NotFound => Settings::default(),
            Err(error) => {
                AppError::from(error).log();
                Settings::default()
            }
        };
        Self {
            path,
            current: Mutex::new(current),
            writer: Mutex::new(()),
        }
    }

    /// The current settings. Never waits for a write in progress: it answers with the last persisted state.
    pub fn get(&self) -> Settings {
        *self.lock()
    }

    /// Applies `patch`, persists the result atomically and returns it. If persisting fails, nothing changes.
    pub fn update(&self, patch: SettingsPatch) -> Result<Settings, AppError> {
        self.update_with(patch, |bytes| write_atomic(&self.path, bytes))
    }

    /// `update` with the persisting step passed in, so a test can hold the write open.
    fn update_with(
        &self,
        patch: SettingsPatch,
        persist: impl FnOnce(&[u8]) -> io::Result<()>,
    ) -> Result<Settings, AppError> {
        // The lock guards no data (`()`), so a poisoned one is safe to keep using.
        let _writer = self.writer.lock().unwrap_or_else(PoisonError::into_inner);
        // Only `update` assigns `current`, and updates are serialised, so it cannot change before the assignment below.
        let current = self.get();
        let next = current.apply(patch);
        if next != current {
            let mut bytes = serde_json::to_vec_pretty(&next)
                .map_err(|error| AppError::logged(ErrorCode::Internal, error))?;
            bytes.push(b'\n');
            persist(&bytes)?;
            *self.lock() = next;
        }
        Ok(next)
    }

    /// The settings are plain `Copy` data, so a panic elsewhere cannot leave them half-updated: a poisoned lock is safe
    /// to keep using.
    fn lock(&self) -> MutexGuard<'_, Settings> {
        self.current.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// Reads at most `MAX_SETTINGS_FILE_BYTES` of a regular file; a longer file is reported as invalid data instead of
/// being buffered.
///
/// The file is opened first and its type is read from the opened handle, never from the path: checking the path and then
/// opening it would leave a gap in which something else could be put at the path (a FIFO, a device, a link to a file the
/// user did not choose), and the check would be about the wrong thing. Opening is also where a FIFO hurts, so it is
/// opened without waiting (see `open_without_blocking`). The handle's metadata follows symlinks, so a link to a regular
/// file still works.
fn read_bounded(path: &Path) -> io::Result<Vec<u8>> {
    read_regular(open_without_blocking(path)?)
}

/// Reads at most `MAX_SETTINGS_FILE_BYTES` of `file`, which must be a regular file.
fn read_regular(file: File) -> io::Result<Vec<u8>> {
    if !file.metadata()?.is_file() {
        return Err(io::Error::from(io::ErrorKind::InvalidData));
    }
    let mut bytes = Vec::new();
    file.take(limits::MAX_SETTINGS_FILE_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limits::MAX_SETTINGS_FILE_BYTES {
        return Err(io::Error::from(io::ErrorKind::InvalidData));
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::sync::{mpsc, Arc};
    use std::thread;
    use std::time::Duration;

    use serde_json::json;

    use super::*;
    use crate::error::UiError;
    use crate::storage::atomic::testutil::TempDir;

    fn store_in(dir: &TempDir) -> SettingsStore {
        SettingsStore::load(dir.path().join(FILE_NAME))
    }

    fn patch(value: Value) -> Result<SettingsPatch, AppError> {
        SettingsPatch::from_value(&value)
    }

    fn rejected(value: Value) -> String {
        serde_json::to_string(&UiError::from(patch(value).unwrap_err())).unwrap()
    }

    const INVALID_SETTINGS: &str = r#"{"code":"invalid_argument","key":"error.invalid_argument","retryable":false,"params":{"what":"settings"}}"#;

    // --- wire shape ---

    #[test]
    fn settings_serialize_with_lowercase_enum_values() {
        assert_eq!(
            serde_json::to_value(Settings::default()).unwrap(),
            json!({ "glass": "auto", "theme": "system", "language": "system", "leftPanelWidth": 248, "welcomeTour": "pending" })
        );
        let settings = Settings {
            glass: GlassMode::Solid,
            theme: ThemeMode::Dark,
            language: Language::De,
            left_panel_width: PanelWidth::new(320).unwrap(),
            welcome_tour: WelcomeTour::Shown,
        };
        assert_eq!(
            serde_json::to_value(settings).unwrap(),
            json!({ "glass": "solid", "theme": "dark", "language": "de", "leftPanelWidth": 320, "welcomeTour": "shown" })
        );
    }

    // --- the welcome tour flag (ADR-023) ---

    #[test]
    fn the_welcome_tour_is_pending_by_default_and_a_patch_can_mark_it_shown() {
        assert_eq!(Settings::default().welcome_tour, WelcomeTour::Pending);
        let patched = Settings::default().apply(patch(json!({ "welcomeTour": "shown" })).unwrap());
        assert_eq!(patched.welcome_tour, WelcomeTour::Shown);
        // Another field leaves it alone.
        let other = patched.apply(patch(json!({ "theme": "dark" })).unwrap());
        assert_eq!(other.welcome_tour, WelcomeTour::Shown);
    }

    #[test]
    fn an_invalid_welcome_tour_value_is_refused_in_a_patch_and_falls_back_to_pending_in_a_file() {
        for bad in [
            json!("done"),
            json!(true),
            json!(null),
            json!(1),
            json!("Shown"),
        ] {
            assert_eq!(
                rejected(json!({ "welcomeTour": bad.clone() })),
                INVALID_SETTINGS,
                "{bad}"
            );
        }
        assert_eq!(
            Settings::from_stored(br#"{"welcomeTour":"shown"}"#).welcome_tour,
            WelcomeTour::Shown
        );
        for stored in [
            r#"{"welcomeTour":"done"}"#,
            r#"{"welcomeTour":3}"#,
            r#"{"welcomeTour":null}"#,
            r#"{}"#,
        ] {
            assert_eq!(
                Settings::from_stored(stored.as_bytes()).welcome_tour,
                WelcomeTour::Pending,
                "{stored}"
            );
        }
    }

    // --- patch validation ---

    #[test]
    fn a_patch_accepts_every_valid_value() {
        for (name, glass) in [("auto", GlassMode::Auto), ("solid", GlassMode::Solid)] {
            assert_eq!(
                patch(json!({ "glass": name })).unwrap(),
                SettingsPatch {
                    glass: Some(glass),
                    ..SettingsPatch::default()
                }
            );
        }
        for (name, theme) in [
            ("system", ThemeMode::System),
            ("light", ThemeMode::Light),
            ("dark", ThemeMode::Dark),
        ] {
            assert_eq!(
                patch(json!({ "theme": name })).unwrap(),
                SettingsPatch {
                    theme: Some(theme),
                    ..SettingsPatch::default()
                }
            );
        }
        for (name, language) in [
            ("system", Language::System),
            ("en", Language::En),
            ("de", Language::De),
        ] {
            assert_eq!(
                patch(json!({ "language": name })).unwrap(),
                SettingsPatch {
                    language: Some(language),
                    ..SettingsPatch::default()
                }
            );
        }
        assert_eq!(
            patch(json!({ "glass": "solid", "theme": "light", "language": "en", "leftPanelWidth": 296 }))
                .unwrap(),
            SettingsPatch {
                glass: Some(GlassMode::Solid),
                theme: Some(ThemeMode::Light),
                language: Some(Language::En),
                left_panel_width: PanelWidth::new(296),
                welcome_tour: None,
            }
        );
    }

    #[test]
    fn a_panel_width_patch_accepts_exactly_the_design_range() {
        for pixels in [192, 193, 248, 399, 400] {
            assert_eq!(
                patch(json!({ "leftPanelWidth": pixels })).unwrap(),
                SettingsPatch {
                    left_panel_width: PanelWidth::new(pixels),
                    ..SettingsPatch::default()
                },
                "{pixels}"
            );
        }
        for bad in [
            json!(0),
            json!(191),
            json!(401),
            json!(65_535),
            json!(65_536),
            json!(-248),
            json!(248.5),
            json!(248.0),
            json!("248"),
            json!(null),
            json!(true),
            json!([248]),
            json!({ "px": 248 }),
        ] {
            assert_eq!(
                rejected(json!({ "leftPanelWidth": bad.clone() })),
                INVALID_SETTINGS,
                "{bad}"
            );
        }
        // The wire name is exact: the Rust field name is not accepted.
        assert_eq!(
            rejected(json!({ "left_panel_width": 248 })),
            INVALID_SETTINGS
        );
    }

    #[test]
    fn the_panel_width_range_is_the_one_in_limits() {
        assert_eq!(
            PanelWidth::default().get(),
            limits::LEFT_PANEL_DEFAULT_WIDTH
        );
        assert!(PanelWidth::new(limits::LEFT_PANEL_MIN_WIDTH).is_some());
        assert!(PanelWidth::new(limits::LEFT_PANEL_MAX_WIDTH).is_some());
        assert!(PanelWidth::new(limits::LEFT_PANEL_MIN_WIDTH - 1).is_none());
        assert!(PanelWidth::new(limits::LEFT_PANEL_MAX_WIDTH + 1).is_none());
        // The default is inside the range (the order of the three is checked at compile time in `limits`).
        assert!(PanelWidth::new(limits::LEFT_PANEL_DEFAULT_WIDTH).is_some());
    }

    #[test]
    fn an_empty_patch_is_a_valid_no_op() {
        assert_eq!(patch(json!({})).unwrap(), SettingsPatch::default());
    }

    #[test]
    fn a_patch_rejects_unknown_enum_values() {
        for bad in [
            "Solid", "AUTO", "dark ", " dark", "", "blur", "reduced", "none", "dark\0",
        ] {
            assert_eq!(
                rejected(json!({ "glass": bad })),
                INVALID_SETTINGS,
                "{bad:?}"
            );
            assert_eq!(
                rejected(json!({ "theme": bad })),
                INVALID_SETTINGS,
                "{bad:?}"
            );
        }
        // Language tags are not accepted: only the three wire names, in lowercase.
        for bad in [
            "De", "EN", "de-DE", "en_US", "fr", "german", "", " de", "en ", "de\0", "auto",
        ] {
            assert_eq!(
                rejected(json!({ "language": bad })),
                INVALID_SETTINGS,
                "{bad:?}"
            );
        }
        // Values of the other setting are not valid either.
        assert_eq!(rejected(json!({ "glass": "dark" })), INVALID_SETTINGS);
        assert_eq!(rejected(json!({ "theme": "solid" })), INVALID_SETTINGS);
        assert_eq!(rejected(json!({ "language": "dark" })), INVALID_SETTINGS);
        assert_eq!(rejected(json!({ "theme": "de" })), INVALID_SETTINGS);
    }

    #[test]
    fn a_patch_rejects_values_that_are_not_strings() {
        for bad in [
            json!(null),
            json!(true),
            json!(0),
            json!(["auto"]),
            json!({ "auto": 1 }),
        ] {
            assert_eq!(rejected(json!({ "glass": bad.clone() })), INVALID_SETTINGS);
            assert_eq!(rejected(json!({ "theme": bad.clone() })), INVALID_SETTINGS);
            assert_eq!(rejected(json!({ "language": bad })), INVALID_SETTINGS);
        }
    }

    #[test]
    fn a_patch_rejects_unknown_keys_and_non_objects() {
        assert_eq!(rejected(json!({ "colour": "red" })), INVALID_SETTINGS);
        assert_eq!(
            rejected(json!({ "glass": "auto", "../x": 1 })),
            INVALID_SETTINGS
        );
        for bad in [
            json!(null),
            json!("glass"),
            json!(3),
            json!([]),
            // A struct would also read an array field by field; a patch must be an object.
            json!(["solid", "dark"]),
            json!(["solid"]),
            json!(true),
        ] {
            assert_eq!(rejected(bad), INVALID_SETTINGS);
        }
    }

    #[test]
    fn a_patch_can_name_at_most_the_four_settings() {
        // Every key beyond the four known ones is unknown, so a patch with more than four keys never passes. The check
        // stops at the first unknown key: a huge object is refused without being walked.
        assert_eq!(
            rejected(
                json!({ "glass": "solid", "theme": "dark", "language": "de", "leftPanelWidth": 248, "extra": 1 })
            ),
            INVALID_SETTINGS
        );
        let huge: serde_json::Map<String, Value> =
            (0..10_000).map(|n| (format!("key{n}"), json!(n))).collect();
        assert_eq!(rejected(Value::Object(huge)), INVALID_SETTINGS);
        // Key names are case-sensitive and exact.
        for key in [
            "Glass",
            "THEME",
            "glass ",
            "",
            "theme\0",
            "glass.theme",
            "LeftPanelWidth",
            "Language",
        ] {
            assert_eq!(
                rejected(json!({ key: "auto" })),
                INVALID_SETTINGS,
                "{key:?}"
            );
        }
    }

    #[test]
    fn a_rejection_names_no_value() {
        // The error carries the fixed word "settings", never the offending input.
        let text = rejected(json!({ "glass": "C:\\Users\\user\\secret" }));
        assert!(!text.contains("secret"), "{text}");
        assert_eq!(text, INVALID_SETTINGS);
    }

    #[test]
    fn apply_replaces_only_the_named_fields() {
        let base = Settings {
            glass: GlassMode::Solid,
            theme: ThemeMode::Dark,
            ..Settings::default()
        };
        let only_theme = patch(json!({ "theme": "light" })).unwrap();
        assert_eq!(
            base.apply(only_theme),
            Settings {
                glass: GlassMode::Solid,
                theme: ThemeMode::Light,
                ..Settings::default()
            }
        );
        let only_width = patch(json!({ "leftPanelWidth": 304 })).unwrap();
        assert_eq!(
            base.apply(only_width),
            Settings {
                left_panel_width: PanelWidth::new(304).unwrap(),
                ..base
            }
        );
        assert_eq!(base.apply(SettingsPatch::default()), base);
    }

    // --- loading ---

    #[test]
    fn a_missing_file_gives_the_defaults() {
        let dir = TempDir::new();
        assert_eq!(store_in(&dir).get(), Settings::default());
    }

    #[test]
    fn damaged_files_give_the_defaults() {
        for contents in [
            &b""[..],
            b"not json",
            b"[]",
            b"null",
            b"{\"glass\":",
            &[0xff, 0xfe, 0x00],
        ] {
            let dir = TempDir::new();
            fs::write(dir.path().join(FILE_NAME), contents).unwrap();
            assert_eq!(store_in(&dir).get(), Settings::default(), "{contents:?}");
        }
    }

    #[test]
    fn invalid_fields_fall_back_one_by_one() {
        let dir = TempDir::new();
        fs::write(
            dir.path().join(FILE_NAME),
            r#"{"glass":"frosted","theme":"dark","leftPanelWidth":9999,"future":{"x":1}}"#,
        )
        .unwrap();
        assert_eq!(
            store_in(&dir).get(),
            Settings {
                theme: ThemeMode::Dark,
                ..Settings::default()
            }
        );
    }

    #[test]
    fn a_stored_panel_width_is_read_only_inside_the_range() {
        for (contents, expected) in [
            (r#"{"leftPanelWidth":192}"#, 192),
            (r#"{"leftPanelWidth":400}"#, 400),
            (r#"{"leftPanelWidth":320}"#, 320),
            // Out of range, wrong type or missing: the default, never a clamped guess.
            (r#"{"leftPanelWidth":191}"#, 248),
            (r#"{"leftPanelWidth":401}"#, 248),
            (r#"{"leftPanelWidth":-1}"#, 248),
            (r#"{"leftPanelWidth":300.5}"#, 248),
            (r#"{"leftPanelWidth":"300"}"#, 248),
            (r#"{"leftPanelWidth":null}"#, 248),
            (r#"{"left_panel_width":300}"#, 248),
            (r#"{}"#, 248),
        ] {
            let dir = TempDir::new();
            fs::write(dir.path().join(FILE_NAME), contents).unwrap();
            assert_eq!(
                store_in(&dir).get().left_panel_width.get(),
                expected,
                "{contents}"
            );
        }
    }

    #[test]
    fn an_oversized_file_is_not_read() {
        let dir = TempDir::new();
        let padding = " ".repeat(usize::try_from(limits::MAX_SETTINGS_FILE_BYTES).unwrap());
        fs::write(
            dir.path().join(FILE_NAME),
            format!(r#"{{"theme":"dark"}}{padding}"#),
        )
        .unwrap();
        assert_eq!(store_in(&dir).get(), Settings::default());
        // Exactly at the limit is still read.
        let padding = " ".repeat(usize::try_from(limits::MAX_SETTINGS_FILE_BYTES).unwrap() - 16);
        fs::write(
            dir.path().join(FILE_NAME),
            format!(r#"{{"theme":"dark"}}{padding}"#),
        )
        .unwrap();
        assert_eq!(store_in(&dir).get().theme, ThemeMode::Dark);
    }

    // --- updating and persisting ---

    #[test]
    fn updates_are_persisted_and_survive_a_restart() {
        let dir = TempDir::new();
        let store = store_in(&dir);
        let updated = store
            .update(
                patch(json!({ "glass": "solid", "theme": "dark", "language": "de", "leftPanelWidth": 280 }))
                    .unwrap(),
            )
            .unwrap();
        assert_eq!(
            updated,
            Settings {
                glass: GlassMode::Solid,
                theme: ThemeMode::Dark,
                language: Language::De,
                left_panel_width: PanelWidth::new(280).unwrap(),
                welcome_tour: WelcomeTour::Pending,
            }
        );
        assert_eq!(store.get(), updated);
        assert_eq!(store_in(&dir).get(), updated);

        let stored: Value =
            serde_json::from_slice(&fs::read(dir.path().join(FILE_NAME)).unwrap()).unwrap();
        assert_eq!(
            stored,
            json!({ "glass": "solid", "theme": "dark", "language": "de", "leftPanelWidth": 280, "welcomeTour": "pending" })
        );
    }

    #[test]
    fn a_partial_update_keeps_the_other_field() {
        let dir = TempDir::new();
        let store = store_in(&dir);
        store
            .update(patch(json!({ "theme": "light" })).unwrap())
            .unwrap();
        let updated = store
            .update(patch(json!({ "glass": "solid" })).unwrap())
            .unwrap();
        assert_eq!(
            updated,
            Settings {
                glass: GlassMode::Solid,
                theme: ThemeMode::Light,
                ..Settings::default()
            }
        );
        assert_eq!(store_in(&dir).get(), updated);
    }

    #[test]
    fn writing_leaves_only_the_settings_file_behind() {
        let dir = TempDir::new();
        store_in(&dir)
            .update(patch(json!({ "theme": "dark" })).unwrap())
            .unwrap();
        let names: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(names, [FILE_NAME]);
    }

    #[test]
    fn an_unchanged_update_does_not_touch_the_disk() {
        let dir = TempDir::new();
        let store = store_in(&dir);
        store.update(SettingsPatch::default()).unwrap();
        store
            .update(patch(json!({ "theme": "system" })).unwrap())
            .unwrap();
        assert!(!dir.path().join(FILE_NAME).exists());
    }

    #[test]
    fn a_failed_write_changes_nothing_in_memory() {
        let dir = TempDir::new();
        // The settings "file" is a non-empty directory, so the final rename cannot succeed.
        let path = dir.path().join(FILE_NAME);
        fs::create_dir(&path).unwrap();
        fs::write(path.join("child"), b"x").unwrap();
        let store = SettingsStore::load(path);
        assert_eq!(store.get(), Settings::default());
        let error = store
            .update(patch(json!({ "theme": "dark" })).unwrap())
            .unwrap_err();
        assert_ne!(error.code(), ErrorCode::InvalidArgument);
        assert_eq!(store.get(), Settings::default());
    }

    // --- loading: only regular files are opened ---

    #[test]
    fn a_directory_at_the_settings_path_gives_the_defaults() {
        let dir = TempDir::new();
        fs::create_dir(dir.path().join(FILE_NAME)).unwrap();
        assert_eq!(store_in(&dir).get(), Settings::default());
    }

    #[test]
    fn read_bounded_refuses_anything_but_a_regular_file() {
        let dir = TempDir::new();
        // A directory is damaged data, not "first start": the difference decides whether the load is logged.
        let error = read_bounded(dir.path()).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
        let error = read_bounded(&dir.path().join("missing.json")).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::NotFound);
        let file = dir.path().join(FILE_NAME);
        fs::write(&file, b"{}").unwrap();
        assert_eq!(read_bounded(&file).unwrap(), b"{}");
    }

    #[cfg(unix)]
    #[test]
    fn a_fifo_at_the_settings_path_does_not_block_the_load() {
        let dir = TempDir::new();
        let path = dir.path().join(FILE_NAME);
        // mkfifo(1) instead of `libc::mkfifo`, which is an unsafe call and `unsafe_code` is forbidden (the open flags above
        // come from libc as plain constants). Where mkfifo is missing there is nothing to test.
        let made = std::process::Command::new("mkfifo")
            .arg(&path)
            .status()
            .is_ok_and(|status| status.success());
        if !made {
            return;
        }
        let (sender, receiver) = mpsc::channel();
        thread::spawn(move || {
            let _ = sender.send(SettingsStore::load(path).get());
        });
        // A plain `open` of a FIFO that nobody writes to blocks for ever, so the load runs on its own thread.
        let settings = receiver
            .recv_timeout(WAIT)
            .expect("load returned without opening the FIFO");
        assert_eq!(settings, Settings::default());
    }

    #[cfg(unix)]
    #[test]
    fn a_device_is_turned_down_without_being_read() {
        // `/dev/zero` never ends: reading it would only stop at the size cap, and it must not even get that far.
        let error = read_bounded(Path::new("/dev/zero")).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    }

    #[cfg(unix)]
    #[test]
    fn the_type_is_taken_from_the_opened_handle_not_from_the_path() {
        let dir = TempDir::new();
        let path = dir.path().join(FILE_NAME);
        fs::write(&path, b"{}").unwrap();
        let handle = open_without_blocking(&path).unwrap();
        // The path now names something else: what could be swapped in between a check of the path and an open of it.
        fs::remove_file(&path).unwrap();
        fs::create_dir(&path).unwrap();
        assert_eq!(read_regular(handle).unwrap(), b"{}");
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_to_a_regular_file_is_read() {
        let dir = TempDir::new();
        let real = dir.path().join("real.json");
        fs::write(&real, br#"{"theme":"dark"}"#).unwrap();
        let link = dir.path().join(FILE_NAME);
        std::os::unix::fs::symlink(&real, &link).unwrap();
        assert_eq!(SettingsStore::load(link).get().theme, ThemeMode::Dark);
    }

    // --- hardening: unknown keys, odd files, the whole path from the webview to the file ---

    /// What the `update_settings` command does: validate the whole patch, then persist it.
    fn apply_json(store: &SettingsStore, value: Value) -> Result<Settings, AppError> {
        store.update(SettingsPatch::from_value(&value)?)
    }

    #[test]
    fn a_patch_with_an_unknown_key_applies_nothing_and_never_touches_the_file() {
        let dir = TempDir::new();
        let store = store_in(&dir);
        // Nothing stored yet: a rejected patch must not create the file either.
        for bad in [
            json!({ "colour": "red" }),
            json!({ "theme": "dark", "colour": "red" }),
            json!({ "glass": "solid", "theme": "dark", "extra": null }),
            json!({ "theme": "neon" }),
            json!(["theme", "dark"]),
        ] {
            let error = apply_json(&store, bad).unwrap_err();
            assert_eq!(error.code(), ErrorCode::InvalidArgument);
        }
        assert!(!dir.path().join(FILE_NAME).exists());
        assert_eq!(store.get(), Settings::default());

        // With a stored file: the same, byte for byte.
        apply_json(&store, json!({ "theme": "light" })).unwrap();
        let before = fs::read(dir.path().join(FILE_NAME)).unwrap();
        let error =
            apply_json(&store, json!({ "glass": "solid", "theme": "dark", "x": 1 })).unwrap_err();
        assert_eq!(error.code(), ErrorCode::InvalidArgument);
        assert_eq!(fs::read(dir.path().join(FILE_NAME)).unwrap(), before);
        assert_eq!(store.get().theme, ThemeMode::Light);
        assert_eq!(store.get().glass, GlassMode::Auto);
    }

    #[test]
    fn the_stored_file_holds_exactly_the_five_settings_as_json_with_a_final_newline() {
        let dir = TempDir::new();
        let store = store_in(&dir);
        apply_json(&store, json!({ "glass": "solid" })).unwrap();
        let bytes = fs::read(dir.path().join(FILE_NAME)).unwrap();
        assert_eq!(bytes.last(), Some(&b'\n'));
        let stored: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            stored,
            json!({ "glass": "solid", "theme": "system", "language": "system", "leftPanelWidth": 248, "welcomeTour": "pending" })
        );
    }

    #[test]
    fn the_language_is_persisted_and_read_back_field_by_field() {
        let dir = TempDir::new();
        let store = store_in(&dir);
        assert_eq!(store.get().language, Language::System);
        apply_json(&store, json!({ "language": "de" })).unwrap();
        assert_eq!(store_in(&dir).get().language, Language::De);
        // A partial update of another field keeps the language.
        apply_json(&store, json!({ "glass": "solid" })).unwrap();
        assert_eq!(store_in(&dir).get().language, Language::De);

        for (contents, expected) in [
            (r#"{"language":"en"}"#, Language::En),
            (r#"{"language":"system"}"#, Language::System),
            // Invalid, mistyped or missing: the default, never a guess.
            (r#"{"language":"De"}"#, Language::System),
            (r#"{"language":"de-DE"}"#, Language::System),
            (r#"{"language":"fr"}"#, Language::System),
            (r#"{"language":null}"#, Language::System),
            (r#"{"language":["de"]}"#, Language::System),
            (r#"{"Language":"de"}"#, Language::System),
            (r#"{"theme":"dark"}"#, Language::System),
        ] {
            let dir = TempDir::new();
            fs::write(dir.path().join(FILE_NAME), contents).unwrap();
            assert_eq!(store_in(&dir).get().language, expected, "{contents}");
        }
    }

    #[test]
    fn fields_of_the_wrong_type_or_spelling_fall_back_to_the_defaults() {
        for contents in [
            r#"{"glass":null,"theme":["dark"]}"#,
            r#"{"glass":1,"theme":{"x":"dark"}}"#,
            r#"{"Glass":"solid","THEME":"dark"}"#,
            r#"{"glass":"Solid","theme":"DARK"}"#,
            r#"{"settings":{"glass":"solid","theme":"dark"}}"#,
            r#"{"LeftPanelWidth":300}"#,
        ] {
            let dir = TempDir::new();
            fs::write(dir.path().join(FILE_NAME), contents).unwrap();
            assert_eq!(store_in(&dir).get(), Settings::default(), "{contents}");
        }
    }

    #[test]
    fn a_file_with_anything_after_the_json_is_damaged_as_a_whole() {
        let dir = TempDir::new();
        fs::write(
            dir.path().join(FILE_NAME),
            r#"{"glass":"solid","theme":"dark"} trailing"#,
        )
        .unwrap();
        assert_eq!(store_in(&dir).get(), Settings::default());
    }

    #[test]
    fn a_file_one_byte_over_the_limit_is_not_read() {
        let dir = TempDir::new();
        let limit = usize::try_from(limits::MAX_SETTINGS_FILE_BYTES).unwrap();
        let mut bytes = br#"{"theme":"dark"}"#.to_vec();
        bytes.resize(limit, b' ');
        fs::write(dir.path().join(FILE_NAME), &bytes).unwrap();
        assert_eq!(store_in(&dir).get().theme, ThemeMode::Dark);
        bytes.push(b' ');
        fs::write(dir.path().join(FILE_NAME), &bytes).unwrap();
        assert_eq!(store_in(&dir).get(), Settings::default());
    }

    #[test]
    fn an_update_heals_a_damaged_file_and_creates_a_missing_directory() {
        let dir = TempDir::new();
        fs::write(dir.path().join(FILE_NAME), b"not json").unwrap();
        let store = store_in(&dir);
        apply_json(&store, json!({ "theme": "dark" })).unwrap();
        assert_eq!(store_in(&dir).get().theme, ThemeMode::Dark);

        let nested = dir.path().join("first").join("run").join(FILE_NAME);
        let store = SettingsStore::load(nested.clone());
        assert_eq!(store.get(), Settings::default());
        apply_json(&store, json!({ "glass": "solid" })).unwrap();
        assert_eq!(SettingsStore::load(nested).get().glass, GlassMode::Solid);
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_to_a_directory_or_to_nothing_gives_the_defaults() {
        let dir = TempDir::new();
        let target_dir = dir.path().join("a-directory");
        fs::create_dir(&target_dir).unwrap();
        let link = dir.path().join(FILE_NAME);
        std::os::unix::fs::symlink(&target_dir, &link).unwrap();
        assert_eq!(SettingsStore::load(link.clone()).get(), Settings::default());
        fs::remove_file(&link).unwrap();
        std::os::unix::fs::symlink(dir.path().join("missing"), &link).unwrap();
        assert_eq!(SettingsStore::load(link).get(), Settings::default());
    }

    // --- locking: reads do not wait for the disk, writes are serialised ---

    /// Upper bound for a step that should be instant. A failure shows up as a timeout instead of a hung test run.
    const WAIT: Duration = Duration::from_secs(10);

    /// A persisting step that signals `started`, then stays open until `release` fires.
    fn held_open(
        started: mpsc::Sender<()>,
        release: mpsc::Receiver<()>,
    ) -> impl FnOnce(&[u8]) -> io::Result<()> {
        move |_| {
            started.send(()).unwrap();
            release
                .recv_timeout(WAIT)
                .map_err(|_| io::Error::from(io::ErrorKind::TimedOut))
        }
    }

    #[test]
    fn get_does_not_wait_for_a_write_in_progress() {
        let dir = TempDir::new();
        let store = Arc::new(store_in(&dir));
        let (started_sender, started) = mpsc::channel();
        let (release_sender, release) = mpsc::channel();
        let writer = {
            let store = Arc::clone(&store);
            thread::spawn(move || {
                store.update_with(
                    patch(json!({ "theme": "dark" })).unwrap(),
                    held_open(started_sender, release),
                )
            })
        };
        started.recv_timeout(WAIT).expect("the write started");

        // The write is open (it would be inside fsync or rename). `get` runs on its own thread, so a lock that blocks
        // it fails the test with a timeout.
        let (answer_sender, answer) = mpsc::channel();
        let reader = {
            let store = Arc::clone(&store);
            thread::spawn(move || {
                let _ = answer_sender.send(store.get());
            })
        };
        let during = answer
            .recv_timeout(WAIT)
            .expect("get answered while the write was open");
        // Nothing is persisted yet, so memory still holds the old settings.
        assert_eq!(during, Settings::default());

        release_sender.send(()).unwrap();
        let updated = writer.join().unwrap().unwrap();
        reader.join().unwrap();
        assert_eq!(updated.theme, ThemeMode::Dark);
        assert_eq!(store.get(), updated);
    }

    #[test]
    fn a_second_update_waits_for_the_first_and_builds_on_it() {
        let dir = TempDir::new();
        let store = Arc::new(store_in(&dir));
        let (started_sender, started) = mpsc::channel();
        let (release_sender, release) = mpsc::channel();
        let first = {
            let store = Arc::clone(&store);
            thread::spawn(move || {
                store.update_with(
                    patch(json!({ "theme": "dark" })).unwrap(),
                    held_open(started_sender, release),
                )
            })
        };
        started.recv_timeout(WAIT).expect("the first write started");

        let (done_sender, done) = mpsc::channel();
        let second = {
            let store = Arc::clone(&store);
            thread::spawn(move || {
                let result = store.update(patch(json!({ "glass": "solid" })).unwrap());
                let _ = done_sender.send(());
                result
            })
        };
        // The second update is queued behind the first. A pause cannot make this fail wrongly, only catch a bug.
        assert!(done.recv_timeout(Duration::from_millis(200)).is_err());

        release_sender.send(()).unwrap();
        first.join().unwrap().unwrap();
        let both = second.join().unwrap().unwrap();
        let expected = Settings {
            glass: GlassMode::Solid,
            theme: ThemeMode::Dark,
            ..Settings::default()
        };
        assert_eq!(both, expected);
        assert_eq!(store.get(), expected);
        assert_eq!(store_in(&dir).get(), expected);
    }

    #[test]
    fn a_failed_persist_leaves_memory_alone_and_the_next_update_works() {
        let dir = TempDir::new();
        let store = store_in(&dir);
        let error = store
            .update_with(patch(json!({ "theme": "dark" })).unwrap(), |_| {
                Err(io::Error::from(io::ErrorKind::PermissionDenied))
            })
            .unwrap_err();
        assert_eq!(error.code(), ErrorCode::IoPermissionDenied);
        assert_eq!(store.get(), Settings::default());
        // The writer lock was released: a later update goes through.
        let updated = store
            .update(patch(json!({ "theme": "light" })).unwrap())
            .unwrap();
        assert_eq!(updated.theme, ThemeMode::Light);
    }
}
