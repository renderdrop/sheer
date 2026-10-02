# Security — threat model and checklist

Living document. Every measure has a status (`done` / `open`) and a reference to the test or file that proves it.
The `security-reviewer` audits against this checklist before every milestone tag.

Status as of the Phase 2 security baseline (ADR-005). `done` means the measure holds for the code that exists today; a new
command, plugin or capability must add its own test, and measures that only apply to later milestones stay `open`.
Config and capability rows are pinned by `src-tauri/tests/security_baseline.rs`.

## Threat model

**Attacker:** delivers a malicious PDF (mail, download, USB stick).
**Goals:** code execution via the parser; reading or overwriting local files via IPC or links; exfiltrating document
content; tampering with updates or dependencies.
**Assets:** the user's documents and saved signatures; integrity of the computer.
**Out of scope by design:** there are no accounts and no servers, hence no auth or transport surface. This stays so.

## 1. Tauri hardening

| # | Measure | Status | Evidence |
|---|---|---|---|
| T1 | Strict CSP: `default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src ipc: http://ipc.localhost; object-src 'none'; base-uri 'none'; frame-src 'none'; form-action 'none'`; no scripts from anywhere else. Differs from §13.1 in `connect-src` (Tauri IPC needs `ipc:`) and `img-src` (no `asset:`, asset protocol is off): ADR-005 | done | `src-tauri/tauri.conf.json`; `security_baseline.rs::production_csp_is_strict`, `csp_never_allows_remote_hosts_or_eval` |
| T2 | No CDN, web fonts or remote URLs in the bundle | open | grep in CI |
| T3 | Capabilities least privilege: one file, window `main`, the three app commands only. No plugin permission at all (stricter than the baseline core/dialog/fs/opener/window; the dialog plugin is called from Rust) | done | `src-tauri/capabilities/default.json`; `security_baseline.rs::capabilities_grant_only_the_app_commands_to_the_main_window`, `build_script_declares_exactly_the_granted_commands` |
| T4 | Not enabled: shell, http, websocket, process (except relaunch for updater), global-shortcut | done | `src-tauri/Cargo.toml`; `security_baseline.rs::dangerous_plugins_and_tauri_features_stay_off` |
| T5 | `withGlobalTauri: false`, no `dangerous*` options (e.g. remote-domain IPC access), asset protocol off, no DevTools in release (`devtools` cargo feature absent; Tauri enables the inspector only in debug builds), `devUrl` dev-only | done | `tauri.conf.json`; `security_baseline.rs::webview_flags_are_locked_down`, `dev_url_is_only_a_dev_setting`, `dangerous_plugins_and_tauri_features_stay_off` |
| T6 | Updater opt-in, minisign-signed, embedded public key, HTTPS only; private key never in repo/CI | open | M7 |
| T7 | Windows: WebView2 requirement in installer; macOS: hardened runtime + notarization (human blocker) | open | M7 |
| T8 | The webview can only show the app origin: top-level navigation to other URLs is refused (`on_navigation`), external links go through `open_link` (P3) | open | M1 |

## 2. IPC and commands

| # | Measure | Status | Evidence |
|---|---|---|---|
| I1 | Every command is `async`, takes serde-typed input and validates bounds (page id, scale, pixel size, file size) against consts in `limits.rs`. Each new command needs its own bounds test (ARCHITECTURE §5) | done | `src-tauri/src/limits.rs` tests; `commands::tests::render_*`; `engine::tests::refuses_frames_over_the_render_limits_before_allocating` |
| I2 | Frontend never sees file paths; works with document and page IDs only. No command takes a path or URL | done | `security_baseline.rs::no_command_takes_a_path_or_url`; `commands/mod.rs` |
| I3 | Paths only from dialogs or drag-and-drop in the backend; canonicalized and scope-checked. Today: the dialog path is canonicalized, must be a regular file of at most 2 GiB. Open: drag-and-drop, argv and recents intake, `%PDF-` sniff (M1) | open | `commands::tests::only_regular_files_are_opened`, `limits::tests::file_size_is_capped` |
| I4 | UI errors without system paths, stack traces or internal IDs: `AppError` is not serializable, only `UiError { code, key, retryable, params? }` crosses IPC; full errors only to the local log, with detail at opt-in debug level (`SHEER_LOG=debug`) | done | `error::tests::ui_errors_never_leak_paths_or_debug_text`, `serializes_code_key_and_params`, `detail_logging_is_opt_in_for_release_builds`; `commands::tests::blocking_*`; `src/api/errors.test.ts` |

## 3. PDF as hostile input

