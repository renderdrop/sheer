//! Writes the headers and footers (ADR-139 Addendum A2, ARCHITECTURE §16.2): per page one marked `/Artifact /Pagination` stream with the
//! resolved runs in Helvetica (WinAnsi, not embedded), placed against the CropBox and turned so that the text is upright as shown on a
//! `/Rotate`d page. The page gets the key `/SHR_HF << /V 1 /S <stream> >>`; the spec itself goes into the catalog as `/SHR_HF` so a
//! reopened document can edit or remove it. Always an incremental update on top of the file.
//!
//! The layer shares its wrapper with the OCR layer (`page_layer`): `[q, original..., Q, ocr?, hf?]`.

use lopdf::{dictionary, Dictionary, Document, IncrementalDocument, Object, ObjectId, Stream};

use super::page_layer::{self, num, page_geom, PageGeom, Wrap, HF_HEAD, HF_KEY};
use crate::content::std14;
use crate::error::{AppError, ErrorCode};
use crate::model::annotation::Rgb;
use crate::model::header_footer::{
    HfSpec, HfWrite, PlacedRun, BACKGROUND_PAD, BOX_ASCENT, BOX_DESCENT,
};

/// The resource name of the font on a page.
pub const FONT_NAME: &str = "SHR_HF0";
/// The largest spec JSON that is written or read (bytes).
pub const SPEC_MAX_BYTES: usize = 16 * 1024;

fn damaged(what: &str) -> AppError {
    AppError::logged(ErrorCode::DamagedFile, format!("header footer: {what}"))
}

/// The WinAnsi bytes of `text` as a PDF hex string; a character with no code is `?` (the spec was checked before).
fn hex_winansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len() * 2 + 2);
    out.push('<');
    for c in text.chars() {
        out.push_str(&format!("{:02X}", std14::winansi(c).unwrap_or(b'?')));
    }
    out.push('>');
    out
}

/// The content of the layer of one page. `geom` is the page as the file has it: the runs are in page space (top left of the unrotated
/// crop box, y down) and turn with the page's rotation, so that they read upright on the displayed page.
///
/// With `background`, an opaque box in the page colour (`run.fill`, white when none was sampled) is filled behind every run first,
/// after the wrapped original and before `BT`: the run's full glyph box (`BOX_DESCENT` to `BOX_ASCENT`, its width) plus
/// [`BACKGROUND_PAD`] on every side, turned with the page (F21.7). The layer starts from the initial graphics state (the original
/// is wrapped in `q`/`Q`), so the fill is opaque. Only this layer carries it; the page content is not changed.
pub fn layer_stream(geom: &PageGeom, runs: &[PlacedRun], color: Rgb, background: bool) -> Vec<u8> {
    let mut out = String::from_utf8_lossy(HF_HEAD).into_owned();
    if background {
        let (x, up) = geom.axes();
        for run in runs {
            if !run.origin.x.is_finite()
                || !run.origin.y.is_finite()
                || !run.width.is_finite()
                || run.text.is_empty()
            {
                continue;
            }
            let (e, f) = (geom.crop[0] + run.origin.x, geom.crop[3] - run.origin.y);
            let (a0, a1) = (-BACKGROUND_PAD, run.width + BACKGROUND_PAD);
            let b0 = -(BOX_DESCENT * run.size + BACKGROUND_PAD);
            let b1 = BOX_ASCENT * run.size + BACKGROUND_PAD;
            let corner = |a: f32, b: f32| {
                format!(
                    "{} {}",
                    num(e + a * x[0] + b * up[0]),
                    num(f + a * x[1] + b * up[1])
                )
            };
            // The page colour sampled for this box; white when none was.
            let [fr, fg, fb] = run.fill.map_or([255, 255, 255], |c| c.0);
            let ch = |v: u8| num(f32::from(v) / 255.0);
            out.push_str(&format!("{} {} {} rg\n", ch(fr), ch(fg), ch(fb)));
            out.push_str(&format!(
                "{} m {} l {} l {} l h f\n",
                corner(a0, b0),
                corner(a1, b0),
                corner(a1, b1),
                corner(a0, b1)
            ));
        }
    }
    out.push_str("BT\n0 Tr\n");
    let channel = |v: u8| num(f32::from(v) / 255.0);
    out.push_str(&format!(
        "{} {} {} rg\n",
        channel(color.0[0]),
        channel(color.0[1]),
        channel(color.0[2])
    ));
    let (x, up) = geom.axes();
    for run in runs {
        if !run.origin.x.is_finite() || !run.origin.y.is_finite() || run.text.is_empty() {
            continue;
        }
        let e = geom.crop[0] + run.origin.x;
        let f = geom.crop[3] - run.origin.y;
        out.push_str(&format!(
            "/{FONT_NAME} {} Tf {} {} {} {} {} {} Tm {} Tj\n",
            num(run.size),
            num(x[0]),
            num(x[1]),
            num(up[0]),
            num(up[1]),
            num(e),
            num(f),
            hex_winansi(&run.text)
        ));
    }
    out.push_str("ET\nEMC\nQ\n");
    out.into_bytes()
}

