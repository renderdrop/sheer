//! The page tree of a saved file (ADR-036 §5): which pages the document has, in which order, and how each is turned.
//!
//! The incremental way ([`rewrite_pages`]) appends to the original: a rotation re-appends the page's dictionary with `/Rotate`; a change of
//! the members or the order re-appends the root `/Pages` object (same object number, so `/Root` stays) with a flat `/Kids` or a two-level
//! tree, and every kept page with its new `/Parent` and the inherited attributes written into it. A blank page is a new dictionary, a
//! page of an import source an iterative copy of the objects it needs. Pages that are not in the list leave the tree and are still in the
//! file as objects. The full way ([`compact`], "clean copy") then makes a new file of what is reachable: nothing of a deleted page, and
//! nothing a deleted annotation left, is in it.
//!
//! Every PDF is hostile input here: the tree walks are bounded by a depth and a visited set, a copy by a count of objects and a nesting
//! depth, and nothing recurses on the file's own structure without a bound.

use std::collections::{HashMap, HashSet};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::{mpsc, Arc};
use std::thread;

use lopdf::{Dictionary, Document, IncrementalDocument, Object, ObjectId, Stream};

use crate::documents::sources::SourceBytes;
use crate::error::{AppError, ErrorCode};
use crate::limits;
use crate::model::page::PageSource;
use crate::model::page::SourceId;
use crate::model::page_ops::PagePlan;

fn failed(detail: impl std::fmt::Display) -> AppError {
    AppError::logged(ErrorCode::SaveFailed, detail)
}

fn lopdf_error(error: impl std::fmt::Display) -> AppError {
    failed(format!("lopdf: {error}"))
}

/// Runs `work` on a thread with the big stack lopdf wants, contained: a panic is `internal`.
pub fn on_big_stack<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, AppError> + Send + 'static,
) -> Result<T, AppError> {
    let (sender, receiver) = mpsc::channel();
    thread::Builder::new()
        .name("sheer-pages".into())
        .stack_size(limits::SAVE_STACK_BYTES)
        .spawn(move || {
            let result = catch_unwind(AssertUnwindSafe(work)).unwrap_or_else(|_| {
                Err(AppError::logged(ErrorCode::Internal, "page work panicked"))
            });
            let _ = sender.send(result);
        })
        .map_err(|error| AppError::logged(ErrorCode::Internal, error))?;
    receiver
        .recv()
        .map_err(|_| AppError::logged(ErrorCode::Internal, "page work ended without an answer"))?
}

/// The number of pages of an import source. An encrypted source is `unsupported_feature`, one lopdf cannot read `damaged_file`, one without
/// pages or with more than `MAX_PAGES` is refused.
pub fn count_pages(bytes: Arc<[u8]>) -> Result<u32, AppError> {
    on_big_stack(move || {
        let doc = super::prescan::load_untrusted(&bytes)?;
        if doc.is_encrypted() {
            return Err(AppError::new(ErrorCode::UnsupportedFeature));
        }
        let count = u32::try_from(doc.get_pages().len())
            .map_err(|_| AppError::new(ErrorCode::DamagedFile))?;
        if count == 0 {
            return Err(AppError::new(ErrorCode::DamagedFile));
        }
        limits::validate_page_count(count)
    })
}

/// The file after the page tree was written into it, and the page objects that are no longer part of the document.
#[derive(Debug)]
pub struct Rewritten {
    pub bytes: Vec<u8>,
    pub deleted_pages: Vec<ObjectId>,
}

fn name_is(dict: &Dictionary, key: &[u8], value: &[u8]) -> bool {
    dict.get(key)
        .and_then(Object::as_name)
        .is_ok_and(|name| name == value)
}

/// The dictionary `object` stands for: itself, or what it references (one hop at a time, bounded).
fn resolve<'a>(doc: &'a Document, object: &'a Object) -> Option<&'a Object> {
    let mut current = object;
    for _ in 0..16 {
        match current {
            Object::Reference(id) => current = doc.get_object(*id).ok()?,
            other => return Some(other),
        }
    }
    None
}

