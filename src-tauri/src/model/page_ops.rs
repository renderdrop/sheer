//! What the page commands do to a [`DocState`] (ADR-036 §2): rotate, delete, move, insert, and the internal steps that undo them.
//!
//! Every function validates before it changes anything and returns the exact inverse as a [`DocCommand`]: rotating sets absolute
//! rotations back, deleting is undone by restoring the slots at their old positions together with the annotations they carried, a move by
//! putting the old order back, an insert by removing the new pages. Undo applies the inverse, whose own inverse is the redo, so
//! ids and positions come back as they were.

use std::collections::{HashMap, HashSet};

use serde::Deserialize;

use super::command::DocCommand;
use super::doc_state::{Delta, DocState, Slot};
use super::page::{
    normalize_rotation, NewPage, PageSlot, PageSlotInfo, PageSource, SourceId, A4_PT,
};
use crate::documents::PageId;
use crate::error::AppError;
use crate::limits;

/// How `CropPages` crops (ADR-047 §2): margins in points, in page space before `/Rotate`, measured from each page's MediaBox, or back to
/// the MediaBox.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum CropSpec {
    Margins {
        top: f32,
        right: f32,
        bottom: f32,
        left: f32,
    },
    Reset,
}

/// One page of the list a save has to write.
#[derive(Debug, Clone, PartialEq)]
pub struct PlanPage {
    pub id: PageId,
    pub source: PageSource,
    /// The page's position in the engine's copy.
    pub engine_index: u32,
    pub rotation: u16,
    pub saved_rotation: u16,
    pub size: [f32; 2],
    /// The MediaBox, the crop now, and the crop the file has (ADR-047 §2).
    pub media: [f32; 4],
    pub crop: Option<[f32; 4]>,
    pub saved_crop: Option<[f32; 4]>,
}

/// The pages a save has to write, in order, and what is different from the file.
#[derive(Debug, Clone, PartialEq)]
pub struct PagePlan {
    pub pages: Vec<PlanPage>,
    /// How many pages the file has now.
    pub file_pages: u32,
    /// Pages were added, removed or moved.
    pub structure_changed: bool,
    /// A page of the file has another rotation than the file says.
    pub rotation_changed: bool,
    /// A page of the file has another crop than the file says.
    pub crop_changed: bool,
    /// A page was replaced by a redacted raster (`PageSource::Redacted`).
    pub redacted: bool,
}

impl PagePlan {
    /// Anything about the pages differs from the file.
    pub fn changed(&self) -> bool {
        self.structure_changed || self.rotation_changed || self.crop_changed || self.redacted
    }

    /// The position in the saved file of file page `engine_index` (`None` if it was deleted).
    pub fn file_position(&self, file_index: u32) -> Option<u32> {
        self.pages
            .iter()
            .position(|page| page.source == PageSource::File { index: file_index })
            .and_then(|position| u32::try_from(position).ok())
    }

    /// The position in the saved file of the page that has engine page `engine_index` and is not a page of the file (`None`: not a
    /// page of the list, or one of the file's).
    pub fn brought_position(&self, engine_index: u32) -> Option<u32> {
        self.pages
            .iter()
            .position(|page| {
                page.engine_index == engine_index && !matches!(page.source, PageSource::File { .. })
            })
            .and_then(|position| u32::try_from(position).ok())
    }

    /// The import sources the list uses.
    pub fn sources(&self) -> Vec<SourceId> {
        let mut used: Vec<SourceId> = self
            .pages
            .iter()
            .filter_map(|page| match page.source {
                PageSource::Imported { source, .. } => Some(source),
                _ => None,
            })
            .collect();
        used.sort();
        used.dedup();
        used
    }
}

impl DocState {
    /// The pages in order.
    pub fn pages(&self) -> &[PageSlot] {
        &self.pages
    }

    /// What the UI is told about the pages, in order.
    pub fn page_infos(&self) -> Vec<PageSlotInfo> {
        self.pages.iter().map(PageSlot::info).collect()
    }

    /// The slot of a page.
    pub fn slot(&self, page: PageId) -> Option<&PageSlot> {
        self.pages.iter().find(|slot| slot.id == page)
    }

    /// Where a page is in the order.
    pub fn position(&self, page: PageId) -> Option<u32> {
        self.pages
            .iter()
            .position(|slot| slot.id == page)
            .and_then(|position| u32::try_from(position).ok())
    }

