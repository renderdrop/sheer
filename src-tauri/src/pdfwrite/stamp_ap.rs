//! The appearance of a stamp (ARCHITECTURE §16.1, DESIGN 3.14): a rounded rectangle (1.5 pt, radius 4 pt) in Ink, filled Solar for the
//! Solar tone, and the text in Helvetica-Bold (WinAnsi, not embedded) centred, with the date in Helvetica below it. The text is fitted
//! to the box (one line, `model::stamp::fitted_font`) and the form clips to its box, so a long text can never leave the stamp.

use std::fmt::Write as _;

use lopdf::{Dictionary, Object, Stream};

use super::appearance::{num, turn_matrix};
use crate::content::std14::{self, Std14};
use crate::model::annotation::Rgb;
use crate::model::stamp::{
    fitted_font, text_width, tone_rgb, StampTone, DATE_SCALE, INK_RGB, LINE_GAP, SOLAR_RGB,
};

/// The names of the two fonts in the form's resources.
pub const BOLD_NAME: &str = "FB";
pub const REGULAR_NAME: &str = "FR";

const BORDER_PT: f32 = 1.5;
const RADIUS_PT: f32 = 4.0;
/// Height of capital letters over the baseline, as a part of the size (Helvetica: 718/1000).
const CAP: f32 = 0.718;
/// The circle approximation of a quarter turn with one Bézier curve.
const KAPPA: f32 = 0.552_284_8;

fn channel(value: u8) -> String {
    num(f32::from(value) / 255.0)
}

/// `text` as a hexadecimal PDF string of WinAnsi codes (a character WinAnsi has no glyph for becomes a space).
fn hex_string(text: &str) -> String {
    let mut out = String::with_capacity(text.len() * 2 + 2);
    out.push('<');
    for c in text.chars() {
        let _ = write!(out, "{:02X}", std14::winansi(c).unwrap_or(b' '));
    }
    out.push('>');
    out
}

fn rounded_rect(out: &mut String, x: f32, y: f32, w: f32, h: f32, r: f32) {
    let r = r.min(w / 2.0).min(h / 2.0).max(0.0);
    let k = r * KAPPA;
    let (x1, y1) = (x + w, y + h);
    let _ = writeln!(out, "{} {} m", num(x + r), num(y));
    let _ = writeln!(out, "{} {} l", num(x1 - r), num(y));
    let _ = writeln!(
        out,
        "{} {} {} {} {} {} c",
        num(x1 - r + k),
        num(y),
        num(x1),
        num(y + r - k),
        num(x1),
        num(y + r)
    );
    let _ = writeln!(out, "{} {} l", num(x1), num(y1 - r));
    let _ = writeln!(
        out,
        "{} {} {} {} {} {} c",
        num(x1),
        num(y1 - r + k),
        num(x1 - r + k),
        num(y1),
        num(x1 - r),
        num(y1)
    );
    let _ = writeln!(out, "{} {} l", num(x + r), num(y1));
    let _ = writeln!(
        out,
        "{} {} {} {} {} {} c",
        num(x + r - k),
        num(y1),
        num(x),
        num(y1 - r + k),
        num(x),
        num(y1 - r)
    );
    let _ = writeln!(out, "{} {} l", num(x), num(y + r));
    let _ = writeln!(
        out,
        "{} {} {} {} {} {} c\nh",
        num(x),
        num(y + r - k),
        num(x + r - k),
        num(y),
        num(x + r),
        num(y)
    );
}

/// The content stream of the form for a stamp `w` by `h` points (the form's `/BBox` is `[0 0 w h]`). `tone` is the annotation's colour:
/// Solar draws the yellow fill, anything else the outline only.
pub fn build(text: &str, date: Option<&str>, tone: Rgb, w: f32, h: f32) -> Vec<u8> {
    let mut c = String::new();
    c.push_str("q\n");
    let _ = writeln!(c, "0 0 {} {} re W n", num(w), num(h));
    let ink = INK_RGB.0;
    let _ = writeln!(
        c,
        "{} {} {} RG {} w",
        channel(ink[0]),
        channel(ink[1]),
        channel(ink[2]),
        num(BORDER_PT)
    );
    let solar = tone == SOLAR_RGB;
    if solar {
        let [r, g, b] = tone.0;
        let _ = writeln!(c, "{} {} {} rg", channel(r), channel(g), channel(b));
    }
    let half = BORDER_PT / 2.0;
    rounded_rect(&mut c, half, half, w - BORDER_PT, h - BORDER_PT, RADIUS_PT);
    c.push_str(if solar { "B\n" } else { "S\n" });

    let size = fitted_font(text, date, w, h);
    let _ = writeln!(
        c,
        "{} {} {} rg",
        channel(ink[0]),
        channel(ink[1]),
        channel(ink[2])
    );
    let (first_baseline, date_line) = match date {
        Some(date) => {
            let date_size = size * DATE_SCALE;
            let block = size + size * LINE_GAP + date_size;
            let bottom = (h - block) / 2.0;
            let date_baseline = bottom + date_size * 0.2;
            let first = bottom + date_size + size * LINE_GAP + size * 0.2;
            (first, Some((date, date_size, date_baseline)))
        }
        None => (h / 2.0 - size * CAP / 2.0, None),
    };
    let x = (w - text_width(Std14::HelveticaBold, text, size)) / 2.0;
    let _ = writeln!(
        c,
        "BT\n/{BOLD_NAME} {} Tf\n{} {} Td\n{} Tj\nET",
        num(size),
        num(x),
        num(first_baseline),
        hex_string(text)
    );
    if let Some((date, date_size, baseline)) = date_line {
        let x = (w - text_width(Std14::Helvetica, date, date_size)) / 2.0;
        let _ = writeln!(
            c,
            "BT\n/{REGULAR_NAME} {} Tf\n{} {} Td\n{} Tj\nET",
            num(date_size),
            num(x),
            num(baseline),
            hex_string(date)
        );
    }
    c.push_str("Q\n");
    c.into_bytes()
}

