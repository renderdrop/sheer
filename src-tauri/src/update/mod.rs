//! The only network module (ADR-053 §3, ARCHITECTURE §11.3). Nothing outside `update/` names `tauri_plugin_updater` (check.sh guard).
//!
//! * The plugin is used from Rust only: no capability grants `updater:*`, so the webview cannot call it, and the requests are
//!   Rust-side, so the CSP is unchanged.
//! * The public key is `updater/minisign.pub`. While it is the placeholder the plugin is not even registered and every call
//!   answers `unsupported_feature` (`what: "updater_unconfigured"`).
//! * One endpoint constant, HTTPS only. The automatic check runs only while `settings.updates` is on; "Check for updates" is a click.
//! * A package is verified before it is kept; a bad signature drops it. Installing happens in the quit hook only.

use std::sync::Arc;
use std::time::Duration;

use base64::Engine as _;
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::plugin::{Builder, TauriPlugin};
use tauri::{AppHandle, Manager, RunEvent, Runtime};
use tauri_plugin_updater::UpdaterExt;

use crate::error::{AppError, ErrorCode};
use crate::events::{AppEvent, AppEvents};
use crate::limits;
use crate::storage::settings::{SettingsPatch, SettingsStore, SkippedVersion, UpdatesMode};

pub mod state;

use state::{Trigger, UpdateState, Verified};

/// The one place updates come from: the latest release's manifest on GitHub. No template variables, so the request carries no
/// version or identifier.
pub const ENDPOINT: &str =
    "https://github.com/renderdrop/sheer/releases/latest/download/latest.json";
/// The signing key's public half, embedded at build time.
const PUBKEY_FILE: &str = include_str!("../../updater/minisign.pub");
/// How long the manifest request may take.
const CHECK_TIMEOUT: Duration = Duration::from_secs(30);
/// How long the package download may take in all.
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(15 * 60);
/// How often the background thread looks whether the automatic check is due.
const TICK: Duration = Duration::from_secs(60);

/// What the UI is told about an available update. `notes` is plain text, at most `limits::UPDATE_NOTES_MAX` bytes, with control and
/// bidirectional characters removed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,
    pub date: Option<String>,
    pub notes: String,
}

/// Progress of `download_update`, on its channel.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum UpdateEvent {
    Progress {
        downloaded: u64,
        total: Option<u64>,
    },
    /// Downloaded and signature-checked; installing happens on quit.
    Verified,
    /// A bad signature deletes the download (ADR-054 §4).
    Failed {
        code: ErrorCode,
    },
}

/// Why an update step failed. Mapped to an [`AppError`] at the command boundary; the detail only reaches the local log.
#[derive(Debug, PartialEq, Eq)]
pub enum UpdateError {
    /// The signing key is still the placeholder (or damaged): the updater does not run (`updater_unconfigured`).
    Unconfigured,
    /// The signature does not match: the download is dropped.
    BadSignature,
    /// The package is bigger than `limits::UPDATE_PACKAGE_MAX`.
    TooLarge,
    /// A network, HTTP or parse failure.
    Failed(String),
}

impl From<UpdateError> for AppError {
    fn from(error: UpdateError) -> Self {
        match error {
            UpdateError::Unconfigured => AppError::unsupported("updater_unconfigured"),
            UpdateError::BadSignature => AppError::new(ErrorCode::DamagedFile),
            UpdateError::TooLarge => {
                AppError::too_large("update_package", limits::UPDATE_PACKAGE_MAX)
            }
            UpdateError::Failed(detail) => AppError::logged(ErrorCode::Internal, detail),
        }
    }
}

impl From<tauri_plugin_updater::Error> for UpdateError {
    fn from(error: tauri_plugin_updater::Error) -> Self {
        use tauri_plugin_updater::Error as E;
        match error {
            E::Minisign(_)
            | E::Base64(_)
            | E::SignatureUtf8(_)
            | E::SignedVersionMismatch { .. }
            | E::MissingSignedVersion => Self::BadSignature,
            other => Self::Failed(other.to_string()),
        }
    }
}

/// The key line of a `minisign.pub` file: the first line that is not empty and does not start with `#`, accepted only when it is a
/// real public key in the form `tauri signer generate` writes (base64 of the two-line minisign key text). The placeholder is not.
pub fn pubkey_from_file(file: &str) -> Result<String, UpdateError> {
    let line = file
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty() && !line.starts_with('#'))
        .ok_or(UpdateError::Unconfigured)?;
    decode_public_key(line).map_err(|_| UpdateError::Unconfigured)?;
    Ok(line.to_owned())
}

