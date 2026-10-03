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
| blocking pool | lopdf save, backup, recents, autosave, page jobs (extract, split, merge, compress; ≤ 2) | PDFium |

## 2. Rust modules (`src-tauri/src/`)

```
main.rs          sheer_lib::run()
lib.rs           builder: plugins (single-instance first, Windows only), manage(AppState, AppEvents), invoke_handler, DragDrop/Opened hooks, startup arguments, menu bar (macOS)
events.rs        AppEvent (dropHover | opened | needsPassword | openFailed: the typed pushes) · AppEvents (the receiver of subscribe_app, and the open results that came before it)
sources.rs       every way a path enters besides the dialog: WindowEvent::DragDrop, RunEvent::Opened (macOS), the command line and a second instance (Windows); each ends in documents::intake
state.rs         AppState { registry, engine, settings, recents }
error.rs         AppError (internal) → UiError (IPC)
limits.rs        every numeric bound as a const
commands/        thin: validate → registry/engine → UiError
                 app · documents · render · outline · text · search · links · edit · pages (M3) · forms, signatures (M4) · export (M6) · recovery (M7)
documents/       sources (M3: `SourceRegistry`, import bytes in memory, ADR-036 §4) · registry (the table of open documents: claim = dedupe by canonical path, abandon = the arbiter of an open that outlives its deadline) · intake (admit: canonicalize, open once, judge the handle; command-line and URL parsing; the dialog is in commands/) · recents
engine/          the only PDFium user (ADR-002)
                 mod (Engine, Job) · worker (open, frames and tiles, page sizes) · queue (priority, cancellation by viewport, dedupe: ADR-018) · guard (catch_unwind, deadlines) · encode (frames)
                 pages (M3: rotate, append blank, import pages; append-only) · text (the layer, and the one reading of a page's characters) · search (one page: the page's text, found by `model::find`) · links · outline · space (pages and destinations in page space) · import (annotations → model; M4: `sheer-*` `/NM` → signature, mark) · transport (M7). Forms are not read here (ADR-041); widgets render from their file appearance
model/           engine-free domain (ADR-003)
                 geometry (Point, Rect, Quad, PageBox) · find (text search) · reading (what the UI is told about content) · ids · annotation · page · command · history · doc_state · validate (the first three exist)
pdfwrite/        the only lopdf user (ADR-004)
                 save · annots · appearance · coords · pagetree (M3: tree rewrite, page deep copy) · produce (M3: extract, split, merge) · compress (M3: `image`, jpeg only) · forms (M4: read_fields, write_values, field appearances) · flatten (M4) · content (M5: burn text boxes and images into pages) · redact (M5: raster page, redacted Full save) · crypt (M5: R6 encrypt, keep encryption) · metadata (M5: Info + regenerated XMP)
content/         M5, engine-free and lopdf-free: text (layout, WinAnsi check) · std14 (AFM widths of Helvetica, Times-Roman, Courier) · image (dialog handle → header check → decode → JPEG/Flate asset)
signatures/      M4, engine-free and lopdf-free: art (normalise, simplify, bounds) · typed (skrifa + bundled font → polygons) · image (dialog handle → `image` decode → RGBA → PNG) · drafts (DraftStore, ≤ 16)
storage/         atomic (temp + fsync + rename) · backup · settings · app_dirs · signatures (M4: library.bin, XChaCha20-Poly1305) · keychain (M4: `SecretStore` over keyring-core) · autosave (M7)
security/        links (http/https/mailto allowlist, `SafeUrl`) · names (display-name sanitizer; today `documents::sanitize_text`)
menu/            macOS menu bar (ADR-016): mod (MenuBridge: the channel to the UI, the id allowlist, build + rebuild on a language change) · spec (layout of src/actions/menu.json, texts of the UI catalogs, ACTION_IDS)
platform/        macos (reduced transparency flag) · windows
```

Import rules, checked by a CI grep:
- `pdfium_render` appears only in `engine/`.
- `lopdf` appears only in `pdfwrite/`.
- `model/` imports neither.
- `commands/` never touches either library directly.

## 3. Frontend modules (`src/`)

```
api/          call.ts (the one `invoke` caller) · app.ts, documents.ts, render.ts (render_page, set_viewport, get_page_sizes), outline.ts · text.ts · search.ts · links.ts (the read commands: each parses what the backend answers and treats a wrong shape as `internal`; `wire.ts` holds the page-space shapes and number checks they share), … (one typed wrapper per command) · errors.ts · frame.ts · types.gen.ts (ts-rs, generated)
engine/       buckets.ts (zoom buckets, tiles: pure) · renderCache.ts (Blob LRU, pins, in-flight dedupe, object URLs) · renderScheduler.ts (generations, set_viewport, quiet cancels) · textCache.ts
stores/       documents · view · pages · annotations · tools · search · ui · settings · recents
features/     shell (Shell, CaptionBar, ToolbarSlot, ToolbarRow, LeftPanel, MainGrid, Inspector, StatusBar, EmptyState, BannerRow: the app shell of DESIGN 2; grid rules in lib/layout.ts)
              viewer (Canvas (the DOM: scroll region, wheel, pinch), ViewerCanvas (layout, the mounted pages, anchors), PageView (placeholder, cached image, tiles), layout.ts (pure: rows, boxes, virtual window, anchors, fits), model.ts, scrollBridge.ts, useDevicePixelRatio, useViewer (store: the actions, the canvas's size, whether a render runs; the open documents are the `documents` store), appEvents (what the backend pushes), TextLayer, LinkLayer; zoom steps and limits are `lib/zoom.ts`)
              annotations (Overlay SVG, tools/, Inspector, geometry.ts, ink.ts, textWrap.ts)
              thumbnails · outline · search · comments · pages (M3) · forms, signatures (M4)
actions/      the one command registry (ADR-016): registry.ts (every action: id, labelKey, icon, per-platform shortcut, enabled(state), run()) · shortcut.ts (bindings: platform modifier, key matching, chips, aria, native accelerator) · keys.ts (the global key handler) · dispatch.ts (runAction) · state.ts (what enabled looks at) · menuBridge.ts (macOS menu commands in) · menu.json (layout of the macOS menu bar, read by Rust too)
components/   design-system primitives (Phase 3)
i18n/         locales/en.json + de.json (flat dotted keys, pure JSON, identical key sets; the one source of UI text, later also read by Rust for native menu labels) · catalog.ts (key types from en.json: an unknown key fails tsc) · translate.ts (typed t(key, params), {name} placeholders, plurals via Intl.PluralRules: base key + .one/.other, needs count) · format.ts (Intl numbers, percent) · store.ts, bind.ts (UI locale follows settings.language; "system" = navigator.language, de* is German; sets <html lang>) · errors.ts (error.<code>[.<what>])
styles/tokens.css
```

Only `src/api/call.ts` calls `invoke`: it turns every rejection into an `AppError`, and the typed wrappers (`src/api/app.ts`, `documents.ts`, …) go through it. Everything else imports the wrappers. The window has no event permission (SECURITY T3), so the frontend never calls `listen` or `emit`, and `src/api/app.test.ts` fails on any import of `@tauri-apps/api/event`. Backend pushes (§6) reach it through a `Channel` that a wrapper in `src/api/` passes to a command (`watchTransparency` → `watch_transparency`; the settings store consumes it. `subscribeMenu` → `subscribe_menu`; `src/actions/menuBridge.ts` consumes it. `subscribeApp` → `subscribe_app`; `src/features/viewer/appEvents.ts` consumes it: the drop overlay follows `dropHover`, `opened` and `openFailed` go to `adoptOpenOutcomes`, the same function that takes the answer of the open dialog).

**Commands and keys.** A command is an action of `src/actions/registry.ts` and nothing else defines one. The toolbar's items (name, icon, shortcut chip, `aria-keyshortcuts`, enabled), the More menu, the global key handler and the macOS menu bar's commands are all derived from it or run through `runAction(id)`, which refuses an unknown id and a disabled action: there is no second shortcut table. A shortcut is a canonical binding (`{ key, mods }`, `primary` = Cmd on macOS and Ctrl elsewhere, a different one on macOS where research says so), resolved per platform. The key handler (`keys.ts`) takes no key from a text field or an event that is already handled, runs a bare printable key (the tool letters) only while focus is inside the canvas (`data-action-scope="canvas"`), and takes the browser's meaning away from every key it binds. `enabled` reads flags (`hasDocument`, the two zoom limits), not the zoom or the page, so the toolbar keeps its render isolation (ADR-015).

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

Today the registry (`documents::Registry`) holds, per id, the canonical path, the display name, the page count (`None` while the engine is still loading) and the flags (`DocFlags { encrypted, xfa, has_forms, signed }`, what PDFium said when it loaded the document: best effort, read once by the worker and kept with the page sizes until the document is released); the other fields arrive with the features that need them.

A path enters the backend only from the Rust-side dialog, `WindowEvent::DragDrop`, `RunEvent::Opened` (macOS), argv or a second instance
(Windows), or a recents entry (`sources.rs` and `commands::open_document_dialog`). `documents::intake::admit` then: canonicalizes → **opens the
file once** → judges that handle: a regular file ≤ 2 GiB with `%PDF-` in its first 1024 bytes (not a directory, device or FIFO; the open never
waits on a pipe) → `Registry::claim` dedupes by canonical path (a file that is open already answers with its existing document; one that is still
loading is not started a second time) → the engine receives the **same handle** (`Engine::open(id, file, confirm)`, PDFium `load_pdf_from_reader`).
No path is opened twice, so there is no gap between the check and the use in which another file could be put at the path. At most 32 documents are
open (new ids only: an open document can always be asked for again) and at most 32 files are taken from one source at a time, the rest being one
`limit_exceeded`; ids are never reused in a session. Every file of a batch is judged on its own: a bad one is an `openFailed`, the others still open.

**A worker stuck past its deadline.** A running PDFium call cannot be interrupted. The first caller that finds the worker past its deadline gets `engine_unavailable` and replaces it (`Engine::recover`, ADR-028): a new worker on a new queue; the old one serves nothing more and leaks its PDFium state if it ever returns. Documents of the old worker answer `engine_crashed` until closed and must be reopened; their page sizes stay readable until then. The engine process of M7 replaces this.

