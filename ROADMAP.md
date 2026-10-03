# ROADMAP

Legend: `[ ]` open · `[x]` done · `[~]` blocked (see `docs/BLOCKERS.md`).
The Stop hook picks the first open `- [ ]` line, so order matters. Scope: `docs/FEATURES.md`, ADR-010/011.

## Phase 0 — Bootstrap (v0.0.1)

- [x] Orchestration scaffold: agents, hooks, docs skeleton, license, trademark, logo

## Phase 1 — Research (v0.1.0)

- [x] Research: docs/research/acrobat-features.md
- [x] Research: docs/research/online-tools.md
- [x] Research: docs/research/ux-patterns.md
- [x] Research: docs/research/libraries-licensing.md
- [x] Synthesis: docs/FEATURES.md + milestones M1–M7 in ROADMAP.md

## Phase 2 — Architecture + Spike (v0.2.0)

- [x] Architecture: ADR-001..004 + docs/ARCHITECTURE.md
- [x] Spike: Tauri 2 + bundled PDFium, open_document + render_page, React page view with zoom
- [x] Security baseline: strict CSP, minimal capabilities, fetch-pdfium.sh with SHA256, docs/SECURITY.md threat model
- [x] First security-reviewer run (PASS, 7 low findings: 6 fixed, 1 moved to M1)
- [x] Tooling: scripts/check.sh, scripts/bump-version.sh, CI (macOS + Windows), Dependabot

## Phase 3 — Design system + app shell (v0.3.0)

