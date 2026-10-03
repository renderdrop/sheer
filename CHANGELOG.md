# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.6.0] - 2026-10-03

M3 — Organize pages.

### Added

- Organize mode: a page grid with a size slider, multi-select, drag-and-drop and keyboard reordering, rotate, delete (never the last page; undo brings pages and their annotations back), insert blank pages or pages from another file — all undoable; the viewer, thumbnails, outline and search follow the new order.
- Save rewrites the page tree incrementally; "clean copy" writes a full new file; changing pages of a signed file asks first.
- Extract pages to a new file; split every N pages or by ranges with a naming pattern into a chosen folder (never overwrites); merge several PDFs (dropping several files offers "Merge into one" or "Open as tabs"); compress with three presets (96/150/220 dpi) and a size estimate. All with progress and cancel; annotations travel along.
- Undo/Redo buttons in the toolbar, an "Edited" badge in the status bar; annotations on inserted pages are editable at once.

### Security

- Every PDF parsed for writing goes through one guarded loader with a decode-budget pre-scan (defence in depth until the separate engine process in M7); imported pages and annotations keep only safe web links (no automatic or JavaScript actions); Windows device names are never used as file names; outputs are claimed with create-new.
- New dependencies: image 0.25 (JPEG only) and flate2 (MIT/Apache).
## [0.5.0] - 2026-10-03

M2 — Comment and markup.

### Added

- Annotation model with a per-document undo/redo command stack (Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z, Ctrl+Y on Windows; macOS Edit menu); existing annotations are imported from the file, unknown types stay read-only.
- Tools: highlight, underline, strikethrough (from text), sticky notes with replies, free text (Helvetica), freehand ink (smoothing, pressure), rectangle, ellipse, line and arrow; one-shot or locked tool mode.
- Annotations on the canvas: select, move, resize, nudge with the keyboard, delete; edited originals disappear from the page image at once and come back on undo.
- Properties inspector with the eight Okabe-Ito colours, stroke presets, opacity, font size and line ends.
- Comments panel: threads with replies, filter by type and author, sort by page or date, jump to the annotation.
- Save and Save As (Ctrl/Cmd+S, Ctrl/Cmd+Shift+S): appearance streams for every type, incremental and atomic write, a backup of the original on the first save, the welcome document saves only as a copy; unsaved-changes dot, quit with unsaved documents, file-changed-on-disk confirmation.
- Author name: empty by default; asked once at the first save of a document with annotations (the system name only as a suggestion); empty writes no author; invisible and bidirectional characters are removed.
- Release workflow: unsigned NSIS and DMG installers attached to a GitHub Release on every tag.

### Security

- Bounded annotation import (counts, quads, string bytes per page and document) and an undo history bounded by bytes; the save checks the file again right before replacing it and refuses when it cannot tell; backups are private (0700); one save build per document at a time.
- New dependency: lopdf 0.45.0 (MIT).
## [0.4.0] - 2026-10-03

M1 — Viewer. CI green on Windows and macOS (run 37120538629).

### Security

- Windows file identity from the opened handle (`same-file`); the PDFium worker respawns after a wedge (at most 3 times per process);
  unlocks are serialised per document; recents drop UNC, device and NTFS-stream spellings before any file-system access, and Locate goes
  through the normal intake.

### Added

- Search panel: live search after two characters, hits grouped by page with context, highlights on the canvas, next/previous (Enter, Shift+Enter, Ctrl/Cmd+G, F3).
- Text selection on a lazy per-page text layer; copy with Ctrl/Cmd+C, select all on a page.
- View rotation (Ctrl/Cmd+R / L, view-only, per document) and Go to page (Ctrl/Cmd+Shift+N) from the status bar.
- Password-protected PDFs: an unlock prompt; the password stays in memory for the session only, with a growing wait after wrong attempts.
- Recent files on the empty state: open, remove, missing files marked; ids only cross to the UI, never paths.
- Document tabs (Ctrl+Tab / Ctrl+Shift+Tab, Ctrl/Cmd+W); the macOS menu greys document commands without a document.
- Hostile-input corpus of 61 generated malformed PDFs with a never-crash test; XFA warning banner; intake refuses UNC, device-path and NTFS stream spellings.

- A scrolling, virtualized canvas (ADR-018): every page has a placeholder of its real size, and only the pages within a viewport height of the viewport are mounted (at most 24).
  The render queue has priorities (visible, near, thumbnails), cancels the renders of pages that scrolled away (`set_viewport`) and draws one frame once however many pages ask for it;
  a render cache of up to 256 MiB keeps the images, and a page shows the best one it has while the sharp one is on its way.
- Zoom buckets (a quarter octave, display pixel ratio included) and 1024 px tiles for pages that are too large for one frame, which replace the retry at a smaller scale.
- Zoom around the pointer (Ctrl/Cmd+wheel, trackpad pinch in WebView2 and WKWebView) and around the middle of the viewport (buttons, keys); the point you look at stays where it is.
  Fit width and Fit page stay fitted as the window is resized.
