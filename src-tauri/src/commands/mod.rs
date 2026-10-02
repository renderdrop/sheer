//! IPC commands. Thin wrappers over [`AppState`], which holds the logic and is testable without Tauri.
//!
//! Signatures (frontend names are camelCase; errors are `{ code, message }`, see `error.rs`):
//!
//! | Command | Arguments | Returns |
//! |---|---|---|
//! | `open_document_dialog` | none | `DocumentInfo { id, pageCount }` or `null` if the dialog was cancelled |
//! | `render_page` | `docId: number`, `pageIndex: number`, `scale: number` | PNG bytes (`ArrayBuffer`) |
//! | `close_document` | `docId: number` | nothing |
//!
//! `scale` is device pixels per PDF point (1.0 = 72 dpi), accepted range 0.1 to 8, and a page may not exceed
//! 40 megapixels. The frontend never sees file paths: the path comes from the dialog and stays in the registry.

use std::path::PathBuf;

use tauri::ipc::Response;
use tauri::{State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

use crate::documents::{DocumentId, DocumentInfo, Registry};
use crate::engine::{limits, Engine};
use crate::error::{AppError, ErrorCode};

/// Everything the commands share. Managed by Tauri, created in `lib.rs`.
pub struct AppState {
    engine: Engine,
    registry: Registry,
}

impl AppState {
    pub fn new(engine: Engine) -> Self {
        Self {
            engine,
            registry: Registry::new(),
        }
    }

    /// Registers and loads the PDF at `path`. The path must come from the native dialog (or a drop event later).
    pub fn open_path(&self, path: PathBuf) -> Result<DocumentInfo, AppError> {
        let path = std::fs::canonicalize(&path)
            .map_err(|error| AppError::logged(ErrorCode::FileUnreadable, error))?;
        let id = self.registry.register(path.clone())?;
        match self.engine.open(id, path) {
            Ok(page_count) => {
                self.registry.set_page_count(id, page_count)?;
                Ok(DocumentInfo { id, page_count })
            }
            Err(error) => {
                self.registry.remove(id);
                Err(error)
            }
        }
    }

    /// Validates the request against the registered page count, then renders.
    pub fn render_page(
        &self,
        id: DocumentId,
        page_index: u32,
        scale: f32,
    ) -> Result<Vec<u8>, AppError> {
        let scale = limits::validate_scale(scale)?;
        let page_count = self.registry.page_count(id)?;
        let page_index = limits::validate_page_index(page_index, page_count)?;
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

/// Shows the native "open" dialog and loads the chosen PDF. Returns `None` if the user cancels.
#[tauri::command(async)]
pub fn open_document_dialog(
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<Option<DocumentInfo>, AppError> {
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
        .map_err(|error| AppError::logged(ErrorCode::FileUnreadable, error))?;
    state.open_path(path).map(Some)
}

/// Renders one page to PNG. Returned as raw bytes, not JSON, to avoid inflating large images.
#[tauri::command(async)]
pub fn render_page(
    state: State<'_, AppState>,
    doc_id: DocumentId,
    page_index: u32,
    scale: f32,
) -> Result<Response, AppError> {
    state
        .render_page(doc_id, page_index, scale)
        .map(Response::new)
}

/// Releases a document opened with `open_document_dialog`.
#[tauri::command(async)]
pub fn close_document(state: State<'_, AppState>, doc_id: DocumentId) -> Result<(), AppError> {
    state.close_document(doc_id)
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

    #[test]
    fn render_rejects_unknown_documents_and_bad_scales_before_the_engine() {
        let state = state_without_engine();
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml");
        // A registered but never loaded document is indistinguishable from an unknown one.
        let id = state.registry.register(manifest).unwrap();
        let code = |result: Result<Vec<u8>, AppError>| result.unwrap_err().code();
        assert_eq!(
            code(state.render_page(id, 0, 1.0)),
            ErrorCode::UnknownDocument
        );
        assert_eq!(
            code(state.render_page(id, 0, 0.0)),
            ErrorCode::ScaleOutOfRange
        );
        assert_eq!(
            code(state.render_page(id, 0, 99.0)),
            ErrorCode::ScaleOutOfRange
        );
    }

    #[test]
    fn render_checks_the_page_range_against_the_registry() {
        let state = state_without_engine();
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml");
        let id = state.registry.register(manifest).unwrap();
        state.registry.set_page_count(id, 3).unwrap();
        // Page 3 of 3 is out of range; this is rejected before the (unavailable) engine is asked.
        assert_eq!(
            state.render_page(id, 3, 1.0).unwrap_err().code(),
            ErrorCode::PageOutOfRange
        );
        // A valid request reaches the engine, which here has no library.
        assert_eq!(
            state.render_page(id, 2, 1.0).unwrap_err().code(),
            ErrorCode::EngineUnavailable
        );
    }

    #[test]
    fn failed_opens_leave_nothing_registered() {
        let state = state_without_engine();
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml");
        assert_eq!(
            state.open_path(manifest).unwrap_err().code(),
            ErrorCode::EngineUnavailable
        );
        assert!(state.registry.is_empty());
        let missing = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("missing.pdf");
        assert_eq!(
            state.open_path(missing).unwrap_err().code(),
            ErrorCode::FileUnreadable
        );
        assert!(state.registry.is_empty());
    }

    #[test]
    fn closing_an_unknown_document_is_fine() {
        let state = state_without_engine();
        let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml");
        let id = state.registry.register(manifest).unwrap();
        state.registry.remove(id);
        assert!(state.close_document(id).is_ok());
    }
}
