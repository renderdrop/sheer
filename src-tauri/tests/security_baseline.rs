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
    // ADR-053 section 6: no inline style *markup*. React and Motion write styles through CSSOM (`element.style`, WAAPI), which
    // style-src does not govern; the dev policy keeps 'unsafe-inline' for Vite's injected <style> only.
    assert_eq!(csp["style-src"], set(&["'self'"]));
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

/// Tauri uses `devCsp` only under `tauri dev`; a release must not be able to pick it up: the two differ, the production policy has
/// nothing of the dev server in it, `'unsafe-inline'` is for styles alone (never scripts), and the release workflow builds with the
/// config as it is (no `--config` override, no `--debug`).
#[test]
fn the_release_never_uses_the_dev_csp() {
    let config = config();
    let production = config["app"]["security"]["csp"].as_str().unwrap();
    let dev = config["app"]["security"]["devCsp"].as_str().unwrap();
    assert_ne!(production, dev);
    for forbidden in ["localhost:1420", "ws:", "script-src", "unsafe-eval"] {
        assert!(!production.contains(forbidden), "csp has {forbidden}");
    }
    for (name, tokens) in csp("csp") {
        assert!(
            name == "style-src" || !tokens.contains("'unsafe-inline'"),
            "{name} allows inline code"
        );
    }
    let workflow = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../.github/workflows/release.yml"),
    )
    .unwrap();
    let build: Vec<&str> = workflow
        .lines()
        .filter(|line| line.contains("tauri build") || line.contains("tauri -- build"))
        .collect();
    assert!(!build.is_empty(), "no tauri build step in release.yml");
    for line in build {
        assert!(
            !line.contains("--config") && !line.contains("--debug") && !line.contains("--features"),
            "{line}"
        );
    }
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
        "allow-open-welcome-document",
        "allow-unlock-document",
        "allow-list-recents",
        "allow-remove-recent",
        "allow-open-recent",
        "allow-restore-recent",
        "allow-set-recent-starred",
        "allow-reveal-recent",
        "allow-locate-recent",
        "allow-get-recent-thumbnail",
        "allow-set-menu-state",
        "allow-render-page",
        "allow-set-viewport",
        "allow-get-pages",
        "allow-get-outline",
        "allow-get-text-layer",
        "allow-text-edit-probe",
        "allow-text-edit-lines",
        "allow-search",
        "allow-cancel-search",
        "allow-get-page-links",
        "allow-open-link",
        "allow-list-annotations",
        "allow-list-document-annotations",
        "allow-apply-command",
        "allow-get-form-fields",
        "allow-pick-pdf-sources",
        "allow-release-source",
        "allow-undo",
        "allow-redo",
        "allow-save-document",
        "allow-save-document-as",
        "allow-extract-pages",
        "allow-split-document",
        "allow-merge-documents",
        "allow-compress-document",
        "allow-flatten-document",
        "allow-estimate-compression",
        "allow-cancel-job",
        "allow-close-document",
        "allow-app-ready",
        "allow-get-settings",
        "allow-update-settings",
        "allow-subscribe-menu",
        "allow-subscribe-app",
        "allow-use-signature",
        "allow-save-library-signature",
        "allow-save-draft-signature",
        "allow-rename-signature",
        "allow-list-signatures",
        "allow-import-signature-image",
        "allow-get-signature-preview",
        "allow-discard-signature-draft",
        "allow-get-library-signature",
        "allow-delete-signature",
        "allow-create-typed-signature",
        "allow-create-drawn-signature",
        "allow-clear-signature-library",
        "allow-insert-image-dialog",
        "allow-get-annotation-quote",
        "allow-create-citations",
        "allow-list-citations",
        "allow-get-bibliography",
        "allow-save-citation-list",
        "allow-list-signing-identities",
        "allow-create-signing-identity",
        "allow-pick-identity-file",
        "allow-import-signing-identity",
        "allow-discard-identity-import",
        "allow-delete-signing-identity",
        "allow-export-signing-certificate",
        "allow-sign-document",
        "allow-save-unsigned-copy",
        "allow-validate-signatures",
        "allow-open-signed-revision",
        "allow-set-signer-trust",
        "allow-list-trusted-signers",
        "allow-remove-trusted-signer",
        "allow-get-asset-preview",
        "allow-import-warnings",
        "allow-apply-redactions",
        "allow-get-protection",
        "allow-stage-protection",
        "allow-stage-unprotection",
        "allow-get-metadata",
        "allow-export-images",
        "allow-resolve-export-conflicts",
        "allow-images-to-pdf",
        "allow-release-image-batch",
        "allow-pick-images",
        "allow-list-image-batch",
        "allow-get-image-batch-preview",
        "allow-export-pdf",
        "allow-prepare-print",
        "allow-get-print-page",
        "allow-open-print-dialog",
        "allow-release-print",
        "allow-list-recoveries",
        "allow-restore-recovery",
        "allow-discard-recovery",
        "allow-discard-all-recoveries",
        "allow-check-for-update",
        "allow-download-update",
        "allow-install-update-on-quit",
        "allow-skip-update-version",
        "allow-updater-configured",
        "allow-open-default-apps-settings",
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
/// `Channel` argument of a command instead (`subscribe_menu`), which needs no permission.
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
    // Windows registers through the NSIS hooks instead (ADR-053 section 5): Tauri's own macro would write the .pdf default.
    // Every other platform file leaves the base list alone.
    for platform in platform_names() {
        let expected = if platform == "windows" {
            serde_json::json!([])
        } else {
            config["bundle"]["fileAssociations"].clone()
        };
        assert_eq!(
            platform_config(&platform)["bundle"]["fileAssociations"],
            expected,
            "{platform}"
        );
    }
}

