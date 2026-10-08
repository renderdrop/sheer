//! The PDF summary of the comment export (ADR-139, ARCHITECTURE section 16.3, DESIGN 3.16 E5): a new document like
//! `images_pdf::build`, written with lopdf. Text is real, selectable text in subsets of the bundled Arimo faces (Type0/Identity-H,
//! `text_fonts::add_fallback_font`); a character the face lacks becomes `?` and is reported. Every text here came from a file, so it is
//! only ever drawn: nothing is parsed or interpreted.

use std::collections::HashMap;
use std::io::Write as _;

use lopdf::{Dictionary, Document, Object, ObjectId, Stream, StringFormat};

use super::annots::text_string;
use super::seal::{INK, STONE, TEXT_SECONDARY};
use super::text_fonts::add_fallback_font;
use crate::error::{AppError, ErrorCode};
use crate::export::comments::{
    author_label, format_date, meta_line, page_heading, type_label, CommentItem, Head, ItemKind,
    Labels,
};
use crate::fontprog::fallback::{Face, FallbackStore};
use crate::limits;
use crate::menu::spec::MenuLocale;
use crate::model::text_edit::FallbackFace;
use crate::platform::Paper;

/// Margin on all sides, in points (DESIGN 3.16 E5).
const MARGIN: f32 = 56.0;
/// The foot line sits this far above the bottom edge.
const FOOT_BASELINE: f32 = 24.0;
/// Quote block: rule width and the space between rule and text.
const RULE: f32 = 2.0;
const INSET: f32 = 10.0;
/// Indent of a reply.
const REPLY_INDENT: f32 = 16.0;
/// Most lines of the document name in the head.
const NAME_LINES_MAX: usize = 3;
/// Side of the type icon.
const ICON_PT: f32 = 10.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum Style {
    Regular,
    Bold,
}

impl Style {
    fn face(self) -> Face {
        Face {
            family: FallbackFace::Sans,
            bold: self == Self::Bold,
            italic: false,
        }
    }
}

type Rgb8 = [u8; 3];

#[derive(Debug, Clone)]
struct Seg {
    text: String,
    style: Style,
    size: f32,
    color: Rgb8,
}

/// A line of the document before it is placed.
#[derive(Debug, Clone, Default)]
struct Line {
    /// Space above (not at the top of a page).
    gap: f32,
    leading: f32,
    /// Where the text starts, from the margin.
    indent: f32,
    /// A rule of a quote block, left of the text, in this colour.
    bar: Option<Rgb8>,
    /// The 10 pt vector icon of the item's type, before the swatch and the text (DESIGN 3.16 E5).
    icon: Option<ItemKind>,
    /// A swatch of the item's colour before the text.
    swatch: Option<Rgb8>,
    /// A thin rule across the text width (the head).
    rule: bool,
    segs: Vec<Seg>,
}

#[derive(Debug, Clone)]
enum Op {
    Text {
        style: Style,
        size: f32,
        x: f32,
        y: f32,
        color: Rgb8,
        text: String,
    },
    Rect {
        x: f32,
        y: f32,
        w: f32,
        h: f32,
        color: Rgb8,
    },
    /// The type icon in a 10 pt box whose bottom left is `x`, `y`.
    Icon { kind: ItemKind, x: f32, y: f32 },
}

/// The finished summary.
#[derive(Debug)]
pub struct Summary {
    pub bytes: Vec<u8>,
    pub pages: usize,
    /// A character was drawn as `?` because the bundled face lacks it.
    pub glyphs_replaced: bool,
}

/// Widths and the set of characters used, per style.
#[derive(Default)]
struct Metrics {
    glyphs: HashMap<(Style, char), Option<f32>>,
    store: FallbackStore,
    replaced: bool,
}

impl Metrics {
    fn glyph(&mut self, style: Style, c: char) -> Option<f32> {
        *self
            .glyphs
            .entry((style, c))
            .or_insert_with(|| style.face().advance(c).filter(|_| style.face().has_char(c)))
    }