fn resolve_dict<'a>(doc: &'a Document, object: &'a Object) -> Option<&'a Dictionary> {
    match resolve(doc, object)? {
        Object::Dictionary(dict) => Some(dict),
        Object::Stream(stream) => Some(&stream.dict),
        _ => None,
    }
}

/// The attributes a page inherits from its ancestors, written into its own dictionary so that it can move to another parent.
fn materialize_inherited(doc: &Document, dict: &mut Dictionary) {
    const INHERITED: [&[u8]; 4] = [b"Resources", b"MediaBox", b"CropBox", b"Rotate"];
    for key in INHERITED {
        if dict.has(key) {
            continue;
        }
        let mut parent = dict.get(b"Parent").and_then(Object::as_reference).ok();
        let mut visited = HashSet::new();
        for _ in 0..limits::MAX_PARENT_CHAIN {
            let Some(id) = parent.filter(|id| visited.insert(*id)) else {
                break;
            };
            let Ok(node) = doc.get_dictionary(id) else {
                break;
            };
            if let Ok(value) = node.get(key) {
                dict.set(key, value.clone());
                break;
            }
            parent = node.get(b"Parent").and_then(Object::as_reference).ok();
        }
    }
}

/// How the pages hang under the root: all directly, or in nodes of `TREE_KIDS_PER_NODE`.
fn arrange(target: &mut Document, root: ObjectId, pages: &[ObjectId]) -> Vec<(ObjectId, Object)> {
    let count = i64::try_from(pages.len()).unwrap_or(i64::MAX);
    if pages.len() <= limits::FLAT_KIDS_MAX {
        let kids = pages.iter().map(|id| Object::Reference(*id)).collect();
        return vec![(root, Object::Array(kids))]
            .into_iter()
            .chain(std::iter::once((root, Object::Integer(count))))
            .collect();
    }
    let mut nodes = Vec::new();
    for chunk in pages.chunks(limits::TREE_KIDS_PER_NODE) {
        let node = target.new_object_id();
        let kids: Vec<Object> = chunk.iter().map(|id| Object::Reference(*id)).collect();
        nodes.push((node, kids, chunk.len()));
    }
    let mut out = vec![(
        root,
        Object::Array(
            nodes
                .iter()
                .map(|(id, _, _)| Object::Reference(*id))
                .collect(),
        ),
    )];
    out.push((root, Object::Integer(count)));
    for (id, kids, len) in nodes {
        let mut dict = Dictionary::new();
        dict.set("Type", Object::Name(b"Pages".to_vec()));
        dict.set("Parent", Object::Reference(root));
        dict.set("Kids", Object::Array(kids));
        dict.set("Count", Object::Integer(i64::try_from(len).unwrap_or(0)));
        out.push((id, Object::Dictionary(dict)));
    }
    out
}

/// The parent a page gets, by position: the root, or the node its chunk is in. Mirrors [`arrange`].
fn parents(root: ObjectId, nodes: &[ObjectId], count: usize) -> Vec<ObjectId> {
    if count <= limits::FLAT_KIDS_MAX {
        return vec![root; count];
    }
    (0..count)
        .map(|position| nodes[position / limits::TREE_KIDS_PER_NODE])
        .collect()
}

fn rotate_object(degrees: u16) -> Object {
    Object::Integer(i64::from(degrees))
}

/// A page dictionary for a blank page of `size` points.
fn blank_page(size: [f32; 2], rotation: u16) -> Dictionary {
    let mut dict = Dictionary::new();
    dict.set("Type", Object::Name(b"Page".to_vec()));
    dict.set(
        "MediaBox",
        Object::Array(vec![
            Object::Integer(0),
            Object::Integer(0),
            Object::Real(size[0]),
            Object::Real(size[1]),
        ]),
    );
    dict.set("Resources", Object::Dictionary(Dictionary::new()));
    if rotation != 0 {
        dict.set("Rotate", rotate_object(rotation));
    }
    dict
}

