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
| T1 | Strict CSP: `default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src ipc: http://ipc.localhost; object-src 'none'; base-uri 'none'; frame-src 'none'; form-action 'none'`; no scripts from anywhere else. Differs from §13.1 in `connect-src` (Tauri IPC needs `ipc:`) and `img-src` (no `asset:`, asset protocol is off): ADR-005. The CSP exists in the base file only: no `tauri.<platform>.conf.json` (found by glob, so a new platform file is covered at once) may set `app.security`, because Tauri merges it over the base on that platform | done | `src-tauri/tauri.conf.json`; `security_baseline.rs::production_csp_is_strict`, `csp_never_allows_remote_hosts_or_eval`, `platform_patches_never_touch_app_security`, `platform_config_discovery_finds_the_platform_files` |
| T2 | No CDN, web fonts or remote URLs in the bundle | open | grep in CI |
| T3 | Capabilities least privilege: one file, window `main`, the eight app commands (`open_document_dialog`, `render_page`, `close_document`, `app_ready`, `get_settings`, `update_settings`, `watch_transparency`, `subscribe_menu`) and exactly seven window permissions for the custom title bar (DESIGN 2.2, ADR-014), each granted by its own name, never `core:default` or `core:window:default`: `core:window:allow-minimize`, `-toggle-maximize` and `-close` (the three caption buttons on Windows), `-is-maximized` and `-is-fullscreen` (read-only state for the maximize or restore icon and the macOS traffic-light inset), `-start-dragging` and `-internal-toggle-maximize` (what Tauri's `data-tauri-drag-region` script calls for dragging the toolbar row and caption, and for a double click that maximizes). Nothing else from `core:` or any plugin: in particular no `core:event:*`: the webview can neither `listen` (it would hear `tauri://drag-drop`, whose payload is the dropped file paths) nor `emit` (it would speak as the backend), so the window's resize and focus events are not used either (the shell reads the DOM's `resize` event and asks `is_maximized` again). The window API is imported in one module, `src/api/window.ts`, whose five wrappers match the five non-drag permissions one to one; none takes a label, a path or a URL. Backend-to-UI pushes are a `tauri::ipc::Channel` the webview passes as an argument of a command (`watch_transparency(on_change: Channel<bool>)`, `subscribe_menu(on_action: Channel<String>, system_language)` for the macOS menu bar, later `search`); a channel needs no permission and carries typed data only. The menu channel carries nothing but the ids of the backend's allowlist (`menu::spec::ACTION_IDS`), and the UI runs only ids it has an action for (ADR-016). Stricter than the baseline core/dialog/fs/opener/window; the dialog plugin is called from Rust | done | `src-tauri/capabilities/default.json`; `security_baseline.rs::capabilities_grant_only_the_app_commands_and_the_window_chrome_to_the_main_window`, `the_webview_has_no_event_permissions`, `menu_commands_reach_the_webview_only_through_the_channel`, `menu::tests::an_id_that_is_not_on_the_allowlist_never_reaches_the_ui`, `build_script_declares_exactly_the_granted_commands`, `window_chrome_follows_the_design_per_platform`; `src/api/window.test.ts` (the capability lists exactly these seven, the wrappers call exactly five window methods); `src/api/app.test.ts` (no import of the event API) |
| T4 | Not enabled: shell, http, websocket, process (except relaunch for updater), global-shortcut | done | `src-tauri/Cargo.toml`; `security_baseline.rs::dangerous_plugins_and_tauri_features_stay_off` |
| T5 | `withGlobalTauri: false`, no `dangerous*` options (e.g. remote-domain IPC access), asset protocol off, `dragDropEnabled` set explicitly (T9), no DevTools in release (`devtools` cargo feature absent; Tauri enables the inspector only in debug builds), `devUrl` dev-only | done | `tauri.conf.json`; `security_baseline.rs::webview_flags_are_locked_down`, `dev_url_is_only_a_dev_setting`, `dangerous_plugins_and_tauri_features_stay_off` |
| T6 | Updater opt-in, minisign-signed, embedded public key, HTTPS only; private key never in repo/CI | open | M7 |
| T7 | Windows: WebView2 requirement in installer; macOS: hardened runtime + notarization (human blocker) | open | M7 |
| T8 | The webview can only show the app origin: top-level navigation to other URLs is refused (`on_navigation`), external links go through `open_link` (P3) | open | M1 |
| T9 | `dragDropEnabled` is `true` in the window config, set explicitly and not left to the default. With it Tauri takes the OS drop itself, so a dropped file cannot navigate the webview to `file://` (with `false` the webview's own drop handling would), and the dropped paths go only to Rust's `WindowEvent::DragDrop` handler (M1 intake, I3). Tauri also emits the drop as the `tauri://drag-drop` event with the paths in its payload; the webview cannot receive it, because T3 grants no `listen`. Paths never reach JS: Rust re-emits only `drop:hover {active, count}` through a channel, without paths | done | `tauri.conf.json`; `security_baseline.rs::webview_flags_are_locked_down`, `the_webview_has_no_event_permissions` |

## 2. IPC and commands

| # | Measure | Status | Evidence |
|---|---|---|---|
| I1 | Every command is `async`, takes serde-typed input and validates bounds (page id, scale, pixel size, file size) against consts in `limits.rs`. Each new command needs its own bounds test (ARCHITECTURE §5) | done | `src-tauri/src/limits.rs` tests; `commands::tests::render_*`; `engine::tests::refuses_frames_over_the_render_limits_before_allocating` |
| I2 | Frontend never sees file paths; works with document and page IDs only. No command takes a path or URL. The one thing the UI learns about a file is its display name: the last path component, at most 255 characters, without the characters that can reorder or hide text (Unicode categories Cc and Cf except U+200C and U+200D, which scripts and emoji need, plus U+2028, U+2029 and U+FFFC) | done | `security_baseline.rs::no_command_takes_a_path_or_url`; `commands/mod.rs`; `documents::tests` and `tests/display_name.rs` (a sweep over every scalar value) |
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
| D1 | Atomic save (temp file in target dir + rename); backup of original on first write; restrictive temp permissions; cleanup on exit. The atomic write with restrictive permissions exists in `storage::atomic` (see D7); backup and cleanup on exit are still to do | open | Rust tests |
| D2 | Saved signatures/stamps encrypted in app data dir; key in OS keychain (`keyring`, ADR) | open | M4 |
| D3 | PDF passwords never stored; session memory only | open | code review |
| D4 | Redaction removes content from streams, images, text layer, annotations and metadata; test: redacted text not extractable after save | open | M5 |
| D5 | Export offers "remove metadata"; autosave files contain nothing but the document | open | M6 |
| D6 | Logs local, without document content, default level warn; no external crash reports. Today: error codes go to stderr, details only at opt-in debug (I4); the logging module is still to come | open | logging module |
| D7 | Settings file (`settings.json` in the app data dir) is user-writable, so it is untrusted input. Read only if it is a regular file (a directory, FIFO or device counts as damaged), judged on the opened handle and not on the path (no check-then-open gap), opened `O_NONBLOCK` on Unix so a FIFO cannot hang the start, of at most 64 KiB (`limits::MAX_SETTINGS_FILE_BYTES`); every field that is missing, oversized or invalid falls back to its default, so a damaged file never blocks start or reaches the UI. Written only by `storage::atomic::write_atomic`: temp file `.<name>.<pid>.<n>.tmp` (process id plus a per-process counter, so writers never share one and no fixed name can be planted in advance) created with `create_new` (a taken name is skipped, never written through or followed as a symlink), fsync, rename, fsync of the directory; mode `0600` and directories `0700` on Unix. The webview's patch is validated whole before anything is written (object, `deny_unknown_fields`, the enum values of `glass`, `theme` and `language` (lowercase wire names only: `system`, `en`, `de`; no language tags), `leftPanelWidth` an integer from 192 to 400 and never clamped), a stored width outside that range falls back to the default of 248, and `get_settings` never waits for the disk | done | `storage::settings::tests` (`damaged_files_give_the_defaults`, `an_oversized_file_is_not_read`, `a_directory_at_the_settings_path_gives_the_defaults`, `a_patch_can_name_at_most_the_four_settings`, `a_panel_width_patch_accepts_exactly_the_design_range`, `a_stored_panel_width_is_read_only_inside_the_range`, `get_does_not_wait_for_a_write_in_progress`), `storage::atomic::tests` (`a_taken_temp_name_is_skipped_and_what_is_there_stays_untouched`, `a_temp_name_that_is_a_second_name_for_another_file_is_never_written_through`, unix: file and directory modes, symlinks), `storage::settings::tests` (`the_type_is_taken_from_the_opened_handle_not_from_the_path`, `a_fifo_at_the_settings_path_does_not_block_the_load`), `tests/settings_storage.rs` |

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
| C2 | No eval, new Function, dynamic script loading, innerHTML (guard hook blocks) | done | ESLint rules in `tools/lint/config.js` (`no-eval`, `no-implied-eval`, `no-new-func`, restricted `innerHTML`/`dangerouslySetInnerHTML`/`document.write`) in `npm run check`; `.claude/hooks/guard-secrets.sh` |
| C3 | No secrets, tokens or private keys in the repo, not even for tests | done | secret scan over tracked files in `scripts/check.sh` (`guard_secrets`); `.claude/hooks/guard-secrets.sh` |
| C4 | `security-reviewer` before every milestone tag and on config/capability/IPC/file/link/parsing changes | open | `STATE.md` log |
| C5 | UI texts (i18n) are data, never code or markup: the catalogs `src/i18n/locales/{en,de}.json` are bundled into the app at build time (pure JSON, no run-time loading, no network, no user-supplied catalogs); keys and placeholder names are looked up with `Object.hasOwn`, so `constructor` or `__proto__` find nothing on the prototype and the key itself is shown; interpolation inserts text only (a function replacer, so `$&` and `{name}` in a value stay literal; only strings and numbers count, `null` and `undefined` leave the placeholder) and the result goes to React text and attributes, never to `innerHTML` (C2); a backend error's `what` reaches the catalog only through `isPlainKey` (`errorText`), so the backend cannot pick any other key; the `language` setting is one of three fixed wire names (D7) | done | `src/i18n/i18n.test.ts` (catalog shape, `inserts a value as it is, whatever characters it holds`, `shows the key when no catalog has it, and never throws`, `isPlainKey says no to what is not a message of its own`, interpolation with missing and `null` parameters), `src/api/errors.test.ts` (`errorText`), `src-tauri/tests/i18n_catalogs.rs` (flat JSON, no duplicate keys, same keys in en and de) |
