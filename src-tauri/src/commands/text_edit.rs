//! `text_edit_probe` and `text_edit_lines`: the lines of existing page text the user may edit (ADR-125, ARCHITECTURE §13.5). The edit itself
//! is `apply_command` with `DocCommand::EditTextLine`.
//!
//! | Command | Arguments | Returns |
//! |---|---|---|
//! | `text_edit_probe` | `docId: number`, `pageId: number`, `unit: number` (UTF-16 index into `TextLayer.text`) | `TextLineInfo`: the line at that character, its box, font and whether (and in which font) it can be edited |
//! | `text_edit_lines` | `docId: number`, `pageId: number` | `{ lines: TextLineInfo[] }`: at most 5 000 lines in reading order, for keyboard navigation |
//!
//! Both take a document id and a page id, never a path. W0 seam: the input is validated, the answer is `not_yet` until the v1.5.1
//! packages fill it in. A refusal later is `unsupported_feature` with `what: "textEdit"` and `params.reason`.

use tauri::State;

use super::{blocking, AppState};
use crate::documents::{DocumentId, PageId};
use crate::error::{AppError, UiError};
use crate::limits;
use crate::model::text_edit::{PageTextLines, TextLineInfo};

impl AppState {
    /// The line at UTF-16 index `unit` of the page's text layer. `invalid_argument` (`page`, `unit`).
    pub fn text_edit_probe(
        &self,
        id: DocumentId,
        page: PageId,
        unit: u32,
    ) -> Result<TextLineInfo, AppError> {
        let _page_index = self.registry.page_index(id, page)?;
        if unit as usize >= limits::MAX_TEXT_CHARS {
            return Err(AppError::invalid("unit"));
        }
        Err(AppError::not_yet())
    }

    /// Every line of the page in reading order. `invalid_argument` (`page`).
    pub fn text_edit_lines(&self, id: DocumentId, page: PageId) -> Result<PageTextLines, AppError> {
        let _page_index = self.registry.page_index(id, page)?;
        Err(AppError::not_yet())
    }
}

/// The line of a page at a character of its text layer.
#[tauri::command]
pub async fn text_edit_probe(
    state: State<'_, AppState>,
    doc_id: DocumentId,
    page_id: PageId,
    unit: u32,
) -> Result<TextLineInfo, UiError> {
    let state = state.inner().clone();
    blocking(move || state.text_edit_probe(doc_id, page_id, unit)).await
}

/// All lines of a page, in reading order.
#[tauri::command]
pub async fn text_edit_lines(
    state: State<'_, AppState>,
    doc_id: DocumentId,
    page_id: PageId,
) -> Result<PageTextLines, UiError> {
    let state = state.inner().clone();
    blocking(move || state.text_edit_lines(doc_id, page_id)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::testutil::state_with_pages;
    use crate::error::ErrorCode;

    #[test]
    fn the_seam_validates_the_input_and_then_says_not_yet() {
        let (state, id) = state_with_pages(2, |_| {});
        let page = state.registry.page_id(id, 0).unwrap();
        let error = state.text_edit_probe(id, page, 0).unwrap_err();
        assert_eq!(error.code(), ErrorCode::UnsupportedFeature);
        let error = state
            .text_edit_probe(id, page, limits::MAX_TEXT_CHARS as u32)
            .unwrap_err();
        assert_eq!(error.code(), ErrorCode::InvalidArgument);
        assert_eq!(
            state.text_edit_lines(id, page).unwrap_err().code(),
            ErrorCode::UnsupportedFeature
        );
    }
}
