# Sheer

Sheer is an open-source, local-only desktop PDF app for macOS and Windows (Tauri 2 + React 19/TS + PDFium via pdfium-render).
It covers everyday Acrobat-class tasks (view, annotate, edit, organize, forms, sign, convert) with a restrained liquid-glass UI in one accent hue ("Iris").
Work is orchestrated autonomously per `ORCHESTRATOR_PROMPT.md`; resume state lives in `STATE.md` and `ROADMAP.md`.

## Commands

- `npm run check` — typecheck, lint, vitest, clippy -D warnings, cargo test, cargo deny, npm audit
- `npm run tauri dev` — run the app
- `cargo test` (in `src-tauri/`) — Rust tests only
- Rust lives in `~/.cargo/bin` (may not be on PATH); scripts prepend it.

## Rules (short)

1. No questions. Decide, record in `docs/DECISIONS.md`, continue.
2. Dependencies: permissive only (MIT, Apache-2.0, BSD, ISC, MPL-2.0, Zlib). No GPL/AGPL/LGPL deps. Log each in `docs/LICENSES.md`.
3. No Adobe branding, icons, names, screenshots or layout copies.
4. Local only: no backend, login, accounts, telemetry, cloud AI or network (except the opt-in updater module).
5. Signatures: visual (draw/type/image) + optional self-signed digital later. No eIDAS QES.
6. English for code, commits, docs, tests. UI strings via i18n (en, de). Exception: session reports in `docs/reports/` are German (ADR-122).
7. Token discipline beats perfection. Finished > perfect.
8. Nothing overlaps in the UI; every surface has a slot in the layout grid.
9. No Claude Code mods, plugins or MCP servers.
10. Own code is AGPL-3.0-or-later; name + logo are trademarks (`TRADEMARK.md`); DCO sign-off for contributions.
11. Security is part of done: `security-reviewer` PASS before every milestone tag. Every PDF is hostile input.
12. CI before every push (ADR-120, corrected): read the last completed CI run on main (`bash scripts/ci-status.sh`, never wait); red from an own commit = fix first. If the own last push is still running, push anyway and read that run (`scripts/ci-status.sh <run-id>`) before the next push. Log every package commit with its CI run in STATE.md `ci_log`. Green CI is part of every package's DoD.
13. Test PDFs only from `review/owner/` or self-generated; never search other folders of the machine. Screenshots only by capturing the app window, never the screen (ADR-126).
14. Writes, deletes and moves only inside the repo and the Claude temp folder; no reads outside the repo (test material: `review/owner/`). Enforced by the `guard-paths.sh` PreToolUse hook, exit 2 (ADR-127).

## Code

- TS `strict`, no `any` without comment. Rust: clippy -D warnings, typed `Result`, no `unwrap()`/`expect()` in prod paths.
- All PDF work in Rust. The frontend never holds raw PDF bytes or file paths (document IDs only).
- Design tokens only (`src/styles/tokens.css`); no hardcoded colors or sizes. App name only via the `APP_NAME` token.
- Conventional Commits. Version changes only via `scripts/bump-version.sh`.

## References

- `docs/DESIGN.md` — tokens, components, motion
- `docs/ARCHITECTURE.md` — modules, IPC command signatures
- `docs/SECURITY.md` — threat model + checklist
