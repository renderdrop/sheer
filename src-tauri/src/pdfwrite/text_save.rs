//! Writing the rewritten page as an incremental update (ARCHITECTURE §13.4): one new content stream per page (the same object id when
//! only this page uses it), new font objects, page `/Resources` materialised when inherited or shared. Never a Full save because of text.
//!
//! [`write`] is the seam's signature (one page); [`write_pages`] writes several pages and builds one font object per face for all of
//! them (glyphs unioned); [`apply_edits`] is the hook of `SavePlan.text_edits`; [`preview_page`] makes the one-page PDF the engine swaps in.

use std::collections::{BTreeSet, HashMap, HashSet};

use lopdf::{Dictionary, Document, IncrementalDocument, Object, ObjectId, Stream};

use super::pagetree::{copy_page_with, materialize_inherited, on_big_stack};
use super::text_splice::{content_stream_ids, fallback_chars, replay, Rewritten};
use crate::error::{AppError, ErrorCode};
use crate::fontprog::fallback::{Face, FallbackStore, Subset};
use crate::limits;
use crate::model::text_edit::{ChangeWarning, FallbackFace, TextEdit};

fn failed(detail: impl std::fmt::Display) -> AppError {
    AppError::logged(ErrorCode::SaveFailed, format!("textSave: {detail}"))
}

fn name(value: &str) -> Object {
    Object::Name(value.as_bytes().to_vec())
}

fn real(value: f32) -> Object {
    Object::Real(value)
}

/// `write_pages` for one page.
pub fn write(
    doc: &mut IncrementalDocument,
    page: ObjectId,
    rewritten: &Rewritten,
) -> Result<(), AppError> {
    write_pages(doc, &[(page, rewritten)])
}

// --- fonts -------------------------------------------------------------------------------------------------------------

/// The `ToUnicode` CMap of a substitute font: its codes are the characters' UTF-16 code units.
fn to_unicode(cids: &[(u16, u16)]) -> Vec<u8> {
    let mut out = String::from(
        "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n\
         /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n\
         /CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n\
         1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n",
    );
    for chunk in cids.chunks(100) {
        out.push_str(&format!("{} beginbfchar\n", chunk.len()));
        for (cid, _) in chunk {
            out.push_str(&format!("<{cid:04X}> <{cid:04X}>\n"));
        }
        out.push_str("endbfchar\n");
    }
    out.push_str("endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n");
    out.into_bytes()
}

