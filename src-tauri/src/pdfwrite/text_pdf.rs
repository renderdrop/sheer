//! "Save as text PDF" (F19.22, ADR-143), part 2: the blocks of `export::text_flow` set as a new A4 document, written with lopdf.
//! Real, selectable text in subsets of a bundled face (Inter by default, Tinos as the serif choice; Regular and Bold), Type0/Identity-H
//! with a `ToUnicode` map (`text_fonts::add_embedded_font`), so the text is searchable and copies as it was recognized. Lines are broken
//! with the face's real advance widths, left aligned. A character the face lacks becomes `?` and is reported.
//!
//! With "keep original image" every source page's text starts on a new sheet and the page itself follows it as a picture (JPEG of
//! the rendered page) on a sheet of the page's own size; without, the text of all pages flows on.

use std::collections::{BTreeSet, HashMap};
use std::io::Write as _;

use lopdf::{Dictionary, Document, Object, ObjectId, Stream, StringFormat};
use serde::Deserialize;

use super::annots::text_string;
use super::text_fonts::add_embedded_font;
use crate::error::{AppError, ErrorCode};
use crate::export::text_flow::{Block, BlockKind};
use crate::fontprog::fallback::{self, Face};
use crate::limits;
use crate::model::text_edit::FallbackFace;

/// The face of the text.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TextPdfFont {
    Inter,
    Tinos,
}

/// One of the four faces the export draws with.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
struct TextFace {
    serif: bool,
    bold: bool,
}

impl TextFace {
    fn of(font: TextPdfFont, bold: bool) -> Self {
        Self {
            serif: font == TextPdfFont::Tinos,
            bold,
        }
    }

    fn tinos(self) -> Face {
        Face {
            family: FallbackFace::Serif,
            bold: self.bold,
            italic: false,
        }
    }

    /// The bundled TrueType file: Inter 4.1 static instances (OFL-1.1, `resources/fonts/`, `docs/LICENSES.md`) or Tinos.
    fn data(self) -> &'static [u8] {
        match (self.serif, self.bold) {
            (false, false) => include_bytes!("../../resources/fonts/Inter-Regular.ttf"),
            (false, true) => include_bytes!("../../resources/fonts/Inter-Bold.ttf"),
            (true, _) => self.tinos().data(),
        }
    }

    fn base_font(self) -> &'static str {
        match (self.serif, self.bold) {
            (false, false) => "Inter-Regular",
            (false, true) => "Inter-Bold",
            (true, _) => self.tinos().base_font(),
        }
    }
}

/// A rendered source page kept as a picture: baseline JPEG bytes, its pixel size, whether it is grey, and the sheet size in points.
#[derive(Debug, Clone, PartialEq)]
pub struct PageImage {
    pub jpeg: Vec<u8>,
    pub width_px: u32,
    pub height_px: u32,
    pub grey: bool,
    pub size_pt: [f32; 2],
}

/// The blocks of one source page and, with "keep original image", the page as a picture.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Section {
    pub blocks: Vec<Block>,
    pub image: Option<PageImage>,
}

/// What the document is built from.
#[derive(Debug)]
pub struct TextPdfInput<'a> {
    pub sections: &'a mut [Section],
    pub font: TextPdfFont,
    /// Each section on new sheets, its picture after it.
    pub keep_images: bool,
    /// The document's name for `/Title`.
    pub title: &'a str,
    /// A BCP 47 tag for the catalog's `/Lang` (from the recognizer), if one is known.
    pub lang: Option<&'a str>,
    pub producer: &'a str,
}

/// The finished document.
#[derive(Debug)]
pub struct TextPdf {
    pub bytes: Vec<u8>,
    pub pages: usize,
    /// A character was drawn as `?` because the face lacks it.
    pub glyphs_replaced: bool,
}

/// A4 in points.
const PAGE: [f32; 2] = [595.0, 842.0];
const MARGIN_X: f32 = 64.0;
const MARGIN_Y: f32 = 72.0;

/// Size, leading, space above, space below and weight of each kind.
#[derive(Debug, Clone, Copy)]
struct Style {
    size: f32,
    leading: f32,
    before: f32,
    after: f32,
    bold: bool,
}

