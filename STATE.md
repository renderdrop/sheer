# STATE
phase: M1
version: 0.3.0
current_item: ROADMAP M1 "Full-text search with hit highlight and next/previous" (backend search API exists, ADR-019)
last_completed: M1 Outline panel (see git log); before: FEEDBACK F1-F5 all done (07771b1)
loop_count_this_session: 25 (cap reached, session stopped per ORCHESTRATOR §12.2)
open_blockers: 1 (B-001 macOS/CI unverified — needs a GitHub remote or a Mac)
notes: docs/FEEDBACK.md (product owner) has priority over ROADMAP.md (ORCHESTRATOR_PROMPT §14); the Stop hook reads it first.
  Visual review = screenshots/recordings from the real Tauri window via scripts/ui/ (docs/UI_REVIEW.md), designer verdict PASS/FIX.
  Known open: forced-colors untested; text/link coords are unrotated page space (viewer must apply /Rotate); native link-confirm
  dialog + opener never run live. Run `npm run check` from Git Bash. Rust in ~/.cargo/bin.
