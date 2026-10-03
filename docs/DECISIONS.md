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

---

## ADR-014 — Window chrome: platform window configs and seven window permissions

**Status:** accepted (2026-10-02)

**Context.** DESIGN 2.2 asks for an overlay title bar with the native traffic lights on macOS and, on Windows, no native decorations and our
own caption buttons (minimize, maximize or restore, close) with a drag region. `decorations` is one flag for all platforms (`false` would
also remove the macOS traffic lights), and Tauri's window commands each need their own permission. ADR-013 granted no `core:` permission at all.

**Decision.**
1. **Config.** `tauri.conf.json` keeps the one window for every platform (minimum size 960 x 640). `tauri.macos.conf.json` adds
   `titleBarStyle: Overlay`, `hiddenTitle` and `trafficLightPosition {16, 22}`; `tauri.windows.conf.json` adds `decorations: false`. Tauri merges
   a platform file into the base file as a JSON merge patch, which replaces arrays whole, so each platform file repeats the complete window entry.
   `security_baseline.rs` merges the same way and runs the window checks (one window `main`, no `url`, `dragDropEnabled: true`, no `danger*` key)
   on the base file and on both results.
2. **Permissions.** The capability grants, by their own names, `core:window:allow-minimize`, `-toggle-maximize`, `-close`, `-is-maximized`,
   `-is-fullscreen`, `-start-dragging` and `-internal-toggle-maximize`, and nothing else from `core:`. The caption buttons need the first three;
   the maximize or restore icon and the macOS traffic-light inset read the next two; Tauri's `data-tauri-drag-region` script calls the last two
   (dragging, and the double click on the drag region). `src/api/window.ts` is the only module that imports the window API.
3. **No window events.** The window API's `onResized` and `onFocusChanged` would need `core:event:allow-listen`, which ADR-013 refuses. The shell
   reads the DOM's `resize` event and asks `is_maximized` or `is_fullscreen` again, and takes focus from the DOM's `focus` and `blur`.
4. **Platform for the first paint.** The Windows caption row and the macOS inset exist before `app_ready` has answered, so the first render takes
   the platform from the user agent (`src/lib/platform.ts`) and the backend's answer replaces it.

**Consequences.** ADR-013's "no core permission at all" becomes "no core permission except these seven". `security_baseline.rs` accepts exactly this
list (any other `core:` entry, `core:default` included, fails it) and `src/api/window.test.ts` ties the list to the wrappers. Not done: Windows 11
Snap Layouts on hover over the maximize button need native non-client hit testing, which an undecorated window with web caption buttons does not
get (dragging to a screen edge and the Win+arrow keys still snap the window); revisit with a native caption hit-test
if users miss it. Closing is a request (`close`, not `destroy`), so a later "unsaved changes" veto still works.

---

## ADR-015 — App shell render isolation, and the display-name filter

**Status:** accepted (2026-10-02)

**Context.** The first shell kept the open document, page, zoom, image and render flag in a hook inside `Shell`, and read the window width and the whole `ui`
store there. Every wheel-zoom step, page change, finished render, drag-over and step of the splitter re-rendered the shell, rebuilt the toolbar's entries
and re-rendered the toolbar and the left panel. The review found that `display_name` still let format characters through (soft hyphen, tag characters, the
interlinear marks) and that the platform configs were not all covered by the CSP test.

**Decision.**
1. **The viewer is a store** (`useViewer`: document, image, `opening`, `rendering`, and the actions `open`, `zoomStep`, `setZoom`, `resetZoom`,
   `zoomByWheel`, `goToPage`). Actions read the current state when called, so they never change. The render loop and the shell's keys live in
   `ViewerEffects` (renders nothing). Zoom and page stay in the `view` store.
2. **The shell follows the structure, not the pixels.** `shellStructure` (`lib/layout.ts`) reduces window width, panel width, panel choices, tool and
   document to booleans; `useShellStructure` returns the same object until one flips. `shellTracks` turns a structure and a panel width into the grid.
   `computeShellLayout` is both together and keeps its tests.
3. **Each part follows what it shows** (per-field selectors): `ToolbarSlot`, `ViewerCanvas`, `ViewerStatusBar`, `MainGrid`, `LeftPanelSplitter`,
   `BannerRow`, `EmptyStateSlot`; `LeftPanel` and `Inspector` are memoized with stable props (`placement()` returns the same style object for a column).
4. **Two small primitive extensions** so the toolbar need not render per zoom step: `ToolbarItem.text` may be a `ReactNode` (the zoom readout is an
   element that follows the zoom), and `Menu` / `ToolbarItem.menu` accept a function that makes the entries while the open menu renders and may use hooks
   (`useZoomMenu`). A list still works as before.
