//! New files from pages of existing ones (ADR-036 §6): extract, split and merge. Pure functions on bytes: no PDFium, no files, no
//! dialogs (the commands in `commands/jobs.rs` own those), so every case runs in a unit test.
//!
//! The output is a **full rewrite**: a new document is built object by object from the closure of each kept page (content, resources,
//! fonts, images, annotations with their appearance streams). Nothing of the original file is carried that is not reachable from a
//! kept page, so a deleted page's content never leaves with the file. The copy is iterative over objects and bounded (objects,
//! nesting, pages), because every PDF is hostile input.
//!
//! What a page's closure may not reach: other pages and page tree nodes. A reference to one is `null` in the copy (a link to a page
//! that is not in the output loses its destination; `/Parent` of a page is rebuilt; an annotation's `/P` points to the new page or to
//! nothing). Signature values are removed (they would not verify), `/Perms` is not carried, `/AcroForm` is carried when exactly one
//! input has forms.

use std::collections::{HashMap, HashSet};

use lopdf::{Dictionary, Document, Object, ObjectId, Stream};
use serde::Serialize;

use super::save::{append_annotations, validate, Change, Plan};
use crate::documents::sanitize_text;
use crate::error::{AppError, ErrorCode};
use crate::limits;
use crate::model::annotation::PdfOrigin;

/// The phase a [`Control::progress`] message is about; the wire name is the lower-case word.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    Read,
    Images,
    Write,
    Validate,
}

/// Something the output lost, for the UI to say once.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Warning {
    SignaturesRemoved,
    FormsDropped,
    /// Form fields on pages taken from another file were not carried over (the widgets show no more).
    WidgetsDropped,
}

/// How a job is told to stop and how it reports. `check` is called between objects, pages and images.
pub trait Control {
    /// `Err(cancelled)` once the user cancelled, `Err(engine_timeout)` past the deadline.
    fn check(&self) -> Result<(), AppError>;
    /// A step of `phase` is done: `done` of `total`.
    fn progress(&self, phase: Phase, done: u32, total: u32);
}

/// A [`Control`] that never stops and tells nobody.
pub struct Unattended;

impl Control for Unattended {
    fn check(&self) -> Result<(), AppError> {
        Ok(())
    }
    fn progress(&self, _phase: Phase, _done: u32, _total: u32) {}
}

/// A produced file.
#[derive(Debug)]
pub struct Output {
    pub bytes: Vec<u8>,
    pub pages: u32,
    pub warnings: Vec<Warning>,
}

/// Where the content of a page of an output comes from.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum PageKind {
    /// Page `index` of the part's own file.
    File { index: u32 },
    /// A page that is empty, `width` x `height` points (before the rotation).
    Blank { width: f32, height: f32 },
    /// Page `index` of the `source`th of the part's `sources`.
    Imported { source: usize, index: u32 },
}

/// A page of the input to put in the output, and, if the model rotated it, the rotation it has now.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PageSel {
    pub kind: PageKind,
    /// Degrees (0, 90, 180, 270) written as `/Rotate`; `None` keeps the page's own.
    pub rotation: Option<u16>,
}

impl PageSel {
    /// Page `index` of the file as it is.
    pub const fn plain(index: u32) -> Self {
        Self::file(index, None)
    }

    pub const fn file(index: u32, rotation: Option<u16>) -> Self {
        Self {
            kind: PageKind::File { index },
            rotation,
        }
    }
}

/// A PDF that was read: the document and its page objects in order.
#[derive(Debug)]
pub struct Parsed {
    pub doc: Document,
    pub pages: Vec<ObjectId>,
}

fn damaged(detail: impl std::fmt::Display) -> AppError {
    AppError::logged(ErrorCode::DamagedFile, format!("lopdf: {detail}"))
}

fn failed(detail: impl std::fmt::Display) -> AppError {
    AppError::logged(ErrorCode::SaveFailed, detail)
}

/// Reads `bytes` for a job. Encrypted files are `unsupported_feature`, files without pages `damaged_file`, more than 50 000 pages
/// `limit_exceeded`.
pub fn load(bytes: &[u8]) -> Result<Parsed, AppError> {
    let doc = super::prescan::load_untrusted(bytes)?;
    // lopdf opens a file with an empty user password by itself and then no longer reports it as encrypted: its state says so.
    if doc.is_encrypted() || doc.encryption_state.is_some() {
        return Err(AppError::new(ErrorCode::UnsupportedFeature));
    }
    let pages: Vec<ObjectId> = doc.get_pages().values().copied().collect();
    if pages.is_empty() {
        return Err(damaged("no pages"));
    }
    limits::validate_page_count(u32::try_from(pages.len()).unwrap_or(u32::MAX))?;
    Ok(Parsed { doc, pages })
}

// --- Ranges and groups --------------------------------------------------------------------------------------------

/// Parses "1-3, 5, 8-" over a document of `count` pages: 1-based inclusive ranges in the order written. A number is a one page range,
/// `8-` runs to the last page. Anything else is `invalid_argument` (`ranges`): empty text or token, `0`, a page past the end, a range
/// that runs backwards, a number of more than six digits; more than 1 000 ranges is `limit_exceeded`.
pub fn parse_ranges(text: &str, count: u32) -> Result<Vec<(u32, u32)>, AppError> {
    let invalid = || AppError::invalid("ranges");
    let tokens: Vec<&str> = text.split(',').map(str::trim).collect();
    if tokens.len() > limits::MAX_SPLIT_OUTPUTS {
        return Err(AppError::limit("outputs", limits::MAX_SPLIT_OUTPUTS as u64));
    }
    let number = |part: &str| -> Result<u32, AppError> {
        if part.is_empty() || part.len() > 6 || !part.bytes().all(|b| b.is_ascii_digit()) {
            return Err(invalid());
        }
        part.parse::<u32>().map_err(|_| invalid())
    };
    let mut ranges = Vec::with_capacity(tokens.len());
    for token in tokens {
        let (start, end) = match token.split_once('-') {
            None => {
                let page = number(token)?;
                (page, page)
            }
            Some((first, last)) => {
                let (first, last) = (first.trim(), last.trim());
                (
                    number(first)?,
                    if last.is_empty() {
                        count
                    } else {
                        number(last)?
                    },
                )
            }
        };
        if start < 1 || end < start || end > count {
            return Err(invalid());
        }
        ranges.push((start, end));
    }
    Ok(ranges)
}

/// The page positions (0-based) of each 1-based inclusive range.
pub fn groups_from_ranges(ranges: &[(u32, u32)]) -> Vec<Vec<u32>> {
    ranges
        .iter()
        .map(|&(start, end)| (start - 1..end).collect())
        .collect()
}

fn check_outputs(outputs: usize) -> Result<(), AppError> {
    if outputs > limits::MAX_SPLIT_OUTPUTS {
        Err(AppError::limit("outputs", limits::MAX_SPLIT_OUTPUTS as u64))
    } else {
        Ok(())
    }
}

