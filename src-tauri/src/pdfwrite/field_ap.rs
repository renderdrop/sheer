//! Appearance streams of form fields (ADR-041 §3): the content a field's widget shows after its value was changed. Helvetica in
//! WinAnsiEncoding (`/Helv` in the stream's own resources), laid out with Helvetica's metrics.
//!
//! No lopdf here: this module makes the text and the numbers; `forms` turns them into objects. A widget's frame is `[0 0 w h]` in the
//! widget's own (unrotated) system; `/MK /R` becomes a matrix on the stream.

use std::fmt::Write as _;

use super::appearance::{num, FONT_NAME};
use crate::model::annotation::Rgb;
use crate::model::form::{winansi_byte, Align, ChoiceOption};

/// Where text sits inside the frame, in points, and the line height of Helvetica as a part of the size.
const LINE_HEIGHT: f32 = 1.15;
const ASCENT: f32 = 0.718;
const DESCENT: f32 = 0.207;
/// The size of text a field draws at size 0 (automatic) at most, and at least.
const AUTO_MAX: f32 = 12.0;
const AUTO_MIN: f32 = 4.0;
/// A list box's selected row.
const HIGHLIGHT: Rgb = Rgb([153, 193, 218]);
const KAPPA: f32 = 0.552_284_8;

/// A built appearance stream, before it is an object.
#[derive(Debug, Clone, PartialEq)]
pub struct FieldAp {
    /// `/BBox`: `[0 0 w h]` of the (possibly turned) frame.
    pub bbox: [f32; 4],
    pub matrix: Option<[f32; 6]>,
    pub content: String,
    pub uses_font: bool,
}

/// The widget's box and what surrounds the text.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Frame {
    /// Size of the widget's rectangle.
    pub w: f32,
    pub h: f32,
    pub fill: Option<Rgb>,
    pub border: Option<Rgb>,
    pub border_width: f32,
    /// `/MK /R`: 0, 90, 180, 270.
    pub rotation: u16,
}

impl Frame {
    /// The frame the content is drawn in: width and height swap for a quarter turn.
    fn inner(&self) -> (f32, f32) {
        if matches!(self.rotation, 90 | 270) {
            (self.h, self.w)
        } else {
            (self.w, self.h)
        }
    }

    fn matrix(&self) -> Option<[f32; 6]> {
        let (w, h) = (self.w, self.h);
        match self.rotation {
            90 => Some([0.0, 1.0, -1.0, 0.0, w, 0.0]),
            180 => Some([-1.0, 0.0, 0.0, -1.0, w, h]),
            270 => Some([0.0, -1.0, 1.0, 0.0, 0.0, h]),
            _ => None,
        }
    }

    fn finish(&self, content: String, uses_font: bool) -> FieldAp {
        let (w, h) = self.inner();
        FieldAp {
            bbox: [0.0, 0.0, w, h],
            matrix: self.matrix(),
            content,
            uses_font,
        }
    }
}

/// How text is set.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TextStyle {
    pub align: Align,
    /// 0 = automatic.
    pub font_size: f32,
    pub color: Rgb,
    pub multiline: bool,
    pub comb: bool,
    pub max_len: Option<u32>,
    pub password: bool,
}

