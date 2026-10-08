//! The reply links and review states of a page's annotations as the file has them (`/IRT`, `/StateModel /Review`, `/State`).
//!
//! PDFium does not say which annotation a reply points at or what state it gives, so the model reads both here, with lopdf, after the
//! engine has read the page. The positions are the engine's (every dictionary of `/Annots` counts, popups do not; `Slots::read`).
//! A file is hostile input: the page's array is capped, a link that does not point into the array is dropped, and anything that is not
//! a state of the Review model is ignored.

use std::collections::HashMap;

use lopdf::{Dictionary, Document, Object, ObjectId};

use crate::error::AppError;
use crate::limits;
use crate::model::annotation::ReviewState;

/// What an annotation of the file says about its place in a thread.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ReviewLink {
    /// The position of the annotation it replies to.
    pub reply_to: Option<u32>,
    /// The review state it gives that annotation.
    pub state: Option<ReviewState>,
}

fn is_popup(dict: &Dictionary) -> bool {
    matches!(dict.get(b"Subtype"), Ok(Object::Name(name)) if name == b"Popup")
}

/// Longest `/State` or `/StateModel` that is read: the words of the Review and Marked models are far shorter, so a longer string is not one
/// and is not even copied.
const MAX_STATE_BYTES: usize = 16;

fn text(doc: &Document, dict: &Dictionary, key: &[u8]) -> Option<Vec<u8>> {
    match doc.dereference(dict.get(key).ok()?).ok()?.1 {
        Object::String(bytes, _) | Object::Name(bytes) if bytes.len() <= MAX_STATE_BYTES => {
            Some(bytes.clone())
        }
        _ => None,
    }
}

/// The links of the annotations of page `page_index` of `bytes`, by position (only those that reply to something or give a state).
pub fn read_page(bytes: &[u8], page_index: u32) -> Result<HashMap<u32, ReviewLink>, AppError> {
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
    let mut counted: Vec<(Option<ObjectId>, &Dictionary)> = Vec::new();
    for entry in &entries {
        let Ok((id, Object::Dictionary(dict))) = doc.dereference(entry) else {
            continue;
        };
        if !is_popup(dict) {
            counted.push((entry.as_reference().ok().or(id), dict));
        }
    }
    let positions: HashMap<ObjectId, u32> = counted
        .iter()
        .zip(0u32..)
        .filter_map(|((id, _), position)| id.map(|id| (id, position)))
        .collect();
    let mut links = HashMap::new();
    for ((_, dict), position) in counted.iter().zip(0u32..) {
        let link = link_of(&doc, dict, position, &positions);
        if link != ReviewLink::default() {
            links.insert(position, link);
        }
    }
    break_cycles(&mut links);
    Ok(links)
}

/// Takes the reply link off every annotation that is on a cycle of replies (A replies to B and B to A, or a longer ring): such a link
/// has no parent to hang under. The annotations that merely reply into a ring keep their link (the ring's members are roots).
pub(super) fn break_cycles(links: &mut HashMap<u32, ReviewLink>) {
    let mut on_cycle = Vec::new();
    for start in links.keys() {
        let mut at = *start;
        // A walk longer than the number of links has entered a ring.
        for _ in 0..=links.len() {
            match links.get(&at).and_then(|link| link.reply_to) {
                Some(parent) => at = parent,
                None => break,
            }
            if at == *start {
                on_cycle.push(*start);
                break;
            }
        }
    }
    for position in on_cycle {
        if let Some(link) = links.get_mut(&position) {
            link.reply_to = None;
        }
    }
    links.retain(|_, link| *link != ReviewLink::default());
}

