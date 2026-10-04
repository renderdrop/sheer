# STATE
phase: v1.2 Redesign "sheer." (docs/REDESIGN_BRIEF.md, ADR-100)
version: 1.1.0
current_item: Package 0 (designer: DESIGN.md v2 + MOTION.md v2) and B1 (favourites + reveal, backend) running in parallel
last_completed: v1.1.0 (c086f82, tag v1.1.0)
loop_count_this_session: 0
open_blockers: 3 human-only (B-001, B-002, B-005)
notes: FEEDBACK.md has no F13 at v1.2 start, so the brief's R0–R7 order rules. Package 0 blocks all visual work (R0+).
  Planned R0 wave (4 parallel): P-A tokens.css + legacy aliases; P-B dark/glass removal (settings Rust+TS, popover, scripts);
  P-C Inter + type scale + lint gate; P-D Icon audit + BrandSurface/WorkSurface/SolarGlow. Per-phase designer round (brief §3).
  Acceptance recipe (window): node scripts/ui/dev.mjs → shot.ps1 / cdp.mjs; installed build: tauri build → NSIS /S → mouse.ps1.