**An open that outlives its deadline.** The worker cannot be interrupted, so an open can finish after its caller gave up (`engine_timeout`). The
caller then takes its registry entry back with `Registry::abandon`; the worker, once the document is loaded, asks the job's `confirm` callback, which
records the page count in the registry in one step (`set_page_count`) and fails if the entry is gone. Under the registry's one lock either the
confirmation comes first and the open succeeded after all (`Abandoned::Loaded`: the caller reports the document), or the abandonment comes first and
the worker drops the document and its handle (`Removed`). No document is ever left in the engine without a registry entry; a late `close` could not
reach it, because a stuck engine refuses new jobs.

The frontend never uses `onDragDropEvent` and cannot receive the `tauri://drag-drop` event that carries the paths: `dragDropEnabled` is `true` on purpose (explicit in `tauri.conf.json`, pinned by `security_baseline.rs`), so Tauri takes the OS drop itself and hands the paths only to Rust's `WindowEvent::DragDrop` handler, and the window has no event permission (SECURITY T3, T9). Rust tells the page `dropHover { active }` over the app channel (§6), without paths; what the drop opens arrives as `opened` or `openFailed`.
Recents store paths in app data. The UI sees only `RecentEntry { id, displayName, folder (parent folder's name only, never a path), lastOpened, missing }`.

## 5. Tauri commands

All commands are `async` and return `Result<T, UiError>`. Bounds come from `limits.rs`. A violation returns `invalid_argument` or
`limit_exceeded`, and an unknown id returns `not_found`.

