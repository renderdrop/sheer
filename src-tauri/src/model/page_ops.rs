//! What the page commands do to a [`DocState`] (ADR-036 §2): rotate, delete, move, insert, and the internal steps that undo them.
//!
//! Every function validates before it changes anything and returns the exact inverse as a [`DocCommand`]: rotating sets absolute
//! rotations back, deleting is undone by restoring the slots at their old positions together with the annotations they carried, a move by
//! putting the old order back, an insert by removing the new pages. Undo applies the inverse, whose own inverse is the redo, so
//! ids and positions come back as they were.

use std::collections::{HashMap, HashSet};

use serde::Deserialize;

use super::annotation::AnnotationBody;
use super::command::DocCommand;
use super::doc_state::{Delta, DocState, Entry, Slot};
use super::page::{
    normalize_rotation, BoxesRead, NewPage, PageSlot, PageSlotInfo, PageSource, SourceId, A4_PT,
};
use crate::documents::PageId;
use crate::error::AppError;
use crate::limits;

/// How `CropPages` crops (ADR-047 §2): margins in points, in page space before `/Rotate`, measured from each page's MediaBox, or back to
/// the MediaBox.
#[derive(Debug, Clone, PartialEq, Deserialize)]
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
    /// Puts these crops back (`None`: no crop). Internal: the inverse of a crop; not accepted from the UI.
    #[serde(skip_deserializing)]
    Restore {
        crops: Vec<(PageId, Option<[f32; 4]>)>,
    },
}

/// What a point of page space moves by when a page's box (user space `[x0, y0, x1, y1]`) goes from `from` to `to`: page space has its
/// origin at the top left corner of the box and y pointing down.
fn origin_shift(from: [f32; 4], to: [f32; 4]) -> (f32, f32) {
    (from[0] - to[0], to[3] - from[3])
}