/// The Helvetica font dictionary every page of the update shares.
fn add_font(inc: &mut IncrementalDocument) -> ObjectId {
    inc.new_document.add_object(dictionary! {
        "Type" => "Font",
        "Subtype" => "Type1",
        "BaseFont" => "Helvetica",
        "Encoding" => "WinAnsiEncoding",
    })
}

fn catalog_id(doc: &Document) -> Result<ObjectId, AppError> {
    doc.trailer
        .get(b"Root")
        .ok()
        .and_then(|o| o.as_reference().ok())
        .ok_or_else(|| damaged("catalog"))
}

/// Writes `pages` (page object, runs) into `inc` with the layer of the spec, takes the layer off the pages in `strip`, and sets (or,
/// with no spec, removes) the catalog key. A page named in `pages` replaces its earlier layer; an OCR layer stays on every page.
pub fn write(
    inc: &mut IncrementalDocument,
    pages: &[(ObjectId, Vec<PlacedRun>)],
    strip: &[ObjectId],
    spec: Option<&HfSpec>,
) -> Result<(), AppError> {
    let color = spec.map_or(Rgb([0, 0, 0]), |s| s.color);
    let json = spec
        .map(|s| serde_json::to_vec(s).map_err(|e| AppError::logged(ErrorCode::Internal, e)))
        .transpose()?;
    if json.as_ref().is_some_and(|j| j.len() > SPEC_MAX_BYTES) {
        return Err(AppError::limit("headerFooter", SPEC_MAX_BYTES as u64));
    }
    let wrap = Wrap::add(inc);
    let font = (!pages.is_empty()).then(|| add_font(inc));
    for (page, runs) in pages {
        let Some(font) = font else { break };
        let prev = inc.get_prev_documents();
        let mut dict = prev
            .get_dictionary(*page)
            .map_err(|_| damaged("page"))?
            .clone();
        let geom = page_geom(prev, *page);
        let old = page_layer::split(prev, &dict);
        let resources = page_layer::resources_with_font(prev, *page, FONT_NAME, font);
        let stream = layer_stream(&geom, runs, color, spec.is_some_and(|s| s.background));
        let stream = inc
            .new_document
            .add_object(Stream::new(Dictionary::new(), stream));
        dict.set(
            "Contents",
            Object::Array(page_layer::assemble(old.base, wrap, old.ocr, Some(stream))),
        );
        dict.set("Resources", Object::Dictionary(resources));
        dict.set(
            HF_KEY,
            Object::Dictionary(dictionary! { "V" => 1, "S" => stream }),
        );
        inc.new_document.set_object(*page, Object::Dictionary(dict));
    }
    for page in strip {
        let prev = inc.get_prev_documents();
        let mut dict = prev
            .get_dictionary(*page)
            .map_err(|_| damaged("page"))?
            .clone();
        let old = page_layer::split(prev, &dict);
        dict.set(
            "Contents",
            Object::Array(page_layer::assemble(old.base, wrap, old.ocr, None)),
        );
        dict.remove(HF_KEY);
        inc.new_document.set_object(*page, Object::Dictionary(dict));
    }
    let prev = inc.get_prev_documents();
    let root = catalog_id(prev)?;
    let mut catalog = prev
        .get_dictionary(root)
        .map_err(|_| damaged("catalog"))?
        .clone();
    match json {
        Some(json) => catalog.set(
            HF_KEY,
            Object::Dictionary(dictionary! {
                "V" => 1,
                "Spec" => Object::String(json, lopdf::StringFormat::Literal),
            }),
        ),
        None => {
            catalog.remove(HF_KEY);
        }
    }
    inc.new_document
        .set_object(root, Object::Dictionary(catalog));
    Ok(())
}

/// Applies a save's [`HfWrite`] on top of `original` (not encrypted): the original bytes stay as a prefix. `write.pages` is keyed by
/// the position in the file (from 0); every other page that has our layer loses it.
pub fn apply(original: Vec<u8>, write_plan: &HfWrite) -> Result<Vec<u8>, AppError> {
    let doc = super::load_untrusted(&original)?;
    if doc.is_encrypted() {
        return Err(AppError::new(ErrorCode::UnsupportedFeature));
    }
    let all = doc.get_pages();
    let mut chosen = Vec::with_capacity(write_plan.pages.len());
    for (position, runs) in &write_plan.pages {
        let id = all
            .get(&position.saturating_add(1))
            .copied()
            .ok_or_else(|| damaged("page index"))?;
        chosen.push((id, runs.clone()));
    }
    let strip: Vec<ObjectId> = all
        .values()
        .copied()
        .filter(|id| !chosen.iter().any(|(page, _)| page == id))
        .filter(|id| doc.get_dictionary(*id).is_ok_and(|dict| dict.has(HF_KEY)))
        .collect();
    let mut inc = IncrementalDocument::create_from(original, doc);
    write(&mut inc, &chosen, &strip, write_plan.spec.as_ref())?;
    let mut out = Vec::new();
    inc.save_to(&mut out)
        .map_err(|e| AppError::logged(ErrorCode::Internal, format!("save: {e}")))?;
    Ok(out)
}

/// What a file has of ours.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Found {
    /// The spec in the catalog; `None` if there is none, it is damaged or oversized.
    pub spec: Option<HfSpec>,
    /// Pages with the `/SHR_HF` key.
    pub layers: u32,
    /// Their indices in the file (from 0).
    pub layer_pages: Vec<u32>,
}

