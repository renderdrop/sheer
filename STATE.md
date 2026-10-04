# STATE
phase: M7
version: 0.9.0
current_item: M7 W0 seams (ADR-053) + onboarding/tips running; v0.9.0 release commit 4706a0b pushed, tag waits for its CI run (37170218415) to be green on both platforms. Then W1 B1 engine process | B2 autosave | B3 updater | B4 packaging/CSP/bench
last_completed: M6 Convert and output released as v0.9.0 (tag v0.9.0)
loop_count_this_session: 0
open_blockers: 2 (B-001 UI never seen on a Mac, macOS keychain untested; B-002 code signing)
notes: Repository renderdrop/sheer is public (ADR-046). CI: every push to main runs Windows + macOS (docs-only skipped); tags run only release.yml. Read CI once per milestone, never wait (ADR-030).
  M5 close: tester PASS, security PASS (medium fixed: import_warnings capability + declared-vs-granted test), designer PASS, CI 37159379280 green on both platforms, local debug build ok.
  FEEDBACK (product owner) before ROADMAP (§14). Push after every commit. Designer review: one round, only blockers → fix.
  Window review: scripts/ui (docs/UI_REVIEW.md); the doc-tab close button and the window close share the label "Schließen" — target the tab's own button.
  Run `npm run check` from Git Bash. Rust in ~/.cargo/bin.
