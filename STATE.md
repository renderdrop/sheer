# STATE
phase: M7
version: 0.9.0
current_item: M7 last wave running: security politur (T8 navigation guard, D1/D6/P4/T2, thumbnail command) | accessibility part 2 (F6 regions, live regions, forced colors) | UI minors + CSP gate coverage | fps zoom/panel measurement. Then milestone end: tester, full security audit, annot-smoke, csp gate, print gate, designer, CI, v1.0.0, DONE
last_completed: v0.9.0 (tag on 4706a0b; candidate CI 37170218415 green on Windows + macOS; release built)
loop_count_this_session: 0
open_blockers: 2 (B-001 UI never seen on a Mac, macOS keychain untested; B-002 code signing)
notes: Repository renderdrop/sheer is public (ADR-046). CI: every push to main runs Windows + macOS (docs-only skipped); tags run only release.yml. Read CI once per milestone, never wait (ADR-030).
  M5 close: tester PASS, security PASS (medium fixed: import_warnings capability + declared-vs-granted test), designer PASS, CI 37159379280 green on both platforms, local debug build ok.
  FEEDBACK (product owner) before ROADMAP (§14). Push after every commit. Designer review: one round, only blockers → fix.
  Window review: scripts/ui (docs/UI_REVIEW.md); the doc-tab close button and the window close share the label "Schließen" — target the tab's own button.
  Run `npm run check` from Git Bash. Rust in ~/.cargo/bin.