/// Positions of `count` pages cut into runs of `n`: the last one may be shorter. `n` is 1 to 10 000 (`invalid_argument`), at most 1 000
/// outputs (`limit_exceeded`).
pub fn groups_every_n(count: u32, n: u32) -> Result<Vec<Vec<u32>>, AppError> {
    if n == 0 || n > limits::MAX_SPLIT_EVERY_N || count == 0 {
        return Err(AppError::invalid("plan"));
    }
    check_outputs(count.div_ceil(n) as usize)?;
    let mut groups = Vec::new();
    let mut start = 0;
    while start < count {
        let end = count.min(start.saturating_add(n));
        groups.push((start..end).collect());
        start = end;
    }
    Ok(groups)
}

/// Positions of `count` pages cut so that a new file starts at each of `cuts` (positions; one at 0 starts nothing new). A position past
/// the end is `invalid_argument`.
pub fn groups_before(count: u32, cuts: &[u32]) -> Result<Vec<Vec<u32>>, AppError> {
    if cuts.iter().any(|&cut| cut >= count) || count == 0 {
        return Err(AppError::invalid("plan"));
    }
    let mut starts: Vec<u32> = cuts.iter().copied().filter(|&cut| cut > 0).collect();
    starts.push(0);
    starts.sort_unstable();
    starts.dedup();
    check_outputs(starts.len())?;
    let mut groups = Vec::with_capacity(starts.len());
    for (at, &start) in starts.iter().enumerate() {
        let end = starts.get(at + 1).copied().unwrap_or(count);
        groups.push((start..end).collect());
    }
    Ok(groups)
}

// --- The copy -----------------------------------------------------------------------------------------------------

fn is_page_node(object: &Object) -> bool {
    let dict = match object {
        Object::Dictionary(dict) => dict,
        Object::Stream(stream) => &stream.dict,
        _ => return false,
    };
    dict.get(b"Type")
        .and_then(Object::as_name)
        .is_ok_and(|name| name == b"Page" || name == b"Pages")
}

/// Brings objects of one source document into the output.
struct Importer<'a> {
    src: &'a Document,
    /// Every page object of the source: a reference to one that is not kept is `null`.
    all_pages: HashSet<ObjectId>,
    /// Source page object -> its object in the output.
    kept: HashMap<ObjectId, ObjectId>,
    map: HashMap<ObjectId, ObjectId>,
    queue: Vec<ObjectId>,
    signatures: bool,
    overflow: bool,
}

/// Page entries that are not carried: the parent is rebuilt, the structure tree is not.
const PAGE_SKIP: [&[u8]; 3] = [b"Parent", b"StructParents", b"B"];
/// Page attributes a page may inherit from its tree.
const INHERITED: [&[u8]; 4] = [b"Resources", b"MediaBox", b"CropBox", b"Rotate"];

impl<'a> Importer<'a> {
    fn new(parsed: &'a Parsed) -> Self {
        Self {
            src: &parsed.doc,
            all_pages: parsed.pages.iter().copied().collect(),
            kept: HashMap::new(),
            map: HashMap::new(),
            queue: Vec::new(),
            signatures: false,
            overflow: false,
        }
    }

    fn map_ref(&mut self, dst: &mut Document, id: ObjectId) -> Object {
        if let Some(&new) = self.kept.get(&id) {
            return Object::Reference(new);
        }
        if self.all_pages.contains(&id) {
            return Object::Null;
        }
        if let Some(&new) = self.map.get(&id) {
            return Object::Reference(new);
        }
        let Some(target) = self.src.objects.get(&id) else {
            return Object::Null;
        };
        if is_page_node(target) {
            return Object::Null;
        }
        if self.map.len() >= limits::MAX_COPY_OBJECTS {
            self.overflow = true;
            return Object::Null;
        }
        let new = dst.new_object_id();
        self.map.insert(id, new);
        self.queue.push(id);
        Object::Reference(new)
    }

    fn translate(&mut self, dst: &mut Document, object: &Object, depth: usize) -> Object {
        if depth > limits::MAX_COPY_NESTING {
            return Object::Null;
        }
        match object {
            Object::Reference(id) => self.map_ref(dst, *id),
            Object::Array(items) => Object::Array(
                items
                    .iter()
                    .map(|item| self.translate(dst, item, depth + 1))
                    .collect(),
            ),
            Object::Dictionary(dict) => {
                Object::Dictionary(self.translate_dict(dst, dict, depth + 1, &[]))
            }
            Object::Stream(stream) => {
                let dict = self.translate_dict(dst, &stream.dict, depth + 1, &[]);
                Object::Stream(
                    Stream::new(dict, stream.content.clone())
                        .with_compression(stream.allows_compression),
                )
            }
            other => other.clone(),
        }
    }

    fn translate_dict(
        &mut self,
        dst: &mut Document,
        dict: &Dictionary,
        depth: usize,
        skip: &[&[u8]],
    ) -> Dictionary {
        let signature_field = dict
            .get(b"FT")
            .and_then(Object::as_name)
            .is_ok_and(|name| name == b"Sig");
        let mut out = Dictionary::new();
        for (key, value) in dict.iter() {
            if skip.contains(&key.as_slice()) {
                continue;
            }
            if signature_field && key.as_slice() == b"V" {
                self.signatures = true;
                continue;
            }
            let translated = self.translate(dst, value, depth);
            out.set(key.clone(), translated);
        }
        for key in [&b"Annots"[..], b"Fields", b"Kids"] {
            if let Ok(Object::Array(items)) = out.get_mut(key) {
                items.retain(|item| !item.is_null());
            }
        }
        let dead_destination = |value: &Object| matches!(value, Object::Array(items) if items.first().is_none_or(Object::is_null));
        if out.get(b"Dest").is_ok_and(dead_destination) {
            out.remove(b"Dest");
        }
        let dead_action = out.get(b"A").is_ok_and(|action| match action {
            Object::Dictionary(action) => {
                action
                    .get(b"S")
                    .and_then(Object::as_name)
                    .is_ok_and(|name| name == b"GoTo")
                    && action.get(b"D").is_ok_and(dead_destination)
            }
            _ => false,
        });
        if dead_action {
            out.remove(b"A");
        }
        out
    }

    /// Copies what the queue holds, and what that reaches.
    fn drain(&mut self, dst: &mut Document, control: &dyn Control) -> Result<(), AppError> {
        let mut steps = 0u32;
        while let Some(id) = self.queue.pop() {
            steps += 1;
            if steps.is_multiple_of(256) {
                control.check()?;
            }
            let (Some(object), Some(&new)) = (self.src.objects.get(&id), self.map.get(&id)) else {
                continue;
            };
            let translated = self.translate(dst, object, 0);
            dst.objects.insert(new, translated);
        }
        if self.overflow {
            return Err(AppError::limit("objects", limits::MAX_COPY_OBJECTS as u64));
        }
        Ok(())
    }