/// The width of Helvetica's glyph for a WinAnsi byte, in 1/1000 em.
fn glyph_width(byte: u8) -> u16 {
    match byte {
        32 | 33 | 44 | 46 | 47 | 58 | 59 | 73 | 91 | 92 | 93 | 102 | 116 => 278,
        34 => 355,
        35 | 36 | 48..=57 | 63 | 95 | 97 | 98 | 100 | 101 | 103 | 104 | 110..=113 | 117 => 556,
        37 => 889,
        77 | 109 => 833,
        38 | 65 | 66 | 69 | 75 | 80 | 83 | 86 | 88 | 89 => 667,
        39 => 191,
        40 | 41 | 45 | 96 | 114 => 333,
        42 => 389,
        43 | 60..=62 | 126 => 584,
        64 => 1015,
        67 | 68 | 72 | 78 | 82 | 85 => 722,
        70 | 84 | 90 => 611,
        71 | 79 | 81 => 778,
        74 | 99 | 107 | 115 | 118 | 120 | 121 | 122 => 500,
        76 => 556,
        87 => 944,
        94 => 469,
        105 | 106 | 108 => 222,
        119 => 722,
        123 | 125 => 334,
        124 => 260,
        // Latin-1 letters: the width of the letter they are made of.
        0xC0..=0xC5 => 667,
        0xC7 => 722,
        0xC8..=0xCB => 667,
        0xCC..=0xCF => 278,
        0xD1 => 722,
        0xD2..=0xD6 => 778,
        0xD9..=0xDC => 722,
        0xDD => 667,
        0xE7 => 500,
        0xEC..=0xEF => 278,
        0xFD | 0xFF => 500,
        _ => 556,
    }
}

/// The width of `bytes` at `size` points.
fn width_of(bytes: &[u8], size: f32) -> f32 {
    bytes
        .iter()
        .map(|b| f32::from(glyph_width(*b)))
        .sum::<f32>()
        * size
        / 1000.0
}

/// `text` as WinAnsi bytes (a character the encoding lacks becomes `?`; values are checked before they get here).
fn encode(text: &str) -> Vec<u8> {
    text.chars()
        .map(|c| winansi_byte(c).unwrap_or(b'?'))
        .collect()
}

fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2 + 2);
    out.push('<');
    for byte in bytes {
        let _ = write!(out, "{byte:02X}");
    }
    out.push('>');
    out
}

fn rgb(out: &mut String, color: Rgb, op: &str) {
    let [r, g, b] = color.0.map(|channel| num(f32::from(channel) / 255.0));
    let _ = writeln!(out, "{r} {g} {b} {op}");
}

/// The background and the border of a rectangular widget.
fn rectangle_chrome(out: &mut String, frame: &Frame) {
    let (w, h) = frame.inner();
    if let Some(fill) = frame.fill {
        rgb(out, fill, "rg");
        let _ = writeln!(out, "0 0 {} {} re f", num(w), num(h));
    }
    if let (Some(border), true) = (frame.border, frame.border_width > 0.0) {
        let half = frame.border_width / 2.0;
        rgb(out, border, "RG");
        let _ = writeln!(
            out,
            "{} w {} {} {} {} re S",
            num(frame.border_width),
            num(half),
            num(half),
            num(w - frame.border_width),
            num(h - frame.border_width)
        );
    }
}

/// The padding between the frame and the text.
fn padding(frame: &Frame) -> f32 {
    frame.border_width.max(1.0) + 1.0
}

/// The size text is set at: the given one, or for 0 as large as the height allows (at most 12 pt).
fn text_size(font_size: f32, inner_h: f32, multiline: bool) -> f32 {
    if font_size > 0.0 {
        font_size.min(1000.0)
    } else if multiline {
        AUTO_MAX
    } else {
        (inner_h / LINE_HEIGHT).clamp(AUTO_MIN, AUTO_MAX)
    }
}

/// Breaks `text` into lines that are at most `width` points wide at `size`: at line feeds, then at spaces, then inside a word that is
/// too long on its own.
fn wrap(text: &str, size: f32, width: f32) -> Vec<Vec<u8>> {
    let mut lines = Vec::new();
    for paragraph in text.split('\n') {
        let bytes = encode(paragraph);
        let mut line: Vec<u8> = Vec::new();
        for word in bytes.split_inclusive(|b| *b == b' ') {
            let mut candidate = line.clone();
            candidate.extend_from_slice(word);
            let fits = width_of(trim_end(&candidate), size) <= width;
            if fits || line.is_empty() && width_of(trim_end(word), size) <= width {
                line = candidate;
                continue;
            }
            if !line.is_empty() {
                lines.push(std::mem::take(&mut line));
            }
            // A word wider than the line is cut where it no longer fits.
            for byte in word {
                let mut next = line.clone();
                next.push(*byte);
                if width_of(trim_end(&next), size) > width && !line.is_empty() {
                    lines.push(std::mem::take(&mut line));
                }
                line.push(*byte);
            }
        }
        lines.push(line);
    }
    lines
}

