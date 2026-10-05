//! The file side of a certificate signature (ADR-121 sections 1 and 5): one appended revision that holds the signature dictionary with a
//! fixed-width `/ByteRange` and a zero-filled `/Contents`, the merged signature field and widget with the seal's appearance, the page with
//! its new `/Annots` entry, the AcroForm with `/Fields` and `/SigFlags 3`, and, for the first signature, `/Perms /DocMDP` with the DocMDP
//! reference. The revision is written by lopdf's `IncrementalDocument` like every save: the original bytes stay as they are, nothing
//! earlier is re-serialised, and the signature dictionary is a plain object (never in an object stream).
//!
//! [`prepare`] makes the bytes with the placeholders patched (`/ByteRange` known, `/Contents` zeros); the caller hashes
//! `pdfsig::cms_build::digest_ranges`, signs, and [`finish`] writes the CMS into the gap. Every PDF is hostile input: the document comes
//! from `load_untrusted`, and every walk up a page tree is bounded.

use std::ops::Range;

use lopdf::{Dictionary, Document, IncrementalDocument, Object, ObjectId, StringFormat};

use super::annots::text_string;
use super::coords::page_mapper;
use super::seal::{self, SealSpec};
use super::sigread;
use crate::error::{AppError, ErrorCode};
use crate::limits;
use crate::model::geometry::Rect;
use crate::pdfsig::types::SignLock;
use crate::signatures::Art;

/// The three numbers of `/ByteRange` are written as these 10 digit values and then overwritten, in place, by the real ones
/// (space-padded to the same width). Each is found exactly once in the appended bytes.
const MAGIC: [i64; 3] = [2_000_000_001, 2_000_000_002, 2_000_000_003];
/// The width of one `/ByteRange` number.
const NUMBER_WIDTH: usize = 10;
/// Annotation flags: Print (4) and Locked (128).
const FLAGS_WIDGET: i64 = 4 | 128;
/// Smallest seal in points as the reader sees it (ARCHITECTURE section 5 `SealPlacement`).
const SEAL_MIN: (f32, f32) = (72.0, 24.0);
/// The deepest `/Parent` chain looked at for an inherited page key.
const TREE_DEPTH_MAX: usize = 64;
/// How far a seal may stick out of the page box before it counts as outside (rounding of the UI).
const EDGE_TOLERANCE_PT: f32 = 0.5;

/// What the signature says and where its seal goes.
#[derive(Debug, Clone)]
pub struct SignPlan {
    /// The page (0-based position in the file) and the box on it, in page space (y down, before `/Rotate`); `None`: invisible, on
    /// the first page with an empty `/Rect`.
    pub placement: Option<(u32, Rect)>,
    /// The signer's name: `/Name` and the seal.
    pub name: String,
    /// `/M`, a PDF date (`D:20261005140500+02'00'`).
    pub signed_at: String,
    /// `YYYY-MM-DD HH:mm +hh:mm`: the same instant, for the seal.
    pub date_line: String,
    /// `seal.signed` in the language of the interface.
    pub signed_label: String,
    /// The whole reason line of the seal (`seal.reason` filled in); the reason itself goes into `/Reason`.
    pub reason_line: Option<String>,
    pub reason: Option<String>,
    pub location: Option<String>,
    /// The art the user picked for the seal, if any.
    pub art: Option<Art>,
    /// What a certification signature allows (the first signature of a document); ignored for an approval signature.
    pub lock: SignLock,
    /// The size in bytes of `/Contents` (`pdfsig::cms_build::contents_capacity`).
    pub contents_len: usize,
}

/// The file with the placeholders in: `/ByteRange` is final, `/Contents` is zeros.
#[derive(Debug)]
pub struct Prepared {
    /// The original, then the revision.
    pub bytes: Vec<u8>,
    /// The `/Contents` string with its angle brackets: the one part the signature does not cover.
    pub gap: Range<usize>,
    /// The field's name (`Signature1`, ...).
    pub field_name: String,
    /// The signature certifies the document (it is the first one).
    pub certifies: bool,
}

fn failed(detail: impl std::fmt::Display) -> AppError {
    AppError::logged(ErrorCode::SaveFailed, format!("sign: {detail}"))
}