/// The embedded key, or `Unconfigured` while it is the placeholder.
pub fn configured_key() -> Result<String, UpdateError> {
    pubkey_from_file(PUBKEY_FILE)
}

fn base64_text(encoded: &str) -> Result<String, UpdateError> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded.trim())
        .map_err(|_| UpdateError::BadSignature)?;
    String::from_utf8(bytes).map_err(|_| UpdateError::BadSignature)
}

fn decode_public_key(pubkey: &str) -> Result<minisign_verify::PublicKey, UpdateError> {
    let text = base64_text(pubkey)?;
    minisign_verify::PublicKey::decode(&text).map_err(|_| UpdateError::BadSignature)
}

/// Checks `data` against `signature` (the content of the release's `.sig` file: base64 of the minisign signature text) with
/// `pubkey`. The plugin verifies the same way while downloading; this second check is on the bytes we keep.
pub fn verify_package(data: &[u8], signature: &str, pubkey: &str) -> Result<(), UpdateError> {
    let key = decode_public_key(pubkey)?;
    let signature = minisign_verify::Signature::decode(&base64_text(signature)?)
        .map_err(|_| UpdateError::BadSignature)?;
    key.verify(data, &signature, true)
        .map_err(|_| UpdateError::BadSignature)
}

/// The outcome of a download as it is kept: the size cap and the signature are both enforced here, whatever the plugin said.
pub fn accept_download(
    downloaded: Result<Vec<u8>, tauri_plugin_updater::Error>,
    signature: &str,
    pubkey: &str,
) -> Result<Vec<u8>, UpdateError> {
    let package = downloaded?;
    if package.len() as u64 > limits::UPDATE_PACKAGE_MAX {
        return Err(UpdateError::TooLarge);
    }
    verify_package(&package, signature, pubkey)?;
    Ok(package)
}

/// Release notes as plain text for the UI: control characters (except newline) and bidirectional controls removed, cut to
/// `UPDATE_NOTES_MAX` bytes at a character boundary.
pub fn sanitize_notes(notes: &str) -> String {
    let mut out = String::new();
    for c in notes.chars() {
        let bidi = matches!(
            c,
            '\u{61c}' | '\u{200e}' | '\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}'
        );
        if bidi || (c.is_control() && c != '\n') {
            continue;
        }
        if out.len() + c.len_utf8() > limits::UPDATE_NOTES_MAX {
            break;
        }
        out.push(c);
    }
    out
}

/// The plugin configuration the app adds to the Tauri context in code (so `tauri.conf.json` carries no updater entry): the
/// endpoint and the key.
pub fn plugin_config(pubkey: &str) -> serde_json::Value {
    serde_json::json!({ "endpoints": [ENDPOINT], "pubkey": pubkey })
}

/// Adds the updater's plugin configuration to `context` when the key is real; nothing while it is the placeholder.
/// Call it on `generate_context!()`.
pub fn configure(mut context: tauri::Context) -> tauri::Context {
    // The acceptance build (ADR-131) never updates: without the plugin configuration the updater is not registered.
    if cfg!(feature = "automation") {
        return context;
    }
    if let Ok(key) = configured_key() {
        context
            .config_mut()
            .plugins
            .0
            .insert("updater".to_owned(), plugin_config(&key));
    }
    context
}

fn updates_mode<R: Runtime>(app: &AppHandle<R>) -> UpdatesMode {
    app.try_state::<Arc<SettingsStore>>()
        .map(|store| store.get().updates)
        .unwrap_or_default()
}

/// The shared update state, managed by [`plugin`].
pub fn update_state<R: Runtime>(app: &AppHandle<R>) -> Result<Arc<UpdateState>, AppError> {
    app.try_state::<Arc<UpdateState>>()
        .map(|state| state.inner().clone())
        .ok_or_else(|| AppError::logged(ErrorCode::Internal, "update state missing"))
}

