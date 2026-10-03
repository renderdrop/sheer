# STATE
phase: M1
version: 0.3.0
current_item: ROADMAP M1 "Outline (bookmarks) panel" (docs/FEEDBACK.md F1-F5 all done)
last_completed: FEEDBACK F1-F5 - reviews+fixes, mood (8f0781f), motion (931d017, 7a02c1a), welcome tour scaffold (5cc78fd); all designer PASS from Tauri-window captures
loop_count_this_session: 0
open_blockers: 1 (B-001 macOS/CI unverified — needs a GitHub remote or a Mac)
notes: docs/FEEDBACK.md (product owner) has priority over ROADMAP.md (ORCHESTRATOR_PROMPT §14); the Stop hook reads it first.
  Visual review = screenshots/recordings from the real Tauri window via scripts/ui/ (docs/UI_REVIEW.md), designer verdict PASS/FIX.
  Known open: forced-colors untested; text/link coords are unrotated page space (viewer must apply /Rotate); native link-confirm
  dialog + opener never run live. Run `npm run check` from Git Bash. Rust in ~/.cargo/bin.