fn trim_end(bytes: &[u8]) -> &[u8] {
    let end = bytes
        .iter()
        .rposition(|b| *b != b' ')
        .map_or(0, |index| index + 1);
    &bytes[..end]
}

/// The appearance of a text field.
pub fn text_ap(frame: &Frame, style: &TextStyle, text: &str) -> FieldAp {
    let (w, h) = frame.inner();
    let pad = padding(frame);
    let mut out = String::new();
    rectangle_chrome(&mut out, frame);
    let shown: String = if style.password {
        text.chars()
            .map(|c| if c == '\n' { c } else { '*' })
            .collect()
    } else {
        text.to_owned()
    };
    if shown.is_empty() {
        return frame.finish(out, false);
    }
    let (inner_w, inner_h) = ((w - 2.0 * pad).max(0.0), (h - 2.0 * pad).max(0.0));
    let _ = writeln!(out, "/Tx BMC\nq");
    let _ = writeln!(
        out,
        "{} {} {} {} re W n",
        num(pad),
        num(pad),
        num(inner_w),
        num(inner_h)
    );
    out.push_str("BT\n");
    rgb(&mut out, style.color, "rg");
    if style.multiline {
        let size = text_size(style.font_size, inner_h, true);
        let _ = writeln!(out, "/{FONT_NAME} {} Tf", num(size));
        let line_height = size * LINE_HEIGHT;
        let mut y = h - pad - size * ASCENT;
        for line in wrap(&shown, size, inner_w) {
            let x = align_x(style.align, w, pad, width_of(trim_end(&line), size));
            let _ = writeln!(out, "1 0 0 1 {} {} Tm {} Tj", num(x), num(y), hex(&line));
            y -= line_height;
            if y < -line_height {
                break;
            }
        }
    } else if style.comb && style.max_len.is_some_and(|max| max > 0) {
        let cells = style.max_len.unwrap_or(1).max(1);
        let size = text_size(style.font_size, inner_h, false);
        let _ = writeln!(out, "/{FONT_NAME} {} Tf", num(size));
        #[allow(clippy::cast_precision_loss)] // a cell count of a form field
        let cell = inner_w / cells as f32;
        let y = baseline(h, size);
        for (index, byte) in encode(&shown).iter().take(cells as usize).enumerate() {
            let glyph = width_of(&[*byte], size);
            #[allow(clippy::cast_precision_loss)]
            let x = pad + index as f32 * cell + (cell - glyph) / 2.0;
            let _ = writeln!(out, "1 0 0 1 {} {} Tm {} Tj", num(x), num(y), hex(&[*byte]));
        }
    } else {
        let flat: String = shown.replace('\n', " ");
        let bytes = encode(&flat);
        let mut size = text_size(style.font_size, inner_h, false);
        if style.font_size <= 0.0 {
            let natural = width_of(&bytes, size);
            if natural > inner_w && natural > 0.0 {
                size = (size * inner_w / natural).max(AUTO_MIN);
            }
        }
        let _ = writeln!(out, "/{FONT_NAME} {} Tf", num(size));
        let x = align_x(style.align, w, pad, width_of(&bytes, size));
        let _ = writeln!(
            out,
            "1 0 0 1 {} {} Tm {} Tj",
            num(x),
            num(baseline(h, size)),
            hex(&bytes)
        );
    }
    out.push_str("ET\nQ\nEMC\n");
    frame.finish(out, true)
}