| # | Measure | Status | Evidence |
|---|---|---|---|
| P1 | PDFium build without V8 (no JavaScript) and without XFA | done | `scripts/fetch-pdfium.sh` refuses archives whose `args.gn` lacks `pdf_enable_v8 = false` and `pdf_enable_xfa = false` |
| P2 | Launch, GoToR and URI actions are never executed automatically | open | M1 (no link or action code exists yet) |
| P3 | Links: click + confirmation dialog with visible URL; only http(s)/mailto; file:, javascript:, custom schemes dropped | open | URL filter tests, M1 |
| P4 | Embedded files never auto-opened/executed; save only via dialog, without exec permissions | open | M5/M6 |
| P5 | Engine calls wrapped in `catch_unwind`, with per-job deadlines (open 20 s, render 10 s, close 5 s), a stuck job fails later jobs fast instead of queueing, a panic drops only the affected document, worker survives; render frames capped at 4096 px per side and 4096² pixels, checked on the real page size before allocation; files ≤ 2 GiB | done | `engine::guard::tests`; `engine::tests::a_panicking_job_becomes_an_error_and_the_worker_survives`, `a_crash_quarantines_only_the_affected_document`, `a_stuck_job_times_out_then_the_engine_fails_fast_and_recovers`, `a_full_queue_is_refused_without_blocking`, `jobs_whose_caller_gave_up_are_not_started`; `limits::tests::pixel_size_*`; ADR-005 |
| P6 | Engine in its own process from M7 (crash isolation); a segfault or true hang in PDFium is not catchable in-process | open | M7 ADR |
| P7 | All PDF strings untrusted: rendered as text only, never innerHTML, never in shell commands, sanitized as file names | open | lint + guard hook |
| P8 | Fuzz corpus `tests/fixtures/malformed/` (≥ 30 files); app never crashes, only shows an error | open | M1 |
| P9 | Fonts from PDFs rasterized by PDFium only; never installed into the OS or passed to the WebView | open | architecture |
| P10 | Memory budget per document and limits for object recursion and stream decompression inside PDFium (today only the file-size cap and the render caps exist) | open | M1 fuzz corpus (P8) |

## 4. Data at rest

| # | Measure | Status | Evidence |
|---|---|---|---|
| D1 | Atomic save (temp file in target dir + rename); backup of original on first write; restrictive temp permissions; cleanup on exit | open | Rust tests |
| D2 | Saved signatures/stamps encrypted in app data dir; key in OS keychain (`keyring`, ADR) | open | M4 |
| D3 | PDF passwords never stored; session memory only | open | code review |
| D4 | Redaction removes content from streams, images, text layer, annotations and metadata; test: redacted text not extractable after save | open | M5 |
| D5 | Export offers "remove metadata"; autosave files contain nothing but the document | open | M6 |
| D6 | Logs local, without document content, default level warn; no external crash reports. Today: error codes go to stderr, details only at opt-in debug (I4); the logging module is still to come | open | logging module |

## 5. Supply chain

| # | Measure | Status | Evidence |
|---|---|---|---|
| S1 | Lockfiles committed, versions pinned, `rust-toolchain.toml` + `.nvmrc` | done | `src-tauri/Cargo.lock`, `package-lock.json`, `rust-toolchain.toml`, `.nvmrc` |
| S2 | `cargo deny check`, `cargo audit`, `npm audit --audit-level=high` in `npm run check` and CI; Dependabot weekly | open | `scripts/check.sh`, CI |
| S3 | PDFium binary: fixed release tag + SHA256 verification; never downloaded at runtime (the app binds the bundled library by absolute path) | done | `scripts/fetch-pdfium.sh`; `engine::library_path` |
| S4 | Every new dependency: name, SPDX license, "why not write it ourselves"; no convenience deps | open | `docs/LICENSES.md` |
| S5 | No dependencies with networked `postinstall` except known build tools (Tauri CLI, esbuild) | open | review |
| S6 | Network crates only inside the updater module; `npm run check` fails otherwise | open | check script |

## 6. Code hygiene

| # | Measure | Status | Evidence |
|---|---|---|---|
| C1 | No `unsafe` without comment + reviewer approval (`unsafe_code = "deny"`); clippy -D warnings; no `unwrap()`/`expect()` in prod paths | done | `src-tauri/Cargo.toml` `[lints]`; `security_baseline.rs::lints_forbid_unsafe_and_unwrap_in_production_code`; `cargo clippy --all-targets -- -D warnings` |
| C2 | No eval, new Function, dynamic script loading, innerHTML (guard hook blocks) | done | `.claude/hooks/guard-secrets.sh` |
| C3 | No secrets, tokens or private keys in the repo, not even for tests | done | `.claude/hooks/guard-secrets.sh` |
| C4 | `security-reviewer` before every milestone tag and on config/capability/IPC/file/link/parsing changes | open | `STATE.md` log |