/// Copies the objects a page of `src` needs into `target`, under new numbers.
struct Copier<'a> {
    src: &'a Document,
    target: &'a mut Document,
    map: HashMap<ObjectId, ObjectId>,
    queue: Vec<ObjectId>,
    /// Objects to copy as these instead of what the source has (the page with its annotations cleaned, annotations without a jump).
    overrides: HashMap<ObjectId, Object>,
    copied: usize,
}

impl Copier<'_> {
    fn is_page_node(&self, id: ObjectId) -> bool {
        self.src
            .get_dictionary(id)
            .is_ok_and(|dict| name_is(dict, b"Type", b"Page") || name_is(dict, b"Type", b"Pages"))
    }

    fn map_reference(&mut self, id: ObjectId) -> Object {
        if let Some(mapped) = self.map.get(&id) {
            return Object::Reference(*mapped);
        }
        // Another page, or the tree: following it would bring in the whole file.
        if self.is_page_node(id) {
            return Object::Null;
        }
        let new = self.target.new_object_id();
        self.map.insert(id, new);
        self.queue.push(id);
        Object::Reference(new)
    }

    fn remap(&mut self, object: Object, depth: usize) -> Object {
        if depth > limits::MAX_COPY_NESTING {
            return Object::Null;
        }
        match object {
            Object::Reference(id) => self.map_reference(id),
            Object::Array(items) => Object::Array(
                items
                    .into_iter()
                    .map(|item| self.remap(item, depth + 1))
                    .collect(),
            ),
            Object::Dictionary(dict) => Object::Dictionary(self.remap_dict(dict, depth)),
            Object::Stream(stream) => {
                let Stream {
                    dict,
                    content,
                    allows_compression,
                    start_position,
                } = stream;
                Object::Stream(Stream {
                    dict: self.remap_dict(dict, depth),
                    content,
                    allows_compression,
                    start_position,
                })
            }
            other => other,
        }
    }

    fn remap_dict(&mut self, dict: Dictionary, depth: usize) -> Dictionary {
        let mut out = Dictionary::new();
        for (key, value) in dict {
            out.set(key, self.remap(value, depth + 1));
        }
        out
    }

    /// Copies the page `page` of the source and everything it needs; the new page's object number comes back.
    fn copy_page(&mut self, page: ObjectId, mut dict: Dictionary) -> Result<ObjectId, AppError> {
        let new_page = self.target.new_object_id();
        self.map.insert(page, new_page);
        dict.remove(b"Parent");
        dict.remove(b"StructParents");
        dict.remove(b"B");
        self.overrides.insert(page, Object::Dictionary(dict));
        self.queue.push(page);
        while let Some(id) = self.queue.pop() {
            self.copied += 1;
            if self.copied > limits::MAX_COPY_OBJECTS {
                return Err(AppError::limit("objects", limits::MAX_COPY_OBJECTS as u64));
            }
            let Some(&new) = self.map.get(&id) else {
                continue;
            };
            let object = match self.overrides.remove(&id) {
                Some(object) => object,
                None => self.src.get_object(id).cloned().unwrap_or(Object::Null),
            };
            let object = self.remap(object, 0);
            self.target.set_object(new, object);
        }
        Ok(new_page)
    }
}

