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
> **Update (Phase 2):** ADR-001 … ADR-004 are now used. They are appended after ADR-011 because this file is
> append-only, so the order below is chronological, not numeric. ADR-005 … ADR-009 stay reserved for Phase 2
> (e.g. the spike fallback in §8.3).

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

---

## ADR-001 — Stack confirmation

**Status:** accepted (2026-10-02)

**Context.** ORCHESTRATOR_PROMPT §4 fixes the stack and requires Phase 2 to verify it. Phase 1 found one gap: PDFium has no
incremental save. lopdf fills it (ADR-010).

**Options.** (a) As specified, plus lopdf. (b) Electron: bundles Chromium. (c) PDF.js engine: no structural writes; the frontend would
hold PDF bytes (I2).

**Decision.** (a), all MIT, Apache-2.0 or BSD: Tauri 2 (plugins `dialog`, `opener`, `log`; `single-instance` in M1); React 19, TS
strict, Vite, Tailwind 4, Motion, Zustand; PDFium plain build `chromium/7881` via `pdfium-render` 0.9.x (dynamic binding); lopdf 0.45;
`image` 0.25, `thiserror`, `zeroize`; `ts-rs` as a dev-dependency that generates `src/ipc/types.gen.ts`; Vitest, `cargo test`, WebDriver E2E (M7).
Rules: PDFium is bound only by absolute path from the resource dir (no DLL hijacking); `dialog` and `opener` have no JS permissions
(Rust calls them); engine and disk commands are `async`.

**Consequences.** CI fails when `types.gen.ts` is stale. Each dependency enters `docs/LICENSES.md` in the commit that adds it.

---

## ADR-002 — PDF engine integration

**Status:** accepted (2026-10-02)

**Context.** PDFium is not thread-safe. Targets: 500 pages open in < 1 s, 60 fps scrolling. Every PDF is hostile input (P5).

**Options.** (a) `Mutex<Pdfium>` in command tasks: no priorities, and a long job blocks everything. (b) One worker thread with a
priority queue. (c) An engine process now: too costly before M1.

**Decision.** (b). Messages are shaped so that (c) is a transport swap in M7.

1. **Worker.** The thread `sheer-pdfium` (16 MB stack) owns `Pdfium` and every `PdfDocument`. Callers use a cloneable `EngineHandle`.
   Requests and responses are owned serde enums, answered via `oneshot`.
2. **Queue.** A `BinaryHeap` + `Condvar`, ordered by priority, then newest viewport generation, then FIFO. Priorities: `Control` (open,
   close, hide annotation, replace file) > `Visible` > `Interactive` (text layer, links, annotation import of visible pages) > `Near` >
   `Thumbnail` > `Background` (search, other imports, export). Long work runs as one job per page.
3. **Cancellation.** `set_viewport` increments the generation and lists the visible and near pages. Queued renders for other pages fail
   with `cancelled`, which the UI ignores. Search checks an `AtomicBool` after each page. A running PDFium call is never interrupted;
   the pixel cap bounds it. Identical in-flight keys are deduplicated.
4. **Render cache** (frontend, `renderCache.ts`). An LRU of PNG Blobs, 256 MB by default (range 128–1024), with mounted pages pinned.
   Key: `doc:page:pageRev:bucket[:tile]`. Zoom and DPR fold into one bucket `b = ceil(4·log2(zoom·dpr))`, rendered at `2^(b/4)`.
   Display then downscales by at most 19 %. The backend increments `pageRev` when page pixels change, so stale entries age out.
   Rust caches no pixels.
5. **Virtualization.** Open returns every page size (`FPDF_GetPageSizeByIndexF`). Only pages within the viewport ± one viewport height
   are mounted (max 24); a spacer holds the rest. A page shows the best cached bucket CSS-scaled, then requests its exact bucket. Above
   4096 px per side or 8 MP, pages render as 1024 px tiles over a low-bucket underlay. `set_viewport` fires 150 ms after scrolling settles.
6. **Transport.** `render_page` returns a `tauri::ipc::Response` (ArrayBuffer). Frame: `"SHR1"`, `u8` format (1 = PNG RGB, 2 = raw
   RGBA8), 3 reserved bytes, `u32` LE width, `u32` LE height, payload. Default: PNG with fast compression, at most 4096×4096 px. Spike gate:
   if PNG-encoding an A4 page at 2× takes more than 30 ms on Windows, the default becomes format 2.
