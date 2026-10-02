//! Pins the security-relevant configuration (docs/SECURITY.md T1, T3, T4, T5, I2, P5; ADR-005).
//!
//! These tests read `tauri.conf.json`, `capabilities/*.json`, `Cargo.toml` and the command sources as plain files, so a
//! change that weakens the baseline fails here and has to be argued in an ADR and reviewed by the security-reviewer.

// Test code: panicking on a broken fixture is the point (clippy.toml only exempts `#[test]` functions, not helpers).
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::PathBuf;

use serde_json::Value;

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn read(relative: &str) -> String {
    let path = root().join(relative);
    fs::read_to_string(&path).unwrap_or_else(|error| panic!("{}: {error}", path.display()))
}

fn config() -> Value {
    serde_json::from_str(&read("tauri.conf.json")).unwrap()
}

/// Splits a CSP into directive name -> source tokens.
fn directives(csp: &str) -> BTreeMap<String, BTreeSet<String>> {
    csp.split(';')
        .map(str::trim)
        .filter(|directive| !directive.is_empty())
        .map(|directive| {
            let mut parts = directive.split_whitespace();
            let name = parts.next().unwrap_or_default().to_owned();
            (name, parts.map(str::to_owned).collect())
        })
        .collect()
}

fn set(tokens: &[&str]) -> BTreeSet<String> {
    tokens.iter().map(|token| (*token).to_owned()).collect()
}

fn csp(key: &str) -> BTreeMap<String, BTreeSet<String>> {
    let config = config();
    let csp = config["app"]["security"][key]
        .as_str()
        .unwrap_or_else(|| panic!("app.security.{key} is missing"));
    directives(csp)
}

// --- T1: CSP ---------------------------------------------------------------------------------------------------

#[test]
fn production_csp_is_strict() {
    let csp = csp("csp");
    assert_eq!(csp["default-src"], set(&["'self'"]));
    assert_eq!(csp["img-src"], set(&["'self'", "data:", "blob:"]));
    assert_eq!(csp["style-src"], set(&["'self'", "'unsafe-inline'"]));
    assert_eq!(csp["font-src"], set(&["'self'"]));
    // ADR-005: Tauri's IPC needs exactly these two sources, which are app-internal protocol handlers, not hosts.
    assert_eq!(csp["connect-src"], set(&["ipc:", "http://ipc.localhost"]));
    for closed in ["object-src", "base-uri", "frame-src", "form-action"] {
        assert_eq!(csp[closed], set(&["'none'"]), "{closed}");
    }
    // Scripts fall back to `default-src 'self'`: no inline, no eval, no remote.
    assert!(
        !csp.contains_key("script-src"),
        "scripts must use default-src"
    );
}

#[test]
fn csp_never_allows_remote_hosts_or_eval() {
    for key in ["csp", "devCsp"] {
        for (name, tokens) in csp(key) {
            for token in tokens {
                assert_ne!(token, "'unsafe-eval'", "{key} {name}");
                assert_ne!(token, "*", "{key} {name}");
                let remote = ["https:", "http:", "ws:", "wss:", "ftp:"]
                    .iter()
                    .any(|scheme| token.starts_with(scheme));
                let allowed_local = token == "http://ipc.localhost"
                    || (key == "devCsp"
                        && (token == "http://localhost:1420" || token == "ws://localhost:1420"));
                assert!(!remote || allowed_local, "{key} {name}: {token}");
            }
        }
    }
}

// --- T5: webview and config flags ------------------------------------------------------------------------------

/// Every object key in `value`, at any depth.
fn collect_keys(value: &Value, out: &mut Vec<String>) {
    match value {
        Value::Object(map) => {
            for (key, inner) in map {
                out.push(key.clone());
                collect_keys(inner, out);
            }
        }
        Value::Array(items) => items.iter().for_each(|item| collect_keys(item, out)),
        _ => {}
    }
}