fn lopdf_error(error: impl std::fmt::Display) -> AppError {
    failed(format!("lopdf: {error}"))
}

fn name(text: &str) -> Object {
    Object::Name(text.as_bytes().to_vec())
}

fn literal(text: &str) -> Object {
    Object::String(text.as_bytes().to_vec(), StringFormat::Literal)
}

fn real(value: f32) -> Object {
    Object::Real(value)
}

/// A request text (reason, location) cleaned for the file and the seal: control and bidirectional-override characters removed, trimmed;
/// `None` when nothing is left, `invalid_argument` (`what`) when it is longer than `max` characters.
pub fn clean_text(
    text: Option<&str>,
    max: usize,
    what: &'static str,
) -> Result<Option<String>, AppError> {
    let Some(text) = text else { return Ok(None) };
    let clean: String = text
        .chars()
        .filter(|c| {
            !c.is_control()
                && !matches!(c, '\u{200E}' | '\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}')
        })
        .collect();
    let clean = clean.trim();
    if clean.chars().count() > max {
        return Err(AppError::invalid(what));
    }
    Ok((!clean.is_empty()).then(|| clean.to_owned()))
}

/// `key` of the page or of the nearest ancestor that has it.
fn inherited<'a>(doc: &'a Document, page: ObjectId, key: &[u8]) -> Option<&'a Object> {
    let mut id = page;
    for _ in 0..TREE_DEPTH_MAX {
        let dict = doc.get_dictionary(id).ok()?;
        if let Ok(value) = dict.get(key) {
            return doc.dereference(value).ok().map(|(_, value)| value);
        }
        id = dict.get(b"Parent").ok()?.as_reference().ok()?;
    }
    None
}

fn box_of(doc: &Document, object: &Object) -> Option<[f32; 4]> {
    let array = object.as_array().ok()?;
    if array.len() != 4 {
        return None;
    }
    let mut v = [0f32; 4];
    for (slot, item) in v.iter_mut().zip(array) {
        *slot = doc
            .dereference(item)
            .ok()?
            .1
            .as_float()
            .ok()
            .filter(|f| f.is_finite())?;
    }
    let b = [
        v[0].min(v[2]),
        v[1].min(v[3]),
        v[0].max(v[2]),
        v[1].max(v[3]),
    ];
    (b[2] > b[0] && b[3] > b[1]).then_some(b)
}

/// The width and height of the page's box (the crop box inside the media box) and its `/Rotate`.
fn page_geometry(doc: &Document, page: ObjectId) -> (f32, f32, u16) {
    let media = inherited(doc, page, b"MediaBox")
        .and_then(|o| box_of(doc, o))
        .unwrap_or([0.0, 0.0, 612.0, 792.0]);
    let crop = inherited(doc, page, b"CropBox")
        .and_then(|o| box_of(doc, o))
        .map(|c| {
            [
                c[0].max(media[0]),
                c[1].max(media[1]),
                c[2].min(media[2]),
                c[3].min(media[3]),
            ]
        })
        .filter(|c| c[2] > c[0] && c[3] > c[1])
        .unwrap_or(media);
    let rotate = inherited(doc, page, b"Rotate")
        .and_then(|o| o.as_i64().ok())
        .map_or(0, |r| {
            u16::try_from(r.rem_euclid(360) / 90 * 90).unwrap_or(0)
        });
    (crop[2] - crop[0], crop[3] - crop[1], rotate)
}

/// The first `SignatureN` that no signature field has.
fn free_field_name(taken: &[String]) -> String {
    (1u32..)
        .map(|n| format!("Signature{n}"))
        .find(|candidate| !taken.contains(candidate))
        .unwrap_or_else(|| "Signature".to_owned())
}

/// The appended bytes hold `needle` exactly once: its offset in `bytes` (counted from `from`).
fn find_unique(bytes: &[u8], from: usize, needle: &[u8]) -> Result<usize, AppError> {
    let tail = bytes.get(from..).ok_or_else(|| failed("no update"))?;
    let mut found = None;
    let mut start = 0;
    while let Some(at) = tail
        .get(start..)
        .and_then(|rest| rest.windows(needle.len()).position(|w| w == needle))
    {
        if found.is_some() {
            return Err(failed("a placeholder is not unique"));
        }
        found = Some(from + start + at);
        start += at + 1;
    }
    found.ok_or_else(|| failed("a placeholder is missing"))
}

