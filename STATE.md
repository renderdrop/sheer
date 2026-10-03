# STATE
phase: M1
version: 0.3.0
current_item: REVIEW the wip(m1) commit (engine read APIs + thumbnails), then Outline panel (M1 item 5)
last_completed: M1 items 2+3 — render pipeline, zoom/fit, scroll modes (b72fbf9); then wip(m1) commit, unreviewed
loop_count_this_session: 13
open_blockers: 1 (B-001 macOS/CI unverified — needs a GitHub remote or a Mac)
notes: WIP, UNREVIEWED: the latest commit "wip(m1): engine read APIs + thumbnails (unreviewed)" passed `npm run check` (15/15) but had
  NO tester, reviewer or security-reviewer run (user instruction, 2026-10-03). Next session first: tester + reviewer + security-reviewer
  on `git diff b72fbf9..HEAD` (new IPC: get_outline, get_text_layer, search/cancel_search, get_page_links, open_link; new dep
  tauri-plugin-opener; ADR-019), fix findings, then tick "Thumbnails panel (lazy)" in ROADMAP.md (left unticked on purpose).
  Known open: thumbnails tabpanel is an extra Tab stop; forced-colors untested; text/link coords are unrotated page space (viewer must
  apply /Rotate); native link-confirm dialog + opener never run live. Run `npm run check` from Git Bash. Rust in ~/.cargo/bin.
  Session was PAUSED by the user: `.claude/state/STOP` exists (gitignored) — delete it to resume the autonomous loop.
