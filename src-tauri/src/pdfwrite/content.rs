//! Burns content objects (text boxes, images) into a page at save (ADR-047 §1). owned by package A.
//!
//! The page's content becomes `q <old streams> Q` and one appended stream draws the objects in creation order. A text box is
//! `BT … ET` with a standard 14 font (`/Type1`, `/WinAnsiEncoding`, not embedded, so the text stays extractable) clipped to its box;
//! an image is `q w 0 0 h x y cm /SheerImN Do Q`; opacity goes through an `/ExtGState` (`ca`, `CA`). On a rotated page an object hangs
//! down and to the right from the corner that is the upper-left one as displayed, like `flatten::placement_upright`. The page
//! dictionary and its `/Resources` are written again; a save appends them (incremental).

use std::collections::HashMap;
use std::fmt::Write as _;
use std::sync::Arc;

use lopdf::{Dictionary, Document, IncrementalDocument, Object, ObjectId, Stream};

use super::coords::{page_mapper, Mapper};
use crate::content::image::{ImageAsset, Pixels};
use crate::content::std14::{base_font, text_width, winansi};
use crate::content::text::{layout, LINE_HEIGHT};
use crate::content::ContentObject;
use crate::documents::PageId;
use crate::error::{AppError, ErrorCode};
use crate::model::annotation::{AnnotationBody, StdFont, TextAlign};

/// The deepest `/Parent` chain looked at for an inherited key.
const MAX_TREE_DEPTH: usize = 64;

fn failed(detail: impl std::fmt::Display) -> AppError {
    AppError::logged(ErrorCode::SaveFailed, format!("content: {detail}"))
}

fn name(value: &str) -> Object {
    Object::Name(value.as_bytes().to_vec())
}

/// A number for a content stream: finite, at most 3 decimals, no exponent.
fn num(value: f32) -> String {
    if !value.is_finite() {
        return "0".to_owned();
    }
    let text = format!("{value:.3}");
    let text = text.trim_end_matches('0').trim_end_matches('.');
    if text.is_empty() || text == "-0" {
        "0".to_owned()
    } else {
        text.to_owned()
    }
}

/// What is read from a page before it is written again.
struct PageSource {
    dict: Dictionary,
    resources: Dictionary,
    fonts: Dictionary,
    xobjects: Dictionary,
    gstates: Dictionary,
    contents: Vec<Object>,
    mapper: Mapper,
    rotation: i64,
}

fn dict_of(doc: &Document, object: &Object) -> Option<Dictionary> {
    doc.dereference(object).ok()?.1.as_dict().ok().cloned()
}

fn inherited_object(doc: &Document, page: ObjectId, key: &[u8]) -> Option<Object> {
    let mut id = page;
    for _ in 0..MAX_TREE_DEPTH {
        let dict = doc.get_dictionary(id).ok()?;
        if let Ok(value) = dict.get(key) {
            return Some(value.clone());
        }
        id = dict.get(b"Parent").ok()?.as_reference().ok()?;
    }
    None
}

fn read_page(doc: &Document, page: ObjectId) -> Result<PageSource, AppError> {
    let dict = doc.get_dictionary(page).map_err(failed)?.clone();
    let resources = inherited_object(doc, page, b"Resources")
        .and_then(|object| dict_of(doc, &object))
        .unwrap_or_default();
    let sub = |key: &[u8]| {
        resources
            .get(key)
            .ok()
            .and_then(|object| dict_of(doc, object))
            .unwrap_or_default()
    };
    let (fonts, xobjects, gstates) = (sub(b"Font"), sub(b"XObject"), sub(b"ExtGState"));
    let contents = match dict.get(b"Contents") {
        Ok(Object::Array(items)) => items.clone(),
        Ok(Object::Reference(id)) => match doc.get_object(*id) {
            Ok(Object::Array(items)) => items.clone(),
            Ok(Object::Stream(_)) => vec![Object::Reference(*id)],
            _ => Vec::new(),
        },
        _ => Vec::new(),
    };
    let rotation = inherited_object(doc, page, b"Rotate")
        .and_then(|object| {
            doc.dereference(&object)
                .ok()
                .and_then(|(_, o)| o.as_i64().ok())
        })
        .map_or(0, |value| value.rem_euclid(360) / 90 * 90);
    Ok(PageSource {
        dict,
        resources,
        fonts,
        xobjects,
        gstates,
        contents,
        mapper: page_mapper(doc, page),
        rotation,
    })
}