/// Reads the catalog key and counts the page keys. A spec that does not parse or check is `None` (the layers are still counted, so a
/// removal always works).
pub fn read(doc: &Document) -> Found {
    let spec = catalog_id(doc)
        .ok()
        .and_then(|root| doc.get_dictionary(root).ok())
        .and_then(|catalog| catalog.get(HF_KEY).ok())
        .and_then(|o| doc.dereference(o).ok())
        .and_then(|(_, o)| o.as_dict().ok())
        .filter(|d| d.get(b"V").ok().and_then(|v| v.as_i64().ok()) == Some(1))
        .and_then(|d| d.get(b"Spec").ok())
        .and_then(|o| o.as_str().ok())
        .filter(|bytes| bytes.len() <= SPEC_MAX_BYTES)
        .and_then(|bytes| serde_json::from_slice::<HfSpec>(bytes).ok())
        .filter(|spec| spec.check(None).is_ok());
    let layer_pages: Vec<u32> = doc
        .get_pages()
        .iter()
        .filter(|(_, id)| doc.get_dictionary(**id).is_ok_and(|d| d.has(HF_KEY)))
        .map(|(number, _)| number - 1)
        .collect();
    Found {
        spec,
        layers: u32::try_from(layer_pages.len()).unwrap_or(u32::MAX),
        layer_pages,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::annotation::Rgb;
    use crate::model::header_footer::{self, HfPages, HfSlots};
    use crate::ocr::{OcrLine, OcrPageLayer, OcrWord};
    use crate::pdfwrite::ocr_layer::apply_ocr_layers;
    use std::collections::BTreeMap;

    /// A file of `count` pages; `extra` is added to every page dictionary.
    fn pdf(count: usize, media: [i64; 4], extra: Dictionary) -> Vec<u8> {
        let mut doc = Document::with_version("1.5");
        let pages = doc.new_object_id();
        let mut kids = Vec::new();
        for _ in 0..count {
            let content = doc.add_object(Stream::new(
                Dictionary::new(),
                b"q 2 0 0 2 0 0 cm\n".to_vec(),
            ));
            let mut page = dictionary! {
                "Type" => "Page", "Parent" => pages,
                "MediaBox" => media.iter().map(|v| Object::Integer(*v)).collect::<Vec<_>>(),
                "Contents" => content,
            };
            for (k, v) in extra.iter() {
                page.set(k.clone(), v.clone());
            }
            kids.push(Object::Reference(doc.add_object(page)));
        }
        doc.set_object(
            pages,
            dictionary! { "Type" => "Pages", "Kids" => kids, "Count" => count as i64 },
        );
        let catalog = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages });
        doc.trailer.set("Root", catalog);
        let mut out = Vec::new();
        doc.save_to(&mut out).unwrap();
        out
    }

    fn letter() -> Vec<u8> {
        pdf(3, [0, 0, 612, 792], Dictionary::new())
    }

    fn spec(header: &str, pages: HfPages) -> HfSpec {
        HfSpec {
            slots: HfSlots {
                header_left: header.into(),
                footer_right: "Seite {page} von {total}".into(),
                ..HfSlots::default()
            },
            pages,
            date: "07.10.2026".into(),
            ..HfSpec::default()
        }
    }

    /// The save plan for `spec` over a file of `count` pages with this geometry.
    fn write_of(spec: &HfSpec, geom: PageGeom, count: u32) -> HfWrite {
        HfWrite {
            spec: Some(spec.clone()),
            pages: (0..count)
                .map(|p| (p, header_footer::resolve(spec, geom, p, count, "Bericht")))
                .filter(|(_, runs)| !runs.is_empty())
                .collect(),
        }
    }

    fn geom0() -> PageGeom {
        PageGeom {
            crop: [0.0, 0.0, 612.0, 792.0],
            rotate: 0,
        }
    }

    /// The upper-cased text of the page and the number of its content parts.
    fn page_content(bytes: &[u8], index: u32) -> (String, usize) {
        let doc = crate::pdfwrite::prescan::load_untrusted(bytes).unwrap();
        let page = *doc.get_pages().get(&(index + 1)).unwrap();
        let parts = page_layer::content_refs(&doc, doc.get_dictionary(page).unwrap()).len();
        (
            String::from_utf8_lossy(&doc.get_page_content(page)).to_uppercase(),
            parts,
        )
    }

    fn hex(text: &str) -> String {
        hex_winansi(text).to_uppercase()
    }

    #[test]
    fn the_layer_is_appended_incrementally_and_resolved_per_page() {
        let original = letter();
        let s = spec("Bericht Müller", HfPages::All);
        let saved = apply(original.clone(), &write_of(&s, geom0(), 3)).unwrap();
        assert_eq!(&saved[..original.len()], &original[..], "prefix intact");
        for page in 0..3 {
            let (text, parts) = page_content(&saved, page);
            assert_eq!(parts, 4, "[q, original, Q, hf]");
            assert!(text.contains(&hex("Bericht Müller")), "{text}");
            assert!(text.contains(&hex(&format!("Seite {} von 3", page + 1))));
            assert!(text.contains("/ARTIFACT"), "marked as an artifact");
            // ü is 0xFC in WinAnsi
            assert!(text.contains("FC"));
        }
        let doc = crate::pdfwrite::prescan::load_untrusted(&saved).unwrap();
        let found = read(&doc);
        assert_eq!(found.layers, 3);
        assert_eq!(found.spec.as_ref(), Some(&s));
    }

    #[test]
    fn the_page_range_is_respected_and_a_narrower_one_takes_the_layer_off() {
        let all = apply(letter(), &write_of(&spec("A", HfPages::All), geom0(), 3)).unwrap();
        let narrow = spec("B", HfPages::Ranges { text: "2".into() });
        let saved = apply(all.clone(), &write_of(&narrow, geom0(), 3)).unwrap();
        assert!(saved.starts_with(&all), "still incremental");
        let (first, parts_first) = page_content(&saved, 0);
        assert!(!first.contains("/ARTIFACT"), "{first}");
        assert_eq!(parts_first, 1, "the original alone again");
        let (second, parts) = page_content(&saved, 1);
        assert_eq!(parts, 4);
        assert!(second.contains(&hex("B")) && !second.contains(&hex("A")));
        assert_eq!(second.matches("/ARTIFACT").count(), 1);
        let doc = crate::pdfwrite::prescan::load_untrusted(&saved).unwrap();
        assert_eq!(read(&doc).layers, 1);
    }

    #[test]
    fn applying_again_replaces_and_removing_removes() {
        let first = apply(letter(), &write_of(&spec("alt", HfPages::All), geom0(), 3)).unwrap();
        let second = apply(
            first.clone(),
            &write_of(&spec("neu", HfPages::All), geom0(), 3),
        )
        .unwrap();
        for page in 0..3 {
            let (text, parts) = page_content(&second, page);
            assert_eq!(parts, 4, "no wrap on wrap");
            assert!(!text.contains(&hex("alt")), "old header gone: {text}");
            assert_eq!(text.matches(&hex("neu")).count(), 1);
        }
        let removed = apply(
            second.clone(),
            &HfWrite {
                spec: None,
                pages: Vec::new(),
            },
        )
        .unwrap();
        assert!(removed.starts_with(&second));
        for page in 0..3 {
            let (text, parts) = page_content(&removed, page);
            assert_eq!(parts, 1);
            assert!(!text.contains("/ARTIFACT") && !text.contains(&hex("neu")));
        }
        let doc = crate::pdfwrite::prescan::load_untrusted(&removed).unwrap();
        assert_eq!(read(&doc), Found::default());
    }

    fn ocr_words(text: &str) -> BTreeMap<u32, OcrPageLayer> {
        BTreeMap::from([(
            0u32,
            OcrPageLayer {
                lang: "en-US".into(),
                lines: vec![OcrLine {
                    words: vec![OcrWord {
                        text: text.into(),
                        rect: [10.0, 10.0, 60.0, 22.0],
                    }],
                }],
                ..OcrPageLayer::default()
            },
        )])
    }

    fn ocr_hex(text: &str) -> String {
        crate::pdfwrite::ocr_layer::hex_codes(text)
    }

    #[test]
    fn one_layer_each_beside_ocr_whatever_the_order() {
        let s = spec("Kopf", HfPages::All);
        let hf = apply(letter(), &write_of(&s, geom0(), 3)).unwrap();
        let both = apply_ocr_layers(hf, &ocr_words("scan"), false).unwrap();
        let (text, parts) = page_content(&both, 0);
        assert_eq!(parts, 5, "[q, original, Q, ocr, hf]");
        assert!(text.contains(&hex("Kopf")) && text.contains(&ocr_hex("scan")));
        // the header again: the OCR layer stays
        let s2 = spec("Neu", HfPages::All);
        let again = apply(both, &write_of(&s2, geom0(), 3)).unwrap();
        let (text, parts) = page_content(&again, 0);
        assert_eq!(parts, 5);
        assert!(text.contains(&ocr_hex("scan")));
        assert!(!text.contains(&hex("Kopf")) && text.contains(&hex("Neu")));
        // the OCR again: the header stays
        let redone = apply_ocr_layers(again, &ocr_words("neu"), false).unwrap();
        let (text, parts) = page_content(&redone, 0);
        assert_eq!(parts, 5);
        assert!(!text.contains(&ocr_hex("scan")) && text.contains(&ocr_hex("neu")));
        assert!(text.contains(&hex("Neu")));
        assert_eq!(text.matches("/ARTIFACT").count(), 1);
        // removing the header leaves the OCR layer
        let removed = apply(
            redone,
            &HfWrite {
                spec: None,
                pages: Vec::new(),
            },
        )
        .unwrap();
        let (text, parts) = page_content(&removed, 0);
        assert_eq!(parts, 4, "[q, original, Q, ocr]");
        assert!(text.contains("3 TR") && !text.contains("/ARTIFACT"));
    }

    #[test]
    fn a_hostile_page_key_never_drops_page_content() {
        let mut doc = Document::with_version("1.5");
        let pages = doc.new_object_id();
        let real = doc.add_object(Stream::new(Dictionary::new(), b"0 0 10 10 re f\n".to_vec()));
        let page = doc.add_object(dictionary! {
            "Type" => "Page", "Parent" => pages,
            "MediaBox" => vec![0.into(), 0.into(), 100.into(), 100.into()],
            "Contents" => vec![Object::Reference(real)],
            "SHR_HF" => dictionary! { "V" => 1, "S" => real },
        });
        doc.set_object(
            pages,
            dictionary! { "Type" => "Pages", "Kids" => vec![page.into()], "Count" => 1 },
        );
        let catalog = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages,
        "SHR_HF" => dictionary! { "V" => 1, "Spec" => Object::string_literal("{not json") } });
        doc.trailer.set("Root", catalog);
        let mut bytes = Vec::new();
        doc.save_to(&mut bytes).unwrap();
        let loaded = crate::pdfwrite::prescan::load_untrusted(&bytes).unwrap();
        let found = read(&loaded);
        assert_eq!((found.spec, found.layers), (None, 1));
        let removed = apply(
            bytes,
            &HfWrite {
                spec: None,
                pages: Vec::new(),
            },
        )
        .unwrap();
        let (text, _) = page_content(&removed, 0);
        assert!(text.contains("RE"), "the real content stays: {text}");
        let loaded = crate::pdfwrite::prescan::load_untrusted(&removed).unwrap();
        assert_eq!(read(&loaded), Found::default());
    }

    struct Count(usize);

    impl crate::pdfwrite::ops_walk::WalkSink for Count {
        fn run(&mut self, _run: crate::pdfwrite::ops_walk::Run) -> Result<(), AppError> {
            self.0 += 1;
            Ok(())
        }
    }

    #[test]
    fn the_text_walk_of_the_editor_does_not_see_the_header() {
        let saved = apply(letter(), &write_of(&spec("Kopf", HfPages::All), geom0(), 3)).unwrap();
        let doc = crate::pdfwrite::prescan::load_untrusted(&saved).unwrap();
        let page = *doc.get_pages().get(&1).unwrap();
        let mut count = Count(0);
        crate::pdfwrite::ops_walk::walk(
            &doc,
            page,
            &mut crate::pdfwrite::ops_walk::Budget::new(),
            &mut count,
        )
        .unwrap();
        assert_eq!(count.0, 0, "the header is not an editable line");
    }

    /// A burned text box on page 0 (`content::burn_all`), as a save plan holds it.
    fn burned_box() -> (crate::documents::PageId, Vec<crate::content::ContentObject>) {
        let draft: crate::model::annotation::AnnotationDraft =
            serde_json::from_value(serde_json::json!({
                "pageId": 1, "color": [0, 0, 0], "kind": "textBox",
                "box": {"x": 50.0, "y": 300.0, "w": 200.0, "h": 40.0},
                "text": "Burned body", "font": "sans", "fontSize": 12.0, "align": "left",
            }))
            .unwrap();
        let annotation = crate::model::annotation::Annotation::from_draft(
            crate::model::ids::AnnotId::new(1),
            &draft,
            "2026-10-08T00:00:00Z",
        )
        .unwrap();
        (
            crate::documents::PageId::new(1),
            vec![crate::content::ContentObject {
                annotation,
                index: 0,
                image: None,
            }],
        )
    }

    #[test]
    fn a_burned_object_and_a_header_layer_share_a_page_in_the_save_order() {
        // The order of `apply_extras`: the header layer first, then the burned objects on top.
        let with_header =
            apply(letter(), &write_of(&spec("Kopf", HfPages::All), geom0(), 3)).unwrap();
        let burned =
            crate::pdfwrite::content::burn_all(with_header.clone(), &[burned_box()]).unwrap();
        assert!(burned.starts_with(&with_header), "still incremental");
        let (text, parts) = page_content(&burned, 0);
        assert_eq!(parts, 6, "[q, q, original, Q, hf, burned]");
        let header_at = text.find(&hex("Kopf")).expect("header kept");
        let body_at = text.find("(BURNED BODY)").expect("burned text drawn");
        assert!(header_at < body_at, "burned objects come after the layer");
        assert_eq!(text.matches("/ARTIFACT").count(), 1);
        // the other pages keep just the header
        let (other, parts) = page_content(&burned, 1);
        assert_eq!(parts, 4);
        assert!(other.contains(&hex("Kopf")) && !other.contains("BURNED"));
        // the layers are still found,
        let doc = crate::pdfwrite::prescan::load_untrusted(&burned).unwrap();
        assert_eq!(read(&doc).layers, 3);
    }

    #[test]
    fn the_background_box_is_written_before_the_text_and_round_trips() {
        let original = letter();
        let mut s = spec("Kopf", HfPages::All);
        s.background = true;
        let saved = apply(original.clone(), &write_of(&s, geom0(), 3)).unwrap();
        assert_eq!(&saved[..original.len()], &original[..], "prefix intact");
        let (text, parts) = page_content(&saved, 0);
        assert_eq!(parts, 4, "[q, original, Q, hf]");
        let fill = text.find("1 1 1 RG").expect("white fill");
        assert!(fill < text.find("BT").unwrap() && text.contains(" H F\n"));
        // one box per run (the header and the page number), none without the option
        assert_eq!(text.matches(" H F\n").count(), 2, "{text}");
        let doc = crate::pdfwrite::prescan::load_untrusted(&saved).unwrap();
        assert_eq!(read(&doc).spec.as_ref(), Some(&s));
        let mut plain = s.clone();
        plain.background = false;
        let again = apply(saved, &write_of(&plain, geom0(), 3)).unwrap();
        let (text, _) = page_content(&again, 0);
        assert!(!text.contains(" H F\n") && text.contains(&hex("Kopf")));
        // a spec of an older file has no such key
        let mut json = serde_json::to_value(&plain).unwrap();
        json.as_object_mut().unwrap().remove("background");
        assert!(!serde_json::from_value::<HfSpec>(json).unwrap().background);
    }

    #[test]
    fn the_box_is_the_padded_text_box_and_turns_with_the_page() {
        let geom = PageGeom {
            crop: [0.0, 0.0, 200.0, 300.0],
            rotate: 0,
        };
        let run = PlacedRun {
            text: "ab".into(),
            origin: crate::model::geometry::Point { x: 20.0, y: 40.0 },
            angle: 0,
            size: 10.0,
            width: 30.0,
            fill: None,
        };
        let text = String::from_utf8(layer_stream(&geom, &[run], Rgb([0, 0, 0]), true)).unwrap();
        // baseline at pdf y 260; box from x 17 to 53, y from 260 - 2.25 - 3 = 254.75 to 260 + 9.31 + 3 (the full glyph box)
        assert!(
            text.contains("17 254.75 m 53 254.75 l 53 272.31 l 17 272.31 l h f"),
            "{text}"
        );
    }

    #[test]
    fn rotation_and_crop_set_the_text_matrix() {
        for (rotate, matrix) in [
            (0, "1 0 0 1"),
            (90, "0 1 -1 0"),
            (180, "-1 0 0 -1"),
            (270, "0 -1 1 0"),
        ] {
            let geom = PageGeom {
                crop: [10.0, 20.0, 110.0, 220.0],
                rotate,
            };
            let runs = header_footer::resolve(&spec("H", HfPages::All), geom, 0, 1, "f");
            let text =
                String::from_utf8(layer_stream(&geom, &runs, Rgb([0, 0, 0]), false)).unwrap();
            assert!(text.contains(&format!(" {matrix} ")), "{rotate}: {text}");
            assert!(
                !text.contains(" re ") && !text.contains(" f\n"),
                "no box: {text}"
            );
        }
    }
}

