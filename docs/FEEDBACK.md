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

- [x] designer (Opus) writes `docs/MOTION.md`: one spring curve for everything, three durations (120/200/320 ms), rules for enter, exit and
      layout change, and a catalogue of micro-interactions: buttons with press and hover response; panels slide instead of appearing; pages
      load with a fade instead of a jump; zoom with inertia and snap to fit steps; drag and drop with a preview card that drops into the
      window; opening fades from thumbnail to page; success moments as a subtle Iris pulse instead of a dialog. Budget: 60 fps in the Tauri
      window, blur only on toolbar and panels, never on the document canvas; reduced motion switches to fades
- [x] implementer applies the motion system (9834c69, 97ebe64, 931d017)
- [x] Acceptance by screen recording from the Tauri window; 60 fps measured (designer PASS round 3; 7a02c1a)

## F4 — Onboarding

On first launch a bundled "Welcome to Sheer.pdf" opens (own template, Iris design, 4–5 pages). Every page is a task: navigate, zoom,
highlight, comment, drag a signature, reorder pages. Coach marks point at the tool; when the user completes the task, a short success
moment follows, then the next step. Progress in the status bar, skippable, restartable in Settings, never shown automatically twice.

- [x] Scaffold in M1: welcome document, coach-mark component, step engine, steps Open / Navigate / Zoom (designer PASS round 3; 7ea748c, 9044be8, 5cc78fd)
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

- [ ] `.github/workflows/release.yml`: on every tag push `v*`, build the installers on Windows and macOS (NSIS setup and DMG, unsigned) and attach them
      to a GitHub Release whose body is the tag's section from CHANGELOG.md
- [ ] Build the existing tag v0.4.0 with it after the fact (workflow_dispatch with a tag input; never move or re-push a tag)
