//! Pins the security-relevant configuration (docs/SECURITY.md T1, T3, T4, T5, I2, P5; ADR-005).
//!
//! These tests read `tauri.conf.json`, every `tauri.<platform>.conf.json`, `capabilities/*.json`, `Cargo.toml` and the
//! command sources as plain files, so a change that weakens the baseline fails here and has to be argued in an ADR and
//! reviewed by the security-reviewer.

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

/// RFC 7396 JSON Merge Patch, the way Tauri merges `tauri.<platform>.conf.json` into `tauri.conf.json`: objects merge
/// key by key, a `null` removes a key, anything else (an array too) replaces the value.
fn merge_patch(target: &mut Value, patch: &Value) {
    let Value::Object(patch) = patch else {
        *target = patch.clone();
        return;
    };
    if !target.is_object() {
        *target = Value::Object(serde_json::Map::new());
    }
    let Value::Object(target) = target else {
        return;
    };
    for (key, value) in patch {
        if value.is_null() {
            target.remove(key);
        } else {
            merge_patch(target.entry(key.clone()).or_insert(Value::Null), value);
        }
    }
}

/// The platform names of every `tauri.<platform>.conf.json` next to `tauri.conf.json`, sorted. Found by glob, not listed by
/// hand: a platform file that someone adds later (`tauri.linux.conf.json`) is merged over the base by Tauri on that
/// platform, so every test that walks the platform configs has to see it without being edited.
fn platform_names() -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(root())
        .unwrap()
        .filter_map(|entry| {
            let file = entry.unwrap().file_name().into_string().ok()?;
            let platform = file.strip_prefix("tauri.")?.strip_suffix(".conf.json")?;
            // `tauri.conf.json` itself leaves nothing between the two affixes.
            (!platform.is_empty() && !platform.contains('.')).then(|| platform.to_owned())
        })
        .collect();
    names.sort();
    names
}

/// The patch file of `platform`, as it is on disk.
fn platform_patch(platform: &str) -> Value {
    serde_json::from_str(&read(&format!("tauri.{platform}.conf.json"))).unwrap()
}

