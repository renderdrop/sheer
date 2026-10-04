//! IPC commands. Thin wrappers over [`AppState`], which holds the logic and is testable without Tauri.
//!
//! Every command is `async`: it validates, then runs the blocking part (registry, engine, dialog) on the blocking
//! pool, never on an async worker. Every command returns `Result<T, UiError>`; the error carries a stable code and an
//! i18n key, never a path or detail (see `error.rs`).
//!
//! Signatures (frontend names are camelCase):
//!
//! | Command | Arguments | Returns |
//! |---|---|---|
//! | `open_document_dialog` | none | the open events of the chosen files (at most 32, in order): `{ type: "opened", document: { id, pageCount, displayName, flags } }` or `{ type: "openFailed", code, key, retryable, params? }` each; empty if the dialog was cancelled |
//! | `open_welcome_document` | none | the open event of the bundled welcome document (ADR-023): `{ type: "opened", document: { .., kind: "welcome" } }` or `openFailed`; the file is found by Rust, nothing path-like comes from the webview |
//! | `render_page` | `req: { docId, pageId, bucket, tile?, priority, generation }` | frame (`ArrayBuffer`, ADR-002 §6, see `engine/encode.rs`), see [`render`] |
//! | `set_viewport` | `docId: number`, `hint: { generation, visible: number[], near: number[] }` | nothing; cancels queued renders of pages that left the viewport, see [`render`] |
//! | `get_pages` | `docId: number` | `PageSlotInfo[]` in the current order, see [`pages`] |
//! | `get_outline` | `docId: number` | the bookmarks as a tree, see [`outline`] |
//! | `get_text_layer` | `docId: number`, `pageId: number` | the text of a page and the box of each character, see [`text`] |
//! | `search`, `cancel_search` | `docId`, `query: { text, matchCase, wholeWord, maxHits }`, `onEvent: Channel<SearchEvent>`; `searchId` | the id of the search; the hits arrive on the channel, see [`search`] |
//! | `get_page_links`, `open_link` | `docId`, `pageId` (and `linkIndex`) | the links of a page; opening one asks the user in a native dialog first, see [`links`] |
//! | `list_annotations`, `list_document_annotations`, `apply_command` (see [`pages`]), `undo`, `redo` | `docId`, and `pageId` or `command` | the annotations of a page; the `ChangeSet` of a command, an undo or a redo, see [`annotations`] |
//! | `close_document` | `docId: number`, `discard?: boolean` | nothing; unsaved changes without `discard` are `unsaved_changes`, see [`save`] |
//! | `save_document`, `save_document_as` | `docId`, `ack?` (and `opts?`) | the `SaveResult` (`null` if the Save As dialog was cancelled), see [`save`] |
//! | `unlock_document` | `docId`, `password: string` (1 to 1024 bytes) | the `DocumentInfo` once the encrypted file is open; a wrong password is `password_required` (retry waits 1 s after the third, in Rust) |
//! | `list_recents`, `remove_recent`, `open_recent` | none; `recentId`; `recentId` | `{ id, displayName, folder, lastOpened, missing }[]` (at most 50, no paths; `folder` is the parent folder's name); nothing; the open event of the file (`opened`, `needsPassword` or `openFailed`) |
//! | `set_menu_state` | `hasDocument: boolean` | nothing; the macOS menu bar greys the commands that need a document |
//! | `app_ready`, `get_settings`, `update_settings`, `watch_transparency`, `subscribe_menu`, `subscribe_app` | see [`app`] | see [`app`] |
//!
//! A frame is at most 4096 x 4096 pixels (all bounds in `limits.rs`); a page that is larger at its zoom bucket is asked for
//! as 1024 px tiles. A `pageId` is the page's position until M3 (identity mapping). The frontend never sees file paths: a
//! path comes from the dialog (here), a drop, the OS or the command line (`sources`), is judged by `documents::intake` and
//! stays in the registry.

pub mod annotations;
pub mod app;
pub mod content;
pub mod export_images;
pub mod export_pdf;
pub mod forms;
pub mod images_pdf;
pub mod jobs;
pub mod library;
pub mod links;
pub mod metadata;
pub mod outline;
pub mod pages;
pub mod print;
pub mod protect;
pub mod recent_actions;
pub mod recovery;
pub mod redact;
pub mod render;
pub mod save;
pub mod search;
pub mod signatures;
pub mod text;
pub mod update;

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Instant;

use tauri::path::BaseDirectory;
use tauri::{AppHandle, Manager, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;
use zeroize::Zeroizing;

use crate::documents::intake::{self, Admitted};
use crate::documents::{
    Abandoned, Claim, DocKind, DocumentId, DocumentInfo, Fingerprint, Registry,
};
use crate::engine::Engine;
use crate::error::{AppError, ErrorCode, UiError};
use crate::events::AppEvent;
use crate::limits;
use crate::menu::{self, spec::MenuLocale};
use crate::storage::recents::{RecentEntry, RecentsStore};

/// How opening a file ended, short of an error. See [`AppState::open_outcome`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Opened {
    /// The document is open (or was open already) and loaded.
    Ready(DocumentInfo),
    /// The file is encrypted and waits under `id` for its password (`AppState::unlock`) or for `close_document`.
    Locked {
        id: DocumentId,
        display_name: String,
    },
    /// Another request is loading this very file and reports it, so this one has nothing to say.
    Pending,
}

impl Opened {
    /// The event for the UI; `None` for [`Opened::Pending`].
    fn into_event(self) -> Option<AppEvent> {
        match self {
            Opened::Ready(document) => Some(AppEvent::opened(document)),
            Opened::Locked { id, display_name } => Some(AppEvent::needs_password(id, display_name)),
            Opened::Pending => None,
        }
    }
}

/// Most `unlock_document` calls that run at once, in all documents. An attempt after the free ones sleeps on a thread of the blocking
/// pool for up to `PASSWORD_RETRY_DELAY`; without a bound a script in the webview could park the pool with sleeping unlocks.
const MAX_CONCURRENT_UNLOCKS: usize = 4;

/// The `unlock_document` calls in flight (SECURITY D3). One per document: a second call for a document that is being tried would
/// read the wrong-password count before the first has written it and skip the wait, so it is refused instead; and
/// [`MAX_CONCURRENT_UNLOCKS`] in all.
#[derive(Default)]
struct UnlockGate {
    busy: Mutex<HashSet<DocumentId>>,
}

impl UnlockGate {
    /// Reserves the attempt for `id` until the returned slot is dropped. `limit_exceeded` (`what: "unlocks"`) if one is running for
    /// it or too many run.
    fn enter(self: &Arc<Self>, id: DocumentId) -> Result<UnlockSlot, AppError> {
        let mut busy = self.busy.lock().unwrap_or_else(PoisonError::into_inner);
        if busy.len() >= MAX_CONCURRENT_UNLOCKS || !busy.insert(id) {
            return Err(AppError::limit("unlocks", MAX_CONCURRENT_UNLOCKS as u64));
        }
        Ok(UnlockSlot {
            gate: Arc::clone(self),
            id,
        })
    }
}

/// An attempt that may run; frees its place when dropped, also when the attempt fails or panics.
struct UnlockSlot {
    gate: Arc<UnlockGate>,
    id: DocumentId,
}

impl Drop for UnlockSlot {
    fn drop(&mut self) {
        self.gate
            .busy
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&self.id);
    }
}

/// Everything the commands share. Managed by Tauri, created in `lib.rs`. Cloning is cheap (shared handles), which is
/// how a command moves it onto the blocking pool.
#[derive(Clone)]
pub struct AppState {
    engine: Engine,
    registry: Arc<Registry>,
    /// The `render_page` calls in flight, capped per document and in all (see [`render::RenderGate`]).
    renders: Arc<render::RenderGate>,
    /// The searches that run (see [`search::SearchRegistry`]).
    searches: Arc<search::SearchRegistry>,
    /// The unlock attempts in flight (see [`UnlockGate`]).
    unlocks: Arc<UnlockGate>,
    /// The annotation models of the open documents (see [`annotations::AnnotationStore`]).
    annotations: Arc<annotations::AnnotationStore>,
    /// The import sources: PDFs the user chose to take pages from, held in memory (`documents::sources`, ADR-036 §4).
    sources: Arc<crate::documents::sources::SourceRegistry>,
    /// The signatures made and not placed or saved yet (see [`signatures`]).
    drafts: Arc<crate::signatures::DraftStore>,
    /// The recent files (`storage::recents`); `None` where there is no app data directory (most tests).
    recents: Option<Arc<RecentsStore>>,
    /// The app data directory, where the backups of the originals go (`commands::save`); `None` where there is none (most tests).
    data_dir: Option<Arc<PathBuf>>,
}

impl AppState {
    pub fn new(engine: Engine) -> Self {
        Self {
            engine,
            registry: Arc::new(Registry::new()),
            renders: Arc::new(render::RenderGate::default()),
            searches: Arc::new(search::SearchRegistry::default()),
            unlocks: Arc::new(UnlockGate::default()),
            annotations: Arc::new(annotations::AnnotationStore::default()),
            sources: Arc::new(crate::documents::sources::SourceRegistry::new()),
            drafts: Arc::new(crate::signatures::DraftStore::default()),
            recents: None,
            data_dir: None,
        }
    }

    /// This state with the recent files kept in `recents`: every document the user opens is noted there.
    #[must_use]
    pub fn with_recents(mut self, recents: Arc<RecentsStore>) -> Self {
        self.recents = Some(recents);
        self
    }

    /// This state with `directory` as the app data directory: the first save over a file puts a copy of the original in its `backups` folder.
    #[must_use]
    pub fn with_data_dir(mut self, directory: PathBuf) -> Self {
        self.data_dir = Some(Arc::new(directory));
        self
    }

    /// This state (same engine and documents) without an app data directory: a save makes no backup. For tests that share one engine.
    #[must_use]
    pub fn without_data_dir(&self) -> Self {
        let mut state = self.clone();
        state.data_dir = None;
        state
    }

