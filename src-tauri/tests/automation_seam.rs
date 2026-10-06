//! ADR-131 guards: the acceptance build's feature and files stay out of every release path, and every native dialog goes through the
//! seam. These read files only; the queue itself is unit-tested in `src/automation/queue.rs` (run with `--features automation`).

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn read(relative: &str) -> String {
    fs::read_to_string(root().join(relative)).unwrap_or_else(|error| panic!("{relative}: {error}"))
}

fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            rust_files(&path, out);
        } else if path.extension().is_some_and(|ext| ext == "rs") {
            out.push(path);
        }
    }
}

#[test]
fn the_feature_exists_and_is_not_a_default() {
    let manifest = read("Cargo.toml");
    let features: Vec<&str> = manifest
        .lines()
        .skip_while(|line| line.trim() != "[features]")
        .skip(1)
        .take_while(|line| !line.trim_start().starts_with('['))
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .collect();
    assert_eq!(features, ["automation = []"]);
    assert!(!manifest.contains("default ="), "no default feature set");
}

#[test]
fn no_release_config_capability_or_workflow_names_automation() {
    let mut files = vec!["tauri.conf.json".to_owned()];
    for entry in fs::read_dir(root()).unwrap() {
        let name = entry.unwrap().file_name().into_string().unwrap();
        if name.starts_with("tauri.")
            && name.ends_with(".conf.json")
            && name != "tauri.acceptance.conf.json"
        {
            files.push(name);
        }
    }
    for entry in fs::read_dir(root().join("capabilities")).unwrap() {
        files.push(format!(
            "capabilities/{}",
            entry.unwrap().file_name().to_string_lossy()
        ));
    }
    files.extend([
        "../.github/workflows/release.yml".to_owned(),
        "../.github/workflows/ci.yml".to_owned(),
    ]);
    for file in files {
        assert!(
            !read(&file).to_lowercase().contains("automation"),
            "{file} names the automation feature"
        );
    }
}

#[test]
fn the_acceptance_config_has_its_own_identity_and_is_not_bundled_or_updated() {
    let base: Value = serde_json::from_str(&read("tauri.conf.json")).unwrap();
    let acceptance: Value = serde_json::from_str(&read("tauri.acceptance.conf.json")).unwrap();
    assert_eq!(acceptance["identifier"], "app.sheer.acceptance");
    assert_ne!(acceptance["identifier"], base["identifier"]);
    assert_eq!(acceptance["productName"], "Sheer Acceptance");
    assert_eq!(acceptance["mainBinaryName"], "sheer-acceptance");
    assert_eq!(acceptance["bundle"]["active"], false);
    assert_eq!(acceptance["bundle"]["createUpdaterArtifacts"], false);
    assert!(
        acceptance.get("plugins").is_none(),
        "no updater plugin section"
    );
    // The capability list: the default capability and one inline capability with exactly the two automation permissions.
    let capabilities = acceptance["app"]["security"]["capabilities"]
        .as_array()
        .unwrap();
    assert_eq!(capabilities[0], "default");
    assert_eq!(capabilities.len(), 2);
    assert_eq!(capabilities[1]["windows"], serde_json::json!(["main"]));
    assert_eq!(
        capabilities[1]["permissions"],
        serde_json::json!(["allow-automation-queue-dialog", "allow-automation-state"])
    );
    assert!(capabilities[1].get("remote").is_none());
}

#[test]
fn the_acceptance_build_does_not_share_the_keychain_item_of_the_app() {
    let keychain = read("src/storage/keychain.rs");
    assert!(keychain.contains("cfg!(feature = \"automation\")"));
    assert!(keychain.contains("\"app.sheer.acceptance\""));
}

#[test]
fn every_native_dialog_goes_through_the_seam() {
    let mut files = Vec::new();
    rust_files(&root().join("src"), &mut files);
    let seam = root().join("src").join("automation");
    for file in files.into_iter().filter(|file| !file.starts_with(&seam)) {
        let text = fs::read_to_string(&file).unwrap();
        for (number, line) in text.lines().enumerate() {
            let code = line.trim_start();
            if code.starts_with("//") {
                continue;
            }
            // Any `blocking_pick_*`, `blocking_save_file`, `blocking_show` (with or without a leading dot, also at the start of a
            // continuation line of a multi-line chain) and any `.print()` / `window.print()`.
            for forbidden in [
                "blocking_pick_",
                "blocking_save_",
                "blocking_show",
                "window.print()",
                ".print()",
            ] {
                assert!(
                    !line.contains(forbidden),
                    "{}:{}: `{forbidden}` outside src/automation (use automation::dialogs)",
                    file.display(),
                    number + 1
                );
            }
        }
    }
}

#[test]
fn a_build_without_the_feature_deletes_stale_automation_permissions() {
    let build = read("build.rs");
    assert!(build.contains("remove_stale_automation_permissions"));
    assert!(build.contains("starts_with(\"automation_\")"));
    // The cleanup runs in the branch of the feature being off.
    assert!(build.contains("} else {\n        remove_stale_automation_permissions();"));
}