/// An annotation of a page that is copied: widgets are dropped (no form merge before M4), a jump to another page loses its target.
/// `None` drops the annotation.
fn clean_annotation(src: &Document, annot: &Dictionary) -> Option<Dictionary> {
    if name_is(annot, b"Subtype", b"Widget") {
        return None;
    }
    let names_a_page = |array: &Object| -> bool {
        resolve(src, array)
            .and_then(|object| object.as_array().ok())
            .and_then(|items| items.first())
            .and_then(|first| first.as_reference().ok())
            .is_some_and(|id| {
                src.get_dictionary(id)
                    .is_ok_and(|dict| name_is(dict, b"Type", b"Page"))
            })
    };
    let mut cleaned = annot.clone();
    if annot.get(b"Dest").is_ok_and(names_a_page) {
        cleaned.remove(b"Dest");
    }
    // Actions of a document that came from elsewhere: only a link the app would itself offer to open (`security::links::classify`).
    // Launch, JavaScript, GoToR, SubmitForm, ImportData and the rest are dropped, and so are the additional actions and a chain (`Next`).
    cleaned.remove(b"AA");
    if let Some(action) = annot.get(b"A").ok().and_then(|a| resolve_dict(src, a)) {
        match safe_uri_action(action) {
            Some(safe) => cleaned.set("A", Object::Dictionary(safe)),
            None => {
                cleaned.remove(b"A");
            }
        }
    }
    Some(cleaned)
}

/// A fresh URI action (`S` and `URI` only) for `action` if it is one and its address passes the link classifier; else `None`.
fn safe_uri_action(action: &Dictionary) -> Option<Dictionary> {
    if !name_is(action, b"S", b"URI") {
        return None;
    }
    let raw = action.get(b"URI").ok()?.as_str().ok()?;
    let text = String::from_utf8_lossy(raw);
    crate::security::links::classify(&text)?;
    let mut safe = Dictionary::new();
    safe.set("S", Object::Name(b"URI".to_vec()));
    safe.set("URI", Object::string_literal(raw.to_vec()));
    Some(safe)
}

/// The page `index` of `src` as a copy into `target`: the new object number, with `/Rotate` set. The parent is set by the caller.
fn import_page(
    src: &Document,
    pages: &[ObjectId],
    index: u32,
    rotation: u16,
    target: &mut Document,
    budget: &mut usize,
) -> Result<ObjectId, AppError> {
    let page_id = *usize::try_from(index)
        .ok()
        .and_then(|index| pages.get(index))
        .ok_or_else(|| failed("a page the source does not have"))?;
    let mut dict = src.get_dictionary(page_id).map_err(lopdf_error)?.clone();
    materialize_inherited(src, &mut dict);
    // Annotations: which are kept, as direct dictionaries or as objects with a cleaned dictionary.
    let mut overrides: HashMap<ObjectId, Object> = HashMap::new();
    let mut dropped: HashSet<ObjectId> = HashSet::new();
    if let Some(entries) = dict
        .get(b"Annots")
        .ok()
        .and_then(|annots| resolve(src, annots))
        .and_then(|annots| annots.as_array().ok())
        .cloned()
    {
        let mut kept = Vec::with_capacity(entries.len());
        let mut counted = 0u32;
        for entry in entries.into_iter().take(limits::MAX_ANNOTS_ARRAY) {
            let reference = entry.as_reference().ok();
            let Some(annot) = resolve_dict(src, &entry) else {
                continue;
            };
            // The place the engine knows it by (popups are not counted); an annotation without a name gets one made from it, so the
            // model finds it again in the copy.
            let at = (!name_is(annot, b"Subtype", b"Popup")).then(|| {
                counted += 1;
                counted - 1
            });
            match clean_annotation(src, annot) {
                Some(mut cleaned) => {
                    if let Some(at) = at {
                        super::annots::stamp_name(&mut cleaned, index, at);
                    }
                    match reference {
                        Some(id) => {
                            overrides.insert(id, Object::Dictionary(cleaned));
                            kept.push(Object::Reference(id));
                        }
                        None => kept.push(Object::Dictionary(cleaned)),
                    }
                }
                None => {
                    dropped.extend(reference);
                }
            }
        }
        // A popup of a widget that was dropped goes with it.
        kept.retain(|entry| {
            resolve_dict(src, entry).is_none_or(|annot| {
                !(name_is(annot, b"Subtype", b"Popup")
                    && annot
                        .get(b"Parent")
                        .and_then(Object::as_reference)
                        .is_ok_and(|parent| dropped.contains(&parent)))
            })
        });
        dict.set("Annots", Object::Array(kept));
    }
    dict.set("Rotate", rotate_object(rotation));
    let mut copier = Copier {
        src,
        target,
        map: HashMap::new(),
        queue: Vec::new(),
        overrides,
        copied: *budget,
    };
    let new_page = copier.copy_page(page_id, dict)?;
    *budget = copier.copied;
    Ok(new_page)
}

