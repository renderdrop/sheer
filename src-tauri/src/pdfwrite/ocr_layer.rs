//! The invisible text layer of a scanned page (ADR-134 items 6, 7): per word a `3 Tr` hex string of the glyphless font, sized and
//! stretched (`Tf`, `Tz`) so that the font's character box is the recognized word's box, with an explicit space between two words.
//! The page's original `/Contents` is wrapped as `[q, original..., Q, layer]`, the resources get a page-local copy with the font, and
//! the result is an incremental update.

use std::collections::BTreeMap;

use lopdf::{dictionary, Dictionary, Document, IncrementalDocument, Object, ObjectId, Stream};

use super::ocr_font;
use crate::error::{AppError, ErrorCode};
use crate::ocr::OcrPageLayer;

/// The resource name of the font on a page.
pub const FONT_NAME: &str = "SheerOcr0";
/// The language-less text size below which a word is not written.
const MIN_SIZE: f32 = 0.5;
/// The narrowest a gap space is made (points), so its `Tz` stays above zero.
const MIN_GAP: f32 = 0.1;

/// Where a page is in user space: its crop box `[x0, y0, x1, y1]` and its `/Rotate` (0, 90, 180, 270).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PageGeom {
    pub crop: [f32; 4],
    pub rotate: u16,
}

impl PageGeom {
    /// The size of the unrotated page (the crop box).
    pub fn size(&self) -> (f32, f32) {
        (self.crop[2] - self.crop[0], self.crop[3] - self.crop[1])
    }

    /// The size of the page as it is shown.
    pub fn display_size(&self) -> (f32, f32) {
        let (w, h) = self.size();
        if self.rotate % 180 == 90 {
            (h, w)
        } else {
            (w, h)
        }
    }

    /// A point of the displayed page (points from the top left, y down) in user space.
    pub fn display_to_user(&self, dx: f32, dy: f32) -> (f32, f32) {
        let (w, h) = self.size();
        let [x0, y0, ..] = self.crop;
        match self.rotate % 360 {
            90 => (x0 + dy, y0 + dx),
            180 => (x0 + w - dx, y0 + dy),
            270 => (x0 + w - dy, y0 + h - dx),
            _ => (x0 + dx, y0 + h - dy),
        }
    }

    /// A point of the displayed page in the page space of the engine (ADR-003: top left of the unrotated crop box, y down).
    pub fn display_to_page(&self, dx: f32, dy: f32) -> (f32, f32) {
        let (ux, uy) = self.display_to_user(dx, dy);
        (ux - self.crop[0], self.crop[3] - uy)
    }

    /// The directions of the displayed x axis and of "up" in user space; they make the rows of the text matrix.
    pub fn axes(&self) -> ([f32; 2], [f32; 2]) {
        match self.rotate % 360 {
            90 => ([0.0, 1.0], [-1.0, 0.0]),
            180 => ([-1.0, 0.0], [0.0, -1.0]),
            270 => ([0.0, -1.0], [1.0, 0.0]),
            _ => ([1.0, 0.0], [0.0, 1.0]),
        }
    }
}

fn num(v: f32) -> String {
    if !v.is_finite() {
        return "0".into();
    }
    let s = format!("{v:.3}");
    let s = s.trim_end_matches('0').trim_end_matches('.');
    if s.is_empty() || s == "-" || s == "-0" {
        "0".into()
    } else {
        s.to_owned()
    }
}

/// UTF-16BE hex of `text`; a code point outside the BMP is U+FFFD (ADR-134 item 6).
pub fn hex_codes(text: &str) -> String {
    let mut out = String::with_capacity(text.len() * 4 + 2);
    out.push('<');
    for c in text.chars() {
        let unit = u16::try_from(u32::from(c)).unwrap_or(0xFFFD);
        out.push_str(&format!("{unit:04X}"));
    }
    out.push('>');
    out
}

