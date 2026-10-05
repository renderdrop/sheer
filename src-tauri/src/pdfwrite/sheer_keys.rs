//! The Sheer keys of an annotation (ADR-119): `/SHR_Cite << /V 1 /Q (quote) /G (group) >>` on a Highlight that is a citation, and
//! `/SHR_Tags [(name) ...]` on any markup annotation.
//!
//! PDFium does not report custom keys, so the model reads them here, with lopdf, after the engine has read the page; the positions are the
//! engine's (every dictionary of `/Annots` counts, popups do not), as in `reviews`. A file is hostile input: the page's array is capped,
//! a value of the wrong type or size, or a `/V` other than 1, is ignored (the annotation then reads as a plain highlight), and nothing
//! here panics. [`write`] sets both keys afresh from the model on every annotation the model writes; an annotation it does not write
//! (unchanged, or on a page it did not read) keeps its dictionary and so its keys.

use std::collections::HashMap;

use lopdf::{Dictionary, Document, Object, ObjectId};

use crate::error::AppError;
use crate::limits;
use crate::model::annotation::{Annotation, AnnotationBody};
use crate::model::quote::{self, Cite};

use super::annots::text_string;
use super::forms::decode_text;

/// What an annotation of the file says about being a citation and about its tags.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SheerKeys {
    pub cite: Option<Cite>,
    pub tags: Vec<String>,
}

/// Most bytes of a string that is decoded: the longest wanted text in UTF-16 (two bytes a unit, supplementary characters four) with its
/// byte order mark. A longer string is not a text of ours and is not even copied.
const fn raw_cap(chars: usize) -> usize {
    chars * 4 + 8
}

/// Most entries of `/SHR_Tags` that are looked at (names beyond [`limits::TAGS_PER_ANNOT`] valid ones are ignored anyway).
const MAX_TAG_ENTRIES: usize = 4 * limits::TAGS_PER_ANNOT;

fn is_popup(dict: &Dictionary) -> bool {
    matches!(dict.get(b"Subtype"), Ok(Object::Name(name)) if name == b"Popup")
}

fn resolve<'a>(doc: &'a Document, object: &'a Object) -> Option<&'a Object> {
    doc.dereference(object).ok().map(|(_, object)| object)
}

fn string_of(doc: &Document, object: &Object, max_chars: usize) -> Option<String> {
    match resolve(doc, object)? {
        Object::String(bytes, _) | Object::Name(bytes) if bytes.len() <= raw_cap(max_chars) => {
            Some(decode_text(bytes, max_chars))
        }
        _ => None,
    }
}

/// `/SHR_Cite` of `dict` if it is a well-formed cite record of version 1.
fn read_cite(doc: &Document, dict: &Dictionary) -> Option<Cite> {
    let Object::Dictionary(cite) = resolve(doc, dict.get(b"SHR_Cite").ok()?)? else {
        return None;
    };
    // A version we do not know may mean something else: the annotation reads as a plain highlight.
    match resolve(doc, cite.get(b"V").ok()?)? {
        Object::Integer(1) => {}
        _ => return None,
    }
    let quote = quote::normalize_quote(&string_of(
        doc,
        cite.get(b"Q").ok()?,
        limits::CITE_QUOTE_MAX,
    )?);
    quote::check_quote(&quote).ok()?;
    let group = cite
        .get(b"G")
        .ok()
        .and_then(|group| string_of(doc, group, 8))
        .filter(|group| quote::is_group_id(group));
    Some(Cite { quote, group })
}

/// `/SHR_Tags` of `dict`: the names that are texts of a valid length, at most [`limits::TAGS_PER_ANNOT`], without repeats.
fn read_tags(doc: &Document, dict: &Dictionary) -> Vec<String> {
    let Some(Object::Array(entries)) = dict.get(b"SHR_Tags").ok().and_then(|o| resolve(doc, o))
    else {
        return Vec::new();
    };
    crate::model::tags::clean_names_lenient(
        entries
            .iter()
            .take(MAX_TAG_ENTRIES)
            .filter_map(|entry| string_of(doc, entry, limits::TAG_NAME_MAX)),
    )
}

/// The Sheer keys of the annotations of the pages `page_indices` of `bytes` (parsed once), by page index, then by position (only
/// annotations that have any). A page that is not in the file is absent.
pub fn read_pages(
    bytes: &[u8],
    page_indices: &[u32],
) -> Result<HashMap<u32, HashMap<u32, SheerKeys>>, AppError> {
    let doc = super::prescan::load_untrusted(bytes)?;
    Ok(read_pages_of(&doc, page_indices))
}

/// [`read_pages`] of a document that is loaded already (a decrypted one, say).
pub fn read_pages_of(
    doc: &Document,
    page_indices: &[u32],
) -> HashMap<u32, HashMap<u32, SheerKeys>> {
    let pages = doc.get_pages();
    let mut out = HashMap::new();
    for &page_index in page_indices {
        if let Some(page_id) = pages.get(&page_index.saturating_add(1)) {
            out.insert(page_index, read_one(doc, *page_id));
        }
    }
    out
}