    /// The page dictionary with the attributes it inherits written into it.
    fn flattened_page(&self, id: ObjectId) -> Result<Dictionary, AppError> {
        let base = self.src.get_dictionary(id).map_err(damaged)?;
        let mut dict = base.clone();
        let mut parent = base.get(b"Parent").and_then(Object::as_reference).ok();
        let mut seen = HashSet::new();
        for _ in 0..limits::MAX_PARENT_CHAIN {
            let Some(node) = parent else { break };
            if !seen.insert(node) {
                break;
            }
            let Ok(node_dict) = self.src.get_dictionary(node) else {
                break;
            };
            for key in INHERITED {
                if !dict.has(key) {
                    if let Ok(value) = node_dict.get(key) {
                        dict.set(key.to_vec(), value.clone());
                    }
                }
            }
            parent = node_dict.get(b"Parent").and_then(Object::as_reference).ok();
        }
        if !dict.has(b"MediaBox") {
            dict.set("MediaBox", vec![0.into(), 0.into(), 612.into(), 792.into()]);
        }
        Ok(dict)
    }

    /// The form of the source, if pages kept any of its fields: the `/AcroForm` entries without the fields, and the fields to keep.
    fn form(&self) -> Option<(Dictionary, Vec<ObjectId>)> {
        let catalog = self.src.catalog().ok()?;
        let acro = catalog
            .get_deref(b"AcroForm", self.src)
            .ok()?
            .as_dict()
            .ok()?;
        let fields = acro.get_deref(b"Fields", self.src).ok()?.as_array().ok()?;
        let mut keep = Vec::new();
        for field in fields {
            let Ok(id) = field.as_reference() else {
                continue;
            };
            if self.field_is_copied(id) {
                keep.push(id);
            }
        }
        if keep.is_empty() {
            return None;
        }
        let mut rest = acro.clone();
        rest.remove(b"Fields");
        Some((rest, keep))
    }

    /// Whether a widget of the field (or the field, if it is its own widget) is among the copied objects.
    fn field_is_copied(&self, root: ObjectId) -> bool {
        let mut stack = vec![root];
        let mut seen = HashSet::new();
        while let Some(id) = stack.pop() {
            if !seen.insert(id) || seen.len() > 100_000 {
                continue;
            }
            let Ok(dict) = self.src.get_dictionary(id) else {
                continue;
            };
            match dict.get(b"Kids").and_then(Object::as_array) {
                Ok(kids) if !kids.is_empty() => {
                    stack.extend(kids.iter().filter_map(|kid| kid.as_reference().ok()));
                }
                _ => {
                    if self.map.contains_key(&id) {
                        return true;
                    }
                }
            }
        }
        false
    }
}

/// Whose objects a page is copied from.
#[derive(Clone, Copy)]
enum Who {
    Main,
    Source(usize),
    /// An importer of its own, for a page of a source that was taken before.
    Fresh(usize),
}

enum Planned {
    /// A page copied from a file; the number is its index there.
    Copy(Who, ObjectId, u32),
    Blank([f32; 2]),
}

/// Takes the widgets out of the annotations of a page that came from another file (forms of imported pages are not merged), and gives
/// the annotations that have no `/NM` the name the model knows them by (`annots::imported_name`, from the page's `index` in the file and
/// the place the annotation had before the widgets went). Returns whether there was a widget.
fn drop_widgets(src: &Document, page: &mut Dictionary, index: u32) -> bool {
    let entries = match page.get(b"Annots") {
        Ok(Object::Array(items)) => items.clone(),
        Ok(Object::Reference(id)) => match src.get_object(*id).and_then(Object::as_array) {
            Ok(items) => items.clone(),
            Err(_) => return false,
        },
        _ => return false,
    };
    let before = entries.len();
    let mut counted = 0u32;
    let mut kept: Vec<Object> = Vec::with_capacity(before);
    for entry in entries {
        let Some(dict) = src
            .dereference(&entry)
            .ok()
            .and_then(|(_, object)| object.as_dict().ok())
        else {
            kept.push(entry);
            continue;
        };
        let subtype = dict.get(b"Subtype").ok().and_then(|s| s.as_name().ok());
        let at = (subtype != Some(b"Popup")).then(|| {
            counted += 1;
            counted - 1
        });
        if subtype == Some(b"Widget") {
            continue;
        }
        match at {
            Some(at) if !super::annots::has_name(dict) => {
                let mut named = dict.clone();
                super::annots::stamp_name(&mut named, index, at);
                kept.push(Object::Dictionary(named));
            }
            _ => kept.push(entry),
        }
    }
    let dropped = kept.len() < before;
    page.set("Annots", Object::Array(kept));
    dropped
}

/// One input of an output: a read PDF and the pages of it that go in, in this order.
pub struct Part<'a> {
    pub parsed: &'a Parsed,
    /// Files that pages of this part were imported from (`PageKind::Imported { source }` is an index into this).
    pub sources: Vec<&'a Parsed>,
    pub pages: Vec<PageSel>,
    /// The name of the input, for the outline of a merge.
    pub title: &'a str,
}

fn text_string(text: &str) -> Object {
    let mut bytes = vec![0xFE, 0xFF];
    for unit in text.encode_utf16() {
        bytes.extend_from_slice(&unit.to_be_bytes());
    }
    Object::string_literal(bytes)
}

