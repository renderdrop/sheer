# STATE
phase: M6
version: 0.8.1
current_item: M6 UI wave running: U1 export images | U2 images to PDF | U3 print | U4 export copy (seams 2ea43ed; backend reviews all PASS). Then reviews, tick M6, Politur M6 (ROADMAP list), milestone end incl. annot-smoke and print gate (print a 3-page fixture to Microsoft Print to PDF)
last_completed: v0.8.1 — FEEDBACK F9 (annotation input) + F10 (vector signatures) for the owner re-test; M6 backend on main (8972856)
loop_count_this_session: 0
open_blockers: 2 (B-001 UI never seen on a Mac, macOS keychain untested; B-002 code signing)
notes: Repository renderdrop/sheer is public (ADR-046). CI: every push to main runs Windows + macOS (docs-only skipped); tags run only release.yml. Read CI once per milestone, never wait (ADR-030).
  M5 close: tester PASS, security PASS (medium fixed: import_warnings capability + declared-vs-granted test), designer PASS, CI 37159379280 green on both platforms, local debug build ok.
  FEEDBACK (product owner) before ROADMAP (§14). Push after every commit. Designer review: one round, only blockers → fix.
  Window review: scripts/ui (docs/UI_REVIEW.md); the doc-tab close button and the window close share the label "Schließen" — target the tab's own button.
  Run `npm run check` from Git Bash. Rust in ~/.cargo/bin.