/// The Sheer keys of the annotations of page `page_index` of `bytes`, by position (only those that have any).
pub fn read_page(bytes: &[u8], page_index: u32) -> Result<HashMap<u32, SheerKeys>, AppError> {
    Ok(read_pages(bytes, &[page_index])?
        .remove(&page_index)
        .unwrap_or_default())
}

fn read_one(doc: &Document, page_id: ObjectId) -> HashMap<u32, SheerKeys> {
    let Ok(page) = doc.get_dictionary(page_id) else {
        return HashMap::new();
    };
    let entries: Vec<&Object> = match page.get(b"Annots").ok().and_then(|a| resolve(doc, a)) {
        Some(Object::Array(array)) => array.iter().take(limits::MAX_ANNOTS_ARRAY).collect(),
        _ => return HashMap::new(),
    };
    let mut keys = HashMap::new();
    let mut position = 0u32;
    for entry in entries {
        let Some(Object::Dictionary(dict)) = resolve(doc, entry) else {
            continue;
        };
        if is_popup(dict) {
            continue;
        }
        let is_highlight =
            matches!(dict.get(b"Subtype"), Ok(Object::Name(name)) if name == b"Highlight");
        let found = SheerKeys {
            cite: if is_highlight {
                read_cite(doc, dict)
            } else {
                None
            },
            tags: read_tags(doc, dict),
        };
        if found.cite.is_some() || !found.tags.is_empty() {
            keys.insert(position, found);
        }
        position = position.saturating_add(1);
    }
    keys
}

/// Sets `/SHR_Cite` and `/SHR_Tags` of `dict` from `annotation`, and takes them off where the model has none (the user removed them).
/// With `keys_known` false (the model could not read the keys of this annotation: an encrypted file) the keys the file has stay, and the
/// model only sets what it has.
pub fn write(dict: &mut Dictionary, annotation: &Annotation, keys_known: bool) {
    if keys_known {
        dict.remove(b"SHR_Cite");
        dict.remove(b"SHR_Tags");
    }
    if let (Some(cite), AnnotationBody::Highlight { .. }) = (&annotation.cite, &annotation.body) {
        let mut record = Dictionary::new();
        record.set("V", Object::Integer(1));
        record.set("Q", text_string(&cite.quote));
        if let Some(group) = &cite.group {
            record.set("G", text_string(group));
        }
        dict.set("SHR_Cite", Object::Dictionary(record));
    }
    if !annotation.tags.is_empty() {
        dict.set(
            "SHR_Tags",
            Object::Array(
                annotation
                    .tags
                    .iter()
                    .take(limits::TAGS_PER_ANNOT)
                    .map(|tag| text_string(tag))
                    .collect(),
            ),
        );
    }
}

