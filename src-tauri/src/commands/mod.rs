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
//! | `open_document_dialog` | none | `DocumentInfo { id, pageCount, displayName }` or `null` if the dialog was cancelled |
//! | `render_page` | `docId: number`, `pageId: number`, `scale: number` | frame (`ArrayBuffer`, ADR-002 §6, see `engine/encode.rs`) |
//! | `close_document` | `docId: number` | nothing |
//! | `app_ready`, `get_settings`, `update_settings`, `watch_transparency` | see [`app`] | see [`app`] |
//!
//! `scale` is device pixels per PDF point (1.0 = 72 dpi), accepted range 0.1 to 8, and a frame may not exceed 4096 x
//! 4096 pixels (all bounds in `limits.rs`). A `pageId` is the page's position until M3 (identity mapping). The frontend
//! never sees file paths: the path comes from the dialog and stays in the registry.

pub mod app;

use std::path::PathBuf;
use std::sync::Arc;

use tauri::ipc::Response;
use tauri::{State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

use crate::documents::{display_name, DocumentId, DocumentInfo, PageId, Registry};
use crate::engine::Engine;
use crate::error::{AppError, ErrorCode, UiError};
use crate::limits;

/// Everything the commands share. Managed by Tauri, created in `lib.rs`. Cloning is cheap (shared handles), which is
/// how a command moves it onto the blocking pool.
#[derive(Clone)]
pub struct AppState {
    engine: Engine,
    registry: Arc<Registry>,
}

impl AppState {
    pub fn new(engine: Engine) -> Self {
        Self {
            engine,
            registry: Arc::new(Registry::new()),
        }
    }

    /// Registers and loads the PDF at `path`. The path must come from the native dialog (or a drop event later).
    ///
    /// The path is canonicalized and must be a regular file within `limits::MAX_PDF_FILE_BYTES`.
    pub fn open_path(&self, path: PathBuf) -> Result<DocumentInfo, AppError> {
        let path = std::fs::canonicalize(&path)?;
        let metadata = std::fs::metadata(&path)?;
        if !metadata.is_file() {
            return Err(AppError::logged(ErrorCode::NotAPdf, "not a regular file"));
        }
        limits::validate_file_size(metadata.len())?;

        let display_name = display_name(&path);
        let id = self.registry.register(path.clone())?;
        match self.engine.open(id, path) {
            Ok(page_count) => {
                self.registry.set_page_count(id, page_count)?;
                Ok(DocumentInfo {
                    id,
                    page_count,
                    display_name,
                })
            }
            Err(error) => {
                self.registry.remove(id);
                // A timeout does not tell whether the worker went on to load the document after the caller stopped
                // waiting. Release the id in the engine too, so no orphaned document stays behind without a registry
                // entry. Best effort: if the engine is unavailable there is nothing loaded to release, and the open
                // error is the one the caller needs to see.
                let _ = self.engine.close(id);
                Err(error)
            }
        }
    }

    /// Validates the request against the registered page count, then renders. Returns a frame.
    pub fn render_page(
        &self,
        id: DocumentId,
        page: PageId,
        scale: f32,
    ) -> Result<Vec<u8>, AppError> {
        let scale = limits::validate_scale(scale)?;
        let page_index = self.registry.page_index(id, page)?;
        self.engine.render(id, page_index, scale)
    }

    /// Closes a document. Closing an unknown id is not an error.
    pub fn close_document(&self, id: DocumentId) -> Result<(), AppError> {
        if self.registry.remove(id) {
            self.engine.close(id)?;
        }
        Ok(())
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

/// Shows the native "open" dialog and loads the chosen PDF. Returns `None` if the user cancels.
#[tauri::command]
pub async fn open_document_dialog(
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<Option<DocumentInfo>, UiError> {
    let state = state.inner().clone();
    blocking(move || {
        let picked = window
            .dialog()
            .file()
            .set_parent(&window)
            .add_filter("PDF", &["pdf"])
            .blocking_pick_file();
        let Some(picked) = picked else {
            return Ok(None);
        };
        let path = picked
            .into_path()
            .map_err(|error| AppError::logged(ErrorCode::Internal, error))?;
        state.open_path(path).map(Some)
    })
    .await
}

/// Renders one page to a frame. Returned as raw bytes, not JSON, to avoid inflating large images.
#[tauri::command]
pub async fn render_page(
    state: State<'_, AppState>,
    doc_id: DocumentId,
    page_id: PageId,
    scale: f32,
) -> Result<Response, UiError> {
    let state = state.inner().clone();
    blocking(move || state.render_page(doc_id, page_id, scale))
        .await
        .map(Response::new)
}

/// Releases a document opened with `open_document_dialog`.
#[tauri::command]
pub async fn close_document(state: State<'_, AppState>, doc_id: DocumentId) -> Result<(), UiError> {
    let state = state.inner().clone();
    blocking(move || state.close_document(doc_id)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A state whose engine has no library: enough to test everything that is decided before PDFium is involved.
    fn state_without_engine() -> AppState {
        AppState::new(Engine::start(
            PathBuf::from("no-such-dir").join("pdfium.dll"),
        ))
    }

    fn manifest() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml")
    }

    #[test]
    fn render_rejects_unknown_documents_and_bad_scales_before_the_engine() {
        let state = state_without_engine();
        // A registered but never loaded document is indistinguishable from an unknown one.
        let id = state.registry.register(manifest()).unwrap();
        let code = |result: Result<Vec<u8>, AppError>| result.unwrap_err().code();
        assert_eq!(
            code(state.render_page(id, PageId::new(0), 1.0)),
            ErrorCode::NotFound
        );
        for bad_scale in [0.0, 99.0, f32::NAN, f32::INFINITY, -1.0] {
            assert_eq!(
                code(state.render_page(id, PageId::new(0), bad_scale)),
                ErrorCode::InvalidArgument,
                "{bad_scale}"
            );
        }
    }

    #[test]
    fn render_checks_the_page_id_against_the_registry() {
        let state = state_without_engine();
        let id = state.registry.register(manifest()).unwrap();
        state.registry.set_page_count(id, 3).unwrap();
        // Pages 3 and up are out of range; this is rejected before the (unavailable) engine is asked.
        for page in [3, 4, u32::MAX] {
            assert_eq!(
                state
                    .render_page(id, PageId::new(page), 1.0)
                    .unwrap_err()
                    .code(),
                ErrorCode::InvalidArgument,
                "page {page}"
            );
        }
        // A valid request reaches the engine, which here has no library.
        assert_eq!(
            state
                .render_page(id, PageId::new(2), 1.0)
                .unwrap_err()
                .code(),
            ErrorCode::EngineUnavailable
        );
    }

    #[test]
    fn failed_opens_leave_nothing_registered() {
        let state = state_without_engine();
        assert_eq!(
            state.open_path(manifest()).unwrap_err().code(),
            ErrorCode::EngineUnavailable
        );
        assert!(state.registry.is_empty());
        let missing = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("missing.pdf");
        assert_eq!(
            state.open_path(missing).unwrap_err().code(),
            ErrorCode::IoNotFound
        );
        assert!(state.registry.is_empty());
    }

    #[test]
    fn a_failed_open_also_closes_the_document_in_the_engine() {
        use std::sync::Mutex;

        use crate::engine::Job;

        #[derive(Debug, PartialEq)]
        enum Seen {
            Open(DocumentId),
            Close(DocumentId),
        }
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = Arc::clone(&seen);
        // The engine "times out" on open; the close job is answered normally.
        let engine = Engine::with_handler(move |job| match job {
            Job::Open { id, reply, .. } => {
                log.lock().unwrap().push(Seen::Open(id));
                let _ = reply.send(Err(AppError::new(ErrorCode::EngineTimeout)));
            }
            Job::Close { id, reply } => {
                log.lock().unwrap().push(Seen::Close(id));
                let _ = reply.send(Ok(()));
            }
            _ => {}
        });
        let state = AppState::new(engine);

        assert_eq!(
            state.open_path(manifest()).unwrap_err().code(),
            ErrorCode::EngineTimeout
        );
        assert!(state.registry.is_empty());
        // `close` waits for its answer, so both jobs are logged by the time `open_path` has returned.
        let seen = seen.lock().unwrap();
        match seen.as_slice() {
            [Seen::Open(opened), Seen::Close(closed)] => assert_eq!(opened, closed),
            other => panic!("expected open then close of the same id, got {other:?}"),
        }
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
    fn closing_an_unknown_document_is_fine() {
        let state = state_without_engine();
        let id = state.registry.register(manifest()).unwrap();
        state.registry.remove(id);
        assert!(state.close_document(id).is_ok());
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
