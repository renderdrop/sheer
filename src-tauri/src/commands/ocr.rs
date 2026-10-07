//! OCR commands (ADR-134, ARCHITECTURE section 15). The job itself is `ocr::service`; these validate, refuse and answer.
//!
//! | Command | Arguments | Returns |
//! |---|---|---|
//! | `ocr_capabilities` | none | `{ backend: "windows" \| "vision" \| "none", languages: { tag, available }[], maxImageDimension }` |
//! | `ocr_classify_pages` | `docId`, `pages?: PageId[]` (default all) | `{ page: PageId, class }[]`, class `scan`, `hasTextLayer`, `sheerLayer`, `text` or `empty` |
//! | `ocr_start` | `docId`, `pages: PageSelection`, `lang`, `redo` | `{ job, langUsed, notice: "languageFallback" \| null }`; the job pushes `ocrProgress` and `ocrFinished` (`events.rs`) |
//! | `ocr_cancel` | `job` | nothing; pages that are done stay applied; an unknown or finished job is not an error |
//! | `ocr_open_language_settings` | none | nothing; opens the fixed URI `ms-settings:regionlanguage` (Windows), `unsupported_feature` elsewhere |
//!
//! `ocr_start` is refused like a text edit: `read_only` (`signed`, `permission`), `unsupported_feature` (`ocrUnavailable`) when the
//! computer has no OCR language, `invalid_argument` (`lang`, `pageSelection`), `limit_exceeded` (`ocrJobs`) while a job runs. Nothing
//! reaches the webview but ids, counts and class names; the recognized text goes into the model (`DocCommand::ApplyOcr`), never over IPC.

use std::sync::Arc;

use serde::Serialize;
use tauri::State;

use super::{blocking, AppState};
use crate::documents::{DocumentId, PageId};
use crate::error::{AppError, ErrorCode, UiError};
use crate::events::{AppEvent, AppEvents};
use crate::limits;
use crate::model::ranges::{parse_ranges, PageSelection};
use crate::ocr::backend::{self, Capabilities};
use crate::ocr::service::{self, JobSpec};
use crate::ocr::{limits as ocr_limits, OcrJobId, PageOcrClass};
use crate::pdfwrite::pagetree::on_big_stack;

/// One page and its class.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct PageClass {
    pub page: PageId,
    pub class: PageOcrClass,
}

/// The answer of `ocr_start`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrStarted {
    pub job: OcrJobId,
    pub lang_used: String,
    /// `"languageFallback"` when `lang` was not available and another language is used.
    pub notice: Option<&'static str>,
}

/// The pages the selection names, as ids in document order, each once.
fn select_pages(all: &[PageId], selection: &PageSelection) -> Result<Vec<PageId>, AppError> {
    let invalid = || AppError::invalid("pageSelection");
    let too_many = || AppError::limit("pages", limits::MAX_EXPORT_PAGES as u64);
    let mut positions: Vec<usize> = match selection {
        PageSelection::All => (0..all.len()).collect(),
        PageSelection::Current { page_id } => {
            vec![all
                .iter()
                .position(|id| id == page_id)
                .ok_or_else(invalid)?]
        }
        PageSelection::Pages { pages } => {
            if pages.len() > limits::MAX_EXPORT_PAGES {
                return Err(too_many());
            }
            pages
                .iter()
                .map(|id| all.iter().position(|known| known == id).ok_or_else(invalid))
                .collect::<Result<_, _>>()?
        }
        PageSelection::Ranges { text } => {
            let count = u32::try_from(all.len()).map_err(|_| invalid())?;
            let ranges = parse_ranges(text, count).map_err(|error| {
                if error.code() == ErrorCode::InvalidArgument {
                    invalid()
                } else {
                    error
                }
            })?;
            ranges
                .into_iter()
                .flat_map(|(start, end)| (start - 1..end).map(|p| p as usize))
                .collect()
        }
    };
    positions.sort_unstable();
    positions.dedup();
    if positions.is_empty() {
        return Err(invalid());
    }
    if positions.len() > limits::MAX_EXPORT_PAGES {
        return Err(too_many());
    }
    Ok(positions.into_iter().map(|p| all[p]).collect())
}

