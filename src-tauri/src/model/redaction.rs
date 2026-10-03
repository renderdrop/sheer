//! Redaction marks as the model has them (ADR-047 §3).
//!
//! A mark is an annotation of kind `redactMark` that lives in the model only: undoable, never written to the file, never imported,
//! never in the comments list. Applying them is a job (`engine::redact`) that swaps the marked pages for raster pages: the job reads
//! what to burn with [`snapshot`], and the model step is [`plan`] (a [`DocCommand::RestoreRedaction`], which is its own inverse).

use std::collections::{BTreeSet, HashSet};
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use super::annotation::{Annotation, AnnotationBody, RedactSource, Rgb, Sync as AnnotSync};
use super::command::DocCommand;
use super::doc_state::{Delta, DocPart, DocState, Slot};
use super::geometry::{Quad, Rect};
use super::ids::AnnotId;
use super::page::{PageSlot, PageSource};
use crate::documents::PageId;
use crate::error::AppError;
use crate::limits;

/// The marks of one page in a [`DocCommand::MarkRedactions`] (search hits become these).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkSpec {
    pub page_id: PageId,
    pub quads: Vec<Quad>,
    pub source: RedactSource,
}

/// The arguments of `apply_redactions`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RedactOptions {
    /// `None`: every page with marks.
    pub pages: Option<Vec<PageId>>,
    pub remove_metadata: bool,
}

/// Checks the geometry of a new mark (called from `AnnotationBody::check`): not empty and at most 512 quads. The numbers themselves
/// are checked with the other quads; the per-document budget is [`mark`]'s.
pub(crate) fn check_mark(body: &AnnotationBody) -> Result<(), AppError> {
    if let AnnotationBody::RedactMark { quads, .. } = body {
        if quads.is_empty() {
            return Err(AppError::invalid("quads"));
        }
        if quads.len() > limits::MAX_REDACT_QUADS_PER_MARK {
            return Err(AppError::limit(
                "quads",
                limits::MAX_REDACT_QUADS_PER_MARK as u64,
            ));
        }
    }
    Ok(())
}

/// Live marks in the document.
fn marks_in(state: &DocState) -> usize {
    state
        .entries
        .values()
        .filter(|entry| !entry.tombstone && entry.annotation.body.is_redact_mark())
        .count()
}

/// Runs [`DocCommand::MarkRedactions`]: adds the marks as one step and returns its inverse. Every mark is checked before the first
/// one is added; a mark on a page the document does not have, one without quads, over 512 quads, or a number that is not finite is
/// `invalid_argument`, and more than 20 000 marks in the document is `limit_exceeded` (`redaction`).
pub(crate) fn mark(
    state: &mut DocState,
    marks: &[MarkSpec],
    delta: &mut Delta,
) -> Result<DocCommand, AppError> {
    if marks.is_empty() {
        return Err(AppError::invalid("marks"));
    }
    if marks_in(state) + marks.len() > limits::MAX_REDACT_MARKS_PER_DOC {
        return Err(AppError::limit(
            "redaction",
            limits::MAX_REDACT_MARKS_PER_DOC as u64,
        ));
    }
    let mut made = Vec::with_capacity(marks.len());
    for spec in marks {
        if state.slot(spec.page_id).is_none() {
            return Err(AppError::invalid("page"));
        }
        let mut annotation = Annotation {
            id: AnnotId::new(0),
            page_id: spec.page_id,
            rect: Rect {
                x: 0.0,
                y: 0.0,
                w: 0.0,
                h: 0.0,
            },
            color: Rgb([0, 0, 0]),
            opacity: 1.0,
            contents: String::new(),
            author: None,
            modified: None,
            in_reply_to: None,
            locked: false,
            sync: AnnotSync::New,
            body: AnnotationBody::RedactMark {
                quads: spec.quads.clone(),
                source: spec.source,
            },
        };
        annotation.normalize()?;
        made.push(annotation);
    }
    let mut slots: Vec<Slot> = Vec::with_capacity(made.len());
    for mut annotation in made {
        let id = state.alloc_id()?;
        annotation.id = id;
        slots.push((
            id,
            Some(super::doc_state::Entry {
                annotation,
                persisted: None,
                tombstone: false,
            }),
        ));
    }
    Ok(DocCommand::Restore {
        slots: state.set_slots(slots, delta),
    })
}