/// The configuration a build for `platform` sees: the base file with its platform file merged over it.
fn platform_config(platform: &str) -> Value {
    let mut merged = config();
    merge_patch(&mut merged, &platform_patch(platform));
    merged
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

/// The glob finds the platform files that exist today, and only those: `tauri.conf.json` is the base, not a platform.
#[test]
fn platform_config_discovery_finds_the_platform_files() {
    let names = platform_names();
    for expected in ["macos", "windows"] {
        assert!(
            names.iter().any(|name| name == expected),
            "tauri.{expected}.conf.json is not found: {names:?}"
        );
    }
    assert!(!names.iter().any(|name| name.is_empty() || name == "conf"));
}

/// The CSP and the asset protocol come from the base file alone (`csp()` reads only that one, and the tests above pin it).
/// A platform file merges over the base on its platform, so if it had an `app.security` of its own, that platform would
/// ship a policy the CSP tests never looked at. `null` counts too: it deletes the key from the merged result.
#[test]
fn platform_patches_never_touch_app_security() {
    for platform in platform_names() {
        let patch = platform_patch(&platform);
        assert!(
            patch["app"].get("security").is_none(),
            "tauri.{platform}.conf.json sets app.security: the CSP is defined in tauri.conf.json only"
        );
        // The merged result carries the base policy unchanged, key for key.
        assert_eq!(
            platform_config(&platform)["app"]["security"],
            config()["app"]["security"],
            "{platform}"
        );
    }
}

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
    // The base file and each platform's merged result: the window of every build is checked, not just the base one.
    let mut configs = vec![("base".to_owned(), config())];
    configs.extend(
        platform_names()
            .into_iter()
            .map(|platform| (platform.clone(), platform_config(&platform))),
    );
    for (name, config) in &configs {
        assert_eq!(
            config["app"]["withGlobalTauri"],
            Value::Bool(false),
            "{name}"
        );
        // Every Tauri option that weakens the security model is spelled `dangerous...` (remote-domain IPC access, switching
        // off the CSP hashing, ...). None may appear anywhere in the config.
        let mut keys = Vec::new();
        collect_keys(config, &mut keys);
        let dangerous: Vec<&String> = keys
            .iter()
            .filter(|key| key.starts_with("danger"))
            .collect();
        assert!(
            dangerous.is_empty(),
            "{name}: weakening options are set: {dangerous:?}"
        );
        // The asset protocol (file:// access from the webview) stays off; the page gets pixels as blob: URLs from IPC bytes.
        assert_eq!(
            config["app"]["security"]["assetProtocol"]["enable"],
            Value::Bool(false),
            "{name}"
        );
        // Exactly one window, loaded from the bundled frontend (no `url` pointing anywhere else).
        let windows = config["app"]["windows"].as_array().unwrap();
        assert_eq!(windows.len(), 1, "{name}");
        assert_eq!(windows[0]["label"], "main", "{name}");
        assert!(windows[0].get("url").is_none(), "{name}");
        // Drag and drop is set on purpose, not left to the default (SECURITY T5, ARCHITECTURE §4). `true`: Tauri takes the OS
        // drop itself, so a dropped file cannot navigate the webview to file://, and the dropped paths reach only Rust's
        // `WindowEvent::DragDrop` handler. The webview cannot hear the `tauri://drag-drop` event that carries them, because
        // it has no event permission (`the_webview_has_no_event_permissions`).
        assert_eq!(windows[0]["dragDropEnabled"], Value::Bool(true), "{name}");
        // No updater and no remote config in the baseline (T6 arrives in M7 with its own ADR).
        assert!(
            config
                .get("plugins")
                .is_none_or(|plugins| plugins.get("updater").is_none()),
            "{name}"
        );
    }
}

