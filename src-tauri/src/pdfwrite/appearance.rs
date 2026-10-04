//! Appearance streams (`/AP /N`) for the annotations the model writes (ADR-003 §5): one content stream per annotation, drawn in the page's
//! user space with the annotation's rectangle as the form's `/BBox` and an identity matrix, so what the file shows is exactly the
//! geometry the model holds (the overlay draws the same numbers). The streams are plain text, not compressed: they are a few hundred
//! bytes, and a reader that has to look at one can.
//!
//! No lopdf here: this module makes the text and says which resources it needs ([`Appearance`]); `annots` turns that into objects.

use std::fmt::Write as _;

use super::coords::Mapper;
use crate::model::annotation::{Annotation, AnnotationBody, LineEnd, NoteIcon, Rgb, Stroke};
use crate::model::geometry::{Point, Quad};
use crate::signatures::{marks, Art, DrawCmd};

/// The name the opacity graphics state has in the form's resources.
pub const GS_NAME: &str = "GS";
/// The name of the font in the form's resources and in a free text's `/DA`.
pub const FONT_NAME: &str = "Helv";
/// The name of the image of a signature in the form's resources.
pub const IMAGE_NAME: &str = "Im0";

/// A circle drawn with four Bézier curves: the distance of the control points from the ends, as a part of the radius.
const KAPPA: f32 = 0.552_284_8;

/// What an appearance stream is made of.
#[derive(Debug, Clone, PartialEq)]
pub struct Appearance {
    /// `/BBox`, in user space: `[left, bottom, right, top]`.
    pub bbox: [f32; 4],
    pub content: String,
    /// Whether `/GS` is in the content (opacity below 1, or the multiply blend of a highlight).
    pub uses_state: bool,
    pub multiply: bool,
    /// Whether `/Helv` is in the content.
    pub uses_font: bool,
}

/// A number the way a content stream wants it: at most three decimals, no exponent, no `-0`.
pub fn num(value: f32) -> String {
    let value = if value.is_finite() { value } else { 0.0 };
    let mut text = format!("{value:.3}");
    if text.contains('.') {
        while text.ends_with('0') {
            text.pop();
        }
        if text.ends_with('.') {
            text.pop();
        }
    }
    if text == "-0" {
        text = "0".to_owned();
    }
    text
}

fn channel(value: u8) -> String {
    num(f32::from(value) / 255.0)
}

fn fill_color(out: &mut String, color: Rgb) {
    let [r, g, b] = color.0;
    let _ = writeln!(out, "{} {} {} rg", channel(r), channel(g), channel(b));
}

fn stroke_color(out: &mut String, color: Rgb) {
    let [r, g, b] = color.0;
    let _ = writeln!(out, "{} {} {} RG", channel(r), channel(g), channel(b));
}

fn move_to(out: &mut String, m: Mapper, p: Point) {
    let (x, y) = m.point(p);
    let _ = writeln!(out, "{} {} m", num(x), num(y));
}

fn line_to(out: &mut String, m: Mapper, p: Point) {
    let (x, y) = m.point(p);
    let _ = writeln!(out, "{} {} l", num(x), num(y));
}

fn curve_to(out: &mut String, m: Mapper, points: [Point; 3]) {
    let [(x1, y1), (x2, y2), (x3, y3)] = points.map(|p| m.point(p));
    let _ = writeln!(
        out,
        "{} {} {} {} {} {} c",
        num(x1),
        num(y1),
        num(x2),
        num(y2),
        num(x3),
        num(y3)
    );
}

fn midpoint(a: Point, b: Point) -> Point {
    Point {
        x: f32::midpoint(a.x, b.x),
        y: f32::midpoint(a.y, b.y),
    }
}

fn distance(a: Point, b: Point) -> f32 {
    (a.x - b.x).hypot(a.y - b.y)
}

/// The line width of an underline or a strike-out of text `height` points high.
fn markup_width(height: f32) -> f32 {
    (height / 16.0).clamp(0.5, 3.0)
}

fn quad_height(quad: &Quad) -> f32 {
    distance(quad[0], quad[2])
}

