# FEEDBACK

Product-owner feedback (2026-10-03). Open items here take precedence over `ROADMAP.md` (ORCHESTRATOR_PROMPT §14).
Work them in order; tick `[x]` when done. The Stop hook reads the first open `- [ ]` line of this file before the roadmap.

## F1 — Catch up on reviews

- [x] tester, reviewer and security-reviewer on `a1efc46..HEAD` (engine read APIs + thumbnails): tester PASS (no gaps); reviewer
      PASS, then a deeper frontend pass FIX (2 major in `src/api/search.ts`); security FAIL only on `cargo deny` run without
      `--target` (Linux-only GTK advisories; `check.sh` checks the shipped targets, ADR-017) + 2 low
- [x] Fix the findings (blocker/major, critical/high); tick "Thumbnails panel (lazy)" in ROADMAP.md (32e41b9, 4b1f703)

## F2 — Mood: the app looks grey, empty and lifeless

The §3 rule "gradient barely visible" is overruled (ADR). Target: the mood of the reference image, with one hue.

- [x] designer (Opus) writes a mood spec with concrete token changes: background gradient clearly visible (iris-100 → iris-50, 135°), glass
      surfaces slightly iris-tinted instead of pure white, icon tiles on iris-100, soft coloured shadows (Iris 12 %), empty state with a large,
      gently floating logo sheet as the focal point, toolbar with visible translucency over the gradient; ADR
- [x] implementer applies the spec (light + dark, glass fallback, reduced motion)
- [x] Acceptance by screenshots from the Tauri window (not the browser): light + dark, empty state + document; designer verdict PASS (2nd round)

## F3 — Motion system

- [x] designer (Opus) writes `docs/MOTION.md`: one spring curve for everything, three durations (120/200/320 ms), rules for enter, exit and
      layout change, and a catalogue of micro-interactions: buttons with press and hover response; panels slide instead of appearing; pages
      load with a fade instead of a jump; zoom with inertia and snap to fit steps; drag and drop with a preview card that drops into the
      window; opening fades from thumbnail to page; success moments as a subtle Iris pulse instead of a dialog. Budget: 60 fps in the Tauri
      window, blur only on toolbar and panels, never on the document canvas; reduced motion switches to fades
- [x] implementer applies the motion system (3e2c971, e959fcd, a1d0ae5)
- [x] Acceptance by screen recording from the Tauri window; 60 fps measured (designer PASS round 3; a707243)

## F4 — Onboarding

On first launch a bundled "Welcome to Sheer.pdf" opens (own template, Iris design, 4–5 pages). Every page is a task: navigate, zoom,
highlight, comment, drag a signature, reorder pages. Coach marks point at the tool; when the user completes the task, a short success
moment follows, then the next step. Progress in the status bar, skippable, restartable in Settings, never shown automatically twice.

- [x] Scaffold in M1: welcome document, coach-mark component, step engine, steps Open / Navigate / Zoom (designer PASS round 3; 8bba314, b3ceb2f, b8ec27f)
- [x] Tickets for the remaining steps: highlight + comment (M2), reorder pages (M3), drag a signature (M4)

## F5 — Installer

- [x] Ticket in M7: NSIS target with own header and sidebar images in Iris, Sheer icon, no WiX default dialog

After F1–F5: continue with the roadmap.

## F6 — CI red on GitHub

CI runs #5 and #7 on `main` are red and the Dependabot PRs fail. Work this before the M1 milestone close.

- [x] Fetch the logs of the failed runs (`gh run view --log-failed`), find the cause per platform (Windows, macOS) and fix it
- [x] Record the macOS build result in B-001 (`docs/BLOCKERS.md`)
- [x] ORCHESTRATOR_PROMPT §8.6: CI green on Windows and macOS is part of the milestone DoD; the CI status is checked after every push
- [x] Dependabot: limit to security updates plus grouped patch/minor updates, ignore major bumps; close the open Dependabot PRs

