# Architecture

Decisions: ADR-001…004 in `docs/DECISIONS.md`. This file lists the modules, every Tauri command and the data flows. A new
command must be added here together with a bounds test.

Terms: a **Tauri command** is an IPC function, a **`DocCommand`** is an undoable edit (ADR-003), and an **action** is a UI command bound to a
menu item or shortcut.

## 1. Threads

| Thread | Owns | Never |
|---|---|---|
| Tauri main | event loop, windows, menu, drag-drop/open events | PDF work, blocking IO |
| tokio tasks | `async` commands: validate → registry → engine | PDFium calls |
| `sheer-pdfium` | `Pdfium`, open `PdfDocument`s, `ReplaceFile` | lopdf |
| `sheer-watchdog` | job deadlines | — |
| blocking pool | lopdf save, backup, recents, autosave | PDFium |

## 2. Rust modules (`src-tauri/src/`)

```
main.rs          sheer_lib::run()
lib.rs           builder: plugins, manage(AppState), invoke_handler, DragDrop/Opened hooks, menu
state.rs         AppState { registry, engine, settings, recents }
error.rs         AppError (internal) → UiError (IPC)
limits.rs        every numeric bound as a const
commands/        thin: validate → registry/engine → UiError
                 app · documents · render · text · links · edit · pages (M3) · forms (M4) · export (M6) · recovery (M7)
documents/       registry (DocumentRegistry, DocumentEntry) · intake (path checks, Rust-side dialogs) · recents
engine/          the only PDFium user (ADR-002)
                 mod (EngineHandle, EngineRequest/Response) · worker · queue · guard (catch_unwind, watchdog)
                 render · text · search · links · import (annotations → model) · forms (M4) · transport (M7)
model/           engine-free domain (ADR-003)
                 ids · geometry · annotation · page · command · history · doc_state · validate
pdfwrite/        the only lopdf user (ADR-004)
                 save · annots · appearance · coords · pagetree (M3) · crypt (M5)
storage/         atomic (temp + fsync + rename) · backup · settings · app_dirs · autosave (M7)
security/        links (http/https/mailto allowlist) · names (display-name sanitizer)
platform/        macos (reduced transparency flag) · windows
```

Import rules, checked by a CI grep:
- `pdfium_render` appears only in `engine/`.
- `lopdf` appears only in `pdfwrite/`.
- `model/` imports neither.
- `commands/` never touches either library directly.

## 3. Frontend modules (`src/`)

```
api/          call.ts (the one `invoke` caller) · app.ts, documents.ts, … (one typed wrapper per command) · errors.ts · frame.ts · types.gen.ts (ts-rs, generated)
engine/       renderCache.ts (Blob LRU) · renderScheduler.ts (dedupe, generations, set_viewport) · textCache.ts
stores/       documents · view · annotations · tools · search · ui · settings · recents
features/     shell (Shell, CaptionBar, ToolbarSlot, ToolbarRow, LeftPanel, MainGrid, Inspector, StatusBar, EmptyState, BannerRow: the app shell of DESIGN 2; grid rules in lib/layout.ts)
              viewer (Canvas, ViewerCanvas, useViewer (store: open document, page image, render loop), PageView, layout.ts, TextLayer, LinkLayer, zoom.ts)
              annotations (Overlay SVG, tools/, Inspector, geometry.ts, ink.ts, textWrap.ts)
              thumbnails · outline · search · comments · pages (M3) · forms, signatures (M4)
actions/      action registry: shortcuts, menu ids
components/   design-system primitives (Phase 3)
i18n/ · styles/tokens.css
```

Only `src/api/call.ts` calls `invoke`: it turns every rejection into an `AppError`, and the typed wrappers (`src/api/app.ts`, `documents.ts`, …) go through it. Everything else imports the wrappers. The window has no event permission (SECURITY T3), so the frontend never calls `listen` or `emit`, and `src/api/app.test.ts` fails on any import of `@tauri-apps/api/event`. Backend pushes (§6) reach it through a `Channel` that a wrapper in `src/api/` passes to a command (`watchTransparency` → `watch_transparency`; the settings store consumes it).

