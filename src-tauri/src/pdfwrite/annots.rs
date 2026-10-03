//! The annotation dictionaries and appearance streams the model writes (ADR-003 §5): the common keys `/Subtype /Rect /P /NM /M /T
//! /Contents /C /CA /F /IRT /AP`, and per kind the keys that belong to it. Strings are written as hexadecimal strings: no escaping to get
//! wrong, and a text with a line break stays as it is.

use std::collections::hash_map::RandomState;
use std::collections::HashMap;
use std::hash::{BuildHasher, Hasher};
use std::io::Write as _;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use lopdf::{Dictionary, Object, ObjectId, Stream, StringFormat};

use super::appearance::{self, num, Appearance, FONT_NAME, GS_NAME, IMAGE_NAME};
use super::coords::Mapper;
use crate::model::annotation::{
    Annotation, AnnotationBody, LineEnd, NoteIcon, Rgb, SignatureArtRef, SignatureRole,
};
use crate::model::ids::AssetId;
use crate::signatures::{marks, raster, Art};

/// Annotation flags (ISO 32000-1, table 165).
const FLAG_PRINT: i64 = 4;
const FLAG_NO_ZOOM: i64 = 8;
const FLAG_NO_ROTATE: i64 = 16;
const FLAG_LOCKED: i64 = 128;

/// The `/NM` given to an annotation of a page taken from another file that has none, so that the model can find it again in the copy
/// (`Slots::find` matches by name): page `page_index` of the source, annotation number `annot_index` counted as the engine counts
/// (popups left out, every other entry counted, widgets included).
pub fn imported_name(page_index: u32, annot_index: u32) -> String {
    format!("sheer-i{page_index}-{annot_index}")
}

/// Whether the annotation has a `/NM` the model can read (a string).
pub fn has_name(dict: &Dictionary) -> bool {
    matches!(dict.get(b"NM"), Ok(Object::String(..)))
}

/// Gives `dict` the name [`imported_name`] says if it has none.
pub fn stamp_name(dict: &mut Dictionary, page_index: u32, annot_index: u32) {
    if !has_name(dict) {
        dict.set(
            "NM",
            Object::String(
                imported_name(page_index, annot_index).into_bytes(),
                StringFormat::Literal,
            ),
        );
    }
}

/// Reals in a dictionary, rounded the way the content streams are (three decimals).
fn real(value: f32) -> Object {
    Object::Real(num(value).parse::<f32>().unwrap_or(0.0))
}

fn numbers(values: &[f32]) -> Object {
    Object::Array(values.iter().map(|value| real(*value)).collect())
}

fn color(rgb: Rgb) -> Object {
    numbers(&rgb.0.map(|channel| f32::from(channel) / 255.0))
}

/// A text string: ASCII as it is, anything else as UTF-16BE with a byte order mark (ISO 32000-1, 7.9.2.2).
pub fn text_string(text: &str) -> Object {
    let bytes = if text
        .chars()
        .all(|c| matches!(c, '\n' | '\r' | '\t') || (' '..='~').contains(&c))
    {
        text.as_bytes().to_vec()
    } else {
        let mut bytes = vec![0xFE, 0xFF];
        for unit in text.encode_utf16() {
            bytes.extend_from_slice(&unit.to_be_bytes());
        }
        bytes
    };
    Object::String(bytes, StringFormat::Hexadecimal)
}

fn name(text: &str) -> Object {
    Object::Name(text.as_bytes().to_vec())
}

/// `2026-10-03T12:30:45Z` as the PDF date `D:20261003123045Z`. A date that is a PDF date already (an annotation read from a file and
/// not changed) is kept; anything else is no date.
pub fn pdf_date(date: &str) -> Option<String> {
    if date.starts_with("D:") {
        return Some(date.to_owned());
    }
    let digits: Vec<char> = date.chars().collect();
    let shaped = digits.len() == 20
        && digits[4] == '-'
        && digits[7] == '-'
        && digits[10] == 'T'
        && digits[13] == ':'
        && digits[16] == ':'
        && digits[19] == 'Z';
    if !shaped {
        return None;
    }
    let mut out = String::from("D:");
    for (index, c) in digits[..19].iter().enumerate() {
        if matches!(index, 4 | 7 | 10 | 13 | 16) {
            continue;
        }
        if !c.is_ascii_digit() {
            return None;
        }
        out.push(*c);
    }
    out.push('Z');
    Some(out)
}

