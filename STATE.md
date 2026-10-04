# STATE
phase: v1.2 Redesign "sheer." — owner feedback F15 (docs/FEEDBACK.md, ADR-104): A bug patch → B shell polish → mode-layout designer acceptance → R5 → v1.2.0
version: 1.2.0-beta.1 (pre-release, tag v1.2.0-beta.1, ADR-103)
current_item: F15 A acceptance in the installed build + B wave 1 (P-B2 B4/B5 ADR-110, P-B3 B6/B7 ADR-111, P-B4 B9/B10 ADR-112) + A11 save-hang fix (ADR-109)
last_completed: A1–A10 fixes, A6 engine short-read fix, B1–B3 (19f4345)
loop_count_this_session: 0
open_blockers: 2 human-only (B-002, B-005)
notes: Accepted with the mouse in the installed build: A1, A4, A7, A8 placement upright + rotate handle, A9 (Windows: library survives restart).
  Re-check after the next build: A2/A3 (overlay multiply), A5 (panel frame width), A6 (grey bottom → engine reads), A8 save/reopen, A10 print (Windows), A11.
  Then B wave 2: B8 outline, B11 arrow + shape recognition, B12 canvas drift. Minors: images-to-PDF orientation segments collide; signature menu thumbs overlap rows.
  Installed app: %LOCALAPPDATA%\Sheer\sheer.exe; helpers in the session scratchpad (keys.ps1, wheel.ps1). Do not run the dev window while agents run cargo/vitest.
