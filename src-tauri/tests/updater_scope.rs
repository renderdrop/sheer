//! Pins where the updater may live (ADR-053 section 3, SECURITY T6): one HTTPS endpoint, no capability for the webview,
//! the plugin named only under `src/update/`, and `scripts/check.sh`'s guard doing what it says.

// Test code: panicking on a broken fixture is the point.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::Value;

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
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
fn the_endpoint_is_the_one_https_constant() {
    let endpoint = sheer_lib::update::ENDPOINT;
    assert_eq!(
        endpoint,
        "https://github.com/renderdrop/sheer/releases/latest/download/latest.json"
    );
    let plugin_config = sheer_lib::update::plugin_config("key");
    assert_eq!(plugin_config["endpoints"], serde_json::json!([endpoint]));
    // The insecure-transport switches of the plugin are never set anywhere.
    let mut files = Vec::new();
    rust_files(&root().join("src"), &mut files);
    for file in files {
        let text = fs::read_to_string(&file).unwrap();
        for forbidden in [
            "dangerous_insecure_transport_protocol",
            "dangerousInsecureTransportProtocol",
            "dangerous_accept_invalid_certs",
            "dangerous_accept_invalid_hostnames",
        ] {
            assert!(!text.contains(forbidden), "{}: {forbidden}", file.display());
        }
    }
}

#[test]
fn no_capability_and_no_config_hands_the_updater_to_the_webview() {
    for entry in fs::read_dir(root().join("capabilities")).unwrap() {
        let path = entry.unwrap().path();
        let text = fs::read_to_string(&path).unwrap();
        assert!(
            !text.contains("updater:"),
            "{} grants updater",
            path.display()
        );
    }
    // The plugin's configuration is added in code (`update::configure`), never in the config files, and the CSP stays closed.
    for name in [
        "tauri.conf.json",
        "tauri.windows.conf.json",
        "tauri.macos.conf.json",
    ] {
        let config: Value =
            serde_json::from_str(&fs::read_to_string(root().join(name)).unwrap()).unwrap();
        assert!(
            config
                .get("plugins")
                .is_none_or(|plugins| plugins.get("updater").is_none()),
            "{name}"
        );
        let text = config.to_string();
        assert!(
            !text.contains("github.com"),
            "{name} mentions the endpoint host"
        );
    }
    let csp = fs::read_to_string(root().join("tauri.conf.json")).unwrap();
    assert!(csp.contains("connect-src ipc: http://ipc.localhost;"));
}

#[test]
fn only_update_names_the_updater_and_http_crates() {
    let mut files = Vec::new();
    rust_files(&root().join("src"), &mut files);
    let pattern = [
        "tauri_plugin_updater",
        "reqwest",
        "hyper",
        "ureq",
        "tungstenite",
        "minisign_verify",
        "tauri_plugin_http",
        "tauri_plugin_websocket",
    ];
    let update_dir = root().join("src").join("update");
    for file in files {
        if file.starts_with(&update_dir) {
            continue;
        }
        let text = fs::read_to_string(&file).unwrap();
        for line in text.lines().filter(|l| !l.trim_start().starts_with("//")) {
            for name in pattern {
                assert!(!line.contains(name), "{}: {name}", file.display());
            }
        }
    }
}

/// Runs `guard_updater_scope <dir>` from `scripts/check.sh` in bash; `None` where there is no bash.
fn run_guard(dir: &Path) -> Option<(bool, String)> {
    let script = root().join("..").join("scripts").join("check.sh");
    let script = script.canonicalize().ok()?;
    let command = format!(
        "SHEER_CHECK_SOURCE_ONLY=1 source '{}' && guard_updater_scope '{}'",
        script
            .to_string_lossy()
            .replace(std::path::MAIN_SEPARATOR, "/")
            .trim_start_matches("//?/"),
        dir.to_string_lossy()
            .replace(std::path::MAIN_SEPARATOR, "/")
            .trim_start_matches("//?/")
    );
    let output = Command::new(bash()?).args(["-c", &command]).output().ok()?;
    Some((
        output.status.success(),
        String::from_utf8_lossy(&output.stdout).into_owned(),
    ))
}

