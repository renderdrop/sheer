//! The OCR text layers a session made (ADR-134, ARCHITECTURE section 15): `DocState.ocr_layers`, page id to layer. They are written
//! into the file by the save path only; here they are a model step with an exact inverse, like the other page-level commands.

use std::sync::Arc;

use super::command::DocCommand;
use super::doc_state::{Delta, DocPart, DocState};
use crate::documents::PageId;
use crate::error::AppError;
use crate::ocr::textlayer::{canonical, Shape};
use crate::ocr::OcrPageLayer;

/// Runs `DocCommand::ApplyOcr` and `RestoreOcr`: sets the layer of each page (`None`: removes it). Every page must exist, or nothing
/// changes. Returns the `RestoreOcr` that puts the previous layers back (which is its own inverse again).
pub(crate) fn restore(
    state: &mut DocState,
    layers: &[(PageId, Option<Arc<OcrPageLayer>>)],
    delta: &mut Delta,
) -> Result<DocCommand, AppError> {
    if layers
        .iter()
        .any(|(page, _)| state.position(*page).is_none())
    {
        return Err(AppError::invalid("page"));
    }
    Ok(DocCommand::RestoreOcr {
        layers: swap(state, layers, delta),
    })
}

/// Runs `DocCommand::ApplyOcr`: the recognizer's boxes are of the page as it is shown now; the model keeps them in page space (before the
/// rotation), so that rotating the page later does not move them (`textlayer::canonical`).
pub(crate) fn apply(
    state: &mut DocState,
    layers: &[(PageId, Arc<OcrPageLayer>)],
    delta: &mut Delta,
) -> Result<DocCommand, AppError> {
    let mut kept = Vec::with_capacity(layers.len());
    for (page, layer) in layers {
        let slot = state.slot(*page).ok_or_else(|| AppError::invalid("page"))?;
        let shape = Shape {
            size: slot.size,
            rotation: slot.rotation,
        };
        kept.push((*page, Some(Arc::new(canonical(layer, shape)))));
    }
    restore(state, &kept, delta)
}