    /// `text` with the characters the face lacks as `?`; notes the characters for the subset.
    fn prepare(&mut self, style: Style, text: &str) -> String {
        let out: String = text
            .chars()
            .map(|c| {
                // A paragraph break is not drawn; `wrap` splits on it.
                if c == '\n' || self.glyph(style, c).is_some() {
                    c
                } else {
                    self.replaced = true;
                    '?'
                }
            })
            .collect();
        self.store.add(style.face(), &out.replace('\n', ""));
        out
    }

    /// Width in points of prepared `text`.
    fn width(&mut self, style: Style, size: f32, text: &str) -> f32 {
        text.chars()
            .map(|c| self.glyph(style, c).unwrap_or(0.0))
            .sum::<f32>()
            * size
            / 1000.0
    }

    /// `text` cut with an ellipsis to at most `max` points.
    fn fit(&mut self, style: Style, size: f32, text: &str, max: f32) -> String {
        if self.width(style, size, text) <= max {
            return text.to_owned();
        }
        let ellipsis = self.width(style, size, "\u{2026}");
        let mut out = String::new();
        let mut used = ellipsis;
        for c in text.chars() {
            let w = self.glyph(style, c).unwrap_or(0.0) * size / 1000.0;
            if used + w > max {
                break;
            }
            used += w;
            out.push(c);
        }
        out.push('\u{2026}');
        out
    }

    /// Greedy word wrap of prepared `text`; paragraphs (`\n`) stay separate. A word wider than the line is broken anywhere.
    fn wrap(&mut self, style: Style, size: f32, text: &str, max: f32) -> Vec<Vec<String>> {
        let mut paragraphs = Vec::new();
        for paragraph in text.split('\n') {
            let mut lines: Vec<String> = Vec::new();
            let mut line = String::new();
            let mut used = 0.0f32;
            let space = self.width(style, size, " ");
            for word in paragraph.split(' ').filter(|w| !w.is_empty()) {
                let w = self.width(style, size, word);
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
                    let cw = self.glyph(style, c).unwrap_or(0.0) * size / 1000.0;
                    if used + cw > max && !line.is_empty() {
                        lines.push(std::mem::take(&mut line));
                        used = 0.0;
                    }
                    line.push(c);
                    used += cw;
                }
            }
            if !line.is_empty() || lines.is_empty() {
                lines.push(line);
            }
            paragraphs.push(lines);
        }
        paragraphs
    }
}

/// Places lines on pages.
struct Layout {
    metrics: Metrics,
    pages: Vec<Vec<Op>>,
    /// From the top edge.
    y: f32,
    width: f32,
    height: f32,
}

impl Layout {
    fn text_width(&self) -> f32 {
        self.width - 2.0 * MARGIN
    }

    fn at_top(&self) -> bool {
        self.y <= MARGIN + 0.01
    }

    fn new_page(&mut self) -> Result<(), AppError> {
        if self.pages.len() >= limits::COMMENT_EXPORT_PDF_PAGES_MAX {
            return Err(AppError::limit(
                "commentExport",
                limits::COMMENT_EXPORT_PDF_PAGES_MAX as u64,
            ));
        }
        self.pages.push(Vec::new());
        self.y = MARGIN;
        Ok(())
    }

    fn room(&self, needed: f32) -> bool {
        self.y + needed <= self.height - MARGIN + 0.01
    }

    fn place(&mut self, line: &Line) -> Result<(), AppError> {
        if self.pages.is_empty() {
            self.new_page()?;
        }
        let mut gap = if self.at_top() { 0.0 } else { line.gap };
        if !self.room(gap + line.leading) {
            self.new_page()?;
            gap = 0.0;
        }
        self.y += gap;
        let top = self.y;
        let page = self.pages.len() - 1;
        let x0 = MARGIN + line.indent;
        let size = line.segs.iter().map(|s| s.size).fold(0.0f32, f32::max);
        // The baseline sits at 0.8 of the font size below the top of a line box centred on the leading.
        let baseline = top + (line.leading - size) / 2.0 + size * 0.8;
        let text_width = self.text_width();
        if line.rule {
            self.pages[page].push(Op::Rect {
                x: MARGIN,
                y: self.height - top - 0.5,
                w: text_width,
                h: 0.5,
                color: STONE,
            });
        }
        if let Some(color) = line.bar {
            self.pages[page].push(Op::Rect {
                x: x0 - INSET - RULE,
                y: self.height - top - line.leading,
                w: RULE,
                h: line.leading,
                color,
            });
        }
        let mut x = x0;
        if let Some(kind) = line.icon {
            self.pages[page].push(Op::Icon {
                kind,
                x,
                y: self.height - baseline - 1.0,
            });
            x += ICON_PT + 4.0;
        }
        if let Some(color) = line.swatch {
            self.pages[page].push(Op::Rect {
                x,
                y: self.height - baseline - 0.5,
                w: 8.0,
                h: 8.0,
                color,
            });
            x += 12.0;
        }
        for seg in &line.segs {
            let width = self.metrics.width(seg.style, seg.size, &seg.text);
            self.pages[page].push(Op::Text {
                style: seg.style,
                size: seg.size,
                x,
                y: self.height - baseline,
                color: seg.color,
                text: seg.text.clone(),
            });
            x += width;
        }
        self.y += line.leading;
        Ok(())
    }