fn style(kind: BlockKind) -> Style {
    let (size, leading, before, after, bold) = match kind {
        BlockKind::Heading(1) => (20.0, 26.0, 18.0, 8.0, true),
        BlockKind::Heading(2) => (16.0, 21.0, 14.0, 6.0, true),
        BlockKind::Heading(_) => (13.0, 18.0, 12.0, 4.0, true),
        BlockKind::Body => (11.0, 15.5, 0.0, 7.0, false),
        BlockKind::Small => (9.0, 12.5, 0.0, 5.0, false),
    };
    Style {
        size,
        leading,
        before,
        after,
        bold,
    }
}

/// Advance widths (1/1000 em) and the characters each face draws.
struct Metrics {
    font: TextPdfFont,
    widths: HashMap<(TextFace, char), Option<f32>>,
    used: HashMap<TextFace, BTreeSet<char>>,
    replaced: bool,
}

impl Metrics {
    fn new(font: TextPdfFont) -> Self {
        Self {
            font,
            widths: HashMap::new(),
            used: HashMap::new(),
            replaced: false,
        }
    }

    fn glyph(&mut self, face: TextFace, c: char) -> Option<f32> {
        *self.widths.entry((face, c)).or_insert_with(|| {
            let data = face.data();
            let blank = c == ' ';
            (blank || fallback::has_char_in(data, c))
                .then(|| fallback::advance_in(data, c))
                .flatten()
        })
    }

    /// `text` with the characters the face lacks as `?`.
    fn prepare(&mut self, face: TextFace, text: &str) -> String {
        text.chars()
            .map(|c| {
                if self.glyph(face, c).is_some() {
                    c
                } else {
                    self.replaced = true;
                    '?'
                }
            })
            .collect()
    }

    fn width(&mut self, face: TextFace, size: f32, text: &str) -> f32 {
        text.chars()
            .map(|c| self.glyph(face, c).unwrap_or(0.0))
            .sum::<f32>()
            * size
            / 1000.0
    }

    fn note(&mut self, face: TextFace, text: &str) {
        self.used.entry(face).or_default().extend(text.chars());
    }

    /// Greedy word wrap of prepared `text` at `max` points; a word wider than the line is broken anywhere.
    fn wrap(&mut self, face: TextFace, size: f32, text: &str, max: f32) -> Vec<String> {
        let space = self.width(face, size, " ");
        let mut lines: Vec<String> = Vec::new();
        let mut line = String::new();
        let mut used = 0.0f32;
        for word in text.split(' ').filter(|w| !w.is_empty()) {
            let w = self.width(face, size, word);
            let needed = if line.is_empty() { w } else { used + space + w };
            if needed <= max {
                if !line.is_empty() {
                    line.push(' ');
                }
                line.push_str(word);
                used = needed;
                continue;
            }
            if !line.is_empty() {
                lines.push(std::mem::take(&mut line));
            }
            used = 0.0;
            if w <= max {
                line.push_str(word);
                used = w;
                continue;
            }
            for c in word.chars() {
                let cw = self.glyph(face, c).unwrap_or(0.0) * size / 1000.0;
                if used + cw > max && !line.is_empty() {
                    lines.push(std::mem::take(&mut line));
                    used = 0.0;
                }
                line.push(c);
                used += cw;
            }
        }
        if !line.is_empty() {
            lines.push(line);
        }
        lines
    }
}

/// A line of text at a baseline (user space).
#[derive(Debug, Clone)]
struct TextOp {
    face: TextFace,
    size: f32,
    x: f32,
    y: f32,
    text: String,
}

#[derive(Debug, Clone)]
enum Sheet {
    Text(Vec<TextOp>),
    /// The index of the section whose picture this is.
    Image(usize),
}

struct Layout {
    metrics: Metrics,
    sheets: Vec<Sheet>,
    /// From the top edge, on the last text sheet.
    y: f32,
    /// Space still owed below the last block placed (not carried to a new sheet).
    pending_after: f32,
    open: bool,
}

impl Layout {
    fn new_sheet(&mut self) -> Result<(), AppError> {
        if self.sheets.len() >= limits::TEXT_PDF_PAGES_MAX {
            return Err(AppError::limit(
                "textPdf",
                limits::TEXT_PDF_PAGES_MAX as u64,
            ));
        }
        self.sheets.push(Sheet::Text(Vec::new()));
        self.y = MARGIN_Y;
        self.pending_after = 0.0;
        self.open = true;
        Ok(())
    }