    /// The size a blank page inserted at `at` gets: the page before it, else the page after it, else A4.
    pub fn blank_size(&self, at: u32) -> [f32; 2] {
        let at = usize::try_from(at)
            .unwrap_or(usize::MAX)
            .min(self.pages.len());
        at.checked_sub(1)
            .and_then(|before| self.pages.get(before))
            .or_else(|| self.pages.get(at))
            .map_or(A4_PT, |slot| slot.size)
    }

    /// Whether `count` pages fit at `at`: `at` is a position in the list (or its end) and the document stays within `MAX_PAGES`. What a
    /// command that has to make the pages in the engine first asks before it does.
    pub fn check_insert(&self, at: u32, count: usize) -> Result<(), AppError> {
        if count == 0 || usize::try_from(at).map_or(true, |at| at > self.pages.len()) {
            return Err(AppError::invalid("at"));
        }
        if count > limits::MAX_INSERT_PAGES {
            return Err(AppError::limit("pages", limits::MAX_INSERT_PAGES as u64));
        }
        if self.pages.len() + count > limits::MAX_PAGES as usize {
            return Err(AppError::limit("pages", u64::from(limits::MAX_PAGES)));
        }
        Ok(())
    }

    /// The rotation each page has in the engine's copy should have, by engine index.
    pub fn engine_rotations(&self) -> HashMap<u32, u16> {
        self.pages
            .iter()
            .map(|slot| (slot.engine_index, slot.rotation))
            .collect()
    }

    /// What a save has to write for the pages.
    pub fn page_plan(&self) -> PagePlan {
        let in_place = |(position, slot): (usize, &PageSlot)| {
            u32::try_from(position)
                .is_ok_and(|position| slot.source == PageSource::File { index: position })
        };
        let structure_changed = self.pages.len() != usize::try_from(self.file_pages).unwrap_or(0)
            || !self.pages.iter().enumerate().all(in_place);
        let rotation_changed = self.pages.iter().any(|slot| {
            matches!(slot.source, PageSource::File { .. }) && slot.rotation != slot.saved_rotation
        });
        let crop_changed = self.pages.iter().any(|slot| slot.crop != slot.saved_crop);
        let redacted = self
            .pages
            .iter()
            .any(|slot| matches!(slot.source, PageSource::Redacted { .. }));
        PagePlan {
            pages: self
                .pages
                .iter()
                .map(|slot| PlanPage {
                    id: slot.id,
                    source: slot.source.clone(),
                    engine_index: slot.engine_index,
                    rotation: slot.rotation,
                    saved_rotation: slot.saved_rotation,
                    size: slot.size,
                    media: slot.media,
                    crop: slot.crop,
                    saved_crop: slot.saved_crop,
                })
                .collect(),
            file_pages: self.file_pages,
            structure_changed,
            rotation_changed,
            crop_changed,
            redacted,
        }
    }

    /// The positions of `pages`, ascending. The list must be non-empty, unique and every page must exist.
    fn positions(&self, pages: &[PageId]) -> Result<Vec<usize>, AppError> {
        if pages.is_empty() {
            return Err(AppError::invalid("pages"));
        }
        if pages.len() > limits::MAX_PAGES as usize {
            return Err(AppError::limit("pages", u64::from(limits::MAX_PAGES)));
        }
        let index: HashMap<u32, usize> = self
            .pages
            .iter()
            .enumerate()
            .map(|(position, slot)| (slot.id.get(), position))
            .collect();
        let mut seen = HashSet::with_capacity(pages.len());
        let mut positions = Vec::with_capacity(pages.len());
        for page in pages {
            let position = *index.get(&page.get()).ok_or(AppError::invalid("page"))?;
            if !seen.insert(position) {
                return Err(AppError::invalid("pages"));
            }
            positions.push(position);
        }
        positions.sort_unstable();
        Ok(positions)
    }

    /// Rotates the pages by `turns` quarter turns clockwise.
    pub(super) fn rotate_pages(
        &mut self,
        pages: &[PageId],
        turns: i8,
        delta: &mut Delta,
    ) -> Result<DocCommand, AppError> {
        if !matches!(turns, -1 | 1 | 2) {
            return Err(AppError::invalid("quarterTurns"));
        }
        let positions = self.positions(pages)?;
        let mut before = Vec::with_capacity(positions.len());
        for position in positions {
            let slot = &mut self.pages[position];
            before.push((slot.id, slot.rotation));
            slot.rotation = normalize_rotation(i64::from(slot.rotation) + 90 * i64::from(turns));
            slot.rev = slot.rev.wrapping_add(1);
            delta
                .engine_rotations
                .push((slot.engine_index, slot.rotation));
        }
        delta.pages = true;
        Ok(DocCommand::SetRotations { rotations: before })
    }