// --- Applying the marks ----------------------------------------------------------------------------------------------

/// What the job needs to know about one page it rasters, taken when it starts.
#[derive(Debug, Clone, PartialEq)]
pub struct PageWork {
    pub page_id: PageId,
    pub engine_index: u32,
    /// The page's `rev` now: a page that changed meanwhile fails the job.
    pub rev: u32,
    /// Width and height in points before the rotation (the crop size), and the `/Rotate`.
    pub size: [f32; 2],
    pub rotation: u16,
    /// The rectangles to fill black, page space (one per quad of every mark on the page).
    pub burn: Vec<Rect>,
}

/// The bounding rectangle of a quad.
fn quad_rect(quad: &Quad) -> Rect {
    let min =
        |f: fn(&super::geometry::Point) -> f32| quad.iter().map(f).fold(f32::INFINITY, f32::min);
    let max = |f: fn(&super::geometry::Point) -> f32| {
        quad.iter().map(f).fold(f32::NEG_INFINITY, f32::max)
    };
    let (x0, x1) = (min(|p| p.x), max(|p| p.x));
    let (y0, y1) = (min(|p| p.y), max(|p| p.y));
    Rect {
        x: x0,
        y: y0,
        w: x1 - x0,
        h: y1 - y0,
    }
}

/// The pages `apply_redactions` works on: `pages` (each must be a page of the document, once) or, with `None`, every page, in the order
/// of the document, that has at least one live mark; a listed page without a mark is left out. Nothing to do is `invalid_argument`
/// (`redaction`), more than 5 000 pages is `limit_exceeded`.
pub fn snapshot(state: &DocState, pages: Option<&[PageId]>) -> Result<Vec<PageWork>, AppError> {
    if let Some(list) = pages {
        let mut seen = HashSet::new();
        for page in list {
            if state.slot(*page).is_none() || !seen.insert(page.get()) {
                return Err(AppError::invalid("pages"));
            }
        }
    }
    let wanted = |page: PageId| pages.is_none_or(|list| list.contains(&page));
    let mut work = Vec::new();
    for slot in state.pages().iter().filter(|slot| wanted(slot.id)) {
        let burn: Vec<Rect> = state
            .entries
            .values()
            .filter(|entry| !entry.tombstone && entry.annotation.page_id == slot.id)
            .filter_map(|entry| match &entry.annotation.body {
                AnnotationBody::RedactMark { quads, .. } => Some(quads.iter().map(quad_rect)),
                _ => None,
            })
            .flatten()
            .collect();
        if burn.is_empty() {
            continue;
        }
        work.push(PageWork {
            page_id: slot.id,
            engine_index: slot.engine_index,
            rev: slot.rev,
            size: slot.size,
            rotation: slot.rotation,
            burn,
        });
    }
    if work.is_empty() {
        return Err(AppError::invalid("redaction"));
    }
    if work.len() > limits::MAX_REDACT_PAGES {
        return Err(AppError::limit("pages", limits::MAX_REDACT_PAGES as u64));
    }
    Ok(work)
}

/// A rastered page: what the job made for one [`PageWork`], already added to the engine's copy as `engine_index`.
#[derive(Debug, Clone)]
pub struct Raster {
    pub page_id: PageId,
    /// The `rev` the page had when the job started.
    pub rev: u32,
    pub engine_index: u32,
    /// The one-page PDF (`pdfwrite::redact::raster_page`).
    pub bytes: Arc<[u8]>,
}