    fn at_top(&self) -> bool {
        self.y <= MARGIN_Y + 0.01
    }

    fn room(&self, needed: f32) -> bool {
        self.y + needed <= PAGE[1] - MARGIN_Y + 0.01
    }

    /// Places a block; a heading keeps the first two lines of what follows (`next_leading`) on its sheet.
    fn place(&mut self, block: &Block, next_leading: Option<f32>) -> Result<(), AppError> {
        let st = style(block.kind);
        let face = TextFace::of(self.metrics.font, st.bold);
        let text = self.metrics.prepare(face, &block.text);
        let lines = self
            .metrics
            .wrap(face, st.size, &text, PAGE[0] - 2.0 * MARGIN_X);
        if lines.is_empty() {
            return Ok(());
        }
        if !self.open {
            self.new_sheet()?;
        }
        let gap = |layout: &Self| {
            if layout.at_top() {
                0.0
            } else {
                layout.pending_after.max(st.before)
            }
        };
        let keep = match block.kind {
            BlockKind::Heading(_) => {
                lines.len() as f32 * st.leading + next_leading.map_or(0.0, |l| 2.0 * l)
            }
            _ => st.leading * lines.len().min(2) as f32,
        };
        if !self.room(gap(self) + keep) && !self.at_top() {
            self.new_sheet()?;
        }
        self.y += gap(self);
        for line in lines {
            if !self.room(st.leading) && !self.at_top() {
                self.new_sheet()?;
            }
            let baseline = self.y + (st.leading - st.size) / 2.0 + st.size * 0.8;
            self.metrics.note(face, &line);
            if let Some(Sheet::Text(ops)) = self.sheets.last_mut() {
                ops.push(TextOp {
                    face,
                    size: st.size,
                    x: MARGIN_X,
                    y: PAGE[1] - baseline,
                    text: line,
                });
            }
            self.y += st.leading;
        }
        self.pending_after = st.after;
        Ok(())
    }

    fn place_blocks(&mut self, blocks: &[Block]) -> Result<(), AppError> {
        for (at, block) in blocks.iter().enumerate() {
            let next = blocks.get(at + 1).map(|b| style(b.kind).leading);
            self.place(block, next)?;
        }
        Ok(())
    }

    fn image(&mut self, section: usize) -> Result<(), AppError> {
        if self.sheets.len() >= limits::TEXT_PDF_PAGES_MAX {
            return Err(AppError::limit(
                "textPdf",
                limits::TEXT_PDF_PAGES_MAX as u64,
            ));
        }
        self.sheets.push(Sheet::Image(section));
        self.open = false;
        Ok(())
    }
}

fn flate(bytes: &[u8]) -> Result<Stream, AppError> {
    let mut encoder = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
    encoder
        .write_all(bytes)
        .map_err(|_| AppError::new(ErrorCode::Internal))?;
    let packed = encoder
        .finish()
        .map_err(|_| AppError::new(ErrorCode::Internal))?;
    let mut dict = Dictionary::new();
    dict.set("Filter", Object::Name(b"FlateDecode".to_vec()));
    Ok(Stream::new(dict, packed))
}

fn fresh_id() -> Result<Object, AppError> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes)
        .map_err(|error| AppError::logged(ErrorCode::Internal, format!("random: {error}")))?;
    let (first, second) = bytes.split_at(16);
    Ok(Object::Array(vec![
        Object::String(first.to_vec(), StringFormat::Hexadecimal),
        Object::String(second.to_vec(), StringFormat::Hexadecimal),
    ]))
}

/// A language tag fit for `/Lang`: letters, digits and `-`, at most 35 characters.
fn clean_lang(lang: &str) -> Option<&str> {
    let ok = !lang.is_empty()
        && lang.len() <= 35
        && lang.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-');
    ok.then_some(lang)
}

fn media_box(size: [f32; 2]) -> Object {
    Object::Array(vec![
        0.into(),
        0.into(),
        Object::Real(size[0]),
        Object::Real(size[1]),
    ])
}