/// The root of the page tree of `doc`: the object number `/Pages` of the catalog points to, if it points to one.
fn pages_root(doc: &Document) -> Option<ObjectId> {
    doc.catalog()
        .ok()?
        .get(b"Pages")
        .and_then(Object::as_reference)
        .ok()
}

/// Whether the tree of `doc` can be trusted to be patched in place: a root that is an object and a `/Count` that is the number of pages.
fn tree_is_sound(doc: &Document, pages: usize) -> bool {
    pages_root(doc)
        .and_then(|root| doc.get_dictionary(root).ok())
        .and_then(|root| root.get(b"Count").ok())
        .and_then(|count| count.as_i64().ok())
        .is_some_and(|count| usize::try_from(count) == Ok(pages))
}

/// Top-level fields of the form that only have widgets on deleted pages are left out.
fn live_fields(doc: &Document, fields: &[Object], deleted: &HashSet<ObjectId>) -> Vec<Object> {
    #[allow(clippy::too_many_arguments)] // a recursive walk that carries its counters
    fn leaves_on_deleted(
        doc: &Document,
        node: &Object,
        deleted: &HashSet<ObjectId>,
        depth: usize,
        seen: &mut HashSet<ObjectId>,
        total: &mut usize,
        some: &mut bool,
        all: &mut bool,
    ) {
        *total += 1;
        if depth > 16 || *total > 100_000 {
            *all = false;
            return;
        }
        if let Object::Reference(id) = node {
            if !seen.insert(*id) {
                return;
            }
        }
        let Some(dict) = resolve_dict(doc, node) else {
            *all = false;
            return;
        };
        match dict.get(b"Kids").ok().and_then(|kids| resolve(doc, kids)) {
            Some(Object::Array(kids)) => {
                for kid in kids {
                    leaves_on_deleted(doc, kid, deleted, depth + 1, seen, total, some, all);
                }
            }
            _ => {
                *some = true;
                let on_deleted = dict
                    .get(b"P")
                    .and_then(Object::as_reference)
                    .is_ok_and(|page| deleted.contains(&page));
                if !on_deleted {
                    *all = false;
                }
            }
        }
    }
    fields
        .iter()
        .filter(|field| {
            let (mut some, mut all, mut total) = (false, true, 0usize);
            leaves_on_deleted(
                doc,
                field,
                deleted,
                0,
                &mut HashSet::new(),
                &mut total,
                &mut some,
                &mut all,
            );
            !(some && all)
        })
        .cloned()
        .collect()
}