#[test]
fn webview_flags_are_locked_down() {
    let config = config();
    assert_eq!(config["app"]["withGlobalTauri"], Value::Bool(false));
    // Every Tauri option that weakens the security model is spelled `dangerous...` (remote-domain IPC access, switching
    // off the CSP hashing, ...). None may appear anywhere in the config.
    let mut keys = Vec::new();
    collect_keys(&config, &mut keys);
    let dangerous: Vec<&String> = keys
        .iter()
        .filter(|key| key.starts_with("danger"))
        .collect();
    assert!(
        dangerous.is_empty(),
        "weakening options are set: {dangerous:?}"
    );
    // The asset protocol (file:// access from the webview) stays off; the page gets pixels as blob: URLs from IPC bytes.
    assert_eq!(
        config["app"]["security"]["assetProtocol"]["enable"],
        Value::Bool(false)
    );
    // Exactly one window, loaded from the bundled frontend (no `url` pointing anywhere else).
    let windows = config["app"]["windows"].as_array().unwrap();
    assert_eq!(windows.len(), 1);
    assert_eq!(windows[0]["label"], "main");
    assert!(windows[0].get("url").is_none());
    // No updater and no remote config in the baseline (T6 arrives in M7 with its own ADR).
    assert!(config
        .get("plugins")
        .is_none_or(|plugins| plugins.get("updater").is_none()));
}

#[test]
fn dev_url_is_only_a_dev_setting() {
    let config = config();
    let dev_url = config["build"]["devUrl"].as_str().unwrap();
    assert!(dev_url.starts_with("http://localhost:"), "{dev_url}");
    // `frontendDist` is what release builds load.
    assert_eq!(config["build"]["frontendDist"], "../dist");
}

// --- T3 / I2: capabilities -------------------------------------------------------------------------------------

