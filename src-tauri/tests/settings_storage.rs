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
    GlassMode, Language, Settings, SettingsPatch, SettingsStore, ThemeMode, FILE_NAME,
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

#[test]
fn an_unknown_language_is_rejected_whole_and_the_saved_language_stays() {
    let dir = TempDir::new();
    let store = SettingsStore::load(dir.settings_file());
    store.update(patch(json!({ "language": "de" }))).unwrap();
    let before = fs::read(dir.settings_file()).unwrap();

    for bad in [
        json!({ "language": "fr" }),
        json!({ "theme": "dark", "language": "de-DE" }),
        json!({ "glass": "solid", "language": "DE" }),
        json!({ "language": null }),
        json!({ "language": ["de"] }),
        json!({ "language": "" }),
    ] {
        let error = SettingsPatch::from_value(&bad).unwrap_err();
        assert_eq!(error.code(), ErrorCode::InvalidArgument, "{bad}");
    }

    // A rejected patch changed neither the memory nor the file.
    assert_eq!(store.get().language, Language::De);
    assert_eq!(store.get().theme, ThemeMode::System);
    assert_eq!(fs::read(dir.settings_file()).unwrap(), before);
    assert_eq!(
        SettingsStore::load(dir.settings_file()).get().language,
        Language::De
    );
}

// --- criterion 2: atomic write, damaged or missing file ----------------------------------------------------------

#[test]
fn a_leftover_temp_file_from_a_crash_is_never_written_through_or_reused() {
    let dir = TempDir::new();
    // Leftovers under the old fixed name and under the pid-and-counter names a crashed run may have left. A write picks
    // a temp name of its own and never touches them, whichever of those names it meets.
    let pid = std::process::id();
    let leftovers = [
        format!(".{FILE_NAME}.tmp"),
        format!(".{FILE_NAME}.{pid}.0.tmp"),
        format!(".{FILE_NAME}.{pid}.1.tmp"),
    ];
    for name in &leftovers {
        fs::write(dir.path().join(name), b"half a wri").unwrap();
    }

    write_atomic(&dir.settings_file(), b"{\"theme\":\"dark\"}\n").unwrap();

    assert_eq!(
        fs::read(dir.settings_file()).unwrap(),
        b"{\"theme\":\"dark\"}\n"
    );
    for name in &leftovers {
        assert_eq!(fs::read(dir.path().join(name)).unwrap(), b"half a wri");
    }
    let mut expected: Vec<String> = leftovers.to_vec();
    expected.push(FILE_NAME.to_owned());
    expected.sort();
    assert_eq!(names(dir.path()), expected);
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
            theme: ThemeMode::Light,
            ..Settings::default()
        }
    );
}