/// A Type0 font (Identity-H, `CIDFontType2`) of the subset of `face` in `doc`. The code of a character is its UTF-16 code unit; the
/// `CIDToGIDMap` takes it to the glyph of the subset, so the content stream does not depend on how the subset numbers its glyphs.
pub(super) fn add_font_object(
    doc: &mut Document,
    face: Face,
    subset: &Subset,
) -> Result<ObjectId, AppError> {
    let mut cids: Vec<(u16, u16)> = Vec::with_capacity(subset.gids.len());
    for (c, gid) in &subset.gids {
        let cid = u16::try_from(u32::from(*c)).map_err(|_| AppError::invalid("fontProgram"))?;
        cids.push((cid, *gid));
    }
    cids.sort_unstable();
    cids.dedup_by_key(|(cid, _)| *cid);
    let max = cids.last().map_or(0, |(cid, _)| usize::from(*cid));
    let map_len = (max + 1) * 2;
    if map_len > limits::CID_TO_GID_MAX_BYTES {
        return Err(AppError::limit(
            "cidToGid",
            limits::CID_TO_GID_MAX_BYTES as u64,
        ));
    }
    let mut map = vec![0u8; map_len];
    for (cid, gid) in &cids {
        let at = usize::from(*cid) * 2;
        map[at..at + 2].copy_from_slice(&gid.to_be_bytes());
    }
    let widths: HashMap<u16, f32> = subset.widths.iter().copied().collect();
    let mut w = Vec::with_capacity(cids.len() * 2);
    for (cid, gid) in &cids {
        w.push(Object::Integer(i64::from(*cid)));
        w.push(Object::Array(vec![real(
            widths.get(gid).copied().unwrap_or(0.0).round(),
        )]));
    }
    let tag = format!("SHEERF+{}", face.base_font());
    let descriptor = face
        .descriptor()
        .ok_or_else(|| AppError::invalid("fontProgram"))?;

    let mut program_dict = Dictionary::new();
    program_dict.set("Length1", Object::Integer(subset.program.len() as i64));
    let program = doc.add_object(Stream::new(program_dict, subset.program.clone()));

    let mut flags = 32i64;
    if face.family == FallbackFace::Mono {
        flags |= 1;
    }
    if face.family == FallbackFace::Serif {
        flags |= 2;
    }
    if face.italic {
        flags |= 64;
    }
    if face.bold {
        flags |= 1 << 18;
    }
    let mut fd = Dictionary::new();
    fd.set("Type", name("FontDescriptor"));
    fd.set("FontName", name(&tag));
    fd.set("Flags", Object::Integer(flags));
    fd.set(
        "FontBBox",
        Object::Array(descriptor.bbox.map(real).to_vec()),
    );
    fd.set("ItalicAngle", real(descriptor.italic_angle));
    fd.set("Ascent", real(descriptor.ascent.round()));
    fd.set("Descent", real(descriptor.descent.round()));
    fd.set("CapHeight", real(descriptor.cap_height.round()));
    fd.set("StemV", Object::Integer(if face.bold { 140 } else { 80 }));
    fd.set("FontFile2", Object::Reference(program));
    let fd = doc.add_object(fd);

    let to_gid = doc.add_object(Stream::new(Dictionary::new(), map));
    let mut system = Dictionary::new();
    system.set("Registry", Object::string_literal("Adobe"));
    system.set("Ordering", Object::string_literal("Identity"));
    system.set("Supplement", Object::Integer(0));
    let mut cid_font = Dictionary::new();
    cid_font.set("Type", name("Font"));
    cid_font.set("Subtype", name("CIDFontType2"));
    cid_font.set("BaseFont", name(&tag));
    cid_font.set("CIDSystemInfo", Object::Dictionary(system));
    cid_font.set("FontDescriptor", Object::Reference(fd));
    cid_font.set("DW", Object::Integer(0));
    cid_font.set("W", Object::Array(w));
    cid_font.set("CIDToGIDMap", Object::Reference(to_gid));
    let cid_font = doc.add_object(cid_font);

    let unicode = doc.add_object(Stream::new(Dictionary::new(), to_unicode(&cids)));
    let mut font = Dictionary::new();
    font.set("Type", name("Font"));
    font.set("Subtype", name("Type0"));
    font.set("BaseFont", name(&tag));
    font.set("Encoding", name("Identity-H"));
    font.set(
        "DescendantFonts",
        Object::Array(vec![Object::Reference(cid_font)]),
    );
    font.set("ToUnicode", Object::Reference(unicode));
    Ok(doc.add_object(font))
}

fn deref_dict(doc: &Document, object: &Object) -> Option<Dictionary> {
    doc.dereference(object)
        .ok()
        .and_then(|(_, o)| o.as_dict().ok())
        .cloned()
}