/// Builds the document. `progress(done, total)` is called per section and may stop the build with its error (a cancelled job).
pub fn build(
    input: &mut TextPdfInput<'_>,
    progress: &mut dyn FnMut(usize, usize) -> Result<(), AppError>,
) -> Result<TextPdf, AppError> {
    let mut layout = Layout {
        metrics: Metrics::new(input.font),
        sheets: Vec::new(),
        y: MARGIN_Y,
        pending_after: 0.0,
        open: false,
    };
    let total = input.sections.len();
    for (at, section) in input.sections.iter().enumerate() {
        progress(at, total)?;
        if input.keep_images {
            layout.open = false;
        }
        layout.place_blocks(&section.blocks)?;
        if input.keep_images && section.image.is_some() {
            layout.image(at)?;
        }
    }
    progress(total, total)?;
    if layout.sheets.is_empty() {
        return Err(AppError::invalid("textPdf"));
    }
    write_document(input, &layout)
}

fn write_document(input: &mut TextPdfInput<'_>, layout: &Layout) -> Result<TextPdf, AppError> {
    let mut doc = Document::with_version("1.7");
    let tree = doc.new_object_id();

    let mut fonts: Vec<(TextFace, String, ObjectId, HashMap<char, u16>)> = Vec::new();
    for bold in [false, true] {
        let face = TextFace::of(input.font, bold);
        let Some(chars) = layout.metrics.used.get(&face).filter(|set| !set.is_empty()) else {
            continue;
        };
        let subset = fallback::subset_font(face.data(), chars)?;
        let numbers =
            fallback::descriptor_of(face.data()).ok_or(AppError::invalid("fontProgram"))?;
        let id = add_embedded_font(&mut doc, face.base_font(), bold, numbers, &subset)?;
        let codes: HashMap<char, u16> = subset.gids.iter().copied().collect();
        fonts.push((face, format!("F{}", fonts.len() + 1), id, codes));
    }
    let mut font_dict = Dictionary::new();
    for (_, name, id, _) in &fonts {
        font_dict.set(name.as_str(), Object::Reference(*id));
    }
    let mut text_resources = Dictionary::new();
    text_resources.set("Font", Object::Dictionary(font_dict));
    let text_resources = doc.add_object(Object::Dictionary(text_resources));

    let mut kids = Vec::with_capacity(layout.sheets.len());
    for sheet in &layout.sheets {
        let (content, resources, size) = match sheet {
            Sheet::Text(ops) => {
                let mut content = String::from("0 g\n");
                for op in ops {
                    let Some((_, name, _, codes)) = fonts.iter().find(|(f, ..)| *f == op.face)
                    else {
                        continue;
                    };
                    let hex: String = op
                        .text
                        .chars()
                        .map(|c| format!("{:04X}", codes.get(&c).copied().unwrap_or(0)))
                        .collect();
                    if hex.is_empty() {
                        continue;
                    }
                    content.push_str(&format!(
                        "BT /{name} {:.2} Tf {:.2} {:.2} Td <{hex}> Tj ET\n",
                        op.size, op.x, op.y
                    ));
                }
                (content, Object::Reference(text_resources), PAGE)
            }
            Sheet::Image(section) => {
                let Some(image) = input
                    .sections
                    .get_mut(*section)
                    .and_then(|s| s.image.as_mut())
                else {
                    return Err(AppError::new(ErrorCode::Internal));
                };
                let [w, h] = limits::sanitize_page_size(image.size_pt[0], image.size_pt[1]);
                let mut dict = Dictionary::new();
                dict.set("Type", Object::Name(b"XObject".to_vec()));
                dict.set("Subtype", Object::Name(b"Image".to_vec()));
                dict.set("Width", i64::from(image.width_px));
                dict.set("Height", i64::from(image.height_px));
                let space: &[u8] = if image.grey {
                    b"DeviceGray"
                } else {
                    b"DeviceRGB"
                };
                dict.set("ColorSpace", Object::Name(space.to_vec()));
                dict.set("BitsPerComponent", 8);
                dict.set("Filter", Object::Name(b"DCTDecode".to_vec()));
                let xobject = doc.add_object(Stream::new(dict, std::mem::take(&mut image.jpeg)));
                let mut images = Dictionary::new();
                images.set("Im1", Object::Reference(xobject));
                let mut resources = Dictionary::new();
                resources.set("XObject", Object::Dictionary(images));
                (
                    format!("q {w:.2} 0 0 {h:.2} 0 0 cm /Im1 Do Q\n"),
                    Object::Dictionary(resources),
                    [w, h],
                )
            }
        };
        let stream = doc.add_object(flate(content.as_bytes())?);
        let mut page = Dictionary::new();
        page.set("Type", Object::Name(b"Page".to_vec()));
        page.set("Parent", Object::Reference(tree));
        page.set("MediaBox", media_box(size));
        page.set("Resources", resources);
        page.set("Contents", Object::Reference(stream));
        kids.push(Object::Reference(doc.add_object(Object::Dictionary(page))));
    }
    let count = kids.len();
    let mut tree_dict = Dictionary::new();
    tree_dict.set("Type", Object::Name(b"Pages".to_vec()));
    tree_dict.set("Count", i64::try_from(count).unwrap_or(0));
    tree_dict.set("Kids", Object::Array(kids));
    doc.objects.insert(tree, Object::Dictionary(tree_dict));

    let mut catalog = Dictionary::new();
    catalog.set("Type", Object::Name(b"Catalog".to_vec()));
    catalog.set("Pages", Object::Reference(tree));
    if let Some(lang) = input.lang.and_then(clean_lang) {
        catalog.set("Lang", Object::string_literal(lang));
    }
    let root = doc.add_object(Object::Dictionary(catalog));
    doc.trailer.set("Root", Object::Reference(root));
    let mut info = Dictionary::new();
    info.set(
        "Producer",
        Object::string_literal(input.producer.as_bytes().to_vec()),
    );
    let title: String = input.title.chars().take(300).collect();
    if !title.trim().is_empty() {
        info.set("Title", text_string(&title));
    }
    let info = doc.add_object(Object::Dictionary(info));
    doc.trailer.set("Info", Object::Reference(info));
    doc.trailer.set("ID", fresh_id()?);

    let mut bytes = Vec::new();
    doc.save_to(&mut bytes)
        .map_err(|error| AppError::logged(ErrorCode::Internal, format!("text pdf: {error}")))?;
    if bytes.len() > limits::TEXT_PDF_MAX {
        return Err(AppError::limit("textPdf", limits::TEXT_PDF_MAX as u64));
    }
    Ok(TextPdf {
        bytes,
        pages: count,
        glyphs_replaced: layout.metrics.replaced,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::export::text_flow::{flow, SourceLine, SourcePage};
    use skrifa::raw::TableProvider;

    fn block(kind: BlockKind, text: &str) -> Block {
        Block {
            kind,
            text: text.to_owned(),
        }
    }

    fn build_with(sections: &[Section], font: TextPdfFont, keep_images: bool) -> TextPdf {
        let mut owned = sections.to_vec();
        build(
            &mut TextPdfInput {
                sections: &mut owned,
                font,
                keep_images,
                title: "Scan",
                lang: Some("de-DE"),
                producer: "Sheer",
            },
            &mut |_, _| Ok(()),
        )
        .unwrap()
    }

    /// The font size of every `Tf` before a `Tj` whose text (via ToUnicode in lopdf's extraction) is wanted: read from the content.
    fn sizes_by_font(doc: &Document, page: ObjectId) -> Vec<(String, f32)> {
        let content = doc.get_and_decode_page_content(page).unwrap();
        content
            .operations
            .iter()
            .filter(|op| op.operator == "Tf")
            .map(|op| {
                (
                    String::from_utf8_lossy(op.operands[0].as_name().unwrap()).into_owned(),
                    op.operands[1].as_float().unwrap(),
                )
            })
            .collect()
    }

    #[test]
    fn the_text_is_extractable_headings_are_bigger_and_fonts_are_embedded_subsets() {
        for font in [TextPdfFont::Inter, TextPdfFont::Tinos] {
            let sections = [Section {
                blocks: vec![
                    block(BlockKind::Heading(1), "Chapter Größe"),
                    block(BlockKind::Body, &"Body words with umlauts äöü. ".repeat(40)),
                    block(BlockKind::Small, "1 A note."),
                ],
                image: None,
            }];
            let built = build_with(&sections, font, false);
            assert!(!built.glyphs_replaced);
            let doc = crate::pdfwrite::load_untrusted(&built.bytes).unwrap();
            let pages = doc.get_pages();
            let text = doc.extract_text(&[1]).unwrap();
            assert!(text.contains("Chapter Größe"), "{text}");
            assert!(text.contains("Body words with umlauts äöü."), "{text}");
            let page = pages[&1];
            let sizes = sizes_by_font(&doc, page);
            assert_eq!(sizes[0].1, 20.0);
            assert!(sizes.iter().skip(1).all(|(_, s)| *s < 20.0));
            // Bold heading and regular body are two fonts; each a Type0 with an embedded TrueType subset and a ToUnicode map.
            let fonts = doc.get_page_fonts(page).unwrap();
            assert_eq!(fonts.len(), 2);
            for dict in fonts.values() {
                assert_eq!(dict.get(b"Subtype").unwrap().as_name().unwrap(), b"Type0");
                assert!(dict.has(b"ToUnicode"));
                let base = dict.get(b"BaseFont").unwrap().as_name().unwrap();
                let base = String::from_utf8_lossy(base);
                let family = if font == TextPdfFont::Inter {
                    "+Inter-"
                } else {
                    "+Tinos-"
                };
                assert!(base.contains(family), "{base}");
                let cid = doc
                    .get_dictionary(
                        dict.get(b"DescendantFonts").unwrap().as_array().unwrap()[0]
                            .as_reference()
                            .unwrap(),
                    )
                    .unwrap();
                let descriptor = doc
                    .get_dictionary(cid.get(b"FontDescriptor").unwrap().as_reference().unwrap())
                    .unwrap();
                let file = descriptor
                    .get(b"FontFile2")
                    .unwrap()
                    .as_reference()
                    .unwrap();
                let program = doc
                    .get_object(file)
                    .unwrap()
                    .as_stream()
                    .unwrap()
                    .decompressed_content()
                    .unwrap();
                let parsed = skrifa::FontRef::new(&program).unwrap();
                assert!(parsed.maxp().unwrap().num_glyphs() < 200, "a subset");
            }
            let catalog = doc.catalog().unwrap();
            assert_eq!(catalog.get(b"Lang").unwrap().as_str().unwrap(), b"de-DE");
        }
    }

    #[test]
    fn long_text_wraps_inside_the_margins_and_paginates() {
        let sections = [Section {
            blocks: (0..60)
                .map(|n| {
                    block(
                        BlockKind::Body,
                        &format!("Paragraph {n} {}", "lorem ipsum dolor ".repeat(30)),
                    )
                })
                .collect(),
            image: None,
        }];
        let built = build_with(&sections, TextPdfFont::Inter, false);
        assert!(built.pages > 5);
        let doc = crate::pdfwrite::load_untrusted(&built.bytes).unwrap();
        for (_, page) in doc.get_pages() {
            let content = doc.get_and_decode_page_content(page).unwrap();
            for op in content.operations.iter().filter(|op| op.operator == "Td") {
                let x = op.operands[0].as_float().unwrap();
                let y = op.operands[1].as_float().unwrap();
                assert!((x - MARGIN_X).abs() < 0.01);
                assert!((MARGIN_Y - 20.0..=PAGE[1] - MARGIN_Y).contains(&y), "{y}");
            }
        }
        // The widest line fits the text width by the face's own metrics.
        let mut metrics = Metrics::new(TextPdfFont::Inter);
        let face = TextFace::of(TextPdfFont::Inter, false);
        let lines = metrics.wrap(
            face,
            11.0,
            &"lorem ipsum dolor ".repeat(30),
            PAGE[0] - 2.0 * MARGIN_X,
        );
        assert!(lines.len() > 2);
        for line in &lines {
            assert!(metrics.width(face, 11.0, line) <= PAGE[0] - 2.0 * MARGIN_X + 0.01);
        }
    }

    #[test]
    fn kept_images_follow_their_text_on_sheets_of_their_own() {
        let jpeg = {
            let page = crate::pdfwrite::redact::RasterPage::from_rgb(vec![200; 4 * 4 * 3], 4, 4);
            crate::export::images::encode(&page, crate::export::images::ImageFormat::Jpeg, 80)
                .unwrap()
        };
        let image = PageImage {
            jpeg,
            width_px: 4,
            height_px: 4,
            grey: true,
            size_pt: [300.0, 400.0],
        };
        let sections = [
            Section {
                blocks: vec![block(BlockKind::Body, "first page text")],
                image: Some(image.clone()),
            },
            Section {
                blocks: Vec::new(),
                image: Some(image.clone()),
            },
            Section {
                blocks: vec![block(BlockKind::Body, "third page text")],
                image: Some(image),
            },
        ];
        let built = build_with(&sections, TextPdfFont::Inter, true);
        assert_eq!(built.pages, 5);
        let doc = crate::pdfwrite::load_untrusted(&built.bytes).unwrap();
        let pages = doc.get_pages();
        let width = |n: u32| {
            doc.get_dictionary(pages[&n])
                .unwrap()
                .get(b"MediaBox")
                .unwrap()
                .as_array()
                .unwrap()[2]
                .as_float()
                .unwrap()
        };
        assert_eq!(
            [width(1), width(2), width(3), width(4), width(5)],
            [595.0, 300.0, 300.0, 595.0, 300.0]
        );
        assert!(doc.extract_text(&[1]).unwrap().contains("first page text"));
        assert!(doc.extract_text(&[4]).unwrap().contains("third page text"));
        // Without the option the same sections are one sheet of text.
        let plain = build_with(&sections, TextPdfFont::Inter, false);
        assert_eq!(plain.pages, 1);
    }

    #[test]
    fn missing_glyphs_are_replaced_and_reported_and_nothing_is_refused() {
        let sections = [Section {
            blocks: vec![block(BlockKind::Body, "Text \u{4E2D}\u{1F600} end")],
            image: None,
        }];
        let built = build_with(&sections, TextPdfFont::Inter, false);
        assert!(built.glyphs_replaced);
        let doc = crate::pdfwrite::load_untrusted(&built.bytes).unwrap();
        assert!(doc.extract_text(&[1]).unwrap().contains("Text ?? end"));
        let error = build(
            &mut TextPdfInput {
                sections: &mut [Section::default()],
                font: TextPdfFont::Inter,
                keep_images: false,
                title: "",
                lang: Some("de-DE) /JS"),
                producer: "Sheer",
            },
            &mut |_, _| Ok(()),
        )
        .unwrap_err();
        assert_eq!(error.code(), ErrorCode::InvalidArgument);
        assert_eq!(clean_lang("de-DE) /JS"), None);
    }

    /// The whole path: lines as an OCR layer gives them, flowed, set and read back.
    #[test]
    fn recognized_lines_become_a_searchable_text_pdf() {
        let line = |text: &str, size: f32, y: f32| SourceLine {
            text: text.to_owned(),
            size,
            rect: [40.0, y, 520.0, y + size],
            bold: false,
        };
        let page = SourcePage {
            lines: vec![
                line("Annual Report", 28.0, 40.0),
                line(
                    "The first paragraph of recognized text runs across",
                    11.0,
                    100.0,
                ),
                line("two lines of the scanned page.", 11.0, 114.0),
            ],
        };
        let flowed = flow(&[page], true);
        let sections: Vec<Section> = flowed
            .pages
            .into_iter()
            .map(|blocks| Section {
                blocks,
                image: None,
            })
            .collect();
        let built = build_with(&sections, TextPdfFont::Inter, false);
        let doc = crate::pdfwrite::load_untrusted(&built.bytes).unwrap();
        let text = doc.extract_text(&[1]).unwrap();
        assert!(text.contains("Annual Report"));
        assert!(
            text.contains("runs across two lines of the scanned page."),
            "{text}"
        );
        let sizes = sizes_by_font(&doc, doc.get_pages()[&1]);
        assert!(sizes[0].1 > sizes[1].1);
    }

    #[test]
    fn a_stopping_progress_hook_stops_the_build() {
        let mut sections = [Section::default(), Section::default()];
        let error = build(
            &mut TextPdfInput {
                sections: &mut sections,
                font: TextPdfFont::Tinos,
                keep_images: false,
                title: "x",
                lang: None,
                producer: "Sheer",
            },
            &mut |done, _| {
                if done == 1 {
                    Err(AppError::new(ErrorCode::Cancelled))
                } else {
                    Ok(())
                }
            },
        )
        .unwrap_err();
        assert_eq!(error.code(), ErrorCode::Cancelled);
    }
}