#[cfg(test)]
mod render_tests {
    use super::*;
    use crate::model::header_footer::{self, HfPages, HfSlots};
    use pdfium_render::prelude::*;

    fn pdfium() -> Option<crate::engine::test_support::Bound> {
        crate::engine::test_support::bind()
    }

    /// A one-page file with the given media box, crop and rotation.
    fn page_pdf(media: [i64; 4], crop: Option<[i64; 4]>, rotate: i64) -> Vec<u8> {
        let mut doc = Document::with_version("1.5");
        let pages = doc.new_object_id();
        let content = doc.add_object(Stream::new(Dictionary::new(), Vec::new()));
        let mut page = dictionary! {
            "Type" => "Page", "Parent" => pages,
            "MediaBox" => media.iter().map(|v| Object::Integer(*v)).collect::<Vec<_>>(),
            "Contents" => content,
            "Rotate" => rotate,
        };
        if let Some(c) = crop {
            page.set(
                "CropBox",
                c.iter().map(|v| Object::Integer(*v)).collect::<Vec<_>>(),
            );
        }
        let page = doc.add_object(page);
        doc.set_object(
            pages,
            dictionary! { "Type" => "Pages", "Kids" => vec![page.into()], "Count" => 1 },
        );
        let catalog = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages });
        doc.trailer.set("Root", catalog);
        let mut out = Vec::new();
        doc.save_to(&mut out).unwrap();
        out
    }

    /// The bounding box of the dark pixels of page 0 rendered at one pixel per point: `(x0, y0, x1, y1)`, plus the page's text.
    fn render(pdfium: &Pdfium, bytes: &[u8]) -> (u32, u32, Option<[u32; 4]>, String) {
        let doc = pdfium.load_pdf_from_byte_slice(bytes, None).unwrap();
        let page = doc.pages().get(0).unwrap();
        let (w, h) = (page.width().value as i32, page.height().value as i32);
        // The characters, not `all()`: PDFium answers an empty string for text on a page turned by 270 degrees.
        let text: String = page
            .text()
            .map(|t| t.chars().iter().filter_map(|c| c.unicode_char()).collect())
            .unwrap_or_default();
        let bitmap = page
            .render_with_config(&PdfRenderConfig::new().set_target_size(w, h))
            .unwrap();
        let (bw, bh) = (bitmap.width() as u32, bitmap.height() as u32);
        let raw = bitmap.as_raw_bytes();
        let mut found: Option<[u32; 4]> = None;
        for y in 0..bh {
            for x in 0..bw {
                let i = ((y * bw + x) * 4) as usize;
                if raw[i] < 128 && raw[i + 1] < 128 && raw[i + 2] < 128 {
                    found = Some(match found {
                        None => [x, y, x, y],
                        Some([a, b, c, d]) => [a.min(x), b.min(y), c.max(x), d.max(y)],
                    });
                }
            }
        }
        (bw, bh, found, text)
    }

    fn header_only() -> HfSpec {
        HfSpec {
            slots: HfSlots {
                header_left: "Kopfzeile Größe".into(),
                ..HfSlots::default()
            },
            pages: HfPages::All,
            ..HfSpec::default()
        }
    }

    fn saved(media: [i64; 4], crop: Option<[i64; 4]>, rotate: i64) -> Vec<u8> {
        let bytes = page_pdf(media, crop, rotate);
        let doc = crate::pdfwrite::prescan::load_untrusted(&bytes).unwrap();
        let page = *doc.get_pages().get(&1).unwrap();
        let geom = page_geom(&doc, page);
        let s = header_only();
        let plan = HfWrite {
            spec: Some(s.clone()),
            pages: vec![(0, header_footer::resolve(&s, geom, 0, 1, "f"))],
        };
        apply(bytes, &plan).unwrap()
    }

    #[test]
    fn pdfium_shows_the_header_upright_at_the_displayed_top_left_on_every_rotation() {
        let Some(pdfium) = pdfium() else {
            eprintln!("PDFium library not available, skipping");
            return;
        };
        for rotate in [0, 90, 180, 270] {
            // a cropped page, so that the origin of the crop matters
            let bytes = saved([0, 0, 400, 500], Some([20, 30, 320, 430]), rotate);
            let (w, h, dark, text) = render(&pdfium, &bytes);
            let dark = dark.unwrap_or_else(|| panic!("nothing drawn at {rotate}"));
            assert!(text.contains("Kopfzeile Größe"), "{rotate}: {text:?}");
            // displayed size
            let (ew, eh) = if rotate % 180 == 90 {
                (400, 300)
            } else {
                (300, 400)
            };
            assert_eq!((w, h), (ew, eh), "{rotate}");
            // the header sits in the top band, from the left margin of 28 pt, and is wider than high (upright)
            assert!(dark[0] >= 26 && dark[0] <= 32, "{rotate}: left {dark:?}");
            assert!(
                dark[1] >= 26 && dark[3] <= 28 + 12,
                "{rotate}: top {dark:?}"
            );
            assert!(
                dark[2] - dark[0] > 3 * (dark[3] - dark[1]),
                "{rotate}: upright {dark:?}"
            );
        }
    }

    #[test]
    fn pdfium_finds_the_new_header_only_after_a_replace_and_nothing_after_a_removal() {
        let Some(pdfium) = pdfium() else {
            eprintln!("PDFium library not available, skipping");
            return;
        };
        let first = saved([0, 0, 612, 792], None, 0);
        let mut s2 = header_only();
        s2.slots.header_left = "Zweite Fassung".into();
        let plan = HfWrite {
            spec: Some(s2.clone()),
            pages: vec![(0, header_footer::resolve(&s2, geom_letter(), 0, 1, "f"))],
        };
        let second = apply(first, &plan).unwrap();
        let (_, _, _, text) = render(&pdfium, &second);
        assert!(text.contains("Zweite Fassung"), "{text:?}");
        assert!(!text.contains("Kopfzeile"), "no duplicate header: {text:?}");
        let removed = apply(
            second,
            &HfWrite {
                spec: None,
                pages: Vec::new(),
            },
        )
        .unwrap();
        let (_, _, dark, text) = render(&pdfium, &removed);
        assert!(dark.is_none() && text.trim().is_empty(), "{text:?}");
    }

    fn geom_letter() -> PageGeom {
        PageGeom {
            crop: [0.0, 0.0, 612.0, 792.0],
            rotate: 0,
        }
    }

    /// A letter page that already has a footer: `text` in bold Helvetica at `size` with its baseline at `origin` (page space, y down).
    fn footed_pdf(text: &str, origin: (f32, f32), size: f32) -> Vec<u8> {
        let mut doc = Document::with_version("1.5");
        let pages = doc.new_object_id();
        let font = doc.add_object(dictionary! {
            "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica-Bold", "Encoding" => "WinAnsiEncoding",
        });
        let ops = format!(
            "BT /F1 {size} Tf 1 0 0 1 {} {} Tm ({text}) Tj ET
",
            origin.0,
            792.0 - origin.1
        );
        let content = doc.add_object(Stream::new(Dictionary::new(), ops.into_bytes()));
        let page = doc.add_object(dictionary! {
            "Type" => "Page", "Parent" => pages,
            "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
            "Resources" => dictionary! { "Font" => dictionary! { "F1" => font } },
            "Contents" => content,
        });
        doc.set_object(
            pages,
            dictionary! { "Type" => "Pages", "Kids" => vec![page.into()], "Count" => 1 },
        );
        let catalog = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages });
        doc.trailer.set("Root", catalog);
        let mut out = Vec::new();
        doc.save_to(&mut out).unwrap();
        out
    }

    /// Page 0 at one pixel per point as tightly packed RGB rows (white paper).
    fn rgb(pdfium: &Pdfium, bytes: &[u8]) -> (Vec<u8>, u32, u32) {
        let doc = pdfium.load_pdf_from_byte_slice(bytes, None).unwrap();
        let page = doc.pages().get(0).unwrap();
        let (w, h) = (page.width().value as i32, page.height().value as i32);
        let bitmap = page
            .render_with_config(&PdfRenderConfig::new().set_target_size(w, h))
            .unwrap();
        let (bw, bh) = (bitmap.width() as u32, bitmap.height() as u32);
        let raw = bitmap.as_raw_bytes();
        let stride = raw.len() / bh as usize;
        let mut out = Vec::with_capacity((bw * bh * 3) as usize);
        for y in 0..bh as usize {
            for x in 0..bw as usize {
                // BGRA rows from PDFium
                let p = &raw[y * stride + x * 4..][..3];
                out.extend_from_slice(&[p[2], p[1], p[0]]);
            }
        }
        (out, bw, bh)
    }

    /// F21.7: the background box hides an existing footer at the same place completely. Inside the box the saved page looks exactly
    /// like the same layer on a blank page; the old footer, bolder and wider than the new text, had ink there before. The page colour
    /// is sampled from the original as the save does it (`sample_fill`), so a footer under the box cannot tint the box either.
    #[test]
    fn pdfium_shows_the_background_box_over_an_existing_footer() {
        let Some(pdfium) = pdfium() else {
            eprintln!("PDFium library not available, skipping");
            return;
        };
        let spec = HfSpec {
            slots: HfSlots {
                footer_right: "Seite {page} von {total}".into(),
                ..HfSlots::default()
            },
            pages: HfPages::All,
            background: true,
            ..HfSpec::default()
        };
        let runs = header_footer::resolve(&spec, geom_letter(), 0, 1, "f");
        let run = runs.first().unwrap().clone();
        // The old footer: bold, a little larger, starting where the new run starts and running past its end.
        let original = footed_pdf(
            "Alte Fusszeile 12 WWW",
            (run.origin.x, run.origin.y),
            run.size * 1.1,
        );
        let blank = footed_pdf("", (0.0, 0.0), 1.0);
        let (before, w, h) = rgb(&pdfium, &original);
        let raster = crate::pdfwrite::redact::RasterPage::from_rgb(before.clone(), w, h);
        let fill = crate::commands::hf_detect::sample_fill(
            &raster,
            612.0,
            792.0,
            header_footer::box_rect(&run, BACKGROUND_PAD),
        );
        assert_eq!(
            fill,
            Some(Rgb([255, 255, 255])),
            "the footer under the box does not tint it"
        );
        let sampled: Vec<PlacedRun> = runs
            .iter()
            .cloned()
            .map(|r| PlacedRun { fill, ..r })
            .collect();
        let plan = HfWrite {
            spec: Some(spec.clone()),
            pages: vec![(0, sampled)],
        };
        let (after, ..) = rgb(&pdfium, &apply(original, &plan).unwrap());
        let (reference, ..) = rgb(&pdfium, &apply(blank, &plan).unwrap());
        // The box in pixels, one pixel inside its edges (anti-aliasing).
        let b = header_footer::background_rect(&run);
        let (x0, y0, x1, y1) = (
            b[0].ceil() as u32 + 1,
            b[1].ceil() as u32 + 1,
            b[2].floor() as u32 - 1,
            b[3].floor() as u32 - 1,
        );
        let (mut inked, mut differ) = (0, 0);
        for y in y0..=y1.min(h - 1) {
            for x in x0..=x1.min(w - 1) {
                let at = ((y * w + x) * 3) as usize;
                if before[at] < 128 {
                    inked += 1;
                }
                if (0..3).any(|c| after[at + c].abs_diff(reference[at + c]) > 8) {
                    differ += 1;
                }
            }
        }
        assert!(inked > 50, "the old footer had ink under the box: {inked}");
        assert_eq!(differ, 0, "old footer pixels show through the box");
    }

    // The spike of ARCHITECTURE 16.2 (hiding an old header in the engine copy while an edit is pending) failed: pdfium-render 0.9.4 has
    // no public API for content marks (`FPDFPageObj_GetMark` is reachable only through the crate-private bindings accessor, and the
    // page object handle is private too), so the documented fallback applies: the engine shows the old layer until save, and the
    // overlay skips pages that have one.
}
#[cfg(test)]
mod fill_tests {
    use super::*;

    #[test]
    fn a_sampled_page_colour_fills_the_box_and_white_is_the_default() {
        let geom = PageGeom {
            crop: [0.0, 0.0, 200.0, 300.0],
            rotate: 0,
        };
        let run = |fill| PlacedRun {
            text: "ab".into(),
            origin: crate::model::geometry::Point { x: 20.0, y: 40.0 },
            angle: 0,
            size: 10.0,
            width: 30.0,
            fill,
        };
        let tinted = String::from_utf8(layer_stream(
            &geom,
            &[run(Some(Rgb([255, 0, 51])))],
            Rgb([0, 0, 0]),
            true,
        ))
        .unwrap();
        assert!(tinted.contains("1 0 0.2 rg\n17 254.75 m"), "{tinted}");
        let plain =
            String::from_utf8(layer_stream(&geom, &[run(None)], Rgb([0, 0, 0]), true)).unwrap();
        assert!(plain.contains("1 1 1 rg\n17 254.75 m"), "{plain}");
    }
}
