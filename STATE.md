# STATE
phase: M7 (release candidate 1.0.0)
version: 1.0.0
current_item: tag v1.0.0 on the release commit once its CI run is green on both platforms, then .claude/state/DONE (stop condition 1)
last_completed: M7 Polish and ship — all ROADMAP items [x]; tester PASS, full security audit PASS, annot-smoke 16/16, CSP gate 0/0, print gate ok, designer PASS
loop_count_this_session: 0
open_blockers: 2 (B-001 UI never seen on a Mac, macOS keychain untested; B-002 code signing)
notes: Repository renderdrop/sheer is public (ADR-046). CI: every push to main runs Windows + macOS (docs-only skipped); tags run only release.yml. Read CI once per milestone, never wait (ADR-030).
  M5 close: tester PASS, security PASS (medium fixed: import_warnings capability + declared-vs-granted test), designer PASS, CI 37159379280 green on both platforms, local debug build ok.
  FEEDBACK (product owner) before ROADMAP (§14). Push after every commit. Designer review: one round, only blockers → fix.
  Window review: scripts/ui (docs/UI_REVIEW.md); the doc-tab close button and the window close share the label "Schließen" — target the tab's own button.
  Run `npm run check` from Git Bash. Rust in ~/.cargo/bin.