/// DESIGN 2: the window never gets smaller than 960 x 640, and 2.2: the chrome differs per platform. macOS keeps the
/// native traffic lights over an overlay title bar; Windows draws its own caption buttons, so it has no native decorations.
#[test]
fn window_chrome_follows_the_design_per_platform() {
    for (name, config) in [
        ("base", config()),
        ("windows", platform_config("windows")),
        ("macos", platform_config("macos")),
    ] {
        let window = &config["app"]["windows"][0];
        assert_eq!(window["minWidth"], 960, "{name}");
        assert_eq!(window["minHeight"], 640, "{name}");
    }

    let windows = platform_config("windows");
    assert_eq!(windows["app"]["windows"][0]["decorations"], false);
    assert!(windows["app"]["windows"][0].get("titleBarStyle").is_none());

    let macos = platform_config("macos");
    let window = &macos["app"]["windows"][0];
    assert_eq!(window["titleBarStyle"], "Overlay");
    assert_eq!(window["hiddenTitle"], true);
    assert_eq!(
        window["trafficLightPosition"],
        serde_json::json!({ "x": 16, "y": 22 })
    );
    // Not decorations: false (that would remove the traffic lights).
    assert!(window.get("decorations").is_none());

    // The base file is what Linux builds use: native decorations, nothing platform-specific.
    let base = &config()["app"]["windows"][0];
    assert!(base.get("decorations").is_none());
    assert!(base.get("titleBarStyle").is_none());
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

/// The window-chrome permissions of the custom title bar (DESIGN 2.2, SECURITY T3, ADR-014): the only `core:` permissions the
/// webview gets. Minimize, maximize and close are the caption buttons; `internal-toggle-maximize` and `start-dragging` are
/// what Tauri's `data-tauri-drag-region` script calls (double click, drag); `is-maximized` and `is-fullscreen` are read-only
/// state for the maximize/restore icon and the macOS traffic-light inset.
const WINDOW_PERMISSIONS: [&str; 7] = [
    "core:window:allow-minimize",
    "core:window:allow-toggle-maximize",
    "core:window:allow-close",
    "core:window:allow-is-maximized",
    "core:window:allow-is-fullscreen",
    "core:window:allow-start-dragging",
    "core:window:allow-internal-toggle-maximize",
];

#[test]
fn capabilities_grant_only_the_app_commands_and_the_window_chrome_to_the_main_window() {
    let mut files: Vec<PathBuf> = fs::read_dir(root().join("capabilities"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .collect();
    files.sort();
    assert!(!files.is_empty(), "no capability file found");

    let mut granted = BTreeSet::new();
    for file in &files {
        // A permission is listed once: a second entry is noise that hides what the file grants (and a copy that was meant to be
        // another permission).
        let listed: Vec<String> = serde_json::from_str::<Value>(&fs::read_to_string(file).unwrap())
            .unwrap()["permissions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|permission| permission.as_str().unwrap().to_owned())
            .collect();
        let unique: BTreeSet<&String> = listed.iter().collect();
        assert_eq!(
            unique.len(),
            listed.len(),
            "a permission is listed twice in {}: {listed:?}",
            file.display()
        );
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
            // App commands (`allow-...`, no colon) or exactly one of the listed window-chrome permissions. Every other
            // plugin or core permission (`dialog:`, `fs:`, `shell:`, `core:default`, `core:event:`, ...) is refused, and so
            // is any other `core:window:` one.
            assert!(
                (permission.starts_with("allow-") && !permission.contains(':'))
                    || WINDOW_PERMISSIONS.contains(&permission),
                "unexpected permission {permission} in {}",
                file.display()
            );
            granted.insert(permission.to_owned());
        }
    }
    let mut expected = set(&[
        "allow-open-document-dialog",
        "allow-render-page",
        "allow-set-viewport",
        "allow-get-page-sizes",
        "allow-close-document",
        "allow-app-ready",
        "allow-get-settings",
        "allow-update-settings",
        "allow-watch-transparency",
        "allow-subscribe-menu",
        "allow-subscribe-app",
    ]);
    expected.extend(
        WINDOW_PERMISSIONS
            .iter()
            .map(|permission| (*permission).to_owned()),
    );
    assert_eq!(granted, expected);
}

/// The webview can neither listen to events nor emit them. `listen` would let it hear `tauri://drag-drop`, whose payload
/// is the dropped file paths (SECURITY I2), and `emit` would let it speak as the backend. Backend-to-UI pushes use a
/// `Channel` argument of a command instead (`watch_transparency`, `subscribe_menu`), which needs no permission.
#[test]
fn the_webview_has_no_event_permissions() {
    let default = read("capabilities/default.json");
    for forbidden in [
        "core:event",
        "allow-listen",
        "allow-unlisten",
        "allow-emit",
        "core:default",
    ] {
        assert!(
            !default.contains(forbidden),
            "{forbidden} must not be granted to the webview (SECURITY T3)"
        );
    }
}

/// A click in the native menu reaches the webview only as a message on the channel of `subscribe_menu`, and only with an id of
/// the allowlist (`menu::spec::ACTION_IDS`, ADR-016). The menu module therefore never emits an event: that would need the webview
/// to `listen`, which it cannot (ADR-013), and would bypass the allowlist.
#[test]
fn menu_commands_reach_the_webview_only_through_the_channel() {
    // Every file of the menu module, found by glob: a file someone adds to `src/menu` later (a submodule for the menu bar of
    // another platform) is scanned without this test being edited. `src/commands/app.rs` is where the channel is taken.
    let mut files: Vec<String> = fs::read_dir(root().join("src/menu"))
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .filter(|name| name.ends_with(".rs"))
        .map(|name| format!("src/menu/{name}"))
        .collect();
    files.sort();
    assert!(
        ["src/menu/mod.rs", "src/menu/spec.rs"]
            .iter()
            .all(|expected| files.iter().any(|file| file == expected)),
        "the glob finds the menu module's files: {files:?}"
    );
    files.push("src/commands/app.rs".to_owned());
    let mut sources = String::new();
    for file in &files {
        // The tests of a file name the forbidden calls; production code is what comes before them.
        let source = read(file);
        sources.push_str(source.split("#[cfg(test)]").next().unwrap());
    }
    for forbidden in [
        ".emit(",
        ".emit_to(",
        ".emit_filter(",
        "Emitter",
        "Listener",
        "evaluate_script",
        ".eval(",
    ] {
        assert!(
            !sources.contains(forbidden),
            "{forbidden} in the menu or the app commands: menu commands go through the Channel only (ADR-013, ADR-016)"
        );
    }
    let app = read("src/commands/app.rs");
    assert!(
        app.contains("on_action: Channel<String>"),
        "subscribe_menu takes the channel the commands are sent on"
    );
    let menu = read("src/menu/mod.rs");
    assert!(
        menu.contains("spec::is_action_id(id)"),
        "MenuBridge::forward must check the allowlist before it sends"
    );
}

/// What the backend pushes to the UI (a drag over the window, a file the OS asked the app to open) reaches the webview only as
/// a message on the channel of `subscribe_app`, and carries no path (SECURITY T3, T9, I2, I3). The modules that make and send
/// the pushes therefore never emit an event or run a script: that would need the webview to `listen` (it cannot, ADR-013).
#[test]
fn app_pushes_reach_the_webview_only_through_the_channel() {
    let mut sources = String::new();
    for file in ["src/events.rs", "src/sources.rs", "src/commands/app.rs"] {
        // The tests of a file name the forbidden calls; production code is what comes before them.
        sources.push_str(read(file).split("#[cfg(test)]").next().unwrap());
    }
    for forbidden in [
        ".emit(",
        ".emit_to(",
        ".emit_filter(",
        "Emitter",
        "Listener",
        "evaluate_script",
        ".eval(",
    ] {
        assert!(
            !sources.contains(forbidden),
            "{forbidden} in the app events: pushes go through the Channel only (ADR-013)"
        );
    }
    let app = read("src/commands/app.rs");
    assert!(
        app.contains("on_event: Channel<AppEvent>"),
        "subscribe_app takes the channel the pushes are sent on"
    );
    // A message is a type and the fields of that type; none has a place for a path.
    let events = read("src/events.rs");
    let events = events.split("#[cfg(test)]").next().unwrap();
    assert!(
        !events.contains("PathBuf") && !events.contains("Path"),
        "an AppEvent must not be able to carry a path (SECURITY I2)"
    );
}

/// SECURITY I3: a document is opened by one door. `documents::intake` canonicalizes the path, opens it once and judges the open
/// handle; the engine is handed that handle. Nothing else in the command layer, the sources or the engine opens a file by
/// path, and PDFium is never given a path to open (which would be the check-then-open gap again).
#[test]
fn a_document_is_opened_through_intake_and_pdfium_gets_the_handle() {
    for file in [
        "src/commands/mod.rs",
        "src/commands/app.rs",
        "src/sources.rs",
        "src/engine/mod.rs",
        "src/engine/worker.rs",
    ] {
        let source = read(file);
        let production = source.split("#[cfg(test)]").next().unwrap();
        for forbidden in [
            "load_pdf_from_file",
            "File::open(",
            "fs::canonicalize",
            "fs::metadata",
            "OpenOptions",
            "open_without_blocking",
        ] {
            assert!(
                !production.contains(forbidden),
                "{file} uses {forbidden}: a document is opened by `documents::intake::admit` only (SECURITY I3)"
            );
        }
    }
    let engine = read("src/engine/mod.rs");
    assert!(
        engine.contains("file: File,"),
        "Job::Open carries the open handle, not a path"
    );
    assert!(
        read("src/engine/worker.rs").contains("load_pdf_from_reader(file"),
        "PDFium reads the handle intake judged"
    );
    let intake = read("src/documents/intake.rs");
    for rule in [
        "fs::canonicalize",
        "open_without_blocking",
        "metadata.is_file()",
        "PDF_SIGNATURE",
        "MAX_PDF_FILE_BYTES",
    ] {
        assert!(intake.contains(rule), "intake must apply {rule}");
    }
}

/// The app registers as a viewer for `.pdf` and nothing else (SECURITY I3): a double click in the file manager opens it, and
/// the file arrives through the same intake as a drop.
#[test]
fn the_file_association_is_pdf_only_and_viewer_only() {
    let config = config();
    let associations = config["bundle"]["fileAssociations"].as_array().unwrap();
    assert_eq!(associations.len(), 1);
    let pdf = &associations[0];
    assert_eq!(pdf["ext"], serde_json::json!(["pdf"]));
    assert_eq!(pdf["mimeType"], "application/pdf");
    // macOS: a viewer today (an editor once M2 saves annotations into the file), and an alternate, so the user's choice of
    // default application is not taken over.
    assert!(
        matches!(pdf["role"].as_str(), Some("Viewer" | "Editor")),
        "{}",
        pdf["role"]
    );
    assert_eq!(pdf["rank"], "Alternate");
    // No platform file changes it.
    for platform in platform_names() {
        assert_eq!(
            platform_config(&platform)["bundle"]["fileAssociations"],
            config["bundle"]["fileAssociations"],
            "{platform}"
        );
    }
}

/// A second instance is forwarded to the running one by a plugin that only talks locally (a named mutex and a window message on
/// Windows). It is built on Windows alone: macOS opens files in the running app by itself (`RunEvent::Opened`), and the
/// plugin's socket in `/tmp` is not needed there. It is the first plugin, so a second process is turned away before any setup.
#[test]
fn second_instance_forwarding_is_windows_only_and_registered_first() {
    let manifest = read("Cargo.toml");
    assert!(section(&manifest, "dependencies")
        .iter()
        .all(|line| !line.contains("single-instance")));
    assert!(section(&manifest, "target.'cfg(windows)'.dependencies")
        .iter()
        .any(|line| line.starts_with("tauri-plugin-single-instance")));
    let lib = read("src/lib.rs");
    let single_instance = lib.find("tauri_plugin_single_instance::init(").unwrap();
    let dialog = lib.find("tauri_plugin_dialog::init()").unwrap();
    assert!(
        single_instance < dialog,
        "the single-instance plugin has to be the first plugin"
    );
    assert!(lib.contains("#[cfg(windows)]"));
    // It adds no command and no permission: the capability stays as it is.
    assert!(!read("capabilities/default.json").contains("single-instance"));
}
#[test]
fn build_script_declares_exactly_the_granted_commands() {
    let build = read("build.rs");
    let commands = [
        "open_document_dialog",
        "render_page",
        "set_viewport",
        "get_page_sizes",
        "close_document",
        "app_ready",
        "get_settings",
        "update_settings",
        "watch_transparency",
        "subscribe_menu",
        "subscribe_app",
    ];
    let handlers = read("src/lib.rs");
    for command in commands {
        assert!(build.contains(&format!("\"{command}\"")), "{command}");
        // Declared and granted but not registered would fail at run time with "command not found".
        assert!(
            handlers.contains(&format!("::{command},")),
            "{command} is not in the invoke handler"
        );
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
        declared,
        commands.len(),
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
    assert!(section(&manifest, "lints.rust").contains(&"unsafe_code = \"forbid\"".to_owned()));
    let clippy = section(&manifest, "lints.clippy");
    assert!(clippy.contains(&"unwrap_used = \"deny\"".to_owned()));
    assert!(clippy.contains(&"expect_used = \"deny\"".to_owned()));
}