/// A fresh `/NM`: 128 random bits as hex. The names only have to differ from one another within a file; they come from the OS-seeded
/// hasher of the standard library, a counter and the clock.
pub fn random_name() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_nanos());
    let mut text = String::with_capacity(32);
    for _ in 0..2 {
        let mut hasher = RandomState::new().build_hasher();
        hasher.write_u64(COUNTER.fetch_add(1, Ordering::Relaxed));
        hasher.write_u128(nanos);
        text.push_str(&format!("{:016x}", hasher.finish()));
    }
    text
}

fn border_style(width: f32, dashed: bool) -> Dictionary {
    let mut style = Dictionary::new();
    style.set("Type", name("Border"));
    style.set("W", real(width));
    if dashed {
        style.set("S", name("D"));
        style.set("D", numbers(&[3.0, 3.0]));
    } else {
        style.set("S", name("S"));
    }
    style
}

const fn line_end(end: LineEnd) -> &'static str {
    match end {
        LineEnd::None => "None",
        LineEnd::OpenArrow => "OpenArrow",
        LineEnd::ClosedArrow => "ClosedArrow",
    }
}

const fn note_icon(icon: NoteIcon) -> &'static str {
    match icon {
        NoteIcon::Comment => "Comment",
        NoteIcon::Note => "Note",
        NoteIcon::Help => "Help",
    }
}

/// What a written annotation refers to besides itself.
pub struct Links {
    pub page: ObjectId,
    /// `/IRT`: the annotation it replies to.
    pub reply_to: Option<ObjectId>,
}

