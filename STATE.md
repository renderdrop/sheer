# STATE
phase: 3
version: 0.2.0
current_item: App shell layout grid: toolbar, left panel, canvas, inspector slot, status bar, scroll-edge scrim
last_completed: Primitives I + II and Hardening (see git log)
loop_count_this_session: 4
open_blockers: 1 (B-001 macOS/CI unverified — needs a GitHub remote or a Mac)
notes: Run `npm run check` / `npm run fetch-pdfium` from Git Bash (in PowerShell `bash` may resolve to WSL). Rust in ~/.cargo/bin.
  Custom agent types need a session restart; until then general-purpose + ROLE block (ADR-000 §8).
  ESLint lives in npm workspace tools/lint (typescript-eslint needs TS 6; app uses TS 7).
  Primitives in src/components (barrel index.ts, softDisabled.ts, tokens.ts mirror); dev showcase at #showcase.
  Open M1 follow-ups: open-by-handle (TOCTOU), orphaned engine doc when a timed-out open finishes (worker.rs).