## 4. Document registry

```rust
pub struct DocumentRegistry { next_id: AtomicU32, docs: RwLock<HashMap<DocId, Arc<DocumentEntry>>> }
pub struct DocumentEntry {
    pub id: DocId,
    path: PathBuf,                               // canonical, private, never serialized
    pub display_name: String,                    // file name only, sanitized, ≤ 255 chars
    fingerprint: Mutex<Fingerprint>,             // len + mtime at open/save
    password: Mutex<Option<Zeroizing<String>>>,
    pub flags: RwLock<DocFlags>,                 // encrypted, signed, certified, xfa, has_forms
    pub state: Mutex<DocState>,                  // pages, annotations, history, rev
}
```

A path enters the backend only from the Rust-side dialog, `WindowEvent::DragDrop`, `RunEvent::Opened` (macOS), argv or a second instance
(Windows), or a recents entry. `documents::intake` then: canonicalizes → requires a regular file ≤ 2 GiB with `%PDF-` in its first 1024
bytes → dedupes by canonical path (returns the existing id) → sends `Open` to the engine. At most 32 documents are open; ids are never reused
in a session.

The frontend never uses `onDragDropEvent` and cannot receive the `tauri://drag-drop` event that carries the paths: `dragDropEnabled` is `true` on purpose (explicit in `tauri.conf.json`, pinned by `security_baseline.rs`), so Tauri takes the OS drop itself and hands the paths only to Rust's `WindowEvent::DragDrop` handler, and the window has no event permission (SECURITY T3, T9). Rust re-sends `drop:hover` without paths.
Recents store paths in app data. The UI sees only `RecentEntry { id, displayName, lastOpened, missing }`.

## 5. Tauri commands

All commands are `async` and return `Result<T, UiError>`. Bounds come from `limits.rs`. A violation returns `invalid_argument` or
`limit_exceeded`, and an unknown id returns `not_found`.

```rust
// app
app_ready() -> AppBootstrap                          // platform, reducedTransparency, version (pending opens join in M1)
get_settings() -> Settings                           // { glass: "auto" | "solid", theme: "system" | "light" | "dark", leftPanelWidth: 192..=400 }
update_settings(patch: SettingsPatch) -> Settings    // patch { glass?, theme?, leftPanelWidth? }; unknown key, enum value or width outside the range → invalid_argument (what: "settings")
watch_transparency(on_change: Channel<bool>) -> ()   // each change of the OS "Reduce transparency" flag, as a bare bool; one receiver, a new call replaces it
// documents
open_document_dialog() -> Vec<OpenResult>            // ≤ 32 files
open_recent(recent_id: u32) -> OpenResult
list_recents() -> Vec<RecentEntry>                   // ≤ 50
remove_recent(recent_id: u32) -> ()
unlock_document(doc_id: DocId, password: String) -> DocumentInfo        // 1..=1024 bytes
get_document_info(doc_id: DocId) -> DocumentInfo
close_document(doc_id: DocId, discard: bool) -> ()                      // dirty && !discard → unsaved_changes
save_document(doc_id: DocId, ack: SaveAck) -> SaveResult
save_document_as(doc_id: DocId, opts: SaveAsOptions, ack: SaveAck) -> Option<SaveResult>  // None = cancelled
revert_document(doc_id: DocId) -> DocumentInfo
get_outline(doc_id: DocId) -> Vec<OutlineNode>       // ≤ 10 000 nodes, depth ≤ 32, title ≤ 512 chars
// render
render_page(req: RenderRequest) -> tauri::ipc::Response   // frame, ADR-002 §6
set_viewport(doc_id: DocId, hint: ViewportHint) -> ()
// text, search, links
get_text_layer(doc_id: DocId, page_id: PageId) -> TextLayer   // ≤ 200 000 chars
search(doc_id: DocId, query: SearchQuery, on_event: Channel<SearchEvent>) -> u32
cancel_search(search_id: u32) -> ()
get_page_links(doc_id: DocId, page_id: PageId) -> Vec<LinkInfo>     // ≤ 1 000
open_link(doc_id: DocId, page_id: PageId, link_index: u32) -> ()    // URL re-read in Rust; http, https, mailto
// edit (ADR-003)
list_annotations(doc_id: DocId, pages: Option<Vec<PageId>>) -> Vec<Annotation>
apply_command(doc_id: DocId, cmd: DocCommand, coalesce_key: Option<String>) -> ChangeSet  // key ≤ 64 chars
undo(doc_id: DocId) -> ChangeSet
redo(doc_id: DocId) -> ChangeSet
```