/// The `Tz` (percent) that stretches `chars` glyphs of size `size` to `width` points.
pub fn horizontal_scale(width: f32, size: f32, chars: usize) -> f32 {
    100.0 * width / (0.5 * size * chars.max(1) as f32)
}

/// One `Tf`, `Tz`, `Tm`, `Tj` group: `text` at the displayed position (`dx`, `baseline_dy`), `size` high, `width` wide.
fn show(
    out: &mut String,
    geom: &PageGeom,
    text: &str,
    dx: f32,
    baseline_dy: f32,
    size: f32,
    width: f32,
) {
    let chars = text.chars().count();
    let (e, f) = geom.display_to_user(dx, baseline_dy);
    let (x, up) = geom.axes();
    out.push_str(&format!(
        "/{FONT_NAME} {} Tf {} Tz {} {} {} {} {} {} Tm {} Tj\n",
        num(size),
        num(horizontal_scale(width, size, chars)),
        num(x[0]),
        num(x[1]),
        num(up[0]),
        num(up[1]),
        num(e),
        num(f),
        hex_codes(text)
    ));
}

/// A word shorter than this share of its line's median height (a hyphen, a dot, a quote) takes the line's size and baseline: with a
/// size and baseline of its own, PDFium sees the line jump and breaks it there (measured on the corpus).
const SHORT_WORD: f32 = 0.5;

fn median(mut values: Vec<f32>) -> f32 {
    values.sort_by(f32::total_cmp);
    values.get(values.len() / 2).copied().unwrap_or(0.0)
}

/// The content of the layer for one page: every word, a space between the words of a line. A word is sized to its own box (so the
/// selection of the word is its box) unless it is much shorter than the line (see [`SHORT_WORD`]); the spaces use the line's size.
pub fn layer_stream(geom: &PageGeom, layer: &OcrPageLayer) -> Vec<u8> {
    let mut out = String::from("q\nBT\n3 Tr\n");
    for line in &layer.lines {
        let line_size = median(
            line.words
                .iter()
                .map(|w| (w.rect[3] - w.rect[1]).max(MIN_SIZE))
                .collect(),
        );
        let line_bottom = median(line.words.iter().map(|w| w.rect[3]).collect());
        let line_baseline = line_bottom - 0.2 * line_size;
        let mut right: Option<f32> = None; // right edge of the word before
        for word in &line.words {
            let [x0, y0, x1, y1] = word.rect;
            let height = (y1 - y0).max(MIN_SIZE);
            let (size, baseline) = if height >= SHORT_WORD * line_size {
                (height, y1 - 0.2 * height)
            } else {
                (line_size, line_baseline)
            };
            if let Some(right) = right {
                let gap = (x0 - right).max(MIN_GAP);
                show(&mut out, geom, " ", right, line_baseline, line_size, gap);
            }
            show(
                &mut out,
                geom,
                &word.text,
                x0,
                baseline,
                size,
                (x1 - x0).max(MIN_GAP),
            );
            right = Some(x1);
        }
    }
    out.push_str("ET\nQ\n");
    out.into_bytes()
}

// --- Document writing ---------------------------------------------------------------------------------------------

fn damaged(what: &str) -> AppError {
    AppError::logged(ErrorCode::DamagedFile, format!("ocr layer: {what}"))
}

fn inherited<'a>(doc: &'a Document, page: ObjectId, key: &[u8]) -> Option<&'a Object> {
    let mut id = page;
    for _ in 0..64 {
        let dict = doc.get_dictionary(id).ok()?;
        if let Ok(value) = dict.get(key) {
            return doc.dereference(value).ok().map(|(_, v)| v);
        }
        id = dict.get(b"Parent").ok()?.as_reference().ok()?;
    }
    None
}

fn read_box(doc: &Document, object: &Object) -> Option<[f32; 4]> {
    let array = object.as_array().ok()?;
    if array.len() != 4 {
        return None;
    }
    let mut v = [0.0f32; 4];
    for (slot, item) in v.iter_mut().zip(array) {
        let n = doc.dereference(item).ok()?.1.as_float().ok()?;
        if !n.is_finite() {
            return None;
        }
        *slot = n;
    }
    let r = [
        v[0].min(v[2]),
        v[1].min(v[3]),
        v[0].max(v[2]),
        v[1].max(v[3]),
    ];
    (r[2] > r[0] && r[3] > r[1]).then_some(r)
}