/// One corner path of a quad: top left, top right, bottom right, bottom left.
fn quad_path(out: &mut String, m: Mapper, quad: &Quad) {
    move_to(out, m, quad[0]);
    line_to(out, m, quad[1]);
    line_to(out, m, quad[3]);
    line_to(out, m, quad[2]);
    out.push_str("h\n");
}

/// Moves `p` towards `towards` by `by` points.
fn toward(p: Point, towards: Point, by: f32) -> Point {
    let length = distance(p, towards);
    if length < f32::EPSILON {
        return p;
    }
    Point {
        x: p.x + (towards.x - p.x) / length * by,
        y: p.y + (towards.y - p.y) / length * by,
    }
}

fn dash(out: &mut String, dashed: bool) {
    if dashed {
        out.push_str("[3 3] 0 d\n");
    }
}

/// An ellipse in `[left, bottom, right, top]`, as a closed path.
fn ellipse_path(out: &mut String, [x0, y0, x1, y1]: [f32; 4]) {
    let (cx, cy) = (f32::midpoint(x0, x1), f32::midpoint(y0, y1));
    let (rx, ry) = ((x1 - x0) / 2.0, (y1 - y0) / 2.0);
    let (kx, ky) = (rx * KAPPA, ry * KAPPA);
    let _ = writeln!(out, "{} {} m", num(cx + rx), num(cy));
    let curves = [
        (cx + rx, cy + ky, cx + kx, cy + ry, cx, cy + ry),
        (cx - kx, cy + ry, cx - rx, cy + ky, cx - rx, cy),
        (cx - rx, cy - ky, cx - kx, cy - ry, cx, cy - ry),
        (cx + kx, cy - ry, cx + rx, cy - ky, cx + rx, cy),
    ];
    for (a, b, c, d, e, f) in curves {
        let _ = writeln!(
            out,
            "{} {} {} {} {} {} c",
            num(a),
            num(b),
            num(c),
            num(d),
            num(e),
            num(f)
        );
    }
    out.push_str("h\n");
}

/// The byte of Windows code page 1252 for `c` (WinAnsiEncoding), `?` for what it does not have (ADR-003 §3: free text is Helvetica,
/// WinAnsi only).
pub fn win_ansi(c: char) -> u8 {
    let code = u32::from(c);
    match code {
        0x20..=0x7E | 0xA0..=0xFF => u8::try_from(code).unwrap_or(b'?'),
        _ => match c {
            '\u{20AC}' => 0x80,
            '\u{201A}' => 0x82,
            '\u{0192}' => 0x83,
            '\u{201E}' => 0x84,
            '\u{2026}' => 0x85,
            '\u{2020}' => 0x86,
            '\u{2021}' => 0x87,
            '\u{02C6}' => 0x88,
            '\u{2030}' => 0x89,
            '\u{0160}' => 0x8A,
            '\u{2039}' => 0x8B,
            '\u{0152}' => 0x8C,
            '\u{017D}' => 0x8E,
            '\u{2018}' => 0x91,
            '\u{2019}' => 0x92,
            '\u{201C}' => 0x93,
            '\u{201D}' => 0x94,
            '\u{2022}' => 0x95,
            '\u{2013}' => 0x96,
            '\u{2014}' => 0x97,
            '\u{02DC}' => 0x98,
            '\u{2122}' => 0x99,
            '\u{0161}' => 0x9A,
            '\u{203A}' => 0x9B,
            '\u{0153}' => 0x9C,
            '\u{017E}' => 0x9E,
            '\u{0178}' => 0x9F,
            _ => b'?',
        },
    }
}

/// `text` as a PDF literal string in WinAnsi, for a `Tj`.
fn literal(text: &str) -> String {
    let mut out = String::from("(");
    for c in text.chars() {
        match win_ansi(c) {
            b'(' => out.push_str("\\("),
            b')' => out.push_str("\\)"),
            b'\\' => out.push_str("\\\\"),
            byte @ 0x20..=0x7E => out.push(char::from(byte)),
            byte => {
                let _ = write!(out, "\\{byte:03o}");
            }
        }
    }
    out.push(')');
    out
}

