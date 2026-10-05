# STATE
phase: v1.2.0 released — Politur v1.3 done; next: v1.3 "Citations" spec
version: 1.2.0 (tag v1.2.0)
current_item: CI red on macOS since #61 (owner F16): fixed in 7380b68, waiting for run #67 to be green; v1.3 work paused until main is green (ADR-120)
last_completed: Politur v1.3 (446a6d9, 1656ac6, af7091d; reviewer PASS)
loop_count_this_session: 0
open_blockers: 2 human-only (B-002, B-005)
notes: ADR-120: every loop starts with `bash scripts/ci-status.sh` (last completed run on main, never wait); red = fix first. v1.3 acceptance round 2 in progress after the FIX packages A–D (d15cac3, ed59df9, 94444b6, c2efc5e): selection to line end OK, rule after reopen OK; still to re-test: tag-delete undo (console hooked), Year field, Reference from empty Comments, error toast, aria labels. v1.3 W0 + C1–C4 + F1–F4 committed; security-reviewer PASS on the backend.
  Owner re-check on the Mac after v1.2.0: A10 "Save as PDF" in the print dialog. Screenshot series docs/review/v1.2/ (not tracked), motion recordings docs/review/v1.2/motion/.
  After v1.2.0: "Politur v1.3" (ROADMAP, carried minors), then the v1.3 "Citations" spec. Never run the dev window while agents run cargo/vitest;
  stop it with taskkill sheer.exe + Stop-Process on tauri.js/vite.js only. Acceptance helpers in the session scratchpad (keys.ps1, wheel.ps1, shotsize.ps1, dnd.ps1 with topmost guard).