/// The crop box inside the media box and the `/Rotate` of `page`.
pub fn page_geom(doc: &Document, page: ObjectId) -> PageGeom {
    let media = inherited(doc, page, b"MediaBox")
        .and_then(|o| read_box(doc, o))
        .unwrap_or([0.0, 0.0, 612.0, 792.0]);
    let crop = inherited(doc, page, b"CropBox")
        .and_then(|o| read_box(doc, o))
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
        .map_or(0, |r| r.rem_euclid(360) as u16);
    PageGeom {
        crop,
        rotate: rotate - rotate % 90,
    }
}

/// The page's `/Contents` as a list of references.
fn content_refs(doc: &Document, page: &Dictionary) -> Vec<Object> {
    let Ok(contents) = page.get(b"Contents") else {
        return Vec::new();
    };
    match contents {
        Object::Reference(id) => match doc.get_object(*id) {
            Ok(Object::Array(items)) => items.clone(),
            _ => vec![Object::Reference(*id)],
        },
        Object::Array(items) => items.clone(),
        _ => Vec::new(),
    }
}

/// A page-local copy of the resources with the OCR font added (the inherited or shared dictionary stays as it is).
fn resources_with_font(doc: &Document, page: ObjectId, font: ObjectId) -> Dictionary {
    let mut resources = inherited(doc, page, b"Resources")
        .and_then(|o| o.as_dict().ok())
        .cloned()
        .unwrap_or_default();
    let mut fonts = resources
        .get(b"Font")
        .ok()
        .and_then(|o| doc.dereference(o).ok())
        .and_then(|(_, o)| o.as_dict().ok())
        .cloned()
        .unwrap_or_default();
    fonts.set(FONT_NAME, Object::Reference(font));
    resources.set("Font", Object::Dictionary(fonts));
    resources
}

/// Writes `layers` (page object, layer) into `inc`: one font set, and per page the wrapped contents, the page-local resources and the
/// `/SheerOcr` key. Pages without a word are left alone.
pub fn write_ocr_layers(
    inc: &mut IncrementalDocument,
    layers: &[(ObjectId, &OcrPageLayer)],
    boxed: bool,
) -> Result<(), AppError> {
    if layers.iter().all(|(_, l)| l.lines.is_empty()) {
        return Ok(());
    }
    let font = ocr_font::add_font(&mut inc.new_document, boxed)?;
    let open = inc
        .new_document
        .add_object(Stream::new(Dictionary::new(), b"q\n".to_vec()));
    let close = inc
        .new_document
        .add_object(Stream::new(Dictionary::new(), b"Q\n".to_vec()));
    for (page, layer) in layers {
        if layer.lines.is_empty() {
            continue;
        }
        let prev = inc.get_prev_documents();
        let mut dict = prev
            .get_dictionary(*page)
            .map_err(|_| damaged("page"))?
            .clone();
        let geom = page_geom(prev, *page);
        let mut contents = vec![Object::Reference(open)];
        contents.extend(content_refs(prev, &dict));
        contents.push(Object::Reference(close));
        let resources = resources_with_font(prev, *page, font);
        let stream = layer_stream(&geom, layer);
        let stream = inc
            .new_document
            .add_object(Stream::new(Dictionary::new(), stream));
        contents.push(Object::Reference(stream));
        dict.set("Contents", Object::Array(contents));
        dict.set("Resources", Object::Dictionary(resources));
        dict.set(
            "SheerOcr",
            Object::Dictionary(dictionary! {
                "V" => 1,
                "S" => stream,
                "Lang" => Object::string_literal(layer.lang.as_str()),
            }),
        );
        inc.new_document.set_object(*page, Object::Dictionary(dict));
    }
    Ok(())
}