/// Builds one PDF from the pages of `parts`. With `outline` and more than one part the document has one bookmark per part.
pub fn build(parts: &[Part<'_>], outline: bool, control: &dyn Control) -> Result<Output, AppError> {
    let total: usize = parts.iter().map(|part| part.pages.len()).sum();
    if total == 0 {
        return Err(AppError::invalid("pages"));
    }
    if total > limits::MAX_PAGES as usize {
        return Err(AppError::limit("pages", u64::from(limits::MAX_PAGES)));
    }
    let total_u32 = u32::try_from(total).map_err(|_| AppError::invalid("pages"))?;

    let mut dst = Document::with_version("1.7");
    let root_pages = dst.new_object_id();
    let catalog = dst.new_object_id();
    let mut importers: Vec<Importer<'_>> = Vec::with_capacity(parts.len());
    let mut page_ids: Vec<ObjectId> = Vec::with_capacity(total);
    let mut first_pages: Vec<ObjectId> = Vec::with_capacity(parts.len());
    let mut done = 0u32;
    let mut extra_signatures = false;
    let mut widgets_dropped = false;

    for part in parts {
        let mut importer = Importer::new(part.parsed);
        let mut source_importers: Vec<Importer<'_>> = part
            .sources
            .iter()
            .map(|parsed| Importer::new(parsed))
            .collect();
        let mut seen_files = HashSet::new();
        let mut seen_imported = HashSet::new();
        let mut planned = Vec::with_capacity(part.pages.len());
        for selection in &part.pages {
            if !matches!(selection.rotation, None | Some(0 | 90 | 180 | 270)) {
                return Err(AppError::invalid("page"));
            }
            let new = dst.new_object_id();
            let plan = match selection.kind {
                PageKind::File { index } => {
                    let source = part
                        .parsed
                        .pages
                        .get(index as usize)
                        .copied()
                        .ok_or(AppError::invalid("page"))?;
                    if !seen_files.insert(index) {
                        return Err(AppError::invalid("page"));
                    }
                    importer.kept.insert(source, new);
                    Planned::Copy(Who::Main, source, index)
                }
                PageKind::Blank { width, height } => {
                    Planned::Blank(limits::sanitize_page_size(width, height))
                }
                PageKind::Imported { source, index } => {
                    let from = part.sources.get(source).ok_or(AppError::invalid("page"))?;
                    let page = from
                        .pages
                        .get(index as usize)
                        .copied()
                        .ok_or(AppError::invalid("page"))?;
                    if seen_imported.insert((source, index)) {
                        source_importers
                            .get_mut(source)
                            .ok_or(AppError::invalid("page"))?
                            .kept
                            .insert(page, new);
                        Planned::Copy(Who::Source(source), page, index)
                    } else {
                        // The same page of a source twice: the second copy brings its own objects.
                        Planned::Copy(Who::Fresh(source), page, index)
                    }
                }
            };
            planned.push((plan, new, selection.rotation));
        }
        if let Some(&(_, first, _)) = planned.first() {
            first_pages.push(first);
        }
        for (plan, new, rotation) in planned {
            control.check()?;
            let mut dict = match plan {
                Planned::Blank(size) => {
                    let mut dict = Dictionary::new();
                    dict.set(
                        "MediaBox",
                        vec![0.into(), 0.into(), size[0].into(), size[1].into()],
                    );
                    dict.set("Resources", Object::Dictionary(Dictionary::new()));
                    dict
                }
                Planned::Copy(who, source, page_index) => {
                    let mut fresh;
                    let from: &mut Importer<'_> = match who {
                        Who::Main => &mut importer,
                        Who::Source(at) => source_importers
                            .get_mut(at)
                            .ok_or(AppError::invalid("page"))?,
                        Who::Fresh(at) => {
                            let parsed = part.sources.get(at).ok_or(AppError::invalid("page"))?;
                            fresh = Importer::new(parsed);
                            fresh.kept.insert(source, new);
                            &mut fresh
                        }
                    };
                    let mut flat = from.flattened_page(source)?;
                    if !matches!(who, Who::Main) {
                        widgets_dropped |= drop_widgets(from.src, &mut flat, page_index);
                    }
                    let dict = from.translate_dict(&mut dst, &flat, 0, &PAGE_SKIP);
                    from.drain(&mut dst, control)?;
                    if !matches!(who, Who::Main) && from.signatures {
                        extra_signatures = true;
                    }
                    dict
                }
            };
            dict.set("Type", Object::Name(b"Page".to_vec()));
            if let Some(degrees) = rotation {
                dict.set("Rotate", i64::from(degrees));
            }
            dst.objects.insert(new, Object::Dictionary(dict));
            page_ids.push(new);
            done += 1;
            control.progress(Phase::Write, done, total_u32);
        }
        extra_signatures |= source_importers.iter().any(|i| i.signatures);
        importers.push(importer);
    }

    // The page tree: flat for up to 512 pages, else a node per 256.
    let reference = |id: ObjectId| Object::Reference(id);
    let (kids, nodes): (Vec<Object>, Vec<(ObjectId, Vec<ObjectId>)>) =
        if page_ids.len() <= limits::FLAT_KIDS_MAX {
            (
                page_ids.iter().copied().map(reference).collect(),
                Vec::new(),
            )
        } else {
            let mut nodes = Vec::new();
            for chunk in page_ids.chunks(limits::TREE_KIDS_PER_NODE) {
                nodes.push((dst.new_object_id(), chunk.to_vec()));
            }
            (nodes.iter().map(|(id, _)| reference(*id)).collect(), nodes)
        };
    for (node, children) in &nodes {
        let mut dict = Dictionary::new();
        dict.set("Type", Object::Name(b"Pages".to_vec()));
        dict.set("Parent", reference(root_pages));
        dict.set(
            "Kids",
            Object::Array(children.iter().copied().map(reference).collect()),
        );
        dict.set("Count", children.len() as i64);
        dst.objects.insert(*node, Object::Dictionary(dict));
        for child in children {
            set_parent(&mut dst, *child, *node)?;
        }
    }
    if nodes.is_empty() {
        for child in &page_ids {
            set_parent(&mut dst, *child, root_pages)?;
        }
    }
    let mut pages_dict = Dictionary::new();
    pages_dict.set("Type", Object::Name(b"Pages".to_vec()));
    pages_dict.set("Kids", Object::Array(kids));
    pages_dict.set("Count", total as i64);
    dst.objects
        .insert(root_pages, Object::Dictionary(pages_dict));

    let mut catalog_dict = Dictionary::new();
    catalog_dict.set("Type", Object::Name(b"Catalog".to_vec()));
    catalog_dict.set("Pages", reference(root_pages));

    // Forms: exactly one input with fields keeps them.
    let mut warnings = Vec::new();
    let forms: Vec<usize> = importers
        .iter()
        .enumerate()
        .filter(|(_, importer)| importer.form().is_some())
        .map(|(at, _)| at)
        .collect();
    match forms.as_slice() {
        [] => {}
        &[only] => {
            if let Some(importer) = importers.get_mut(only) {
                if let Some((rest, fields)) = importer.form() {
                    let mut acro =
                        importer.translate_dict(&mut dst, &rest, 0, &[b"SigFlags", b"XFA"]);
                    let mut mapped = Vec::with_capacity(fields.len());
                    for field in fields {
                        let object = importer.map_ref(&mut dst, field);
                        if !object.is_null() {
                            mapped.push(object);
                        }
                    }
                    importer.drain(&mut dst, control)?;
                    acro.set("Fields", Object::Array(mapped));
                    let id = dst.add_object(Object::Dictionary(acro));
                    catalog_dict.set("AcroForm", reference(id));
                }
            }
        }
        _ => warnings.push(Warning::FormsDropped),
    }

    if outline && parts.len() > 1 {
        if let Some(root) = build_outline(&mut dst, parts, &first_pages) {
            catalog_dict.set("Outlines", reference(root));
        }
    }
    dst.objects
        .insert(catalog, Object::Dictionary(catalog_dict));
    dst.trailer.set("Root", reference(catalog));

    // Title, author and the like of the first input.
    if let Some(importer) = importers.first_mut() {
        if let Ok(info) = importer
            .src
            .trailer
            .get(b"Info")
            .and_then(Object::as_reference)
        {
            let mapped = importer.map_ref(&mut dst, info);
            if !mapped.is_null() {
                importer.drain(&mut dst, control)?;
                dst.trailer.set("Info", mapped);
            }
        }
    }
    if widgets_dropped {
        warnings.push(Warning::WidgetsDropped);
    }
    if extra_signatures || importers.iter().any(|importer| importer.signatures) {
        warnings.push(Warning::SignaturesRemoved);
    }

    control.check()?;
    let mut bytes = Vec::new();
    dst.save_to(&mut bytes).map_err(failed)?;
    control.progress(Phase::Validate, 0, 1);
    validate(&bytes, total_u32)?;
    control.progress(Phase::Validate, 1, 1);
    Ok(Output {
        bytes,
        pages: total_u32,
        warnings,
    })
}

