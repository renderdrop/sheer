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
7. **Brand reference.** The provided design file `Sheer — Logo & Farbe.html` is the human-supplied brand reference
   (moved from the repo root to `assets/brand/` before publication, ADR-045). The brand sources are now `assets/brand/icon*.svg` and `wordmark*.svg` (`logo.svg` and the HTML reference were deleted in Politur v1.3, nothing referenced them).

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

## ADR-027 — Link confirmation stays native; intake hardening; hostile corpus (M1 P3)

**Context.** DESIGN §3.21 and ADR-026 §5 describe an in-app link dialog (focus on Cancel, punycode host). The shipped flow is a native
message box from Rust (`commands::links::DesktopLinkUi`) that shows the URL in full with "Open link" / "Cancel".

**Decision.**
1. **Keep the native dialog for M1.** The safety content of §3.21 is met in Rust, where it cannot be bypassed: only `http`, `https` and
   `mailto` pass `security::links::classify`, at most 2048 bytes, ASCII only (so a host is punycode by construction; a non-ASCII
   host is refused, never shown as Unicode), no `user@`, `mailto:` without `attach`; the URL the user sees is the one that is opened;
   nothing opens without a click and the webview cannot open anything. What the native box cannot do is the default focus (the OS picks it)
   and a "Copy link" button; both move to the in-app dialog if it is built later (M2 polish). A blocked link is not clickable, so the
   "blocked" variant of §3.21 is not needed.
2. **XFA banner** is a second banner row (`XfaBannerRow`, `role=status`) driven by `flags.xfa` of the active document, dismissal per
   document for the session. It is separate from the error banner so an error and the XFA notice can show together.
3. **Intake:** the file is opened first and judged; the registry key (canonical path) is derived afterwards and accepted only if a second
   open of that path is the same file (device and inode on Unix; volume serial and file index on Windows, ADR-028; was size and times).
   A change in between is `io_in_use`. On Windows, paths beginning with two separators other
   than `\?\C:\` (network shares, `\?\UNC\`, `\.\` devices) and names with a colon after the drive (NTFS alternate streams) are refused
   before the file system is touched, so no open waits on a network. A bare word right after a `--long-option` on a command line is that
   option's value and is skipped.
4. **Corpus:** 50-odd generated files in `tests/fixtures/malformed/` (`tests/support/malformed.rs`), checked for drift like the other
   fixtures, and `tests/fuzz_corpus.rs` opens each one with a per-file timeout. An `internal` error counts as a failure.

**Consequences.** The corpus found two ways to keep PDFium busy past the render deadline, both left out of it because the engine is
then `engine_unavailable` for the rest of the process (P5, P6; the app stays up and every call answers with a typed error): a tiling
pattern with a tiny `/XStep` filling a large area, and a Form XObject that calls itself twice per level. The corpus holds the
bounded variants (`XStep 2`, one call per level). A real fix is the engine process of M7.

## ADR-028 — Politur M1: file identity, worker respawn, unlock serialisation, link summary

**Context.** The M1 security review left five open points (ROADMAP "Politur M1"). `unsafe` stays forbidden in our code.

**Decision.**
1. **File identity on Windows.** `documents::intake::same_file` compared size and times; it now compares the handles' identity (volume
   serial number and file index) through the `same-file` crate (Unlicense OR MIT, already in the build through walkdir; listed in
   LICENSES.md as a direct, Windows-only dependency). Unix keeps device and inode from `std`. The registry stays keyed by the canonical
   path (hard links to one file remain two documents; accepted, a second document of one file is harmless and read-only).
2. **Mapped network drives.** A drive letter that maps to a share cannot be told from a local one by its spelling, and the drive type
   needs `GetDriveTypeW` (`unsafe`) or a dependency for one call. So the **first open of a path on a mapped drive may wait on the
   network** (SMB timeouts, up to tens of seconds, on the blocking pool, not on the UI). Afterwards the canonical path is a
   `\?\UNC\...` one and is refused, so a share is never loaded. Revisit with the engine process (M7), which can be killed on a timeout.
3. **Engine respawn.** When a caller meets a worker stuck past its deadline (`engine_unavailable`), the engine retires that worker and
   starts a new one on a new queue (`Engine::recover`). The stuck thread cannot be stopped: if it ever returns it serves nothing more
   (`Health::retire`) and leaks its PDFium state instead of dropping it (dropping would run `FPDF_DestroyLibrary` under the new
   worker). At most 3 respawns per process (`engine::MAX_RESPAWNS`), each leaking a thread and its PDFium state; after that the engine
   stays `engine_unavailable` until restart. Documents of the old worker are gone: they answer `engine_crashed` until closed (same path as a quarantined document), the UI
   must reopen them. Page sizes stay readable until close. Two PDFium instances can exist in one process for as long as the old
   thread is stuck, but only one is ever called. Leaks: one stuck thread and its memory per wedge until restart. The wedge cases
   (tiny `/XStep`, self-calling Form XObject) are `#[ignore]`d tests in `fuzz_corpus.rs`; the per-file timeout is 15 s. A dotless file
   name after a bare `--flag` on a command line is skipped as that flag's value (documented in `fuzz_corpus.rs` and ADR-027).
4. **Unlock.** `AppState::unlock` reserves an `UnlockGate` slot per document before it reads the wrong-password count, and at most 4
   run at once; the others get `limit_exceeded` (`what: "unlocks"`). Parallel calls can no longer skip the 1 s wait, and sleeping
   unlocks cannot park the blocking pool. **Residual risk:** the password arrives as an ordinary `String` deserialised by Tauri's IPC
   (JSON), then moved into `Zeroizing`; the deserialised copy, the webview's JS string and the WebView2/WKWebView IPC buffers are not
   wiped and may linger in memory. Not fixable without leaving JSON IPC; the threat model (SECURITY D3) is a local, same-user attacker
   who can read process memory anyway.
5. **Link dialog.** The native box shows the host on its own line, then the URL cut to 120 characters with `…`. A host with `xn--`
   labels is shown as `xn--... (decoded)` using a small in-house RFC 3492 decoder (no dependency); the decoded form appears only
   if every character is a letter or digit, and the `xn--` form is always shown with it.

## ADR-029 — M2 annotation UI (DESIGN §3.22–§3.27)

**Context.** M2 adds annotation tools, an inspector, a comments panel and save/undo affordances; the designer's spec needed a few calls.

**Decision.**
1. **Tools:** no split buttons. Each tool remembers its last variant; pressing the tool key again cycles variants; the inspector holds a
   segmented chooser. Markup (H), Text (T), Shapes (R) get letters; when space runs out, Pages moves into More first, then Undo/Redo.
2. **Ink:** strokes ≤ 1000 ms apart join one Ink annotation.
3. **Keyboard:** each annotation is a Tab stop after the canvas; F6 skips them; arrows nudge, Alt+arrows resize.
4. **Palette:** the eight Okabe-Ito colours (colour-blind safe), identical in light and dark (annotation colours are document content).
   This **supersedes ADR-011 §9** (six swatches). "Recent" lists colours found in the file that are not in the palette.
5. **Free text:** Helvetica (Standard 14) only in M2; no font embedding.
6. **Author:** new setting "Author name", default the OS display name, stored locally only.
7. **Quit with several edited documents:** asks one document at a time.

**Consequences.** New tokens per DESIGN §3.22–§3.27; `Settings` gains `authorName` (validated, ≤ 128 chars).

## ADR-030 — Tempo level 2

**Context.** Product-owner decision (2026-10-03): ship v1.0 faster; review rounds, CI waiting and Should/Could scope cost more than they return.

**Decision.**
1. **Designer review at milestone end: one round only.** Only `blocker` findings trigger a fix package; major and minor go to the next
   milestone's polish ticket. No second round. (DoD §8.6 adjusted: no open `blocker`; major → polish.)
2. **CI status is checked once per milestone** (at milestone end, the last finished run on `main`); never wait for a running run. A red run
   is fixed as part of the milestone close. This replaces the "check after every push" rule of FEEDBACK F6 (§9); pushing after every commit stays.
3. **fps measurement and all onboarding steps move to M7** (ROADMAP M7: onboarding steps highlight/comment, reorder, signature; fps in the Tauri window).
4. **Roadmap M2–M6 trimmed to "Must" from docs/FEATURES.md.** Should/Could items move to one ticket "v1.1-Backlog" (ROADMAP, marked `[~]`, not picked
   by the loop): comments panel, stamps, edit existing text, replace image, header/footer/watermark, reveal in Finder/Explorer, OCR, read mode, XFDF,
   self-signed digital signature.
5. **Four implementers in parallel per milestone**, packages cut accordingly (in waves of four where dependencies require it).

**Consequences.** ORCHESTRATOR_PROMPT §7.6, §8.4 (steps 1, 3, 8), §8.6 and §9 changed. M2 keeps the comments needed for notes (sticky-note popover,
replies via /IRT stay in the model) but loses the comments panel.

## ADR-031 — Release workflow (unsigned)

**Context.** FEEDBACK F7: tagged versions need downloadable installers; there are no signing certificates or secrets (BLOCKERS B-002).

**Decision.**
1. `.github/workflows/release.yml` triggers on `push` of `v*` tags and on `workflow_dispatch` with input `tag`; it checks out
   `refs/tags/<tag>` and never creates, moves or pushes tags (`gh release create --verify-tag`).
2. Matrix `windows-latest` (`--bundles nsis`) and `macos-latest` (`--bundles dmg`). macOS builds for the runner architecture (arm64),
   not universal, because the pinned PDFium binary is fetched per runner architecture; Intel Macs are not covered until that changes.
3. Installers are unsigned; no signing secrets or updater keys. The release body says so and links B-002.
4. Least privilege: workflow-level `contents: read`; only the `publish` job has `contents: write`. Concurrency group per tag, no cancel.
5. Release notes = `scripts/changelog-section.sh <version>` (tested in `scripts/changelog-section.test.ts`). Versions `0.x` are pre-releases.
   Assets: `.exe`, `.dmg`, `SHA256SUMS.txt`. An existing release for the tag is edited and its assets replaced.

**Building an old tag.** `gh workflow run release.yml -f tag=v0.4.0` (the workflow file must exist on the default branch; the build
itself uses the tag's sources, so a tag older than this workflow still builds; the publish job uses the workflow commit's `changelog-section.sh` on the tag's `CHANGELOG.md`).

**Consequences.** Users get a SmartScreen/Gatekeeper warning until B-002 is resolved.

---

## ADR-033 — Saving annotations (M2 P8)

**Status:** accepted (2026-10-03). Implements ADR-004 §1 for annotations; where it differs, this entry says so.

1. **Incremental only.** `pdfwrite` (lopdf 0.45, MIT, `default-features = false`) appends dictionaries, appearance streams, the changed `/Annots` arrays and an xref section to the original bytes. A positional `/Annots` index counts dictionary entries that are not `/Subtype /Popup` (what PDFium lists); `PdfOrigin.annot_index` is that, and a save returns the new position of every annotation of a touched page.
2. **History is dropped on a successful save** (deviation from ADR-003 §7 "survives save"). Snapshots in the steps carry `sync` and file positions from before the save; undoing one would mark a file annotation clean with other content. `DocState::finish_save` clears the stacks. Keeping them needs a rebase of every slot; later.
3. **Encrypted files** are not changed (`unsupported_feature`) until ADR-004 §5's spike is done; no password is kept after open.
4. **Temp file names** stay those of `storage::atomic` (`.<name>.<pid>.<n>.tmp`, swept at start) instead of `.sheer-<random>`. Validation is lopdf (re-parse, page count) plus PDFium's reopen; if the reopen fails the original bytes (the prefix of the new file) are written back. Backups: `<app data>/backups`, once per document per session, 30 days / 2 GB; failure to back up is logged and does not stop the save. No setting to turn them off yet.
5. **Save As** is `save_document_as` with a Rust-side dialog; the path goes through `intake::admit_target`. The document is rebound to the new file (user kind). The welcome document answers `read_only` to `save_document`; `tests/security_baseline.rs` pins the order of the checks.
6. **Line ends:** `/LE` is `[tail (at from), head (at to)]`. A free text's `/Contents` is its lines joined by LF; its `/C` is its fill and its colour is only in `/DA` (the import reads the colour back as black until it parses `/DA`).
7. **Import fix.** pdfium-render's `stroke_color()`/`fill_color()` crash PDFium for any annotation with an appearance stream (the fallback treats the annotation handle as a page object). `engine::import` reads colours from the paths of the appearance and never calls the two (superseded by ADR-035 §1: an /AP without objects cannot be told from no /AP, so an annotation without objects gets the default colour of its kind). Remove this when pdfium-render is fixed or the engine runs out of process (M7).
8. **Not done:** quit with unsaved documents (needs a close-request hook), "Saved" pulse and "Saving…" in the status bar, a confirmation dialog for `needs_confirmation` (shown as the banner), macOS menu entries for Save/Save As, a live refresh of the overlay by `pageRev` (the render cache of the document is dropped after a save).
9. **Save As over an existing file.** `intake::admit_target` accepts an existing regular file; the user has already been asked by the native save dialog's own overwrite prompt (it is shown by the OS, in the OS language, before the path reaches Rust), so Sheer asks nothing more. The file is replaced atomically; a failed reload deletes the new file (the old content of an overwritten target is not restored: there is no copy of it). The backup of ADR-004 §3 covers the *opened* file only.

## ADR-034 — Author name: empty by default, confirmed once; comments panel back in M2

**Context.** Product-owner decision (2026-10-03). The OS account name may be a real name and would leak into every shared PDF (/T).

**Decision.**
1. `authorName` defaults to **empty**. Supersedes ADR-029 §6 (default = OS display name).
2. On the **first save of a document with annotations** while `authorName` is unset, a small **inline field in the toolbar** appears once:
   pre-filled with the OS name only as a suggestion, stored only after the user confirms. Dismissing or confirming empty keeps it empty;
   the prompt is never shown again (setting `authorPrompt: pending | done`).
3. Empty author → **no /T entry** is written. Replies and notes still work; the UI shows "No author".
4. On save (and when storing the setting), **invisible and bidirectional Unicode characters are removed** from the name (Cf, bidi
   controls U+202A–U+202E, U+2066–U+2069, zero-width U+200B–U+200F, U+FEFF); control characters stay rejected.
5. The **comments panel** (threads via /IRT, filter, sort, jump; DESIGN §3.26) returns to M2 as its own package; it leaves the v1.1 backlog.
   This amends ADR-030 §4.

## ADR-035 — Polish M2: limits, save races, CSP (backend)

**Status:** accepted (2026-10-03).

1. **No colour calls on an annotation without objects.** Which is both "no /AP" and "/AP without objects", and the second crashes PDFium in `FPDFAnnot_GetColor`'s fallback; pdfium-render has no public way to ask whether an /AP exists and the code may not use `unsafe`. The cost: an annotation from another program without an appearance stream (and without objects) imports with the default colour of its kind (highlight yellow, others black, no fill) until the user changes it; PDFium's own render still draws its real colour. Files from Sheer and most programs have an appearance. Reverse it when pdfium-render can ask for `/AP`, or the engine is out of process (M7). `tests/annotations_import.rs` pins the default and the survival of an empty /AP.
2. **Import limits.** `quads_of` looks at no more than `MAX_ANNOT_QUADS * 4` quads. The strings an import takes (contents, author, date, name, free text lines) are budgeted: 4 MiB per page and 32 MiB per document (`MAX_IMPORT_BYTES_PER_PAGE/DOC`); an annotation that would pass either ends the page's import (the rest of the page is left out). Author and contents lose Cf characters (bidi controls, zero-width, BOM; `engine::import::is_format_char`, a table of Unicode 16 Cf). Page import also skips annotations whose position the model already has from a save (a note created on a page that was never read, then saved, was listed twice).
3. **Model.** The undo stack is bounded by estimated bytes as well (16 MiB of JSON-sized annotations, `MAX_HISTORY_BYTES`; the oldest steps go, the newest stays). Counters per page and in all and a reply index replace the scans of `check_room` and `replies_to`. `AnnotationStore::with` refuses an id that was closed (`not_found`; ids are never reused) instead of making it a model. A poisoned lock drops every model, refuses their documents from then on and makes the lock usable again for new ones, since half a change cannot be told from a whole one.
4. **Save.** The fingerprint is compared when the file is read and again right before the rename (the build and the backup take time); a missing fingerprint on either side counts as changed (`needs_confirmation`, `ack.fileChanged` overrides). At most one build runs per document and app (`BuildSlot`): after `engine_timeout` the thread keeps running, and a new save is refused (`save_failed`) until it ends. A skipped backup is `warnings: ["backupSkipped"]` in the `SaveResult`. A failed rollback is logged. `SaveAck.rewrite_encrypted` is removed: an encrypted file is refused (`unsupported_feature`) and nothing could answer it; it returns with the full rewrite of M3 (ADR-004 §5). The backup folder is `0700` on Unix.
5. **CSP `style-src 'unsafe-inline'` stays.** React sets `style` attributes (positions of pages, overlays and the scroll, sizes from tokens), which only `'unsafe-inline'` (or `'unsafe-hashes'` with a hash for every value, impossible for computed ones) allows; a nonce does not cover attributes. Scripts have no inline allowance (`script-src` falls back to `default-src 'self'`). Inline style cannot run code; the residual is CSS-based exfiltration, which needs an injection that the text-only rendering of PDF strings (P7) prevents. `security_baseline.rs::the_release_never_uses_the_dev_csp` pins that the release `csp` is not `devCsp`, has no dev server and no inline script, and that the release workflow builds with the config as it is.
6. **deny.toml** allows only licenses a shipped target uses: `Apache-2.0 WITH LLVM-exception`, `BSD-2-Clause` and `BSL-1.0` were removed (checked per target as `scripts/check.sh` does). A dependency that needs one adds it back with its ADR-000 line.

## ADR-036 — Page operations (M3)

**Status:** accepted (2026-10-03). Amends ADR-002 §7, ADR-003 §6, ADR-004 §2, ADR-033 §1.

**Context.** `PageId` is the file's page index ("identity until M3"). M3 adds rotate, delete, reorder, insert (blank, from a file) as undoable
edits, and extract, split, merge, compress as new-file producers, on 500+ page documents, with hostile inputs on both sides.

**Options.** (a) Mutate PDFium's page list in step with the model (`FPDFPage_Delete`, `FPDF_MovePages`): every move shifts indices of
every cached render, text layer and hidden annotation, and pdfium-render has no safe `FPDF_MovePages`. (b) PDFium's in-memory document
is **append-only**; order lives only in the model and engine indices never shift. (c) A second engine document per import source:
routing per page, more PDFium state to replay in M7. → **(b)** for the live view, lopdf for every write.

**Decision.**

1. **Stable ids.** `PageId` is a per-document `u32` from a counter that never reuses: file page *i* gets id *i* at open (today's ids
   stay valid), new pages get the next ids. Order is model state:
   `DocState.pages: Vec<PageSlot { id, source: PageSource, engine_index: u32, rotation: u16, rev: u32, size: [f32; 2] }>` with
   `PageSource = File { index } | Blank | Imported { source: SourceId, index }`. Annotations keep `page_id` and therefore follow moves and
   rotations for free (page space is before `/Rotate`, ADR-003 §1). Every engine request maps `PageId → engine_index` in the command layer;
   engine answers (outline and link targets) map back through the reverse map. A target on a deleted page is `None` in the UI's eyes (the
   UI checks membership in the current list; outline items show disabled).
2. **Page commands** (one undo step each, `model::command`, labels `page.rotate|delete|move|insertBlank|insert`):
   - `RotatePages { pages, quarterTurns: -1 | 1 | 2 }` → inverse with the negated turn; `rev += 1` per page.
   - `DeletePages { pages }` removes the slots **and** their annotations (with replies); inverse `RestorePages { slots: Vec<(u32, PageSlot)>, annotations: Vec<Slot>, imported: Vec<PageId> }` (internal). Deleting every page is `invalid_argument` (`lastPage`).
   - `MovePages { pages, toIndex }`: moved pages keep their relative order and land at `toIndex` of the list without them; inverse is internal `ReorderPages { order: Vec<PageId> }`.
   - `InsertBlankPage { at, width?, height? }`: missing size = the unrotated size of the page before `at`, else after, else A4.
   - `InsertPages { source: SourceId, pages: Vec<u32> /* source indices */, at }`.
   Inverses of inserts remove the slots; redo re-adds them with the **same** ids and engine indices.
3. **Mirroring into PDFium** (`Control` jobs in `engine::pages`, before the model applies; a failure leaves the model untouched):
   - rotate → `PdfPage::set_rotation` on the engine page (undo sets it back), `pageRev += 1`.
   - delete, move → **no engine call**; the slot is just unmapped/reordered.
   - insert blank → `PdfPages::create_page_at_end` (size from the command); insert from file →
     `PdfPages::copy_pages_from_document` (`FPDF_ImportPages`) from a short-lived second `PdfDocument` loaded from the source bytes, **appended
     at the end**, then the source document is closed. Imported pages' annotations are read by `engine::import` like file pages.
   - The engine document holds ≤ 60 000 pages including unmapped ones (`limit_exceeded`, `pages`); a save resets it.
   - Caches: render, text and thumbnail keys are `doc:pageId:pageRev…`, so a move or delete invalidates nothing and an undo hits the cache.
     Search walks a snapshot of the order; the UI drops hits of removed pages and sorts by the current order. Hidden-annotation indices
     (ADR-003 §4) are engine indices, which never shift.
4. **Import sources.** `pick_pdf_sources` (Rust dialog) reads each chosen file through `intake::admit` into memory: ≤ 512 MiB each,
   ≤ 1 GiB and ≤ 32 sources in all, encrypted sources `unsupported_feature`. `SourceRegistry` (app-level) holds `Arc<SourceBytes>`; a
   document that inserted from a source pins its `Arc` until close or the next successful save (history is dropped then, ADR-033 §2).
5. **Save: incremental by default** (`pdfwrite::pagetree`):
   - Rotations only → re-append the changed page dicts with `/Rotate`.
   - Membership or order changed → re-append the root `/Pages` object (same object number, so `/Root` is untouched) with flat `/Kids`
     (≤ 512 pages) or a two-level tree of new nodes (≤ 256 kids each) and the new `/Count`; every kept page is re-appended with its new
     `/Parent` and the inherited `/Resources /MediaBox /CropBox /Rotate` materialized. Old intermediate nodes become unreferenced.
   - Blank page → new dict, `/MediaBox`, empty `/Resources`, no `/Contents`.
   - Imported page → iterative deep copy of the object closure of the source page (visited set, ≤ 1 000 000 objects, `/Parent` cut,
     annotation `/P` remapped), renumbered after the target's highest id. Widgets are dropped (no form merge until M4), links with a
     destination outside the copied set lose it; `/StructParents` and `/B` are removed.
   - Top-level `/AcroForm /Fields` is re-appended without fields whose every widget sits on a deleted page.
   - Dangling outline/named destinations to deleted pages are left in incremental saves (the old page objects are still in the file;
     readers fail the jump quietly).
   - After `ReplaceFile`, slot *i* becomes `File { index: i }` with `engine_index = i`; ids stay, so the UI keeps its keys.
   **Full rewrite** (`SaveMode::Full`) is required for: Save As "Clean copy" (the only way deleted pages leave the file, which the save
   banner says once after a delete), a file lopdf had to repair or whose page tree has a cycle, depth > 64 or a wrong `/Count`, and all of §6.
   A full rewrite replaces every reference to a deleted page object with `null` and removes nulls from `/Kids`, `/Fields` and `/Annots`.
   **Signatures:** any page change in a signed or certified file returns `needs_confirmation{breaksSignature}` even when incremental
   (page changes are never "allowed changes"); the UI defaults to Save As.
6. **New-file operations** (`pdfwrite::produce`, one blocking thread per job, 64 MB stack, `catch_unwind`, ≤ 2 jobs at once, 10 min
   deadline, temp file + atomic rename, lopdf re-parse + PDFium test open before rename). Inputs are the **current model state**
   (unsaved annotations and page edits included) through the save builder in Full mode. Results are new files chosen in a Rust save/folder
   dialog; extract, merge and compress open their result as a normal document; split reports the count. No untitled in-memory documents in
   M3. Encrypted inputs are refused. Signature values and `/Perms` are removed (`warnings: ["signaturesRemoved"]`).
   - extract: subset of `PageId`s. split: `everyN` (1..=10 000) or `before` page list; ≤ 1 000 outputs named `<stem>-NN.pdf`, `create_new`,
     a taken name gets ` (n)`. merge: ≤ 64 inputs (open documents and sources), ≤ 50 000 pages, ≤ 2 GiB; `/AcroForm` only if exactly one
     input has forms (else `formsDropped`); outline = one item per input.
   - compress presets: `lossless` (prune, dedupe identical streams, Flate unfiltered streams, object streams); `print` 300 dpi JPEG q85;
     `ebook` 150 dpi q70; `screen` 96 dpi q55. Target pixels per image = the largest page it is used on × dpi (an upper bound, no content
     stream parsing). Only 8-bit DeviceGray/DeviceRGB (or ICC N=1/3) images with `DCTDecode` or `FlateDecode` are touched; JPX, JBIG2,
     CCITT, Indexed, CMYK, masks, `/Decode`, 16 bpc are left as is; SMasks are kept. A recoded stream replaces the original only if smaller.
   - Crate: `image` 0.25 (MIT OR Apache-2.0, image-rs, actively released), `default-features = false, features = ["jpeg"]` (decode via
     `zune-jpeg`, MIT OR Apache-2.0 OR Zlib; image's own JPEG encoder; `imageops::resize` Triangle). No PNG, TIFF, WebP or other decoders.
     `image::Limits`: ≤ 10 000 px per side, ≤ 50 MP, `max_alloc` 256 MiB; an image over a limit stays untouched. Flate decoding uses
     `flate2` with a 256 MiB output cap per stream (bomb guard), never lopdf's unbounded `decompressed_content`.
   - Progress and cancel: `Channel<JobEvent>` (progress ≤ every 100 ms); `cancel_job` sets an `AtomicBool` read between objects/pages; a
     cancelled job deletes its temp files and sends `cancelled`.
7. **Limits** (`limits.rs`): ≤ 50 000 live pages per document, ≤ 5 000 pages per insert, page lists unique and existing, `toIndex` ≤ len,
   `ChangeSet.pages` = the full `PageSlotInfo` list only when the list changed.

**Consequences.** Moves and deletes cost no PDFium work and no re-render. Deleted and undone-insert pages stay in PDFium memory until save.
Incremental saves after deletes keep the removed content recoverable, so "Clean copy" is the privacy path. Imported forms, outlines of
merged inputs and dangling destinations in incremental saves are deferred (M4/v1.1). `image` + `zune-jpeg` (+ `flate2`) are logged in
`docs/LICENSES.md`.

## ADR-037 — M3 organize UI (DESIGN §3.28–§3.31)

**Decision.** (1) Pages is a mode, not a one-shot tool: the page grid takes the canvas track, the left panel collapses; leaving returns to
the viewer at the focused page. (2) In Organize, primary+L/R rotate the selected pages (file rotation, ADR-036); view rotation is off.
(3) Delete has no confirm (toast with Undo) and never removes the last page. (4) Insert goes after the focused page, else at the end.
(5) A multi-file drop shows an info banner ("Merge into one" / "Open as tabs"); its × opens nothing. (6) Split writes only into a folder
chosen in Rust's native dialog; the UI never sees a path; Rust never overwrites (" (2)" suffix). (7) Compress presets at 96 / 150 / 220 dpi;
if the result is not smaller, nothing opens and the UI says so. (8) One shared progress bar (§3.30) for all new-file jobs.
New tokens: `--grid-thumb` 160 (96–256), `--insert-marker` 2, `--sheet-width` 560, `--dialog-width-md` 480.

## ADR-038 — Backend first, no placeholder APIs (from M4)

**Context.** Product-owner decision (2026-10-03). In M3 the frontend packages ran beside the backend ones and coded against stubs
(`organize/source.ts`, a stub `src/api/jobs.ts`), and two backend packages ran out of turns; integration cost an extra round.

**Decision.** From M4: (1) Rust backend packages run as the **first wave** with `maxTurns` 160 (agent `backend-implementer`).
(2) Frontend packages start only when the command signatures **exist in code** (registered commands + typed `src/api/*` wrappers
committed), not just in ARCHITECTURE. (3) **No placeholder APIs**: a frontend package never writes a stub for a backend call.
Amends ADR-025 / ADR-030 §5: the four parallel implementers apply per wave (backend wave, then frontend wave).

## ADR-039 — Polish M3 backend: load budget, drift, hidden originals

**Context.** Findings of the M3 reviews. **Decision.** (1) `pdfwrite::prescan` runs before every lopdf `load_mem` of foreign bytes (P12). (2) A page insert that the model refuses after the engine appended pages takes them off again (`Job::TruncatePages`, only if the copy has not grown since); a copy that fails half way does the same inside the worker. (3) Annotations the file marks Hidden stay in `DocState::hidden_origins`, so undo never shows them (the `Imported.hidden` flag; cleared at save, where positions move). (4) `AnnotationStore` remembers at most 4 096 closed ids; a poisoned lock answers `not_found` with `what: annotation_state` (`error.not_found.annotation_state`, en/de). (5) Imported pages that lose form widgets add `Warning::WidgetsDropped` (wire `widgetsDropped`). (6) `bundle.targets` is `["nsis","dmg","app"]`; `release.yml` still selects one with `--bundles`. (7) A save that cannot write is tested end to end (`tests/save_restore.rs`); the reopen-mismatch branch shares the same `put_back`.

**Addendum (security review).** The pre-scan (`pdfwrite::prescan`) is **defence in depth**, a heuristic on raw bytes that normalizes `#xx` name escapes, covers object and xref streams, cuts data by a direct `/Length`, and counts filter chains it cannot evaluate at their worst case. It can still be fooled; the real bound is the M7 engine process with an address-space limit. Every lopdf load of foreign bytes goes through `pdfwrite::load_untrusted` (a test fails on any other `load_mem`). Annotations copied from an import source keep only a URI action that passes `security::links::classify` (rebuilt, no `Next`); `AA` is dropped. A failed take-back of engine pages answers `engine_crashed` (the worker drops the document; the UI reopens it).

## ADR-040 — Pre-scan by a PDF tokenizer, not by byte search (two-attempts rule)

**Context.** The decode-budget pre-scan (ADR-039) searched raw bytes for `obj`, `/Length`, `/ObjStm`. Two security rounds found bypasses
(a `/Xobj` key; a fake `N G obj` inside a string or comment; a nested `/Length` in `/DecodeParms` before an indirect top-level `/Length`).
§7.6: an approach that fails twice is replaced.

**Decision.** The pre-scan becomes a small **PDF lexer + object-level parser** (no decoding): it tokenizes the whole file (literal strings
with escapes and nesting, hex strings, comments, names with `#xx`, numbers, `<<`/`>>`/`[`/`]` with depth), recognizes `N G obj … endobj`
at top level, reads only **top-level** keys of a stream dictionary, and charges the budget per stream: object/xref streams with an
evaluable Flate chain are inflated with a cap; anything ambiguous — duplicate top-level keys, indirect `/Length` (charge up to the next
`endstream` token found by the lexer), unevaluable filter chains, unterminated strings/dicts, nesting deeper than 64, a header the lexer
cannot place — is charged conservatively or **refused**. The lexer is bounded (single pass, no recursion, input ≤ the intake cap).
It remains defence in depth; the hard bound is the M7 engine process with an address-space limit (ADR-039).

**Consequences.** `prescan.rs` is rewritten around the lexer; the bypass inputs from both reviews become regression tests; a property
test (random bytes / mutated corpus) asserts the lexer never panics and terminates.

## ADR-041 — Forms and signatures (M4)

**Status:** accepted (2026-10-03). Amends ADR-002 §7 (forms are read by lopdf), ADR-003 §2/§5 (the planned `stamp { assetId }` kind is
replaced by `signature` and `mark`), SECURITY D2. Signatures and types: ARCHITECTURE §5 "Forms and signatures".

**Context.** M4: fill AcroForms (text, checkbox, radio, choice) with the keyboard, save them incrementally with appearances, flatten;
create signatures (draw, type, image), place/move/scale them, initials and date; Fill & Sign on flat forms (text, check, cross, dot);
a signature library encrypted at rest with its key in the OS keychain. Every PDF and every image is hostile input.

**Options.**
- Form model: (a) PDFium's form API (pdfium-render `PdfFormField`) read and mutated in the engine — no object ids, no `/MaxLen`,
  `/Q`, `/DA`, `/MK`, on-state names, `/Tabs`; PDFium would hold edits it can never save (ADR-002 §7). (b) **lopdf reads the field tree
  once** into a Rust model; values are `DocState`; lopdf writes `/V` + `/AP` at save. (c) A JS form engine in the webview: the
  webview never holds PDF bytes.
- Signatures: (a) the generic `stamp { assetId }` of ADR-003; (b) **a typed `signature` kind plus a `mark` kind**; (c) a separate
  "signature layer" outside the annotation model: a second undo stack.
- Library crypto: AES-GCM vs **XChaCha20-Poly1305** (random 192-bit nonces need no counter; pure Rust, constant time without AES-NI).

**Decision.**

1. **Form model (b).** `pdfwrite::forms::read_fields` runs once per document on the first `get_form_fields` (blocking pool,
   `load_untrusted` with the ADR-040 pre-scan, 30 s deadline, only if `DocFlags.has_forms`). It walks `/AcroForm /Fields` iteratively
   (visited set, depth ≤ 32), inherits `/FT /Ff /V /DV /DA /Q /Opt /MaxLen`, and returns per terminal field: fully qualified name,
   `/TU`, kind, flags, value, default, options, and per widget the object id, file page index, `/Rect` (converted by `pdfwrite::coords`
   to page space), on-state, `/MK` colours, `/DA` size and colour, and its position in the page's tab order (`/Tabs /R` and `/S` = rows
   top-to-bottom then left-to-right, `/C` = columns, none = `/Annots` order). Kinds: `text`, `checkbox`, `radio` (also a checkbox whose
   widgets have different on-states), `choice` (combo/list, editable, multi-select), `signature` and `button` (listed, never filled),
   `unsupported`. Object ids stay in Rust (`FormModel`); the UI sees `FieldId` (session `u32`, never reused). PDFium keeps rendering
   widgets from their file appearance; it is never told about values.
