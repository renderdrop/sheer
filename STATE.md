# STATE
phase: v1.2 Redesign "sheer." (docs/REDESIGN_BRIEF.md, ADR-100, wave plan ADR-101)
version: 1.1.0
current_item: STOPPED at the owner checkpoint (ADR-102): waiting for the owner's feedback on the installer build; R5 only after it
last_completed: wave 6 (modes + F14 tool row, Windows menu row, mini bar, Lesen tools) + tour/lint fix (686caf0); installer Sheer_1.1.0_x64-setup.exe built
loop_count_this_session: 0
open_blockers: 3 human-only (B-001, B-002, B-005)
notes: .claude/state/STOP is set on purpose (owner: build the installer, then STOP). Next session: read the owner feedback (FEEDBACK.md F15?),
  delete .claude/state/STOP, then continue. Open after feedback: R1/R2/R3/R4 acceptance rounds on the ADR-102 layout, R5 spells, R6, Politur v1.2, R7.
  Installer is unsigned and still versioned 1.1.0 (no bump before the v1.2.0 tag, so the updater offers 1.2.0 later). Smoke 16/16 on the mode layout.
  Stop the dev window (taskkill sheer.exe) before agents run cargo test. Window shots: node scripts/ui/dev.mjs → shot.ps1.
