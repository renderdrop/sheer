# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security

- File names shown in the UI lose every Unicode control (Cc) and format (Cf) character except the two joiners, plus U+2028, U+2029 and U+FFFC (ADR-015). The CSP test covers every `tauri.<platform>.conf.json` and fails when one sets `app.security`.
- The window has no event permission any more (`core:event:allow-listen`/`allow-unlisten` dropped): the macOS "Reduce transparency" flag reaches the UI
  through a `Channel` passed to the new `watch_transparency` command (ADR-013). `dragDropEnabled` is set explicitly.
- Settings file: opened first and judged on the handle (`O_NONBLOCK` on Unix); atomic writes use a per-process unique temp name.

## [0.2.0] - 2026-10-02

### Added

- Architecture: ADR-001 (stack), ADR-002 (PDFium worker, render cache), ADR-003 (annotation model, undo/redo),
  ADR-004 (file strategy), ADR-005 (CSP for Tauri IPC); `docs/ARCHITECTURE.md` with module map and IPC commands.
- Tauri 2 + React 19 app that opens a PDF through a native dialog and renders pages via bundled PDFium (plain build,
  pinned `chromium/7881`, SHA256-verified by `scripts/fetch-pdfium.sh`), with zoom and Ctrl+wheel.
- Security baseline: strict CSP, three-command capability, async commands, UI-safe errors, central limits,
  panic and timeout guard around PDFium jobs, binary render frames.
- Tooling: `npm run check` (15 steps incl. clippy, cargo-deny, cargo-audit, npm audit, import/network/secret guards),
  `scripts/bump-version.sh`, CI for macOS + Windows, Dependabot.

### Security

- First security review: PASS. Low findings fixed (orphaned document on failed open, raw startup error output,
  unpinned CI tools, debug artifact naming, missing secret scan, unverified cached PDFium library).

## [0.1.0] - 2026-10-02

### Added

- Research on Acrobat features, online PDF tools, desktop UX patterns, PDF libraries and licenses (`docs/research/`).
- Feature catalog with MoSCoW, complexity and milestone mapping (`docs/FEATURES.md`).
- Roadmap with Phase 3 and milestones M1–M7.
- ADR-010 (v1.0 product scope) and ADR-011 (design adjustments).

## [0.0.1] - 2026-10-02

### Added

- Orchestration scaffold: Claude Code subagents, hooks, state and roadmap files.
- Project documents: README, LICENSE (AGPL-3.0-or-later), TRADEMARK, SECURITY policy.
- Docs skeleton: features, architecture, design, security, decisions, licenses, blockers.
- Brand logo (`assets/brand/logo.svg`).
- Pinned toolchains (`.nvmrc`, `rust-toolchain.toml`) and `cargo-deny` policy (`deny.toml`).