Key types (serde `camelCase`; ts-rs generates the TS):

```rust
struct RenderRequest { doc_id: DocId, page_id: PageId, bucket: i16 /* -17..=24 */, tile: Option<(u16, u16)> /* ≤ 63 */,
                       priority: Priority /* Visible | Near | Thumbnail */, generation: u32, forms: bool }
struct ViewportHint  { generation: u32, visible: Vec<PageId> /* ≤ 64 */, near: Vec<PageId> /* ≤ 64 */ }
struct SearchQuery   { text: String /* 1..=512 chars */, match_case: bool, whole_word: bool, max_hits: u32 /* ≤ 50 000 */ }
enum   SearchEvent   { Hits { page_id: PageId, hits: Vec<Vec<Quad>> }, Progress { done: u32, total: u32 }, Done { truncated: bool } }
struct SaveAck       { break_signature: bool, file_changed: bool, rewrite_encrypted: bool }
struct TextLayer     { text: String, boxes: Vec<f32> /* x, y, w, h per char, page space */, truncated: bool }
struct LinkInfo      { index: u32, rect: Rect, target: LinkTarget /* Page { page_id, y } | Url { url ≤ 2048 } | Blocked */ }
struct OpenResult    { doc_id: DocId, status: OpenStatus /* Ready | NeedsPassword */, info: Option<DocumentInfo> }
struct DocumentInfo  { doc_id: DocId, display_name: String, pages: Vec<PageSlotInfo>, rev: u32, flags: DocFlags, history: HistoryState }
struct PageSlotInfo  { id: PageId, width: f32, height: f32 /* pt, unrotated CropBox */, rotation: u16, rev: u32, label: Option<String> }
struct SaveResult    { rev: u32, mode: SaveMode /* Incremental | Full */, backup_created: bool }
struct AppBootstrap  { platform: Platform /* macos | windows | linux */, reduced_transparency: bool, version: &'static str }
struct Settings      { glass: GlassMode /* Auto | Solid */, theme: ThemeMode /* System | Light | Dark */ }   // serde lowercase values
```

**Settings.** `storage::settings` keeps the settings in memory and in `<app data dir>/settings.json`. A missing, oversized (> 64 KiB), damaged
or hand-edited file never blocks start: only a regular file is read (its type is taken from the opened handle, not from the path, and on Unix it is opened
`O_NONBLOCK` so a FIFO cannot hang the start), and each field that is invalid falls back to its default. `update_settings`
takes the patch as raw JSON, validates all of it first (an object that passes a `deny_unknown_fields` struct, so at most `glass` and `theme`, with
known enum values) and writes it with `storage::atomic::write_atomic`: a temp file `.settings.json.<pid>.<n>.tmp` (process id and a per-process counter, so no two
writers share one) is created with `create_new` (a name that is taken is skipped, never written through; mode `0600` on Unix, directories `0700`), fsynced,
renamed over the file, and the directory is fsynced on Unix. Only after the write succeeds does the
in-memory copy change, so a failed write leaves memory and disk in agreement. Updates are serialised by a writer lock that is held across the
write; the lock that guards the in-memory copy is not, so `get_settings` never waits for the disk.
`reducedTransparency` is the macOS "Reduce transparency" flag (`NSWorkspace.accessibilityDisplayShouldReduceTransparency`, `platform::macos`);
elsewhere it is `false` and CSS `prefers-reduced-transparency` covers the platform. The frontend turns settings and flag into
`html[data-theme]` and `html[data-transparency="reduced"]` (`src/stores/settings.ts`, DESIGN §1). On macOS the flag is live: when the window gains
focus (the setting is changed in System Settings, so the app was in the background) `platform::on_window_event` re-reads it and, if it changed,
sends the new value over the channel the UI opened with `watch_transparency` (§5, §6), which the settings store mirrors. Startup does not wait for the backend: `src/main.tsx` renders with the defaults at
once and `loadSettings` applies the stored settings when they arrive (after 3 s without an answer the defaults stay and a late answer still applies).

