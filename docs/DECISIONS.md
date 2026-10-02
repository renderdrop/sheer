# Architecture Decision Records

Append-only. Format: `ADR-NNN — Title` · Status · Context · Options · Decision · Consequences.

---

## ADR-000 — Adopt the ORCHESTRATOR_PROMPT specification

**Status:** accepted (2026-10-02)

**Context.** The project is bootstrapped and driven autonomously from `ORCHESTRATOR_PROMPT.md`. It fixes mission, rules,
design language, tech stack, repo layout, subagents, hooks, phases, versioning and security requirements.

**Decision.** All specifications in `ORCHESTRATOR_PROMPT.md` are adopted as-is. Deviations made during bootstrap:

1. **Hook scripts on Windows.** Claude Code runs hooks through Git Bash on Windows, where `CLAUDE_PROJECT_DIR` and
   `file_path` contain backslashes. The hook scripts normalize `\` to `/` (a no-op on macOS/Linux) so that file tests
   and `*/docs/*`-style patterns work. `guard-secrets.sh` also skips `.claude/hooks/`, because it contains the very patterns
   it searches for and would otherwise block edits to itself. `format.sh` falls back to `~/.cargo/bin/rustfmt`.
2. **Rust toolchain.** Rust was missing on the dev machine. It was installed with the official `rustup-init` into the
   user profile **without modifying PATH**. Scripts (`scripts/check.sh`, npm scripts) prepend `~/.cargo/bin` when present.
3. **License allowlist.** `deny.toml` allows, in addition to the six licenses named in rule 2, these permissive SPDX ids:
   MIT-0, 0BSD, BSL-1.0, CC0-1.0, Unicode-3.0, Unicode-DFS-2016, Apache-2.0 WITH LLVM-exception. Core crates of the
   Rust/Tauri ecosystem use them (e.g. `unicode-ident` → Unicode-3.0). None is copyleft; GPL/AGPL/LGPL stay forbidden.
4. **Research parallelism.** Phase 1 runs four `researcher` agents at once, as section 8.2 specifies. That overrides the
   general "max. 3 parallel" rule of 7.6 for this phase only: the work is read-only web research with disjoint output files.
5. **Scripts and CI.** `scripts/*.sh` and `.github/workflows/ci.yml` are created in Phase 2 as section 8.3 specifies,
   not as empty stubs in Phase 0.
6. **Toolchain pins.** Node `22.23.1` (`.nvmrc`, matches the dev machine), Rust `1.99.0` (`rust-toolchain.toml`).
7. **Brand reference.** The provided design file `Sheer — Logo & Farbe.html` stays in the repo root as the human-supplied
   brand reference. `assets/brand/logo.svg` (Appendix A) remains the single logo source.

**Consequences.** Everything below builds on these constraints. Any further deviation needs its own ADR.

8. **Subagent types (addendum, Phase 1).** Custom agents in `.claude/agents/` are only registered at session start. In the
   bootstrap session they run as `general-purpose` with the model from the agent file (`sonnet`/`opus`/`haiku`) and the
   agent file's body pasted verbatim as a ROLE block at the top of the brief. From the next session on, the named types are used.

> ADR-001 … ADR-009 are reserved for Phase 2 (architecture, spike, security baseline) so the numbering in
> `ORCHESTRATOR_PROMPT.md` §8.3 stays valid. Phase 1 decisions therefore start at ADR-010.

---

## ADR-010 — Product scope for v1.0 (from Phase 1 research)

**Status:** accepted (2026-10-02)

**Context.** `docs/research/*.md`: the most frequent tasks are image↔PDF conversion, compress, merge, fill & sign, page
operations, annotate, protect. PDFium (plain build) renders, extracts text with char boxes, searches, fills AcroForms and
creates most markup annotations, but `pdfium-render` 0.9.4 always saves with flags 0 (full rewrite, breaks signatures),
cannot set passwords, create signatures, redact, or reliably generate appearance streams for line/arrow/free-text.

**Options.** (a) PDFium only, accept gaps · (b) PDFium + lopdf (MIT) for structural writes · (c) switch engine (no
permissive engine covers more; MuPDF is AGPL).

**Decision.**
1. **Engine pairing:** PDFium plain build (no V8, no XFA) for render/text/search/forms/annotation creation; **lopdf** for
   incremental save, appearance-stream XObjects, encryption, metadata and structural edits. Final integration design is
   the architect's ADR-002/004.
2. **XFA:** detect and warn ("This form type is not supported"), never render via V8/XFA build.
3. **Redaction v1:** affected pages are flattened to images with the redaction burned in, and text layer, annotations
   and metadata of those pages are removed. This is true removal. Operator-level removal (keeps other text selectable) is post-1.0.
4. **Office conversion (PDF↔Word/Excel/PowerPoint): Won't for v1.** No permissive offline engine exists. Images↔PDF is in.
5. **OCR:** only through OS APIs (Apple Vision, Windows.Media.Ocr), Should for M6. Tesseract is not bundled in v1
   (native build, language data size). `ocrs` excluded: model-weight license unknown.
6. **Digital signatures** (self-signed, lopdf incremental + RustCrypto `cms`): post-1.0 (rule 5 "later milestone").
   `pdf_signer` is GPL-3.0 and excluded.
7. **Signed input files:** edits on documents that carry signatures use incremental save. The user is warned before any
   full rewrite.
8. **Bundled PDFium third-party code:** FreeType (taken under the FTL, not GPL-2.0), ICU, libpng, libtiff, lcms,
   libjpeg-turbo, OpenJPEG, zlib, Abseil, Highway are permissive components of the PDFium binary and are accepted. Their
   notices ship with the app (About → Licenses), generated from the LICENSE file in the release tarball.
9. **Out of scope for v1:** compare, read aloud, multi-file search, form authoring, PDF/A, tagging, Bates, print
   production, all cloud/AI/collaboration features (see `docs/FEATURES.md` "Later").

**Consequences.** Two Rust PDF libraries must agree on one document state. ADR-002/004 define the ownership (PDFium for
reading/rendering, lopdf for writing, reload after save). Roadmap M1–M7 reflects this scope.

---

## ADR-011 — Design adjustments from UX research

**Status:** accepted (2026-10-02)

**Context.** `docs/research/ux-patterns.md`: Apple's Liquid Glass drew legibility criticism, and macOS 27 lowered default
transparency. WebKit does not support `prefers-reduced-transparency` (WebView2 does). A transparent macOS window needs
`macOSPrivateApi`, which blocks the Mac App Store. Tauri's native file drop blocks HTML5 drag-and-drop on Windows. Several
seed tokens fail WCAG contrast in some pairings.

**Decision.**
1. Glass only on the control layer (toolbar, tab strip, inspector, popovers). The document canvas is opaque. Never glass on glass.
2. Keep `--surface: rgba(255,255,255,.72)` for panels over the app gradient. Add `--surface-strong` (≈ .86 alpha) for
   surfaces that float over document content, plus a scroll-edge scrim under the toolbar.
3. Glass is CSS-only (`backdrop-filter` over an in-app gradient). No native window transparency, no `macOSPrivateApi`.
4. Reduced transparency: the CSS media query on Windows; on macOS the Rust side reads the OS setting and sets
   `data-transparency="reduced"` on `<html>`. A user setting "Glass: Auto / Solid" overrides it.
5. Native file drop opens documents. In-app reordering (thumbnails, page grid) uses pointer events and always offers a
   keyboard/button alternative (WCAG 2.5.7).
6. The seven tool groups from §3 are shown as four visual clusters plus overflow: Select · Markup (highlight, comment,
   draw) · Fill & Sign (form, signature) · Pages. Every command is also in the native menu bar with its shortcut.
7. Tools are one-shot by default; double-click locks a tool (badge); Esc returns to Select.
8. Contrast rules: `--ink-30` only for dividers, never control borders; no white text on `--iris-400`; semantic colors
   only for icons/fills, never small text. Targets ≥ 24 px (32 px default).
9. Annotation colors are document content, not UI chrome. The "one hue" rule applies to the UI only. The annotation
   palette uses six colorblind-safe swatches with text names.

**Consequences.** The designer applies these rules in `docs/DESIGN.md` (Phase 3). The `reviewer` checks them.