    /// Places `lines`, starting on a new page unless the first `keep` of them fit together.
    fn place_group(&mut self, lines: &[Line], keep: usize) -> Result<(), AppError> {
        let needed: f32 = lines
            .iter()
            .take(keep)
            .map(|line| line.leading + line.gap)
            .sum();
        if !self.pages.is_empty() && !self.at_top() && !self.room(needed) {
            self.new_page()?;
        }
        for line in lines {
            self.place(line)?;
        }
        Ok(())
    }

    /// Lines of `text` (prepared and wrapped) in one style.
    #[allow(clippy::too_many_arguments)]
    fn text_lines(
        &mut self,
        text: &str,
        style: Style,
        size: f32,
        leading: f32,
        color: Rgb8,
        indent: f32,
        max: f32,
        first_gap: f32,
        paragraph_gap: f32,
        bar: Option<Rgb8>,
    ) -> Vec<Line> {
        let prepared = self.metrics.prepare(style, text);
        let mut out = Vec::new();
        for (index, paragraph) in self
            .metrics
            .wrap(style, size, &prepared, max)
            .into_iter()
            .enumerate()
        {
            for (n, text) in paragraph.into_iter().enumerate() {
                let gap = match (out.is_empty(), n) {
                    (true, _) => first_gap,
                    (false, 0) if index > 0 => paragraph_gap,
                    _ => 0.0,
                };
                out.push(Line {
                    gap,
                    leading,
                    indent,
                    bar,
                    segs: vec![Seg {
                        text,
                        style,
                        size,
                        color,
                    }],
                    ..Line::default()
                });
            }
        }
        out
    }

    /// A one-line meta row: the first part bold in Ink, the rest in the secondary colour, cut to the width.
    fn meta(
        &mut self,
        bold: &str,
        rest: &str,
        indent: f32,
        gap: f32,
        icon: Option<ItemKind>,
        swatch: Option<Rgb8>,
    ) -> Line {
        let reserved = if icon.is_some() { ICON_PT + 4.0 } else { 0.0 }
            + if swatch.is_some() { 12.0 } else { 0.0 };
        let max = self.text_width() - indent - reserved;
        let bold = self.metrics.prepare(Style::Bold, bold);
        let bold = self.metrics.fit(Style::Bold, 9.0, &bold, max);
        let used = self.metrics.width(Style::Bold, 9.0, &bold);
        let rest = self.metrics.prepare(Style::Regular, rest);
        let rest = self
            .metrics
            .fit(Style::Regular, 9.0, &rest, (max - used).max(0.0));
        Line {
            gap,
            leading: 12.0,
            indent,
            icon,
            swatch,
            segs: vec![
                Seg {
                    text: bold,
                    style: Style::Bold,
                    size: 9.0,
                    color: INK,
                },
                Seg {
                    text: rest,
                    style: Style::Regular,
                    size: 9.0,
                    color: TEXT_SECONDARY,
                },
            ],
            ..Line::default()
        }
    }
}

fn quotation(text: &str, locale: MenuLocale) -> String {
    match locale {
        MenuLocale::De => format!("\u{201E}{text}\u{201C}"),
        MenuLocale::En => format!("\u{201C}{text}\u{201D}"),
    }
}