/// The `/Resources` `page` sees (its own or inherited), as one direct dictionary whose `/Font` is direct too, with `fonts` added.
fn resources_with(doc: &Document, page: ObjectId, fonts: &[(String, ObjectId)]) -> Dictionary {
    let mut id = page;
    let mut found: Option<Object> = None;
    for _ in 0..limits::MAX_PARENT_CHAIN {
        let Ok(dict) = doc.get_dictionary(id) else {
            break;
        };
        if let Ok(value) = dict.get(b"Resources") {
            found = Some(value.clone());
            break;
        }
        match dict.get(b"Parent").and_then(Object::as_reference) {
            Ok(parent) => id = parent,
            Err(_) => break,
        }
    }
    let mut resources = found.and_then(|o| deref_dict(doc, &o)).unwrap_or_default();
    let mut font_dict = resources
        .get(b"Font")
        .ok()
        .and_then(|o| deref_dict(doc, o))
        .unwrap_or_default();
    for (resource, object) in fonts {
        font_dict.set(resource.as_bytes().to_vec(), Object::Reference(*object));
    }
    resources.set("Font", Object::Dictionary(font_dict));
    resources
}

/// Puts the substitute fonts of `fallback` into `doc` as a page-local resource of `page` (the working copy a replay lets `text_lines`
/// read the edits so far from).
pub(super) fn install_fonts(
    doc: &mut Document,
    page: ObjectId,
    fallback: &[(Face, BTreeSet<char>)],
    store: &FallbackStore,
) -> Result<(), AppError> {
    let mut entries = Vec::new();
    for (face, chars) in fallback {
        let mut local = store.clone();
        local.add(*face, &chars.iter().collect::<String>());
        let subset = local.subset(*face)?;
        let id = add_font_object(doc, *face, &subset)?;
        entries.push((super::text_splice::resource_name(*face), id));
    }
    let resources = resources_with(doc, page, &entries);
    let mut dict = doc.get_dictionary(page).map_err(failed)?.clone();
    dict.set("Resources", Object::Dictionary(resources));
    doc.set_object(page, Object::Dictionary(dict));
    Ok(())
}

// --- pages -------------------------------------------------------------------------------------------------------------

/// Whether a content stream of `page` is also drawn by another page.
fn is_shared(doc: &Document, page: ObjectId, id: ObjectId) -> bool {
    doc.get_pages()
        .into_values()
        .filter(|other| *other != page)
        .any(|other| content_stream_ids(doc, other).contains(&id))
}

/// Writes every page of `items` into the update: the new content, its `/Resources`, and the font objects (one per face, for all pages).
pub fn write_pages(
    doc: &mut IncrementalDocument,
    items: &[(ObjectId, &Rewritten)],
) -> Result<(), AppError> {
    // The characters of each face, over all pages.
    let mut used: Vec<(Face, BTreeSet<char>)> = Vec::new();
    for (_, r) in items {
        for (face, chars) in fallback_chars(r)? {
            match used.iter_mut().find(|(f, _)| *f == face) {
                Some((_, set)) => set.extend(chars),
                None => used.push((face, chars)),
            }
        }
    }
    let mut store = FallbackStore::default();
    for (face, chars) in &used {
        store.add(*face, &chars.iter().collect::<String>());
    }
    let mut font_ids: HashMap<Face, ObjectId> = HashMap::new();
    for (face, _) in &used {
        let subset = store.subset(*face)?;
        font_ids.insert(
            *face,
            add_font_object(&mut doc.new_document, *face, &subset)?,
        );
    }
    let mut seen = HashSet::new();
    for (page, r) in items {
        if !seen.insert(*page) {
            return Err(failed("a page twice"));
        }
        let prev = doc.get_prev_documents();
        let mut dict = prev.get_dictionary(*page).map_err(failed)?.clone();
        let entries: Vec<(String, ObjectId)> = r
            .fonts
            .iter()
            .filter_map(|f| font_ids.get(&f.face).map(|id| (f.name.clone(), *id)))
            .collect();
        dict.set(
            "Resources",
            Object::Dictionary(resources_with(prev, *page, &entries)),
        );
        let ids = content_stream_ids(prev, *page);
        let reuse = match ids.as_slice() {
            [only] if !is_shared(prev, *page, *only) => Some(*only),
            _ => None,
        };
        let stream = Stream::new(Dictionary::new(), r.content.clone());
        match reuse {
            Some(id) => doc.new_document.set_object(id, Object::Stream(stream)),
            None => {
                let id = doc.new_document.add_object(Object::Stream(stream));
                dict.set("Contents", Object::Reference(id));
            }
        }
        doc.new_document.set_object(*page, Object::Dictionary(dict));
    }
    Ok(())
}

