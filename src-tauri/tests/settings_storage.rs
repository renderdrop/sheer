//! Settings persistence through the public API: acceptance criteria for `get_settings` / `update_settings`.
//!
//! The unit tests in `storage::settings` and `storage::atomic` cover the happy paths and the enum validation. These
//! tests add what happens around the file: a crash leftover, a blocked write, wrong value types, a missing data
//! directory and concurrent updates.

// Test code: panicking on a broken fixture is the point (clippy.toml only exempts `#[test]` functions, not helpers).
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::thread;

use serde_json::{json, Value};
use sheer_lib::error::ErrorCode;
use sheer_lib::storage::atomic::write_atomic;
use sheer_lib::storage::settings::{
    GlassMode, Settings, SettingsPatch, SettingsStore, ThemeMode, FILE_NAME,
};

/// A scratch directory under the system temp dir, removed on drop.
struct TempDir(PathBuf);

impl TempDir {
    fn new() -> Self {
        static NEXT: AtomicU32 = AtomicU32::new(0);
        let path = std::env::temp_dir().join(format!(
            "sheer-settings-it-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }

    fn settings_file(&self) -> PathBuf {
        self.0.join(FILE_NAME)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn patch(value: Value) -> SettingsPatch {
    SettingsPatch::from_value(&value).unwrap()
}

fn names(directory: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(directory)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

// --- criterion 1: invalid patches are rejected, as a whole -------------------------------------------------------

#[test]
fn a_patch_with_one_valid_and_one_invalid_field_is_rejected_whole() {
    for bad in [
        json!({ "glass": "solid", "theme": "neon" }),
        json!({ "theme": "dark", "glass": "frosted" }),
        json!({ "glass": "solid", "theme": "dark", "extra": true }),
    ] {
        let error = SettingsPatch::from_value(&bad).unwrap_err();
        assert_eq!(error.code(), ErrorCode::InvalidArgument, "{bad}");
    }
}

#[test]
fn a_rejected_patch_never_reaches_the_file() {
    let dir = TempDir::new();
    let store = SettingsStore::load(dir.settings_file());
    // The command validates first (`SettingsPatch::from_value(..)?`), so `update` is never called with a bad patch.
    assert!(SettingsPatch::from_value(&json!({ "glass": "solid", "theme": "neon" })).is_err());
    assert_eq!(store.get(), Settings::default());
    assert!(!dir.settings_file().exists());
}

// --- criterion 2: atomic write, damaged or missing file ----------------------------------------------------------

#[test]
fn a_leftover_temp_file_from_a_crash_is_replaced_and_removed() {
    let dir = TempDir::new();
    let leftover = dir.path().join(format!(".{FILE_NAME}.tmp"));
    fs::write(&leftover, b"half a wri").unwrap();

    write_atomic(&dir.settings_file(), b"{\"theme\":\"dark\"}\n").unwrap();

    assert_eq!(
        fs::read(dir.settings_file()).unwrap(),
        b"{\"theme\":\"dark\"}\n"
    );
    assert_eq!(names(dir.path()), [FILE_NAME]);
}

#[test]
fn a_leftover_temp_file_does_not_stop_the_app_from_starting() {
    let dir = TempDir::new();
    fs::write(dir.settings_file(), br#"{"glass":"solid","theme":"light"}"#).unwrap();
    fs::write(
        dir.path().join(format!(".{FILE_NAME}.tmp")),
        b"{\"theme\":\"da",
    )
    .unwrap();
    // Only the real file is read, never the temp file.
    assert_eq!(
        SettingsStore::load(dir.settings_file()).get(),
        Settings {
            glass: GlassMode::Solid,
            theme: ThemeMode::Light
        }
    );
}

#[test]
fn a_write_that_cannot_start_leaves_the_stored_file_and_memory_untouched() {
    let dir = TempDir::new();
    let original = br#"{"glass":"auto","theme":"dark"}"#;
    fs::write(dir.settings_file(), original).unwrap();
    let store = SettingsStore::load(dir.settings_file());
    assert_eq!(store.get().theme, ThemeMode::Dark);

    // A directory where the temp file belongs: creating the temp file fails before the settings file is touched.
    fs::create_dir(dir.path().join(format!(".{FILE_NAME}.tmp"))).unwrap();
    let error = store
        .update(patch(json!({ "theme": "light" })))
        .unwrap_err();

    assert_ne!(error.code(), ErrorCode::InvalidArgument);
    assert_eq!(fs::read(dir.settings_file()).unwrap(), original);
    assert_eq!(store.get().theme, ThemeMode::Dark);
}

#[test]
fn stored_values_of_the_wrong_type_fall_back_field_by_field() {
    let cases: [(&str, Settings); 5] = [
        (
            r#"{"glass":5,"theme":"light"}"#,
            Settings {
                glass: GlassMode::Auto,
                theme: ThemeMode::Light,
            },
        ),
        (
            r#"{"glass":"solid","theme":null}"#,
            Settings {
                glass: GlassMode::Solid,
                theme: ThemeMode::System,
            },
        ),
        (
            r#"{"glass":["solid"],"theme":{"dark":true}}"#,
            Settings::default(),
        ),
        (r#"{"glass":"Solid","theme":"DARK"}"#, Settings::default()),
        (
            r#"{"theme":"dark"}"#,
            Settings {
                glass: GlassMode::Auto,
                theme: ThemeMode::Dark,
            },
        ),
    ];
    for (contents, expected) in cases {
        let dir = TempDir::new();
        fs::write(dir.settings_file(), contents).unwrap();
        assert_eq!(
            SettingsStore::load(dir.settings_file()).get(),
            expected,
            "{contents}"
        );
    }
}

#[test]
fn a_missing_data_directory_is_created_on_the_first_update() {
    let dir = TempDir::new();
    let path = dir.path().join("not").join("yet").join(FILE_NAME);
    let store = SettingsStore::load(path.clone());
    assert_eq!(store.get(), Settings::default());

    store.update(patch(json!({ "glass": "solid" }))).unwrap();

    assert!(path.is_file());
    assert_eq!(SettingsStore::load(path).get().glass, GlassMode::Solid);
}

#[test]
fn the_next_update_repairs_a_damaged_file() {
    let dir = TempDir::new();
    fs::write(dir.settings_file(), b"{ this is not json").unwrap();
    let store = SettingsStore::load(dir.settings_file());
    assert_eq!(store.get(), Settings::default());

    store.update(patch(json!({ "theme": "dark" }))).unwrap();

    let stored: Value = serde_json::from_slice(&fs::read(dir.settings_file()).unwrap()).unwrap();
    assert_eq!(stored, json!({ "glass": "auto", "theme": "dark" }));
    assert_eq!(names(dir.path()), [FILE_NAME]);
}

#[test]
fn concurrent_updates_always_leave_a_complete_file_that_matches_memory() {
    let dir = TempDir::new();
    let store = Arc::new(SettingsStore::load(dir.settings_file()));

    let workers: Vec<_> = (0..8)
        .map(|worker| {
            let store = Arc::clone(&store);
            thread::spawn(move || {
                for round in 0..10 {
                    let theme = ["system", "light", "dark"][(worker + round) % 3];
                    let glass = ["auto", "solid"][(worker + round) % 2];
                    store
                        .update(patch(json!({ "theme": theme, "glass": glass })))
                        .unwrap();
                }
            })
        })
        .collect();
    for worker in workers {
        worker.join().unwrap();
    }

    // The file parses, holds exactly the in-memory settings, and no temp file is left behind.
    let stored: Value = serde_json::from_slice(&fs::read(dir.settings_file()).unwrap()).unwrap();
    assert_eq!(stored, serde_json::to_value(store.get()).unwrap());
    assert_eq!(SettingsStore::load(dir.settings_file()).get(), store.get());
    assert_eq!(names(dir.path()), [FILE_NAME]);
}
