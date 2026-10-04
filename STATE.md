# STATE
phase: v1.2 Redesign "sheer." (docs/REDESIGN_BRIEF.md, ADR-100, wave plan ADR-101)
version: 1.1.0
current_item: wave 4 running — W-Home (R2), W-TopBar (R3.1), W-Tools (R3.3), W-Sidebar (R3.2 + canvas + comments tab)
last_completed: wave 3 (shell skeleton 91b7869, R4.1/R4.2 primitives, R1.5 + brand fixes)
loop_count_this_session: 0
open_blockers: 3 human-only (B-001, B-002, B-005)
notes: Next wave 4 fills the skeleton slots: Home (R2), top bar (R3.1), tool sidebar (R3.3), page sidebar + canvas (R3.2).
  Then wave 5: R3.4 (form banner, selection popover, comments tab, redact band), R4.3 palette + signature sheet, R4.4 contrast + /dev/components.
  Designer rounds: R2 + R3 after wave 4, R4 after wave 5. Stop the dev window (taskkill sheer.exe) before agents run cargo test.
  Window shots: node scripts/ui/dev.mjs (bg) → wait for :9222 → shot.ps1 → src-tauri/target/debug/sheer.exe <pdf> opens a file.