7. **Ownership.** PDFium renders, extracts text, searches, reads links and forms, and imports annotations. It **never saves**, so its
   in-memory document may be mutated (ADR-003 §4). lopdf writes, off the worker (ADR-004). Afterwards the worker runs `ReplaceFile`:
   close → rename → reopen → re-hide → increment `rev`/`pageRev` → emit `doc:reloaded`.
8. **Guards.** Each job runs in `catch_unwind`, and a panic poisons only that document (`engine_crashed`). The thread `sheer-watchdog`
   enforces deadlines: render 10 s, text 10 s, open 20 s. After a timeout the engine is `Wedged`: jobs fail with `engine_unavailable`, and
   the UI offers save (lopdf needs no PDFium) and restart. Limits: `limits.rs`. Segfaults inside PDFium stay uncatchable in-process.
9. **M7.** The worker loop moves to `src/bin/sheer-engine.rs`. Rust starts it via `std::process::Command`, and the two exchange
   length-prefixed frames over stdio. Only `engine::transport` changes. Paths, passwords, page maps and hidden sets stay in the main
   process, so a dead engine is respawned and its state replayed.

**Consequences.** One render at a time; responsiveness comes from priorities. The frontend owns pixel memory.

---

## ADR-003 — Annotation domain model and undo/redo command stack

**Status:** accepted (2026-10-02)

**Context.** Annotations must not depend on PDFium, which writes weak appearance streams (APs) and only saves by full rewrite. Undo must
be exact.

**Options.** (a) Edit in PDFium and save with it: breaks incremental save. (b) TS owns the model: Rust needs a copy anyway (autosave,
page maps). (c) Rust owns model and history in `model/` (no PDFium/lopdf imports); the frontend keeps a replica updated by change sets.

**Decision.** (c).

1. **Coordinates.** Page space is in points, origin at the CropBox's top-left, y pointing down, before `/Rotate` is applied. Only
   `pdfwrite::coords` converts.
2. **Types.** The Rust structs are the source; ts-rs generates:

```ts
type DocId = number; type PageId = number; type AnnotId = number;   // session-scoped u32
type Point = { x: number; y: number }; type Rect = { x: number; y: number; w: number; h: number };
type Quad = [Point, Point, Point, Point];   // TL, TR, BL, BR
type Rgb = [number, number, number];        // 0–255
type LineEnd = 'none' | 'openArrow' | 'closedArrow';
interface AnnotationCommon {
  id: AnnotId; pageId: PageId; rect: Rect;  // rect computed by Rust
  color: Rgb; opacity: number; contents: string; author: string | null;
  modified: string | null; inReplyTo: AnnotId | null; locked: boolean;
  sync: 'new' | 'clean' | 'modified';
}
type AnnotationBody =
  | { kind: 'highlight' | 'underline' | 'strikeout' | 'squiggly'; quads: Quad[] }
  | { kind: 'note'; at: Point; icon: 'comment' | 'note' | 'help' }
  | { kind: 'freeText'; box: Rect; lines: string[]; fontSize: number; fill: Rgb | null; borderWidth: number }
  | { kind: 'ink'; strokes: { points: Point[]; outline: Point[] }[]; width: number }
  | { kind: 'rect' | 'ellipse'; box: Rect; width: number; fill: Rgb | null; dashed: boolean }
  | { kind: 'line'; from: Point; to: Point; width: number; head: LineEnd; tail: LineEnd }
  | { kind: 'stamp'; box: Rect; assetId: number };   // M4
type Annotation = AnnotationCommon & AnnotationBody;
```

   `AnnotationDraft` is `Annotation` without `id`, `rect` and `sync`. `AnnotationPatch` makes non-identity fields optional and rejects
   fields that do not belong to the kind. Rust-only fields: `persisted: Option<PdfOrigin>` (page, `/Annots` index, `/NM`) and `tombstone`.
3. **Geometry is final at commit.** Ink smoothing and pressure produce `outline` (perfect-freehand, MIT, M2). Free text is wrapped into
   `lines` with Helvetica/Arial metrics, which are metric-compatible. Rust draws only the given geometry, so the overlay matches the AP.
   Free text v1 is Helvetica with WinAnsi characters only (en/de).
4. **Rendering split.** PDFium renders persisted, clean annotations from their original AP. The SVG overlay draws every annotation with
   `sync ≠ clean`, plus the one being edited. When a persisted annotation changes, a `Control` job calls `delete_annotation` on PDFium's
   in-memory page (load-time index mapped to the current index) and increments `pageRev`. Unsupported subtypes (widget, link, popup, polygon,
   caret, attachment) stay PDFium-only.
