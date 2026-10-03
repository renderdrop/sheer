//! The incremental update (ADR-004 §1, steps 3 and 4): the original bytes stay as they are, and a new section follows them with the
//! annotation dictionaries and appearance streams that changed, the `/Annots` arrays that name them, a cross-reference section and a
//! trailer. A signature over the original bytes stays valid; earlier revisions stay recoverable.
//!
//! Where an annotation is in the file is a position among the page's `/Annots` entries that are dictionaries and not popups (what
//! PDFium counts, and so what `PdfOrigin::annot_index` is). A deleted annotation leaves its object where it was (nothing is
//! overwritten); it only stops being listed.

use std::collections::{BTreeMap, HashMap, HashSet};

use lopdf::{Dictionary, Document, IncrementalDocument, Object, ObjectId};

use super::annots::{self, Links};
use super::coords::page_mapper;
use crate::error::{AppError, ErrorCode};
use crate::limits;
use crate::model::annotation::{Annotation, PdfOrigin};
use crate::model::ids::AnnotId;

/// One thing to do to the file.
#[derive(Debug, Clone)]
pub enum Change {
    /// Write `annotation` on page `page_index`: over the annotation at `origin` if it is in the file, else as a new one.
    Write {
        page_index: u32,
        annotation: Box<Annotation>,
        origin: Option<PdfOrigin>,
    },
    /// Take the annotation at `origin` out of the page.
    Delete { id: AnnotId, origin: PdfOrigin },
}

/// What to save: the changes, and where every other annotation of the model is in the file (clean ones keep their position
/// from changing under them, and a reply finds its parent).
#[derive(Debug, Clone, Default)]
pub struct Plan {
    pub changes: Vec<Change>,
    pub known: Vec<(AnnotId, PdfOrigin)>,
}

/// The saved file, and where every annotation of the plan is in it.
#[derive(Debug)]
pub struct Built {
    /// The original followed by the update; the original itself if there was nothing to write.
    pub bytes: Vec<u8>,
    pub origins: Vec<(AnnotId, PdfOrigin)>,
    pub pages: u32,
}

fn failed(detail: impl std::fmt::Display) -> AppError {
    AppError::logged(ErrorCode::SaveFailed, detail)
}

fn lopdf_error(error: impl std::fmt::Display) -> AppError {
    failed(format!("lopdf: {error}"))
}

/// Whether the dictionary is a popup annotation (PDFium does not list those, it makes its own).
fn is_popup(dict: &Dictionary) -> bool {
    dict.get(b"Subtype")
        .and_then(Object::as_name)
        .is_ok_and(|subtype| subtype == b"Popup")
}

fn name_of(dict: &Dictionary) -> Option<Vec<u8>> {
    match dict.get(b"NM") {
        Ok(Object::String(bytes, _)) => Some(bytes.clone()),
        _ => None,
    }
}

/// What the page's `/Annots` is made of.
struct Slots {
    /// Where the array is when it is an object of its own.
    holder: Option<ObjectId>,
    /// The entries, `None` once taken out.
    entries: Vec<Option<Object>>,
    /// The entry index of each counted annotation, in order.
    counted: Vec<usize>,
    /// The same, to ask whether an entry is one.
    counted_set: HashSet<usize>,
}

impl Slots {
    fn read(doc: &Document, page: &Dictionary) -> Result<Self, AppError> {
        let (holder, entries) = match page.get(b"Annots") {
            Ok(Object::Reference(id)) => {
                let array = doc
                    .get_object(*id)
                    .and_then(Object::as_array)
                    .map_err(lopdf_error)?;
                (Some(*id), array.clone())
            }
            Ok(Object::Array(array)) => (None, array.clone()),
            _ => (None, Vec::new()),
        };
        if entries.len() > limits::MAX_ANNOTS_ARRAY {
            return Err(AppError::limit(
                "annotations",
                limits::MAX_ANNOTS_ARRAY as u64,
            ));
        }
        let mut slots = Self {
            holder,
            entries: entries.into_iter().map(Some).collect(),
            counted: Vec::new(),
            counted_set: HashSet::new(),
        };
        slots.counted = (0..slots.entries.len())
            .filter(|&index| slots.dict_at(doc, index).is_some_and(|d| !is_popup(d)))
            .collect();
        slots.counted_set = slots.counted.iter().copied().collect();
        Ok(slots)
    }

    /// The dictionary entry `index` stands for, in the original file.
    fn dict_at<'a>(&'a self, doc: &'a Document, index: usize) -> Option<&'a Dictionary> {
        let entry = self.entries.get(index)?.as_ref()?;
        match doc.dereference(entry).ok()?.1 {
            Object::Dictionary(dict) => Some(dict),
            _ => None,
        }
    }

