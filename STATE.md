# STATE
phase: M2
version: 0.4.0
current_item: M2 wave (ADR-030: four implementers) P5–P8 running + FEEDBACK F7 release workflow; then Politur M2 + milestone end
last_completed: M2 P4 annotation model + undo (7ef660d); ADR-030 tempo level 2 (4e589db)
loop_count_this_session: 0
open_blockers: 1 (B-001: macOS CI green; the UI has never been seen running on a Mac)
packages:
  P5 layer: src/features/annotations/{layer,selection}/, src/stores/tools.ts, toolbar entries, PageView mount
  P6 create: src/features/annotations/create/ (CreationLayer contract)
  P7 inspector: src/features/inspector/, src/features/annotations/note/, selection slice in src/stores/annotations.ts, settings authorName
  P8 save: Rust writer + save commands, src/features/save/, src/api/save.ts, interop tests
  F7: .github/workflows/release.yml, scripts/changelog-section.sh; then `gh workflow run` for v0.4.0
notes: FEEDBACK (product owner) before ROADMAP (§14). Push after every commit; CI checked once per milestone, never wait (ADR-030).
  Designer review: one round, only blockers → fix. fps + onboarding steps in M7. Should/Could → v1.1 backlog ([~]).
  Run `npm run check` from Git Bash. Rust in ~/.cargo/bin.