/// Writes the page tree of `plan` into `original` as an incremental update. `sources` holds the bytes of every import source the plan uses.
pub fn rewrite_pages(
    original: Vec<u8>,
    plan: &PagePlan,
    sources: &HashMap<SourceId, Arc<SourceBytes>>,
) -> Result<Rewritten, AppError> {
    let doc = super::prescan::load_untrusted(&original)?;
    if doc.is_encrypted() {
        return Err(AppError::new(ErrorCode::UnsupportedFeature));
    }
    let file_pages: Vec<ObjectId> = doc.get_pages().into_values().collect();
    if u32::try_from(file_pages.len()) != Ok(plan.file_pages) {
        return Err(failed(
            "the file has another number of pages than the document",
        ));
    }
    let kept_file: HashSet<u32> = plan
        .pages
        .iter()
        .filter_map(|page| match page.source {
            PageSource::File { index } => Some(index),
            _ => None,
        })
        .collect();
    let deleted_pages: Vec<ObjectId> = file_pages
        .iter()
        .enumerate()
        .filter(|(index, _)| u32::try_from(*index).is_ok_and(|index| !kept_file.contains(&index)))
        .map(|(_, id)| *id)
        .collect();
    let deleted: HashSet<ObjectId> = deleted_pages.iter().copied().collect();
    let structure = plan.structure_changed || !tree_is_sound(&doc, file_pages.len());

    let mut inc = IncrementalDocument::create_from(original, doc);
    if !structure {
        for page in &plan.pages {
            let PageSource::File { index } = page.source else {
                continue;
            };
            if page.rotation == page.saved_rotation {
                continue;
            }
            let id = file_pages[usize::try_from(index).map_err(|_| failed("page index"))?];
            let mut dict = inc
                .get_prev_documents()
                .get_dictionary(id)
                .map_err(lopdf_error)?
                .clone();
            dict.set("Rotate", rotate_object(page.rotation));
            inc.new_document.set_object(id, Object::Dictionary(dict));
        }
        return finish(inc, deleted_pages);
    }

    // The root, and the catalog if the root is not an object of its own.
    let catalog_id = inc
        .get_prev_documents()
        .trailer
        .get(b"Root")
        .and_then(Object::as_reference)
        .map_err(lopdf_error)?;
    let (root, root_dict, root_is_new) = {
        let prev = inc.get_prev_documents();
        match pages_root(prev) {
            Some(root) => (
                root,
                prev.get_dictionary(root).map_err(lopdf_error)?.clone(),
                false,
            ),
            None => (inc.new_document.new_object_id(), Dictionary::new(), true),
        }
    };

    // Every page of the list: its object, and its dictionary where it is not in the target yet.
    let mut loaded: HashMap<SourceId, (Document, Vec<ObjectId>)> = HashMap::new();
    let mut budget = 0usize;
    let mut page_ids: Vec<ObjectId> = Vec::with_capacity(plan.pages.len());
    let mut dicts: Vec<(ObjectId, Dictionary)> = Vec::new();
    for page in &plan.pages {
        match page.source {
            PageSource::File { index } => {
                let id = file_pages[usize::try_from(index).map_err(|_| failed("page index"))?];
                let prev = inc.get_prev_documents();
                let mut dict = prev.get_dictionary(id).map_err(lopdf_error)?.clone();
                materialize_inherited(prev, &mut dict);
                dict.set("Rotate", rotate_object(page.rotation));
                dicts.push((id, dict));
                page_ids.push(id);
            }
            PageSource::Blank => {
                let id = inc.new_document.new_object_id();
                dicts.push((id, blank_page(page.size, page.rotation)));
                page_ids.push(id);
            }
            PageSource::Imported { source, index } => {
                if let std::collections::hash_map::Entry::Vacant(vacant) = loaded.entry(source) {
                    let bytes = sources
                        .get(&source)
                        .ok_or_else(|| failed("an import source is gone"))?;
                    let src = super::prescan::load_untrusted(&bytes.bytes)?;
                    if src.is_encrypted() {
                        return Err(AppError::new(ErrorCode::UnsupportedFeature));
                    }
                    let pages = src.get_pages().into_values().collect();
                    vacant.insert((src, pages));
                }
                let (src, pages) = loaded
                    .get(&source)
                    .ok_or_else(|| failed("an import source is gone"))?;
                let id = import_page(
                    src,
                    pages,
                    index,
                    page.rotation,
                    &mut inc.new_document,
                    &mut budget,
                )?;
                page_ids.push(id);
            }
        }
    }

    // The tree.
    let arranged = arrange(&mut inc.new_document, root, &page_ids);
    let node_ids: Vec<ObjectId> = arranged.iter().skip(2).map(|(id, _)| *id).collect();
    let parent_of = parents(root, &node_ids, page_ids.len());
    let mut root_out = root_dict;
    root_out.set("Type", Object::Name(b"Pages".to_vec()));
    root_out.remove(b"Parent");
    for (id, object) in arranged {
        if id == root {
            match object {
                Object::Array(_) => root_out.set("Kids", object),
                other => root_out.set("Count", other),
            }
        } else {
            inc.new_document.set_object(id, object);
        }
    }
    inc.new_document
        .set_object(root, Object::Dictionary(root_out));
    for (id, mut dict) in dicts {
        let position = page_ids
            .iter()
            .position(|page| *page == id)
            .ok_or_else(|| failed("page without a position"))?;
        dict.set("Parent", Object::Reference(parent_of[position]));
        inc.new_document.set_object(id, Object::Dictionary(dict));
    }
    for (position, id) in page_ids.iter().enumerate() {
        if let Ok(dict) = inc.new_document.get_dictionary_mut(*id) {
            dict.set("Parent", Object::Reference(parent_of[position]));
        }
    }

    // The catalog: a root that was not an object of its own, and a form without the fields whose pages are gone.
    let mut catalog_dict: Option<Dictionary> = None;
    if root_is_new {
        let mut catalog = inc
            .get_prev_documents()
            .get_dictionary(catalog_id)
            .map_err(lopdf_error)?
            .clone();
        catalog.set("Pages", Object::Reference(root));
        catalog_dict = Some(catalog);
    }
    if !deleted.is_empty() {
        let prev = inc.get_prev_documents();
        let catalog = prev.get_dictionary(catalog_id).map_err(lopdf_error)?;
        if let Ok(acro) = catalog.get(b"AcroForm") {
            let acro_id = acro.as_reference().ok();
            if let Some(form) = resolve_dict(prev, acro) {
                let fields_ref = form.get(b"Fields").ok().and_then(|f| f.as_reference().ok());
                if let Some(Object::Array(fields)) =
                    form.get(b"Fields").ok().and_then(|f| resolve(prev, f))
                {
                    let live = live_fields(prev, fields, &deleted);
                    if live.len() != fields.len() {
                        match (fields_ref, acro_id) {
                            (Some(fields_id), _) => {
                                inc.new_document.set_object(fields_id, Object::Array(live));
                            }
                            (None, Some(acro_id)) => {
                                let mut form = form.clone();
                                form.set("Fields", Object::Array(live));
                                inc.new_document
                                    .set_object(acro_id, Object::Dictionary(form));
                            }
                            (None, None) => {
                                let mut form = form.clone();
                                form.set("Fields", Object::Array(live));
                                let mut catalog =
                                    catalog_dict.take().unwrap_or_else(|| catalog.clone());
                                catalog.set("AcroForm", Object::Dictionary(form));
                                catalog_dict = Some(catalog);
                            }
                        }
                    }
                }
            }
        }
    }
    if let Some(catalog) = catalog_dict {
        inc.new_document
            .set_object(catalog_id, Object::Dictionary(catalog));
    }
    finish(inc, deleted_pages)
}