5. **PDF mapping.** Common keys: `/Subtype /Rect /P /NM /M /T /Contents /C /CA /F 4 /IRT /AP`. `/NM` (random 128-bit hex) goes on every
   annotation we write and is its identity across reloads. The AP is a Form XObject with an ExtGState for opacity. Imported APs are kept until
   the annotation is modified. Per kind: highlight → Highlight + QuadPoints, `/BM /Multiply` · underline/strikeout/squiggly → same keys, line or zigzag ·
   note → Text + `/Name`, NoZoom|NoRotate · freeText → FreeText + `/DA (/Helv n Tf)` · ink → Ink + `/InkList`, AP fills outlines ·
   rect/ellipse → Square/Circle · line → Line + `/L /LE` · stamp → Stamp + image XObject (M4).
6. **Commands** (`model::command`):

```rust
#[serde(tag = "type", rename_all = "camelCase")]
pub enum DocCommand {
    CreateAnnotation { draft: AnnotationDraft },
    UpdateAnnotation { id: AnnotId, patch: AnnotationPatch },
    DeleteAnnotations { ids: Vec<AnnotId> },
    RotatePages { pages: Vec<PageId>, quarter_turns: i8 },   // M3
    DeletePages { pages: Vec<PageId> },                      // M3
    MovePages { pages: Vec<PageId>, to_index: u32 },         // M3
    InsertBlankPage { at: u32, width: f32, height: f32 },    // M3
    SetFieldValue { field: FieldId, value: FieldValue },     // M4
    Batch { label: String, commands: Vec<DocCommand> },
}
fn apply(&self, s: &mut DocState) -> Result<(DocCommand /* inverse */, ChangeSet), AppError>;
```

   Every apply returns its exact inverse. A deletion is undone by an internal `Restore` that carries snapshots. Moving an annotation to another
   page is a `Batch` of Delete + Create. Until save, page commands only edit `DocState.pages: Vec<PageSlot { id, source, rotation, rev }>`.
7. **History.** Undo and redo stacks of `Entry { label, forward, inverse, coalesce }`, at most 500 entries. Updates with the same
   `coalesce_key` on the same id within 1.5 s merge. A gesture commits once; transient state stays in the frontend. A clean marker records
   the depth at the last save. History survives save and is dropped on close.
8. **Change sets.** apply, undo and redo return
   `ChangeSet { rev, upserted, removed, pages | null, history: { canUndo, canRedo, undoLabel, redoLabel, dirty } }`.

**Consequences.** Each gesture costs one IPC round trip (~1 ms). The overlay and the AP generator must agree. In M2 an interop test diffs PDFium
renders of saved files against the overlay.

---

## ADR-004 — File strategy

**Status:** accepted (2026-10-02)

**Context.** PDFium only saves by full rewrite, which breaks signatures. SECURITY D1/D3/D5 require an atomic save, a backup, session-only
passwords and minimal autosave data.

**Options.** (a) Full save with PDFium. (b) lopdf incremental save by default, full rewrite only where required. (c) A qpdf sidecar: needs a
C++ build, and incremental writing is undocumented.

**Decision.** (b).

1. **Save** (`pdfwrite::save`; blocking thread, 64 MB stack, `catch_unwind`, 60 s):
   1. Snapshot non-clean annotations, tombstones and the page map.
   2. Read the target; if size or mtime differ from the open fingerprint → `needs_confirmation{fileChangedOnDisk}`.
   3. `Document::load_mem` (session password), then `IncrementalDocument::create_from`.
   4. Append annotation dicts, AP XObjects, `/Annots` arrays (tombstones and their popups removed) and the changed page tree.
   5. Write temp `.<stem>.sheer-<random>.tmp` in the target directory (`create_new`, mode 0600), `fsync`.
   6. Validate: lopdf re-parse plus a PDFium test open.
   7. Back up the original (§3).
   8. Worker `ReplaceFile`: close, rename (Windows: 3 retries, 100 ms apart), `fsync` the directory (Unix), reopen, re-hide. The model records
      new origins and the clean marker.
   9. On failure: reopen the original, delete the temp file, return `io_in_use` or `save_failed`.
2. **Full rewrite** (lopdf, unreferenced objects pruned) for Save As "Clean copy", compress, redaction, encryption changes, metadata removal
   and new-file outputs. Incremental saves keep old revisions recoverable, so redaction and metadata removal never use them (D4/D5).
3. **Backup.** The first save over an original in a session copies it to
   `$APPDATA/<id>/backups/<timestamp>-<sanitized stem>-<hash8>.pdf`. Backups are kept for 30 days or up to 2 GB. A setting can turn them off.
