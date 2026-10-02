# STATE
phase: M1
version: 0.3.0
current_item: Document registry with IDs; open via dialog, native drag and drop, file association; open-by-handle …
last_completed: Phase 3 — design system + app shell (tag v0.3.0)
loop_count_this_session: 9
open_blockers: 1 (B-001 macOS/CI unverified — needs a GitHub remote or a Mac)
notes: Run `npm run check` / `npm run fetch-pdfium` from Git Bash (in PowerShell `bash` may resolve to WSL). Rust in ~/.cargo/bin.
  Custom agent types need a session restart; until then general-purpose + ROLE block (ADR-000 §8).
  Visual check: `.claude/launch.json` "sheer-web" serves the UI on :1420 (no Tauri backend; empty state renders).
  Debug bundles build (MSI + NSIS). Actions registry src/actions; overlays mounted in ToolbarSlot; dismiss order components/dismiss.ts.
  M1 follow-ups are inside the M1 checkbox texts (TOCTOU, orphaned doc, menu greying, zoom disabled without doc).