#[test]
fn capabilities_grant_only_the_app_commands_to_the_main_window() {
    let mut files: Vec<PathBuf> = fs::read_dir(root().join("capabilities"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .collect();
    files.sort();
    assert!(!files.is_empty(), "no capability file found");

    let mut granted = BTreeSet::new();
    for file in &files {
        let capability: Value = serde_json::from_str(&fs::read_to_string(file).unwrap()).unwrap();
        assert_eq!(
            capability["windows"],
            serde_json::json!(["main"]),
            "{}",
            file.display()
        );
        assert!(
            capability.get("remote").is_none(),
            "no remote origin may reach IPC: {}",
            file.display()
        );
        for permission in capability["permissions"].as_array().unwrap() {
            let permission = permission
                .as_str()
                .expect("object permissions are not used");
            // App commands only: plugin permissions (`dialog:`, `fs:`, `shell:`, `core:` ...) always contain a colon.
            assert!(
                permission.starts_with("allow-") && !permission.contains(':'),
                "unexpected permission {permission} in {}",
                file.display()
            );
            granted.insert(permission.to_owned());
        }
    }
    assert_eq!(
        granted,
        set(&[
            "allow-open-document-dialog",
            "allow-render-page",
            "allow-close-document"
        ])
    );
}

#[test]
fn build_script_declares_exactly_the_granted_commands() {
    let build = read("build.rs");
    for command in ["open_document_dialog", "render_page", "close_document"] {
        assert!(build.contains(&format!("\"{command}\"")), "{command}");
        assert!(
            root()
                .join("permissions/autogenerated")
                .join(format!("{command}.toml"))
                .is_file(),
            "{command}"
        );
    }
    let declared = fs::read_dir(root().join("permissions/autogenerated"))
        .unwrap()
        .count();
    assert_eq!(
        declared, 3,
        "a new command needs a bounds test and a review"
    );
}

/// `(function name, signature text)` of every `#[tauri::command]` function in `src/commands`.
fn command_signatures() -> Vec<(String, String)> {
    let mut found = Vec::new();
    for entry in fs::read_dir(root().join("src/commands")).unwrap() {
        let source = fs::read_to_string(entry.unwrap().path()).unwrap();
        for chunk in source.split("#[tauri::command").skip(1) {
            let Some(start) = chunk.find("fn ") else {
                continue;
            };
            let signature = &chunk[start + 3..];
            let signature = &signature[..signature.find('{').unwrap_or(signature.len())];
            let name: String = signature
                .chars()
                .take_while(|c| c.is_alphanumeric() || *c == '_')
                .collect();
            found.push((name, signature.to_owned()));
        }
    }
    found
}

/// Parameter names of a signature: identifiers directly followed by a single colon (not `::`).
fn parameter_names(signature: &str) -> Vec<String> {
    let bytes = signature.as_bytes();
    let mut names = Vec::new();
    let mut word = String::new();
    for (at, &byte) in bytes.iter().enumerate() {
        if byte.is_ascii_alphanumeric() || byte == b'_' {
            word.push(char::from(byte));
            continue;
        }
        let single_colon =
            byte == b':' && bytes.get(at + 1) != Some(&b':') && (at == 0 || bytes[at - 1] != b':');
        if single_colon && !word.is_empty() {
            names.push(word.clone());
        }
        // Whitespace between the name and the colon keeps the word; anything else ends it.
        if !(byte == b' ' && !word.is_empty()) {
            word.clear();
        }
    }
    names
}

#[test]
fn no_command_takes_a_path_or_url() {
    let signatures = command_signatures();
    let names: Vec<&str> = signatures.iter().map(|(name, _)| name.as_str()).collect();
    assert!(
        names.contains(&"render_page"),
        "the scan found no commands: {names:?}"
    );
    for (function, signature) in &signatures {
        for name in parameter_names(signature) {
            let lower = name.to_lowercase();
            for forbidden in ["path", "file", "dir", "url", "uri"] {
                assert!(
                    !lower.contains(forbidden),
                    "{function}({name}): the frontend must not pass paths or URLs (SECURITY I2)"
                );
            }
        }
        for forbidden in ["Path", "PathBuf", "OsString"] {
            assert!(
                !signature.contains(forbidden),
                "{function} takes a {forbidden}: paths enter only from Rust-side dialogs (SECURITY I2)"
            );
        }
    }
}

#[test]
fn the_parameter_scan_finds_names_and_ignores_paths_in_types() {
    let names = parameter_names(
        "render_page(state: State<'_, AppState>, doc_id: DocumentId, scale : f32) -> Result<Response, UiError> ",
    );
    assert_eq!(names, ["state", "doc_id", "scale"]);
    assert!(parameter_names("open(path: PathBuf)").contains(&"path".to_owned()));
    assert!(parameter_names("f(x: std::path::PathBuf)").contains(&"x".to_owned()));
}

// --- T4 / T5 / P5: Cargo.toml ----------------------------------------------------------------------------------

/// Lines of one TOML section (`[name]`), without comments.
fn section(manifest: &str, name: &str) -> Vec<String> {
    let header = format!("[{name}]");
    manifest
        .lines()
        .skip_while(|line| line.trim() != header)
        .skip(1)
        .take_while(|line| !line.trim_start().starts_with('['))
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .map(str::to_owned)
        .collect()
}

#[test]
fn dangerous_plugins_and_tauri_features_stay_off() {
    let manifest = read("Cargo.toml");
    let dependencies = section(&manifest, "dependencies");
    let names: Vec<&str> = dependencies
        .iter()
        .filter_map(|line| line.split('=').next())
        .map(str::trim)
        .collect();
    for forbidden in [
        "tauri-plugin-shell",
        "tauri-plugin-http",
        "tauri-plugin-websocket",
        "tauri-plugin-process",
        "tauri-plugin-global-shortcut",
    ] {
        assert!(
            !names.contains(&forbidden),
            "{forbidden} is not allowed (SECURITY T4)"
        );
    }
    let tauri = dependencies
        .iter()
        .find(|line| line.starts_with("tauri ="))
        .expect("tauri dependency");
    for feature in ["devtools", "protocol-asset", "isolation-pattern-unsafe"] {
        assert!(
            !tauri.contains(feature),
            "tauri feature {feature} is not allowed (SECURITY T5)"
        );
    }
    assert!(
        section(&manifest, "features").is_empty(),
        "the app crate defines no cargo features that could switch DevTools on"
    );
}

#[test]
fn panics_unwind_so_the_engine_guard_works() {
    let manifest = read("Cargo.toml");
    let code: Vec<&str> = manifest
        .lines()
        .filter(|line| !line.trim_start().starts_with('#'))
        .collect();
    assert!(
        !code.iter().any(|line| line.contains("panic = \"abort\"")),
        "catch_unwind needs unwinding (P5)"
    );
    assert!(section(&manifest, "profile.release").contains(&"panic = \"unwind\"".to_owned()));
    assert!(
        !root().join(".cargo/config.toml").exists(),
        "check it for panic=abort"
    );
}

#[test]
fn lints_forbid_unsafe_and_unwrap_in_production_code() {
    let manifest = read("Cargo.toml");
    assert!(section(&manifest, "lints.rust").contains(&"unsafe_code = \"deny\"".to_owned()));
    let clippy = section(&manifest, "lints.clippy");
    assert!(clippy.contains(&"unwrap_used = \"deny\"".to_owned()));
    assert!(clippy.contains(&"expect_used = \"deny\"".to_owned()));
}
