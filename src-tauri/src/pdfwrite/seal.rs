//! The look of a certificate signature on the page: the signature field's `/AP /N` (ADR-121 section 5, DESIGN 3.8 S4). Every viewer shows
//! the picture this builds, and the app's PDFium renders the same stream.
//!
//! Transparent background, a 0.75 pt Stone frame with a 4 pt radius, padding 8 pt. On the left either the signature art the user picked
//! (the left 40 %) or a shield with a check mark drawn as vectors; then the text column: the name, "Digitally signed", the date
//! (`YYYY-MM-DD HH:mm +hh:mm`, the same instant as `/M`) and an optional reason. The text is Helvetica (WinAnsi, as every other appearance
//! stream of the writer), scaled down to 6 pt, then the reason line goes, then the name is shortened with "...". The date and the
//! "digitally signed" line never go. No colour carries a meaning, and the seal never shows a validity: that is the app's to say.
//!
//! The colours are the DESIGN tokens `--color-ink`, `--color-stone` and `--text-secondary`; a test compares them with `tokens.css`.

use std::fmt::Write as _;

use lopdf::{Dictionary, Document, Object, ObjectId, Stream};

use super::appearance::{helvetica_width, num, win_ansi, FONT_NAME, IMAGE_NAME};
use crate::error::{AppError, ErrorCode};
use crate::signatures::{raster, Art, DrawCmd};

/// `--color-ink`.
pub const INK: [u8; 3] = [0x0f, 0x0f, 0x0f];
/// `--color-stone`.
pub const STONE: [u8; 3] = [0x8a, 0x8a, 0x86];
/// `--text-secondary` (`--color-text-secondary`).
pub const TEXT_SECONDARY: [u8; 3] = [0x6f, 0x6f, 0x6b];

/// "Digitally signed" and the reason template per language (`seal.signed`, `seal.reason` of `src/i18n/locales`; a test compares them).
pub const SIGNED_EN: &str = "Digitally signed";
pub const SIGNED_DE: &str = "Digital signiert";
pub const REASON_EN: &str = "Reason: {reason}";
pub const REASON_DE: &str = "Grund: {reason}";

const FRAME_PT: f32 = 0.75;
const RADIUS_PT: f32 = 4.0;
const ICON_PT: f32 = 20.0;
const GAP_PT: f32 = 8.0;
/// Base sizes and line heights in points (DESIGN S4): name 11/14, the other lines 8/10.
const NAME_PT: f32 = 11.0;
const SMALL_PT: f32 = 8.0;
const NAME_LINE: f32 = 14.0;
const SMALL_LINE: f32 = 10.0;
/// The smallest scale: 6 pt for the small lines.
const MIN_SCALE: f32 = 0.75;
/// Where the art ends: the left 40 % of the box inside the padding.
const ART_SHARE: f32 = 0.4;
/// A circle drawn with four Bézier curves: the distance of the control points from the ends, as a part of the radius.
const KAPPA: f32 = 0.552_284_8;

/// What the seal says and how big it is.
#[derive(Debug, Clone, PartialEq)]
pub struct SealSpec {
    /// The size as the reader sees it, in points (after the page's `/Rotate`).
    pub width: f32,
    pub height: f32,
    /// The page's `/Rotate` (0, 90, 180, 270): the form's `/Matrix` turns the seal back upright (ADR-105).
    pub rotate: u16,
    /// The signer's name as it is in the certificate.
    pub name: String,
    /// `seal.signed` in the language of the interface.
    pub signed_label: String,
    /// `YYYY-MM-DD HH:mm +hh:mm`.
    pub date: String,
    /// The whole reason line (`seal.reason` filled in), if there is a reason.
    pub reason_line: Option<String>,
}

/// The image of raster art as two stream objects (the mask is the alpha channel, when any pixel is not opaque).
#[derive(Debug, Clone)]
pub struct SealImage {
    pub image: Stream,
    pub mask: Option<Stream>,
}

/// The appearance: the form XObject, and the image it draws when the art is a picture.
#[derive(Debug, Clone)]
pub struct Seal {
    pub form: Stream,
    pub image: Option<SealImage>,
}

fn failed(detail: impl std::fmt::Display) -> AppError {
    AppError::logged(ErrorCode::SaveFailed, format!("seal: {detail}"))
}

fn name_obj(text: &str) -> Object {
    Object::Name(text.as_bytes().to_vec())
}

