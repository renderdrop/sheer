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
- [x] Thumbnails panel (lazy)
- [x] Outline (bookmarks) panel
- [x] Full-text search with hit highlight and next/previous
- [x] Text selection and copy (char-box text layer)
- [x] View rotation, go to page, status bar page x/y + zoom
- [x] Password-protected PDFs (session-only password)
- [x] Recent files (local, removable, missing-file handling); record the open-from-recents clone (MOTION §4.6) as F3 evidence
- [x] Multiple documents in tabs; macOS menu enabled-state sync (grey items without a document, Close Window on ⌘W)
- [x] Onboarding scaffold (FEEDBACK F4): bundled "Welcome to Sheer.pdf" opened on first launch, coach-mark component, step engine, steps Open / Navigate / Zoom, progress in the status bar, skippable, restart in Settings, never automatic twice
- [x] Hostile input: fuzz corpus ≥ 30 malformed PDFs + never-crash test, safe links (confirm, http/https/mailto), XFA warning; intake: registry key from the handle, reject NTFS ADS names and `\?NC`/REMOTE UNC (OR DEADLINE), PIN WINDOWS DEVICE-PATH REFUSAL IN A TEST, SKIP STRAY NON-FLAG ARGV VALUES, DOCUMENT TOKIO `NET` FROM SINGLE-INSTANCE IN THE NETWORK GUARD
- [x] Politur M1
  - intake: Windows `same_file` compares size/mtime/ctime only; use the handle's file ID (e.g. `same-file` crate, MIT/Unlicense) and key the registry on it (security medium)
  - engine: respawn the PDFium worker after `engine_unavailable` until M7's engine process (tiny `/XStep`, self-calling Form XObject wedge it; security medium); add both as `#[ignore]`d corpus cases for M7
  - intake: refuse mapped network drives before the first open (drive type), or document the wait
  - links dialog: truncate the displayed URL, show the host prominently, decode punycode for display alongside `xn--`
  - fuzz_corpus.rs: lower the 60 s per-file timeout; document that a dotless file after a bare `--flag` is skipped
  - XFA banner: keep the dismissal in a store so a remount does not show it again
  - recents: Undo toast after remove, "Locate…" for a missing file
  - unlock: serialise unlocks per document (in-flight flag) so parallel calls cannot skip the 1 s wait; bound simultaneous unlock sleeps (security medium)
  - recents: on Windows refuse `\\`/`//` paths in `storable()` and skip `try_exists` for network paths (NTLM leak from a tampered recents.json)
  - unlock: record the residual risk of the IPC-deserialised `String` password (not zeroized) in DECISIONS, or a Zeroizing deserialiser
  - viewer: expose each page's `/Rotate` to the UI (`PageSlotInfo.rotation`) and wire `fileRotation.ts`; overlays assume 0 today
  - search: gate F3/Shift+F3 to Windows (DESIGN 3.16) and let F3 work from the page field; bound the text cache `failed` set and listeners
  - milestone end: record the open-from-recents clone (MOTION §4.6) as F3 evidence with scripts/ui/

## M2 — Comment and markup (v0.5.0)