/// The language a job uses and the notice for the UI, or `unsupported_feature` `ocrUnavailable`.
fn choose_language(
    caps: &Capabilities,
    requested: &str,
) -> Result<(&'static str, Option<&'static str>), AppError> {
    if !ocr_limits::LANGUAGES.contains(&requested) {
        return Err(AppError::invalid("lang"));
    }
    service::plan_language(caps, requested)
        .map(|(tag, fallback)| (tag, fallback.then_some("languageFallback")))
        .ok_or(AppError::unsupported("ocrUnavailable"))
}

impl AppState {
    fn page_ids(&self, doc: DocumentId) -> Result<Vec<PageId>, AppError> {
        self.model(doc, |state| {
            Ok(state.pages().iter().map(|slot| slot.id).collect())
        })
    }

    /// The class of each page asked for (all pages without `pages`), by the document as the user sees it now.
    pub fn ocr_classify(
        &self,
        doc: DocumentId,
        pages: Option<Vec<PageId>>,
    ) -> Result<Vec<PageClass>, AppError> {
        let (facts, layered) = self.model(doc, |state| {
            let layered = state.ocr_layers.keys().copied().collect();
            let facts: Vec<(PageId, u32)> = state
                .pages()
                .iter()
                .zip(0u32..)
                .map(|(slot, position)| (slot.id, position))
                .collect();
            Ok((facts, layered))
        })?;
        let facts = match pages {
            None => facts,
            Some(wanted) => {
                if wanted.len() > limits::MAX_PAGES as usize {
                    return Err(AppError::limit("pages", u64::from(limits::MAX_PAGES)));
                }
                wanted
                    .iter()
                    .map(|id| {
                        facts
                            .iter()
                            .find(|(known, _)| known == id)
                            .copied()
                            .ok_or(AppError::invalid("page"))
                    })
                    .collect::<Result<_, _>>()?
            }
        };
        let bytes = self.snapshot_bytes(doc)?;
        let classes = on_big_stack(move || service::classify(&bytes, &facts, &layered))?;
        Ok(classes
            .into_iter()
            .map(|(page, class)| PageClass { page, class })
            .collect())
    }

    /// Validates and starts an OCR job on a thread of its own; the answer is immediate.
    pub fn ocr_start(
        &self,
        events: Arc<AppEvents>,
        doc: DocumentId,
        selection: &PageSelection,
        lang: &str,
        redo: bool,
    ) -> Result<OcrStarted, AppError> {
        // Signed or permission-restricted documents refuse like a text edit does.
        self.check_may_edit(doc)?;
        let pages = select_pages(&self.page_ids(doc)?, selection)?;
        let (lang_used, notice) = choose_language(&backend::capabilities(), lang)?;
        let handle = service::begin()?;
        let started = OcrStarted {
            job: handle.id,
            lang_used: lang_used.to_owned(),
            notice,
        };
        let spec = JobSpec {
            doc,
            job: handle.id,
            pages,
            lang: lang_used.to_owned(),
            redo,
        };
        let app = self.clone();
        std::thread::Builder::new()
            .name("sheer-ocr".into())
            .stack_size(limits::SAVE_STACK_BYTES)
            .spawn(move || {
                // The handle frees the job slot when it drops, also on a panic.
                let handle = handle;
                let ran = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    service::run_job(&app, &events, &spec, &handle.cancel);
                }));
                if ran.is_err() {
                    events.publish(AppEvent::OcrFinished {
                        doc: spec.doc,
                        job: spec.job,
                        applied: 0,
                        skipped: 0,
                        failed: u32::try_from(spec.pages.len()).unwrap_or(u32::MAX),
                        refused: None,
                    });
                }
            })
            .map_err(|error| AppError::logged(ErrorCode::Internal, error))?;
        Ok(started)
    }
}

/// What the recognizer can do on this computer.
#[tauri::command]
pub async fn ocr_capabilities() -> Result<Capabilities, UiError> {
    blocking(|| Ok(backend::capabilities())).await
}

