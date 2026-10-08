//! The geometry of the `Line` annotations of a page as the file has them (`/L`, `/LE`, `/BS /W`), so a line or an arrow made here (or by
//! another program) comes back editable instead of opaque (ADR-114).
//!
//! PDFium names no accessor for `/L` and `/LE`, so the model reads them here, with lopdf, after the engine has read the page; the
//! positions are the engine's (every dictionary of `/Annots` counts, popups do not, as in `reviews`). A file is hostile input: the
//! array is capped, a number that is not finite or a line that is out of range is skipped (it stays opaque), and an ending the model
//! has no name for is `None`.

use std::collections::HashMap;

use lopdf::{Dictionary, Document, Object};

use crate::error::AppError;
use crate::limits;
use crate::model::annotation::{AnnotationBody, Imported, LineEnd};
use crate::model::geometry::Point;

/// What the file says about one line annotation, in user space.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LineRead {
    /// `/L`: start x, start y, end x, end y.
    pub l: [f32; 4],
    /// `/Rect`: left, bottom, right, top (normalised).
    pub rect: [f32; 4],
    pub width: f32,
    /// The ending at the start of the line, then the one at its end.
    pub ends: [LineEnd; 2],
}

fn numbers(doc: &Document, dict: &Dictionary, key: &[u8]) -> Vec<f32> {
    let Ok(Object::Array(items)) = dict
        .get(key)
        .and_then(|object| doc.dereference(object).map(|(_, o)| o))
    else {
        return Vec::new();
    };
    items
        .iter()
        .take(8)
        .filter_map(|item| doc.dereference(item).ok()?.1.as_float().ok())
        .collect()
}

fn end_of(object: Option<&Object>) -> LineEnd {
    match object {
        Some(Object::Name(name)) if name == b"OpenArrow" => LineEnd::OpenArrow,
        Some(Object::Name(name)) if name == b"ClosedArrow" => LineEnd::ClosedArrow,
        _ => LineEnd::None,
    }
}

fn width_of(doc: &Document, dict: &Dictionary) -> f32 {
    let from_style = dict
        .get(b"BS")
        .and_then(|style| doc.dereference(style).map(|(_, o)| o))
        .and_then(Object::as_dict)
        .and_then(|style| style.get(b"W"))
        // `/BS` and its `/W` may be indirect objects.
        .and_then(|width| doc.dereference(width).map(|(_, o)| o))
        .and_then(Object::as_float)
        .ok();
    let width = from_style
        .or_else(|| numbers(doc, dict, b"Border").get(2).copied())
        .unwrap_or(1.0);
    if width.is_finite() && width > 0.0 {
        width.min(limits::MAX_ANNOT_STROKE_PT)
    } else {
        1.0
    }
}

pub(super) fn read_line(doc: &Document, dict: &Dictionary) -> Option<LineRead> {
    let l = numbers(doc, dict, b"L");
    let rect = numbers(doc, dict, b"Rect");
    let [x0, y0, x1, y1] = l.get(..4)?.try_into().ok()?;
    let [ra, rb, rc, rd]: [f32; 4] = rect.get(..4)?.try_into().ok()?;
    let range = limits::MAX_PAGE_SIDE_PT * 4.0;
    if ![x0, y0, x1, y1, ra, rb, rc, rd]
        .iter()
        .all(|v| v.is_finite() && v.abs() <= range)
    {
        return None;
    }
    let ends = match dict
        .get(b"LE")
        .and_then(|object| doc.dereference(object).map(|(_, o)| o))
    {
        Ok(Object::Array(items)) => [end_of(items.first()), end_of(items.get(1))],
        Ok(name @ Object::Name(_)) => [end_of(Some(name)); 2],
        _ => [LineEnd::None; 2],
    };
    Some(LineRead {
        l: [x0, y0, x1, y1],
        rect: [ra.min(rc), rb.min(rd), ra.max(rc), rb.max(rd)],
        width: width_of(doc, dict),
        ends,
    })
}