2. **Values are model state.** `DocCommand::SetFieldValue { field, value, coalesce }` (label `field.set`) validates against the
   field (read-only refused; `MaxLen`; option membership unless editable; text ≤ 32 768 chars, WinAnsi only, LF only if multiline) and
   returns the old value as its inverse. Text fields commit on blur, Enter, Tab and after 500 ms idle with `coalesce = "field:<id>"`
   (one undo step per editing session, ADR-003 §7). Reset = a `Batch` of `SetFieldValue` to the defaults (`form.reset`).
   `ChangeSet.fields` carries every changed `FieldState`. A field whose value is not clean is drawn by the overlay control on an
   opaque `--field-fill`; a clean, unfocused field's control is transparent (PDFium's render shows the file appearance). Same rule
   as ADR-003 §4, no PDFium mutation, no `pageRev` bump while typing.
3. **Save (incremental, `pdfwrite::forms::write_values`).** Per changed field: re-append the field dict with `/V` (text string:
   PDFDocEncoding if representable, else UTF-16BE; buttons: the on-state name or `/Off` on the field that carries `/V`; multi-select:
   array + `/I`), without `/RV`. Per widget: buttons get `/AS` and keep their file `/AP` if it has the on-state, else a generated one
   (check, circle); text and choice get a new `/AP /N` stream built by `pdfwrite::appearance`: `/MK /BG` fill, `/MK /BC` border,
   `/Tx BMC … EMC`, Helvetica (WinAnsiEncoding, `/Helv` in the stream's own `/Resources`) at the `/DA` size and colour (size 0 =
   auto: fit the height, ≤ 12 pt), `/Q` alignment, comb cells, multiline wrap with Helvetica metrics, list boxes from `/TI` with the
   selection highlighted. `/NeedAppearances` is **never set**; an existing `true` is left (other viewers regenerate the fields we did
   not touch). **Calculation, format, validation and keystroke scripts are not run** (no JS engine; `/AA` and `/CO` untouched);
   `FormInfo.hasScripts` lets the UI say so once. **XFA**: full XFA has no AcroForm fields and stays warn-only; a hybrid form is
   filled through its AcroForm and the save removes `/XFA` from a re-appended `/AcroForm` (`warnings: ["xfaRemoved"]`), so other
   viewers do not show stale XFA data. A signed document: field values are an incremental change, so the existing DocMDP rule of
   ADR-004 §4 decides whether `needs_confirmation{breaksSignature}` is asked. After a Full save the form is re-read and `FieldId`s are
   kept by fully qualified name.
4. **Flatten is a new-file job** (ADR-036 §6, full rewrite, Save As dialog, the result opens): first every changed field gets its
   appearance (step 3); then per page, for each widget that is not Hidden/NoView and has `/AP /N` (the `/AS` state for buttons), the
   appearance becomes a Form XObject `/SheerFlN` in the page's `/Resources /XObject`, the page content is wrapped `q … Q` and
   `q <a b c d e f> cm /SheerFlN Do Q` is appended (the matrix maps `/BBox` through `/Matrix` onto `/Rect`, PDF 32000 §12.5.5); the
   widgets leave `/Annots`; `/AcroForm` is removed when no field is left (signature values with it: `signaturesRemoved`).
   `scope: "formsAndAnnotations"` burns every annotation with an appearance the same way (Links and Popups excepted).
5. **Signatures and Fill & Sign are annotation kinds (b)**, so placement, move, scale, delete and undo reuse `CreateAnnotation`,
   `MoveAnnotations`, `UpdateAnnotation { box }` and the overlay:
   - `signature { box, role: signature | initials, art: { type: "asset", assetId, aspect } | { type: "file" } }`. PDF: `/Stamp` with
     `/NM (sheer-sig-<32 hex>)` or `sheer-ini-…`, `/F 4`, `/AP /N` = filled vector paths in `color`, or an image XObject (DeviceRGB,
     8 bpc, Flate, `/SMask` from alpha; one XObject per asset per save). On reopen PDFium imports it as `art: file`: movable and
     scalable (a `Control` job mirrors `set_bounds` into PDFium, `pageRev += 1`; save writes only `/Rect`, the AP is kept by
     reference), never re-coloured.
   - `mark { box, glyph: check | cross | dot }`: `/Stamp`, `/NM (sheer-mark-<glyph>-<hex>)`, a vector AP from fixed geometry, so it
     imports back as a typed `mark`.
   - Text and date are `freeText` presets (no border, no fill); the date is text the UI formats with `Intl` in the UI language and
     the user may edit. Initials are `signature` with `role: initials`.
   - `color` applies to vector art and marks; raster art ignores it. Aspect is kept by the UI when scaling; Rust bounds the box only.
6. **Creation.** Drawn: the UI sends perfect-freehand outline polygons; Rust trims, normalises (height 1 000 units) and simplifies
   them. Typed: Rust lays out the text with the bundled **Homemade Apple** font (Apache-2.0, Font Diner; `resources/fonts/`, read only
   by Rust, so no webfont and no CSP change) via **skrifa** outlines, flattened to polygons (tolerance 0.5 unit); a missing glyph is
   `invalid_argument` (`glyph`). Image: `import_signature_image` opens the **native dialog in Rust** (PNG, JPEG), judges the opened
   handle like intake (regular file ≤ 10 MiB), sniffs the format from magic bytes, decodes with `image` (features `jpeg` + `png`;
   `Limits` 4 000 px per side, 16 MP, 128 MiB), converts to RGBA8, optionally makes near-white transparent (luminance ≥ 235),
   trims to content, downsizes to ≤ 1 600 px on the long side and re-encodes as PNG — metadata (EXIF, ICC, text chunks) never
   survives. All three produce a **draft** (app-level, in memory, ≤ 16, oldest dropped) that can be placed and/or saved.
7. **Library (`storage::signatures`, `storage::keychain`).** One file `<app data>/signatures/library.bin` (dir `0700`, file `0600`
   on Unix, written by `storage::atomic`): `"SHLB" | u8 version=1 | 24-byte nonce | XChaCha20-Poly1305(JSON)` with the 5-byte header
   as AAD; a new random nonce per write. Plaintext JSON: `{ v: 1, items: [{ id: <32 hex>, role, created, art }] }`, art =
   `{ vector: { w, h, paths } }` or `{ raster: { png: base64 } }`. Limits: ≤ 32 items, ≤ 512 KiB of art per item, file ≤ 16 MiB,
   checked before decrypt and after. The key is 32 bytes from `getrandom`, created on the first save, kept as `Zeroizing<[u8; 32]>`
   only while a call runs, stored as a binary secret under service `app.sheer.desktop`, user `signature-library-key-v1`.
   **No keychain → no library**: `status: "unavailable"`, `save_signature` answers `unsupported_feature` (`keychain`); signatures can
   still be created and placed for the session; nothing is ever written in plaintext. A file that does not decrypt (key gone, tampered)
   is `status: "locked"`; the only way on is `clear_signature_library` (deletes file and key; a new key on the next save). Deletion
   rewrites the file without the item (no secure-wipe claim: the old ciphertext is unreadable without the key). Keychain calls run on
   the blocking pool with a 60 s deadline (macOS may show its access prompt). Residual: Windows Credential Manager and an unsigned
   macOS build do not bind the secret to this app — another process of the same user can read it; the encryption protects copies
   of the data folder (backups, sync, a lost disk), not a compromised account. Unsigned macOS updates may re-prompt for access.
8. **IPC rules.** No path crosses IPC (image import and flatten output use Rust dialogs); art reaches the UI as vector paths or as
   an `SHR1` PNG frame (`get_signature_preview`), never as file bytes; library item ids are random, not indices; assets of a document
   (≤ 64, ≤ 32 MiB) live in `DocState` and are dropped on close.

**Crates** (each logged in `docs/LICENSES.md`, `cargo deny` clean):
- `chacha20poly1305` 0.11 — Apache-2.0 OR MIT, RustCrypto, NCC-audited, released 2026-06.
- `getrandom` 0.3 — MIT OR Apache-2.0, rust-random; key and nonces.
- `keyring-core` 1.0 (2026-04), `apple-native-keyring-store` 1.0 (macOS only, 2026-07), `windows-native-keyring-store` 1.1
  (Windows only, 2026-05) — all MIT OR Apache-2.0, open-source-cooperative/keyring-rs (successor of `keyring` 3; the `keyring` 4.2
  umbrella is not used). Edition 2024, fine with rust-version 1.90. The API churned before 1.0, so the versions are pinned to the
  minor and wrapped behind `storage::keychain::SecretStore` (one file to swap; an in-memory store for tests). Linux dev builds have
  no store: `unavailable`.
- `skrifa` 0.x — MIT OR Apache-2.0, googlefonts/fontations, `forbid(unsafe_code)`, active. `ttf-parser` rejected: marked unmaintained.
- `image` gains feature `png` (decoder via `png`, MIT OR Apache-2.0, already a dependency).
- Font: Homemade Apple, Apache-2.0 (license file shipped next to it).