    /// Crops pages (ADR-047 §2): validates every page first (at least 72 x 72 pt left, inside the MediaBox), sets the crops, shifts the
    /// annotations, content objects and form widget rects of those pages by the origin change in the same step, and returns the inverse
    /// (the old crops and the reverse shift). The engine mirrors it afterwards (`Job::SetCropBox`, `commands::pages`). Package B.
    pub(super) fn crop_pages(
        &mut self,
        _pages: &[PageId],
        _spec: &CropSpec,
        _delta: &mut Delta,
    ) -> Result<DocCommand, AppError> {
        Err(AppError::not_yet())
    }

    /// Sets the rotation of each page to the given value.
    pub(super) fn set_rotations(
        &mut self,
        rotations: &[(PageId, u16)],
        delta: &mut Delta,
    ) -> Result<DocCommand, AppError> {
        let ids: Vec<PageId> = rotations.iter().map(|(page, _)| *page).collect();
        let positions: HashMap<u32, usize> = {
            self.positions(&ids)?;
            self.pages
                .iter()
                .enumerate()
                .map(|(position, slot)| (slot.id.get(), position))
                .collect()
        };
        let mut before = Vec::with_capacity(rotations.len());
        for (page, degrees) in rotations {
            let slot = &mut self.pages[positions[&page.get()]];
            before.push((slot.id, slot.rotation));
            slot.rotation = normalize_rotation(i64::from(*degrees));
            slot.rev = slot.rev.wrapping_add(1);
            delta
                .engine_rotations
                .push((slot.engine_index, slot.rotation));
        }
        delta.pages = true;
        Ok(DocCommand::SetRotations { rotations: before })
    }

    /// Takes the pages out of the list, with their annotations. `keep_one`: refuse to remove every page.
    pub(super) fn remove_pages(
        &mut self,
        pages: &[PageId],
        keep_one: bool,
        delta: &mut Delta,
    ) -> Result<DocCommand, AppError> {
        let positions = self.positions(pages)?;
        if keep_one && positions.len() >= self.pages.len() {
            return Err(AppError::invalid("lastPage"));
        }
        let doomed_ids: HashSet<u32> = positions.iter().map(|&p| self.pages[p].id.get()).collect();
        let annotation_slots: Vec<Slot> = self
            .entries
            .iter()
            .filter(|(_, entry)| doomed_ids.contains(&entry.annotation.page_id.get()))
            .map(|(id, _)| (*id, None))
            .collect();
        let annotations = self.set_slots(annotation_slots, delta);
        let doomed: HashSet<usize> = positions.iter().copied().collect();
        let mut kept = Vec::with_capacity(self.pages.len() - doomed.len());
        let mut removed = Vec::with_capacity(doomed.len());
        for (position, slot) in std::mem::take(&mut self.pages).into_iter().enumerate() {
            if doomed.contains(&position) {
                removed.push((u32::try_from(position).unwrap_or(u32::MAX), slot));
            } else {
                kept.push(slot);
            }
        }
        self.pages = kept;
        delta.pages = true;
        Ok(DocCommand::RestorePages {
            slots: removed,
            annotations,
        })
    }

    /// Puts slots into the list at the positions they will have (ascending), and sets the annotation slots.
    pub(super) fn restore_pages(
        &mut self,
        slots: &[(u32, PageSlot)],
        annotations: &[Slot],
        delta: &mut Delta,
    ) -> Result<DocCommand, AppError> {
        let len = self.pages.len();
        if slots.is_empty() || len.saturating_add(slots.len()) > limits::MAX_PAGES as usize {
            return Err(AppError::limit("pages", u64::from(limits::MAX_PAGES)));
        }
        let present: HashSet<u32> = self.pages.iter().map(|slot| slot.id.get()).collect();
        let mut previous: Option<usize> = None;
        for (k, (position, slot)) in slots.iter().enumerate() {
            let position = usize::try_from(*position).unwrap_or(usize::MAX);
            if previous.is_some_and(|before| position <= before)
                || position > len + k
                || present.contains(&slot.id.get())
            {
                return Err(AppError::invalid("pages"));
            }
            previous = Some(position);
        }
        let mut merged = Vec::with_capacity(len + slots.len());
        let mut old = std::mem::take(&mut self.pages).into_iter();
        for (position, slot) in slots {
            let position = usize::try_from(*position).unwrap_or(usize::MAX);
            while merged.len() < position {
                match old.next() {
                    Some(existing) => merged.push(existing),
                    None => break,
                }
            }
            merged.push(slot.clone());
        }
        merged.extend(old);
        self.pages = merged;
        self.set_slots(annotations.to_vec(), delta);
        delta.pages = true;
        Ok(DocCommand::RemovePages {
            pages: slots.iter().map(|(_, slot)| slot.id).collect(),
        })
    }