fn real(value: f32) -> Object {
    Object::Real(num(value).parse::<f32>().unwrap_or(0.0))
}

/// The `/Matrix` that turns a form drawn upright in `width` by `height` back for a page with `/Rotate` `rotate`; `None` for no turn.
pub fn counter_matrix(rotate: u16, width: f32, height: f32) -> Option<[f32; 6]> {
    match rotate % 360 {
        90 => Some([0.0, 1.0, -1.0, 0.0, height, 0.0]),
        180 => Some([-1.0, 0.0, 0.0, -1.0, width, height]),
        270 => Some([0.0, -1.0, 1.0, 0.0, 0.0, width]),
        _ => None,
    }
}

/// `text` as far as Helvetica in WinAnsi can show it: what WinAnsi has stays, a Latin letter with a mark loses it, the rest is `?`
/// (a certificate name is never dropped for one odd character; the full name is in `/Name`).
pub fn fold(text: &str) -> String {
    /// The base letters of U+0100 to U+017F.
    const LATIN_EXT_A: &str = "AaAaAaCcCcCcCcDdDdEeEeEeEeEeGgGgGgGgHhHhIiIiIiIiIiIiJjKkkLlLlLlLlLlNnNnNnnNnOoOoOoOoRrRrRrSsSsSsSsTtTtTtUuUuUuUuUuUuWwYyYZzZzZzs";
    text.chars()
        .filter(|c| !c.is_control())
        .map(|c| {
            if win_ansi(c) != b'?' || c == '?' {
                return c;
            }
            let code = u32::from(c);
            if (0x100..0x180).contains(&code) {
                return LATIN_EXT_A
                    .chars()
                    .nth((code - 0x100) as usize)
                    .unwrap_or('?');
            }
            '?'
        })
        .collect()
}

/// `text` shortened with "..." so that it is at most `max` points wide at `size`.
fn ellipsize(text: &str, size: f32, max: f32) -> String {
    if helvetica_width(text, size) <= max {
        return text.to_owned();
    }
    let mut chars: Vec<char> = text.chars().collect();
    while !chars.is_empty() {
        chars.pop();
        let shortened: String = chars.iter().collect::<String>() + "...";
        if helvetica_width(&shortened, size) <= max {
            return shortened;
        }
    }
    "...".to_owned()
}

/// `text` as a PDF literal string in WinAnsi.
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

fn color(out: &mut String, rgb: [u8; 3], stroke: bool) {
    let [r, g, b] = rgb.map(|v| num(f32::from(v) / 255.0));
    let _ = writeln!(out, "{r} {g} {b} {}", if stroke { "RG" } else { "rg" });
}