/// The model step of an applied redaction (label `redact.apply`): the slot of each rastered page becomes a [`PageSource::Redacted`] one
/// with the same id, the marks, annotations and content objects of those pages go, and with `remove_metadata` the metadata removal is
/// staged. The second value says whether session edits were dropped with them (`unsavedEditsDropped`). A page that is gone or has
/// another `rev` than the job saw is `invalid_argument` (`redaction`): the step is not made.
pub fn plan(
    state: &DocState,
    rasters: &[Raster],
    remove_metadata: bool,
) -> Result<(DocCommand, bool), AppError> {
    let mut slots = Vec::with_capacity(rasters.len());
    let mut pages = BTreeSet::new();
    for raster in rasters {
        let slot = state
            .slot(raster.page_id)
            .filter(|slot| slot.rev == raster.rev)
            .ok_or(AppError::invalid("redaction"))?;
        if !pages.insert(raster.page_id.get()) {
            return Err(AppError::invalid("redaction"));
        }
        slots.push(PageSlot {
            source: PageSource::Redacted {
                bytes: raster.bytes.clone(),
            },
            engine_index: raster.engine_index,
            // The raster page is the shown box, from the origin: the page keeps its size and has no crop of the file's.
            media: [0.0, 0.0, slot.size[0], slot.size[1]],
            crop: None,
            saved_crop: None,
            ..slot.clone()
        });
    }
    let mut dropped = false;
    let mut entries: Vec<Slot> = Vec::new();
    for (id, entry) in &state.entries {
        if !pages.contains(&entry.annotation.page_id.get()) {
            continue;
        }
        let body = &entry.annotation.body;
        if !body.is_redact_mark()
            && (entry.tombstone || entry.annotation.sync != AnnotSync::Clean || body.is_content())
        {
            dropped = true;
        }
        entries.push((*id, None));
    }
    Ok((
        DocCommand::RestoreRedaction {
            slots,
            entries,
            strip: remove_metadata.then_some(true),
        },
        dropped,
    ))
}

/// Runs [`DocCommand::RestoreRedaction`]: puts `slots` in place of the pages with the same ids (each gets a `rev` past the one it has),
/// sets the entries, and sets the staged metadata removal if `strip` says. Returns the command that undoes it, which is of the same
/// kind. Nothing changes if a page is not there.
pub(crate) fn restore(
    state: &mut DocState,
    slots: &[PageSlot],
    entries: &[Slot],
    strip: Option<bool>,
    delta: &mut Delta,
) -> Result<DocCommand, AppError> {
    let mut seen = HashSet::new();
    for slot in slots {
        if state.slot(slot.id).is_none() || !seen.insert(slot.id.get()) {
            return Err(AppError::invalid("page"));
        }
    }
    let mut before = Vec::with_capacity(slots.len());
    for slot in slots {
        let Some(position) = state.position(slot.id) else {
            continue;
        };
        let place = &mut state.pages[position as usize];
        before.push(place.clone());
        let rev = place.rev.wrapping_add(1);
        *place = PageSlot {
            rev,
            ..slot.clone()
        };
        delta
            .engine_rotations
            .push((place.engine_index, place.rotation));
    }
    delta.pages = true;
    let inverse_entries = state.set_slots(entries.to_vec(), delta);
    let inverse_strip = strip.map(|value| {
        let old = state.metadata().strip;
        state.metadata_mut().strip = value;
        delta.doc.insert(DocPart::Metadata);
        old
    });
    Ok(DocCommand::RestoreRedaction {
        slots: before,
        entries: inverse_entries,
        strip: inverse_strip,
    })
}