fn set_parent(dst: &mut Document, page: ObjectId, parent: ObjectId) -> Result<(), AppError> {
    dst.get_dictionary_mut(page)
        .map_err(failed)?
        .set("Parent", Object::Reference(parent));
    Ok(())
}

/// One bookmark per input, each to the input's first page. `None` if no input has a page.
fn build_outline(
    dst: &mut Document,
    parts: &[Part<'_>],
    first_pages: &[ObjectId],
) -> Option<ObjectId> {
    if first_pages.is_empty() {
        return None;
    }
    let root = dst.new_object_id();
    let items: Vec<ObjectId> = first_pages.iter().map(|_| dst.new_object_id()).collect();
    let titled = parts.iter().filter(|part| !part.pages.is_empty());
    for (at, (part, &page)) in titled.zip(first_pages).enumerate() {
        let Some(&item) = items.get(at) else { continue };
        let title = sanitize_text(part.title, 256);
        let mut dict = Dictionary::new();
        dict.set("Title", text_string(&title));
        dict.set("Parent", Object::Reference(root));
        dict.set(
            "Dest",
            Object::Array(vec![Object::Reference(page), Object::Name(b"Fit".to_vec())]),
        );
        if let Some(&previous) = at.checked_sub(1).and_then(|p| items.get(p)) {
            dict.set("Prev", Object::Reference(previous));
        }
        if let Some(&next) = items.get(at + 1) {
            dict.set("Next", Object::Reference(next));
        }
        dst.objects.insert(item, Object::Dictionary(dict));
    }
    let mut outlines = Dictionary::new();
    outlines.set("Type", Object::Name(b"Outlines".to_vec()));
    outlines.set("First", Object::Reference(*items.first()?));
    outlines.set("Last", Object::Reference(*items.last()?));
    outlines.set("Count", items.len() as i64);
    dst.objects.insert(root, Object::Dictionary(outlines));
    Some(root)
}

/// The part of `plan` (its page indices are positions in the document) that concerns the pages `documents` (positions in the document,
/// in the order they have in the output): page index `documents[j]` becomes `base + j`. Annotations and origins of other pages are left
/// out. A page that is in the output more than once has its annotations in each place: one plan for each round of copies (annotation
/// ids must be unique within a plan), to be written one after the other.
pub fn plan_for_output(plan: &Plan, documents: &[u32], base: u32) -> Vec<Plan> {
    let mut places: HashMap<u32, Vec<u32>> = HashMap::new();
    for (offset, document) in documents.iter().enumerate() {
        if let Ok(offset) = u32::try_from(offset) {
            places
                .entry(*document)
                .or_default()
                .push(base.saturating_add(offset));
        }
    }
    let rounds = places.values().map(Vec::len).max().unwrap_or(0);
    (0..rounds)
        .map(|round| {
            let place = |page: &u32| places.get(page).and_then(|list| list.get(round)).copied();
            let moved = |origin: &PdfOrigin| {
                place(&origin.page_index).map(|page_index| PdfOrigin {
                    page_index,
                    ..origin.clone()
                })
            };
            let mut out = Plan {
                assets: plan.assets.clone(),
                ..Plan::default()
            };
            for change in &plan.changes {
                match change {
                    Change::Write {
                        page_index,
                        annotation,
                        origin,
                    } => {
                        if let Some(page_index) = place(page_index) {
                            out.changes.push(Change::Write {
                                page_index,
                                annotation: annotation.clone(),
                                origin: origin.as_ref().and_then(moved),
                            });
                        }
                    }
                    Change::Delete { id, origin } => {
                        if let Some(origin) = moved(origin) {
                            out.changes.push(Change::Delete { id: *id, origin });
                        }
                    }
                }
            }
            out.known = plan
                .known
                .iter()
                .filter_map(|(id, origin)| moved(origin).map(|origin| (*id, origin)))
                .collect();
            out
        })
        .collect()
}

/// Writes the annotations of `plans` (new, changed and deleted ones, with their appearance streams, as a save does) into `bytes`, a
/// file this module produced that has `pages` pages. Nothing to write: `bytes` as they are.
pub fn annotate(bytes: Vec<u8>, plans: &[Plan], pages: u32) -> Result<Vec<u8>, AppError> {
    let mut bytes = bytes;
    for plan in plans.iter().filter(|plan| !plan.changes.is_empty()) {
        let built = append_annotations(bytes, plan)?;
        validate(&built.bytes, pages)?;
        bytes = built.bytes;
    }
    Ok(bytes)
}

/// The pages of one input in a new file (extract, and each file of a split).
pub fn build_one(
    parsed: &Parsed,
    pages: &[PageSel],
    control: &dyn Control,
) -> Result<Output, AppError> {
    build(
        &[Part {
            parsed,
            sources: Vec::new(),
            pages: pages.to_vec(),
            title: "",
        }],
        false,
        control,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::Dictionary;

    fn code<T: std::fmt::Debug>(result: Result<T, AppError>) -> ErrorCode {
        result.unwrap_err().code()
    }

    #[test]
    fn ranges_parse_pages_spans_and_open_ends() {
        assert_eq!(
            parse_ranges("1-3, 5, 8-", 10).unwrap(),
            vec![(1, 3), (5, 5), (8, 10)]
        );
        assert_eq!(parse_ranges(" 2 - 4 ", 4).unwrap(), vec![(2, 4)]);
        assert_eq!(parse_ranges("7", 7).unwrap(), vec![(7, 7)]);
        // Overlaps and any order are the user's business: each range is a file.
        assert_eq!(
            parse_ranges("5-6,1,5-6", 6).unwrap(),
            vec![(5, 6), (1, 1), (5, 6)]
        );
        assert_eq!(parse_ranges("3-", 3).unwrap(), vec![(3, 3)]);
    }

    #[test]
    fn ranges_refuse_everything_else() {
        for bad in [
            "", " ", ",", "1,", ",1", "1,,2", "0", "0-3", "1-0", "3-2", "11", "1-11", "12-", "-3",
            "a", "1-a", "1 2", "1--2", "+1", "1.5", "-", "1-2-3", "１", "0000001", "9999999",
        ] {
            assert_eq!(
                code(parse_ranges(bad, 10)),
                ErrorCode::InvalidArgument,
                "{bad:?}"
            );
        }
        let many = vec!["1"; limits::MAX_SPLIT_OUTPUTS + 1].join(",");
        assert_eq!(code(parse_ranges(&many, 10)), ErrorCode::LimitExceeded);
        assert_eq!(code(parse_ranges("1", 0)), ErrorCode::InvalidArgument);
        // The last allowed number of ranges works.
        let max = vec!["1"; limits::MAX_SPLIT_OUTPUTS].join(",");
        assert_eq!(
            parse_ranges(&max, 10).unwrap().len(),
            limits::MAX_SPLIT_OUTPUTS
        );
    }

    #[test]
    fn groups_every_n_and_before() {
        assert_eq!(
            groups_every_n(5, 2).unwrap(),
            vec![vec![0, 1], vec![2, 3], vec![4]]
        );
        assert_eq!(groups_every_n(3, 10_000).unwrap(), vec![vec![0, 1, 2]]);
        assert_eq!(code(groups_every_n(5, 0)), ErrorCode::InvalidArgument);
        assert_eq!(code(groups_every_n(5, 10_001)), ErrorCode::InvalidArgument);
        assert_eq!(code(groups_every_n(0, 1)), ErrorCode::InvalidArgument);
        assert_eq!(code(groups_every_n(1_001, 1)), ErrorCode::LimitExceeded);
        assert_eq!(groups_every_n(1_000, 1).unwrap().len(), 1_000);

        assert_eq!(
            groups_before(6, &[4, 2, 2, 0]).unwrap(),
            vec![vec![0, 1], vec![2, 3], vec![4, 5]]
        );
        assert_eq!(groups_before(3, &[]).unwrap(), vec![vec![0, 1, 2]]);
        assert_eq!(code(groups_before(3, &[3])), ErrorCode::InvalidArgument);
        assert_eq!(
            groups_from_ranges(&[(2, 3), (5, 5)]),
            vec![vec![1, 2], vec![4]]
        );
    }

    #[test]
    fn a_page_tree_that_is_not_a_tree_is_damaged_not_a_panic() {
        assert_eq!(code(load(b"%PDF-1.4\nnot a pdf")), ErrorCode::DamagedFile);
        assert_eq!(
            load(b"").err().map(|e| e.code()),
            Some(ErrorCode::DamagedFile)
        );
    }

    // --- Documents built here, extracted, merged, read back ---

    fn name(value: &str) -> Object {
        Object::Name(value.as_bytes().to_vec())
    }

    fn rect() -> Object {
        vec![0.into(), 0.into(), 10.into(), 10.into()].into()
    }

    /// `count` pages. The tree has a middle node that holds `/Resources` and `/MediaBox` (inherited). Page `i` shows the text
    /// `page-i-text`, has a link to page `i + 1` (`/Dest`), a highlight with an appearance stream and, with `form`, a text field.
    /// `signed` adds a signature field with a value on page 0; `/Outlines` has one item per page.
    fn sample(count: u32, form: bool, signed: bool) -> Vec<u8> {
        let mut doc = Document::with_version("1.5");
        let root = doc.new_object_id();
        let middle = doc.new_object_id();
        let ids: Vec<ObjectId> = (0..count).map(|_| doc.new_object_id()).collect();
        let mut fields = Vec::new();
        for (i, &page) in ids.iter().enumerate() {
            let content = doc.add_object(Object::Stream(Stream::new(
                Dictionary::new(),
                format!("BT (page-{i}-text) Tj ET").into_bytes(),
            )));
            let mut annots = Vec::new();
            let mut link = Dictionary::new();
            link.set("Type", name("Annot"));
            link.set("Subtype", name("Link"));
            link.set("Rect", rect());
            link.set("P", Object::Reference(page));
            if let Some(&next) = ids.get(i + 1) {
                link.set("Dest", vec![Object::Reference(next), name("Fit")]);
            }
            annots.push(Object::Reference(doc.add_object(link)));
            let appearance = doc.add_object(Object::Stream(Stream::new(
                Dictionary::new(),
                format!("0 0 1 rg 0 0 10 10 re f % ap-{i}").into_bytes(),
            )));
            let mut ap = Dictionary::new();
            ap.set("N", Object::Reference(appearance));
            let mut highlight = Dictionary::new();
            highlight.set("Type", name("Annot"));
            highlight.set("Subtype", name("Highlight"));
            highlight.set("Rect", rect());
            highlight.set("AP", Object::Dictionary(ap));
            highlight.set("P", Object::Reference(page));
            annots.push(Object::Reference(doc.add_object(highlight)));
            if form {
                let mut field = Dictionary::new();
                field.set("Type", name("Annot"));
                field.set("Subtype", name("Widget"));
                field.set("FT", name("Tx"));
                field.set("T", Object::string_literal(format!("field-{i}")));
                field.set("Rect", rect());
                field.set("P", Object::Reference(page));
                let id = doc.add_object(field);
                fields.push(Object::Reference(id));
                annots.push(Object::Reference(id));
            }
            if signed && i == 0 {
                let mut value = Dictionary::new();
                value.set("Type", name("Sig"));
                value.set("ByteRange", vec![0.into(), 1.into(), 2.into(), 3.into()]);
                value.set("Contents", Object::string_literal(vec![0u8; 8]));
                let value = doc.add_object(value);
                let mut field = Dictionary::new();
                field.set("Type", name("Annot"));
                field.set("Subtype", name("Widget"));
                field.set("FT", name("Sig"));
                field.set("T", Object::string_literal("sig"));
                field.set("V", Object::Reference(value));
                field.set("Rect", rect());
                field.set("P", Object::Reference(page));
                let id = doc.add_object(field);
                fields.push(Object::Reference(id));
                annots.push(Object::Reference(id));
            }
            let mut dict = Dictionary::new();
            dict.set("Type", name("Page"));
            dict.set("Parent", Object::Reference(middle));
            dict.set("Contents", Object::Reference(content));
            dict.set("Annots", Object::Array(annots));
            doc.objects.insert(page, Object::Dictionary(dict));
        }
        let mut node = Dictionary::new();
        node.set("Type", name("Pages"));
        node.set("Parent", Object::Reference(root));
        node.set(
            "Kids",
            Object::Array(ids.iter().copied().map(Object::Reference).collect()),
        );
        node.set("Count", i64::from(count));
        node.set("MediaBox", vec![0.into(), 0.into(), 200.into(), 300.into()]);
        node.set("Resources", Object::Dictionary(Dictionary::new()));
        doc.objects.insert(middle, Object::Dictionary(node));
        let mut tree = Dictionary::new();
        tree.set("Type", name("Pages"));
        tree.set("Kids", vec![Object::Reference(middle)]);
        tree.set("Count", i64::from(count));
        doc.objects.insert(root, Object::Dictionary(tree));
        let mut catalog = Dictionary::new();
        catalog.set("Type", name("Catalog"));
        catalog.set("Pages", Object::Reference(root));
        // An outline: its items point at every page, so a copy that followed it would take the whole file along.
        let outlines = doc.new_object_id();
        let items: Vec<ObjectId> = ids
            .iter()
            .enumerate()
            .map(|(i, &page)| {
                let mut item = Dictionary::new();
                item.set("Title", Object::string_literal(format!("outline-{i}")));
                item.set("Parent", Object::Reference(outlines));
                item.set("Dest", vec![Object::Reference(page), name("Fit")]);
                doc.add_object(item)
            })
            .collect();
        let mut outline = Dictionary::new();
        outline.set("Type", name("Outlines"));
        if let (Some(&first), Some(&last)) = (items.first(), items.last()) {
            outline.set("First", Object::Reference(first));
            outline.set("Last", Object::Reference(last));
        }
        doc.objects.insert(outlines, Object::Dictionary(outline));
        catalog.set("Outlines", Object::Reference(outlines));
        if form || signed {
            let mut acro = Dictionary::new();
            acro.set("Fields", Object::Array(fields));
            acro.set("SigFlags", 3);
            catalog.set("AcroForm", Object::Dictionary(acro));
        }
        let mut perms = Dictionary::new();
        perms.set("DocMDP", Object::Null);
        catalog.set("Perms", Object::Dictionary(perms));
        let catalog = doc.add_object(catalog);
        doc.trailer.set("Root", Object::Reference(catalog));
        let mut info = Dictionary::new();
        info.set("Title", Object::string_literal("A title"));
        let info = doc.add_object(info);
        doc.trailer.set("Info", Object::Reference(info));
        let mut out = Vec::new();
        doc.save_to(&mut out).unwrap();
        out
    }

    fn contains(haystack: &[u8], needle: &str) -> bool {
        haystack
            .windows(needle.len())
            .any(|window| window == needle.as_bytes())
    }

    /// The number in the text of each page of `bytes`, in order (`page-3-text` is `3`).
    fn page_order(bytes: &[u8]) -> Vec<u32> {
        let parsed = load(bytes).unwrap();
        parsed
            .pages
            .iter()
            .map(|&page| {
                let dict = parsed.doc.get_dictionary(page).unwrap();
                let content = dict.get_deref(b"Contents", &parsed.doc).unwrap();
                let text =
                    String::from_utf8_lossy(&content.as_stream().unwrap().content).into_owned();
                text.trim_start_matches("BT (page-")
                    .split('-')
                    .next()
                    .unwrap()
                    .parse()
                    .unwrap()
            })
            .collect()
    }

    fn extract(bytes: &[u8], pages: &[u32]) -> Result<Output, AppError> {
        let parsed = load(bytes)?;
        let selection: Vec<PageSel> = pages.iter().copied().map(PageSel::plain).collect();
        build_one(&parsed, &selection, &Unattended)
    }

    fn annots_of(parsed: &Parsed, page: ObjectId) -> Vec<Dictionary> {
        let dict = parsed.doc.get_dictionary(page).unwrap();
        dict.get(b"Annots")
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| match entry {
                // An annotation that had no name comes as a dictionary of its own, with the name the model knows it by.
                Object::Dictionary(dict) => dict.clone(),
                other => parsed
                    .doc
                    .get_dictionary(other.as_reference().unwrap())
                    .unwrap()
                    .clone(),
            })
            .collect()
    }

    #[test]
    fn extract_keeps_the_chosen_pages_in_order_and_nothing_of_the_others() {
        let source = sample(5, false, false);
        let output = extract(&source, &[3, 1]).unwrap();
        assert_eq!(output.pages, 2);
        assert_eq!(page_order(&output.bytes), vec![3, 1]);
        // The other pages' content, their outline and link targets are not in the file.
        for gone in [
            "page-0-text",
            "page-2-text",
            "page-4-text",
            "outline-",
            "Outlines",
            "ap-0",
            "ap-2",
            "Perms",
        ] {
            assert!(
                !contains(&output.bytes, gone),
                "{gone} is still in the file"
            );
        }
        for kept in ["page-3-text", "page-1-text", "ap-3", "ap-1"] {
            assert!(contains(&output.bytes, kept), "{kept} is gone");
        }
        let parsed = load(&output.bytes).unwrap();
        for &page in &parsed.pages {
            let dict = parsed.doc.get_dictionary(page).unwrap();
            // The inherited box was written into the page, the annotations stayed with their appearance.
            assert_eq!(dict.get(b"MediaBox").unwrap().as_array().unwrap().len(), 4);
            let annots = annots_of(&parsed, page);
            assert_eq!(annots.len(), 2);
            let highlight = &annots[1];
            assert!(highlight
                .get_deref(b"AP", &parsed.doc)
                .unwrap()
                .as_dict()
                .unwrap()
                .has(b"N"));
            assert_eq!(highlight.get(b"P").unwrap().as_reference().unwrap(), page);
            // Page 3's link points to page 4 and page 1's to page 2, neither in the file: no destination is left.
            assert!(!annots[0].has(b"Dest"));
        }
        assert!(contains(&output.bytes, "A title"));
        assert!(output.warnings.is_empty());
    }

    #[test]
    fn a_link_between_two_kept_pages_survives() {
        let source = sample(4, false, false);
        let output = extract(&source, &[2, 3]).unwrap();
        let parsed = load(&output.bytes).unwrap();
        let annots = annots_of(&parsed, parsed.pages[0]);
        let dest = annots[0].get(b"Dest").unwrap().as_array().unwrap();
        assert_eq!(dest[0].as_reference().unwrap(), parsed.pages[1]);
    }

    #[test]
    fn selections_must_be_unique_existing_and_not_empty() {
        let source = sample(3, false, false);
        for bad in [&[][..], &[0, 0], &[3], &[u32::MAX]] {
            assert_eq!(
                code(extract(&source, bad)),
                ErrorCode::InvalidArgument,
                "{bad:?}"
            );
        }
        let parsed = load(&source).unwrap();
        let rotated = [PageSel::file(0, Some(45))];
        assert_eq!(
            code(build_one(&parsed, &rotated, &Unattended)),
            ErrorCode::InvalidArgument
        );
    }

    #[test]
    fn the_rotation_of_the_model_is_written() {
        let source = sample(2, false, false);
        let parsed = load(&source).unwrap();
        let output = build_one(
            &parsed,
            &[PageSel::file(1, Some(270)), PageSel::file(0, Some(0))],
            &Unattended,
        )
        .unwrap();
        let out = load(&output.bytes).unwrap();
        let rotation = |at: usize| {
            out.doc
                .get_dictionary(out.pages[at])
                .unwrap()
                .get(b"Rotate")
                .unwrap()
                .as_i64()
                .unwrap()
        };
        assert_eq!((rotation(0), rotation(1)), (270, 0));
    }

    #[test]
    fn signatures_are_removed_and_said_so() {
        let source = sample(2, false, true);
        let output = extract(&source, &[0, 1]).unwrap();
        assert_eq!(output.warnings, vec![Warning::SignaturesRemoved]);
        assert!(!contains(&output.bytes, "ByteRange"));
        // The field stays (unsigned); the form survives with it.
        assert!(contains(&output.bytes, "AcroForm"));
        assert!(!contains(&output.bytes, "SigFlags"));
    }

    #[test]
    fn a_form_keeps_only_the_fields_of_the_kept_pages() {
        let source = sample(3, true, false);
        let output = extract(&source, &[2]).unwrap();
        assert!(contains(&output.bytes, "field-2"));
        assert!(!contains(&output.bytes, "field-0"));
        assert!(!contains(&output.bytes, "field-1"));
        let parsed = load(&output.bytes).unwrap();
        let catalog = parsed.doc.catalog().unwrap();
        let acro = catalog
            .get_deref(b"AcroForm", &parsed.doc)
            .unwrap()
            .as_dict()
            .unwrap();
        assert_eq!(acro.get(b"Fields").unwrap().as_array().unwrap().len(), 1);
    }

    fn all_pages(parsed: &Parsed) -> Vec<PageSel> {
        (0..parsed.pages.len() as u32).map(PageSel::plain).collect()
    }

    #[test]
    fn merge_joins_inputs_with_one_bookmark_each() {
        let a = load(&sample(3, false, false)).unwrap();
        let b = load(&sample(2, false, false)).unwrap();
        let parts = [
            Part {
                parsed: &a,
                sources: Vec::new(),
                pages: all_pages(&a),
                title: "First",
            },
            Part {
                parsed: &b,
                sources: Vec::new(),
                pages: all_pages(&b),
                title: "Second",
            },
        ];
        let output = build(&parts, true, &Unattended).unwrap();
        assert_eq!(output.pages, 5);
        assert_eq!(page_order(&output.bytes), vec![0, 1, 2, 0, 1]);
        let parsed = load(&output.bytes).unwrap();
        let catalog = parsed.doc.catalog().unwrap();
        let outlines = catalog
            .get_deref(b"Outlines", &parsed.doc)
            .unwrap()
            .as_dict()
            .unwrap();
        assert_eq!(outlines.get(b"Count").unwrap().as_i64().unwrap(), 2);
        let last = outlines.get(b"Last").unwrap().as_reference().unwrap();
        let second = parsed.doc.get_dictionary(last).unwrap();
        let dest = second.get(b"Dest").unwrap().as_array().unwrap();
        assert_eq!(dest[0].as_reference().unwrap(), parsed.pages[3]);
        assert!(!contains(&output.bytes, "outline-"));
    }

    #[test]
    fn merge_keeps_one_form_and_drops_two() {
        let one = load(&sample(2, true, false)).unwrap();
        let none = load(&sample(2, false, false)).unwrap();
        let parts = [
            Part {
                parsed: &one,
                sources: Vec::new(),
                pages: all_pages(&one),
                title: "a",
            },
            Part {
                parsed: &none,
                sources: Vec::new(),
                pages: all_pages(&none),
                title: "b",
            },
        ];
        let output = build(&parts, false, &Unattended).unwrap();
        assert!(output.warnings.is_empty());
        assert!(contains(&output.bytes, "AcroForm"));
        let two = [
            Part {
                parsed: &one,
                sources: Vec::new(),
                pages: all_pages(&one),
                title: "a",
            },
            Part {
                parsed: &one,
                sources: Vec::new(),
                pages: all_pages(&one),
                title: "b",
            },
        ];
        let output = build(&two, false, &Unattended).unwrap();
        assert_eq!(output.warnings, vec![Warning::FormsDropped]);
        assert!(!contains(&output.bytes, "AcroForm"));
        // The widgets are still on the pages: they show, they just are not fields any more.
        assert!(contains(&output.bytes, "Widget"));
    }

    #[test]
    fn a_long_document_gets_a_two_level_tree() {
        let source = sample(600, false, false);
        let order: Vec<u32> = (0..600).rev().collect();
        let output = extract(&source, &order).unwrap();
        assert_eq!(output.pages, 600);
        assert_eq!(page_order(&output.bytes), order);
        let parsed = load(&output.bytes).unwrap();
        let root = parsed
            .doc
            .catalog()
            .unwrap()
            .get_deref(b"Pages", &parsed.doc)
            .unwrap()
            .as_dict()
            .unwrap();
        assert_eq!(root.get(b"Kids").unwrap().as_array().unwrap().len(), 3);
        assert_eq!(root.get(b"Count").unwrap().as_i64().unwrap(), 600);
    }

    struct StopAfter(std::cell::Cell<u32>);

    impl Control for StopAfter {
        fn check(&self) -> Result<(), AppError> {
            let left = self.0.get();
            if left == 0 {
                return Err(AppError::new(ErrorCode::Cancelled));
            }
            self.0.set(left - 1);
            Ok(())
        }
        fn progress(&self, _: Phase, _: u32, _: u32) {}
    }

    #[test]
    fn a_cancelled_job_stops_with_cancelled_and_produces_nothing() {
        let source = sample(10, false, false);
        let parsed = load(&source).unwrap();
        let pages: Vec<PageSel> = (0..10).map(PageSel::plain).collect();
        let result = build_one(&parsed, &pages, &StopAfter(std::cell::Cell::new(3)));
        assert_eq!(code(result), ErrorCode::Cancelled);
    }

    #[test]
    fn a_page_that_reaches_itself_does_not_loop() {
        let source = sample(2, false, false);
        let mut hostile = load(&source).unwrap();
        let page = hostile.pages[0];
        if let Ok(dict) = hostile.doc.get_dictionary_mut(page) {
            dict.set("Annots", vec![Object::Reference(page)]);
            dict.set("Contents", Object::Reference(page));
        }
        let selection = [PageSel::plain(0)];
        assert!(build_one(&hostile, &selection, &Unattended).is_ok());
    }

    #[test]
    fn blank_and_imported_pages_are_part_of_the_output() {
        let own = load(&sample(2, false, false)).unwrap();
        let other = load(&sample(3, true, false)).unwrap();
        let pages = vec![
            PageSel::plain(1),
            PageSel {
                kind: PageKind::Blank {
                    width: 100.0,
                    height: 50.0,
                },
                rotation: Some(90),
            },
            PageSel {
                kind: PageKind::Imported {
                    source: 0,
                    index: 2,
                },
                rotation: None,
            },
            // The same source page again: it brings its own copy.
            PageSel {
                kind: PageKind::Imported {
                    source: 0,
                    index: 2,
                },
                rotation: None,
            },
            PageSel::plain(0),
        ];
        let part = Part {
            parsed: &own,
            sources: vec![&other],
            pages,
            title: "x",
        };
        let output = build(&[part], false, &Unattended).unwrap();
        assert_eq!(output.pages, 5);
        let parsed = load(&output.bytes).unwrap();
        let blank = parsed.doc.get_dictionary(parsed.pages[1]).unwrap();
        let media: Vec<f32> = blank
            .get(b"MediaBox")
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .map(|n| n.as_float().unwrap())
            .collect();
        assert_eq!(media, vec![0.0, 0.0, 100.0, 50.0]);
        assert_eq!(blank.get(b"Rotate").unwrap().as_i64().unwrap(), 90);
        // Imported pages keep their content and annotations but not their form fields.
        for at in [2, 3] {
            let annots = annots_of(&parsed, parsed.pages[at]);
            assert_eq!(annots.len(), 2, "link and highlight, no widget");
            assert!(contains(&output.bytes, "page-2-text"));
        }
        assert_eq!(output.warnings, vec![Warning::WidgetsDropped]);
        assert!(!contains(&output.bytes, "field-2"));
        assert!(!contains(&output.bytes, "AcroForm"));
    }

    #[test]
    fn an_imported_page_that_is_not_there_is_refused() {
        let own = load(&sample(1, false, false)).unwrap();
        let part = Part {
            parsed: &own,
            sources: Vec::new(),
            pages: vec![PageSel {
                kind: PageKind::Imported {
                    source: 0,
                    index: 0,
                },
                rotation: None,
            }],
            title: "x",
        };
        assert_eq!(
            code(build(&[part], false, &Unattended)),
            ErrorCode::InvalidArgument
        );
    }
}
