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
| `sheer-pdfium` | until M7 B1: `Pdfium`, open `PdfDocument`s, `ReplaceFile`; afterwards only in `InProcessTransport` (unit tests) | lopdf |
| `sheer-engine-pump` (M7) | the parent side of the engine process: queue → wire → child, deadlines, restart + replay (§11) | PDFium, lopdf |
| `sheer-engine-reader` (M7) | reads child frames: answers `ReadAt` from `FileTable`, hands replies to the pump | PDFium |
| engine child process (M7) | `sheer --sheer-engine`: `Pdfium`, `PdfDocument`s, one job at a time (§11) | files (except the PDFium library), Tauri, network |
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
signatures/      M4, engine-free and lopdf-free: vector (validate, trim, normalise `PathCmd` paths; no simplification, ADR-051) · typed (skrifa + bundled font → cubic paths) · image (dialog handle → `image` decode → RGBA → PNG) · drafts (DraftStore, ≤ 16)
storage/         atomic (temp + fsync + rename) · backup · settings · app_dirs · signatures (M4: library.bin, XChaCha20-Poly1305) · keychain (M4: `SecretStore` over keyring-core) · autosave (M7)
security/        links (http/https/mailto allowlist, `SafeUrl`) · names (display-name sanitizer; today `documents::sanitize_text`)
menu/            macOS menu bar (ADR-016): mod (MenuBridge: the channel to the UI, the id allowlist, build + rebuild on a language change) · spec (layout of src/actions/menu.json, texts of the UI catalogs, ACTION_IDS)
platform/        windows
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

Only `src/api/call.ts` calls `invoke`: it turns every rejection into an `AppError`, and the typed wrappers (`src/api/app.ts`, `documents.ts`, …) go through it. Everything else imports the wrappers. The window has no event permission (SECURITY T3), so the frontend never calls `listen` or `emit`, and `src/api/app.test.ts` fails on any import of `@tauri-apps/api/event`. Backend pushes (§6) reach it through a `Channel` that a wrapper in `src/api/` passes to a command (`subscribeMenu` → `subscribe_menu`; `src/actions/menuBridge.ts` consumes it. `subscribeApp` → `subscribe_app`; `src/features/viewer/appEvents.ts` consumes it: the drop overlay follows `dropHover`, `opened` and `openFailed` go to `adoptOpenOutcomes`, the same function that takes the answer of the open dialog).

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

The frontend never uses `onDragDropEvent` and cannot receive the `tauri://drag-drop` event that carries the paths: `dragDropEnabled` is `true` on purpose (explicit in `tauri.conf.json`, pinned by `security_baseline.rs`), so Tauri takes the OS drop itself and hands the paths only to Rust's `WindowEvent::DragDrop` handler, and the window has no event permission (SECURITY T3, T9). Rust tells the page `dropHover { active, x?, y? }` over the app channel (§6), without paths (`x`, `y`: the cursor in whole logical px from the window's top-left, at most one message per frame while files are over the window, for the drop glow of MOTION spell 4; `WindowEvent::DragDrop` `Over`); what the drop opens arrives as `opened` or `openFailed`.
Recents store paths in app data. The UI sees only `RecentEntry { id, displayName, folder (parent folder's name only, never a path), lastOpened, missing }`.

## 5. Tauri commands

All commands are `async` and return `Result<T, UiError>`. Bounds come from `limits.rs`. A violation returns `invalid_argument` or
`limit_exceeded`, and an unknown id returns `not_found`.