/// Sets the layer of each page (`None`: removes it) and returns what was there before, in the order that undoes it. The pages are not
/// checked: the caller did.
pub(crate) fn swap(
    state: &mut DocState,
    layers: &[(PageId, Option<Arc<OcrPageLayer>>)],
    delta: &mut Delta,
) -> Vec<(PageId, Option<Arc<OcrPageLayer>>)> {
    let mut before = Vec::with_capacity(layers.len());
    for (page, layer) in layers {
        let previous = match layer {
            Some(layer) => state.ocr_layers.insert(page.get(), Arc::clone(layer)),
            None => state.ocr_layers.remove(&page.get()),
        };
        before.push((*page, previous));
    }
    // The inverse undoes in reverse, so a page named twice ends where it started.
    before.reverse();
    delta.doc.insert(DocPart::Ocr);
    before
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::doc_state::Stamp;
    use crate::ocr::{OcrLine, OcrWord};

    fn layer(text: &str) -> Arc<OcrPageLayer> {
        Arc::new(OcrPageLayer {
            lang: "en-US".into(),
            angle_deg: 0.0,
            dpi: 300.0,
            lines: vec![OcrLine {
                words: vec![OcrWord {
                    text: text.into(),
                    rect: [0.0, 0.0, 10.0, 10.0],
                }],
            }],
        })
    }

    fn stamp() -> Stamp {
        Stamp {
            now_ms: 0,
            modified: "2026-01-01T00:00:00Z".into(),
        }
    }

    #[test]
    fn apply_is_one_undo_step_that_removes_and_redo_adds_again() {
        let mut state = DocState::new(2);
        let (a, b) = (PageId::new(0), PageId::new(1));
        let command = DocCommand::ApplyOcr {
            layers: vec![(a, layer("one")), (b, layer("two"))],
        };
        assert_eq!(command.label(), "ocr.apply");
        let changes = state.execute(command, &stamp()).unwrap();
        assert!(changes.doc.contains(&DocPart::Ocr));
        assert_eq!(state.ocr_layers.len(), 2);
        state.undo(&stamp()).unwrap();
        assert!(state.ocr_layers.is_empty());
        state.redo(&stamp()).unwrap();
        assert_eq!(state.ocr_layers.len(), 2);
        // A layer over an existing one comes back to it on undo.
        let again = DocCommand::ApplyOcr {
            layers: vec![(a, layer("new"))],
        };
        state.execute(again, &stamp()).unwrap();
        assert_eq!(state.ocr_layers[&a.get()].lines[0].words[0].text, "new");
        state.undo(&stamp()).unwrap();
        assert_eq!(state.ocr_layers[&a.get()].lines[0].words[0].text, "one");
    }

    #[test]
    fn an_unknown_page_or_an_empty_list_changes_nothing() {
        let mut state = DocState::new(1);
        let bad = DocCommand::ApplyOcr {
            layers: vec![(PageId::new(0), layer("x")), (PageId::new(9), layer("y"))],
        };
        assert!(state.execute(bad, &stamp()).is_err());
        assert!(state.ocr_layers.is_empty());
        let empty = DocCommand::ApplyOcr { layers: vec![] };
        assert!(state.execute(empty, &stamp()).is_err());
    }

    #[test]
    fn a_signed_document_refuses_it() {
        use crate::model::sig_policy::check;
        use crate::pdfsig::types::SignatureLock;
        let command = DocCommand::ApplyOcr {
            layers: vec![(PageId::new(0), layer("x"))],
        };
        assert!(check(SignatureLock::AnnotateFillAndSign, &command).is_err());
        assert!(check(SignatureLock::None, &command).is_ok());
    }

    #[test]
    fn a_save_writes_the_layers_into_the_file_and_nothing_stays_pending() {
        let mut state = DocState::new(2);
        let command = DocCommand::ApplyOcr {
            layers: vec![(PageId::new(1), layer("x"))],
        };
        state.execute(command, &stamp()).unwrap();
        let changes = state.finish_save(&std::collections::HashMap::new());
        assert!(state.ocr_layers.is_empty());
        assert!(changes.doc.contains(&DocPart::Ocr));
        // The history is dropped with the save: nothing can bring the pending layer back over the file's real one.
        let _ = state.undo(&stamp());
        assert!(state.ocr_layers.is_empty());
    }

    #[test]
    fn rotating_or_cropping_the_page_after_ocr_does_not_shift_the_layer() {
        let mut state = DocState::new(1);
        let page = PageId::new(0);
        state
            .execute(
                DocCommand::ApplyOcr {
                    layers: vec![(page, layer("x"))],
                },
                &stamp(),
            )
            .unwrap();
        let before = state.ocr_layers[&page.get()].lines[0].words[0].rect;
        state
            .execute(
                DocCommand::SetRotations {
                    rotations: vec![(page, 90)],
                },
                &stamp(),
            )
            .unwrap();
        assert_eq!(state.ocr_layers[&page.get()].lines[0].words[0].rect, before);
        // Page space is what a text layer reports: the same boxes before and after.
        let slot = state.slot(page).unwrap();
        let shape = Shape {
            size: slot.size,
            rotation: slot.rotation,
        };
        let text = crate::ocr::textlayer::text_page(&state.ocr_layers[&page.get()], shape);
        assert_eq!(text.rotation, 90);
        assert_eq!(text.boxes[0..4], [0.0, 0.0, 10.0, 10.0]);
        // A layer made on the page while it is turned is kept in page space.
        let turned = DocCommand::ApplyOcr {
            layers: vec![(page, layer("y"))],
        };
        state.execute(turned, &stamp()).unwrap();
        let rect = state.ocr_layers[&page.get()].lines[0].words[0].rect;
        assert_ne!(
            rect, before,
            "displayed (0,0)-(10,10) at 90 is not page (0,0)"
        );
    }
}