F6 result: macOS failed only on test-side issues (APFS refuses non-UTF-8 names; clippy constant assert; a 300 ms respawn timing); fixed,
CI green on Windows and macOS (run 37120538629). Dependabot PRs #1/#2 closed. Open for the product owner: the repository setting
"Dependabot security updates" (automated security fixes) is off — enabling it is a repo setting, left to a human.

## F7 — Release workflow

- [x] `.github/workflows/release.yml`: on every tag push `v*`, build the installers on Windows and macOS (NSIS setup and DMG, unsigned) and attach them
      to a GitHub Release whose body is the tag's section from CHANGELOG.md
- [x] Build the existing tag v0.4.0 with it after the fact (workflow_dispatch with a tag input; never move or re-push a tag)

F7 result: release.yml (ADR-031) built v0.4.0 via workflow_dispatch (run 37124250480): GitHub pre-release "Sheer 0.4.0" with
Sheer_0.4.0_x64-setup.exe, Sheer_0.4.0_aarch64.dmg and SHA256SUMS.txt (unsigned, B-002).

## F9 — Annotation tools dead in v0.8.0 (blocker, before M6)

Product-owner test of the installed v0.8.0 build (2026-10-04).

- [x] Reproduce in the real Tauri window (installed v0.8.0 build), on a normal PDF and on the welcome document: Highlight, Note, Text,
      Draw and Rectangle — clicking the tool and dragging on the page does nothing
- [x] Find and fix the cause: does the M5 edit layer (insert/crop/redact) swallow the annotation layer's pointer events? Does the
      read-only welcome document silently block annotations? The welcome document must allow them (the tour needs them); other
      read-only cases show a visible notice instead of failing silently
- [x] Window test: in the Tauri window, every annotation tool creates an annotation; part of the milestone DoD (ORCHESTRATOR §8.6)
- [x] Naming: annotation tool → "Textkommentar" / "Text comment" (tooltip: floating note, stays a comment); edit tool → "Text einfügen" /
      "Insert text" (tooltip: becomes a permanent part of the page). The toolbar groups "Markieren" and "Bearbeiten" are visibly separated
- [x] Tag v0.8.1 for the owner's re-test

F9 finding: reproduced with the installed v0.8.0 via CDP. Not the M5 layers: since M4 (b0487ee) the annotation creation layer sits inside
`[data-annot-layer]`, which is `pointer-events: none`, and inherited it, so no tool got pointer input (already broken in v0.7.0).
jsdom ignores `pointer-events` when dispatching, so the unit tests passed. Fix: `pointer-events-auto` on the creation layer.

## F10 — Signatures must be vector, not pixels (blocker for v1.0, ships with v0.8.1)

Product-owner test (2026-10-04): signatures are placed as low-resolution bitmaps; the typed signature is pixelated.

- [x] (a) Drawn: capture pointer points, smooth the path (Catmull-Rom or Bézier), vary stroke width with velocity, write it as a vector
      path into the appearance stream; in the app render it as SVG at the device pixel ratio
- [x] (b) Typed: glyphs of the handwriting font as paths (skrifa) in the appearance stream, never rasterised
- [x] (c) Image: make a white background transparent, embed at ≥ 300 dpi
- [x] (d) Drawing area in the signature sheet ≥ 600×200 CSS px, DPR-scaled, real-time smoothing, "New" (clear) button
- [x] (e) Selection frame and handles in design-system style instead of square boxes
- [x] Acceptance: screenshot at 200 % zoom with smooth edges; exported PDF checked at 400 % (Edge, or an equivalent PDFium render at 400 %)

F10 result (ADR-051): art crosses IPC as path commands with cubic Béziers and is written 1:1 as m/l/c/h; typed glyphs are skrifa curves
(no linearisation); drawn ink is one Catmull-Rom + velocity-width function for preview and file; image art up to 3 000 px with a soft white
ramp. Acceptance: window screenshot at 200 % antialiased without steps (review/f10-sig-200*.png, not tracked); the saved file rendered by
PDFium at 400 % deviates from an exact-curve reference in 0.2 % of ink pixels (`tests/signatures.rs`). The slightly rough edge of typed
signatures is the bundled Homemade Apple font's marker texture, not rasterisation. The Edge 400 % check is the owner's re-test.