/// The Form XObject of a stamp: `/BBox [0 0 w h]`, the two standard fonts as page-local resources.
/// `rotation` is the page's `/Rotate`: the stamp stays upright on a turned page, so the form is drawn for the displayed box (sides swapped for a
/// quarter turn) and its `/Matrix` turns it back against the page; the annotation `/Rect` (`w` by `h` in user space) is where it lands.
pub fn stream(
    text: &str,
    date: Option<&str>,
    tone: StampTone,
    w: f32,
    h: f32,
    rotation: u16,
) -> Stream {
    let (w, h) = if rotation % 180 == 90 { (h, w) } else { (w, h) };
    let rgb = tone_rgb(tone);
    let name = |text: &str| Object::Name(text.as_bytes().to_vec());
    let font = |base: &str| {
        let mut font = Dictionary::new();
        font.set("Type", name("Font"));
        font.set("Subtype", name("Type1"));
        font.set("BaseFont", name(base));
        font.set("Encoding", name("WinAnsiEncoding"));
        Object::Dictionary(font)
    };
    let mut fonts = Dictionary::new();
    fonts.set(BOLD_NAME, font("Helvetica-Bold"));
    fonts.set(REGULAR_NAME, font("Helvetica"));
    let mut resources = Dictionary::new();
    resources.set("Font", Object::Dictionary(fonts));
    let mut dict = Dictionary::new();
    dict.set("Type", name("XObject"));
    dict.set("Subtype", name("Form"));
    dict.set(
        "BBox",
        Object::Array(vec![
            Object::Integer(0),
            Object::Integer(0),
            Object::Real(w),
            Object::Real(h),
        ]),
    );
    dict.set("Resources", Object::Dictionary(resources));
    if let Some(matrix) = turn_matrix([0.0, 0.0, w, h], -f32::from(rotation % 360)) {
        dict.set(
            "Matrix",
            Object::Array(matrix.iter().map(|v| Object::Real(*v)).collect()),
        );
    }
    Stream::new(dict, build(text, date, rgb, w, h))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(bytes: &[u8]) -> String {
        String::from_utf8(bytes.to_vec()).unwrap()
    }

    #[test]
    fn a_solar_stamp_fills_and_an_ink_stamp_only_strokes() {
        let solar = text(&build("DRAFT", None, SOLAR_RGB, 100.0, 34.0));
        assert!(solar.contains("\nB\n") && solar.contains("1 0.973 0.302 rg"));
        let ink = text(&build("DRAFT", None, INK_RGB, 100.0, 34.0));
        assert!(ink.contains("\nS\n") && !ink.contains("\nB\n"));
        assert!(ink.contains("/FB ") && !ink.contains("/FR "));
    }

    #[test]
    fn the_text_is_winansi_hex_and_the_date_has_its_own_font() {
        let content = text(&build(
            "Gepr\u{fc}ft \u{20ac}",
            Some("07.10.2026"),
            INK_RGB,
            120.0,
            50.0,
        ));
        // ü is 0xFC and the euro 0x80 in WinAnsi.
        assert!(content.contains("FC") && content.contains("80>"));
        assert!(content.contains("/FR "));
    }

    fn matrix(stream: &Stream) -> Option<[f32; 6]> {
        let values: Vec<f32> = stream
            .dict
            .get(b"Matrix")
            .ok()?
            .as_array()
            .ok()?
            .iter()
            .filter_map(|v| v.as_float().ok())
            .collect();
        values.try_into().ok()
    }

    #[test]
    fn a_stamp_on_a_turned_page_is_turned_back_and_drawn_for_the_displayed_box() {
        assert!(matrix(&stream("OK", None, StampTone::Ink, 80.0, 30.0, 0)).is_none());
        let upright = stream("OK", None, StampTone::Ink, 80.0, 30.0, 90);
        // The user space box is 80 by 30; shown on a page turned by 90 it is 30 by 80, so the form is drawn 30 by 80.
        let bbox = upright.dict.get(b"BBox").unwrap().as_array().unwrap();
        assert!((bbox[2].as_float().unwrap() - 30.0).abs() < 1e-3);
        assert!((bbox[3].as_float().unwrap() - 80.0).abs() < 1e-3);
        // The same quarter turn back as a file signature on a page turned by 90 (angle -90).
        let [a, b, c, d, ..] = matrix(&upright).unwrap();
        assert!(
            a.abs() < 1e-5 && (b - 1.0).abs() < 1e-5 && (c + 1.0).abs() < 1e-5 && d.abs() < 1e-5
        );
        let half = matrix(&stream("OK", None, StampTone::Ink, 80.0, 30.0, 180)).unwrap();
        assert!((half[0] + 1.0).abs() < 1e-5 && (half[3] + 1.0).abs() < 1e-5);
    }

    #[test]
    fn the_form_has_the_two_fonts_and_a_bbox() {
        let stream = stream("OK", None, StampTone::Solar, 60.0, 30.0, 0);
        let resources = stream.dict.get(b"Resources").unwrap().as_dict().unwrap();
        let fonts = resources.get(b"Font").unwrap().as_dict().unwrap();
        assert!(fonts.has(b"FB") && fonts.has(b"FR"));
        assert_eq!(
            stream.dict.get(b"BBox").unwrap().as_array().unwrap().len(),
            4
        );
    }
}