/// A key of `dict` that starts with `base` and is not used yet.
fn unique(dict: &Dictionary, base: &str) -> String {
    (1u32..)
        .map(|n| format!("{base}{n}"))
        .find(|candidate| !dict.has(candidate.as_bytes()))
        .unwrap_or_else(|| base.to_owned())
}

/// The matrix that puts a local frame (origin at the top-left of the box, x right, y up, the box at `0..w` by `-h..0`) on the page:
/// the object is upright as displayed (`flatten::placement_upright`).
fn frame(rect: [f32; 4], rotation: i64) -> [f32; 6] {
    let (x0, y0, x1, y1) = (rect[0], rect[1], rect[2], rect[3]);
    match rotation {
        90 => [0.0, 1.0, -1.0, 0.0, x0, y0],
        180 => [-1.0, 0.0, 0.0, -1.0, x1, y0],
        270 => [0.0, -1.0, 1.0, 0.0, x1, y1],
        _ => [1.0, 0.0, 0.0, 1.0, x0, y1],
    }
}

/// A PDF literal string of WinAnsi `text`: every byte outside printable ASCII, and the three specials, as an octal escape.
fn literal(text: &str) -> Result<String, AppError> {
    let mut out = String::from("(");
    for c in text.chars() {
        let code = winansi(c).ok_or_else(|| AppError::bad_char(c))?;
        match code {
            b'\\' | b'(' | b')' => {
                out.push('\\');
                out.push(char::from(code));
            }
            0x20..=0x7E => out.push(char::from(code)),
            _ => {
                let _ = write!(out, "\\{code:03o}");
            }
        }
    }
    out.push(')');
    Ok(out)
}

/// The resources and the drawing operators of `objs`.
struct Drawing {
    ops: String,
    fonts: Dictionary,
    xobjects: Dictionary,
    gstates: Dictionary,
}