/// The lines of page `page_index` of `bytes`, by position (only the `Line` annotations that could be read).
pub fn read_page(bytes: &[u8], page_index: u32) -> Result<HashMap<u32, LineRead>, AppError> {
    let doc = super::prescan::load_untrusted(bytes)?;
    let pages = doc.get_pages();
    let Some(page_id) = pages.get(&page_index.saturating_add(1)) else {
        return Ok(HashMap::new());
    };
    let Ok(page) = doc.get_dictionary(*page_id) else {
        return Ok(HashMap::new());
    };
    let entries: Vec<Object> = match page
        .get(b"Annots")
        .ok()
        .and_then(|annots| doc.dereference(annots).ok())
        .map(|(_, object)| object)
    {
        Some(Object::Array(array)) => array
            .iter()
            .take(limits::MAX_ANNOTS_ARRAY)
            .cloned()
            .collect(),
        _ => return Ok(HashMap::new()),
    };
    let mut lines = HashMap::new();
    let mut position = 0u32;
    for entry in &entries {
        let Ok((_, Object::Dictionary(dict))) = doc.dereference(entry) else {
            continue;
        };
        let subtype = dict.get(b"Subtype").ok().and_then(|s| s.as_name().ok());
        if subtype == Some(b"Popup".as_slice()) {
            continue;
        }
        if subtype == Some(b"Line".as_slice()) {
            if let Some(read) = read_line(&doc, dict) {
                lines.insert(position, read);
            }
        }
        position += 1;
    }
    Ok(lines)
}