## F11 — Patch v1.0.1 (owner test of the installed v1.0.0, 2026-10-04)

Every item: reproduce and accept in the installed build with real mouse input (OS cursor, `scripts/ui/mouse.ps1`), not only in tests.
Owner screenshots: `review/owner/` (not tracked).

- [x] 1. Redaction is surgical: (a) the extra black bar at the page bottom on the first click (check after item 2); (b) the rest of the
      page stays text (selectable, searchable); remove only text objects, image areas and vectors inside the rectangle; rasterise at most
      the affected image area, never the page. Acceptance: after redact + save, an unredacted sentence is selectable and findable in Sheer
      and in Edge, the redacted one is not
- [x] 2. Live drag preview is offset from the cursor for every tool (highlight, text comment, draw, rectangle, signature); fix the common
      cause in the preview layer's coordinate conversion (zoom, scroll, DPR)
- [x] 3. Highlight while dragging shows at the top left instead of on the text; the drag must look like and follow a text selection
- [x] 4. Text comment, drawing and rectangle cannot be edited after insertion ("This request was invalid"): check IPC validation
- [x] 5. Comments panel shows "Comments could not be read" once a check mark from the Sign menu is placed: handle mark annotations
- [x] 6. Tools stay active after an action until Esc or the select tool; no fallback after each annotation
- [x] 7. Starting the tour closes the current document and drops changes: open the welcome document in a new tab, never lose unsaved work
- [x] 8. Drawn signature: the pad shows raw angular strokes and a guide line that is drawn along; smoothing must apply live; the guide is
      not part of the path
- [x] Tag v1.0.1 (tester, security-reviewer, annot-smoke, installed-build acceptance)

## F12 — Milestone v1.1 "Structure and comfort"

