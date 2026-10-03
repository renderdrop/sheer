//! The pages of a document (ARCHITECTURE §5 "Pages", ADR-036).
//!
//! | Command | Arguments | Returns |
//! |---|---|---|
//! | `get_pages` | `docId: number` | `PageSlotInfo[]` in the document's current order: `{ id, width, height, rotation, rev, label, origin }`; size in points before the rotation |
//! | `apply_command` | `docId: number`, `command: DocCommand` | the `ChangeSet` of an annotation or page command (`rotatePages`, `deletePages`, `movePages`, `insertBlankPage`, `insertPages`); the whole command happened or nothing did. `ChangeSet.pages` is the full list when it changed |
//! | `pick_pdf_sources` | `multiple: boolean` | `SourceResult[]` of the PDFs chosen in a native dialog (`ready { sourceId, displayName, pageCount }` or `failed { code, key, .. }`); empty if the dialog was cancelled |
//! | `release_source` | `sourceId: number` | nothing; an unknown id is nothing |
//!
//! The model decides the order and the members of the page list (`model::page_ops`); the engine's copy of the document only grows. An
//! insert therefore asks the engine for the new pages first (`Control` priority) and hands the model the engine indices and sizes it got.
//! After every change of the list the registry is told which engine page each id is, so the other commands (render, text, links, search)
//! keep translating an id with one lookup.

use std::path::PathBuf;
use std::sync::Arc;

use serde::Serialize;
use tauri::{State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

use super::annotations::Revert;
use super::{blocking, AppState};
use crate::documents::intake;
use crate::documents::sources::SourceBytes;
use crate::documents::DocumentId;
use crate::error::{AppError, ErrorCode, UiError};
use crate::limits;
use crate::model::command::{DocCommand, LABEL_INSERT_BLANK, LABEL_INSERT_PAGES};
use crate::model::doc_state::ChangeSet;
use crate::model::page::{NewPage, PageSlotInfo, PageSource, SourceId};
use crate::model::protection::Permission;
use crate::pdfwrite::pagetree;

/// One PDF the user chose to take pages from.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SourceResult {
    Ready {
        source_id: SourceId,
        display_name: String,
        page_count: u32,
    },
    Failed {
        #[serde(flatten)]
        error: UiError,
    },
}