```rust
// app
app_ready() -> AppBootstrap                          // platform, paper, version
get_settings() -> Settings                           // { language: "system" | "en" | "de", leftPanelWidth: 192..=400 }
update_settings(patch: SettingsPatch) -> Settings    // patch { language?, leftPanelWidth? }; unknown key, enum value or width outside the range → invalid_argument (what: "settings")
subscribe_menu(on_action: Channel<String>, system_language: Option<String>) -> ()
                                                     // each command chosen in the macOS menu bar, as the bare id of the item (kebab-case, `menu::spec::ACTION_IDS` only: system items and any other id are dropped in Rust); one receiver, a new call replaces it; system_language = navigator.language, for the menu's labels while language is "system" (a malformed tag counts as unknown); a no-op listener on Windows, which has no menu bar
subscribe_app(on_event: Channel<AppEvent>) -> ()
                                                     // the backend's pushes, as typed `AppEvent`s without paths: `dropHover { active }` while files are dragged over the window, `opened { document: DocumentInfo }` and `openFailed { code, key, retryable, params? }` for a file opened by a drop, the OS (file association) or a second launch; open results that came before the UI subscribed (a file the app was started with is opened while the window loads) are sent first, in order, once; one receiver, a new call replaces it
// documents
open_document_dialog(single?: bool) -> Vec<AppEvent> // multi-select (one file with `single`, for the hub cards of one-file tools), ≤ 32 files, in the dialog's order: `opened { document }` or `openFailed { .. }` each (one more `openFailed` limit_exceeded `documents` if more were chosen); empty = cancelled. `OpenResult { status: NeedsPassword }` comes with passwords
open_recent(recent_id: u32) -> AppEvent             // ADR-026: like a file from the dialog, `opened { document }`, `needsPassword { id, displayName }` or `openFailed { .. }` (a file that is gone: io_not_found, and the entry stays listed as `missing`); an id that is not listed → not_found. Recents are recorded when a document the user opened (never the welcome document) is loaded, and at most 50 are kept
restore_recent(recent_id: u32) -> bool           // Undo of a removal (DESIGN 3.11/3.12): puts the entry back where it was; false if it was not removed in this run or is listed again
set_recent_starred(recent_id: u32, starred: bool) -> () // "Markiert" favourite flag, persisted in `recents.json` (`starred`, absent = false); starred entries are never evicted by the 50 cap (at most 49 can be starred); removing an entry from the list drops it and its star (Undo restores both); unknown id → not_found
reveal_recent(recent_id: u32) -> ()              // "Show in Explorer/Finder": Rust calls tauri-plugin-opener `reveal_item_in_dir` on the stored path (no JS capability); unknown id, network/device path or a file that is gone → not_found, nothing is spawned
locate_recent(recent_id: u32) -> bool            // "Locate…" for a missing file: Rust shows the file dialog and replaces the entry's path in storage (the path never reaches the UI); false on cancel; unknown id → not_found
open_welcome_document() -> AppEvent                 // ADR-023, DESIGN §3.14: opens the bundled `resources/welcome/welcome-{en,de}.pdf` for the resolved UI language (settings language, "system" = the language `subscribe_menu`/`app_ready` reported, else en) through `intake::admit` like any file; the path is resolved in Rust from the resource dir and never crosses IPC; `opened { document }` with `kind: Welcome` and `display_name` "Welcome to {app}.pdf" (localized), or `openFailed`; a welcome document already open is closed with discard first (restart). Not added to recents
list_recents() -> Vec<RecentEntry>                   // ≤ 50, newest first; `RecentEntry { id, displayName, folder (parent folder's name only), lastOpened (s since 1970), missing, starred }`, ids are per run, stored in `recents.json` (app data dir, atomic, hostile-input tolerant)
remove_recent(recent_id: u32) -> ()                 // an unlisted id is not an error; the file is untouched
unlock_document(doc_id: DocId, password: String) -> DocumentInfo        // 1..=1024 bytes, no NUL (invalid_argument); one attempt per document at a time and 4 in all, else limit_exceeded (ADR-028); for a document that waited as `needsPassword` (else not_found); held as `Zeroizing<String>`, never stored or logged; wrong → password_required, and after the 3rd wrong one each try waits 1 s in Rust (ADR-026); any other failure forgets the document. `close_document` on a waiting id cancels it
set_menu_state(has_document: bool) -> ()            // macOS menu bar: commands that need a document are greyed without one and Cmd+W closes the window; a no-op on Windows
get_document_info(doc_id: DocId) -> DocumentInfo
close_document(doc_id: DocId, discard: Option<bool>) -> ()            // dirty && !discard → unsaved_changes (the welcome document never)
save_document(doc_id: DocId, ack: SaveAck) -> SaveResult
save_document_as(doc_id: DocId, opts: SaveAsOptions, ack: SaveAck) -> Option<SaveResult>  // None = cancelled
revert_document(doc_id: DocId) -> DocumentInfo
get_outline(doc_id: DocId) -> Vec<OutlineNode>       // ≤ 10 000 nodes, depth ≤ 32, title ≤ 512 chars sanitized like a display name; a target is a page id and y, or none; a cycle in the file ends where it comes back; node = { title, target, children, derived }; `derived` is true on every node when the file has no bookmarks and the tree was made from headings (ADR-113: ≤ 200 entries, ≤ 3 levels, titles ≤ 200 chars)
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
smart_links(doc_id: DocId, page_id: PageId) -> { rev: u64, ready: bool, partial: bool, links: SmartLinkWire[] }   // ADR-132, DESIGN §3.11; detected footnotes, contents, references, sources; never written into the PDF; `ready: false` = the per-revision document index is still building in the background (links empty, ask again); `SmartLinkWire` = `{ kind: footnote|noteBack|contents|reference|literature, rects: Rect[] (page points, top-left origin; contents: [page number, whole line]), marker, target: { pageId, rect? }, preview ≤ 280 chars }`, ≤ 400; candidates over a real link, widget or annotation are dropped (L3); a page with a text edit has none; engine read job `Job::SmartText` (wire `SmartText`) at `Background` priority, limits `limits::*_SMART_*`; off = the UI does not call; `partial: true` = the index hit its time/size limit and is a prefix of the document (links into the missing pages are not found; the frontend may ignore it); document-wide lookups (endnotes, caption and heading targets without contents and list-of-figures lines, bibliography) are built once per revision with the index, `detect` runs per page; the index holds the file text, so a page with a session text edit has no links itself but its unedited file text still feeds its neighbours' detection (accepted: the index never contains session edits)
// edit (ADR-003)
// F15 B4 (ADR-110): a FreeText body also carries `align` (left|center|right) and `borderColor` (Rgb|null); `AnnotationPatch.borderColor` sets it; saved as /Q, /DA (rg + RG), /BS /W, /C
list_annotations(doc_id: DocId, page_id: PageId) -> Vec<Annotation>   // by id, ≤ 2 000; the first call for a page reads it from the file (`Interactive`), later calls answer from the model
list_document_annotations(doc_id: DocId) -> Vec<AnnotationSummary>   // {id, pageId, kind, color, contents (≤ 240 chars), author, modified, inReplyTo} + optional `state` (review state of a reply: none|accepted|rejected|cancelled|completed) and `detail` (mark glyph check|cross|dot, signature role signature|initials; ADR-057), ≤ 20 000, by page then id; reads unread pages at `Background`; for the comments panel (`features/comments`)
get_annotation_quote(doc_id: DocId, annotation_id: AnnotId) -> Option<String>   // text under a highlight/underline/strikeout: characters whose centre is in a quad, whitespace collapsed, ≤ 280 chars (… last if cut); null for other kinds; not_found for an unknown id. F12-P4, DESIGN 3.59
// Review replies (F12-P4): `createAnnotation` with `draft.state` (accepted|rejected|cancelled|completed|none) makes a Text annotation with `/IRT`, `/RT /R`, `/StateModel (Review)`, `/State (…)`, flag Hidden, no appearance; it needs `inReplyTo`, a note body and empty contents (else invalid_argument `state`). A page read links replies and states from the file (`pdfwrite::reviews`, lopdf, best effort; encrypted documents have no threads).
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
struct AppBootstrap  { platform: Platform /* macos | windows | linux */, version: &'static str }
enum   AppEvent      { DropHover { active: bool, x?: i32, y?: i32 }, Opened { document: DocumentInfo }, OpenFailed { code, key, retryable, params? } }  // wire: `{ "type": "dropHover" | "opened" | "openFailed", ..fields }`, camelCase; OpenFailed carries the error of §7 flat and names no file; no variant has room for a path
struct Settings      { language: Language /* System | En | De */, left_panel_width: PanelWidth, welcome_tour: WelcomeTour /* Pending | Shown */, author_name: AuthorName /* "" or ≤128 chars, sanitized, no control chars; default "" (ADR-034) */, author_prompt: AuthorPrompt /* Pending | Done */ }   // serde lowercase values; `welcomeTour` default pending (missing or invalid → pending), the UI writes `shown` before it calls `open_welcome_document` on first launch (ADR-023)
```

**Menu bar.** On macOS `menu::install` builds the menu bar at startup from `src/actions/menu.json` (App, File, Edit with the system items, View, Window, Help; the labels are the `menu.*` keys of `src/i18n/locales/*.json`, compiled in with `include_str!`) and `.on_menu_event` hands each chosen item to `MenuBridge::forward`, which sends it on the channel of `subscribe_menu` if `menu::spec::is_action_id` allows it. `update_settings` rebuilds the menu when `language` changes (`menu::refresh`, on the main thread); "system" uses the language `subscribe_menu` reported. Windows has no menu bar (ADR-016): nothing is installed there. Open runs like every other command: the menu sends `open`, the UI calls `open_document_dialog`. The menu is not synchronised with the UI's state (items are not greyed without a document): `runAction` refuses a command that cannot run, which is all the menu needs.

**Settings.** `storage::settings` keeps the settings in memory and in `<app data dir>/settings.json`. A missing, oversized (> 64 KiB), damaged
or hand-edited file never blocks start: only a regular file is read (its type is taken from the opened handle, not from the path, and on Unix it is opened
`O_NONBLOCK` so a FIFO cannot hang the start), and each field that is invalid falls back to its default. `update_settings`
takes the patch as raw JSON, validates all of it first (an object that passes a `deny_unknown_fields` struct, so at most `language`, `leftPanelWidth`, `welcomeTour`, `authorName` and `authorPrompt`, with
known enum values) and writes it with `storage::atomic::write_atomic`: a temp file `.settings.json.<pid>.<n>.tmp` (process id and a per-process counter, so no two
writers share one) is created with `create_new` (a name that is taken is skipped, never written through; mode `0600` on Unix, directories `0700`), fsynced,
renamed over the file, and the directory is fsynced on Unix. At startup `sweep_stale_temp_files` removes the temp files of that exact name pattern that a crash left in the data directory and that are older than an hour. Only after the write succeeds does the
in-memory copy change, so a failed write leaves memory and disk in agreement. Updates are serialised by a writer lock that is held across the
write; the lock that guards the in-memory copy is not, so `get_settings` never waits for the disk.
The light-only redesign (ADR-100) removed the `glass` and `theme` keys: a file that still has them loads, and `drop_retired_keys` rewrites it once at startup so they are gone. Startup does not wait for the backend: `src/main.tsx` renders with the defaults at
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
create_drawn_signature(role: SignatureRole, outlines: Vec<Vec<PathCmd>>) -> SignatureDraft   // cubic Bézier outlines in pad pixels (ADR-051): <= 64 paths, <= 20 000 commands; Rust validates, trims, scales to 1000 units, never simplifies
create_typed_signature(role: SignatureRole, text: String, font: TypedFont) -> SignatureDraft  // 1..=64 chars, no control chars
import_signature_image(role: SignatureRole, remove_background: bool) -> Option<SignatureDraft> // Rust open dialog (PNG, JPEG); None = cancelled
list_signatures() -> SignatureLibrary
save_signature(draft_id: DraftId) -> SignatureItem    // keychain missing, refused or timed out → keychain_unavailable, never kept in memory only (ADR-107); locked → invalid_argument (what: "library"); 32 items → limit_exceeded
delete_signature(item_id: String) -> ()               // 32 lowercase hex; unknown → not_found
clear_signature_library() -> ()                       // deletes library.bin and the keychain entry; the way out of `locked`
get_signature_preview(art: SignatureRef, max_px: u16 /* 16..=1024 */) -> tauri::ipc::Response   // SHR1 PNG frame of raster art
use_signature(doc_id: DocId, art: SignatureRef) -> AssetInfo   // copies the art into the document's assets; then CreateAnnotation { kind: "signature" }
// ADR-105: Signature and Mark annotations (draft, patch and wire) carry `angle: f32` degrees, clockwise on the page, default 0, normalised to (-180, 180]; non-finite → invalid_argument ("angle"). `box` is the box before the turn, `rect` the bounds of the turned box. AnnotationPatch gains `angle` (signature, mark only). Saved as the appearance `/Matrix`; the turn and box ride in `/NM` suffix `-r<centi-deg>-<w*100>-<h*100>`
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
type PathCmd = ['M', number, number] | ['L', number, number] | ['C', number, number, number, number, number, number] | ['Z'];  // ADR-051; written 1:1 as m / l / c / h + one f; typed = skrifa curves (quad raised to cubic); image art: white 225..245 luminance fades to transparent, <= 3000 px long side, never upscaled
type TypedFont = 'dancingScript' | 'greatVibes' | 'alexBrush';  // DESIGN 3.60, SIL OFL 1.1 fonts, unmodified; default dancingScript
type SignatureArt = { type: 'vector'; w: number; h: number; paths: PathCmd[][] /* nonzero fill, y down, 1000 units high; also what the library stores (old polygon entries load as L paths) */ }
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
// ADR-055 (supersedes raster_page): the page again without what lies under the marks; burn = page space, from the top left of the shown box
pub fn redact_content::redacted_page(src: &Document, page: ObjectId, shown: [f32; 4], rotation: u16, burn: &[Rect]) -> Result<Vec<u8>, AppError>;
pub fn redact_content::redacted_blank(size: [f32; 2], rotation: u16, burn: &[Rect]) -> Result<Vec<u8>, AppError>;   // + redact_image.rs (pixels of one image)
pub fn redact::scrub(doc: &mut Document, redacted: &[ObjectId]) -> Result<(), AppError>;   // StructTreeRoot, MarkInfo, Thumb, PieceInfo, orphan fields, new /ID
pub fn crypt::encrypt_r6(doc: &mut Document, p: &PendingProtection) -> Result<(), AppError>;
pub fn crypt::read_protection(bytes: &[u8], password: Option<&Secret>) -> Result<ProtectionRead, AppError>;
pub fn metadata::read(doc: &Document) -> Result<MetadataRead, AppError>;
pub fn metadata::write(doc: &mut IncrementalDocument, m: &MetadataValues, had_xmp: bool, now: PdfDate) -> Result<(), AppError>;
pub fn metadata::strip(doc: &mut Document) -> Result<(), AppError>;
// AppState gains engine() -> &Engine and has_unsaved_changes(DocumentId) -> bool for the modules outside `commands`.
// platform::paper_default() -> Paper { A4, Letter } (A4 until package B reads the OS region); model::ranges::PageSelection (serde twin of the TS type).
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
- *Redaction (ADR-055, surgical; ADR-047 §3 raster dropped).* `apply_redactions`: snapshot of the marked pages (`PageWork` carries `source` and `shown`) → per page the
  content is read from the file (decrypted with the session password if needed; a file changed on disk is `needs_confirmation`), the import source or the old
  redacted page and written again by `redact_content::redacted_page` (text cut per glyph with a `TJ` kerning gap, strokes cut, rectangle fills holed, images
  blacked out in the covered pixels, forms copied and cut, shadings clipped, annotations not carried, a black rectangle per mark; limits `MAX_REDACT_*`)
  → engine append (Control) → one model step (`redact.apply`) swapping slots to `Redacted`. A page that changed while the job
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
images_to_pdf(opts: ImagesToPdfOptions, order?: u32[], on_event: Channel<JobEvent>) -> Option<JobId>   // batch source: order = indices into the batch in page order (permutation or subset, ≤ 500, no repeats; else invalid_argument "order"); None = cancelled; done.opened
pick_images(batch?: u32) -> Option<{ batch, count, added, skipped }>                    // Rust open dialog appends PNG/JPEG to the batch (new batch when absent); None = cancelled or nothing usable
list_image_batch(batch: u32) -> [{ index, name, width, height }]                        // name = file name only, ≤ 120 chars; size from the header (0 = unreadable); not_found "imageBatch" when expired
get_image_batch_preview(batch: u32, index: u32, max_px: u16 /*16..=512*/) -> SHR1 frame // decoded under the M5 intake limits, cached per batch
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
pub struct SnapshotId(u32);   // SnapshotId::fresh(): process-wide counter, called by the worker that opens it
pub struct Snapshot { bytes: Option<Arc<[u8]>> /* None = clean, live document */, engine: EngineDocRef }
pub enum EngineDocRef { Live(DocumentId), Snapshot(SnapshotId) }
pub fn export::snapshot::current(app: &AppState, doc: DocumentId) -> Result<Snapshot, AppError>;   // blocking pool; ≤ 1 GiB
pub fn pdfwrite::save::write_to_memory(plan: &SavePlan, input: &[u8]) -> Result<Vec<u8>, AppError>; // Full, unencrypted, no backup
pub fn pdfwrite::images_pdf::build(pages: &[ImagePage], producer: &str) -> Result<Vec<u8>, AppError>;
pub struct ImagePage { image: ImageAsset /* content::image output (`prepare`) */, size_pt: [f32; 2], place: Rect /* pt, fitted */ }
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
// Engine::{open_snapshot(Arc<[u8]>) -> SnapshotId, close_snapshot(SnapshotId), render_export(EngineDocRef, engine_index, dpi, annotations, rotate_quarter) -> RasterPage}
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
// PageSelection is src/api/pageSelection.ts (shared by exportImages.ts and print.ts). print.ts parses SHR1 frames of format 3 = JPEG
// (format 1 = PNG, 2 reserved): width and height 1..=10 000, payload starts FF D8 FF.
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
  { margin: 0 }`) loads all frames, awaits decode, calls `open_print_dialog`, releases the backend set when the call returns; the frames and blob URLs stay until `afterprint` (+30 s, at most 5 min) because `Webview::print()` returns when the dialog opens, not when WKWebView has painted (ADR-107).
  Permissions: `print` for print, `copy` for images out, `edit` for export-copy transforms of a restricted document.
- *Limits* (`limits.rs`): selection ≤ 5 000 pages; dpi 36..=600; export bitmap ≤ 10 000 px per side, ≤ 64 MP; ≤ 5 000 image files per
  job, ticket 5 min; images in ≤ 500 per job and per batch, batch 10 min, stored sum ≤ 1 GiB, M5 per-image limits; margin 0..=72 pt;
  page 72..=14 400 pt; snapshot ≤ 1 GiB; print ≤ 2 000 pages (`high` ≤ 300), ≤ 768 MiB per set, ≤ 4 sets.
- *Errors.* New `what` values: `exportPixels` (params `{ page }`), `exportTarget`, `snapshot`, `printJob`, `printDialog`, `imageBatch`,
  `pageSelection`; each with `error.<code>.<what>` in en and de. Codes: `exportPixels` `limit_exceeded` (params `{ what, page }`: `UiParams`/`ErrorParams` gain `page`), `exportTarget` and
  `pageSelection` `invalid_argument`, `snapshot` and `printJob` `limit_exceeded`, `printDialog` `unsupported_feature`, `imageBatch` `not_found`; `create_unique`
  with a bad extension is `invalid_argument` `extension` (internal, no text).
- *Tests.* `tests/export_images.rs` (names never contain `/Title` or label bytes, hostile display names, conflict ticket, `create_new`
  never overwrites, `dpiLowered`, cancel keeps files), `tests/images_to_pdf.rs` (fit/A4/Letter geometry, EXIF orientation, skipped images,
  result opens in PDFium), `tests/snapshot.rs` (unsaved text box and annotation appear in a render, marks never), `tests/export_pdf.rs`
  (remove keeps links and widgets, strip leaves no `/Info` or `/Metadata`, encrypted copy reopens with its password, source untouched),
  `tests/print_set.rs` (caps, release on close, frames decode).

### Ship (M7) (ADR-053; `engine/{wire,transport,pump,host,remote_file,files,ledger}.rs`, `storage/autosave.rs`, `update/`, `commands/{recovery,update,app}.rs`)

```rust
// commands/recovery.rs: every answer names records by a session-scoped id, never by path
async fn list_recoveries(state) -> Result<Vec<RecoveryEntry>, UiError>;
async fn restore_recovery(state, id: RecoveryId) -> Result<AppEvent, UiError>;  // opened | needsPassword | openFailed (TS: OpenOutcome), as DocKind::Recovered
async fn discard_recovery(state, id: RecoveryId) -> Result<(), UiError>;
async fn discard_all_recoveries(state) -> Result<u32, UiError>;                    // how many were removed

// commands/update.rs: the only commands that reach the network, and only through update/
async fn check_for_update(app, state) -> Result<Option<UpdateInfo>, UiError>;      // unsupported_feature while the key is the placeholder
async fn download_update(app, state, on_event: Channel<UpdateEvent>) -> Result<(), UiError>; // download + verify, keeps the package in memory
async fn install_update_on_quit(state) -> Result<(), UiError>;                     // marks it; the quit flow installs after dirty docs resolve
async fn skip_update_version(state, version: String) -> Result<(), UiError>;       // ≤ 32 chars, semver checked
async fn updater_configured() -> Result<bool, UiError>;                            // is the embedded key real; no network, no state (Settings → Updates visibility)

// commands/app.rs
async fn open_default_apps_settings(app) -> Result<(), UiError>;                   // Windows: ms-settings deep link; macOS: unsupported_feature
```

```ts
type RecoveryId = number;
interface RecoveryEntry { id: RecoveryId; displayName: string; folder: string | null; savedAt: string /* ISO 8601 */;
  pageCount: number; original: 'unchanged' | 'changed' | 'missing'; }
interface UpdateInfo { version: string; date: string | null; notes: string /* plain text, ≤ 4 KiB, control/bidi chars stripped */ }
type UpdateEvent =
  | { kind: 'progress'; downloaded: number; total: number | null }
  | { kind: 'verified' }                       // ready; install happens on quit
  | { kind: 'failed'; code: ErrorCode };       // a bad signature deletes the download (ADR-054 §4)
type AutosaveStatus = 'on' | 'offEncrypted' | 'offTooLarge' | 'clean';   // DocumentInfo.autosave
// AppEvent gains: { kind: 'engineRestarted'; lost: DocId[] } and { kind: 'updateAvailable'; info: UpdateInfo } (automatic check only)
```

- *Settings.* `updates: 'off' | 'on'` (default `'off'`), `skippedVersion: string | null`, `lastUpdateCheck` (Rust-only, not sent).
- *Limits* (`limits.rs`): `ENGINE_HANDSHAKE_TIMEOUT` 5 s; `ENGINE_RESTART_BUDGET` 5 per `ENGINE_RESTART_WINDOW` 10 min; `MAX_FRAME_BYTES` 80 MiB (a render reply's blob cap); `ENGINE_LOG_LINE_MAX` 4 KiB; `UPDATE_VERSION_MAX_CHARS` 32; `ENGINE_STRIKES` 2; `WIRE_HEADER_MAX`
  16 MiB; `READ_AT_MAX` 1 MiB; remote block cache 64 × 256 KiB per document; `AUTOSAVE_DEBOUNCE` 30 s, `AUTOSAVE_MAX_INTERVAL` 120 s,
  `AUTOSAVE_DOC_MAX` 512 MiB, `AUTOSAVE_STORE_MAX` 2 GiB, `AUTOSAVE_RETENTION` 30 days; `UPDATE_CHECK_INTERVAL` 24 h; update package
  ≤ 256 MiB, notes ≤ 4 KiB.
- *Errors.* New `what`: `engine` (`engine_crashed` after quarantine), `autosave` (`io_*` while writing: logged, never a banner), `recovery`
  (`not_found`), `update` (`unsupported_feature` placeholder key, `damaged_file` bad signature, `internal` for any network or
  HTTP failure, details logged only), `updateVersion` (`invalid_argument`). Each with `error.<code>.<what>` in en and de.
- *Tests.* `tests/engine_process.rs`, `tests/autosave.rs` (no file for encrypted or pending-protection docs; 0600; deleted on save and
  close; dead-session scan via `try_lock`; Recovered saves as Save As), `tests/updater_scope.rs` (endpoint is the one HTTPS constant,
  no `updater:` capability, plugin named only in `update/`), `tests/perf_open.rs` (`#[ignore]`), `security_baseline.rs` (release CSP
  without `'unsafe-inline'`, NSIS hooks never write the `.pdf` default value).

### Citations (v1.3, ADR-119; `model/{annotation,quote,tags,bibliography,command,doc_state}.rs`, `pdfwrite/{annots,sheer_keys,bibliography}.rs`, `engine/{page_labels,first_page}.rs`, `export/citations.rs`, `storage/settings.rs`, `commands/{citations,bibliography,citation_export,annotations,app,save}.rs`)

```rust
// commands/citations.rs
create_citations(doc_id: DocId, drafts: Vec<CitationDraft>) -> ChangeSet   // ≤ 64 drafts, one page each (unique); Rust reads the page text (Interactive), quote = text under the quads (model::quote, ≤ 2 000 chars), one Batch `citation.create`, shared group id if > 1; empty quote → invalid_argument `citation`; `edit` permission gated
list_citations(doc_id: DocId) -> Vec<CitationInfo>   // ≤ 20 000, page order then position; reads unread pages at Background; first call runs Job::PageLabels (cached); locator resolved now
// commands/bibliography.rs
get_bibliography(doc_id: DocId) -> BibliographyInfo  // first call: Info + XMP + /SHR_Bib (blocking pool, load_untrusted, 30 s) then Job::FirstPageHints only for empty title/authors/year; then from DocState.bibliography
apply_command(doc_id, DocCommand::SetBibliography { record: BibRecord }) -> ChangeSet   // one undo step `bibliography.set`; ChangeSet.doc gains "bibliography"; written by the next save
// commands/citation_export.rs
save_citation_list(doc_id: DocId, format: CitationFileFormat, blocks: Vec<StyledBlock>, style: CitationStyle, lang: Option<String>) -> bool
                                                     // Rust save dialog, default name `<stem> - citations (<style>).<ext>` via export::names; txt|html|md written from `blocks` with Rust escaping;
                                                     // ris|bib written from the stored BibRecord (blocks must be empty); atomic write; false = cancelled; ≤ 20 000 blocks, ≤ 4 MiB of text
// commands/annotations.rs (changed)
get_annotation_quote(..) -> Option<String>           // a citation answers its stored quote, cut to 280
list_document_annotations(..) -> Vec<AnnotationSummary>   // summary gains `tags: Vec<String>`, `cite: bool`
// commands/app.rs (changed)
update_settings(patch: SettingsPatch) -> Settings    // patch gains `tags?: TagDef[]` (replaces the list; ≤ 64, names 1..=40 chars unique case-insensitive, colour ∈ TAG_PALETTE) else invalid_argument (what: "tags")
// engine jobs
Job::PageLabels { engine_index: u32 } -> Vec<Option<String>>   // Background; PdfPage::label(), ≤ 64 chars, display-name filter; 2 s budget → all None
Job::FirstPageHints { engine_index: u32 } -> FirstPageHints { title: Option<String>, year: Option<String>, doi: Option<String> }   // page 1, ≤ 20 000 chars, 1 s
// pdfwrite
pub fn sheer_keys::read_page(bytes: &[u8], page_index: u32) -> Result<HashMap<u32, SheerKeys { cite: Option<Cite>, tags: Vec<String> }>, AppError>;
pub fn bibliography::read(doc: &Document) -> Result<BibRead { record: Option<BibRecord>, xmp: BibFields, info: BibFields }, AppError>;
pub fn bibliography::write(doc: &mut IncrementalDocument, record: &BibRecord) -> Result<(), AppError>;   // after metadata::write; edits the newest /Info
```

```rust
struct Cite            { quote: String /* 1..=2 000 */, group: Option<String> /* 8 hex */ }        // Annotation.cite (Highlight only), file: /SHR_Cite << /V 1 /Q /G >>
// Annotation gains: cite: Option<Cite>, tags: Vec<String> /* ≤ 8 */   (serde default; file: /SHR_Tags [(name) …])
// AnnotationPatch gains: tags: Option<Vec<String>>, quote: Option<String> /* citation only */
struct CitationDraft   { page_id: PageId, quads: Vec<Quad> /* 1..=512 */, color: Rgb, contents: String /* ≤ 32 768 */, tags: Vec<String> }
struct CitationInfo    { id: AnnotId, page_id: PageId, locator: String /* label or position+1 */, quote: String, contents: String, tags: Vec<String>, group: Option<String>, color: Rgb }
enum   BibKind         { Book, Article, Chapter, Report, WebPage, Thesis }        // serde camelCase
struct Person          { family: String, given: String }                         // ≤ 256 chars each
struct BibRecord       { kind: BibKind, authors: Vec<Person> /* ≤ 32 */, title, year /* ≤ 16 */, container_title, volume, issue, pages, edition,
                         publisher, place, doi /* ≤ 256 */, url /* ≤ 2 048, never opened */, accessed /* YYYY-MM-DD */ : Option<String> each }   // file: /SHR_Bib in /Info
enum   BibSource       { User, Xmp, Info, Heuristic, None }
struct BibliographyInfo { record: BibRecord /* merged */, sources: HashMap<BibField, BibSource>, pending: bool, dropped_by_strip: bool }
struct TagDef          { name: String, color: Rgb }                              // Settings.tags: Vec<TagDef>
enum   CitationStyle   { Apa7, Mla9, Chicago17AuthorDate, DinIso690 }
enum   CitationFileFormat { Txt, Html, Md, Ris, Bib }
struct StyledBlock     { runs: Vec<Run { text: String, italic: bool }> /* ≤ 64 runs, ≤ 4 000 chars per run */ }
```

```ts
// src/features/citations/format/ (pure; golden tests)
type CitationStyle = 'apa7' | 'mla9' | 'chicago17AuthorDate' | 'dinIso690';
function formatReference(r: BibRecord, s: CitationStyle, lang: 'en' | 'de'): StyledBlock;
function formatInText(r: BibRecord, c: CitationInfo[] /* one group */, s: CitationStyle, lang: 'en' | 'de'): StyledBlock;
function formatCitationList(r: BibRecord, cs: CitationInfo[], s: CitationStyle, lang: 'en' | 'de'): StyledBlock[];  // reference, then quote + in-text locator (+ comment) per group
function toClipboard(blocks: StyledBlock[]): { text: string; html: string };   // HTML escaped, <i> for italic only
```

- *Import.* After the engine reads a page, `read_page_file(.., sheer_keys::read_page)` merges `cite` and `tags` like the review links. A Highlight with a valid `/SHR_Cite /V 1` is a citation; anything else is a plain highlight with no error. Strings pass the display-name filter and the caps.
- *Write.* `annots::annotation_dict` sets or removes `/SHR_Cite` and `/SHR_Tags` from the model. On a page whose keys could not be read, it keeps the existing `SHR_*` keys. `/Contents` is only ever the comment.
- *Save.* `SavePlan.bibliography: Option<BibRecord>` → `bibliography::write` after `metadata::write` (incremental). It is skipped with a pending strip (`dropped_by_strip`).
- *Limits* (`limits.rs`): `CITE_QUOTE_MAX` 2 000, `CITE_DRAFTS_MAX` 64, `CITATIONS_MAX` 20 000, `TAGS_MAX` 64, `TAG_NAME_MAX` 40, `TAGS_PER_ANNOT` 8, `PAGE_LABEL_MAX` 64, XMP depth 32 / 200 000 events, `CITATION_EXPORT_MAX` 4 MiB.
- *Errors.* New `what`: `citation`, `bibliography`, `tags`, `citationExport`; each with `error.<code>.<what>` in en and de.

### Certificate signatures (v1.4, ADR-121; `pdfsig/{mod,types,identity,p12,certgen,cms_build,ess,verify,revisions,coverage}.rs`, `pdfwrite/{sigread,sign,seal,unsign}.rs`, `model/{sig_policy,doc_state}.rs`, `storage/{identities,trust,keychain}.rs`, `commands/{identities,sign,sig_validate,unsigned_copy,pages,save}.rs`)

Import rule (CI grep): `der`, `spki`, `pkcs8`, `x509_cert`, `cms`, `rsa`, `p256`, `p384`, `sha1`, `p12_keystore` appear only in `pdfsig/`, which has no engine and no lopdf code. Private keys, PKCS#12 bytes and paths never cross IPC. All of these commands run on the blocking pool.

```rust
// commands/identities.rs (v1.4.1)
list_signing_identities() -> SigningIdentities              // status like the signature library; ≤ 8 items
create_signing_identity(spec: NewIdentitySpec) -> SigningIdentityInfo   // ECDSA P-256, self-signed, 3 years; keychain missing → keychain_unavailable; 8 items → limit_exceeded
pick_identity_file() -> Option<IdentityImportTicket>        // Rust open dialog (.p12/.pfx), ≤ 256 KiB held in memory; None = cancelled; one ticket at a time, 10 min
import_signing_identity(ticket: u32, password: Secret) -> SigningIdentityInfo   // wrong → password_incorrect (1 s delay from the 4th try, ticket dropped after 5);
                                                            // no single key + matching cert → invalid_argument `identityFile`; other key types → unsupported_feature `signingKey`
discard_identity_import(ticket: u32) -> ()                  // an unknown ticket is not an error
delete_signing_identity(identity_id: String) -> ()          // 32 lowercase hex; unknown → not_found
export_signing_certificate(identity_id: String) -> bool     // Rust save dialog, `<CN>.cer` (DER, public certificate only); false = cancelled
// commands/sign.rs (v1.4.1, v1.4.2)
sign_document(doc_id: DocId, request: SignRequest) -> Option<SaveResult>
    // Rust save dialog (default `<stem> (signed).pdf`, the same file allowed), None = cancelled. PAdES B-B, one appended revision, never Full.
    // dirty → unsaved_changes; file changed → needs_confirmation fileChangedOnDisk; encrypted → unsupported_feature `signEncrypted`; XFA → unsupported_feature `xfa`;
    // DocMDP P=1 → read_only `certified`; expired identity → invalid_argument `identityExpired`. The result is re-admitted; history empty
save_unsigned_copy(doc_id: DocId) -> Option<AppEvent>      // Rust save dialog; Full rewrite without /Perms, signature values, dictionaries and signed widgets; `opened` (a new user document)
// commands/sig_validate.rs (v1.4.3)
validate_signatures(doc_id: DocId) -> SignatureReport       // ≤ 32 signatures, 60 s; cached in DocState until reload
open_signed_revision(doc_id: DocId, signature: u32) -> AppEvent   // bytes [0, b+c) as DocKind::SignedRevision (read-only, never a recent); `opened` | `openFailed`
set_signer_trust(doc_id: DocId, signature: u32, trusted: bool) -> SignatureReport   // pins/unpins the signer cert's SHA-256 read in Rust; ≤ 256 pins
list_trusted_signers() -> Vec<TrustedSigner>
remove_trusted_signer(fingerprint: String) -> ()            // 64 lowercase hex; unknown → not_found
// changed
apply_command(..)       // a command the lock does not allow → read_only `signed` (fillAndSign: setFieldValue only; annotateFillAndSign: + annotation commands; locked: none)
save_document(..)       // a signed document saves Incremental only; anything that needs Full → read_only `signed`
get_document_info(..)   // DocumentInfo gains `signatureLock`; DocKind gains `SignedRevision`
// pdfwrite / pdfsig
pub fn sigread::scan_fields(doc: &Document) -> Result<SigScan { fields: Vec<SigField>, doc_mdp: Option<u8> }, AppError>;   // W0, bounded
pub fn sigread::revisions(bytes: &[u8]) -> Result<Vec<u64> /* revision end offsets */, AppError>;   // startxref /Prev chain, ≤ 64
pub fn sign::prepare(original: &[u8], doc: &Document, plan: &SignPlan) -> Result<Prepared { bytes: Vec<u8>, gap: Range<usize> }, AppError>;  // placeholders patched
pub fn seal::appearance(spec: &SealSpec, art: Option<&Art>) -> Result<Stream, AppError>;
pub fn pdfsig::cms_build::sign(digest: &[u8; 32], identity: &UnlockedIdentity) -> Result<Vec<u8> /* DER ContentInfo */, AppError>;
pub fn pdfsig::verify::check(sig: &RawSignature, ranges: &mut dyn Read) -> SignatureCheck;   // never panics out (catch_unwind in the caller)
```

```ts
type KeyKind = { type: 'ecP256' } | { type: 'ecP384' } | { type: 'rsa'; bits: number };
interface CertName { commonName: string; organization: string | null; email: string | null }   // display-name filter, ≤ 128 each
interface CertSummary { subject: CertName; issuer: CertName; selfSigned: boolean; notBefore: string; notAfter: string /* ISO 8601 */;
  serialHex: string /* ≤ 64 */; fingerprintSha256: string /* 64 hex */ }
interface SigningIdentityInfo extends CertSummary { id: string /* 32 hex */; source: 'generated' | 'imported'; key: KeyKind; chainLength: number; expired: boolean }
interface SigningIdentities { status: 'ready' | 'empty' | 'unavailable' | 'locked'; items: SigningIdentityInfo[] }
interface NewIdentitySpec { name: string /* 1..=64 */; email: string | null /* ≤ 254 */; organization: string | null /* ≤ 64 */ }
interface IdentityImportTicket { ticket: number; displayName: string }
interface SealPlacement { pageId: PageId; rect: Rect /* page space, ≥ 72×24 pt, inside the CropBox */ }
interface SignRequest { identityId: string; placement: SealPlacement | null /* null = invisible */; art: SignatureRef | null;
  reason: string | null /* ≤ 128 */; location: string | null /* ≤ 64 */; lock: 'allowFillAndSign' | 'noChanges' /* P=2 | P=1; certification only */ }
type SignatureLock = 'none' | 'fillAndSign' | 'annotateFillAndSign' | 'locked';
type LaterChanges = { signatures: boolean; formFill: boolean; annotations: boolean; other: boolean };
interface SignatureInfo {
  index: number; fieldName: string /* ≤ 512 */; kind: { type: 'certification'; p: 1 | 2 | 3 } | { type: 'approval' } | { type: 'docTimestamp' };
  subFilter: 'etsiCadesDetached' | 'adbePkcs7Detached' | 'adbePkcs7Sha1' | 'etsiRfc3161' | 'other';
  signer: CertSummary | null; claimedTime: string | null /* /M, else signing-time; always "claimed" */; reason: string | null; location: string | null;
  cryptographic: 'valid' | 'invalid' | 'unsupportedAlgorithm' | 'malformed' | 'unverifiable'; weakAlgorithm: boolean; timestampPresent: boolean;
  coverage: { type: 'wholeFile' } | { type: 'earlierRevision'; revision: number; later: LaterChanges; verdict: 'allowed' | 'disallowed' };
  certValidAtClaimedTime: boolean; trust: 'ownIdentity' | 'trustedByYou' | 'notTrusted'; widget: { pageId: PageId; rect: Rect } | null }
interface SignatureReport { signatures: SignatureInfo[]; truncated: boolean; lock: SignatureLock }
interface TrustedSigner { fingerprint: string; commonName: string; added: string }
```

- *Format.* `/SubFilter /ETSI.CAdES.detached`. Signed attributes: content-type, message-digest and signing-certificate-v2; no signing-time. ByteRange placeholders are fixed width. `/Contents` ≤ 64 KiB. The first signature certifies (DocMDP P=2 by default), later ones approve.
- *Storage.* `<app data>/signing/identities.bin` (`"SHID"`, XChaCha20-Poly1305, key in the keychain as `signing-identities-key-v1`), `<app data>/signing/trusted.json` (fingerprints only).
- *Validation.* Main process, lopdf + `pdfsig`, not the PDFium child. Steps i–vii of ADR-121 §4. Trust is never claimed without a local pin, and every report shows the external-check notice.
- *Errors.* New `what`: `signEncrypted`, `certified`, `signed`, `identityFile`, `signingKey`, `identityExpired`, `identities`, `signature`; each with `error.<code>.<what>` in en and de.

## 6. Pushes (Rust → UI, never with paths)

The webview has no event permission (SECURITY T3): it cannot `listen` to or `emit` events. A push reaches it as a message on a `tauri::ipc::Channel` that the
UI passes to a command, like `search(.., on_event: Channel<SearchEvent>)`. Three are implemented: `search` sends `hits`, `progress`, `done` and `failed` (§5) for one search, one channel per search, so a message belongs to the search whose channel it came on. `subscribe_menu(on_action: Channel<String>, ..)` sends the id of each macOS menu command (`menu:action {id}` below, as a bare string) from the allowlist.
`subscribe_app(on_event: Channel<AppEvent>)` sends the typed `AppEvent`s of `events.rs` (`dropHover { active }`, `opened { document }`, `openFailed { code, .. }`; shapes in §5). They are the events
`drop:hover` and `doc:opened` of the original plan, as channel messages: `dropHover` while files are dragged over the window (`WindowEvent::DragDrop`: enter shows, leave or drop hides; moving over it sends the throttled cursor position as `x`, `y`), and
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
`engine_crashed`, `engine_unavailable`, `cancelled` (UI stays silent), `keychain_unavailable`, `internal`.

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
| `citations` (`features/citations/store.ts`, ADR-119) | per doc: `bibliography` (`BibliographyInfo`, reloaded when a ChangeSet's `doc` has `bibliography`), `citations` (`CitationInfo[]`, refetched debounced after a ChangeSet that touches a citation), load token (dropped on close); global: chosen style (`localStorage` `sheer.citations.style`, default `apa7`) | `get_bibliography`/`list_citations`, ChangeSet |
| `settings` (changed) | also mirrors `tags: TagDef[]`; the tag editor writes through `update_settings` | `update_settings` |

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

## 11. Engine process, autosave, updater, packaging (M7, ADR-053)

### 11.1 Engine process

```
main.rs                  if let Some(code) = sheer_lib::engine_child_main() { std::process::exit(code) }  // before run()
engine/wire.rs           WireRequest / WireReply (serde, postcard header) · Frame codec · per-kind blob caps · Hello / Ready
engine/transport.rs      trait Transport · ChildTransport (spawn, handshake, kill, stderr → log) · InProcessTransport (tests)
engine/pump.rs           thread sheer-engine-pump: Queue → Transport, deadlines, SizeCache writes, Confirm, restart + replay
engine/files.rs          FileTable: FileToken → File (the intake handle; parent only)
engine/remote_file.rs    RemoteFile: Read + Seek over ReadAt, 64 × 256 KiB block cache (child only)
engine/ledger.rs         per document: the PDFium-copy mutations to replay; strikes; quarantine
engine/host.rs           child loop: read frame → worker::serve → write frame; exits on stdin EOF
engine/worker.rs         unchanged serving code, now called by host.rs and InProcessTransport
```

```rust
pub fn engine_child_main() -> Option<i32>;   // lib.rs; main.rs calls it only if wire::child_mode_requested(args, env): argv[1] == CHILD_FLAG && env CHILD_ENV == "1"
                                              // (W0: always None). Types below are `pub` (engine is a pub mod), not pub(crate): unused pub(crate) items trip dead_code

pub trait Transport: Send {
    fn call(&mut self, request: WireRequest, blob: Blob, deadline: Instant) -> Result<(WireReply, Blob), TransportError>;
    fn kill(&mut self);
}
pub enum TransportError { Timeout, Died, Protocol(&'static str) }   // all three end in a restart
pub enum Blob { None, Shared(Arc<[u8]>), Owned(Vec<u8>) }

#[derive(Serialize, Deserialize)]
pub enum WireRequest {
    Open { id: DocumentId, file: FileToken, password: Option<WireSecret> }, // WireSecret: zeroized on drop, redacting Debug
    Reopen { id: DocumentId, source: WireSource },                           // File(FileToken) | FileWithPassword(..) | Bytes (blob)
    Render { key: RenderKey },
    Outline { id: DocumentId }, TextLayer { id: DocumentId, page_index: u32 }, PageLinks { id: DocumentId, page_index: u32 },
    ImportAnnotations { id: DocumentId, page_index: u32 },
    SetAnnotationsHidden { id: DocumentId, hide: Vec<(u32, u32)>, show: Vec<(u32, u32)> },
    SearchPage { id: DocumentId, page_index: u32, spec: SearchSpec, limit: u32 },
    SetPageRotations { id: DocumentId, items: Vec<(u32, u16)> }, SetCropBox { id: DocumentId, engine_index: u32, crop: [f32; 4] },
    RenderForRedaction { id: DocumentId, engine_index: u32, dpi: f32, burn: Vec<Rect> },
    OpenSnapshot { id: SnapshotId /* parent-assigned */ },                   // bytes in blob
    CloseSnapshot { id: SnapshotId },
    RenderExport { doc: EngineDocRef, engine_index: u32, dpi: f32, annotations: bool, rotate_quarter: u8 },
    AppendBlankPage { id: DocumentId, size: [f32; 2] }, TruncatePages { id: DocumentId, keep: u32, total: u32 },
    AppendPages { id: DocumentId, pages: Vec<u32> },                         // source bytes in blob
    Release { id: DocumentId, snapshot: bool }, Close { id: DocumentId },
    #[cfg(debug_assertions)] Crash,                                           // honoured only with SHEER_ENGINE_TEST_HOOKS=1
}
// Child → parent, besides replies: WireRead { token: FileToken, offset: u64, len: u32 } in a ReadAt frame (answered by a ReadData frame, blob = bytes).
// Replies: WireReply { Opened(WireLoaded) | Reopened(WireLoaded) | Frame | Outline | TextLayer | PageLinks(Vec<WireLink>) | Annotations | Done | Search |
//   Raster { width, height, gray } | SnapshotOpened | Appended | Released { snapshot } | Failed(WireError { code }) }. WireLink carries the URL as a string:
//   the parent classifies it again (security::links), so a child cannot hand the UI a URL it would refuse. WireError carries only the code.
// Frame kinds: Hello, Ready, Request, Reply, ReadAt, ReadData, ReadFailed. wire.rs frames raw header bytes; B1 adds postcard (the only new dep).
// `Transport::call` of InProcessTransport (the queue + health of the thread worker, held by Engine) is a refusal until B1's pump maps wire requests to jobs.
// Opened / Reopened replies carry pages, sizes, rotations, boxes and flags; the pump writes them into SizeCache.
```

- **Flow.** `Engine::call` is unchanged for callers (same `Rank`, timeouts, `Refused`). The pump pops a `Request`, keeps its reply
  channel, sends the wire form, and waits until `run_deadline`. `Confirm` runs in the parent on `Opened`; `false` → `Close`.
- **Restart.** On `TransportError`: kill, answer the in-flight job `engine_crashed`, strike its document, start a child, replay every
  open, non-quarantined document from `ledger` at Control rank (Reopen from `FileTable`, appended pages, truncations, net rotations, net
  crops, net hidden set, live snapshots), compare sizes, then resume the queue. Lost documents → `AppEvent::EngineRestarted { lost }`.
  The UI bumps the render generation (frames re-requested) and shows a banner "Reopen" for each lost document.
- **Budget.** 5 restarts per 10 min, then `engine_unavailable` until app restart (save still works: lopdf only, ADR-053 §1.8).
- **Guards.** CI grep: no `std::fs`/`File::open` in `engine/{host,remote_file}.rs`; `pdfium_render` still only in `engine/`.

### 11.2 Autosave and recovery (`storage/autosave.rs`)

```rust
pub struct Autosave { dir: PathBuf /* $APPDATA/autosave/<session-uuid> */, lock: File, pending: Mutex<HashMap<DocumentId, Instant>> }
impl Autosave {
    pub fn start(app_data: &Path) -> Result<Self, AppError>;                 // creates 0700 dir, takes `lock` with File::try_lock
    // free fn `autosave::start(&AppHandle)`: the lib.rs hook (W0: no-op) that calls this, manages the state, spawns the timer
    pub fn note_change(&self, id: DocumentId);                               // called from apply/undo/redo ChangeSets
    pub fn status(&self, doc: &DocumentEntry) -> AutosaveStatus;
    pub fn write(&self, state: &AppState, id: DocumentId) -> Result<(), AppError>; // snapshot::current → write_atomic <n>.pdf + <n>.json
    pub fn forget(&self, id: DocumentId);                                    // save success, close
    pub fn scan(app_data: &Path) -> Result<Vec<Recovery>, AppError>;         // dead sessions only; purges > 30 days and > 2 GiB
}
```

A timer task (tokio interval 5 s) picks documents whose debounce or max interval elapsed and runs `write` on the blocking pool, one at a
time, skipping during a save. Window blur triggers the same check. Normal quit removes the session dir.

### 11.3 Updater (`update/`)

```
update/mod.rs        plugin() -> TauriPlugin (pubkey from include_str!("../../updater/minisign.pub")); ENDPOINT const; check(); download()
update/state.rs      UpdateState { pending: Mutex<Option<Update + bytes>> }; install_on_quit flag read by the quit flow in sources.rs
```

`Cargo.toml`: `tauri-plugin-updater = { version = "2", default-features = false, features = ["native-tls", "system-proxy", "zip"] }`.
`tauri.conf.json`: no updater entry (the plugin config is added in code by `update::configure`); `createUpdaterArtifacts` is set only by `release.yml`'s `--config` override when the secret `TAURI_SIGNING_PRIVATE_KEY` exists (ADR-053 amendment); no capability names `updater:*`.

**W0 seams as landed.** `DocKind::Recovered` is a unit variant (wire `"recovered"`); the original path/name live in the registry entry (B2), so the enum stays `Copy`. `update::plugin()` is an empty plugin named `sheer-update` until B3 swaps in `tauri-plugin-updater`; `AutosaveStatus` lives in `storage/autosave.rs` (`DocumentInfo.autosave` and the `AppEvent` additions `engineRestarted` / `updateAvailable` are added by B2 / B1 / B3). Settings `updates` and `skippedVersion` are optional in `src/api/app.ts` until F2 reads them. Commands stubbed with `AppError::not_yet()`: all of `commands/{recovery,update}.rs` and `open_default_apps_settings`.

### 11.4 Packaging

- `tauri.conf.json` `bundle.windows.nsis`: `installMode: "currentUser"`, `languages: ["English", "German"]`, `headerImage:
  "installer/nsis-header.bmp"`, `sidebarImage: "installer/nsis-sidebar.bmp"`, `installerIcon: "icons/icon.ico"`, `installerHooks:
  "installer/hooks.nsh"`; `bundle.windows.webviewInstallMode: { type: "downloadBootstrapper", silent: true }`.
- `tauri.windows.conf.json`: `bundle.fileAssociations: []` (the hooks register `OpenWithProgids` instead).
- macOS: `--target universal-apple-darwin`, DMG; `fetch-pdfium.sh --universal` fetches `mac-x64` and `mac-arm64`; `library_path`
  picks the slice's directory at compile time (unchanged).
- Release CSP: `style-src 'self'`; devCsp unchanged.

## 12. v1.2 command map (menu row and modes, ADR-102)

Windows has the in-window menu row again (`features/shell/MenuRowSlot.tsx`: `MenuBar` from `menu.json` and the registry, 32 high, with the caption buttons 46 x 32 at the right, hidden in full screen; Home has no menu row and its caption buttons are 46 x 32 in the strip). macOS keeps its native menu, built from the same `menu.json` (`src-tauri/src/menu`). The top bar keeps Undo, Redo, Search, the tour pill and Fertig; Export and More are gone. Every command stays an action of the registry, so shortcuts are unchanged. The modes are the actions `mode-read`, `mode-comment`, `mode-fill`, `mode-pages`, `mode-edit` (they call `ui.setMode`); the Werkzeuge menu lists them as radio items with "1" to "5" as hint text only (never accelerators; the digit keys are the shell's, not the menu's). Tool actions (`tool-*`), `merge-files`, `split-document`, `extract-pages` and `toggle-inspector` are not in any menu (`menuBar: false`). Where each command lives (FEEDBACK F14: Speichern, Speichern unter, Kopie exportieren, Als Bilder exportieren, Drucken, Formular reduzieren, Dokumenteigenschaften and PDF aus Bildern are not in a mode):

| Command | Place |
|---|---|
| Open, Save, Save As, Export copy, Export images, Images to PDF, Compress, Flatten form, Protect, Document properties, Print, Close, Settings, Exit | Datei menu (Settings and Exit Windows only); Save is also **Fertig**, Save As also double click on the file name |
| Open recent, Merge, Split, Extract pages | Home (recents, hub cards) and the Seiten mode tool row |
| Undo, Redo, Find (and Find next / previous) | Bearbeiten menu, top bar buttons (Undo, Redo, Search), Primary+Z / Primary+Shift+Z / Primary+F / Primary+G |
| Delete, Add comment | Bearbeiten menu, selection popover, Delete, Primary+Shift+M |
| Zoom, fits, scroll modes, rotate, go to page, next / previous page and tab, sidebar toggle and tabs, full screen | Ansicht menu (no "Eigenschaften" item), zoom dropdown, page field, tabs, F11 |
| Lesen, Kommentieren, Ausfüllen & Signieren, Seiten, Bearbeiten | Werkzeuge menu (radio items, hint 1 to 5), the mode row, keys 1 to 5 |
| Highlight form fields, Manage signatures | Werkzeuge menu only (the Ausfüllen & Signieren tool row has no buttons for them) |
| Tools (select, highlight, comment, draw, shapes, signature, redact, pages, text box, image, crop, Lesen tools) | The tool row of their mode (F14 table, DESIGN §3.2), tool letters |
| Welcome tour, Reset tips, About | Hilfe menu (About Windows only); the tour pill shows progress |

Keyboard of the menu row (DESIGN §3.2): Alt alone or F10 focuses Datei and shows the mnemonics; Alt plus the access letter opens a menu (never with Ctrl, which is AltGr); Left/Right switch menus, Down/Enter/Space open, Esc closes and then returns focus. ARIA `menubar`, `menuitem`, `menuitemradio` for the modes.

Zoom and page text are in the top bar centre; the polite live regions (save, render, settled page, success pulses) are `topbar/LiveRegions.tsx`.

UI preferences that live in the webview's `localStorage` (never document content, paths or anything Rust needs; each is read defensively and falls back to a default): `sheer.exportImages`, `sheer.formHighlight`, `sheer.organizeThumb2`, `sheer.signatureInk`, `sheer.signatureItemFonts`, `sheer.signatureTab`, `sheer.styleColours`, `sheer.toolDefaults`, `sheer.toolVariants`, `sheer.tools.recentColors`, `sheer.tools.shapeRecognition`, `signatureFont`, `comments.sort`, `margin.comments`, `compress.preset`, `img2pdf.options`, `print.annotations`, `print.quality`. Persistent app settings (language, theme, recents) are Rust's (`storage/settings.rs`), not here.

## 13. Text editing (v1.5, ADR-125; phase 1 = feasibility, no UI)

Modules: `pdfwrite/ops_walk.rs` (shared walker, from `redact_content.rs`), `pdfwrite/text_lines.rs` (runs → lines → paragraphs),
`pdfwrite/text_fonts.rs` (font dict → `FontMap`), `pdfwrite/text_splice.rs` (offset lexer + splice), `pdfwrite/text_save.rs`
(incremental write), `fontprog/` (engine-free, lopdf-free: `skrifa` glyph tables, Type1 eexec scan, `cmap` (ToUnicode parser),
`fallback` (bundled fonts, `subsetter`)), `model/text_edit.rs`, `engine/text.rs` (+ char origins), `commands/text_edit.rs`.
Import rules unchanged: lopdf only in `pdfwrite/`, PDFium only in `engine/`.

### 13.1 Operator walk (`ops_walk.rs`)

State: `Gs { ctm, text: TextState { font, size, tc, tw, tz, tl, ts, tr }, .. }` on a `q/Q` stack (≤ `MAX_STATE_DEPTH` 512);
`Tm`/`Tlm` inside `BT…ET`. `Td` sets `Tlm = translate(tx,ty)·Tlm`; `TD` also `TL = -ty`; `T*` = `0 -TL Td`; `'` = `T*` + `Tj`;
`"` = set `Tw`,`Tc` + `'`. Each shown glyph advances `tx = ((w0 − Tj/1000)·Tfs + Tc + Tw·[single-byte code 32]) · Tz`; `Ts` raises
without moving the baseline. Output per glyph: `GlyphPos { op: OpRef, byte: Range<u32>, code: u32, origin: [f64; 2] /* page */,
adv: f64, size_eff: f64, dir: [f64; 2] }`, grouped into `Run { ops: Range<OpRef>, font: FontKey, glyphs }` (a run ends at
`Tf`, `Tm`, `Td`-family, `ET`, a state change or a gap). Form XObjects are walked (depth ≤ `MAX_REDACT_FORM_DEPTH`, cycle set) for
mapping and collision checks only; their runs carry `in_form: true` and are not editable. Budgets as redaction: `MAX_REDACT_OPS`,
`MAX_REDACT_WORK`, `MAX_REDACT_CONTENT_BYTES`.

### 13.2 Lines, paragraphs, mapping (`text_lines.rs`)

- *Line:* runs with parallel `dir` (≤ 1°), baseline offset (minus `Ts`) ≤ 0.2 × size, horizontal gap from the previous run's end
  ≤ 3 × the font's space width (else a new line segment: table cells, columns). Order = baseline, then x along `dir`.
- *Paragraph:* consecutive lines, same font family and size (± 10 %), baseline step equal (± 15 %, ≤ 1.6 × size), left edges within
  1 pt (or right edges / centres for that alignment). `justified` = inner lines' right edges within 1 pt and word gaps vary.
- *Mapping:* `engine/text.rs` already reads every char once; it also keeps `CharGeom { utf16: u32, unicode: u32, origin: [f32; 2],
  size: f32, generated: bool }` (pdfium-render `origin()`, `is_generated()`; never over IPC). Probe: char at the clicked UTF-16 index →
  nearest walker glyph whose origin is within 0.3 × size and whose Unicode (via `FontMap`) matches; generated chars resolve to their
  neighbour. A miss is `unmapped`. The same match yields an *observed* code→Unicode table, used when `ToUnicode` is missing.

### 13.3 Fonts (`text_fonts.rs`, `fontprog/`)

```rust
pub struct FontMap { kind: FontKind, embedded: Option<ProgramKind>, subset: bool /* "ABCDEF+" */, to_code: HashMap<char, Code>,
                     widths: WidthSource, glyphs: GlyphSet, space_code: Option<Code> }
pub enum FontKind { Simple, Type0IdentityH, Type3 /* refuse */, Type0Other /* refuse */ }
pub enum ProgramKind { TrueType, Cff, OpenTypeCff, Type1 }
```
- *Simple:* code → glyph name by `/Encoding` (base WinAnsi/MacRoman/Standard/font built-in) + `/Differences`; name → Unicode by AGL
  (+ `uniXXXX`, `uXXXXX`); `ToUnicode` wins when present. Width = `/Widths[code − FirstChar]`, else std14 AFM (`content/std14.rs`,
  grown to all 14). Glyph present: TrueType → `cmap` (3,0)/(1,0)/(3,1) lookup gid ≠ 0; CFF → charset has the name; Type1 → name in
  `/CharStrings`; non-embedded → code in encoding with width > 0.
- *Type0 Identity-H:* Unicode → CID by reversing `ToUnicode` (several CIDs for one char: the one used most on the page), else the
  observed table; CID → GID by `/CIDToGIDMap` (Identity or stream, ≤ 128 KiB); GID < `numGlyphs` and outline non-empty; width from `W`/`DW`.
- *Type3, other CMaps, vertical:* read for mapping only.
- A char is `ok` if code + glyph + width exist; else `missing`. Any missing → whole line in the fallback (ADR-125 §3).
- *Fallback:* `fontprog::fallback::pick(flags, weight, name) -> Face` over the 12 bundled Arimo/Tinos/Cousine faces; written as
  Type0/Identity-H, `CIDFontType2`, `FontFile2` subset, `W`, `ToUnicode`; one font object per (face, document save), glyphs unioned.

### 13.4 Rewrite, undo, save

- *Splice:* `text_splice::lex(stream) -> Vec<Tok { op, args: Range<u32> }>` (inline images skipped by `BI…ID…EI` with a length check;
  doubt → the whole stream is re-encoded via lopdf). Diff old/new glyph strings (common prefix/suffix in Unicode); the first changed show-op
  gets the new codes as one `TJ` (prefix kerning kept, no new kerning), later changed show-ops on the line become empty `[] TJ`.
  Fallback lines are written as `/SheerFn s Tf [..] TJ /Orig s Tf` (no `q/Q` inside `BT`), so later ops see the original font.
- *Width:* `delta = new_adv − old_adv`. `keepStart`: nothing else moves (segments placed by `Td`/`Tm` keep their place; consecutive
  show-ops shift with the text position); a collision with the next segment or beyond the paragraph's right edge → warning
  `overflow`. `squeeze`: `Tz` = max(85 %, old/new) around the line. Justified: `delta` spread over the line's word gaps as `TJ` numbers.
  `paragraph` scope (v1.5.2): greedy re-break with the run's font, same baselines and left edge, refuse if more lines are needed.
- *Model:* `DocCommand::EditTextLine { page_id, key: LineKey, text, fit, scope }`; `DocState.text_edits: HashMap<PageId,
  Vec<TextEdit>>` replayed over the original stream (each key is resolved against the state after the edits before it). Inverse = pop.
  Preview: `pdfwrite` builds the one-page PDF, the engine swaps it in (the ADR-055 `Redacted` path, new variant `PageSource::TextEdited
  { bytes }`); text layer and search read it.
- *Save:* incremental (`IncrementalDocument`): per page one new content stream (same object id if only this page uses it, else a new
  object), new font objects, page `/Resources` materialised if inherited or shared. `SavePlan.text_edits`. Never Full because of text.

### 13.5 Commands and shapes

```rust
// commands/text_edit.rs (blocking pool, lopdf; DocId only, never a path)
text_edit_probe(doc_id: DocId, page_id: PageId, unit: u32 /* UTF-16 index into TextLayer.text */) -> TextLineInfo
text_edit_lines(doc_id: DocId, page_id: PageId) -> PageTextLines          // ≤ 5 000 lines; for keyboard navigation
// commands/text_preview.rs (ADR-129 §1; never changes DocState, no undo step; a snapshot per frame)
text_edit_preview(doc_id: DocId, page_id: PageId, key: LineKey, text: string, fit: TextFit, scope: TextScope, generation: u32, scale: f32 /* px per pt, 0.5..8 */)
  -> binary: u32 LE n, n bytes JSON { generation, rect: Rect /* page space, unrotated */, pxPerPt, overflowPt, fallback: { face, chars[] } | null }, then the PNG of the region
  // region = line box widened to the free room (scope paragraph: the paragraph box + 1 line); stale generation -> cancelled
apply_command(doc_id: DocId, command: DocCommand /* + EditTextLine */) -> ChangeSet   // ChangeSet.pages carries the swapped slot
// engine
Job::PageChars { engine_index: u32 } -> Vec<CharGeom>                     // Interactive; cached with the text layer
// pdfwrite
pub fn ops_walk::walk(src: &Document, page: ObjectId, budget: &mut Budget, sink: &mut dyn WalkSink) -> Result<(), AppError>;
pub fn text_lines::lines(src: &Document, page: ObjectId, chars: &[CharGeom]) -> Result<PageLines, AppError>;
pub fn text_splice::replay(src: &Document, page: ObjectId, edits: &[TextEdit], fonts: &FallbackStore) -> Result<Rewritten, AppError>;
pub fn text_save::write(doc: &mut IncrementalDocument, page: ObjectId, r: &Rewritten) -> Result<(), AppError>;
```
```ts
interface LineKey { rev: number /* page edit revision */; line: number }
interface TextLineInfo { key: LineKey; text: string /* ≤ 2 000 */; box: Rect; paragraph: number; justified: boolean;
  font: { name: string /* display filter, subset tag removed */; size: number; embedded: boolean };
  editable: { type: 'same' } | { type: 'fallback'; face: 'sans' | 'serif' | 'mono' } | { type: 'no'; reason: TextEditRefusal } }
type TextEditRefusal = 'signed' | 'permission' | 'type3' | 'invisible' | 'clip' | 'vertical' | 'cmap' | 'inForm' | 'actualText'
  | 'script' | 'notFileSource' | 'unmapped' | 'tooComplex';
interface EditTextLine { type: 'editTextLine'; pageId: PageId; key: LineKey; text: string; fit: 'keepStart' | 'squeeze';
  scope: 'line' | 'paragraph' }
// ChangeSet.warnings gains 'textOverflow' | 'fontFallback'
```
The probe cannot know the new text, so `apply_command` re-checks: a line that needs the fallback answers `fontFallback` in
`ChangeSet.warnings` (the UI's notice names the original font); the edit stays one undo step.

### 13.6 Limits and security

`limits.rs`: line text ≤ 2 000 chars; ≤ 10 000 edits per document, ≤ 500 per page; font program ≤ 32 MiB, glyphs ≤ 65 535;
`ToUnicode` ≤ 1 MiB, ≤ 100 000 mappings, `bfrange` span ≤ 65 536, destination ≤ 16 UTF-16 units; `Differences` ≤ 256 codes;
`W` ≤ 65 536 entries; `CIDToGIDMap` ≤ 128 KiB; probe ≤ 5 s, replay ≤ 30 s. Every PDF is hostile: font programs are parsed only by
`skrifa`/`read-fonts` (safe Rust, bounds-checked) and our Type1 scan (bounded, no charstring execution), in the blocking pool under
`catch_unwind` with the deadline; nothing is rasterised or hinted in the main process. Cycles in fonts, encodings and forms are cut by
visited sets; the generated subset is re-parsed with `skrifa` before it is written. Refusals are typed (`unsupported_feature`,
`what: "textEdit"`, `params.reason`), never panics. Signed/certified: checked from `sigread::scan_fields` at probe and at apply.
Tests: `tests/text_edit.rs` (corpus: same-font edit renders identical outside the line box, extracted text equals the new text,
undo restores byte-identical stream, refusals per class, hostile fonts fuzz-seeded from `tests/fixtures/hostile/`).

### 13.7 W0 seam as landed (v1.5.1)

All §13.5 signatures exist with `not_yet` bodies: `pdfwrite/{ops_walk,text_lines,text_fonts,text_splice,text_save}.rs`, top-level `fontprog/{mod,glyphs,type1,cmap,fallback}.rs` (a crate module beside `pdfwrite`, engine- and lopdf-free), `model/text_edit.rs`, `commands/text_edit.rs`, `src/api/textEdit.ts`. The spike `pdfwrite/textedit/` is untouched. Deviations and additions:
- `text_edit_lines` returns `PageTextLines { lines: TextLineInfo[] }` (a struct, so it can grow). `text_lines::probe(lines, chars, unit) -> TextLineInfo` is added (the mapping step of the probe). `font_map(src, font, observed)`, `fontprog::glyphs::read`, `fontprog::cmap::parse`, `fontprog::type1::scan` and `FallbackStore::subset` are the helper signatures of §13.3.
- `ChangeSet` had no `warnings`; it now has `warnings: Vec<ChangeWarning>` (`textOverflow`, `fontFallback`), empty by default (TS: optional). `PageSource::TextEdited { bytes }` has origin `"textEdited"` (TS `PageOrigin`); until its package lands it is treated like `Redacted` wherever page bytes are read.
- `DocCommand::EditTextLine` is a page command (never inside a batch); `check_shape` enforces `limits::TEXT_EDIT_LINE_CHARS`; `run` returns `not_yet`. `DocState.text_edits` is not added yet (package B1).
- `Job::PageChars { id, engine_index }` is in-process only: pump and worker answer `not_yet`, no wire request yet. `CharGeom` lives in `model/text_edit.rs` (engine-free), not `engine/text.rs`.
- `limits.rs` has the §13.6 constants (`TEXT_EDIT_*`, `FONT_*`, `TOUNICODE_*`, `DIFFERENCES_MAX`, `CID_*`). Commands are in `build.rs` and `capabilities/default.json`. Tokens `--edit-hover-outline` / `--fallback-underline` are shorthand values; their 2 pt offset is `--focus-offset`. i18n keys of the §3.10 table are in en and de.

## 14. Acceptance automation (ADR-131; `automation/{mod,dialogs,queue,commands}.rs`)

Cargo feature `automation` (not in `default`, never in `release.yml`/`ci.yml`; `scripts/check.sh` `guard_automation` and `tests/automation_seam.rs` fail otherwise). It exists for the acceptance build only: `npm run build:acceptance` (`tauri build --no-bundle --config src-tauri/tauri.acceptance.conf.json --features automation`, `CARGO_TARGET_DIR=src-tauri/target-acceptance`).

- **Seam.** Every native dialog calls `automation::dialogs`: `.seam_pick_file()?`, `.seam_pick_files()?`, `.seam_pick_folder()?`, `.seam_save_file()?` on a `FileDialogBuilder`, `.seam_show()` on a message builder, and `dialogs::print` for the print dialog (`print/dialog.rs`). Without the feature each calls the native dialog as before. A test fails on any `blocking_pick_*`, `blocking_save_file`, `blocking_show` or `window.print()` outside `src/automation/`.
- **With the feature** the answer is the head of a FIFO queue. Kind mismatch or empty queue: `internal` error with `params.what = "automationNoAnswer"` (never a native dialog; the entry stays queued). `cancel: true` answers as a dismissed dialog. Paths become `FilePath::Path` and then go through the call site's own checks exactly like dialog paths. Print records `{printId, pages, cancelled}` and opens nothing (a `print` entry at the head is consumed for its `cancel`; without one the print is recorded anyway).
- **Commands** (compiled and registered only with the feature; permissions `allow-automation-queue-dialog`, `allow-automation-state` come from the inline capability `acceptance-automation` in `tauri.acceptance.conf.json`, main window only; `capabilities/` never names them):

| Command | Arguments | Returns |
|---|---|---|
| `automation_queue_dialog` | `entry: { kind: "open"\|"openMany"\|"folder"\|"save"\|"message"\|"print", paths?: string[], button?: string, cancel?: boolean }` | nothing; refused (`invalid_argument` `paths`) for relative paths, a wrong path count (one for open/folder/save, at least one for openMany) or more than 64 queued entries |
| `automation_state` | none | `{ queueLength, lastPrint: { printId, pages, cancelled } \| null, lastError: { expected, found } \| null }` (`found`: kind at the head, `null` if empty) |

  A message answers "confirm" unless `cancel` is true or `button` is `"cancel"`.
- **Separate identity.** Identifier `app.sheer.acceptance`: Tauri derives the app-data folder (`app_data_dir`: recents, settings, autosave, signature library, trust store), the Windows single-instance mutex and window class from it, so the acceptance exe never shares them with `app.sheer.desktop`. The keychain service (`storage/keychain.rs`) switches to `app.sheer.acceptance` with the feature. The updater is not configured (`update::configure` returns the context unchanged), so its plugin is not registered.

## 15. OCR text layer (v1.7, ADR-134; phase 1 = Windows spike, no UI)

```
ocr/mod.rs          OcrService: job queue, pipeline (engine RenderForOcr → backend → layer), cancel, progress pushes
ocr/backend.rs      enum OcrBackend { WindowsChild, VisionSidecar, None }; capabilities(); spawn/kill/restart (budget 5 / 10 min)
ocr/child.rs        ocr_child_main() -> Option<i32>  // main.rs: argv[1] == "--sheer-ocr-child" && env SHEER_OCR_CHILD == "1"
ocr/win.rs          #[cfg(windows)] recognize(&Gray8, &LangTag) -> Result<RawOcr, OcrError>  // windows 0.62 safe projections only
ocr/wire.rs         u32 LE len + JSON header + blob; OcrRequest / OcrReply; caps and validation of replies
ocr/limits.rs       MAX_SIDE_PX 8000, MAX_PIXELS 40_000_000, MAX_WORDS 20_000, MAX_WORD_CHARS 128, MAX_REPLY 8 MiB, PAGE_TIMEOUT 30 s
ocr/geometry.rs     pixel boxes → page user space (inverse display matrix incl. /Rotate), line grouping, sanitizing (NFC, controls)
ocr/textlayer.rs    OcrPageLayer → TextLayer / search hits for unsaved layers (same shapes as the engine's)
pdfwrite/ocr_font.rs   glyphless TrueType (generated) + Type0/CIDFontType2/ToUnicode objects
pdfwrite/ocr_layer.rs  layer content stream (3 Tr, per-word Tm/Tz/Tj, explicit gap spaces), /Contents wrap, /SheerOcr key
sidecar/ocr-macos/     Swift package `sheer-ocr` (library OcrCore: Wire, Geometry, VisionRecognizer + XCTest; executable sheer-ocr), same wire; bundled as externalBin
```

```rust
pub struct OcrWord { pub text: String, pub rect: [f32; 4] }        // page user space, x0 y0 x1 y1
pub struct OcrLine { pub words: Vec<OcrWord> }
pub struct OcrPageLayer { pub lang: LangTag, pub backend: BackendKind, pub angle_deg: f32, pub dpi: f32, pub lines: Vec<OcrLine> }
pub enum PageOcrClass { Scan, HasTextLayer, SheerLayer, Text, Empty }

// engine/wire.rs additions (child replies reuse Raster)
WireRequest::OcrProbe { id: DocumentId, pages: Vec<u32> }                       // → OcrProbe(Vec<PageOcrClass>)
WireRequest::RenderForOcr { id: DocumentId, engine_index: u32, dpi: f32, max_side: u32 } // → Raster { width, height, gray }

// model
DocCommand::ApplyOcr { layers: Vec<(PageId, Arc<OcrPageLayer>)> }               // one undo step; DocState.ocr_layers
pub fn write_ocr_layers(doc: &mut lopdf::Document, layers: &[(ObjectId, &OcrPageLayer)]) -> Result<(), PdfWriteError>; // save path only
```

| Command | Arguments | Returns |
|---|---|---|
| `ocr_capabilities` | none | `{ backend: "windows"\|"vision"\|"none", languages: { tag: "de-DE"\|"en-US", available: boolean }[], maxImageDimension: number \| null }` |
| `ocr_classify_pages` | `docId, pages?: PageId[]` (page ids) | `{ page: number, class: PageOcrClass }[]` |
| `ocr_start` | `docId, pages: PageSelection, lang: "de-DE"|"en-US", redo: boolean` | `{ job: OcrJobId, langUsed: string, notice: "languageFallback" \| null }`; refused `read_only` (signed/certified), `read_only` (`permission`), `invalid_argument` (`lang`, `pageSelection`), `limit_exceeded` (`ocrJobs`, one job at a time), `unsupported_feature` (`ocrUnavailable`) |
| `ocr_cancel` | `job` | nothing; finished pages stay applied |
| `ocr_open_language_settings` | none | nothing; opens the fixed OS URI `ms-settings:regionlanguage` by starting `explorer.exe` with it (no plugin) (Windows only, `unsupported_feature` elsewhere); TS `openLanguageSettings()` |

Pushes: `ocrProgress { doc, job, done, total, failed }`, `ocrFinished { doc, job, applied, skipped, failed }` (no paths, no text).
They are `AppEvent`s on the `subscribeApp` channel (`events.rs`); TS: `parseOcrEvent`, `handleOcrEvent(event, { onProgress, onFinished })` in `src/api/ocr.ts`. Arguments are `docId` like every command. `ocr_start` runs `ocr::service::run_job` (sequential, one job at a time, `ocr_cancel` sets its flag) and ends with one `DocCommand::ApplyOcr` (internal, label `ocr.apply`; `DocPart::Ocr` in the change set; `DocState.ocr_layers`).

TS (`src/api/ocr.ts`):

```ts
export interface OcrLanguage { tag: 'de-DE' | 'en-US'; available: boolean }
export interface OcrCapabilities { backend: 'windows' | 'vision' | 'none'; languages: OcrLanguage[]; maxImageDimension: number | null }
export type PageOcrClass = 'scan' | 'hasTextLayer' | 'sheerLayer' | 'text' | 'empty'
```

- **Isolation.** Windows OCR runs only in the `--sheer-ocr-child` process of our own exe; macOS in the `sheer-ocr` sidecar. Both get
  gray8 bitmaps and a language tag, never PDF bytes or paths. CI grep: `windows::Media` only in `ocr/win.rs`; `pdfium_render` still
  only in `engine/`.
- **macOS sidecar (ADR-137).** `backend::recognizer_exe()`: Windows = `current_exe()` (child mode), macOS = `sheer-ocr` next to the main
  binary (`Contents/MacOS`, Tauri `bundle.externalBin: ["binaries/sheer-ocr"]` in `tauri.macos.conf.json`), overridable by
  `SHEER_OCR_SIDECAR` in debug builds only (tests, CI); elsewhere `None` (`unsupported_feature` `ocrUnavailable`). `probe_capabilities`
  asks each language with a blank 64x64 bitmap through the same `ChildClient` (backend `vision`); the sidecar answers
  `language_unavailable` when `supportedRecognitionLanguages()` lacks the tag. Swift: `VNRecognizeTextRequest` `.accurate`,
  language correction on, `recognitionLanguages = [tag]`, gray8 → `CGImage` (stride), one box per whitespace token via
  `boundingBox(for:)`, normalized bottom-left → pixel top-left (`Geometry.pixelBox`), limits mirrored from `limits.rs`, exit on EOF
  (code 2 after a broken message, as the Rust child). Build: `scripts/build-sidecar-macos.sh` (universal, ad-hoc signed, copies to
  `src-tauri/binaries/sheer-ocr-<triple>`; needed before any cargo build on macOS because tauri-build checks the file). CI (macOS):
  build, `swift test`, then `tests/ocr_vision.rs` with `SHEER_OCR=1` (PDFium renders a generated page, Vision reads it); release.yml builds
  the sidecar before `tauri build`.
- **Acceptance mask.** With the Cargo feature `automation`, `SHEER_AUTOMATION_OCR_LANGS` (comma list) only removes languages from
  `capabilities()` (`backend::mask_languages`); release builds do not compile it.
- **Save.** Incremental: `[q, original…, Q, layer]` per page, page-local `/Resources`, one font set per document.
