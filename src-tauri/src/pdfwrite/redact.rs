//! The pages true redaction leaves behind (ADR-055, which supersedes the raster page of ADR-047 §3).
//!
//! A redacted page is the original page without what lay under the marks ([`super::redact_content`]): the text, vectors and images
//! outside the marks are still the page's own. The save puts that one-page PDF where the original was, and [`finish`] scrubs what
//! still held content of the original (the structure tree with its `/ActualText`, fields whose widgets were on the page) and writes
//! a new `/ID`. The original page itself is never copied: a Full save only carries what the page tree reaches (`pagetree::compact`).

use std::collections::HashSet;
use std::sync::Arc;

use lopdf::{Document, Object, ObjectId, StringFormat};

use super::pagetree::on_big_stack;
use super::prescan::load_untrusted;
use super::redact_content::{redacted_blank, redacted_page};
use crate::error::{AppError, ErrorCode};
use crate::limits;
use crate::model::geometry::Rect;

/// Most nodes of the form tree [`scrub`] looks at (a hostile file may make it as large as it likes).
const MAX_FIELD_NODES: usize = 100_000;
const MAX_FIELD_DEPTH: usize = 16;

/// A bitmap as PDFium drew it (page export, print).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum RasterPixels {
    Rgb8(Vec<u8>),
    Gray8(Vec<u8>),
}

/// A rendered page.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct RasterPage {
    pub pixels: RasterPixels,
    pub width: u32,
    pub height: u32,
}

impl RasterPage {
    /// A picture from tightly packed RGB rows; one whose pixels are all grey becomes a grey one.
    pub fn from_rgb(rgb: Vec<u8>, width: u32, height: u32) -> Self {
        let (triples, _) = rgb.as_chunks::<3>();
        let grey = triples.iter().all(|[r, g, b]| r == g && g == b);
        let pixels = if grey {
            RasterPixels::Gray8(triples.iter().map(|[r, _, _]| *r).collect())
        } else {
            RasterPixels::Rgb8(rgb)
        };
        Self {
            pixels,
            width,
            height,
        }
    }
}

/// A parsed plain PDF the pages of one redaction job come from (the file, an import source or an earlier redacted page), parsed once.
#[derive(Clone)]
pub struct PdfSource {
    doc: Arc<Document>,
    pages: Arc<Vec<ObjectId>>,
}

impl PdfSource {
    /// Parses `bytes` on a thread with a big stack. An encrypted file is `unsupported_feature` (decrypt it first).
    pub fn parse(bytes: Vec<u8>) -> Result<Self, AppError> {
        on_big_stack(move || {
            let doc = load_untrusted(&bytes)?;
            if doc.is_encrypted() {
                return Err(AppError::new(ErrorCode::UnsupportedFeature));
            }
            let pages: Vec<ObjectId> = doc.get_pages().into_values().collect();
            Ok(Self {
                doc: Arc::new(doc),
                pages: Arc::new(pages),
            })
        })
    }

    /// The one-page PDF of page `index` of the file without what lies under `burn` ([`redacted_page`]).
    pub fn redact_page(
        &self,
        index: u32,
        shown: [f32; 4],
        rotation: u16,
        burn: Vec<Rect>,
    ) -> Result<Vec<u8>, AppError> {
        let object = usize::try_from(index)
            .ok()
            .and_then(|index| self.pages.get(index))
            .copied()
            .ok_or(AppError::invalid("redaction"))?;
        let doc = self.doc.clone();
        on_big_stack(move || redacted_page(&doc, object, shown, rotation, &burn))
    }
}

/// The one-page PDF of a blank page with the marks painted black ([`redacted_blank`]), on a thread with a big stack.
pub fn redact_blank(size: [f32; 2], rotation: u16, burn: Vec<Rect>) -> Result<Vec<u8>, AppError> {
    on_big_stack(move || redacted_blank(size, rotation, &burn))
}

/// The decoded content of page `index` of a saved file (for the tests).
pub fn page_content_of(bytes: &[u8], index: usize) -> Result<String, AppError> {
    let doc = load_untrusted(bytes)?;
    let page = doc
        .get_pages()
        .into_values()
        .nth(index)
        .ok_or(AppError::invalid("page"))?;
    Ok(String::from_utf8_lossy(&doc.get_page_content(page)).into_owned())
}