- [x] Annotation domain model + undo/redo command stack
- [x] Text markup: highlight, underline, strikethrough
- [x] Sticky notes and free text
- [x] Freehand ink (smoothing, pressure)
- [x] Shapes: rectangle, ellipse, line, arrow
- [x] Palette, stroke presets, properties inspector; one-shot/locked tool modes
- [x] Save annotations: appearance streams via lopdf, incremental + atomic save, backup of original; save refuses an in-place write to the welcome document (`DocKind::Welcome`, Save acts as Save As) with a security_baseline pin
- [x] Interop test: saved annotations re-open correctly (PDFium + AP present for every type)
- [x] Comments panel (DESIGN §3.26, ADR-034): threads via /IRT, filter (type, author), sort (page, date), jump, empty state
- [x] Author name (ADR-034): default empty; one-time inline toolbar field at the first annotation save (OS name as suggestion, stored after confirm); empty → no /T; strip invisible/bidi characters on save
- [x] Politur M2
  - (from M1 review) recents clone: fix the zoom before the FLIP measures the target rect (one frame of "–" and a moving target); counter-scale the clone radius or fade it earlier; make the empty-state fade-out visible
  - (from M1 security) `style-src 'unsafe-inline'`: move to hashed/nonce styles or record the reason in DECISIONS; confirm the release build never uses devCsp; prune 3 unused license allowances in deny.toml
  - (from M1 reviews) Clear in recents: one failure still shows Undo for every id; missing row opens Locate twice over (row + button) — keep one; text cache listeners: bound; links are untested with file /Rotate (no link overlay yet)
  - (from P4 security, medium) import.rs `quads_of`: cap iterations (`.take(MAX_ANNOT_QUADS * 4)`); aggregate byte budget for imported strings per page and per document; undo history bounded by bytes, not only 500 entries
  - (from P4 security, low) `with()` must not re-create a DocState for a closed document; strip Cf (bidi/format) characters from imported author/contents; per-page counters + reply index instead of O(n) scans; clear the model on a poisoned lock
  - (from P4 review) annotations store: cache per page so one change does not re-render every page; prune `removed`; wire `mark_clean` from save
  - (from M2 security, medium) save: re-take the fingerprint right before `replace_atomic` and answer needs_confirmation if it changed; treat a missing fingerprint as changed (fail closed)
  - (from M2 security, medium) AuthorName: covered by the "Author name" item (ADR-034)
  - (from M2 security, low) import.rs: skip PDFium stroke/fill colour calls when an /AP has zero objects (crashes the worker on a crafted file); backup dir 0700 on unix; Save As over a different file: record the dialog's overwrite prompt in ADR-033; single-flight guard per document for timed-out save builds
  - (from M2 reviews) save: test on a /Rotate page and read /CA back; log a failed rollback; signal a skipped backup; drop or settle `ack.rewrite_encrypted`; record loss of undo across save (ADR-033) in the user docs
  - (from M2 reviews) quit with unsaved documents; "Saving…/Saved" status hints; file-changed-on-disk dialog instead of the banner; macOS menu Save/Save As; overlay refresh on pageRev after move/modify (stale bitmap)
  - (from M2 reviews) layer: key selection by page; Esc cancels a pending keyboard nudge; announce when Alt+arrow resize is unavailable; F6 skips annotation tab stops; note popover: reply ownership by a stable author id, line-height token, `done` reset in FreeTextEditor; restore the eslint-disable comments in stores/annotations.ts

## M3 — Organize pages (v0.6.0)

- [x] Page grid (organize mode) with pointer-event reorder + keyboard move
- [x] Rotate and delete pages (undoable)
- [x] Insert blank page / pages from file
- [x] Extract pages to new file
- [x] Merge files (multi-drop suggests merge)
- [x] Split (every N pages, ranges)
- [x] Compress: three named presets with estimated size
- [x] Politur M3
  - (from M3 fix review) render cache revision as a tuple (annotation rev, slot rev) instead of a sum; drop the duplicated updateViewport effect; a save-level test that forces a write failure / reopen mismatch and checks the restore
  - (from M3 security, medium) jobs: reject Windows reserved device names (CON, NUL, AUX, COM1… before any dot, case-insensitive) in split/extract file stems → prefix "_"; lopdf `load_mem` on hostile inputs: cap total decoded bytes (pre-scan object streams / implausible /Length or /N)
  - (from M3 security/review, low) jobs: decide cleanup from the replace result instead of exists() (TOCTOU); `admit_folder` helper instead of the dummy split.pdf; merge sources as Arc<[u8]> with a total in-memory cap; drop `_ids` in target_is_open; widgets on imported pages dropped silently → warning
  - (from M3 review) pages: engine/model drift when the model refuses an insert after the engine appended pages; InsertBlankPage double lock; count_pages Arc::try_unwrap; organize grid: drag card + marquee in rAF/ref (no per-move grid render), boolean `dragging` dep, cache --scale-lift; tests for size slider, exit to focused page, reduced motion, announcements; read-only aria-disabled for Pages; dropBatch module state (single drops delayed 120 ms)
  - (known M3 limits) annotations of imported pages editable only after save; unsaved annotations on blank/imported pages not carried into extract/split/merge outputs
  - (from M2 design review, major) Undo/Redo buttons in the toolbar (§3.27); "Bearbeitet"/"Edited" badge in the status bar (§3.10/§3.27); comments row excerpt shows free-text contents, not the kind label (§3.26)
  - (from M2 design review, minor) note anchor glyph (§3.25); highlight blended (multiply) instead of painted over text; 1 px ring on colour dots in both themes; comment root rows aligned with the group header (§3.15); tools/zoom visibly disabled without a document (§3.22); no vertical scrollbar on the empty state when content fits
  - (from M2 reviews) author prompt: feedback when a confirmed name is invalid; own placeholder; focus return on close; end-to-end test that an empty author saves without /T
  - (from M2 reviews) comments panel: test Delete/Backspace (opaque guard, focus move); confirm-free delete stays undoable; cancel overlapping list calls; keep summary identity stable across refreshes
  - (from M2 reviews) `Models.closed` bounded; explain not_found after a poisoned lock in the UI; reset `closeRequests` after a quit walk; undoing a change to an annotation that was Hidden in the file must keep it hidden
  - (from M2 security, low) `bundle.targets` "all" → only the shipped macOS/Windows targets; a test that the closeRequested handler is enforced in Rust; devCsp never in release (pinned) — keep
  - (deferred) F6 skips annotation tab stops (no F6 handler yet); link overlay with file /Rotate test; user docs: undo history ends at save (ADR-033)