5. **`Field`** is the shared number field (Slider, Go to page). `--status-name-max` (40 %) is a token. `useRevealMotion` is the banner's height and
   opacity motion (250 ms; opacity only under reduced motion); the row clips only while it moves (Motion's `transitionEnd` does not reach `overflow`).
6. **`display_name`** removes Unicode categories Cc and Cf except U+200C and U+200D (scripts and emoji need them), plus U+2028, U+2029 and U+FFFC. The
   Cf table is written out (Unicode 17, 21 ranges) because the standard library has none and one table is not worth a dependency; `tests/display_name.rs`
   checks it over every scalar value against an oracle that is not a copy of it (the standard library's printable-character table, known Cf characters by
   name, the category size of 170). `security_baseline.rs` finds `tauri.<platform>.conf.json` by glob and fails when a
   platform file sets `app.security`, so the CSP exists in the base file only.

**Consequences.** Render counts are tested (`Shell.renders.test.tsx`); a new always-changing field must be followed by the part that shows it, never by
`Shell`. A newer Unicode version can add a Cf character; the table then needs the new range, and the sweep test (which has no copy of the table: the standard
library's printable-character table, a list of known Cf characters and the category size of 170) needs the new count. No new dependency.

---

## ADR-016 — One command registry, platform shortcuts, and a macOS-only native menu bar

**Status:** accepted (2026-10-02)

**Context.** The toolbar, the More menu and the keyboard each had their own idea of a command: the spike bound Ctrl or Cmd with O, plus,
minus and 0 in the viewer, the toolbar had its own shortcut chips, and the empty state a third copy. macOS needs a menu bar with every command (HIG;
without an Edit menu the webview's Cmd+C and Cmd+V do not work), while the Windows window has custom chrome with no native decorations (ADR-014).
The webview has no event permission (ADR-013), so a menu click cannot arrive as an event.

**Decision.**
1. **One registry.** `src/actions/registry.ts` lists every action: `id`, `labelKey`, `icon`, `shortcut`, `enabled(state)`, `run()`, and where it is listed.
   The toolbar's items (name, icon, chip, `aria-keyshortcuts`, enabled state), the More menu, the key handler and the macOS commands all derive from it or
   go through `runAction(id)`, which refuses an unknown id and a disabled action. There is no other shortcut table. `enabled` reads flags
   (`hasDocument`, the two zoom limits), not the zoom or the page, so ADR-015's render isolation holds. Tools are actions too (`tool-select` ... `tool-pages`).
2. **Shortcuts.** A binding is `{ key, mods }` with a canonical key name and `primary` as the modifier: Cmd on macOS, Ctrl elsewhere. It is exact: Ctrl is not
   Cmd on macOS, the Windows key never counts, Ctrl+Alt is never bound on Windows (AltGr), and Shift is ignored only for plus and minus. Keys are matched
   by layout for Latin letters and by position for digits and non-Latin layouts. The table follows `docs/research/ux-patterns.md` section 5: Open, Close
   (Cmd/Ctrl+W), zoom (Cmd/Ctrl with plus and minus), Fit page, Actual size and Fit width on Cmd/Ctrl with 0, 1 and 2 (Acrobat's; the same on macOS, where
   the research's Preview keys were unverified), Settings on Cmd/Ctrl+comma, the tool letters V H C D F S P. The research has no key for the rest, so they are
   chosen here and can be changed in one place: Option+Cmd+1 and Option+Cmd+I on macOS and F4 and Shift+F4 on Windows for the left panel and the inspector, and
   Alt+Down and Alt+Up for the next and previous page (they do not scroll the canvas). The handler (`src/actions/keys.ts`) never takes a key from a text
   field, a select or an editable element, nor from an event something else has handled or an IME composition. A bare printable key works only while focus is inside the canvas
   (`data-action-scope="canvas"`). A key it binds loses the browser's meaning (Ctrl and plus would zoom the whole window) even when the action is disabled.
3. **macOS menu bar.** `src-tauri/src/menu` builds App, File, Edit (system items, which is what makes copy and paste work), View, Window and Help from
   `src/actions/menu.json`. The labels are the `menu.*` keys of `src/i18n/locales/*.json`, compiled in with `include_str!`, so there is one catalog. The menu is
   rebuilt when the language setting changes (`update_settings` calls `menu::refresh`), and "system" uses the language the UI reports with `subscribe_menu`
   (`navigator.language`; a malformed tag counts as unknown). Tauri reads accelerator strings as physical key names, which have no plus: Zoom In is Cmd and the
   Equal key (the key handler also takes Cmd+Shift+Equal). Tauri drops an accelerator it cannot parse without a word, so a test parses every one with muda.
4. **Windows has no native menu bar.** The window has no native decorations and a native menu would need them; a custom menu bar in the caption row would be a second menu that
   duplicates More. Every command is reachable from the toolbar, More and the keyboard, with its shortcut shown in tooltips and menu items. If users miss a menu bar, a
   custom one in the caption row is the next step; the layout file would then drive it too.
5. **Menu clicks reach the UI through a channel.** `subscribe_menu(on_action: Channel<String>, system_language: Option<String>)` keeps the channel; `Builder::on_menu_event`
   hands each chosen item to `MenuBridge::forward`, which sends its id only if it is in `menu::spec::ACTION_IDS`: the system items and any other id are dropped in Rust. The UI
   runs only ids it has an action for (`parseMenuMessage`, `getAction`) and applies the action's own `enabled`. The capability gets `allow-subscribe-menu` and nothing else.
   `security_baseline.rs` pins the command, the capability and that the menu code never emits an event. Open is a command like the others: the menu sends `open` and the UI calls
   `open_document_dialog`, so there is one path (and one "opening" guard); the Rust dialog is not called from the menu.

**Consequences.** Ctrl+0 is now Fit page and Ctrl+1 is Actual size (the spike had Ctrl+0 as 100 %); Ctrl on macOS and Cmd on Windows no longer trigger shortcuts, and
`aria-keyshortcuts` lists the one modifier of the platform. The layout file, the registry and the Rust allowlist are tied together by tests on both sides
(`src/actions/menu.test.ts`, `menu::spec::tests`), not by one source: a new menu command needs the registry entry, the layout item, the id in `ACTION_IDS` and the `menu.*` keys.
The macOS menu is not synchronised with the UI's state: its items are not greyed without a document (the UI refuses a command that cannot run), and there is no Close Window
item, so Cmd+W without a document does nothing. Settings and About are placeholders until the settings popover item: they are in the registry, More and the menu bar, and run
nothing (macOS has the system About panel). The macOS side is built and tested for its data on Windows, but the menu itself has not run on a Mac (B-001). `muda` is a dev-dependency of the
backend (MIT or Apache-2.0, already in the build through Tauri, no default features) for the accelerator test.

> **ADR-016 amendment (2026-10-02):** next/previous page use the primary modifier with ↓/↑ (⌘↓/⌘↑, Ctrl+↓/↑) instead of
> Alt/Option+↓/↑, which is reserved for "move thumbnail up/down" (WCAG 2.5.7 alternative to dragging). Settings and About
> are no longer placeholders: they open the settings popover and the About dialog.

---

## ADR-017 — Document intake: open once, judge the handle; one app channel for every source

**Status:** accepted (2026-10-03)

**Context.** M1 opens documents from the dialog, a drop on the window, the OS (file association) and a second launch. The spike checked the path and
then let PDFium open it by path in the worker: a gap in which something else could be put at that path (SECURITY I3). A timed-out open could also finish
later and leave a document in the engine that no registry entry names, so nothing could close it, and a close sent after the timeout is refused while the
engine is still stuck.

**Decision.**
1. **One door.** `documents::intake::admit` canonicalizes the path, opens the file once (`O_NONBLOCK` on Unix, backup semantics on Windows, so a FIFO or a
   directory is turned down on the handle and never waited on), and judges that handle: regular file, at most 2 GiB, `%PDF-` in the first 1024 bytes. The
   handle goes to the engine as it is (`Job::Open { file }`, `load_pdf_from_reader`); no code outside `intake` opens a document by path
   (`security_baseline.rs::a_document_is_opened_through_intake_and_pdfium_gets_the_handle`). `Registry::claim` dedupes by the canonical path in one step with
   the registration, so two opens of one file are one document, also while the first still loads.
2. **No orphan.** The engine asks the job's `confirm` callback once the document is loaded; it records the page count in the registry in one step and fails
   if the entry is gone. A caller that gave up takes the entry back with `Registry::abandon`. Under the registry's lock the confirmation is first (the open
   succeeded after all) or the abandonment is first (the worker drops the document and its handle). The earlier "send a `close` after a failed open" is gone:
   it cannot reach a stuck engine.
3. **One app channel.** `subscribe_app(on_event: Channel<AppEvent>)` carries `dropHover { active }`, `opened { document }` and `openFailed { error }` (the
   error flattened, no file named), and the open dialog answers with the same `opened`/`openFailed` list, so the UI has one parser. Open results that come
   before the UI subscribes (a file the app was started with) wait in `AppEvents` and are sent first, in order, once, on subscribing. Rejected: handing them
   over in `app_ready`, which the settings store calls on its own schedule, so a result between that read and the subscription would belong to neither.
4. **Sources** (`sources.rs`): `WindowEvent::DragDrop` (with `dragDropEnabled: true`, ADR-013), `RunEvent::Opened` (macOS), the command line at startup and
   `tauri-plugin-single-instance` for a second launch (Windows only, first plugin, local only). The bundle registers `.pdf` as an alternate viewer. At most 32
   files are taken from one source, the rest being one `limit_exceeded`; each file of a batch succeeds or fails alone.
5. **Frontend.** The `documents` store (`byId`, `order`, `activeId`) holds every open document, so a multi-select, a multi-file drop or a second launch no longer
   closes what was open; the last one opened (or the existing one that was asked for again) is shown, and closing the active one shows its neighbour, until
   the tabs of M1 bring a way to switch. One banner for the first failure of a batch. A render that succeeds clears only the banner a render put there.

**Consequences.** `Cargo.lock` gains the Linux-only stack of the plugin (zbus and its async crates); `cargo deny` runs per desktop target and does not build
them. The macOS side (`RunEvent::Opened`, the file association, the unconfirmed `Alternate` rank) is written and its data is tested on Windows, but it has not run
on a Mac (B-001). A document opened while another request is still loading the same file answers nothing for that request: the first request reports it.

---

## ADR-018 — Render pipeline as built (M1: queue, buckets, tiles, virtual canvas, zoom and scroll modes)

**Status:** accepted (2026-10-03). Implements ADR-002 §2–§6; where it differs, this entry says so.

**Context.** M1 turns the spike's one-page viewer into a scrolling canvas: 500 pages, 60 fps, any zoom on any display, hostile page sizes.

**Decision.**
1. **Queue** (`engine/queue.rs`). A `BinaryHeap` behind a `Mutex` + `Condvar`, ordered priority, then newest generation, then arrival (`Control > Visible > Interactive > Near >
   Thumbnail > Background`). `set_viewport` cancels queued `Visible`/`Near` renders of that document that were asked at its generation or before and are in neither list
   (`cancelled`), and re-ranks the ones it keeps (visible or near, at the hint's generation); an older hint is ignored. Closing a document cancels everything queued for it. A
   full queue (64) refuses a job unless it outranks the lowest queued one, which is cancelled in its place; jobs whose caller gave up are dropped first. Identical frames
   (`doc, page, bucket, tile`) are one job, queued or running: later callers wait for the same answer (`finish_render` hands the waiters over under the queue's lock). At most 8
   callers join one job (the rest get `limit_exceeded`, `requests`: the UI asks for a frame once, so a crowd is not the UI), and the frame is an `Arc` that all of them share, so
   the worker never copies a multi-megabyte image once per caller; the IPC response copies it once, on the caller's own thread, only if it is shared. A close is the one job
   that is never skipped for an expired caller: it releases a document, so a timeout must not leave it in the worker.
2. **Bucket** `b = ceil(4·log2(ratio))` with `ratio = zoom · 96/72 · devicePixelRatio` (device px per point; ADR-002 §4's "zoom" is this product), rendered at `2^(b/4)` px per
   point, `b` in −17..=24. 100 % at DPR 1 is bucket 2. The cache key is `doc:page:rev:bucket[:col,row]`: the DPR is inside the bucket, so it is not a key part of its own.
3. **Tiles.** A page is one frame up to 4096 px a side and 8 Mpx (the backend allows 16 Mpx), otherwise 1024 px tiles from a grid of at most 64 × 64 over a whole-page
   underlay at the largest bucket that fits 4 Mpx. The worker renders a tile into a 1024² bitmap with the page laid out at full size and shifted (`set_origin`); a test proves a
   tile is pixel-identical to that part of the whole page. This replaces the 0.7× retry. A tile the backend's grid lacks (a pixel of rounding) is ignored by the scheduler.
4. **Page sizes** are their own command, `get_page_sizes(doc_id) -> [[w, h]]` in points (rotation applied, sanitized to 1..14 400 pt, US Letter for nonsense), not part of
   the `opened` event (ADR-002 §5): the event stays three fields and the registry independent of PDFium. A document with more than 50 000 pages is refused at open
   (`limit_exceeded`, `pages`), which bounds the answer and the scroll height. The worker reads the sizes once, when it loads the document, and keeps them (`engine/sizes.rs`)
   until the document is released; `get_page_sizes` is a lookup of that list, so it takes no queue slot and cannot be made to repeat the work, however often it is asked.
   (This replaces a `PageSizes` job per call.)
   **Bounds on the render commands.** A tile column or row of 64 or more is refused at the command (`invalid_argument`, `tile`); a viewport hint's lists are `PageList`s, which
   refuse the 65th page while the list is read; `render_page` calls in flight are capped per document (96) and in all (128) by `RenderGate`, above what the UI can have pending
   (every distinct frame needs one of the queue's 64 places), so a flood cannot park the blocking pool. `close_document` marks the registry entry as closing (gone for the UI:
   `not_found`, its path can be opened anew) and removes it only when the engine confirms the release; a close the engine could not take is retried by the next open or close.
5. **Frontend.** `engine/renderCache.ts` (Blob LRU, 256 MiB default, 128–1024, pins per mounted page, lazy object URLs revoked on eviction, in-flight dedupe, best
   cached bucket as a stand-in) and `engine/renderScheduler.ts` (generation per document, `set_viewport` 150 ms after the viewport settles, quiet `cancelled`). The canvas
   (`features/viewer`) lays out from the sizes (`layout.ts`, pure), mounts the visible pages and one viewport height around them (≤ 24), and keeps the point under the pointer or
   at the middle of the viewport when the zoom or the mode changes: a zoom, a jump and a mode change leave a `ScrollAnchor` in the view store that the canvas applies in a
   layout effect and consumes. The DPR is followed through a `resolution` media query. Pinch is `ctrl+wheel` (WebView2) or WebKit's `gesture*` events (WKWebView).
6. **Zoom and scroll modes.** Fit width and fit page are modes (`view.fit`) that follow the window until the next zoom of another kind. Scroll modes are `continuous`, `single`
   and `spread` (a pair, 2·k and 2·k+1, side by side); the two paged ones show one row, turn with next/previous page (a spread turns two) and with the wheel at the end of the page
   (400 ms between turns), and render the neighbouring rows ahead, after the same 80 ms settle time a page waits for after its bucket changed (so a held zoom key renders
   only the bucket it stops at). They are three registry actions, in More (checked) and the macOS View menu.

**Consequences.** `RenderRequest.forms` waits for M4. The cache budget is a constant until a setting exists. A document of ≥ ~8 000 pages at a high zoom exceeds the browser's
maximum element height (≈ 33 M px); the scroll height is not compressed. A hint is a generation behind a render that the UI asked just after it, so it never cancels it.

---

## ADR-019 — Read APIs as built (M1: outline, text layer, search, links, document flags)

**Status:** accepted (2026-10-03). Implements ARCHITECTURE §5 (outline, text, search, links) and ADR-002 §2, §3, §7; where it differs, this entry says so.

**Context.** The left panel (outline, search, thumbnails) and the viewer's text and link layers need what PDFium knows about the *content* of a document. Every byte of it is
hostile (SECURITY P2, P3, P5, P7): a bookmark tree that is a cycle, a million siblings, a link that launches a program, a URL that is a `file:` path, a page with ten million characters.

**Decision.**

1. **Engine jobs.** `Outline`, `TextLayer` and `PageLinks` are `Interactive` jobs (after the pages on screen, before anything that was not asked for), `SearchPage` is `Background`;
   each has the 10 s deadline of ADR-002 §8. The engine is asked for page *indices*; the commands map them to page ids (identity until M3) and back. A search is a loop on a
   blocking-pool thread that asks for one page at a time, so the queue's priorities are what keep a scroll from waiting for it; a page the engine was too busy for (a full queue, or
   more urgent work for the whole deadline) is asked again up to 10 times, 250 ms apart, before the search ends with `failed`.
2. **Page space.** `model::geometry::PageBox` turns PDFium's user space (y up, origin wherever the crop box is) into ADR-003 §1's page space (points, top left of the page's box, y down,
   before `/Rotate`), checks that every number is finite, brings it within ±14 400 and keeps a hundredth of a point. One `PageBox` per page read, from `FPDF_GetPageBoundingBox`.
3. **Search is Rust's, over PDFium's text. (Deviation from ADR-002 §7, "PDFium searches".)** Measured with the fixtures of `tests/support/fixtures.rs`: PDFium's search folds the case
   of ASCII letters only (`MÜNCHEN` does not find `München`) and does not find `hyphenated` in `hyphen-` / `ated` on two lines, because the hyphen of a line end stays in its
   text as U+0002. `model::find` normalizes the text of the page (the same characters as the text layer) and the query alike (Unicode lower-casing, ligatures as letters, soft hyphens gone,
   a run of white space is one space), finds hits with KMP (linear whatever the page and the query) and PDFium gives the box of each character of each hit, merged per line. `ß` is not
   `ss` (full case folding is not done). What can be selected is what can be found.
4. **The text layer has a box per UTF-16 code unit** (`boxes.length == 4 * text.length` as JavaScript counts), not per Unicode scalar: it is what `Range` offsets and string indices
   are, and a character of two units has its box twice. PDFium hands a character outside the Basic Multilingual Plane over as two surrogate halves where its characters are 16 bit (Windows;
   measured); `engine::text::text_chars` puts them together, for the layer and the search alike. The layer is cut at 200 000 units (`truncated`), a search looks at the first 1 000 000
   characters of a page.
5. **Outline.** Depth first with a set of the bookmarks read (`PdfBookmark` is hashed by its handle): a chain that comes back to one ends there. The tree is cut at 10 000 nodes and 32 levels;
   a title is one line (`\r \n \t` are spaces), goes through `documents::sanitize_text` (the display-name filter, now one function for both) and is cut at 512 characters. A bookmark has a
   target only if its action is a jump in this document (PDFium reads the destination of a `GoToR` action too, and its page number is a page of the other file).
6. **Links.** From the page's link annotations (`/Annots` order); `pdfium-render`'s `PdfPageLinks::get(i)` is `FPDFLink_Enumerate` from annotation position *i*, which repeats links on a page that
   has other annotations, so it is not used. At most 1 000 links, taken out of the first 10 000 annotations. `Page` / `Url` / `Blocked` as in ARCHITECTURE §5; the URL rules are in
   `security::links` (SECURITY P3). `SafeUrl` has no public constructor and is what the dialog and the opener take.
7. **`open_link`.** `open_link(doc_id, page_id, link_index)`: no URL crosses IPC. Rust re-reads the page's links, checks that the link is a `Url`, asks in a native message box (`tauri-plugin-dialog`,
   `blocking_show`, called from the blocking pool; texts `link.confirm.*` of the UI catalogs in the language of the settings, the URL filled in last) and calls
   `tauri_plugin_opener::open_url`. The opener plugin (Apache-2.0 OR MIT) is a dependency for that one function: it is not registered with the builder and no capability names it, so there is no
   `plugin:opener|…` command for the webview, which `security_baseline.rs` pins. Why not write it: starting the system's handler is Win32 and Objective-C FFI, which `unsafe_code = "forbid"` rules out.
8. **Flags.** `DocFlags { encrypted, xfa, has_forms, signed }` is read when the document is loaded and kept with the page sizes (`engine/sizes.rs`), set into the registry and part of
   `DocumentInfo` (`flags`). `encrypted`: the security handler revision is not "unprotected"; `xfa`, `has_forms`: `FPDF_GetFormType`; `signed`: a signed signature field, looked for only in a
   document that has a form (counting signatures walks every page). Best effort, nothing to rely on for security.
9. **Cancellation and bounds.** One search per document: a new one, `cancel_search` and `close_document` set a flag the loop reads between two pages; a cancelled search sends nothing more
   (a page being searched is finished and its hits dropped). At most 64 searches run at once. The command layer applies the bounds again on what it sends. Search events are on a channel per search, so a message belongs to the
   search whose channel it came on.
10. **Deviations from ARCHITECTURE §5 as first written.** `SearchEvent::Failed` (the engine could not go on), `flags` in `DocumentInfo`, boxes per UTF-16 unit, `LinkInfo.index` is the position among the page's links,
    `invalid_argument` / `limit_exceeded` with `what` = `query`, `hits`, `link`, `searches`.

**Consequences.** A page that is rotated by an angle that is not a multiple of 180° in its text (not its `/Rotate`) gets one rectangle per character for a hit. Text in right-to-left order is
searched in PDFium's logical order. A page with more than 1 000 000 characters is searched only in its first million. `FPDF_GetSignatureCount` is not called for a document without a form, so
a signature in a document with no AcroForm (malformed) is not reported. The UI's selection of text, the search panel, the outline panel and the link layer are separate items (M1 items 4–6).

---

## ADR-020 — Mood: visible gradient, tinted glass

**Status:** accepted (2026-10-03). Product-owner feedback F2 (`docs/FEEDBACK.md`). Overrules ORCHESTRATOR_PROMPT §3 "gradient barely visible";
amends ADR-011 and ADR-012 where named. Spec: `docs/DESIGN.md` §1.2, §1.3, §1.10, §3.10–3.12, §4.

**Context.** The product owner finds the app "grey, empty and lifeless". The background gradient (`#F4F5FF → #FAFAFF`) is invisible,
the glass is near-white over near-white, so translucency never reads, shadows are grey, and the empty state is a lone card.
The target mood: soft light gradient, translucent cards with large radii and a thin light inner edge, icons in small
rounded tiles, pill badges, white space, in one hue (Iris). Blur over a smooth gradient shows nothing, so a visible
gradient alone does not make glass visible.

**Decision.**

1. **Background:** 135° iris-100 → iris-50 (dark `#1C1D40 → #0F1020`), plus three static light fields in the background
   layer (Iris top left, white top right, pale Iris bottom left) that give the toolbar row and the panels something to
   frost. Fields end 240 px below the window top; text placed directly on the background stays below that band.
2. **Tinted glass:** `--surface` iris-50-based at .66 (dark `#1E1E3A` at .60), `saturate(160%)`, a top-lit two-part inner
   edge. `--surface-strong` and solid dialogs stay neutral (a tint over pages is invisible and breaks the 3:1 border).
3. **Iris shadows** in light (iris-500 at 12 % for G1's main shadow); dark keeps black.
4. **Tiles and pills:** accent icons in iris-100 tiles (toast, info banner); "Edited" and the Open shortcut as pill badges.
   Semantic icons on glass use their `-text` colors.
5. **Empty state:** the full logo at 160 px in its own 184 px slot as the focal point, floating 8 px on a 6 s sine cycle;
   the card loses its icon tile, gains radius 24 (`--radius-card`) and padding 40.
6. **Fallbacks:** solid mode → `--surface-fallback` (`#F8F8FF` / `#1E1E3A`), fields off, gradient kept; forced colors →
   system colors, no gradient, no shadows; reduced motion → no float.

**Consequences.** Worst-case contrast drops but stays AA: muted text on light glass 4.99 (was 6.03), on the background
4.67; control border on light glass 3.14; all recomputed in DESIGN §4. Blur now costs a visible effect on the toolbar and
panels; it stays off the canvas and never animates. The float is the only infinite animation; it runs only on the
empty state, compositor-only, paused when the window is hidden. `tokens.css` and `tokens.test.ts` gain the tokens listed
in DESIGN §1.10. Acceptance per F2: Tauri-window screenshots, light and dark, empty state and document, designer PASS.


**Addendum (2026-10-03, designer review of Tauri-window screenshots).** The document view kept the grey look the empty state lost:
native scrollbars, a flat canvas, a dark canvas like a hole, no page edge in dark, and an empty inspector column at ≥ 1280 px. Hence:
thin token-coloured scrollbars everywhere (native under forced colors; DESIGN §1.11), `--color-canvas` #ECEDFC / #111226 with a
`--canvas-edge` inset, a dark `--page-shadow` with a 1 px light ring, and the inspector track is no longer reserved in `auto` mode:
it opens (and closes) with the left panel's grid-track transition when there is a selection or a tool other than Select (DESIGN §2.4).
---

## ADR-021 — Visual review from the real Tauri window (dev tooling)

**Status:** accepted (2026-10-03)

**Context.** The product owner judges the look in the app, not in a browser tab: F2 and F3 are accepted by screenshots and a
screen recording of the Tauri window, and every milestone now needs a designer verdict on such screenshots (ORCHESTRATOR §8.6).
A browser preview misses WebView2's rendering, the native caption, the backend (no documents) and the real frame pacing.

**Decision.** `scripts/ui/` (Windows; macOS waits for B-001), dev only, no dependencies, nothing shipped (`docs/UI_REVIEW.md`):
`dev.sh` runs `tauri dev` with `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222` (loopback, this process only,
never in `tauri.conf.json` or a release build); `cdp.mjs` drives the window over that port (evaluate, theme, frame-time
statistics from `requestAnimationFrame`); `shot.ps1`/`record.ps1` capture the window itself with `PrintWindow`
(`PW_RENDERFULLCONTENT`), at a fixed ~1280×800 client size, into the git-ignored `review/`. A document is opened as the OS does
it: a second launch of the debug binary with the path, which single-instance forwards. Verdicts are PASS/FIX by the `designer`,
who reads the PNGs. Frame pacing is measured in the page (`cdp.mjs fps`), because `PrintWindow` caps a recording at ~10–20 fps.

**Consequences.** The `fetch(`/`WebSocket` hits in `scripts/ui/cdp.mjs` are loopback CDP in a dev script, not app networking
(rule 4 concerns the product). Captures show the window content, not OS material behind it.

---

## ADR-022 — One motion system

**Status:** accepted (2026-10-03). Product-owner feedback F3 (`docs/FEEDBACK.md`). Spec: `docs/MOTION.md`; replaces DESIGN §1.6 and
amends ADR-011/012 motion tokens, ADR-018 §5 ("nothing animates" on the canvas) and ADR-020 (G2 blur).

**Context.** Motion grew per component: three easings (an overshooting `cubic-bezier(.34,1.56,.64,1)` for transforms, ease-out,
ease-in), 150/200/250 ms, panels that only fade, a canvas that jumps on every zoom, page frames that pop in, and a left-panel
collapse that animates the grid tracks so the canvas reflows every frame and the centred page drifts by half the track before
fit width re-fits at the end (a second jump).

**Decision.**
1. **One curve:** a spring with bounce .15 (damping ratio .85). CSS `--ease-spring` is its `linear()` sampling over the visual
   duration (fallback `cubic-bezier(.25,.1,.25,1)`); Motion uses `{ type: "spring", bounce: .15, visualDuration }`. Peak
   overshoot 0.6 %, so it serves opacity, transforms and grid tracks alike. `--ease-in`/`--ease-out` are removed.
2. **Three durations:** 120 / 200 / 320 ms (`--motion-fast/base/slow`); exits one step shorter and opacity-only.
3. **Layout:** only the main row's columns and the banner row may animate. Contents do not reflow per frame (panels slide at
   their final width in a clipped track; fit width is a transform until it commits once at rest). The canvas keeps the document
   point under the pointer or viewport centre fixed. *Anchored* means: no vertical movement; a page narrower than the canvas
   stays centred in its slot (rule 8) and glides with the panel in one spring, never in a jump or two steps.
4. **Zoom** animates as a transform with inertia (projected target) and snaps to fit width, fit page and 100 % within ±8 %;
   a document opens at fit width capped at 100 %.
5. **Blur** only on G1 (toolbar, panels, banner, empty card); G2 loses its backdrop filter because it sits over the canvas.
6. **Reduced motion:** opacity only, layout and zoom at once.
7. **Scrollbars:** the `::-webkit-scrollbar` recipe in both webviews, arrow buttons hidden; standard `scrollbar-*`
   properties dropped (on WebView2 they disable that recipe and draw arrow buttons).

**Consequences.** `tokens.css`, `tokens.test.ts` and a new `src/lib/motion.ts` (parity-tested) change; every component that
named `ease-out`/`ease-in` moves to `ease-spring`. The canvas gains a per-frame anchor during track animations and a transform
layer for zoom. Acceptance: Tauri-window screen recording plus `cdp.mjs fps` per MOTION §5 (avg ≥ 58, p95 ≤ 18 ms).

---

## ADR-023 — Welcome tour: a generated sample PDF, coach marks, one step manifest

**Status:** accepted (2026-10-03). Product-owner feedback F4 (`docs/FEEDBACK.md`). Spec: `docs/DESIGN.md` §3.14; motion: MOTION §4.7.

**Context.** First launch should teach by doing: a bundled PDF where every page is a task, coach marks at the tools, a short
success moment, progress in the status bar, skippable, restartable, and never shown automatically twice. Only Open, Navigate and Zoom
exist in M1. Highlight and comment (M2), reorder (M3) and signature (M4) follow.

**Decision.**
1. **Generated, not drawn.** The test-side `PdfBuilder` generates the document (`tests/welcome_document.rs`), and the result is committed
   under `src-tauri/resources/welcome/` with an up-to-date test. No production code gains a PDF writer or `expect()` paths. It uses vector paths, one axial shading,
   Helvetica and Helvetica-Bold (Standard 14, WinAnsi, not embedded), and no images, annotations, links, actions or JavaScript. Page size 600 × 800 pt
   keeps the 8 grid. One edition each for en and de, with strings from the locale files (one source with the UI).
2. **One manifest.** `src/features/tour/steps.json` holds ids, pages, target rects and `shipped`. Both the engine and the generator read
   it, so the coach mark's canvas target and the drawn frame cannot drift. Unshipped steps are absent from the app *and* the PDF,
   so the tour never asks for a missing tool.
2a. **4–5 pages.** A closing page ("You're all set": what to try next, restart via Settings, shortcuts) is always last. Tasks share
   pages: Welcome (open + navigate), Zoom, Markup (highlight + comment), Sign and sort (sign + reorder). An untasked Navigate page exists
   only to keep an edition at 4 pages (M1: Welcome, Navigate, Zoom, Closing). From M3 on, Markup and Sign and sort are printed swapped
   ([4] before [3]), and the reorder task moves page 3 above page 4. Five pages in total, and the closing page never moves.
3. **Coach mark at `--z-popover`**, clamped to the canvas slot, never over chrome, its anchor or its target. It is non-modal, never takes
   focus, sits in the F6 cycle, and is not in `DISMISS_PRIORITY` (Esc releases tools as before). The anchor's tooltip is suppressed, the card yields to popovers, and toasts move above it.
   The Navigate card may cover the page's own copy of the same instruction at scroll 0; accepted.
4. **Once only.** Setting `welcomeTour: pending | shown`, written `shown` *before* the document opens. It does not start when a file
   came with the launch. Restart lives in the Settings popover. Close or Skip ends the tour, with no resume.
5. **Sample semantics.** `open_welcome_document()` opens the resource through the normal intake (hostile input as always) as
   `kind: "welcome"`. It is read-only, Save acts as Save As, and closing discards edits without a prompt (confirmed by the product owner).
6. **Success** is the shared `pulse()`, with no dialog or toast. Announcements go through the status bar's polite live region.

**Consequences.** `Settings`, `update_settings` validation, `DocumentInfo` (`kind`) and the IPC surface (`open_welcome_document`) change
in ARCHITECTURE. `win_ansi` learns „ “ ” …. Each tool PR (M2–M4) flips `shipped`, adds its detector and regenerates both PDFs.
The security review covers the new command (no path crosses IPC; the resource path is resolved in Rust only).

## ADR-024 — Stop hook: WAITING turns, stuck detection, cap 60

**Context.** Turns that end only to wait for subagents burned loop budget, and a session could spin without progress until the cap.

**Decision.** `.claude/hooks/continue-loop.sh`: if `.claude/state/WAITING` exists, the hook deletes it and blocks without counting the
loop. Each counted loop compares `refs/heads/main` with the last seen value; ten loops in a row without a new commit allow the stop.
`CC_MAX_LOOPS` defaults to 60. `session-start.sh` resets the stall counter and a stale WAITING file on a real start.
ORCHESTRATOR_PROMPT §7.6 tells the orchestrator to create WAITING before every turn end that only waits for agents.

## ADR-025 — Feature loop in work packages

**Context.** One roadmap item per loop, with a tester, reviewer re-rounds and live checks after every item, cost more turns than
the features themselves.

**Decision.** ORCHESTRATOR_PROMPT §8.4/§7.6 and the agent files:
1. At milestone start the orchestrator cuts the open items into 2–4 disjoint work packages of 3–5 items (listed in `STATE.md`) and
   runs one `implementer` per package in parallel (max. 4, shared working tree, own files only). One loop = one package.
2. The `implementer` runs `npm run check` itself. The `tester` runs only at milestone end. One `reviewer` per package. The
   `security-reviewer` runs for packages that touch config, capabilities, IPC, file access or parsing, and at milestone end. The
   `designer` reviews only at milestone end, from four screenshots (light/dark × empty state/document). No deep or re-reviews.
3. At most one FIX round per package. Minors go to one polish ticket per milestone (`- [ ] Politur Mx` in `ROADMAP.md`).
4. No live measuring, recording or checking between packages; fps measurement and Tauri window acceptance run once at milestone end
   with the `scripts/ui/` tools.
5. `maxTurns`: implementer 100, reviewer 30. Package briefs may have 300 words.
6. The milestone Definition of Done (§8.6) is unchanged.

**Consequences.** Shared working tree instead of worktrees: §9 has no feature branches, and each worktree would need its own
`node_modules` and `target`. Packages therefore must not share files; the implementer reports failures in other packages' files
instead of fixing them, and each package commit stages only its own files. The Stop hook's prompt names the next package.

## ADR-026 — Remaining M1 viewer surfaces (DESIGN §3.16–§3.21)

**Context.** Search, text selection, document tabs, password prompt, go to page, rotation, link confirmation and the XFA warning
needed specs before the M1 work packages start.

**Decision.** The designer's spec (DESIGN §3.16–§3.21) with these choices:
1. **Tabs:** own grid row (`--tabs-row-height` 32, 0 without a document); no drag reorder in M1; Ctrl+Tab / Ctrl+Shift+Tab on both
   platforms (Cmd+Tab is the macOS app switcher); primary+W closes the tab.
2. **Go to page:** primary+Shift+N focuses the page field in the status bar.
3. **Rotate view:** primary+R / primary+L, view-only (never written to the file), kept per tab.
4. **Search:** live after 2 characters, capped at 10 000 hits in the UI; Windows also binds F3 / Shift+F3.
5. **Link dialog:** focus starts on Cancel, hosts shown as punycode, no "don't ask again".
6. **Password prompt:** after the third wrong attempt each retry waits 1 s, enforced in Rust; the password lives only in memory.

**Consequences.** New tokens `--tabs-row-height`, `--tab-min`, `--tab-max`, `--dialog-width` (tokens.css, tokens.test.ts, §1.9).
