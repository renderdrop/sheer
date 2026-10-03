# FEEDBACK

Product-owner feedback (2026-10-03). Open items here take precedence over `ROADMAP.md` (ORCHESTRATOR_PROMPT §14).
Work them in order; tick `[x]` when done. The Stop hook reads the first open `- [ ]` line of this file before the roadmap.

## F1 — Catch up on reviews

- [x] tester, reviewer and security-reviewer on `b72fbf9..HEAD` (engine read APIs + thumbnails): tester PASS (no gaps); reviewer
      PASS, then a deeper frontend pass FIX (2 major in `src/api/search.ts`); security FAIL only on `cargo deny` run without
      `--target` (Linux-only GTK advisories; `check.sh` checks the shipped targets, ADR-017) + 2 low
- [x] Fix the findings (blocker/major, critical/high); tick "Thumbnails panel (lazy)" in ROADMAP.md (cbb7a98, 1bc4854)

## F2 — Mood: the app looks grey, empty and lifeless

The §3 rule "gradient barely visible" is overruled (ADR). Target: the mood of the reference image, with one hue.

- [x] designer (Opus) writes a mood spec with concrete token changes: background gradient clearly visible (iris-100 → iris-50, 135°), glass
      surfaces slightly iris-tinted instead of pure white, icon tiles on iris-100, soft coloured shadows (Iris 12 %), empty state with a large,
      gently floating logo sheet as the focal point, toolbar with visible translucency over the gradient; ADR
- [x] implementer applies the spec (light + dark, glass fallback, reduced motion)
- [x] Acceptance by screenshots from the Tauri window (not the browser): light + dark, empty state + document; designer verdict PASS (2nd round)

## F3 — Motion system

- [ ] designer (Opus) writes `docs/MOTION.md`: one spring curve for everything, three durations (120/200/320 ms), rules for enter, exit and
      layout change, and a catalogue of micro-interactions: buttons with press and hover response; panels slide instead of appearing; pages
      load with a fade instead of a jump; zoom with inertia and snap to fit steps; drag and drop with a preview card that drops into the
      window; opening fades from thumbnail to page; success moments as a subtle Iris pulse instead of a dialog. Budget: 60 fps in the Tauri
      window, blur only on toolbar and panels, never on the document canvas; reduced motion switches to fades
- [ ] implementer applies the motion system
- [ ] Acceptance by screen recording from the Tauri window; 60 fps measured

## F4 — Onboarding

On first launch a bundled "Welcome to Sheer.pdf" opens (own template, Iris design, 4–5 pages). Every page is a task: navigate, zoom,
highlight, comment, drag a signature, reorder pages. Coach marks point at the tool; when the user completes the task, a short success
moment follows, then the next step. Progress in the status bar, skippable, restartable in Settings, never shown automatically twice.

- [ ] Scaffold in M1: welcome document, coach-mark component, step engine, steps Open / Navigate / Zoom
- [x] Tickets for the remaining steps: highlight + comment (M2), reorder pages (M3), drag a signature (M4)

## F5 — Installer

- [x] Ticket in M7: NSIS target with own header and sidebar images in Iris, Sheer icon, no WiX default dialog

After F1–F5: continue with the roadmap.