/// The keys of `annotation` on top of `base` (the dictionary it had in the file, if it had one: keys the model does not know stay).
/// The appearance is not set here (see [`appearance_stream`]). `None` for an annotation the model does not write.
pub fn annotation_dict(
    annotation: &Annotation,
    m: Mapper,
    nm: &str,
    links: &Links,
    base: Option<Dictionary>,
) -> Option<Dictionary> {
    let mut dict = base.unwrap_or_default();
    // The appearance of a signature read from the file is the file's: a move or a scale changes only its `/Rect`.
    let kept_ap = if matches!(
        annotation.body,
        AnnotationBody::Signature {
            art: SignatureArtRef::File,
            ..
        }
    ) {
        dict.get(b"AP").ok().cloned()
    } else {
        None
    };
    // What the model sets afresh every time; what it does not know about the annotation stays.
    for key in [
        &b"AP"[..],
        b"AS",
        b"RD",
        b"IRT",
        b"RT",
        b"BS",
        b"Border",
        b"IC",
        b"C",
        b"QuadPoints",
        b"InkList",
        b"L",
        b"LE",
        b"DA",
        b"DS",
        b"RC",
        b"Name",
    ] {
        dict.remove(key);
    }
    dict.set("Type", name("Annot"));
    let rect = m.rect(annotation.rect);
    let mut flags = FLAG_PRINT;
    if annotation.locked {
        flags |= FLAG_LOCKED;
    }
    match &annotation.body {
        AnnotationBody::Highlight { quads }
        | AnnotationBody::Underline { quads }
        | AnnotationBody::Strikeout { quads } => {
            let subtype = match annotation.body {
                AnnotationBody::Highlight { .. } => "Highlight",
                AnnotationBody::Underline { .. } => "Underline",
                _ => "StrikeOut",
            };
            dict.set("Subtype", name(subtype));
            let mut points = Vec::with_capacity(quads.len() * 8);
            for quad in quads {
                for corner in quad {
                    let (x, y) = m.point(*corner);
                    points.push(x);
                    points.push(y);
                }
            }
            dict.set("QuadPoints", numbers(&points));
            dict.set("C", color(annotation.color));
        }
        AnnotationBody::Note { icon, .. } => {
            dict.set("Subtype", name("Text"));
            dict.set("Name", name(note_icon(*icon)));
            dict.set("C", color(annotation.color));
            flags |= FLAG_NO_ZOOM | FLAG_NO_ROTATE;
        }
        AnnotationBody::FreeText {
            bounds,
            font_size,
            fill,
            border_width,
            ..
        } => {
            dict.set("Subtype", name("FreeText"));
            let [r, g, b] = annotation.color.0.map(|channel| f32::from(channel) / 255.0);
            dict.set(
                "DA",
                Object::String(
                    format!(
                        "/{FONT_NAME} {} Tf {} {} {} rg",
                        num(*font_size),
                        num(r),
                        num(g),
                        num(b)
                    )
                    .into_bytes(),
                    StringFormat::Literal,
                ),
            );
            dict.set("Q", 0);
            dict.set("BS", border_style(*border_width, false));
            // The background of a free text is its `/C`.
            if let Some(fill) = fill {
                dict.set("C", color(*fill));
            }
            let _ = bounds;
        }
        AnnotationBody::Ink { strokes, width } => {
            dict.set("Subtype", name("Ink"));
            let list = strokes
                .iter()
                .map(|stroke| {
                    let mut points = Vec::with_capacity(stroke.points.len() * 2);
                    for point in &stroke.points {
                        let (x, y) = m.point(*point);
                        points.push(x);
                        points.push(y);
                    }
                    numbers(&points)
                })
                .collect();
            dict.set("InkList", Object::Array(list));
            dict.set("BS", border_style(*width, false));
            dict.set("C", color(annotation.color));
        }
        AnnotationBody::Rect {
            width,
            fill,
            dashed,
            ..
        }
        | AnnotationBody::Ellipse {
            width,
            fill,
            dashed,
            ..
        } => {
            let subtype = if matches!(annotation.body, AnnotationBody::Rect { .. }) {
                "Square"
            } else {
                "Circle"
            };
            dict.set("Subtype", name(subtype));
            dict.set("BS", border_style(*width, *dashed));
            dict.set("C", color(annotation.color));
            if let Some(fill) = fill {
                dict.set("IC", color(*fill));
            }
            // The rectangle is the shape grown by half the line; `/RD` says by how much.
            let half = width / 2.0;
            dict.set("RD", numbers(&[half, half, half, half]));
        }
        AnnotationBody::Line {
            from,
            to,
            width,
            head,
            tail,
        } => {
            dict.set("Subtype", name("Line"));
            let (x0, y0) = m.point(*from);
            let (x1, y1) = m.point(*to);
            dict.set("L", numbers(&[x0, y0, x1, y1]));
            // The first ending is at the start of the line (`from`, the tail), the second at its end (`to`, the head).
            dict.set(
                "LE",
                Object::Array(vec![name(line_end(*tail)), name(line_end(*head))]),
            );
            dict.set("BS", border_style(*width, false));
            dict.set("C", color(annotation.color));
        }
        AnnotationBody::Signature { .. } | AnnotationBody::Mark { .. } => {
            dict.set("Subtype", name("Stamp"));
            // The colour only matters to vector art; `/C` keeps it for the reader that looks at the annotation, not the picture.
            dict.set("C", color(annotation.color));
        }
        AnnotationBody::Opaque { .. } => return None,
    }
    if let Some(ap) = kept_ap {
        dict.set("AP", ap);
    }
    dict.set("F", flags);
    dict.set("Rect", numbers(&rect));
    dict.set("P", Object::Reference(links.page));
    dict.set("NM", text_string(nm));
    dict.set("CA", real(annotation.opacity));
    // A free text is its lines: they are its contents in the file, as PDF readers expect.
    let contents = match &annotation.body {
        AnnotationBody::FreeText { lines, .. } => lines.join(
            "
",
        ),
        _ => annotation.contents.clone(),
    };
    dict.set("Contents", text_string(&contents));
    match written_author(annotation.author.as_deref()) {
        Some(author) => dict.set("T", text_string(&author)),
        None => {
            dict.remove(b"T");
        }
    }
    match annotation.modified.as_deref().and_then(pdf_date) {
        Some(date) => dict.set(
            "M",
            Object::String(date.into_bytes(), StringFormat::Literal),
        ),
        None => {
            dict.remove(b"M");
        }
    }
    if let Some(parent) = links.reply_to {
        dict.set("IRT", Object::Reference(parent));
        dict.set("RT", name("R"));
    }
    Some(dict)
}

