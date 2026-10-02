# STATE
phase: 3
version: 0.2.0
current_item: Design spec: component specs in docs/DESIGN.md (designer), applying ADR-011
last_completed: Tooling: scripts/check.sh, scripts/bump-version.sh, CI (macOS + Windows), Dependabot (tag v0.2.0)
loop_count_this_session: 0
open_blockers: 0
notes: Run `npm run check` / `npm run fetch-pdfium` from Git Bash (in PowerShell `bash` may resolve to WSL). Rust in ~/.cargo/bin.
  Custom agent types need a session restart; until then general-purpose + ROLE block (ADR-000 §8).
  ESLint lives in npm workspace tools/lint (typescript-eslint needs TS 6; app uses TS 7).
  Open M1 follow-ups: open-by-handle (TOCTOU), orphaned engine doc when a timed-out open finishes (worker.rs).
  Only win-x64 PDFium has been run; mac pins untested until CI runs on GitHub (no remote configured yet).