fn item_lines(layout: &mut Layout, item: &CommentItem, labels: Labels, gap: f32) -> Vec<Line> {
    let locale = labels.locale();
    let full = layout.text_width();
    let date = |item: &CommentItem| {
        item.modified
            .as_deref()
            .and_then(|text| format_date(text, locale))
    };
    let mut rest = format!(" \u{00B7} {}", author_label(&item.author, labels));
    if let Some(date) = date(item) {
        rest.push_str(" \u{00B7} ");
        rest.push_str(&date);
    }
    let swatch = item.kind.is_markup().then_some(item.color.0);
    let mut lines = vec![layout.meta(
        &type_label(item, labels),
        &rest,
        0.0,
        gap,
        Some(item.kind),
        swatch,
    )];
    if let Some(quote) = &item.quote {
        lines.extend(layout.text_lines(
            &quotation(quote, locale),
            Style::Regular,
            10.0,
            14.0,
            INK,
            RULE + INSET,
            full - RULE - INSET,
            4.0,
            4.0,
            Some(STONE),
        ));
    }
    if let Some(citation) = &item.citation {
        lines.extend(layout.text_lines(
            citation,
            Style::Regular,
            9.0,
            12.0,
            TEXT_SECONDARY,
            0.0,
            full,
            4.0,
            2.0,
            None,
        ));
    }
    if !item.contents.is_empty() {
        lines.extend(layout.text_lines(
            &item.contents,
            Style::Regular,
            10.0,
            14.0,
            INK,
            0.0,
            full,
            4.0,
            4.0,
            None,
        ));
    }
    for reply in &item.replies {
        let author = author_label(&reply.author, labels);
        let rest = date(reply).map_or_else(String::new, |d| format!(" \u{00B7} {d}"));
        lines.push(layout.meta(&author, &rest, REPLY_INDENT, 6.0, None, None));
        lines.extend(layout.text_lines(
            &reply.contents,
            Style::Regular,
            10.0,
            14.0,
            INK,
            REPLY_INDENT,
            full - REPLY_INDENT,
            2.0,
            4.0,
            None,
        ));
    }
    lines
}

fn head_lines(
    layout: &mut Layout,
    items: &[CommentItem],
    head: &Head,
    labels: Labels,
) -> Vec<Line> {
    let full = layout.text_width();
    let mut lines = layout.text_lines(
        &labels.get("commentExport.pdf.title"),
        Style::Bold,
        20.0,
        28.0,
        INK,
        0.0,
        full,
        0.0,
        0.0,
        None,
    );
    let mut name = layout.text_lines(
        &head.name,
        Style::Regular,
        12.0,
        16.0,
        INK,
        0.0,
        full,
        0.0,
        0.0,
        None,
    );
    name.truncate(NAME_LINES_MAX);
    lines.extend(name);
    lines.extend(layout.text_lines(
        &meta_line(items, head, labels),
        Style::Regular,
        9.0,
        12.0,
        TEXT_SECONDARY,
        0.0,
        full,
        4.0,
        0.0,
        None,
    ));
    lines.push(Line {
        gap: 8.0,
        leading: 16.5,
        rule: true,
        ..Line::default()
    });
    lines
}

fn page_dimensions(paper: Paper) -> (f32, f32) {
    match paper {
        Paper::A4 => (595.0, 842.0),
        Paper::Letter => (612.0, 792.0),
    }
}

