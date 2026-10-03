//! A look at the annotations a file holds, for the checks of a save and for tests that must not use lopdf themselves: the subtype, the
//! rectangle, the `/NM`, the quads, and whether the annotation has a normal appearance that is a stream.

use lopdf::{Dictionary, Document, Object};

use crate::error::AppError;

/// One annotation of a page, as the file has it.
#[derive(Debug, Clone, PartialEq)]
pub struct Summary {
    pub page_index: u32,
    pub subtype: String,
    pub has_appearance: bool,
    pub rect: [f32; 4],
    pub name: Option<String>,
    pub quad_points: Vec<f32>,
    /// Whether `/IRT` is a reference.
    pub is_reply: bool,
    /// `/CA`, the constant opacity.
    pub opacity: Option<f32>,
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
        .filter_map(|item| doc.dereference(item).ok()?.1.as_float().ok())
        .collect()
}

/// The annotations of every page of `bytes`, in page order and the order of the page's `/Annots` (popups included).
pub fn list_annotations(bytes: &[u8]) -> Result<Vec<Summary>, AppError> {
    let doc = super::prescan::load_untrusted(bytes)?;
    let mut out = Vec::new();
    for (number, page_id) in doc.get_pages() {
        for dict in doc.get_page_annotations(page_id).unwrap_or_default() {
            let subtype = dict
                .get(b"Subtype")
                .and_then(Object::as_name)
                .map(|name| String::from_utf8_lossy(name).into_owned())
                .unwrap_or_default();
            let has_appearance = dict
                .get(b"AP")
                .and_then(|object| doc.dereference(object).map(|(_, o)| o))
                .and_then(Object::as_dict)
                .and_then(|ap| ap.get(b"N"))
                .and_then(|object| doc.dereference(object).map(|(_, o)| o))
                .is_ok_and(|normal| matches!(normal, Object::Stream(_)));
            let rect = numbers(&doc, dict, b"Rect");
            out.push(Summary {
                page_index: number - 1,
                subtype,
                has_appearance,
                rect: [
                    rect.first().copied().unwrap_or(0.0),
                    rect.get(1).copied().unwrap_or(0.0),
                    rect.get(2).copied().unwrap_or(0.0),
                    rect.get(3).copied().unwrap_or(0.0),
                ],
                name: match dict.get(b"NM") {
                    Ok(Object::String(bytes, _)) => {
                        Some(String::from_utf8_lossy(bytes).into_owned())
                    }
                    _ => None,
                },
                quad_points: numbers(&doc, dict, b"QuadPoints"),
                is_reply: matches!(dict.get(b"IRT"), Ok(Object::Reference(_))),
                opacity: dict.get(b"CA").and_then(Object::as_float).ok(),
            });
        }
    }
    Ok(out)
}