/// The hook of `SavePlan.text_edits`: replays the edits of every page (`file_index` is the page's index in `original`) and appends the
/// result as an incremental update. An encrypted file is `unsupported_feature` (the save decrypts first).
pub fn apply_edits(
    original: Vec<u8>,
    edits: &[(u32, Vec<TextEdit>)],
) -> Result<(Vec<u8>, Vec<ChangeWarning>), AppError> {
    let (bytes, warnings, _) = apply_edits_with(original, edits, false)?;
    Ok((bytes, warnings))
}

/// The characters a page draws in each substitute face.
pub type FallbackUse = Vec<(Face, BTreeSet<char>)>;

/// [`apply_edits`], and with `want_fallback` the characters drawn in the substitute faces (read back from the new content, which costs a
/// second lex: the save does not ask).
fn apply_edits_with(
    original: Vec<u8>,
    edits: &[(u32, Vec<TextEdit>)],
    want_fallback: bool,
) -> Result<(Vec<u8>, Vec<ChangeWarning>, FallbackUse), AppError> {
    if edits.iter().all(|(_, list)| list.is_empty()) {
        return Ok((original, Vec::new(), Vec::new()));
    }
    let doc = super::prescan::load_untrusted(&original)?;
    if doc.is_encrypted() {
        return Err(AppError::new(ErrorCode::UnsupportedFeature));
    }
    let pages = doc.get_pages();
    let store = FallbackStore::default();
    let mut done: Vec<(ObjectId, Rewritten)> = Vec::new();
    let mut warnings: Vec<ChangeWarning> = Vec::new();
    let mut used: FallbackUse = Vec::new();
    for (index, list) in edits {
        if list.is_empty() {
            continue;
        }
        let page = *index
            .checked_add(1)
            .and_then(|n| pages.get(&n))
            .ok_or(AppError::invalid("page"))?;
        if done.iter().any(|(p, _)| *p == page) {
            return Err(AppError::invalid("page"));
        }
        let r = replay(&doc, page, list, &store)?;
        for w in &r.warnings {
            if !warnings.contains(w) {
                warnings.push(*w);
            }
        }
        if want_fallback {
            for (face, chars) in fallback_chars(&r)? {
                match used.iter_mut().find(|(f, _)| *f == face) {
                    Some((_, set)) => set.extend(chars),
                    None => used.push((face, chars)),
                }
            }
        }
        done.push((page, r));
    }
    let mut inc = IncrementalDocument::create_from(original, doc);
    let refs: Vec<(ObjectId, &Rewritten)> = done.iter().map(|(p, r)| (*p, r)).collect();
    write_pages(&mut inc, &refs)?;
    let mut bytes = Vec::new();
    inc.save_to(&mut bytes).map_err(failed)?;
    Ok((bytes, warnings, used))
}

/// The one-page PDF of page `page_index` of `original` with `edits` applied (the preview the engine swaps in, ADR-055's path with
/// `PageSource::TextEdited`), and the warnings of the edits. The page keeps its boxes and rotation; its annotations are left out (the
/// model draws its own). Runs on a thread with a big stack.
pub fn preview_page(
    original: &[u8],
    page_index: u32,
    edits: &[TextEdit],
) -> Result<(Vec<u8>, Vec<ChangeWarning>), AppError> {
    let made = preview_page_with(original, page_index, edits, None)?;
    Ok((made.bytes, made.warnings))
}