fn draw(
    doc: &mut Document,
    source: &PageSource,
    objs: &[ContentObject],
) -> Result<Drawing, AppError> {
    let mut drawing = Drawing {
        ops: String::new(),
        fonts: source.fonts.clone(),
        xobjects: source.xobjects.clone(),
        gstates: source.gstates.clone(),
    };
    let mut font_names: HashMap<u8, String> = HashMap::new();
    let mut image_names: HashMap<usize, String> = HashMap::new();
    let mut gs_names: HashMap<u32, String> = HashMap::new();
    for obj in objs {
        let annotation = &obj.annotation;
        let rect = source.mapper.rect(match &annotation.body {
            AnnotationBody::TextBox { bounds, .. } | AnnotationBody::Image { bounds, .. } => {
                *bounds
            }
            _ => continue,
        });
        let m = frame(rect, source.rotation);
        let mut ops = format!(
            "q\n{} {} {} {} {} {} cm\n",
            num(m[0]),
            num(m[1]),
            num(m[2]),
            num(m[3]),
            num(m[4]),
            num(m[5])
        );
        let opacity = annotation.opacity.clamp(0.0, 1.0);
        if opacity < 1.0 {
            let gs = gs_names.entry(opacity.to_bits()).or_insert_with(|| {
                let key = unique(&drawing.gstates, "SheerGs");
                let mut dict = Dictionary::new();
                dict.set("Type", name("ExtGState"));
                dict.set("ca", Object::Real(opacity));
                dict.set("CA", Object::Real(opacity));
                drawing
                    .gstates
                    .set(key.as_bytes().to_vec(), Object::Dictionary(dict));
                key
            });
            let _ = writeln!(ops, "/{gs} gs");
        }
        let (w, h) = (rect[2] - rect[0], rect[3] - rect[1]);
        match &annotation.body {
            AnnotationBody::TextBox {
                text,
                font,
                font_size,
                align,
                ..
            } => {
                let font_key = font_names
                    .entry(*font as u8)
                    .or_insert_with(|| {
                        let key = unique(&drawing.fonts, "SheerF");
                        let mut dict = Dictionary::new();
                        dict.set("Type", name("Font"));
                        dict.set("Subtype", name("Type1"));
                        dict.set("BaseFont", name(base_font(*font)));
                        dict.set("Encoding", name("WinAnsiEncoding"));
                        let id = doc.add_object(Object::Dictionary(dict));
                        drawing
                            .fonts
                            .set(key.as_bytes().to_vec(), Object::Reference(id));
                        key
                    })
                    .clone();
                let (lines, _) = layout(text, *font, *font_size, w)?;
                let [r, g, b] = annotation.color.0;
                let _ = write!(
                    ops,
                    "0 {} {} {} re W n\n{} {} {} rg\nBT\n/{font_key} {} Tf\n",
                    num(-h),
                    num(w),
                    num(h),
                    num(f32::from(r) / 255.0),
                    num(f32::from(g) / 255.0),
                    num(f32::from(b) / 255.0),
                    num(*font_size)
                );
                for (index, line) in lines.iter().enumerate() {
                    if line.is_empty() {
                        continue;
                    }
                    let x = line_x(*align, *font, line, *font_size, w);
                    #[allow(clippy::cast_precision_loss)]
                    let y = -(index as f32 * font_size * LINE_HEIGHT + font_size);
                    let _ = writeln!(
                        ops,
                        "1 0 0 1 {} {} Tm {} Tj",
                        num(x),
                        num(y),
                        literal(line)?
                    );
                }
                ops.push_str("ET\n");
            }
            AnnotationBody::Image { .. } => {
                let asset = obj
                    .image
                    .as_ref()
                    .ok_or_else(|| failed("image asset missing"))?;
                let key = match image_names.get(&(Arc::as_ptr(asset) as usize)) {
                    Some(key) => key.clone(),
                    None => {
                        let key = unique(&drawing.xobjects, "SheerIm");
                        let id = image_object(doc, asset)?;
                        drawing
                            .xobjects
                            .set(key.as_bytes().to_vec(), Object::Reference(id));
                        image_names.insert(Arc::as_ptr(asset) as usize, key.clone());
                        key
                    }
                };
                let _ = write!(
                    ops,
                    "{} 0 0 {} 0 {} cm\n/{key} Do\n",
                    num(w),
                    num(h),
                    num(-h)
                );
            }
            _ => continue,
        }
        ops.push_str("Q\n");
        drawing.ops.push_str(&ops);
    }
    Ok(drawing)
}

fn line_x(align: TextAlign, font: StdFont, line: &str, size: f32, width: f32) -> f32 {
    let line_width = text_width(font, line, size);
    match align {
        TextAlign::Left => 0.0,
        TextAlign::Center => ((width - line_width) / 2.0).max(0.0),
        TextAlign::Right => (width - line_width).max(0.0),
    }
}

/// The image XObject of `asset` (with its `/SMask` when it has alpha) added to `doc`.
fn image_object(doc: &mut Document, asset: &ImageAsset) -> Result<ObjectId, AppError> {
    let base = |space: &str, filter: &str| {
        let mut dict = Dictionary::new();
        dict.set("Type", name("XObject"));
        dict.set("Subtype", name("Image"));
        dict.set("Width", i64::from(asset.width));
        dict.set("Height", i64::from(asset.height));
        dict.set("ColorSpace", name(space));
        dict.set("BitsPerComponent", 8);
        dict.set("Filter", name(filter));
        dict
    };
    match &asset.pixels {
        Pixels::Jpeg(bytes) => {
            Ok(doc.add_object(Stream::new(base("DeviceRGB", "DCTDecode"), bytes.clone())))
        }
        Pixels::Flate { rgb, alpha } => {
            let mask = doc.add_object(Stream::new(
                base("DeviceGray", "FlateDecode"),
                alpha.clone(),
            ));
            let mut dict = base("DeviceRGB", "FlateDecode");
            dict.set("SMask", Object::Reference(mask));
            Ok(doc.add_object(Stream::new(dict, rgb.clone())))
        }
    }
}