- Scroll modes: Continuous scrolling, Single page and Two pages (More menu, macOS View menu); the status bar shows the page the scroll position is on.
- `get_page_sizes` and `set_viewport` commands; the error code `cancelled` (the UI stays silent about it); a document of more than 50 000 pages is refused.
- A 500-page synthetic PDF test that logs how long opening it and its first visible page take.
- The read APIs of the backend (ADR-019), with typed and validated wrappers in `src/api`: `get_outline` (at most 10 000 nodes, 32 levels, a cycle in the file ends where it comes back),
  `get_text_layer` (the text of a page and a box for every character, in page space), `search` and `cancel_search` (page by page at the lowest priority, so renders go first; hits as
  one rectangle per line, progress, done; Unicode case, hyphenated words and phrases across a line break are found, which PDFium's own search does not do), `get_page_links` and
  `open_link`. A document tells whether it is encrypted, has an XFA or an AcroForm, or is signed (`flags` of `DocumentInfo`).
- Thumbnails panel in the left panel: virtualized for any page count, rendered lazily at thumbnail priority from the shared render cache, the current
  page highlighted and kept in view, one Tab stop with arrow keys, Home and End, click or Enter to jump.
- Outline panel (DESIGN 3.15): the document's bookmarks as a tree in the left panel (WAI-ARIA tree keys, type-ahead, one Tab stop, virtualized
  for 10 000 entries), the section you are reading marked, a click or Enter jumps to the exact spot; entries without a target in this document are
  shown muted.
- Welcome tour (ADR-023, FEEDBACK F4): on the first launch without a file, a bundled "Welcome to Sheer" document (English or German, 4 pages
  in the Iris design, drawn in code) opens once; coach marks point at the control for each task (open, go to page 2, zoom in), a short success
  moment follows each one, progress shows in the status bar, the tour can be skipped and restarted from Settings. More steps (highlight,
  comment, signature, page order) come with their tools in M2–M4.
- Test PDFs generated in code (`src-tauri/tests/support`), with the committed ones under `tests/fixtures/` checked against their generator: outlines (also a cycle), links of every kind,
  text with non-ASCII letters, a hyphenated line end and an emoji, a form, an XFA form, a signed and an encrypted document.

### Changed

- Mood (ADR-020, FEEDBACK F2): a clearly visible Iris background gradient with three soft light fields, so the glass of the toolbar and
  panels shows what is behind it; Iris-tinted glass with a light top edge; soft Iris shadows; a large, gently floating logo on the empty
  state (still under reduced motion, paused while the window is hidden); thin Iris scrollbars; a tinted canvas with an edge in both themes and
  a visible page edge in dark. The inspector column is no longer reserved while nothing is selected: it slides open like the left panel.
- Motion (ADR-022, docs/MOTION.md, FEEDBACK F3): one spring and three durations (120/200/320 ms) for every animation, exits shorter and
  fading; buttons, tabs and menu items answer press and hover; the left panel and the inspector slide in and out while the page in the middle
  stays put; pages fade in instead of popping, a sharp render fades over its stand-in; zoom glides with inertia and snaps to fit width, fit page
  and 100 %, and a document opens at fit width (at most 100 %); a dropped file shows a preview card that falls into the window; opening
  flies from the card or thumbnail to the page; short jumps scroll smoothly; a quiet Iris pulse instead of a dialog marks a success.
  Reduced motion turns all of it into fades. Measured in the Tauri window at 60 fps.

### Security

- Links in a PDF are read as data and nothing they ask for is done: a jump in the document is a page, a URL that is plain `http`, `https` or `mailto` (at most 2048 bytes, only RFC 3986
  characters, no credentials before the host, no attachment in a mail link) is shown in a native dialog from Rust and opened only if the user agrees, and every other action (launch, a jump to
  another file, JavaScript, any other scheme) is blocked. `open_link` takes no URL from the webview. `tauri-plugin-opener` (Apache-2.0 OR MIT) is a dependency for its `open_url` function
  only: it is not registered and no capability names it.
- Outline titles, text and URLs from a file are bounded and filtered before they reach the UI, and the frontend parsers refuse an answer that is not within the bounds.
- A flood of `render_page` calls cannot park the blocking pool: a tile column or row of 64 or more is refused at the command, at most 8 callers join one frame that is being
  drawn (the frame is shared, not copied for each), at most 96 calls per document and 128 in all are in flight, and a viewport hint with more than 64 pages in a list is refused
  while it is read. `get_page_sizes` is answered from the sizes read once when the document was loaded.
- A document whose close the engine could not take is no longer lost: it is hidden from the UI, kept marked as closing, and released by the next open or close; a close that
  timed out still runs.
- A web link needs a real host (DNS labels or a bracketed IPv6 address, a port of at most 65535, no percent-encoding in the host).
- The capability file lists each permission once, and a test keeps it so.

### Fixed

- Page views are memoized for real: the canvas hands them numbers instead of a layout object that is new on every render. Neighbours rendered ahead in a paged mode wait for the
  zoom to settle like a page does. The render cache forgets what it kept about a closed document (page versions, and all but the last 256 closed ids). A rectangle that starts at
  or after a tiled page's edge no longer asks for a tile.

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
