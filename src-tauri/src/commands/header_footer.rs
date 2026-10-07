//! Headers and footers (ADR-139 Addendum A2, ARCHITECTURE §16.2, §16.5).
//!
//! | Command | Arguments | Returns |
//! |---|---|---|
//! | `get_header_footer` | `docId: number` | `HeaderFooterInfo { spec, defaults, pending, fileLayers, refusal }`: `spec` is the current spec (the staged one included), `refusal` is `signed` or `permission` when a change would be refused. The first call reads the catalog key and counts the page keys of the file (blocking pool, `load_untrusted`, 30 s); a damaged or oversized spec is `null` with `fileLayers` still counted, so a removal always works |
//! | `resolve_header_footer` | `docId: number`, `spec: HfSpec \| null` (`null` = the current one), `pages: number[]` (1 to 64) | `{ pageId, runs, underFileLayer }[]` in the order asked: the runs the save would write on each page (the preview and the overlay use this very function), and whether the engine's copy of the page still shows a layer of the file (the pending change replaces it at save; PDFium offers no way to hide it before, so the overlay skips such pages). `invalid_argument` for a spec that does not fit (`headerFooter` with `params.char`, `ranges`, `fontSize`, `margin`), `limit_exceeded` `pages` |
//!
//! The change itself is `apply_command` with `DocCommand::SetHeaderFooter { spec }` (one undo step, refused on signed documents and without
//! the `edit` permission like every command). The write at save is `pdfwrite::header_footer`.

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::{mpsc, Mutex, PoisonError};
use std::thread;

use serde::Serialize;
use tauri::State;

use super::save::read_all;
use super::{blocking, AppState};
use crate::documents::{display_name, intake, DocumentId, PageId};
use crate::error::{AppError, ErrorCode, UiError};
use crate::limits;
use crate::model::header_footer::{self, HfSpec, PlacedRun};
use crate::model::page::PageSource;
use crate::model::protection::Permission;
use crate::pdfsig::types::SignatureLock;
use crate::pdfwrite::page_layer::PageGeom;
use crate::pdfwrite::{crypt, header_footer as writer};

/// Most pages one `resolve_header_footer` answers.
const RESOLVE_PAGES_MAX: usize = 64;

/// What the dialog needs to know.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeaderFooterInfo {
    pub spec: Option<HfSpec>,
    pub defaults: HfSpec,
    pub pending: bool,
    pub file_layers: u32,
    pub refusal: Option<&'static str>,
}

/// The runs on one page.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedPage {
    pub page_id: PageId,
    pub runs: Vec<PlacedRun>,
    pub under_file_layer: bool,
}

/// The documents whose file is being read by a thread of [`read_with_deadline`].
static READING: Mutex<Vec<DocumentId>> = Mutex::new(Vec::new());

struct Reading(DocumentId);

impl Reading {
    fn begin(id: DocumentId) -> Option<Self> {
        let mut reading = READING.lock().unwrap_or_else(PoisonError::into_inner);
        if reading.contains(&id) {
            return None;
        }
        reading.push(id);
        Some(Self(id))
    }
}

impl Drop for Reading {
    fn drop(&mut self) {
        READING
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .retain(|other| *other != self.0);
    }
}

/// Runs `work` on a thread of its own with the save stack and stops waiting after the metadata read limit (`engine_timeout`); a panic
/// is `internal`. One such thread per document at a time.
fn read_with_deadline<T: Send + 'static>(
    id: DocumentId,
    work: impl FnOnce() -> Result<T, AppError> + Send + 'static,
) -> Result<T, AppError> {
    let Some(reading) = Reading::begin(id) else {
        return Err(AppError::logged(
            ErrorCode::EngineTimeout,
            "the headers of the document are still being read",
        ));
    };
    let (sender, receiver) = mpsc::channel();
    thread::Builder::new()
        .name("sheer-header-footer".into())
        .stack_size(limits::SAVE_STACK_BYTES)
        .spawn(move || {
            let _reading = reading;
            let result = catch_unwind(AssertUnwindSafe(work)).unwrap_or_else(|_| {
                Err(AppError::logged(
                    ErrorCode::Internal,
                    "reading the headers panicked",
                ))
            });
            let _ = sender.send(result);
        })
        .map_err(|e| AppError::logged(ErrorCode::Internal, e))?;
    receiver
        .recv_timeout(limits::METADATA_READ_TIMEOUT)
        .map_err(|_| {
            AppError::logged(
                ErrorCode::EngineTimeout,
                "reading the headers took too long",
            )
        })?
}

/// The display name of the file without `.pdf`, for `{file}`.
pub(super) fn file_stem(name: &str) -> String {
    let lower = name.to_ascii_lowercase();
    match lower.strip_suffix(".pdf") {
        Some(_) => name[..name.len() - 4].to_owned(),
        None => name.to_owned(),
    }
}