fn write_page(
    doc: &mut Document,
    page: ObjectId,
    source: PageSource,
    objs: &[ContentObject],
) -> Result<(), AppError> {
    let drawing = draw(doc, &source, objs)?;
    if drawing.ops.is_empty() {
        return Ok(());
    }
    let stream = |bytes: Vec<u8>| Stream::new(Dictionary::new(), bytes);
    let open = doc.add_object(stream(b"q\n".to_vec()));
    let mut ours = b"Q\n".to_vec();
    ours.extend_from_slice(drawing.ops.as_bytes());
    let close = doc.add_object(stream(ours));
    let mut contents = Vec::with_capacity(source.contents.len() + 2);
    contents.push(Object::Reference(open));
    contents.extend(source.contents);
    contents.push(Object::Reference(close));
    let mut resources = source.resources;
    resources.set("Font", Object::Dictionary(drawing.fonts));
    resources.set("XObject", Object::Dictionary(drawing.xobjects));
    resources.set("ExtGState", Object::Dictionary(drawing.gstates));
    let mut dict = source.dict;
    dict.set("Contents", Object::Array(contents));
    dict.set("Resources", Object::Dictionary(resources));
    doc.set_object(page, Object::Dictionary(dict));
    Ok(())
}

/// Wraps the page's content in `q … Q` and appends one stream that draws `objs` in creation order (text clipped to its box, images
/// with opacity through an `/ExtGState`). `doc` is a full rewrite; the page dictionary and its `/Resources` are written again.
pub fn burn(doc: &mut Document, page: ObjectId, objs: &[ContentObject]) -> Result<(), AppError> {
    let source = read_page(doc, page)?;
    write_page(doc, page, source, objs)
}

/// [`burn`] for a saved file: `original` (not encrypted) gets an update that holds the changed page dictionaries and the new streams.
/// `content` is what the save plan holds; an object whose page is not in the file is skipped.
pub fn burn_all(
    original: Vec<u8>,
    content: &[(PageId, Vec<ContentObject>)],
) -> Result<Vec<u8>, AppError> {
    if content.iter().all(|(_, objs)| objs.is_empty()) {
        return Ok(original);
    }
    let doc = super::prescan::load_untrusted(&original)?;
    if doc.is_encrypted() {
        return Err(AppError::new(ErrorCode::UnsupportedFeature));
    }
    let pages = doc.get_pages();
    let mut inc = IncrementalDocument::create_from(original, doc);
    for (_, objs) in content {
        let Some(first) = objs.first() else {
            continue;
        };
        let Some(page) = pages.get(&first.index.saturating_add(1)).copied() else {
            continue;
        };
        let source = read_page(inc.get_prev_documents(), page)?;
        write_page(&mut inc.new_document, page, source, objs)?;
    }
    let mut bytes = Vec::new();
    inc.save_to(&mut bytes).map_err(failed)?;
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_are_short_and_finite() {
        assert_eq!(num(12.0), "12");
        assert_eq!(num(0.5), "0.5");
        assert_eq!(num(-0.0001), "0");
        assert_eq!(num(f32::NAN), "0");
    }

    #[test]
    fn strings_are_escaped_and_winansi() {
        assert_eq!(literal("a(b)\\").unwrap(), "(a\\(b\\)\\\\)");
        assert_eq!(literal("ä").unwrap(), "(\\344)");
        assert!(literal("中").is_err());
    }

    #[test]
    fn the_frame_hangs_from_the_displayed_top_left() {
        let rect = [10.0, 20.0, 110.0, 70.0];
        assert_eq!(frame(rect, 0), [1.0, 0.0, 0.0, 1.0, 10.0, 70.0]);
        assert_eq!(frame(rect, 90)[4..], [10.0, 20.0]);
        assert_eq!(frame(rect, 180)[4..], [110.0, 20.0]);
        assert_eq!(frame(rect, 270)[4..], [110.0, 70.0]);
    }
}
