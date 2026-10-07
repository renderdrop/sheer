# Sheer

Sheer is an open-source, local-only desktop PDF app for macOS and Windows (Tauri 2 + React 19/TS + PDFium via pdfium-render).
It covers everyday Acrobat-class tasks (view, annotate, edit, organize, forms, sign, convert) with a restrained liquid-glass UI in one accent hue ("Iris").
Work is orchestrated autonomously per `ORCHESTRATOR_PROMPT.md`; resume state lives in `STATE.md` and `ROADMAP.md`.

## Commands

- `npm run check` — typecheck, lint, vitest, clippy -D warnings, cargo test, cargo deny, npm audit (orchestrator, once before each commit)
- `npm run check:fast` — only what changed, < 60 s (agents while working)
- `npm run cargo -- <args>` — cargo in `src-tauri/` with six jobs, low priority, sccache (instead of a bare `cargo`)
- `npm run tauri dev` — run the app
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
15. Acceptance only through the acceptance build (`npm run build:acceptance`, id `app.sheer.acceptance`, feature `automation`): dialogs answered by the script queue, input via CDP (`scripts/ui/accept/`); real mouse/keyboard only in the final smoke (≤ 5 min, announced before and after); dialog guard aborts with Esc + report. The owner's installation is never touched (ADR-131).
16. Owner corpus stays private (ADR-133): versioned files, reports and commit messages never name file names, titles, persons or personal data from `review/owner/`; use IDs (`owner-pdf-E4`, `corpus-07`) resolved via the untracked `review/owner/INDEX.md`.
17. Resources and pace (ADR-136): at most two agents with cargo at once (frontend agents up to four); six rustc jobs, builds at low priority; `guard-resources.sh` blocks builds under 8 GB free RAM or 40 GB free disk; `target/` ≤ 60 GB via `npm run target:budget` (cargo sweep, not clean); sccache in `.tools/`; agents run `check:fast`, the full check runs once before each commit; wait for agents by notification, never a foreground sleep > 2 min; `npm run accept:clean` after every acceptance; at session start commit or discard what `git status` shows.

## Code

- TS `strict`, no `any` without comment. Rust: clippy -D warnings, typed `Result`, no `unwrap()`/`expect()` in prod paths.
- All PDF work in Rust. The frontend never holds raw PDF bytes or file paths (document IDs only).
- Design tokens only (`src/styles/tokens.css`); no hardcoded colors or sizes. App name only via the `APP_NAME` token.
- Conventional Commits. Version changes only via `scripts/bump-version.sh`.

## References

- `docs/DESIGN.md` — tokens, components, motion
- `docs/ARCHITECTURE.md` — modules, IPC command signatures
- `docs/SECURITY.md` — threat model + checklist