impl AppState {
    /// The name `{file}` takes for document `id`.
    pub(super) fn header_file_name(&self, id: DocumentId) -> String {
        self.registry
            .path(id)
            .map(|path| file_stem(&display_name(&path)))
            .unwrap_or_default()
    }

    /// See the module documentation.
    pub fn get_header_footer(&self, id: DocumentId) -> Result<HeaderFooterInfo, AppError> {
        let info = self.info(id).ok_or(AppError::not_found("document"))?;
        if !self.model(id, |state| Ok(state.header_footer.read))? {
            let session = self.session_password(id);
            let path = self
                .registry
                .path(id)
                .ok_or(AppError::not_found("document"))?;
            let found = read_with_deadline(id, move || {
                let (bytes, _) = read_all(intake::admit(&path)?)?;
                let (doc, _) = crypt::load_decrypted(&bytes, session.as_ref().map(|s| s.as_str()))?;
                drop(bytes);
                Ok(writer::read(&doc))
            })?;
            self.model(id, |state| {
                // Another call may have read it meanwhile.
                if !state.header_footer.read {
                    let hf = &mut state.header_footer;
                    hf.read = true;
                    hf.file = found.spec;
                    hf.file_layers = found.layers;
                    hf.layer_pages = found.layer_pages;
                }
                Ok(())
            })?;
        }
        let refusal = match (&info.signature_lock, info.flags.permissions) {
            (SignatureLock::None, Some(allowed)) if !allowed.contains(Permission::Edit) => {
                Some("permission")
            }
            (SignatureLock::None, _) => None,
            _ => Some("signed"),
        };
        self.model(id, |state| {
            let hf = &state.header_footer;
            Ok(HeaderFooterInfo {
                spec: hf.current().cloned(),
                defaults: HfSpec::default(),
                pending: hf.is_pending(),
                file_layers: hf.file_layers,
                refusal,
            })
        })
    }

    /// See the module documentation.
    pub fn resolve_header_footer(
        &self,
        id: DocumentId,
        spec: Option<HfSpec>,
        pages: &[PageId],
    ) -> Result<Vec<ResolvedPage>, AppError> {
        if pages.is_empty() {
            return Err(AppError::invalid("pages"));
        }
        if pages.len() > RESOLVE_PAGES_MAX {
            return Err(AppError::limit("pages", RESOLVE_PAGES_MAX as u64));
        }
        let file = self.header_file_name(id);
        self.model(id, |state| {
            if let Some(spec) = &spec {
                spec.check(Some(state.page_count()))?;
            }
            let hf = &state.header_footer;
            let spec = spec.as_ref().or_else(|| hf.current());
            let total = state.page_count();
            pages
                .iter()
                .map(|page| {
                    let slot = state.slot(*page).ok_or(AppError::not_found("page"))?;
                    let position = state.position(*page).ok_or(AppError::not_found("page"))?;
                    let geom = PageGeom {
                        crop: slot.shown_box(),
                        rotate: slot.rotation,
                    };
                    let runs = spec.map_or_else(Vec::new, |spec| {
                        header_footer::resolve(spec, geom, position, total, &file)
                    });
                    let under_file_layer = matches!(slot.source, PageSource::File { index }
                        if hf.layer_pages.contains(&index));
                    Ok(ResolvedPage {
                        page_id: *page,
                        runs,
                        under_file_layer,
                    })
                })
                .collect()
        })
    }
}

/// The current headers and footers of a document, and whether a change would be refused.
#[tauri::command]
pub async fn get_header_footer(
    state: State<'_, AppState>,
    doc_id: DocumentId,
) -> Result<HeaderFooterInfo, UiError> {
    let state = state.inner().clone();
    blocking(move || state.get_header_footer(doc_id)).await
}

/// The runs a header/footer spec puts on pages (the preview and the overlay).
#[tauri::command]
pub async fn resolve_header_footer(
    state: State<'_, AppState>,
    doc_id: DocumentId,
    spec: Option<HfSpec>,
    pages: Vec<PageId>,
) -> Result<Vec<ResolvedPage>, UiError> {
    let state = state.inner().clone();
    blocking(move || state.resolve_header_footer(doc_id, spec, &pages)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_file_name_loses_its_pdf_extension_only() {
        assert_eq!(file_stem("Bericht.pdf"), "Bericht");
        assert_eq!(file_stem("Bericht.PDF"), "Bericht");
        assert_eq!(file_stem("a.pdf.txt"), "a.pdf.txt");
        assert_eq!(file_stem("Bericht"), "Bericht");
    }

    #[test]
    fn the_info_crosses_the_wire_in_camel_case() {
        let info = HeaderFooterInfo {
            spec: None,
            defaults: HfSpec::default(),
            pending: false,
            file_layers: 2,
            refusal: Some("signed"),
        };
        let json = serde_json::to_value(&info).unwrap();
        assert_eq!(json["fileLayers"], 2);
        assert_eq!(json["refusal"], "signed");
        assert_eq!(json["defaults"]["slots"]["footerRight"], "{page}");
    }
}
