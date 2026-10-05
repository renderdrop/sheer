//! The incremental update (ADR-004 §1, steps 3 and 4): the original bytes stay as they are, and a new section follows them with the
//! annotation dictionaries and appearance streams that changed, the `/Annots` arrays that name them, a cross-reference section and a
//! trailer. A signature over the original bytes stays valid; earlier revisions stay recoverable.
//!
//! Where an annotation is in the file is a position among the page's `/Annots` entries that are dictionaries and not popups (what
//! PDFium counts, and so what `PdfOrigin::annot_index` is). A deleted annotation leaves its object where it was (nothing is
//! overwritten); it only stops being listed.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Arc;

use lopdf::{Dictionary, Document, IncrementalDocument, Object, ObjectId};

use super::annots::{self, Links};
use super::coords::page_mapper;
use crate::content::ContentObject;
use crate::documents::PageId;
use crate::error::{AppError, ErrorCode};
use crate::limits;
use crate::model::annotation::{Annotation, PdfOrigin};
use crate::model::ids::{AnnotId, AssetId};
use crate::model::metadata::MetadataChange;
use crate::security::secret::PendingProtection;
use crate::signatures::Art;

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
    /// The art the signatures of the changes refer to (`DocState.assets`).
    pub assets: HashMap<AssetId, Arc<Art>>,
}

/// What a save has to write besides the annotations, the form values and the page list (ADR-047, ARCHITECTURE §5 "Edit and protect"). It
/// is made from the model by `commands::save` and consumed by [`apply_extras`]; every field is empty or false for a plain save.
#[derive(Debug, Clone, Default)]
pub struct SavePlan {
    /// The text boxes and images to burn into each page, in creation order (`pdfwrite::content`, package A).
    pub content: Vec<(PageId, Vec<ContentObject>)>,
    /// The pages whose crop is not the file's: their page dictionaries are written again with `/CropBox` (package B).
    pub crops: Vec<PageId>,
    /// At least one page is a redacted raster (`PageSource::Redacted`): the save is Full and scrubbed (package C).
    pub redacted: bool,
    /// A staged protection change: `Protect` encrypts, `Remove` writes no `/Encrypt` (package D).
    pub protection: Option<PendingProtection>,
    /// Staged metadata: a new `/Info`, or a removal (package D).
    pub metadata: Option<MetadataChange>,
    /// The document is encrypted and stays so: the Full rewrite keeps its own `/Encrypt` and file key (package D).
    pub keep_encryption: bool,
    /// The bibliographic record to write as `/SHR_Bib` after the metadata (ADR-119, package C2); skipped with a pending strip.
    pub bibliography: Option<crate::model::bibliography::BibRecord>,
}

impl SavePlan {
    /// Nothing besides the plain annotation save.
    pub fn is_empty(&self) -> bool {
        self.content.is_empty()
            && self.crops.is_empty()
            && !self.redacted
            && self.protection.is_none()
            && self.metadata.is_none()
            && !self.keep_encryption
            && self.bibliography.is_none()
    }

    /// The save is a whole new file, no update on top of the original (ADR-047): redaction (no earlier revision may survive), a change
    /// of the protection, a removal of the metadata, and the rewrite of an encrypted document. Content, crops and a metadata edit are
    /// incremental.
    pub fn requires_full(&self) -> bool {
        self.redacted
            || self.protection.is_some()
            || self.keep_encryption
            || matches!(self.metadata, Some(MetadataChange::Strip))
    }

    /// The original is not copied to the backup folder, and the file's old backups go (redaction and removal of the metadata: what was
    /// taken out must not survive in a copy of ours).
    pub fn never_backed_up(&self) -> bool {
        self.redacted || matches!(self.metadata, Some(MetadataChange::Strip))
    }
}