    /// Notes a file the user opened as a recent one. The welcome document is not a file of the user and is never noted.
    fn note_recent(&self, kind: DocKind, path: &std::path::Path) {
        if kind == DocKind::User {
            if let Some(recents) = &self.recents {
                recents.record(path);
            }
        }
    }

    /// What the UI is told about document `id`: the registry's record, with the flags PDFium gave when it loaded the document
    /// (`DocFlags`, kept by the engine). `None` for a document that is unknown, still loading or being closed.
    fn info(&self, id: DocumentId) -> Option<DocumentInfo> {
        // An engine that has no flags for the document (a test double) leaves the flags the registry has.
        if let Ok(flags) = self.engine.doc_flags(id) {
            // The entry may be gone by now (closed meanwhile); the info is then `None` below.
            let _ = self.registry.set_flags(id, flags);
        }
        self.registry.info(id)
    }

    /// Opens the PDF at `path`, which must come from the Rust side (dialog, drop, OS, command line; SECURITY I3).
    ///
    /// Intake judges the file on the handle it opens (`documents::intake::admit`), the registry dedupes by the canonical path
    /// (a file that is open already answers with its existing document, and a file that another request is still loading
    /// answers `None`: that request reports it), and the engine loads the same handle. Errors leave nothing registered. A file
    /// that needs a password is an error here (`password_required`) and is not kept; the paths that can ask for the password
    /// ([`AppState::open_each`], `open_recent`) use [`AppState::open_outcome`].
    /// Whether the UI has a document open: the window asks the UI before it closes then (`sources::on_window_event`).
    pub fn has_open_documents(&self) -> bool {
        self.registry.has_loaded()
    }

    pub fn open_path(&self, path: PathBuf) -> Result<Option<DocumentInfo>, AppError> {
        self.require_ready(self.open_as(path, DocKind::User, None)?)
    }

    /// [`AppState::open_path`] that can end with a file waiting for its password ([`Opened::Locked`]).
    pub fn open_outcome(&self, path: PathBuf) -> Result<Opened, AppError> {
        self.open_as(path, DocKind::User, None)
    }

    /// For the callers that cannot ask for a password: a locked document is forgotten again and the answer is the error.
    fn require_ready(&self, opened: Opened) -> Result<Option<DocumentInfo>, AppError> {
        match opened {
            Opened::Ready(document) => Ok(Some(document)),
            Opened::Pending => Ok(None),
            Opened::Locked { id, .. } => {
                self.registry.remove_locked(id);
                Err(AppError::new(ErrorCode::PasswordRequired))
            }
        }
    }

    /// [`AppState::open_path`] for a document of `kind` that is shown under `name` (when given) and not under its file's name.
    fn open_as(
        &self,
        path: PathBuf,
        kind: DocKind,
        name: Option<String>,
    ) -> Result<Opened, AppError> {
        // Documents that were closed but could not be released then count against the limit: try again before looking at it.
        self.release_closing();
        let Admitted { path, file } = intake::admit(&path)?;
        let canonical = path.clone();
        let id = match self.registry.claim_as(path, kind, name)? {
            Claim::New(id) => id,
            Claim::Existing(id) => {
                // A file that is waiting for its password asks again; one that is loaded answers as it is.
                return Ok(match self.registry.locked_name(id) {
                    Some(display_name) => Opened::Locked { id, display_name },
                    None => self.info(id).map_or(Opened::Pending, Opened::Ready),
                });
            }
        };
        // The engine asks this once the document is loaded. It records the page count in the same step, so the entry either
        // gets it before the caller gives up (below) or is already gone and the engine drops the document.
        let registry = Arc::clone(&self.registry);
        self.registry.set_fingerprint(id, Fingerprint::of(&file));
        let confirm = move |page_count| registry.set_page_count(id, page_count).is_ok();
        match self.engine.open(id, file, confirm) {
            Ok(page_count) => {
                // Already recorded by `confirm`; recorded again for an engine that does not ask.
                self.registry.set_page_count(id, page_count)?;
            }
            // Encrypted and the empty password does not fit: the entry stays, waiting for `unlock_document`.
            Err(error)
                if error.code() == ErrorCode::PasswordRequired
                    && self.registry.lock_for_password(id) =>
            {
                let display_name = self.registry.locked_name(id).unwrap_or_default();
                return Ok(Opened::Locked { id, display_name });
            }
            Err(error) => {
                return match self.registry.abandon(id) {
                    // The deadline passed, but the engine had finished loading and had recorded the document just before: it
                    // is open, and is told as such.
                    Abandoned::Loaded(_) => {
                        self.note_recent(kind, &canonical);
                        Ok(self.info(id).map_or(Opened::Pending, Opened::Ready))
                    }
                    // Not loaded: the entry is gone, so a load that is still running finds nobody and releases the document.
                    Abandoned::Removed | Abandoned::Gone => Err(error),
                };
            }
        }
        self.refresh_permissions(id);
        self.note_recent(kind, &canonical);
        Ok(self.info(id).map_or(Opened::Pending, Opened::Ready))
    }

    /// Gives the password the user typed for the document `id` that waits for it (`Opened::Locked`) and returns the document once it
    /// is open (ADR-026, DESIGN 3.19).
    ///
    /// The password must be 1 to `MAX_PASSWORD_BYTES` bytes without NUL (`invalid_argument`, `what: "password"`); it lives in a
    /// [`Zeroizing`] string, goes to PDFium and is never stored or logged. A wrong one is `password_required` and is counted: after
    /// `FREE_PASSWORD_ATTEMPTS` wrong ones every attempt first waits until `PASSWORD_RETRY_DELAY` has passed since the last wrong
    /// one, here, so the webview cannot skip it. Any other failure (the file changed, is damaged or uses an unsupported
    /// handler) forgets the document and is the error; an id that does not wait for a password is `not_found`. Attempts are serialised
    /// per document and bounded in all (`UnlockGate`): one that comes while another runs is `limit_exceeded`, `what: "unlocks"`.
    pub fn unlock(
        &self,
        id: DocumentId,
        password: Zeroizing<String>,
    ) -> Result<DocumentInfo, AppError> {
        if password.is_empty()
            || password.len() > limits::MAX_PASSWORD_BYTES
            || password.contains('\0')
        {
            return Err(AppError::invalid("password"));
        }
        let Some((path, kind)) = self.registry.locked_path(id) else {
            return Err(AppError::not_found("document"));
        };
        // One attempt per document at a time, and a few in all: the count of wrong passwords is read below and written after the
        // engine has answered, so two attempts in parallel would both see "no wait". Held until this call returns.
        let _slot = self.unlocks.enter(id)?;
        let wait = self.registry.password_wait(id, Instant::now());
        if !wait.is_zero() {
            std::thread::sleep(wait);
        }
        // The file is judged again on a fresh handle: whatever is at the path now is what is opened.
        let Admitted { path, file } = match intake::admit(&path) {
            Ok(admitted) => admitted,
            Err(error) => {
                self.registry.remove_locked(id);
                return Err(error);
            }
        };
        let session = password.clone();
        let registry = Arc::clone(&self.registry);
        self.registry.set_fingerprint(id, Fingerprint::of(&file));
        let confirm = move |page_count| registry.set_page_count(id, page_count).is_ok();
        match self
            .engine
            .open_with_password(id, file, Some(password), confirm)
        {
            Ok(page_count) => {
                self.registry.set_page_count(id, page_count)?;
                // The file may be saved again, and a save needs the password to read it (ADR-047 §4).
                self.note_session_password(id, Some(session));
            }
            Err(error) if error.code() == ErrorCode::PasswordRequired => {
                self.registry.note_wrong_password(id, Instant::now());
                return Err(error);
            }
            Err(error) => {
                return match self.registry.abandon(id) {
                    Abandoned::Loaded(_) => self.unlocked(id, kind, &path),
                    Abandoned::Removed | Abandoned::Gone => Err(error),
                };
            }
        }
        self.unlocked(id, kind, &path)
    }

    fn unlocked(
        &self,
        id: DocumentId,
        kind: DocKind,
        path: &std::path::Path,
    ) -> Result<DocumentInfo, AppError> {
        self.refresh_permissions(id);
        self.note_recent(kind, path);
        self.info(id).ok_or(AppError::not_found("document"))
    }

    /// The recent files for the UI, newest first (at most `MAX_RECENTS`), with the ones whose file is gone marked `missing`.
    pub fn list_recents(&self) -> Vec<RecentEntry> {
        self.recents
            .as_ref()
            .map_or_else(Vec::new, |recents| recents.list())
    }

    /// Takes entry `id` off the list. An id that is not listed is nothing (the list may have changed under the UI).
    pub fn remove_recent(&self, id: u32) {
        if let Some(recents) = &self.recents {
            recents.remove(id);
        }
    }

    /// Opens the recent file `id`, the way a file from the dialog opens (intake, password, the same events). An id that is not
    /// listed is `not_found`; a file that is gone is `io_not_found` in the event, and stays listed as missing.
    pub fn open_recent(&self, id: u32) -> Result<AppEvent, AppError> {
        let path = self
            .recents
            .as_ref()
            .and_then(|recents| recents.path_of(id))
            .ok_or(AppError::not_found("recent"))?;
        Ok(match self.open_outcome(path) {
            Ok(opened) => opened
                .into_event()
                .unwrap_or_else(|| AppEvent::open_failed(AppError::new(ErrorCode::Internal))),
            Err(error) => AppEvent::open_failed(error),
        })
    }

    /// Opens the bundled welcome document at `path` (found by the caller from the resource directory, never from the UI) as
    /// `DocKind::Welcome` under `name`, through the same intake as every file. A welcome document that is open already is closed
    /// (its edits are discarded) first, so the tour starts fresh. The answer is the open event, like the other opens.
    pub fn open_welcome(&self, path: PathBuf, name: String) -> AppEvent {
        for id in self.registry.welcome_ids() {
            if let Err(error) = self.close_document(id) {
                return AppEvent::open_failed(error);
            }
        }
        match self
            .open_as(path, DocKind::Welcome, Some(name))
            .and_then(|opened| self.require_ready(opened))
        {
            Ok(Some(document)) => AppEvent::opened(document),
            // Another request is loading the very same file and reports it, so this one has nothing to say.
            Ok(None) => AppEvent::open_failed(AppError::new(ErrorCode::Internal)),
            Err(error) => AppEvent::open_failed(error),
        }
    }