    /// Adds new pages (already in the engine's copy) at `at`.
    pub(super) fn insert_pages(
        &mut self,
        at: u32,
        pages: &[NewPage],
        delta: &mut Delta,
    ) -> Result<DocCommand, AppError> {
        let at = usize::try_from(at).unwrap_or(usize::MAX);
        if pages.is_empty() || at > self.pages.len() {
            return Err(AppError::invalid("at"));
        }
        if pages.len() > limits::MAX_INSERT_PAGES {
            return Err(AppError::limit("pages", limits::MAX_INSERT_PAGES as u64));
        }
        if self.pages.len() + pages.len() > limits::MAX_PAGES as usize {
            return Err(AppError::limit("pages", u64::from(limits::MAX_PAGES)));
        }
        let first = self.next_page_id;
        let count = u32::try_from(pages.len()).map_err(|_| AppError::invalid("pages"))?;
        let next = first
            .checked_add(count)
            .ok_or(AppError::limit("pages", u64::from(u32::MAX)))?;
        let slots: Vec<(u32, PageSlot)> = (first..next)
            .zip(pages)
            .enumerate()
            .map(|(k, (id, page))| {
                (
                    u32::try_from(at + k).unwrap_or(u32::MAX),
                    PageSlot {
                        id: PageId::new(id),
                        source: page.source.clone(),
                        engine_index: page.engine_index,
                        rotation: page.rotation,
                        saved_rotation: page.rotation,
                        rev: 0,
                        size: page.size,
                        media: [0.0, 0.0, page.size[0], page.size[1]],
                        crop: None,
                        saved_crop: None,
                    },
                )
            })
            .collect();
        let inverse = self.restore_pages(&slots, &[], delta)?;
        self.next_page_id = next;
        // The annotations an imported page came with join the model as the page's own `clean` ones (new ids; the undo of this step
        // takes them out with the page). A page whose annotations were not read stays unread and is read like any page; a blank page
        // has none.
        for ((_, slot), page) in slots.iter().zip(pages) {
            match (&page.annotations, &slot.source) {
                (Some(items), _) => {
                    self.import_page(slot.id, items);
                }
                (None, &PageSource::Blank) => {
                    self.imported.insert(slot.id.get());
                }
                (None, _) => {}
            }
        }
        Ok(inverse)
    }

    /// Moves the pages, in their current relative order, so that they start at `to_index` of the list without them.
    pub(super) fn move_pages(
        &mut self,
        pages: &[PageId],
        to_index: u32,
        delta: &mut Delta,
    ) -> Result<DocCommand, AppError> {
        let positions = self.positions(pages)?;
        let to_index = usize::try_from(to_index).unwrap_or(usize::MAX);
        if to_index > self.pages.len() - positions.len() {
            return Err(AppError::invalid("toIndex"));
        }
        let before: Vec<PageId> = self.pages.iter().map(|slot| slot.id).collect();
        let moving: HashSet<usize> = positions.iter().copied().collect();
        let mut moved = Vec::with_capacity(positions.len());
        let mut rest = Vec::with_capacity(self.pages.len() - positions.len());
        for (position, slot) in std::mem::take(&mut self.pages).into_iter().enumerate() {
            if moving.contains(&position) {
                moved.push(slot);
            } else {
                rest.push(slot);
            }
        }
        let tail = rest.split_off(to_index);
        rest.extend(moved);
        rest.extend(tail);
        self.pages = rest;
        delta.pages = true;
        Ok(DocCommand::ReorderPages { order: before })
    }

