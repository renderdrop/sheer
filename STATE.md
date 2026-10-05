# STATE
phase: v1.2 Redesign "sheer." — R7 release gate (owner feedback F15 complete; R1–R6 and Politur v1.2 done)
version: 1.2.0-beta.1 (pre-release, tag v1.2.0-beta.1, ADR-103); next tag v1.2.0
current_item: R7 — all gates green except one flaky macOS CI vitest run (unhandled error from Comments.test.tsx, being hardened); then bump 1.2.0, CHANGELOG [1.2.0] (prepared, uncommitted), tag v1.2.0, push
last_completed: R7 designer review vs BRAND §2 PASS, smoke 16/16, CSP gates 0/0, full security audit PASS, stale text-comment frame fixed
loop_count_this_session: 0
open_blockers: 2 human-only (B-002, B-005)
notes: Owner re-check on the Mac after v1.2.0: A10 "Save as PDF" in the print dialog. Screenshot series docs/review/v1.2/ (not tracked), motion recordings docs/review/v1.2/motion/.
  After v1.2.0: "Politur v1.3" (ROADMAP, carried minors), then the v1.3 "Citations" spec. Never run the dev window while agents run cargo/vitest;
  stop it with taskkill sheer.exe + Stop-Process on tauri.js/vite.js only. Acceptance helpers in the session scratchpad (keys.ps1, wheel.ps1, shotsize.ps1, dnd.ps1 with topmost guard).
