# STATE
phase: v1.2 Redesign "sheer." — owner feedback F15 (docs/FEEDBACK.md, ADR-104): A bug patch → B shell polish → mode-layout designer acceptance → R5 → v1.2.0
version: 1.2.0-beta.1 (pre-release, tag v1.2.0-beta.1, ADR-103)
current_item: F15 A wave — P-A1 (A1–A3 canvas visuals), P-A2 (A4 drag in any tool, A8 rotation + rotate handle, ADR-105), P-A3 (A5–A7, ADR-106), P-A4 (A9 keychain, A10 macOS print, ADR-107)
last_completed: F15 recorded, B-001 closed, v1.3–v1.8 tickets, B design spec DESIGN §3.5 + ADR-108 (6ee5724)
loop_count_this_session: 0
open_blockers: 2 human-only (B-002, B-005)
notes: After the A wave: security-reviewer on the A diff, local NSIS build, install, mouse acceptance per item (scripts/ui/mouse.ps1, review/f15/).
  B wave builds from DESIGN §3.5; B7 fonts = Ms Madi (default), Hurricane, Birthstone (owner pick, ADR-108; TTFs in google/fonts ofl/).
  B3 before-shot: review/f15/b3-before.png (installed beta). Installed app: %LOCALAPPDATA%\Sheer\sheer.exe.
  Stop the dev window (taskkill sheer.exe) before agents run cargo test. Window shots: node scripts/ui/dev.mjs → shot.ps1.