fn finish(
    mut inc: IncrementalDocument,
    deleted_pages: Vec<ObjectId>,
) -> Result<Rewritten, AppError> {
    let mut bytes = Vec::new();
    inc.save_to(&mut bytes).map_err(lopdf_error)?;
    Ok(Rewritten {
        bytes,
        deleted_pages,
    })
}

/// A new file of what is reachable in `bytes` once every reference to a page in `deleted` is `null` and gone from the `/Kids`, `/Fields`
/// and `/Annots` that listed it (ADR-036 §5, "clean copy"). Nothing of those pages, and no object only they or a deleted annotation held, is
/// in the result.
pub fn compact(bytes: Vec<u8>, deleted: &[ObjectId]) -> Result<Vec<u8>, AppError> {
    let mut doc = super::prescan::load_untrusted(&bytes)?;
    drop(bytes);
    if doc.is_encrypted() {
        return Err(AppError::new(ErrorCode::UnsupportedFeature));
    }
    let doomed: HashSet<ObjectId> = deleted.iter().copied().collect();
    if !doomed.is_empty() {
        for id in &doomed {
            doc.objects.remove(id);
        }
        doc.traverse_objects(|object| {
            if matches!(object, Object::Reference(id) if doomed.contains(id)) {
                *object = Object::Null;
            }
        });
        // Objects the traversal does not reach from the trailer are dropped below anyway; the ones it did reach are cleaned.
        for object in doc.objects.values_mut() {
            strip_nulls(object, 0);
        }
        strip_nulls_dict(&mut doc.trailer, 0);
    }
    doc.prune_objects();
    // The old cross-reference chain is not part of the new file.
    doc.trailer.remove(b"Prev");
    doc.trailer.remove(b"XRefStm");
    let mut out = Vec::new();
    doc.save_to(&mut out).map_err(lopdf_error)?;
    Ok(out)
}