/// The decoded samples of every image object of a saved file (for the tests).
pub fn images_of(bytes: &[u8]) -> Result<Vec<Vec<u8>>, AppError> {
    let doc = load_untrusted(bytes)?;
    Ok(doc
        .objects
        .values()
        .filter_map(|object| object.as_stream().ok())
        .filter(|stream| {
            stream
                .dict
                .get(b"Subtype")
                .and_then(Object::as_name)
                .is_ok_and(|name| name == b"Image")
        })
        .filter_map(|stream| stream.decompressed_content().ok())
        .collect())
}

fn failed(detail: impl std::fmt::Display) -> AppError {
    AppError::logged(ErrorCode::SaveFailed, detail)
}

fn lopdf_error(error: impl std::fmt::Display) -> AppError {
    failed(format!("lopdf: {error}"))
}

/// Whether `page` was made by `redact_content` (it carries its marker).
fn is_redacted_page(doc: &Document, page: ObjectId) -> bool {
    doc.get_dictionary(page)
        .is_ok_and(|dict| dict.has(super::redact_content::MARKER))
}

fn resolve_array(doc: &Document, object: &Object) -> Option<Vec<Object>> {
    let mut current = object;
    for _ in 0..8 {
        match current {
            Object::Reference(id) => current = doc.get_object(*id).ok()?,
            Object::Array(items) => return Some(items.clone()),
            _ => return None,
        }
    }
    None
}

/// The pages of `doc` that `redact_content` made.
pub fn redacted_pages(doc: &Document) -> Vec<ObjectId> {
    doc.get_pages()
        .into_values()
        .filter(|page| is_redacted_page(doc, *page))
        .collect()
}

/// Removes what still holds content of the redacted pages: `/StructTreeRoot`, `/MarkInfo`, `/Thumb` and `/PieceInfo` of `redacted`,
/// fields whose every widget was on them, and writes a new `/ID`. With `strip_hidden` the document-level data that can hold the text too
/// goes: `/Outlines` (bookmark titles), `/Names` (named destinations, JavaScript, embedded files), `/Dests`, `/PageLabels`, `/AF`,
/// `/OpenAction` and the catalog's `/AA`.
pub fn scrub(
    doc: &mut Document,
    redacted: &[ObjectId],
    strip_hidden: bool,
) -> Result<(), AppError> {
    // The structure tree holds `/ActualText` and `/Alt` of what was on the pages, and `/MarkInfo` only says that it exists.
    let root = doc
        .trailer
        .get(b"Root")
        .and_then(Object::as_reference)
        .map_err(lopdf_error)?;
    let catalog = doc.get_dictionary_mut(root).map_err(lopdf_error)?;
    catalog.remove(b"StructTreeRoot");
    catalog.remove(b"MarkInfo");
    if strip_hidden {
        for key in HIDDEN_DATA {
            catalog.remove(key);
        }
    }
    for page in redacted {
        if let Ok(dict) = doc.get_dictionary_mut(*page) {
            for key in [
                &b"Thumb"[..],
                b"PieceInfo",
                b"StructParents",
                b"Metadata",
                super::redact_content::MARKER,
            ] {
                dict.remove(key);
            }
        }
    }
    drop_orphan_fields(doc, root);
    doc.trailer.set("ID", fresh_id()?);
    Ok(())
}

/// The catalog entries `scrub` takes out with `strip_hidden`.
const HIDDEN_DATA: [&[u8]; 8] = [
    b"Outlines",
    b"Names",
    b"Dests",
    b"PageLabels",
    b"AF",
    b"OpenAction",
    b"AA",
    b"Threads",
];

/// A new `/ID`: two random strings of 16 bytes.
fn fresh_id() -> Result<Object, AppError> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|error| failed(format!("random: {error}")))?;
    let (first, second) = bytes.split_at(16);
    Ok(Object::Array(vec![
        Object::String(first.to_vec(), StringFormat::Hexadecimal),
        Object::String(second.to_vec(), StringFormat::Hexadecimal),
    ]))
}

/// The widgets that are on a page of the document, by object.
fn live_widgets(doc: &Document) -> HashSet<ObjectId> {
    let mut live = HashSet::new();
    for page in doc.get_pages().into_values() {
        let Some(page) = doc.get_dictionary(page).ok() else {
            continue;
        };
        let Some(annots) = page.get(b"Annots").ok().and_then(|a| resolve_array(doc, a)) else {
            continue;
        };
        for entry in annots.into_iter().take(limits::MAX_ANNOTS_ARRAY) {
            if let Object::Reference(id) = entry {
                live.insert(id);
            }
        }
    }
    live
}

