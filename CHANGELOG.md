# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] - 2026-10-02

### Added

- Design system (`docs/DESIGN.md`, ADR-011/012): Iris tokens for light and dark, glass recipes with a solid mode
  (no `backdrop-filter`, reduced transparency, forced colors, "Glass: Solid"), reduced motion, fixed elevation layers.
- Glass UI primitives: Button, IconButton, Toolbar (clusters, overflow, roving focus, lockable tools), Tooltip, Popover,
  Menu, Tabs, Slider, Splitter, Panel, Field, segmented control.
- App shell: floating toolbar, collapsible left panel with persisted width, opaque canvas with scroll-edge scrim,
  reserved inspector slot, status bar, per-OS window chrome (ADR-014), render isolation (ADR-015).
- Empty state with Open button, drop-zone visual and recents placeholder.
- In-house typed i18n with English and German catalogs shared with Rust; language setting; localized shortcut labels.
- Settings popover (theme, glass, language) and About dialog; global shortcuts are off while a dialog is open.
- One command registry (`src/actions`, ADR-016): the toolbar, the More menu, the keyboard and the macOS menu bar all derive from it. Shortcuts follow the platform
  (Cmd on macOS, Ctrl elsewhere): Open, Close (new), zoom, Actual size, Fit width and Fit page (new), previous and next page (⌘/Ctrl+↓/↑), the panel toggles, Settings, About and
  the tool letters, which work only while the canvas has focus. The key handler never takes a key from a text field.
- The macOS menu bar (App, File, Edit, View, Window, Help), labelled from the UI catalogs in English and German and rebuilt when the language changes. Menu clicks reach the UI
  through a `Channel` passed to the new `subscribe_menu` command, with an allowlist of ids in Rust. Windows has no menu bar (ADR-016).

- Menus have submenus (DESIGN 3.5): an item with `submenu` opens a solid second level with Right, Enter, Space, a click or after the pointer rested on it for 200 ms; Left and Esc close it, and they nest.
- Collapsing or restoring the left panel animates over 250 ms (the columns slide and the panel fades, opacity only under reduced motion) without rendering the shell.
- A leftover `.<name>.<pid>.<n>.tmp` file older than an hour is removed from the app data directory at startup (SECURITY D1).

### Changed

- Popovers and tooltips follow scrolling and resizing once per animation frame, not once per event.
- Ctrl+0 is Fit page and Ctrl+1 is Actual size (it was 100 %). Ctrl on macOS and Cmd on Windows no longer trigger shortcuts.

### Fixed

- The error banner no longer jumps by 8 px when it opens; a render that is cancelled no longer leaves "Rendering…" in the status bar.

### Security

- File names shown in the UI lose every Unicode control (Cc) and format (Cf) character except the two joiners, plus U+2028, U+2029 and U+FFFC (ADR-015). The CSP test covers every `tauri.<platform>.conf.json` and fails when one sets `app.security`.
- The window has no event permission any more (`core:event:allow-listen`/`allow-unlisten` dropped): the macOS "Reduce transparency" flag reaches the UI
  through a `Channel` passed to the new `watch_transparency` command (ADR-013). `dragDropEnabled` is set explicitly.
- Settings file: opened first and judged on the handle (`O_NONBLOCK` on Unix); atomic writes use a per-process unique temp name.
- `unsafe_code = "forbid"`; the lint rule now rejects every HTML sink (`innerHTML`, `outerHTML`, `insertAdjacentHTML`,
  `setHTMLUnsafe`, `createContextualFragment`, `DOMParser`, `document.write`). Phase 3 security audit: PASS.

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