/// The baseline of a single line of `size` points centred vertically in a frame `h` high.
fn baseline(h: f32, size: f32) -> f32 {
    (h - (ASCENT + DESCENT) * size) / 2.0 + DESCENT * size
}

fn align_x(align: Align, w: f32, pad: f32, text_width: f32) -> f32 {
    match align {
        Align::Left => pad,
        Align::Center => ((w - text_width) / 2.0).max(pad),
        Align::Right => (w - pad - text_width).max(pad),
    }
}

/// What a choice field draws.
#[derive(Debug, Clone, Copy)]
pub struct ChoiceView<'a> {
    pub combo: bool,
    pub options: &'a [ChoiceOption],
    pub selected: &'a [String],
    pub custom: Option<&'a str>,
    /// The first visible option of a list box (`/TI`).
    pub top_index: usize,
}

/// The appearance of a combo box (the label of the selection, or the text typed) or a list box (the options from the top index, the
/// selected ones highlighted).
pub fn choice_ap(frame: &Frame, style: &TextStyle, view: &ChoiceView<'_>) -> FieldAp {
    if view.combo {
        let label = view.custom.map(str::to_owned).or_else(|| {
            let export = view.selected.first()?;
            view.options
                .iter()
                .find(|option| option.export == *export)
                .map(|option| option.label.clone())
        });
        let text_style = TextStyle {
            multiline: false,
            comb: false,
            password: false,
            ..*style
        };
        return text_ap(frame, &text_style, label.as_deref().unwrap_or(""));
    }
    let (w, h) = frame.inner();
    let pad = padding(frame);
    let mut out = String::new();
    rectangle_chrome(&mut out, frame);
    let size = if style.font_size > 0.0 {
        style.font_size.min(1000.0)
    } else {
        AUTO_MAX
    };
    let row = size * LINE_HEIGHT;
    let _ = writeln!(out, "/Tx BMC\nq");
    let _ = writeln!(
        out,
        "{} {} {} {} re W n",
        num(pad),
        num(pad),
        num((w - 2.0 * pad).max(0.0)),
        num((h - 2.0 * pad).max(0.0))
    );
    let mut top = h - pad;
    for option in view.options.iter().skip(view.top_index) {
        if top < 0.0 {
            break;
        }
        let bottom = top - row;
        if view.selected.contains(&option.export) {
            rgb(&mut out, HIGHLIGHT, "rg");
            let _ = writeln!(
                out,
                "{} {} {} {} re f",
                num(pad),
                num(bottom),
                num((w - 2.0 * pad).max(0.0)),
                num(row)
            );
        }
        out.push_str("BT\n");
        rgb(&mut out, style.color, "rg");
        let _ = writeln!(out, "/{FONT_NAME} {} Tf", num(size));
        let _ = writeln!(
            out,
            "1 0 0 1 {} {} Tm {} Tj\nET",
            num(pad + 1.0),
            num(bottom + (row - (ASCENT + DESCENT) * size) / 2.0 + DESCENT * size),
            hex(&encode(&option.label))
        );
        top = bottom;
    }
    out.push_str("Q\nEMC\n");
    frame.finish(out, true)
}

/// A check box or a radio button.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mark {
    Check,
    Radio,
}

fn circle(out: &mut String, cx: f32, cy: f32, r: f32) {
    let k = r * KAPPA;
    let _ = writeln!(out, "{} {} m", num(cx + r), num(cy));
    let _ = writeln!(
        out,
        "{} {} {} {} {} {} c",
        num(cx + r),
        num(cy + k),
        num(cx + k),
        num(cy + r),
        num(cx),
        num(cy + r)
    );
    let _ = writeln!(
        out,
        "{} {} {} {} {} {} c",
        num(cx - k),
        num(cy + r),
        num(cx - r),
        num(cy + k),
        num(cx - r),
        num(cy)
    );
    let _ = writeln!(
        out,
        "{} {} {} {} {} {} c",
        num(cx - r),
        num(cy - k),
        num(cx - k),
        num(cy - r),
        num(cx),
        num(cy - r)
    );
    let _ = writeln!(
        out,
        "{} {} {} {} {} {} c h",
        num(cx + k),
        num(cy - r),
        num(cx + r),
        num(cy - k),
        num(cx + r),
        num(cy)
    );
}