/// A fresh `/NM` for `annotation`: the 128 random bits of [`random_name`], behind the prefix our own stamps carry so that a reload
/// reads them as signatures and marks again (`signatures::marks::parse_name`).
pub fn new_name(annotation: &Annotation) -> String {
    match &annotation.body {
        AnnotationBody::Signature { role, .. } => {
            let prefix = match role {
                SignatureRole::Signature => "sheer-sig-",
                SignatureRole::Initials => "sheer-ini-",
            };
            format!("{prefix}{}", random_name())
        }
        AnnotationBody::Mark { glyph, .. } => {
            format!("sheer-mark-{}-{}", marks::word(*glyph), random_name())
        }
        _ => random_name(),
    }
}

/// The Form XObject of an appearance: the rectangle as `/BBox`, an identity matrix, and the resources the content names.
pub fn appearance_stream(ap: &Appearance, opacity: f32) -> Stream {
    appearance_stream_with(ap, opacity, None)
}

/// [`appearance_stream`] with the image XObject a raster signature draws.
pub fn appearance_stream_with(ap: &Appearance, opacity: f32, image: Option<ObjectId>) -> Stream {
    let mut dict = Dictionary::new();
    dict.set("Type", name("XObject"));
    dict.set("Subtype", name("Form"));
    dict.set("BBox", numbers(&ap.bbox));
    let mut resources = Dictionary::new();
    if ap.uses_state {
        let mut state = Dictionary::new();
        state.set("Type", name("ExtGState"));
        state.set("CA", real(opacity));
        state.set("ca", real(opacity));
        state.set("BM", name(if ap.multiply { "Multiply" } else { "Normal" }));
        let mut states = Dictionary::new();
        states.set(GS_NAME, Object::Dictionary(state));
        resources.set("ExtGState", Object::Dictionary(states));
    }
    if ap.uses_font {
        let mut font = Dictionary::new();
        font.set("Type", name("Font"));
        font.set("Subtype", name("Type1"));
        font.set("BaseFont", name("Helvetica"));
        font.set("Encoding", name("WinAnsiEncoding"));
        let mut fonts = Dictionary::new();
        fonts.set(FONT_NAME, Object::Dictionary(font));
        resources.set("Font", Object::Dictionary(fonts));
    }
    if let Some(image) = image {
        let mut images = Dictionary::new();
        images.set(IMAGE_NAME, Object::Reference(image));
        resources.set("XObject", Object::Dictionary(images));
    }
    dict.set("Resources", Object::Dictionary(resources));
    Stream::new(dict, ap.content.clone().into_bytes())
}

/// The appearance of `annotation` as a stream, mapped by `m`.
pub fn build_stream(annotation: &Annotation, m: Mapper) -> Option<Stream> {
    appearance::build(annotation, m).map(|ap| appearance_stream(&ap, annotation.opacity))
}

/// A deflated stream: `bytes` as they are, `/Filter /FlateDecode`.
fn flate_stream(mut dict: Dictionary, bytes: &[u8]) -> Option<Stream> {
    let mut encoder = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
    encoder.write_all(bytes).ok()?;
    let packed = encoder.finish().ok()?;
    dict.set("Filter", name("FlateDecode"));
    Some(Stream::new(dict, packed))
}