```rust
// app
app_ready() -> AppBootstrap                          // platform, reducedTransparency, version
get_settings() -> Settings                           // { glass: "auto" | "solid", theme: "system" | "light" | "dark", language: "system" | "en" | "de", leftPanelWidth: 192..=400 }
update_settings(patch: SettingsPatch) -> Settings    // patch { glass?, theme?, language?, leftPanelWidth? }; unknown key, enum value or width outside the range → invalid_argument (what: "settings")
watch_transparency(on_change: Channel<bool>) -> ()   // each change of the OS "Reduce transparency" flag, as a bare bool; one receiver, a new call replaces it
subscribe_menu(on_action: Channel<String>, system_language: Option<String>) -> ()
                                                     // each command chosen in the macOS menu bar, as the bare id of the item (kebab-case, `menu::spec::ACTION_IDS` only: system items and any other id are dropped in Rust); one receiver, a new call replaces it; system_language = navigator.language, for the menu's labels while language is "system" (a malformed tag counts as unknown); a no-op listener on Windows, which has no menu bar
subscribe_app(on_event: Channel<AppEvent>) -> ()
                                                     // the backend's pushes, as typed `AppEvent`s without paths: `dropHover { active }` while files are dragged over the window, `opened { document: DocumentInfo }` and `openFailed { code, key, retryable, params? }` for a file opened by a drop, the OS (file association) or a second launch; open results that came before the UI subscribed (a file the app was started with is opened while the window loads) are sent first, in order, once; one receiver, a new call replaces it
// documents
open_document_dialog() -> Vec<AppEvent>             // multi-select, ≤ 32 files, in the dialog's order: `opened { document }` or `openFailed { .. }` each (one more `openFailed` limit_exceeded `documents` if more were chosen); empty = cancelled. `OpenResult { status: NeedsPassword }` comes with passwords
open_recent(recent_id: u32) -> AppEvent             // ADR-026: like a file from the dialog, `opened { document }`, `needsPassword { id, displayName }` or `openFailed { .. }` (a file that is gone: io_not_found, and the entry stays listed as `missing`); an id that is not listed → not_found. Recents are recorded when a document the user opened (never the welcome document) is loaded, and at most 50 are kept
restore_recent(recent_id: u32) -> bool           // Undo of a removal (DESIGN 3.11/3.12): puts the entry back where it was; false if it was not removed in this run or is listed again
locate_recent(recent_id: u32) -> bool            // "Locate…" for a missing file: Rust shows the file dialog and replaces the entry's path in storage (the path never reaches the UI); false on cancel; unknown id → not_found
open_welcome_document() -> AppEvent                 // ADR-023, DESIGN §3.14: opens the bundled `resources/welcome/welcome-{en,de}.pdf` for the resolved UI language (settings language, "system" = the language `subscribe_menu`/`app_ready` reported, else en) through `intake::admit` like any file; the path is resolved in Rust from the resource dir and never crosses IPC; `opened { document }` with `kind: Welcome` and `display_name` "Welcome to {app}.pdf" (localized), or `openFailed`; a welcome document already open is closed with discard first (restart). Not added to recents
list_recents() -> Vec<RecentEntry>                   // ≤ 50, newest first; `RecentEntry { id, displayName, folder (parent folder's name only), lastOpened (s since 1970), missing }`, ids are per run, stored in `recents.json` (app data dir, atomic, hostile-input tolerant)
remove_recent(recent_id: u32) -> ()                 // an unlisted id is not an error; the file is untouched
unlock_document(doc_id: DocId, password: String) -> DocumentInfo        // 1..=1024 bytes, no NUL (invalid_argument); one attempt per document at a time and 4 in all, else limit_exceeded (ADR-028); for a document that waited as `needsPassword` (else not_found); held as `Zeroizing<String>`, never stored or logged; wrong → password_required, and after the 3rd wrong one each try waits 1 s in Rust (ADR-026); any other failure forgets the document. `close_document` on a waiting id cancels it
set_menu_state(has_document: bool) -> ()            // macOS menu bar: commands that need a document are greyed without one and Cmd+W closes the window; a no-op on Windows
get_document_info(doc_id: DocId) -> DocumentInfo
close_document(doc_id: DocId, discard: Option<bool>) -> ()            // dirty && !discard → unsaved_changes (the welcome document never)
save_document(doc_id: DocId, ack: SaveAck) -> SaveResult
save_document_as(doc_id: DocId, opts: SaveAsOptions, ack: SaveAck) -> Option<SaveResult>  // None = cancelled
revert_document(doc_id: DocId) -> DocumentInfo
get_outline(doc_id: DocId) -> Vec<OutlineNode>       // ≤ 10 000 nodes, depth ≤ 32, title ≤ 512 chars sanitized like a display name; a target is a page id and y, or none; a cycle in the file ends where it comes back
// render
render_page(req: RenderRequest) -> tauri::ipc::Response   // frame, ADR-002 §6: the whole page or one 1024 px tile; `cancelled` if withdrawn while queued
set_viewport(doc_id: DocId, hint: ViewportHint) -> ()      // cancels queued renders of pages that left the viewport, re-ranks the rest (ADR-018)
get_page_sizes(doc_id: DocId) -> Vec<[f32; 2]>             // [width, height] in points per page, rotation applied, 1..=14 400 pt; ≤ 50 000 pages; read once at load, a lookup
// text, search, links
get_text_layer(doc_id: DocId, page_id: PageId) -> TextLayer   // ≤ 200 000 UTF-16 code units, four boxes per unit; `Interactive` priority  // + `rotation` (the page's `/Rotate`, 0/90/180/270; the boxes are before it). Until the page list of `DocumentInfo` carries `PageSlotInfo.rotation`, this is how the UI learns it (`viewer/fileRotation.ts`, filled by the text cache)
search(doc_id: DocId, query: SearchQuery, on_event: Channel<SearchEvent>) -> u32   // returns at once; one page per `Background` job; ≤ 50 000 hits, ≤ 64 searches at once
cancel_search(search_id: u32) -> ()                                  // an unknown or finished id is not an error
get_page_links(doc_id: DocId, page_id: PageId) -> Vec<LinkInfo>     // ≤ 1 000, `Interactive` priority
open_link(doc_id: DocId, page_id: PageId, link_index: u32) -> ()    // URL re-read in Rust, shown in a native dialog from Rust, then opened by Rust; http, https, mailto
// edit (ADR-003)
list_annotations(doc_id: DocId, page_id: PageId) -> Vec<Annotation>   // by id, ≤ 2 000; the first call for a page reads it from the file (`Interactive`), later calls answer from the model
list_document_annotations(doc_id: DocId) -> Vec<AnnotationSummary>   // {id, pageId, kind, color, contents (≤ 240 chars), author, modified, inReplyTo}, ≤ 20 000, by page then id; reads unread pages at `Background`; for the comments panel (`features/comments`)
apply_command(doc_id: DocId, command: DocCommand) -> ChangeSet   // M3: was apply_annotation_command; annotation and page variants (see "Pages")
undo(doc_id: DocId) -> ChangeSet          // nothing to undo: an empty ChangeSet with the current rev
redo(doc_id: DocId) -> ChangeSet
```

Key types (serde `camelCase`; ts-rs generates the TS):

```rust
struct RenderRequest { doc_id: DocId, page_id: PageId, bucket: i16 /* -17..=24 */, tile: Option<(u16, u16)> /* ≤ 63 */,
                       priority: Priority /* Visible | Near | Thumbnail */, generation: u32 }   // `forms: bool` joins with M4
struct ViewportHint  { generation: u32, visible: Vec<PageId> /* ≤ 64 */, near: Vec<PageId> /* ≤ 64 */ }
struct SearchQuery   { text: String /* 1..=512 chars */, match_case: bool, whole_word: bool, max_hits: u32 /* ≤ 50 000 */ }
enum   SearchEvent   { Hits { page_id: PageId, hits: Vec<Vec<Quad>> }, Progress { done: u32, total: u32 }, Done { truncated: bool }, Failed { code, key, retryable, params? } }
                     // wire: `{ "type": "hits" | "progress" | "done" | "failed", ..fields }`, camelCase. `Failed` is an addition: the engine could not go on, and no `Done` follows. A cancelled search sends nothing more
struct SaveAck       { break_signature: bool, file_changed: bool }   // `rewrite_encrypted` returns with the full rewrite (M3, ADR-035 §4)
struct TextLayer     { text: String, boxes: Vec<f32> /* x, y, w, h per UTF-16 code unit of `text`, page space (the box of a character of two units is there twice) */, truncated: bool }
struct OutlineNode   { title: String, target: Option<PageTarget { page_id, y }>, children: Vec<OutlineNode> }
struct LinkInfo      { index: u32 /* position among the page's links */, rect: Rect, target: LinkTarget /* Page { page_id, y } | Url { url ≤ 2048 } | Blocked; wire: `{ "type": "page" | "url" | "blocked", ..fields }` */ }
struct ChangeSet     { rev: u64 /* grows with every change, undo and redo */, upserted: Vec<Annotation>, removed: Vec<AnnotId>, pages: Option<Vec<PageSlotInfo>> /* M3: the full list when it changed, ADR-036 */,
                       history: HistoryState { can_undo, can_redo, undo_label: Option<String>, redo_label: Option<String> /* catalog keys: `annotation.create` | `.update` | `.delete` | `.move` or a batch's own label */, dirty } }
enum   DocCommand    { CreateAnnotation { draft }, UpdateAnnotation { id, patch, coalesce: Option<String> }, DeleteAnnotations { ids } /* + their replies */, MoveAnnotations { ids, dx, dy },
                       Batch { label, commands } /* one undo step; ≤ 5 000 commands, ≤ 2 deep */, Restore { .. } /* internal: the inverse of everything, never accepted from the UI */ }   // wire: `{ "type": "createAnnotation" | ..., ..fields }`
struct DocFlags      { encrypted: bool, xfa: bool, has_forms: bool, signed: bool }   // best effort, from PDFium, read when the document is loaded; part of `DocumentInfo` as `flags` (`signed` only for a document that has a form)
struct OpenResult    { doc_id: DocId, status: OpenStatus /* Ready | NeedsPassword */, info: Option<DocumentInfo> }
struct DocumentInfo  { doc_id: DocId, display_name: String, kind: DocKind, pages: Vec<PageSlotInfo>, rev: u32, flags: DocFlags, history: HistoryState }  // planned; today `{ id, pageCount, displayName, flags }` + `kind`, the fields every open document has
enum   DocKind       { User, Welcome }   // serde lowercase; Welcome = the bundled tour sample (ADR-023): read-only, `save_document` answers `read_only` (the UI offers Save As), `close_document` discards without `unsaved_changes`, never a recent
struct PageSlotInfo  { id: PageId, width: f32, height: f32 /* pt, unrotated CropBox */, rotation: u16, rev: u32, label: Option<String> }
struct SaveResult    { rev: u64, mode: SaveMode /* Incremental | Full */, backup_created: bool, document: DocumentInfo, changes: ChangeSet }   // ADR-033: `document` = the document as it is now (Save As renames it, the welcome document becomes a user document), `changes` = the annotations as `clean` and an empty history
struct AppBootstrap  { platform: Platform /* macos | windows | linux */, reduced_transparency: bool, version: &'static str }
enum   AppEvent      { DropHover { active: bool }, Opened { document: DocumentInfo }, OpenFailed { code, key, retryable, params? } }  // wire: `{ "type": "dropHover" | "opened" | "openFailed", ..fields }`, camelCase; OpenFailed carries the error of §7 flat and names no file; no variant has room for a path
struct Settings      { glass: GlassMode /* Auto | Solid */, theme: ThemeMode /* System | Light | Dark */, language: Language /* System | En | De */, left_panel_width: PanelWidth, welcome_tour: WelcomeTour /* Pending | Shown */, author_name: AuthorName /* "" or ≤128 chars, sanitized, no control chars; default "" (ADR-034) */, author_prompt: AuthorPrompt /* Pending | Done */ }   // serde lowercase values; `welcomeTour` default pending (missing or invalid → pending), the UI writes `shown` before it calls `open_welcome_document` on first launch (ADR-023)
```

**Menu bar.** On macOS `menu::install` builds the menu bar at startup from `src/actions/menu.json` (App, File, Edit with the system items, View, Window, Help; the labels are the `menu.*` keys of `src/i18n/locales/*.json`, compiled in with `include_str!`) and `.on_menu_event` hands each chosen item to `MenuBridge::forward`, which sends it on the channel of `subscribe_menu` if `menu::spec::is_action_id` allows it. `update_settings` rebuilds the menu when `language` changes (`menu::refresh`, on the main thread); "system" uses the language `subscribe_menu` reported. Windows has no menu bar (ADR-016): nothing is installed there. Open runs like every other command: the menu sends `open`, the UI calls `open_document_dialog`. The menu is not synchronised with the UI's state (items are not greyed without a document): `runAction` refuses a command that cannot run, which is all the menu needs.

**Settings.** `storage::settings` keeps the settings in memory and in `<app data dir>/settings.json`. A missing, oversized (> 64 KiB), damaged
or hand-edited file never blocks start: only a regular file is read (its type is taken from the opened handle, not from the path, and on Unix it is opened
`O_NONBLOCK` so a FIFO cannot hang the start), and each field that is invalid falls back to its default. `update_settings`
takes the patch as raw JSON, validates all of it first (an object that passes a `deny_unknown_fields` struct, so at most `glass`, `theme`, `language`, `leftPanelWidth`, `welcomeTour`, `authorName` and `authorPrompt`, with
known enum values) and writes it with `storage::atomic::write_atomic`: a temp file `.settings.json.<pid>.<n>.tmp` (process id and a per-process counter, so no two
writers share one) is created with `create_new` (a name that is taken is skipped, never written through; mode `0600` on Unix, directories `0700`), fsynced,
renamed over the file, and the directory is fsynced on Unix. At startup `sweep_stale_temp_files` removes the temp files of that exact name pattern that a crash left in the data directory and that are older than an hour. Only after the write succeeds does the
in-memory copy change, so a failed write leaves memory and disk in agreement. Updates are serialised by a writer lock that is held across the
write; the lock that guards the in-memory copy is not, so `get_settings` never waits for the disk.
`reducedTransparency` is the macOS "Reduce transparency" flag (`NSWorkspace.accessibilityDisplayShouldReduceTransparency`, `platform::macos`);
elsewhere it is `false` and CSS `prefers-reduced-transparency` covers the platform. The frontend turns settings and flag into
`html[data-theme]` and `html[data-transparency="reduced"]` (`src/stores/settings.ts`, DESIGN §1). On macOS the flag is live: when the window gains
focus (the setting is changed in System Settings, so the app was in the background) `platform::on_window_event` re-reads it and, if it changed,
sends the new value over the channel the UI opened with `watch_transparency` (§5, §6), which the settings store mirrors. Startup does not wait for the backend: `src/main.tsx` renders with the defaults at
once and `loadSettings` applies the stored settings when they arrive (after 3 s without an answer the defaults stay and a late answer still applies).

**Read commands** (`engine::{outline, text, search, links, space}`, `commands::{outline, text, search, links}`, ADR-019). Each is one engine job per
call, except `search`, which is one job per page. Coordinates are page space (ADR-003 §1: points, origin at the top left of the page's box, y down, before `/Rotate`)
and are kept to a hundredth of a point; every number of a page comes from the file and is finite and within ±14 400 before it is sent. The command layer applies the
bounds a second time on what it sends (the engine applies them first), so the UI is promised them whatever the engine hands over.
- *Outline.* Read depth first with the set of bookmarks already read: a `/Next` that points to an earlier sibling, a `/First` that points to an ancestor and a bookmark that
  is its own sibling end the chain there. A bookmark goes to a page only through a jump in this document (a `GoToR` action's destination is a page of another file and
  is no target). Beyond 10 000 nodes or 32 levels the rest is left out.
- *Text layer.* One reading of a page's characters (`engine::text::text_chars`) serves the layer and the search: PDFium's controls are left out (the hyphen of a
  hyphenated line end is U+0002, so the word reads whole), and the two halves of a surrogate pair, which PDFium hands over as two characters where its characters are 16 bit
  (Windows), are one character. The box is PDFium's "loose" one (the height of the font), so a selection of a line has no gaps.
- *Search.* PDFium's own search is not used: it folds the case of ASCII letters only and does not see through a hyphenated line end (both measured, see ADR-019). The page's
  text is searched in Rust (`model::find`: Unicode lower-casing unless the search is case sensitive, ligatures as letters, soft hyphens gone, a run of white space is one space so
  a phrase is found across a line break, whole word where the hit's own edge is a letter, KMP so no page and no query makes it more than linear) and PDFium is asked for the box of
  each character of each hit, which become the hit's quads, one per line. The loop (`commands::search`) asks the engine for one page at a time at `Background` priority, so a
  render that is queued goes first; a page the engine is too busy for is asked again up to 10 times; a damaged page is skipped; a new search of a document, `cancel_search` and
  `close_document` cancel the running one through a flag read between two pages, and a cancelled search sends nothing more.
- *Links.* The page's link annotations in `/Annots` order (not `FPDFLink_Enumerate`'s index, which for a page with other annotations repeats links). A link is `Page` if its
  action is a jump in this document or it has a `/Dest` of its own that names a page, `Url` if its URI action passes `security::links::classify` (`http`, `https`, `mailto`; at
  most 2048 bytes; only RFC 3986 characters, no credentials before the host, no attachment parameter in a `mailto`), and `Blocked` otherwise: Launch, GoToR, GoToE,
  JavaScript, any other scheme, a damaged destination. Nothing is executed.
- *`open_link`.* The UI names a link by document, page and index. Rust reads the page's links again, takes the URL from the document (a `SafeUrl`, the only value the opener
  takes), shows a native message box with the URL in full (texts from the UI catalogs, `link.confirm.*`, in the language of the settings), and only if the user agrees calls
  `tauri_plugin_opener::open_url`, the one place the plugin is used. The plugin is not registered with the builder and no capability names it, so the webview has no opener
  command at all. A link that is a page, is blocked or does not exist is `invalid_argument` (`link`) and the user is not asked; a declined dialog is `Ok(())`.
- *Flags.* `encrypted` (the security handler revision is not "unprotected"), `xfa` and `has_forms` (`FPDF_GetFormType`), `signed` (a signed signature field; only looked for in a document
  that has a form, because counting signatures walks every page).

Launch, GoToR and JavaScript actions map to `Blocked`. The UI's confirm dialog is a native one shown by Rust with the URL, and `open_link` re-reads the URL from the
document. The frontend therefore cannot make Rust open an arbitrary URL.

`model::validate` bounds on `DocCommand`:
- Coordinates are finite and within ±14 400 pt.
- Quads ≤ 4 096. Ink ≤ 256 strokes, ≤ 10 000 points per stroke, ≤ 100 000 points in total.
- Contents ≤ 32 768 chars. Author ≤ 256 chars. Free text ≤ 8 192 chars, WinAnsi only.
- Font size 4–144. Widths 0.25–72 pt. Opacity 0.05–1.
- Batch ≤ 1 000 commands. Page lists are unique and existing.

A render frame is at most 4096×4096 px (16 Mpx), checked after the bucket and tile are resolved against the page's real size: a whole page above that is `limit_exceeded` and the UI asks for tiles; a page more than 64 tiles wide or high is refused. `get_page_sizes` and a viewport hint are bounded the same way (≤ 50 000 pages, ≤ 64 pages per list, refused while the hint is read). A tile column or row of 64 or more is refused at the command; at most 8 callers join one queued or running frame; at most 96 `render_page` calls per document and 128 in all are in flight (`limit_exceeded`, `requests`).

**Planned commands.** The milestone ADR fixes the exact signatures; the same rules apply, and output paths come from a Rust-side save dialog.
M3: see "Pages" below (ADR-036; `insert_pages_from_file` became `pick_pdf_sources` + `InsertPages`). M4: see "Forms and
signatures" below (ADR-041). M5: see "Edit and protect" below (ADR-047; `set_protection`/`remove_protection` became
`stage_protection`/`stage_unprotection`, `set_metadata` became `SetMetadata`/`RemoveMetadata` commands).
M6: see "Convert and output" below (ADR-049; `print_document` became `prepare_print` + `open_print_dialog`, `reveal_in_folder` is v1.1). M7: `list_recoverable`, `restore_autosave`, `discard_autosave`.

### Annotations (ADR-003; `model/{annotation,command,history,doc_state,ids}.rs`, `engine/import.rs`, `commands/annotations.rs`)

- *Ownership.* `model` has no PDFium or lopdf import. A `DocState` per open document (created on first use, dropped by `close_document`) holds the annotations, the revision, the history and the set of
  imported pages. PDFium reads annotations (`engine::import`, an `Interactive` job) and never saves; saving is a later package (lopdf) that works from `DocState::entries` (`persisted` origin, `tombstone`) and then calls `mark_clean`.
- *No event channel.* The model changes only as the answer to a command of the UI, so the answer is the delta (`ChangeSet`); the UI replica (`stores/annotations.ts`) applies it, ignores one older than its `rev`, and never lets a page list that was on its way meanwhile overwrite or resurrect what commands decided.
- *Import.* Highlight, underline and strikeout (quads), text notes, free text, squares and circles become typed annotations (`sync: clean`). Ink, lines, stamps, squiggly and the rest are `opaque { subtype }`: listed, selectable, never changed. Links, widgets and popups are not annotations
  of the model. What PDFium cannot say (opacity, stroke width, a free text's font size, `/IRT`) is read as the default. A page is read once (≤ 2 000 annotations looked at); strings are cut and stripped of control characters, and an annotation that fails validation is left out.
- *Commands.* Every apply validates before it changes anything and returns its exact inverse as slots (`id → previous entry | none`); undo applies it, and the inverse of that is the redo, so ids and snapshots return exactly. A `Batch` rolls back whole on an error. A reply (`inReplyTo`) needs a live parent on the same page; deleting a parent deletes its replies.
  Opaque annotations and locked ones (an update that only unlocks excepted) are refused (`invalid_argument`). `rect` is always computed by Rust. Updates with the same `coalesce` key on one annotation within 1.5 s share one undo step. History ≤ 500 steps; `dirty` compares the top step with the clean marker.
  Limits are in `limits.rs`: annotations per page 2 000 and per document 20 000, quads 512, strokes 256, points 10 000 per stroke and 50 000 in all, 500 free text lines, contents 32 768 characters.
- *Stamp.* `modified` is stamped by `commands/annotations.rs` (ISO 8601, UTC); the model has no clock.

### Pages (ADR-036; `model/{page,command,doc_state}.rs`, `engine/pages.rs`, `documents/sources.rs`, `pdfwrite/{pagetree,produce,compress}.rs`, `commands/pages.rs`)

```rust
// commands/pages.rs (M3)
get_pages(doc_id: DocId) -> Vec<PageSlotInfo>        // current order; replaces get_page_sizes (removed in M3); ≤ 50 000
apply_command(doc_id: DocId, command: DocCommand) -> ChangeSet   // replaces apply_annotation_command; annotation and page variants
pick_pdf_sources(multiple: bool) -> Vec<SourceResult>            // Rust open dialog → intake::admit → bytes in memory; ≤ 32; [] = cancelled
release_source(source_id: SourceId) -> ()                        // unknown id is not an error; pinned bytes live on in documents
extract_pages(doc_id: DocId, pages: Vec<PageId>, on_event: Channel<JobEvent>) -> Option<JobId>          // None = save dialog cancelled
split_document(doc_id: DocId, plan: SplitPlan, on_event: Channel<JobEvent>) -> Option<JobId>            // folder dialog
merge_documents(inputs: Vec<MergeInput>, on_event: Channel<JobEvent>) -> Option<JobId>   // 2..=64 inputs; works with sources only (no document open); Save As dialog, result opens as a document
compress_document(doc_id: DocId, preset: CompressPreset, save_as?: bool /* ignored: the result is always a new file */, on_event: Channel<JobEvent>) -> Option<JobId>
estimate_compression(doc_id: DocId) -> CompressEstimate        // sample-based (<= ~1.5 s): { current, presets: { lossless, print, ebook, screen } } in bytes
cancel_job(job_id: JobId) -> ()                                  // unknown or finished id is not an error
```

```ts
type SourceId = number; type JobId = number;
interface PageSlotInfo { id: PageId; width: number; height: number /* pt, unrotated CropBox */;
  rotation: 0 | 90 | 180 | 270; rev: number; label: string | null; origin: 'file' | 'blank' | 'imported' }
type PageCommand =   // members of DocCommand, wire `{ type, ..fields }`
  | { type: 'rotatePages'; pages: PageId[]; quarterTurns: -1 | 1 | 2 }
  | { type: 'deletePages'; pages: PageId[] }
  | { type: 'movePages'; pages: PageId[]; toIndex: number }
  | { type: 'insertBlankPage'; at: number; width?: number; height?: number }
  | { type: 'insertPages'; source: SourceId; pages: number[] /* source indices, ≤ 5 000 */; at: number };
type SourceResult = { type: 'ready'; sourceId: SourceId; displayName: string; pageCount: number }
                  | { type: 'failed'; code: ErrorCode; key: string; params?: UiParams };
type SplitPlan = ( { type: 'everyN'; n: number /* 1..=10 000 */ } | { type: 'before'; pages: PageId[] } | { type: 'ranges'; text: string /* "1-3, 5, 8-", may skip pages and overlap */ } )
  & { pattern?: string /* file names, tokens {name} {n} {pages}, default {name}-{n} */ };   // <= 1 000 outputs
type MergeInput = { type: 'document'; docId: DocId } | { type: 'source'; sourceId: SourceId };
type CompressPreset = 'lossless' | 'print' | 'ebook' | 'screen';   // print 220 dpi q85, ebook 150 q70, screen 96 q55; a result that is not smaller is not written (done.outputs = 0)
type JobEvent =
  | { type: 'progress'; phase: 'read' | 'images' | 'write' | 'validate'; done: number; total: number }
  | { type: 'done'; outputs: number; bytesBefore: number; bytesAfter: number;
      warnings: ('signaturesRemoved' | 'formsDropped')[]; opened: DocumentInfo | null }
  | { type: 'cancelled' } | { type: 'failed'; code: ErrorCode; key: string; retryable: boolean; params?: UiParams };
```

- *Order is model state.* `DocState.pages` is the order; `ChangeSet.pages` is `Option<Vec<PageSlotInfo>>` (the full list, only when it changed). `DocumentInfo.pages` carries the same list, so `viewer/fileRotation.ts` reads `rotation` from it and `get_text_layer`'s `rotation` becomes redundant.
- *Engine mapping.* Commands translate `PageId → engine_index` before every engine job and back for outline and link targets. The engine document is append-only: rotate is `set_rotation`, inserts append (`create_page_at_end`, `copy_pages_from_document`), delete and move touch only the model. Mirroring jobs run at `Control` priority before the model applies.
- *Frontend.* `stores/pages` holds the `PageSlotInfo[]` per document from `DocumentInfo`/ChangeSet; `layout.ts` builds rows from it, so a move relayouts without renders. `features/pages`: the organizer grid (virtualized thumbnails, multi-select, drag to `movePages`), insert/extract/split/merge/compress dialogs, one progress row per job in the status bar.
- *Save.* Incremental page-tree rewrite or Full per ADR-036 §5; `SaveAsOptions.cleanCopy: boolean` selects Full. Signed or certified + any page change → `needs_confirmation{breaksSignature}`.
- *Limits.* 50 000 live pages, 60 000 engine pages, ≤ 50 000 ids per page list (unique, existing), 5 000 pages per insert, sources ≤ 512 MiB each and 1 GiB in all, ≤ 2 jobs at once, 10 min per job; `image::Limits` 10 000 px per side, 50 MP, 256 MiB; Flate output ≤ 256 MiB per stream; deep copy ≤ 1 000 000 objects.

### Forms and signatures (ADR-041; `pdfwrite/{forms,flatten,appearance}.rs`, `model/{form,annotation,command,doc_state}.rs`, `signatures/`, `storage/{signatures,keychain}.rs`, `commands/{forms,signatures}.rs`)

```rust
// commands/forms.rs (M4)
get_form_fields(doc_id: DocId) -> FormInfo            // first call reads the field tree (blocking pool, load_untrusted, 30 s); later calls answer from DocState.form.
                                                      // no form → FormInfo { fields: [], .. }; full XFA → unsupported_feature (what: "xfa")
apply_command(doc_id: DocId, command: DocCommand) -> ChangeSet   // + SetFieldValue
flatten_document(doc_id: DocId, opts: FlattenOptions, on_event: Channel<JobEvent>) -> Option<JobId>   // Save As dialog (None = cancelled); full rewrite; result opens
// commands/signatures.rs (M4); library calls run on the blocking pool, keychain deadline 60 s
create_drawn_signature(role: SignatureRole, outlines: Vec<Vec<Point>>) -> SignatureDraft   // perfect-freehand outline polygons in pad pixels
create_typed_signature(role: SignatureRole, text: String, font: TypedFont) -> SignatureDraft  // 1..=64 chars, no control chars
import_signature_image(role: SignatureRole, remove_background: bool) -> Option<SignatureDraft> // Rust open dialog (PNG, JPEG); None = cancelled
list_signatures() -> SignatureLibrary
save_signature(draft_id: DraftId) -> SignatureItem    // keychain missing → unsupported_feature (what: "keychain"); locked → invalid_argument (what: "library"); 32 items → limit_exceeded
delete_signature(item_id: String) -> ()               // 32 lowercase hex; unknown → not_found
clear_signature_library() -> ()                       // deletes library.bin and the keychain entry; the way out of `locked`
get_signature_preview(art: SignatureRef, max_px: u16 /* 16..=1024 */) -> tauri::ipc::Response   // SHR1 PNG frame of raster art
use_signature(doc_id: DocId, art: SignatureRef) -> AssetInfo   // copies the art into the document's assets; then CreateAnnotation { kind: "signature" }
```

```ts
type FieldId = number; type AssetId = number; type DraftId = number;
type FieldValue =   // wire `{ type, ..fields }`
  | { type: 'text'; text: string }
  | { type: 'checked'; on: boolean }
  | { type: 'radio'; selected: number | null }          // index into the field's `states`
  | { type: 'choice'; selected: string[]; custom: string | null };   // export values; custom only if editable
type FieldKind =
  | { type: 'text'; multiline: boolean; maxLen: number | null; comb: boolean; password: boolean; align: 'left' | 'center' | 'right'; fontSize: number /* 0 = auto */ }
  | { type: 'checkbox' }
  | { type: 'radio'; states: string[] /* on-state names, sanitized, display only */; noToggleOff: boolean }
  | { type: 'choice'; combo: boolean; editable: boolean; multiSelect: boolean; options: { export: string; label: string }[] }
  | { type: 'signature' } | { type: 'button' } | { type: 'unsupported' };
interface Widget { pageId: PageId; rect: Rect /* page space */; tabOrder: number /* within its page */; state: number | null /* radio: index into states */;
  fill: Rgb | null; border: Rgb | null; textColor: Rgb }
interface FormField { id: FieldId; name: string /* fully qualified, ≤ 512 */; tooltip: string | null; kind: FieldKind; readOnly: boolean; required: boolean;
  value: FieldValue; defaultValue: FieldValue | null; widgets: Widget[]; sync: 'clean' | 'modified' }
interface FormInfo { fields: FormField[]; hasScripts: boolean; xfa: 'none' | 'hybrid' | 'full'; needAppearances: boolean }
interface FieldState { id: FieldId; value: FieldValue; sync: 'clean' | 'modified' }
// DocCommand member:  { type: 'setFieldValue'; field: FieldId; value: FieldValue; coalesce?: string /* "field:<id>" */ }
// ChangeSet gains:    fields: FieldState[]   (empty when no field changed)
type FlattenOptions = { scope: 'forms' | 'formsAndAnnotations' };
// JobEvent.done.warnings gains 'xfaRemoved'; SaveResult.warnings too

type SignatureRole = 'signature' | 'initials';
type TypedFont = 'homemadeApple';
type SignatureArt = { type: 'vector'; w: number; h: number; paths: Point[][] /* filled polygons, nonzero, y down */ }
                  | { type: 'raster'; w: number; h: number /* px; pixels via get_signature_preview */ };
type SignatureRef = { type: 'draft'; id: DraftId } | { type: 'library'; id: string };
interface SignatureDraft { id: DraftId; role: SignatureRole; art: SignatureArt }
interface SignatureItem { id: string /* 32 hex */; role: SignatureRole; created: string /* ISO 8601 */; art: SignatureArt }
interface SignatureLibrary { status: 'ready' | 'empty' | 'unavailable' | 'locked'; items: SignatureItem[] }
interface AssetInfo { assetId: AssetId; aspect: number /* w / h */; art: SignatureArt }
// AnnotationBody gains (replaces the planned `stamp`):
//   | { kind: 'signature'; box: Rect; role: SignatureRole; art: { type: 'asset'; assetId: AssetId; aspect: number } | { type: 'file' } }
//   | { kind: 'mark'; box: Rect; glyph: 'check' | 'cross' | 'dot' }
```

- *Ownership.* `DocState.form: Option<FormModel>` (fields, object ids, widget refs, values, clean values) and `DocState.assets: AssetStore`
  (`Arc<Art>` by `AssetId`). Only `pdfwrite::forms` sees object ids. Widget pages map `File { index } → PageId` through the slots; a widget on
  a deleted page drops out of the tab order. `signatures::DraftStore` and the library are app-level (`AppState`). Import rules: `keyring_core`
  and the store crates only in `storage/keychain.rs`, `chacha20poly1305` only in `storage/signatures.rs`, `skrifa` only in `signatures/typed.rs`.
- *Validation* (`model::validate`, before anything changes): read-only, signature, button and unsupported fields refuse values
  (`invalid_argument`, `field`); value type must match the kind; text ≤ 32 768 chars, ≤ `maxLen`, WinAnsi only, LF only if multiline, no other
  control chars; radio index < `states.len()`, `null` only without `noToggleOff`; choice values ∈ options unless editable, one value unless
  multi-select, custom ≤ 512 chars. Signature `box` ≥ 4 pt per side; `assetId` alive in this document; `file` art only from import.
- *Rendering.* PDFium renders widgets and clean signature/mark stamps. `features/forms` puts one control per fillable widget in `PageOverlay`
  (`input`, `textarea`, `select`, `role="checkbox"`/`"radio"`): transparent while clean and unfocused, opaque `--field-fill` when focused or
  modified. Signatures and marks with `sync ≠ clean` are drawn by the annotation overlay (vector paths as SVG, raster via
  `get_signature_preview` as a Blob URL). Moving or scaling an `art: file` signature runs a `Control` job (`set_bounds`) and bumps `pageRev`.
- *Keyboard.* Tab / Shift+Tab walk the widgets by (page position in the current order, `tabOrder`), skipping read-only; Space toggles a
  checkbox; arrows move within a radio group; Alt+Down opens a combo; Enter commits a single-line field and moves on; Escape reverts the
  uncommitted text and returns focus to the canvas. Text commits with `coalesce: "field:<id>"` on blur, Enter, Tab and 500 ms idle.
- *Save.* `pdfwrite::forms::write_values` joins the incremental save of ADR-033/036 (field dicts with `/V`, widget `/AS` and `/AP`, `/AcroForm`
  only when `/XFA` is removed). Signatures: `/Stamp` with `sheer-sig-` / `sheer-ini-` `/NM` and an image or path AP; marks `sheer-mark-<glyph>-`;
  one image XObject per asset per save. `art: file` writes `/Rect` only.
- *Library file.* `<app data>/signatures/library.bin` = `"SHLB" | 0x01 | nonce[24] | ciphertext+tag`, AAD = the first 5 bytes. Key: 32 bytes,
  service `app.sheer.desktop`, user `signature-library-key-v1`. `SecretStore { get() -> Result<Option<Zeroizing<[u8;32]>>>, set(&[u8;32]), delete() }`.
  Status: no file → `empty`; no store or store error → `unavailable`; size, header, decrypt or JSON fails → `locked`. Never written in plaintext.
- *Limits* (`limits.rs`): form read 30 s, ≤ 10 000 fields, ≤ 20 000 widgets, depth ≤ 32, ≤ 2 000 options of ≤ 512 chars per field, names ≤ 512
  and tooltips ≤ 1 024 chars (Cf stripped, ADR-035 §2). Drawn: ≤ 256 outlines, ≤ 50 000 points, finite, pad ≤ 4 096 px. Art: ≤ 2 000 paths,
  ≤ 100 000 points after simplification. Image file ≤ 10 MiB; decode ≤ 4 000 px per side, 16 MP, 128 MiB; stored PNG ≤ 1 600 px long side,
  ≤ 512 KiB. Drafts ≤ 16 (oldest dropped). Assets ≤ 64 and ≤ 32 MiB per document. Library ≤ 32 items, file ≤ 16 MiB.
- *Errors.* New `what` values: `field`, `fieldText`, `glyph`, `keychain`, `library`, `xfa`, `signatureImage` (decode or limit failure), each with
  `error.<code>.<what>` in en and de.

### Edit and protect (ADR-047; `content/`, `pdfwrite/{content,redact,crypt,metadata}.rs`, `model/{annotation,command,doc_state,page,page_ops,redaction,protection,metadata}.rs`, `engine/{pages,redact}.rs`, `security/secret.rs`, `commands/{content,pages,redact,protect,metadata}.rs`)

```rust
// commands/content.rs (M5)
insert_image_dialog(doc_id: DocId) -> Option<ImageAssetInfo>   // Rust open dialog (PNG, JPEG); None = cancelled; then CreateAnnotation { kind: "image" }
get_asset_preview(doc_id: DocId, asset_id: AssetId, max_px: u16 /* 16..=2048 */) -> tauri::ipc::Response   // SHR1 PNG frame
apply_command(doc_id: DocId, command: DocCommand) -> ChangeSet  // + textBox / image kinds via Create/Update/Move/DeleteAnnotation(s), + CropPages,
                                                                //   MarkRedactions, SetMetadata, RemoveMetadata
// commands/redact.rs
apply_redactions(doc_id: DocId, opts: RedactOptions, on_event: Channel<JobEvent>) -> JobId   // no dialog; done.changes = the ChangeSet; cancel = no change
// commands/protect.rs (passwords → security::secret::Secret at deserialisation; blocking pool for lopdf)
get_protection(doc_id: DocId) -> ProtectionInfo
stage_protection(doc_id: DocId, opts: ProtectOptions) -> ChangeSet                          // one undo step; written by the next save
stage_unprotection(doc_id: DocId, permissions_password: Option<String>) -> ChangeSet       // owner rights checked now; wrong → password_required
// commands/metadata.rs
get_metadata(doc_id: DocId) -> DocMetadata         // first call reads the file (blocking pool, load_untrusted, 30 s); then from DocState.metadata
```

```rust
// Rust-only shapes
pub struct Secret(Zeroizing<String>);                       // security/secret.rs: Deserialize (1..=127 bytes after SASLprep, no NUL/controls), Debug = "<secret>", no Serialize
pub struct SecretSlots { slots: HashMap<Ticket, PendingProtection> }   // DocState.secrets; cleared on save, close, and when a step leaves the history
pub enum PendingProtection { Protect { open: Option<Secret>, owner: Secret /* random if none given */, allow: Permissions }, Remove }
pub enum PageSource { File { index }, Blank, Imported { source, index }, Redacted { bytes: Arc<[u8]> } }   // + Redacted (one-page PDF from pdfwrite::redact)
pub struct PageSlot { /* ADR-036 fields */ media: [f32; 4], crop: Option<[f32; 4]> }                     // user space
pub struct SavePlan { /* .. */ content: Vec<(PageId, Vec<ContentObject>)>, crops: Vec<PageId>, redacted: bool,
                      protection: Option<PendingProtection>, metadata: Option<MetadataChange>, keep_encryption: bool }
// pdfwrite entry points
pub fn content::burn(doc: &mut Document /* Full, or IncrementalDocument::new_document */, page: ObjectId, objs: &[ContentObject], assets: &AssetStore) -> Result<(), AppError>;
pub fn redact::raster_page(img: RasterPage /* RGB8 or Gray8, w, h */, size_pt: [f32; 2], rotate: u16) -> Result<Vec<u8>, AppError>;
pub fn redact::scrub(doc: &mut Document, redacted: &[ObjectId]) -> Result<(), AppError>;   // StructTreeRoot, MarkInfo, Thumb, PieceInfo, orphan fields, new /ID
pub fn crypt::encrypt_r6(doc: &mut Document, p: &PendingProtection) -> Result<(), AppError>;
pub fn crypt::read_protection(bytes: &[u8], password: Option<&Secret>) -> Result<ProtectionRead, AppError>;
pub fn metadata::read(doc: &Document) -> Result<MetadataRead, AppError>;
pub fn metadata::write(doc: &mut IncrementalDocument, m: &MetadataValues, had_xmp: bool, now: PdfDate) -> Result<(), AppError>;
pub fn metadata::strip(doc: &mut Document) -> Result<(), AppError>;
// engine jobs
Job::SetCropBox { engine_index: u32, crop: [f32; 4] }                                     // Control
Job::RenderForRedaction { engine_index: u32, dpi: f32, burn: Vec<Rect> } -> RasterPage   // Background; with annotations + form appearances
```

```ts
type StdFont = 'sans' | 'serif' | 'mono';          // Helvetica, Times-Roman, Courier; WinAnsi only
// AnnotationBody gains (colour and opacity are the annotation's common fields):
//   | { kind: 'textBox'; box: Rect; text: string /* ≤ 8 192 chars, LF */; lines: string[] /* Rust layout, read-only */;
//       font: StdFont; fontSize: number /* 4..=144 */; align: 'left' | 'center' | 'right' }   // draft: box.height ignored, Rust grows it
//   | { kind: 'image'; box: Rect; assetId: AssetId; aspect: number }
//   | { kind: 'redactMark'; quads: Quad[] /* ≤ 512 */; source: 'text' | 'area' }            // model only, never written or imported
interface ImageAssetInfo { assetId: AssetId; width: number; height: number /* px after downsizing */; aspect: number }

type CropSpec = { type: 'margins'; top: number; right: number; bottom: number; left: number /* pt, page space, from the MediaBox */ }
              | { type: 'reset' };
// PageCommand gains: { type: 'cropPages'; pages: PageId[]; spec: CropSpec }
// PageSlotInfo gains: media: { width: number; height: number }; crop: { top: number; right: number; bottom: number; left: number } | null;
//                     origin gains 'redacted'

// DocCommand gains: { type: 'markRedactions'; marks: { pageId: PageId; quads: Quad[]; source: 'text' | 'area' }[] /* ≤ 10 000 */ }
interface RedactOptions { pages: PageId[] | null /* null = every page with marks */; removeMetadata: boolean }
// JobEvent: progress.phase gains 'redact'; done gains changes: ChangeSet | null; done.warnings gains 'unsavedEditsDropped'

type Permission = 'print' | 'copy' | 'edit';
interface ProtectOptions { openPassword: string | null; permissionsPassword: string | null; allow: Permission[] }
interface ProtectionInfo { encrypted: boolean; method: 'none' | 'rc4' | 'aes128' | 'aes256' | 'unknown'; ownerRights: boolean;
  allow: Permission[]; pending: 'none' | 'protect' | 'remove' }
// DocFlags gains: permissions: Permission[] | null   (null = not encrypted, or opened with owner rights)
// SaveAck gains:  rewriteEncrypted: boolean

interface DocMetadata { title: string | null; author: string | null; subject: string | null; keywords: string | null;
  creator: string | null; producer: string | null; created: string | null; modified: string | null /* ISO 8601 */;
  pdfVersion: string; fileBytes: number; xmp: { present: boolean; bytes: number }; truncated: boolean;
  pending: 'none' | 'edited' | 'remove' }
type MetadataPatch = Partial<Record<'title' | 'author' | 'subject' | 'keywords', string | null>>;   // ≤ 1 000 chars, controls stripped
// DocCommand gains: { type: 'setMetadata'; patch: MetadataPatch } | { type: 'removeMetadata' }
// ChangeSet gains:  doc: ('metadata' | 'protection')[]   (the UI re-reads get_metadata / get_protection)
```

Wrappers: `src/api/content.ts` (`insertImageDialog`, `getAssetPreview`), `pages.ts` (`cropPages` builder), `redaction.ts` (`markRedactions`,
`applyRedactions`), `protection.ts` (`getProtection`, `stageProtection`, `stageUnprotection`), `metadata.ts` (`getMetadata`, `setMetadata`,
`removeMetadata`); each parses its answer and treats a wrong shape as `internal`. Password fields are cleared by the caller after the call.

- *Content objects.* `textBox` and `image` live in `DocState.entries` like annotations (undo, overlay, move, scale) but are never in
  `list_document_annotations`. `content::text::layout(text, font, size, width) -> (lines, height)` runs inside `model::validate` on create
  and update. The overlay draws them while unsaved; a save burns them (`pdfwrite::content`), removes them from the model (`ChangeSet.removed`)
  and PDFium shows them from the reloaded file. Image assets: `AssetStore` with an image budget beside the signature one.
- *Crop.* `CropPages` validates every page first (≥ 72 × 72 pt, inside the MediaBox), then mirrors (`Job::SetCropBox`), then shifts the
  page's annotations, content objects and widget rects by the origin change; inverse = the old crops + the reverse shift. Saving writes
  `/CropBox` in the re-appended page dict (ADR-036 §5 path).
- *Redaction.* `apply_redactions`: snapshot of the marked pages → per page `RenderForRedaction` (200 dpi, ≤ 4 096 px, ≤ 16 MP, ≥ 72 dpi)
  → `raster_page` → engine append (Control) → one model step (`redact.apply`) swapping slots to `Redacted`. A page that changed while the job
  ran (`rev`) fails the job. Text layer, search and links read the slot's engine page, which has no text. A save with any `Redacted` slot is
  Full + `scrub`, `backupCreated: false`, and `storage::backup::forget_target(path)` deletes that file's backups.
- *Protection.* A save with `SavePlan.protection` is Full: `Protect` → `crypt::encrypt_r6` (V5, `Aes256CryptFilter`, file key from
  `getrandom`), `Remove` → no `/Encrypt`; then the registry's session password becomes the new open password. A save of an encrypted file
  without a pending change keeps its `/Encrypt` and key (`keep_encryption`) after `needs_confirmation{rewriteEncrypted}`.
  `apply_command` checks `DocFlags.permissions`: `edit` gates every edit command (annotate, fill, page ops, content, crop, redaction);
  refused with `read_only` (`permission`). Secrets never reach `UiError`, logs, history JSON or `Debug`.
- *Metadata.* `SetMetadata` keeps clean and current values (`DocState.metadata`), inverse = the old values; `RemoveMetadata` sets
  `strip` (inverse clears it). Save: set → incremental `/Info` (+ regenerated XMP if the file had XMP, `/ModDate` now); strip → Full
  `metadata::strip`, no backup. Strings from the file pass the display-name filter (no controls, Cf, bidi) before they cross IPC.
- *Limits* (`limits.rs`): text box ≤ 8 192 chars, ≤ 500 lines, box ≥ 4 pt; image file ≤ 20 MiB, header ≤ 8 192 px per side and ≤ 40 MP,
  `max_alloc` 256 MiB, stored ≤ 4 096 px long side and ≤ 24 MiB; ≤ 128 image assets, ≤ 256 MiB per document; crop ≥ 72 pt per side;
  marks ≤ 10 000 per command and 20 000 per document, ≤ 512 quads each; redaction ≤ 5 000 pages per job, raster ≤ 16 MP; passwords
  1..=127 bytes; metadata fields ≤ 1 000 chars, read once ≤ 30 s, XMP looked at ≤ 4 MiB.
- *Errors.* New `what` values: `textBox` (params `{ char }`), `image`, `crop`, `redactPage`, `redaction`, `password`, `ownerPassword`,
  `permission`, `metadata`; new confirmation reason `rewriteEncrypted`; each with `error.<code>.<what>` in en and de.
- *Tests.* `tests/content_objects.rs` (burned text extractable, upright on rotated pages), `tests/crop.rs` (annotations stay put on screen,
  undo exact, export keeps crop), `tests/redaction.rs` (the D4 proof of ADR-047 §3), `tests/protection.rs` (R6 written by lopdf opens in
  PDFium with each password; permissions read back; re-save keeps encryption; no password in any `UiError` or log line),
  `tests/metadata.rs` (round trip, hostile strings filtered, strip leaves no `/Info` or `/Metadata`).
- *W0 seams as built.* Every seam above exists and stops at a stub that answers `unsupported_feature` (`what: "notYet"`, `AppError::not_yet`);
  each stub file starts with `owned by package X`. Where the build differs from the signatures: `SavePlan` is `pdfwrite::SavePlan` (the
  annotation plan stays `Plan`), made by `commands::save::save_plan_of`, applied by `pdfwrite::apply_extras`; `PageSlot` also has
  `saved_crop` (like `saved_rotation`), `PlanPage` carries `media/crop/saved_crop`, `PagePlan` has `crop_changed` and `redacted`;
  `DocState` also has `pending_protection: Option<Ticket>` and `MetadataState` has `had_xmp`; `DocFlags.permissions` is a `PermissionSet`
  (`Copy`, serialized as a list); `UiParams` has `char` (`textBox`, never ASCII); jobs have `Job::SetCropBox` and
  `Job::RenderForRedaction` with `id` and `reply` like every job, and `Engine::{set_crop_box, render_for_redaction}`; the label
  `protect.remove` is chosen in `DocState::execute` from the ticket. In TypeScript the content kinds are `ContentBody` (not in
  `AnnotationBody`, so the comment features keep exhaustive maps): they arrive in `ChangeSet.content` and `listContentObjects`, and
  `cropPages` is `CropPagesCommand`, not a `PageCommand`; `media`, `crop`, `doc` and `done.changes` are optional in the types and always
  sent. The `PageSource` enum is no longer `Copy` (`Redacted` holds the raster page).

### Convert and output (ADR-049; `export/{mod,snapshot,images,names,from_images}.rs`, `print/{mod,set,dialog}.rs`, `engine/{export,snapshot}.rs`, `pdfwrite/{images_pdf,export,save}.rs`, `documents/image_batch.rs`, `model/ranges.rs`, `commands/{export_images,images_pdf,export_pdf,print}.rs`)

```rust
// commands/export_images.rs (A)
export_images(doc_id: DocId, opts: ImageExportOptions, on_event: Channel<JobEvent>) -> ExportStart   // folder dialog after validation
resolve_export_conflicts(ticket: u32, choice: ConflictChoice, on_event: Channel<JobEvent>) -> Option<JobId>   // cancel / expired ticket → None
// commands/images_pdf.rs (B)
images_to_pdf(opts: ImagesToPdfOptions, on_event: Channel<JobEvent>) -> Option<JobId>   // open dialog (or batch) → Save As dialog; None = cancelled; done.opened
release_image_batch(batch: u32) -> ()                                                   // unknown id is not an error
// commands/export_pdf.rs (C)
export_pdf(doc_id: DocId, opts: PdfExportOptions, ack: SaveAck, on_event: Channel<JobEvent>) -> Option<JobId>   // Save As dialog; open document unchanged
// commands/print.rs (D)
prepare_print(doc_id: DocId, opts: PrintOptions, on_event: Channel<JobEvent>) -> JobId   // done.print
get_print_page(print_id: u32, index: u32) -> tauri::ipc::Response                        // SHR1 JPEG frame; index < done.print.pages
open_print_dialog(print_id: u32) -> PrintRoute                                           // main window only; set must be complete
release_print(print_id: u32) -> ()                                                       // also on close_document and after 10 min
```

```rust
// Rust-only shapes
pub struct Snapshot { bytes: Option<Arc<[u8]>> /* None = clean, live document */, engine: EngineDocRef }
pub enum EngineDocRef { Live(DocumentId), Snapshot(SnapshotId) }
pub fn export::snapshot::current(app: &AppState, doc: DocumentId) -> Result<Snapshot, AppError>;   // blocking pool; ≤ 1 GiB
pub fn pdfwrite::save::write_to_memory(plan: &SavePlan, input: &[u8]) -> Result<Vec<u8>, AppError>; // Full, unencrypted, no backup
pub fn pdfwrite::images_pdf::build(pages: &[ImagePage], producer: &str) -> Result<Vec<u8>, AppError>;
pub struct ImagePage { image: StoredImage /* content::image output */, size_pt: [f32; 2], place: Rect /* pt, fitted */ }
pub fn pdfwrite::export::strip_annotations(doc: &mut Document) -> Result<u32, AppError>;          // keeps /Link and /Widget
pub fn export::names::image_names(stem: &str, positions: &[u32], total: u32, ext: ImageExt) -> Vec<String>;
pub fn commands::jobs::create_unique(folder: &Path, stem: &str, ext: &str) -> Result<(File, PathBuf), AppError>;   // was .pdf only
pub struct PrintSet { id: u32, doc: DocumentId, frames: Vec<Arc<[u8]>>, bytes: usize, created: Instant }   // print/set.rs, ≤ 4 sets
pub fn print::dialog::open(window: &WebviewWindow) -> Result<PrintRoute, AppError>;   // Windows: with_webview → ICoreWebView2_16::ShowPrintUI(System),
                                                                                      //   cast fails → Webview::print(); macOS: Webview::print()
// engine jobs
Job::OpenSnapshot { bytes: Arc<[u8]> } -> SnapshotId                                   // Control; not in the registry, no page sizes pushed
Job::CloseSnapshot { id: SnapshotId }                                                  // Control; also on cancel and worker respawn
Job::RenderExport { doc: EngineDocRef, engine_index: u32, dpi: f32, annotations: bool, rotate_quarter: u8 } -> RasterPage   // Background, RGB8 on white
```

```ts
type PageSelection = { type: 'all' } | { type: 'current'; pageId: PageId } | { type: 'pages'; pages: PageId[] }
                   | { type: 'ranges'; text: string /* "1-3, 5, 8-", positions in the current order */ };
interface ImageExportOptions { pages: PageSelection; dpi: number /* 36..=600 */; format: 'png' | 'jpeg';
  jpegQuality: number /* 1..=100, ignored for png */; annotations: boolean }
type ExportStart = { type: 'started'; jobId: JobId } | { type: 'cancelled' }
                 | { type: 'conflicts'; ticket: number; count: number; names: string[] /* ≤ 5, generated by Rust */ };
type ConflictChoice = 'replace' | 'keepBoth' | 'cancel';

type PaperSize = 'fit' | 'a4' | 'letter';
interface ImagesToPdfOptions { source: { type: 'dialog' } | { type: 'batch'; batch: number };
  paper: PaperSize; orientation: 'auto' | 'portrait' | 'landscape'; marginPt: number /* 0..=72 */ }
// AppEvent gains: { type: 'imagesDropped'; batch: number; count: number; skipped: number }
// AppBootstrap gains: paper: 'a4' | 'letter'

interface PdfExportOptions { annotations: 'keep' | 'flatten' | 'remove'; removeMetadata: boolean }

interface PrintOptions { pages: PageSelection; annotations: boolean; quality: 'standard' | 'high'; autoRotate: boolean;
  paper: 'portrait' | 'landscape' /* orientation landscape pages are turned to */ }
type PrintRoute = 'system' | 'webview';
// JobEvent: progress.phase gains 'snapshot' | 'render' | 'encode'; done gains print: { printId: number; pages: number } | null;
//           done.warnings gains 'dpiLowered' | 'imagesSkipped'; done gains skipped: number (images → PDF, else 0)
```

Wrappers: `src/api/exportImages.ts` (`exportImages`, `resolveExportConflicts`), `imagesToPdf.ts` (`imagesToPdf`, `releaseImageBatch`),
`exportPdf.ts` (`exportPdf`), `print.ts` (`preparePrint`, `getPrintPage`, `openPrintDialog`, `releasePrint`); each parses its answer
and treats a wrong shape as `internal`. UI (ADR-050) in `features/convert/` and `features/print/PrintSurface.tsx`.

- *Snapshot.* Dirty → `save_plan_of` + `write_to_memory` (content burned, crops, redacted slots, form values; marks never) → `OpenSnapshot`.
  Clean → the live engine document, no copy. A snapshot is closed by the job's drop guard (done, failed, cancelled).
- *Images out.* Validate all → resolve positions → per page compute px = pt × dpi / 72; above 10 000 px per side or 64 MP, dpi lowered to
  fit (`dpiLowered`), below 36 → `limit_exceeded` `exportPixels` `{ page }` before any file. Name plan → conflict check
  (`symlink_metadata`) → folder held under a ticket if needed. Each page: `RenderExport` → `image` PNG / JPEG encode → `create_new` file,
  or `write_atomic` for `replace` (target must be a regular file or absent). `done.outputs` = files written; Cancel keeps them.
- *Images in.* `documents::image_batch` holds dropped image handles (opened once, judged as regular files, magic bytes PNG/JPEG);
  `content::image::intake(handle)` per image; skipped ones counted. Fit size from pHYs / JFIF density. `build` writes catalog, pages,
  XObjects (`/DCTDecode` or `/FlateDecode` + `/SMask`), `/Info` with `/Producer` only; then the merge path (atomic write, `intake::admit`, tab).
- *Export a copy.* Snapshot bytes → `load_untrusted` → `flatten` / `strip_annotations` / `metadata::strip` → new `/ID` → Full write via
  `write_atomic` to the Save As target; encrypted source → `crypt` keep-encryption with the session password (ack `rewriteEncrypted`).
  A target equal to the open document's path is `invalid_argument` (`exportTarget`): a copy never replaces its source.
- *Print.* `prepare_print` → snapshot → `RenderExport` (150/300 dpi, rotated per `autoRotate`) → JPEG q92 frames in `PrintSet`.
  `PrintSurface` (one `<section>` per page, `break-after: page`, `img { width: 100%; height: 100vh; object-fit: contain }`, `@page
  { margin: 0 }`) loads all frames, awaits decode, calls `open_print_dialog`, releases the set and blob URLs when the call returns.
  Permissions: `print` for print, `copy` for images out, `edit` for export-copy transforms of a restricted document.
- *Limits* (`limits.rs`): selection ≤ 5 000 pages; dpi 36..=600; export bitmap ≤ 10 000 px per side, ≤ 64 MP; ≤ 5 000 image files per
  job, ticket 5 min; images in ≤ 500 per job and per batch, batch 10 min, stored sum ≤ 1 GiB, M5 per-image limits; margin 0..=72 pt;
  page 72..=14 400 pt; snapshot ≤ 1 GiB; print ≤ 2 000 pages (`high` ≤ 300), ≤ 768 MiB per set, ≤ 4 sets.
- *Errors.* New `what` values: `exportPixels` (params `{ page }`), `exportTarget`, `snapshot`, `printJob`, `printDialog`, `imageBatch`,
  `pageSelection`; each with `error.<code>.<what>` in en and de.
- *Tests.* `tests/export_images.rs` (names never contain `/Title` or label bytes, hostile display names, conflict ticket, `create_new`
  never overwrites, `dpiLowered`, cancel keeps files), `tests/images_to_pdf.rs` (fit/A4/Letter geometry, EXIF orientation, skipped images,
  result opens in PDFium), `tests/snapshot.rs` (unsaved text box and annotation appear in a render, marks never), `tests/export_pdf.rs`
  (remove keeps links and widgets, strip leaves no `/Info` or `/Metadata`, encrypted copy reopens with its password, source untouched),
  `tests/print_set.rs` (caps, release on close, frames decode).

## 6. Pushes (Rust → UI, never with paths)

The webview has no event permission (SECURITY T3): it cannot `listen` to or `emit` events. A push reaches it as a message on a `tauri::ipc::Channel` that the
UI passes to a command, like `search(.., on_event: Channel<SearchEvent>)`. Four are implemented: `search` sends `hits`, `progress`, `done` and `failed` (§5) for one search, one channel per search, so a message belongs to the search whose channel it came on; `watch_transparency(on_change: Channel<bool>)` sends
each change of the macOS "Reduce transparency" flag (checked when the window gains focus) as a bare bool; a value that already differs from what `app_ready`
reported is sent on subscribing. `subscribe_menu(on_action: Channel<String>, ..)` sends the id of each macOS menu command (`menu:action {id}` below, as a bare string) from the allowlist.
`subscribe_app(on_event: Channel<AppEvent>)` sends the typed `AppEvent`s of `events.rs` (`dropHover { active }`, `opened { document }`, `openFailed { code, .. }`; shapes in §5). They are the events
`drop:hover` and `doc:opened` of the original plan, as channel messages: `dropHover` while files are dragged over the window (`WindowEvent::DragDrop`: enter shows, leave or drop hides; moving over it does nothing), and
`opened` or `openFailed` for each file a drop, the OS (file association) or a second launch asked the app to open, sent as soon as that file is open. The open dialog's answer has the same two shapes, so the UI has one parser.
A file the app was started with is opened while the window is still loading, so its result waits in `AppEvents` and is the first thing the channel carries when the UI subscribes: never lost, never twice. (It is `subscribe_app` that hands them over and not `app_ready`, as the first plan had it: `app_ready` is a plain read that the settings store makes on its own schedule, and a result that arrived between that read and the subscription would belong to neither; the subscription is the one hand-off, under one lock.) A hover is
not kept (it is stale at once), and so few failures that a window that never listens cannot grow the queue (`MAX_PENDING_FAILURES`); an `opened` is never dropped, each stands for an open document. A message that cannot be sent (the webview is
gone) is kept for the next subscription. The planned notifications are delivered the same way (a channel opened by a command, typed messages, no paths), unless an ADR grants
`listen` for a named event: `doc:reloaded {docId, rev}` · `doc:annotations-imported {docId, pageIds}` · `engine:status {state: ok | wedged}`.

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
| `documents` | `byId: Record<DocId, DocMeta>` (today the `DocumentInfo` of the backend: displayName, pageCount; later pages, rev, flags, history), `order` (opening order), `activeId` (the last one opened or brought forward; the one closed is replaced by its next neighbour, else the previous) | `add` for each `opened` (dialog answer, app channel), `remove` on close, ChangeSet |
| `view` | per doc: zoom, fit (`none` / `width` / `page`, a mode that follows the window), scrollMode (`continuous` / `single` / `spread`), pageIndex (the current page: follows the scroll position in continuous mode), pageCount, anchor (`{ page, xPt, yPt, viewX, viewY }`: where the canvas puts the document next, consumed by it), rotation (view rotation 0/90/180/270, viewing only, in memory; the layout is made from the rotated page sizes, `viewer/transform.ts`) | canvas, toolbar, status bar |
| `pages` | per doc: the size of every page in points (`get_page_sizes`), replaced as a whole; placeholders of US Letter until it arrives | `showDocument` |
| `annotations` | per doc: `rev`, `byId`, `loaded` (pages), `removed` (ids), `history` (can undo/redo, labels, dirty); `annotationsOnPage` selects a page; `selection` and `editing` (transient draft) join with the tools | `loadPage`, ChangeSet (`apply`, `undo`, `redo`); `editing` locally |
| `tools` | active tool, locked, presets per tool | toolbar, actions |
| `search` | per doc (`features/search/store.ts`): query, options, status, `runId`, hits in document order and by page (a page's array is replaced only when that page gets hits), active hit, progress; the pages draw their own hits (`SearchHits`), so a hit or an active hit wakes the pages it concerns, not the document. The UI asks for ≤ 10 000 hits (ADR-026). Text layers are not a store: `features/textlayer/cache.ts` keeps the fetched ones in an LRU bounded by 2 M code units | search Channel |
| `ui` | left panel tab/width/collapsed, inspector mode, active tool (moves to `tools` in M2), drop-hover flag, error banner, dialogs, toasts, engine status | UI, events |
| `settings` | mirror of Rust settings | `get_settings`/`update_settings` |
| `recents` | `RecentEntry[]` | `list_recents`/`remove_recent` |

Rules:
- Stores hold no pixels. The render cache (`renderCache`, with its scheduler) and the text cache are module singletons.
- Document and annotation data change only through ChangeSets and events, never optimistically.
- Page components subscribe through per-page selectors, so re-renders stay local.

## 9. Data flows

- **Open.** Action → `open_document_dialog` (Rust dialog, several files) → `intake::admit` (canonicalize, open once, judge the handle) → `Registry::claim` (dedupe) → engine `Open` with that handle (Control: page sizes, flags) →
  `opened`/`openFailed` per file → `adoptOpenOutcomes` → `documents` store (+ a `view` entry), banner for the first failure → `layout.ts` offsets → visible pages render. A file dropped on the window, opened by the OS or given at startup takes
  the same way from `intake` on and arrives as the same two messages on the app channel (§6), so there is one UI path for every source. Annotation import runs Interactive for visible pages and
  Background for the rest; `doc:annotations-imported` triggers `list_annotations`.
- **Render.** Scroll → `layout.ts` (visible range, ± one viewport height, ≤ 24 pages) → `PageView`s mount, sized from `get_page_sizes`. A page shows the best cached bucket as an `<img src=blob:>` scaled by CSS and asks the scheduler
  for its exact bucket (`bucketFor(zoom, dpr)`; tiles over a low underlay above 4096 px or 8 Mpx) → `render_page` (Visible or Near, stamped with the viewport generation) → the worker renders and encodes → frame → Blob → cache → the exact `<img>` covers the stand-in when decoded. 150 ms after the viewport settles, `set_viewport` cancels the stale jobs and re-ranks the rest. A zoom, a change of scroll mode and a jump to a page set a `ScrollAnchor` that the canvas scrolls to once it has laid out; a change of the display's pixel ratio changes the bucket and renders again.
- **Search.** The search box → `search(doc, query, channel)` → validate, register (one search per document: an earlier one is cancelled) → returns the id; a blocking-pool thread asks the
  engine for page 0, 1, 2, … as `Background` jobs → `hits` per page with quads in page space (the UI draws them over the page and keeps the active hit) · `progress` · `done`.
  Typing again, closing the panel or the document cancels (`cancel_search`, a new `search`, `close_document`); a render on screen is always taken before the next page.
  A hit has quads and no character range, so the list's snippet is found in the page's text layer: the characters whose box centre is inside a quad (`search/snippet.ts`), fetched lazily for the rows on screen.
- **Page overlays and rotation.** Text, hit and link coordinates are page space (unrotated, before `/Rotate`). Everything over a page is one wrapper per page (`PageOverlay`) that is the unrotated page in points, scaled to the zoom and turned by file `/Rotate` + view rotation about its centre (`viewer/transform.ts` `overlayBox`; `pageToView` for single points such as a hit's y when scrolling). Children are placed with the plain numbers Rust sends. The bitmap sits in a surface turned by the view rotation only (the renderer applies `/Rotate`). The file's `/Rotate` is not reported to the UI yet (`viewer/fileRotation.ts` is the seam: 0 until `DocumentInfo.pages` carries it).
- **Text selection and copy.** `get_text_layer` boxes (one per UTF-16 unit) become runs (`textlayer/runs.ts`, one transparent span per line fragment, stretched to the glyph width); spans carry their char range. The browser selects; the `copy` event (primary+C, Edit menu) is answered from the page text between the two boundaries (`textlayer/selection.ts`), as `text/plain`. There is no `get_text` command: the frontend already holds the text, so ligature and hyphen handling stays in Rust's layer reading.
- **Open a link.** `get_page_links` when a page is shown (the UI draws a hit area per link: a `page` target scrolls, a `url` target is a link, `blocked` does nothing) → a click on a `url`
  link → `open_link(doc, page, index)` → Rust re-reads the link, shows the URL in a native dialog, and opens it with the system's handler if the user agrees.
- **Annotate.** A pointer gesture builds a draft in `annotations.editing`. On pointerup, `apply_command(CreateAnnotation)` → validate,
  apply, push history → ChangeSet → store → overlay. A persisted annotation that becomes non-clean is hidden in PDFium, `pageRev`
  increments, and the page re-renders.
- **Command.** Key press → `handleKeyDown` (not from a text field; a bare key only in the canvas) → `runAction(id)`. Toolbar and More clicks call `runAction` too. A macOS menu choice → `on_menu_event` → allowlist → channel → `runAction`. `runAction` looks the id up, asks `enabled(readActionState())` and calls `run()`.
- **Undo.** Ctrl/⌘+Z (Redo: Ctrl+Y or Ctrl+Shift+Z, ⌘+Shift+Z) → the `undo` and `redo` actions (enabled by `ActionState.canUndo` and `canRedo`, from the `annotations` store; in a text field the field's own undo) → `undo` → inverse applied → ChangeSet (same path).
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
| addresses pages by index | address them by `PageId` (stable ids, mapped to engine indices: ADR-036) |