/// The OCR class of the pages of a document.
#[tauri::command]
pub async fn ocr_classify_pages(
    state: State<'_, AppState>,
    doc_id: DocumentId,
    pages: Option<Vec<PageId>>,
) -> Result<Vec<PageClass>, UiError> {
    let state = state.inner().clone();
    blocking(move || state.ocr_classify(doc_id, pages)).await
}

/// Starts text recognition on pages of a document.
#[tauri::command]
pub async fn ocr_start(
    state: State<'_, AppState>,
    events: State<'_, Arc<AppEvents>>,
    doc_id: DocumentId,
    pages: PageSelection,
    lang: String,
    redo: bool,
) -> Result<OcrStarted, UiError> {
    let state = state.inner().clone();
    let events = Arc::clone(events.inner());
    blocking(move || state.ocr_start(events, doc_id, &pages, &lang, redo)).await
}

/// Asks a running OCR job to stop after its current page.
#[tauri::command]
pub async fn ocr_cancel(job: OcrJobId) -> Result<(), UiError> {
    service::cancel(job);
    Ok(())
}

/// The one URI `ocr_open_language_settings` opens; the frontend gives no argument.
const LANGUAGE_SETTINGS_URI: &str = "ms-settings:regionlanguage";

/// Opens the OS language settings (Windows), so the user can install an OCR language pack. Sheer installs nothing itself.
#[tauri::command]
pub async fn ocr_open_language_settings() -> Result<(), UiError> {
    blocking(|| {
        if !cfg!(windows) {
            return Err(AppError::unsupported("languageSettings"));
        }
        // A fixed program with a fixed argument; the frontend gives nothing. (The opener plugin is reserved for links, security baseline.)
        let (program, argument) = language_settings_command(std::env::var_os("SystemRoot"));
        std::process::Command::new(program)
            .arg(argument)
            .spawn()
            .map(drop)
            .map_err(|error| AppError::logged(ErrorCode::Internal, error))
    })
    .await
}

/// `%SystemRoot%\explorer.exe` (absolute, so a PATH entry cannot hijack it); `C:\Windows` when the variable is unset or relative.
fn explorer_path(system_root: Option<std::ffi::OsString>) -> std::path::PathBuf {
    let root = system_root
        .map(std::path::PathBuf::from)
        .filter(|root| root.is_absolute())
        .unwrap_or_else(|| std::path::PathBuf::from(r"C:\Windows"));
    root.join("explorer.exe")
}