fn strip_nulls_dict(dict: &mut Dictionary, depth: usize) {
    for (key, value) in dict.iter_mut() {
        if matches!(key.as_slice(), b"Kids" | b"Fields" | b"Annots") {
            if let Object::Array(items) = value {
                items.retain(|item| !matches!(item, Object::Null));
            }
        }
        strip_nulls(value, depth + 1);
    }
}

fn strip_nulls(object: &mut Object, depth: usize) {
    if depth > limits::MAX_COPY_NESTING {
        return;
    }
    match object {
        Object::Dictionary(dict) => strip_nulls_dict(dict, depth),
        Object::Stream(stream) => strip_nulls_dict(&mut stream.dict, depth),
        Object::Array(items) => items
            .iter_mut()
            .for_each(|item| strip_nulls(item, depth + 1)),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn link_with(action: Dictionary) -> Dictionary {
        let mut annot = Dictionary::new();
        annot.set("Subtype", Object::Name(b"Link".to_vec()));
        annot.set("A", Object::Dictionary(action));
        let mut extra = Dictionary::new();
        extra.set("S", Object::Name(b"JavaScript".to_vec()));
        annot.set("AA", Object::Dictionary(extra));
        annot
    }

    fn action(kind: &str, extra: &[(&str, Object)]) -> Dictionary {
        let mut dict = Dictionary::new();
        dict.set("S", Object::Name(kind.as_bytes().to_vec()));
        for (key, value) in extra {
            dict.set(*key, value.clone());
        }
        dict
    }

    #[test]
    fn imported_annotations_keep_only_safe_uri_actions() {
        let doc = Document::new();
        for dangerous in [
            action("Launch", &[("F", Object::string_literal("calc.exe"))]),
            action(
                "JavaScript",
                &[("JS", Object::string_literal("app.alert(1)"))],
            ),
            action("GoToR", &[("F", Object::string_literal("x.pdf"))]),
            action(
                "SubmitForm",
                &[("F", Object::string_literal("http://a.example/"))],
            ),
            action(
                "URI",
                &[("URI", Object::string_literal("file:///etc/passwd"))],
            ),
            action(
                "URI",
                &[("URI", Object::string_literal("javascript:alert(1)"))],
            ),
        ] {
            let cleaned = clean_annotation(&doc, &link_with(dangerous)).unwrap();
            assert!(cleaned.get(b"A").is_err());
            assert!(cleaned.get(b"AA").is_err());
        }
        let mut good = action(
            "URI",
            &[("URI", Object::string_literal("https://example.org/a"))],
        );
        good.set("Next", Object::Dictionary(action("Launch", &[])));
        let cleaned = clean_annotation(&doc, &link_with(good)).unwrap();
        let kept = cleaned.get(b"A").unwrap().as_dict().unwrap();
        assert!(name_is(kept, b"S", b"URI"));
        assert!(kept.get(b"Next").is_err(), "a chain is not carried");
        assert!(cleaned.get(b"AA").is_err());
    }
}