/// Reads the whole file behind an admitted handle, at most `MAX_SOURCE_BYTES` of it.
fn read_source(path: &std::path::Path) -> Result<(Vec<u8>, String), AppError> {
    use std::io::Read;
    let admitted = intake::admit(path)?;
    let name = crate::documents::display_name(&admitted.path);
    let mut bytes = Vec::new();
    admitted
        .file
        .take(limits::MAX_SOURCE_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limits::MAX_SOURCE_BYTES {
        return Err(AppError::limit("sourceBytes", limits::MAX_SOURCE_BYTES));
    }
    Ok((bytes, name))
}

impl AppState {
    /// The pages of document `id` in their current order.
    pub fn pages(&self, id: DocumentId) -> Result<Vec<PageSlotInfo>, AppError> {
        self.model(id, |state| Ok(state.page_infos()))
    }

    /// Runs a command on a document as one undo step (ADR-003 §6, ADR-036 §2). `not_found` for an unknown document, annotation, page or
    /// source, `invalid_argument` for a value that does not fit (`lastPage` for the delete of every page), `limit_exceeded` for a count that
    /// is too large. A page insert first makes the pages in the engine's copy; a command the model then refuses takes them off again.
    pub fn apply_command(
        &self,
        id: DocumentId,
        command: DocCommand,
    ) -> Result<ChangeSet, AppError> {
        command.check_shape()?;
        // A file opened with the open password of a restricted file keeps its restrictions (ADR-047 §4): no `edit`, no edit command.
        self.check_may_edit(id)?;
        match command {
            DocCommand::InsertBlankPage { at, width, height } => {
                let base = self.model(id, |state| {
                    state.check_insert(at, 1)?;
                    Ok(state.blank_size(at))
                })?;
                let size = [width.unwrap_or(base[0]), height.unwrap_or(base[1])];
                let page = self.engine.append_blank_page(id, size)?;
                let add = DocCommand::AddPages {
                    label: LABEL_INSERT_BLANK.to_owned(),
                    at,
                    pages: vec![NewPage {
                        source: PageSource::Blank,
                        engine_index: page.engine_index,
                        rotation: page.rotation,
                        size: page.size,
                        media: page.media,
                        annotations: None,
                    }],
                };
                let appended = page.engine_index..page.engine_index.saturating_add(1);
                self.execute_or_take_back(id, add, appended)
            }
            DocCommand::InsertPages { source, pages, at } => {
                self.model(id, |state| state.check_insert(at, pages.len()))?;
                let bytes = self
                    .sources
                    .pin(id, source)
                    .ok_or(AppError::not_found("source"))?;
                if pages.iter().any(|index| *index >= bytes.page_count) {
                    return Err(AppError::invalid("pages"));
                }
                let appended = self.engine.append_pages(id, bytes, pages.clone())?;
                let range = match (appended.first(), appended.last()) {
                    (Some(first), Some(last)) => {
                        first.engine_index..last.engine_index.saturating_add(1)
                    }
                    _ => 0..0,
                };
                let new_pages = pages
                    .iter()
                    .zip(appended)
                    .map(|(&index, page)| {
                        // The files written from this document name an original that has no `/NM` the same way (`pdfwrite::annots`).
                        let annotations = page.annotations.map(|mut items| {
                            for item in &mut items {
                                if item.origin.name.is_none() {
                                    item.origin.name =
                                        Some(crate::pdfwrite::annots::imported_name(
                                            index,
                                            item.origin.annot_index,
                                        ));
                                }
                            }
                            items
                        });
                        NewPage {
                            source: PageSource::Imported { source, index },
                            engine_index: page.engine_index,
                            rotation: page.rotation,
                            size: page.size,
                            media: page.media,
                            annotations,
                        }
                    })
                    .collect();
                let add = DocCommand::AddPages {
                    label: LABEL_INSERT_PAGES.to_owned(),
                    at,
                    pages: new_pages,
                };
                self.execute_or_take_back(id, add, range)
            }
            other => self.execute(id, other),
        }
    }

    /// `read_only` (`permission`) when the document's permissions forbid editing it (`DocFlags.permissions`), else nothing.
    pub(super) fn check_may_edit(&self, id: DocumentId) -> Result<(), AppError> {
        let info = self.info(id).ok_or(AppError::not_found("document"))?;
        match info.flags.permissions {
            Some(allowed) if !allowed.contains(Permission::Edit) => {
                Err(AppError::read_only("permission"))
            }
            _ => Ok(()),
        }
    }

    /// [`AppState::execute`] of an insert whose pages the engine has made already (`appended`: their engine indices). If the model refuses
    /// the step (the document changed since the check, or was closed) the pages are taken off the engine's copy again, so the two do not
    /// drift apart. Taking them back is best effort: pages left over in the copy are never listed by the model.
    fn execute_or_take_back(
        &self,
        id: DocumentId,
        command: DocCommand,
        appended: std::ops::Range<u32>,
    ) -> Result<ChangeSet, AppError> {
        let result = self.execute(id, command);
        if result.is_err() && !appended.is_empty() {
            let _ = self.engine.truncate_pages(id, appended.start, appended.end);
        }
        result
    }

    /// Runs a validated command as one step of the history and makes the engine follow.
    pub(super) fn execute(
        &self,
        id: DocumentId,
        command: DocCommand,
    ) -> Result<ChangeSet, AppError> {
        self.change_and_sync(id, Revert::Undo, |state, stamp| {
            state.execute(command, stamp)
        })
    }

    /// Reads the PDFs at `paths` (from the native dialog) into import sources. A file that does not qualify is a `failed` entry, in order.
    pub fn add_sources(&self, paths: Vec<PathBuf>) -> Vec<SourceResult> {
        paths
            .into_iter()
            .take(limits::MAX_SOURCES + 1)
            .map(|path| match self.add_source(&path) {
                Ok(result) => result,
                Err(error) => SourceResult::Failed {
                    error: UiError::from(error),
                },
            })
            .collect()
    }

    fn add_source(&self, path: &std::path::Path) -> Result<SourceResult, AppError> {
        // Refused before the file is read when there is no room for another one of any size.
        self.sources.check_room(0)?;
        let (bytes, display_name) = read_source(path)?;
        self.sources.check_room(bytes.len() as u64)?;
        let bytes: Arc<[u8]> = Arc::from(bytes);
        let page_count = pagetree::count_pages(Arc::clone(&bytes))?;
        let (source_id, _) = self.sources.add(SourceBytes {
            bytes,
            page_count,
            display_name: display_name.clone(),
        })?;
        Ok(SourceResult::Ready {
            source_id,
            display_name,
            page_count,
        })
    }
}

/// The pages of a document in their current order.
#[tauri::command]
pub async fn get_pages(
    state: State<'_, AppState>,
    doc_id: DocumentId,
) -> Result<Vec<PageSlotInfo>, UiError> {
    let state = state.inner().clone();
    blocking(move || state.pages(doc_id)).await
}

/// Runs a command on a document as one undo step and answers with what changed.
#[tauri::command]
pub async fn apply_command(
    state: State<'_, AppState>,
    doc_id: DocumentId,
    command: DocCommand,
) -> Result<ChangeSet, UiError> {
    let state = state.inner().clone();
    blocking(move || state.apply_command(doc_id, command)).await
}

/// Asks the user for PDFs to take pages from (a native dialog) and reads them into memory. The webview gets ids, names and page counts.
#[tauri::command]
pub async fn pick_pdf_sources(
    window: WebviewWindow,
    state: State<'_, AppState>,
    multiple: bool,
) -> Result<Vec<SourceResult>, UiError> {
    let state = state.inner().clone();
    blocking(move || {
        let dialog = window
            .dialog()
            .file()
            .set_parent(&window)
            .add_filter("PDF", &["pdf"]);
        let picked = if multiple {
            dialog.blocking_pick_files()
        } else {
            dialog.blocking_pick_file().map(|file| vec![file])
        };
        let Some(picked) = picked else {
            return Ok(Vec::new());
        };
        let paths = picked
            .into_iter()
            .take(limits::MAX_SOURCES + 1)
            .filter_map(|file| match file.into_path() {
                Ok(path) => Some(path),
                Err(error) => {
                    AppError::logged(ErrorCode::Internal, error).log();
                    None
                }
            })
            .collect();
        Ok(state.add_sources(paths))
    })
    .await
}

/// Lets go of an import source. An id that is not held is nothing; documents that already pinned the bytes keep them.
#[tauri::command]
pub async fn release_source(
    state: State<'_, AppState>,
    source_id: SourceId,
) -> Result<(), UiError> {
    let state = state.inner().clone();
    blocking(move || {
        state.sources.release(source_id);
        Ok(())
    })
    .await
}