4. **Signed files.** `signed` means PDFium's signature count is > 0; `certified` means `/Perms /DocMDP` is present. A banner explains that
   changes are saved as additions. Every full-rewrite path returns `needs_confirmation{breaksSignature}`, and the UI defaults to Save As. A
   DocMDP "no changes" document needs this confirmation for every save.
5. **Passwords.** `password_required` leads to `unlock_document` (≤ 1024 bytes). The password is held as `Zeroizing<String>` with a
   redacting `Debug`, zeroized on close, and never logged, persisted, or put in recents or autosave. Encrypted saves stay incremental if lopdf
   encrypts the appended objects (spike check). Otherwise the save is a full rewrite after `needs_confirmation{rewriteEncrypted}`.
6. **Autosave (M7).** 30 s after the last change and on window blur, an atomic write of `$APPDATA/<id>/autosave/<uuid>.json` =
   `{ v, source: { path, len, mtime }, state }` (non-clean model plus page map). Encrypted documents are never autosaved. The file is
   deleted on save or close. Restore checks the fingerprint, then applies `state` as one undoable `Batch`. How D5 is read: the file holds
   the edits plus a source reference, nothing else.
7. **Temp files** are tracked and deleted on failure and on exit.

**Consequences.** A save parses the whole file; benchmark this on the 500-page fixture in M2. Files grow with each incremental save until a
clean copy is made.

---

## ADR-005 — Security baseline: CSP `connect-src`, config hardening, error and engine guards

**Status:** accepted (2026-10-02)

**Context.** ORCHESTRATOR_PROMPT §13.1 fixes the CSP at `connect-src 'none'` and `img-src 'self' asset: data: blob:`. The spike ships
`connect-src ipc: http://ipc.localhost` and no `asset:`. Aligning the spike with ARCHITECTURE §10 (Phase 2, security baseline) needs these
deviations on record, next to the other baseline decisions.

**Options for `connect-src`.** (a) `'none'` as written. Tauri 2 sends every `invoke` as a `fetch` to its custom protocol: `ipc://localhost`, or
`http://ipc.localhost` on Windows/WebView2. `'none'` blocks it. Tauri's own `ipc-protocol.js` then logs a warning and falls back to the
postMessage interface, which answers by evaluating script in the page: a slower path that is not meant for multi-MB render frames (ADR-002 §6),
and one CSP violation per session. (b) Serve frames from our own `sheer:` scheme: the page would then need that scheme in `img-src`/`connect-src`
anyway, and commands still use the IPC protocol. (c) Keep the two IPC sources and nothing else.

**Decision.** (c).
1. **CSP (production):** `default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src ipc:
   http://ipc.localhost; object-src 'none'; base-uri 'none'; frame-src 'none'; form-action 'none'`. Scripts fall back to `default-src 'self'`:
   no inline, no eval. `ipc:` and `http://ipc.localhost` are handlers inside the app (the webview intercepts the virtual host and Rust answers), not
   network hosts. `http:`, `https:`, `ws:` and `*` stay blocked, so a page cannot send data to a server. `asset:` is dropped from `img-src` because the
   asset protocol is off (`app.security.assetProtocol.enable = false`, no `protocol-asset` feature): pages arrive as bytes over IPC and become `blob:`
   URLs. `devCsp` adds only `localhost:1420` for Vite and applies to `tauri dev`.
2. **No DevTools in release.** Tauri enables the inspector only when `debug_assertions` or the `devtools` cargo feature is on (`webview/mod.rs`).
   The `tauri` dependency keeps `features = []`, and the app crate defines no `[features]`.
3. **Capabilities.** One file, window `main`, the three app commands only. No plugin permission (`core:`, `dialog:`, `fs:` …) is granted, so the
   dialog plugin, which Rust calls, has no JS surface. No `remote` section, so no remote origin reaches IPC.
4. **Panics unwind.** `[profile.release] panic = "unwind"`: the engine guard (3) relies on `catch_unwind`.
5. **Pinned.** `src-tauri/tests/security_baseline.rs` asserts items 1–4, the absence of `dangerous*` options, `withGlobalTauri: false`, no shell/http/
   websocket/process/global-shortcut plugins, and that no command takes a path or URL. Changing any of it needs a new ADR and a security-reviewer pass.

