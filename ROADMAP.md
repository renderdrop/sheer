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
- [x] Politur M5
  - (flaky) Comments.test.tsx "shows the contents as the excerpt, and a muted No text…" failed once under the full suite (passes alone 3/3): make it deterministic
  - (from M4 design review, major) empty state must fit an 800 px window (content 832 px in a 702 px scroller): smaller logo (≈96–112 px), tighter gaps, or at most 3 recents when the window is short
  - (from M4 design review, minor) light-theme "Formular" status pill without background; Flatten label "Formular fixieren…" vs §3.32 `form.flatten` "Formular reduzieren…" (fix string or ADR + DESIGN); same width rule for the Tool-options toggle and button; page gutter at 100 % (page flush to canvas edges, horizontal bar) and near-black top band in dark; check the field focus ring
  - (from M4 polish review) OrganizeBar icon size literal → token; comments delete-focus test must prove focus by key; Enter-to-place test for more than one rect layout; ~~`import_warnings` IPC + UI~~ (done); discard drawn/image drafts too (done ad9081a); macOS keychain untested (B-001)
  - (UI half done in ad9081a) page gutter at 100 % and the near-black top band in dark: check at the window review (jsdom cannot)
  - (from M5 backend reviews, minor) DONE: image.rs single to_rgba8, Zeroizing in closure, fewer password copies in save.rs, SASLprep fallback for session passwords, CI-fail tests, close drops secrets test, limits.rs docs
  - (from M5 UI reviews, minor) DONE except the crop unit from the OS measurement system (v1.1): insert: Align control (§3.36), multi-select, inspector Delete button, Delete announces + Undo toast; crop: unit from OS measurement system (Rust), stale aria-invalid after drag, dead shade transition, i18n range placeholder, focusable handles; redact: thumbnail pulse, duplicate progress label, title after warnings, extra exit button, text-selection marking test; protect: owner-password label + show/hide on remove, keep passwords on non-password stage errors, Hide label, strength/toggle tests, rewrite-cancel test
  - (open, carried to M7 hardening) (from M4 security, low) style-src 'unsafe-inline' (nonces/classes); devCsp never in release (pinned)

## M6 — Convert and output (v0.9.0)

- [x] PDF → PNG/JPG (page ranges, DPI)
- [x] Images → PDF
- [x] Print via native dialog
- [x] Export with/without annotations, optional metadata removal
- [x] Politur M6
  - [x] (from M5 design review, major; 7ccfe48) page gutter at 100 %: the horizontal scrollbar sits right under the page
  - [x] (from M5 design review, minor; 7ccfe48, DESIGN fixed with ADR-050) DESIGN §1.11/§3.11 still say logo 160 in a 184 slot (tokens: 104/128 on short windows); empty state top-heavy at 800 px (equal top/bottom padding); dark canvas around the page near-black vs window background (§1.10); thumbnail panel bottom padding
  - (v1.1) crop units from the OS measurement system
  - [x] (from M6 backend reviews; all DONE) print: global byte cap across sets (or MAX_PRINT_SETS 2), sort+dedup range pages, take order and snapshot together (SnapshotGuard), confirm per-page pixel cap at 300 dpi, test open_dialog's main-window check; images out: no-follow open on replace, preflight all names before replace, longer timeout for export renders, encode on the blocking pool; snapshot: tests for burned content, crops, redaction rasters, no marks, encrypted original, size cap, guard on engine open error, loud skip when PDFium is missing in CI, avoid the extra bytes copy; images in: cap live batches, drop handles beyond the cap while sniffing, log skip reasons, re-check target_is_open at publish
  - [x] (from F10 security review, low) DrawCmd payload count guard in the deserializer
  - [x] (flaky) commands::tests::after_the_third_wrong_password_each_try_waits_in_rust failed once under the full suite: time each of the first three tries, not their sum
  - [x] (from M6 UI) print: pending-redaction note (output.pendingRedact); export images: quality control aria-disabled for PNG; menu items cannot show output.notAllowed (v1.1)

## M7 — Polish and ship (v1.0.0)

- [x] CSP hardening (from M4 security, low): style-src unsafe-inline replaced by nonces/classes
- [x] Performance budget: 500-page PDF opens < 1 s, 60 fps scrolling (benchmark); thumbnail list fast scroll (one 34 ms frame at 120 px/frame, F3); scroll-height compression beyond the browser element limit (≈ 8k pages at 400 %), memory-aware cache budget
- [x] Accessibility pass (WCAG 2.2 AA analog, screen reader labels, focus order)
- [x] Recents rows with a 32 × 40 first-page thumbnail (DESIGN §3.11), cached locally at close, no paths to the UI (M1 review minor, deferred)
- [x] i18n de/en complete
- [x] Per-tool tips (onboarding = welcome-document tour, FEEDBACK F4)
- [x] Onboarding steps (F4, moved here by ADR-030): "Highlight" + "Comment", "Reorder pages", "Drag a signature" pages of the welcome document with coach marks + success moment; flip `shipped` in steps.json and regenerate both PDFs
- [x] fps measurement in the Tauri window (`node scripts/ui/cdp.mjs fps`, moved here by ADR-030): 60 fps idle, scroll, zoom, panel slide
- [x] PDF engine in its own process (crash isolation, ADR)
- [x] Crash-safe autosave
- [x] Windows installer (FEEDBACK F5): NSIS target (no MSI/WiX default dialog) with own header and sidebar images in Iris and the Sheer icon
- [x] Installers: DMG, NSIS (WebView2 bootstrapper); Windows .pdf association via OpenWithProgids, default handler only on opt-in
- [x] Signed opt-in updater (minisign public key in repo; private key → BLOCKERS)
- [x] Full security-reviewer audit, docs/SECURITY.md finalized
- [x] Signing/notarization guide in docs/BLOCKERS.md
- [x] Politur M7
  - (from M6 design review, minor) recent rows: page thumbnail (32×40) instead of the generic icon tile, or update §3.11; dark-mode text looks heavier than light (same weight? ClearType?); horizontal overlay scrollbar over the page edge: bottom inset or track tint; disabled toolbar icons on the light empty state very low contrast
  - (from M6 UI) menu items cannot show output.notAllowed (v1.1 unless cheap); export images estimate is client-side
  - (from M7 backend reviews, minor) autosave: track store size incrementally (done: upper-bound estimate, measured only near the cap); log timer panics (done); RecoveryView.folder (done: dropped); a Recovered document always counts as unsaved on close; engine: first spawn not counted against the budget (confirmed, comment in `engine/pump.rs`: one extra spawn at most, its failure is retried and counted); replay failure strikes only the replayed document