/// The program and the one argument of `ocr_open_language_settings`, from the value of `%SystemRoot%`. Pure; nothing comes from the UI.
fn language_settings_command(
    system_root: Option<std::ffi::OsString>,
) -> (std::path::PathBuf, &'static str) {
    (explorer_path(system_root), LANGUAGE_SETTINGS_URI)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ocr::backend::{BackendKind, OcrLanguage};

    #[test]
    fn language_settings_use_an_absolute_explorer_and_a_fixed_uri() {
        let (program, argument) = language_settings_command(None);
        assert!(program.ends_with("explorer.exe"));
        assert_eq!(argument, "ms-settings:regionlanguage");
        if cfg!(windows) {
            assert!(program.is_absolute());
            let set = |root: &str| explorer_path(Some(root.into()));
            assert_eq!(
                set(r"D:\Win"),
                std::path::PathBuf::from(r"D:\Win\explorer.exe")
            );
            // A relative or empty %SystemRoot% (a hijack through the environment) falls back to C:\Windows.
            let fallback = std::path::PathBuf::from(r"C:\Windows\explorer.exe");
            assert_eq!(set(r"evil"), fallback);
            assert_eq!(set(""), fallback);
            assert_eq!(explorer_path(None), fallback);
        }
    }

    #[test]
    fn a_signed_or_restricted_document_refuses_ocr_before_anything_runs() {
        use crate::commands::testutil::state_with_pages;
        use crate::documents::DocFlags;
        use crate::model::protection::{Permission, PermissionSet};
        use crate::pdfsig::types::SignatureLock;
        let refuse = |state: &AppState, doc| {
            state
                .ocr_start(
                    Arc::new(AppEvents::default()),
                    doc,
                    &PageSelection::All,
                    "en-US",
                    false,
                )
                .unwrap_err()
        };
        let (state, doc) = state_with_pages(2, |_| {});
        state
            .registry
            .set_signature_lock(doc, SignatureLock::Locked);
        let error = refuse(&state, doc);
        assert_eq!(error.code(), ErrorCode::ReadOnly);
        let (state, doc) = state_with_pages(2, |_| {});
        let flags = DocFlags {
            permissions: Some(PermissionSet::from_list(&[Permission::Print])),
            ..DocFlags::default()
        };
        state.registry.set_flags(doc, flags).unwrap();
        assert_eq!(refuse(&state, doc).code(), ErrorCode::ReadOnly);
        // Nothing was registered as a running job by the refusals.
        assert!(service::begin().is_ok());
    }

    fn ids(n: u32) -> Vec<PageId> {
        (0..n).map(PageId::new).collect()
    }

    fn caps(de: bool, en: bool) -> Capabilities {
        Capabilities {
            backend: BackendKind::Windows,
            languages: vec![
                OcrLanguage {
                    tag: "de-DE",
                    available: de,
                },
                OcrLanguage {
                    tag: "en-US",
                    available: en,
                },
            ],
            max_image_dimension: Some(8000),
        }
    }

    #[test]
    fn selections_resolve_to_page_ids_in_order_without_repeats() {
        let all = ids(5);
        let pick = |s: PageSelection| select_pages(&all, &s).unwrap();
        assert_eq!(pick(PageSelection::All), all);
        let current = PageSelection::Current {
            page_id: PageId::new(3),
        };
        assert_eq!(pick(current), vec![PageId::new(3)]);
        let pages = PageSelection::Pages {
            pages: vec![PageId::new(4), PageId::new(1), PageId::new(4)],
        };
        assert_eq!(pick(pages), vec![PageId::new(1), PageId::new(4)]);
        let ranges = PageSelection::Ranges {
            text: "1-2, 5".into(),
        };
        assert_eq!(
            pick(ranges),
            vec![PageId::new(0), PageId::new(1), PageId::new(4)]
        );
        let bad = |s: PageSelection| select_pages(&all, &s).unwrap_err().code();
        let unknown = PageSelection::Current {
            page_id: PageId::new(9),
        };
        assert_eq!(bad(unknown), ErrorCode::InvalidArgument);
        assert_eq!(
            bad(PageSelection::Pages { pages: vec![] }),
            ErrorCode::InvalidArgument
        );
        assert_eq!(
            bad(PageSelection::Ranges { text: "9".into() }),
            ErrorCode::InvalidArgument
        );
    }

    #[test]
    fn the_language_rule_has_a_fallback_notice_and_a_refusal() {
        let both = caps(true, true);
        assert_eq!(choose_language(&both, "de-DE").unwrap(), ("de-DE", None));
        assert_eq!(
            choose_language(&caps(false, true), "de-DE").unwrap(),
            ("en-US", Some("languageFallback"))
        );
        let none = choose_language(&caps(false, false), "de-DE").unwrap_err();
        assert_eq!(none.code(), ErrorCode::UnsupportedFeature);
        assert_eq!(
            choose_language(&both, "../x").unwrap_err().code(),
            ErrorCode::InvalidArgument
        );
    }

    #[test]
    fn the_answers_have_the_wire_shape() {
        let started = OcrStarted {
            job: OcrJobId::new(3),
            lang_used: "en-US".into(),
            notice: Some("languageFallback"),
        };
        assert_eq!(
            serde_json::to_value(started).unwrap(),
            serde_json::json!({"job": 3, "langUsed": "en-US", "notice": "languageFallback"})
        );
        let page = PageClass {
            page: PageId::new(2),
            class: PageOcrClass::HasTextLayer,
        };
        assert_eq!(
            serde_json::to_value(page).unwrap(),
            serde_json::json!({"page": 2, "class": "hasTextLayer"})
        );
    }
}