/// Asks the endpoint whether a newer version exists. Every network access starts here and passes the key and the setting first.
pub async fn check<R: Runtime>(
    app: &AppHandle<R>,
    trigger: Trigger,
) -> Result<Option<UpdateInfo>, AppError> {
    configured_key()?;
    let state = update_state(app)?;
    if !state.ready() {
        return Err(UpdateError::Unconfigured.into());
    }
    if !state::may_check(trigger, updates_mode(app)) {
        return Err(AppError::new(ErrorCode::UnsupportedFeature));
    }
    state.note_check(std::time::Instant::now());
    let endpoint = ENDPOINT
        .parse()
        .map_err(|error| AppError::logged(ErrorCode::Internal, format!("endpoint: {error}")))?;
    let updater = app
        .updater_builder()
        .endpoints(vec![endpoint])
        .and_then(|builder| builder.timeout(CHECK_TIMEOUT).build())
        .map_err(UpdateError::from)?;
    let found = updater.check().await.map_err(UpdateError::from)?;
    let Some(update) = found else {
        state.set_found(None);
        return Ok(None);
    };
    // Defence in depth: the plugin compares too, but a manifest that names the same or an older version (a downgrade) is never offered.
    if !is_newer(&update.current_version, &update.version) {
        state.set_found(None);
        return Ok(None);
    }
    if SkippedVersion::new(&update.version).is_none() {
        state.set_found(None);
        return Err(AppError::logged(
            ErrorCode::Internal,
            "update version is not a version string",
        ));
    }
    let skipped = app.try_state::<Arc<SettingsStore>>().is_some_and(|store| {
        store.get().skipped_version.as_deref() == Some(update.version.as_str())
    });
    if trigger == Trigger::Automatic && skipped {
        state.set_found(None);
        return Ok(None);
    }
    let info = UpdateInfo {
        version: update.version.clone(),
        date: update.date.map(|date| date.date().to_string()),
        notes: sanitize_notes(update.body.as_deref().unwrap_or_default()),
    };
    state.set_found(Some(update));
    Ok(Some(info))
}

/// `x.y.z` with an optional `-pre` / `+build` tail as (numbers, is a release, tail).
fn version_key(version: &str) -> Option<([u64; 3], bool, &str)> {
    let core_end = version.find(['-', '+']).unwrap_or(version.len());
    let mut numbers = [0u64; 3];
    let mut parts = version[..core_end].split('.');
    for slot in &mut numbers {
        *slot = parts.next()?.parse().ok()?;
    }
    if parts.next().is_some() {
        return None;
    }
    let tail = &version[core_end..];
    Some((numbers, !tail.starts_with('-'), tail))
}

/// `true` only when `offered` is strictly newer than `current`; a version that does not parse is never newer.
pub fn is_newer(current: &str, offered: &str) -> bool {
    match (version_key(current), version_key(offered)) {
        // Two prereleases of one version: the plugin orders them; here only an identical string is refused.
        (Some((c, false, c_pre)), Some((o, false, o_pre))) if c == o => c_pre != o_pre,
        (Some(current), Some(offered)) => (offered.0, offered.1) > (current.0, current.1),
        _ => false,
    }
}

enum Step {
    Done(Result<Vec<u8>, tauri_plugin_updater::Error>),
    TooBig,
}

/// Downloads the update `check` found, verifies it and keeps it in memory. A bad signature drops everything and is final.
pub async fn download<R: Runtime>(
    app: &AppHandle<R>,
    on_event: &Channel<UpdateEvent>,
) -> Result<(), AppError> {
    let key = configured_key()?;
    let state = update_state(app)?;
    if !state.ready() {
        return Err(UpdateError::Unconfigured.into());
    }
    let mut update = state.found().ok_or(AppError::not_found("update"))?;
    update.timeout = Some(DOWNLOAD_TIMEOUT);
    let signature = update.signature.clone();

    let (tx, rx) = std::sync::mpsc::channel::<Step>();
    let size_tx = tx.clone();
    let progress = on_event.clone();
    let mut downloaded = 0_u64;
    let task_update = update.clone();
    let task = tauri::async_runtime::spawn(async move {
        let result = task_update
            .download(
                move |chunk, total| {
                    downloaded += chunk as u64;
                    let _ = progress.send(UpdateEvent::Progress { downloaded, total });
                    if downloaded > limits::UPDATE_PACKAGE_MAX
                        || total.is_some_and(|total| total > limits::UPDATE_PACKAGE_MAX)
                    {
                        let _ = size_tx.send(Step::TooBig);
                    }
                },
                || {},
            )
            .await;
        let _ = tx.send(Step::Done(result));
    });
    // The first message wins: a size violation ends the wait before the download finishes.
    let step = tauri::async_runtime::spawn_blocking(move || rx.recv().ok())
        .await
        .map_err(|error| {
            AppError::logged(ErrorCode::Internal, format!("download wait: {error}"))
        })?;
    let outcome = match step {
        Some(Step::Done(result)) => accept_download(result, &signature, &key),
        Some(Step::TooBig) => {
            task.abort();
            Err(UpdateError::TooLarge)
        }
        None => Err(UpdateError::Failed("download task ended".into())),
    };
    finish_download(&state, update, outcome, on_event)
}