## Later (post-1.0, not scheduled)

See `docs/FEATURES.md` → "Later".

## v1.1 backlog (ADR-030)

- [~] Disabled vs. enabled toolbar icons hard to tell apart in light theme (ink-50 vs ink-60; ≥ 3:1 rule for disabled) — design decision, e.g. darker enabled icons (M7 design review, major)
- [~] Empty state with the recovery banner on short windows: show 2 recents rows so none is cut off (M7 design review)
- [~] Dark-mode small text looks heavier (Windows ClearType on dark) — recheck against §3.52 #10 (M7 design review)

- [~] Disabled menu items show why (output.notAllowed tooltip) — menus cannot show tooltips (from M6 UI)
- [~] Export-as-images size estimate from a Rust sample render instead of client-side (from M6 UI)

- [~] v1.1-Backlog — Should/Could items moved out of M2–M7 (Tempo level 2); not part of v1.0, not picked by the loop
  - Stamps (Approved, Draft, …) (Should, was M4)
  - Edit existing text objects (single line/paragraph, same font) (Should, was M5)
  - Replace image (Should, was M5)
  - Header/footer, page numbers, watermark (Should, was M5)
  - Reveal in Finder/Explorer (Should, was M6)
  - OCR via OS APIs (Vision / Windows.Media.Ocr), invisible text layer (Should, was M6)
  - Read mode / full screen (Could, was M7)
  - Import/export comments (XFDF) (Could); self-signed digital signature (Could)

## v1.2 polish (collected at the v1.1 milestone end, ADR-030)

- [~] Politur v1.1 — folded into "Politur v1.2" (ADR-100)
  - (designer, major) tooltips linger after the pointer leaves and can cover the tab pill (dark doc screenshot)
  - (designer, minor) horizontal scrollbar at 100–115 % although the page fits; toast on the hub sits on the Recent row; Recent thumbnail and light-theme page need a visible edge token
  - (reviewer P1, minor) hub compact rule repeats a literal `max-height: 800px` (use one custom variant); single-file cards open multi-select then close extras; Sign card couples to `[data-toolbar-item="signature"]`
  - (reviewer P3, minor) docs/LICENSES.md skrifa row still says "flattened to polygons"; signature font choice is kept in localStorage, not in the encrypted library
  - (reviewer P4, minor) SelectionBar clamp near viewport edges unverified; SelectionBar not the first Tab stop
  - (P2 deviations) English menu labels Title Case vs spec sentence case; Windows full screen via web API; Open Recent not in the macOS bar
  - (security, low) docs/SECURITY.md re-date to v1.1 with rows for get_annotation_quote (280-char cap), review-state replies, bundled skrifa fonts, menu module; skip /State strings > 16 bytes before cloning; A→B→A /IRT cycle unit test; cite the typed-signature text cap test
  - (F11) a fresh annotation's inspector narrows the canvas without refit, so wide pages scroll horizontally (ADR-056 trade-off) — revisit with the §3.57 inspector rules

## v1.2 Redesign "sheer." (docs/REDESIGN_BRIEF.md, ADR-100)

Order as in the brief. Each phase ends with one designer round on Tauri-window screenshots next to moodboard crops (brief §3).

