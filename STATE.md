# STATE
phase: M1
version: 0.3.0
current_item: docs/FEEDBACK.md F1 (fix review findings of b72fbf9..HEAD), then F2 mood, F3 motion, F4 onboarding scaffold; then ROADMAP
last_completed: M1 items 2+3 — render pipeline, zoom/fit, scroll modes (b72fbf9); wip(m1) commit reviewed 2026-10-03
loop_count_this_session: 0
open_blockers: 1 (B-001 macOS/CI unverified — needs a GitHub remote or a Mac)
notes: docs/FEEDBACK.md (product owner) has priority over ROADMAP.md (ORCHESTRATOR_PROMPT §14); the Stop hook reads it first.
  Visual review = screenshots/recordings from the real Tauri window via scripts/ui/ (docs/UI_REVIEW.md), designer verdict PASS/FIX.
  Known open: forced-colors untested; text/link coords are unrotated page space (viewer must apply /Rotate); native link-confirm
  dialog + opener never run live. Run `npm run check` from Git Bash. Rust in ~/.cargo/bin.