/// A preview page for the live preview (ADR-129 section 1): the page with the edits, optionally cut to a region.
#[derive(Debug, Clone)]
pub struct PreviewPage {
    pub bytes: Vec<u8>,
    pub warnings: Vec<ChangeWarning>,
    /// The characters the page's edits draw in the substitute faces.
    pub fallback: FallbackUse,
    /// The rotation of the page in degrees (0, 90, 180 or 270).
    pub rotate: u16,
    /// Width and height of the page's visible box in points (before the rotation).
    pub page_size: [f64; 2],
    /// The clip as cut to the visible box, `[x0, y0, x1, y1]` in the space of the request's.
    pub clipped: Option<[f64; 4]>,
}

/// [`preview_page`] for the live preview. With `clip` (`[x0, y0, x1, y1]`, points from the top left of the page's visible box, before the
/// page's rotation) the page's `CropBox` is cut to that region, so PDFium draws nothing else. The clip is cut to the visible box.
pub fn preview_page_with(
    original: &[u8],
    page_index: u32,
    edits: &[TextEdit],
    clip: Option<[f64; 4]>,
) -> Result<PreviewPage, AppError> {
    let original = original.to_vec();
    let edits = edits.to_vec();
    on_big_stack(move || {
        let (updated, warnings, fallback) =
            apply_edits_with(original, &[(page_index, edits)], true)?;
        let doc = super::prescan::load_untrusted(&updated)?;
        let page = *doc
            .get_pages()
            .get(&page_index.saturating_add(1))
            .ok_or(AppError::invalid("page"))?;
        let mut dict = doc.get_dictionary(page).map_err(failed)?.clone();
        materialize_inherited(&doc, &mut dict);
        for key in [
            &b"Annots"[..],
            b"AA",
            b"Thumb",
            b"PieceInfo",
            b"Metadata",
            b"StructParents",
            b"B",
            b"Parent",
        ] {
            dict.remove(key);
        }
        let rotate = dict
            .get(b"Rotate")
            .ok()
            .and_then(|r| doc.dereference(r).ok())
            .and_then(|(_, r)| r.as_i64().ok())
            .map_or(0, |r| {
                u16::try_from(r.rem_euclid(360) / 90 * 90).unwrap_or(0)
            });
        let media = box_of(&doc, dict.get(b"MediaBox").ok()).unwrap_or([0.0, 0.0, 612.0, 792.0]);
        let crop = box_of(&doc, dict.get(b"CropBox").ok()).map_or(media, |c| {
            [
                c[0].max(media[0]),
                c[1].max(media[1]),
                c[2].min(media[2]),
                c[3].min(media[3]),
            ]
        });
        let (left, top) = (crop[0], crop[3]);
        let page_size = [crop[2] - crop[0], crop[3] - crop[1]];
        let mut clipped = None;
        if let Some([x0, y0, x1, y1]) = clip {
            let cut = [
                (left + x0).clamp(crop[0], crop[2]),
                (top - y1).clamp(crop[1], crop[3]),
                (left + x1).clamp(crop[0], crop[2]),
                (top - y0).clamp(crop[1], crop[3]),
            ];
            if cut[2] - cut[0] < 1.0 || cut[3] - cut[1] < 1.0 {
                return Err(AppError::invalid("region"));
            }
            clipped = Some([cut[0] - left, top - cut[3], cut[2] - left, top - cut[1]]);
            #[allow(clippy::cast_possible_truncation)]
            // page coordinates are far below f32's range
            dict.set(
                "CropBox",
                Object::Array(cut.iter().map(|v| Object::Real(*v as f32)).collect()),
            );
        }
        let mut target = Document::with_version("1.5");
        let mut budget = 0usize;
        let new_page = copy_page_with(&doc, page, dict, HashMap::new(), &mut target, &mut budget)?;
        let pages_id = target.new_object_id();
        if let Ok(d) = target.get_dictionary_mut(new_page) {
            d.set("Parent", Object::Reference(pages_id));
        }
        let mut pages = Dictionary::new();
        pages.set("Type", name("Pages"));
        pages.set("Kids", Object::Array(vec![Object::Reference(new_page)]));
        pages.set("Count", Object::Integer(1));
        target.objects.insert(pages_id, Object::Dictionary(pages));
        let mut catalog = Dictionary::new();
        catalog.set("Type", name("Catalog"));
        catalog.set("Pages", Object::Reference(pages_id));
        let catalog_id = target.add_object(catalog);
        target.trailer.set("Root", Object::Reference(catalog_id));
        let mut out = Vec::new();
        target.save_to(&mut out).map_err(failed)?;
        Ok(PreviewPage {
            bytes: out,
            warnings,
            fallback,
            rotate,
            page_size,
            clipped,
        })
    })
}

