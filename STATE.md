# STATE
phase: v1.2 Redesign "sheer." (docs/REDESIGN_BRIEF.md, ADR-100, wave plan ADR-101)
version: 1.1.0
current_item: wave 6 (ADR-102 + F14) running — SH-1 mode row/tool row/grid, SH-2 Windows menu row, SH-3 properties mini bar, SH-4 Lesen tools (hand, text select, magnifier)
last_completed: waves 4–5 (Home, top bar, sidebar, R3.4, R4.3, R4.4; 4cf4610); smoke 16/16 on the wave 4 layout
loop_count_this_session: 0
open_blockers: 3 human-only (B-001, B-002, B-005)
notes: Owner: after the shell package build the installer locally (npm run tauri build → NSIS), then STOP for feedback; R5 only after it (ADR-102).
  F14 (FEEDBACK) is the binding tool table; DESIGN v2 §3.2–§3.4 is the spec. Right tool sidebar is gone; Windows menu row is back.
  Stop the dev window (taskkill sheer.exe) before agents run cargo test. Window shots: node scripts/ui/dev.mjs → shot.ps1.