    /// Puts the pages in `order`, which has to name every page once.
    pub(super) fn reorder_pages(
        &mut self,
        order: &[PageId],
        delta: &mut Delta,
    ) -> Result<DocCommand, AppError> {
        let current = self.pages.len();
        let mut index: HashMap<u32, PageSlot> = self
            .pages
            .iter()
            .map(|slot| (slot.id.get(), slot.clone()))
            .collect();
        if order.len() != current {
            return Err(AppError::invalid("order"));
        }
        let mut next = Vec::with_capacity(current);
        for page in order {
            next.push(
                index
                    .remove(&page.get())
                    .ok_or(AppError::invalid("order"))?,
            );
        }
        let before: Vec<PageId> = self.pages.iter().map(|slot| slot.id).collect();
        self.pages = next;
        delta.pages = true;
        Ok(DocCommand::ReorderPages { order: before })
    }
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

    fn run(state: &mut DocState, value: serde_json::Value) -> Result<(), AppError> {
        let command: DocCommand = serde_json::from_value(value).unwrap();
        state.execute(command, &stamp()).map(drop)
    }

    fn order(state: &DocState) -> Vec<u32> {
        state.pages().iter().map(|p| p.id.get()).collect()
    }

    #[test]
    fn move_delete_and_undo_restore_ids_and_positions() {
        let mut state = DocState::new(4);
        run(
            &mut state,
            json!({"type": "movePages", "pages": [3, 1], "toIndex": 1}),
        )
        .unwrap();
        assert_eq!(order(&state), [0, 1, 3, 2]);
        run(&mut state, json!({"type": "deletePages", "pages": [0, 3]})).unwrap();
        assert_eq!(order(&state), [1, 2]);
        state.undo(&stamp()).unwrap();
        assert_eq!(order(&state), [0, 1, 3, 2]);
        state.undo(&stamp()).unwrap();
        assert_eq!(order(&state), [0, 1, 2, 3]);
        state.redo(&stamp()).unwrap();
        state.redo(&stamp()).unwrap();
        assert_eq!(order(&state), [1, 2]);
    }

    #[test]
    fn the_last_page_stays_and_bad_lists_are_refused() {
        let mut state = DocState::new(2);
        for bad in [
            json!({"type": "deletePages", "pages": [0, 1]}),
            json!({"type": "deletePages", "pages": [0, 0]}),
            json!({"type": "deletePages", "pages": [9]}),
            json!({"type": "movePages", "pages": [0], "toIndex": 2}),
            json!({"type": "rotatePages", "pages": [0], "quarterTurns": 3}),
        ] {
            assert_eq!(
                run(&mut state, bad).unwrap_err().code(),
                ErrorCode::InvalidArgument
            );
        }
        assert_eq!(state.rev(), 0);
    }

    #[test]
    fn rotation_is_undone_exactly_and_deleting_takes_annotations_along() {
        let mut state = DocState::new(2);
        run(
            &mut state,
            json!({"type": "rotatePages", "pages": [1], "quarterTurns": -1}),
        )
        .unwrap();
        assert_eq!(state.pages()[1].rotation, 270);
        run(
            &mut state,
            json!({"type": "createAnnotation", "draft": {
                "pageId": 1, "kind": "note", "color": [1, 2, 3],
                "at": {"x": 1.0, "y": 1.0}, "icon": "note", "contents": "x"
            }}),
        )
        .unwrap();
        run(&mut state, json!({"type": "deletePages", "pages": [1]})).unwrap();
        assert!(state.list(PageId::new(1)).is_empty());
        assert!(run(
            &mut state,
            json!({"type": "rotatePages", "pages": [1], "quarterTurns": 1})
        )
        .is_err());
        state.undo(&stamp()).unwrap();
        assert_eq!(state.list(PageId::new(1)).len(), 1);
        state.undo(&stamp()).unwrap();
        state.undo(&stamp()).unwrap();
        assert_eq!(state.pages()[1].rotation, 0);
    }

    #[test]
    fn the_plan_says_what_differs_from_the_file() {
        let mut state = DocState::new(3);
        assert!(!state.page_plan().changed());
        run(
            &mut state,
            json!({"type": "rotatePages", "pages": [0], "quarterTurns": 2}),
        )
        .unwrap();
        let plan = state.page_plan();
        assert!(plan.rotation_changed && !plan.structure_changed);
        run(
            &mut state,
            json!({"type": "movePages", "pages": [0], "toIndex": 2}),
        )
        .unwrap();
        assert!(state.page_plan().structure_changed);
        assert_eq!(state.page_plan().file_position(0), Some(2));
    }
}