#[test]
fn the_check_script_guard_allows_update_and_rejects_everything_else() {
    let dir = std::env::temp_dir().join(format!("sheer-scope-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(dir.join("update")).unwrap();
    fs::create_dir_all(dir.join("other")).unwrap();
    fs::write(
        dir.join("update").join("a.rs"),
        "use tauri_plugin_updater::Update;\nuse reqwest::Client;\n",
    )
    .unwrap();
    fs::write(
        dir.join("other").join("b.rs"),
        "// tauri_plugin_updater is only mentioned here\nfn f() {}\n",
    )
    .unwrap();
    let Some((clean, out)) = run_guard(&dir) else {
        let _ = fs::remove_dir_all(&dir);
        return; // no bash on this machine
    };
    assert!(clean, "update/ and comments must pass: {out}");
    for line in [
        "use tauri_plugin_updater::Builder;",
        "use reqwest::get;",
        "let _ = hyper::Client::new();",
    ] {
        fs::write(dir.join("other").join("c.rs"), format!("{line}\n")).unwrap();
        let (ok, out) = run_guard(&dir).unwrap();
        assert!(!ok, "{line} must fail");
        assert!(out.contains("outside update/"), "{out}");
    }
    let _ = fs::remove_dir_all(&dir);
    // The real tree passes.
    let (ok, out) = run_guard(&root().join("src")).unwrap();
    assert!(ok, "{out}");
}

/// Runs `guard_owner_corpus <corpus> <tree>` from `scripts/check.sh`; `None` where there is no bash.
fn run_owner_guard(corpus: &Path, tree: &Path) -> Option<(bool, String)> {
    let script = root().join("..").join("scripts").join("check.sh");
    let script = script.canonicalize().ok()?;
    let slash = |p: &Path| {
        p.to_string_lossy()
            .replace(std::path::MAIN_SEPARATOR, "/")
            .trim_start_matches("//?/")
            .to_owned()
    };
    let command = format!(
        "SHEER_CHECK_SOURCE_ONLY=1 source '{}' && guard_owner_corpus '{}' '{}'",
        slash(&script),
        slash(corpus),
        slash(tree)
    );
    let output = Command::new(bash()?).args(["-c", &command]).output().ok()?;
    Some((
        output.status.success(),
        String::from_utf8_lossy(&output.stdout).into_owned(),
    ))
}

#[test]
fn the_owner_corpus_guard_fails_on_a_file_name_and_skips_a_missing_folder() {
    let base = std::env::temp_dir().join(format!("sheer-owner-guard-{}", std::process::id()));
    let _ = fs::remove_dir_all(&base);
    let (corpus, tree) = (base.join("corpus"), base.join("tree"));
    fs::create_dir_all(&corpus).unwrap();
    fs::create_dir_all(&tree).unwrap();
    fs::write(corpus.join("Fictional Report 1999.pdf"), b"%PDF").unwrap();
    fs::write(
        tree.join("a.md"),
        "A line about owner-pdf-E4 only.
",
    )
    .unwrap();
    let Some((ok, out)) = run_owner_guard(&corpus, &tree) else {
        let _ = fs::remove_dir_all(&base);
        return; // no bash on this machine
    };
    assert!(ok, "IDs only must pass: {out}");
    for line in [
        "see Fictional Report 1999.pdf here",
        "the Fictional Report 1999 says",
    ] {
        fs::write(
            tree.join("b.md"),
            format!(
                "{line}
"
            ),
        )
        .unwrap();
        let (ok, out) = run_owner_guard(&corpus, &tree).unwrap();
        assert!(!ok, "{line} must fail");
        assert!(out.contains("b.md:1"), "{out}");
        assert!(
            !out.contains("Fictional"),
            "the name is never printed: {out}"
        );
    }
    let (ok, _) = run_owner_guard(&base.join("absent"), &tree).unwrap();
    assert!(ok, "a missing corpus folder is a silent pass");
    let _ = fs::remove_dir_all(&base);
}

/// Git Bash on Windows (the `bash` on PATH there can be the WSL launcher, which does not take `C:/` paths); `bash` elsewhere.
/// `None` when there is none.
fn bash() -> Option<PathBuf> {
    if cfg!(windows) {
        ["ProgramFiles", "ProgramFiles(x86)"]
            .iter()
            .filter_map(std::env::var_os)
            .map(|base| PathBuf::from(base).join("Git").join("bin").join("bash.exe"))
            .find(|path| path.exists())
    } else {
        Some(PathBuf::from("bash"))
    }
}