fn rounded_frame(out: &mut String, w: f32, h: f32) {
    let inset = FRAME_PT / 2.0;
    let (x0, y0, x1, y1) = (inset, inset, w - inset, h - inset);
    let r = RADIUS_PT.min((x1 - x0) / 2.0).min((y1 - y0) / 2.0).max(0.0);
    let k = r * KAPPA;
    let _ = writeln!(out, "{} {} m", num(x0 + r), num(y0));
    let _ = writeln!(out, "{} {} l", num(x1 - r), num(y0));
    let _ = writeln!(
        out,
        "{} {} {} {} {} {} c",
        num(x1 - r + k),
        num(y0),
        num(x1),
        num(y0 + r - k),
        num(x1),
        num(y0 + r)
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
    let _ = writeln!(out, "{} {} l", num(x0 + r), num(y1));
    let _ = writeln!(
        out,
        "{} {} {} {} {} {} c",
        num(x0 + r - k),
        num(y1),
        num(x0),
        num(y1 - r + k),
        num(x0),
        num(y1 - r)
    );
    let _ = writeln!(out, "{} {} l", num(x0), num(y0 + r));
    let _ = writeln!(
        out,
        "{} {} {} {} {} {} c",
        num(x0),
        num(y0 + r - k),
        num(x0 + r - k),
        num(y0),
        num(x0 + r),
        num(y0)
    );
    out.push_str("h\nS\n");
}

/// The shield with a check mark (the Lucide `shield-check` shape in a 24 unit box, as vectors), `size` points square at `(x, y)`.
fn shield(out: &mut String, x: f32, y: f32, size: f32) {
    let s = size / 24.0;
    let _ = writeln!(
        out,
        "q\n{} 0 0 {} {} {} cm\n1 J 1 j\n{} w",
        num(s),
        num(-s),
        num(x),
        num(y + size),
        num(1.75)
    );
    color(out, INK, true);
    out.push_str(
        "12 2.7 m\n14.6 4.9 17.2 5.9 20 6 c\n20 13 l\n20 17.6 16.6 20.1 12 21.5 c\n7.4 20.1 4 17.6 4 13 c\n4 6 l\n6.8 5.9 9.4 4.9 12 2.7 c\nh\nS\n9 12 m\n11 14 l\n15 10 l\nS\nQ\n",
    );
}

/// Vector art in the box `(x, y, w, h)`, centred and as large as fits.
fn vector_art(out: &mut String, art_w: f32, art_h: f32, paths: &[Vec<DrawCmd>], bx: [f32; 4]) {
    if art_w <= 0.0 || art_h <= 0.0 {
        return;
    }
    let [x, y, w, h] = bx;
    let s = (w / art_w).min(h / art_h);
    let left = x + (w - art_w * s) / 2.0;
    let top = y + (h + art_h * s) / 2.0;
    let _ = writeln!(
        out,
        "q\n{} 0 0 {} {} {} cm",
        num(s),
        num(-s),
        num(left),
        num(top)
    );
    color(out, INK, false);
    for path in paths {
        for command in path {
            match *command {
                DrawCmd::M(a, b) => {
                    let _ = writeln!(out, "{} {} m", num(a), num(b));
                }
                DrawCmd::L(a, b) => {
                    let _ = writeln!(out, "{} {} l", num(a), num(b));
                }
                DrawCmd::C(a, b, c, d, e, f) => {
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
                DrawCmd::Z => out.push_str("h\n"),
            }
        }
        out.push_str("f\n");
    }
    out.push_str("Q\n");
}

struct Line {
    text: String,
    size: f32,
    height: f32,
    rgb: [u8; 3],
}

fn lines_for(spec: &SealSpec, k: f32, with_reason: bool) -> Vec<Line> {
    let mut lines = vec![
        Line {
            text: fold(&spec.name),
            size: NAME_PT * k,
            height: NAME_LINE * k,
            rgb: INK,
        },
        Line {
            text: fold(&spec.signed_label),
            size: SMALL_PT * k,
            height: SMALL_LINE * k,
            rgb: INK,
        },
        Line {
            text: fold(&spec.date),
            size: SMALL_PT * k,
            height: SMALL_LINE * k,
            rgb: TEXT_SECONDARY,
        },
    ];
    if let (true, Some(reason)) = (with_reason, &spec.reason_line) {
        lines.push(Line {
            text: fold(reason),
            size: SMALL_PT * k,
            height: SMALL_LINE * k,
            rgb: TEXT_SECONDARY,
        });
    }
    lines
}

/// The lines at the largest scale in `MIN_SCALE..=1` at which they fit the column, shortening the reason (it may be any length) and,
/// as the last resort, the name. The date and the "digitally signed" line stay whatever happens (a column that is too narrow clips them).
fn fit_lines(spec: &SealSpec, column_w: f32, column_h: f32) -> Vec<Line> {
    let steps = [1.0, 0.95, 0.9, 0.85, 0.8, MIN_SCALE];
    for with_reason in [true, false] {
        if with_reason && spec.reason_line.is_none() {
            continue;
        }
        for k in steps {
            let mut lines = lines_for(spec, k, with_reason);
            let total: f32 = lines.iter().map(|line| line.height).sum();
            let fits = lines
                .iter()
                .take(3)
                .all(|line| helvetica_width(&line.text, line.size) <= column_w);
            if total <= column_h && fits {
                if let Some(reason) = lines.get_mut(3) {
                    reason.text = ellipsize(&reason.text, reason.size, column_w);
                }
                return lines;
            }
        }
    }
    let mut lines = lines_for(spec, MIN_SCALE, false);
    if let Some(name) = lines.first_mut() {
        name.text = ellipsize(&name.text, name.size, column_w);
    }
    lines
}

fn text_block(out: &mut String, lines: &[Line], x: f32, width: f32, height: f32) {
    let total: f32 = lines.iter().map(|line| line.height).sum();
    let mut top = (height + total) / 2.0;
    // Text that does not fit is clipped, never drawn over the frame.
    let _ = writeln!(
        out,
        "q\n{} {} {} {} re W n",
        num(x),
        num(0.0),
        num(width.max(0.0)),
        num(height)
    );
    for line in lines {
        let baseline = top - (line.height - line.size) / 2.0 - 0.78 * line.size;
        color(out, line.rgb, false);
        let _ = writeln!(
            out,
            "BT\n/{FONT_NAME} {} Tf\n{} {} Td\n{} Tj\nET",
            num(line.size),
            num(x),
            num(baseline),
            literal(&line.text)
        );
        top -= line.height;
    }
    out.push_str("Q\n");
}

fn image_streams(png: &[u8]) -> Result<SealImage, AppError> {
    let picture = raster::decode_art(png)?;
    let (width, height) = picture.dimensions();
    let mut rgb = Vec::new();
    let mut alpha = Vec::new();
    for pixel in picture.pixels() {
        rgb.extend_from_slice(&pixel.0[..3]);
        alpha.push(pixel.0[3]);
    }
    let dict = |space: &str| {
        let mut dict = Dictionary::new();
        dict.set("Type", name_obj("XObject"));
        dict.set("Subtype", name_obj("Image"));
        dict.set("Width", i64::from(width));
        dict.set("Height", i64::from(height));
        dict.set("ColorSpace", name_obj(space));
        dict.set("BitsPerComponent", 8);
        dict
    };
    let flate = |dict: Dictionary, bytes: &[u8]| -> Result<Stream, AppError> {
        let mut stream = Stream::new(dict, bytes.to_vec());
        stream.compress().map_err(failed)?;
        Ok(stream)
    };
    let mask = if alpha.iter().any(|a| *a != 255) {
        Some(flate(dict("DeviceGray"), &alpha)?)
    } else {
        None
    };
    Ok(SealImage {
        image: flate(dict("DeviceRGB"), &rgb)?,
        mask,
    })
}

/// The seal's appearance for `spec`, with `art` (the user's signature) on the left if given.
pub fn appearance(spec: &SealSpec, art: Option<&Art>) -> Result<Seal, AppError> {
    let (w, h) = (spec.width, spec.height);
    if !(w.is_finite() && h.is_finite() && w >= 1.0 && h >= 1.0) {
        return Err(AppError::invalid("placement"));
    }
    let pad = if h >= 40.0 { 8.0 } else { 4.0 };
    let gap = if w >= 120.0 { GAP_PT } else { GAP_PT / 2.0 };
    let inner_h = (h - 2.0 * pad).max(1.0);
    let mut c = String::new();
    c.push_str("q\n");
    color(&mut c, STONE, true);
    let _ = writeln!(c, "{} w", num(FRAME_PT));
    rounded_frame(&mut c, w, h);
    let mut image = None;
    let left_w = match art {
        Some(art) => {
            let art_w = ((w - 2.0 * pad) * ART_SHARE).max(1.0);
            let bx = [pad, pad, art_w, inner_h];
            match art {
                Art::Vector {
                    w: aw,
                    h: ah,
                    paths,
                } => vector_art(&mut c, *aw, *ah, paths, bx),
                Art::Raster { w: pw, h: ph, png } => {
                    let streams = image_streams(png)?;
                    let (pw, ph) = (*pw as f32, *ph as f32);
                    let s = (bx[2] / pw).min(bx[3] / ph);
                    let _ = writeln!(
                        c,
                        "q\n{} 0 0 {} {} {} cm\n/{IMAGE_NAME} Do\nQ",
                        num(pw * s),
                        num(ph * s),
                        num(bx[0] + (bx[2] - pw * s) / 2.0),
                        num(bx[1] + (bx[3] - ph * s) / 2.0)
                    );
                    image = Some(streams);
                }
            }
            art_w
        }
        None => {
            let size = ICON_PT.min(inner_h).min((w - 2.0 * pad) / 3.0).max(0.0);
            if size >= 4.0 {
                shield(&mut c, pad, (h - size) / 2.0, size);
            }
            size
        }
    };
    let x = pad + left_w + if left_w > 0.0 { gap } else { 0.0 };
    let column_w = (w - pad - x).max(1.0);
    let lines = fit_lines(spec, column_w, inner_h);
    text_block(&mut c, &lines, x, column_w, h);
    c.push_str("Q\n");

    let mut dict = Dictionary::new();
    dict.set("Type", name_obj("XObject"));
    dict.set("Subtype", name_obj("Form"));
    dict.set(
        "BBox",
        Object::Array(vec![real(0.0), real(0.0), real(w), real(h)]),
    );
    if let Some(matrix) = counter_matrix(spec.rotate, w, h) {
        dict.set("Matrix", Object::Array(matrix.map(real).to_vec()));
    }
    let mut font = Dictionary::new();
    font.set("Type", name_obj("Font"));
    font.set("Subtype", name_obj("Type1"));
    font.set("BaseFont", name_obj("Helvetica"));
    font.set("Encoding", name_obj("WinAnsiEncoding"));
    let mut fonts = Dictionary::new();
    fonts.set(FONT_NAME, Object::Dictionary(font));
    let mut resources = Dictionary::new();
    resources.set("Font", Object::Dictionary(fonts));
    dict.set("Resources", Object::Dictionary(resources));
    Ok(Seal {
        form: Stream::new(dict, c.into_bytes()),
        image,
    })
}

/// [`appearance`] written into `doc` (the objects of an incremental update): the form's object, with its image wired into the resources.
pub fn write(spec: &SealSpec, art: Option<&Art>, doc: &mut Document) -> Result<ObjectId, AppError> {
    let Seal { mut form, image } = appearance(spec, art)?;
    if let Some(SealImage { mut image, mask }) = image {
        if let Some(mask) = mask {
            let mask_id = doc.add_object(mask);
            image.dict.set("SMask", Object::Reference(mask_id));
        }
        let image_id = doc.add_object(image);
        let mut images = Dictionary::new();
        images.set(IMAGE_NAME, Object::Reference(image_id));
        if let Ok(Object::Dictionary(resources)) = form.dict.get_mut(b"Resources") {
            resources.set("XObject", Object::Dictionary(images));
        }
    }
    Ok(doc.add_object(form))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec() -> SealSpec {
        SealSpec {
            width: 192.0,
            height: 64.0,
            rotate: 0,
            name: "Ada Lovelace".into(),
            signed_label: SIGNED_EN.into(),
            date: "2026-10-05 14:05 +02:00".into(),
            reason_line: Some("Reason: I approve".into()),
        }
    }

    fn content(seal: &Seal) -> String {
        String::from_utf8_lossy(&seal.form.content).into_owned()
    }

    fn hex(rgb: [u8; 3]) -> String {
        format!("#{:02x}{:02x}{:02x}", rgb[0], rgb[1], rgb[2])
    }

    #[test]
    fn the_colours_are_the_design_tokens() {
        let tokens = include_str!("../../../src/styles/tokens.css");
        for (name, rgb) in [
            ("--color-ink:", INK),
            ("--color-stone:", STONE),
            ("--color-text-secondary:", TEXT_SECONDARY),
        ] {
            let line = tokens
                .lines()
                .find(|line| line.trim_start().starts_with(name))
                .unwrap_or_default();
            assert!(line.contains(&hex(rgb)), "{name} is {line}");
        }
    }

    #[test]
    fn the_labels_are_the_catalog_strings() {
        for (file, signed, reason) in [
            (
                include_str!("../../../src/i18n/locales/en.json"),
                SIGNED_EN,
                REASON_EN,
            ),
            (
                include_str!("../../../src/i18n/locales/de.json"),
                SIGNED_DE,
                REASON_DE,
            ),
        ] {
            assert!(file.contains(&format!("\"seal.signed\": \"{signed}\"")));
            assert!(file.contains(&format!("\"seal.reason\": \"{reason}\"")));
        }
    }

    #[test]
    fn the_seal_says_name_signed_date_and_reason_in_a_box_of_its_size() {
        let seal = appearance(&spec(), None).unwrap();
        let text = content(&seal);
        for expected in [
            "(Ada Lovelace) Tj",
            "(Digitally signed) Tj",
            "(2026-10-05 14:05 +02:00) Tj",
            "(Reason: I approve) Tj",
        ] {
            assert!(text.contains(expected), "{expected} in {text}");
        }
        assert!(text.contains("0.541 0.541 0.525 RG"), "the Stone frame");
        assert!(text.contains("0.75 w"));
        assert_eq!(
            seal.form.dict.get(b"BBox").unwrap(),
            &Object::Array(vec![real(0.0), real(0.0), real(192.0), real(64.0)])
        );
        assert!(seal.form.dict.get(b"Matrix").is_err());
        assert!(seal.image.is_none());
    }

    #[test]
    fn a_small_box_scales_down_then_drops_the_reason_then_shortens_the_name() {
        let mut spec = spec();
        spec.width = 140.0;
        spec.height = 40.0;
        let text = content(&appearance(&spec, None).unwrap());
        assert!(
            text.contains("(Digitally signed) Tj") && text.contains("(2026-10-05 14:05 +02:00) Tj")
        );
        assert!(
            !text.contains("Reason: I approve) Tj"),
            "no room for the reason"
        );
        assert!(text.contains(" 6 Tf"), "the small lines are at 6 pt");
        spec.width = 90.0;
        spec.height = 30.0;
        spec.name = "Augusta Ada King-Noel, Countess of Lovelace".into();
        let text = content(&appearance(&spec, None).unwrap());
        assert!(text.contains("...) Tj"), "the name is shortened");
        assert!(text.contains("(Digitally signed) Tj"));
        // The smallest allowed box still draws.
        spec.width = 72.0;
        spec.height = 24.0;
        assert!(appearance(&spec, None).is_ok());
        spec.width = f32::NAN;
        assert!(appearance(&spec, None).is_err());
    }

    #[test]
    fn a_long_reason_is_shortened_not_dropped_when_the_height_allows() {
        let mut spec = spec();
        spec.reason_line = Some(format!("Reason: {}", "x".repeat(100)));
        let text = content(&appearance(&spec, None).unwrap());
        assert!(text.contains("...) Tj") && text.contains("(Reason: x"));
    }

    #[test]
    fn rotated_pages_get_a_counter_matrix() {
        let mut spec = spec();
        spec.rotate = 90;
        let seal = appearance(&spec, None).unwrap();
        let Ok(Object::Array(matrix)) = seal.form.dict.get(b"Matrix") else {
            panic!("a rotated page needs a /Matrix");
        };
        assert_eq!(matrix.len(), 6);
        assert_eq!(counter_matrix(0, 10.0, 5.0), None);
        // The corners of the form land in a box of the swapped size at the origin.
        for (rotate, size) in [(90u16, (5.0, 10.0)), (180, (10.0, 5.0)), (270, (5.0, 10.0))] {
            let [a, b, c, d, e, f] = counter_matrix(rotate, 10.0, 5.0).unwrap();
            let xs: Vec<f32> = [(0.0, 0.0), (10.0, 0.0), (0.0, 5.0), (10.0, 5.0)]
                .iter()
                .map(|(x, y)| a * x + c * y + e)
                .collect();
            let ys: Vec<f32> = [(0.0, 0.0), (10.0, 0.0), (0.0, 5.0), (10.0, 5.0)]
                .iter()
                .map(|(x, y)| b * x + d * y + f)
                .collect();
            let max = |v: &[f32]| v.iter().copied().fold(f32::MIN, f32::max);
            let min = |v: &[f32]| v.iter().copied().fold(f32::MAX, f32::min);
            assert_eq!((min(&xs), min(&ys)), (0.0, 0.0), "{rotate}");
            assert_eq!((max(&xs), max(&ys)), size, "{rotate}");
        }
    }

    #[test]
    fn text_is_folded_to_what_winansi_can_show() {
        assert_eq!(fold("Zażółć"), "Zazólc");
        assert_eq!(fold("Jürgen Ångström"), "Jürgen Ångström");
        assert_eq!(fold("山田 A"), "?? A");
        assert_eq!(fold("a\u{0007}b"), "ab");
        assert_eq!(fold("Łukasz Ő"), "Lukasz O");
        assert_eq!(literal(&fold("a(b)\\")), "(a\\(b\\)\\\\)");
    }

    #[test]
    fn vector_art_is_drawn_in_the_left_part_and_the_shield_is_left_out() {
        let art = Art::Vector {
            w: 200.0,
            h: 100.0,
            paths: vec![vec![
                DrawCmd::M(0.0, 0.0),
                DrawCmd::L(200.0, 0.0),
                DrawCmd::L(200.0, 100.0),
                DrawCmd::Z,
            ]],
        };
        let text = content(&appearance(&spec(), Some(&art)).unwrap());
        assert!(text.contains("200 0 l") && text.contains("f\n"));
        assert!(!text.contains("21.5 c"), "no shield with art");
    }

    #[test]
    fn write_puts_the_form_into_the_document() {
        let mut doc = Document::with_version("1.7");
        let id = write(&spec(), None, &mut doc).unwrap();
        assert!(doc
            .get_object(id)
            .is_ok_and(|o| matches!(o, Object::Stream(_))));
    }
}