fn arrow(out: &mut String, m: Mapper, tip: Point, from: Point, kind: LineEnd, width: f32) {
    if kind == LineEnd::None {
        return;
    }
    // The arms go back from the tip along the line, a quarter turn of a right angle to each side.
    let length = 5.0 * width.max(1.0);
    let back = toward(tip, from, length);
    let (dx, dy) = (back.x - tip.x, back.y - tip.y);
    let (sin, cos) = (25.0f32.to_radians().sin(), 25.0f32.to_radians().cos());
    let arm = |sign: f32| Point {
        x: tip.x + dx * cos - sign * dy * sin,
        y: tip.y + sign * dx * sin + dy * cos,
    };
    move_to(out, m, arm(1.0));
    line_to(out, m, tip);
    line_to(out, m, arm(-1.0));
    if kind == LineEnd::ClosedArrow {
        out.push_str("h\nB\n");
    } else {
        out.push_str("S\n");
    }
}

fn stroke_polyline(out: &mut String, m: Mapper, stroke: &Stroke) {
    let mut points = stroke.points.iter();
    let Some(first) = points.next() else { return };
    move_to(out, m, *first);
    let mut any = false;
    for point in points {
        line_to(out, m, *point);
        any = true;
    }
    if !any {
        // A tap: a dot, drawn as a zero length line with round caps.
        line_to(out, m, *first);
    }
    out.push_str("S\n");
}

/// The appearance of `annotation`, with its geometry mapped by `m`. `None` for an annotation the model does not write.
pub fn build(annotation: &Annotation, m: Mapper) -> Option<Appearance> {
    build_with(annotation, m, None).map(|(ap, _)| ap)
}

