# STATE
phase: M7
version: 0.9.0
current_item: M7 backend wave running (ADR-053): B1 engine process | B2 autosave | B3 updater (placeholder key, private key = human, BLOCKERS) | B4 packaging/CSP/bench. Done: W0 a8da321, tour + tips bc63805. Then F1 recovery UI | F2 updater UI | F3 performance | F4 CSP sweep/default app; W3 accessibility, i18n, recents thumbnails; Politur M7
last_completed: v0.9.0 (tag on 4706a0b; candidate CI 37170218415 green on Windows + macOS; release built)
loop_count_this_session: 0
open_blockers: 2 (B-001 UI never seen on a Mac, macOS keychain untested; B-002 code signing)
notes: Repository renderdrop/sheer is public (ADR-046). CI: every push to main runs Windows + macOS (docs-only skipped); tags run only release.yml. Read CI once per milestone, never wait (ADR-030).
  M5 close: tester PASS, security PASS (medium fixed: import_warnings capability + declared-vs-granted test), designer PASS, CI 37159379280 green on both platforms, local debug build ok.
  FEEDBACK (product owner) before ROADMAP (§14). Push after every commit. Designer review: one round, only blockers → fix.
  Window review: scripts/ui (docs/UI_REVIEW.md); the doc-tab close button and the window close share the label "Schließen" — target the tab's own button.
  Run `npm run check` from Git Bash. Rust in ~/.cargo/bin.