/// Turns an opaque `Line` import into a [`AnnotationBody::Line`] with the geometry the file has. The points are put on the page the
/// way the engine put the rectangle: by the offset between `/Rect` and the imported rectangle, with y turned. Anything else is left.
pub fn lift(item: &mut Imported, read: &LineRead) {
    if !matches!(&item.body, AnnotationBody::Opaque { subtype } if subtype == "Line") {
        return;
    }
    let [left, _, _, top] = read.rect;
    let at = |x: f32, y: f32| Point {
        x: item.rect.x + (x - left),
        y: item.rect.y + (top - y),
    };
    let [x0, y0, x1, y1] = read.l;
    item.body = AnnotationBody::Line {
        from: at(x0, y0),
        to: at(x1, y1),
        width: read.width,
        head: read.ends[1],
        tail: read.ends[0],
    };
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::annotation::{PdfOrigin, Rgb};
    use crate::model::geometry::Rect;
    use lopdf::dictionary;

    fn file(annots: Vec<Dictionary>) -> Vec<u8> {
        let mut doc = Document::with_version("1.7");
        let pages_id = doc.new_object_id();
        let refs: Vec<Object> = annots
            .into_iter()
            .map(|dict| Object::Reference(doc.add_object(dict)))
            .collect();
        let page = doc.add_object(dictionary! {
            "Type" => "Page", "Parent" => pages_id, "MediaBox" => vec![0.into(), 0.into(), 200.into(), 200.into()],
            "Annots" => refs,
        });
        doc.objects.insert(
            pages_id,
            Object::Dictionary(
                dictionary! {"Type" => "Pages", "Kids" => vec![page.into()], "Count" => 1},
            ),
        );
        let catalog = doc.add_object(dictionary! {"Type" => "Catalog", "Pages" => pages_id});
        doc.trailer.set("Root", catalog);
        let mut out = Vec::new();
        doc.save_to(&mut out).unwrap();
        out
    }

    fn reals(values: [f32; 4]) -> Object {
        Object::Array(values.iter().map(|v| Object::Real(*v)).collect())
    }

    fn line(l: [f32; 4], rect: [f32; 4], le: Object) -> Dictionary {
        dictionary! {
            "Subtype" => "Line",
            "L" => reals(l),
            "Rect" => reals(rect),
            "LE" => le,
            "BS" => dictionary! {"W" => 3.0},
        }
    }

    fn opaque(rect: Rect) -> Imported {
        Imported {
            origin: PdfOrigin {
                page_index: 0,
                annot_index: 0,
                name: None,
            },
            body: AnnotationBody::Opaque {
                subtype: "Line".into(),
            },
            rect,
            color: Rgb([0, 0, 0]),
            opacity: 1.0,
            contents: String::new(),
            author: None,
            modified: None,
            locked: false,
            hidden: false,
        }
    }

    #[test]
    fn a_line_is_read_by_position_with_its_endings_and_width() {
        let bytes = file(vec![
            dictionary! {"Subtype" => "Highlight"},
            dictionary! {"Subtype" => "Popup"},
            line(
                [20.0, 150.0, 120.0, 150.0],
                [10.0, 140.0, 130.0, 160.0],
                Object::Array(vec![
                    Object::Name(b"None".to_vec()),
                    Object::Name(b"OpenArrow".to_vec()),
                ]),
            ),
            line(
                [f32::NAN, 0.0, 1.0, 1.0],
                [0.0, 0.0, 2.0, 2.0],
                Object::Null,
            ),
        ]);
        let lines = read_page(&bytes, 0).unwrap();
        assert_eq!(
            lines.len(),
            1,
            "popups do not count and a bad line is skipped"
        );
        let read = lines.get(&1).unwrap();
        assert_eq!(read.ends, [LineEnd::None, LineEnd::OpenArrow]);
        assert_eq!(read.width, 3.0);
        assert!(read_page(&bytes, 4).unwrap().is_empty());
    }

    #[test]
    fn width_and_endings_follow_references_and_a_single_ending_name() {
        let mut doc = Document::with_version("1.7");
        let width = doc.add_object(Object::Real(4.0));
        let style = doc.add_object(dictionary! {"W" => width});
        let le = doc.add_object(Object::Name(b"ClosedArrow".to_vec()));
        let dict = dictionary! {"Subtype" => "Line", "L" => reals([0.0, 0.0, 10.0, 10.0]), "Rect" => reals([0.0, 0.0, 10.0, 10.0]),
        "BS" => style, "LE" => le};
        let read = read_line(&doc, &dict).unwrap();
        assert_eq!(read.width, 4.0);
        assert_eq!(read.ends, [LineEnd::ClosedArrow; 2]);
        // A /W that is not a number, zero or huge falls back to 1 or the cap.
        for (bad, expected) in [
            (Object::Name(b"x".to_vec()), 1.0),
            (Object::Real(0.0), 1.0),
            (Object::Real(1e9), limits::MAX_ANNOT_STROKE_PT),
            (Object::Real(f32::NAN), 1.0),
        ] {
            let dict = dictionary! {"Subtype" => "Line", "L" => reals([0.0, 0.0, 10.0, 10.0]),
            "Rect" => reals([0.0, 0.0, 10.0, 10.0]), "BS" => dictionary! {"W" => bad}};
            assert_eq!(read_line(&doc, &dict).unwrap().width, expected);
        }
    }

    #[test]
    fn a_hostile_l_array_leaves_the_line_opaque() {
        let doc = Document::with_version("1.7");
        let rect = reals([0.0, 0.0, 10.0, 10.0]);
        let hostile = [
            // Too short, wrong types, out of range, infinite, a loop of its own size.
            Object::Array(vec![Object::Real(1.0); 3]),
            Object::Array(vec![Object::string_literal("a"); 4]),
            reals([0.0, 0.0, 1e12, 1.0]),
            reals([f32::INFINITY, 0.0, 1.0, 1.0]),
            Object::Array(Vec::new()),
            Object::Null,
            Object::Integer(7),
        ];
        for l in hostile {
            let dict = dictionary! {"Subtype" => "Line", "L" => l, "Rect" => rect.clone()};
            assert!(read_line(&doc, &dict).is_none());
        }
        // More than four numbers are read as the first four; a huge array is cut at eight values.
        let long = Object::Array((0..10_000).map(|n| Object::Integer(n % 5)).collect());
        let dict = dictionary! {"Subtype" => "Line", "L" => long, "Rect" => rect};
        assert!(read_line(&doc, &dict).is_some());
    }

    #[test]
    fn lifting_puts_the_points_where_the_rectangle_is_with_y_turned() {
        let read = LineRead {
            l: [20.0, 150.0, 120.0, 130.0],
            rect: [10.0, 125.0, 130.0, 155.0],
            width: 2.0,
            ends: [LineEnd::None, LineEnd::OpenArrow],
        };
        // The page is 200 high: the rectangle's top (155) is at y = 45.
        let mut item = opaque(Rect {
            x: 10.0,
            y: 45.0,
            w: 120.0,
            h: 30.0,
        });
        lift(&mut item, &read);
        assert_eq!(
            item.body,
            AnnotationBody::Line {
                from: Point { x: 20.0, y: 50.0 },
                to: Point { x: 120.0, y: 70.0 },
                width: 2.0,
                head: LineEnd::OpenArrow,
                tail: LineEnd::None,
            }
        );
        // Another kind is left alone.
        let mut other = opaque(Rect {
            x: 0.0,
            y: 0.0,
            w: 1.0,
            h: 1.0,
        });
        other.body = AnnotationBody::Opaque {
            subtype: "Ink".into(),
        };
        let before = other.clone();
        lift(&mut other, &read);
        assert_eq!(other, before);
    }
}