/// [`build`] for an annotation that has art (a signature): `art` is what its asset holds. A signature without art has no appearance
/// to write (its file one stays). The flag says whether the content draws `/Im0`, the image of raster art, which the caller adds to
/// the resources.
pub fn build_with(
    annotation: &Annotation,
    m: Mapper,
    art: Option<&Art>,
) -> Option<(Appearance, bool)> {
    let mut uses_image = false;
    let bbox = m.rect(annotation.rect);
    let mut c = String::new();
    let mut multiply = false;
    let mut uses_font = false;
    c.push_str("q\n");
    match &annotation.body {
        AnnotationBody::Highlight { quads } => {
            multiply = true;
            fill_color(&mut c, annotation.color);
            for quad in quads {
                quad_path(&mut c, m, quad);
                c.push_str("f\n");
            }
        }
        AnnotationBody::Underline { quads } => {
            stroke_color(&mut c, annotation.color);
            for quad in quads {
                let width = markup_width(quad_height(quad));
                let _ = writeln!(c, "{} w", num(width));
                move_to(&mut c, m, toward(quad[2], quad[0], width / 2.0));
                line_to(&mut c, m, toward(quad[3], quad[1], width / 2.0));
                c.push_str("S\n");
            }
        }
        AnnotationBody::Strikeout { quads } => {
            stroke_color(&mut c, annotation.color);
            for quad in quads {
                let _ = writeln!(c, "{} w", num(markup_width(quad_height(quad))));
                move_to(&mut c, m, midpoint(quad[0], quad[2]));
                line_to(&mut c, m, midpoint(quad[1], quad[3]));
                c.push_str("S\n");
            }
        }
        AnnotationBody::Note { icon, .. } => {
            let [x0, y0, x1, y1] = bbox;
            fill_color(&mut c, annotation.color);
            c.push_str("0 0 0 RG\n1 w\n");
            let _ = writeln!(
                c,
                "{} {} {} {} re\nB",
                num(x0 + 0.5),
                num(y0 + 0.5),
                num(x1 - x0 - 1.0),
                num(y1 - y0 - 1.0)
            );
            // Lines of "text" on the icon tell the three apart: two for a comment, three for a note, one and a dot for help.
            let rows: u8 = match icon {
                NoteIcon::Comment => 2,
                NoteIcon::Note => 3,
                NoteIcon::Help => 1,
            };
            c.push_str("0 0 0 RG\n1 w\n");
            for row in 0..rows {
                let y = y1 - 6.0 - 4.0 * f32::from(row);
                let _ = writeln!(
                    c,
                    "{} {} m {} {} l S",
                    num(x0 + 4.0),
                    num(y),
                    num(x1 - 4.0),
                    num(y)
                );
            }
            if *icon == NoteIcon::Help {
                let _ = writeln!(
                    c,
                    "0 0 0 rg\n{} {} 2 2 re f",
                    num(f32::midpoint(x0, x1) - 1.0),
                    num(y0 + 4.0)
                );
            }
        }
        AnnotationBody::FreeText {
            bounds,
            lines,
            font_size,
            fill,
            border_width,
        } => {
            let [x0, y0, x1, y1] = m.rect(*bounds);
            if let Some(fill) = fill {
                fill_color(&mut c, *fill);
                let _ = writeln!(
                    c,
                    "{} {} {} {} re f",
                    num(x0),
                    num(y0),
                    num(x1 - x0),
                    num(y1 - y0)
                );
            }
            if *border_width > 0.0 {
                stroke_color(&mut c, annotation.color);
                let half = border_width / 2.0;
                let _ = writeln!(
                    c,
                    "{} w\n{} {} {} {} re S",
                    num(*border_width),
                    num(x0 + half),
                    num(y0 + half),
                    num(x1 - x0 - border_width),
                    num(y1 - y0 - border_width)
                );
            }
            if lines.iter().any(|line| !line.is_empty()) {
                uses_font = true;
                let pad = border_width + 2.0;
                // The box clips the text, as the overlay's does.
                let _ = writeln!(
                    c,
                    "{} {} {} {} re W n",
                    num(x0),
                    num(y0),
                    num(x1 - x0),
                    num(y1 - y0)
                );
                fill_color(&mut c, annotation.color);
                let leading = font_size * 1.2;
                let _ = writeln!(
                    c,
                    "BT\n/{FONT_NAME} {} Tf\n{} TL\n{} {} Td",
                    num(*font_size),
                    num(leading),
                    num(x0 + pad),
                    num(y1 - pad - font_size * 0.8)
                );
                for line in lines {
                    let _ = writeln!(c, "{} Tj\nT*", literal(line));
                }
                c.push_str("ET\n");
            }
        }
        AnnotationBody::Ink { strokes, width } => {
            fill_color(&mut c, annotation.color);
            stroke_color(&mut c, annotation.color);
            let _ = writeln!(c, "{} w\n1 J\n1 j", num(*width));
            for stroke in strokes {
                if stroke.outline.len() >= 3 {
                    let mut points = stroke.outline.iter();
                    if let Some(first) = points.next() {
                        move_to(&mut c, m, *first);
                    }
                    for point in points {
                        line_to(&mut c, m, *point);
                    }
                    c.push_str("h\nf\n");
                } else {
                    stroke_polyline(&mut c, m, stroke);
                }
            }
        }
        AnnotationBody::Rect {
            bounds,
            width,
            fill,
            dashed,
        }
        | AnnotationBody::Ellipse {
            bounds,
            width,
            fill,
            dashed,
        } => {
            let shape = m.rect(*bounds);
            if let Some(fill) = fill {
                fill_color(&mut c, *fill);
            }
            stroke_color(&mut c, annotation.color);
            let _ = writeln!(c, "{} w", num(*width));
            dash(&mut c, *dashed);
            if matches!(annotation.body, AnnotationBody::Rect { .. }) {
                let _ = writeln!(
                    c,
                    "{} {} {} {} re",
                    num(shape[0]),
                    num(shape[1]),
                    num(shape[2] - shape[0]),
                    num(shape[3] - shape[1])
                );
            } else {
                ellipse_path(&mut c, shape);
            }
            c.push_str(match (fill.is_some(), *width > 0.0) {
                (true, true) => "B\n",
                (true, false) => "f\n",
                (false, true) => "S\n",
                (false, false) => "n\n",
            });
        }
        AnnotationBody::Line {
            from,
            to,
            width,
            head,
            tail,
        } => {
            stroke_color(&mut c, annotation.color);
            fill_color(&mut c, annotation.color);
            let _ = writeln!(c, "{} w", num(*width));
            move_to(&mut c, m, *from);
            line_to(&mut c, m, *to);
            c.push_str("S\n");
            // The head is at `to`, the tail at `from`.
            arrow(&mut c, m, *to, *from, *head, *width);
            arrow(&mut c, m, *from, *to, *tail, *width);
        }
        AnnotationBody::Signature { bounds, .. } => match art {
            Some(Art::Vector { w, h, paths }) => {
                fill_color(&mut c, annotation.color);
                // The art's commands 1:1 (ADR-051): art space to the box, then `Mapper` flips y; one fill for all (nonzero).
                let at = |x: f32, y: f32| Point {
                    x: bounds.x + x / w * bounds.w,
                    y: bounds.y + y / h * bounds.h,
                };
                for cmd in paths.iter().flatten() {
                    match *cmd {
                        DrawCmd::M(x, y) => move_to(&mut c, m, at(x, y)),
                        DrawCmd::L(x, y) => line_to(&mut c, m, at(x, y)),
                        DrawCmd::C(x1, y1, x2, y2, x, y) => {
                            curve_to(&mut c, m, [at(x1, y1), at(x2, y2), at(x, y)]);
                        }
                        DrawCmd::Z => c.push_str("h\n"),
                    }
                }
                c.push_str("f\n");
            }
            Some(Art::Raster { .. }) => {
                let [x0, y0, x1, y1] = bbox;
                uses_image = true;
                let _ = writeln!(
                    c,
                    "{} 0 0 {} {} {} cm\n/{IMAGE_NAME} Do",
                    num(x1 - x0),
                    num(y1 - y0),
                    num(x0),
                    num(y0)
                );
            }
            // The art of an annotation read from the file is in the file: nothing is written.
            None => return None,
        },
        AnnotationBody::Mark { bounds, glyph } => {
            fill_color(&mut c, annotation.color);
            let at = |u: f32, v: f32| Point {
                x: bounds.x + u * bounds.w,
                y: bounds.y + v * bounds.h,
            };
            match marks::shape(*glyph) {
                marks::Shape::Polygon(points) => {
                    for (index, [u, v]) in points.iter().enumerate() {
                        if index == 0 {
                            move_to(&mut c, m, at(*u, *v));
                        } else {
                            line_to(&mut c, m, at(*u, *v));
                        }
                    }
                    c.push_str("h\nf\n");
                }
                marks::Shape::Disc { inset } => {
                    let [x0, y0, x1, y1] = bbox;
                    let (dx, dy) = ((x1 - x0) * inset, (y1 - y0) * inset);
                    ellipse_path(&mut c, [x0 + dx, y0 + dy, x1 - dx, y1 - dy]);
                    c.push_str("f\n");
                }
            }
        }
        AnnotationBody::Opaque { .. }
        | AnnotationBody::TextBox { .. }
        | AnnotationBody::Image { .. }
        | AnnotationBody::RedactMark { .. } => return None,
    }
    c.push_str("Q\n");
    let uses_state = annotation.opacity < 1.0 || multiply;
    if uses_state {
        c.insert_str(0, &format!("/{GS_NAME} gs\n"));
    }
    let ap = Appearance {
        bbox,
        content: c,
        uses_state,
        multiply,
        uses_font,
    };
    Some((ap, uses_image))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::documents::PageId;
    use crate::model::annotation::Sync;
    use crate::model::geometry::Rect;
    use crate::model::ids::AnnotId;

    fn annotation(body: AnnotationBody, rect: Rect) -> Annotation {
        Annotation {
            id: AnnotId::new(1),
            page_id: PageId::new(0),
            rect,
            color: Rgb([255, 0, 0]),
            opacity: 1.0,
            contents: String::new(),
            author: None,
            modified: None,
            in_reply_to: None,
            locked: false,
            sync: Sync::New,
            body,
        }
    }

    fn mapper() -> Mapper {
        Mapper::new(0.0, 792.0)
    }

    fn rect(x: f32, y: f32, w: f32, h: f32) -> Rect {
        Rect { x, y, w, h }
    }

    #[test]
    fn numbers_are_short_and_never_exponential() {
        assert_eq!(num(1.0), "1");
        assert_eq!(num(0.5), "0.5");
        assert_eq!(num(-0.0), "0");
        assert_eq!(num(12.345_67), "12.346");
        assert_eq!(num(f32::NAN), "0");
        assert_eq!(num(100_000.0), "100000");
    }

    #[test]
    fn win_ansi_maps_latin_text_and_the_specials_and_marks_the_rest() {
        assert_eq!(win_ansi('A'), b'A');
        assert_eq!(win_ansi('\u{E4}'), 0xE4);
        assert_eq!(win_ansi('\u{20AC}'), 0x80);
        assert_eq!(win_ansi('\u{2019}'), 0x92);
        assert_eq!(win_ansi('\u{4E2D}'), b'?');
        assert_eq!(literal("a(b)\\\u{E4}"), "(a\\(b\\)\\\\\\344)");
    }

    #[test]
    fn a_highlight_fills_its_quads_with_multiply_and_has_the_rectangle_as_bbox() {
        let quad = [
            Point { x: 72.0, y: 80.0 },
            Point { x: 172.0, y: 80.0 },
            Point { x: 72.0, y: 92.0 },
            Point { x: 172.0, y: 92.0 },
        ];
        let a = annotation(
            AnnotationBody::Highlight { quads: vec![quad] },
            rect(72.0, 80.0, 100.0, 12.0),
        );
        let ap = build(&a, mapper()).unwrap();
        assert!(ap.multiply && ap.uses_state);
        assert_eq!(ap.bbox, [72.0, 700.0, 172.0, 712.0]);
        assert!(ap.content.starts_with("/GS gs\nq\n1 0 0 rg\n"));
        assert!(ap.content.contains("72 712 m"));
        assert!(ap.content.contains("172 700 l"));
        assert!(ap.content.contains("f\n"));
    }

    #[test]
    fn opacity_below_one_asks_for_the_graphics_state_and_opaque_kinds_have_no_appearance() {
        let mut a = annotation(
            AnnotationBody::Rect {
                bounds: rect(10.0, 10.0, 50.0, 40.0),
                width: 2.0,
                fill: None,
                dashed: true,
            },
            rect(9.0, 9.0, 52.0, 42.0),
        );
        a.opacity = 0.5;
        let ap = build(&a, mapper()).unwrap();
        assert!(ap.uses_state && !ap.multiply);
        assert!(ap.content.contains("[3 3] 0 d"));
        assert!(ap.content.contains("2 w"));
        assert!(ap.content.contains("S\n"));
        let opaque = annotation(
            AnnotationBody::Opaque {
                subtype: "Stamp".into(),
            },
            rect(0.0, 0.0, 1.0, 1.0),
        );
        assert!(build(&opaque, mapper()).is_none());
    }

    #[test]
    fn free_text_draws_its_lines_in_helvetica_inside_a_clip() {
        let a = annotation(
            AnnotationBody::FreeText {
                bounds: rect(72.0, 100.0, 200.0, 40.0),
                lines: vec!["Hello (world)".into(), "Zwei".into()],
                font_size: 12.0,
                fill: Some(Rgb([255, 255, 255])),
                border_width: 1.0,
            },
            rect(72.0, 100.0, 200.0, 40.0),
        );
        let ap = build(&a, mapper()).unwrap();
        assert!(ap.uses_font && !ap.uses_state);
        assert!(ap.content.contains("/Helv 12 Tf"));
        assert!(ap.content.contains("(Hello \\(world\\)) Tj"));
        assert!(ap.content.contains("(Zwei) Tj"));
        assert!(ap.content.contains("re W n"));
    }

    #[test]
    fn a_line_draws_an_arrow_only_where_it_has_one() {
        let line = |head, tail| {
            annotation(
                AnnotationBody::Line {
                    from: Point { x: 10.0, y: 10.0 },
                    to: Point { x: 110.0, y: 10.0 },
                    width: 2.0,
                    head,
                    tail,
                },
                rect(0.0, 0.0, 120.0, 20.0),
            )
        };
        let plain = build(&line(LineEnd::None, LineEnd::None), mapper()).unwrap();
        let closed = build(&line(LineEnd::ClosedArrow, LineEnd::None), mapper()).unwrap();
        let open = build(&line(LineEnd::OpenArrow, LineEnd::OpenArrow), mapper()).unwrap();
        assert_eq!(plain.content.matches(" m\n").count(), 1);
        assert!(closed.content.contains("h\nB\n"));
        assert_eq!(open.content.matches(" m\n").count(), 3);
    }

    #[test]
    fn ink_fills_its_outline_and_a_stroke_without_one_is_a_polyline() {
        let stroke = |outline: Vec<Point>| Stroke {
            points: vec![Point { x: 10.0, y: 10.0 }, Point { x: 20.0, y: 20.0 }],
            outline,
        };
        let a = annotation(
            AnnotationBody::Ink {
                strokes: vec![
                    stroke(vec![
                        Point { x: 10.0, y: 10.0 },
                        Point { x: 20.0, y: 10.0 },
                        Point { x: 20.0, y: 20.0 },
                    ]),
                    stroke(Vec::new()),
                ],
                width: 3.0,
            },
            rect(8.0, 8.0, 14.0, 14.0),
        );
        let ap = build(&a, mapper()).unwrap();
        assert!(ap.content.contains("h\nf\n"));
        assert!(ap.content.contains("S\n"));
    }

    #[test]
    fn signature_art_is_written_one_to_one_as_curves_with_y_flipped() {
        use crate::model::annotation::{SignatureArtRef, SignatureRole};
        let art = Art::Vector {
            w: 2000.0,
            h: 1000.0,
            paths: vec![vec![
                DrawCmd::M(0.0, 0.0),
                DrawCmd::L(1000.0, 0.0),
                DrawCmd::C(1500.0, 0.0, 2000.0, 500.0, 2000.0, 1000.0),
                DrawCmd::Z,
            ]],
        };
        let a = annotation(
            AnnotationBody::Signature {
                bounds: rect(100.0, 100.0, 200.0, 100.0),
                role: SignatureRole::Signature,
                art: SignatureArtRef::File,
            },
            rect(100.0, 100.0, 200.0, 100.0),
        );
        let (ap, image) = build_with(&a, mapper(), Some(&art)).unwrap();
        assert!(!image);
        // Page y is down, PDF y is up: the top left corner of the box (100, 100) is (100, 692).
        assert!(
            ap.content.contains("100 692 m\n200 692 l\n"),
            "{}",
            ap.content
        );
        assert!(
            ap.content.contains("250 692 300 642 300 592 c\nh\nf\n"),
            "{}",
            ap.content
        );
        assert_eq!(ap.content.matches(" c\n").count(), 1);
    }

    #[test]
    fn a_typed_signature_appearance_is_made_of_curves_not_long_polylines() {
        use crate::model::annotation::{SignatureArtRef, SignatureRole};
        let art = crate::signatures::typed::outlines("Ada Lovelace").unwrap();
        let a = annotation(
            AnnotationBody::Signature {
                bounds: rect(100.0, 100.0, 300.0, 60.0),
                role: SignatureRole::Signature,
                art: SignatureArtRef::File,
            },
            rect(100.0, 100.0, 300.0, 60.0),
        );
        let (ap, _) = build_with(&a, mapper(), Some(&art)).unwrap();
        let curves = ap.content.matches(" c\n").count();
        let lines = ap.content.matches(" l\n").count();
        assert!(
            curves > 50 && curves > lines,
            "{curves} curves, {lines} lines"
        );
        // Longest run of line segments in a row: a glyph's straight parts only, never a flattened curve.
        let mut longest = 0;
        let mut run = 0;
        for operator in ap
            .content
            .lines()
            .filter_map(|line| line.split(' ').next_back())
        {
            if operator == "l" {
                run += 1;
                longest = longest.max(run);
            } else {
                run = 0;
            }
        }
        assert!(longest <= 8, "{longest} line segments in a row");
        assert_eq!(ap.content.matches("f\n").count(), 1);
    }
}