    /// Opens every path, one after the other, and hands `report` how each went as soon as it is known, in order: `opened`
    /// (also for a file that was open already), `needsPassword` (an encrypted file, which waits for `unlock_document`) or
    /// `openFailed`, never two for one file and never stopping at a failure. At most `MAX_OPEN_BATCH` paths are taken; the rest
    /// are one more `openFailed` with `limit_exceeded` (`documents`), not one per file.
    pub fn open_each(&self, paths: Vec<PathBuf>, mut report: impl FnMut(AppEvent)) {
        let too_many = paths.len() > limits::MAX_OPEN_BATCH;
        for path in paths.into_iter().take(limits::MAX_OPEN_BATCH) {
            match self.open_outcome(path) {
                // `Pending`: another request is loading this very file and reports it.
                Ok(opened) => {
                    if let Some(event) = opened.into_event() {
                        report(event);
                    }
                }
                Err(error) => report(AppEvent::open_failed(error)),
            }
        }
        if too_many {
            report(AppEvent::open_failed(AppError::limit(
                "documents",
                limits::MAX_OPEN_BATCH as u64,
            )));
        }
    }

    /// [`AppState::open_each`], collected: the answer of the open dialog.
    pub fn open_paths(&self, paths: Vec<PathBuf>) -> Vec<AppEvent> {
        let mut events = Vec::with_capacity(paths.len().min(limits::MAX_OPEN_BATCH) + 1);
        self.open_each(paths, |event| events.push(event));
        events
    }

    /// Closes a document. Closing an unknown id is not an error.
    ///
    /// The document is gone for the UI at once (`Registry::begin_close`: `not_found` everywhere, its path can be opened anew),
    /// but its registry entry stays until the engine has released it. If the engine does not answer (a busy or stuck worker, a
    /// full queue) that is the error returned, the entry stays marked as closing, and the release is tried again by the next
    /// close or open: the engine's copy of the document is never left without an entry that could name it. The same goes for
    /// documents left over from an earlier failure, oldest first.
    pub fn close_document(&self, id: DocumentId) -> Result<(), AppError> {
        // A search of a document that is going away has nothing left to find in.
        self.searches.cancel_document(id);
        // Its annotations and undo history go with it (a save has to come first; the UI asks before closing a document with changes).
        self.annotations.remove(id);
        // The bytes of the sources it took pages from are not needed any more.
        self.sources.unpin_all(id);
        // Its print sets (rendered pages held in memory) go too.
        crate::print::sets().release_doc(id);
        // A document that still waits for its password was never loaded: cancelling its prompt forgets it.
        self.registry.remove_locked(id);
        self.registry.begin_close(id);
        match self.release_closing_checked() {
            // This document is still waiting for its release: that is the answer.
            Err(error) if self.registry.closing().contains(&id) => Err(error),
            // An older one could not be released; it is none of this call's business, and is tried again later.
            Err(error) => {
                error.log();
                Ok(())
            }
            Ok(()) => Ok(()),
        }
    }

    /// Asks the engine to release every document marked as closing, oldest first, and forgets each one the engine confirms.
    /// Stops at the first the engine does not answer (the others would not be answered either) and returns its error.
    fn release_closing_checked(&self) -> Result<(), AppError> {
        for id in self.registry.closing() {
            self.engine.close(id)?;
            self.registry.remove(id);
        }
        Ok(())
    }

    /// [`AppState::release_closing_checked`] for the caller that has no use for the answer: a failure leaves the documents
    /// marked as closing for the next try.
    fn release_closing(&self) {
        if let Err(error) = self.release_closing_checked() {
            error.log();
        }
    }
}

impl AppState {
    /// The engine handle, for the output modules outside `commands` (`export`, `print`; ADR-049).
    pub fn engine(&self) -> &Engine {
        &self.engine
    }

    /// Whether document `id` has unsaved changes: its file on disk is not what the user sees (ADR-049 §1).
    pub fn has_unsaved_changes(&self, id: DocumentId) -> bool {
        self.annotations.is_dirty(id)
    }
}

/// Runs `job` on the blocking pool and maps its error to the IPC error. A panic in `job` becomes `internal`, so no
/// command can take the app down.
async fn blocking<T, F>(job: F) -> Result<T, UiError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, AppError> + Send + 'static,
{
    match tauri::async_runtime::spawn_blocking(job).await {
        Ok(result) => result.map_err(UiError::from),
        Err(error) => Err(AppError::logged(
            ErrorCode::Internal,
            format!("blocking job failed: {error}"),
        )
        .into()),
    }
}

/// Shows the native "open" dialog (several files can be chosen) and opens what was chosen. Returns how each file went, in the
/// order the dialog gave them (the shapes of `AppEvent::Opened` and `AppEvent::OpenFailed`), and an empty list if the user
/// cancels. At most `MAX_OPEN_BATCH` files are taken; see [`AppState::open_paths`].
#[tauri::command]
pub async fn open_document_dialog(
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<Vec<AppEvent>, UiError> {
    let state = state.inner().clone();
    blocking(move || {
        let picked = window
            .dialog()
            .file()
            .set_parent(&window)
            .add_filter("PDF", &["pdf"])
            .blocking_pick_files();
        let Some(picked) = picked else {
            return Ok(Vec::new());
        };
        // Taken one past the limit, so `open_paths` can tell that there were too many without holding thousands of paths.
        let paths = picked
            .into_iter()
            .take(limits::MAX_OPEN_BATCH + 1)
            .filter_map(|file| match file.into_path() {
                Ok(path) => Some(path),
                Err(error) => {
                    AppError::logged(ErrorCode::Internal, error).log();
                    None
                }
            })
            .collect();
        Ok(state.open_paths(paths))
    })
    .await
}

/// The file of the welcome document in the resource directory (`tauri.conf.json` `bundle.resources`), per interface language.
pub fn welcome_resource(locale: MenuLocale) -> &'static str {
    match locale {
        MenuLocale::En => "resources/welcome/welcome-en.pdf",
        MenuLocale::De => "resources/welcome/welcome-de.pdf",
    }
}