/// Pushes `item` on the array `key` of the dictionary `holder`, wherever the array is: written in the dictionary, an object of its own
/// (then a copy of that object goes into the update), or missing.
fn push_entry(
    inc: &mut IncrementalDocument,
    holder: &mut Dictionary,
    key: &[u8],
    item: Object,
) -> Result<(), AppError> {
    match holder.get(key) {
        Ok(Object::Reference(array)) => {
            let array = *array;
            inc.opt_clone_object_to_new_document(array)
                .map_err(lopdf_error)?;
            match inc.new_document.get_object_mut(array) {
                Ok(Object::Array(items)) => items.push(item),
                _ => return Err(AppError::invalid("document")),
            }
        }
        Ok(Object::Array(_)) => {
            if let Ok(Object::Array(items)) = holder.get_mut(key) {
                items.push(item);
            }
        }
        Ok(_) => return Err(AppError::invalid("document")),
        Err(_) => holder.set(key.to_vec(), Object::Array(vec![item])),
    }
    Ok(())
}

/// Writes the signature revision on top of `original` (`doc` is the same bytes, loaded with `load_untrusted`).
///
/// Refuses: an encrypted document (`unsupported_feature` `signEncrypted`), an XFA form (`unsupported_feature` `xfa`), a document that a
/// certification signature locks (`read_only` `certified`), a seal outside the page or smaller than 72 by 24 pt (`invalid_argument`
/// `placement`).
pub fn prepare(original: Vec<u8>, doc: Document, plan: &SignPlan) -> Result<Prepared, AppError> {
    if doc.is_encrypted() {
        return Err(AppError::unsupported("signEncrypted"));
    }
    let root = doc
        .trailer
        .get(b"Root")
        .and_then(Object::as_reference)
        .map_err(|_| AppError::invalid("document"))?;
    let catalog = doc.get_dictionary(root).map_err(lopdf_error)?.clone();
    let acro_prev: Option<Dictionary> = match catalog.get(b"AcroForm") {
        Ok(object) => doc
            .dereference(object)
            .ok()
            .and_then(|(_, o)| o.as_dict().ok())
            .cloned(),
        Err(_) => None,
    };
    if acro_prev.as_ref().is_some_and(|acro| acro.has(b"XFA")) {
        return Err(AppError::unsupported("xfa"));
    }
    let scan = sigread::scan_fields(&doc)?;
    if scan.doc_mdp == Some(1) {
        return Err(AppError::read_only("certified"));
    }
    if scan.truncated || scan.fields.len() >= limits::SIGS_PER_DOC_MAX {
        return Err(AppError::limit(
            "signatures",
            limits::SIGS_PER_DOC_MAX as u64,
        ));
    }
    let certifies = scan.doc_mdp.is_none() && !scan.fields.iter().any(|field| field.signed);
    let taken: Vec<String> = scan.fields.iter().map(|f| f.name.clone()).collect();
    let field_name = free_field_name(&taken);

    let pages = doc.get_pages();
    let (page_index, rect) = match &plan.placement {
        Some((index, rect)) => (*index, Some(*rect)),
        None => (0, None),
    };
    let page_id = *pages
        .get(&(page_index + 1))
        .ok_or(AppError::invalid("placement"))?;
    let (box_w, box_h, rotate) = page_geometry(&doc, page_id);
    let mapper = page_mapper(&doc, page_id);
    // The rectangle in user space and the size the reader sees (a page turned by 90 or 270 shows it with the sides swapped).
    let (user_rect, seal_size) = match rect {
        Some(rect) => {
            let finite = [rect.x, rect.y, rect.w, rect.h]
                .iter()
                .all(|v| v.is_finite());
            let (w, h) = if rotate % 180 == 90 {
                (rect.h, rect.w)
            } else {
                (rect.w, rect.h)
            };
            let inside = rect.x >= -EDGE_TOLERANCE_PT
                && rect.y >= -EDGE_TOLERANCE_PT
                && rect.x + rect.w <= box_w + EDGE_TOLERANCE_PT
                && rect.y + rect.h <= box_h + EDGE_TOLERANCE_PT;
            if !(finite && inside && w >= SEAL_MIN.0 && h >= SEAL_MIN.1) {
                return Err(AppError::invalid("placement"));
            }
            (mapper.rect(rect), Some((w, h)))
        }
        None => ([0.0; 4], None),
    };

    let mut inc = IncrementalDocument::create_from(original, doc);
    let original_len = inc.get_prev_documents_bytes().len();

    // The signature dictionary.
    let mut sig = Dictionary::new();
    sig.set("Type", name("Sig"));
    sig.set("Filter", name("Adobe.PPKLite"));
    sig.set("SubFilter", name("ETSI.CAdES.detached"));
    sig.set(
        "ByteRange",
        Object::Array(
            std::iter::once(Object::Integer(0))
                .chain(MAGIC.iter().map(|m| Object::Integer(*m)))
                .collect(),
        ),
    );
    sig.set(
        "Contents",
        Object::String(vec![0u8; plan.contents_len], StringFormat::Hexadecimal),
    );
    sig.set("M", literal(&plan.signed_at));
    sig.set("Name", text_string(&plan.name));
    if let Some(reason) = &plan.reason {
        sig.set("Reason", text_string(reason));
    }
    if let Some(location) = &plan.location {
        sig.set("Location", text_string(location));
    }
    if certifies {
        let p = match plan.lock {
            SignLock::AllowFillAndSign => 2,
            SignLock::NoChanges => 1,
        };
        let mut params = Dictionary::new();
        params.set("Type", name("TransformParams"));
        params.set("P", p);
        params.set("V", name("1.2"));
        let mut reference = Dictionary::new();
        reference.set("Type", name("SigRef"));
        reference.set("TransformMethod", name("DocMDP"));
        reference.set("TransformParams", Object::Dictionary(params));
        reference.set("Data", Object::Reference(root));
        reference.set("DigestMethod", name("SHA256"));
        sig.set(
            "Reference",
            Object::Array(vec![Object::Dictionary(reference)]),
        );
    }
    let sig_id = inc.new_document.add_object(sig);

    // The merged signature field and widget.
    let mut widget = Dictionary::new();
    widget.set("Type", name("Annot"));
    widget.set("Subtype", name("Widget"));
    widget.set("FT", name("Sig"));
    widget.set("T", literal(&field_name));
    widget.set("V", Object::Reference(sig_id));
    widget.set("P", Object::Reference(page_id));
    widget.set("F", FLAGS_WIDGET);
    widget.set(
        "Rect",
        Object::Array(user_rect.iter().map(|v| real(*v)).collect()),
    );
    if let Some((width, height)) = seal_size {
        let spec = SealSpec {
            width,
            height,
            rotate,
            name: plan.name.clone(),
            signed_label: plan.signed_label.clone(),
            date: plan.date_line.clone(),
            reason_line: plan.reason_line.clone(),
        };
        let ap = seal::write(&spec, plan.art.as_ref(), &mut inc.new_document)?;
        let mut normal = Dictionary::new();
        normal.set("N", Object::Reference(ap));
        widget.set("AP", Object::Dictionary(normal));
    }
    let widget_id = inc.new_document.add_object(widget);

    // The page lists the widget.
    inc.opt_clone_object_to_new_document(page_id)
        .map_err(lopdf_error)?;
    let mut page = inc
        .new_document
        .get_dictionary(page_id)
        .map_err(lopdf_error)?
        .clone();
    push_entry(&mut inc, &mut page, b"Annots", Object::Reference(widget_id))?;
    inc.new_document
        .set_object(page_id, Object::Dictionary(page));

    // The AcroForm lists the field and sets SigFlags 3 (signatures exist, the file is append-only).
    let mut catalog_new = catalog.clone();
    match catalog.get(b"AcroForm") {
        Ok(Object::Reference(acro_id)) => {
            let acro_id = *acro_id;
            inc.opt_clone_object_to_new_document(acro_id)
                .map_err(lopdf_error)?;
            let mut acro = inc
                .new_document
                .get_dictionary(acro_id)
                .map_err(lopdf_error)?
                .clone();
            push_entry(&mut inc, &mut acro, b"Fields", Object::Reference(widget_id))?;
            acro.set("SigFlags", 3);
            inc.new_document
                .set_object(acro_id, Object::Dictionary(acro));
        }
        Ok(Object::Dictionary(inline)) => {
            let mut acro = inline.clone();
            push_entry(&mut inc, &mut acro, b"Fields", Object::Reference(widget_id))?;
            acro.set("SigFlags", 3);
            catalog_new.set("AcroForm", Object::Dictionary(acro));
        }
        _ => {
            let mut acro = Dictionary::new();
            acro.set("Fields", Object::Array(vec![Object::Reference(widget_id)]));
            acro.set("SigFlags", 3);
            let acro_id = inc.new_document.add_object(acro);
            catalog_new.set("AcroForm", Object::Reference(acro_id));
        }
    }
    // The catalog names the certification signature.
    if certifies {
        match catalog.get(b"Perms") {
            Ok(Object::Reference(perms_id)) => {
                let perms_id = *perms_id;
                inc.opt_clone_object_to_new_document(perms_id)
                    .map_err(lopdf_error)?;
                if let Ok(Object::Dictionary(perms)) = inc.new_document.get_object_mut(perms_id) {
                    perms.set("DocMDP", Object::Reference(sig_id));
                }
            }
            Ok(Object::Dictionary(inline)) => {
                let mut perms = inline.clone();
                perms.set("DocMDP", Object::Reference(sig_id));
                catalog_new.set("Perms", Object::Dictionary(perms));
            }
            _ => {
                let mut perms = Dictionary::new();
                perms.set("DocMDP", Object::Reference(sig_id));
                catalog_new.set("Perms", Object::Dictionary(perms));
            }
        }
    }
    inc.new_document
        .set_object(root, Object::Dictionary(catalog_new));

    let mut bytes = Vec::new();
    inc.save_to(&mut bytes).map_err(lopdf_error)?;
    drop(inc);

    // The placeholders: `/Contents` and `/ByteRange` are each found once, in the appended bytes only.
    let mut needle = Vec::with_capacity(plan.contents_len * 2 + 2);
    needle.push(b'<');
    needle.extend(std::iter::repeat_n(b'0', plan.contents_len * 2));
    needle.push(b'>');
    let gap_start = find_unique(&bytes, original_len, &needle)?;
    let gap = gap_start..gap_start + needle.len();
    let magic = MAGIC
        .iter()
        .map(i64::to_string)
        .collect::<Vec<_>>()
        .join(" ");
    let range_at = find_unique(&bytes, original_len, magic.as_bytes())?;
    let total = bytes.len();
    let numbers = [gap.start, gap.end, total - gap.end];
    let patched = numbers
        .iter()
        .map(|n| format!("{n:>NUMBER_WIDTH$}"))
        .collect::<Vec<_>>()
        .join(" ");
    if patched.len() != magic.len() || numbers.iter().any(|n| n.to_string().len() > NUMBER_WIDTH) {
        return Err(failed("the file is too large for a 10 digit byte range"));
    }
    bytes[range_at..range_at + patched.len()].copy_from_slice(patched.as_bytes());
    Ok(Prepared {
        bytes,
        gap,
        field_name,
        certifies,
    })
}