Launch, GoToR and JavaScript actions map to `Blocked`. The UI's confirm dialog shows the URL, and `open_link` re-reads the URL from the
document. The frontend therefore cannot make Rust open an arbitrary URL.

`model::validate` bounds on `DocCommand`:
- Coordinates are finite and within ±14 400 pt.
- Quads ≤ 4 096. Ink ≤ 256 strokes, ≤ 10 000 points per stroke, ≤ 100 000 points in total.
- Contents ≤ 32 768 chars. Author ≤ 256 chars. Free text ≤ 8 192 chars, WinAnsi only.
- Font size 4–144. Widths 0.25–72 pt. Opacity 0.05–1.
- Batch ≤ 1 000 commands. Page lists are unique and existing.

A render frame is at most 4096×4096 px, checked after the bucket and tile are resolved.

**Planned commands.** The milestone ADR fixes the exact signatures; the same rules apply, and output paths come from a Rust-side save dialog.
M3: `extract_pages`, `split_document`, `merge_documents`, `insert_pages_from_file`, `compress_document`. M4: `get_form_fields`,
`list_signatures`, `save_signature`, `delete_signature`. M5: `set_protection`, `remove_protection`, `get_metadata`, `set_metadata`.
M6: `export_images`, `print_document`, `reveal_in_folder`. M7: `list_recoverable`, `restore_autosave`, `discard_autosave`.

## 6. Pushes (Rust → UI, never with paths)

The webview has no event permission (SECURITY T3): it cannot `listen` to or `emit` events. A push reaches it as a message on a `tauri::ipc::Channel` that the
UI passes to a command, like `search(.., on_event: Channel<SearchEvent>)`. The first one is implemented: `watch_transparency(on_change: Channel<bool>)` sends
each change of the macOS "Reduce transparency" flag (checked when the window gains focus) as a bare bool; a value that already differs from what `app_ready`
reported is sent on subscribing. The planned notifications are delivered the same way (a channel opened by a command, typed messages, no paths), unless an ADR grants
`listen` for a named event: `doc:opened {docId}` (drop, file association, second instance) · `doc:reloaded {docId, rev}` · `doc:annotations-imported {docId, pageIds}` ·
`drop:hover {active, count}` · `engine:status {state: ok | wedged}` · `menu:action {id}`.

## 7. Error model

```rust
#[derive(thiserror::Error, Debug)]
pub enum AppError { Io(std::io::Error), Pdfium(String), Lopdf(String), Invalid(&'static str),
                    Limit { what: &'static str, max: u64 }, NeedsConfirmation(Reason), /* … */ }
#[derive(Serialize)] #[serde(rename_all = "camelCase")]
pub struct UiError { code: ErrorCode, params: Option<UiParams>, retryable: bool }
```

`impl From<AppError> for UiError` is the only way an error reaches IPC. It logs the full error locally (`log`, default level warn, details
only at opt-in debug, never document content or passwords). It emits only a code plus whitelisted params (page number, limit, display name).
TS maps `code` to the i18n key `error.<code>`. A unit test serializes every variant and asserts there are no path separators, drive letters
or debug text.