## M4 — Forms and signature (v0.7.0)

- [x] AcroForm fill (text, checkbox, radio, choice) with keyboard navigation
- [x] Save filled forms + flatten
- [x] Signature creation: draw, type, image
- [x] Place, move, scale signatures; initials and date
- [x] Fill & Sign for flat forms (text, check, cross, dot)
- [x] Signature library encrypted at rest, key in OS keychain (keyring ADR)
- [x] Politur M4
  - (from M4 frontend reviews) DrawPad: rAF/ref-driven path instead of setDrawing(buffer.slice()) per pointermove; forms: rotation 90/180/270 tests for FormLayer/FormHost, control radii/insets as classes, `1px` border literal → token, record the localStorage highlight toggle in DECISIONS; PlacementLayer: Enter effect deps, centre from the scroll surface's visible rect; OrganizeBar icon size token; guard the `useSignMenuEntries` hook-in-data with a comment/test; sign-menu rows with thumbnails
  - (from M4 backend reviews) flatten: NoRotate annots kept upright (or note in ADR-041); explicit tests for /AS states, /Perms removal, object pruning and a hostile /Resources merge (many colliding /SheerFl names, huge /XObject dict); forms: radio-group + comb/MaxLen AP tests, negative MaxLen clamp; library: keychain read error vs corrupt key distinguished, 60 s keychain deadline, raster list preview, Art::check without re-serializing, tamper → quarantine test; macOS keychain untested (B-001)
  - (from M3 final security, medium — do first) prescan: resolve /Length only for /ObjStm and /XRef streams, charge nothing for others (false refusals of real files with lengths like 120.0 or in object streams); a repeated object id with differing values → refuse or keep the maximum (incremental updates can hide a bomb behind the last definition)
  - (from M3 final security, low) duplicate/non-name keys in any top-level dict refuse the file (stricter than lopdf)
  - (from M3 design review, major) organize grid default thumbnail size 160 (`--grid-thumb`), not 96 (or reset a persisted value); organize bar: Insert with label "Einfügen" + menu affordance like Extract/Split
  - (from M3 design review, minor) grid left gutter = padding 24; size field and Done button same sm height/baseline; empty state still shows a vertical scrollbar; page pills low contrast in dark mode (§4)
  - (from M3 security, low) style-src unsafe-inline (re-evaluate nonces/hashes)
  - (from M3 polish review) organize read-only: per-cell aria-disabled and no marquee when read-only; comments delete focus fallback clamp (`Math.min(fallback, index)`); toolbar collapse-order and slotRev constants named; imported annotations over MAX_ANNOTATIONS_PER_DOC leave pages unread (soft cap); single-file drop delay (backend drop count)
  - (deferred) F6 skips annotation tab stops (no F6 handler yet); link overlay with file /Rotate test; user docs: undo history ends at save (ADR-033)

## M5 — Edit and protect (v0.8.0)