/// The appearance of a check box or radio button in its on-state (`on`) or its off-state: the background and border (a circle for a
/// radio button), and when on a check mark or a dot in `color`.
pub fn mark_ap(frame: &Frame, mark: Mark, on: bool, color: Rgb) -> FieldAp {
    let (w, h) = frame.inner();
    let mut out = String::new();
    let (cx, cy) = (w / 2.0, h / 2.0);
    let side = w.min(h);
    match mark {
        Mark::Check => rectangle_chrome(&mut out, frame),
        Mark::Radio => {
            let r = (side / 2.0 - frame.border_width / 2.0).max(0.0);
            if let Some(fill) = frame.fill {
                rgb(&mut out, fill, "rg");
                circle(&mut out, cx, cy, r);
                out.push_str("f\n");
            }
            if let (Some(border), true) = (frame.border, frame.border_width > 0.0) {
                rgb(&mut out, border, "RG");
                let _ = writeln!(out, "{} w", num(frame.border_width));
                circle(&mut out, cx, cy, r);
                out.push_str("S\n");
            }
        }
    }
    if on {
        match mark {
            Mark::Check => {
                rgb(&mut out, color, "RG");
                let _ = writeln!(
                    out,
                    "q {} w 1 J 1 j {} {} m {} {} l {} {} l S Q",
                    num((side * 0.12).max(0.5)),
                    num(w * 0.22),
                    num(h * 0.52),
                    num(w * 0.42),
                    num(h * 0.26),
                    num(w * 0.8),
                    num(h * 0.78)
                );
            }
            Mark::Radio => {
                rgb(&mut out, color, "rg");
                circle(&mut out, cx, cy, side * 0.25);
                out.push_str("f\n");
            }
        }
    }
    frame.finish(out, false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(w: f32, h: f32) -> Frame {
        Frame {
            w,
            h,
            fill: Some(Rgb([255, 255, 255])),
            border: Some(Rgb([0, 0, 0])),
            border_width: 1.0,
            rotation: 0,
        }
    }

    fn style() -> TextStyle {
        TextStyle {
            align: Align::Left,
            font_size: 0.0,
            color: Rgb([0, 0, 0]),
            multiline: false,
            comb: false,
            max_len: None,
            password: false,
        }
    }

    #[test]
    fn helvetica_widths_match_the_font_metrics() {
        assert_eq!(glyph_width(b' '), 278);
        assert_eq!(glyph_width(b'A'), 667);
        assert_eq!(glyph_width(b'M'), 833);
        assert_eq!(glyph_width(b'%'), 889);
        assert_eq!(glyph_width(b'i'), 222);
        assert_eq!(glyph_width(b'W'), 944);
        assert!((width_of(b"Hello", 10.0) - 22.78).abs() < 0.01);
    }

    #[test]
    fn a_text_appearance_has_the_marked_content_the_font_and_the_text_in_hex() {
        let ap = text_ap(&frame(100.0, 20.0), &style(), "Hi");
        assert_eq!(ap.bbox, [0.0, 0.0, 100.0, 20.0]);
        assert!(ap.uses_font);
        assert!(ap.content.contains("/Tx BMC"));
        assert!(ap.content.contains("/Helv "));
        assert!(ap.content.contains("<4869> Tj"));
        assert!(ap.content.trim_end().ends_with("EMC"));
    }

    #[test]
    fn an_empty_text_draws_only_the_chrome_and_needs_no_font() {
        let ap = text_ap(&frame(100.0, 20.0), &style(), "");
        assert!(!ap.uses_font);
        assert!(!ap.content.contains("Tj"));
    }

    #[test]
    fn auto_size_fits_the_height_up_to_twelve_points_and_shrinks_to_the_width() {
        let tall = text_ap(&frame(200.0, 60.0), &style(), "x");
        assert!(tall.content.contains("/Helv 12 Tf"));
        let long = text_ap(&frame(40.0, 20.0), &style(), "a very long line of text");
        let size: f32 = long
            .content
            .split("/Helv ")
            .nth(1)
            .and_then(|rest| rest.split(' ').next())
            .and_then(|n| n.parse().ok())
            .unwrap();
        assert!((AUTO_MIN..12.0).contains(&size));
    }

    #[test]
    fn multiline_text_wraps_at_the_width_and_keeps_line_feeds() {
        let mut s = style();
        s.multiline = true;
        s.font_size = 10.0;
        let lines = wrap("one two three\nfour", 10.0, 40.0);
        assert!(lines.len() >= 3);
        assert_eq!(lines.last().map(Vec::as_slice), Some(&b"four"[..]));
        let ap = text_ap(&frame(60.0, 80.0), &s, "one two three\nfour");
        assert!(ap.content.matches(" Tj").count() >= 3);
    }

    #[test]
    fn a_comb_field_puts_one_character_in_each_cell_and_a_password_shows_stars() {
        let mut s = style();
        s.comb = true;
        s.max_len = Some(4);
        let ap = text_ap(&frame(100.0, 20.0), &s, "AB");
        assert_eq!(ap.content.matches(" Tj").count(), 2);
        let mut p = style();
        p.password = true;
        let ap = text_ap(&frame(100.0, 20.0), &p, "ab");
        assert!(ap.content.contains("<2A2A> Tj"));
    }

    #[test]
    fn rotation_turns_the_frame_and_sets_a_matrix_that_maps_it_back() {
        let mut f = frame(100.0, 20.0);
        f.rotation = 90;
        let ap = text_ap(&f, &style(), "x");
        assert_eq!(ap.bbox, [0.0, 0.0, 20.0, 100.0]);
        assert_eq!(ap.matrix, Some([0.0, 1.0, -1.0, 0.0, 100.0, 0.0]));
    }

    #[test]
    fn a_list_box_highlights_the_selected_row() {
        let options: Vec<ChoiceOption> = ["a", "b", "c"]
            .iter()
            .map(|v| ChoiceOption {
                export: (*v).into(),
                label: (*v).into(),
            })
            .collect();
        let selected = vec!["b".to_owned()];
        let view = ChoiceView {
            combo: false,
            options: &options,
            selected: &selected,
            custom: None,
            top_index: 0,
        };
        let ap = choice_ap(&frame(80.0, 80.0), &style(), &view);
        assert_eq!(ap.content.matches(" re f").count(), 2); // the background and one row
        assert_eq!(ap.content.matches(" Tj").count(), 3);
        let combo = ChoiceView {
            combo: true,
            ..view
        };
        assert!(choice_ap(&frame(80.0, 20.0), &style(), &combo)
            .content
            .contains("<62> Tj"));
    }

    #[test]
    fn marks_draw_a_check_or_a_dot_only_when_on() {
        let f = frame(12.0, 12.0);
        assert!(mark_ap(&f, Mark::Check, true, Rgb([0, 0, 0]))
            .content
            .contains(" l S Q"));
        assert!(!mark_ap(&f, Mark::Check, false, Rgb([0, 0, 0]))
            .content
            .contains(" l S Q"));
        let dot = mark_ap(&f, Mark::Radio, true, Rgb([0, 0, 0])).content;
        assert!(dot.matches(" c").count() >= 8);
        assert!(!mark_ap(&f, Mark::Radio, true, Rgb([0, 0, 0])).uses_font);
    }
}
