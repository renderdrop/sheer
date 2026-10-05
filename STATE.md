# STATE
phase: v1.2 Redesign "sheer." — owner feedback F15 (docs/FEEDBACK.md, ADR-104): A + B built and accepted with the mouse; designer acceptance of the mode layout running; then R5 → R6 → Politur v1.2 → R7 / v1.2.0
version: 1.2.0-beta.1 (pre-release, tag v1.2.0-beta.1, ADR-103)
current_item: R5 motion spells — four packages in parallel: R5-A (1, 16, 18, 21), R5-B (3, 8, 12, 15, 17), R5-C (2, 5, 7, 9), R5-D (4, 6, 10, 11, 14, 22); 13 and 20 exist
last_completed: F15 complete; R1–R4 acceptance (smoke 16/16, ADR-116, ADR-117), MOTION spells 1 and 14 adapted to ADR-102
loop_count_this_session: 0
open_blockers: 2 human-only (B-002, B-005)
notes: Owner re-check on the Mac: A10 "Save as PDF" in the print dialog (next pre-release). Signature fonts per owner: Ms Madi, Hurricane, Birthstone.
  Acceptance helpers in the session scratchpad (keys.ps1, wheel.ps1, shotsize.ps1 with -ClientW/-ClientH). Never run the dev window while agents run cargo/vitest;
  stop it with taskkill sheer.exe + Stop-Process on tauri.js/vite.js only (do not match "vite" broadly — it kills vitest runs).
  Minors of the F15 rounds are in ROADMAP "Politur v1.2".