/// The image XObject of raster art: DeviceRGB, 8 bits, Flate, with the alpha channel as a DeviceGray `/SMask` when any pixel is not
/// opaque (ADR-041 §5). `None` if the PNG does not decode (it is our own output, so that does not happen).
fn image_objects(art: &Art, doc: &mut lopdf::Document) -> Option<ObjectId> {
    let Art::Raster { png, .. } = art else {
        return None;
    };
    let picture = raster::decode_art(png).ok()?;
    let (width, height) = picture.dimensions();
    let pixels = picture.pixels().len();
    let mut rgb = Vec::with_capacity(pixels * 3);
    let mut alpha = Vec::with_capacity(pixels);
    for pixel in picture.pixels() {
        rgb.extend_from_slice(&pixel.0[..3]);
        alpha.push(pixel.0[3]);
    }
    let image_dict = |space: &str| {
        let mut dict = Dictionary::new();
        dict.set("Type", name("XObject"));
        dict.set("Subtype", name("Image"));
        dict.set("Width", i64::from(width));
        dict.set("Height", i64::from(height));
        dict.set("ColorSpace", name(space));
        dict.set("BitsPerComponent", 8);
        dict
    };
    let mut dict = image_dict("DeviceRGB");
    if alpha.iter().any(|a| *a != 255) {
        let mask = flate_stream(image_dict("DeviceGray"), &alpha)?;
        let mask = doc.add_object(mask);
        dict.set("SMask", Object::Reference(mask));
    }
    let stream = flate_stream(dict, &rgb)?;
    Some(doc.add_object(stream))
}

/// Writes the appearance of `annotation` as an object of `doc` and returns it: the stream of [`build_stream`] for the kinds that have
/// one, with the art of a signature taken from `assets`; the image of a raster asset is written once per save (`images`). `None` for
/// an annotation without an appearance to write (art that is in the file already, or an asset that is gone).
pub fn write_appearance(
    annotation: &Annotation,
    m: Mapper,
    assets: &HashMap<AssetId, Arc<Art>>,
    doc: &mut lopdf::Document,
    images: &mut HashMap<AssetId, ObjectId>,
) -> Option<ObjectId> {
    let AnnotationBody::Signature { art: reference, .. } = &annotation.body else {
        let stream = build_stream(annotation, m)?;
        return Some(doc.add_object(stream));
    };
    let SignatureArtRef::Asset { asset_id, .. } = reference else {
        return None;
    };
    let art = assets.get(asset_id)?;
    let (ap, uses_image) = appearance::build_with(annotation, m, Some(art))?;
    let image = if uses_image {
        match images.get(asset_id) {
            Some(id) => Some(*id),
            None => {
                let id = image_objects(art, doc)?;
                images.insert(*asset_id, id);
                Some(id)
            }
        }
    } else {
        None
    };
    let stream = appearance_stream_with(&ap, annotation.opacity, image);
    Some(doc.add_object(stream))
}

/// The /T text for an annotation's author (ADR-034): sanitized, and `None` (no /T) when nothing is left.
fn written_author(author: Option<&str>) -> Option<String> {
    author
        .map(crate::storage::settings::sanitize_author)
        .filter(|name| !name.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dates_become_pdf_dates_and_pdf_dates_stay() {
        assert_eq!(
            pdf_date("2026-10-03T12:30:45Z").as_deref(),
            Some("D:20261003123045Z")
        );
        assert_eq!(
            pdf_date("D:20240102030405Z").as_deref(),
            Some("D:20240102030405Z")
        );
        assert_eq!(pdf_date("yesterday"), None);
        assert_eq!(pdf_date("2026-10-03T12:30:4xZ"), None);
    }

    #[test]
    fn text_is_ascii_when_it_can_be_and_utf16_with_a_mark_when_it_cannot() {
        let Object::String(ascii, _) = text_string("Hi\n") else {
            panic!("not a string")
        };
        assert_eq!(ascii, b"Hi\n");
        let Object::String(wide, _) = text_string("\u{E4}") else {
            panic!("not a string")
        };
        assert_eq!(wide, [0xFE, 0xFF, 0x00, 0xE4]);
    }

    #[test]
    fn names_are_32_hex_digits_and_do_not_repeat() {
        let a = random_name();
        let b = random_name();
        assert_eq!(a.len(), 32);
        assert!(a.bytes().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
    }

    #[test]
    fn an_empty_author_writes_no_t_and_a_name_is_sanitized() {
        assert_eq!(written_author(None), None);
        assert_eq!(written_author(Some("")), None);
        assert_eq!(written_author(Some("\u{200B}\u{202E}")), None);
        assert_eq!(written_author(Some("Ada")).as_deref(), Some("Ada"));
        assert_eq!(
            written_author(Some("\u{202E}Ada\u{FEFF}")).as_deref(),
            Some("Ada")
        );
    }
}