/// Writes what [`SavePlan`] holds on top of `bytes` (the file after the page list, the annotations and the form values): burns the content
/// objects, writes the crops, scrubs after a redaction, encrypts or decrypts, writes or strips the metadata. An empty plan returns `bytes`
/// as they are. Packages A to D fill this in, each in its own file (`content`, `redact`, `crypt`, `metadata`).
pub fn apply_extras(bytes: Vec<u8>, plan: &SavePlan) -> Result<Vec<u8>, AppError> {
    if plan.is_empty() {
        return Ok(bytes);
    }
    // Package A: text boxes and images.
    let bytes = super::content::burn_all(bytes, &plan.content)?;
    // Package C: what still holds content of a redacted page (structure tree, orphan fields, `/ID`); before any encryption.
    let bytes = if plan.redacted {
        super::redact::finish(
            bytes,
            plan.keep_encryption,
            matches!(plan.metadata, Some(MetadataChange::Strip)),
        )?
    } else {
        bytes
    };
    // Package D: the metadata. Encryption is not here: it is the last step of the save (`commands::save::build_pages`), after the
    // compaction, and the file this function sees is a plain one (a protected file was decrypted first).
    let bytes = match &plan.metadata {
        Some(change) => super::metadata::apply(bytes, change)?,
        None => bytes,
    };
    // Crops are written with the page list (`pagetree::rewrite_pages`), so `plan.crops` needs nothing here.
    Ok(bytes)
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
    let doc = crate::pdfwrite::prescan::load_untrusted(&original)?;
    if doc.is_encrypted() {
        return Err(AppError::new(ErrorCode::UnsupportedFeature));
    }
    let pages = doc.get_pages();
    let page_count = u32::try_from(pages.len()).map_err(|_| failed("page count"))?;
    let mut inc = IncrementalDocument::create_from(original, doc);
    let mut origins: Vec<(AnnotId, PdfOrigin)> = Vec::new();
    // One image XObject per raster asset per save.
    let mut images: HashMap<AssetId, lopdf::ObjectId> = HashMap::new();
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
                .unwrap_or_else(|| annots::new_name(annotation));
            // A turned signature or mark carries its turn and box in its name, so a reload can give them back (ADR-105).
            let mut name = annots::named_with_turn(annotation, &name);
            // The turn of a signature whose art is in the file lives in that stream's /Matrix; when it cannot be written (no stream, a
            // /BBox that is not usable) the name must not claim it either, or a reload would show a turn the page does not have.
            let turned_stream = target.base.as_ref().and_then(|base| {
                annots::turned_file_appearance(annotation, inc.get_prev_documents(), base)
            });
            if turned_stream.is_none() && annots::has_file_appearance(annotation) {
                name = crate::signatures::marks::with_turn(&name, None);
            }
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
            if let Some(ap) = annots::write_appearance(
                annotation,
                mapper,
                &plan.assets,
                &mut inc.new_document,
                &mut images,
            ) {
                let mut normal = Dictionary::new();
                normal.set("N", Object::Reference(ap));
                dict.set("AP", Object::Dictionary(normal));
            } else if let Some(stream) = turned_stream {
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

/// The current state of a document as a Full, unencrypted PDF in memory, no backup, never on disk (ADR-049 §1): the snapshot an export
/// or a print renders. `input` is the plain file after the page list, the annotations and the form values (what `build_pages` of
/// `commands::save` has made); this burns in what `plan` holds (content objects, redaction scrub), leaves out any protection
/// (a staged one is not applied), and writes the whole file again without an earlier revision. The result has to load.
pub fn write_to_memory(plan: &SavePlan, input: &[u8]) -> Result<Vec<u8>, AppError> {
    let plain = SavePlan {
        protection: None,
        keep_encryption: false,
        ..plan.clone()
    };
    let bytes = apply_extras(input.to_vec(), &plain)?;
    let bytes = super::pagetree::compact(bytes, &[])?;
    if u64::try_from(bytes.len()).map_or(true, |len| len > limits::MAX_SNAPSHOT_BYTES) {
        return Err(AppError::limit("snapshot", limits::MAX_SNAPSHOT_BYTES));
    }
    crate::pdfwrite::prescan::load_untrusted(&bytes)?;
    Ok(bytes)
}

/// Reads `bytes` again as a PDF with `pages` pages (ADR-004 §1 step 6, the lopdf half of the check).
pub fn validate(bytes: &[u8], pages: u32) -> Result<(), AppError> {
    let doc = crate::pdfwrite::prescan::load_untrusted(bytes)?;
    if u32::try_from(doc.get_pages().len()).ok() == Some(pages) {
        Ok(())
    } else {
        Err(failed("the saved file has another number of pages"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::metadata::MetadataValues;

    #[test]
    fn an_empty_plan_is_incremental_and_leaves_the_bytes_alone() {
        let plan = SavePlan::default();
        assert!(plan.is_empty() && !plan.requires_full() && !plan.never_backed_up());
        assert_eq!(apply_extras(b"x".to_vec(), &plan).unwrap(), b"x");
    }

    #[test]
    fn redaction_protection_removal_and_encrypted_rewrites_are_full_saves() {
        let full = |plan: SavePlan| plan.requires_full();
        assert!(full(SavePlan {
            redacted: true,
            ..SavePlan::default()
        }));
        assert!(full(SavePlan {
            protection: Some(PendingProtection::Remove),
            ..SavePlan::default()
        }));
        assert!(full(SavePlan {
            keep_encryption: true,
            ..SavePlan::default()
        }));
        assert!(full(SavePlan {
            metadata: Some(MetadataChange::Strip),
            ..SavePlan::default()
        }));
        // A metadata edit and a crop are updates on top of the original.
        let edit = SavePlan {
            metadata: Some(MetadataChange::Set {
                values: MetadataValues::default(),
                had_xmp: false,
            }),
            crops: vec![PageId::new(0)],
            ..SavePlan::default()
        };
        assert!(!edit.requires_full() && !edit.is_empty());
    }

    #[test]
    fn only_redaction_and_removal_of_metadata_skip_the_backup() {
        let redacted = SavePlan {
            redacted: true,
            ..SavePlan::default()
        };
        let stripped = SavePlan {
            metadata: Some(MetadataChange::Strip),
            ..SavePlan::default()
        };
        let protected = SavePlan {
            protection: Some(PendingProtection::Remove),
            ..SavePlan::default()
        };
        assert!(redacted.never_backed_up() && stripped.never_backed_up());
        assert!(!protected.never_backed_up());
    }

    #[test]
    fn a_plan_with_work_runs_and_a_file_that_is_not_one_is_refused() {
        let plan = SavePlan {
            redacted: true,
            ..SavePlan::default()
        };
        assert_eq!(
            apply_extras(b"not a pdf".to_vec(), &plan)
                .unwrap_err()
                .code(),
            ErrorCode::DamagedFile
        );
        let bytes = std::fs::read(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/minimal.pdf"),
        )
        .unwrap();
        let pages = u32::try_from(
            crate::pdfwrite::prescan::load_untrusted(&bytes)
                .unwrap()
                .get_pages()
                .len(),
        )
        .unwrap();
        let out = apply_extras(bytes, &plan).unwrap();
        assert!(validate(&out, pages).is_ok());
    }
}
