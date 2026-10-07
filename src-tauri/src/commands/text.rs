//! `get_text_layer`: the text of a page and the box of every character, for selecting and copying text (ARCHITECTURE §5).
//!
//! | Command | Arguments | Returns |
//! |---|---|---|
//! | `get_text_layer` | `docId: number`, `pageId: number` | `{ text, boxes, truncated, rotation }`: at most 200 000 UTF-16 code units, and four numbers (x, y, width, height in page space) per code unit; `rotation` is the page's own `/Rotate` in degrees, which the boxes are before |
//!
//! The engine reads the page at `Interactive` priority, after the pages on screen and before anything that is not asked for
//! (ADR-002 §2). The layer is a lookup of what the page says: it is not kept (the UI's `textCache` is).

use std::sync::Arc;

use tauri::State;

use super::annotations::AnnotationStore;
use super::{blocking, AppState};
use crate::documents::{DocumentId, PageId};
use crate::error::{AppError, ErrorCode, UiError};
use crate::limits;
use crate::model::reading::TextLayer;
use crate::ocr::textlayer::{self, Shape};
use crate::ocr::OcrPageLayer;

/// [`AppState::pending_ocr`] for a reader that holds the models only (the search thread).
pub(super) fn pending_layer(
    models: &AnnotationStore,
    id: DocumentId,
    page: PageId,
) -> Option<(Arc<OcrPageLayer>, Shape)> {
    models.peek(id, |state| {
        let layer = state.ocr_layers.get(&page.get())?;
        let slot = state.slot(page)?;
        Some((
            Arc::clone(layer),
            Shape {
                size: slot.size,
                rotation: slot.rotation,
            },
        ))
    })
}

impl AppState {
    /// The OCR layer of `page` that is not in the file yet, and where the page is (ADR-134 item 8). Nothing for a page without one, or a
    /// document that has no model yet (no model, no OCR run).
    pub(super) fn pending_ocr(
        &self,
        id: DocumentId,
        page: PageId,
    ) -> Option<(Arc<OcrPageLayer>, Shape)> {
        pending_layer(&self.annotations, id, page)
    }

    /// The text layer of a page of an open document. `invalid_argument` (`page`) for a page the document does not have.
    pub fn text_layer(&self, id: DocumentId, page: PageId) -> Result<TextLayer, AppError> {
        let page_index = self.registry.page_index(id, page)?;
        let layer = match self.pending_ocr(id, page) {
            // Until the save the file has no text on this page: the layer answers (the engine's own answer would be empty).
            Some((ocr, shape)) => textlayer::text_page(&ocr, shape),
            None => self.engine.text_layer(id, page_index)?,
        };
        // What the UI is promised, checked on what is sent: within the limit, and a box for every code unit.
        let units = layer.text.encode_utf16().count();
        if units > limits::MAX_TEXT_CHARS || layer.boxes.len() != 4 * units {
            return Err(AppError::logged(
                ErrorCode::Internal,
                "the text layer does not have a box for every character",
            ));
        }
        Ok(TextLayer {
            text: layer.text,
            boxes: layer.boxes,
            truncated: layer.truncated,
            rotation: layer.rotation,
        })
    }
}