/// The crop that leaves `margins` (`[top, right, bottom, left]`) of `media` out: `None` for margins that leave the MediaBox whole.
/// `invalid_argument` (`crop`) for a margin that is not a number or is negative (outside the MediaBox) and for less than 72 x 72 pt left.
fn margin_crop(media: [f32; 4], margins: [f32; 4]) -> Result<Option<[f32; 4]>, AppError> {
    let [top, right, bottom, left] = margins;
    if margins
        .iter()
        .any(|m| !m.is_finite() || *m < 0.0 || *m > limits::MAX_PAGE_SIDE_PT)
    {
        return Err(AppError::invalid("crop"));
    }
    let crop = [
        media[0] + left,
        media[1] + bottom,
        media[2] - right,
        media[3] - top,
    ];
    // 0.001 pt of slack: margins that add up to exactly the largest allowed crop (a page 72 pt wide) are sums of f32 and can land a
    // rounding error below 72; that is not a refusal worth making. Anything visibly smaller still is.
    let slack = 0.001;
    if crop[2] - crop[0] < limits::MIN_CROP_SIDE_PT - slack
        || crop[3] - crop[1] < limits::MIN_CROP_SIDE_PT - slack
    {
        return Err(AppError::invalid("crop"));
    }
    Ok((crop != media).then_some(crop))
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

/// Whether the labels of a file say more than the page number: PDFium answers "1", "2", ... for a file without `/PageLabels`, and a
/// label that is only the original number would be wrong once pages are moved.
fn has_real_labels(labels: &[Option<String>]) -> bool {
    labels
        .iter()
        .enumerate()
        .any(|(i, l)| l.as_deref().is_some_and(|l| l != (i + 1).to_string()))
}

impl DocState {
    /// The pages in order.
    pub fn pages(&self) -> &[PageSlot] {
        &self.pages
    }

    /// What the UI is told about the pages, in order.
    pub fn page_infos(&self) -> Vec<PageSlotInfo> {
        let labels = self.page_labels.as_deref().filter(|l| has_real_labels(l));
        self.pages
            .iter()
            .map(|slot| {
                let mut info = slot.info();
                if let (Some(labels), PageSource::File { index }) = (labels, &slot.source) {
                    info.label = usize::try_from(*index)
                        .ok()
                        .and_then(|i| labels.get(i))
                        .and_then(|label| label.clone())
                        .filter(|label| !label.trim().is_empty());
                }
                info
            })
            .collect()
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
    /// (the old crops; applying them shifts everything back). The engine mirrors it afterwards (`Delta::engine_crops`, `Job::SetCropBox`).
    pub(super) fn crop_pages(
        &mut self,
        pages: &[PageId],
        spec: &CropSpec,
        delta: &mut Delta,
    ) -> Result<DocCommand, AppError> {
        let positions = self.positions(pages)?;
        let restore: HashMap<u32, Option<[f32; 4]>> = match spec {
            CropSpec::Restore { crops } => {
                crops.iter().map(|(id, crop)| (id.get(), *crop)).collect()
            }
            _ => HashMap::new(),
        };
        // Everything is checked and made before the first change, so a refused page changes nothing.
        let mut steps: Vec<(usize, Option<[f32; 4]>)> = Vec::with_capacity(positions.len());
        for &position in &positions {
            let slot = &self.pages[position];
            let crop = match spec {
                CropSpec::Reset => None,
                CropSpec::Margins {
                    top,
                    right,
                    bottom,
                    left,
                } => margin_crop(slot.media, [*top, *right, *bottom, *left])?,
                CropSpec::Restore { .. } => *restore
                    .get(&slot.id.get())
                    .ok_or(AppError::invalid("crop"))?,
            };
            steps.push((position, crop));
        }
        let mut shifts: HashMap<u32, (f32, f32)> = HashMap::new();
        for (position, crop) in &steps {
            let slot = &self.pages[*position];
            let shift = origin_shift(slot.shown_box(), crop.unwrap_or(slot.media));
            if shift != (0.0, 0.0) {
                shifts.insert(slot.id.get(), shift);
            }
        }
        let mut moved: Vec<Slot> = Vec::new();
        for (id, entry) in &self.entries {
            let Some(&(dx, dy)) = shifts.get(&entry.annotation.page_id.get()) else {
                continue;
            };
            if entry.tombstone {
                continue;
            }
            let old = &entry.annotation;
            let mut next = old.moved(dx, dy, "")?;
            next.modified.clone_from(&old.modified);
            next.sync = old.sync;
            if matches!(next.body, AnnotationBody::Opaque { .. }) {
                next.rect.x += dx;
                next.rect.y += dy;
            }
            moved.push((
                *id,
                Some(Entry {
                    annotation: next,
                    ..entry.clone()
                }),
            ));
        }

        self.set_slots(moved, delta);
        let mut before = Vec::with_capacity(steps.len());
        for (position, crop) in steps {
            let slot = &mut self.pages[position];
            before.push((slot.id, slot.crop));
            if let (Some(&(dx, dy)), PageSource::File { index }) =
                (shifts.get(&slot.id.get()), &slot.source)
            {
                if let Some(form) = &mut self.form {
                    form.shift_widgets(*index, dx, dy);
                }
            }
            slot.crop = crop;
            let shown = slot.shown_box();
            slot.size = limits::sanitize_page_size(shown[2] - shown[0], shown[3] - shown[1]);
            slot.rev = slot.rev.wrapping_add(1);
            delta.engine_crops.push((slot.engine_index, shown));
        }
        delta.pages = true;
        Ok(DocCommand::CropPages {
            pages: before.iter().map(|(id, _)| *id).collect(),
            spec: CropSpec::Restore { crops: before },
        })
    }

    /// The box each of the engine pages `engine_indices` shows in the model now (`(engine index, [x0, y0, x1, y1])`): what the engine's copy
    /// is set back to when it could not follow a crop.
    pub fn crop_mirror(&self, engine_indices: impl Iterator<Item = u32>) -> Vec<(u32, [f32; 4])> {
        let by_engine: HashMap<u32, [f32; 4]> = self
            .pages
            .iter()
            .map(|slot| (slot.engine_index, slot.shown_box()))
            .collect();
        engine_indices
            .filter_map(|index| by_engine.get(&index).map(|shown| (index, *shown)))
            .collect()
    }

    /// Takes what the engine read about the boxes of the pages of the file when the document was loaded (by file page): the MediaBox,
    /// and the CropBox the file has, which is the crop the file has. Only used while the model is made.
    pub fn set_boxes(&mut self, boxes: &[Option<BoxesRead>]) {
        for slot in &mut self.pages {
            let PageSource::File { index } = slot.source else {
                continue;
            };
            let Some(read) = usize::try_from(index)
                .ok()
                .and_then(|at| boxes.get(at).copied().flatten())
            else {
                continue;
            };
            let (media, crop) = read.sanitized(slot.media);
            slot.media = media;
            slot.crop = crop;
            slot.saved_crop = crop;
        }
    }

    /// The form was read from the file, whose widgets are in the page space of the file's crops: moves them to the space of the crops
    /// the session has now.
    pub(super) fn align_widgets_to_crops(&mut self) {
        let Some(form) = &mut self.form else { return };
        for slot in &self.pages {
            let PageSource::File { index } = slot.source else {
                continue;
            };
            if slot.crop != slot.saved_crop {
                let from = slot.saved_crop.unwrap_or(slot.media);
                let (dx, dy) = origin_shift(from, slot.shown_box());
                form.shift_widgets(index, dx, dy);
            }
        }
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
                        media: page.media,
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
    use crate::model::page::BoxesRead;

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
    fn crop_json(page: u32, top: f32, right: f32, bottom: f32, left: f32) -> serde_json::Value {
        json!({"type": "cropPages", "pages": [page], "spec": {
            "type": "margins", "top": top, "right": right, "bottom": bottom, "left": left
        }})
    }

    fn note_at(state: &DocState, page: u32) -> (f32, f32) {
        let list = state.list(PageId::new(page));
        match &list[0].body {
            crate::model::annotation::AnnotationBody::Note { at, .. } => (at.x, at.y),
            other => panic!("not a note: {other:?}"),
        }
    }

    #[test]
    fn a_crop_is_one_undo_step_that_moves_the_page_origin_and_everything_on_it() {
        let mut state = DocState::new(2);
        let [w, h] = state.pages()[0].size;
        run(
            &mut state,
            json!({"type": "createAnnotation", "draft": {
                "pageId": 0, "kind": "note", "color": [1, 2, 3],
                "at": {"x": 100.0, "y": 100.0}, "icon": "note", "contents": "x"
            }}),
        )
        .unwrap();
        run(&mut state, crop_json(0, 30.0, 20.0, 10.0, 50.0)).unwrap();
        assert_eq!(
            state.history_state().undo_label.as_deref(),
            Some("page.crop")
        );
        let slot = state.slot(PageId::new(0)).unwrap();
        assert_eq!(slot.crop, Some([50.0, 10.0, w - 20.0, h - 30.0]));
        assert_eq!(slot.size, [w - 70.0, h - 40.0]);
        assert_eq!(slot.rev, 1);
        assert_eq!(note_at(&state, 0), (50.0, 70.0));
        assert_eq!(
            state.slot(PageId::new(1)).unwrap().crop,
            None,
            "other pages stay"
        );
        assert!(state.page_plan().crop_changed);
        // Margins are measured from the MediaBox, not from the crop before.
        run(&mut state, crop_json(0, 0.0, 0.0, 0.0, 10.0)).unwrap();
        assert_eq!(
            state.slot(PageId::new(0)).unwrap().crop,
            Some([10.0, 0.0, w, h])
        );
        assert_eq!(note_at(&state, 0), (90.0, 100.0));
        state.undo(&stamp()).unwrap();
        assert_eq!(note_at(&state, 0), (50.0, 70.0));
        state.undo(&stamp()).unwrap();
        let slot = state.slot(PageId::new(0)).unwrap();
        assert_eq!((slot.crop, slot.size), (None, [w, h]));
        assert_eq!(note_at(&state, 0), (100.0, 100.0));
        assert!(!state.page_plan().crop_changed);
        let redone = state.redo(&stamp()).unwrap();
        assert_eq!(redone.engine_crops.len(), 1);
        assert_eq!(note_at(&state, 0), (50.0, 70.0));
        assert_eq!(
            state.list(PageId::new(0))[0].sync,
            crate::model::annotation::Sync::New
        );
    }

    #[test]
    fn reset_takes_the_crop_off_and_margins_of_zero_are_no_crop() {
        let mut state = DocState::new(1);
        run(&mut state, crop_json(0, 5.0, 5.0, 5.0, 5.0)).unwrap();
        run(
            &mut state,
            json!({"type": "cropPages", "pages": [0], "spec": {"type": "reset"}}),
        )
        .unwrap();
        assert_eq!(state.slot(PageId::new(0)).unwrap().crop, None);
        run(&mut state, crop_json(0, 0.0, 0.0, 0.0, 0.0)).unwrap();
        assert_eq!(state.slot(PageId::new(0)).unwrap().crop, None);
    }

    #[test]
    fn a_crop_that_leaves_too_little_or_lies_outside_is_refused_and_changes_nothing() {
        let mut state = DocState::new(2);
        let rev = state.rev();
        for bad in [
            crop_json(0, 400.0, 0.0, 400.0, 0.0),
            crop_json(0, 0.0, 300.0, 0.0, 300.0),
            crop_json(0, -1.0, 0.0, 0.0, 0.0),
            crop_json(0, 0.0, 0.0, 0.0, 1e9),
            // The second page is the one that fails: the first is not cropped either.
            json!({"type": "cropPages", "pages": [0, 9], "spec": {"type": "reset"}}),
            // The inverse is internal.
            json!({"type": "cropPages", "pages": [0], "spec": {"type": "restore", "crops": []}}),
        ] {
            assert!(
                serde_json::from_value::<DocCommand>(bad.clone()).map_or(true, |command| {
                    state.execute(command, &stamp()).is_err()
                })
            );
        }
        assert_eq!(state.rev(), rev);
        assert!(state.pages().iter().all(|slot| slot.crop.is_none()));
        // 72 x 72 is the least that is allowed.
        let [w, h] = state.pages()[0].size;
        run(&mut state, crop_json(0, h - 72.0, w - 72.0, 0.0, 0.0)).unwrap();
        assert_eq!(state.slot(PageId::new(0)).unwrap().size, [72.0, 72.0]);
    }

    #[test]
    fn the_boxes_read_at_load_become_media_and_the_files_crop() {
        let mut state = DocState::new(1);
        state.set_boxes(&[Some(BoxesRead {
            media: [10.0, 20.0, 510.0, 720.0],
            crop: Some([60.0, 20.0, 600.0, 700.0]),
        })]);
        let slot = state.slot(PageId::new(0)).unwrap();
        assert_eq!(slot.media, [10.0, 20.0, 510.0, 720.0]);
        assert_eq!(
            slot.crop,
            Some([60.0, 20.0, 510.0, 700.0]),
            "clipped to the MediaBox"
        );
        assert_eq!(slot.crop, slot.saved_crop);
        let info = slot.info();
        assert_eq!(
            info.crop.map(|c| (c.left, c.right, c.top, c.bottom)),
            Some((50.0, 0.0, 20.0, 0.0))
        );
        // Margins count from the MediaBox of the file.
        run(&mut state, crop_json(0, 0.0, 0.0, 0.0, 0.0)).unwrap();
        assert_eq!(state.slot(PageId::new(0)).unwrap().crop, None);
        assert!(
            state.page_plan().crop_changed,
            "the file has a crop this no longer has"
        );
    }
    #[test]
    fn text_boxes_move_with_the_crop_and_come_back_exactly() {
        use crate::model::annotation::AnnotationBody;
        let mut state = DocState::new(1);
        run(
            &mut state,
            json!({"type": "createAnnotation", "draft": {
                "pageId": 0, "kind": "textBox", "color": [20, 40, 160], "opacity": 1.0,
                "box": {"x": 72.0, "y": 100.0, "w": 150.0, "h": 0.0},
                "text": "hello", "font": "serif", "fontSize": 14.0, "align": "left"
            }}),
        )
        .unwrap();
        let at = |state: &DocState| match &state.list(PageId::new(0))[0].body {
            AnnotationBody::TextBox { bounds, .. } => (bounds.x, bounds.y),
            other => panic!("not a text box: {other:?}"),
        };
        assert!(state.list(PageId::new(0))[0].body.is_content());
        run(&mut state, crop_json(0, 30.0, 0.0, 0.0, 50.0)).unwrap();
        assert_eq!(at(&state), (22.0, 70.0));
        state.undo(&stamp()).unwrap();
        assert_eq!(at(&state), (72.0, 100.0));
    }

    #[test]
    fn labels_follow_the_file_pages_and_plain_numbers_are_none() {
        let mut state = DocState::new(3);
        state.page_labels = Some(vec![Some("i".into()), Some("ii".into()), Some("1".into())]);
        let labels: Vec<_> = state.page_infos().into_iter().map(|i| i.label).collect();
        assert_eq!(
            labels,
            vec![
                Some("i".to_owned()),
                Some("ii".to_owned()),
                Some("1".to_owned())
            ]
        );
        state.page_labels = Some(vec![Some("1".into()), Some("2".into()), Some("3".into())]);
        assert!(state.page_infos().iter().all(|i| i.label.is_none()));
        state.page_labels = None;
        assert!(state.page_infos().iter().all(|i| i.label.is_none()));
    }
}