Codes: `invalid_argument`, `limit_exceeded`, `not_found`, `not_a_pdf`, `damaged_file`, `too_large`, `unsupported_feature`,
`password_required`, `password_incorrect`, `unsaved_changes`, `needs_confirmation` (`reason`: `breaksSignature`, `fileChangedOnDisk`,
`rewriteEncrypted`), `save_failed`, `io_permission_denied`, `io_not_found`, `io_in_use`, `io_disk_full`, `engine_timeout`,
`engine_crashed`, `engine_unavailable`, `cancelled` (UI stays silent), `internal`.

## 8. Zustand stores (`src/stores/`)

| Store | Holds | Changed by |
|---|---|---|
| `documents` | `byId: Record<DocId, DocMeta>` (displayName, pages, rev, flags, history), `order`, `activeId` | open/close, events, ChangeSet |
| `view` | per doc: zoom, fit, scrollMode, viewRotation, anchor `{ pageId, offset }`, currentPage (today: zoom, pageIndex, pageCount) | canvas, toolbar, status bar |
| `annotations` | per doc: `byId`, `byPage`, `selection`, `editing` (transient draft) | ChangeSet; `editing` locally |
| `tools` | active tool, locked, presets per tool | toolbar, actions |
| `search` | per doc: query, hits by page, active hit, status | search Channel |
| `ui` | left panel tab/width/collapsed, inspector mode, active tool (moves to `tools` in M2), drop-hover flag, error banner, dialogs, toasts, engine status | UI, events |
| `settings` | mirror of Rust settings | `get_settings`/`update_settings` |
| `recents` | `RecentEntry[]` | `list_recents`/`remove_recent` |

Rules:
- Stores hold no pixels. The render cache and text cache are module singletons.
- Document and annotation data change only through ChangeSets and events, never optimistically.
- Page components subscribe through per-page selectors, so re-renders stay local.

## 9. Data flows

- **Open.** Action → `open_document_dialog` (Rust dialog) → `intake` → engine `Open` (Control: page sizes, flags) → registry →
  `OpenResult` → `documents` store → `layout.ts` offsets → visible pages render. Annotation import runs Interactive for visible pages and
  Background for the rest; `doc:annotations-imported` triggers `list_annotations`.
- **Render.** Scroll → visible range → mount ≤ 24 pages. A cache hit shows `<img src=blob:>`. A miss calls `render_page` (Visible) → the
  worker renders and encodes → frame → Blob → cache → `img.decode()` → swap. When scrolling settles, `set_viewport` cancels stale jobs.
- **Annotate.** A pointer gesture builds a draft in `annotations.editing`. On pointerup, `apply_command(CreateAnnotation)` → validate,
  apply, push history → ChangeSet → store → overlay. A persisted annotation that becomes non-clean is hidden in PDFium, `pageRev`
  increments, and the page re-renders.
- **Undo.** Ctrl/⌘+Z → `undo` → inverse applied → ChangeSet (same path).
- **Save.** Ctrl/⌘+S → `save_document` (no ack). On `needs_confirmation` the UI shows a dialog and retries with `ack` → ADR-004 pipeline →
  `SaveResult` + `doc:reloaded` → store marked clean; the new `pageRev` keys refresh the images.

## 10. Spike alignment

The spike layout (`lib.rs`, `main.rs`, `error.rs`, `engine/`, `commands/`, `documents/`) stays and is extended with `state.rs`,
`limits.rs`, `model/` and `storage/` in M1, and `pdfwrite/` in M2. The spike needs a refactor wherever it does one of these:

| If the spike… | Required change |
|---|---|
| keeps PDFium in managed state or calls it from command tasks | move it into `engine::worker`; commands use `EngineHandle` |
| takes a path from JS, e.g. `open_document(path)` | replace with `open_document_dialog`. A path-taking command must not exist in release builds and is removed before the first security-reviewer run |
| returns images as base64 or JSON | switch to the `ipc::Response` frame |
| returns `String` errors | switch to `AppError` → `UiError` |
| has sync commands | make them `async` |
| addresses pages by index | address them by `PageId` (identity mapping until M3) |