    /// The entry of the annotation at `origin`: the one at its position, if it is the one that was read (the same `/NM`), else the
    /// one with its `/NM`. `None` if the file has no such annotation.
    fn find(&self, doc: &Document, origin: &PdfOrigin) -> Option<usize> {
        let wanted = origin.name.as_deref().map(str::as_bytes);
        let name_matches = |index: usize| {
            wanted.is_none_or(|wanted| {
                self.dict_at(doc, index)
                    .and_then(name_of)
                    .is_some_and(|name| name == wanted)
            })
        };
        let at = usize::try_from(origin.annot_index)
            .ok()
            .and_then(|position| self.counted.get(position).copied());
        if let Some(index) = at.filter(|&index| name_matches(index)) {
            return Some(index);
        }
        wanted?;
        self.counted
            .iter()
            .copied()
            .find(|&index| name_matches(index))
    }

    /// The object id of entry `index` if it is a reference.
    fn reference_at(&self, index: usize) -> Option<ObjectId> {
        self.entries.get(index)?.as_ref()?.as_reference().ok()
    }

    /// Takes out the entry and the popups that belong to it.
    fn remove(&mut self, doc: &Document, index: usize) {
        let own = self.reference_at(index);
        let popup = self
            .dict_at(doc, index)
            .and_then(|dict| dict.get(b"Popup").ok())
            .and_then(|object| object.as_reference().ok());
        if let Some(entry) = self.entries.get_mut(index) {
            *entry = None;
        }
        for other in 0..self.entries.len() {
            let belongs = self.reference_at(other).is_some_and(|id| {
                Some(id) == popup
                    || (own.is_some()
                        && self.dict_at(doc, other).is_some_and(|dict| {
                            is_popup(dict)
                                && dict.get(b"Parent").and_then(Object::as_reference).ok() == own
                        }))
            });
            if belongs {
                self.entries[other] = None;
            }
        }
    }
}

/// The changes of one page, grouped.
fn group(plan: &Plan) -> BTreeMap<u32, Vec<&Change>> {
    let mut pages: BTreeMap<u32, Vec<&Change>> = BTreeMap::new();
    for change in &plan.changes {
        let page = match change {
            Change::Write { page_index, .. } => *page_index,
            Change::Delete { origin, .. } => origin.page_index,
        };
        pages.entry(page).or_default().push(change);
    }
    pages
}