/// The NSIS hooks add Sheer to "Open with" and never take the default: no write to the (Default) value of `.pdf` or to
/// `HKCR`/`UserChoice`, everything under HKCU, and the uninstall removes the ProgID it wrote.
#[test]
fn nsis_hooks_register_pdf_without_becoming_the_default() {
    let windows = platform_config("windows");
    let nsis = &windows["bundle"]["windows"]["nsis"];
    assert_eq!(nsis["installMode"], "currentUser");
    assert_eq!(nsis["installerHooks"], "installer/hooks.nsh");
    let hooks = read("installer/hooks.nsh");
    let code: Vec<&str> = hooks
        .lines()
        .map(str::trim)
        .filter(|line| !line.starts_with(';'))
        .collect();
    for line in &code {
        assert!(!line.contains("UserChoice"), "{line}");
        assert!(!line.contains("HKCR") && !line.contains("HKLM"), "{line}");
        if line.starts_with("WriteReg") && line.contains(r"Software\Classes\.pdf") {
            assert!(
                line.contains("OpenWithProgids"),
                "only OpenWithProgids may be written under .pdf: {line}"
            );
        }
    }
    let joined = code.join("\n");
    assert!(joined.contains("NSIS_HOOK_POSTINSTALL") && joined.contains("NSIS_HOOK_PREUNINSTALL"));
    assert!(joined.contains(r#"DeleteRegKey HKCU "Software\Classes\${SHEER_PROGID}""#));
    assert!(joined.contains(r#"DeleteRegValue HKCU "Software\Classes\.pdf\OpenWithProgids""#));
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
    // The list is read from build.rs itself, so a command cannot be declared without a grant, a handler and a permission file.
    let marker = ".commands(&[";
    let start = build.find(marker).expect("build.rs declares the commands") + marker.len();
    let end = start + build[start..].find(']').expect("the command list ends");
    let commands: Vec<&str> = build[start..end].split('"').skip(1).step_by(2).collect();
    assert!(
        commands.len() > 60,
        "the scan found too few commands: {}",
        commands.len()
    );
    let handlers = read("src/lib.rs");
    for command in &commands {
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
    // Every declared command is also granted: a command without its `allow-` entry is denied at runtime.
    let capability = read("capabilities/default.json");
    for command in &commands {
        let permission = format!("\"allow-{}\"", command.replace('_', "-"));
        assert!(
            capability.contains(&permission),
            "{command} is declared but not granted"
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
/// SECURITY P3: a link in a PDF is opened by Rust and only by Rust. The opener plugin is a dependency whose one function, `open_url`,
/// is called in one place (`commands/links.rs`) with a `SafeUrl`; the plugin is not registered with the builder (so the webview has no
/// `plugin:opener|...` command at all), and no capability grants it.
#[test]
fn the_opener_is_called_from_rust_only_and_the_webview_has_no_permission_for_it() {
    // No capability names it, in any file.
    for entry in fs::read_dir(root().join("capabilities")).unwrap() {
        let path = entry.unwrap().path();
        let text = fs::read_to_string(&path).unwrap();
        assert!(
            !text.contains("opener"),
            "{} grants the opener to the webview (SECURITY P3)",
            path.display()
        );
    }
    // It is not registered as a plugin: `generate_handler!` and `.plugin(...)` do not know it.
    let lib = read("src/lib.rs");
    assert!(
        !lib.contains("tauri_plugin_opener") && !lib.contains("opener::init"),
        "the opener plugin must not be registered: it would add commands for the webview"
    );
    // Its `open_url` is the one function used, in the one file that has a confirmation dialog in front of it.
    let mut users = Vec::new();
    let mut stack = vec![root().join("src")];
    while let Some(dir) = stack.pop() {
        for entry in fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                stack.push(path);
            } else if path.extension().is_some_and(|ext| ext == "rs") {
                let text = fs::read_to_string(&path).unwrap();
                for line in text
                    .lines()
                    .filter(|line| !line.trim_start().starts_with("//"))
                {
                    if let Some((_, after)) = line.split_once("tauri_plugin_opener") {
                        users.push((path.clone(), after.trim().to_owned()));
                    }
                }
            }
        }
    }
    // Two uses: `open_url` for links, and `reveal_item_in_dir` for "show in the file manager" of a recent file, whose path comes
    // from the recents store only (`commands/recent_actions.rs`).
    assert_eq!(users.len(), 2, "the opener is named twice: {users:?}");
    let named = |file: &str, call: &str| {
        users
            .iter()
            .any(|(path, after)| path.ends_with(file) && after.starts_with(call))
    };
    assert!(
        named("links.rs", "::open_url("),
        "open_url is used in links.rs: {users:?}"
    );
    assert!(
        named("recent_actions.rs", "::reveal_item_in_dir("),
        "only reveal_item_in_dir is used in recent_actions.rs: {users:?}"
    );
    let links = read("src/commands/links.rs");
    let confirm = links.find(".blocking_show()").expect("the dialog");
    let open = links
        .find("tauri_plugin_opener::open_url")
        .expect("the opener");
    assert!(
        confirm < open,
        "the dialog is built before the opener is called"
    );
}

/// SECURITY P3: the webview passes no URL. `open_link` names a link by document, page and index; the URL comes from the file.
#[test]
fn open_link_takes_no_url_from_the_webview() {
    let signature = command_signatures()
        .into_iter()
        .find(|(name, _)| name == "open_link")
        .expect("open_link is a command")
        .1;
    let mut names = parameter_names(&signature);
    names.retain(|name| name != "window" && name != "state");
    assert_eq!(names, ["doc_id", "page_id", "link_index"]);
}

/// ADR-023: the welcome document is opened by a command that takes nothing from the webview. Its file is resolved in Rust from
/// the resource directory, opened through the one door (`AppState::open_welcome` -> `open_as` -> `intake::admit`), and shipped
/// as a bundle resource next to PDFium and nothing else.
#[test]
fn open_welcome_document_takes_nothing_from_the_webview_and_opens_through_intake() {
    let signatures = command_signatures();
    let (_, signature) = signatures
        .iter()
        .find(|(name, _)| name == "open_welcome_document")
        .expect("the command exists");
    assert_eq!(
        parameter_names(signature),
        ["app", "state"],
        "no argument comes from the webview, only Tauri's own handles"
    );
    let source = read("src/commands/mod.rs");
    let production = source.split("#[cfg(test)]").next().unwrap();
    assert!(production.contains("BaseDirectory::Resource"));
    assert!(production.contains("\"resources/welcome/welcome-en.pdf\""));
    assert!(production.contains("\"resources/welcome/welcome-de.pdf\""));
    assert!(
        production.contains("intake::admit(&path)"),
        "open_as admits every file, the welcome document too"
    );
    let resources = config()["bundle"]["resources"].clone();
    assert_eq!(
        resources,
        serde_json::json!(["pdfium/**/*", "resources/welcome/*.pdf"])
    );
    for edition in ["en", "de"] {
        assert!(
            root()
                .join(format!("resources/welcome/welcome-{edition}.pdf"))
                .is_file(),
            "{edition}"
        );
    }
}

/// The welcome document is a bundled resource and is never written in place (ADR-004, DESIGN 3.27): `save_in_place` answers `read_only`
/// before it reads, backs up or writes anything, and the in-place path is the only caller of the common save. The behaviour is tested
/// with the real engine in `tests/save_annotations.rs`; this pins the shape of the code.
#[test]
fn saving_in_place_refuses_the_welcome_document_before_anything_else() {
    let source = read("src/commands/save.rs");
    let start = source.find("pub fn save_in_place").expect("save_in_place");
    let body = &source[start..];
    let refusal = body.find("DocKind::Welcome").expect("the welcome check");
    let read_only = body.find("ErrorCode::ReadOnly").expect("read_only");
    let common = body.find("self.save(id, None").expect("the common save");
    assert!(refusal < read_only && read_only < common);
    // Only the dialog's path (through `intake::admit_target`) and the in-place save call the common save.
    assert_eq!(source.matches("self.save(id,").count(), 2);
    assert!(source.contains("intake::admit_target(target)"));
}

/// The close of the window is held back by Rust while a document is open (ADR-029 §7): the webview has the close permission of the
/// custom title bar, so the question about unsaved changes must not depend on anything the page does. The handler is registered on the
/// builder, answers `CloseRequested` with `prevent_close` (and a quit with `prevent_exit`), and decides from backend state.
#[test]
fn the_close_request_is_held_back_in_rust_not_by_the_page() {
    let lib = read("src/lib.rs");
    assert!(
        lib.contains("sources::on_window_event(window, event)"),
        "the window event hook must be registered on the builder"
    );
    assert!(
        lib.contains("sources::on_run_event(app, &event)"),
        "the run event hook must be registered"
    );
    let sources = read("src/sources.rs");
    let close = sources
        .split("WindowEvent::CloseRequested { api, .. }")
        .nth(1)
        .expect("the hook handles CloseRequested");
    let handler: String = close.chars().take(240).collect();
    assert!(
        handler.contains("ui_takes_the_close(app)") && handler.contains("api.prevent_close()"),
        "CloseRequested must call prevent_close when the UI takes the close: {handler}"
    );
    assert!(
        sources.contains("RunEvent::ExitRequested") && sources.contains("api.prevent_exit()"),
        "a quit with a document open must be held back too"
    );
    // The decision looks at backend state (the registry), not at an argument that came from the webview.
    assert!(sources.contains("state.has_open_documents()"));
    assert!(sources.contains("events.request_close()"));
}
/// Every `.rs` file under `src/`, as (path relative to `src-tauri`, with forward slashes; text), cut at the first `#[cfg(test)]`
/// (the unit tests sit at the end of a file and may print and use whatever they need).
fn production_sources() -> Vec<(String, String)> {
    fn walk(dir: &std::path::Path, out: &mut Vec<PathBuf>) {
        for entry in fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                walk(&path, out);
            } else if path.extension().is_some_and(|e| e == "rs") {
                out.push(path);
            }
        }
    }
    let mut files = Vec::new();
    walk(&root().join("src"), &mut files);
    files
        .into_iter()
        .map(|path| {
            let name = path
                .strip_prefix(root())
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/");
            let text = fs::read_to_string(&path).unwrap();
            let production = text.split("#[cfg(test)]").next().unwrap().to_owned();
            (name, production)
        })
        .collect()
}

/// T8: the main window is built in code with a navigation guard and a new-window refusal, from windows the config declares with
/// `create: false`, and the dev server the guard accepts is the one the config names.
#[test]
fn the_webview_can_only_navigate_to_the_app_origin() {
    let navigation = read("src/security/navigation.rs");
    assert!(navigation.contains(".on_navigation(|url| allows(url, cfg!(debug_assertions)))"));
    assert!(navigation.contains(".on_new_window(|_, _| NewWindowResponse::Deny)"));
    assert!(read("src/lib.rs").contains("security::navigation::create_windows(app)?"));
    // The dev origin is only accepted in a debug build, and is the config's devUrl.
    let dev_url = config()["build"]["devUrl"].as_str().unwrap().to_owned();
    assert_eq!(dev_url, "http://localhost:1420");
    assert!(navigation.contains("DEV_HOST: &str = \"localhost\""));
    assert!(navigation.contains("DEV_PORT: u16 = 1420"));
    // Every window of the base config and of every platform file is left to `create_windows`, or it would exist without the guards.
    let mut configs = vec![config()];
    for platform in platform_names() {
        configs.push(serde_json::from_str(&read(&format!("tauri.{platform}.conf.json"))).unwrap());
    }
    for config in configs {
        for window in config["app"]["windows"].as_array().into_iter().flatten() {
            assert_eq!(window["create"], Value::Bool(false), "{window}");
        }
    }
}

/// The index just after the parenthesis that closes the call whose argument list opens at `open` (strings are skipped).
fn call_end(text: &str, open: usize) -> usize {
    let (mut depth, mut in_string, mut escaped) = (0_u32, false, false);
    for (offset, c) in text[open..].char_indices() {
        match (in_string, c) {
            (true, _) if escaped => escaped = false,
            (true, '\\') => escaped = true,
            (true, '"') => in_string = false,
            (true, _) => {}
            (false, '"') => in_string = true,
            (false, '(') => depth += 1,
            (false, ')') => {
                depth -= 1;
                if depth == 0 {
                    return open + offset + 1;
                }
            }
            _ => {}
        }
    }
    text.len()
}

/// D6: no log call in production code formats anything but an error value, a reason code or a fixed text. Document content (names,
/// text, paths) must never reach `eprintln!`/`println!`/`dbg!`; the detail of an error is logged only through `AppError::log`
/// (debug level only). A new call that formats something else has to be added here, with its reason.
#[test]
fn log_calls_format_no_document_strings() {
    const MACROS: [&str; 5] = ["eprintln!", "eprint!", "println!", "print!", "dbg!"];
    // Arguments that are known not to carry document content.
    const ALLOWED_ARGS: [&str; 7] = [
        "error",
        "reason",
        "error.kind()",
        "error.code()",
        "index + 1",
        "self.code",
        "detail",
    ];
    let mut found = 0;
    for (file, text) in production_sources() {
        for mac in MACROS {
            for (start, _) in text.match_indices(mac) {
                let before = text[..start].chars().next_back();
                if before.is_some_and(|c| c.is_alphanumeric() || c == '_') {
                    continue; // `print!` inside `eprint!`: the longer name has its own entry
                }
                let line_start = text[..start].rfind('\n').map_or(0, |i| i + 1);
                if text[line_start..start].trim_start().starts_with("//") {
                    continue;
                }
                let end = call_end(&text, start + mac.len());
                let call = &text[start..end - 1];
                found += 1;
                // Inline `{name}` / `{name:?}` placeholders, then the trailing arguments.
                let mut args: Vec<String> = Vec::new();
                let mut rest = call;
                while let Some(open) = rest.find('{') {
                    let Some(close) = rest[open..].find('}') else {
                        break;
                    };
                    let inner = &rest[open + 1..open + close];
                    if !inner.is_empty() {
                        args.push(inner.split(':').next().unwrap().trim().to_owned());
                    }
                    rest = &rest[open + close + 1..];
                }
                if let Some((_, after)) = call.rsplit_once("\",") {
                    args.extend(
                        after
                            .split(',')
                            .map(|arg| arg.trim().to_owned())
                            .filter(|arg| !arg.is_empty()),
                    );
                }
                for arg in args {
                    // The child's stderr relay, gated on the detail level (checked below).
                    let relay = file == "src/engine/transport.rs" && arg == "text.trim_end()";
                    assert!(
                        ALLOWED_ARGS.contains(&arg.as_str()) || relay,
                        "{file}: a log call formats `{arg}`, which may be document content: {call}"
                    );
                }
            }
        }
    }
    assert!(
        found >= 5,
        "the scan found {found} log calls: the pattern is broken"
    );
    let transport = read("src/engine/transport.rs");
    let relay = transport.find("sheer-engine: {}").unwrap();
    let gate = transport.find("detail_logging_enabled()").unwrap();
    assert!(
        gate < relay && relay - gate < 200,
        "the engine's stderr is relayed only at detail level"
    );
}

/// D6: the default level hides the detail of an error (the opt-in is `SHEER_LOG=debug` or a debug build), and no logging crate that
/// could write to a file or the network is a dependency.
#[test]
fn logging_is_local_stderr_with_detail_opt_in() {
    let error = read("src/error.rs");
    assert!(error.contains("(Some(detail), true) => eprintln!"));
    assert!(error.contains("debug_build || env_level == Some(\"debug\")"));
    let manifest = read("Cargo.toml");
    for logger in ["tracing", "log", "env_logger", "sentry", "tauri-plugin-log"] {
        let declared = manifest.lines().any(|line| {
            line.strip_prefix(logger)
                .is_some_and(|rest| rest.trim_start().starts_with('=') || rest.starts_with('.'))
        });
        assert!(!declared, "{logger} is a logging dependency");
    }
}

/// P4: nothing in the app opens or extracts an embedded file (attachment). The PDFium and lopdf attachment APIs, and the names of the
/// structures, appear nowhere in production code outside this allowlist (empty today).
#[test]
fn no_code_path_opens_or_extracts_embedded_files() {
    const FORBIDDEN: [&str; 8] = [
        "FPDFDoc_GetAttachment",
        "FPDFDoc_AddAttachment",
        "FPDFDoc_DeleteAttachment",
        "FPDFAttachment_",
        ".attachments()",
        "EmbeddedFile",
        "/FileAttachment",
        "FPDFAnnot_GetFileAttachment",
    ];
    const ALLOWLIST: [&str; 0] = [];
    for (file, text) in production_sources() {
        if ALLOWLIST.contains(&file.as_str()) {
            continue;
        }
        for word in FORBIDDEN {
            assert!(
                !text.contains(word),
                "{file} uses `{word}`: embedded files must never be opened or extracted (P4)"
            );
        }
    }
}

/// The recent-preview command takes a recents id and nothing else: the path comes from the backend list, the file name in the cache from
/// a hash of that path, the read is capped and checked, and the document the preview is made from is one the user opened.
#[test]
fn the_thumbnail_commands_take_no_path_from_the_webview() {
    let source = read("src/commands/thumbnails.rs");
    let command = source
        .split("pub async fn get_recent_thumbnail(")
        .nth(1)
        .unwrap()
        .split(')')
        .next()
        .unwrap();
    assert!(
        command.contains("recent_id: u32") && !command.contains("path"),
        "{command}"
    );
    // `cache_thumbnail` is a method of the state, not a command: nothing registers it with the webview.
    assert!(!read("src/lib.rs").contains("cache_thumbnail"));
    assert!(source.contains("self.registry.kind(id) != Some(DocKind::User)"));
    let thumbs = read("src/storage/thumbs.rs");
    assert!(thumbs.contains("MAX_THUMB_BYTES + 1") && thumbs.contains("is_thumb_frame(&bytes)"));
}