/// Whether the dictionary at `id` of `doc` carries a Sheer key (for tests and for callers that keep a page as it is).
pub fn has_keys(doc: &Document, id: ObjectId) -> bool {
    doc.get_dictionary(id)
        .is_ok_and(|dict| dict.has(b"SHR_Cite") || dict.has(b"SHR_Tags"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::{dictionary, StringFormat};

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

    fn s(text: &str) -> Object {
        Object::string_literal(text)
    }

    fn cite(v: Object, q: Object, g: Option<Object>) -> Object {
        let mut dict = dictionary! {"V" => v, "Q" => q};
        if let Some(g) = g {
            dict.set("G", g);
        }
        Object::Dictionary(dict)
    }

    #[test]
    fn a_cite_and_tags_are_read_by_position_and_popups_do_not_count() {
        let bytes = file(vec![
            dictionary! {"Subtype" => "Highlight", "SHR_Cite" => cite(1.into(), s("the quote"), Some(s("0a1b2c3d"))),
            "SHR_Tags" => vec![s("Method"), s("method"), s("Idea")]},
            dictionary! {"Subtype" => "Popup"},
            dictionary! {"Subtype" => "Underline", "SHR_Tags" => vec![s("x")],
            "SHR_Cite" => cite(1.into(), s("not a highlight"), None)},
            dictionary! {"Subtype" => "Highlight"},
        ]);
        let keys = read_page(&bytes, 0).unwrap();
        assert_eq!(
            keys.get(&0),
            Some(&SheerKeys {
                cite: Some(Cite {
                    quote: "the quote".into(),
                    group: Some("0a1b2c3d".into())
                }),
                tags: vec!["Method".into(), "Idea".into()],
            })
        );
        assert_eq!(
            keys.get(&1),
            Some(&SheerKeys {
                cite: None,
                tags: vec!["x".into()]
            }),
            "a cite on another kind is not read"
        );
        assert_eq!(keys.get(&2), None);
        assert!(read_page(&bytes, 9).unwrap().is_empty());
    }

    #[test]
    fn utf16_text_is_decoded() {
        let mut units = vec![0xFE, 0xFF];
        for u in "Größe €".encode_utf16() {
            units.extend(u.to_be_bytes());
        }
        let bytes = file(vec![
            dictionary! {"Subtype" => "Highlight", "SHR_Tags" => vec![Object::String(units, StringFormat::Hexadecimal)]},
        ]);
        assert_eq!(read_page(&bytes, 0).unwrap()[&0].tags, ["Größe €"]);
    }

    #[test]
    fn hostile_values_are_ignored_not_trusted() {
        let long = Object::String(vec![b'q'; 20_000], StringFormat::Literal);
        let bytes = file(vec![
            // Unknown version, a wrong type, a missing quote, an empty quote, an oversize quote.
            dictionary! {"Subtype" => "Highlight", "SHR_Cite" => cite(2.into(), s("q"), None)},
            dictionary! {"Subtype" => "Highlight", "SHR_Cite" => s("not a dictionary")},
            dictionary! {"Subtype" => "Highlight", "SHR_Cite" => dictionary! {"V" => 1}},
            dictionary! {"Subtype" => "Highlight", "SHR_Cite" => cite(1.into(), s("  "), None)},
            dictionary! {"Subtype" => "Highlight", "SHR_Cite" => cite(1.into(), long.clone(), None)},
            // A bad group is dropped, the cite stays; a version that is not an integer is ignored.
            dictionary! {"Subtype" => "Highlight", "SHR_Cite" => cite(1.into(), s("ok"), Some(s("ZZ")))},
            dictionary! {"Subtype" => "Highlight", "SHR_Cite" => cite(s("1"), s("ok"), None)},
            // Tags: not an array; elements of the wrong type, empty, oversize; too many.
            dictionary! {"Subtype" => "Text", "SHR_Tags" => s("x")},
            dictionary! {"Subtype" => "Text", "SHR_Tags" => vec![Object::Integer(3), s(""), long, Object::Null, s("fine")]},
            dictionary! {"Subtype" => "Text", "SHR_Tags" => (0..1000).map(|i| s(&format!("t{i}"))).collect::<Vec<_>>()},
        ]);
        let keys = read_page(&bytes, 0).unwrap();
        for position in [0, 1, 2, 3, 4, 6, 7] {
            assert_eq!(keys.get(&position), None, "annotation {position}");
        }
        assert_eq!(
            keys[&5].cite,
            Some(Cite {
                quote: "ok".into(),
                group: None
            })
        );
        assert_eq!(keys[&8].tags, ["fine"]);
        assert_eq!(keys[&9].tags.len(), limits::TAGS_PER_ANNOT);
    }

    #[test]
    fn a_page_without_annots_or_with_a_wrong_type_is_empty() {
        let bytes = file(vec![]);
        assert!(read_page(&bytes, 0).unwrap().is_empty());
    }

    #[test]
    fn what_is_written_is_read_back_and_the_keys_go_when_the_model_has_none() {
        use crate::documents::PageId;
        use crate::model::annotation::{Rgb, Sync};
        use crate::model::ids::AnnotId;
        let mut annotation = Annotation {
            id: AnnotId::new(1),
            page_id: PageId::new(0),
            rect: crate::model::geometry::Rect {
                x: 0.0,
                y: 0.0,
                w: 1.0,
                h: 1.0,
            },
            color: Rgb([1, 2, 3]),
            opacity: 1.0,
            contents: String::new(),
            author: None,
            modified: None,
            in_reply_to: None,
            state: None,
            locked: false,
            sync: Sync::New,
            cite: Some(Cite {
                quote: "Größe \u{1F600}".into(),
                group: Some("0a1b2c3d".into()),
            }),
            tags: vec!["Ünï".into(), "b".into()],
            body: AnnotationBody::Highlight { quads: vec![] },
        };
        let mut dict = dictionary! {"Subtype" => "Highlight"};
        write(&mut dict, &annotation, true);
        let bytes = file(vec![dict.clone()]);
        let read = read_page(&bytes, 0).unwrap();
        assert_eq!(read[&0].cite, annotation.cite);
        assert_eq!(read[&0].tags, annotation.tags);
        // A cite on a note is not written; no tags, no key.
        annotation.body = AnnotationBody::Note {
            at: crate::model::geometry::Point { x: 0.0, y: 0.0 },
            icon: crate::model::annotation::NoteIcon::Note,
        };
        annotation.tags.clear();
        write(&mut dict, &annotation, true);
        assert!(!dict.has(b"SHR_Cite") && !dict.has(b"SHR_Tags"));
        // Keys that were never read stay; the model only adds what it has.
        let mut kept = dictionary! {"Subtype" => "Highlight", "SHR_Tags" => vec![s("keep")],
        "SHR_Cite" => cite(1.into(), s("q"), None)};
        write(&mut kept, &annotation, false);
        assert!(kept.has(b"SHR_Cite") && kept.has(b"SHR_Tags"));
        write(&mut kept, &annotation, true);
        assert!(!kept.has(b"SHR_Cite") && !kept.has(b"SHR_Tags"));
    }

    #[test]
    fn several_pages_are_read_from_one_load() {
        let bytes = file(vec![
            dictionary! {"Subtype" => "Underline", "SHR_Tags" => vec![s("x")]},
        ]);
        let read = read_pages(&bytes, &[0, 5]).unwrap();
        assert_eq!(read[&0][&0].tags, ["x"]);
        assert!(!read.contains_key(&5));
    }
}