/// The stroke paths of the icon of `kind` in a 10 pt box at (`x`, `y`), in Ink: a line drawing of 0.9 pt with round ends, in the manner of
/// the Lucide set (own simplified shapes, no third-party paths). Decorative: the type is also written out.
fn icon_ops(kind: ItemKind, x: f32, y: f32) -> String {
    let path = match kind {
        ItemKind::Comment => "1 9 m 9 9 l 9 3 l 4.5 3 l 2 0.8 l 2 3 l 1 3 h 3 6.5 m 7 6.5 l",
        ItemKind::Highlight => "2 2.5 m 7 8.5 l 1 1 m 9 1 l",
        ItemKind::Underline => "2.5 9 m 2.5 4.5 l 3.5 3 l 6.5 3 l 7.5 4.5 l 7.5 9 l 1 1 m 9 1 l",
        ItemKind::Strikeout => "1 5 m 9 5 l 3 8.5 m 7 8.5 l 3 1.5 m 7 1.5 l",
        ItemKind::Citation => "1.5 4 m 4 4 l 4 8 l 1.5 8 l h 6 4 m 8.5 4 l 8.5 8 l 6 8 l h 1.5 2 m 4 4 l 6 2 m 8.5 4 l",
        ItemKind::Stamp => "1 2.5 m 9 2.5 l 9 7.5 l 1 7.5 l h 3 5 m 7 5 l",
        ItemKind::Shape => "1 1 m 6 1 l 6 6 l 1 6 l h 5 4 m 9 4 l 7 9 l h",
        ItemKind::Ink => "1 3 m 2.5 9 4 9 5 5 c 6 1 7.5 1 9 7 c",
    };
    let mut out = format!("q 0.9 w 1 J 1 j {} RG\n", stroke_color(INK));
    let mut numbers = path.split_whitespace().peekable();
    while let Some(token) = numbers.next() {
        match token.parse::<f32>() {
            Ok(value) => {
                // Numbers come in pairs; the box is placed by the first of each pair being x.
                let Some(next) = numbers.next().and_then(|t| t.parse::<f32>().ok()) else {
                    continue;
                };
                out.push_str(&format!("{:.2} {:.2} ", x + value, y + next));
            }
            Err(_) => {
                out.push_str(token);
                out.push('\n');
            }
        }
    }
    out.push_str(
        "S
Q
",
    );
    out
}

fn stroke_color(rgb: Rgb8) -> String {
    let [r, g, b] = rgb.map(|c| f32::from(c) / 255.0);
    format!("{r:.3} {g:.3} {b:.3}")
}