/// The text of a page, with the box of each character in page space.
#[tauri::command]
pub async fn get_text_layer(
    state: State<'_, AppState>,
    doc_id: DocumentId,
    page_id: PageId,
) -> Result<TextLayer, UiError> {
    let state = state.inner().clone();
    blocking(move || state.text_layer(doc_id, page_id)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::testutil::state_with_pages;
    use crate::engine::{Job, TextPage};

    /// A state whose engine answers `get_text_layer` with `page`, and remembers which page index it was asked for.
    fn state_with_text(
        page: TextPage,
    ) -> (
        AppState,
        DocumentId,
        std::sync::Arc<std::sync::Mutex<Vec<u32>>>,
    ) {
        let asked = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let log = std::sync::Arc::clone(&asked);
        let (state, id) = state_with_pages(3, move |job| {
            if let Job::TextLayer {
                page_index, reply, ..
            } = job
            {
                log.lock().unwrap().push(page_index);
                let _ = reply.send(Ok(page.clone()));
            }
        });
        (state, id, asked)
    }

    fn page(text: &str, truncated: bool) -> TextPage {
        let units = text.encode_utf16().count();
        TextPage {
            text: text.to_owned(),
            boxes: (0..units * 4).map(|n| n as f32).collect(),
            truncated,
            rotation: 0,
        }
    }

    #[test]
    fn the_layer_of_a_page_is_the_engines_text_and_boxes() {
        let (state, id, asked) = state_with_text(page("Gr\u{fc}\u{df}e", false));
        let layer = state.text_layer(id, PageId::new(1)).unwrap();
        assert_eq!(layer.text, "Gr\u{fc}\u{df}e");
        assert_eq!(layer.boxes.len(), 20);
        assert!(!layer.truncated);
        assert_eq!(
            *asked.lock().unwrap(),
            [1],
            "the page id is the position of the page"
        );

        // The flag of a page that is cut passes through.
        let (state, id, _) = state_with_text(page("abc", true));
        assert!(state.text_layer(id, PageId::new(0)).unwrap().truncated);
    }

    #[test]
    fn a_character_of_two_code_units_has_two_boxes() {
        let (state, id, _) = state_with_text(page("a\u{1f600}", false));
        let layer = state.text_layer(id, PageId::new(0)).unwrap();
        assert_eq!(layer.text.encode_utf16().count(), 3);
        assert_eq!(layer.boxes.len(), 12);
    }

    #[test]
    fn a_page_the_document_does_not_have_is_refused_before_the_engine_is_asked() {
        let (state, id, asked) = state_with_text(page("abc", false));
        for bad in [3, 4, u32::MAX] {
            assert_eq!(
                state.text_layer(id, PageId::new(bad)).unwrap_err().code(),
                ErrorCode::InvalidArgument,
                "{bad}"
            );
        }
        let unknown: DocumentId = serde_json::from_str("999").unwrap();
        assert_eq!(
            state
                .text_layer(unknown, PageId::new(0))
                .unwrap_err()
                .code(),
            ErrorCode::NotFound
        );
        assert!(asked.lock().unwrap().is_empty());
    }

    #[test]
    fn a_layer_that_does_not_keep_its_promises_is_an_internal_error_not_sent() {
        // Too few boxes for the text.
        let mut short = page("abc", false);
        short.boxes.pop();
        let (state, id, _) = state_with_text(short);
        assert_eq!(
            state.text_layer(id, PageId::new(0)).unwrap_err().code(),
            ErrorCode::Internal
        );
        // More text than a layer may hold.
        let too_long = page(&"x".repeat(limits::MAX_TEXT_CHARS + 1), false);
        let (state, id, _) = state_with_text(too_long);
        assert_eq!(
            state.text_layer(id, PageId::new(0)).unwrap_err().code(),
            ErrorCode::Internal
        );
        // Exactly the limit is fine.
        let at_limit = page(&"x".repeat(limits::MAX_TEXT_CHARS), true);
        let (state, id, _) = state_with_text(at_limit);
        assert!(state.text_layer(id, PageId::new(0)).is_ok());
    }

    #[test]
    fn a_pending_ocr_layer_answers_instead_of_the_engine_until_undo_takes_it_away() {
        use crate::model::command::DocCommand;
        use crate::ocr::{OcrLine, OcrWord};
        let (state, id, asked) = state_with_text(page("engine text", false));
        let layer = Arc::new(OcrPageLayer {
            lang: "en-US".into(),
            angle_deg: 0.0,
            dpi: 300.0,
            lines: vec![OcrLine {
                words: vec![OcrWord {
                    text: "scanned".into(),
                    rect: [10.0, 10.0, 80.0, 22.0],
                }],
            }],
        });
        state
            .apply_command(
                id,
                DocCommand::ApplyOcr {
                    layers: vec![(PageId::new(1), layer)],
                },
            )
            .unwrap();
        let ocr = state.text_layer(id, PageId::new(1)).unwrap();
        assert_eq!(ocr.text, "scanned");
        assert_eq!(ocr.boxes.len(), 28);
        assert!(asked.lock().unwrap().is_empty(), "the engine is not asked");
        // Another page is the engine's.
        assert_eq!(
            state.text_layer(id, PageId::new(0)).unwrap().text,
            "engine text"
        );
        // Undo shows the engine's text at once; redo the layer again.
        state.undo(id).unwrap();
        assert_eq!(
            state.text_layer(id, PageId::new(1)).unwrap().text,
            "engine text"
        );
        state.redo(id).unwrap();
        assert_eq!(
            state.text_layer(id, PageId::new(1)).unwrap().text,
            "scanned"
        );
    }
}
