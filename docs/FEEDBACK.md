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