/// Keeps a verified package, or drops everything after a bad signature (final: no retry, ADR-054 section 4).
fn finish_download(
    state: &UpdateState,
    update: tauri_plugin_updater::Update,
    outcome: Result<Vec<u8>, UpdateError>,
    on_event: &Channel<UpdateEvent>,
) -> Result<(), AppError> {
    match outcome {
        Ok(package) => {
            state.set_verified(Verified { update, package });
            let _ = on_event.send(UpdateEvent::Verified);
            Ok(())
        }
        Err(error) => {
            if error == UpdateError::BadSignature {
                state.discard();
            }
            let error = AppError::from(error);
            let _ = on_event.send(UpdateEvent::Failed { code: error.code() });
            Err(error)
        }
    }
}

/// Remembers `version` as the one not to offer again.
pub fn skip_version(store: &SettingsStore, version: &str) -> Result<(), AppError> {
    if SkippedVersion::new(version).is_none() {
        return Err(AppError::invalid("updateVersion"));
    }
    let patch = SettingsPatch::from_value(&serde_json::json!({ "skippedVersion": version }))?;
    store.update(patch).map(|_| ())
}

/// `RunEvent` hook: installs the marked package when the app exits, which only happens after the quit flow resolved every dirty
/// document. Windows runs the installer and ends the process; macOS swaps the bundle and then restarts.
pub fn on_run_event<R: Runtime>(app: &AppHandle<R>, event: &RunEvent) {
    if !matches!(event, RunEvent::Exit) {
        return;
    }
    let Ok(state) = update_state(app) else {
        return;
    };
    let Some(verified) = state.take_for_install() else {
        return;
    };
    match verified.update.install(&verified.package) {
        #[cfg(not(windows))]
        Ok(()) => app.restart(),
        #[cfg(windows)]
        Ok(()) => {}
        Err(error) => AppError::from(UpdateError::from(error)).log(),
    }
}

/// Background thread of the automatic check. It only ever calls [`check`] with `Trigger::Automatic`, which the setting gates.
fn spawn_scheduler<R: Runtime>(app: AppHandle<R>, state: Arc<UpdateState>) {
    let spawned = std::thread::Builder::new()
        .name("sheer-update-check".into())
        .spawn(move || loop {
            std::thread::sleep(TICK);
            let now = std::time::Instant::now();
            if !state::automatic_due(updates_mode(&app), state.last_check(), now) {
                continue;
            }
            match tauri::async_runtime::block_on(check(&app, Trigger::Automatic)) {
                Ok(Some(info)) => {
                    if let Some(events) = app.try_state::<Arc<AppEvents>>() {
                        events.publish(AppEvent::UpdateAvailable { info });
                    }
                }
                Ok(None) => {}
                // Silent for the user, logged locally.
                Err(error) => error.log(),
            }
        });
    if let Err(error) = spawned {
        AppError::logged(ErrorCode::Internal, error).log();
    }
}