/// Takes the fields out of the form whose widgets are all gone from the pages (they were on a redacted page), and the widgets that are
/// gone from the fields that stay. A terminal field that is no widget, and a widget that is no object of its own, stay.
fn drop_orphan_fields(doc: &mut Document, root: ObjectId) {
    let live = live_widgets(doc);
    let Some(acro) = doc
        .get_dictionary(root)
        .ok()
        .and_then(|catalog| catalog.get(b"AcroForm").ok())
        .cloned()
    else {
        return;
    };
    let (acro_id, form) = match &acro {
        Object::Reference(id) => match doc.get_dictionary(*id) {
            Ok(form) => (Some(*id), form.clone()),
            Err(_) => return,
        },
        Object::Dictionary(form) => (None, form.clone()),
        _ => return,
    };
    let Some(fields) = form
        .get(b"Fields")
        .ok()
        .and_then(|fields| resolve_array(doc, fields))
    else {
        return;
    };
    let mut budget = MAX_FIELD_NODES;
    let kept: Vec<Object> = fields
        .into_iter()
        .filter(|field| prune_field(doc, field, &live, 0, &mut budget) != Verdict::Orphan)
        .collect();
    let mut form = form;
    form.set("Fields", Object::Array(kept));
    match acro_id {
        Some(id) => doc.set_object(id, Object::Dictionary(form)),
        None => {
            if let Ok(catalog) = doc.get_dictionary_mut(root) {
                catalog.set("AcroForm", Object::Dictionary(form));
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Verdict {
    /// Not a widget, or one that is on a page.
    Live,
    /// Widgets, all of them gone from the pages.
    Orphan,
    /// Not looked at (a limit was reached): kept.
    Unknown,
}

/// Looks at the field `node`; its kids that are widgets of a redacted page are taken out of its `/Kids`. The verdict is on the node as a
/// whole: orphan when it has widgets and none is live.
fn prune_field(
    doc: &mut Document,
    node: &Object,
    live: &HashSet<ObjectId>,
    depth: usize,
    budget: &mut usize,
) -> Verdict {
    if depth > MAX_FIELD_DEPTH || *budget == 0 {
        return Verdict::Unknown;
    }
    *budget -= 1;
    let id = node.as_reference().ok();
    let dict = match node {
        Object::Reference(id) => doc.get_dictionary(*id).ok().cloned(),
        Object::Dictionary(dict) => Some(dict.clone()),
        _ => None,
    };
    let Some(dict) = dict else {
        return Verdict::Unknown;
    };
    let kids = dict
        .get(b"Kids")
        .ok()
        .and_then(|kids| resolve_array(doc, kids));
    let Some(kids) = kids else {
        // A terminal node: orphan only if it is a widget of its own that is not on a page.
        let widget = dict
            .get(b"Subtype")
            .and_then(Object::as_name)
            .is_ok_and(|subtype| subtype == b"Widget");
        return match id {
            Some(id) if widget && !live.contains(&id) => Verdict::Orphan,
            _ => Verdict::Live,
        };
    };
    let mut kept = Vec::with_capacity(kids.len());
    let mut any_widget = false;
    let mut any_live = false;
    for kid in &kids {
        match prune_field(doc, kid, live, depth + 1, budget) {
            Verdict::Orphan => any_widget = true,
            Verdict::Live => {
                any_widget = true;
                any_live = true;
                kept.push(kid.clone());
            }
            Verdict::Unknown => {
                any_live = true;
                kept.push(kid.clone());
            }
        }
    }
    if any_widget && !any_live {
        return Verdict::Orphan;
    }
    if kept.len() != kids.len() {
        if let Some(id) = id {
            if let Ok(dict) = doc.get_dictionary_mut(id) {
                dict.set("Kids", Object::Array(kept));
            }
        }
    }
    Verdict::Live
}

/// Scrubs a saved file after redaction (see [`scrub`]): loads `bytes`, finds the raster pages, and writes the whole file again. The
/// old cross-reference chain is not part of the result.
///
/// `keep_id`: the file is encrypted again afterwards with its old key, which R2 to R4 derive from the first `/ID` string, so that
/// string stays (the second one is new).
pub fn finish(bytes: Vec<u8>, keep_id: bool, strip_hidden: bool) -> Result<Vec<u8>, AppError> {
    let mut doc = load_untrusted(&bytes)?;
    drop(bytes);
    if doc.is_encrypted() {
        return Err(AppError::new(ErrorCode::UnsupportedFeature));
    }
    let first_id = doc
        .trailer
        .get(b"ID")
        .ok()
        .and_then(|id| id.as_array().ok())
        .and_then(|items| items.first().cloned())
        .filter(|first| keep_id && matches!(first, Object::String(..)));
    let redacted = redacted_pages(&doc);
    scrub(&mut doc, &redacted, strip_hidden)?;
    if let Some(first) = first_id {
        if let Ok(Object::Array(items)) = doc.trailer.get_mut(b"ID") {
            if let Some(slot) = items.first_mut() {
                *slot = first;
            }
        }
    }
    doc.trailer.remove(b"Prev");
    doc.trailer.remove(b"XRefStm");
    let mut out = Vec::new();
    doc.save_to(&mut out).map_err(lopdf_error)?;
    Ok(out)
}

/// No stream is inflated past this when a file is searched ([`audit`]).
const INFLATE_CAP: u64 = 256 * 1024 * 1024;

/// What [`audit`] found in a saved file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Audit {
    pub pages: usize,
    /// The trailer has an `/Info`.
    pub has_info: bool,
    /// The catalog, or any object, has `/Metadata`.
    pub has_metadata: bool,
    /// The catalog has a `/StructTreeRoot` or `/MarkInfo`.
    pub has_structure: bool,
    /// The catalog has `/Outlines`, `/Names`, `/Dests`, `/PageLabels`, `/OpenAction` or `/AA`.
    pub has_hidden_data: bool,
    /// Cross-reference sections (`startxref` keywords) and whether the trailer chains to an earlier one (`/Prev`).
    pub xref_sections: usize,
    pub has_prev: bool,
    /// The first string of the trailer's `/ID`.
    pub id: Option<Vec<u8>>,
    /// Where each needle was found: the raw file, a string, a name, a stream as stored, or a stream inflated (with the 256 MiB cap).
    pub leaks: Vec<String>,
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty()
        && haystack
            .windows(needle.len())
            .any(|window| window == needle)
}

fn collect_texts(object: &Object, out: &mut Vec<Vec<u8>>, depth: usize) {
    if depth > 64 {
        return;
    }
    match object {
        Object::String(bytes, _) | Object::Name(bytes) => out.push(bytes.clone()),
        Object::Array(items) => items
            .iter()
            .for_each(|item| collect_texts(item, out, depth + 1)),
        Object::Dictionary(dict) => dict.iter().for_each(|(key, value)| {
            out.push(key.clone());
            collect_texts(value, out, depth + 1);
        }),
        Object::Stream(stream) => stream.dict.iter().for_each(|(key, value)| {
            out.push(key.clone());
            collect_texts(value, out, depth + 1);
        }),
        _ => {}
    }
}

/// Reads a saved file for what true redaction promises (SECURITY D4): none of `needles` (each a spelling of the text, as bytes) in the raw
/// bytes, in any string or name of any object, in any stream as stored or inflated (Flate, capped at 256 MiB), plus the facts of the
/// structure ([`Audit`]). Used by the tests; it parses with the same pre-scan as every other load.
pub fn audit(bytes: &[u8], needles: &[Vec<u8>]) -> Result<Audit, AppError> {
    use std::io::Read;
    let mut leaks = Vec::new();
    if needles.iter().any(|needle| contains(bytes, needle)) {
        leaks.push("raw file".to_owned());
    }
    let doc = load_untrusted(bytes)?;
    let mut has_metadata = false;
    for (id, object) in &doc.objects {
        let mut texts = Vec::new();
        collect_texts(object, &mut texts, 0);
        let dict = match object {
            Object::Dictionary(dict) => Some(dict),
            Object::Stream(stream) => Some(&stream.dict),
            _ => None,
        };
        if let Some(dict) = dict {
            has_metadata |= dict.has(b"Metadata")
                || dict
                    .get(b"Type")
                    .and_then(Object::as_name)
                    .is_ok_and(|name| name == b"Metadata");
        }
        if let Object::Stream(stream) = object {
            texts.push(stream.content.clone());
            let mut inflated = Vec::new();
            let read = flate2::read::ZlibDecoder::new(stream.content.as_slice())
                .take(INFLATE_CAP)
                .read_to_end(&mut inflated);
            if read.is_ok() {
                texts.push(inflated);
            }
        }
        if texts
            .iter()
            .any(|text| needles.iter().any(|needle| contains(text, needle)))
        {
            leaks.push(format!("object {} {}", id.0, id.1));
        }
    }
    let text = String::from_utf8_lossy(bytes);
    let catalog = doc.catalog().ok();
    Ok(Audit {
        pages: doc.get_pages().len(),
        has_info: doc.trailer.has(b"Info"),
        has_metadata,
        has_structure: catalog.is_some_and(|c| c.has(b"StructTreeRoot") || c.has(b"MarkInfo")),
        has_hidden_data: catalog.is_some_and(|c| HIDDEN_DATA.iter().any(|key| c.has(key))),
        xref_sections: text.matches("startxref").count(),
        has_prev: doc.trailer.has(b"Prev"),
        id: doc
            .trailer
            .get(b"ID")
            .and_then(Object::as_array)
            .ok()
            .and_then(|ids| ids.first())
            .and_then(|first| first.as_str().ok())
            .map(<[u8]>::to_vec),
        leaks,
    })
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use flate2::write::ZlibEncoder;
    use flate2::Compression;
    use lopdf::{Dictionary, Stream};

    use super::*;

    fn name(text: &[u8]) -> Object {
        Object::Name(text.to_vec())
    }

    #[test]
    fn a_page_with_the_marker_is_a_redacted_page_and_finish_removes_the_marker() {
        let (mut doc, page) = form_doc();
        assert!(redacted_pages(&doc).is_empty());
        if let Ok(dict) = doc.get_dictionary_mut(page) {
            dict.set(
                crate::pdfwrite::redact_content::MARKER.to_vec(),
                Object::Boolean(true),
            );
        }
        assert_eq!(redacted_pages(&doc), vec![page]);
        let mut bytes = Vec::new();
        doc.save_to(&mut bytes).unwrap();
        let out = finish(bytes, false, false).unwrap();
        let again = load_untrusted(&out).unwrap();
        assert!(redacted_pages(&again).is_empty(), "the marker is gone");
    }

    #[test]
    fn a_grey_looking_rgb_picture_is_stored_as_grey() {
        let grey_rgb = RasterPage::from_rgb(vec![7u8; 8 * 8 * 3], 8, 8);
        assert!(matches!(grey_rgb.pixels, RasterPixels::Gray8(ref g) if g.len() == 64));
        let mut rgb = vec![0u8; 8 * 8 * 3];
        rgb[0] = 255;
        assert!(matches!(
            RasterPage::from_rgb(rgb, 8, 8).pixels,
            RasterPixels::Rgb8(_)
        ));
    }

    /// A document with a catalog that has the structure tree, a form of two fields (`on` is on the page, `off` is on no page) and a page.
    fn form_doc() -> (Document, ObjectId) {
        let mut doc = Document::with_version("1.5");
        let pages_id = doc.new_object_id();
        let live_widget = {
            let mut d = Dictionary::new();
            d.set("Subtype", name(b"Widget"));
            d.set("T", Object::string_literal("on"));
            doc.add_object(d)
        };
        let dead_widget = {
            let mut d = Dictionary::new();
            d.set("Subtype", name(b"Widget"));
            d.set("T", Object::string_literal("off"));
            d.set("V", Object::string_literal("SECRET"));
            doc.add_object(d)
        };
        let mut page = Dictionary::new();
        page.set("Type", name(b"Page"));
        page.set("Parent", Object::Reference(pages_id));
        page.set(
            "Annots",
            Object::Array(vec![Object::Reference(live_widget)]),
        );
        page.set("Thumb", Object::Integer(1));
        let page_id = doc.add_object(page);
        let mut pages = Dictionary::new();
        pages.set("Type", name(b"Pages"));
        pages.set("Kids", Object::Array(vec![Object::Reference(page_id)]));
        pages.set("Count", Object::Integer(1));
        doc.objects.insert(pages_id, Object::Dictionary(pages));
        let mut form = Dictionary::new();
        form.set(
            "Fields",
            Object::Array(vec![
                Object::Reference(live_widget),
                Object::Reference(dead_widget),
            ]),
        );
        let mut catalog = Dictionary::new();
        catalog.set("Type", name(b"Catalog"));
        catalog.set("Pages", Object::Reference(pages_id));
        catalog.set("StructTreeRoot", Object::Dictionary(Dictionary::new()));
        catalog.set("MarkInfo", Object::Dictionary(Dictionary::new()));
        catalog.set("AcroForm", Object::Dictionary(form));
        let catalog_id = doc.add_object(catalog);
        doc.trailer.set("Root", Object::Reference(catalog_id));
        (doc, page_id)
    }

    #[test]
    fn scrub_removes_the_structure_tree_orphan_fields_and_renews_the_id() {
        let (mut doc, page) = form_doc();
        doc.trailer.set(
            "ID",
            Object::Array(vec![
                Object::String(vec![1; 16], StringFormat::Hexadecimal),
                Object::String(vec![1; 16], StringFormat::Hexadecimal),
            ]),
        );
        scrub(&mut doc, &[page], false).unwrap();
        let catalog = doc.catalog().unwrap();
        assert!(catalog.get(b"StructTreeRoot").is_err() && catalog.get(b"MarkInfo").is_err());
        let fields = catalog
            .get(b"AcroForm")
            .unwrap()
            .as_dict()
            .unwrap()
            .get(b"Fields")
            .unwrap()
            .as_array()
            .unwrap();
        assert_eq!(fields.len(), 1, "the field that is on no page is gone");
        assert!(doc.get_dictionary(page).unwrap().get(b"Thumb").is_err());
        let id = doc.trailer.get(b"ID").unwrap().as_array().unwrap();
        assert_ne!(id[0].as_str().unwrap(), &[1u8; 16][..]);
        assert_eq!(id[0].as_str().unwrap().len(), 16);
    }

    #[test]
    fn finish_writes_one_new_file_without_the_old_chain() {
        let (mut doc, _) = form_doc();
        doc.trailer.set(
            "ID",
            Object::Array(vec![
                Object::string_literal("a1"),
                Object::string_literal("b2"),
            ]),
        );
        let mut bytes = Vec::new();
        doc.save_to(&mut bytes).unwrap();
        let out = finish(bytes.clone(), false, false).unwrap();
        let text = String::from_utf8_lossy(&out);
        assert_eq!(text.matches("startxref").count(), 1);
        assert!(!text.contains("StructTreeRoot"));
        // The `/ID` is new, except its first string when the file is encrypted again.
        let id_of = |bytes: &[u8]| {
            let doc = load_untrusted(bytes).unwrap();
            let ids = doc.trailer.get(b"ID").unwrap().as_array().unwrap().clone();
            ids.iter()
                .map(|id| id.as_str().unwrap().to_vec())
                .collect::<Vec<_>>()
        };
        let before = id_of(&bytes);
        let fresh = id_of(&out);
        assert_ne!(before[0], fresh[0]);
        let kept = id_of(&finish(bytes, true, false).unwrap());
        assert_eq!(before[0], kept[0]);
        assert_ne!(before[1], kept[1]);
    }

    #[test]
    fn the_audit_finds_a_string_in_a_file_and_in_an_inflated_stream() {
        let (mut doc, _) = form_doc();
        let mut packed = Stream::new(Dictionary::new(), {
            let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
            encoder.write_all(b"..needle..").unwrap();
            encoder.finish().unwrap()
        });
        packed.dict.set("Filter", name(b"FlateDecode"));
        doc.add_object(packed);
        let mut bytes = Vec::new();
        doc.save_to(&mut bytes).unwrap();
        let found = audit(&bytes, &[b"needle".to_vec(), b"SECRET".to_vec()]).unwrap();
        assert!(
            found.leaks.iter().any(|l| l == "raw file"),
            "{:?}",
            found.leaks
        );
        assert!(
            found.leaks.iter().any(|l| l.starts_with("object")),
            "{:?}",
            found.leaks
        );
        assert_eq!(found.pages, 1);
        assert!(!found.has_info && found.has_structure);
        assert_eq!(found.xref_sections, 1);
        let clean = audit(&bytes, &[b"absent-text".to_vec()]).unwrap();
        assert!(clean.leaks.is_empty());
    }
}
