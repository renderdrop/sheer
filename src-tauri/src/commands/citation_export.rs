//! Saving the citation list to a file (ADR-119 section 8, ARCHITECTURE section 5 "Citations (v1.3)").
//!
//! | Command | Arguments | Returns |
//! |---|---|---|
//! | `save_citation_list` | `docId`, `format: txt\|html\|md\|ris\|bib`, `blocks: StyledBlock[]`, `style: CitationStyle`, `lang?: 'en'\|'de'` (HTML `<html lang>` and title) | `boolean`: `false` if the save dialog was cancelled |
//!
//! The UI sends typed blocks, never markup; Rust escapes them for the format (`export::citations`). `ris` and `bib` are made from the
//! stored bibliographic record and take no blocks. The save dialog is Rust's, the file is written atomically, and no path goes back.

use crate::automation::dialogs::DialogSeam;
use tauri::{State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

use super::jobs::file_stem;
use super::{blocking, AppState};
use crate::documents::DocumentId;
use crate::error::{AppError, ErrorCode, UiError};
use crate::export::citations::{
    self, default_file_name, CitationFileFormat, CitationStyle, StyledBlock,
};
use crate::model::bibliography::BibRecord;

impl AppState {
    /// The record `ris` and `bib` are made from: the one the next save writes if the user changed it, else the one the session read.
    /// It is the merged record of `get_bibliography` (the staged edit included), which reads the file when nothing was read yet.
    fn export_record(&self, id: DocumentId) -> Result<BibRecord, AppError> {
        Ok(self.get_bibliography(id)?.record)
    }

    /// What can be checked without the dialog, so that a request that cannot run does not ask for a file name: the document is open,
    /// the format and the content agree and are within the caps. Answers the stem of the display name and the record, if one is needed.
    fn check_citation_list(
        &self,
        id: DocumentId,
        format: CitationFileFormat,
        blocks: &[StyledBlock],
        lang: Option<&str>,
    ) -> Result<(String, Option<BibRecord>), AppError> {
        let info = self.info(id).ok_or(AppError::not_found("document"))?;
        let record = if format.from_record() {
            Some(self.export_record(id)?)
        } else {
            None
        };
        // Builds the text once to apply every check; the file is made again after the dialog (the lists are small).
        citations::render_in(format, blocks, record.as_ref(), lang)?;
        Ok((file_stem(&info.display_name), record))
    }

    /// Asks for the target and writes the list. `false` when the dialog was cancelled.
    pub fn save_citation_list_dialog(
        &self,
        window: &WebviewWindow,
        id: DocumentId,
        format: CitationFileFormat,
        blocks: &[StyledBlock],
        style: CitationStyle,
        lang: Option<&str>,
    ) -> Result<bool, AppError> {
        let (stem, record) = self.check_citation_list(id, format, blocks, lang)?;
        let dialog = window
            .dialog()
            .file()
            .set_parent(window)
            .add_filter(format.filter_label(), &[format.extension()])
            .set_file_name(default_file_name(&stem, format, style));
        let Some(chosen) = dialog.seam_save_file()? else {
            return Ok(false);
        };
        let path = chosen
            .into_path()
            .map_err(|error| AppError::logged(ErrorCode::Internal, error))?;
        self.write_citation_list(&path, format, blocks, record.as_ref(), lang)?;
        Ok(true)
    }

    /// [`AppState::save_citation_list_dialog`] with the target chosen: never a document that is open.
    pub fn write_citation_list(
        &self,
        target: &std::path::Path,
        format: CitationFileFormat,
        blocks: &[StyledBlock],
        record: Option<&BibRecord>,
        lang: Option<&str>,
    ) -> Result<(), AppError> {
        let target = citations::admit_target(target, format)?;
        if self.registry.is_open_path(&target) {
            return Err(AppError::invalid("exportTarget"));
        }
        citations::write_list_in(&target, format, blocks, record, lang)?;
        Ok(())
    }
}

/// Writes the list as a file the user picks in a native dialog.
#[tauri::command]
pub async fn save_citation_list(
    window: WebviewWindow,
    state: State<'_, AppState>,
    doc_id: DocumentId,
    format: CitationFileFormat,
    blocks: Vec<StyledBlock>,
    style: CitationStyle,
    lang: Option<String>,
) -> Result<bool, UiError> {
    let state = state.inner().clone();
    blocking(move || {
        state.save_citation_list_dialog(&window, doc_id, format, &blocks, style, lang.as_deref())
    })
    .await
}
