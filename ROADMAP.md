# ROADMAP

Legend: `[ ]` open · `[x]` done · `[~]` blocked (see `docs/BLOCKERS.md`).
The Stop hook picks the first open `- [ ]` line, so order matters.

## Phase 0 — Bootstrap (v0.0.1)

- [x] Orchestration scaffold: agents, hooks, docs skeleton, license, trademark, logo

## Phase 1 — Research (v0.1.0)

- [ ] Research: docs/research/acrobat-features.md
- [ ] Research: docs/research/online-tools.md
- [ ] Research: docs/research/ux-patterns.md
- [ ] Research: docs/research/libraries-licensing.md
- [ ] Synthesis: docs/FEATURES.md + milestones M1–M7 in ROADMAP.md

## Phase 2 — Architecture + Spike (v0.2.0)

- [ ] Architecture: ADR-001..004 + docs/ARCHITECTURE.md
- [ ] Spike: Tauri 2 + bundled PDFium, open_document + render_page, React page view with zoom
- [ ] Security baseline: strict CSP, minimal capabilities, fetch-pdfium.sh with SHA256, docs/SECURITY.md threat model
- [ ] First security-reviewer run
- [ ] Tooling: scripts/check.sh, scripts/bump-version.sh, CI (macOS + Windows), Dependabot

## Phase 3 — Design system + app shell (v0.3.0)

- [ ] Detailed after Phase 1 synthesis