/// Opens the bundled welcome document ("Welcome to {app}.pdf", ADR-023) in the language of the interface. The command takes no
/// argument from the webview: the file comes from the resource directory, found here, and goes through `documents::intake`
/// like any other file. Not a recent. A welcome document that is open is closed first (restart).
#[tauri::command]
pub async fn open_welcome_document(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<AppEvent, UiError> {
    let state = state.inner().clone();
    let locale = menu::ui_locale(&app);
    let name = menu::spec::text(locale, "doc.welcomeName", &menu::app_name(&app));
    let resolved = app
        .path()
        .resolve(welcome_resource(locale), BaseDirectory::Resource);
    blocking(move || {
        let path = resolved.map_err(|error| AppError::logged(ErrorCode::Internal, error))?;
        Ok(state.open_welcome(path, name))
    })
    .await
}

/// Releases a document that was opened (dialog, drop, file association). A document with changes that are not saved is
/// `unsaved_changes` unless the user chose to `discard` them (ADR-004, DESIGN 3.27).
#[tauri::command]
pub async fn close_document(
    state: State<'_, AppState>,
    doc_id: DocumentId,
    discard: Option<bool>,
) -> Result<(), UiError> {
    let state = state.inner().clone();
    blocking(move || state.close_document_checked(doc_id, discard.unwrap_or(false))).await
}

/// Gives the password the user typed for a document that waits for it (`needsPassword`) and answers with the document once it
/// is open (ADR-026, DESIGN 3.19). 1 to 1024 bytes. A wrong password is `password_required` (the prompt stays, and after the third
/// wrong one each try waits a second, in Rust); `close_document` with the same id cancels. The password is wrapped in a
/// [`Zeroizing`] string at once, goes to PDFium and is never stored or logged; the copy the IPC layer parsed it from is out of
/// this code's reach.
#[tauri::command]
pub async fn unlock_document(
    state: State<'_, AppState>,
    doc_id: DocumentId,
    password: String,
) -> Result<DocumentInfo, UiError> {
    let password = Zeroizing::new(password);
    let state = state.inner().clone();
    blocking(move || state.unlock(doc_id, password)).await
}

/// The recent files, newest first, at most 50: id, display name, time of the last open and whether the file is gone. No paths.
#[tauri::command]
pub async fn list_recents(state: State<'_, AppState>) -> Result<Vec<RecentEntry>, UiError> {
    let state = state.inner().clone();
    blocking(move || Ok(state.list_recents())).await
}

/// Takes one entry off the list of recent files (the file stays on disk). An id that is not listed is nothing.
#[tauri::command]
pub async fn remove_recent(state: State<'_, AppState>, recent_id: u32) -> Result<(), UiError> {
    let state = state.inner().clone();
    blocking(move || {
        state.remove_recent(recent_id);
        Ok(())
    })
    .await
}

/// Opens a recent file by its id: `opened`, `needsPassword` or `openFailed` like a file from the dialog. An id that is not listed is
/// `not_found`.
#[tauri::command]
pub async fn open_recent(state: State<'_, AppState>, recent_id: u32) -> Result<AppEvent, UiError> {
    let state = state.inner().clone();
    blocking(move || state.open_recent(recent_id)).await
}

/// Tells the menu bar whether a document is open (macOS): the commands that need one are greyed without it, and Cmd+W closes the
/// window instead of a document. A no-op on Windows, which has no menu bar.
#[tauri::command]
pub async fn set_menu_state(app: AppHandle, has_document: bool) -> Result<(), UiError> {
    menu::set_has_document(&app, has_document);
    Ok(())
}

/// What the tests of the command modules need: a state whose engine is a double that the test scripts, with one loaded document.
#[cfg(test)]
pub(crate) mod testutil {
    use super::*;
    use crate::engine::Job;

    /// A state with `pages` pages in its one document, and the engine double `handler` answers every job that reaches it.
    pub fn state_with_pages(
        pages: u32,
        handler: impl FnMut(Job) + Send + 'static,
    ) -> (AppState, DocumentId) {
        let state = AppState::new(Engine::with_handler(handler));
        let id = state
            .registry
            .register(PathBuf::from("doc.pdf"))
            .expect("register");
        state
            .registry
            .set_page_count(id, pages)
            .expect("page count");
        (state, id)
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::sync::mpsc;
    use std::sync::Mutex;
    use std::thread;

    use super::*;
    use crate::engine::Job;
    use crate::storage::atomic::testutil::TempDir;

    /// What intake lets through. PDFium never sees it in these tests: the engine here is a double.
    const MINIMAL: &[u8] = b"%PDF-1.4\n%%EOF\n";

    /// A state whose engine has no library: enough to test everything that is decided before PDFium is involved.
    fn state_without_engine() -> AppState {
        AppState::new(Engine::start(
            PathBuf::from("no-such-dir").join("pdfium.dll"),
        ))
    }

    fn manifest() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml")
    }

    fn pdf(dir: &TempDir, name: &str) -> PathBuf {
        let path = dir.path().join(name);
        fs::write(&path, MINIMAL).unwrap();
        path
    }

    /// What the double engine saw, in order.
    #[derive(Debug, Clone, PartialEq, Eq)]
    enum Seen {
        Open(DocumentId),
        Close(DocumentId),
    }

    /// An engine that "loads" every document as one of `pages` pages, the way the worker does: it asks the caller's
    /// `confirm` and keeps the document only if it is wanted. Needs no PDFium.
    fn loading_engine(pages: u32) -> (Engine, Arc<Mutex<Vec<Seen>>>) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = Arc::clone(&seen);
        let engine = Engine::with_handler(move |job| match job {
            Job::Open {
                id, confirm, reply, ..
            } => {
                log.lock().unwrap().push(Seen::Open(id));
                let wanted = confirm(pages);
                let _ = reply.send(if wanted {
                    Ok(pages)
                } else {
                    Err(AppError::new(ErrorCode::EngineTimeout))
                });
            }
            Job::Close { id, reply } => {
                log.lock().unwrap().push(Seen::Close(id));
                let _ = reply.send(Ok(()));
            }
            _ => {}
        });
        (engine, seen)
    }

    fn opened_ids(events: &[AppEvent]) -> Vec<u32> {
        events
            .iter()
            .filter_map(|event| match event {
                AppEvent::Opened { document } => {
                    Some(serde_json::to_value(document.id).unwrap().as_u64().unwrap() as u32)
                }
                _ => None,
            })
            .collect()
    }

    fn failed_codes(events: &[AppEvent]) -> Vec<String> {
        events
            .iter()
            .filter_map(|event| match serde_json::to_value(event).unwrap() {
                value if value["type"] == "openFailed" => {
                    Some(value["code"].as_str().unwrap().to_owned())
                }
                _ => None,
            })
            .collect()
    }

    #[test]
    fn failed_opens_leave_nothing_registered() {
        let dir = TempDir::new();
        let state = state_without_engine();
        // Passes intake, then the engine (which has no library) refuses.
        assert_eq!(
            state.open_path(pdf(&dir, "a.pdf")).unwrap_err().code(),
            ErrorCode::EngineUnavailable
        );
        assert!(state.registry.is_empty());
        let missing = dir.path().join("missing.pdf");
        assert_eq!(
            state.open_path(missing).unwrap_err().code(),
            ErrorCode::IoNotFound
        );
        assert!(state.registry.is_empty());
    }

    // --- the welcome document (ADR-023) ---

    #[test]
    fn the_welcome_document_opens_as_welcome_under_its_own_name_and_a_second_call_restarts_it() {
        let dir = TempDir::new();
        let path = pdf(&dir, "welcome-en.pdf");
        let (engine, seen) = loading_engine(4);
        let state = AppState::new(engine);

        let first =
            serde_json::to_value(state.open_welcome(path.clone(), "Welcome to Sheer.pdf".into()))
                .unwrap();
        assert_eq!(first["type"], "opened");
        assert_eq!(first["document"]["kind"], "welcome");
        assert_eq!(first["document"]["displayName"], "Welcome to Sheer.pdf");
        assert_eq!(first["document"]["pageCount"], 4);
        let first_id = first["document"]["id"].as_u64().unwrap() as u32;

        // Again: the open one is closed (discarded) first and the file opens under a new id.
        let second =
            serde_json::to_value(state.open_welcome(path, "Welcome to Sheer.pdf".into())).unwrap();
        assert_eq!(second["type"], "opened");
        assert_ne!(second["document"]["id"].as_u64().unwrap() as u32, first_id);
        assert_eq!(state.registry.welcome_ids().len(), 1);
        let log = seen.lock().unwrap();
        assert_eq!(log.len(), 3, "{log:?}");
        assert!(matches!(log[1], Seen::Close(_)));
    }

    #[test]
    fn a_missing_welcome_file_is_an_open_failure_like_any_other() {
        let state = state_without_engine();
        let event = serde_json::to_value(state.open_welcome(
            PathBuf::from("no-such-dir").join("welcome-en.pdf"),
            "x".into(),
        ))
        .unwrap();
        assert_eq!(event["type"], "openFailed");
        assert_eq!(event["code"], "io_not_found");
        assert!(state.registry.is_empty());
    }

    #[test]
    fn the_welcome_file_follows_the_interface_language() {
        assert_eq!(
            welcome_resource(MenuLocale::En),
            "resources/welcome/welcome-en.pdf"
        );
        assert_eq!(
            welcome_resource(MenuLocale::De),
            "resources/welcome/welcome-de.pdf"
        );
    }

    // --- passwords (ADR-026) and recent files ---

    /// The one password the double engine accepts.
    const SECRET: &str = "s3cret";

    /// An engine that "loads" a file with `pages` pages only when it gets `SECRET`, and answers `password_required` otherwise, as
    /// PDFium does for an encrypted file. Counts the jobs it was given.
    fn locked_engine(pages: u32) -> (Engine, Arc<Mutex<u32>>) {
        let jobs = Arc::new(Mutex::new(0));
        let count = Arc::clone(&jobs);
        let engine = Engine::with_handler(move |job| match job {
            Job::Open {
                password,
                confirm,
                reply,
                ..
            } => {
                *count.lock().unwrap() += 1;
                let fits = password.as_deref().map(String::as_str) == Some(SECRET);
                let _ = reply.send(if fits && confirm(pages) {
                    Ok(pages)
                } else {
                    Err(AppError::new(ErrorCode::PasswordRequired))
                });
            }
            Job::Close { reply, .. } => {
                let _ = reply.send(Ok(()));
            }
            _ => {}
        });
        (engine, jobs)
    }

    fn secret() -> Zeroizing<String> {
        Zeroizing::new(SECRET.to_owned())
    }

    fn wrong() -> Zeroizing<String> {
        Zeroizing::new("nope".to_owned())
    }

    fn locked_id(event: &AppEvent) -> DocumentId {
        match event {
            AppEvent::NeedsPassword { id, .. } => *id,
            other => panic!("expected needsPassword, got {other:?}"),
        }
    }

    #[test]
    fn an_encrypted_file_is_reported_as_needing_a_password_and_waits_without_a_path_on_the_wire() {
        let dir = TempDir::new();
        let (engine, _) = locked_engine(2);
        let state = AppState::new(engine);
        let events = state.open_paths(vec![pdf(&dir, "Locked file.pdf")]);
        assert_eq!(events.len(), 1);
        let id = locked_id(&events[0]);
        assert_eq!(
            serde_json::to_string(&events[0]).unwrap(),
            r#"{"type":"needsPassword","id":0,"displayName":"Locked file.pdf"}"#
        );
        // It is not open: no info, nothing to render, but the entry is there for the next try.
        assert_eq!(state.info(id), None);
        assert_eq!(state.registry.len(), 1);
        // Asking again for the same file asks for the password again, under the same id.
        let again = state.open_paths(vec![pdf(&dir, "Locked file.pdf")]);
        assert_eq!(locked_id(&again[0]), id);
        assert_eq!(state.registry.len(), 1);
    }

    #[test]
    fn open_path_does_not_keep_a_file_that_needs_a_password() {
        let dir = TempDir::new();
        let (engine, _) = locked_engine(2);
        let state = AppState::new(engine);
        assert_eq!(
            state.open_path(pdf(&dir, "a.pdf")).unwrap_err().code(),
            ErrorCode::PasswordRequired
        );
        assert!(state.registry.is_empty());
    }

    #[test]
    fn the_right_password_opens_the_document_and_a_wrong_one_keeps_asking() {
        let dir = TempDir::new();
        let (engine, _) = locked_engine(5);
        let state = AppState::new(engine);
        let id = locked_id(&state.open_paths(vec![pdf(&dir, "a.pdf")])[0]);

        assert_eq!(
            state.unlock(id, wrong()).unwrap_err().code(),
            ErrorCode::PasswordRequired
        );
        assert_eq!(state.info(id), None, "still locked");
        let info = state.unlock(id, secret()).unwrap();
        assert_eq!(info.id, id);
        assert_eq!(info.page_count, 5);
        assert_eq!(info.display_name, "a.pdf");
        // It is a document now: the password is not asked for again, and the id is an ordinary one.
        assert_eq!(
            state.unlock(id, secret()).unwrap_err().code(),
            ErrorCode::NotFound
        );
        state.close_document(id).unwrap();
        assert!(state.registry.is_empty());
    }

    #[test]
    fn a_password_outside_the_bounds_never_reaches_the_engine() {
        let dir = TempDir::new();
        let (engine, jobs) = locked_engine(1);
        let state = AppState::new(engine);
        let id = locked_id(&state.open_paths(vec![pdf(&dir, "a.pdf")])[0]);
        assert_eq!(*jobs.lock().unwrap(), 1, "the first open");
        for bad in [
            String::new(),
            "x".repeat(limits::MAX_PASSWORD_BYTES + 1),
            "a\0b".to_owned(),
        ] {
            let error = state.unlock(id, Zeroizing::new(bad)).unwrap_err();
            assert_eq!(error.code(), ErrorCode::InvalidArgument);
        }
        assert_eq!(*jobs.lock().unwrap(), 1);
        // The limit itself is fine (it is merely wrong), counted in bytes.
        let longest = Zeroizing::new("x".repeat(limits::MAX_PASSWORD_BYTES));
        assert_eq!(
            state.unlock(id, longest).unwrap_err().code(),
            ErrorCode::PasswordRequired
        );
        let wide = Zeroizing::new("é".repeat(limits::MAX_PASSWORD_BYTES / 2 + 1));
        assert_eq!(
            state.unlock(id, wide).unwrap_err().code(),
            ErrorCode::InvalidArgument
        );
    }

    #[test]
    fn an_id_that_waits_for_nothing_cannot_be_unlocked() {
        let (state, id) = testutil::state_with_pages(1, |_| {});
        // Loaded documents and unknown ids alike.
        for id in [id, serde_json::from_str::<DocumentId>("999").unwrap()] {
            assert_eq!(
                state.unlock(id, secret()).unwrap_err().code(),
                ErrorCode::NotFound
            );
        }
    }

    #[test]
    fn after_the_third_wrong_password_each_try_waits_in_rust() {
        let dir = TempDir::new();
        let (engine, _) = locked_engine(1);
        let state = AppState::new(engine);
        let id = locked_id(&state.open_paths(vec![pdf(&dir, "a.pdf")])[0]);

        // Each of the free tries on its own: a busy machine slows the sum down, but none of them waits the delay.
        for _ in 0..limits::FREE_PASSWORD_ATTEMPTS {
            let started = std::time::Instant::now();
            assert!(state.unlock(id, wrong()).is_err());
            assert!(
                started.elapsed() < limits::PASSWORD_RETRY_DELAY,
                "the first three tries are not slowed down"
            );
        }
        // The fourth waits, whatever the password; so does the right one.
        let fourth = std::time::Instant::now();
        assert!(state.unlock(id, wrong()).is_err());
        assert!(fourth.elapsed() >= limits::PASSWORD_RETRY_DELAY);
        let fifth = std::time::Instant::now();
        assert!(state.unlock(id, secret()).is_ok());
        assert!(fifth.elapsed() >= limits::PASSWORD_RETRY_DELAY);
    }

    #[test]
    fn a_second_unlock_of_a_document_is_refused_while_one_runs_so_the_wait_cannot_be_skipped() {
        let dir = TempDir::new();
        let (engine, jobs) = locked_engine(1);
        let state = AppState::new(engine);
        let id = locked_id(&state.open_paths(vec![pdf(&dir, "a.pdf")])[0]);
        let slot = state.unlocks.enter(id).unwrap();
        let error = state.unlock(id, secret()).unwrap_err();
        assert_eq!(error.code(), ErrorCode::LimitExceeded);
        assert_eq!(
            *jobs.lock().unwrap(),
            1,
            "the refused attempt never reached the engine"
        );
        drop(slot);
        // The place is free again, also after an attempt that failed.
        assert_eq!(
            state.unlock(id, wrong()).unwrap_err().code(),
            ErrorCode::PasswordRequired
        );
        assert!(state.unlock(id, secret()).is_ok());
    }

    #[test]
    fn only_a_few_unlocks_run_at_once_in_all() {
        let gate = Arc::new(UnlockGate::default());
        let registry = Registry::new();
        let slots: Vec<UnlockSlot> = (0..MAX_CONCURRENT_UNLOCKS)
            .map(|i| {
                let id = registry
                    .register(std::path::PathBuf::from(format!("{i}.pdf")))
                    .unwrap();
                gate.enter(id).unwrap()
            })
            .collect();
        let extra = registry
            .register(std::path::PathBuf::from("x.pdf"))
            .unwrap();
        assert_eq!(
            gate.enter(extra).err().map(|e| e.code()),
            Some(ErrorCode::LimitExceeded)
        );
        drop(slots);
        assert!(gate.enter(extra).is_ok());
    }

    #[test]
    fn cancelling_the_prompt_forgets_the_document() {
        let dir = TempDir::new();
        let (engine, _) = locked_engine(1);
        let state = AppState::new(engine);
        let id = locked_id(&state.open_paths(vec![pdf(&dir, "a.pdf")])[0]);
        state.close_document(id).unwrap();
        assert!(state.registry.is_empty());
        assert_eq!(
            state.unlock(id, secret()).unwrap_err().code(),
            ErrorCode::NotFound
        );
    }

    #[test]
    fn a_file_that_changed_while_the_prompt_was_open_is_refused_and_forgotten() {
        let dir = TempDir::new();
        let (engine, _) = locked_engine(1);
        let state = AppState::new(engine);
        let path = pdf(&dir, "a.pdf");
        let id = locked_id(&state.open_paths(vec![path.clone()])[0]);
        fs::write(&path, b"not a pdf any more").unwrap();
        assert_eq!(
            state.unlock(id, secret()).unwrap_err().code(),
            ErrorCode::NotAPdf
        );
        assert!(state.registry.is_empty());
    }

    fn state_with_recents(dir: &TempDir, pages: u32) -> AppState {
        let (engine, _) = loading_engine(pages);
        AppState::new(engine).with_recents(Arc::new(RecentsStore::load(
            dir.path().join(crate::storage::recents::FILE_NAME),
        )))
    }

    #[test]
    fn opened_files_become_recents_without_a_path_and_the_welcome_document_does_not() {
        let dir = TempDir::new();
        let state = state_with_recents(&dir, 1);
        state.open_paths(vec![pdf(&dir, "a.pdf"), pdf(&dir, "b.pdf")]);
        let welcome = state.open_welcome(pdf(&dir, "welcome-en.pdf"), "Welcome.pdf".into());
        assert_eq!(serde_json::to_value(welcome).unwrap()["type"], "opened");
        let list = state.list_recents();
        let names: Vec<&str> = list.iter().map(|e| e.display_name.as_str()).collect();
        assert_eq!(names, ["b.pdf", "a.pdf"]);
        assert!(list.iter().all(|entry| !entry.missing));
        let json = serde_json::to_string(&list).unwrap();
        // Only the parent folder's name, never the path to it.
        assert!(list
            .iter()
            .all(|entry| entry.folder.starts_with("sheer-test")));
        assert!(
            !json.contains(std::env::temp_dir().to_string_lossy().as_ref()),
            "{json}"
        );
        assert!(!json.contains('/') && !json.contains("\\\\"), "{json}");
    }

    #[test]
    fn a_failed_open_is_not_a_recent_and_a_password_file_is_one_once_unlocked() {
        let dir = TempDir::new();
        let (engine, _) = locked_engine(1);
        let state = AppState::new(engine).with_recents(Arc::new(RecentsStore::load(
            dir.path().join(crate::storage::recents::FILE_NAME),
        )));
        let id = locked_id(&state.open_paths(vec![pdf(&dir, "a.pdf")])[0]);
        assert!(state.list_recents().is_empty(), "not open yet");
        state.unlock(id, secret()).unwrap();
        assert_eq!(state.list_recents().len(), 1);
        state.open_paths(vec![manifest()]);
        assert_eq!(
            state.list_recents().len(),
            1,
            "a refused file is not listed"
        );
    }

    #[test]
    fn a_recent_opens_by_id_and_a_missing_one_says_so_and_stays_removable() {
        let dir = TempDir::new();
        let state = state_with_recents(&dir, 3);
        let a = pdf(&dir, "a.pdf");
        state.open_paths(vec![a.clone()]);
        let id = state.list_recents()[0].id;
        // Opened from the list while it is open already: the document it has.
        let open = state.open_recent(id).unwrap();
        assert_eq!(serde_json::to_value(open).unwrap()["type"], "opened");

        fs::remove_file(&a).unwrap();
        assert!(state.list_recents()[0].missing);
        let event = serde_json::to_value(state.open_recent(id).unwrap()).unwrap();
        assert_eq!(event["type"], "openFailed");
        assert_eq!(event["code"], "io_not_found");
        // Still listed (the drive may come back) until the user removes it.
        assert_eq!(state.list_recents().len(), 1);
        state.remove_recent(id);
        assert!(state.list_recents().is_empty());
        state.remove_recent(id);
        assert_eq!(
            state.open_recent(id).unwrap_err().code(),
            ErrorCode::NotFound
        );
    }

    #[test]
    fn without_a_store_there_are_no_recents_and_nothing_to_open() {
        let state = state_without_engine();
        assert!(state.list_recents().is_empty());
        state.remove_recent(0);
        assert_eq!(
            state.open_recent(0).unwrap_err().code(),
            ErrorCode::NotFound
        );
    }
    // --- the intake rules, through the state (ARCHITECTURE §4) ---

    #[test]
    fn a_file_without_the_pdf_signature_is_refused_before_the_engine_and_nothing_is_registered() {
        let state = state_without_engine();
        // Cargo.toml is text: refused by intake, so the missing engine is never reached.
        assert_eq!(
            state.open_path(manifest()).unwrap_err().code(),
            ErrorCode::NotAPdf
        );
        assert!(state.registry.is_empty());
    }

    #[test]
    fn only_regular_files_are_opened() {
        let state = state_without_engine();
        let directory = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        assert_eq!(
            state.open_path(directory).unwrap_err().code(),
            ErrorCode::NotAPdf
        );
        assert!(state.registry.is_empty());
    }

    #[test]
    fn a_file_is_open_once_whatever_its_name() {
        let dir = TempDir::new();
        fs::create_dir(dir.path().join("sub")).unwrap();
        let path = pdf(&dir, "a.pdf");
        let (engine, seen) = loading_engine(3);
        let state = AppState::new(engine);

        let first = state.open_path(path.clone()).unwrap().unwrap();
        // The same file under another spelling, and a link to it where the platform allows one.
        let roundabout = dir.path().join("sub").join("..").join("a.pdf");
        let second = state.open_path(roundabout).unwrap().unwrap();
        assert_eq!(first, second);
        let link = dir.path().join("link.pdf");
        #[cfg(unix)]
        let linked = std::os::unix::fs::symlink(&path, &link).is_ok();
        #[cfg(windows)]
        let linked = std::os::windows::fs::symlink_file(&path, &link).is_ok();
        if linked {
            assert_eq!(state.open_path(link).unwrap().unwrap(), first);
        }

        assert_eq!(state.registry.len(), 1);
        assert_eq!(*seen.lock().unwrap(), [Seen::Open(first.id)]);
        assert_eq!(first.page_count, 3);
        assert_eq!(first.display_name, "a.pdf");
    }

    #[test]
    fn ids_are_never_reused_in_a_session() {
        let dir = TempDir::new();
        let (engine, _) = loading_engine(1);
        let state = AppState::new(engine);
        let a = state.open_path(pdf(&dir, "a.pdf")).unwrap().unwrap();
        state.close_document(a.id).unwrap();
        // The same file again is a new document with a new id.
        let again = state.open_path(dir.path().join("a.pdf")).unwrap().unwrap();
        let b = state.open_path(pdf(&dir, "b.pdf")).unwrap().unwrap();
        assert_ne!(a.id, again.id);
        assert_ne!(again.id, b.id);
        assert_ne!(a.id, b.id);
    }

    #[test]
    fn at_most_32_documents_are_open_and_one_that_is_open_can_still_be_asked_for() {
        let dir = TempDir::new();
        let (engine, _) = loading_engine(1);
        let state = AppState::new(engine);
        let paths: Vec<PathBuf> = (0..=limits::MAX_OPEN_DOCUMENTS)
            .map(|i| pdf(&dir, &format!("{i}.pdf")))
            .collect();
        let mut first = None;
        for path in &paths[..limits::MAX_OPEN_DOCUMENTS] {
            let info = state.open_path(path.clone()).unwrap().unwrap();
            first.get_or_insert(info.id);
        }
        let error = state.open_path(paths[limits::MAX_OPEN_DOCUMENTS].clone());
        assert_eq!(error.unwrap_err().code(), ErrorCode::LimitExceeded);
        assert_eq!(state.registry.len(), limits::MAX_OPEN_DOCUMENTS);
        // The limit is on new documents: one that is open answers with its id.
        assert!(state.open_path(paths[0].clone()).unwrap().is_some());
        // Closing one makes room.
        state.close_document(first.unwrap()).unwrap();
        assert!(state
            .open_path(paths[limits::MAX_OPEN_DOCUMENTS].clone())
            .unwrap()
            .is_some());
    }

    #[test]
    fn a_batch_is_cut_at_the_limit_with_one_error_for_all_the_rest() {
        let dir = TempDir::new();
        let (engine, _) = loading_engine(1);
        let state = AppState::new(engine);
        let paths: Vec<PathBuf> = (0..limits::MAX_OPEN_BATCH + 8)
            .map(|i| pdf(&dir, &format!("{i}.pdf")))
            .collect();
        let events = state.open_paths(paths);
        assert_eq!(opened_ids(&events).len(), limits::MAX_OPEN_BATCH);
        assert_eq!(failed_codes(&events), ["limit_exceeded"]);
        // The error names what ran out and the number, nothing else.
        let json = serde_json::to_value(events.last().unwrap()).unwrap();
        assert_eq!(
            json["params"],
            serde_json::json!({ "what": "documents", "limit": 32 })
        );
    }

    #[test]
    fn one_bad_file_does_not_stop_the_others_and_each_is_told_in_order() {
        let dir = TempDir::new();
        let (engine, _) = loading_engine(2);
        let state = AppState::new(engine);
        let text = dir.path().join("text.pdf");
        fs::write(&text, b"not a pdf").unwrap();
        let events = state.open_paths(vec![
            pdf(&dir, "one.pdf"),
            text,
            dir.path().join("missing.pdf"),
            pdf(&dir, "two.pdf"),
        ]);
        let kinds: Vec<String> = events
            .iter()
            .map(|event| {
                let value = serde_json::to_value(event).unwrap();
                match value["type"].as_str().unwrap() {
                    "opened" => format!(
                        "opened {}",
                        value["document"]["displayName"].as_str().unwrap()
                    ),
                    _ => value["code"].as_str().unwrap().to_owned(),
                }
            })
            .collect();
        assert_eq!(
            kinds,
            [
                "opened one.pdf",
                "not_a_pdf",
                "io_not_found",
                "opened two.pdf"
            ]
        );
    }

    #[test]
    fn asking_again_for_an_open_document_is_reported_as_opened_with_the_same_id() {
        let dir = TempDir::new();
        let (engine, _) = loading_engine(1);
        let state = AppState::new(engine);
        let path = pdf(&dir, "a.pdf");
        let first = state.open_paths(vec![path.clone()]);
        let second = state.open_paths(vec![path]);
        assert_eq!(opened_ids(&first), opened_ids(&second));
        assert_eq!(opened_ids(&second).len(), 1);
    }

    #[test]
    fn a_file_that_is_still_loading_is_not_loaded_a_second_time() {
        let dir = TempDir::new();
        let path = pdf(&dir, "slow.pdf");
        // The engine holds the first open until the test lets it go.
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel::<()>();
        let release_rx = Mutex::new(release_rx);
        let opens = Arc::new(Mutex::new(0));
        let counted = Arc::clone(&opens);
        let engine = Engine::with_handler(move |job| {
            if let Job::Open { confirm, reply, .. } = job {
                *counted.lock().unwrap() += 1;
                entered_tx.send(()).unwrap();
                release_rx.lock().unwrap().recv().unwrap();
                let _ = confirm(4);
                let _ = reply.send(Ok(4));
            }
        });
        let state = AppState::new(engine);

        let first = {
            let (state, path) = (state.clone(), path.clone());
            thread::spawn(move || state.open_path(path))
        };
        entered_rx.recv().unwrap();
        // Same file, while the first is in the engine: nothing is started, and the first request is the one to report it.
        assert_eq!(state.open_path(path).unwrap(), None);
        release_tx.send(()).unwrap();
        let opened = first.join().unwrap().unwrap().unwrap();
        assert_eq!(opened.page_count, 4);
        assert_eq!(*opens.lock().unwrap(), 1);
        assert_eq!(state.registry.len(), 1);
    }

    // --- an open that outlives its deadline (SECURITY P5) ---

    /// What `Engine::open` returns when the caller's deadline passes first, while the worker is still busy.
    fn timed_out() -> AppError {
        AppError::new(ErrorCode::EngineTimeout)
    }

    #[test]
    fn a_timed_out_open_that_the_engine_finishes_later_finds_no_entry_and_drops_the_document() {
        let dir = TempDir::new();
        let path = pdf(&dir, "late.pdf");
        // The engine answers "timeout" at once, as the caller would see it, and keeps the job's `confirm` to call it later,
        // as the worker does when the document finally finishes loading.
        let late: Arc<Mutex<Option<crate::engine::Confirm>>> = Arc::new(Mutex::new(None));
        let held = Arc::clone(&late);
        let engine = Engine::with_handler(move |job| {
            if let Job::Open { confirm, reply, .. } = job {
                *held.lock().unwrap() = Some(confirm);
                let _ = reply.send(Err(timed_out()));
            }
        });
        let state = AppState::new(engine);

        assert_eq!(
            state.open_path(path).unwrap_err().code(),
            ErrorCode::EngineTimeout
        );
        assert!(state.registry.is_empty(), "the entry went with the failure");
        // The worker's question comes now: nobody wants the document, so it is to be dropped, not kept.
        let confirm = late.lock().unwrap().take().unwrap();
        assert!(!confirm(5));
        assert!(state.registry.is_empty(), "and it did not come back");
    }

    #[test]
    fn a_timed_out_open_whose_document_was_recorded_just_before_is_open_after_all() {
        let dir = TempDir::new();
        let path = pdf(&dir, "just-in-time.pdf");
        // The worker finished (and recorded the page count) in the moment between the deadline and the caller's cleanup.
        let engine = Engine::with_handler(|job| match job {
            Job::Open { confirm, reply, .. } => {
                assert!(confirm(7));
                let _ = reply.send(Err(timed_out()));
            }
            Job::Close { reply, .. } => {
                let _ = reply.send(Ok(()));
            }
            _ => {}
        });
        let state = AppState::new(engine);
        let info = state.open_path(path).unwrap().unwrap();
        assert_eq!(info.page_count, 7);
        assert_eq!(
            state.registry.len(),
            1,
            "the document is registered, so it can be closed"
        );
        state.close_document(info.id).unwrap();
        assert!(state.registry.is_empty());
    }

    // --- intake edge cases, through the state ---

    /// A symlink, or `false` when the platform refuses it (Windows needs a privilege or developer mode).
    fn link(target: &std::path::Path, at: &std::path::Path) -> bool {
        #[cfg(unix)]
        let made = std::os::unix::fs::symlink(target, at);
        #[cfg(windows)]
        let made = if target.is_dir() {
            std::os::windows::fs::symlink_dir(target, at)
        } else {
            std::os::windows::fs::symlink_file(target, at)
        };
        #[cfg(not(any(unix, windows)))]
        let made: std::io::Result<()> = Err(std::io::Error::from(std::io::ErrorKind::Unsupported));
        made.is_ok()
    }

    fn seen_opens(seen: &Mutex<Vec<Seen>>) -> usize {
        let log = seen.lock().unwrap();
        log.iter()
            .filter(|entry| matches!(entry, Seen::Open(_)))
            .count()
    }

    fn id_number(id: DocumentId) -> u64 {
        serde_json::to_value(id).unwrap().as_u64().unwrap()
    }

    #[test]
    fn refused_files_never_reach_the_engine_or_the_registry() {
        let dir = TempDir::new();
        let (engine, seen) = loading_engine(1);
        let state = AppState::new(engine);

        let beyond_the_window = {
            let mut bytes = vec![b' '; limits::PDF_SNIFF_BYTES];
            bytes.extend_from_slice(MINIMAL);
            bytes
        };
        let mut refused = Vec::new();
        for (name, bytes) in [
            ("empty.pdf", &b""[..]),
            ("text.pdf", b"plain text"),
            ("png.pdf", b"\x89PNG\r\n\x1a\n"),
            ("short.pdf", b"%PDF"),
            ("late.pdf", &beyond_the_window[..]),
        ] {
            let path = dir.path().join(name);
            fs::write(&path, bytes).unwrap();
            refused.push((path, ErrorCode::NotAPdf));
        }
        let folder = dir.path().join("folder.pdf");
        fs::create_dir(&folder).unwrap();
        let folder_link = dir.path().join("folder-link.pdf");
        if link(&folder, &folder_link) {
            refused.push((folder_link, ErrorCode::NotAPdf));
        }
        refused.push((folder, ErrorCode::NotAPdf));
        refused.push((dir.path().join("missing.pdf"), ErrorCode::IoNotFound));
        let dangling = dir.path().join("dangling.pdf");
        if link(&dir.path().join("gone.pdf"), &dangling) {
            refused.push((dangling, ErrorCode::IoNotFound));
        }

        for (path, expected) in refused {
            let name = path.file_name().unwrap().to_string_lossy().into_owned();
            let error = state.open_path(path).unwrap_err();
            assert_eq!(error.code(), expected, "{name}");
            assert!(state.registry.is_empty(), "{name} left an entry");
        }
        assert!(seen.lock().unwrap().is_empty(), "the engine was asked");

        // The state is as good as new: the next good file is the one the engine is asked for.
        let info = state.open_path(pdf(&dir, "good.pdf")).unwrap().unwrap();
        assert_eq!(*seen.lock().unwrap(), [Seen::Open(info.id)]);
    }

    /// Windows file names ignore case: `REPORT.PDF` and `Report.pdf` are one file, so one document.
    #[cfg(windows)]
    #[test]
    fn a_file_is_open_once_whatever_the_case_of_its_name_on_windows() {
        let dir = TempDir::new();
        let path = pdf(&dir, "Report.pdf");
        let upper = dir.path().join("REPORT.PDF");
        if !upper.exists() {
            eprintln!("skipping: this directory is case-sensitive");
            return;
        }
        let (engine, seen) = loading_engine(2);
        let state = AppState::new(engine);
        let first = state.open_path(path).unwrap().unwrap();
        let again = state.open_path(upper).unwrap().unwrap();
        assert_eq!(first, again);
        assert_eq!(*seen.lock().unwrap(), [Seen::Open(first.id)]);
        assert_eq!(state.registry.len(), 1);
    }

    #[test]
    fn the_33rd_open_is_refused_with_the_limit_and_nothing_else_even_inside_a_batch() {
        const MAX: usize = limits::MAX_OPEN_DOCUMENTS;
        let dir = TempDir::new();
        let (engine, seen) = loading_engine(1);
        let state = AppState::new(engine);
        let paths: Vec<PathBuf> = (0..=MAX).map(|i| pdf(&dir, &format!("{i}.pdf"))).collect();
        let events = state.open_paths(paths[..MAX].to_vec());
        assert_eq!(opened_ids(&events).len(), MAX);
        assert!(failed_codes(&events).is_empty());

        // The 33rd, between two files that are open already: only that one is refused, the others are answered as usual.
        let events = state.open_paths(vec![paths[0].clone(), paths[MAX].clone(), paths[1].clone()]);
        let types: Vec<String> = events
            .iter()
            .map(|event| serde_json::to_value(event).unwrap()["type"].to_string())
            .collect();
        assert_eq!(types, [r#""opened""#, r#""openFailed""#, r#""opened""#]);
        assert_eq!(
            serde_json::to_string(&events[1]).unwrap(),
            r#"{"type":"openFailed","code":"limit_exceeded","key":"error.limit_exceeded","retryable":false,"params":{"what":"documents","limit":32}}"#
        );
        // It left nothing behind, and the engine was never asked to load it.
        assert_eq!(state.registry.len(), MAX);
        assert_eq!(seen_opens(&seen), MAX);

        // A file that is not a PDF is told so even at the limit: intake judges it before the registry counts it.
        let text = dir.path().join("text.pdf");
        fs::write(&text, b"plain text").unwrap();
        assert_eq!(failed_codes(&state.open_paths(vec![text])), ["not_a_pdf"]);

        // The limit is about open documents: one close makes room for exactly one.
        let first = state.open_path(paths[0].clone()).unwrap().unwrap();
        state.close_document(first.id).unwrap();
        assert!(failed_codes(&state.open_paths(vec![paths[MAX].clone()])).is_empty());
        let one_more = dir.path().join("one-more.pdf");
        fs::write(&one_more, MINIMAL).unwrap();
        assert_eq!(
            failed_codes(&state.open_paths(vec![one_more])),
            ["limit_exceeded"]
        );
    }

    #[test]
    fn ids_only_grow_across_opens_closes_and_opens_that_failed() {
        let dir = TempDir::new();
        let path = pdf(&dir, "a.pdf");
        // Every third open is answered with a timeout and never confirmed: its entry is taken back (and its id with it).
        let attempts: Arc<Mutex<Vec<u64>>> = Arc::default();
        let log = Arc::clone(&attempts);
        let engine = Engine::with_handler(move |job| match job {
            Job::Open {
                id, confirm, reply, ..
            } => {
                let mut ids = log.lock().unwrap();
                ids.push(id_number(id));
                if ids.len().is_multiple_of(3) {
                    let _ = reply.send(Err(timed_out()));
                } else {
                    let _ = confirm(1);
                    let _ = reply.send(Ok(1));
                }
            }
            Job::Close { reply, .. } => {
                let _ = reply.send(Ok(()));
            }
            _ => {}
        });
        let state = AppState::new(engine);

        let rounds = 3 * limits::MAX_OPEN_DOCUMENTS;
        for round in 0..rounds {
            match state.open_path(path.clone()) {
                Ok(info) => state.close_document(info.unwrap().id).unwrap(),
                Err(error) => assert_eq!(error.code(), ErrorCode::EngineTimeout, "round {round}"),
            }
        }
        assert!(state.registry.is_empty());
        let ids = attempts.lock().unwrap().clone();
        assert_eq!(ids.len(), rounds, "every attempt asked the engine");
        assert!(
            ids.windows(2).all(|pair| pair[0] < pair[1]),
            "an id was used twice or went back: {ids:?}"
        );
    }

    /// The UI hears codes and the whitelisted params: no path, no directory, no file name of a refused file, no OS message.
    #[test]
    fn what_the_ui_hears_of_a_batch_holds_no_path_and_no_file_system_detail() {
        let dir = TempDir::new();
        let secret = dir.path().join("confidential-7731");
        fs::create_dir(&secret).unwrap();
        let (engine, _) = loading_engine(2);
        let state = AppState::new(engine);

        let text = secret.join("secret-name-4242.pdf");
        fs::write(&text, b"plain text").unwrap();
        let empty = secret.join("empty-name-5151.pdf");
        fs::write(&empty, b"").unwrap();
        let folder = secret.join("folder-name-8855.pdf");
        fs::create_dir(&folder).unwrap();
        let good = secret.join("good-name-9090.pdf");
        fs::write(&good, MINIMAL).unwrap();
        let events = state.open_paths(vec![
            text,
            empty,
            secret.join("missing-name-1234.pdf"),
            folder,
            good,
        ]);
        assert_eq!(events.len(), 5);

        let dir_text = dir.path().to_string_lossy().into_owned();
        let mut wire: Vec<serde_json::Value> = events
            .iter()
            .map(|event| serde_json::to_value(event).unwrap())
            .collect();
        wire.push(serde_json::to_value(AppEvent::DropHover { active: true }).unwrap());
        wire.push(serde_json::to_value(AppEvent::DropHover { active: false }).unwrap());
        let keys = |value: &serde_json::Value| -> Vec<String> {
            let mut keys: Vec<String> = value.as_object().unwrap().keys().cloned().collect();
            keys.sort();
            keys
        };
        for message in &wire {
            let text = message.to_string();
            for forbidden in [
                "confidential",
                "7731",
                "sheer-test",
                dir_text.as_str(),
                "os error",
                "cannot find",
                "No such file",
                "\\",
                "/",
            ] {
                assert!(!text.contains(forbidden), "{forbidden:?} in {text}");
            }
            match message["type"].as_str().unwrap() {
                "dropHover" => assert_eq!(keys(message), ["active", "type"]),
                "opened" => {
                    assert_eq!(keys(message), ["document", "type"]);
                    assert_eq!(
                        keys(&message["document"]),
                        ["displayName", "flags", "id", "kind", "pageCount"]
                    );
                    assert_eq!(message["document"]["displayName"], "good-name-9090.pdf");
                }
                "openFailed" => {
                    let mut allowed = keys(message);
                    allowed.retain(|key| {
                        !["code", "key", "retryable", "type"].contains(&key.as_str())
                    });
                    assert!(allowed.is_empty(), "unexpected fields {allowed:?}");
                    for name in ["name-4242", "name-5151", "name-8855", "name-1234"] {
                        assert!(!text.contains(name), "{name} in {text}");
                    }
                }
                other => panic!("unexpected event type {other}"),
            }
        }
        assert_eq!(
            failed_codes(&events),
            ["not_a_pdf", "not_a_pdf", "io_not_found", "not_a_pdf"]
        );
    }

    #[test]
    fn closing_an_unknown_document_is_fine() {
        let state = state_without_engine();
        let id = state.registry.register(manifest()).unwrap();
        state.registry.remove(id);
        assert!(state.close_document(id).is_ok());
    }

    #[test]
    fn closing_a_document_drops_its_session_password_and_secrets() {
        let dir = TempDir::new();
        let (engine, _seen) = engine_refusing_closes(3, 0, ErrorCode::EngineTimeout);
        let state = AppState::new(engine);
        let opened = state.open_path(pdf(&dir, "a.pdf")).unwrap().unwrap();
        state.note_session_password(
            opened.id,
            Some(zeroize::Zeroizing::new("hunter2".to_owned())),
        );
        assert_eq!(
            state
                .session_password(opened.id)
                .as_deref()
                .map(String::as_str),
            Some("hunter2")
        );
        state.close_document(opened.id).unwrap();
        // The model, and the secrets slots in it, are gone and refused from now on: nothing hands the password out again.
        assert!(state.session_password(opened.id).is_none());
        assert!(state.annotations.with(opened.id, 3, |_| Ok(())).is_err());
    }
    // --- a close the engine could not take ---

    /// An engine that "loads" every document as one of `pages` pages and refuses the first `failures` closes with `error`, as a
    /// busy, stuck or full engine does; the closes after that work. Needs no PDFium.
    fn engine_refusing_closes(
        pages: u32,
        failures: usize,
        error: ErrorCode,
    ) -> (Engine, Arc<Mutex<Vec<Seen>>>) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = Arc::clone(&seen);
        let refused = Arc::new(Mutex::new(0usize));
        let engine = Engine::with_handler(move |job| match job {
            Job::Open {
                id, confirm, reply, ..
            } => {
                log.lock().unwrap().push(Seen::Open(id));
                let wanted = confirm(pages);
                let _ = reply.send(if wanted {
                    Ok(pages)
                } else {
                    Err(AppError::new(ErrorCode::EngineTimeout))
                });
            }
            Job::Close { id, reply } => {
                log.lock().unwrap().push(Seen::Close(id));
                let mut refused = refused.lock().unwrap();
                let _ = reply.send(if *refused < failures {
                    *refused += 1;
                    Err(AppError::new(error))
                } else {
                    Ok(())
                });
            }
            _ => {}
        });
        (engine, seen)
    }

    fn closes(seen: &Mutex<Vec<Seen>>) -> Vec<Seen> {
        seen.lock()
            .unwrap()
            .iter()
            .filter(|entry| matches!(entry, Seen::Close(_)))
            .cloned()
            .collect()
    }

    #[test]
    fn a_close_the_engine_does_not_take_keeps_the_entry_so_the_document_is_not_lost() {
        let dir = TempDir::new();
        for error in [
            ErrorCode::EngineUnavailable,
            ErrorCode::EngineTimeout,
            ErrorCode::EngineCrashed,
        ] {
            let (engine, seen) = engine_refusing_closes(3, 1, error);
            let state = AppState::new(engine);
            let path = pdf(&dir, "a.pdf");
            let opened = state.open_path(path).unwrap().unwrap();

            // The engine does not take the close: the caller hears why ...
            assert_eq!(
                state.close_document(opened.id).unwrap_err().code(),
                error,
                "{error:?}"
            );
            // ... the document is closed as far as the UI is concerned ...
            assert_eq!(state.registry.info(opened.id), None);
            assert_eq!(
                state.page_sizes(opened.id).unwrap_err().code(),
                ErrorCode::NotFound
            );
            assert_eq!(
                state
                    .render_page(render::RenderRequest {
                        doc_id: opened.id,
                        page_id: crate::documents::PageId::new(0),
                        bucket: 0,
                        tile: None,
                        priority: render::RenderPriority::Visible,
                        generation: 1,
                    })
                    .unwrap_err()
                    .code(),
                ErrorCode::NotFound
            );
            // ... but its entry is kept, so that the engine's copy has a name to be released by.
            assert_eq!(state.registry.closing(), [opened.id]);
            assert_eq!(state.registry.len(), 1);
            assert_eq!(
                *seen.lock().unwrap(),
                [Seen::Open(opened.id), Seen::Close(opened.id)]
            );

            // Closing it again (the UI may) is another try, and it goes through now.
            assert!(state.close_document(opened.id).is_ok());
            assert!(state.registry.is_empty());
            assert_eq!(
                closes(&seen),
                [Seen::Close(opened.id), Seen::Close(opened.id)]
            );
        }
    }

    #[test]
    fn the_next_open_or_close_tries_again_to_release_what_could_not_be_released() {
        let dir = TempDir::new();
        let (engine, seen) = engine_refusing_closes(2, 1, ErrorCode::EngineUnavailable);
        let state = AppState::new(engine);
        let first = state.open_path(pdf(&dir, "a.pdf")).unwrap().unwrap();
        assert!(state.close_document(first.id).is_err());
        assert_eq!(state.registry.closing(), [first.id]);

        // Opening the same file again is a new document with a new id: the closed one is not offered back. The open also
        // retried the release, which went through.
        let again = state.open_path(dir.path().join("a.pdf")).unwrap().unwrap();
        assert_ne!(again.id, first.id);
        assert!(state.registry.closing().is_empty());
        assert_eq!(state.registry.len(), 1);
        assert_eq!(
            closes(&seen),
            [Seen::Close(first.id), Seen::Close(first.id)]
        );

        // Another document's close does the same for an older one that is still waiting.
        let (engine, seen) = engine_refusing_closes(2, 1, ErrorCode::EngineTimeout);
        let state = AppState::new(engine);
        let a = state.open_path(pdf(&dir, "b.pdf")).unwrap().unwrap();
        let b = state.open_path(pdf(&dir, "c.pdf")).unwrap().unwrap();
        assert!(state.close_document(a.id).is_err());
        assert!(state.close_document(b.id).is_ok());
        assert!(state.registry.is_empty());
        // The older one first: it was retried before the newer one was asked for.
        assert_eq!(
            closes(&seen),
            [Seen::Close(a.id), Seen::Close(a.id), Seen::Close(b.id)]
        );
    }

    #[test]
    fn a_closing_document_still_counts_against_the_limit_until_the_engine_has_released_it() {
        let dir = TempDir::new();
        // Every close fails for a while: the engine holds what it was not asked to release.
        let healthy = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let up = Arc::clone(&healthy);
        let engine = Engine::with_handler(move |job| match job {
            Job::Open { confirm, reply, .. } => {
                let _ = confirm(1);
                let _ = reply.send(Ok(1));
            }
            Job::Close { reply, .. } => {
                let _ = reply.send(if up.load(std::sync::atomic::Ordering::SeqCst) {
                    Ok(())
                } else {
                    Err(AppError::new(ErrorCode::EngineUnavailable))
                });
            }
            _ => {}
        });
        let state = AppState::new(engine);
        let paths: Vec<PathBuf> = (0..=limits::MAX_OPEN_DOCUMENTS)
            .map(|i| pdf(&dir, &format!("{i}.pdf")))
            .collect();
        let mut ids = Vec::new();
        for path in &paths[..limits::MAX_OPEN_DOCUMENTS] {
            ids.push(state.open_path(path.clone()).unwrap().unwrap().id);
        }
        assert!(state.close_document(ids[0]).is_err());

        // Room is not made by a close that did not happen.
        let error = state.open_path(paths[limits::MAX_OPEN_DOCUMENTS].clone());
        assert_eq!(error.unwrap_err().code(), ErrorCode::LimitExceeded);
        // The engine recovers: the next open releases the old document first, and then there is room.
        healthy.store(true, std::sync::atomic::Ordering::SeqCst);
        assert!(state
            .open_path(paths[limits::MAX_OPEN_DOCUMENTS].clone())
            .unwrap()
            .is_some());
        assert!(state.registry.closing().is_empty());
        assert_eq!(state.registry.len(), limits::MAX_OPEN_DOCUMENTS);
    }

    #[test]
    fn a_close_that_fails_for_an_older_document_is_not_this_documents_error() {
        let dir = TempDir::new();
        let engine_up = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let up = Arc::clone(&engine_up);
        let engine = Engine::with_handler(move |job| match job {
            Job::Open { confirm, reply, .. } => {
                let _ = confirm(1);
                let _ = reply.send(Ok(1));
            }
            Job::Close { reply, .. } => {
                let _ = reply.send(if up.load(std::sync::atomic::Ordering::SeqCst) {
                    Ok(())
                } else {
                    Err(AppError::new(ErrorCode::EngineUnavailable))
                });
            }
            _ => {}
        });
        let state = AppState::new(engine);
        let a = state.open_path(pdf(&dir, "a.pdf")).unwrap().unwrap();
        assert!(state.close_document(a.id).is_err());
        // An id that is not open is not an error even while another document waits to be released ...
        let unknown = state.registry.register(manifest()).unwrap();
        state.registry.remove(unknown);
        assert!(state.close_document(unknown).is_ok());
        // ... and the one that waits is still there for the next try.
        assert_eq!(state.registry.closing(), [a.id]);
    }

    #[test]
    fn blocking_maps_errors_to_ui_errors_without_the_detail() {
        let error = tauri::async_runtime::block_on(blocking(|| {
            Err::<(), _>(AppError::logged(
                ErrorCode::IoNotFound,
                r"C:\Users\user\secret-plan.pdf",
            ))
        }))
        .unwrap_err();
        assert_eq!(error.code(), ErrorCode::IoNotFound);
        assert!(!serde_json::to_string(&error).unwrap().contains("secret"));
    }

    #[test]
    fn blocking_turns_a_panic_into_an_internal_error() {
        let result = tauri::async_runtime::block_on(blocking(|| -> Result<(), AppError> {
            panic!("command body panicked at C:/secret/plan.pdf")
        }));
        let error = result.unwrap_err();
        assert_eq!(error.code(), ErrorCode::Internal);
        assert!(!serde_json::to_string(&error).unwrap().contains("secret"));
    }
}
