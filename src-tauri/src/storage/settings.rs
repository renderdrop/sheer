//! User settings: a small JSON file in the app data directory, mirrored in memory.
//!
//! Wire shape (camelCase, enum values lowercase): `{ "glass": "auto" | "solid", "theme": "system" | "light" | "dark" }`.
//!
//! - **Reading** never fails: a missing, oversized, damaged or hand-edited file falls back to the defaults, field by
//!   field. The file is user-writable, so nothing in it is trusted beyond the enum values it can hold.
//! - **Updating** validates the whole patch first (unknown keys and unknown enum values are `invalid_argument` with
//!   `what: "settings"`), then writes atomically and only then changes the in-memory copy, so a failed write leaves
//!   memory and disk in agreement.

use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, PoisonError};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{AppError, ErrorCode};
use crate::limits;
use crate::storage::atomic::write_atomic;

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

/// Every persisted setting. Add a field here, to [`SettingsPatch`] and to `src/api/app.ts` together.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub glass: GlassMode,
    pub theme: ThemeMode,
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
        }
    }

    /// These settings with every field the patch names replaced.
    pub fn apply(self, patch: SettingsPatch) -> Self {
        Self {
            glass: patch.glass.unwrap_or(self.glass),
            theme: patch.theme.unwrap_or(self.theme),
        }
    }
}

/// A validated partial update. Built only by [`SettingsPatch::from_value`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct SettingsPatch {
    pub glass: Option<GlassMode>,
    pub theme: Option<ThemeMode>,
}

impl SettingsPatch {
    /// Validates the JSON the webview sent. It must be an object whose keys are known settings and whose values are
    /// valid for them. An empty object is a valid no-op. Anything else is `invalid_argument` (`what: "settings"`),
    /// so a bad request never reaches the file.
    pub fn from_value(value: &Value) -> Result<Self, AppError> {
        let Value::Object(map) = value else {
            return Err(AppError::invalid("settings"));
        };
        let mut patch = Self::default();
        for (key, value) in map {
            match key.as_str() {
                "glass" => patch.glass = Some(parse_value(value)?),
                "theme" => patch.theme = Some(parse_value(value)?),
                _ => return Err(AppError::invalid("settings")),
            }
        }
        Ok(patch)
    }
}

fn parse_value<'de, T: Deserialize<'de>>(value: &'de Value) -> Result<T, AppError> {
    T::deserialize(value).map_err(|_| AppError::invalid("settings"))
}

/// The settings of the running app: in memory, backed by one file.
#[derive(Debug)]
pub struct SettingsStore {
    path: PathBuf,
    current: Mutex<Settings>,
}

impl SettingsStore {
    /// Loads the settings at `path`. Never fails; see the module docs.
    pub fn load(path: PathBuf) -> Self {
        let current = match read_bounded(&path) {
            Ok(bytes) => Settings::from_stored(&bytes),
            // First start: nothing stored yet.
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Settings::default(),
            Err(error) => {
                AppError::from(error).log();
                Settings::default()
            }
        };
        Self {
            path,
            current: Mutex::new(current),
        }
    }

    pub fn get(&self) -> Settings {
        *self.lock()
    }

    /// Applies `patch`, persists the result atomically and returns it. If persisting fails, nothing changes.
    pub fn update(&self, patch: SettingsPatch) -> Result<Settings, AppError> {
        let mut current = self.lock();
        let next = current.apply(patch);
        if next != *current {
            let mut bytes = serde_json::to_vec_pretty(&next)
                .map_err(|error| AppError::logged(ErrorCode::Internal, error))?;
            bytes.push(b'\n');
            write_atomic(&self.path, &bytes)?;
            *current = next;
        }
        Ok(next)
    }

    /// The settings are plain `Copy` data, so a panic elsewhere cannot leave them half-updated: a poisoned lock is safe
    /// to keep using.
    fn lock(&self) -> MutexGuard<'_, Settings> {
        self.current.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// Reads at most `MAX_SETTINGS_FILE_BYTES`; a longer file is reported as invalid data instead of being buffered.
fn read_bounded(path: &Path) -> std::io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    File::open(path)?
        .take(limits::MAX_SETTINGS_FILE_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limits::MAX_SETTINGS_FILE_BYTES {
        return Err(std::io::Error::from(std::io::ErrorKind::InvalidData));
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use std::fs;

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
            json!({ "glass": "auto", "theme": "system" })
        );
        let settings = Settings {
            glass: GlassMode::Solid,
            theme: ThemeMode::Dark,
        };
        assert_eq!(
            serde_json::to_value(settings).unwrap(),
            json!({ "glass": "solid", "theme": "dark" })
        );
    }

    // --- patch validation ---

    #[test]
    fn a_patch_accepts_every_valid_value() {
        for (name, glass) in [("auto", GlassMode::Auto), ("solid", GlassMode::Solid)] {
            assert_eq!(
                patch(json!({ "glass": name })).unwrap(),
                SettingsPatch {
                    glass: Some(glass),
                    theme: None
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
                    glass: None,
                    theme: Some(theme)
                }
            );
        }
        assert_eq!(
            patch(json!({ "glass": "solid", "theme": "light" })).unwrap(),
            SettingsPatch {
                glass: Some(GlassMode::Solid),
                theme: Some(ThemeMode::Light)
            }
        );
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
        // Values of the other setting are not valid either.
        assert_eq!(rejected(json!({ "glass": "dark" })), INVALID_SETTINGS);
        assert_eq!(rejected(json!({ "theme": "solid" })), INVALID_SETTINGS);
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
            assert_eq!(rejected(json!({ "theme": bad })), INVALID_SETTINGS);
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
            json!(true),
        ] {
            assert_eq!(rejected(bad), INVALID_SETTINGS);
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
        };
        let only_theme = patch(json!({ "theme": "light" })).unwrap();
        assert_eq!(
            base.apply(only_theme),
            Settings {
                glass: GlassMode::Solid,
                theme: ThemeMode::Light
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
            r#"{"glass":"frosted","theme":"dark","future":{"x":1}}"#,
        )
        .unwrap();
        assert_eq!(
            store_in(&dir).get(),
            Settings {
                glass: GlassMode::Auto,
                theme: ThemeMode::Dark
            }
        );
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
            .update(patch(json!({ "glass": "solid", "theme": "dark" })).unwrap())
            .unwrap();
        assert_eq!(
            updated,
            Settings {
                glass: GlassMode::Solid,
                theme: ThemeMode::Dark
            }
        );
        assert_eq!(store.get(), updated);
        assert_eq!(store_in(&dir).get(), updated);

        let stored: Value =
            serde_json::from_slice(&fs::read(dir.path().join(FILE_NAME)).unwrap()).unwrap();
        assert_eq!(stored, json!({ "glass": "solid", "theme": "dark" }));
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
                theme: ThemeMode::Light
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
}