Designer spec before any implementation; the designer justifies every decision against the reference image (§3 reference direction:
soft gradient, translucent white cards, icon tiles, pill badges; the owner's image is not in the repo).

- [x] 1. Start page as a tool hub: cards for Open, Merge, Split, Compress, Images to PDF, Sign, Redact, Fill form; recents below. Card →
      file dialog → straight into the matching mode
- [x] 2. Toolbar only tools (Select, Highlight, Comment, Draw, Shapes, Sign, Redact). File and document functions in a real menu bar (File,
      Edit, View, Tools) instead of the overflow menu. Left sidebar: Pages, Outline, Comments, Search. Right: properties of the selection
- [x] 3. Remove the "Form" button: fields are fillable automatically when present, with a notice banner; "Flatten form" in the File menu;
      marks (✓ ✗ •) and text fields for PDFs without fields under "Sign" as "Fill & Sign"
- [x] 4. Comments like Word: select a sentence → popover "Add comment" → panel shows quoted text, comment, author; replies and
      resolve/accept; click jumps to the spot; every annotation clearly typed in the panel
- [x] 5. Typed signature: three selectable fonts (SIL OFL: e.g. Dancing Script, Great Vibes, Alex Brush); add OFL-1.1 to the font license
      allowlist; remove Homemade Apple
- [x] Tag v1.1.0 (milestone DoD §8.6)

F11 result (v1.0.1): accepted in the installed build with the real OS cursor (scripts/ui/mouse.ps1). Redaction cuts glyphs/vectors/image
pixels inside the marks only (ADR-055); after save "Repeated" is found and "lazy" is not, in Sheer and in Edge (1/1 vs 0/0), the file has
no images. Preview under the pointer (overlayBox got pt instead of px); editing via a valid coalesce key + double-click/Enter; selecting
never refits the zoom (ADR-056); comments list marks (ADR-057); the tour opens a new tab; pad strokes never join; pages re-render sharp
after a save. tester PASS, security-reviewer PASS, annot-smoke 16/16. Screenshots in review/f11/ (not tracked).

F12 result (v1.1.0): spec DESIGN §3.54–§3.60 (ADR-058) before any code; built in four packages, each reviewed (PASS), security PASS.
Accepted in the installed build with the real OS cursor: hub card "Schwärzen" → file dialog → document opens in redact mode; tools-only
toolbar, File/Edit/View/Tools/Help menu bar (Flatten form in File), Pages/Outline/Comments/Search sidebar, zoom in the status bar;
form.pdf shows the fillable-fields banner, a field is filled by click + typing and saved; Fill & Sign menu (Sign / Fill sections, ✓ ✗ •,
date, text); selecting a sentence → "Add comment" → card with quote, text, author, time, reply, resolve (saved as /IRT review state);
three OFL signature fonts (Dancing Script, Great Vibes, Alex Brush), Homemade Apple removed (ADR-059). Designer PASS (4 screenshots,
majors/minors in ROADMAP "v1.2 polish"), tester PASS, annot-smoke 16/16, CSP gate 0 violations.

## F14 — Tool assignment per mode (owner, 2026-10-04; binding for ADR-102)

Lesen: Auswahl, Hand, Textauswahl, Lupe (Z halten), Drehen, Suche.
Kommentieren: Hervorheben, Unterstreichen, Durchstreichen, Notiz, Textkommentar, Zeichnen, Formen (Rechteck, Ellipse, Linie, Pfeil).
Ausfüllen & Signieren: Felder automatisch aktiv, Text, Häkchen, Kreuz, Punkt, Datum, Signatur, Initialen.
Seiten: Raster statt Dokumentansicht; ordnen, drehen, löschen, einfügen, extrahieren, teilen, zusammenführen, komprimieren.
Bearbeiten: Text einfügen, Bild einfügen, Zuschneiden, Schwärzen, Schützen, Metadaten.
Nicht in Modi, sondern Datei-Menü und „Fertig": Speichern, Speichern unter, Kopie exportieren, Als Bilder exportieren, Drucken,
Formular reduzieren, Dokumenteigenschaften, PDF aus Bildern.
Jedes Werkzeug mit Icon und Label; maximal acht sichtbar pro Modus, der Rest unter „Mehr" am Ende der Reihe. Tasten 1–5 wechseln den
Modus, Esc zurück zur Auswahl.

- [x] Spec: DESIGN v2 §3.2 tool table replaced by F14 (ADR-102)
- [x] Shell package: mode row + tool row per F14, properties mini bar, no right sidebar, Windows menu bar restored (DESIGN §3.2–§3.4)
- [x] Build the installer locally (NSIS), then STOP for the owner's feedback — R5 only after it (src-tauri/target/release/bundle/nsis/Sheer_1.1.0_x64-setup.exe, 686caf0)

## F15 — Beta test of v1.2.0-beta.1 on Windows and macOS (owner, 2026-10-04)

The mode layout (ADR-102) is confirmed and stays. B-001 closed: the app runs on the Mac. Three blocks in this order; every item is
accepted in the installed build with the real mouse (`scripts/ui/mouse.ps1`). macOS-only items are accepted through a CI test or a
mock where no Mac is at hand (ADR-104). After A and B: designer acceptance of the mode layout, then R5, then v1.2.0.

### A — Bugs (patch, before everything else)

- [x] A1. Clicking a page in the left sidebar plays a fly-in animation that stacks on repeated clicks. Spell 3 runs only when a document
      opens, never on a page change
- [x] A2. Search hits are grey → Solar yellow with multiply, text stays readable; the current hit stronger
- [x] A3. Text selection is grey → Solar yellow 35 %
- [x] A4. A text comment cannot be moved after creation while its tool is active; moving stutters. Dragging existing annotations is
      allowed in every tool
- [x] A5. Comments panel breaks mid-word ("Textkomme/ntar"); cards too narrow
- [x] A6. Images to PDF: images do not load or only partly. Reproduce with 10 JPGs and fix
- [x] A7. Note and comment: Enter confirms, Shift+Enter inserts a line break
- [x] A8. In a rotated view, signatures and marks are placed rotated with the page. Placement follows the screen orientation (rotate the
      annotation against the view rotation). Plus a rotate handle on placed signatures
- [x] A9. "Save to library" does not save on Windows or macOS. Check keychain access (Windows Credential Manager, macOS Keychain)
      including the error path; if access fails the app says so instead of silently dropping. Acceptance: save a signature, restart,
      the signature is in the library — on both platforms, macOS via a CI test or a keychain mock
- [x] A10. Printing on macOS gives blank pages (Windows works; drag and drop on the Mac works). Likely `Webview::print()` in WKWebView
      does not render the canvas pages; switch the macOS print path to rendered page images or hand a PDF to the system print dialog.
      Acceptance: "Save as PDF" in the Mac print dialog with visible content
- [x] A11. (found in the acceptance) Saving a document with annotations does nothing while the author name is empty: the author
      prompt (ADR-034) lost its slot in the v1.2 layout, so the save waits forever (ADR-109)
A acceptance (2026-10-05): installed NSIS build, real OS cursor (`scripts/ui/mouse.ps1`), shots in `review/f15/` (not tracked).
A9: the library entry survives a restart on Windows; macOS via the CI step "Real credential store round trip" (run 37245442441,
both OS green). A10: the Windows print preview shows the pages; the macOS fix (frames outlive `Webview::print()`, ADR-107) is covered
by CI; the owner's "Save as PDF" in the Mac print dialog is the final check on the next pre-release. A6 had a second cause: the
engine's file reader returned short reads at 256 KiB block borders (large images half grey, ADR-106 addendum).

### B — Shell polish (before R5)

- [x] B1. Remove the "Done" button. Instead a save status next to the file name ("Saved" / dot for unsaved), Ctrl+S
- [x] B2. Sidebar: visible collapse/expand grip on its edge plus a top-bar button; "View → Sidebar" stays
- [x] B3. Mode tabs look lost between top bar and tool row. Designer: tabs and tool row as one continuous bar on a Sand background,
      tabs as a segmented control or with a clear yellow underline; before/after screenshot
- [x] B4. Text comment: a click places it and typing starts at once, no double-click; the box grows with the text; mini bar with align
      left/centre/right, font size, border on/off, fill on/off
- [x] B5. Colours in the mini bar: token palette plus a custom hex value with an input field and "recently used"
- [x] B6. Drawn signature: stronger smoothing (One Euro filter), minimum stroke width, stroke width by speed
- [x] B7. Typed signature: remove the three current fonts. Collect 8–10 OFL fonts from Google Fonts in the style "thin monoline signature
      with long loops" (candidates: Mea Culpa, Ms Madi, Hurricane, Island Moments, Qwitcher Grypen, Birthstone, Love Light, Petemoss,
      Whisper, Waterfall — check each file's licence), render the name "Dijana Kornelsen" in all of them as
      `docs/review/signature-fonts.png`. The owner picks five; until then ship all. **Owner pick (2026-10-05):** Ms Madi (default),
      Hurricane, Birthstone — in this order; the other seven are not shipped; umlauts and ß checked by the owner
- [x] B8. Outline: without bookmarks, derive an outline heuristically from font size and weight, marked "derived"
- [x] B9. Comments as margin bubbles: when comments exist, a margin column appears to the right of the page; each bubble at the height of
      its anchor with avatar initial, name, date, text, reply field, resolve — model: the owner's yellow note bubble image. The left panel
      stays a list and shows the comment text as the first line, not just the type
- [x] B10. Comments panel: filter by type (highlight, note, drawing, shape, signature, quote), author, page, open/resolved; sort by page,
      date, author; type icons subtly distinct
- [x] B11. Shapes: add an arrow. Freehand shape recognition: a roughly drawn shape plus a short hold snaps to circle, ellipse, rectangle,
      line or arrow (like Apple Notes); can be switched off
- [x] B12. Canvas background: very faint, slowly drifting Solar shapes (≤ 6 % opacity) only between the pages, never under them. The
      designer decides after a legibility test whether it stays. **Result:** removed after the test (rings and mask edges noticed at
      first glance; ADR-108 (3))

### C — Feature milestones after v1.2 (each a ROADMAP ticket with a designer spec before implementation)

- [x] C. ROADMAP tickets v1.3–v1.8 with the owner's scope (see ROADMAP "v1.3 Citations" … "v1.8 Context help")

### Then

- [x] Designer acceptance of the mode layout (after A and B): PASS 2026-10-05, no blockers, B3 accepted, B12 removed; majors/minors in
      ROADMAP "Politur v1.2". R5 and v1.2.0 continue in ROADMAP v1.2

## F16 — CI red on main since run #61 (2026-10-05)

Owner: CI on `main` red since run #61, five runs, also on docs commits. Stop v1.3 features until clarified: fetch logs, find the cause per platform, fix until main is green; check why docs commits trigger CI (`paths-ignore`). New rule + ADR: every loop starts by reading the CI status of the last completed run on main (no waiting); red = fix first, no new package; green CI is part of every package's DoD.

- [x] Logs and cause: macOS only, one test (`recent_actions::tests::starring_by_id_and_revealing_only_what_exists`, a relative UNC spelling on Unix is never stored); Windows green.
- [x] Fix: 7380b68 (absolute spelling on non-Windows).
- [x] `paths-ignore` works: every run in question came from a push that also carried code; a docs-only push (893ce34) started no run (ADR-120 context).
- [x] Rule + ADR-120: `scripts/ci-status.sh` at every loop start, red = fix first, CI green in every package's DoD (ORCHESTRATOR_PROMPT §2 rule 12, §8.4 step 0/7, §9; CLAUDE.md rule 12).
- [x] main green on both platforms (run #67, 7380b68: Windows and macOS success)

## F17 — UI quality after the owner test (2026-10-05, patch v1.4.2)

Owner test of v1.4.1. Acceptance only in the installed build (not the dev window), at 960×640 and 1280×800. Release v1.4.2 with a report.

- [x] F17.0a Signing lock choice is remembered and shown visibly on every signing (reverses ADR-123 "never remembered").
- [x] F17.0b glib Dependabot alert dismissed as "not used" (2026-10-05, alert #1; Linux-only GTK chain).
- [x] F17.1 Deleting a highlight with Del breaks the comment cards (frame offset, leftovers). Fix; tests for delete by key, context menu and card.
- [x] F17.2 In Lesen the active tool is not Solar-filled like in the other modes. Unify.
- [x] F17.3 Mini bar: stroke width "0,5 pt" wraps. Segmented control with fixed width, tabular figures, never wraps.
- [x] F17.4 Custom colour: hex field and "Übernehmen" overlap. New two-row popover: palette on top, hex field full width below with a confirm check inside the field; min width 240 px.
- [x] F17.5 Shape recognition while drawing is unreliable. Rename to "Formen automatisch begradigen"; on release test the stroke against circle, ellipse, rectangle, line, arrow (tolerance 12 %), morph in 150 ms on a hit, undo reverts; switch in the mini bar, default on. Test with 20 sample strokes.
- [x] F17.6 Tool row: no "…" on tool labels (menus only). All labels fit fully at 960 px; otherwise shorten labels or switch to icons with tooltips from a threshold — never truncate.
- [x] F17.7 Crop popover scrolls and cuts off buttons. Global rule for all popovers and dialogs: size to content; if it does not fit the viewport it becomes a dialog or is repositioned; internal scroll only for lists, never for forms and buttons. Crop itself more compact: four fields in one row, page choice as a segmented control.
- [x] F17.8 Tips, notices and coach marks cover input fields. One shared positioning engine (collision detection, flip, shift) for all tooltips, tips, coach marks and popovers; notices never over inputs or buttons, only one visible at a time. Audit every existing notice and document it as a screenshot series.
- [x] F17.9 Thumbnails: headings and bold text become black blocks. Render thumbnails at 2–3× target resolution and downscale with a high-quality filter (Lanczos or area averaging), text antialiasing on; before/after screenshot with a bold heading.
- [x] F17.10 New DoD gate: every popover and dialog is checked automatically at 960×640 for overflow, cut-off buttons and overlap (DOM check); violations are blockers.
- Acceptance (2026-10-05, installed NSIS build v1.4.2, Windows, 960×640 + 1280×800, three rounds; review/v1.4.2/, not tracked): all ten points by mouse; F17.9 shows no black blocks before or after with the test files (owner file not available) — 3× box-downscaled thumbnails are finer; surface gate 1560/1560 (both sizes, en+de, review/v1.4.2/gate-final.txt).

## F19 — Beta feedback, part 1: bugs and UX (owner, 2026-10-08, v2.0.0-rc.2; ADR-141)

- [x] F19.1 Comments made in Acrobat or other PDF editors/viewers are read and adopted as regular Sheer comments (editable, panel, margin). (Replaces the dropped "Acrobat comments do not open" report: damaged file.)
- [x] F19.2 Hover on tool buttons spills over the frame (highlight button): hover area exactly equals the button geometry; the surface gate checks hover bounds strictly.
- [x] F19.3 Left sidebar resizable to the right up to 480 px; width remembered.
- [x] F19.4 The last tab can be closed → home.
- [x] F19.5 Favourite star: top right inside the card (not over the title), filled Solar Yellow instead of black.
- [x] F19.6 Home: section "Open" with the open tabs as cards above "Recent"; "Recent" two rows, rest under "Show all", so the tools are visible without scrolling.
- [x] F19.7 Crop: "Apply" directly from the tool (no second click); no empty popup after "Cancel"; cropping only sets the CropBox and never changes content (text stayed unreadable after cropping); regression test.
- [x] F19.8 Redact: confirmation only on Apply, not on every mark; marked areas can be clicked and deleted in the Select tool.
- [x] F19.9 Text selection: one continuous bar per line instead of glyph boxes, same look as the highlight preview.
- [x] F19.10 Comment bubbles always in the margin column next to the page, whatever the page format; bubbles with the agreed gradient (subtle Solar glow as on home).
- [x] F19.11 Comments panel: only the quoted text is tinted, not the whole block.
- [x] F19.12 Header/footer: detect existing ones (text objects in the margin), report overlap, new ones with an optional background box in page colour.
- [x] F19.13 Freehand arrow recognised as a shape; shape recognition more tolerant — open circles and ellipses from 80 % of the circumference.
- [x] F19.14 Toggleable annotation palettes — specification arrived, implemented as F19.19 (ADR-143); originally: per owner specification (spec text pending, ADR-141); first audit which tools have their own palettes and unify. Done so far (86b8395): audit table in DESIGN §1.4, one palette source with switchable sets (PALETTE_SETS). Waiting for the owner spec text.
- Acceptance (2026-10-08, acceptance build v2.0.0-rc.2, Windows 11, CDP): v20rc2 54/54, surface gate 2656/2656 (960×640 + 1280×800, en+de), annot-smoke 17/17, real-input smoke PASS; macOS via CI only.
- [x] F19.15 Focus ring in dialogs moves when scrolling and covers fields (document properties) — fix.

## F19 — Beta feedback, part 2: layout, palettes, smart detection (owner, 2026-10-08, v2.0.0-rc.3; ADR-143)

Templates: `docs/brand/editor-rc3.png`, `docs/brand/home-rc3.png` (untracked, rule 16). Designer derives, does not redesign.

- [x] F19.16 Editor layout per template: menu bar 28 px; tab strip 42 px full width (active tab white with yellow underline, dot = unsaved, scroll arrow from the sixth tab, right: undo, redo, history, search); rounded card (border #E5E5E1, radius 10, 12 px side gap) whose top edge carries the mode tabs as file tabs with key chip 1–5, the active one merging into the sand area; tools of the mode icon-over-label, 56 px high, thin separators, no group captions, no hint texts (explanations only as tooltips); tool inspector 300 px on the right only for tools with settings (crop, header/footer, stamp, OCR, citation reference), replacing their popups, without explanatory text; status bar 30 px (save state, page, zoom, fit). Same pattern for all five modes. At 960 px width: icons only with tooltip.
- [x] F19.17 Home per template: left nav 230 px (word mark; Start, Recent, Starred, Tools; Settings at the bottom; active entry on sand); Solar glow top right (yellow → peach, home only); greeting by time of day with the author name from settings if set; display title "PDFs made simple."; full-width search without key chip; round plus button top right = open; "Recently opened" one row of five cards (thumbnail, file name, three-dot menu), favourites with filled yellow star top right and yellow-tinted card, "Show all" on the right; "Open" section with open tabs in the same card form above it, only when documents are open; "PDF tools" eight tiles in two rows (icon, title, subtitle): Merge, Split, Compress, Fill form, Sign, Redact, Images to PDF, More tools. No scrolling at 1280×800.
- [x] F19.19 Palettes (F19.14 spec): default #EF35F2 · #00F5FF · #6EF230 · Solar #FFF84D · #FF4103; presets Earth #093699 · #B7CF4F · #2A5239 · #DAD1CA · #C54712, Berry #A61B4E · #D92567 · #F2509C · #D4D93D · #D6CECE, Study #174FBF · #A7D5F2 · #1B4427 · #B0BF3F · #F2EDD5. Picker keeps five colours; a small palette button opens the preset chooser (each palette one row of five swatches, no names or hex). Choice replaces the five colours at once, stored locally, app-wide for all annotation tools, not per PDF. Never recolours existing annotations; stored colours stay exact; tool-specific transparency stays. Tools with their own or hard-coded palettes move to the shared source without behaviour change.
- [x] F19.20 Smart links complete: scan the whole document; footnotes also superscript, in brackets or with asterisk; outline merged from table of contents and headings; coverage report per owner PDF as a gate, ≥ 90 % on the three footnote PDFs.
- [x] F19.21 Smarter source detection: title, author, year, edition, publisher, place, ISBN/DOI from metadata, the first three pages and the imprint; document type (book, article, report, official text); "Some details are missing" only once; hit rate per field over the owner corpus in the report.
- [x] F19.22 Save as text PDF after OCR: new PDF with the recognised text as flowing text, paragraphs and headings by font size, Inter/Tinos, no columns or tables; keep the original image optionally.
- [x] F19.23 History panel: list of all changes of the session with a jump to a state; delete single annotations directly from the history; text edits only linear.
- [x] F19.18 Owner decision: foreign stamps stay non-editable (ADR-143).
- [x] F19.24 Comments: (a) no connector line on bubble hover (it pointed to wrong places); the linked mark pulses once instead. (b) After "Comment" the bubble appears at once in the margin column with focus in its text field; typing goes straight in, Enter confirms, Esc discards; no click into the left panel. (c) The frame around the marked text field is misplaced after scrolling or layout shifts (image mentioned, not attached): position computed from current geometry and reset on scroll and resize; regression test with scrolling.
- [x] F19.25 Crop: Enter applies, Esc cancels — no second click on the tool, no confirmation popup.
- [x] F19.26 Separate Draw and Shapes: "Shapes" are rigid geometric shapes (rectangle, ellipse, line, arrow with handles). "Draw" is freehand with smoothing and gets two new tools: freehand arrow (curved line that automatically gets an arrowhead in stroke direction at its end) and freehand shape (loose circles and ellipses, smoothed but not straightened). Automatic straightening applies only to "Shapes", not to "Draw".
- [x] F19.27 Split button active state: exactly one outer contour, unchanged on hover, active and hover-on-active; hover only changes the fill of the hovered half, never the border. The surface gate checks all four combinations (inactive, inactive+hover, active, active+hover) for main part and chevron part (so far only inactive hover).
- Acceptance (2026-10-09, acceptance build v2.0.0-rc.3, Windows 11, CDP): v20rc3 60/60, v20rc2 57/57, v19-backlog 64/64, v17-ocr 50/50, v16-range 11/11, v16-smartlinks 77/79, surface gate 2576/2576 (960×640 + 1280×800, en+de, incl. split-button four states), annot-smoke 16/16, real-input smoke PASS; macOS via CI only. Smart-link coverage on the three footnote files 100/100/90.5 %.
- [ ] F19.28 Smart-link back navigation restores horizontal scroll 0 instead of 17 px when the page is 33 px wider than the viewport (v16-smartlinks "footnote p6", two fix attempts; small).