/// [`write_ocr_layers`] on top of `original` (not encrypted): the original bytes stay as a prefix. `layers` is keyed by page index
/// (file order, from 0).
pub fn apply_ocr_layers(
    original: Vec<u8>,
    layers: &BTreeMap<u32, OcrPageLayer>,
    boxed: bool,
) -> Result<Vec<u8>, AppError> {
    let doc = super::load_untrusted(&original)?;
    if doc.is_encrypted() {
        return Err(AppError::new(ErrorCode::UnsupportedFeature));
    }
    let pages = doc.get_pages();
    let mut chosen = Vec::new();
    for (index, layer) in layers {
        let id = pages
            .get(&index.saturating_add(1))
            .copied()
            .ok_or_else(|| damaged("page index"))?;
        chosen.push((id, layer));
    }
    let mut inc = IncrementalDocument::create_from(original, doc);
    write_ocr_layers(&mut inc, &chosen, boxed)?;
    let mut out = Vec::new();
    inc.save_to(&mut out)
        .map_err(|e| AppError::logged(ErrorCode::Internal, format!("save: {e}")))?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ocr::{OcrLine, OcrWord};

    fn geom(rotate: u16) -> PageGeom {
        PageGeom {
            crop: [10.0, 20.0, 110.0, 220.0], // 100 x 200
            rotate,
        }
    }

    #[test]
    fn the_four_corners_of_a_rotated_page_map_to_user_space() {
        let g = geom(0);
        assert_eq!(g.display_to_user(0.0, 0.0), (10.0, 220.0));
        assert_eq!(g.display_to_user(100.0, 200.0), (110.0, 20.0));
        // 90: the displayed top left is the user bottom left; the page is shown 200 wide
        let g = geom(90);
        assert_eq!(g.display_size(), (200.0, 100.0));
        assert_eq!(g.display_to_user(0.0, 0.0), (10.0, 20.0));
        assert_eq!(g.display_to_user(200.0, 0.0), (10.0, 220.0));
        assert_eq!(g.display_to_user(0.0, 100.0), (110.0, 20.0));
        let g = geom(180);
        assert_eq!(g.display_to_user(0.0, 0.0), (110.0, 20.0));
        let g = geom(270);
        assert_eq!(g.display_to_user(0.0, 0.0), (110.0, 220.0));
        assert_eq!(g.display_to_user(200.0, 100.0), (10.0, 20.0));
    }

    #[test]
    fn the_text_axes_follow_the_displayed_axes() {
        for rotate in [0, 90, 180, 270] {
            let g = geom(rotate);
            let (x, up) = g.axes();
            let o = g.display_to_user(0.0, 0.0);
            let right = g.display_to_user(1.0, 0.0);
            let above = g.display_to_user(0.0, -1.0);
            assert_eq!([right.0 - o.0, right.1 - o.1], x, "x at {rotate}");
            assert_eq!([above.0 - o.0, above.1 - o.1], up, "up at {rotate}");
        }
    }

    #[test]
    fn page_space_is_the_unrotated_top_left_view() {
        let g = geom(0);
        assert_eq!(g.display_to_page(5.0, 7.0), (5.0, 7.0));
        let g = geom(90);
        // displayed (dx, dy) is page space (dy, h - dx) with h = 200
        assert_eq!(g.display_to_page(30.0, 7.0), (7.0, 170.0));
    }

    #[test]
    fn a_word_is_sized_stretched_and_placed_on_its_baseline() {
        let g = geom(0);
        let layer = OcrPageLayer {
            lang: "de-DE".into(),
            lines: vec![OcrLine {
                words: vec![
                    OcrWord {
                        text: "Ab".into(),
                        rect: [20.0, 40.0, 40.0, 50.0],
                    },
                    OcrWord {
                        text: "c".into(),
                        rect: [44.0, 40.0, 50.0, 50.0],
                    },
                ],
            }],
            ..OcrPageLayer::default()
        };
        let text = String::from_utf8(layer_stream(&g, &layer)).unwrap();
        // size 10, Tz = 100 * 20 / (0.5 * 10 * 2) = 200, baseline y = 50 - 2 = 48 from the top = 220 - 48 = 172 in user space
        assert!(
            text.contains("/SheerOcr0 10 Tf 200 Tz 1 0 0 1 30 172 Tm <00410062> Tj"),
            "{text}"
        );
        // the space spans the gap of 4 points: Tz = 100 * 4 / (0.5 * 10) = 80, at the right edge of "Ab"
        assert!(
            text.contains("/SheerOcr0 10 Tf 80 Tz 1 0 0 1 50 172 Tm <0020> Tj"),
            "{text}"
        );
        assert!(text.starts_with("q\nBT\n3 Tr\n") && text.ends_with("ET\nQ\n"));
    }

    #[test]
    fn code_points_outside_the_bmp_become_the_replacement_character() {
        assert_eq!(hex_codes("a\u{1F600}ä"), "<0061FFFD00E4>");
        assert_eq!(num(1.0 / 3.0), "0.333");
        assert_eq!(num(-0.0001), "0");
        assert_eq!(num(f32::NAN), "0");
    }

    /// A one-page file with one text content stream and an unbalanced `q`, as a hostile original could have.
    fn small_pdf() -> Vec<u8> {
        let mut doc = Document::with_version("1.5");
        let pages = doc.new_object_id();
        let content = doc.add_object(Stream::new(
            Dictionary::new(),
            b"q 2 0 0 2 0 0 cm\n".to_vec(),
        ));
        let page = doc.add_object(dictionary! {
            "Type" => "Page", "Parent" => pages,
            "MediaBox" => vec![0.into(), 0.into(), 100.into(), 200.into()],
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

    #[test]
    fn the_layer_is_appended_incrementally_and_wraps_the_original_contents() {
        let original = small_pdf();
        let layer = OcrPageLayer {
            lang: "de-DE".into(),
            lines: vec![OcrLine {
                words: vec![OcrWord {
                    text: "Hi".into(),
                    rect: [1.0, 1.0, 21.0, 11.0],
                }],
            }],
            ..OcrPageLayer::default()
        };
        let layers = BTreeMap::from([(0u32, layer)]);
        let saved = apply_ocr_layers(original.clone(), &layers, false).unwrap();
        assert_eq!(
            &saved[..original.len()],
            &original[..],
            "original bytes are a prefix"
        );
        let doc = crate::pdfwrite::load_untrusted(&saved).unwrap();
        let page = *doc.get_pages().get(&1).unwrap();
        let dict = doc.get_dictionary(page).unwrap();
        let contents = dict.get(b"Contents").unwrap().as_array().unwrap();
        assert_eq!(contents.len(), 4, "[q, original, Q, layer]");
        assert!(dict.get(b"SheerOcr").is_ok());
        let resources = dict.get(b"Resources").unwrap().as_dict().unwrap();
        assert!(resources
            .get(b"Font")
            .unwrap()
            .as_dict()
            .unwrap()
            .has(FONT_NAME.as_bytes()));
        let text = doc.get_page_content(page);
        let text = String::from_utf8_lossy(&text);
        assert!(text.contains("3 Tr") && text.contains("<00480069> Tj"));
    }

    #[test]
    fn a_page_without_words_changes_nothing() {
        let original = small_pdf();
        let layers = BTreeMap::from([(0u32, OcrPageLayer::default())]);
        let saved = apply_ocr_layers(original.clone(), &layers, false).unwrap();
        assert_eq!(&saved[..original.len()], &original[..]);
        assert!(!String::from_utf8_lossy(&saved).contains("SheerOcr"));
    }

    #[test]
    fn a_page_index_the_file_lacks_is_refused() {
        let layers = BTreeMap::from([(5u32, OcrPageLayer::default())]);
        assert!(apply_ocr_layers(small_pdf(), &layers, false).is_err());
    }
}
