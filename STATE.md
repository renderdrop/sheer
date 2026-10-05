# STATE
phase: v1.3.0 released (tag v1.3.0, CI #68 green) — next: v1.4 "Certificate signature"
version: 1.3.0 (tag v1.3.0)
current_item: SESSION TOPIC (ADR-122): v1.4 — acceptance done (15/24 by mouse, rest tests); milestone-end reviewer, designer, tester running; CI #74 (race fix) pending. Then bump 1.4.0, CHANGELOG, tag after green CI, release, German report docs/reports/2026-10-05-v1.4-zertifikatsignatur.md, STOP
last_completed: v1.3 Citations — 24/24 AC in the installed build, tester/security/designer PASS
loop_count_this_session: 0
open_blockers: 2 human-only (B-002, B-005)
notes: ADR-120: every loop starts with `bash scripts/ci-status.sh` (last completed run on main, never wait); red = fix first. v1.4 W0 2a1e3f3 (stable RustCrypto line), seam 586feeb. Release v1.3.0 published.
  Owner re-check on the Mac after v1.2.0: A10 "Save as PDF" in the print dialog. Screenshot series docs/review/v1.2/ (not tracked), motion recordings docs/review/v1.2/motion/.
  After v1.2.0: "Politur v1.3" (ROADMAP, carried minors), then the v1.3 "Citations" spec. Never run the dev window while agents run cargo/vitest;
  stop it with taskkill sheer.exe + Stop-Process on tauri.js/vite.js only. Acceptance helpers in the session scratchpad (keys.ps1, wheel.ps1, shotsize.ps1, dnd.ps1 with topmost guard).
