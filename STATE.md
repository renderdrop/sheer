# STATE
phase: M6
version: 0.8.1
current_item: M6 UI committed (06a7ef7). Running: U2b image list/thumbnails/reorder (backend+UI), reviews U1/U3/U4. Then U2 review, tick M6, Politur M6, milestone end (tester, security, annot-smoke, print gate, designer, CI, 0.9.0)
last_completed: v0.8.1 — FEEDBACK F9 (annotation input) + F10 (vector signatures) for the owner re-test; M6 backend on main (8972856)
loop_count_this_session: 0
open_blockers: 2 (B-001 UI never seen on a Mac, macOS keychain untested; B-002 code signing)
notes: Repository renderdrop/sheer is public (ADR-046). CI: every push to main runs Windows + macOS (docs-only skipped); tags run only release.yml. Read CI once per milestone, never wait (ADR-030).
  M5 close: tester PASS, security PASS (medium fixed: import_warnings capability + declared-vs-granted test), designer PASS, CI 37159379280 green on both platforms, local debug build ok.
  FEEDBACK (product owner) before ROADMAP (§14). Push after every commit. Designer review: one round, only blockers → fix.
  Window review: scripts/ui (docs/UI_REVIEW.md); the doc-tab close button and the window close share the label "Schließen" — target the tab's own button.
  Run `npm run check` from Git Bash. Rust in ~/.cargo/bin.