**Errors (I4).** `AppError` is internal and not `Serialize`. `UiError { code, key, retryable, params? }` is the only type that reaches IPC, built by
`From<AppError>`. `key` is `error.<code>`: ARCHITECTURE §7 lets the TS side derive it, the spike sends it so the contract is explicit, and the frontend
checks it. `params` holds `what` (a fixed word such as `page`, `pixels`) and `limit`; they are `&'static str`/numbers, so request data cannot reach them.
The detail goes to stderr only in debug builds or with `SHEER_LOG=debug`. Codes follow ARCHITECTURE §7; the spike's older names are mapped
(`unknown_document` → `not_found`, `page_out_of_range`/`scale_out_of_range` → `invalid_argument`, `render_too_large` → `limit_exceeded`, …).

**Engine guards (P5).** Each job runs in `catch_unwind`; a panic becomes `engine_crashed`, the affected document is dropped and refuses further work until
closed, the worker and other documents carry on. Deadlines per job: open 20 s, render 10 s, close 5 s (ADR-002 §8). There is no `sheer-watchdog`
thread yet: callers wait with `recv_timeout`, and a shared `Health` mark tells later callers that the running job is past its deadline, so they fail with
`engine_unavailable` at once instead of queueing behind it. Deviation from ADR-002 §8: that state ends when the slow job ends (no restart UI exists yet, and
one slow page must not brick the session). A job whose caller has given up is skipped. The queue refuses new jobs when full (`try_send`).
A segfault or a true hang inside PDFium stays uncatchable in-process; M7's engine process (P6) is the fix. Frames are capped at 4096 px per side and
4096² pixels (ADR-002 §6), checked against the real page size before the bitmap is allocated; opened files must be regular and ≤ 2 GiB.
Until M1 tiles large pages, the frontend answers `limit_exceeded` for a frame by retrying `render_page` at 0.7× scale (at most 4 times).

**Consequences.** `connect-src` is the one place the CSP is looser than §13.1; revisit if Tauri offers IPC that needs no CSP source. The IPC errors
are stable now, so changing a code name is a breaking change for `src/api/errors.ts`. Commands take `pageId` (identity mapping until M3) so the wire
format survives page reordering.

---

## ADR-012 — Design token amendments (Phase 3 spec)

**Status:** accepted (2026-10-02)

**Context.** While writing the component spec (`docs/DESIGN.md`), the designer computed contrast ratios for every pairing.
Several ADR-011 values were too weak.

**Decision.** Adopt the spec's amendments: `--surface-strong` alpha .90 (at .86 worst-case muted text over page content
drops to 4.47:1); new neutrals `--ink-50` (control borders, light disabled text) and `--ink-40` (dark muted text);
`--iris-600` as accent hover; links use `--iris-700` (iris-500 is 4.45:1 on the canvas); semantic text variants that pass
4.5:1; Windows close-button hover red as the only non-Iris chrome color (platform convention). At ≥ 1280 px the inspector
column stays reserved while a document is open, so pages never shift when it appears.

**Consequences.** `src/styles/tokens.css` implements `docs/DESIGN.md` §1 exactly; the reviewer rejects raw values in components.

---

## ADR-013 — Backend pushes use channels; the webview gets no event permission

**Status:** accepted (2026-10-02)

**Context.** The live "Reduce transparency" flag first reached the UI as a Tauri event, which needed `core:event:allow-listen` and
`allow-unlisten`. `listen` is the permission that also lets the webview hear `tauri://drag-drop`, whose payload is the dropped file paths,
so granting it weakened SECURITY I2 ("the frontend never sees file paths") for the sake of one boolean.

**Decision.** The capability grants no plugin or core permission at all. A push from Rust is a `tauri::ipc::Channel` that the UI passes as an
argument of a command; a channel needs no permission and carries typed messages only. `watch_transparency(on_change: Channel<bool>)` is the first
(one receiver, a new call replaces it). Later pushes (`search`, document and drop notifications) use the same mechanism. `dragDropEnabled` is set
to `true` explicitly: Tauri then takes the OS drop itself, so a dropped file cannot navigate the webview to `file://`, and the paths reach only
Rust's `WindowEvent::DragDrop` handler. Rejected: `dragDropEnabled: false` (the webview's default drop handling would navigate), and keeping `listen`
while ignoring the drag-drop event (one bug away from leaking paths).

**Consequences.** `security_baseline.rs` fails on any `core:` permission, `src/api/app.test.ts` on any import of the event API. A future event that
must be global needs an ADR that grants `listen` for it. The settings temp file now has a per-process unique name (`.name.pid.n.tmp`) and is created
with `create_new`; a crash can leave a hidden, never reused leftover. The settings file is opened `O_NONBLOCK` on Unix and judged on the handle,
which adds `libc` as a direct Unix dependency (already in the lockfile).