/// A mark draft for the tests of other modules.
#[cfg(test)]
pub(crate) fn test_draft(page: u32, x: f32) -> super::annotation::AnnotationDraft {
    serde_json::from_value(serde_json::json!({
        "pageId": page, "kind": "redactMark", "color": [0, 0, 0], "source": "area",
        "quads": [[{"x": x, "y": 10.0}, {"x": x + 20.0, "y": 10.0}, {"x": x, "y": 20.0}, {"x": x + 20.0, "y": 20.0}]]
    }))
    .unwrap_or_else(|_| unreachable!())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::error::ErrorCode;
    use crate::model::doc_state::Stamp;

    fn stamp() -> Stamp {
        Stamp {
            now_ms: 0,
            modified: "t".into(),
        }
    }

    fn cmd(value: serde_json::Value) -> DocCommand {
        serde_json::from_value(value).unwrap()
    }

    fn mark_cmd(page: u32, count: usize) -> DocCommand {
        let quad =
            json!([{"x":1.0,"y":2.0},{"x":11.0,"y":2.0},{"x":1.0,"y":9.0},{"x":11.0,"y":9.0}]);
        let marks: Vec<_> = (0..count)
            .map(|_| json!({"pageId": page, "quads": [quad], "source": "text"}))
            .collect();
        cmd(json!({"type": "markRedactions", "marks": marks}))
    }

    fn raster(state: &DocState, page: u32, engine_index: u32) -> Raster {
        let slot = state.slot(PageId::new(page)).unwrap();
        Raster {
            page_id: slot.id,
            rev: slot.rev,
            engine_index,
            bytes: Arc::from(vec![1u8, 2, 3]),
        }
    }

    #[test]
    fn marks_are_one_step_that_undo_and_redo_take_back_and_bring_again() {
        let mut state = DocState::new(2);
        let done = state.execute(mark_cmd(0, 3), &stamp()).unwrap();
        assert_eq!(done.upserted.len(), 3);
        assert!(done.upserted.iter().all(|a| a.body.is_redact_mark()));
        assert_eq!(done.history.undo_label.as_deref(), Some("redact.mark"));
        assert_eq!(state.list(PageId::new(0)).len(), 3);
        let undone = state.undo(&stamp()).unwrap();
        assert_eq!(undone.removed.len(), 3);
        assert!(state.list(PageId::new(0)).is_empty());
        state.redo(&stamp()).unwrap();
        assert_eq!(state.list(PageId::new(0)).len(), 3);
    }

    #[test]
    fn ten_thousand_marks_are_one_step_and_a_bad_mark_adds_none() {
        let mut state = DocState::new(1);
        state.execute(mark_cmd(0, 10_000), &stamp()).unwrap();
        assert_eq!(marks_in(&state), 10_000);
        assert_eq!(
            state.history_state().undo_label.as_deref(),
            Some("redact.mark")
        );
        // A second batch of 10 001 is over the command limit; 10 000 more fit the document budget exactly.
        assert!(state.execute(mark_cmd(0, 10_001), &stamp()).is_err());
        state.execute(mark_cmd(0, 10_000), &stamp()).unwrap();
        let over = state.execute(mark_cmd(0, 1), &stamp()).unwrap_err();
        assert_eq!(over.code(), ErrorCode::LimitExceeded);
        state.undo(&stamp()).unwrap();
        assert_eq!(marks_in(&state), 10_000);

        let mut other = DocState::new(1);
        let bad = cmd(json!({"type": "markRedactions", "marks": [
            {"pageId": 0, "quads": [[{"x":0,"y":0},{"x":1,"y":0},{"x":0,"y":1},{"x":1,"y":1}]], "source": "area"},
            {"pageId": 0, "quads": [], "source": "area"}
        ]}));
        assert_eq!(
            other.execute(bad, &stamp()).unwrap_err().code(),
            ErrorCode::InvalidArgument
        );
        assert_eq!(marks_in(&other), 0);
        let gone = mark_cmd(5, 1);
        assert_eq!(
            other.execute(gone, &stamp()).unwrap_err().code(),
            ErrorCode::InvalidArgument
        );
    }

    #[test]
    fn a_mark_has_at_most_512_quads() {
        let quad =
            json!([{"x":1.0,"y":2.0},{"x":11.0,"y":2.0},{"x":1.0,"y":9.0},{"x":11.0,"y":9.0}]);
        let many: Vec<_> = (0..513).map(|_| quad.clone()).collect();
        let mut state = DocState::new(1);
        let result = state.execute(
            cmd(json!({"type": "markRedactions", "marks": [{"pageId": 0, "quads": many, "source": "text"}]})),
            &stamp(),
        );
        assert!(result.is_err());
        assert!(check_mark(&test_draft(0, 1.0).body).is_ok());
    }

    #[test]
    fn quads_must_be_finite_and_within_the_page_range_and_512_fit() {
        use crate::model::geometry::Point;
        let spec = |x: f32, count: usize| MarkSpec {
            page_id: PageId::new(0),
            quads: vec![
                [
                    Point { x, y: 1.0 },
                    Point { x: 2.0, y: 1.0 },
                    Point { x: 1.0, y: 2.0 },
                    Point { x: 2.0, y: 2.0 },
                ];
                count
            ],
            source: RedactSource::Text,
        };
        for bad in [f32::NAN, f32::INFINITY, 1.0e9, -1.0e9] {
            let mut state = DocState::new(1);
            let command = DocCommand::MarkRedactions {
                marks: vec![spec(bad, 1)],
            };
            assert_eq!(
                state.execute(command, &stamp()).unwrap_err().code(),
                ErrorCode::InvalidArgument,
                "{bad}"
            );
            assert_eq!(marks_in(&state), 0);
        }
        let mut state = DocState::new(1);
        let ok = DocCommand::MarkRedactions {
            marks: vec![spec(1.0, 512)],
        };
        state.execute(ok, &stamp()).unwrap();
        let over = DocCommand::MarkRedactions {
            marks: vec![spec(1.0, 513)],
        };
        assert!(state.execute(over, &stamp()).is_err());
        assert_eq!(marks_in(&state), 1);
    }

    #[test]
    fn the_snapshot_holds_the_pages_with_marks_and_a_rect_for_each_quad() {
        let mut state = DocState::new(3);
        state.execute(mark_cmd(2, 2), &stamp()).unwrap();
        state.execute(mark_cmd(0, 1), &stamp()).unwrap();
        let work = snapshot(&state, None).unwrap();
        let ids: Vec<u32> = work.iter().map(|w| w.page_id.get()).collect();
        assert_eq!(ids, [0, 2], "in the order of the document");
        assert_eq!(work[1].burn.len(), 2);
        assert_eq!(
            work[0].burn[0],
            Rect {
                x: 1.0,
                y: 2.0,
                w: 10.0,
                h: 7.0
            }
        );
        let only = snapshot(&state, Some(&[PageId::new(2), PageId::new(1)])).unwrap();
        assert_eq!(only.len(), 1, "a listed page without a mark is left out");
        assert!(snapshot(&state, Some(&[PageId::new(1)])).is_err());
        assert!(snapshot(&state, Some(&[PageId::new(9)])).is_err());
        assert!(snapshot(&state, Some(&[PageId::new(0), PageId::new(0)])).is_err());
        assert!(snapshot(&DocState::new(1), None).is_err(), "nothing marked");
    }

    #[test]
    fn applying_swaps_the_slot_drops_the_annotations_and_undo_restores_everything() {
        let mut state = DocState::new(2);
        state.execute(mark_cmd(0, 1), &stamp()).unwrap();
        let note: DocCommand = cmd(json!({"type": "createAnnotation", "draft": {
            "pageId": 0, "kind": "highlight", "color": [255, 235, 0],
            "quads": [[{"x":1.0,"y":2.0},{"x":11.0,"y":2.0},{"x":1.0,"y":9.0},{"x":11.0,"y":9.0}]]
        }}));
        state.execute(note, &stamp()).unwrap();
        state.execute(mark_cmd(1, 1), &stamp()).unwrap();
        let before = state.slot(PageId::new(0)).unwrap().clone();

        let (command, dropped) = plan(&state, &[raster(&state, 0, 7)], true).unwrap();
        assert!(dropped, "the highlight was made in this session");
        let changes = state.execute(command, &stamp()).unwrap();
        assert_eq!(changes.history.undo_label.as_deref(), Some("redact.apply"));
        let slot = state.slot(PageId::new(0)).unwrap();
        assert!(matches!(slot.source, PageSource::Redacted { .. }));
        assert_eq!((slot.id, slot.engine_index), (PageId::new(0), 7));
        assert_eq!(slot.rev, before.rev + 1);
        assert_eq!(slot.crop, None);
        assert!(state.list(PageId::new(0)).is_empty());
        assert_eq!(
            state.list(PageId::new(1)).len(),
            1,
            "other pages keep theirs"
        );
        assert!(state.metadata().strip);
        assert!(changes.pages.is_some());
        assert!(changes.doc.contains(&DocPart::Metadata));
        assert_eq!(changes.removed.len(), 2);
        assert!(state.page_plan().redacted);

        state.undo(&stamp()).unwrap();
        let back = state.slot(PageId::new(0)).unwrap();
        assert_eq!(back.source, before.source);
        assert_eq!(back.engine_index, before.engine_index);
        assert!(back.rev > slot_rev_after_apply(&before));
        assert_eq!(state.list(PageId::new(0)).len(), 2);
        assert!(!state.metadata().strip);

        state.redo(&stamp()).unwrap();
        assert!(matches!(
            state.slot(PageId::new(0)).unwrap().source,
            PageSource::Redacted { .. }
        ));
        assert!(state.list(PageId::new(0)).is_empty());
    }

    #[test]
    fn a_redacted_slot_takes_the_box_of_its_raster_page() {
        let mut state = DocState::new(1);
        state
            .execute(
                cmd(json!({"type": "cropPages", "pages": [0], "spec":
                    {"type": "margins", "top": 5.0, "right": 6.0, "bottom": 7.0, "left": 8.0}})),
                &stamp(),
            )
            .unwrap();
        let before = state.slot(PageId::new(0)).unwrap().clone();
        assert!(before.crop.is_some());
        state.execute(mark_cmd(0, 1), &stamp()).unwrap();
        let (command, _) = plan(&state, &[raster(&state, 0, 3)], false).unwrap();
        state.execute(command, &stamp()).unwrap();
        let slot = state.slot(PageId::new(0)).unwrap();
        assert_eq!(slot.media, [0.0, 0.0, slot.size[0], slot.size[1]]);
        assert_eq!((slot.crop, slot.saved_crop), (None, None));
        assert_eq!(slot.size, before.size);
    }

    fn slot_rev_after_apply(before: &PageSlot) -> u32 {
        before.rev + 1
    }

    #[test]
    fn a_page_that_changed_while_the_job_ran_fails_the_step() {
        let mut state = DocState::new(1);
        state.execute(mark_cmd(0, 1), &stamp()).unwrap();
        let stale = raster(&state, 0, 4);
        state
            .execute(
                cmd(json!({"type": "rotatePages", "pages": [0], "quarterTurns": 1})),
                &stamp(),
            )
            .unwrap();
        let error = plan(&state, &[stale], false).unwrap_err();
        assert_eq!(error.code(), ErrorCode::InvalidArgument);
        let twice = [raster(&state, 0, 4), raster(&state, 0, 5)];
        assert!(plan(&state, &twice, false).is_err());
    }

    #[test]
    fn marks_alone_are_not_unsaved_edits() {
        let mut state = DocState::new(1);
        state.execute(mark_cmd(0, 2), &stamp()).unwrap();
        let (_, dropped) = plan(&state, &[raster(&state, 0, 1)], false).unwrap();
        assert!(!dropped);
    }
}