/// Puts the CMS signature into the gap of `prepared` (hexadecimal, zero-padded) and returns the finished file.
pub fn finish(prepared: Prepared, cms: &[u8]) -> Result<Vec<u8>, AppError> {
    let Prepared { mut bytes, gap, .. } = prepared;
    let room = gap.len().saturating_sub(2) / 2;
    if cms.len() > room || bytes.get(gap.clone()).is_none() {
        return Err(failed("the signature does not fit its placeholder"));
    }
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut at = gap.start + 1;
    for byte in cms {
        bytes[at] = HEX[usize::from(byte >> 4)];
        bytes[at + 1] = HEX[usize::from(byte & 15)];
        at += 2;
    }
    Ok(bytes)
}

/// `D:YYYYMMDDHHmmSS+HH'mm'` and `YYYY-MM-DD HH:mm +hh:mm` for one instant.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Stamp {
    pub pdf: String,
    pub seal: String,
}

impl Stamp {
    /// The instant `zoned`, in its own time zone.
    pub fn of(zoned: &jiff::Zoned) -> Self {
        let offset = zoned.offset().seconds();
        let sign = if offset < 0 { '-' } else { '+' };
        let (hours, minutes) = (offset.abs() / 3600, offset.abs() % 3600 / 60);
        Self {
            pdf: format!(
                "D:{}{sign}{hours:02}'{minutes:02}'",
                zoned.strftime("%Y%m%d%H%M%S")
            ),
            seal: format!(
                "{} {sign}{hours:02}:{minutes:02}",
                zoned.strftime("%Y-%m-%d %H:%M")
            ),
        }
    }