/// Appends the changes of `plan` to `original` (a PDF that is not encrypted). Nothing to write: the original comes back as it is.
pub fn append_annotations(original: Vec<u8>, plan: &Plan) -> Result<Built, AppError> {
    if plan.changes.is_empty() {
        return Ok(Built {
            bytes: original,
            origins: Vec::new(),
            pages: 0,
        });
    }
    let doc = Document::load_mem(&original).map_err(lopdf_error)?;
    if doc.is_encrypted() {
        return Err(AppError::new(ErrorCode::UnsupportedFeature));
    }
    let pages = doc.get_pages();
    let page_count = u32::try_from(pages.len()).map_err(|_| failed("page count"))?;
    let mut inc = IncrementalDocument::create_from(original, doc);
    let mut origins: Vec<(AnnotId, PdfOrigin)> = Vec::new();
    let known: HashMap<AnnotId, &PdfOrigin> = plan.known.iter().map(|(id, o)| (*id, o)).collect();
    let mut known_by_page: HashMap<u32, Vec<(AnnotId, &PdfOrigin)>> = HashMap::new();
    for (id, origin) in &plan.known {
        known_by_page
            .entry(origin.page_index)
            .or_default()
            .push((*id, origin));
    }

    for (page_index, changes) in group(plan) {
        let page_id = *pages
            .get(&(page_index + 1))
            .ok_or_else(|| failed("a change names a page the file does not have"))?;
        let (mapper, mut slots) = {
            let prev = inc.get_prev_documents();
            let page = prev.get_dictionary(page_id).map_err(lopdf_error)?;
            (page_mapper(prev, page_id), Slots::read(prev, page)?)
        };

        // Where each kept annotation was, to find where it ends up.
        let mut moved: Vec<(AnnotId, usize, Option<Vec<u8>>)> = Vec::new();
        {
            let prev = inc.get_prev_documents();
            for (id, origin) in known_by_page.get(&page_index).into_iter().flatten() {
                if let Some(index) = slots.find(prev, origin) {
                    moved.push((*id, index, origin.name.clone().map(String::into_bytes)));
                }
            }
        }

        // 1. Deletions.
        for change in &changes {
            if let Change::Delete { origin, .. } = change {
                let prev = inc.get_prev_documents();
                if let Some(index) = slots.find(prev, origin) {
                    slots.remove(prev, index);
                }
            }
        }

        // 2. The objects the writes go to.
        struct Target {
            id: ObjectId,
            entry: Option<usize>,
            base: Option<Dictionary>,
        }
        let mut targets: HashMap<AnnotId, Target> = HashMap::new();
        let mut appended: Vec<AnnotId> = Vec::new();
        for change in &changes {
            let Change::Write {
                annotation, origin, ..
            } = change
            else {
                continue;
            };
            let prev = inc.get_prev_documents();
            let entry = origin.as_ref().and_then(|origin| slots.find(prev, origin));
            let target = match entry {
                Some(index) => {
                    let base = slots.dict_at(prev, index).cloned();
                    let id = match slots.reference_at(index) {
                        Some(id) => id,
                        // A dictionary written in the array itself cannot be pointed to: it becomes an object.
                        None => {
                            let id = inc.new_document.new_object_id();
                            slots.entries[index] = Some(Object::Reference(id));
                            id
                        }
                    };
                    Target {
                        id,
                        entry: Some(index),
                        base,
                    }
                }
                None => {
                    appended.push(annotation.id);
                    Target {
                        id: inc.new_document.new_object_id(),
                        entry: None,
                        base: None,
                    }
                }
            };
            targets.insert(annotation.id, target);
        }

        // 3. The dictionaries and appearances.
        for change in &changes {
            let Change::Write {
                annotation, origin, ..
            } = change
            else {
                continue;
            };
            let Some(target) = targets.get(&annotation.id) else {
                continue;
            };
            let name = origin
                .as_ref()
                .filter(|_| target.entry.is_some())
                .and_then(|origin| origin.name.clone())
                .unwrap_or_else(annots::random_name);
            let reply_to = annotation.in_reply_to.and_then(|parent| {
                targets.get(&parent).map(|t| t.id).or_else(|| {
                    let prev = inc.get_prev_documents();
                    let index = slots.find(prev, known.get(&parent)?)?;
                    slots.reference_at(index)
                })
            });
            let links = Links {
                page: page_id,
                reply_to,
            };
            let Some(mut dict) =
                annots::annotation_dict(annotation, mapper, &name, &links, target.base.clone())
            else {
                continue;
            };
            if let Some(stream) = annots::build_stream(annotation, mapper) {
                let ap = inc.new_document.add_object(stream);
                let mut normal = Dictionary::new();
                normal.set("N", Object::Reference(ap));
                dict.set("AP", Object::Dictionary(normal));
            }
            inc.new_document
                .set_object(target.id, Object::Dictionary(dict));
            origins.push((
                annotation.id,
                PdfOrigin {
                    page_index,
                    annot_index: 0,
                    name: Some(name),
                },
            ));
        }

        // 4. The array: what is left of the entries, then the new annotations.
        let mut kept: Vec<Object> = Vec::new();
        // The position among the counted entries each old entry has now.
        let mut now_at: HashMap<usize, u32> = HashMap::new();
        {
            let mut position = 0u32;
            for (index, entry) in slots.entries.iter().enumerate() {
                let Some(entry) = entry else { continue };
                if slots.counted_set.contains(&index) {
                    now_at.insert(index, position);
                    position += 1;
                }
                kept.push(entry.clone());
            }
            for id in &appended {
                if let Some(target) = targets.get(id) {
                    kept.push(Object::Reference(target.id));
                    if let Some((_, origin)) = origins.iter_mut().find(|(known, _)| known == id) {
                        origin.annot_index = position;
                    }
                    position += 1;
                }
            }
        }
        for (id, target) in &targets {
            if let (Some(index), Some((_, origin))) = (
                target.entry,
                origins.iter_mut().find(|(known, _)| known == id),
            ) {
                if let Some(position) = now_at.get(&index) {
                    origin.annot_index = *position;
                }
            }
        }
        // The annotations that stayed where they were in the file, at their new positions.
        for (id, index, name) in moved {
            if origins.iter().any(|(known, _)| *known == id) {
                continue;
            }
            if let Some(position) = now_at.get(&index) {
                origins.push((
                    id,
                    PdfOrigin {
                        page_index,
                        annot_index: *position,
                        name: name.and_then(|name| String::from_utf8(name).ok()),
                    },
                ));
            }
        }
        match slots.holder {
            Some(holder) => inc.new_document.set_object(holder, Object::Array(kept)),
            None => {
                inc.opt_clone_object_to_new_document(page_id)
                    .map_err(lopdf_error)?;
                inc.new_document
                    .get_dictionary_mut(page_id)
                    .map_err(lopdf_error)?
                    .set("Annots", Object::Array(kept));
            }
        }
    }

    let mut bytes = Vec::new();
    inc.save_to(&mut bytes).map_err(lopdf_error)?;
    Ok(Built {
        bytes,
        origins,
        pages: page_count,
    })
}

/// Reads `bytes` again as a PDF with `pages` pages (ADR-004 §1 step 6, the lopdf half of the check).
pub fn validate(bytes: &[u8], pages: u32) -> Result<(), AppError> {
    let doc = Document::load_mem(bytes).map_err(lopdf_error)?;
    if u32::try_from(doc.get_pages().len()).ok() == Some(pages) {
        Ok(())
    } else {
        Err(failed("the saved file has another number of pages"))
    }
}