/// The link of the annotation `dict` at `position`: what it replies to (`positions` maps the object ids of the page's annotations to
/// their position) and the review state it gives.
pub(super) fn link_of(
    doc: &Document,
    dict: &Dictionary,
    position: u32,
    positions: &HashMap<ObjectId, u32>,
) -> ReviewLink {
    let reply_to = dict
        .get(b"IRT")
        .ok()
        .and_then(|object| object.as_reference().ok())
        .and_then(|id| positions.get(&id).copied())
        .filter(|parent| *parent != position);
    let model = text(doc, dict, b"StateModel");
    let state = match model.as_deref() {
        Some(b"Review") | None => text(doc, dict, b"State").and_then(|s| ReviewState::from_pdf(&s)),
        Some(_) => None,
    };
    // A `/StateModel` too long to be read is not the Review model either.
    let state = if model.is_none() && dict.has(b"StateModel") {
        None
    } else {
        state
    };
    ReviewLink { reply_to, state }
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::dictionary;

    fn file(annots: Vec<Dictionary>) -> Vec<u8> {
        let mut doc = Document::with_version("1.7");
        let pages_id = doc.new_object_id();
        let refs: Vec<Object> = annots
            .into_iter()
            .map(|dict| Object::Reference(doc.add_object(dict)))
            .collect();
        let page = doc.add_object(dictionary! {
            "Type" => "Page", "Parent" => pages_id, "MediaBox" => vec![0.into(), 0.into(), 100.into(), 100.into()],
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

    #[test]
    fn replies_and_states_are_read_by_position_and_popups_do_not_count() {
        // Object numbers in `file` follow the order of the list: 2 (first) is the number after the Pages id (1).
        let bytes = file(vec![
            dictionary! {"Subtype" => "Highlight", "Contents" => Object::string_literal("hello")},
            dictionary! {"Subtype" => "Popup"},
            dictionary! {"Subtype" => "Text", "IRT" => Object::Reference((2, 0)), "StateModel" => Object::string_literal("Review"), "State" => Object::string_literal("Completed")},
            dictionary! {"Subtype" => "Text", "IRT" => Object::Reference((2, 0)), "StateModel" => Object::string_literal("Marked"), "State" => Object::string_literal("Marked")},
            dictionary! {"Subtype" => "Text", "IRT" => Object::Reference((99, 0))},
        ]);
        let links = read_page(&bytes, 0).unwrap();
        assert_eq!(links.get(&0), None);
        assert_eq!(
            links.get(&1),
            Some(&ReviewLink {
                reply_to: Some(0),
                state: Some(ReviewState::Completed)
            })
        );
        assert_eq!(
            links.get(&2),
            Some(&ReviewLink {
                reply_to: Some(0),
                state: None
            }),
            "a state of another model is not a review state"
        );
        assert_eq!(links.get(&3), None, "a link that points nowhere is dropped");
        assert!(read_page(&bytes, 5).unwrap().is_empty());
    }

    #[test]
    fn a_state_string_longer_than_a_state_word_is_ignored() {
        let long = Object::String(vec![b'C'; 5_000_000 / 100], lopdf::StringFormat::Literal);
        let bytes = file(vec![
            dictionary! {"Subtype" => "Highlight"},
            dictionary! {"Subtype" => "Text", "IRT" => Object::Reference((2, 0)), "State" => long.clone()},
            dictionary! {"Subtype" => "Text", "IRT" => Object::Reference((2, 0)), "StateModel" => long, "State" => Object::string_literal("Completed")},
        ]);
        let links = read_page(&bytes, 0).unwrap();
        // Both still reply; neither gives a state.
        assert_eq!(
            links.get(&1),
            Some(&ReviewLink {
                reply_to: Some(0),
                state: None
            })
        );
        assert_eq!(
            links.get(&2),
            Some(&ReviewLink {
                reply_to: Some(0),
                state: None
            })
        );
    }

    #[test]
    fn replies_that_point_at_each_other_are_refused() {
        // A (1) replies to B (2) and B to A: a cycle, no link; a third replies to itself; a fourth replies into the ring and keeps its link.
        let bytes = file(vec![
            dictionary! {"Subtype" => "Text", "IRT" => Object::Reference((3, 0))},
            dictionary! {"Subtype" => "Text", "IRT" => Object::Reference((2, 0))},
            dictionary! {"Subtype" => "Text", "IRT" => Object::Reference((4, 0))},
            dictionary! {"Subtype" => "Text", "IRT" => Object::Reference((2, 0))},
        ]);
        let links = read_page(&bytes, 0).unwrap();
        assert_eq!(links.get(&0), None, "a cycle is no thread");
        assert_eq!(links.get(&1), None);
        assert_eq!(links.get(&3).and_then(|l| l.reply_to), Some(0));
        assert_eq!(links.get(&2), None, "a reply to itself is no reply");
    }
}