/// The plugin `run` registers: it owns the update state, and registers `tauri-plugin-updater` itself when the key is real.
pub fn plugin<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("sheer-update")
        .setup(|app, _api| {
            let state = Arc::new(UpdateState::default());
            app.manage(state.clone());
            match configured_key() {
                Ok(_) => {
                    app.plugin(tauri_plugin_updater::Builder::new().build())?;
                    state.set_ready();
                    spawn_scheduler(app.clone(), state);
                }
                Err(_) => eprintln!("sheer: updater_unconfigured"),
            }
            Ok(())
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Cursor;

    /// A key pair and a signature made at test time, in the format `tauri signer` writes.
    struct TestKey {
        pubkey: String,
        pub_file: String,
    }

    fn encode(text: &str) -> String {
        base64::engine::general_purpose::STANDARD.encode(text)
    }

    fn test_key() -> TestKey {
        let pair = minisign::KeyPair::generate_unencrypted_keypair().unwrap();
        let text = pair.pk.to_box().unwrap().into_string();
        let pubkey = encode(&text);
        // The pubkey goes through a real file in a temp dir, with the comment header the shipped file has.
        let dir = std::env::temp_dir().join(format!(
            "sheer-update-test-{}-{}",
            std::process::id(),
            rand_suffix()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("minisign.pub");
        std::fs::write(&path, format!("# comment\n\n{pubkey}\n")).unwrap();
        let pub_file = std::fs::read_to_string(&path).unwrap();
        std::fs::remove_file(&path).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
        // The secret key never leaves this function except inside the signer closure below.
        SECRET.with(|secret| *secret.borrow_mut() = Some(pair.sk));
        TestKey { pubkey, pub_file }
    }

    thread_local! {
        static SECRET: std::cell::RefCell<Option<minisign::SecretKey>> = const { std::cell::RefCell::new(None) };
    }

    fn rand_suffix() -> usize {
        static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    }

    fn sign(data: &[u8]) -> String {
        SECRET.with(|secret| {
            let secret = secret.borrow();
            let signature = minisign::sign(
                None,
                secret.as_ref().unwrap(),
                Cursor::new(data),
                Some("timestamp:1\tfile:sheer"),
                Some("signature from test key"),
            )
            .unwrap();
            encode(&signature.into_string())
        })
    }

    #[test]
    fn the_shipped_key_is_the_placeholder_and_the_updater_refuses_to_run() {
        assert_eq!(configured_key(), Err(UpdateError::Unconfigured));
        let error = AppError::from(UpdateError::Unconfigured);
        assert_eq!(error.code(), ErrorCode::UnsupportedFeature);
        assert!(error.to_string().contains("unsupported_feature"));
        assert!(PUBKEY_FILE.contains("PLACEHOLDER"));
    }

    #[test]
    fn only_a_real_minisign_key_counts_as_configured() {
        for bad in [
            "",
            "# only a comment\n",
            "REPLACE_WITH_BASE64_MINISIGN_PUBLIC_KEY\n",
            "# c\nbm90IGEga2V5\n",
            "RWQ-not-base64!\n",
        ] {
            assert_eq!(
                pubkey_from_file(bad),
                Err(UpdateError::Unconfigured),
                "{bad:?}"
            );
        }
        let key = test_key();
        assert_eq!(pubkey_from_file(&key.pub_file), Ok(key.pubkey));
    }

    #[test]
    fn a_good_signature_is_accepted_and_a_bad_one_is_not() {
        let key = test_key();
        let package = b"installer bytes".to_vec();
        let signature = sign(&package);
        assert_eq!(verify_package(&package, &signature, &key.pubkey), Ok(()));
        assert_eq!(
            accept_download(Ok(package.clone()), &signature, &key.pubkey),
            Ok(package.clone())
        );
        // Tampered package, signature of other bytes, garbage, and another key.
        let mut tampered = package.clone();
        tampered[0] ^= 1;
        assert_eq!(
            accept_download(Ok(tampered), &signature, &key.pubkey),
            Err(UpdateError::BadSignature)
        );
        assert_eq!(
            verify_package(&package, &sign(b"other"), &key.pubkey),
            Err(UpdateError::BadSignature)
        );
        assert_eq!(
            verify_package(&package, "bm90IGEgc2lnbmF0dXJl", &key.pubkey),
            Err(UpdateError::BadSignature)
        );
        let other = test_key();
        assert_eq!(
            verify_package(&package, &signature, &other.pubkey),
            Err(UpdateError::BadSignature)
        );
    }

    #[test]
    fn a_plugin_signature_error_is_a_bad_signature_and_maps_to_damaged_file() {
        let key = test_key();
        let failure = minisign_verify::PublicKey::decode(&base64_text(&key.pubkey).unwrap())
            .unwrap()
            .verify(
                b"x",
                &minisign_verify::Signature::decode(&base64_text(&sign(b"y")).unwrap()).unwrap(),
                true,
            )
            .unwrap_err();
        let error = UpdateError::from(tauri_plugin_updater::Error::Minisign(failure));
        assert_eq!(error, UpdateError::BadSignature);
        assert_eq!(AppError::from(error).code(), ErrorCode::DamagedFile);
        assert_eq!(
            AppError::from(UpdateError::from(
                tauri_plugin_updater::Error::ReleaseNotFound
            ))
            .code(),
            ErrorCode::Internal
        );
        assert_eq!(
            accept_download(
                Err(tauri_plugin_updater::Error::EmptyEndpoints),
                "",
                &key.pubkey
            ),
            Err(UpdateError::Failed(
                "Updater does not have any endpoints set.".into()
            ))
        );
    }

    #[test]
    fn a_bad_signature_discards_the_state_and_other_failures_keep_it() {
        // The state without a plugin Update: discard clears the install mark and package flags.
        let state = UpdateState::default();
        assert!(!state.mark_install_on_quit());
        state.discard();
        assert!(!state.has_package());
        assert!(state.found().is_none());
    }

    #[test]
    fn only_a_strictly_newer_version_is_offered() {
        assert!(is_newer("1.9.0", "2.0.0-rc.1"));
        assert!(is_newer("1.9.0", "1.9.1"));
        assert!(is_newer("2.0.0-rc.1", "2.0.0-rc.2"));
        assert!(!is_newer("2.0.0-rc.1", "2.0.0-rc.1"));
        assert!(is_newer("1.9.9", "1.10.0"));
        assert!(is_newer("2.0.0-rc.1", "2.0.0"));
        assert!(!is_newer("1.9.0", "1.9.0"));
        assert!(!is_newer("1.9.0", "1.8.9"));
        assert!(!is_newer("2.0.0", "2.0.0-rc.1"));
        assert!(!is_newer("1.9.0", "1.9.0+build5"));
        assert!(!is_newer("1.9.0", "garbage"));
        assert!(!is_newer("1.9.0", "1.9"));
        assert!(!is_newer("1.9.0", "1.9.0.1"));
    }

    #[test]
    fn the_endpoint_is_one_https_url_without_variables() {
        let url: tauri::Url = ENDPOINT.parse().unwrap();
        assert_eq!(url.scheme(), "https");
        assert_eq!(url.host_str(), Some("github.com"));
        assert!(url
            .path()
            .ends_with("/releases/latest/download/latest.json"));
        assert!(!ENDPOINT.contains('{') && url.query().is_none());
        let config = plugin_config("k");
        assert_eq!(config["endpoints"], json!([ENDPOINT]));
    }

    #[test]
    fn notes_lose_control_and_bidi_characters_and_are_capped() {
        assert_eq!(
            sanitize_notes("a\u{202e}b\u{0}c\r\nd\u{7}\u{2066}e\te"),
            "abc\ndee"
        );
        let long = "ä".repeat(limits::UPDATE_NOTES_MAX);
        let cut = sanitize_notes(&long);
        assert!(cut.len() <= limits::UPDATE_NOTES_MAX && cut.chars().all(|c| c == 'ä'));
        assert!(cut.len() >= limits::UPDATE_NOTES_MAX - 1);
    }

    #[test]
    fn the_wire_shapes_match_architecture() {
        let info = UpdateInfo {
            version: "1.0.1".into(),
            date: None,
            notes: "n".into(),
        };
        assert_eq!(
            serde_json::to_value(info).unwrap(),
            json!({ "version": "1.0.1", "date": null, "notes": "n" })
        );
        assert_eq!(
            serde_json::to_value(UpdateEvent::Progress {
                downloaded: 5,
                total: None
            })
            .unwrap(),
            json!({ "kind": "progress", "downloaded": 5, "total": null })
        );
        assert_eq!(
            serde_json::to_value(UpdateEvent::Verified).unwrap(),
            json!({ "kind": "verified" })
        );
        assert_eq!(
            serde_json::to_value(UpdateEvent::Failed {
                code: ErrorCode::DamagedFile
            })
            .unwrap(),
            json!({ "kind": "failed", "code": "damaged_file" })
        );
    }

    #[test]
    fn skipping_a_version_validates_and_persists() {
        let dir = std::env::temp_dir().join(format!("sheer-skip-test-{}", rand_suffix()));
        std::fs::create_dir_all(&dir).unwrap();
        let store = SettingsStore::load(dir.join("settings.json"));
        assert_eq!(
            skip_version(&store, "not a version").unwrap_err().code(),
            ErrorCode::InvalidArgument
        );
        skip_version(&store, "1.2.3").unwrap();
        assert_eq!(store.get().skipped_version.as_deref(), Some("1.2.3"));
        assert_eq!(store.get().updates, UpdatesMode::Off);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