- [x] Package 0 — docs/DESIGN.md v2 + docs/MOTION.md v2 (designer, from BRAND + moodboard + brief; blocks all visual work)
- [x] B1 — Favourites ("Markiert") and "Show in Explorer/Finder" for recent files (Rust + src/api)
- [x] R0.1 — tokens.css rewritten (BRAND §24 + semantic tokens), role layer re-pointed, glass recipes flat, legacy aliases marked
- [x] R0.2 — Lint gate: no hex/rgb/hsl outside tokens.css, no backdrop-filter, no prefers-color-scheme, token-only shadows/radii/durations
- [x] R0.3 — Dark mode and glass setting removed (tokens, settings + one-time migration, data-theme, tests, UI scripts)
- [x] R0.4 — Inter bundled (OFL, woff2 Latin + Latin Ext), type scale utilities (.t-display … .t-caption), tabular-nums
- [x] R0.5 — Icon audit: Lucide stroke 1.75, sizes 16/18/20 (24 for large actions), monochrome; own icons removed or redrawn
- [x] R0.6 — BrandSurface, WorkSurface and SolarGlow primitives
- [x] R0 acceptance — Inter visible in the Tauri window, no dark/glass/backdrop leftovers, designer round
- [x] R1.1 — Word mark SVGs as paths (primary with claim, secondary, mono ink)
- [x] R1.2 — App icon "s." in three variants, measured optical centering (< 1 %), platform icons via `tauri icon`
- [x] R1.3 — Installer art (NSIS header/sidebar) in brand mode
- [x] R1.4 — Welcome PDF "Welcome to sheer." in the new layout
- [x] R1.5 — About dialog, README head, release-notes template; APP_NAME "sheer." in UI text
- [x] R1 acceptance — icons in Explorer, word mark in Home, installer built locally, designer round (2026-10-05: installed exe + Start menu shortcut show "s.", Home word mark, NSIS built, F15 designer round PASS)
- [x] R2.1 — Home: left navigation (Home, Recent, Starred, Tools), hero (Sand, glow, display type, search with `/`, yellow open button)
- [x] R2.2 — Recent cards (thumbnail, name, relative time, context menu: Open, Star, Show in Explorer, Remove), max 12 + "Show all"; Starred list
- [x] R2.3 — Tools view (rows): file dialog → editor in the matching mode
- [x] R2.4 — Empty state (large glow, "Drop a PDF here.", ghost button), drop on the whole surface
- [x] R2 acceptance — screenshot vs moodboard, drag and drop with the mouse, keyboard navigation, designer round (2026-10-05: moodboard PASS, Explorer → window drop opens a tab, Home reachable by Tab, `/` focuses search, Enter opens a card)
- [x] R3.1 — Editor top bar (back, file name, tabs, zoom, page field, undo/redo, search, export, Done, More); Windows menu bar removed
- [x] R3.2 — Left sidebar (Pages, Outline, Comments, Search) in the new style; yellow page selection; collapsible, remembered
- [x] R3.3 — Canvas (#EFEFEC, page shadow, 24 px gap); ADR-102: mode tabs (Lesen · Kommentieren · Ausfüllen & Signieren · Seiten · Bearbeiten, keys 1–5) with a tool row (≤ 8 tools, F14), contextual properties mini bar, no right sidebar, Windows menu bar restored
- [x] R3.4 — Form banner, selection popover (Highlight · Comment · Copy), comments tab (filter, resolved), redact mode (red band, Apply)
- [x] R3 spec — DESIGN v2 §3.2 rewritten for ADR-102 (designer)
- [x] R3 acceptance — annot-smoke 16/16, old ⋯-menu → new place table (ADR), screenshot vs moodboard, designer round (2026-10-05: smoke 16/16, ADR-116, moodboard PASS, F15 designer PASS)
- [x] R4.1 — Buttons, icon buttons, inputs, dropdowns, popovers, dialogs, toasts, tooltips with kbd
- [x] R4.2 — Tabs, segmented control, toggle, checkbox, slider, skeletons, banner, dropzone
- [x] R4.3 — Highlight/ink palette (Solar default + Mint, Sky, Rose, Lavender); signature sheet (Sand pad, baseline not in the path, ink Ink/Blue)
- [x] R4.4 — /dev/components page (dev builds only) and contrast script (text ≥ 4.5:1, UI ≥ 3:1)
- [x] R4 acceptance — contrast script green, designer round (2026-10-05: src/styles/contrast.test.ts green in npm run check 17/17, F15 designer round PASS)
- [x] Owner checkpoint — local installer build, then STOP for owner feedback (ADR-102); R5 only after it (686caf0)
- [x] R5.1 — Spells 1–6 (tool pill, page indicator, document open, drop zone, marker trail, saved check)
- [x] R5.2 — Spells 7–12 (undo, comment jump, delete page, app start, ambient glow, tool cursors)
- [x] R5.3 — Spells 13–18 (magnifier, sidebar chevrons, skeletons, tooltip groups, zoom snap, focus ring)
- [x] R5 acceptance — recordings, fps p95 ≤ 16.8 ms, reduced-motion variants, designer round (2026-10-05: 21 spells recorded with reduced twins in docs/review/v1.2/motion/ (not tracked), p95 16.8 ms (spell 22: 16.9 ms, 60 Hz noise), spells 4/8/10/16 checked with real OS input, save flash fixed (4adb568), designer PASS)
- [x] R6 — Tour coach marks + tour pill, welcome in a new tab, settings reduced, tool tips (max three per session)
- [x] R6 acceptance — designer round (2026-10-05: PASS on settings, coach mark, pill, tip; findings in Politur v1.2)
- [x] Politur v1.2 — reviewer/designer minors of v1.2 plus the still-valid items of "v1.2 polish" above (2026-10-05: four packages POL-1..4, reviewed, security PASS; leftovers moved to "Politur v1.3")
  - (B1 review/security, minor) reveal: test that a UNC/network recent is refused; `metadata().is_file()` before reveal (+ SECURITY I5 clause); `starred` field order under the `missing` comment in recents.rs; a refused star (49 cap) needs its own error code or a quiet tooltip, not `not_found`
  - (R1 review, minor) gen-installer-art.mjs reads the old logo.svg (dead); delete assets/brand/logo.svg and "Sheer — Logo & Farbe.html" once unused; brand claim test checks tracking/weight only via the up-to-date test; LICENSES skrifa row also covers tests/brand_assets.rs; word mark without GPOS kerning (tracking only)
  - (R0b reviews, minor) LICENSES objc2-app-kit row stale (transitive only); settings.rs RETIRED_KEYS comment says "first write" (startup rewrite); brandRules comment stripper eats `//` inside strings; brandRules non-vacuity check wants a minimum file count; `--font-display` duplicates `--font-sans`; Surface.tsx spreads `rest` after `data-surface`; WorkSurface wraps only panel/canvas/inspector (wrap the whole editor in R3); SolarGlow `drop` needs an opacity variable (R5 spell 4); tauri.conf backgroundColor hex outside tokens (record in DECISIONS)
  - (welcome review, minor) page 1 glow runs under the footer; page 3 highlight card has no Solar cue; task-page headings in Helvetica-Bold (BRAND: no bold headings) — use regular; top-right page number duplicates the footer
  - (R0 designer, minor) welcome PDF could embed Inter instead of Helvetica; "Strg+O" key badge outline should be `--color-border`; yellow-outline toggles (left-panel button, sidebar tab) fail 3:1 — Solar fill + Ink, Ink focus ring (R4 primitives)
  - (wave 3 reviews, minor) controlStyles tests cover only the forced-colors cue (assert the §4 state matrix); Secondary button lacks `active:bg-pressed`; Menu items still use `bg-control-hover/pressed` (move to `bg-subtle/pressed`, then drop those tokens and `--color-accent-pressed`); icon-button `sm` square is control-sm; Toggle knob travel asymmetric (`translate-x-5`); Dropzone/Skeleton without tests, Dropzone doc comment has a hex; Segmented Up/Down remap undocumented; Tabs leftover PRESS_MOTION; word-mark kerning without variation deltas; Wordmark.tsx duplicates the SVG path (guarded by a test); README prose still says "Sheer"; banners stack without a cap (BannerSlot); EditorLayout module-level `placements` map → useMemo; StatusBar.tsx, `--status-name-max`, `--toolbar-row-height`, `leftAutoCollapsed` possibly dead after wave 4
  - (wave 4/5 reviews, minor) home.css local px block (200/1120/280/76/48, minmax 208) → tokens; HomeNav/RecentCard/CenterCluster numeric icon sizes; `emptyState.recentList` key → home.*; topbar `w-12!`/`px-2!` overrides; hardcoded `100 %` label; ARCHITECTURE: document localStorage keys `sheer.signatureInk`, `sheer.styleColours`; HIGHLIGHT_OPACITY duplicates `--hl-opacity`; `--color-hl-excerpt` should derive from `--hl-solar`; BannerSlot hides queued notices with `hidden` (live regions silent); RedactBanner Ghost override chain → Button onDanger variant; dead `form.highlight`/`form.banner` keys?; SelectionBar flip-below component test; showcase inline style props + duplicate #showcase route; contrast page-area heuristic; comments tab wrapper divs between TabList and tabs; horizontal canvas scrollbar when the page fits — floor the fit width (zoom.ts:59) or overflow-x hidden while it fits
  - (wave 6 reviews, minor) ToolRow fit re-measure on locale/font change; OWNS_DIGITS selector list hand-kept (test per digit-owning widget); dead `onSelect` on Mehr submenu parents; overflow step 2 (icon-only) could go if the owner agrees; mini bar: Custom swatch only when the current colour is custom, per-frame rAF placement loop → scroll/resize/ResizeObserver, markup kind change = delete + create (reply thread lost; DECISIONS), "Kommentar" opens the Comments tab, not the note popover; magnifier: inline transition vs the reduced-motion !important rule, Z pressed without pointer move shows nothing until the next move, elementFromPoint per move, missing fade/unmount tests; Home caption box sits at the top of the 56 px strip (visual check); Magnifier/minibar React style props → classes where static; fill tools all disabled on the read-only welcome document (v1.1 behaviour — confirm with the tour)
  - (tour review, minor) tour mode switch leaves redactMode armed; `organize:` prefix special case in modeOfAnchor; Toggle width as a calc of two tokens → `--toggle-width`; macOS restartTour focus fallback untested; drop the `[role=toolbar]` settings anchor and the LAST_RESORT special cases
  - (P-A review, minor) legacy alias block still carries v1.1 `--annot-*` hex values (remove with the §1.4 palette migration, R4.3); rename `--color-surface-solid`; `text-accent` left in IconButton.tsx (yellow on Ink); legacy `--spacing-*` slot aliases (hub, logo, caption) go with R2/R3; `--panel-*` 192/248/400 and `--inspector-width` 288 keep v1.1 values until R3 (Rust limits.rs + layout tests)
  - (F15 A reviews/security, minor) tokens.css doc-hit comment detached from `--color-doc-hit`; SearchHits doc comment omits the stronger active fill; DESIGN §2 contrast table lacks the Solar hit/selection tokens; image_batch `read_at` has no non-windows/unix branch; NotePopover body Enter has no isComposing test; leaving Seiten still flies the thumbnail in (MOTION 4.6, kept); keychain outage maps to `invalid_argument/keychain` (own error code?); `/NM` turn suffix also read for foreign stamps (require `stamp_kind`); reject `/BBox` values above 1e6 in `turned_file_appearance`, and keep Matrix/name in sync when BBox is unparseable; matrix test with page `/Rotate`; macOS print fix unverified on a Mac (owner: Save as PDF)
  - (F15 acceptance + B reviews, minor) images-to-PDF orientation segments collide ("AutomatischHochformat"); signature menu thumbnails overflow their rows; mini bar of a selected note stays visible after a mode switch; tooltips linger after a click (Hervorheben H); SaveStatus failed tooltip without "Retry"/kbd, no aria-live for save states, redundant `max-save-label:sr-only`; author prompt `skip` closure re-registers the Esc layer per keystroke, no Esc/backdrop test, two hosts would duplicate ids; ink lag test bound looser than ADR-111's 10 px at 1000 px/s; CHANGELOG v1.2 line for the new signature fonts; margin marker 24 px inside the 32 px column (confirm §3.5), MarginColumn subscribes `byId` whole; derived outline: PDFium `page.text()` outside the budget check, ~3 s worker stall on big docs (budget 1 s?), `chars().count()` per char, rows `text-text-muted` vs Text-secondary; FreeText import: several stroked paths / fill-only path untested; ARCHITECTURE has no UI-storage line for `sheer.tools.recentColors`; RemoteFile::read returns Err after a partial copy (return Ok(filled)); images_pdf_render child test silently passes without PDFium; lines.rs: /BS /W not dereferenced, no hostile /L or single-name /LE test; derived_outline: confirm unwraps are test-only, fuzz case for NaN/zero/huge font sizes; ADR-115: DocCommand test sending an opaque or File-art draft (also inside Batch), cap Opaque subtype length in from_draft
  - (F15 designer round, majors) comment cards: "Löschen" wraps onto a second action line (+32 px per card) — one action row or Löschen into ⋯ (src/features/comments card); Bearbeiten tool row shows split chevrons on Text einfügen, Bild einfügen, Zuschneiden, Schwärzen although F14/§3.2 give them no variants (tool-row config); Seiten mode keeps the zoom field enabled ("81 %") — §3.2 says disabled there
  - (F15 designer round, minors) bubble "unbekannter Au…" vs cards "Kein Autor" — one string; bubble reply field shows a scrollbar/resize stub; Seiten size field "96 p›" clipped and the slider row has no defined slot; Home nav: Start and Werkzeuge both Sand (stale hover/focus); at 960 px page 2 sits flush against the canvas edge (no padding); at 160 % the margin column runs past the right edge until scrolled; Home search: Arrow Down / Enter do not move to or open the first hit (R2 keyboard check)
  - (R5 reviews, minor) spells 1/21: label weight swap at the end of the glide skipped; glide.ts/Tooltip mirror EASE_OUT and exit timings as fallbacks; FocusRing: a pointer press hides the ring until the next focusin, no real forced-colors test; InsertLayer keeps inline crosshair/copy cursors over `data-cursor`; MARKER_PEAK_RATIO duplicates `--marker-rest/peak`; the marker dry strip is removed by a timer, not animationend (check for a doubled opacity); PageIndicator size snaps mid-travel between pages of different size; thumbnails ghosts.ts layout effect without deps; Undo toast entrance not yet `slow 180` per spell 9; ambient glow pauses on window blur/focus, not Tauri focus events; `SPRING`/`spring` names kept for tweens (rename to TWEEN); drop event: frontend parser accepts any finite x/y (integer + ±32768 clamp like Rust), poisoned throttle lock stops the glow (into_inner), throttle is global not per window; useLastImage: lease created in useMemo can leak on a discarded render (create in an effect), retained blob outside the cache budget (one per mounted page), retained image stretched after a rotation/zoom-bucket change, no lease-release test on unmount/repeated saves
  - (R6 reviews, minor) Settings → Updates shows until a first check returns updater_unconfigured — add a cheap backend probe (update/mod.rs UpdateError::Unconfigured) and call it on settings load; tips session counter is module-level
  - (R5 designer round) minors: spell 9 deleted-page toast shows a faint doubled copy left of the real one (f02, old toast not unmounted or two instances); Lesen→Seiten switch (09-f03, 21-f03): sidebar slides out with the Solar indicator stretched into horizontal lines and grid thumbnails overlapping mid-FLIP, reduced twin (09-reduced-f03) leaves an empty sidebar column for a frame instead of jumping; spells 2/15: unrendered pages and thumbnails read as plain White (page 229 in 02-f03 shows bare Canvas) — the Sand skeleton + shimmer is not visible, check contrast of Sand vs page White; recordings all carry the crash-recovery banner (dismiss before re-recording R7 shots)
  - (R2/R3 moodboard round) minors: Home hero glow is clipped inside the Sand card and reads as a mostly linear Mist→yellow sweep (BRAND §3: diffuse light, partly past the container); 6 of 8 recent cards show the placeholder tile, not a first-page preview (the moodboard shows thumbnails); hero search field has a heavier bottom edge than the 1 px subtle border; the solid-Solar margin bubble is the largest yellow area in the editor (§26: the PDF stays the focus, so consider White + Solar edge); ARCHITECTURE §12 wrongly puts Highlight form fields/Manage signatures in the Fill tool row (ADR-116)
  - (R6 designer round) major: anchor ring on the page field is a thin Solar box around field + "/ 5" with no Ink outline (§2.1 pair: 1px Ink + 2px Solar, offset 2, on the field only); barely visible on White. Minors: tip is ~318 wide with ~16 inset (§3.6: max 280, padding 12); Settings → Updates uses an Aus/An segmented control, not the Toggle; tour pill fill reads White, not Sand; coach mark sits over the tool tier next to "Drehen ⌄" (fine as floating, but check it never hides a tool item at narrower widths)
- [x] R7 — Screenshot series docs/review/v1.2, designer review vs BRAND §2, smoke, gates, audits, CI green, CHANGELOG, tag v1.2.0 (2026-10-05: 27 shots, designer PASS vs BRAND §2, smoke 16/16, CSP 0/0 (dev + release), contrast + check 17/17, fps p95 16.8 ms, full security audit PASS, CI green on Windows and macOS)

## Politur v1.3 (leftovers of "Politur v1.2", ADR-030; picked after the v1.2.0 tag, before the v1.3 spec)

- [x] Politur v1.3 — carried minors (2026-10-05: P13-1..4 committed 446a6d9, 1656ac6, af7091d; reviewer PASS, check 17/17. Done: logo.svg + HTML reference deleted, README prose, welcome PDF fixes, ADR-118 (canvas backgroundColor, no Inter embed, no macOS Open Recent, Title Case menus kept), SECURITY I7–I9/P16, UNC reveal test, redact.pending plurals, onDanger button variants, TWEEN naming, Home tokens, ToolRow re-fit on font load, label weight swap at glide end, useLastImage lease in an effect + aspect check, ink lag bound, search tab padding + wrapping count, page labels in Text colour, note palette in the mini bar. The rest moved to "Politur backlog")

## Feature milestones after v1.2 (FEEDBACK F15 C, ADR-104)

Each milestone starts with a designer spec (DESIGN section + acceptance criteria) before any implementation; architect review where a
new engine capability or dependency is needed. Not picked by the loop before v1.2.0 is tagged.

### v1.3 "Citations"
- [x] v1.3 spec — designer spec (citation annotation, metadata sheet, export formats, tag manager) (2026-10-05: DESIGN §3.7 with 24 acceptance criteria, ADR-119 data model + commands + package cut W0 → C1–C4 → F1–F4)
- [x] v1.3.1 — Select text → "Cite" creates a citation annotation with page number (C1 dfcc0a8, F2 97cba77, rule in the appearance d15cac3; accepted in the installed build 2026-10-05)
- [x] v1.3.2 — Title, author, year read from the PDF (Info dict / XMP / first-page heuristic), editable per document (C2 376d226, C3 df3e989, F3 885d219; accepted in the installed build 2026-10-05)
- [x] v1.3.3 — Export in APA, MLA, Chicago, DIN ISO 690 to the clipboard and as the document's citation list (C4 ee64647, F1 3bffd59; accepted in the installed build 2026-10-05)
- [x] v1.3.4 — Own categories/tags with colour for comments and citations (C4 ee64647, F4 40851fa, 94444b6; accepted in the installed build 2026-10-05)
- [x] v1.3 acceptance — installed build with the mouse, designer round, tag v1.3.0 (2026-10-05: 24/24 AC, tester PASS + 2 tests, security-reviewer PASS (3 low), designer PASS (2 majors, 9 minors → Politur backlog))
  - (2026-10-05, round 1 in the installed NSIS build, zitate.pdf with labels i, ii, 1, 2) passed: AC 1–19, 21, 22 (aria-disabled on the welcome sample), 24 (960×640, 1280×800); AC 23 by code + tests. Failed → acceptance FIX A–D: AC 20 tag-delete undo restores nothing; citation underline lost after save/reopen (appearance stream has the fill only); Year field 56 px clips "2021"; Reference popover unreachable without comments; plus minors (error toast with a check icon, aria "Seite S. i", card order within a page, page shown twice on cards, page-1 DOI not offered when Info is complete) and the text-layer selection that ends ~10 % early on scaled spans (non-embedded fonts; cuts quotes).
  - (2026-10-05, round 2 after FIX A–D d15cac3, ed59df9, 94444b6, c2efc5e) all 24 AC pass: whole-line selection, rule kept after save/reopen, Year 88, Reference button on an empty Comments tab, error toast with alert icon, locator in aria labels, page-1 DOI offered. AC 20 round-1 failure was test timing (the 8 s action toast had expired between automation calls); a real click within its lifetime restores definition and assignments. Remaining: tester, security-reviewer, designer round, tag v1.3.0.

### v1.4 "Certificate signature"
- [x] v1.4 spec — designer spec + architect ADR (crates for CMS/PAdES-B, licence check, key storage) (2026-10-05: DESIGN §3.8 with 24 AC, ADR-121 + orchestrator amendment on stable crates; cut W0 → B1–B4 → F1–F4)
- [x] v1.4.1 — Sign with an imported (.p12/.pfx) or self-generated certificate (PAdES-B) (B1 77a2fe8, B2 803d06d, F1 70ce2db, F2 6ceb72e; accepted in the installed build 2026-10-05)
- [x] v1.4.2 — Visible seal with name and date; the document is read-only afterwards (B2 803d06d, B4 e61e9e9, F4 febe0b8, 0b43d34, 3726216; accepted in the installed build 2026-10-05)
- [x] v1.4.3 — Signature validation in Sheer; clear notice that trust needs an external certificate (B3 5b8da6a, F3 434b920, c6956df, 3726216; accepted in the installed build 2026-10-05)
- [x] v1.4 acceptance — security-reviewer, installed build with the mouse, designer round, tag v1.4.0 (2026-10-05: security FAIL→fixed c6956df; reviewer + designer FIX→fixed 3726216, blocker re-checked by mouse; tester PASS)
  - (2026-10-05, installed NSIS build, Windows) round 1 + 2 by mouse: AC 1, 2, 3, 5, 6, 7, 8, 11, 13, 14, 15, 16, 18, 21, 24 pass (after fixes: in-window menu lock 0b43d34, seal overlay offset + field widths + labels 0bab7a6); not by mouse (tests only): AC 4 import, 9 move/resize (no resize handles), 10 expired, 12 other viewer/print, 17 two signatures, 19 damaged, 20 additions after signing, 22 keychain unavailable, 23 reduced motion. Security review FAIL (1 high) fixed in c6956df. CI: #71 sig_validate env, #73 p12 decode race (72316ba).

### v1.5 "Edit text"
- [x] v1.5 spec — designer spec + architect ADR (content-stream text editing with embedded fonts, fallback font matching) (ADR-125, ARCHITECTURE §13, DESIGN §3.10; feasibility spike pdfwrite/textedit, report docs/reports/2026-10-06-v1.5-phase1-text-machbarkeit.md)
- [x] v1.5.1 — Edit existing text line- and paragraph-wise with embedded fonts (line-wise, pre-release v1.5.0-beta.1, ADR-128; paragraph reflow → v1.5.2)
- [x] v1.5.2 — Otherwise a bundled fallback (Arimo/Tinos/Cousine, ADR-125 §4, changed words only) with a notice; paragraph reflow, never across pages (ADR-129: scope paragraph re-break inside one paragraph, Umbrechen toggle; live line preview in the real font)
- [x] Politur v1.5 — owner scope (ADR-129 §2): substitute notice after Apply, growing edit box, centred/right-aligned lines keep their alignment, designer minors of the beta (hatch, marker, dotted substitutes, calmer mini bar, recovery toggle)
- [x] v1.5 acceptance — installed build with the mouse (owner-pdf-E4, owner-pdf-DD1, corpus-05), one blocker fixed (centred/right lines failed to apply, ccc12ae + 0d6f15c), designer round, tag v1.5.0
- [x] Politur v1.5 (Rest) → patch v1.5.1 (ADR-130): justified lines stretch to full width (splice + reflow), paragraph grouping across
      stretched lines and blank lines, notice lifetime and quoted list, box/preview anchoring for centred/right lines, welcome-document
      decode, preview caps/LRU/permission order, Flate for rewritten streams, neutral walker limit, test pins; P1 descoped (ADR-130 add. 1)
- [x] Acceptance infrastructure (ADR-131, rule 15): automation feature + dialog seam, acceptance build app.sheer.acceptance,
      CDP acceptance scripts with dialog guard, real-input smoke ≤ 5 min (d0268da, 43e0c7c, 44b8aa3)
- [x] Politur v1.5.1 (ADR-132): Umbrechen on for multi-line paragraphs; line stops at the paragraph edge with a true overflow;
      focus ring grows from the anchor; no compressed give-back; second-font lines refuse; refused paragraph preview falls back
      to line scope with a caption (owner-pdf-E4 heading); preview reads the crop edge from the loaded page; NaN guards; divider removed
- [ ] Politur v1.6 — carried over from v1.5.1 and v1.6
  - deferred (ADR-130 §3): approval-signed files (byte-range-aware write); cooperative cancel inside ops_walk/text_lines;
    re-edit of a line that already holds a fallback word; Symbol/ZapfDingbats widths; params.reason vs what on read_only refusals
  - text edit: the box shows the CSS fallback until the first keystroke (no preview of the untouched line)
  - text edit: opening an edit box that docks the mini bar shifts the page by one 40 px row (DESIGN §3.3 by design)
  - text edit: lines with inline runs in a second font (bold word) stay uneditable (review P-B)
  - review minors: decode_plain picks the lowest char when two codes share one; per_doc Vec scan; cross-chain delta low;
    interleaved-chain refusal is conservative
  - smart links: a session-edited page's text is not used for its neighbours' detection;
    index pages past a limit get no links (partial flag, UI ignores it); real-link page jumps carry no y offset; no fade on toggle-off
  - smart links: corpus-20 footnotes not linked (markers are real links); Settings fit at 960×640 to re-check with the gate
  - flaky: first annot-smoke run after launch (Highlight on text.pdf); storage::autosave retention test (timing)
  - not accepted: macOS; screen reader; reduced motion; Save after a justified edit; double-click word selection; Font popover

### v1.6 "Smart links"
- [x] v1.6 spec — designer spec DESIGN §3.11 (detection hints, back navigation)
- [x] v1.6.1 — Detect footnote numbers and jump (with Back)
- [x] v1.6.2 — Link tables of contents; references like "see p. 12" and "Fig. 3"
- [x] v1.6.3 — Literature references "(Müller 2019)" to the bibliography entry; heuristic, with a notice, never destructive
- [x] v1.6 acceptance — acceptance build (ADR-131): corpus-12, corpus-21, corpus-08; designer round (2 blockers fixed), tag v1.6.0
- [x] v1.6.4 — Range citations "[3–5]" link every number through a chooser (ADR-133, DESIGN §3.11 L14; e610716, f704a6e; acceptance build 11/11 with a generated PDF); unreleased

### v1.7 "Scan & OCR"
- [x] v1.7 architect ADR — ADR-134 (accepted 2026-10-07, ADR-135): Windows OCR via the windows crate in a child mode of the app, Swift sidecar on macOS
- [x] v1.7 phase 1 — Windows spike, no UI (f3c4c1b): 6 of 7 exit criteria met; exact-line copy fails (PDFium merges OCR lines); corpus holds only 2 real scan pages
- [ ] v1.7 spec — designer spec (OCR action, progress, language notice, redo, re-check of accuracy on real scans)
- [ ] v1.7 phase-2 prerequisites — real scanned test PDFs from the owner (rule 13); English OCR pack on the dev machine; line structure so copy keeps OCR lines; huge MediaBox guard in ocr_layer (security low); render/OCR pipelining; tilt; NFC; form-XObject scans in the probe
- [ ] v1.7.1 — Invisible text layer for photos and scans (searchable, copyable, highlightable), de/en, OS OCR preferred
- [~] v1.7.2 — Option: take text over as editable paragraphs (no formatting claim) → v2.1 backlog (ADR-135 §1)
- [ ] v1.7 part 1 acceptance — acceptance build (rule 15), security-reviewer, designer round, pre-release v1.7.0-beta.1
- [ ] v1.7 part 2 — macOS Swift sidecar sheer-ocr (Apple Vision), CI-built and CI-tested only; human Mac check pending (B-001)
- [ ] v1.7 acceptance — security-reviewer, tag v1.7.0

### v1.8 "Context help" (ADR-135 §4: on by default, one tip per situation, switch in Settings)
- [ ] v1.8 spec — designer spec (tip slots, clip format, frequency rules)
- [ ] v1.8.1 — Short tips with 3-second clips at the right moments (first highlight, first form, first signature, Pages mode),
      recorded from the app, at most one per situation, can be switched off
- [ ] v1.8 acceptance — installed build with the mouse, designer round, tag v1.8.0

### v1.9 "Backlog" (ADR-135 §5)
- [ ] v1.9 spec — designer spec (stamp picker, header/footer sheet, comment export, citation style)
- [ ] v1.9.1 — Stamps: predefined set + own text, Solar Yellow and Ink
- [ ] v1.9.2 — Headers and footers (default: page number + date)
- [ ] v1.9.3 — Comment export as a PDF summary and as Markdown
- [ ] v1.9.4 — Fifth citation style "Deutsche Zitierweise" (full footnote first, short reference after)
- [ ] v1.9 acceptance — acceptance build, security-reviewer, designer round, tag v1.9.0

### v2.0-rc.1 (ADR-135 §6)
- [ ] v2.0 polish — every open Politur ticket (v1.6, backlog, v1.7–v1.9 minors)
- [ ] v2.0 security — final security audit with the fuzz corpus
- [ ] v2.0 performance — budget re-measured (500-page open < 1 s, scroll p95)
- [ ] v2.0 accessibility — screen-reader pass (Narrator), keyboard-only pass
- [ ] v2.0 owner decisions — collect open owner decisions from every report since v1.5 into the final report
- [ ] v2.0-rc.1 — pre-release

## v2.1 backlog (Should features moved by ADR-135 §1)
- v1.7.2 OCR text as editable paragraphs; skew correction (image deskew)

## Politur v1.4.1 (session "Politur v1.2–v1.4 + CI runtime", ADR-123)

- [x] Politur v1.2–v1.4 — every item of the former "Politur backlog" (2026-10-05: S1–S8, T1–T2 + acceptance fixes; all reviewer PASS, security PASS, tester PASS, designer PASS; closed as working-as-specified or not reproducible: redact mode across a mode switch, hero glow, page-2 gap at 960 px (24 px measured), font choice in localStorage — ADR-123 addenda 3)
- [x] DocMDP choice when signing — "No changes" (default, P=1) or "Fill in forms and allow further signatures" (P=2) (a3cf54a; accepted by mouse 2026-10-05: /P 2 written, field fillable after signing, lock row names P=2)
- [x] CI runtime < 15 min per job — web/native split, dependency-only cache, slimmer debug info (f15da4a, f299c4a; runs #81/#82: Windows 9–10, macOS 5–7, web 4 min)

## F17 "UI quality after the owner test" (v1.4.2, ADR-124)

- [x] F17 — ten points of docs/FEEDBACK.md F17 plus the lock memory and the glib alert (2026-10-05: accepted in the installed build at 960 × 640 and 1280 × 800, surface gate 1560/1560, security PASS, designer FIX → majors/minors below)

## Politur backlog (minors not tied to a milestone)

- [ ] Politur backlog — picked between feature milestones when a wave has a free slot
  - (owner 2026-10-05) „Deutsche Zitierweise (Fußnoten-Stil)" as a fifth citation style — specify only after owner feedback
  - (v1.4.1) inspector refit for a fresh annotation not re-checked by mouse (tests cover the refit path); citation bubble focus shows the leader line but not the outline pair
  - (v1.4.1) save dialogs without a document (jobs, citation export, certificate export) still open in the last-used folder
  - (v1.4.1) seal resize handles verified by tests only, not by mouse; recovery list first row "Wiederherstellen" without fill (hover state, designer minor 5)
  - (v1.4.1, low) recent-preview worker: a failed worker spawn is not retried; queue-full test asserts no panic only
  - (v1.4.2 designer, major) crop popover at 960 × 640 covers the recovery panel (layout, not floating) — close or collapse banners while a tool popover is open, or protect them for popovers
  - (v1.4.2 designer, minor) colour popover sits ~2 px above the mini bar (measure the 8 px gap from the bar edge); selection frame style differs (yellow outer frame after undo vs Ink only)
  - (v1.4.2 review, minor) coach-mark re-test misses attribute-only changes; body MutationObserver while a notice is shown (exclude the canvas subtree, cap); MiniBar fit effect without deps; isControlLabel helper unused; protect selector comment
  - (v1.4.2 security, low) assert the 3× thumbnail size against `limits`; use the PDFium bitmap stride; second marker for the dev-registry bundle guard
  - (v1.4.2) 834397b does not type-check alone (store rename landed in 4a70409; pushed history, not rewritten)
