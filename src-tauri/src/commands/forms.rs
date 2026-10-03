//! The form of a document (ARCHITECTURE §5 "Forms and signatures", ADR-041).
//!
//! | Command | Arguments | Returns |
//! |---|---|---|
//! | `get_form_fields` | `docId: number` | `FormInfo { fields, hasScripts, xfa, needAppearances }`. The first call reads the field tree from the file (its own thread, 30 s deadline, `load_untrusted`); later calls answer from the model, which holds the session's values. A document without a form answers no fields; a full XFA form answers `unsupported_feature` (`params.what: "xfa"`) |
//! | `apply_command` | `docId`, `{ type: "setFieldValue", field, value, coalesce? }` | the `ChangeSet`, with `fields: FieldState[]` (see `commands::pages`) |
//!
//! Values are model state until the file is saved (`commands::save`, `pdfwrite::forms`); PDFium is never told about them.

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::PathBuf;
use std::sync::mpsc;
use std::thread;

use tauri::State;

use super::save::read_all;
use super::{blocking, AppState};
use crate::documents::{intake, DocumentId};
use crate::error::{AppError, ErrorCode, UiError};
use crate::limits;
use crate::model::form::{FormInfo, ReadForm, Xfa};
use crate::pdfwrite::forms;

/// Reads the field tree of the file at `path` on a thread of its own: a deadline the caller can stop waiting at, and the stack the
/// save thread has.
fn read_form_file(path: PathBuf) -> Result<ReadForm, AppError> {
    let (sender, receiver) = mpsc::channel();
    let spawned = thread::Builder::new()
        .name("sheer-form".into())
        .stack_size(limits::SAVE_STACK_BYTES)
        .spawn(move || {
            let result = catch_unwind(AssertUnwindSafe(|| {
                let (bytes, _) = read_all(intake::admit(&path)?)?;
                forms::read_fields(&bytes)
            }))
            .unwrap_or_else(|_| {
                Err(AppError::logged(
                    ErrorCode::Internal,
                    "reading the form panicked",
                ))
            });
            // The caller may have given up.
            let _ = sender.send(result);
        });
    if let Err(error) = spawned {
        return Err(AppError::logged(ErrorCode::Internal, error));
    }
    receiver
        .recv_timeout(limits::FORM_READ_TIMEOUT)
        .map_err(|_| AppError::logged(ErrorCode::EngineTimeout, "reading the form took too long"))?
}

impl AppState {
    /// The form fields of document `id` with the session's values (see the module documentation). `not_found` for a document that is not
    /// open.
    pub fn get_form_fields(&self, id: DocumentId) -> Result<FormInfo, AppError> {
        let info = self.info(id).ok_or(AppError::not_found("document"))?;
        // An encrypted file is not read (lopdf would need the password, and a save into it is not supported anyway).
        if !info.flags.has_forms || info.flags.encrypted {
            return self.model(id, |_| Ok(FormInfo::empty()));
        }
        if self.model(id, |state| Ok(state.form_needs_read()))? {
            let path = self
                .registry
                .path(id)
                .ok_or(AppError::not_found("document"))?;
            let read = read_form_file(path)?;
            if read.xfa == Xfa::Full {
                return Err(AppError::unsupported("xfa"));
            }
            // Two first calls at once read twice; the model keeps the first answer (a second one would drop the values typed meanwhile).
            self.model(id, |state| {
                if state.form_needs_read() {
                    state.install_form(read);
                }
                Ok(())
            })?;
        }
        self.model(id, |state| Ok(state.form_info()))
    }
}

/// The form fields of a document.
#[tauri::command]
pub async fn get_form_fields(
    state: State<'_, AppState>,
    doc_id: DocumentId,
) -> Result<FormInfo, UiError> {
    let state = state.inner().clone();
    blocking(move || state.get_form_fields(doc_id)).await
}