fn color_op(out: &mut String, rgb: Rgb8) {
    let [r, g, b] = rgb.map(|c| f32::from(c) / 255.0);
    out.push_str(&format!("{r:.3} {g:.3} {b:.3} rg\n"));
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

/// Builds the summary. `progress(done, total)` is called per item and may stop the build with its error (a cancelled job).
pub fn build(
    items: &[CommentItem],
    head: &Head,
    paper: Paper,
    labels: Labels,
    producer: &str,
    progress: &mut dyn FnMut(usize, usize) -> Result<(), AppError>,
) -> Result<Summary, AppError> {
    let (width, height) = page_dimensions(paper);
    let mut layout = Layout {
        metrics: Metrics::default(),
        pages: Vec::new(),
        y: MARGIN,
        width,
        height,
    };
    layout.new_page()?;
    let lines = head_lines(&mut layout, items, head, labels);
    layout.place_group(&lines, lines.len())?;
    let mut page: Option<u32> = None;
    let full_width = layout.text_width();
    let mut after_heading = false;
    for (index, item) in items.iter().enumerate() {
        progress(index, items.len())?;
        let mut lines: Vec<Line> = Vec::new();
        if page != Some(item.page_pos) {
            page = Some(item.page_pos);
            lines.extend(layout.text_lines(
                &page_heading(item, labels),
                Style::Bold,
                13.0,
                16.0,
                INK,
                0.0,
                full_width,
                24.0,
                0.0,
                None,
            ));
            after_heading = true;
        }
        let gap = if after_heading { 8.0 } else { 12.0 };
        let keep = lines.len() + 3;
        lines.extend(item_lines(&mut layout, item, labels, gap));
        after_heading = false;
        layout.place_group(&lines, keep)?;
    }
    progress(items.len(), items.len())?;

    // The running foot, once the number of sheets is known.
    let total = layout.pages.len();
    let foot_name = {
        let max = layout.text_width() * 0.5;
        let name = layout.metrics.prepare(Style::Regular, &head.name);
        layout.metrics.fit(Style::Regular, 8.0, &name, max)
    };
    for number in 0..total {
        let n = (number + 1).to_string();
        let total_text = total.to_string();
        let text = labels.fill(
            "commentExport.pdf.foot",
            &[("name", &foot_name), ("n", &n), ("total", &total_text)],
        );
        let text = layout.metrics.prepare(Style::Regular, &text);
        let w = layout.metrics.width(Style::Regular, 8.0, &text);
        layout.pages[number].push(Op::Text {
            style: Style::Regular,
            size: 8.0,
            x: (width - w) / 2.0,
            y: FOOT_BASELINE,
            color: TEXT_SECONDARY,
            text,
        });
    }

    write_document(&layout, head, labels, producer)
}

fn write_document(
    layout: &Layout,
    head: &Head,
    labels: Labels,
    producer: &str,
) -> Result<Summary, AppError> {
    let mut doc = Document::with_version("1.7");
    let tree = doc.new_object_id();

    // One font object per style used, and the code of every character in it.
    let mut fonts: Vec<(Style, String, ObjectId, HashMap<char, u16>)> = Vec::new();
    for style in [Style::Regular, Style::Bold] {
        let face = style.face();
        if layout
            .metrics
            .store
            .chars
            .get(&face)
            .is_none_or(|set| set.is_empty())
        {
            continue;
        }
        let subset = layout.metrics.store.subset(face)?;
        let id = add_fallback_font(&mut doc, face, &subset)?;
        let codes: HashMap<char, u16> = subset.gids.iter().copied().collect();
        fonts.push((style, format!("F{}", fonts.len() + 1), id, codes));
    }
    let font_of = |style: Style| fonts.iter().find(|(s, ..)| *s == style);

    let mut font_dict = Dictionary::new();
    for (_, name, id, _) in &fonts {
        font_dict.set(name.as_str(), Object::Reference(*id));
    }
    let mut resources = Dictionary::new();
    resources.set("Font", Object::Dictionary(font_dict));
    let resources = doc.add_object(Object::Dictionary(resources));

    let mut kids = Vec::with_capacity(layout.pages.len());
    for ops in &layout.pages {
        let mut content = String::new();
        for op in ops {
            match op {
                Op::Rect { x, y, w, h, color } => {
                    color_op(&mut content, *color);
                    content.push_str(&format!("{x:.2} {y:.2} {w:.2} {h:.2} re f\n"));
                }
                Op::Icon { kind, x, y } => {
                    content.push_str(&icon_ops(*kind, *x, *y));
                }
                Op::Text {
                    style,
                    size,
                    x,
                    y,
                    color,
                    text,
                } => {
                    let Some((_, name, _, codes)) = font_of(*style) else {
                        continue;
                    };
                    let hex: String = text
                        .chars()
                        .map(|c| format!("{:04X}", codes.get(&c).copied().unwrap_or(0)))
                        .collect();
                    if hex.is_empty() {
                        continue;
                    }
                    color_op(&mut content, *color);
                    content.push_str(&format!(
                        "BT /{name} {size:.2} Tf {x:.2} {y:.2} Td <{hex}> Tj ET\n"
                    ));
                }
            }
        }
        let stream = doc.add_object(flate(content.as_bytes())?);
        let mut page = Dictionary::new();
        page.set("Type", Object::Name(b"Page".to_vec()));
        page.set("Parent", Object::Reference(tree));
        page.set(
            "MediaBox",
            vec![
                0.into(),
                0.into(),
                Object::Real(layout.width),
                Object::Real(layout.height),
            ],
        );
        page.set("Resources", Object::Reference(resources));
        page.set("Contents", Object::Reference(stream));
        kids.push(Object::Reference(doc.add_object(Object::Dictionary(page))));
    }
    let count = kids.len();
    let mut tree_dict = Dictionary::new();
    tree_dict.set("Type", Object::Name(b"Pages".to_vec()));
    tree_dict.set("Count", i64::try_from(count).unwrap_or(0));
    tree_dict.set("Kids", Object::Array(kids));
    doc.objects.insert(tree, Object::Dictionary(tree_dict));

    let lang = if labels.locale() == MenuLocale::De {
        "de"
    } else {
        "en"
    };
    let mut catalog = Dictionary::new();
    catalog.set("Type", Object::Name(b"Catalog".to_vec()));
    catalog.set("Pages", Object::Reference(tree));
    catalog.set("Lang", Object::string_literal(lang));
    let root = doc.add_object(Object::Dictionary(catalog));
    doc.trailer.set("Root", Object::Reference(root));
    let mut info = Dictionary::new();
    info.set(
        "Producer",
        Object::string_literal(producer.as_bytes().to_vec()),
    );
    let title = format!(
        "{}: {}",
        head.name.chars().take(200).collect::<String>(),
        labels.get("commentExport.pdf.title")
    );
    info.set("Title", text_string(&title));
    let info = doc.add_object(Object::Dictionary(info));
    doc.trailer.set("Info", Object::Reference(info));
    doc.trailer.set("ID", fresh_id()?);

    let mut bytes = Vec::new();
    doc.save_to(&mut bytes)
        .map_err(|error| AppError::logged(ErrorCode::Internal, format!("summary pdf: {error}")))?;
    if bytes.len() > limits::COMMENT_EXPORT_PDF_MAX {
        return Err(AppError::limit(
            "commentExport",
            limits::COMMENT_EXPORT_PDF_MAX as u64,
        ));
    }
    Ok(Summary {
        bytes,
        pages: count,
        glyphs_replaced: layout.metrics.replaced,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::export::comments::ItemKind;
    use crate::model::annotation::Rgb;
    use crate::model::ids::AnnotId;

    fn item(page: u32, text: &str) -> CommentItem {
        CommentItem {
            page_pos: page,
            locator: page.to_string(),
            kind: ItemKind::Highlight,
            type_key: "annot.type.highlight",
            detail: None,
            color: Rgb([255, 248, 77]),
            author: "Ann".to_owned(),
            modified: Some("2026-10-07T10:00:00Z".to_owned()),
            quote: Some("A quoted passage with \u{00E4}\u{00F6}\u{00FC}".to_owned()),
            contents: text.to_owned(),
            citation: None,
            tags: Vec::new(),
            state: None,
            replies: Vec::new(),
            group: None,
            id: AnnotId::new(page),
            merged: Vec::new(),
        }
    }

    fn head() -> Head {
        Head {
            name: "Paper".to_owned(),
            exported: "7 Oct 2026".to_owned(),
            filtered: None,
        }
    }

    fn build_all(items: &[CommentItem], paper: Paper, lang: &str) -> Summary {
        build(
            items,
            &head(),
            paper,
            Labels::new(lang),
            "Sheer",
            &mut |_, _| Ok(()),
        )
        .unwrap()
    }

    fn text_of(bytes: &[u8]) -> (Document, String) {
        let doc = crate::pdfwrite::load_untrusted(bytes).unwrap();
        let mut all = String::new();
        for (number, _) in doc.get_pages() {
            all.push_str(&doc.extract_text(&[number]).unwrap_or_default());
        }
        (doc, all)
    }

    #[test]
    fn the_summary_is_an_a4_document_with_selectable_text_and_german_labels() {
        let mut first = item(12, "Comment with \u{00DF}");
        first.replies.push({
            let mut reply = item(12, "A reply");
            reply.kind = ItemKind::Comment;
            reply.quote = None;
            reply
        });
        let summary = build_all(&[first, item(14, "Second")], Paper::A4, "de");
        assert!(!summary.glyphs_replaced);
        assert_eq!(summary.pages, 1);
        let (doc, text) = text_of(&summary.bytes);
        let page = doc.get_pages().into_iter().next().unwrap().1;
        let media = doc.get_dictionary(page).unwrap().get(b"MediaBox").unwrap();
        let sizes: Vec<f32> = media
            .as_array()
            .unwrap()
            .iter()
            .map(|n| n.as_float().unwrap())
            .collect();
        assert_eq!(sizes, [0.0, 0.0, 595.0, 842.0]);
        for expected in [
            "Kommentare",
            "Seite 12",
            "Seite 14",
            "Hervorhebung",
            "A reply",
            "1 / 1",
        ] {
            assert!(text.contains(expected), "{expected} in {text}");
        }
        let info = doc.trailer.get(b"Info").unwrap().as_reference().unwrap();
        assert!(doc.get_dictionary(info).unwrap().has(b"Producer"));
        assert!(doc.trailer.get(b"ID").is_ok());
        let catalog = doc.catalog().unwrap();
        assert_eq!(catalog.get(b"Lang").unwrap().as_str().unwrap(), b"de");
    }

    #[test]
    fn paragraph_breaks_are_not_missing_glyphs() {
        let summary = build_all(
            &[item(
                1,
                "First paragraph

Second
third line",
            )],
            Paper::A4,
            "en",
        );
        assert!(!summary.glyphs_replaced);
        let (_, text) = text_of(&summary.bytes);
        assert!(!text.contains('?') && text.contains("Second"), "{text}");
    }

    #[test]
    fn letter_paper_and_missing_glyphs_are_reported_not_fatal() {
        let summary = build_all(
            &[item(1, "Emoji \u{1F600} and \u{4E2D}")],
            Paper::Letter,
            "en",
        );
        assert!(summary.glyphs_replaced);
        let (doc, text) = text_of(&summary.bytes);
        assert!(text.contains("Emoji ? and ?"), "{text}");
        let page = doc.get_pages().into_iter().next().unwrap().1;
        let media = doc.get_dictionary(page).unwrap().get(b"MediaBox").unwrap();
        assert_eq!(media.as_array().unwrap()[2].as_float().unwrap(), 612.0);
    }

    #[test]
    fn long_documents_paginate_and_a_heading_is_never_last_on_a_sheet() {
        let items: Vec<_> = (1..=120).map(|n| item(n, &"word ".repeat(60))).collect();
        let summary = build_all(&items, Paper::A4, "en");
        assert!(summary.pages > 5);
        let (_, text) = text_of(&summary.bytes);
        assert!(text.contains(&format!("{0} / {0}", summary.pages)));
        // Every page-heading line is followed by the meta line of its item on the same sheet.
        let doc = crate::pdfwrite::load_untrusted(&summary.bytes).unwrap();
        for (number, _) in doc.get_pages() {
            let page = doc.extract_text(&[number]).unwrap();
            let lines: Vec<&str> = page
                .lines()
                .map(str::trim)
                .filter(|l| !l.is_empty())
                .collect();
            // The last content line is the foot; the one before must not be a heading.
            let before_foot = lines.len().saturating_sub(2);
            assert!(!lines[before_foot].starts_with("Page "), "{page}");
        }
    }

    #[test]
    fn hostile_long_words_and_texts_are_wrapped_and_the_page_cap_is_enforced() {
        let summary = build_all(&[item(1, &"x".repeat(5_000))], Paper::A4, "en");
        assert!(summary.pages >= 1);
        let huge: Vec<_> = (1..=2_500)
            .map(|n| item(n, &"line ".repeat(1_000)))
            .collect();
        let error = build(
            &huge,
            &head(),
            Paper::A4,
            Labels::new("en"),
            "Sheer",
            &mut |_, _| Ok(()),
        )
        .err()
        .unwrap();
        assert_eq!(error.code(), ErrorCode::LimitExceeded);
    }

    #[test]
    fn a_stopping_progress_hook_stops_the_build() {
        let error = build(
            &[item(1, "a"), item(2, "b")],
            &head(),
            Paper::A4,
            Labels::new("en"),
            "Sheer",
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

#[cfg(test)]
mod icon_tests {
    use super::*;

    const KINDS: [ItemKind; 8] = [
        ItemKind::Comment,
        ItemKind::Highlight,
        ItemKind::Underline,
        ItemKind::Strikeout,
        ItemKind::Citation,
        ItemKind::Stamp,
        ItemKind::Shape,
        ItemKind::Ink,
    ];

    #[test]
    fn every_type_has_a_vector_icon_inside_its_10_pt_box() {
        for kind in KINDS {
            let ops = icon_ops(kind, 100.0, 200.0);
            assert!(ops.starts_with("q ") && ops.ends_with("S\nQ\n"), "{kind:?}");
            let path = ops.split_once("RG\n").map(|(_, path)| path).unwrap_or("");
            let numbers: Vec<f32> = path
                .split_whitespace()
                .filter_map(|t| t.parse::<f32>().ok())
                .collect();
            assert!(
                numbers.len() >= 6 && numbers.len().is_multiple_of(2),
                "{kind:?}"
            );
            for pair in numbers.chunks(2) {
                assert!((100.0..=110.0).contains(&pair[0]), "{kind:?} x {}", pair[0]);
                assert!((200.0..=210.0).contains(&pair[1]), "{kind:?} y {}", pair[1]);
            }
        }
    }
}