- [x] Add text boxes and images
- [x] Crop pages
- [x] True redaction (flatten affected pages, strip text/annots/metadata) + not-extractable test
- [x] Password protection and permissions (AES-256), remove password
- [x] Metadata view/edit/remove
- [ ] Politur M5
  - (flaky) Comments.test.tsx "shows the contents as the excerpt, and a muted No text…" failed once under the full suite (passes alone 3/3): make it deterministic
  - (from M4 design review, major) empty state must fit an 800 px window (content 832 px in a 702 px scroller): smaller logo (≈96–112 px), tighter gaps, or at most 3 recents when the window is short
  - (from M4 design review, minor) light-theme "Formular" status pill without background; Flatten label "Formular fixieren…" vs §3.32 `form.flatten` "Formular reduzieren…" (fix string or ADR + DESIGN); same width rule for the Tool-options toggle and button; page gutter at 100 % (page flush to canvas edges, horizontal bar) and near-black top band in dark; check the field focus ring
  - (from M4 polish review) OrganizeBar icon size literal → token; comments delete-focus test must prove focus by key; Enter-to-place test for more than one rect layout; ~~`import_warnings` IPC + UI~~ (done); discard drawn/image drafts too (done ad9081a); macOS keychain untested (B-001)
  - (UI half done in ad9081a) page gutter at 100 % and the near-black top band in dark: check at the window review (jsdom cannot)
  - (from M5 backend reviews, minor) DONE: image.rs single to_rgba8, Zeroizing in closure, fewer password copies in save.rs, SASLprep fallback for session passwords, CI-fail tests, close drops secrets test, limits.rs docs
  - (from M5 UI reviews, minor — carried to Politur M6 if not done at M5 close) insert: Align control (§3.36), multi-select, inspector Delete button, Delete announces + Undo toast; crop: unit from OS measurement system (Rust), stale aria-invalid after drag, dead shade transition, i18n range placeholder, focusable handles; redact: thumbnail pulse, duplicate progress label, title after warnings, extra exit button, text-selection marking test; protect: owner-password label + show/hide on remove, keep passwords on non-password stage errors, Hide label, strength/toggle tests, rewrite-cancel test
  - (from M4 security, low) style-src 'unsafe-inline' (nonces/classes); devCsp never in release (pinned)

## M6 — Convert and output (v0.9.0)

- [ ] PDF → PNG/JPG (page ranges, DPI)
- [ ] Images → PDF
- [ ] Print via native dialog
- [ ] Export with/without annotations, optional metadata removal

## M7 — Polish and ship (v1.0.0)

- [ ] Performance budget: 500-page PDF opens < 1 s, 60 fps scrolling (benchmark); thumbnail list fast scroll (one 34 ms frame at 120 px/frame, F3); scroll-height compression beyond the browser element limit (≈ 8k pages at 400 %), memory-aware cache budget
- [ ] Accessibility pass (WCAG 2.2 AA analog, screen reader labels, focus order)
- [ ] Recents rows with a 32 × 40 first-page thumbnail (DESIGN §3.11), cached locally at close, no paths to the UI (M1 review minor, deferred)
- [ ] i18n de/en complete
- [ ] Per-tool tips (onboarding = welcome-document tour, FEEDBACK F4)
- [ ] Onboarding steps (F4, moved here by ADR-030): "Highlight" + "Comment", "Reorder pages", "Drag a signature" pages of the welcome document with coach marks + success moment; flip `shipped` in steps.json and regenerate both PDFs
- [ ] fps measurement in the Tauri window (`node scripts/ui/cdp.mjs fps`, moved here by ADR-030): 60 fps idle, scroll, zoom, panel slide
- [ ] PDF engine in its own process (crash isolation, ADR)
- [ ] Crash-safe autosave
- [ ] Windows installer (FEEDBACK F5): NSIS target (no MSI/WiX default dialog) with own header and sidebar images in Iris and the Sheer icon
- [ ] Installers: DMG, NSIS (WebView2 bootstrapper); Windows .pdf association via OpenWithProgids, default handler only on opt-in
- [ ] Signed opt-in updater (minisign public key in repo; private key → BLOCKERS)
- [ ] Full security-reviewer audit, docs/SECURITY.md finalized
- [ ] Signing/notarization guide in docs/BLOCKERS.md

## Later (post-1.0, not scheduled)

See `docs/FEATURES.md` → "Later".

## v1.1 backlog (ADR-030)

- [~] v1.1-Backlog — Should/Could items moved out of M2–M7 (Tempo level 2); not part of v1.0, not picked by the loop
  - Stamps (Approved, Draft, …) (Should, was M4)
  - Edit existing text objects (single line/paragraph, same font) (Should, was M5)
  - Replace image (Should, was M5)
  - Header/footer, page numbers, watermark (Should, was M5)
  - Reveal in Finder/Explorer (Should, was M6)
  - OCR via OS APIs (Vision / Windows.Media.Ocr), invisible text layer (Should, was M6)
  - Read mode / full screen (Could, was M7)
  - Import/export comments (XFDF) (Could); self-signed digital signature (Could)