#[test]
fn a_write_that_fails_leaves_memory_untouched_and_no_temp_file_behind() {
    let dir = TempDir::new();
    fs::write(dir.settings_file(), br#"{"glass":"auto","theme":"dark"}"#).unwrap();
    let store = SettingsStore::load(dir.settings_file());
    assert_eq!(store.get().theme, ThemeMode::Dark);

    // A non-empty directory has taken the place of the file: the temp file is written, then the rename fails.
    fs::remove_file(dir.settings_file()).unwrap();
    fs::create_dir(dir.settings_file()).unwrap();
    fs::write(dir.settings_file().join("child"), b"x").unwrap();
    let error = store
        .update(patch(json!({ "theme": "light" })))
        .unwrap_err();

    assert_ne!(error.code(), ErrorCode::InvalidArgument);
    assert_eq!(store.get().theme, ThemeMode::Dark);
    assert_eq!(names(dir.path()), [FILE_NAME]);
    assert_eq!(fs::read(dir.settings_file().join("child")).unwrap(), b"x");
}

#[test]
fn stored_values_of_the_wrong_type_fall_back_field_by_field() {
    let cases: [(&str, Settings); 5] = [
        (
            r#"{"glass":5,"theme":"light"}"#,
            Settings {
                glass: GlassMode::Auto,
                theme: ThemeMode::Light,
                ..Settings::default()
            },
        ),
        (
            r#"{"glass":"solid","theme":null}"#,
            Settings {
                glass: GlassMode::Solid,
                theme: ThemeMode::System,
                ..Settings::default()
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
                ..Settings::default()
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

    let mut stored: Value =
        serde_json::from_slice(&fs::read(dir.settings_file()).unwrap()).unwrap();
    // The default author name comes from the environment (ADR-029); it only has to be a non-empty string.
    let author = stored
        .as_object_mut()
        .unwrap()
        .remove("authorName")
        .unwrap();
    assert!(author.as_str().is_some_and(|name| !name.is_empty()));
    assert_eq!(
        stored,
        json!({ "glass": "auto", "theme": "dark", "language": "system", "leftPanelWidth": 248, "welcomeTour": "pending" })
    );
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

// --- hardening: what the file system can hand us --------------------------------------------------------------

#[test]
fn a_directory_at_the_settings_path_is_damaged_data_not_a_crash() {
    let dir = TempDir::new();
    fs::create_dir(dir.settings_file()).unwrap();
    let store = SettingsStore::load(dir.settings_file());
    assert_eq!(store.get(), Settings::default());
    // Writing cannot succeed either (the directory is in the way), and says so instead of changing memory.
    assert!(store.update(patch(json!({ "theme": "dark" }))).is_err());
    assert_eq!(store.get(), Settings::default());
}

#[test]
fn a_null_value_is_not_the_same_as_leaving_a_key_out() {
    // `{"theme": null}` must not pass as "no change": a present key holds a valid value or the patch is refused.
    for bad in [
        json!({ "theme": null }),
        json!({ "glass": null, "theme": "dark" }),
    ] {
        let error = SettingsPatch::from_value(&bad).unwrap_err();
        assert_eq!(error.code(), ErrorCode::InvalidArgument, "{bad}");
    }
}

#[cfg(unix)]
#[test]
fn the_settings_file_and_a_new_data_directory_are_private_to_the_user() {
    use std::os::unix::fs::PermissionsExt;

    let dir = TempDir::new();
    let data_dir = dir.path().join("app-data");
    let path = data_dir.join(FILE_NAME);
    let store = SettingsStore::load(path.clone());
    store.update(patch(json!({ "glass": "solid" }))).unwrap();

    let mode = |path: &Path| fs::metadata(path).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode(&data_dir), 0o700);
    assert_eq!(mode(&path), 0o600);
}

// --- the left panel width (DESIGN 2, 3.8) ----------------------------------------------------------------------

#[test]
fn the_panel_width_survives_a_restart_and_a_bad_width_changes_nothing() {
    let dir = TempDir::new();
    let store = SettingsStore::load(dir.settings_file());
    assert_eq!(store.get().left_panel_width.get(), 248);

    store
        .update(patch(json!({ "leftPanelWidth": 320 })))
        .unwrap();
    assert_eq!(
        SettingsStore::load(dir.settings_file())
            .get()
            .left_panel_width
            .get(),
        320
    );

    // Out of range, wrongly typed or in company of an invalid field: the patch is refused whole, so neither the file nor
    // memory moves.
    let before = fs::read(dir.settings_file()).unwrap();
    for bad in [
        json!({ "leftPanelWidth": 100 }),
        json!({ "leftPanelWidth": 4000 }),
        json!({ "leftPanelWidth": "wide" }),
        json!({ "leftPanelWidth": 300.5 }),
        json!({ "leftPanelWidth": 300, "theme": "neon" }),
    ] {
        let error = SettingsPatch::from_value(&bad).unwrap_err();
        assert_eq!(error.code(), ErrorCode::InvalidArgument, "{bad}");
    }
    assert_eq!(fs::read(dir.settings_file()).unwrap(), before);
    assert_eq!(store.get().left_panel_width.get(), 320);
}