**Consequences.** One lopdf parse per form document (on demand) plus the save parse. Field appearances use Helvetica only, so
non-WinAnsi values are refused in v1. Forms that rely on scripts keep stale calculated fields (the UI says so). Signatures from a
previous session can be moved and scaled, not re-coloured. The library is as safe as the OS account. Not in M4: digital (PKCS#7)
signatures, rich-text fields, field creation, form merge on insert/merge (ADR-036), XFDF.

## ADR-042 — M4 UI decisions (DESIGN §3.32–§3.35) and the typed-signature font

**Decision.** (1) **Typed signatures use one bundled font, Homemade Apple (Apache-2.0, ADR-041)**, converted to outlines via `skrifa`;
no system fonts (no per-platform allowlist, no fsType checks), no font embedded in the PDF. This overrides the designer's
"system fonts only" note in §3.33, which assumed no permissive font was available. (2) Fields are fillable under Select and the Form
tool (F); F jumps to the first empty field and offers the highlight toggle and Flatten; field scripts never run. (3) Flatten lives in
Form tool options, More and the macOS Edit menu; its confirm focuses Cancel; undoable until save (ADR-041: flatten writes a new file
on save). (4) The Sign tool opens a menu popover; signatures are always aspect-locked; the date follows the OS region and is fixed text.
(5) Library: at most 8 entries per kind; key in the OS keychain; when the keychain is unavailable, entries live for the session only
(nothing written, ADR-041 §4); Undo after delete stays inline in the row (toasts sit under the modal layer).
(6) The field highlight toggle is a UI preference kept in `localStorage` (`sheer.formHighlight`, default on), not in the document or the backend.

## ADR-044 — Politur M4, Rust half

**Decision.** (1) **Pre-scan (amends ADR-040):** `/Length` is resolved, and refused when it cannot be, only for `/ObjStm` and `/XRef`
streams (the only ones lopdf decodes at load); every other stream is charged nothing and ends at its length when `endstream`
follows, else at the next `endstream`. Lengths written `120.0` or `+5` read as whole numbers; an indirect length may live anywhere. A
number object defined twice with different values, or also as something else, is ambiguous and refuses a decoded stream that points at
it (incremental updates cannot hide a bomb behind the last definition); decoded streams are charged per definition (their sum).
Duplicate or non-name keys refuse only stream dictionaries (lopdf parity for the rest). (2) **Flatten:** a `NoRotate` annotation
(`/F` bit 5) keeps its displayed upper-left corner and is drawn upright on a rotated page (`placement_upright`); the appearance is fitted
to the rect as if the page were not turned, so on a 90 degree page the burned box is the rect's width by its height, hanging down and right
from the anchor. The copying of resources is bounded to 400 000 entries over the file (a shared huge `/XObject` dictionary is copied
into every page). (3) **Library:** the keychain distinguishes a store that failed a call (`Unreadable`: treated like no keychain for
that call, never locks, never touches the file) from a secret that is not a key (`Invalid`: locks). Each OS call has a 60 s deadline on
its own thread; one stuck call is outstanding at most (`Unavailable` for the rest). The list carries a re-encoded PNG thumbnail (96 px,
24 KiB) of raster art. `forget_all` on a locked library renames the file that did not open to `library.bin.quarantine-<seconds>` (never
over another file, newest 2 kept) instead of deleting it; its key goes either way. (4) **Imports:** annotations of a page that did not fit
(per page, per document, strings budget) are counted: `DocState::import_warnings` gives `PageTruncated { page, skipped }`; they stay in
the file untouched. No IPC command yet (the UI wave decides how to show it). (5) **Drafts:** `discard_signature_draft(draftId)` frees a
draft (idempotent); the sheet calls it for a replaced typed draft and on close unless the draft was handed out as the answer.

## ADR-043 — CI budget: Windows on main, macOS on tags and manual runs

**Context.** Product-owner decision (2026-10-03): the GitHub Actions minutes are almost used up; macOS runners count ten times.

**Decision.** `.github/workflows/ci.yml`: (1) a push to `main` (and a pull request) runs **Windows only**, `npm run check` (checks + tests),
**no debug bundles**, and is skipped for docs-only changes (`paths-ignore`: `**/*.md` — includes STATE.md, ROADMAP.md, CHANGELOG.md — and
`docs/**`). (2) **macOS** (plus the unsigned debug bundles on both platforms) runs only on a **tag push** (`v*`) and on a **manual start**
(`workflow_dispatch`). (3) Caches: npm (setup-node), Cargo registry/git/target (actions/cache, keyed on toolchain + Cargo.lock), and the
pinned PDFium download (re-verified against its SHA256 pin by `fetch-pdfium.sh`). `release.yml` is unchanged.

**Consequences.** ORCHESTRATOR §8.6: "CI green on Windows and macOS" is met by the last finished Windows run on `main` plus **one manual
`workflow_dispatch` run on the release candidate** at milestone end (before the tag), read once and not waited on (ADR-030); the tag push
runs both platforms again. Amends ADR-030 §2 and FEEDBACK F6.

## ADR-045 — Pre-publication: CI concurrency for manual runs, disclosure and trademark contact

**Context.** Product-owner request (2026-10-03) before the repository goes public: a publish check (`docs/PUBLISH_CHECK.md`), and manual
CI runs must no longer cancel push runs or be cancelled by them (seen at the v0.7.0 tag, STATE notes). `SECURITY.md` and `TRADEMARK.md`
still named `*.invalid` placeholder addresses.

**Decision.** (1) `ci.yml` concurrency group: `ci-<workflow>-<manual|auto>-<ref>`; `workflow_dispatch` runs share a group only with each
other, pushes and pull requests only with each other; `cancel-in-progress` stays on within each group. Amends ADR-043. (2) Vulnerability
reports go through GitHub private vulnerability reporting (no project mailbox, no personal address in the repo); it has to be switched
on in the repository settings once the repository is public. (3) Trademark questions go through a repository issue. (4) README carries a
"pre-release, unsigned, not for productive use" notice and a feature table by milestone. History is not rewritten.
(5) Amendment, same day: the owner chose to rewrite history locally with `git filter-repo` (personal e-mail → GitHub no-reply address
in identities, tags and `Signed-off-by`; Windows user name in test paths → `user`). Because GitHub keeps the old history of the
existing repository (Actions run metadata, pull-request refs), the rewritten history goes into a new repository (PUBLISH_CHECK P-2).

## ADR-046 — Public repository: CI on both platforms for every push, tags run only the release

**Context.** Product-owner decision (2026-10-03): the rewritten history is published, `renderdrop/sheer` is public. Standard GitHub
runners are free for public repositories, so the macOS budget of ADR-043 no longer applies. Commit hashes in the docs that named the
pre-rewrite history were mapped to the new history with `.git/filter-repo/commit-map` (FEEDBACK, BLOCKERS; STATE and DECISIONS held
none). Actions run IDs quoted before the rewrite belong to the old, private repository.

**Decision.** `ci.yml`: every push to `main` and every pull request runs `npm run check` on **Windows and macOS**; `paths-ignore` for
`**/*.md` and `docs/**` stays. A **tag push** no longer triggers CI; it runs only `release.yml` (which builds the installers on both
platforms). The unsigned debug bundles are built only on a manual start (`workflow_dispatch`). Concurrency groups as in ADR-045.

**Consequences.** ORCHESTRATOR §8.6 "CI green on Windows and macOS" = the last finished CI run on `main` (both jobs), read once at
milestone end, never waited on (ADR-030). The manual release-candidate run of ADR-043 is dropped. Supersedes ADR-043 (1)–(2); the caches
of ADR-043 (3) stay.

## ADR-048 — M5 UI decisions (DESIGN §3.36–§3.40)

**Decision.** (1) New toolbar cluster **Edit** after Fill & Sign: Insert text (E), Add image (I), Crop (K); it collapses after Pages.
Redact, Protect and Document properties stay in More / macOS menus (rare or destructive, no letter). (2) Text colour uses the §3.24
document palette (Okabe-Ito), not Iris: Iris is the UI hue, page content stays theme-independent (ADR-011 §9). Fonts: standard
Helvetica/Times/Courier, WinAnsi only (as ADR-041). (3) Crop is a mode in Single page with the inspector forced open; margins in mm
or in from the OS measurement system; crop hides, never removes. (4) Redaction marks live per tab in memory; pending marks show a
persistent warning banner; apply confirms with Cancel focused, is undoable until save, and rasterises affected pages (dpi per
ADR-047). (5) Permissions need a separate permissions password; password strength is a local heuristic, a hint only, no dependency.
Protection and metadata changes take effect on the next save. (6) Image import limits 20 MB / 8192 px are UI defaults; ADR-047 may
amend them. Storage and IPC details defer to ADR-047.

**Amendment (F9).** The tools are named "Text comment" / "Textkommentar" (annotation, T) and "Insert text" / "Text einfügen" (page content, E), each with a tooltip hint saying what it makes. Toolbar groups Markup (de "Markieren") and Edit (de "Bearbeiten") are split by a wider divider gap (`--toolbar-group-gap`).

## ADR-047 — Edit and protect (M5)

**Status:** accepted (2026-10-03). Amends ADR-003 §2 (content kinds, redaction marks), ADR-004 §2/§5 (encrypted saves), ADR-035 §4
(`rewriteEncrypted` returns), ADR-036 §1 (`PageSlot` gains crop and a redacted source), ADR-048 (6) (image limits confirmed). SECURITY D3,
D4, D5. Signatures and types: ARCHITECTURE §5 "Edit and protect".

**Context.** M5: add text boxes and images, crop pages, true redaction, password protection with permissions, metadata view/edit/remove.
UI per DESIGN §3.36–§3.40: everything is one undo step and takes effect on the next save; redaction marks never reach the file.

**Options.**
- Text and images: (a) annotations (`/FreeText`, `/Stamp`): stay editable in every viewer, but they are comments, hidden by "print
  without comments", and §3.36 says they are not comments; (b) **typed model objects, burned into page content at save**; (c) page content
  at once in PDFium: needs `image_api`, and PDFium cannot save (ADR-002).
- Redaction: (a) operator-level removal (parse content streams, cut glyphs and image pixels): fragile on hostile input; (b) **raster the
  affected page** (ADR-010 §3). Raster at apply (job, preview is the real result) vs. at save (preview is a fake).
- Encryption: (a) **lopdf 0.45** — verified on docs.rs: `EncryptionVersion::V5` (AES-256, R6; `R5` also exists), `crypt_filters::
  Aes256CryptFilter`, `Permissions` bitflags, `Document::encrypt(&EncryptionState)`, `load_mem_with_password`, `authenticate_owner_password`;
  `aes`, `cbc`, `ecb`, `sha2`, `md-5`, `stringprep` (SASLprep for R6), `rand`, `getrandom` are **non-optional** dependencies, so
  `default-features = false` keeps them and they are already in our build; (b) qpdf (Apache-2.0, C++ build) — not needed.
  PDFium opens R5/R6 (`CPDF_SecurityHandler`, revision ≥ 5), pinned by a test below.

**Decision.**

1. **Text boxes and images = content objects (b).** New `AnnotationBody` kinds `textBox` and `image` reuse `CreateAnnotation`,
   `UpdateAnnotation`, `MoveAnnotations`, `DeleteAnnotations`, the overlay and undo, but are *content*: `list_document_annotations` skips
   them, `engine::import` never produces them. **Editable until save**; the save burns them into the page (`pdfwrite::content`): the page's
   content is wrapped `q … Q`, one appended stream draws the objects in creation order (text `BT … ET` clipped to the box; image
   `q w 0 0 h x y cm /SheerImN Do Q`, opacity via an `/ExtGState` `ca`); on a rotated page they are drawn upright as displayed
   (`flatten::placement_upright`). After the save they are ordinary page content (editing existing text: v1.1, ROADMAP). Incremental
   (re-appended page dict and `/Resources`); a signed file asks `breaksSignature`.
   - **Fonts:** standard 14 Helvetica / Times-Roman / Courier (sans/serif/mono, ADR-048 (2)), `/Type1` + `/WinAnsiEncoding`, not embedded,
     so text stays extractable. **Rust lays out** (`content::text`, AFM widths of the three fonts in `content::std14`): the UI sends `text`
     (LF breaks) and the box width; the answer carries `lines` and the grown height, which the overlay draws. A non-WinAnsi character is
     `invalid_argument` (`textBox`, params `{ char }`) → `insert.charset`. Unicode (an embedded, subset font) waits for a permissive font
     and a subsetter (v1.1); WinAnsi covers en and de.
   - **Images:** `insert_image_dialog` opens the Rust dialog (PNG, JPEG), judges the opened handle (regular file ≤ 20 MiB), sniffs magic
     bytes, **reads the header dimensions before decoding** (≤ 8 192 px per side, ≤ 40 MP, else `limit_exceeded` `image`), decodes with
     `image::Limits` (`max_alloc` 256 MiB), applies EXIF orientation, drops all metadata (EXIF, ICC, text chunks), downsizes to ≤ 4 096 px
     on the long side and stores **opaque → JPEG q90, alpha → Flate RGB + `/SMask`**. The bytes become a document asset (ADR-041
     `AssetStore`): ≤ 128 image assets, ≤ 256 MiB per document. The UI sees `get_asset_preview` frames, never bytes or paths. Every lopdf load
     on the save path stays behind `load_untrusted` + the ADR-040 pre-scan.

2. **Crop = an undoable page op.** `CropPages { pages, spec: margins | reset }` (label `page.crop`): margins are distances in page space
   (before `/Rotate`; the UI maps from the view) from each page's **MediaBox**, applied to every listed page; a result under 72 × 72 pt or
   outside the MediaBox is `invalid_argument` (`crop`). `PageSlot` gains `media: [f32; 4]` (read at load) and `crop: Option<[f32; 4]>`
   (user space). Page space is anchored at the CropBox, so the command **translates the page's annotations, content objects and form
   widget rects** by the origin shift in the same step (inverse shifts back). Mirroring: `Job::SetCropBox` (`Control`, pdfium-render
   `PdfPageBoundaries::set_crop`), `size` and `rev` update, so renders, thumbnails, text layer and search hits re-key. Save: the page dict
   re-appended with `/CropBox` (reset writes the MediaBox), `/TrimBox /BleedBox /ArtBox` clipped to it. Extract, split, merge, flatten and
   redaction raster go through the same builder and keep the crop. Crop hides, never removes (§3.37).

3. **True redaction = raster at apply, permanent at save.**
   - **Marks** are a kind `redactMark { quads }` in the model only: undoable, never written, never imported, skipped by the comments list.
     `MarkRedactions { marks }` adds up to 10 000 marks (search hits) as one step. A save writes none of them (§3.38: allowed, banner stays).
   - **Apply** is a job, `apply_redactions(doc, opts, channel)`: per affected page (Background priority) PDFium renders the page as it
     draws it (file content, file annotations and widgets with their file appearances, crop applied) at **200 dpi**, lowered so the
     bitmap stays ≤ 4 096 px per side and 16 MP (a page needing < 72 dpi is `limit_exceeded` `redactPage`); Rust fills every mark's
     rectangle grown by 1 px with opaque black **in the bitmap**; `pdfwrite::redact::raster_page` builds a one-page PDF in memory (MediaBox
     = the crop size, the page's `/Rotate`, one image: DeviceGray Flate if every pixel is grey, else DeviceRGB JPEG q90, no text, no
     annotations); the engine appends it (`copy_pages_from_document`, as ADR-036 inserts) and the slot becomes
     `PageSource::Redacted { bytes }` with the **same `PageId`**, `rev + 1`. The model step (label `redact.apply`) also removes the marks,
     every annotation and content object on those pages (session edits on them are dropped: `warnings: ["unsavedEditsDropped"]`), detaches
     their form widgets, and with `removeMetadata` stages a metadata removal (item 5). Undo swaps the old slots back. Cancel changes nothing.
     Text layer, search and links of a redacted page come from the raster page: empty.
   - **Save** with any redacted slot is **Full** (no earlier revision survives; unreferenced objects pruned), never backed up, and deletes
     existing backups of the target file (`storage::backup::forget_target`). It also removes `/StructTreeRoot` and `/MarkInfo` (they hold
     `/ActualText` and `/Alt` of removed content), `/Thumb` and `/PieceInfo` of redacted pages, fields whose every widget was on them, and
     writes a new `/ID`.
   - **Test (SECURITY D4/§13.4)** `tests/redaction.rs::redacted_text_is_not_extractable_after_save`: a fixture with `SHEER-SECRET-4711` in
     page text, a `/Contents`, a form value, a link URI, `/Info /Title`, XMP and a tagged `/ActualText`; mark the search hits, apply
     (metadata on), save. Then PDFium text of every page lacks it; every stream of the result, inflated with the 256 MiB cap, and every
     string contain it in neither PDFDocEncoding, UTF-16BE nor hex; no `/Info`, no `/Metadata`, one xref section; page 2 text intact.

4. **Protection = lopdf R6, staged, written by a Full save.**
   - `stage_protection(doc, opts)` / `stage_unprotection(doc, permissionsPassword?)` are one undo step each (`DocCommand::
     SetProtection { ticket }`, labels `protect.set|remove`). **Passwords never enter the history:** the step holds a ticket; the secrets sit in
     `DocState.secrets: SecretSlots` (`Zeroizing<String>`, redacting `Debug`), dropped on save, close, and when the step leaves the stack.
   - New protection is always **AES-256 R6** (`EncryptionVersion::V5`, `Aes256CryptFilter` for streams and strings, a fresh 32-byte file key
     from `getrandom`, `encrypt_metadata = true`). Permissions (§3.39): print → print + high-quality; copy → copy (accessibility extraction
     stays allowed); edit → modify + annotate + fill + assemble. A restriction needs a permissions (owner) password that differs from the open
     password (`invalid_argument` `ownerPassword`); none restricted and no owner password → a random owner password, discarded.
   - Passwords: UTF-8, 1..=127 bytes after SASLprep (longer is refused, never truncated), no NUL or control characters; never in errors,
     logs, settings, recents or autosave; wrong permissions password → `password_required` with ADR-028's attempt rule.
   - **Remove** needs owner rights: the document was opened with the owner password, its permissions are unrestricted, or the given password
     passes `authenticate_owner_password`. Saved as an unencrypted Full rewrite.
   - **Saving an encrypted document** (resolves ADR-004 §5): Full rewrite keeping its own `/Encrypt` and file key (lopdf
     `encryption_state` from `load_mem_with_password`), after `needs_confirmation{rewriteEncrypted}` (`SaveAck.rewriteEncrypted` returns).
     Gate tests in `tests/protection.rs`: lopdf-written R6 opens in PDFium with each password and the permissions read back; R2/R3/R4/R6
     fixtures re-save with the same password. **If the R6 round-trip fails**, protection ships as AES-128 R4 (`V4` + `Aes128CryptFilter`)
     with a BLOCKERS entry; if the keep-encryption save fails, encrypted documents stay unsaveable as today.
   - **Enforcement:** a document opened with the open password of a restricted file honours its permissions: `DocFlags.permissions`
     (PDFium, at load); `apply_command` refuses edits the flags forbid (`read_only`, `what: permission`).
   - After an in-place save the registry's session password becomes the new open password (the reopen needs it).

5. **Metadata.** `get_metadata` reads the trailer `/Info` and catalog `/Metadata` once (blocking pool, `load_untrusted`, with the session
   password); strings decoded from PDFDocEncoding / UTF-16BE / UTF-8 BOM, control and Cf characters stripped, ≤ 1 000 chars (cut, flagged),
   dates parsed to ISO 8601 or `null`. XMP is not parsed: presence and size only. `SetMetadata { patch }` and `RemoveMetadata` are
   `DocCommand`s (labels `metadata.set|remove`). Save: a set is incremental (new `/Info` keeping keys it does not edit, `/ModDate` = now; if
   the file had XMP, a **regenerated packet** from the Info values, XML-escaped, replaces it — "kept in sync", a PDF/A claim goes with it);
   a removal is Full: no `/Info`, no catalog or object `/Metadata`, no `/PieceInfo`, never backed up.

6. **Wave plan** (ADR-038, backend first). **W0 seams** (orchestrator, one short package): `DocCommand` variants and `AnnotationBody` kinds
   dispatching to the files below, `DocState` fields, `limits.rs`, `SavePlan` fields and the Full triggers in `pdfwrite/save.rs`,
   `SaveAck.rewriteEncrypted`, `JobEvent.done.changes`, error `what`s + en/de keys, `lib.rs` registration. Then **four disjoint packages**:
   - **A content objects:** `content/{mod,text,std14,image}.rs`, `pdfwrite/content.rs`, `commands/content.rs`, `src/api/content.ts`,
     `tests/content_objects.rs`.
   - **B crop:** `model/{page,page_ops}.rs`, `engine/pages.rs`, `pdfwrite/pagetree.rs`, `commands/pages.rs`, `src/api/pages.ts`, `tests/crop.rs`.
   - **C redaction:** `model/redaction.rs`, `engine/redact.rs`, `pdfwrite/redact.rs`, `commands/redact.rs`, `storage/backup.rs`,
     `src/api/redaction.ts`, `tests/redaction.rs`.
   - **D protect + metadata:** `pdfwrite/{crypt,metadata}.rs`, `model/{protection,metadata}.rs`, `security/secret.rs`,
     `commands/{protect,metadata}.rs`, `src/api/{protection,metadata}.ts`, `tests/{protection,metadata}.rs`.

**Crates.** None new. lopdf's crypto dependencies (`aes`, `cbc`, `ecb`, `sha2`, `md-5`, `stringprep`, `rand`; MIT OR Apache-2.0) are
logged in `docs/LICENSES.md` by package D where missing; `cargo deny` already covers them.

**Consequences.** Added content is final after save. Redacted pages lose selectable text and tagging (§3.38 says so); redaction and
protection saves are always Full, so files with signatures ask `breaksSignature`. Permissions bind honest readers only (§3.39 note). XMP
extensions beyond Dublin Core/pdf/xmp are lost on a metadata edit. Not in M5: Unicode fonts, editing existing text, certificate
encryption, operator-level redaction.

## ADR-050 — M6 UI decisions (DESIGN §3.41–§3.45)

**Status:** accepted (2026-10-04). Engine, limits and IPC defer to ADR-049 (M6 architecture).

**Decision.** (1) No toolbar buttons for output: Create PDF from images, Export a copy, Export as images and Print form one group
after Save As in More and the macOS File menu. Keys: Primary+P (Print, platform convention), Primary+Shift+E (Export as images; free in
the registry); none for the rare two. No Ctrl+Shift+I (WebView dev tools). (2) Create PDF from images is reachable without a document:
More, a ghost button under Open in the empty-state drop card (Open stays the one primary), and dropping only images. A mixed drop opens
the PDFs and explains the skipped images in a banner. (3) Print keeps a minimal pre-step (annotations on/off, page range) because the
OS dialog cannot choose annotation visibility and Rust must prepare the pages; everything else is the native dialog. Primary+P twice
prints with the last choices. (4) Export a copy never changes the open document or its path; annotations on by default, metadata
removal opt-in. (5) Export as images: 150 dpi default, presets 72/150/300 + custom 36–600, JPEG quality 85; folder chosen after Go;
Cancel keeps files already written. (6) Images → PDF page size defaults to A4, Letter in US/CA (OS region via Rust); auto orientation;
12 mm margin; images fit, never crop. (7) Permissions (§3.39) gate Print (print) and Export as images (copy); unapplied redaction marks
are never output and the dialogs say so. (8) No new tokens.

## ADR-049 — Convert and output (M6)

**Status:** accepted (2026-10-04). Implements the backend behind ADR-050. Amends ADR-017 (a drop of images), ADR-036 (`JobEvent`,
`create_unique` takes an extension). SECURITY T9 (paths), D3 (hostile input). Signatures and types: ARCHITECTURE §5
"Convert and output".

**Context.** M6: PDF → PNG/JPEG, images → PDF, print through the OS dialog, export a copy with/without annotations and optional
metadata removal. Rules that bind: the UI never holds paths or bytes, every output path comes from a Rust dialog, every job reports on a
`Channel<JobEvent>` and can be cancelled (`cancel_job`), PDF strings never become file names, no network, no shell plugin.

**Options.**
- *What is output when the document has unsaved edits:* (a) the file on disk: surprising, content objects and annotations vanish;
  (b) **a snapshot**: the save pipeline (ADR-033/036/041/047, content burned, crops, redacted slots) writes the current state into
  memory, never to disk; PDFium opens it as an engine-only document. A clean document skips the snapshot and renders the open one.
- *Print:* (a) shell "print" verb on a temp PDF: hands the file to whatever app owns `.pdf` (may be online, may be absent), needs
  the shell, leaves a file; rejected. (b) OS print APIs: Windows GDI (`PrintDlgEx` + `FPDF_RenderPage` to an HDC, not exposed by
  pdfium-render) and macOS PDFKit (`objc2-pdf-kit`); two native code paths, high cost. (c) **The webview prints a print-only surface of
  pre-rendered page images**, opened by Rust: Windows `ICoreWebView2_16::ShowPrintUI(COREWEBVIEW2_PRINT_DIALOG_KIND_SYSTEM)` (the OS
  dialog) via `Webview::with_webview`; macOS `Webview::print()` (wry: `WKWebView` print operation, `NSPrintPanel`). One render path,
  no temp file, offline.
- *Images → PDF result:* untitled in-memory document (no such concept in the registry yet) vs. **the merge pattern** (ADR-036: Save As
  dialog first, the written file opens in a tab).

**Decision.**

1. **Snapshot seam** `export::snapshot::current(doc) -> Snapshot { bytes: Option<Arc<[u8]>>, engine: EngineDocRef }`: dirty →
   `pdfwrite::save::write_to_memory` (Full, no backup, unencrypted, never on disk), opened by `Job::OpenSnapshot` (Control) and closed by
   `Job::CloseSnapshot` when the job ends or is cancelled; clean → the live engine document. Redaction marks are never output (they
   are not written by a save). ≤ 1 GiB snapshot (`limit_exceeded` `snapshot`).

2. **PDF → images** (`export_images`). Pages: `PageSelection` (all, current, selected ids, or range text parsed by the split parser, which
   moves from `pdfwrite::produce` to `model::ranges`, positions in the current order, ≤ 5 000 pages). DPI 36..=600, PNG or JPEG
   (quality 1..=100, default 85, flattened on white), annotations on/off (PDFium `FPDF_ANNOT`; off also hides widgets).
   Per page the bitmap must stay ≤ 10 000 px per side and ≤ 64 MP; a page over it is rendered at the highest DPI that fits and
   `done.warnings` gets `dpiLowered` (page refused only below 36 dpi: `limit_exceeded` `exportPixels`, params `{ page }`). Render is
   `Job::RenderExport` at **Background**, so the viewer stays first; encode on the blocking pool (≤ 2 jobs, ADR-036).
   - Folder: Rust `blocking_pick_folder` after Go (ADR-050 (5)). Names: `{stem}-p{NNN}.{png|jpg}` where `stem = file_stem(display
     name)` (the sanitised file name, never `/Title` or page labels), `NNN` the 1-based position, zero-padded to the page count's width.
   - **No silent overwrite:** before the job Rust checks the planned names; if any exists the call answers `conflicts { ticket, count,
     names ≤ 5 }` and holds the folder behind a ticket (5 min, one per document). `resolve_export_conflicts(ticket, choice)`: `keepBoth`
     → `create_unique` (`name (2).png`, `create_new`), `replace` → `storage::atomic::write_atomic` (temp + rename, never through a
     symlink: the target's `symlink_metadata` must be a regular file or absent), `cancel` → nothing. Without conflicts each file is
     still claimed with `create_new`, so a file appearing meanwhile becomes `name (2)`. Cancel keeps the files already written.
   - Requires `copy` permission on a restricted document (`read_only` `permission`).

3. **Images → PDF** (`images_to_pdf`). Source: the Rust open dialog (PNG, JPEG, multi, ≤ 500, sorted by natural file-name order) or a
   dropped batch: `sources.rs` sniffs dropped non-PDFs, keeps PNG/JPEG handles as an `ImageBatch` (≤ 500, 10 min) and pushes
   `AppEvent::ImagesDropped { batch, count, skipped }`; a mixed drop opens the PDFs and batches the images. Each image goes through
   **`content::image::intake` unchanged** (M5 limits: ≤ 20 MiB, header ≤ 8 192 px and 40 MP before decode, `max_alloc` 256 MiB, EXIF
   orientation, metadata dropped, ≤ 4 096 px long side, JPEG q90 or Flate + `/SMask`); a failing image is skipped with
   `done.warnings: imagesSkipped` and `skipped` count, all failing is `invalid_argument` `image`. Sum of stored images ≤ 1 GiB.
   Page size `fit` (image size at its pHYs/JFIF density if 72..=1 200 dpi, else 150 dpi, clamped 72..=14 400 pt), `a4`, `letter`;
   orientation `auto` (by aspect) / portrait / landscape; margin 0..=72 pt (ADR-050: 12 mm = 34 pt). Image scaled to fit, centred,
   never cropped. `pdfwrite::images_pdf::build` writes a fresh document (one page, one XObject per image, `/Producer` = APP_NAME, no
   other metadata). Then the merge pattern: Save As dialog (default `{first image stem}.pdf`), atomic write, opens as a tab
   (`done.opened`). Paper default: `AppBootstrap.paper` from `platform::paper_default()` (Windows `GetLocaleInfoEx` `LOCALE_IPAPERSIZE`,
   macOS `NSLocale` country US/CA → letter).

4. **Print** = option (c). `prepare_print` renders the selection (annotations on/off, range as item 2) through the same snapshot and
   `RenderExport` at `standard` 150 dpi or `high` 300 dpi (≤ 300 pages), JPEG q92, landscape pages pre-rotated to the paper orientation
   the UI asks for (`autoRotate`, default on), into an in-memory `PrintSet` (≤ 2 000 pages, ≤ 768 MiB, else `limit_exceeded`
   `printJob`). The UI fetches frames (`get_print_page`, SHR1) into blob URLs in `PrintSurface` (shown only under `@media print`, so it
   takes no screen slot; every other element is `display: none` in print), awaits `img.decode()`, then calls `open_print_dialog`:
   Windows `ShowPrintUI(System)`; if that interface is missing (runtime < 1.0.1185) → `Webview::print()` (WebView2 print preview,
   still local); macOS `Webview::print()`. It answers the route taken. `release_print` (also on close and after 10 min) drops the set.
   **No temp files** on any route; a future route needing one uses `storage::temp` (app cache dir, random name, 0600 / owner-only ACL,
   deleted on completion, swept at startup). Requires `print` permission. **Fallback:** if a platform route fails its gate (manual
   window review prints a 3-page fixture to "Microsoft Print to PDF" / macOS "Save as PDF"; text readable, one page per sheet, no UI
   chrome), Print on that platform is hidden, `BLOCKERS` records it, export a copy / images is the documented workaround, and native APIs
   (b) move to v1.1. macOS is unverified until B-001.

5. **Export a copy** (`export_pdf`). Options: `annotations: keep | flatten | remove`, `removeMetadata`. From the snapshot bytes
   (`load_untrusted` + ADR-040 pre-scan): `flatten` reuses `pdfwrite::flatten` (scope `formsAndAnnotations`), `remove` drops every
   `/Annots` entry except `/Link` and `/Widget` (and orphaned `/Popup`s), `removeMetadata` reuses `metadata::strip`. Always Full, new
   `/ID`, Save As dialog (default `{stem} copy.pdf`), atomic write, the open document and its path unchanged, nothing opens. An
   encrypted document's copy keeps its encryption (`keep_encryption`, ack `rewriteEncrypted`); `flatten`/`remove`/`removeMetadata` on a
   restricted document need `edit`. Signed source → `done.warnings: signaturesRemoved` when the copy changes signed content.

6. **Wave plan** (ADR-038). **W0 seams** (orchestrator): `limits.rs`, `JobEvent` phases and `done` fields, error `what`s + en/de keys,
   `AppEvent::ImagesDropped`, `AppBootstrap.paper`, `model/ranges.rs` (moved parser), `create_unique(folder, stem, ext)`, `Job::{OpenSnapshot,
   CloseSnapshot, RenderExport}` + `Engine` methods, `export::snapshot::current` signature, command stubs (`AppError::not_yet`, header
   `owned by package X`), capability grants, `lib.rs` registration. Then **four disjoint packages**:
   - **A images out:** `export/{mod,images,names}.rs`, `engine/export.rs`, `commands/export_images.rs`, `src/api/exportImages.ts`,
     `tests/export_images.rs`.
   - **B images in:** `export/from_images.rs`, `pdfwrite/images_pdf.rs`, `documents/image_batch.rs`, `sources.rs` (image sniff),
     `platform/{windows,macos}.rs` (paper), `commands/images_pdf.rs`, `src/api/imagesToPdf.ts`, `tests/images_to_pdf.rs`.
   - **C snapshot + export a copy:** `export/snapshot.rs`, `engine/snapshot.rs`, `pdfwrite/{export,save}.rs` (`write_to_memory`),
     `commands/export_pdf.rs`, `src/api/exportPdf.ts`, `tests/{snapshot,export_pdf}.rs`.
   - **D print:** `print/{mod,set,dialog}.rs`, `commands/print.rs`, `src/api/print.ts`, `tests/print_set.rs`.
   A and D render clean documents until C lands; dirty-document tests join in Politur M6.

**Crates.** Direct `cfg(windows)` dependencies on `webview2-com` 0.39 (MIT) and `windows` 0.62 (MIT OR Apache-2.0, feature
`Win32_Globalization`), the exact versions wry already pulls in (no new code in the tree); `objc2-foundation` likewise on macOS. Logged in
`docs/LICENSES.md` by packages B/D; `cargo deny` duplicate check pins them to wry's versions.

**Amendment (2026-10-04, package D).** `unsafe_code = "forbid"` stays (SECURITY hygiene, pinned by `tests/security_baseline.rs`), and `ShowPrintUI` is a COM call that needs `unsafe`. So both platforms use `Webview::print()`: on Windows the WebView2 print preview (local, with its own link to the system dialog), on macOS the WKWebView print panel. No `webview2-com`/`windows` dependencies. The System route returns only if a safe wrapper appears (v1.1).

**Consequences.** Printing is raster (150/300 dpi): fine text is slightly softer than vector printing, and very long jobs are capped
(2 000 pages); vector print via native APIs is v1.1. Output reflects unsaved edits without saving. Images → PDF re-encodes (no JPEG
pass-through, v1.1). Exported image names never carry document metadata. Not in M6: reveal in folder (v1.1), OCR, Office formats.

**W0 corrections (2026-10-04).** The code names differ from the text above: `content::image::intake` is `content::image::prepare` / `prepare_bytes`
(`ImageAsset` is the stored image, there is no `StoredImage`); SHR1 had only format 1 (PNG), so print frames are format 3 = JPEG
(`src/api/print.ts`); `parse_ranges` reports more than 1 000 ranges as `limit_exceeded` `outputs`, so package A maps selection errors to
`pageSelection` itself; `AppState` gains `engine()` and `has_unsaved_changes()` because its fields are private to `commands`.
`export::snapshot::current` answers `Live` for a clean document and `notYet` for a dirty one until package C lands.

**Amendment (U2b, images list).** DESIGN §3.43 needs a reorderable list with thumbnails, so one model serves both entry paths: the Rust picker (`pick_images`) also creates (or extends) a batch, and the dialog always works on a batch. New commands `list_image_batch` (index, display file name ≤ 120 chars, declared size; never a path) and `get_image_batch_preview` (SHR1, `maxPx` 16..=512, decoded under the M5 intake limits, cached per batch, at most 1 000 entries). `images_to_pdf` takes `order` (indices into the batch, a permutation or subset, ≤ 500, no repeats; `invalid_argument` `order`); indices are stable, so removing an image in the UI only leaves it out of `order`. The `dialog` source stays for compatibility.

## ADR-051 — Vector signatures with real curves (FEEDBACK F10)

**Status:** accepted (2026-10-04). Amends ADR-041 §3–§5 (signature art), ADR-042. Product-owner blocker for v1.0, ships with v0.8.1.

**Context.** Placed signatures look pixelated when zoomed. Drawn and typed art were already vector, but as polygons: typed glyph curves were
linearised to 12 segments, drawn strokes were perfect-freehand outline polygons simplified by the backend; image art was capped at 1 600 px;
the pad was 512×192 CSS px without device-pixel-ratio scaling.

**Decision.**
1. **Art = path commands, not polygons.** `VectorArt.paths: PathCmd[][]` with `PathCmd = ['M',x,y] | ['L',x,y] | ['C',x1,y1,x2,y2,x,y] | ['Z']`,
   art space 1 000 units high, y down, nonzero fill. The appearance stream writes them 1:1 as `m`/`l`/`c`/`h` and `f`; the app renders
   them as one SVG `<path d>` per subpath (crisp at any zoom and DPR). Limits: ≤ 64 subpaths, ≤ 20 000 commands, finite coordinates in
   −100..=1 100 × −100..=(width+100), validated in Rust.
2. **Drawn:** one algorithm, in the UI (`src/features/signatures/ink`): pointer samples `{x,y,t,pressure}` → Catmull-Rom centreline
   (centripetal, α = 0.5) → width from velocity (fast = thin, slow = thick, clamped 0.45–1.5× nominal, eased) and pressure when the pen
   reports it → closed outline as cubic Béziers with round caps. The live preview uses the same function, so what is drawn is what is
   saved. `create_drawn_signature` takes the Bézier outline paths (pad pixels), Rust validates, trims, normalises to art space; it no
   longer simplifies.
3. **Typed:** skrifa outlines are emitted as curves: quadratic segments raised exactly to cubic, cubic kept; no linearisation.
4. **Image:** near-white becomes transparent with a soft ramp (luminance 225→245 → alpha 1→0, no halo); stored at up to 3 000 px on the
   long side (no upscaling), so at the default placed width (≈ 2 in) it embeds at ≥ 300 dpi; the ghost/inline preview frame is 1 024 px.
5. **Pad:** ≥ 600×200 CSS px (initials 200×200), canvas backing store scaled by `devicePixelRatio`, real-time smoothing, a "New" (clear) button.
6. **Selection frame and handles** follow DESIGN §3 selection rules (rounded handles, Iris ring), not square boxes.

**Amendment (implementation).** The pad stays an SVG surface instead of a canvas: SVG is resolution-independent, so no backing store or DPR rescaling is needed and the live preview is as sharp as the result. The sheet gets a wide variant (`--sheet-width-wide`, 696 px) so the 600 px pad fits.

**Consequences.** Library entries saved before 0.8.1 hold polygons: they load as `L` paths (still vector) and look as before; re-creating
them gives curves. Acceptance: window screenshot at 200 % with smooth edges; the saved PDF rendered at 400 %.

## ADR-052 — CI runs on main are never cancelled

**Status:** accepted (2026-10-04). Amends ADR-045 (concurrency) and ADR-046.

**Context.** With `cancel-in-progress: true`, each push to `main` cancelled the previous run. During a milestone the orchestrator pushes
every few minutes, so between `a4d53c8` and the M6 release candidate no run on `main` finished at all, and the DoD ("last finished run on
main green on both platforms") could not be read. Public-repository runners are free (ADR-046).

**Decision.** `cancel-in-progress` is false for `refs/heads/main` and stays true for pull requests and manual runs. Runs on main queue
per group; every commit gets a finished result.

**Consequences.** More runner time, no cost. Results arrive later during bursts; the milestone-end read (ADR-030) looks at the newest
finished run.

## ADR-053 — Polish and ship (M7): engine process, autosave, updater, budget, installers, CSP

**Status:** accepted (2026-10-04). Amends ADR-002 §8–§9, ADR-004 §6, ADR-005 (CSP), ADR-028 (respawn), ADR-031 (release). SECURITY P6,
T6, D5, S6. Signatures: ARCHITECTURE §5 "Ship (M7)" and §11.

**Context.** Open M7 items: engine crash isolation, crash-safe autosave, signed opt-in updater, a measured performance budget, real
installers, and `style-src 'unsafe-inline'`. A PDFium segfault or wedge (`/XStep`, self-calling Form XObject) takes the app down or
leaks a thread (ADR-028, `MAX_RESPAWNS = 3`). Rules: no unsafe, permissive deps, offline except the updater, typed `Result`s.

### 1. PDF engine in its own process

**Options.** (a) Sidecar binary `src/bin/sheer-engine.rs` as Tauri `externalBin` (ADR-002 §9): a second binary per target triple
(`-aarch64-apple-darwin` names, `lipo` for universal), a second signed and notarized Mach-O, version skew possible. (b) **The same
executable with a mode flag**: one binary to sign, notarize and update, nothing new to bundle; the child never builds Tauri, so no webview
starts. (c) Keep the thread: segfaults stay fatal.

**Decision: (b).**
1. **Entry.** `main.rs`: `if let Some(code) = sheer_lib::engine_child_main() { std::process::exit(code) }` before `sheer_lib::run()`.
   Child mode needs both `argv[1] == "--sheer-engine"` and env `SHEER_ENGINE_PROTOCOL=1`; a file path from an association can never equal
   the flag (Windows passes a full path). Single-instance is registered in `run()` only, so the child never forwards itself.
2. **Spawn.** `std::process::Command::new(current_exe())`, stdin/stdout piped, stderr piped into the parent log (one line per entry,
   ≤ 4 KiB); Windows `CommandExt::creation_flags(CREATE_NO_WINDOW)`. The child ends on stdin EOF, so it dies with the parent on both
   OSes without job objects. Spawned eagerly at startup on a background thread (handshake ≤ 5 s) so the first open does not pay for it.
3. **Wire** (`engine/wire.rs`): frame = `u32 LE len | u8 kind | u32 LE seq | u32 LE header_len | header | blob`. Header = serde_json (B1: no new dependency; postcard dropped; a `len` 0 `ReadAt` asks for the file length) — was: postcard
   (MIT OR Apache-2.0, serde, new dep) of `WireRequest`/`WireReply`; bulk bytes (frames, rasters, snapshot and source bytes, file reads)
   travel raw in `blob`. No sockets, no named pipes of our own. Handshake: `Hello { protocol: 1, library: PathBuf, version }` →
   `Ready { pdfium: bool }`.
4. **The child is less trusted than the parent.** Every reply is hostile input: the parent checks `len` against the cap for the
   pending request's kind *before* allocating (render ≤ `MAX_FRAME_BYTES`, raster ≤ export cap, header ≤ 16 MiB), checks `seq`, and
   re-sanitizes sizes (`limits::sanitize_page_size`) and counts. A violation kills the child (`protocol_violation`, logged).
5. **Files without paths** (`engine/remote_file.rs`, `engine/files.rs`). Handles cannot cross processes without unsafe, and reopening
   by path would break "open once, judge the handle". The parent keeps the intake handle in `FileTable` (`HashMap<FileToken, File>`);
   PDFium in the child reads through `RemoteFile: Read + Seek`, which sends `ReadAt { token, offset, len ≤ 1 MiB }` and keeps a 256 KiB
   × 64 block cache per document. The parent's reader thread answers `ReadAt` directly (`FileExt::seek_read` / `read_at`), never via the
   queue. `Release` drops the handle in the parent too, so `ReplaceFile` still works on Windows. The child opens no file except the
   PDFium library (CI grep: no `std::fs` in `engine/{host,remote_file}.rs`).
6. **Queue mapping.** `queue.rs` is unchanged and stays in the parent. The `sheer-pdfium` thread becomes `sheer-engine-pump`
   (`engine/pump.rs`): it pops a `Request`, turns `Job` into `WireRequest` (reply channel and `Confirm` stay local; `Confirm` runs in the
   parent on `Opened`, and a `false` sends `Close`), sends it, waits ≤ `run_deadline`, writes `SizeCache` from `Opened`/`Reopened`, and
   answers the waiters. One job in flight, as today. `worker::serve` moves behind `engine/host.rs` (the child loop), unchanged in
   substance. `set_viewport`, dedupe and cancellation still act on the parent queue. `Transport` is a trait with `ChildTransport`
   (release) and `InProcessTransport` (the current thread worker: unit tests and `with_handler` doubles).
7. **Restart and replay** (`engine/ledger.rs`). Death = stdout EOF, read error, exit, protocol violation, or a deadline overrun (the
   parent kills the child: `Child::kill`; this replaces `Engine::recover`, `MAX_RESPAWNS` and the leaked threads). The in-flight job gets
   `engine_crashed`; its document gets a strike. A new child is started and every open document is replayed at Control rank before
   queued work: `Reopen` from its `FileTable` handle (password from the registry), then its ledger in order: `AppendBlank`,
   `AppendPages(source, pages)`, `Truncate`, net rotations, net crop boxes, net hidden set; live snapshots reopen from the export job's
   `Arc<[u8]>` (parent assigns `SnapshotId`). Re-read sizes must equal the old ones, else that document is lost. Two strikes =
   quarantined: not replayed, `engine_crashed` until closed. Budget: 5 restarts per 10 min (`limits::ENGINE_RESTART_BUDGET`), then
   `engine_unavailable` until app restart. The UI hears `AppEvent::EngineRestarted { lost: Vec<DocumentId> }` on the app channel.
8. **Save without an engine.** ADR-004 step 6 (PDFium test open) becomes best-effort: lopdf re-parse is mandatory, the PDFium check is
   skipped and logged when the engine is unavailable, so the user can always save.
9. **Tests.** Unit tests keep `InProcessTransport` (no change to `shared_engine`). New `tests/engine_process.rs` runs the real child via
   `env!("CARGO_BIN_EXE_sheer")`: open/render parity, kill mid-render → replay with rotations and hidden annotations intact, oversized
   reply length → kill, strike → quarantine, restart budget. A `Crash` wire request exists only under `cfg(debug_assertions)` and env
   `SHEER_ENGINE_TEST_HOOKS=1`. The two `#[ignore]`d wedge corpus cases are enabled; `fuzz_corpus.rs` runs through the child with a 15 s
   per-file deadline.

Sandboxing the child (macOS `sandbox_init`, Windows AppContainer) needs unsafe or new native deps: v1.1, recorded as P6 residual.

### 2. Crash-safe autosave

**Options.** (a) The ADR-004 §6 JSON of model state: `DocState` is not serializable today (history, import bookkeeping, form model,
content objects), replay would have to be deterministic against lazy page imports, and imported sources live only in memory. (b)
**Snapshot bytes** from the M6 seam (`pdfwrite::save::write_to_memory`): the document with its edits and nothing else (D5 read
literally), recovered by the ordinary open path.

**Decision: (b); amends ADR-004 §6.**
- **What.** `storage/autosave.rs` writes `<n>.pdf` (snapshot, Full) plus `<n>.json` = `{ v: 1, original: { path, len, mtime }, displayName,
  pageCount, savedAt, appVersion }`. No passwords, no history, no UI state. Original path is app-data-only, like recents.
- **Where.** `$APPDATA/autosave/<session-uuid>/`, dir 0700, files 0600 (`storage::atomic`), Windows inherits the profile ACL. The
  session holds `lock` via `File::try_lock` (std ≥ 1.89, safe) for its lifetime.
- **Cadence.** Dirty documents only: 30 s after the last change, at most every 120 s while editing continues, and on window blur;
  Background on the blocking pool, one at a time, never during a save. Skipped (status `offTooLarge`) if the snapshot exceeds 512 MiB;
  total store ≤ 2 GiB (oldest session purged).
- **Encrypted.** Never written: a snapshot is unencrypted and re-encrypting would put a key-derived copy on disk. Skipped for files
  that are encrypted *and* for documents with a pending protection change (status `offEncrypted`, shown in the status bar). v1.1 may
  add keep-encrypted via `pdfwrite::crypt`.
- **Recovery trigger.** At startup `storage::autosave::scan` lists session dirs whose `lock` can be taken (dead sessions). The UI calls
  `list_recoveries` once after `subscribe_app`; a non-empty answer shows the recovery banner-row variant (ADR-054 §5): name, folder name,
  time; Recover / Discard (undoable 8 s: the UI calls `discard_recovery` after the window) / Decide later (records kept). Recover opens the snapshot through `intake::admit` as `DocKind::Recovered { original }`: Save
  acts as Save As, defaulting to the original folder and name (like `DocKind::Welcome`), with a banner if the original changed or is gone.
- **Cleanup.** Deleted on successful save, on close (saved or discarded), on Discard, and for the whole session on normal quit;
  dead sessions older than 14 days are purged at startup.

### 3. Signed opt-in updater

- **Crate.** `tauri-plugin-updater` 2.x (MIT OR Apache-2.0), `default-features = false, features = ["native-tls", "system-proxy",
  "zip"]`: SChannel / Security.framework instead of rustls with webpki-roots (CDLA-Permissive), `zip` for the macOS tar.gz. Verified with
  `minisign-verify` (MIT).
- **Keys.** Public key `src-tauri/updater/minisign.pub`, embedded by `include_str!`. While it is the placeholder, the updater reports
  `unsupported_feature` and the setting is hidden. Private key and password: never in repo or CI (T6) → BLOCKERS. CI builds artifacts with
  `createUpdaterArtifacts: true` unsigned; the maintainer runs `scripts/sign-update.sh` locally (`tauri signer sign`) and uploads `.sig`
  files and `latest.json`.
- **Endpoint.** Exactly `https://github.com/renderdrop/sheer/releases/latest/download/latest.json`; no URL templates, so the request
  carries no version or identifier. HTTPS only (insecure transport never enabled; pinned by a test).
- **Opt-in.** Setting `updates: "off" | "on"` defaults to `"off"` (plus `skippedVersion`, ADR-054 §4); when on, one check per 24 h after
  startup, failures silent. "Check for updates" in About is an explicit per-click consent. The package is downloaded and verified first
  (a bad signature deletes it); installing happens only after the normal quit flow has resolved every dirty document, then Windows runs
  NSIS in `passive` mode and macOS swaps the bundle; restart via `AppHandle::restart` (no process plugin).
- **The only network module.** `src-tauri/src/update/` is the only code naming `tauri_plugin_updater`; it registers the plugin
  (`update::plugin()`) and owns all requests. `check.sh` keeps `NETWORK_ALLOWED_PARENTS=(tauri-plugin-updater)` and adds
  `guard_updater_scope` (grep: `tauri_plugin_updater` only under `src/update/`). No capability grants `updater:*`
  (`security_baseline.rs` pin), so the webview cannot call the plugin. Requests are Rust-side: CSP `connect-src` is unchanged.

### 4. Performance budget

- **Backend bench** `src-tauri/tests/perf_open.rs` (`#[ignore]`, `npm run bench`, Windows CI job, non-blocking for one milestone then
  blocking): generates 500-page text-heavy and image-heavy PDFs with lopdf into a temp dir, child engine pre-spawned; median of 5. Pass:
  admit → page sizes ≤ 400 ms; admit → first Visible frame of page 1 at 100 % ≤ 1 000 ms; `get_page_sizes` ≤ 2 ms.
- **UI** `node scripts/ui/cdp.mjs fps <idle|scroll|zoom|panel|thumbs>` (WebView2 CDP, ADR-021) injects a rAF recorder, drives the
  scenario 10 s on the 500-page fixture. Pass: mean ≥ 58 fps, p95 frame ≤ 20 ms, ≤ 1 frame > 34 ms per scenario (F3; thumbs at 120
  px/frame). macOS is checked manually (Safari timeline); no CDP.
- **Hot spots to measure first.** Box/rotation read per page at open (may load every page: make lazy if > 100 ms); pipe hop for frames
  (≈ 1–3 ms each); main-thread PNG decode (use `img.decode()` before swap); `layout.ts` recomputing all rows per scroll (prefix sums,
  binary search); thumbnail mounts during fling (placeholder until settled).
- **Scroll compression.** Above 16 M CSS px of document height the spacer is capped and `layout.ts` maps scrollTop ↔ document offset by a
  ratio (`toVirtual`/`fromVirtual`), with anchors in document space. **Cache budget:** 256 MB default; `navigator.deviceMemory` ≤ 4 →
  128 MB, ≥ 16 → 512 MB; trimmed to 50 % when the window is hidden.

### 5. Installers

- **Windows: NSIS only**, `installMode: "currentUser"` (no admin), `languages: ["English", "German"]`, `headerImage`
  (150×57) and `sidebarImage` (164×314) BMPs in Iris with the Sheer mark, sources `src-tauri/installer/*.svg`. WebView2:
  `downloadBootstrapper`, silent (Windows 11 ships the runtime; offline Windows 10 needs the Evergreen runtime: documented).
- **.pdf without stealing.** `tauri.windows.conf.json` sets `bundle.fileAssociations: []` (Tauri's NSIS macro writes the `.pdf`
  default). `src-tauri/installer/hooks.nsh` (`installerHooks`): POSTINSTALL writes HKCU `Software\Classes\Sheer.Document.pdf` (open
  command `"$INSTDIR\sheer.exe" "%1"`, icon), `Software\Classes\.pdf\OpenWithProgids\Sheer.Document.pdf`, `Capabilities\FileAssociations`
  + `RegisteredApplications`, then `SHChangeNotify`; PREUNINSTALL removes exactly these. Default handler only on opt-in: Settings →
  "Make default PDF app" opens `ms-settings:defaultapps?registeredAppUser=Sheer` (constant URL, Windows only).
- **macOS: DMG**, `rank: Alternate` kept, **universal** binary (`universal-apple-darwin`; `fetch-pdfium.sh` fetches both slices): one
  artifact, one updater entry for `darwin-aarch64` and `darwin-x86_64`, at the cost of ≈ +15 MB.

### 6. CSP hardening

Inline *style attributes in markup* are what `'unsafe-inline'` permits; React and Motion set styles through CSSOM (`element.style`,
WAAPI), which CSP does not govern; Tailwind 4 and Vite emit CSS files in release; Tauri adds hashes for its own injected code.
**Decision:** release CSP becomes `style-src 'self'`; devCsp keeps `'unsafe-inline'` (Vite HMR injects `<style>`). Gate:
`scripts/ui/cdp.mjs csp` walks every surface of the release-CSP build and fails on any `securitypolicyviolation`; the offenders to fix are
markup `style="…"` (SVG assets, `dangerouslySetInnerHTML`) and runtime `<style>` injection. `security_baseline.rs` pins the absence of
`'unsafe-inline'` in the release CSP. Fallback only if a dependency cannot be fixed: a hash source, never `'unsafe-inline'`.

### Wave plan

- **W0 seams (one package).** `engine/wire.rs` (types, codec, caps; serde derives on payload types), `Transport` trait +
  `InProcessTransport` behind `Engine` (no behaviour change), `engine/files.rs`, `engine_child_main` stub returning `None`, `limits` consts,
  `DocKind::Recovered`, settings keys `updates`, `skippedVersion`, lib.rs hook calls (`autosave::start`, `update::plugin`) as internal no-ops.
- **W1 backend, disjoint.** B1 engine process: `engine/{transport,pump,host,remote_file,ledger}.rs`, `engine/mod.rs`, `main.rs`,
  `events.rs`, `tests/engine_process.rs`, `tests/fuzz_corpus.rs`. B2 autosave: `storage/autosave.rs`, `commands/recovery.rs`,
  `documents/` (Recovered), save/close hooks in `commands/save.rs`. B3 updater: `update/`, `commands/update.rs`, `Cargo.toml`,
  `updater/minisign.pub`, `scripts/{check,sign-update}.sh`, `docs/BLOCKERS.md`. B4 packaging, CSP, bench: `tauri.conf.json`,
  `tauri.windows.conf.json`, `installer/`, `.github/workflows/release.yml`, `scripts/fetch-pdfium.sh`, `tests/{security_baseline,perf_open}.rs`.
- **W2 frontend.** F1 recovery banner + engine-restart toast + Recovered Save As (`src/features/recovery/`, `api/recovery.ts`,
  `appEvents.ts`). F2 updater UI (`src/features/update/`, `api/update.ts`, Settings, About). F3 performance (`viewer/layout.ts`,
  `engine/renderCache.ts`, thumbnails, `scripts/ui/cdp.mjs fps`). F4 CSP sweep + default-app button. Accessibility, i18n, tips,
  onboarding and recents thumbnails follow as W3.

**Consequences.** A crash or wedge costs one restart and a replay instead of the app. Frames pay one pipe copy. Autosave writes up to
512 MiB per dirty document per cycle; encrypted documents have no crash protection in v1.0. Updates need a manual local signing step
per release. The sidecar of ADR-002 §9 is not built.

## ADR-054 — M7 UI decisions (DESIGN §3.46–§3.52)

**Status:** accepted (2026-10-04). Engine, autosave format, retention and updater transport defer to ADR-053 (M7 architecture).

**Decision.** (1) Tour: all seven steps ship; Sign completes by placing or dragging into the frame; Reorder completes on page order from
any input (thumbnails or Organize); the reorder string takes `{from}`/`{to}` from `steps.json` (the old "page 4 above page 5" did not
match the 5-page edition). Step 5 says "Note" (the tool's name since §3.22). (2) Tool tips reuse the coach-card anatomy in a compact
form, one per tool, marked seen *before* showing, no timeout, suppressed during the tour; Settings gains a Help row (restart tour,
show tips again). (3) Recents thumbnails are rendered by Rust at close/save into the app cache and fetched by id; encrypted documents
are never cached; the privacy footer names previews. (4) Updater: Off by default, segmented Off/On in Settings with a hint that names
GitHub and what it sees; automatic check failures are silent; "update available" is an info banner, never a dialog; install only via
restart through the normal quit flow; a failed signature deletes the download and offers no retry. (5) Crash recovery is a banner-row
variant, not a modal sheet, so nothing blocks; it ranks below errors and above warnings; discard is undoable for 8 s; "Decide later"
keeps the records. (6) Installer and DMG artwork carry no text (language-free, single trademark source), light only, generated from
`logo.svg`. (7) Disabled toolbar icons drop the 50 % opacity for a new `--color-icon-disabled` (ink-50 both themes, ≥ 3:1 on G1).

**Consequences.** New tokens `--list-thumb-w/-h`, `--color-icon-disabled`; `--opacity-disabled` removed. Settings gains
`tipsSeen`, `updates`, `skippedVersion`. Finder label legibility on the DMG is verified with B-001.

### ADR-053 amendment (B4): packaging notes

Artwork outputs live in `src-tauri/installer/` (not `icons/installer/` as DESIGN 3.51 says), generated by `scripts/gen-installer-art.mjs`
(`npm run gen-installer-art`) with `@resvg/resvg-js` (MPL-2.0, devDependency, MIT-compatible pure render, deterministic; rejected: hand-rolled
rasteriser, system ImageMagick). The DMG gets the 660 x 400 PNG only (Tauri takes one file). Universal macOS: `fetch-pdfium.sh mac-universal`
fetches both slices and the bundle carries both directories; each slice loads its own (`PLATFORM_DIR`), no lipo of PDFium. CSP: markup grep
found no `style="`, `<style` or `innerHTML` in `src/` or `index.html`, so release `style-src 'self'` applies; the runtime proof is the F4 `cdp.mjs csp` gate.

**ADR-053 amendment (updater artifacts, B3 review).** No config sets `bundle.createUpdaterArtifacts` (Tauri refuses it without the signing key).
`release.yml` passes `--config '{"bundle":{"createUpdaterArtifacts":true}}'` and the key envs only when the repository secret
`TAURI_SIGNING_PRIVATE_KEY` exists (the check is a `!= ''` expression, the secret is never echoed); it then uploads the NSIS `.exe.sig` and the
macOS `*.app.tar.gz` (+ `.sig`) and the publish job writes `latest.json` (`scripts/latest-json.mjs`). Without the secret the release is unsigned
installers only. The alternative stays local signing with `scripts/sign-update.sh`. This supersedes "CI builds artifacts unsigned" in section 3.

**ADR-053 amendment (F4, CSP sweep).** `node scripts/ui/cdp.mjs csp` (see `docs/UI_REVIEW.md`) found 0 violations of the release CSP
(`style-src 'self'`) on the empty state, settings and all toolbar buttons; React and Motion style props use the CSSOM, which `style-src` does not
block, so no `'unsafe-inline'` and no source change was needed. The gate is a milestone DoD step. The Windows-only "Make Sheer the default PDF app"
row in Settings calls `open_default_apps_settings`; it is hidden on macOS and when the platform is unknown.

## ADR-056 — Tools stay active; tool options do not refit the zoom (F11)

**Decision.** (1) After creating an annotation (markup, note, text comment, draw, shapes, sign marks and signatures, insert text and image) the tool stays active until Esc or the Select tool; the one-shot release in the layers is gone (`toolLocked` remains for the toolbar lock state). The Add image tool keeps its chosen image armed for the next click. (2) A fit mode (fit width, fit page) refits only when the user resizes the window or toggles a panel explicitly. The canvas resize caused by the tool-options inspector opening or closing because the tool changed keeps zoom and scroll position (`features/viewer/fitHold.ts`). F11-E amendment: the rule covers the inspector opening or closing for any reason (tool options or a selection), so a click on a mark never moves the page under the cursor. The timer is gone: the hold is armed by a store change that flips the inspector slot, spent by the next canvas size report, and dropped by a window resize or a left-panel change, so it cannot swallow a real resize. (3) Overlay layers pass the page element's size in CSS px to `overlayBox` (was points, which shifted previews by (pxPerPt - 1) * size / 2).

## ADR-057 — Comments panel lists marks and signatures as typed entries (F11-C)

**Decision.** `list_document_annotations` summarizes every annotation that is written to the file (`is_written_as_annotation`), so the Fill & Sign marks (check, cross, dot, date, initials) and signature stamps appear in the Comments panel as their own entries with an icon and the type label (`annot.type.mark`, `annot.type.signature`, en/de, already in the catalogs) and can be filtered by type. Text boxes, images and redaction marks (ADR-047) are page content or model-only objects and are skipped deliberately. The cause of "Comments could not be read" was the frontend summary parser, whose kind allow-list lacked `signature` and `mark`: one such annotation made the whole answer malformed. Also fixed (F11 item 4): the resize command sent the coalesce key `resize:<id>`, but the backend only accepts `[A-Za-z0-9._-]`, so every resize and keyboard resize was refused with `invalid_argument`; the key is now `resize.<id>`.

## ADR-058 — v1.1 "Structure and comfort": hub, tools-only toolbar, menu bar, Word-style comments (DESIGN §3.54–§3.60)

**Status:** accepted (2026-10-04). Source: FEEDBACK F12 items 1–5. Numbered after ADR-055–057, reserved by parallel packages.

**Decision.** (1) The empty state becomes a tool hub: eight G1 cards (Open, Merge, Split, Compress, Images to PDF, Sign, Redact, Fill
form) in a 4-column grid above the unchanged recents; each card runs Rust's file dialog and lands in a defined mode (Split → Organize +
Split dialog, Fill form → first field or the Fill section of Fill & Sign). (2) The toolbar holds seven tools only (Select, Highlight,
Comment, Draw, Shapes, Fill & Sign, Redact) in one centred glass card, labelled when it fits; the Form tool, More, overflow and toolbar
Undo/Redo go; zoom moves to the status bar; the two panel toggles stay as handles. (3) Commands move to File / Edit / View / Tools /
Help: native on macOS (existing muda menu plus Tools), an **in-window menu bar in the Windows caption row** rendered from the same
`menu.json` and registry; a native Win32 menu is rejected because it needs native decorations (ADR-014) and cannot follow the theme.
This supersedes ADR-016 item 4. (4) The inspector is context only (mode, selection, then tool options of tools that have them) and
auto-opens at every width ≥ 960. (5) Form fields are always live with a notice banner; Flatten in File; marks and text sit in the Fill
section of the Fill & Sign popover. (6) Comments: a selection bar offers "Add comment" (Highlight with contents); cards show type tile +
label, quote, body, author, time, replies and review state written as PDF `/StateModel /Review` replies. (7) Typed signatures use three
bundled SIL OFL 1.1 fonts (Dancing Script, Great Vibes, Alex Brush), unmodified, chosen on preview cards; OFL-1.1 is allowed for fonts
only; Homemade Apple is removed (supersedes ADR-042 (1)).

**Consequences.** New registry actions and `menu.*` keys; `menu.json` gains Tools and Help items and a Windows renderer; tour anchors
for removed toolbar items (Pages, Form) move to the sidebar or Tools menu; the comments list switches to measured virtualization;
`docs/LICENSES.md` gains three font entries and the allowlist note.

## ADR-055 — Surgical redaction (F11-A)

**Status:** accepted (2026-10-04). Supersedes ADR-047 §3 option (b) "raster the affected page". Source: FEEDBACK F11 item 1, owner override.

**Context.** The raster page made the whole page a picture: no selectable or searchable text after a redaction of one sentence. The owner
also saw a black bar over the bottom of the page after the first redaction (`review/owner/f11-redact-bar.png`).

**Decision.** (1) Redaction rewrites the page's content (`pdfwrite/redact_content.rs`, `redact_image.rs`) and never rasters a page.
Text: per glyph from the font widths (`/Widths`, `/W`, standard 14 metrics for Helvetica, Times-Roman, Courier), box from the text
matrix and CTM and the descriptor's ascent and descent; a glyph that touches a mark is not written and its advance becomes a `TJ` number so
the rest keeps its place; a font with unknown widths (no `/Widths`, bold or italic standard faces, a CMap other than Identity-H) is cut per
show operator. Paths: straight strokes are cut at the marks, fills of axis-aligned rectangles have the marks cut out, any other painted
path that touches a mark is dropped, clips are kept. Images and inline images: the covered pixels (and of the `SMask`) are zeroed and the
image is written again (Flate raw, JPEG q90 for JPEG); anything undecodable is dropped. Forms are copied and cut recursively (depth 8,
cycles dropped), shadings are painted through a clip without the marks, annotations of the page are not carried (the model drops them
as before), `BDC` property lists (except `/OC`) become `BMC`, `DP`/`MP` go, and a black rectangle is drawn for every mark. The
original entries of replaced XObjects are removed from the resources, so nothing of the covered pixels is left in the file. (2) Fail
safe: odd operands of a show operator drop it, an unreadable form or image is dropped, a page whose content does not parse is refused
(`damaged_file`); never a raster. Limits (`MAX_REDACT_*`): 24 MiB decoded content per stream, 6 M operators, 20 000 marks per page,
2 G rectangle tests, 100 MP per decoded image. (3) The pipeline is unchanged: the job reads the page from the file on disk (decrypted
with the session password; changed on disk is `needs_confirmation`), an import source or the old redacted page, writes a one-page PDF
(MediaBox from the origin, `/Rotate`, a private marker key that `finish` removes), appends it to the engine copy, and one model step swaps
the slot (`PageSource::Redacted`). Save, scrub, undo are as in ADR-047. `engine::redact` (bitmap) stays in the tree for page export
reuse and is no longer called by redaction.

**Bar (F11 1a).** Most likely cause (not reproduced without the window): a region of the old bitmap that PDFium did not draw (the bitmap starts zeroed, so black): the page was
drawn into a bitmap of another aspect than the one the burn and the raster page assumed. It cannot occur now: no bitmap exists, the only
black is one rectangle per mark, each clamped to the shown box, and marks that are not numbers, empty or outside are ignored
(`user_rects`, unit test `marks_that_are_not_numbers_or_outside_the_page_are_ignored`).

**Consequences.** Text outside the marks stays text in Sheer and other viewers. Residual (SECURITY D4): font programs and `/ToUnicode`
maps keep the subset's glyphs; shading definitions stay; fonts without widths lose whole show operators. `apply_redactions` keeps its
signature; `PageWork` gains `source` and `shown`; `pdfwrite::redact::raster_page` is removed.

---

## ADR-059 — OFL-1.1 for bundled fonts only (typed signature fonts)

**Status:** accepted (2026-10-04). Part of ADR-058 (DESIGN §3.60).

**Context.** Homemade Apple (Apache-2.0) is replaced by Dancing Script, Great Vibes and Alex Brush, which are SIL OFL 1.1 (google/fonts `ofl/`; `OFL.txt` headers confirmed at import). OFL-1.1 is permissive but not on the rule 2 list.

**Decision.** OFL-1.1 is allowed for **font assets only**, never for code dependencies; `deny.toml` (crates) is unchanged because fonts are not crates. The TTFs are unmodified, so the Reserved Font Names are not touched; each ships beside its `OFL-<name>.txt` in `src-tauri/resources/fonts/` and is logged in `docs/LICENSES.md`. Glyphs become outlines (Bézier paths) in the PDF and the library; no font is embedded, so the output is not a font derivative. `TypedFont` is `dancingScript | greatVibes | alexBrush` (IPC `create_typed_signature`, default `dancingScript`). The font of a typed library entry is remembered in UI storage (`sheer.signatureItemFonts`); the last choice is `signatureFont`; stored `homemadeApple` values migrate to the default. Homemade Apple and its license are removed.

**Consequences.** Old entries keep rendering (stored as paths). A font-license allowlist exists in prose only; adding another font license needs a new ADR.

---

## ADR-100 — Rebrand to "sheer." (milestone v1.2)

**Status:** accepted (2026-10-04). Source: `docs/REDESIGN_BRIEF.md` (product owner), `docs/BRAND.md` (the only truth for tokens,
colours, type, shapes and brand rules), `docs/brand/moodboard.png` (layout reference). The brief outranks everything it contradicts.

**Superseded.** ORCHESTRATOR_PROMPT §3 design guardrails (Iris accent, liquid glass, light + dark, spring motion) and Anhang A (glass-sheet
logo, "Sheer" word mark); ADR-011 (design adjustments), ADR-012 (token amendments), ADR-020 (mood: gradient, tinted glass), ADR-022 (one
spring motion system, `docs/MOTION.md` v1), the visual parts of ADR-029, ADR-037, ADR-042, ADR-048, ADR-050, ADR-054 and ADR-058 (glass
toolbar card, inspector panel, Windows in-window menu bar in the caption row), the Okabe-Ito highlight palette, and the visual parts of
ADR-051 (selection frame styling). Behaviour from those ADRs (keyboard, data, IPC, security) stays unless the brief changes it. ADR-016
(macOS native menu bar) stays; ADR-059 (OFL fonts) stays and is extended to Inter.

**What changes.** Solar Yellow `#FFF84D` is the only accent on Canvas/Sand/Mist; flat surfaces (no `backdrop-filter`, no translucency);
light only (`prefers-color-scheme` ignored, the theme and glass settings go); ease-out 120/160/180 ms, no overshoot; word mark "sheer."
and app icon "s."; Inter bundled; Top Bar + left Pages sidebar + right Tools sidebar; highlight default Solar Yellow.

**Decisions the brief leaves to the conductor (brief §5 plus the following).**
1. Home navigation has no "Shared"/"Trash" (no cloud, no file management). Windows has no classic menu bar (Top Bar, sidebars and More
   cover every command); macOS keeps the native one. Red only for the redaction warning and errors. Conflict moodboard vs BRAND text:
   BRAND wins on tokens, the moodboard on layout proportions. The old brand leaves repo, docs and assets except CHANGELOG and ADR history.
2. `docs/FEEDBACK.md` has no F13 section at the start of v1.2, so nothing precedes the brief. The `[~]` "v1.2 polish" list from v1.1 is
   folded into the last package "Politur v1.2": items made obsolete by the redesign (glass, dark, toolbar card, menu bar) are dropped there.
3. Package 0 (designer: `docs/DESIGN.md` v2 + `docs/MOTION.md` v2) blocks all visual work. The Rust package B1 (favourites + reveal a
   recent file) has no design content and runs in parallel with it.
4. Token migration: `tokens.css` is rewritten in R0 (BRAND §24 primitives + brief R0.1 semantic tokens). The Tailwind role layer
   (`--color-text-muted`, `--color-accent`, … that the utilities use) stays as the component API and is re-pointed to the semantic tokens,
   so the whole app repaints in one step. Old palette names (`--iris-*`, `--ink-*`, glass recipes) survive only in a marked "legacy
   aliases" block mapped to new values, so parallel packages do not collide; R3/R4 remove every use and R7 deletes the block (brief §6:
   no "iris", "glass", "dark" in code).
5. Fonts: OFL-1.1 stays a font-asset-only allowance (ADR-059). `deny.toml` governs crates, so OFL-1.1 is not added to its crate
   allowlist; a comment there records the font-only allowance. Inter (variable, woff2, Latin + Latin Extended) is logged in
   `docs/LICENSES.md` and served from the bundle (`font-src 'self'`).
6. `APP_NAME` renders "sheer." in UI text; bundle name, product name, file names and installer name stay `Sheer` (file-system
   conventions; trademark text in `TRADEMARK.md` names both spellings).
7. Designer acceptance runs once per phase (brief §3), from Tauri-window screenshots next to moodboard crops; only blockers trigger a fix
   package, majors/minors go to "Politur v1.2".

**Consequences.** `ROADMAP.md` gains "v1.2 Redesign" (Package 0, B1, R0–R7). Every R-phase ends with a designer round. Smoke test,
CSP gate, contrast script and fps budget gate the tag v1.2.0.

## ADR-101 — v1.2 wave plan: shell skeleton and R4 primitives before the R2/R3 screens

**Status:** accepted (2026-10-04). Extends ADR-100.

**Context.** Home (R2) and the editor (R3) both rewrite `Shell.tsx`, `MainGrid.tsx` and `src/lib/layout.ts`, so four parallel packages
cannot share them; and the R2/R3 screens should be built from the restyled R4 primitives, not restyled twice.

**Decision.** (1) Wave 3 runs four packages in parallel: S = shell skeleton (Home/editor view switch, the DESIGN v2 §3 grid with empty
slots filled by the old components, panel widths 200/200/320 in `layout.ts`, `components/tokens.ts` and `limits.rs`), C1 = R4.1 primitives
(buttons, icon buttons, inputs, menus, popovers, tooltips, dialogs, toasts), C2 = R4.2 primitives (tabs, segmented, toggle, checkbox,
slider, swatch, skeleton, banner, dropzone), F1 = R1 brand fixes from the R0 designer round plus R1.5 (About, README, release notes).
(2) Wave 4 fills the skeleton slots in parallel: Home (R2), top bar (R3.1), tool sidebar (R3.3), page sidebar and canvas (R3.2/R3.3).
(3) R3.4 (form banner, selection popover, comments tab, redact band) and R4.3/R4.4 follow in wave 5. Designer rounds stay per phase
(brief §3); the R2 and R3 rounds run after wave 4, the R4 round after wave 5. Intermediate states between waves are never tagged.
(4) The R0 designer round (PASS) and the R1 asset review are combined into one round; R1 acceptance (Explorer icon, word mark in Home,
installer build) completes after wave 4.

**Consequences.** The brief's phase order R2 → R3 → R4 holds for acceptance, not for build order.

## ADR-102 — Editor layout: mode tabs and a tool row instead of the right tool sidebar (owner decision)

**Status:** accepted (2026-10-04). Source: product-owner decision in the session of 2026-10-04 (verbatim intent below); tool assignment
per mode: `docs/FEEDBACK.md` F14 (entered by the owner). Supersedes BRAND §15–§19 and REDESIGN_BRIEF R3 where they describe the right
tool sidebar, DESIGN v2 §3.2 "Tool sidebar" and the rail, ADR-100 item 1 ("Windows has no classic menu bar") and ADR-101 item (2) for
the tool sidebar package.

**Decision.** (1) No right tool sidebar and no rail; the column is removed from the editor grid. (2) Below the top bar a row of mode
tabs as text tabs: Lesen · Kommentieren · Ausfüllen & Signieren · Seiten · Bearbeiten (keys 1–5). Each mode shows one row of at most
eight tools with icon and label; the active tool has the Solar background (Ink label). (3) Properties are a contextual mini bar above
the selection, visible only while something is selected, never covering the selected element. (4) The left navigation stays (Seiten,
Gliederung, Kommentare, Suche), collapsible. (5) Mode "Seiten" replaces the document view with the page grid. (6) Export, Drucken,
Schützen and Dokumenteigenschaften stay in the File menu; the Windows in-window menu bar stays (restored); macOS keeps the native one.
(7) Order of work: designer spec (DESIGN v2 §3.2 rewritten), then the shell package, then a local installer build, then STOP —
R5 (motion) only after the owner's feedback.

**Consequences.** The wave 4 tool sidebar (`src/features/tools/`) is replaced, not polished; the wave 5 fix package drops its sidebar
items. The v1.2 command map (ARCHITECTURE §12) is redone for the menu bar. `ui.inspector`/`toolSidebarCollapsed` lose their meaning
and are removed with the shell package.

## ADR-103 — SemVer pre-releases (v1.2.0-beta.1 for the owner checkpoint)

**Status:** accepted (2026-10-04). Owner request: publish the checkpoint state as pre-release v1.2.0-beta.1 through the release
workflow so the macOS DMG is on GitHub; `.claude/state/STOP` stays set.

**Decision.** (1) `scripts/bump-version.sh` accepts `X.Y.Z-pre` (dot-separated alphanumeric identifiers), still no build metadata.
(2) `release.yml` marks every version with a pre-release suffix as a GitHub pre-release (as before for `0.*`), so it is never "Latest".
(3) The updater reads `/releases/latest/download/latest.json`, which GitHub never resolves to a pre-release, so a beta is never offered
as an update; installed betas update to the next stable release (1.2.0 > 1.2.0-beta.1 in SemVer). (4) CHANGELOG gets a
`[1.2.0-beta.1]` section; the final `[1.2.0]` section will repeat the full milestone notes.

**Consequences.** Checkpoint builds are reproducible from a tag; the v1.2.0 milestone tag is unaffected.

## ADR-104 — F15 beta feedback: order, acceptance method, follow-up milestones

**Status:** accepted (2026-10-04). Source: owner feedback F15 on v1.2.0-beta.1 (Windows and macOS).

**Context.** The owner tested the beta on both platforms, confirmed the mode layout (ADR-102), closed B-001 and listed ten bugs (A),
twelve shell refinements (B) and six follow-up milestones (C). Every item must be accepted in the installed build with the mouse; this
machine is Windows only.

**Decision.** (1) Order: A (bug patch) → B (shell polish) → designer acceptance of the mode layout → R5 → R6 → Politur v1.2 → R7 / v1.2.0.
A and B items live in `docs/FEEDBACK.md` F15 (the Stop hook reads it first); they are built as packages of four disjoint implementers
(ADR-030) with one reviewer each. (2) Acceptance: a local NSIS build (`npm run tauri build`) is installed and each item is driven with the
real OS cursor (`scripts/ui/mouse.ps1`), screenshots in `review/f15/` (not tracked). macOS-only behaviour (A9 keychain, A10 print) is
accepted through code paths that are shared with Windows plus a CI test on `macos-latest` (keychain round trip through the platform store
or its mock; the macOS print document rendered back with visible ink); the owner's "Save as PDF" in the Mac print dialog is the final
check on the next pre-release. (3) No version bump for the patch; the next tag stays v1.2.0 (a pre-release v1.2.0-beta.2 only on the
owner's request). (4) "Done" is removed (B1): F14's "File menu and Done" list now lives in the File menu only. (5) C becomes ROADMAP
milestones v1.3–v1.8, each starting with a designer spec (and an architect ADR where a new engine capability or crate is needed); the
loop does not pick them before v1.2.0 is tagged.

**Consequences.** R5 starts only after the B items and the mode-layout designer acceptance. B7 ships 8–10 fonts until the owner picks five.

## ADR-106 — F15 A5/A6/A7: comments width, images-to-PDF reads, Enter confirms

**A6 cause.** `HeldImage::reopen()` used `File::try_clone()`, whose duplicate shares the file offset with the original (Windows `DuplicateHandle`, Unix `dup`). The list (`declared_size`), up to four concurrent thumbnail decodes, a re-mounted thumbnail and the job all did `seek(0)` + read on handles of the same file, so one reader could move another's position: truncated or empty reads, decode errors, thumbnails that never load, pages missing (counted as `skipped`). **Fix.** Batch images are read with positional reads (`seek_read` on Windows, `read_at` on Unix) in `HeldImage::read_limited` / `declared_size`, which never use the shared offset; the job (`Inputs::read`) and the preview use it. `reopen()` is test-only now. Size and pixel caps are unchanged (20 MiB file, 8192 px side, 40 MP, stored 4096 px). Errors per image stay visible: the list marks an unreadable image and blocks Create until it is removed; the job reports skipped images in a toast.

**A6 addendum (real cause of "only partly").** After the positional reads, big images still rendered grey from some row on, but only in the installed app (engine child), not in-process. `RemoteFile::read` (engine child, 256 KiB cache blocks) returned at most the rest of the current block; pdfium-render's `FPDF_FILEACCESS` callback calls `read` once and reports the short count as success, so a PDFium read that straddled a block border left the rest of its buffer unread and a large JPEG stream decoded to its first bytes then flat grey (#808080). The encoder output and image dictionary were fine. **Fix.** `RemoteFile::read` fills the buffer across blocks (short only at end of file). Tests: `remote_file::one_read_across_a_block_border_is_not_short`; `tests/images_pdf_render.rs` builds 4000x3000, 3000x4000, 1200x800 and 4096x4096 JPEG pages, renders them with PDFium in-process and through the engine child, and asserts the last rows are the picture, not grey. JPEGs are still re-encoded (q90); pass-through was not needed.

**A5.** Card text wraps at spaces (`overflow-wrap: break-word`, not `anywhere`) with `hyphens: auto` for the UI language; only overlong tokens break. The 200 px sidebar is too narrow for a card (icon, type, menu, text), so while the Comments tab shows, the sidebar is at least `COMMENTS_PANEL_MIN` = 280 px (`panelWidthFor`, `src/lib/layout.ts`); the stored width is untouched, the other tabs keep it. `limits.rs` does not mirror panel widths.

**A7.** `isConfirmKey` (Enter, no Shift, no IME composition incl. keyCode 229) confirms: note body closes the popover (commits), note reply and comment compose/reply post, own-reply edits commit. Shift+Enter is a line break. Ctrl/Cmd+Enter keep working as Enter. The free-text box editor on the page keeps Enter as a newline (not in A7).

## ADR-107 — F15 A9/A10: library saves never fall back silently; print surface outlives `Webview::print()`

**A9 evidence (review round).** Ruled out with measurements on Windows: (a) the backend: save, drop everything, new `Keychain`/`Library` lists the entry, in-process and across two separate test processes against Credential Manager; typed art of all three fonts saves and lists; (b) the wire: the list JSON of saved typed art parses with `parseSignatureLibrary`; (c) key re-creation: the key is created only when none exists and is read back by a new instance. Cause established by code trace: the sheet reads the library status once on mount (`listSignatures`, the only status source on a fresh profile: the library dialog is not involved) and computed `willSave = save && status === 'ready'`; while that call has not answered (first keychain access that blocks: macOS asks the user, up to the 60 s deadline; a slow Credential Manager) a Create press skipped the save and handed out the unsaved draft, with the Save checkbox still ticked and no message. The same happened when the list call failed (`unavailable`). Test: `fresh profile: Create before the library status has answered ... still saves` (a pending `list_signatures`). For Windows I could not reproduce a persistent failure; if the owner's Windows build still loses entries, the next step is a log line of the keychain error kind in the installed build (not done: needs a log sink decision). The Sign menu and the Fill slots also read the list once per mount, so a new entry shows there after the next mount; not a persistence fault.

**A9 cause.** The key and file logic is correct with a real store: a Rust round trip against Windows Credential Manager (new `Keychain`/`Library` after a drop, see the `--ignored` tests) lists the saved entry. What lost signatures was the fallback: when the keychain failed for one call (`Unreadable`: access refused or a platform failure, as on an unsigned macOS build) or timed out (`Unavailable`), `Library::save` kept the entry in memory and answered success, so the sheet closed as if it had saved and the entry was gone at exit. The sheet also treated "status not known yet" as "do not save" and sent the draft without saving. **Fix.** `save` now fails with `invalid_argument` / `what: "keychain"` when no usable keychain exists (rename and delete still act on the session, which can no longer hold entries); the sheet saves unless the status is `locked` or `unavailable` and shows `error.invalid_argument.keychain` (en, de) in its alert line. Tests: `a_saved_signature_is_listed_after_a_simulated_restart` (mock), `a_missing_keychain_says_so_on_save_and_writes_nothing`, the sheet test for the message, and two `#[ignore]` real-store tests (`platform_store_round_trip`, `real_keychain_library_survives_a_restart`) that CI runs on `windows-latest` and `macos-latest` under unique service names they delete.

**A10 cause.** The surface already prints decoded `<img>` frames, not canvases. wry's macOS `print()` runs the print operation as a sheet with `setCanSpawnSeparateThread(true)` and returns at once, so `handOver` revoked the blob URLs and emptied the surface before WKWebView laid out and painted the page: blank sheets. **Fix.** After a dialog that opened, the frames stay (`afterprint` plus 30 s, at the latest 5 min, or the next print) before they are revoked; a dialog that failed to open clears at once. No new unsafe code, no CSP or capability change. **Test.** `print_set::a_frame_decodes_back_to_visible_content_not_a_blank_sheet` (runs on both CI OSes), the session tests for the lifetime. A real macOS print preview is not automated; the owner's "Save as PDF" on the next pre-release is the final check.

## ADR-108 — F15 block B design decisions (DESIGN §3.5, MOTION spells 19–22)

**Status:** accepted (2026-10-05). Source: designer spec for F15 B; owner pick for B7.

**Decision.** (1) B3: mode tabs are a segmented control inside one continuous Sand bar with the tool row (a yellow underline on Sand is
1.02:1 and fails the 3:1 rule); the active segment is White with a Stone border and Ink label, the active tool keeps Solar plus a 1 px Ink
hairline. The Sand bar overrides DESIGN §1.2/§2.8 for this bar only. (2) B9: comment margin column 240 px, 16 px from the page; fit
widths subtract 256 px while it is shown; below 360 px of free page width it collapses to 32 px avatar markers; bubbles stack 8 px apart;
leader line only on hover/focus. (3) B12 is a trial (its switch is localStorage `canvas.drift`, no UI: designer/dev only; clearance 40 px covers the page shadow reach of 38 px) and an explicit exception to BRAND §18, DESIGN §5 and MOTION rule 5; the designer
runs the legibility test of DESIGN §3.5 and records the verdict (keep / 0.04 / remove) here. **Verdict (designer, 2026-10-05):
remove.** Pairs `review/f15/design/b12-*`: at fit width and 100 % the gaps are too small for a shape (on = off, no gain); where a
shape shows (50 %, 1920 × 1080 left gap) it reads as a smudge with visible concentric banding and a straight cut at the clearance
mask, noticed at first look (test step 4 fails). Page edge, shadow and bubbles were unaffected and p95 stayed 16.8 ms, but 0.04
keeps the banding and the cut, so lowering does not fix it. Action: delete `src/features/canvasDrift/` and its mount, the
`--gap-shape-*` tokens and the drift keyframes in `tokens.css`, MOTION spell 19 and the B12 paragraph of DESIGN §3.5 (marked
removed); `canvas.drift` in localStorage is then ignored. BRAND §18 / DESIGN §5 / MOTION rule 5 apply again without exception. (4) B7: the owner picked three typed
signature fonts, in this order: **Ms Madi (default), Hurricane, Birthstone** (OFL-1.1, no Reserved Font Name, google/fonts `ofl/`);
Dancing Script, Great Vibes and Alex Brush are removed, the other seven candidates are not shipped. Existing saved typed signatures keep
their stored outlines (vector paths, ADR-051); a stored font id that no longer exists falls back to Ms Madi when re-typed.

**Consequences.** The B wave builds from DESIGN §3.5; B3 gets a before/after screenshot (`review/f15/b3-before.png` taken from the
installed beta).

## ADR-109 — Author prompt is a modal dialog; a save never waits for absent UI

**Status:** accepted (2026-10-05). **Bug.** v1.2 removed the toolbar slot of `AuthorPromptField`; nothing mounted it, so the first save of an annotated document with an empty author awaited an answer nobody could give (`saving` stayed true, later saves returned at once). **Decision.** (1) Slot: a modal dialog (shared `DialogShell` of the save dialogs, portal on `document.body`, app behind inert), mounted once in `features/shell/Shell.tsx` next to `UnsavedDialog`. No tool-row slot: the Sand bar has no free track without overlap (rule 8). ADR-034 behaviour is unchanged (once, OS name as suggestion, Use name / Skip / Esc / backdrop = skip). (2) The mounted prompt registers as host (`registerAuthorHost`); `askAuthorName` resolves as a skip when no host exists, and a host that unmounts releases a waiting save. `saveNow` resets `saving` in `finally` (already the case, now tested).

## ADR-105 — F15 A4/A8: move in every tool, upright placement, turned signatures

**A4 cause.** While a creation or placement tool was active its surface covered the page and took every press, so an existing annotation could not be reached (the hit areas of the annotation layer exist only for the Select tool), and the preview of a drag re-rendered the layer on every pointer event. **Fix.** (1) The creation layer and the placement layer hand a press to `useInteraction.onGrab` first (page-space point, geometric hit test `hitsAnnotation`: filled shapes inside, unfilled shapes and strokes within half of the 12 px hit slop of the outline, a turned signature by its turned box). A hit on a movable annotation (not locked, not opaque, not text markup) selects it and starts the same drag as in the Select tool; a click without movement only selects it. Text markup stays text-anchored and is never grabbed. The other tools (Hand, Text select, forms, crop, redact, pages) keep their own use of the pointer. (2) The move preview is no longer state per pointer event: the draft switches the moved annotations to their preview once, then every `pointermove` is coalesced to one `requestAnimationFrame` that sets a CSS offset (`translate` on the frame, `transform` on the SVG group `data-annot-item`); on release one `moveAnnotations` command is sent (one undo step) and the offset is removed in the layout effect of the final render. Resize and rotate drafts are rAF-coalesced too.

**A8.** Placement turns signatures, initials and marks against the effective display rotation (file `/Rotate` + view rotation): angle = −rotation, normalised to (−180, 180]. Text and Date (FreeText) keep the page orientation (FreeText cannot be turned). **Model.** `Signature` and `Mark` bodies get `angle` (degrees, clockwise on the page, y down; default 0, serde default so old drafts parse). `box` is the box before the turn, `rect` the bounds of the turned box (`rotated_bounds`). The angle is validated (finite, normalised to (−180, 180] and rounded to 0.01; not a number → `invalid_argument` `angle`). `AnnotationPatch.angle` turns an existing one; `moveAnnotations` keeps it. **File.** The appearance form keeps `/BBox` = the box before the turn and gets `/Matrix` = the turn about its centre; `/Rect` = the turned bounds, so any reader fits the form onto the rect without scaling. A signature whose art is in the file (reloaded) gets its own stream copied with a new `/Matrix` when its angle changes (the art is never regenerated). **Reload.** PDFium exposes no custom annotation key and our `/NM` is the annotation's identity, so the turn rides in the name: `<sheer-name>-r<centi-degrees 1..35999>-<w×100>-<h×100>` (`signatures::marks::split_turn`); the importer rebuilds `box` and `angle` from it only if the turned bounds match `/Rect` within 1 pt (another program moved it: unturned bounds = `/Rect`). The name is rewritten on save, the page's slot is found through the previous name. **UI.** The only selected signature or mark shows a rotate handle (knob 18 pt above the top edge, hairline stem, `cursor: grab`): free angle, Shift snaps to 15°, one `updateAnnotation` on release; Alt+Shift+Left/Right turns by 15° from the keyboard. A turned one shows only the rotate handle (no corner resize: turn it back first); its frame is the unturned box rotated by CSS.

**Consequences.** No new command or dependency. The preview of a reloaded (file art) signature that is turned or moved shows the frame only; the page bitmap shows the new look after the next render.

## ADR-111 — One Euro filter for drawn signatures (F15 B6)

**Status:** accepted (2026-10-05). Extends ADR-051.

**Decision.** `inkOutline` runs the pointer samples through a One Euro filter (Casiez et al. 2012) before the Catmull-Rom/offset pipeline; the live preview and the saved art call the same function, so they stay identical (vector Béziers, no rasterising, guide line not in the path). Mouse (neutral pressure 0.5): `minCutoff` 1.2 Hz, `beta` 0.012, `dCutoff` 1 Hz. Pen or touch (any other pressure): `minCutoff` 2.4 Hz, `beta` 0.025. Lag at 1000 px/s is about 10 px; the first sample is exact. Width: 0.45 to 1.5 times nominal by speed (fast thinner) and pressure, and never under 1.4 px (`MIN_STROKE_PX`). Values were tuned by test (jitter RMS under 0.6 of raw, lag under 40 px at 2000 px/s), to be re-tuned by hand feel.

## ADR-112 — Comment margin and comments filter (F15 B9, B10)

**Status:** accepted (2026-10-05). Implements DESIGN §3.5 B9/B10 and ADR-108 (2).

**Decision.** (1) The margin slot is taken in `Canvas`: the viewport it reports is the region's content width minus 256 px (16 gap + 240), or minus 48 px (16 + 32) when `width - 256 < 360`; the content div is as much wider. So the layout, every fit and the scroll maths see the width the pages have, and fit width/page subtract the slot with no change to `fitZoomFor`. Pages and the column are centred as one unit; the column's left is the widest page's right edge + 16. (2) Bubbles come from the comments store (threads with text or replies, no text box, no opaque); the margin reads the list itself (`useCommentsData`, shared debounce with the panel) and the geometry from the annotation replica (pages with bubbles are loaded). Placement is pure (`placeBubbles`), the selected or focused bubble is pinned, only bubbles within one viewport of the view are mounted, heights are measured (estimate 120). (3) Hover is shared (`useCommentHover`) between cards and bubbles; selection already is (annotation selection). (4) Filter types fold kinds: highlight, note (note, text box, marks), drawing (ink), shape (rect, ellipse, line), signature, quote (a text markup with text). `Filter.groups`/`pages` are optional so stored filters stay valid. Sort: page, date newest first, author A-Z (no author last); stored in `localStorage` `comments.sort`. (5) A card's first line is the comment text, else the quote, else the type; the type stays as screen-reader text. A text longer than two lines also shows whole below.

**Open.** View → "Comments in margin" has its store (`useMarginPrefs`, `margin.comments`) but no menu entry yet (menu.json/registry are outside this package). The anchor outline pair on hover is not drawn (annotations package); the leader line is.

## ADR-113 — Derived outline for documents without bookmarks (F15 B8)

**Status:** accepted (2026-10-05). Implements DESIGN §3.5 B8.

**Decision.** (1) `get_outline` is unchanged in name and arguments: when the file has no bookmarks the engine derives a tree from the text (`engine::derived_outline`, run inside `read_outline`, so only when the Outline tab asks) and marks every node `derived: true`; real bookmarks always win. (2) Heuristic: body size = the size most characters have (half-point buckets); sizes at least 1 pt larger are heading levels from the largest, at most 3; a short line (≤ 80 characters) that is bold as a whole at body size and does not end in punctuation is the lowest level (off when more than half the text is bold). Weight comes from PDFium (weight, FORCE_BOLD flag, "bold/black/heavy" in the font name). Lines of one heading run (same class, same page, within 1.6 lines) merge. Running headers and footers (same text, digits aside, same 4 pt height, on ≥ 3 pages) and page numbers (digits, valid Roman numerals, "Page n of m") are skipped. (3) Bounds: see SECURITY P15; what is not reached in time is left out. (4) The job cannot be cancelled in the worker; the frontend ignores the answer once the document is closed (store token) and caches per document. (5) A derived node's target is the line's top (points from the page top).

**Consequence.** The wire node gained `derived`; the parser defaults a missing key to false.

## ADR-110 — F15 B4/B5: text comment properties and the colour popover

**Model.** `FreeText` gets `align` (`left|center|right`, serde default left) and `borderColor` (`Option<Rgb>`, `None` = the text colour); `AnnotationPatch` gets `borderColor` (`align`, `fill`, `borderWidth` existed). Border on/off is `borderWidth` > 0; fill on/off is `fill` set/null (opaque).
**File.** `/Q` 0/1/2; `/DA` = `/Helv <size> Tf r g b rg r g b RG` (text colour, then border colour); `/BS /W` the border width; `/C` the fill (the spec's background colour for FreeText; `/IC` is not defined for FreeText); the appearance draws the fill, an inset border, and each line placed by Helvetica AFM widths (same table in `pdfwrite/appearance.rs` and `freeTextLayout.ts`), padding 4 pt, first baseline 0.86 × size.
**Read back.** PDFium has no accessor for `/DA`, `/Q`, `/BS`, so `engine/import.rs` reads them from the appearance objects (size and colour of the text objects, the stroked path for the border, line positions against the box for the alignment). Third-party files with an appearance read the same way.
**Wrap.** The frontend wraps (TS Helvetica table) and stores the wrapped lines plus the grown box in one patch; the backend draws lines as given.
**Storage.** Recent colours: one list, max 8, `localStorage` key `sheer.tools.recentColors` (the app's UI storage; ARCHITECTURE has no settings key for it). Last-used text defaults: `tools` store `defaults.freeText` (`align, border, borderWidth, borderColor, fillOn, fillColor`). A custom last-used colour survives a restart while it is in the recent list.
**Not done.** The tool row's split-menu swatch rows keep the old palette (B5 there is open).

## ADR-114 — Arrow, shape recognition, line read-back (F15 B11)

- **Arrow** is a PDF Line with `/LE [/None /OpenArrow]` (head at `to`), head 3 x width + 6 pt long, 30 degrees; "Both" writes the head at both ends. Rust appearance, TS preview and layer share the geometry.
- **Read-back:** PDFium has no accessor for `/L` and `/LE`, so `pdfwrite/lines.rs` reads them with lopdf after the engine import (as `reviews` does) and `commands::annotations::lift_lines` turns the opaque Line into an editable `AnnotationBody::Line`. No new IPC.
- **Recognition** (`create/recognise.ts`): resample to 64 points; closed when the ends are within 20 % of the path. Closed: axis-aligned rectangle (tilt search up to 10 degrees, all four corners touched) or ellipse/circle, rms error at most 4 % of the box diagonal, the better must be at most 70 % of the other's error, at least 0.85 turns. Open: line (max deviation 7 % of chord, chord at least 88 % of path) or arrow (straight shaft plus a hook reaching 8 to 35 % of the shaft). Otherwise nothing: it stays ink.
- **Undo:** release creates the ink stroke, then one batch swaps it for the shape, so one undo returns the stroke.
- **Setting:** `tools.shapeRecognition` in UI storage (`sheer.tools.shapeRecognition`), default on; Settings > Drawing and the Zeichnen split menu.
- `Popover`: a popover rendered inside another no longer closes it (colour popover in split menus).

## ADR-115 — Engine child replies must decode every annotation kind (F15 acceptance blocker)

- **Cause:** not a PDFium or engine panic. `SignatureArtRef::File` and `AnnotationBody::Opaque` were `#[serde(skip_deserializing)]` ("only an import makes one"). The child serialised them in its `Annotations` reply, the parent could not deserialise the reply (`malformed header`), treated the child as failed and restarted it. In-process tests never hit this. Any page with a reopened stamp of ours (art "in the file") or a kind the model leaves opaque restarted the engine; the restart reopened the document and the pages then rendered only partly.
- **Fix:** both variants deserialize now. The UI boundary already refuses them (`Annotation::from_draft`: `kind` / `art` invalid). The parent logs the class and column of an undecodable reply (never the serde message, which can quote document text); a panic in the child was and is logged with its reason by `guard::guarded`.
- **Tests:** `tests/engine_child_annotations.rs` (create FreeText, Text, turned stamp, save, close, reopen through the child: no restart, three pages render, angle kept); `annots-turned-stamp-and-opaque-kinds.pdf` in the hostile corpus, whose exercise now lists annotations.

## ADR-116 — Old ⋯ menu and moved entries → their v1.2 place (R3 acceptance)

**Status:** accepted (2026-10-05). Closes the R3 item "old ⋯-menu → new place table". v1.1.0 shipped no ⋯ menu: ADR-058 (2) had
already moved it into the File/Edit/View/Tools/Help bar. So "old ⋯" = the v1.0 More menu (ADR-016, -029, -042, -048, -050) plus the
wave-4 top-bar Export/More (it held the File commands while Windows had no menu row, ADR-100 (1)). Also listed: v1.1 toolbar, hub,
status bar and inspector entries that moved. Built from those ADRs and CHANGELOG [1.0.0]–[1.1.0], not from `git show v1.1.0`. Targets:
`src/actions/menu.json`, `src/features/modes/useSlots.tsx`, `src/features/home/ToolRows.tsx`, DESIGN v2 §3.2, FEEDBACK F14.

| Item | Was | v1.2 place |
|---|---|---|
| Open | More; v1.1 File, hub card | Datei; Home "+" and hero; empty state "Oder öffnen"; Primary+O |
| Save | More; v1.1 File; wave-4 Fertig | Datei; save status next to the file name (B1); Primary+S |
| Save As | More; v1.1 File | Datei; double-click the file name |
| Export a copy | More; v1.1 File; wave-4 top-bar Export | Datei |
| Export as images | More; v1.1 File; wave-4 Export | Datei; Primary+Shift+E; Home tool row |
| Create PDF from images | More; v1.1 File, hub card | Datei; Home tool row |
| Print | More; v1.1 File | Datei; Primary+P |
| Flatten form | More, Form tool options; v1.1 File | Datei |
| Protect | More; v1.1 File | Datei; Bearbeiten mode "Schützen" |
| Document properties | More; v1.1 File | Datei; Bearbeiten mode "Metadaten" |
| Compress | v1.1 File, hub card | Datei; Seiten mode; Home tool row |
| Settings | More; v1.1 File (Win) / app menu (mac) | Datei (Windows), app menu (macOS), Home nav "Einstellungen" |
| About | More; v1.1 Help | Hilfe (Windows), app menu (macOS) |
| Scroll modes (3) | More; v1.1 View | Ansicht |
| Undo / Redo | toolbar, overflowing into More; v1.1 Edit | top bar; Bearbeiten menu |
| Pages / Organize (P) | toolbar, first into More; v1.1 Tools | Seiten mode "Ordnen"; key P |
| Merge, Split | v1.1 Tools, hub cards | Seiten mode; Home tool row |
| Extract pages | v1.1 Tools | Seiten mode "Extrahieren" |
| Insert text, Add image, Crop (E, I, K) | toolbar Edit cluster, collapsing into More | Bearbeiten mode; keys unchanged |
| Redact (X) | More; v1.1 toolbar, hub card | Bearbeiten mode "Schwärzen"; Home tool row (lands in mode 5) |
| Select (V) | v1.1 toolbar | Lesen "Auswahl"; Esc in every mode |
| Highlight (H, variants) | v1.1 toolbar | Kommentieren: Hervorheben · Unterstreichen · Durchstreichen |
| Comment (C/N: note, text) | v1.1 toolbar | Kommentieren: Notiz · Textkommentar |
| Draw (D), Shapes (R) | v1.1 toolbar | Kommentieren: Zeichnen · Formen [Rechteck/Ellipse/Linie/Pfeil] |
| Fill & Sign (S; marks, text, date) | v1.1 toolbar, hub cards Sign / Fill form | Ausfüllen & Signieren mode; Home tool row (lands in mode 3) |
| Form tool (F) | v1.0 toolbar / More | removed in v1.1 (fields always live, banner); action kept for the hub |
| Highlight form fields | Form tool options; v1.1 Tools | Werkzeuge menu |
| Manage signatures | v1.1 Tools | Werkzeuge menu; Signatur/Initialen chevron "Neue …" |
| Tool items in the Tools menu | v1.1 Tools | removed from menus (tool row + letters); Werkzeuge lists the five modes |
| Zoom | v1.1 status bar | top-bar zoom dropdown; Ansicht |
| Page indicator | v1.1 status bar | top-bar page field; Ansicht "Go to page" |
| Left panel toggle | v1.1 handle | top-bar button, sidebar grip (B2), Ansicht |
| Inspector toggle / View "Eigenschaften" | v1.1 handle, View | removed: properties mini bar on selection (ADR-102 (3)) |
| Find | v1.1 Edit, sidebar | top-bar Search; Lesen "Suche"; sidebar tab; Bearbeiten menu |
| Rotate view | v1.1 View | Ansicht; Lesen "Drehen" |
| Wave-4 More ⋯ | top bar | removed; contents in Datei/Ansicht (DESIGN §3.4 item 3) |
| Wave-4 Fertig | top bar | removed (ADR-104 (4)); save status + Datei |

**Gaps.** None without a place. ARCHITECTURE §12 says Highlight form fields and Manage signatures are also in the Ausfüllen & Signieren
tool row. That is wrong: they are in the Werkzeuge menu only (Politur v1.2).

## ADR-117 — Fill & Sign on the welcome document; the annotation smoke is repeatable (F15 acceptance)

**Finding.** `scripts/ui/annot-smoke.mjs` failed rows (check mark, date, later signature) on the welcome document and, in a second run, on text.pdf. Cause: a press on an existing movable annotation moves it instead of placing a new one (ADR-105, `onGrab` first); the open documents keep the annotations of the previous run, so the click spots were occupied and the count did not grow. The product behaves as designed; the test was not repeatable. **Fix.** The smoke deletes the document's annotations before each suite. **Decision.** Fill & Sign tools (Text, marks, Date, Signature, Initials) are enabled on the welcome document (the tour document; v1.8 R6 "first signature"); Save becomes Save As as before. Pages tools stay read-only there (`modes.readOnly`). Open: the tour's "first form" needs form fields enabled on the welcome document (`FormLayer` `documentReadOnly`); decide with R6.

## ADR-118 — Politur v1.3 package P13-1 (backend, scripts, docs)

1. **`tauri.conf.json` `backgroundColor` is `#FAFAF8` = `--color-canvas` (light).** It is the colour of the native window before the webview paints, so start-up shows the app canvas and not a white flash. It is the one place a token value is spelled as hex outside `tokens.css` (the config cannot read CSS); change both together.
2. **Welcome PDF stays on Helvetica (no Inter embed).** `PdfBuilder` writes the standard-14 fonts; embedding Inter needs a TrueType subset (`FontFile2`), a width table and a different "does it fit" model (`EM`, `wrap`), for a cosmetic gain on a sample document. Not done; revisit only with a font-subsetting dependency.
3. **No Open Recent in the macOS menu bar.** It needs a dynamic submenu that is rebuilt on every recents change and item ids that map to recents without a path crossing to the webview; that is a new IPC surface for little gain (Home shows recents). Windows keeps its in-window submenu.
4. **English menu labels stay in Title Case** (`menu.*` keys of en.json), as macOS menus are written and `menu.test.ts` checks; a sentence-case pass was reverted at integration. German is unchanged.
5. **`redact.pending` is a plural group** (`.one` / `.other`, `{count}`) in en and de.
6. **`assets/brand/logo.svg` is deleted;** `gen-installer-art.mjs` already reads `wordmark-secondary.svg`. ADR-000 item 7 now names the current brand sources.

## ADR-119 — Citations (milestone v1.3): citation annotations, bibliographic record, styles, tags

**Status:** accepted (2026-10-05). Scope: ROADMAP v1.3.1 to v1.3.4 (FEEDBACK F15 C). Signatures: ARCHITECTURE §5 "Citations (v1.3, ADR-119)".

**Context.** A citation must be a real Highlight that other viewers show, carry a quote and page that survive without re-extraction, and travel with the file together with the user's tags. Per-document bibliographic data must be read from hostile Info/XMP/page text and stay editable. PDFium exposes no custom annotation key (ADR-105), but the codebase already reads keys PDFium cannot see with lopdf after the engine read (`pdfwrite::reviews`, `read_page_file`). The XML crate `quick-xml` 0.42 (MIT) is already in Cargo.lock (via `plist`). `PageSlotInfo.label` exists but is always `null`; `/PageLabels` is read nowhere except redaction scrubbing.

**Options and decisions.**

1. **Citation marker.** (a) `/NM` suffix like ADR-105: rejected, `/NM` is identity, other tools rewrite it, and it already carries the turn. (b) `/Subj (Citation)`: rejected, other viewers show and edit it, it collides with users' subjects, and it is not language-neutral. (c) **Chosen: a private dict key `/SHR_Cite << /V 1 /Q (quote) /G (group) >>`** on a `/Subtype /Highlight` with `/QuadPoints`. `SHR_` follows the second-class name form (Annex E; the prefix is not registered, accepted). Other viewers ignore it and show the highlight and the `/Contents` popup. `/Contents` stays the user's comment only; the quote never goes into it. Read with lopdf by the new `pdfwrite::sheer_keys::read_page` (same pattern, positions and caps as `reviews::read_page`). It counts as a citation only if the subtype is Highlight and `/V` is 1; any other shape reads as a plain highlight. Writer rule: `annots.rs` writes `/SHR_Cite` and `/SHR_Tags` from the model. On a page whose keys could not be read (an encrypted file the lopdf pass cannot open), it keeps the existing `SHR_*` keys and never drops them.
2. **Page number.** The new engine job `Job::PageLabels` uses `PdfPage::label()` (pdfium-render → `FPDF_GetPageLabel`; PDFium bounds the number-tree depth). It runs lazily on the first citation-related call, not at open, so opening a 500+ page document costs nothing. Bounds: ≤ 50 000 pages, label ≤ 64 chars through the display-name filter, 2 s budget. If the budget runs out, every label is `None`, so labels are never mixed with indices. Labels are cached in `DocState.page_labels` by file page index. A slot from a file page uses its label; any other slot (blank, imported, redacted) or `None` uses position + 1. The locator is resolved when `list_citations` is called, so reordering pages is reflected. `PageSlotInfo.label` stays `null` in v1.3.
3. **Quote.** `quote_of` moves to `model/quote.rs` with a cap parameter: 280 for `get_annotation_quote`, **2 000 chars** (`CITE_QUOTE_MAX`) for citations. It is extracted in Rust when the citation is created (`create_citations`, engine text layer), stored in `/SHR_Cite /Q`, and editable through `AnnotationPatch.quote` (1..=2 000, controls stripped) for ligature or hyphenation clean-up. `get_annotation_quote` returns the stored quote for a citation, cut to 280. A selection across pages becomes one citation per page in one `Batch` (`citation.create`), sharing a Rust-made group id (`/G`, 8 hex chars). The export joins a group into one locator (`12–13`).
4. **Bibliographic record.** `BibRecord { kind: book|article|chapter|report|webPage|thesis, authors: [{family, given}] ≤ 32, title, year (≤ 16 chars: "2020a", "n.d."), containerTitle, volume, issue, pages, edition, publisher, place, doi, url, accessed (YYYY-MM-DD) }`. Strings are ≤ 1 000 chars (DOI ≤ 256, URL ≤ 2 048). Read order per field: user record > XMP > Info > first-page heuristic, and the UI sees the source of each field. **Persistence: hybrid in the file, no sidecar.** A sidecar keyed by `/ID` or a content hash breaks on every save (a new `/ID` or hash), does not travel with the file and leaves data in app storage. The full user record is written as a private key **`/SHR_Bib` in a new incremental `/Info`** (Info allows extra keys; this is the same append path as `metadata::write`). `/Title` and `/Author` are left to the Properties dialog (`SetMetadata`), so the two never fight. XMP is never written for this (the existing XMP writer regenerates the whole packet, which is too lossy to widen). A pending `RemoveMetadata`/strip drops the record: it is not written, and the UI warns.
5. **XMP read.** `quick-xml` 0.42 becomes a direct dependency, pinned to the version already in the lock (no new crate, but a `docs/LICENSES.md` line). It is a pull parser: no entity expansion beyond the five predefined, no external fetch. In addition, a `DocType` event aborts the read, the packet is ≤ 4 MiB (existing cap), depth ≤ 32, ≤ 200 000 events, each value ≤ 1 000 chars, and the whole read stays inside the 30 s metadata read. Fields: `dc:title` (x-default), `dc:creator` Seq, `dc:date`, `dc:publisher`, `prism:doi`/`dc:identifier` (doi:), `prism:publicationName`, `prism:volume`, `prism:number`, `prism:startingPage`/`endingPage`, `prism:url`. Info `/Author` is split into persons in Rust (`;`, " and ", "Family, Given").
6. **Heuristic.** The engine job `Job::FirstPageHints` looks at page 1 only, ≤ 20 000 chars, 1 s budget, and runs only if the title, authors or year is still empty. Title = the largest-size line run (the `derived_outline` size classes), ≤ 300 chars. Year = the first 1900..=2100 four-digit number near "©"/"(c)"/a month name, else none. DOI = `10.\d{4,9}/\S+` cut at trailing punctuation. No network, no DOI lookup.
7. **Styles: TS, not Rust.** Formatting is not PDF work: `src/features/citations/format/` is pure TS with golden tests. APA 7, MLA 9, **Chicago 17 author-date** (same data shape as APA: reference entry plus "(Family Year, page)", one renderer path. Notes-bibliography needs full and short note forms and is a later option), DIN ISO 690:2013 in author-year form. Terms ("p."/"S.", "ed."/"Hrsg.", "accessed"/"abgerufen am") come from the UI language. Formatters return `StyledBlock[]` (runs with `italic`); `render.ts` makes text/plain and escaped text/html for the clipboard (`navigator.clipboard.write` with `ClipboardItem`, falling back to `writeText`; no plugin, no capability).
8. **File export.** `save_citation_list` takes the `StyledBlock[]`, never markup. Rust writes **.txt, .html, .md** with its own escaping (`export/citations.rs`) after a Rust save dialog, atomically. **.ris and .bib** are cheap: Rust writes them from the stored `BibRecord` (the reference only, no style, no frontend text). The frontend never sees a path.
9. **Tags.** Definitions are global and live in `settings.json` (`Settings.tags`, Rust-validated, atomic writes; localStorage would be lost on a webview reset). `TagDef { name 1..=40 chars, display-name filter, unique case-insensitively; color ∈ model::tags::TAG_PALETTE }`, ≤ 64 tags. A test asserts that `TAG_PALETTE` equals the TS annotation palette. Assignment travels in the file as **`/SHR_Tags [(name) …]`** on any non-opaque annotation that is not a review reply, ≤ 8 per annotation. Names, not ids, so another installation shows them. A name with no local definition shows neutral and can be adopted. Renaming a definition does not rewrite files. `AnnotationSummary` gains `tags` and `cite`. The comments filter (ADR-112) gains the group `citation` and an optional `tags`.
10. **Undo.** Every change goes through `apply_command` and the history. `create_citations` applies one `Batch` (`citation.create`). Tags and quote are `UpdateAnnotation` patches (coalesce key `tags`). `SetBibliography { record }` is a document command (label `bibliography.set`, its inverse is the old record) and `ChangeSet.doc` gains `bibliography`.

**Consequences.**
- No new crate. `quick-xml` becomes direct (LICENSES.md line). New limits in `limits.rs`: `CITE_QUOTE_MAX` 2 000, `CITE_DRAFTS_MAX` 64, `CITATIONS_MAX` 20 000, `TAGS_MAX` 64, `TAG_NAME_MAX` 40, `TAGS_PER_ANNOT` 8, `BIB_*` as above, `PAGE_LABEL_MAX` 64, `CITATION_EXPORT_MAX` 4 MiB / 20 000 blocks.
- Other viewers keep `SHR_*` keys while they leave an annotation unchanged; one that rewrites the annotation may drop them, and it then reads back as a plain highlight (accepted, documented in the user docs).
- A save writes `/SHR_Bib` with the plan's `/Info` (incremental; Full only where it already is).
- SECURITY.md rows (security-reviewer checks before the tag): I10 `create_citations`, I11 `list_citations`, I12 `get_bibliography`, I13 `apply_command` `setBibliography` + `AnnotationPatch.{tags,quote}`, I14 `save_citation_list` (dialog in Rust, typed blocks, Rust escaping, size caps, no path out), I15 `update_settings` `tags`; P17 XMP parsing (§5 bounds, DocType refused), P18 page labels (§2 bounds), P19 first-page heuristic (§6 bounds), P20 `sheer_keys` read (caps, typed shape, hostile strings filtered, the URL in a record is never opened).

**Work packages** (ADR-030/038; disjoint files, W0 first).
- **W0 seams (one backend-implementer, sequential):** `limits.rs` consts; wire types with serde defaults (`Annotation.cite/tags`, patch fields, `DocCommand::SetBibliography`, `Job::{PageLabels, FirstPageHints}`, `DocState.{page_labels, bibliography}`, `SavePlan.bibliography`); the four new commands as `not_yet` stubs registered in `lib.rs`, `build.rs` and capabilities; `src/types` and the `src/api/citations.ts` parsers; and the `citation.*`/`tag.*` keys in en/de from the DESIGN spec.
- **Backend wave (parallel):** **C1 annotation keys**: `model/{annotation,quote,tags}.rs`, `pdfwrite/{annots,sheer_keys}.rs`, `commands/annotations.rs`, `commands/citations.rs` (`create_citations`, `list_citations`), `tests/citations_roundtrip.rs`. **C2 bibliography**: `model/{bibliography,command,doc_state}.rs`, `pdfwrite/{bibliography,mod}.rs` (`apply_extras`), `commands/{bibliography,save}.rs`, `Cargo.toml`, `docs/LICENSES.md`, `tests/bibliography.rs` (hostile XMP corpus). **C3 engine jobs**: `engine/{page_labels,first_page,worker,wire,mod}.rs`, `tests/page_labels.rs`. **C4 export and tags storage**: `export/citations.rs`, `commands/citation_export.rs`, `storage/settings.rs`, `commands/app.rs`, tests.
- **Frontend wave (≤ 4, parallel):** **F1 formatter**: `src/features/citations/format/**` + golden tests (4 styles × 6 kinds, en/de terms, joined locators, HTML escaping). **F2 cite flow**: `features/textlayer/SelectionBar.tsx` (Cite), `features/citations/{store.ts,CitationInspector.tsx}`, the citation marker in the annotation layer. **F3 bibliography and export**: `features/citations/{BibliographyForm,CitationsPanel,ExportMenu}.tsx`, clipboard. **F4 tags**: `features/settings/tags/**`, `components/TagPicker`, `features/comments/{filter*,CommentCard}.tsx`.

**Addendum (backend wave C1–C4, 2026-10-05).** Deviations accepted from the package reports:
- C1: `AnnotationDraft` gains `tags` (from the UI) and `cite` (`skip_deserializing`, set by Rust only). File keys are read in `commands/annotations.rs` (`import_read`, PDFium never reports custom keys) with `FORM_READ_TIMEOUT`; on a timeout the page is not imported and the call returns `engine_timeout`, so the next list retries and a page the writer could not read keeps its keys. Encrypted documents: keys are not read, and a rewritten annotation loses them (known limitation). Page labels are cached once per document.
- C2: `/SHR_Bib` is a second incremental update after the metadata one (a lower layer never blanks a user field); the wrapper sits in `pdfwrite/mod.rs` around `save::apply_extras` (the snapshot path keeps the old one, so exports and snapshots carry no `/SHR_Bib`). XMP is read only when unfiltered or single-Flate (bounded inflate). DOI must be bare `10.x/y`, URL `http(s)://`. `SetBibliography` needs a prior `get_bibliography` (as metadata).
- C3: no authors rule on page 1 (the hints type has none). Above `PAGE_LABELS_PAGES_MAX` the labels reply is empty (callers fall back to position+1).
- C4: `.ris`/`.bib` default name `<stem> - reference.<ext>`; an empty list is `invalid_argument` (`blocks`) before the dialog; cancel returns `false`.

**Addendum 2 (frontend wave F1–F4 and integration, 2026-10-05).**
- F1: a format chevron sits next to "Save list…" (the backend needs the format before its dialog); "Try again" reuses `comments.retry`. `doi.org` is allowed by name in the bundle URL guard (`scripts/check.sh`, SECURITY T2): the DOI resolver is printed text in a reference, never fetched, and the CSP allows no remote host. Formatter test data lives in `*.test.data.ts`, which the hardcoded-strings scan skips like tests.
- F2: the Tags button of the mini bar is 28 (`sm`) because mini bar controls are 32; tool id `cite` (key Q), actions `cite-selection` (Primary+Shift+C), `copy-citation-list`, `save-citation-list`.
- F3: Apply writes metadata and the record as two undo steps (the backend refuses `setMetadata` and `setBibliography` in one batch). Restore works for fields whose loaded source is XMP, Info or page 1; a field already stored as edited has no file value to restore.
- F4: the Tags filter is OR within the group and AND with the other groups; renaming or deleting a tag updates every open document except the welcome sample (one undo step per document); the delete toast's Undo restores the definition and the removed assignments in documents still open. Tag names are 1–40 chars (DESIGN aligned).
- Integration: a citation card's quote takes its document colour through `[data-cite-fill]` + `--cite-fill` (RGB channels set per element) at `--hl-opacity`; new tokens `--chip-height` 20, `--tag-dot` 8, `--preview-min-height` 64, `--tag-picker-width` 240.

## ADR-120 — CI first: read main's CI at every loop start; green CI is part of every package's DoD

**Status:** accepted (2026-10-05, owner instruction). Supersedes the CI part of ADR-030 ("read CI once per milestone").

**Context.** CI on `main` was red for five runs in a row (#61–#65) without anyone noticing, because CI was read only at a milestone end. One cause, macOS only: `commands::recent_actions::tests::starring_by_id_and_revealing_only_what_exists` (strengthened in Politur v1.3, 446a6d9) recorded `\host\share\x.pdf`, which is a relative path on Unix; `storage::recents::storable` never records a relative path, so the "not vacuous" assertion found no entry. Windows (where the spelling is a UNC path that is refused before storing) stayed green. The owner also saw docs commits (`docs(decisions): ADR-119 addendum…`) start CI and suspected that `paths-ignore` no longer works. It does: `paths-ignore` (`**/*.md`, `docs/**`) is evaluated over the whole push (old head..new head), and each of those runs came from a push that also carried code (34, 43, 30, 107 and 1 non-doc files); the run only shows the title of the push's last commit. A docs-only push (893ce34) started no run.

**Decision.**
1. At the start of every loop the orchestrator runs `bash scripts/ci-status.sh`: it reads the last *completed* run of the CI workflow on `main` and never waits for a running one (exit 0 green, 1 red with the failed jobs and steps, 2 unknown).
2. Red = fix first: `gh run view <id> --log-failed`, find the cause per platform, fix, push. No new package starts while the last completed run is red.
3. Green CI is part of the Definition of Done of every package, not only of a milestone. The package's own push is checked at the next loop start (rule 1), so nobody waits on a running run.
4. The test fix: on non-Windows the network spelling is recorded as an absolute (missing) path under the test's temp directory, built as text because `Path::join` would read the leading backslashes as a separator on Windows (clippy).
5. `paths-ignore` stays as it is. To keep docs-only commits cheap, push them on their own when convenient; a mixed push runs CI, which is correct.

**Consequences.** One `gh` call per loop (a few seconds, no waiting). ORCHESTRATOR_PROMPT §2 rule 12, §8.4 step 0 and step 7, §9 "CI-Status", and CLAUDE.md rule 12 carry the rule. When `gh` is offline the loop notes it in STATE.md and continues.

## ADR-121 — Certificate signatures (milestone v1.4): PAdES B-B, signing identities, validation, signed-document lock

**Status:** accepted (2026-10-05). Scope: ROADMAP v1.4.1 to v1.4.3. Signatures: ARCHITECTURE §5 "Certificate signatures (v1.4, ADR-121)". UI: DESIGN §3.8 (designer, in parallel).

**Context.** Visual signatures (ADR-041/105) are `/Stamp` annotations and carry no cryptography. `DocFlags.signed` comes from PDFium (best effort, only for documents with a form). Today a signed document plus a page change asks `breaksSignature`. Saves append a revision through lopdf `IncrementalDocument`; Full saves are used only for clean copies, encryption and redaction. `storage/keychain.rs` keeps one 32-byte key in the OS store (keyring-core). Windows Credential Manager caps a credential blob at 2 560 bytes. `Cargo.lock` already has lopdf's RustCrypto generation: `sha2` 0.11.0, `digest` 0.11.3, `const-oid` 0.10.2, `cipher` 0.5, `aes` 0.9, `cbc` 0.2, `rand` 0.10, `hmac` 0.12, `pbkdf2` 0.12, `time` 0.3, `jiff` 0.2, `zeroize`. It has no ASN.1, X.509, CMS or public-key crate (`openssl` is in the lock for Linux only, through the updater). State on crates.io (2026-10): `der` 0.8, `spki` 0.8, `pkcs8` 0.11, `x509-cert` 0.3, `p256`/`p384` 0.14 are stable. `cms` exists only as 0.3.0-pre.2; 0.2.3 belongs to the 2024 `der` 0.7 generation. `rsa` is 0.10.0-rc.18, with 0.9.10 as the latest stable. Every `rsa` version carries RUSTSEC-2023-0071 (Marvin timing side channel, no fix). `p12-keystore` 0.3.2 (MIT OR Apache-2.0) builds on `cms` 0.3-pre, `pkcs12` 0.2-pre, `pkcs5` 0.8 and `x509-parser` 0.18. `rcgen` needs `ring` or `aws-lc-rs` (C/asm) for its keys.

**Options and decisions.**

1. **Format: PAdES B-B, incremental only.**
   - *Options.* (a) `adbe.pkcs7.sha1`: deprecated, rejected. (b) `adbe.pkcs7.detached`: legacy, not PAdES, rejected. (c) **Chosen: `/SubFilter /ETSI.CAdES.detached`**, `/Filter /Adobe.PPKLite`.
   - *CMS.* SignedData v1, detached `id-data`, exactly one SignerInfo (`issuerAndSerialNumber`). Signed attributes are exactly content-type, message-digest (SHA-256) and signing-certificate-v2 (`ESSCertIDv2`, SHA-256 of the signer certificate). There is no signing-time attribute: EN 319 142-1 forbids it for PAdES, and the claimed time is `/M`. No unsigned attributes (no TSA, offline). Algorithms: `ecdsa-with-SHA256` for P-256, `ecdsa-with-SHA384` for P-384, `sha256WithRSAEncryption` (PKCS#1 v1.5, the most widely validated) for RSA. Certificates: the signer and the imported chain, ≤ 8.
   - *ByteRange.* `[0 a b c]`, written as fixed-width placeholders (10 digits, space-padded) and patched after serialisation. The placeholder is found once, in the appended bytes only.
   - *Placeholder size.* `/Contents` is a zero-filled hex string of `round_up(chain DER + max signature + 1 536, 1 024)` bytes, capped at `SIG_CONTENTS_MAX` 64 KiB. Without a timestamp the size is deterministic up to a few bytes.
   - *Revision.* The signed file is the current file's bytes unchanged plus one appended revision, written by `IncrementalDocument` like every save. It holds the signature dictionary as an uncompressed object (never in an object stream), a merged field and widget (`/FT /Sig /T (Signature<n>)`, first free n), a new version of the page with `/Annots`, `/AcroForm` with `/Fields` and `/SigFlags 3`, and the catalog with `/Perms` when certifying. Never Full, and no earlier object is re-serialised.
   - *Preconditions.* The document is clean (`unsaved_changes`), its fingerprint is unchanged (`needs_confirmation fileChangedOnDisk`), it is not encrypted (`unsupported_feature signEncrypted`: the crypt writer cannot leave `/Contents` unencrypted yet) and it has no XFA (`unsupported_feature xfa`).
   - *Target.* A Rust save dialog, default `<stem> (signed).pdf`. The same file is allowed (atomic replace, existing backup rule). The open document is then re-admitted from the target, as after Save As.
   - *DocMDP.* The first signature of a document is a certification signature (`/Reference` with DocMDP, catalog `/Perms /DocMDP`). The default is **P=2** (form fill and further signatures allowed, so a second party can countersign). The option "no changes" sets **P=1**. A document that is already signed gets an approval signature: only one certification is allowed. An existing P=1 refuses with `read_only` (`certified`).
   - *Sheer's lock.* `SignatureLock` is derived from the file: `none`; `fillAndSign` (P=2, or approval signatures only); `annotateFillAndSign` (P=3); `locked` (P=1). `apply_command` refuses every command the lock does not allow with `read_only` (`signed`). A save of a signed document is Incremental only. To edit beyond the lock, `save_unsigned_copy` does a Full rewrite of the current state without `/Perms`, signature values, signature dictionaries and signed-signature widgets (a seal on an unsigned copy would mislead), and opens the result. The `breaksSignature` confirmation stays only for `flags.signed` documents whose fields the scan cannot read.
2. **Crates: pure-Rust RustCrypto, the generation already in the lock.**
   - *Chosen.* `der` 0.8, `spki` 0.8, `pkcs8` 0.11, `x509-cert` 0.3 (feature `builder`), `cms` **=0.3.0-pre.2** (`default-features = false`, types only; Sheer builds and signs SignedData itself), `rsa` **=0.10.0-rc.18** (`default-features = false`), `p256` and `p384` 0.14 (`ecdsa`), `sha2` 0.11 and `jiff` 0.2 (both already in the lock, now direct), `sha1` 0.11 (verifies legacy signatures, which are flagged weak) and `p12-keystore` 0.3.2.
   - *Rejected.* `openssl` (C toolchain and system library). `ring` and `aws-lc-rs` (C/asm builds). `rcgen` (needs one of those). The `cms` 0.2 generation (a second `der`/`digest` generation from 2024). In-house CMS types (about 600 lines, more risk than a pinned pre-release).
   - *Pre-releases* are pinned with `=`. A ROADMAP ticket moves to `cms` 0.3.0 and `rsa` 0.10.0 once they are released.
   - *RUSTSEC-2023-0071* goes into `deny.toml` `ignore` with a reason. Sheer never decrypts with RSA. A private key is used only on an explicit local action, with no network timing oracle. The default self-generated key is P-256 (constant time), so only imported RSA identities ever use an RSA private key.
   - *Guards.* No C toolchain: `check.sh` asserts that `cargo tree -i {ring,aws-lc-rs,openssl}` is empty for the desktop targets outside the updater. Import rule: these crates appear only in `src-tauri/src/pdfsig/`, which is free of engine and lopdf code.
   - *Fallback (two-attempt rule).* If `p12-keystore` fails `cargo deny` or pulls `ring`, B1 decodes PKCS#12 itself on `pkcs12` 0.2-pre, `pkcs5`, `des`, `hmac` and `sha1`.
3. **Keys.**
   - *Self-generated key: ECDSA P-256.* RSA-3072 was rejected: key generation takes seconds in pure Rust, it puts the Marvin-flagged crate on the default path, and its `/Contents` is three times larger. P-256 is validated by every maintained validator (Acrobat/Reader, Foxit, PDF-XChange, pyHanko, EU DSS). Viewers from before about 2012 may answer "unsupported algorithm"; accepted.
   - *Certificate* (made with the `x509-cert` builder). Self-signed v3. Serial of 16 random bytes, positive. Valid from now − 5 min for 3 years. Subject `CN` = name (1..=64 chars, display-name filter, default `Settings.authorName`), optional `O` (≤ 64), optional e-mail (≤ 254) as `emailAddress` and SAN `rfc822Name`. Extensions: basicConstraints CA=false (critical), keyUsage digitalSignature + contentCommitment (critical), EKU id-kp-documentSigning (RFC 9336) + emailProtection, SKI.
   - *Storage.* `<app data>/signing/identities.bin` = `"SHID" | 0x01 | nonce[24] | XChaCha20-Poly1305(postcard)` with the header as AAD (the same scheme as `library.bin`). Per identity it holds: id, label, chain DER, PKCS#8 DER private key, source, created. A separate 32-byte key sits in the keychain under user `signing-identities-key-v1`, so deleting one key never locks the other store. Neither the PKCS#12 blob nor a per-identity key goes into the keychain: a chain or an RSA-4096 key exceeds the 2 560-byte Windows blob, and one item per identity multiplies the macOS access prompts. Status works like the library (`empty`, `ready`, `unavailable`, `locked`). ≤ 8 identities, file ≤ 1 MiB. Never written in plaintext. No key bytes, PKCS#12 bytes or password are ever sent to the webview, which sees only `SigningIdentityInfo`.
   - *The .p12 password is asked once, at import, and never stored.* It arrives as a `Secret` (zeroized), decrypts the file and is dropped; the key is re-wrapped as PKCS#8 inside the envelope. It is not asked again per use: storing the password amounts to storing the key, and asking per use would mean keeping the PKCS#12 blob, which adds nothing against an attacker who already runs as the user (R15). The guard against an unintended signature is the sign confirmation (DESIGN §3.8).
   - *Import.* A Rust open dialog (`.p12`, `.pfx`), file ≤ 256 KiB, held in memory under a ticket (one at a time, 10 min). The file must hold exactly one private key with a matching certificate (equal public keys), else `invalid_argument` (`identityFile`). Accepted keys: RSA 2048..=4096, EC P-256 or P-384; anything else is `unsupported_feature` (`signingKey`). Encryption: PBES2 AES, plus legacy PBES1 3DES/RC2 (decrypt only). KDF and MAC iterations ≤ 2 000 000, checked before decrypting where the crate allows; otherwise a 30 s budget. From the 4th wrong password on, each try waits 1 s; the ticket is dropped after 5.
   - *Zeroize.* PKCS#8 bytes and decrypted envelopes in `Zeroizing`; key types `ZeroizeOnDrop`. A key lives for one sign call only. An expired identity refuses to sign (`invalid_argument`, `identityExpired`).
4. **Validation runs in the main process (blocking pool), not in the PDFium child.**
   - *Why.* PDFium exposes `/Contents`, `/ByteRange` and the time of each signature, but nothing about revisions or object changes. The child reads files only through `ReadAt`, so hashing up to 2 GiB over the wire would double the IO. The new parsers are safe Rust (`der`, lopdf), with no C, so the crash-isolation reason for the child does not apply. Each check runs under `catch_unwind` with a 60 s budget.
   - *Modules.* `pdfwrite/sigread.rs` (lopdf: fields, signature dictionaries, DocMDP, the object set of each revision) and `pdfsig/verify.rs`.
   - *Steps per signature.*
     - (i) SubFilter ∈ {`ETSI.CAdES.detached`, `adbe.pkcs7.detached`, `adbe.pkcs7.sha1`}. `ETSI.RFC3161` is reported as a document timestamp, unverified. Anything else is `unsupportedAlgorithm`.
     - (ii) ByteRange: exactly 4 non-negative integers `[0 a b c]` with a < b and b + c ≤ file length. The gap `[a, b)` must be exactly the `<hex>` token of the `/Contents` of the dictionary the field references, found by a bounded tokenizer from that object's xref offset (the object must be uncompressed). b + c must be the end of a revision on the `startxref`/`/Prev` chain (`%%EOF` plus EOL). Otherwise `malformed`.
     - (iii) Decoded `/Contents` ≤ 512 KiB. CMS: ContentInfo/SignedData, exactly one SignerInfo, ≤ 32 certificates, ≤ 64 signed attributes, each value ≤ 64 KiB. Typed decoding only, BER accepted, `Any` never recursed.
     - (iv) The two ranges are hashed streaming from the intake handle (64 KiB buffer) and compared with message-digest. The signature over the DER signed attributes is verified with the signer certificate's key: RSA PKCS#1 v1.5 or PSS, ECDSA P-256 or P-384, SHA-256/384/512. SHA-1 is verified but `weakAlgorithm`. signing-certificate-v2, if present, must match the signer certificate.
     - (v) Signer: `selfSigned`, and the certificate's validity at the claimed time. No chain is built.
     - (vi) Time: `/M`, else the CMS signing-time attribute, always labelled "claimed by the signer". A timestamp token is reported as present but not verified.
     - (vii) Coverage: the objects new or changed in later revisions are classified as `signatures` (signature dictionaries and fields, `/AcroForm` `/Fields`/`/SigFlags`, `/Perms`, DSS, `/Annots` gaining a signature widget), `formFill` (`/V`, `/AS`, `/AP` of existing non-signature fields), `annotations`, or `other` (everything else, including page content, resources, fonts and an object redefined as another type). The verdict against DocMDP is `allowed` or `disallowed`.
   - *Caps.* ≤ 32 signatures, ≤ 64 revisions, ≤ 200 000 changed objects; past a cap the rest is `unverifiable`.
   - *Trust.* No trust list, OCSP, CRL or AIA fetch (rule 4). The status is `notTrusted`, always with the notice that trust needs the certificate checked externally. Opt-in local pins: `<app data>/signing/trusted.json` (≤ 256 SHA-256 fingerprints of signer certificates + CN, atomic write) → `trustedByYou`. Sheer's own identities → `ownIdentity`. A pin is taken in Rust from the document, never from the UI. CA bundles, AATL and EUTL are rejected (network or stale; chain building and revocation are a separate product).
   - *`open_signed_revision`* opens the bytes `[0, b + c)` as a read-only document (`DocKind::SignedRevision`), so the user sees exactly what was signed. This is the remedy for shadow attacks.
   - *Caching.* The report stays in `DocState` until the document is reloaded.
5. **Seal appearance.**
   - *Builder.* `pdfwrite/seal.rs` builds the widget's `/AP /N`: optional art from a `SignatureRef` (vector paths or image XObject as in ADR-041) in the left 40 %, then text lines. The label "Digitally signed by" comes from i18n `seal.*` in the settings language. Then the CN, the date `YYYY-MM-DD HH:mm ±hh:mm` (local offset via `jiff`, the same instant as `/M`), and optionally Reason (≤ 128) and Location (≤ 64).
   - *Text.* Helvetica (std14, WinAnsi), sized to fit between 6 and 12 pt. A character outside WinAnsi is folded (NFKD, marks dropped), else drawn as `?`. `/Name` keeps the full Unicode name (UTF-16BE).
   - *Widget.* Colours and sizes are DESIGN §3.8 constants. Box ≥ 72 × 24 pt and inside the CropBox. Page `/Rotate` is countered by `/Matrix` (ADR-105). `/F` Print | Locked.
   - *Invisible signature.* `placement: null` writes `/Rect [0 0 0 0]` on the first page.
   - *Placement.* The UI reuses the visual-signature placement flow (move and scale, no turn) as a transient draft that is never a `DocCommand`.
6. **Undo: signing is a terminal save, not a command.** Its precondition is a clean document, so no pending edit is lost. On success it returns `SaveResult` with an empty history and the document reopened from the signed file. A cancel or a failure leaves the file and the model untouched (atomic write). A signature cannot be undone. The way back is the original file (the dialog defaults to a new name) or `save_unsigned_copy`.
7. **Threats and what the validator reports.**
   - *Key extraction.* Envelope plus keychain key, zeroize, redacting `Debug`, never logged, never sent over IPC. Anyone running as the user can sign with the key (R15).
   - *Universal signature forgery and signature wrapping* (empty or null `/Contents`, ByteRange moved or overlapping): step (ii) → `malformed`.
   - *Incremental-saving attacks:* step (vii) → `disallowed` with the change classes.
   - *Shadow attacks* (hide, replace, hide-and-replace): changes inside allowed classes are still listed ("annotations added after signing"), never called harmless, and "View signed version" shows the signed revision.
   - *Hostile PKCS#12:* size and iteration caps.
   - *No URL from a certificate is ever fetched* (AIA and CRL distribution points are ignored).
8. **Package cut (ORCHESTRATOR §8.4; green CI per package, ADR-120).**
   - **W0 seams (sequential):**
     - `limits.rs` consts; `Cargo.toml` with all the crates above (one owner, so no package conflicts on it); `deny.toml` ignore; `docs/LICENSES.md` rows.
     - `pdfsig/{mod,types}.rs` and wire types; `DocumentInfo.signatureLock`; `DocKind::SignedRevision`.
     - A real `pdfwrite/sigread::scan_fields` (small; B2–B4 need it).
     - Every new command as a `not_yet` stub in `lib.rs`, `build.rs` and capabilities.
     - `src/api/signing.ts` parsers; i18n keys `sign.*`, `seal.*`, `sigcheck.*`.
   - **Backend wave (4, disjoint):**
     - **B1 identities:** `pdfsig/{identity,p12,certgen}.rs`, `storage/{identities,keychain}.rs`, `commands/identities.rs`, `tests/identities.rs`.
     - **B2 signer:** `pdfsig/{cms_build,ess}.rs`, `pdfwrite/{sign,seal}.rs`, `commands/sign.rs` (`sign_document`), `tests/sign_roundtrip.rs` (CMS decoded and verified in the test; PDFium reopens the file; earlier bytes identical).
     - **B3 validator:** `pdfsig/{verify,revisions,coverage}.rs`, `pdfwrite/sigread.rs` (revision diff), `storage/trust.rs`, `commands/sig_validate.rs`, `tests/sig_validate.rs` (hostile corpus generated in the test: USF, ISA, SWA, shadow hide/replace, truncated and BER CMS, oversized `/Contents`).
     - **B4 lock and copy:** `model/{sig_policy,doc_state}.rs`, the gate in `commands/pages.rs::apply_command`, `commands/save.rs` (Incremental only), `pdfwrite/unsign.rs`, `commands/unsigned_copy.rs`, `tests/sig_lock.rs`.
   - **Frontend wave (4):**
     - **F1** Settings → Signing certificates (list, create, import with the password dialog, delete, export `.cer`, trusted signers).
     - **F2** sign flow in Fill & Sign (identity picker, seal placement, reason/location, lock option, confirmation).
     - **F3** signatures panel (status per signature, trust notice, View signed version, Trust this signer).
     - **F4** lock UX (actions' `enabled` reads `signatureLock`, banner with "Save unsigned copy", modes disabled).

**Consequences.**
- New crates (LICENSES.md rows, all `MIT OR Apache-2.0` unless noted): `der`, `spki`, `pkcs8`, `x509-cert`, `cms` (pre), `rsa` (rc), `p256`, `p384`, `sha1`, `p12-keystore` (MIT/Apache-2.0). Now direct, already in the lock: `sha2`, `jiff` (Unlicense OR MIT). Transitive: `ecdsa`, `elliptic-curve`, `primeorder`, `sec1`, `rfc6979`, `ff`, `group`, `crypto-bigint`, `signature`, `pkcs1`, `pkcs5`, `pkcs12`, `des`, `rc2`, `x509-parser`, `asn1-rs`, `der-parser`, `oid-registry`, `nom`, `rusticata-macros`, `data-encoding` (all MIT and/or Apache-2.0; W0 confirms each with `cargo deny` on the three desktop targets).
- `deny.toml`: `ignore = [{ id = "RUSTSEC-2023-0071", reason = "ADR-121 §2" }]`.
- Limits: `SIG_CONTENTS_MAX` 64 KiB (write) and 512 KiB (read), `SIG_CHAIN_MAX` 8, `SIG_CMS_CERTS_MAX` 32, `SIG_ATTRS_MAX` 64, `SIGS_PER_DOC_MAX` 32, `SIG_REVISIONS_MAX` 64, `SIG_DIFF_OBJECTS_MAX` 200 000, `SIG_VALIDATE_TIMEOUT` 60 s, `IDENTITIES_MAX` 8, `IDENTITY_FILE_MAX` 256 KiB, `P12_ITER_MAX` 2 000 000, `TRUSTED_SIGNERS_MAX` 256, seal reason 128 / location 64.
- Documents signed elsewhere become read-only in Sheer per `SignatureLock` (behaviour change, CHANGELOG). Fill and countersign still work under P=2.
- SECURITY.md rows (security-reviewer before v1.4.0):
  - I16 identities: create, list, delete, export `.cer` (public only, Rust save dialog).
  - I17 import: `pick_identity_file` + `import_signing_identity` + `discard_identity_import` (Rust dialog, ticket, `Secret`, caps, attempt delay).
  - I18 `sign_document` (preconditions, dialog in Rust, Incremental only, no key over IPC).
  - I19 `validate_signatures` + `open_signed_revision`.
  - I20 `set_signer_trust` / `list_trusted_signers` / `remove_trusted_signer` (fingerprint taken from the document).
  - I21 `save_unsigned_copy` + the `apply_command` lock.
  - P21 signature dictionary and ByteRange parsing (§4 ii).
  - P22 CMS and X.509 decode (§4 iii).
  - P23 PKCS#12 decode (size and iteration caps).
  - P24 revision diff (caps; shadow attacks reported, not hidden).
  - D9 `identities.bin` envelope + keychain key; D10 `trusted.json`.
  - S7 crypto crates pure Rust, the `ring`/`aws-lc-rs`/`openssl` guard, pre-release pins.
  - R14 RUSTSEC-2023-0071 accepted.
  - R15 the user's session can sign without a password.
  - R16 no revocation and no TSA; trust only by local pin.

**Orchestrator amendment (2026-10-05, before W0).** Crates: W0 first tries the stable RustCrypto line — `cms` 0.2, `x509-cert` 0.2, `der` 0.7, `spki` 0.7, `pkcs8` 0.10, `rsa` 0.9, `p256`/`p384` 0.13, `sha1`/`sha2` 0.10 — and a `p12-keystore` release that builds on it; a duplicate `digest`/`sha2` next to the 0.11 line already in the lock is acceptable. The pinned pre-releases above (`cms =0.3.0-pre.2`, `rsa =0.10.0-rc.18`, the 0.8/0.11 family) are used only if a needed API is missing in the stable line; W0 records which one and why in this ADR. RUSTSEC-2023-0071 applies to both lines (no fixed `rsa`); the deny.toml ignore and SECURITY R14 stay. Signing writes a new file (DESIGN §3.8): the original bytes plus one appended revision, so the "one appended revision only" rule above holds for the new file.
UI places follow DESIGN §3.8, not the working names of the frontend cut above: certificates are managed in a Certificates tab of the existing Signatures dialog (Werkzeuge → Manage Signatures…, not Settings); validation shows in the banner slot and the Signatures dialog (Datei → Signatures…, the banner's Details, a click on a seal); the sign tool is the eighth, letter-less slot "Zertifikat" of the Fill & Sign row.

**W0 addendum (2026-10-05, crates).** The stable RustCrypto line was enough, so no pre-release is pinned: `der` 0.7.10, `spki` 0.7, `pkcs8` 0.10, `x509-cert` 0.2.5 (`builder`, `hazmat` for `Profile::Manual`), `cms` 0.2.3 (`builder`), `rsa` 0.9.10, `p256`/`p384` 0.13 (`ecdsa`, `pem` is what makes `VerifyingKey: EncodePublicKey`), `sha1`/`sha2` 0.10, `jiff` 0.2 and `p12-keystore` 0.2.1 (it builds on `cms` 0.2, `pkcs12` 0.1, `pkcs5` 0.7). A test in `pdfsig/mod.rs` builds a self-signed P-256 certificate, a detached ECDSA SignedData with an external digest and an `ESSCertIDv2` attribute (own `der` derive types), and verifies it; the cms builder adds content-type and message-digest itself (a second copy is refused), so B2 adds only signing-certificate-v2. A duplicate `sha2`/`digest` 0.10 next to lopdf's 0.11 is accepted. `cargo deny` passes on all three desktop targets and `ring`, `aws-lc-rs` and `openssl` are not in the desktop graph (guard `guard_crypto_crates` in `scripts/check.sh`, which also keeps the crypto crates inside `pdfsig/`). RUSTSEC-2023-0071 is ignored in `deny.toml` and in `.cargo/audit.toml` (cargo audit reads that file; SECURITY R14). The 0.3/0.8/0.11 pre-release plan of section 2 is dropped; the ROADMAP ticket to move to it is not needed until a stable `cms` 0.3 ships.

## ADR-122 — Session mode: one topic per session, closed with a report and STOP

**Status:** accepted (2026-10-05, owner instruction). Extends ORCHESTRATOR_PROMPT §12 (stop condition 5), §14 (start) and adds §15.

**Context.** The autonomous loop ran from one ROADMAP item into the next (v1.2 → Politur v1.3 → v1.3 → v1.4) without a point where the owner sees a result, and the Stop hook always names the next open item.

**Decision.**
1. Every session works on exactly one topic, named by the first message as "Thema: …": a milestone, a feedback block or a patch. Other ROADMAP items are not started in that session, whatever the Stop hook names.
2. At the start the orchestrator deletes `.claude/state/STOP` itself and reads the CI state (ADR-120).
3. A topic is closed when its Definition of Done holds, CI on `main` is green, and — for user-visible changes — a release or pre-release is on GitHub.
4. Then `docs/reports/<YYYY-MM-DD>-<topic>.md` is written (format in §15: topic and result, delivered, accepted in the installed build, not accepted, open with size, decisions for the owner, usage, suggested next topic; at most 400 words; English like all docs, rule 6), committed and pushed; `.claude/state/STOP` is created and the session stops without starting a new topic. The report is also the last chat message.
5. This session (2026-10-05): the topic is v1.4 "Certificate signature", already running. Two reports: the v1.3 report written afterwards (`docs/reports/2026-10-05-v1.3-zitate.md`), and the v1.4 report after its GitHub release; then STOP, no v1.5.

**Consequences.** The Stop hook (`continue-loop.sh`) stays as it is: the STOP file ends the loop, and §15 rule 1 keeps it from pulling in a new topic. Reports give the owner one page per topic instead of the transcript.

**ADR-119 addendum 3 (owner decisions on the v1.3 report, 2026-10-05).** Chicago stays author-date. The default citation style is APA 7 in every UI language (no longer DIN for German); the last chosen style is kept (`sheer.citations.style`). Reference data stays inside the PDF (`/SHR_Bib`) — confirmed. A fifth style, "Deutsche Zitierweise (Fußnoten-Stil)", is noted in the Politur backlog; it is specified only after owner feedback.

**ADR-122 addendum (owner, 2026-10-05).** Session reports are written in German, as an exception to rule 6 (CLAUDE.md rule 6, ORCHESTRATOR_PROMPT §15 format headings in German). The v1.3 report stays as written.

**ADR-120 correction (owner, 2026-10-05, after runs #71–#74 stayed red).** The CI check moves from the loop start to **before every push** (ORCHESTRATOR §8.4 step 7). Before a push: (a) if `STATE.md` `ci_log` names an own run that was still running at the last push, read it first (`scripts/ci-status.sh <run-id>`; exit 3 = still running); red → fix first; (b) otherwise read the last completed run (`scripts/ci-status.sh`); red and caused by an own commit → fix first; (c) an own run still running → push anyway and note it. Never wait for a run. After every package commit `STATE.md` `ci_log` gets a line "<commit> <package> → run #<n> (<id>)" with the result added when it is read, so a red run maps to its commit. Points 1–2 of the decision above are replaced; point 3 (green CI in every package's DoD) stays. The red runs #71–#74 had two causes, both in tests: two PDFium command tests binding the engine twice in one process (aaabac2) and the .p12 decode slot released after the answer (72316ba); `scripts/check.sh` now also prints a Rust panic's message line (b050ada).

## ADR-123 — Owner decisions on the v1.4 report; session "Politur v1.2–v1.4 + CI runtime" (v1.4.1)

**Status:** accepted (2026-10-05). Source: product-owner message opening this session.

**Decisions (owner).** (1) Signing offers a choice for a certification signature: **"No changes"** (DocMDP P=1, the default) or
**"Fill in forms and allow further signatures"** (P=2). This reverses the P=2 default of ADR-121 section 2: `SignLock::default()` becomes
`NoChanges`. The choice is shown only when the signature certifies (the document has no signature yet); an approval signature has no choice.
The last choice is not remembered (every signature starts at "No changes"). (2) Files certified elsewhere stay locked according to their
DocMDP level (confirmed, no change). (3) Self-generated identities stay ECDSA P-256, 3 years (confirmed).

**Scope of the session.** All open items of the "Politur backlog" (the v1.2, v1.3 and v1.4 leftovers), the DocMDP choice and CI runtime,
released as v1.4.1. The fifth citation style stays parked (needs owner feedback, ADR-119 addendum 3).

**CI runtime target.** Each CI job on `main` finishes in under 15 minutes (run #78: Windows 26 min, macOS 17 min, `npm run check` 20/15 min
of that, Windows cache save 5 min). Levers, in this order: per-step timings in `check.sh`; platform-independent steps (tsc, eslint,
prettier, vitest, bundle guard, npm audit, cargo deny/audit, guards) run once in a separate Linux job, the Windows/macOS matrix keeps
fmt, clippy and cargo test (platform `cfg` code must still be linted and tested on both); dev/test profile with reduced debug info;
a Rust cache that stores dependencies only; fewer integration-test binaries if linking still dominates. Release builds stay in
`release.yml` only. The DoD "CI green on Windows and macOS" now means: all jobs of the run green (the Linux job included).

**Addendum 1 (package S4, CI runtime).** Implemented: `scripts/check.sh` prints `ok  <step>  <n>s` per step and takes
`SHEER_CHECK_PART=all|web|rust` (default `all`, so local `npm run check` is unchanged). `ci.yml` has two jobs: `web` (ubuntu-latest:
version sync, tsc, eslint, prettier, vitest, cargo deny/audit, npm audit, all guards, bundle URL guard; no Rust compile) and `native`
(Windows/macOS matrix: PDFium fetch, fmt, clippy, cargo test, keychain round trip; Node only for the manual debug bundle). The Rust cache
is `Swatinem/rust-cache` v2.9.2 (MIT, pinned by SHA; dependencies only, workspace artifacts are dropped before saving), saved on `main`
only. `[profile.dev|test]` use `debug = "line-tables-only"`, dependencies `debug = false` (panics keep file:line). `release.yml` is
unchanged (it builds once per target; no duplicated work). Open: if linking the 46 integration-test binaries still dominates, merge
them into a few `tests/<group>/main.rs` binaries in a later wave (touches `src-tauri/tests`).

**Addendum 2 (package S8, CI follow-up).** Run #79 (cold cache): web 4 min, macOS 12 min, Windows 14 min, so the 15-minute target is met;
the integration-test consolidation is not needed now (revisit if a job exceeds 15 min). Timeouts are now 20 min (web) and 25 min (native).
The web job installs a minimal toolchain (no clippy/rustfmt; channel read from `rust-toolchain.toml`, selected via `RUSTUP_TOOLCHAIN`). A bare
`cargo deny check` now passes: `deny.toml` ignores the Linux-only GTK advisories RUSTSEC-2024-0429 (glib) and RUSTSEC-2024-0370
(proc-macro-error) with reasons (not shipped; `check.sh` still scopes cargo deny to the desktop targets) and allows the permissive
`Apache-2.0 WITH LLVM-exception` (target-lexicon). `guard_crypto_crates` formatting aligned with `guard_network_crates`.

**Addendum 3 (orchestrator, wave 2 results).** (a) The typed-signature font choice stays in `localStorage`: it is a font name, not
signature data, and the encrypted library has no settings slot; adding one would change the library format for no protection gain.
(b) Redact mode survives a mode switch, as the existing tour/mode test specifies; the backlog item "tour: redactMode after a mode switch"
is closed as working as specified. (c) The early recent preview (S5) renders page 1 of a newly opened user document; T2 routes it through
one bounded worker. (d) Not reproducible from code (S3/S6): page 2 flush at 960 px and the inspector refit — they are checked in the
installed build at acceptance; a reproduced defect is fixed there, otherwise the items are closed.

## ADR-124 — F17 "UI quality after the owner test" (patch v1.4.2)

**Status:** accepted (2026-10-05). Source: owner message opening this session; items in docs/FEEDBACK.md F17.

**Decisions.** (1) The signing lock choice is remembered (last choice, per device, settings store) and shown visibly on every signing:
the sign sheet always shows the current lock; for an approval signature it shows the document's existing lock read-only. This replaces
ADR-123 "never remembered". (2) One positioning engine (`useFloatingPosition` grown into a shared module) places every tooltip, tip, coach
mark and popover: collision detection against the viewport and against "protected" elements (inputs, buttons, the active tool), flip,
shift; a notice never covers an input or a button, and a notice queue shows at most one at a time. (3) Global surface rule: popovers and
dialogs size to their content; if a popover does not fit the viewport it is repositioned, else rendered as a dialog; only lists scroll
internally, never forms or button rows. (4) Thumbnails render at 2–3× the target size and are downscaled with an area-averaging (box)
filter in Rust (no new dependency unless the `image` crate is already in the lock), text antialiasing on. (5) Shape straightening is a
pure TS module (`features/draw` or annotations ink) classifying a finished stroke as circle, ellipse, rectangle, line or arrow with a 12 %
tolerance; a hit morphs in 150 ms and is one undo step. (6) New DoD gate (ORCHESTRATOR_PROMPT §8.6, docs/UI_REVIEW.md): a CDP script opens
every registered popover and dialog at 960×640 in the dev window and fails on overflow, cut-off buttons, internal scroll of non-lists or
overlap; violations are blockers. A dev-only surface registry (stripped from release builds) lets the script open each surface.
(7) Acceptance for this topic runs only in the installed release build (NSIS, Windows) at 960×640 and 1280×800.

### ADR-124 addendum 1 — gate refinements (G3, 2026-10-05)

Three refinements of the surface gate (`scripts/ui/surface-checks.mjs`), none of which relaxes a rule for a real defect:
(a) **Label cut** measures only elements that carry visible text. Visually hidden text (sr-only: `clip: rect(0,0,0,0)`, `clip-path: inset(50%)`,
a box of 1 px or less) is ignored (`isVisuallyHidden`). The colour swatch "label is cut (26 > 22)" was not sr-only: it is the invisible hit-area
pseudo-element (`before:-inset-1`) of an icon-only control, which counts as scrollable overflow, so icon-only controls without text are no
label either (the descendant-rect check still catches real overflow).
(b) **In-field adornments** (the eye of the password field, the check of the hex field), marked `data-adornment` inside their field wrapper,
are not overlaps with that field's input; any other control still is.
(c) **Menu-bar menus** (`role=menu` opened from `role=menubar`) follow the OS menu convention: they may cover the toolbar and the active tool
below them but never their own anchor (the engine protects only the anchor for them, and holds a menu's height to the roomier side of its
anchor so it cannot slide over it). Also: rows scrolled out of a list or cut by an overflow ancestor do not overlap what lies there (the
overlap check uses the visible part of a control), and `role=menu` is a list (Q7) in the page selector as in the spec.

**ADR-124 addendum 2 (acceptance round 2, 2026-10-05).** The crop frame's handles are protected against notices only
(`data-protect="notice"`), not against the crop popover: the popover is the crop tool's own options and stays non-modal, so the
other handles remain draggable. Protecting them against the popover made it fall back to a modal dialog at 960 × 640, which
blocked dragging. This matches Q8 (popovers protect their anchor, the active tool, pressed toggles and the focused input).
The draw tip now describes straightening on release ("hold before release" was the old recogniser).

**ADR-124 addendum 3 (owner, 2026-10-06).** The signing lock choice is remembered only after a completed signing. Changing the radio
no longer writes the preference; a cancelled sheet, a cancelled save dialog or a failed signing keeps the last completed choice.
The F17.9 thumbnail fix was re-checked with the owner's real files (four municipal bylaws, Word 2010 and Distiller): rendered
directly at 96 and 160 px, headings and bold runs become solid black bars; with 3× + box downscale they read as grey text
(before/after montage and an installed-build screenshot in review/v1.5-spike/, not tracked).

## ADR-125 — Editing existing text (v1.5)

**Status:** proposed (2026-10-06), phase 1 = feasibility; no UI. The parallel lopdf spike (word replacement on 10 real PDFs: Word,
LaTeX, InDesign, OCR, form) is reconciled in the session report; its numbers may move thresholds here, not the structure.
Design in ARCHITECTURE.md §13.

**Context.** Users expect to fix a typo in a PDF's own text, not cover it with a text box. PDF has no "text": content streams position
glyph codes of fonts that are often subsetted, re-encoded or not embedded. PDFium (`engine/`) knows characters and boxes but cannot write
content streams; lopdf (`pdfwrite/`) can, and `pdfwrite/redact_content.rs` already walks text operators with a bounded graphics state
(ADR-055). Save must stay incremental (signed and large documents), undo must be a `DocCommand`.

**Options.**
(A) Cover with a filled rectangle + a new text box. Rejected as "editing": the old text stays extractable and searchable.
(B) Whole-page rewrite through PDFium (`FPDFText`/`FPDFPageObj_*` edit API, `FPDFPage_GenerateContent`). Rejected: regenerates the whole
content stream (loses marked content, structure, compression, byte identity), runs in the engine child that must stay read-mostly, and
cannot do incremental updates.
(C) Surgical lopdf rewrite of only the show-operators of one line, glyphs mapped through the original font, fallback font only when the
original cannot show a character. **Chosen.**

**Decisions.**
1. *Reading.* One walker (extracted from `redact_content.rs` into `pdfwrite/ops_walk.rs`, shared with redaction) yields positioned glyph
   runs per page (all text-state operators, `q/Q`, `cm`, Form XObjects read-only). Runs group into lines, lines into paragraphs by
   geometry (§13.2). The UI's click (a UTF-16 index of `TextLayer`) maps to a run by **geometry, not index**: PDFium char origin +
   Unicode matched against walker glyph origins (PDFium's index includes generated spaces and line breaks, so indices never align).
2. *Writing.* A line edit is a glyph-level diff: unchanged prefix and suffix keep their bytes and `TJ` kerning; only the changed span's
   show-operators are spliced (own offset-tracking lexer; every other byte of the stream stays identical). The line start never moves.
   Width delta: default `keepStart` (end moves, collision with a later positioned segment of the same line is a warning); option
   `squeeze` (`Tz` down to 85 %); justified lines re-distribute the delta into word gaps via `TJ` numbers. No reflow across lines in
   v1.5.1; v1.5.2 adds `scope: paragraph` (re-break within the paragraph, same baselines, never more lines than before).
3. *Fonts.* The original font is used when every new character has a code in its encoding, a glyph in its program and a width. Detection
   per font kind in §13.3. Missing glyph → the **whole edited line** switches to a fallback (per-glyph mixing rejected: mixed faces read
   as errors). Embedded font programs are **never modified** (no glyph added to a subset, no `/Differences` grown).
4. *Fallback.* Bundled Arimo / Tinos / Cousine (Regular, Bold, Italic, Bold Italic; **Apache-2.0**, metric-compatible with
   Helvetica/Arial, Times, Courier), chosen by `/Flags` (Serif, FixedPitch, Italic), `/FontWeight`/`/StemV` and `BaseFont` name hints,
   embedded as a subset (`subsetter`) Type0/Identity-H font with `ToUnicode` and `W`. A non-embedded font keeps its own reference while every
   character is encodable (WinAnsi/`Differences`) and has a `/Widths` entry. System fonts are never read (non-deterministic, embedding
   rights via `fsType`, files outside our scope). The user is told whenever a fallback is used, naming the original font.
5. *Crates.* `skrifa` 0.48 (MIT OR Apache-2.0, present) reads TrueType/OpenType/bare CFF (`read-fonts`); `subsetter` (MIT OR Apache-2.0)
   subsets the fallback only. Type1 (`FontFile`): own bounded eexec decrypt + `/CharStrings` name scan (no charstring execution). No
   other font crate; no hinting, no shaping (Latin, Greek, Cyrillic only; complex scripts and RTL refuse).
6. *Never.* Type3 fonts, invisible text (`Tr 3`/`7`: OCR layers over scans), clip modes (`Tr 4–7`), vertical writing, non-Identity
   CMaps, outlined text, text in images, text inside Form XObjects or annotation appearances (v1.5.1), runs under `/ActualText`, pages
   whose slot is not `PageSource::File`, signed or certified documents (any signature field with a value → `read_only` `signed`, no
   matter the lock), documents without `edit` permission. Tagged PDF: marked content and MCIDs around the run are kept, the structure
   tree is not touched.
7. *Model and save.* `DocCommand::EditTextLine` holds a stable line key and the new text; `DocState.text_edits` keeps an ordered list per
   page, replayed over the original stream (undo = pop, deterministic). Preview = one-page PDF from the replay swapped in like a redacted
   page; save = incremental update: new content stream object for that page (same object id unless shared), new fallback font objects,
   a page-local `/Resources` if it was inherited or shared.

**Consequences.** Real typos in Word/LaTeX/InDesign exports become fixable without white-out; subsetted fonts often force the fallback
for new characters (expected and announced). The walker refactor touches redaction: its tests are the regression guard. New bundled
fonts (~5 MB, Apache-2.0) and one crate go to `docs/LICENSES.md`. Phase 1 exit criteria: on the spike corpus, the walker+mapper finds the
clicked line on ≥ 90 % of probes in non-OCR files, a same-font edit renders pixel-identical outside the line's box, and every refusal
class in 6 is detected, not crashed into. Failing that, v1.5 ships white-out + text box only and this ADR is superseded.

**ADR-125 addendum 1 — fallback scope (orchestrator, 2026-10-06).** ADR-125 §3 ("whole edited line") and DESIGN §3.10 E4 ("only the
missing characters") disagreed. Decision: the fallback covers the **changed words** — the word span around every edited character —
and nothing else. Whole-line switching re-sets text the user did not touch (its widths change, so it can collide with later absolutely
positioned segments, as the spike showed); per-glyph mixing puts single foreign glyphs into a word, which reads as an error. Word
scope keeps the untouched prefix and suffix byte-identical (§2) and contains the visual break to what the user typed. Accent: DESIGN.md
maps the brief's "Iris" to Solar (ADR-100); that stands.

**ADR-125 addendum 2 — owner decisions (2026-10-06, session v1.5.1).** The owner confirmed both open questions of the phase-1
report: (1) Arimo, Tinos and Cousine (Regular, Bold, Italic, Bold Italic; Apache-2.0) are bundled; system fonts are never read.
(2) The fallback covers only the changed words (addendum 1). Status of ADR-125: **accepted**.

## ADR-126 — Test files and screenshots: owner folder or self-generated, window capture only

**Status:** accepted (2026-10-06, owner instruction, session v1.5.1).

**Context.** Acceptance runs and corpus gates need real PDFs and screenshots. Looking for PDFs elsewhere on the owner's machine
(Downloads, Documents, program folders) reads private data that was never handed over; a full-screen capture can record other
windows, notifications and private content.

**Decision.**
1. Test PDFs come **only** from `review/owner/` (handed over by the owner; `review/owner/corpus/` for corpus gates) or are
   **generated** by scripts in this repo (output under `review/`, untracked). No other folder of the machine is listed, searched
   or read for test material — not to find files, not to find tools' sample documents.
2. Screenshots are taken **only by capturing the app's own window** (by its window handle, e.g. `PrintWindow`/
   `CGWindowListCreateImage` for the Sheer window), never from the screen or a screen region.
3. `ORCHESTRATOR_PROMPT.md` §2 rule 13 and `CLAUDE.md` rule 13 carry this; briefs for acceptance and gate packages repeat it.

**Consequences.** Corpus gates that need producer variety (Word, LaTeX, Ghostscript) generate their files; if a producer is not
installed, the gate records the gap instead of borrowing files. Window capture may miss OS-drawn overlays (native dialogs) — those
are checked by their own window handle or not at all.

**ADR-125 addendum 3 — signed documents (orchestrator, 2026-10-06).** DESIGN §3.10 E5 lets a file with others' approval signatures be
edited after the `breaksSignature` confirm; ADR-125 §6 refuses every document with a signed field. For v1.5.1 §6 wins: probe and
apply refuse signed/certified and no-edit-permission documents with the same typed error and `params.reason` (`signed` /
`permission`), the tool shows `cert.locked.tool` / `tool.readOnly`. Editing approval-signed files with the confirm is deferred
(ROADMAP ticket "Politur v1.5"); it needs a byte-range-aware incremental write that keeps earlier revisions verifiable.

## ADR-127 — Path guard: writes inside the repo and the Claude temp folder only, no reads outside the repo

**Status:** accepted (2026-10-06, owner instruction).

**Context.** ADR-126 forbids looking for test material elsewhere on the owner's machine. A rule in a prompt is not enough: in the
v1.5.1 session a cleanup step reached into `%APPDATA%` and a tool probe into `C:\Program Files`. The owner wants a hard stop.

**Decision.**
1. A PreToolUse hook `.claude/hooks/guard-paths.sh` (→ `guard-paths.mjs`, node) runs for Bash, PowerShell, Write, Edit and
   NotebookEdit. Exit 2 blocks the call; stderr names the path and the reason.
2. *Writes* (Write/Edit/NotebookEdit targets; `rm`, `del`, `erase`, `rd`, `rmdir`, `Remove-Item`, `mv`, `move`, `Move-Item`, `cp`,
   `copy`, `Copy-Item`, `ren`, `New-Item`, `Set-Content`, `Out-File`, `tee`, `touch`, `mkdir`, `ln`, `sed -i` …; redirections `>`,
   `>>`, `&>`) are allowed only inside the repo (`$CLAUDE_PROJECT_DIR`) and the Claude temp folder (`<tmpdir>/claude/`: scratchpad,
   task output). Relative targets resolve against the cwd, `..` included. A write target that starts with an unknown variable
   cannot be checked and is blocked.
3. *Reads*: any path token outside the repo is blocked. Test material comes from `review/owner/` (ADR-126). Exceptions, read-only:
   the Claude temp folder (our own outputs), `~/.cargo` and `~/.rustup` (the Rust toolchain on PATH, CLAUDE.md), `/dev/*` and `NUL`.
4. Path tokens are recognised by shape (drive letters, Git Bash `/c/`, `~`, `$HOME`/`$APPDATA`/`$TMP`/`$env:…`/`%…%`, `/tmp`, UNC,
   `..`); heredoc bodies are text, not paths. Tested in `scripts/hooks/guard-paths.test.ts` (vitest, part of `npm run check`):
   negatives `rm -rf` outside, `>` outside, Write/`Remove-Item`/`ls`/`mv ..` outside; positives repo, `review/owner/`, temp, heredoc.

**Consequences.** Logs go to the scratchpad, not `$TMP`. Writes to the auto-memory folder (`~/.claude/projects/…/memory`) are
blocked too; memory updates need the owner to widen the guard. The hook inspects the command line only: a repo script may still
use `mktemp` or tool caches (npm, cargo) internally — accepted, those are build tools, not file access by the orchestrator. It is a
tripwire against mistakes, not a sandbox.

## ADR-128 — Tempo level 3 for feature milestones; owner answers for v1.5.1 wave 2

**Status:** accepted (2026-10-06, owner instruction, session "v1.5.1 fortsetzen – Welle 2 bis Beta").

**Owner answers.** B-006: build the recovery change (purge after 30 days, banner summary from three entries). B-007: resolved —
`review/owner/corpus/` holds 32 PDFs; nothing is generated for the corpus gate (the producer-generation clause of ADR-126 is not
needed for v1.5.1). The auto-memory folder of this project (`~/.claude/projects/<repo slug>/memory`) is readable and writable
through the path guard (ADR-127 amended; test in `scripts/hooks/guard-paths.test.ts`).

**Decision (tempo level 3; applies to feature milestones, replaces the matching parts of §7.6 and §8.4 of the orchestrator prompt).**
1. *Code review* (`reviewer`) only for packages that add or change IPC commands or payloads, write, move or delete files, or parse
   untrusted input (PDF, fonts, images). Every other package is gated by `npm run check` (run by its implementer) alone.
2. *Security review* only once, at milestone end (no per-package `security-reviewer`). Critical/high still block the tag.
3. *Designer review* not per wave; one round before the release with four screenshots (light/dark × empty/document, window capture,
   ADR-126). Only blockers trigger a fix package.
4. *Acceptance in the installed build*: one round. Only blockers trigger fixes; everything else goes to the "Politur v1.5" ticket.
5. *Surface gate and window smoke test stay* (they are automatic).
6. *Pre-release* `v1.5.0-beta.1` as soon as the function is usable, not when it is perfect.

**Scope cuts for the v1.5.1 beta (orchestrator).** (a) The live Rust re-render while typing (DESIGN §3.10 E1, last bullet) is
deferred: the edit box draws the draft over a page-coloured mask in the closest CSS family of the line's font; Apply renders the real
result. (b) The Umbrechen toggle (E2) belongs to v1.5.2 (`scope: paragraph`) and is not shown. Both go to "Politur v1.5" / v1.5.2.

**Consequences.** Fewer review agents per wave; the risk moves to the milestone-end security review and the installed-build round.

## ADR-129 — Live line preview, alignment, paragraph reflow (session "Politur v1.5 + v1.5.2 bis Release v1.5.0")

**Status:** accepted (2026-10-06, owner instruction). Tempo level 3 (ADR-128) applies.

**Decisions (owner).**
1. *Live rendering while typing* replaces the ADR-128 scope cut (a): Rust renders the edited line in the real font from the draft.
   The UI asks 60 ms after the last keystroke; under load (a preview still running, or the last one took longer than 60 ms) the delay
   becomes 100 ms. A preview is never an undo step and never touches `DocState`; a stale answer (older generation) is dropped.
2. *Polish v1.5*: the substitute notice also appears after Apply (anchored to the last edit box); the edit box grows with the text;
   centred and right-aligned lines keep their alignment on Apply (the anchor moves, not the start); the designer minors of the beta.
3. *v1.5.2 reflow* (`scope: paragraph`): words re-break inside one paragraph on its own baselines; at most one line is added, only
   if the gap below is at least one line pitch; never across columns or pages, never moving other paragraphs.
4. Release `v1.5.0` after acceptance in the installed build with three owner PDFs (`review/owner/corpus/`); the tag
   `v1.5.0-beta.1` stays.

**Orchestrator cuts.** Wave A: backend preview command (new module, own IPC → review), backend alignment + paragraph grouping of
justified text, backend reflow (new `text_reflow.rs`, expanded inside `replay`), frontend polish (notice, growing box, minors). Wave B:
frontend live preview + alignment-aware box + reflow editing, and the Umbrechen toggle.

## ADR-130 — Patch v1.5.1 "Politur v1.5 (Rest)": justified lines stretch to full width

**Status:** accepted (2026-10-06, owner instruction, session "Politur v1.5 (Rest) als Patch v1.5.1"). Tempo level 3 (ADR-128).

**Owner decision.** A changed line of a justified paragraph (any line but the paragraph's last) is stretched back to the full
paragraph width: the difference between its new natural width and the paragraph's right edge is spread evenly over its word gaps,
whatever the chain structure of the line (one `TJ`, one show operator per word, `Tw`). This replaces the "loses its justification"
behaviour of v1.5.0 and holds for reflow (`scope: paragraph`) too: every re-broken line except the paragraph's last is stretched,
the last line keeps its natural width. Paragraph grouping must keep a justified paragraph together across a strongly stretched line
(E4 page 1, "Ende … des").

**Orchestrator decisions.**
1. *Limits.* A gap grows to at most 4 × the font's space width beyond its natural width; a line that would need more stays left-aligned
   (ragged) with the warning it had before. A line with no word gap (one word) stays left-aligned. Gaps never shrink below 0.5 × space.
2. *Packages (one wave of four).* B1 paragraph grouping of stretched lines + text_lines review lows; B2 splice/reflow stretch +
   reflow and splice lows; B3 backend lows (preview command, limits, Flate for rewritten streams, walker budget, test pins);
   F1 frontend (notice lifetime and format, box anchoring for centred/right lines, designer minors).
3. *Deferred to a later polish ticket:* edits on approval-signed files (byte-range-aware write), cooperative cancel inside the walker,
   re-edit of a line that already holds a fallback word, Symbol/ZapfDingbats widths. They need new write paths or font data, not polish.
4. *Release* `v1.5.1` (patch) after an installed-build round on Windows with a justified owner PDF where a changed line re-breaks.

**Consequences.** Justified documents (statutes, reports) keep their look after an edit; the stretch touches only the edited and
re-broken lines, never other paragraphs.

**ADR-130 addendum 1 (orchestrator, F1).** The P1 minor ("a single-line paragraph's limit ignores the widest-line cap") is
descoped: a paragraph of one line has no other line to cap against, and capping it at its own width stops every single line from
growing, which contradicts DESIGN §3.10 E2 (limit = next object on the baseline less 4 pt, or the crop edge less 12 pt). The current
behaviour stands.

## ADR-131 — Acceptance infrastructure: automation build, CDP input, dialog guard (rule 15)

**Status:** accepted (2026-10-06, owner instruction, session "v1.6 Smarte Verknüpfungen"; first package before everything else).

**Context.** The v1.5.1 acceptance drove the release build with real OS mouse and keyboard. Keys typed while focus was elsewhere
triggered tool shortcuts (an Insert-image file dialog opened unseen), clicks landed on stale coordinates after DPI changes, and the
acceptance exe shared identifier, data folder and single-instance channel with the owner's installed Sheer.

**Decisions (owner).**
1. *Cargo feature `automation`* in `src-tauri`: every native dialog (open, open many, pick folder, save, save as, export, print,
   message/confirm) goes through one seam (`automation::dialogs`). With the feature, the seam answers from a queue the script fills
   (`automation_queue_dialog`, an IPC command compiled and registered only with the feature); an empty queue is an error, never a
   native dialog. Print with the feature writes nothing and reports the print set to the script. Without the feature the seam calls
   the native dialog exactly as before. The feature is never in `default`, never in the release workflow; `npm run check` fails if a
   release config, the default features or the release capability set name it.
2. *Acceptance build*: release profile plus `automation`, identifier `app.sheer.acceptance`, product name "Sheer Acceptance", own
   binary name and target dir, so its app-data folder, single-instance channel, recent list and autosave are separate and it can
   never replace or talk to the owner's installed Sheer. Not bundled, never installed, never updated (updater off).
3. *Acceptance scripts use CDP input* (`Input.dispatchMouseEvent`/`dispatchKeyEvent`/`insertText` against the acceptance build's
   WebView2, remote debugging on 127.0.0.1 only via `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` at launch). Real OS mouse and keyboard only
   in the final smoke test: at most five minutes, announced in the chat before and after.
4. *Dialog guard*: while a script runs, a watcher checks the foreground window and every top-level window of the acceptance process;
   a foreign foreground window or an unexpected dialog → Esc to that window, abort the script, error report with window title,
   class and the last step. No blind clicks.
5. *Rule 15* in ORCHESTRATOR_PROMPT §2 and CLAUDE.md: acceptance only through the acceptance build; the owner's installation (its
   program folder, data folder, settings, recent files, running instance) is never touched.

**Packages.** I1 backend (feature, seam at every dialog call site, queue command, acceptance config, guards); I2 tooling
(`scripts/ui/accept/*`: launcher, CDP input, capture, dialog queue client, guard, real-input smoke ≤ 5 min; docs/UI_REVIEW.md).

## ADR-132 — Politur v1.5.1 decisions and v1.6 "Smart links" detection

**Status:** accepted (2026-10-06, owner instruction, session "v1.6 Smarte Verknüpfungen"). Tempo level 3 (ADR-128); acceptance
through the acceptance build only (ADR-131).

**Politur v1.5.1 (owner).** (1) "Umbrechen" is **on by default** for every line of a multi-line paragraph (single-line paragraphs have
no toggle). (2) Without Umbrechen a line stops at the **paragraph's right edge** (its typical inner-line edge; centred/right lines at
their paragraph edges); the overflow caption and hatch measure against that edge and never let text run past the page edge. Single-
line paragraphs keep the next-object/crop limit of DESIGN §3.10 E2 but never past the crop edge less 12 pt. (3) The focus outline of a
right-aligned or centred box grows with the text from its anchor. (4) The E4 page-1 Präambel case (box opens, no mini bar, no
preview) is reproduced in the acceptance build and fixed or turned into a refusal tooltip.

**v1.6 detection (orchestrator, DESIGN §3.11).**
1. *Where.* Text facts are read in the engine (PDFium, same bounded reader as `derived_outline.rs`): per page lines → runs with size,
   baseline, bold, boxes in page points (`smartlinks::model::PageText`), crossing the engine wire like the other read jobs. Detection
   runs in the app process in `src-tauri/src/smartlinks/` as **pure functions** over `DocText` (unit-testable without PDFium).
2. *Detectors.* `toc` (title + dot leaders/gap + number at line end, ≥ 3 such lines in a block), `footnotes` (raised run: baseline
   ≥ 0.25 × body size above the line's baseline or size ≤ 0.8 × body, numeric/symbol marker; note = line in the lower 40 % of the
   page or an endnote section starting with the same marker, smaller than body), `references` (regex families for page refs and
   Abb./Fig./Tab./Kapitel/§ labels → page or caption/heading line starting with the label), `literature` (author-year and numeric →
   bibliography section entries after a heading "Literatur", "Literaturverzeichnis", "Bibliography", "References", "Quellen").
3. *Scoring.* Each candidate gets a score in [0, 1] from independent cues; it is linked only if exactly one target scores ≥ 0.75 and
   the runner-up ≤ score − 0.25 (DESIGN L2). Page numbers resolve through page labels first, else a printed→physical offset confirmed
   by ≥ 3 contents lines whose title text is found on the target page; no confirmed mapping → no link.
4. *Conflicts.* Candidates intersecting a real link, a form widget or an annotation are dropped in the app process (L3).
5. *IPC.* `smart_links(doc, page) -> { rev, links: SmartLinkWire[] }` (boxes, kind, marker, target page/rect, preview ≤ 280 chars);
   the document index (TOC mapping, notes, captions, bibliography) builds lazily in the background once per revision with limits
   (pages, chars, time) in `limits.rs`; an index not ready → that kind returns nothing yet. Never written into the PDF; no `DocState`
   change; off = no work.
6. *Packages.* Wave 1 backend: S1 engine reader + wire + index/cache + command + `toc` + page mapping; S2 `footnotes` (+ note back);
   S3 `references` + `literature`; Politur P-B and P-F run beside it. Wave 2 frontend: F1 overlay layer, states, preview, keyboard list,
   toggles/settings, real-link hover (L3/L4/L5/L8/L11); F2 Back/forward history, control, keys, jump band (L6/L7).

**ADR-131 addendum 1 (security v1.6.0, low).** Queued dialog paths are checked as absolute and counted only; every consuming command
applies the same canonicalisation and scope checks it applies to a native dialog result, so the queue adds no path the user could
not have picked. The queue exists only in the acceptance build (feature `automation`); the release workflows never enable it.

## ADR-133 — Owner corpus privacy (rule 16) and range citations with a chooser

**Status:** accepted (2026-10-07, owner instruction, session "v1.7 Scan & OCR – Phase 1, Machbarkeit"; first package).

**Decisions (owner).**
1. *Rule 16.* Reports and every versioned file never name file names, titles or persons from the owner corpus (`review/owner/`).
   Owner files are referred to by stable IDs: files with an owner short code keep it as `owner-pdf-<code>` (e.g. `owner-pdf-E4`),
   all others are `corpus-NN` (two digits, by sorted file name). The only mapping is the untracked `review/owner/INDEX.md`
   (`review/` is git-ignored). Corpus tests and acceptance scripts resolve IDs (and any probe text that is personal data, such as
   address lines) through that index at run time; they skip with a clear message when it is missing. Git history is the owner's.
2. *Range citations.* A numeric range "[3–5]" links every number in the range: one detected link over the printed range whose click
   opens a small chooser (one row per entry: number + entry preview) to pick the target; a single-target range behaves like a plain
   link. Designer addendum to DESIGN §3.11 first; the chooser is a registered surface (gate).

## ADR-134 — v1.7 Scan & OCR: OS OCR integration and the invisible text layer

**Status:** accepted 2026-10-07 (owner, session "Endspurt v2.0", ADR-135); proposed in session "v1.7 Scan & OCR – Phase 1, Machbarkeit". Phase 1 = Windows spike, no UI. Design in
ARCHITECTURE.md §15. Corpus files are named by ID only (rule 16, ADR-133).

**Context.** Scans and photographed pages carry no text: no search, copy, highlight or smart links. Owner scope: an invisible text layer,
de/en, from the OS OCR (Windows.Media.Ocr, Apple Vision), with **no `unsafe` in our crate** (`[lints.rust] unsafe_code = "forbid"`
stays) or via a sidecar. Constraints: permissive deps, offline, PDFium only in `engine/`, all writing in `pdfwrite/` (lopdf),
incremental save, undo as `DocCommand`, every PDF hostile. Dev machine fact (WinRT query): `AvailableRecognizerLanguages` = `de-DE`
only, `MaxImageDimension` = 10000; English needs the OS capability `Language.OCR~~~en-US~0.0.1.0`.

**Options.**
(a) *`windows` crate in-process.* `windows` 0.62 (MIT OR Apache-2.0, already in `Cargo.lock` via Tauri) projects WinRT as safe
methods: `DataWriter::new()?.WriteBytes(&px)?; DetachBuffer()?` → `SoftwareBitmap::CreateCopyFromBuffer(&buf, Gray8, w, h)?` →
`OcrEngine::TryCreateFromLanguage(&Language::CreateLanguage(h!("de-DE"))?)?.RecognizeAsync(&bmp)?.get()?`; lines → words →
`Text()`, `BoundingRect()`. No `RoInitialize` call is needed: windows-rs activation falls back to an implicit MTA
(`CoIncrementMTAUsage`) internally. So no `unsafe` at our call sites. Risk: OCR runs native code on attacker-shaped pixels inside the app.
(b) *`objc2-vision` in-process (macOS).* Most generated Vision/Foundation methods are `unsafe fn` (block callbacks, `NSArray` casts,
`boundingBoxForRange`). Violates the rule; rejected.
(c) *Sidecar per platform.* Windows: a Rust OCR child; macOS: a Swift CLI. stdin/stdout framing, killable, crash-isolated like the
engine child.
(d) *Hybrid.* **Chosen:** Windows = (a)'s safe API **inside a second child process of our own exe** (`--sheer-ocr-child`, same pattern
as `engine_child_main`), macOS = Swift sidecar `sheer-ocr` (Tauri `bundle.externalBin`). One wire protocol, one parent module.
Why not plain (a): a WinRT/driver crash or hang would take the window with it; the child costs ~150 lines and is killable on timeout.
Why not a separate Windows exe: one more binary to sign and bundle for no isolation gain.

**Decisions.**
1. *Backends.* `ocr::backend::OcrBackend` = `WindowsChild` | `VisionSidecar` | `None`. The parent never links Vision; the Windows OCR
   code (`ocr/win.rs`, `#[cfg(windows)]`) only runs in the child. Cargo: `[target.'cfg(windows)'.dependencies] windows = { version =
   "0.62", features = ["Media_Ocr", "Graphics_Imaging", "Storage_Streams", "Globalization", "Foundation_Collections"] }` (same
   version as Tauri's, no duplicate). macOS: `sidecar/ocr-macos/` Swift package (Swift toolchain/runtime Apache-2.0 with runtime
   exception; the runtime ships with macOS, nothing bundled), `VNRecognizeTextRequest` `.accurate`, `usesLanguageCorrection = true`,
   word boxes via `boundingBox(for:)` per whitespace token.
2. *Wire* (`ocr/wire.rs`, both directions): `u32` LE header length + JSON header, then a raw blob. Request
   `{ v:1, id, w, h, stride, format:"gray8", lang:["de-DE"] }` + `w*h` bytes; reply `{ id, ok, angle, lines:[{ words:[{ t, x, y, w, h }]
   }] }` in pixel space (Vision's normalized bottom-left boxes converted in Swift). Child exits on stdin EOF.
3. *Languages.* `ocr_capabilities` lists de-DE and en-US with `available` from `AvailableRecognizerLanguages` (Windows) or
   `supportedRecognitionLanguages()` (macOS 11+, both built in). Windows recognizes one language per engine, Vision takes a list.
   Rules: (i) the requested language is used if available; (ii) if not, the other available Latin-script language runs **with a
   visible notice** in the OCR sheet ("English recognition isn't installed on this computer; German is used — some words may be
   wrong") and the layer records the language actually used; (iii) none available → the OCR command is disabled with a tooltip and a
   button "Open language settings" (`ms-settings:regionlanguage`, an OS URI, no network by us). Sheer never downloads or installs
   language packs. Default language: the document's `/Lang` if de/en, else the UI language. Phase 1 runs **de only**; en quality is
   measured later (owner installs the pack, or on macOS) and is not a phase-1 gate.
4. *Rendering.* New engine job `RenderForOcr { id, engine_index, dpi, max_side }` → existing `Raster { width, height, gray }` reply;
   annotations off, page **as displayed** (with `/Rotate`) so sideways scans read upright. Default 300 dpi; if the single page image's
   effective resolution is lower, render at that (min 200 dpi). Longest side ≤ 8000 px (below Windows' 10000; Vision has no hard
   limit); a page that would need < 150 dpi to fit is refused in v1.7.1 (`page_too_large`; tiling later). Pipelined: the engine renders
   page n+1 while the child recognizes n; at most two bitmaps in flight.
5. *Which pages.* Engine job `OcrProbe { id, pages }` → `PageOcrClass`: `Scan` (< 16 non-blank chars and image objects cover ≥ 60 %
   of the crop box), `HasTextLayer` (text exists but all of it is `Tr 3`/`7`, foreign OCR), `SheerLayer` (our key, item 7), `Text`,
   `Empty`. Default run: `Scan` pages only; "Redo" replaces `SheerLayer` pages; `HasTextLayer` and `Text` are never touched.
6. *Text layer.* Font: own minimal glyphless TrueType (`pdfwrite/ocr_font.rs`, generated by code, unitsPerEm 1000, one empty glyph,
   advance 500, ascent 800 / descent −200) as Type0 `/Identity-H`, `CIDFontType2`, `DW 500`, Flate `CIDToGIDMap` mapping every CID
   to glyph 1, `ToUnicode` one `bfrange <0000><FFFF><0000>`; codes are the UTF-16BE units of the text (BMP; other code points →
   U+FFFD, logged). Own code, no license entry; Tesseract's GlyphLessFont (Apache-2.0) is the known-good reference if PDFium disagrees.
   Per line: `BT 3 Tr /SheerOcr0 s Tf`, size `s` = line height, baseline = line bottom + 0.2 s (so PDFium's char box = OCR box); per
   word `a b c d e f Tm`, `Tz` = 100 · word width / (0.5 s · chars), hex `Tj`; each gap gets an explicit space glyph spanning it (real
   spaces in copy text, no reliance on generated ones). Rotation (`/Rotate`, OCR angle) goes into `Tm`; boxes map back from pixel to
   user space through the inverse display matrix.
7. *Where and how it is written.* `pdfwrite/ocr_layer.rs`: original `/Contents` wrapped as `[q-stream, original…, Q-stream,
   layer-stream]` (an unbalanced `q` or `cm` in the original cannot move the layer); page-local `/Resources` copy if inherited or
   shared (as ADR-125 §7); one font object set per document; page key `/SheerOcr << /V 1 /S <layer ref> /Lang (de-DE) >>`
   (`sheer_keys.rs`) for redo. Saved as an incremental update only.
8. *Model.* `DocCommand::ApplyOcr { layers: Vec<(PageId, Arc<OcrPageLayer>)> }` = one undo step per run; cancel keeps finished pages.
   `DocState.ocr_layers`. Until save, `text_layer`/`search` for those pages are answered in the app process from the layer
   (`ocr/textlayer.rs`, same shapes), so search, copy, highlight and smart links work immediately; after save the engine reads the
   real layer. Refused like ADR-125 §6: signed/certified documents (ADR-121 lock), no `modify` permission. Text editing keeps refusing
   `Tr 3` (ADR-125); v1.7.2 may convert a layer into editable text. Redaction must remove OCR words under a box, pending or saved
   (test added to the redaction suite).
9. *Security* (SECURITY.md). The OCR child/sidecar receives **only bitmaps** (gray8, bounded: side ≤ 8000, ≤ 40 M px, stride checked)
   and a language tag from an allowlist; never bytes of the PDF, never paths. Replies are untrusted: header ≤ 8 MiB, ≤ 20 000
   words/page, ≤ 128 chars/word, control chars stripped, NFC, boxes clamped to the image, non-finite numbers refused. 30 s per page,
   then kill + restart (budget as engine: 5 per 10 min). Sidecar path resolved by Tauri from the bundle only. No network.
10. *Build/CI.* Windows: nothing new to bundle. macOS: CI job builds `sheer-ocr` universal (`swiftc` arm64 + x86_64, `lipo`) into
    `src-tauri/binaries/sheer-ocr-universal-apple-darwin`; ad-hoc signed until B-002. Signing and notarization of the sidecar
    (hardened runtime, same identity as the app) ride on **B-002** (the brief named B-005; B-005 is the updater key, which only affects
    delivering the sidecar via updates). OCR tests needing a recognizer are `#[ignore]` unless `SHEER_OCR=1`; protocol, layer writer
    and mapping tests are pure and always run.
11. *Performance targets* (dev machine, 300 dpi A4): p50 ≤ 1.5 s, p95 ≤ 3 s per page end to end; OCR child RSS ≤ 300 MB;
    500-page document runs in the background, cancellable, progress push per page, UI stays at 60 fps.

**Phase 1 (spike, Windows, de, no UI).** `src-tauri/examples/ocr_spike.rs` resolves 5 scanned owner PDFs by ID through
`review/owner/INDEX.md`, runs probe → render → child OCR → layer → incremental save to the Claude temp folder, re-opens with PDFium and
writes a JSON metrics file. Exit criteria (all must hold; report by ID only):
1. Build, clippy `-D warnings` and `cargo deny` green with `windows` features added; `unsafe_code = "forbid"` untouched.
2. OCR quality: word accuracy ≥ 95 % on a hand-checked 200-word sample per file.
3. Search: ≥ 95 % of 20 probe words per file found by the engine's `SearchPage` on the saved file; copying a line through
   `TextLayer` equals the OCR line text (whitespace-normalized) on ≥ 95 % of lines; no doubled spaces.
4. Selection: each edge of PDFium's char-box union per word within **1.5 pt** of the OCR box for ≥ 95 % of words, including one
   `/Rotate 90` page (synthetic if the corpus has none).
5. Incremental and invisible: original bytes are a prefix of the saved file; the page renders pixel-identical at 150 dpi.
6. Timing: targets of item 11 met; probe classifies all 5 files' pages correctly (`Scan`).
7. Robustness: killing the child mid-page fails that page only and restarts; a malformed header is refused.
Failing 2 → raise dpi/try Bgra8 and re-measure once; failing 3/4 → change the layer geometry, not the backend; failing 1 → stop and
ask the owner (a separate crate allowing audited `unsafe` would need a rule change).

**Consequences.** Windows gains one direct dep (`windows`, MIT OR Apache-2.0, logged in `docs/LICENSES.md`), macOS a Swift sidecar to
build and sign; English OCR on Windows depends on an OS pack the user installs, which the UI says plainly. Scans become searchable
without changing their look; saves stay incremental.

## ADR-135 — Session "Endspurt v2.0": a chain of five topics, owner defaults

**Status:** accepted (2026-10-07, owner instruction; session "Endspurt v2.0").

**Context.** The owner chains five topics in one session (ADR-122 normally allows one): v1.7 part 1 (Windows OCR, v1.7.0-beta.1),
v1.7 part 2 (macOS Vision sidecar, v1.7.0), v1.8 context help (v1.8.0), v1.9 backlog (v1.9.0), v2.0-rc.1 (pre-release). Each part
ends with a German report in `docs/reports/` and a release; the next part starts right away. STOP only at the end or on a blocker only a
human can solve (then `STATE.md` holds the exact question). Tempo level 3 (ADR-128), rules 13–16 unchanged.

**Decisions (owner defaults, recorded so no question is needed).**
1. *Scope vs. finish:* finish wins every time; Should features go to a new ROADMAP section "v2.1 backlog".
2. *OCR (ADR-134 accepted).* The recognition language follows the **UI language** (de → de-DE, en → en-US); this replaces ADR-134 §3's
   "document `/Lang` first". The fallback notice and the "language settings" path of ADR-134 §3 stay. The owner supplied no real scans
   and no English pack: acceptance uses self-generated image-only PDFs (generated by a repo script under `review/`) plus the real scan
   page of owner-pdf-F2; English recognition on Windows stays unverified and is named in the report. v1.7.2 (OCR text as editable
   paragraphs) and skew correction beyond the engine's reported angle move to the v2.1 backlog.
3. *macOS (part 2).* The Swift sidecar is built and tested in CI only; the report states that a human Mac check is pending (B-001).
4. *Context help (v1.8).* Tips on by default; four situations (first highlight, first form, first signature, Pages mode); at most one tip
   per situation; a switch in Settings turns them off. Clips are 3 s, recorded from the acceptance build by window capture (rule 13).
5. *v1.9.* Stamps: predefined set plus own text, colours Solar Yellow and Ink. Header/footer: default page number + date. Comment export
   as a PDF summary and as Markdown. Fifth citation style "Deutsche Zitierweise": footnote with the full reference at the first
   citation of a source, short reference afterwards; faculty-specific rules are later polish.
6. *v2.0-rc.1.* All open polish tickets, final security audit with the fuzz corpus, performance budget re-measured, accessibility with
   a screen-reader pass, and a list of open owner decisions collected from every report since v1.5 in the final report. Pre-release.

**Addendum 1 (designer, DESIGN §3.12).** One OCR command "Recognize text…" in the Tools menu; a banner in the existing slot offers it
when scan pages are found; Pages mode only preselects "Selected pages" (its tool row is full). The command stays enabled when no
language is installed so the dialog can show "Open language settings". Save, Done, tab close and page-structure changes are disabled
during a run. Banner priority: redact > signature > OCR progress > form > OCR offer.

**Addendum 2 (owner, 2026-10-07, mid-session).** The chain ends after part 1: v1.7 part 1 closes with the pre-release v1.7.0-beta.1
and its report, then STOP. Parts 2–5 (macOS sidecar, v1.8, v1.9, v2.0-rc.1) are not started in this session; their ROADMAP items stay
open for later sessions.
