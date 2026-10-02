# Security — threat model and checklist

Living document. Every measure has a status (`done` / `open`) and a reference to the test or file that proves it.
The `security-reviewer` audits against this checklist before every milestone tag.

## Threat model

**Attacker:** delivers a malicious PDF (mail, download, USB stick).
**Goals:** code execution via the parser; reading or overwriting local files via IPC or links; exfiltrating document
content; tampering with updates or dependencies.
**Assets:** the user's documents and saved signatures; integrity of the computer.
**Out of scope by design:** there are no accounts and no servers, hence no auth or transport surface. This stays so.

## 1. Tauri hardening

| # | Measure | Status | Evidence |
|---|---|---|---|
| T1 | Strict CSP: `default-src 'self'; img-src 'self' asset: data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'none'`; no scripts from anywhere else | open | `src-tauri/tauri.conf.json` |
| T2 | No CDN, web fonts or remote URLs in the bundle | open | grep in CI |
| T3 | Capabilities least privilege: only core, dialog, fs (scoped), opener (https/mailto), window | open | `src-tauri/capabilities/` |
| T4 | Not enabled: shell, http, websocket, process (except relaunch for updater), global-shortcut | open | `src-tauri/Cargo.toml`, capabilities |
| T5 | `withGlobalTauri: false`, no `dangerousRemoteDomainIpcAccess`, no DevTools in release, `devUrl` dev-only | open | `tauri.conf.json` |
| T6 | Updater opt-in, minisign-signed, embedded public key, HTTPS only; private key never in repo/CI | open | M7 |
| T7 | Windows: WebView2 requirement in installer; macOS: hardened runtime + notarization (human blocker) | open | M7 |

## 2. IPC and commands

| # | Measure | Status | Evidence |
|---|---|---|---|
| I1 | Every command takes serde-typed input and validates bounds (page index, zoom, pixel size, string length) | open | Rust unit tests |
| I2 | Frontend never sees file paths; works with document IDs only. No `read_file(path)` command | open | `docs/ARCHITECTURE.md` |
| I3 | Paths only from dialogs or drag-and-drop in the backend; canonicalized and scope-checked | open | Rust tests |
| I4 | UI errors without system paths, stack traces or internal IDs; full errors only to local opt-in debug log | open | error type tests |

## 3. PDF as hostile input

| # | Measure | Status | Evidence |
|---|---|---|---|
| P1 | PDFium build without V8 (no JavaScript) and without XFA | open | `scripts/fetch-pdfium.sh` |
| P2 | Launch, GoToR and URI actions are never executed automatically | open | tests |
| P3 | Links: click + confirmation dialog with visible URL; only http(s)/mailto; file:, javascript:, custom schemes dropped | open | URL filter tests |
| P4 | Embedded files never auto-opened/executed; save only via dialog, without exec permissions | open | M5/M6 |
| P5 | Engine calls wrapped in `catch_unwind` with timeouts; resource limits (render area, memory per document, recursion) | open | Rust tests |
| P6 | Engine in its own process from M7 (crash isolation) | open | M7 ADR |
| P7 | All PDF strings untrusted: rendered as text only, never innerHTML, never in shell commands, sanitized as file names | open | lint + guard hook |
| P8 | Fuzz corpus `tests/fixtures/malformed/` (≥ 30 files); app never crashes, only shows an error | open | M1 |
| P9 | Fonts from PDFs rasterized by PDFium only; never installed into the OS or passed to the WebView | open | architecture |

## 4. Data at rest

| # | Measure | Status | Evidence |
|---|---|---|---|
| D1 | Atomic save (temp file in target dir + rename); backup of original on first write; restrictive temp permissions; cleanup on exit | open | Rust tests |
| D2 | Saved signatures/stamps encrypted in app data dir; key in OS keychain (`keyring`, ADR) | open | M4 |
| D3 | PDF passwords never stored; session memory only | open | code review |
| D4 | Redaction removes content from streams, images, text layer, annotations and metadata; test: redacted text not extractable after save | open | M5 |
| D5 | Export offers "remove metadata"; autosave files contain nothing but the document | open | M6 |
| D6 | Logs local, without document content, default level warn; no external crash reports | open | logging module |

## 5. Supply chain

| # | Measure | Status | Evidence |
|---|---|---|---|
| S1 | Lockfiles committed, versions pinned, `rust-toolchain.toml` + `.nvmrc` | open | repo root |
| S2 | `cargo deny check`, `cargo audit`, `npm audit --audit-level=high` in `npm run check` and CI; Dependabot weekly | open | `scripts/check.sh`, CI |
| S3 | PDFium binary: fixed release tag + SHA256 verification; never downloaded at runtime | open | `scripts/fetch-pdfium.sh` |
| S4 | Every new dependency: name, SPDX license, "why not write it ourselves"; no convenience deps | open | `docs/LICENSES.md` |
| S5 | No dependencies with networked `postinstall` except known build tools (Tauri CLI, esbuild) | open | review |
| S6 | Network crates only inside the updater module; `npm run check` fails otherwise | open | check script |

## 6. Code hygiene

| # | Measure | Status | Evidence |
|---|---|---|---|
| C1 | No `unsafe` without comment + reviewer approval; clippy -D warnings; no `unwrap()`/`expect()` in prod paths | open | clippy config |
| C2 | No eval, new Function, dynamic script loading, innerHTML (guard hook blocks) | done | `.claude/hooks/guard-secrets.sh` |
| C3 | No secrets, tokens or private keys in the repo, not even for tests | done | `.claude/hooks/guard-secrets.sh` |
| C4 | `security-reviewer` before every milestone tag and on config/capability/IPC/file/link/parsing changes | open | `STATE.md` log |