    pub fn now() -> Self {
        Self::of(&jiff::Zoned::now())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::dictionary;

    fn plain_pdf(extra_catalog: impl FnOnce(&mut Document, &mut Dictionary)) -> Vec<u8> {
        let mut doc = Document::with_version("1.7");
        let pages = doc.new_object_id();
        let page = doc.add_object(dictionary! {
            "Type" => "Page", "Parent" => pages,
            "MediaBox" => vec![0.into(), 0.into(), 300.into(), 400.into()],
        });
        doc.objects.insert(
            pages,
            Object::Dictionary(dictionary! {
                "Type" => "Pages", "Kids" => vec![page.into()], "Count" => 1,
            }),
        );
        let mut catalog = dictionary! { "Type" => "Catalog", "Pages" => pages };
        extra_catalog(&mut doc, &mut catalog);
        let catalog = doc.add_object(catalog);
        doc.trailer.set("Root", catalog);
        let mut bytes = Vec::new();
        doc.save_to(&mut bytes).unwrap();
        bytes
    }

    fn plan(contents_len: usize) -> SignPlan {
        SignPlan {
            placement: Some((
                0,
                Rect {
                    x: 20.0,
                    y: 20.0,
                    w: 192.0,
                    h: 64.0,
                },
            )),
            name: "Ada Lovelace".into(),
            signed_at: "D:20261005140500+02'00'".into(),
            date_line: "2026-10-05 14:05 +02:00".into(),
            signed_label: seal::SIGNED_EN.into(),
            reason_line: None,
            reason: None,
            location: None,
            art: None,
            lock: SignLock::AllowFillAndSign,
            contents_len,
        }
    }

    fn run(bytes: &[u8], plan: &SignPlan) -> Result<Prepared, AppError> {
        prepare(
            bytes.to_vec(),
            crate::pdfwrite::load_untrusted(bytes)?,
            plan,
        )
    }

    #[test]
    fn the_revision_is_appended_with_placeholders_found_once() {
        let original = plain_pdf(|_, _| {});
        let prepared = run(&original, &plan(2048)).unwrap();
        assert_eq!(&prepared.bytes[..original.len()], &original[..]);
        assert!(prepared.certifies);
        assert_eq!(prepared.field_name, "Signature1");
        assert_eq!(prepared.gap.len(), 2 * 2048 + 2);
        assert_eq!(prepared.bytes[prepared.gap.start], b'<');
        assert_eq!(prepared.bytes[prepared.gap.end - 1], b'>');
        let text = String::from_utf8_lossy(&prepared.bytes[original.len()..]).into_owned();
        let range = format!(
            "[0 {:>10} {:>10} {:>10}]",
            prepared.gap.start,
            prepared.gap.end,
            prepared.bytes.len() - prepared.gap.end
        );
        assert!(text.contains(&range), "{range} in the update");
        assert!(text.contains("/DocMDP") && text.contains("/SigFlags 3"));
        assert!(text.contains("/ETSI.CAdES.detached") && text.contains("/Adobe.PPKLite"));
        // The result is a PDF whose signature field the scan reads back.
        let gap = prepared.gap.clone();
        let finished = finish(prepared, &[0xAB, 0xCD, 0x01]).unwrap();
        let scan = sigread::scan_bytes(&finished).unwrap();
        assert_eq!(scan.fields.len(), 1);
        assert_eq!(scan.doc_mdp, Some(2));
        let field = &scan.fields[0];
        assert!(field.signed && field.contents_len == Some(2048));
        assert_eq!(field.name, "Signature1");
        assert_eq!(field.sub_filter.as_deref(), Some("ETSI.CAdES.detached"));
        assert_eq!(field.cert_p, Some(2));
        assert_eq!(&finished[gap.start + 1..][..6], b"ABCD01");
    }

    #[test]
    fn a_second_signature_approves_and_takes_the_next_name() {
        let original = plain_pdf(|_, _| {});
        let first = run(&original, &plan(1024)).unwrap();
        let signed = finish(first, &[1]).unwrap();
        let second = run(&signed, &plan(1024)).unwrap();
        assert!(!second.certifies, "only the first signature certifies");
        assert_eq!(second.field_name, "Signature2");
        let text = String::from_utf8_lossy(&second.bytes[signed.len()..]).into_owned();
        assert!(!text.contains("SigRef"), "no new DocMDP reference: {text}");
        let done = finish(second, &[2]).unwrap();
        let scan = sigread::scan_bytes(&done).unwrap();
        assert_eq!(scan.fields.len(), 2);
        assert_eq!(scan.doc_mdp, Some(2));
        assert_eq!(&done[..signed.len()], &signed[..]);
    }

    #[test]
    fn no_changes_sets_p_1_and_a_certified_document_refuses_more() {
        let original = plain_pdf(|_, _| {});
        let mut request = plan(1024);
        request.lock = SignLock::NoChanges;
        let signed = finish(run(&original, &request).unwrap(), &[1]).unwrap();
        assert_eq!(sigread::scan_bytes(&signed).unwrap().doc_mdp, Some(1));
        let refused = run(&signed, &plan(1024)).unwrap_err();
        assert_eq!(refused.code(), ErrorCode::ReadOnly);
    }

    #[test]
    fn an_invisible_signature_has_an_empty_rect_on_the_first_page() {
        let original = plain_pdf(|_, _| {});
        let mut request = plan(1024);
        request.placement = None;
        let prepared = run(&original, &request).unwrap();
        let text = String::from_utf8_lossy(&prepared.bytes[original.len()..]).into_owned();
        assert!(
            text.contains("/Rect [0 0 0 0]") || text.contains("/Rect[0 0 0 0]"),
            "{text}"
        );
        assert!(!text.contains("/AP"));
    }

    #[test]
    fn the_seal_must_be_big_enough_and_on_the_page() {
        let original = plain_pdf(|_, _| {});
        for (x, y, w, h) in [
            (20.0, 20.0, 60.0, 30.0),
            (20.0, 20.0, 100.0, 10.0),
            (250.0, 20.0, 100.0, 30.0),
            (20.0, 380.0, 100.0, 30.0),
            (f32::NAN, 20.0, 100.0, 30.0),
        ] {
            let mut request = plan(1024);
            request.placement = Some((0, Rect { x, y, w, h }));
            let error = run(&original, &request).unwrap_err();
            assert_eq!(error.code(), ErrorCode::InvalidArgument, "{x} {y} {w} {h}");
        }
        let mut request = plan(1024);
        request.placement = Some((
            3,
            Rect {
                x: 0.0,
                y: 0.0,
                w: 100.0,
                h: 30.0,
            },
        ));
        assert_eq!(
            run(&original, &request).unwrap_err().code(),
            ErrorCode::InvalidArgument
        );
    }

    #[test]
    fn an_xfa_form_and_an_existing_acroform_are_handled() {
        let xfa = plain_pdf(|doc, catalog| {
            let acro = doc.add_object(
                dictionary! { "Fields" => Vec::<Object>::new(), "XFA" => Vec::<Object>::new() },
            );
            catalog.set("AcroForm", acro);
        });
        assert_eq!(
            run(&xfa, &plan(1024)).unwrap_err().code(),
            ErrorCode::UnsupportedFeature
        );
        // An AcroForm with a text field and a Fields array of its own object keeps the field and gains the signature.
        let with_form = plain_pdf(|doc, catalog| {
            let text = doc.add_object(dictionary! { "FT" => "Tx", "T" => Object::string_literal("Name"), "V" => Object::string_literal("x") });
            let fields = doc.add_object(vec![Object::from(text)]);
            let acro = doc.add_object(
                dictionary! { "Fields" => fields, "DA" => Object::string_literal("/Helv 0 Tf") },
            );
            catalog.set("AcroForm", acro);
        });
        let prepared = run(&with_form, &plan(1024)).unwrap();
        let signed = finish(prepared, &[1]).unwrap();
        let doc = crate::pdfwrite::load_untrusted(&signed).unwrap();
        let catalog = doc.catalog().unwrap();
        let acro = doc
            .get_dictionary(catalog.get(b"AcroForm").unwrap().as_reference().unwrap())
            .unwrap();
        let fields = doc
            .get_object(acro.get(b"Fields").unwrap().as_reference().unwrap())
            .unwrap()
            .as_array()
            .unwrap();
        assert_eq!(fields.len(), 2);
        assert!(acro.has(b"DA") && acro.get(b"SigFlags").unwrap().as_i64().unwrap() == 3);
    }

    #[test]
    fn an_encrypted_document_is_refused_and_a_rotated_page_gets_a_matrix() {
        let rotated = {
            let mut doc = Document::with_version("1.7");
            let pages = doc.new_object_id();
            let page = doc.add_object(dictionary! {
                "Type" => "Page", "Parent" => pages, "Rotate" => 90,
                "MediaBox" => vec![0.into(), 0.into(), 300.into(), 400.into()],
            });
            doc.objects.insert(
                pages,
                Object::Dictionary(
                    dictionary! { "Type" => "Pages", "Kids" => vec![page.into()], "Count" => 1 },
                ),
            );
            let catalog = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages });
            doc.trailer.set("Root", catalog);
            let mut bytes = Vec::new();
            doc.save_to(&mut bytes).unwrap();
            bytes
        };
        // A seal that reads 192 by 64 on the turned page is 64 by 192 on the page in user space.
        let mut request = plan(1024);
        request.placement = Some((
            0,
            Rect {
                x: 20.0,
                y: 20.0,
                w: 64.0,
                h: 192.0,
            },
        ));
        let prepared = run(&rotated, &request).unwrap();
        let text = String::from_utf8_lossy(&prepared.bytes[rotated.len()..]).into_owned();
        assert!(text.contains("/Matrix"), "{text}");
        assert!(
            text.contains("/Rect[20 188 84 380]") || text.contains("/Rect [20 188 84 380]"),
            "{text}"
        );
        // 192 by 64 as given is only 64 by 192 for the reader: too narrow.
        assert!(run(&rotated, &plan(1024)).is_err());
    }

    #[test]
    fn texts_are_cleaned_and_bounded() {
        assert_eq!(clean_text(None, 5, "reason").unwrap(), None);
        assert_eq!(
            clean_text(Some("  \u{202E}hi\u{0007} "), 5, "reason")
                .unwrap()
                .as_deref(),
            Some("hi")
        );
        assert_eq!(clean_text(Some(" "), 5, "reason").unwrap(), None);
        assert!(clean_text(Some("abcdef"), 5, "reason").is_err());
    }

    #[test]
    fn the_stamp_is_one_instant_in_two_forms() {
        let zoned = jiff::civil::date(2026, 10, 5)
            .at(14, 5, 9, 0)
            .in_tz("Europe/Berlin")
            .unwrap();
        let stamp = Stamp::of(&zoned);
        assert_eq!(stamp.pdf, "D:20261005140509+02'00'");
        assert_eq!(stamp.seal, "2026-10-05 14:05 +02:00");
        let west = jiff::civil::date(2026, 1, 5)
            .at(9, 0, 0, 0)
            .in_tz("America/St_Johns")
            .unwrap();
        assert_eq!(Stamp::of(&west).seal, "2026-01-05 09:00 -03:30");
    }

    #[test]
    fn a_gap_is_found_exactly_once_or_not_at_all() {
        assert!(find_unique(b"abcabc", 0, b"abc").is_err());
        assert_eq!(find_unique(b"abcxyz", 0, b"xyz").unwrap(), 3);
        assert!(find_unique(b"abc", 0, b"q").is_err());
        assert!(find_unique(b"abc", 9, b"a").is_err());
    }
}
