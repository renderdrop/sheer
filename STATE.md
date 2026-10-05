# STATE
phase: v1.2.0 released — Politur v1.3 done; next: v1.3 "Citations" spec
version: 1.2.0 (tag v1.2.0)
current_item: v1.3 acceptance — frontend review running, NSIS build for the mouse acceptance of DESIGN §3.7 AC 1–24, then designer round, tag v1.3.0
last_completed: Politur v1.3 (446a6d9, 1656ac6, af7091d; reviewer PASS)
loop_count_this_session: 0
open_blockers: 2 human-only (B-002, B-005)
notes: v1.3 W0 + C1–C4 + backend FIX (bf67d9f) + F1–F4 (3bffd59, 885d219, 40851fa, 97cba77) committed; check 17/17; security-reviewer PASS on the backend (medium items fixed in bf67d9f).
  Owner re-check on the Mac after v1.2.0: A10 "Save as PDF" in the print dialog. Screenshot series docs/review/v1.2/ (not tracked), motion recordings docs/review/v1.2/motion/.
  After v1.2.0: "Politur v1.3" (ROADMAP, carried minors), then the v1.3 "Citations" spec. Never run the dev window while agents run cargo/vitest;
  stop it with taskkill sheer.exe + Stop-Process on tauri.js/vite.js only. Acceptance helpers in the session scratchpad (keys.ps1, wheel.ps1, shotsize.ps1, dnd.ps1 with topmost guard).