/// The four numbers of a box entry ordered `[x0, y0, x1, y1]`; `None` for anything else.
fn box_of(doc: &Document, entry: Option<&Object>) -> Option<[f64; 4]> {
    let (_, array) = doc.dereference(entry?).ok()?;
    let items = array.as_array().ok()?;
    if items.len() != 4 {
        return None;
    }
    let mut v = [0.0f64; 4];
    for (slot, item) in v.iter_mut().zip(items) {
        let (_, number) = doc.dereference(item).ok()?;
        *slot = f64::from(number.as_float().ok()?);
    }
    Some([
        v[0].min(v[2]),
        v[1].min(v[3]),
        v[0].max(v[2]),
        v[1].max(v[3]),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fontprog::fallback::Subset;

    fn doc_with_pages(contents: &[&str]) -> (Vec<u8>, Vec<ObjectId>, Vec<ObjectId>) {
        let mut doc = Document::with_version("1.5");
        let pages_id = doc.new_object_id();
        let mut font = Dictionary::new();
        font.set("Type", name("Font"));
        font.set("Subtype", name("Type1"));
        font.set("BaseFont", name("Helvetica"));
        let font = doc.add_object(font);
        let mut fonts = Dictionary::new();
        fonts.set("F1", Object::Reference(font));
        let mut resources = Dictionary::new();
        resources.set("Font", Object::Dictionary(fonts));
        let mut kids = Vec::new();
        let mut streams = Vec::new();
        let mut page_ids = Vec::new();
        for text in contents {
            let stream = doc.add_object(Stream::new(Dictionary::new(), text.as_bytes().to_vec()));
            let mut page = Dictionary::new();
            page.set("Type", name("Page"));
            page.set("Parent", Object::Reference(pages_id));
            page.set(
                "MediaBox",
                Object::Array(vec![
                    Object::Integer(0),
                    Object::Integer(0),
                    Object::Integer(200),
                    Object::Integer(200),
                ]),
            );
            page.set("Contents", Object::Reference(stream));
            let page = doc.add_object(page);
            kids.push(Object::Reference(page));
            streams.push(stream);
            page_ids.push(page);
        }
        let mut pages = Dictionary::new();
        pages.set("Type", name("Pages"));
        pages.set("Count", Object::Integer(kids.len() as i64));
        pages.set("Kids", Object::Array(kids));
        pages.set("Resources", Object::Dictionary(resources));
        doc.objects.insert(pages_id, Object::Dictionary(pages));
        let catalog = doc.add_object(Dictionary::from_iter([
            ("Type", name("Catalog")),
            ("Pages", Object::Reference(pages_id)),
        ]));
        doc.trailer.set("Root", Object::Reference(catalog));
        let mut bytes = Vec::new();
        doc.save_to(&mut bytes).unwrap();
        (bytes, page_ids, streams)
    }

    fn rewritten(content: &str) -> Rewritten {
        Rewritten {
            content: content.as_bytes().to_vec(),
            fonts: Vec::new(),
            warnings: Vec::new(),
        }
    }

    #[test]
    fn an_unshared_stream_keeps_its_id_and_the_file_is_only_appended_to() {
        let (bytes, pages, streams) = doc_with_pages(&["BT /F1 10 Tf (A) Tj ET"]);
        let doc = crate::pdfwrite::load_untrusted(&bytes).unwrap();
        let mut inc = IncrementalDocument::create_from(bytes.clone(), doc);
        write(&mut inc, pages[0], &rewritten("BT /F1 10 Tf (B) Tj ET")).unwrap();
        let mut out = Vec::new();
        inc.save_to(&mut out).unwrap();
        assert_eq!(&out[..bytes.len()], &bytes[..], "the original bytes stay");
        let back = crate::pdfwrite::load_untrusted(&out).unwrap();
        let ids = content_stream_ids(&back, pages[0]);
        assert_eq!(ids, vec![streams[0]]);
        let Ok(Object::Stream(s)) = back.get_object(streams[0]) else {
            panic!("stream");
        };
        assert_eq!(s.content, b"BT /F1 10 Tf (B) Tj ET");
    }

    #[test]
    fn a_shared_stream_gets_a_new_object_and_the_other_page_keeps_the_old() {
        let (bytes, pages, streams) = doc_with_pages(&["BT (A) Tj ET", "BT (B) Tj ET"]);
        let mut doc = crate::pdfwrite::load_untrusted(&bytes).unwrap();
        // The second page draws the first page's stream.
        doc.get_dictionary_mut(pages[1])
            .unwrap()
            .set("Contents", Object::Reference(streams[0]));
        let mut shared = Vec::new();
        doc.save_to(&mut shared).unwrap();
        let doc = crate::pdfwrite::load_untrusted(&shared).unwrap();
        let mut inc = IncrementalDocument::create_from(shared, doc);
        write(&mut inc, pages[0], &rewritten("BT (X) Tj ET")).unwrap();
        let mut out = Vec::new();
        inc.save_to(&mut out).unwrap();
        let back = crate::pdfwrite::load_untrusted(&out).unwrap();
        let first = content_stream_ids(&back, pages[0]);
        let second = content_stream_ids(&back, pages[1]);
        assert_ne!(first, second);
        assert_eq!(second, vec![streams[0]]);
        let Ok(Object::Stream(s)) = back.get_object(streams[0]) else {
            panic!("stream");
        };
        assert_eq!(s.content, b"BT (A) Tj ET");
    }

    #[test]
    fn inherited_resources_become_page_local() {
        let (bytes, pages, _) = doc_with_pages(&["BT (A) Tj ET"]);
        let doc = crate::pdfwrite::load_untrusted(&bytes).unwrap();
        assert!(doc
            .get_dictionary(pages[0])
            .unwrap()
            .get(b"Resources")
            .is_err());
        let mut inc = IncrementalDocument::create_from(bytes, doc);
        write(&mut inc, pages[0], &rewritten("BT (B) Tj ET")).unwrap();
        let mut out = Vec::new();
        inc.save_to(&mut out).unwrap();
        let back = crate::pdfwrite::load_untrusted(&out).unwrap();
        let resources = back
            .get_dictionary(pages[0])
            .unwrap()
            .get(b"Resources")
            .unwrap()
            .as_dict()
            .unwrap();
        assert!(resources
            .get(b"Font")
            .unwrap()
            .as_dict()
            .unwrap()
            .has(b"F1"));
    }

    #[test]
    fn a_fallback_font_object_is_a_type0_identity_h_with_a_cid_to_gid_map() {
        let (bytes, _, _) = doc_with_pages(&["BT ET"]);
        let mut doc = crate::pdfwrite::load_untrusted(&bytes).unwrap();
        let face = crate::fontprog::fallback::pick(0, 400, "Helvetica");
        let subset = Subset {
            program: vec![0, 1, 0, 0],
            gids: vec![('a', 3), ('b', 4)],
            widths: vec![(3, 556.0), (4, 500.0)],
        };
        let id = add_font_object(&mut doc, face, &subset).unwrap();
        let font = doc.get_dictionary(id).unwrap();
        assert_eq!(font.get(b"Subtype").unwrap().as_name().unwrap(), b"Type0");
        assert_eq!(
            font.get(b"Encoding").unwrap().as_name().unwrap(),
            b"Identity-H"
        );
        let cid = doc
            .get_dictionary(
                font.get(b"DescendantFonts").unwrap().as_array().unwrap()[0]
                    .as_reference()
                    .unwrap(),
            )
            .unwrap();
        let map_id = cid.get(b"CIDToGIDMap").unwrap().as_reference().unwrap();
        let Ok(Object::Stream(map)) = doc.get_object(map_id) else {
            panic!("map");
        };
        // cid 0x61 -> gid 3, cid 0x62 -> gid 4
        assert_eq!(map.content.len(), (0x62 + 1) * 2);
        assert_eq!(&map.content[0x61 * 2..0x61 * 2 + 4], &[0, 3, 0, 4]);
    }

    #[test]
    fn apply_edits_rewrites_a_real_page_incrementally() {
        use crate::model::text_edit::{LineKey, TextFit, TextScope};
        let (bytes, pages, streams) = doc_with_pages(&[
            "BT /F1 12 Tf 72 700 Td (Hello world) Tj 0 -14 Td (second line) Tj ET",
        ]);
        let edit = TextEdit {
            key: LineKey { rev: 0, line: 0 },
            text: "Hello warld".to_owned(),
            fit: TextFit::KeepStart,
            scope: TextScope::Line,
        };
        let (out, warnings) = apply_edits(bytes.clone(), &[(0, vec![edit])]).unwrap();
        assert!(warnings.is_empty());
        assert_eq!(&out[..bytes.len()], &bytes[..]);
        let back = crate::pdfwrite::load_untrusted(&out).unwrap();
        let Ok(Object::Stream(s)) = back.get_object(streams[0]) else {
            panic!("stream");
        };
        let text = String::from_utf8(s.content.clone()).unwrap();
        assert!(
            text.contains("<48656C6C6F20776172 6C64>".replace(' ', "").as_str()),
            "{text}"
        );
        assert!(text.ends_with("0 -14 Td (second line) Tj ET"));
        assert_eq!(content_stream_ids(&back, pages[0]), vec![streams[0]]);
    }

    #[test]
    fn a_word_outside_the_encoding_is_set_in_a_fallback_font_object_and_previews() {
        use crate::model::text_edit::{LineKey, TextFit, TextScope};
        let (bytes, pages, _) = doc_with_pages(&["BT /F1 12 Tf 72 700 Td (Hello world) Tj ET"]);
        let edit = TextEdit {
            key: LineKey { rev: 0, line: 0 },
            text: "Hello \u{416}orld".to_owned(),
            fit: TextFit::KeepStart,
            scope: TextScope::Line,
        };
        let (out, warnings) = apply_edits(bytes.clone(), &[(0, vec![edit.clone()])]).unwrap();
        assert_eq!(warnings, vec![ChangeWarning::FontFallback]);
        assert_eq!(&out[..bytes.len()], &bytes[..]);
        let back = crate::pdfwrite::load_untrusted(&out).unwrap();
        let fonts = back
            .get_dictionary(pages[0])
            .unwrap()
            .get(b"Resources")
            .unwrap()
            .as_dict()
            .unwrap()
            .get(b"Font")
            .unwrap()
            .as_dict()
            .unwrap();
        assert!(fonts.has(b"F1") && fonts.iter().any(|(k, _)| k.starts_with(b"SheerFn")));
        let (one, preview_warnings) = preview_page(&bytes, 0, &[edit]).unwrap();
        assert_eq!(preview_warnings, warnings);
        assert_eq!(
            crate::pdfwrite::load_untrusted(&one)
                .unwrap()
                .get_pages()
                .len(),
            1
        );
    }
}