- [x] Design spec: component specs in docs/DESIGN.md (designer), applying ADR-011
- [x] Tokens: src/styles/tokens.css (light/dark, glass + solid fallback, --surface-strong), Tailwind 4 theme, APP_NAME token
- [x] Reduced transparency/motion: CSS media queries + macOS OS flag from Rust, "Glass: Auto/Solid" setting
- [x] Primitives I: Button, IconButton, Toolbar (roving tabindex), Tooltip (name + shortcut), Popover
- [x] Primitives II: Tabs, Slider, Splitter (keyboard-resizable), Panel
- [x] App shell layout grid: toolbar, left panel, canvas, inspector slot, status bar, scroll-edge scrim
- [x] Empty state: drop zone, Open button, recents list placeholder
- [x] Command registry + shortcuts (platform modifiers) + native menu bar
- [x] i18n scaffold (en, de); all shell strings translated
- [x] Hardening: atomic write (create_new, 0600/0700, stale temp), settings is_file check + lock scope + patch key cap, live OS transparency flag (a channel, no event permission), render if load() hangs, forced-colors doc tokens, SECURITY.md T3 + settings row, ARCHITECTURE §3 call.ts
- [x] Settings popover (theme, glass, language) + About dialog (version, licenses entry); wire settings/about actions; EmptyState + toolbar clicks via runAction; keyCode 229 IME guard; numpad canonicalKey; next/prev page accelerators without Option+arrows (collides with reorder)
- [x] Follow-ups: rAF-throttle useFloatingPosition scroll listener, Menu submenus (DESIGN 3.5), stale *.tmp sweep at startup (D1), showcase spacing, stale libc comment in settings.rs tests, Banner pb-1 jump, DESIGN §2.4 computeShellLayout bullet, auto-collapsed panel toggle no-op, cancelled render leaves "Rendering…", panel collapse animation + middle-cut file name, independent Cf oracle in display_name test, log malformed menu catalog, glob src/menu/*.rs in baseline scan

## M1 — Viewer (v0.4.0)

- [x] Document registry with IDs; open via dialog, native drag and drop, file association; open-by-handle (no check/open TOCTOU), no orphaned engine docs after timed-out open
- [x] Render pipeline: serialized PDFium worker, render cache (page, zoom, DPR), page virtualization
- [x] Zoom and fit (width/page/100 %), Ctrl/Cmd+scroll, pinch; scroll modes (continuous/single/two-page); zoom controls disabled without a document
- [ ] Thumbnails panel (lazy)
- [ ] Outline (bookmarks) panel
- [ ] Full-text search with hit highlight and next/previous
- [ ] Text selection and copy (char-box text layer)
- [ ] View rotation, go to page, status bar page x/y + zoom
- [ ] Password-protected PDFs (session-only password)
- [ ] Recent files (local, removable, missing-file handling)
- [ ] Multiple documents in tabs; macOS menu enabled-state sync (grey items without a document, Close Window on ⌘W)
- [ ] Onboarding scaffold (FEEDBACK F4): bundled "Welcome to Sheer.pdf" opened on first launch, coach-mark component, step engine, steps Open / Navigate / Zoom, progress in the status bar, skippable, restart in Settings, never automatic twice
- [ ] Hostile input: fuzz corpus ≥ 30 malformed PDFs + never-crash test, safe links (confirm, http/https/mailto), XFA warning; intake: registry key from the handle, reject NTFS ADS names and `\?NC`/REMOTE UNC (OR DEADLINE), PIN WINDOWS DEVICE-PATH REFUSAL IN A TEST, SKIP STRAY NON-FLAG ARGV VALUES, DOCUMENT TOKIO `NET` FROM SINGLE-INSTANCE IN THE NETWORK GUARD

## M2 — Comment and markup (v0.5.0)

- [ ] Annotation domain model + undo/redo command stack
- [ ] Text markup: highlight, underline, strikethrough
- [ ] Sticky notes and free text
- [ ] Freehand ink (smoothing, pressure)
- [ ] Shapes: rectangle, ellipse, line, arrow
- [ ] Palette, stroke presets, properties inspector; one-shot/locked tool modes
- [ ] Comments panel: threads (/IRT), filter, sort, jump
- [ ] Save annotations: appearance streams via lopdf, incremental + atomic save, backup of original
- [ ] Interop test: saved annotations re-open correctly (PDFium + AP present for every type)
- [ ] Onboarding steps (F4): "Highlight" and "Comment" pages of the welcome document with coach marks + success moment

## M3 — Organize pages (v0.6.0)

- [ ] Page grid (organize mode) with pointer-event reorder + keyboard move
- [ ] Rotate and delete pages (undoable)
- [ ] Insert blank page / pages from file
- [ ] Extract pages to new file
- [ ] Merge files (multi-drop suggests merge)
- [ ] Split (every N pages, ranges)
- [ ] Compress: three named presets with estimated size
- [ ] Onboarding step (F4): "Reorder pages" page of the welcome document with coach mark + success moment

## M4 — Forms and signature (v0.7.0)

- [ ] AcroForm fill (text, checkbox, radio, choice) with keyboard navigation
- [ ] Save filled forms + flatten
- [ ] Signature creation: draw, type, image
- [ ] Place, move, scale signatures; initials and date
- [ ] Fill & Sign for flat forms (text, check, cross, dot)
- [ ] Stamps (Approved, Draft, …)
- [ ] Signature library encrypted at rest, key in OS keychain (keyring ADR)
- [ ] Onboarding step (F4): "Drag a signature" page of the welcome document with coach mark + success moment

## M5 — Edit and protect (v0.8.0)

- [ ] Add text boxes and images
- [ ] Edit existing text objects (single line/paragraph, same font)
- [ ] Replace image
- [ ] Crop pages
- [ ] True redaction (flatten affected pages, strip text/annots/metadata) + not-extractable test
- [ ] Password protection and permissions (AES-256), remove password
- [ ] Metadata view/edit/remove
- [ ] Header/footer, page numbers, watermark

## M6 — Convert and output (v0.9.0)

- [ ] PDF → PNG/JPG (page ranges, DPI)
- [ ] Images → PDF
- [ ] Print via native dialog
- [ ] Export with/without annotations, optional metadata removal
- [ ] Reveal in Finder/Explorer
- [ ] OCR via OS APIs (Vision / Windows.Media.Ocr), invisible text layer

## M7 — Polish and ship (v1.0.0)

- [ ] Performance budget: 500-page PDF opens < 1 s, 60 fps scrolling (benchmark); scroll-height compression beyond the browser element limit (≈ 8k pages at 400 %), memory-aware cache budget
- [ ] Accessibility pass (WCAG 2.2 AA analog, screen reader labels, focus order)
- [ ] i18n de/en complete
- [ ] Per-tool tips; read mode (onboarding = welcome-document tour, FEEDBACK F4)
- [ ] PDF engine in its own process (crash isolation, ADR)
- [ ] Crash-safe autosave
- [ ] Windows installer (FEEDBACK F5): NSIS target (no MSI/WiX default dialog) with own header and sidebar images in Iris and the Sheer icon
- [ ] Installers: DMG, NSIS (WebView2 bootstrapper); Windows .pdf association via OpenWithProgids, default handler only on opt-in
- [ ] Signed opt-in updater (minisign public key in repo; private key → BLOCKERS)
- [ ] Full security-reviewer audit, docs/SECURITY.md finalized
- [ ] Signing/notarization guide in docs/BLOCKERS.md

## Later (post-1.0, not scheduled)

See `docs/FEATURES.md` → "Later".
