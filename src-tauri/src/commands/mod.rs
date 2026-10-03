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
//! | `open_document_dialog` | none | the open events of the chosen files (at most 32, in order): `{ type: "opened", document: { id, pageCount, displayName } }` or `{ type: "openFailed", code, key, retryable, params? }` each; empty if the dialog was cancelled |
//! | `render_page` | `req: { docId, pageId, bucket, tile?, priority, generation }` | frame (`ArrayBuffer`, ADR-002 §6, see `engine/encode.rs`), see [`render`] |
//! | `set_viewport` | `docId: number`, `hint: { generation, visible: number[], near: number[] }` | nothing; cancels queued renders of pages that left the viewport, see [`render`] |
//! | `get_page_sizes` | `docId: number` | `[width, height][]` in points, one per page, see [`render`] |
//! | `close_document` | `docId: number` | nothing |
//! | `app_ready`, `get_settings`, `update_settings`, `watch_transparency`, `subscribe_menu`, `subscribe_app` | see [`app`] | see [`app`] |
//!
//! A frame is at most 4096 x 4096 pixels (all bounds in `limits.rs`); a page that is larger at its zoom bucket is asked for
//! as 1024 px tiles. A `pageId` is the page's position until M3 (identity mapping). The frontend never sees file paths: a
//! path comes from the dialog (here), a drop, the OS or the command line (`sources`), is judged by `documents::intake` and
//! stays in the registry.

pub mod app;
pub mod render;

use std::path::PathBuf;
use std::sync::Arc;

use tauri::{State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

use crate::documents::intake::{self, Admitted};
use crate::documents::{Abandoned, Claim, DocumentId, DocumentInfo, Registry};
use crate::engine::Engine;
use crate::error::{AppError, ErrorCode, UiError};
use crate::events::AppEvent;
use crate::limits;

/// Everything the commands share. Managed by Tauri, created in `lib.rs`. Cloning is cheap (shared handles), which is
/// how a command moves it onto the blocking pool.
#[derive(Clone)]
pub struct AppState {
    engine: Engine,
    registry: Arc<Registry>,
    /// The `render_page` calls in flight, capped per document and in all (see [`render::RenderGate`]).
    renders: Arc<render::RenderGate>,
}

impl AppState {
    pub fn new(engine: Engine) -> Self {
        Self {
            engine,
            registry: Arc::new(Registry::new()),
            renders: Arc::new(render::RenderGate::default()),
        }
    }

    /// Opens the PDF at `path`, which must come from the Rust side (dialog, drop, OS, command line; SECURITY I3).
    ///
    /// Intake judges the file on the handle it opens (`documents::intake::admit`), the registry dedupes by the canonical path
    /// (a file that is open already answers with its existing document, and a file that another request is still loading
    /// answers `None`: that request reports it), and the engine loads the same handle. Errors leave nothing registered.
    pub fn open_path(&self, path: PathBuf) -> Result<Option<DocumentInfo>, AppError> {
        // Documents that were closed but could not be released then count against the limit: try again before looking at it.
        self.release_closing();
        let Admitted { path, file } = intake::admit(&path)?;
        let id = match self.registry.claim(path)? {
            Claim::New(id) => id,
            Claim::Existing(id) => return Ok(self.registry.info(id)),
        };
        // The engine asks this once the document is loaded. It records the page count in the same step, so the entry either
        // gets it before the caller gives up (below) or is already gone and the engine drops the document.
        let registry = Arc::clone(&self.registry);
        let confirm = move |page_count| registry.set_page_count(id, page_count).is_ok();
        match self.engine.open(id, file, confirm) {
            Ok(page_count) => {
                // Already recorded by `confirm`; recorded again for an engine that does not ask.
                self.registry.set_page_count(id, page_count)?;
            }
            Err(error) => {
                return match self.registry.abandon(id) {
                    // The deadline passed, but the engine had finished loading and had recorded the document just before: it
                    // is open, and is told as such.
                    Abandoned::Loaded(_) => Ok(self.registry.info(id)),
                    // Not loaded: the entry is gone, so a load that is still running finds nobody and releases the document.
                    Abandoned::Removed | Abandoned::Gone => Err(error),
                };
            }
        }
        Ok(self.registry.info(id))
    }

    /// Opens every path, one after the other, and hands `report` how each went as soon as it is known, in order: `opened`
    /// (also for a file that was open already) or `openFailed`, never both for one file and never stopping at a failure. At
    /// most `MAX_OPEN_BATCH` paths are taken; the rest are one more `openFailed` with `limit_exceeded` (`documents`), not one
    /// per file.
    pub fn open_each(&self, paths: Vec<PathBuf>, mut report: impl FnMut(AppEvent)) {
        let too_many = paths.len() > limits::MAX_OPEN_BATCH;
        for path in paths.into_iter().take(limits::MAX_OPEN_BATCH) {
            match self.open_path(path) {
                Ok(Some(document)) => report(AppEvent::opened(document)),
                // Another request is loading this very file and reports it.
                Ok(None) => {}
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

/// Releases a document that was opened (dialog, drop, file association).
#[tauri::command]
pub async fn close_document(state: State<'_, AppState>, doc_id: DocumentId) -> Result<(), UiError> {
    let state = state.inner().clone();
    blocking(move || state.close_document(doc_id)).await
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
                        ["displayName", "id", "pageCount"]
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
