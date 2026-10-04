# STATE
phase: M6
version: 0.8.0
current_item: FEEDBACK first: F9 done (c77300e); F10 vector signatures running (backend + frontend, ADR-051); then window acceptance (200 % screenshot, saved PDF at 400 %), annot-smoke, tag v0.8.1 (includes the not-yet-exposed M6 backend). Then M6 UI seams + UI wave
last_completed: M5 Edit and protect released as v0.8.0 (tag v0.8.0)
loop_count_this_session: 0
open_blockers: 2 (B-001 UI never seen on a Mac, macOS keychain untested; B-002 code signing)
notes: Repository renderdrop/sheer is public (ADR-046). CI: every push to main runs Windows + macOS (docs-only skipped); tags run only release.yml. Read CI once per milestone, never wait (ADR-030).
  M5 close: tester PASS, security PASS (medium fixed: import_warnings capability + declared-vs-granted test), designer PASS, CI 37159379280 green on both platforms, local debug build ok.
  FEEDBACK (product owner) before ROADMAP (§14). Push after every commit. Designer review: one round, only blockers → fix.
  Window review: scripts/ui (docs/UI_REVIEW.md); the doc-tab close button and the window close share the label "Schließen" — target the tab's own button.
  Run `npm run check` from Git Bash. Rust in ~/.cargo/bin.
