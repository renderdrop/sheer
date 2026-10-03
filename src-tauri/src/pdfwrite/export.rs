//! Export a copy (ADR-049 §5): the options, the annotation stripping and the rewrite of the copy. A pure function on bytes: the caller
//! (`commands::export_pdf`) reads the snapshot, writes the result and owns the dialog and the job.

use std::collections::HashSet;

use lopdf::{Dictionary, Document, Object, ObjectId, StringFormat};
use serde::Deserialize;

use super::flatten::{self, FlattenScope};
use super::metadata;
use super::prescan::load_untrusted;
use super::produce::{Control, Phase, Warning};
use crate::error::{AppError, ErrorCode};
use crate::limits;

/// What happens to the annotations of the copy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AnnotationsMode {
    Keep,
    Flatten,
    Remove,
}

/// What `export_pdf` takes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PdfExportOptions {
    pub annotations: AnnotationsMode,
    pub remove_metadata: bool,
}

impl PdfExportOptions {
    /// The options change the document (not just copy it): on a restricted document they need the `edit` permission.
    pub fn changes_content(&self) -> bool {
        self.annotations != AnnotationsMode::Keep || self.remove_metadata
    }
}

/// The copy.
#[derive(Debug)]
pub struct Exported {
    pub bytes: Vec<u8>,
    pub warnings: Vec<Warning>,
}

fn failed(detail: impl std::fmt::Display) -> AppError {
    AppError::logged(ErrorCode::SaveFailed, format!("export: {detail}"))
}

/// Makes the copy from the plain file `plain` (a snapshot, or the decrypted file): annotations as `opts` say, metadata removed if asked,
/// a new `/ID`, the whole file written again without an earlier revision. `keep_id` leaves the first `/ID` string as it is, for a file
/// that is encrypted again afterwards with its old key (R2 to R4 derive it from that string). The input goes through the pre-scan.
pub fn export_copy(
    plain: &[u8],
    opts: &PdfExportOptions,
    keep_id: bool,
    control: &dyn Control,
) -> Result<Exported, AppError> {
    control.check()?;
    control.progress(Phase::Write, 0, 1);
    let mut warnings = Vec::new();
    let flattened;
    let input: &[u8] = if opts.annotations == AnnotationsMode::Flatten {
        let output = flatten::flatten(plain, FlattenScope::FormsAndAnnotations, control)?;
        warnings = output.warnings;
        flattened = output.bytes;
        &flattened
    } else {
        plain
    };
    let mut doc = load_untrusted(input)?;
    if doc.is_encrypted() || doc.encryption_state.is_some() {
        return Err(AppError::new(ErrorCode::UnsupportedFeature));
    }
    if opts.annotations == AnnotationsMode::Remove {
        strip_annotations(&mut doc)?;
    }
    if opts.remove_metadata {
        metadata::strip(&mut doc)?;
    }
    let first = doc
        .trailer
        .get(b"ID")
        .ok()
        .and_then(|id| id.as_array().ok())
        .and_then(|items| items.first().cloned())
        .filter(|first| keep_id && matches!(first, Object::String(..)));
    let mut id = fresh_id()?;
    if let (Some(first), Object::Array(items)) = (first, &mut id) {
        if let Some(slot) = items.first_mut() {
            *slot = first;
        }
    }
    doc.trailer.set("ID", id);
    doc.trailer.remove(b"Prev");
    doc.trailer.remove(b"XRefStm");
    doc.prune_objects();
    control.check()?;
    let mut bytes = Vec::with_capacity(input.len());
    doc.save_to(&mut bytes).map_err(failed)?;
    drop(doc);
    // The copy has to load again (ADR-004 §1 step 6).
    let pages = u32::try_from(load_untrusted(&bytes)?.get_pages().len()).unwrap_or(u32::MAX);
    limits::validate_page_count(pages)?;
    control.progress(Phase::Write, 1, 1);
    Ok(Exported { bytes, warnings })
}

fn fresh_id() -> Result<Object, AppError> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|error| failed(format!("random: {error}")))?;
    let (first, second) = bytes.split_at(16);
    Ok(Object::Array(vec![
        Object::String(first.to_vec(), StringFormat::Hexadecimal),
        Object::String(second.to_vec(), StringFormat::Hexadecimal),
    ]))
}

fn subtype(dict: &Dictionary) -> Option<&[u8]> {
    dict.get(b"Subtype").ok().and_then(|s| s.as_name().ok())
}

/// The page's `/Annots` as it is: the array, and the object that holds it if it is an indirect one.
fn annots_of(doc: &Document, page: ObjectId) -> Option<(Option<ObjectId>, Vec<Object>)> {
    let entry = doc.get_dictionary(page).ok()?.get(b"Annots").ok()?;
    match entry {
        Object::Array(items) => Some((None, items.clone())),
        Object::Reference(holder) => match doc.get_object(*holder).ok()? {
            Object::Array(items) => Some((Some(*holder), items.clone())),
            _ => None,
        },
        _ => None,
    }
}

/// Drops every `/Annots` entry except `/Link` and `/Widget` (and the `/Popup`s whose parent stays); answers how many were removed.
/// Entries that are not dictionaries (null, dangling) go as well. The objects that nothing refers to any more go when the copy is
/// written.
pub fn strip_annotations(doc: &mut Document) -> Result<u32, AppError> {
    let pages: Vec<ObjectId> = doc.get_pages().values().copied().collect();
    let mut removed = 0u32;
    for page in pages {
        let Some((holder, items)) = annots_of(doc, page) else {
            continue;
        };
        let dict_of = |entry: &Object| -> Option<(Option<ObjectId>, Dictionary)> {
            match entry {
                Object::Reference(id) => doc
                    .get_dictionary(*id)
                    .ok()
                    .map(|dict| (Some(*id), dict.clone())),
                Object::Dictionary(dict) => Some((None, dict.clone())),
                _ => None,
            }
        };
        // The annotations that stay, by object: a popup stays only with a parent among them.
        let mut kept_ids: HashSet<ObjectId> = HashSet::new();
        for entry in &items {
            if let Some((Some(id), dict)) = dict_of(entry) {
                if matches!(subtype(&dict), Some(b"Link" | b"Widget")) {
                    kept_ids.insert(id);
                }
            }
        }
        let mut kept: Vec<Object> = Vec::with_capacity(items.len());
        for entry in &items {
            let keep = match dict_of(entry) {
                Some((_, dict)) => match subtype(&dict) {
                    Some(b"Link" | b"Widget") => true,
                    Some(b"Popup") => matches!(
                        dict.get(b"Parent"),
                        Ok(Object::Reference(parent)) if kept_ids.contains(parent)
                    ),
                    _ => false,
                },
                None => false,
            };
            if keep {
                kept.push(entry.clone());
            } else {
                removed = removed.saturating_add(1);
            }
        }
        if kept.len() == items.len() {
            continue;
        }
        match holder {
            Some(holder) => {
                doc.set_object(holder, Object::Array(kept));
            }
            None => {
                let dict = doc.get_dictionary_mut(page).map_err(failed)?;
                if kept.is_empty() {
                    dict.remove(b"Annots");
                } else {
                    dict.set("Annots", Object::Array(kept));
                }
            }
        }
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pdfwrite::produce::Unattended;

    #[test]
    fn options_parse_from_the_wire() {
        let opts: PdfExportOptions =
            serde_json::from_str(r#"{"annotations":"flatten","removeMetadata":true}"#).unwrap();
        assert_eq!(opts.annotations, AnnotationsMode::Flatten);
        assert!(opts.remove_metadata);
        assert!(opts.changes_content());
        assert!(serde_json::from_str::<PdfExportOptions>(
            r#"{"annotations":"hide","removeMetadata":true}"#
        )
        .is_err());
        let plain = PdfExportOptions {
            annotations: AnnotationsMode::Keep,
            remove_metadata: false,
        };
        assert!(!plain.changes_content());
    }

    /// One page with a note, a highlight, a link, a widget, a popup of the note, an orphan popup, a null and a dangling entry.
    fn annotated() -> Vec<u8> {
        let mut doc = Document::with_version("1.7");
        let pages = doc.new_object_id();
        let page = doc.new_object_id();
        let annot = |doc: &mut Document, kind: &str, extra: Vec<(&str, Object)>| {
            let mut dict = Dictionary::new();
            dict.set("Type", Object::Name(b"Annot".to_vec()));
            dict.set("Subtype", Object::Name(kind.as_bytes().to_vec()));
            for (key, value) in extra {
                dict.set(key, value);
            }
            doc.add_object(Object::Dictionary(dict))
        };
        let note = annot(&mut doc, "Text", vec![]);
        let highlight = annot(&mut doc, "Highlight", vec![]);
        let link = annot(&mut doc, "Link", vec![]);
        let widget = annot(&mut doc, "Widget", vec![]);
        let popup = annot(&mut doc, "Popup", vec![("Parent", Object::Reference(note))]);
        let orphan = annot(&mut doc, "Popup", vec![]);
        let mut page_dict = Dictionary::new();
        page_dict.set("Type", Object::Name(b"Page".to_vec()));
        page_dict.set("Parent", Object::Reference(pages));
        page_dict.set(
            "MediaBox",
            Object::Array(vec![0i64.into(), 0i64.into(), 100i64.into(), 100i64.into()]),
        );
        page_dict.set(
            "Annots",
            Object::Array(
                [note, highlight, link, widget, popup, orphan]
                    .into_iter()
                    .map(Object::Reference)
                    .chain([Object::Null, Object::Reference((9999, 0))])
                    .collect(),
            ),
        );
        doc.objects.insert(page, Object::Dictionary(page_dict));
        let mut pages_dict = Dictionary::new();
        pages_dict.set("Type", Object::Name(b"Pages".to_vec()));
        pages_dict.set("Kids", Object::Array(vec![Object::Reference(page)]));
        pages_dict.set("Count", Object::Integer(1));
        doc.objects.insert(pages, Object::Dictionary(pages_dict));
        let mut catalog = Dictionary::new();
        catalog.set("Type", Object::Name(b"Catalog".to_vec()));
        catalog.set("Pages", Object::Reference(pages));
        let root = doc.add_object(Object::Dictionary(catalog));
        doc.trailer.set("Root", Object::Reference(root));
        let mut info = Dictionary::new();
        info.set("Title", Object::string_literal("Secret title"));
        let info = doc.add_object(Object::Dictionary(info));
        doc.trailer.set("Info", Object::Reference(info));
        let mut bytes = Vec::new();
        doc.save_to(&mut bytes).unwrap();
        bytes
    }

    fn subtypes(bytes: &[u8]) -> Vec<String> {
        let doc = load_untrusted(bytes).unwrap();
        let mut found = Vec::new();
        for page in doc.get_pages().values() {
            for annot in doc.get_page_annotations(*page).unwrap_or_default() {
                if let Some(kind) = subtype(annot) {
                    found.push(String::from_utf8_lossy(kind).into_owned());
                }
            }
        }
        found
    }

    fn opts(annotations: AnnotationsMode, remove_metadata: bool) -> PdfExportOptions {
        PdfExportOptions {
            annotations,
            remove_metadata,
        }
    }

    #[test]
    fn remove_keeps_links_and_widgets_and_drops_the_rest_with_orphan_popups() {
        let mut doc = load_untrusted(&annotated()).unwrap();
        // Note, highlight, both popups, the null and the dangling entry.
        assert_eq!(strip_annotations(&mut doc).unwrap(), 6);
        let mut bytes = Vec::new();
        doc.save_to(&mut bytes).unwrap();
        assert_eq!(subtypes(&bytes), vec!["Link", "Widget"]);
    }

    #[test]
    fn keep_leaves_the_annotations_and_gives_a_new_id_and_no_earlier_revision() {
        let source = annotated();
        let copy = export_copy(
            &source,
            &opts(AnnotationsMode::Keep, false),
            false,
            &Unattended,
        )
        .unwrap();
        assert!(subtypes(&copy.bytes).contains(&"Text".to_owned()));
        let id = |bytes: &[u8]| {
            load_untrusted(bytes)
                .unwrap()
                .trailer
                .get(b"ID")
                .ok()
                .cloned()
        };
        let new = id(&copy.bytes);
        assert!(new.is_some());
        assert_ne!(new, id(&source));
        assert_eq!(
            copy.bytes.windows(9).filter(|w| *w == b"startxref").count(),
            1
        );
    }

    #[test]
    fn remove_and_metadata_removal_work_through_export_copy() {
        let copy = export_copy(
            &annotated(),
            &opts(AnnotationsMode::Remove, true),
            false,
            &Unattended,
        )
        .unwrap();
        assert_eq!(subtypes(&copy.bytes), vec!["Link", "Widget"]);
        let doc = load_untrusted(&copy.bytes).unwrap();
        assert!(doc.trailer.get(b"Info").is_err());
        assert!(!String::from_utf8_lossy(&copy.bytes).contains("Secret title"));
        // The metadata stays when it is not asked for.
        let kept = export_copy(
            &annotated(),
            &opts(AnnotationsMode::Keep, false),
            false,
            &Unattended,
        )
        .unwrap();
        assert!(String::from_utf8_lossy(&kept.bytes).contains("Secret title"));
    }

    #[test]
    fn a_kept_id_keeps_its_first_string_for_the_encryption_of_old_revisions() {
        let mut doc = load_untrusted(&annotated()).unwrap();
        let string = |byte: u8| Object::String(vec![byte; 16], StringFormat::Hexadecimal);
        doc.trailer
            .set("ID", Object::Array(vec![string(7), string(8)]));
        let mut bytes = Vec::new();
        doc.save_to(&mut bytes).unwrap();
        let copy = export_copy(
            &bytes,
            &opts(AnnotationsMode::Keep, false),
            true,
            &Unattended,
        )
        .unwrap();
        let doc = load_untrusted(&copy.bytes).unwrap();
        let items = doc.trailer.get(b"ID").unwrap().as_array().unwrap().clone();
        assert_eq!(items[0], string(7));
        assert_ne!(items[1], string(8));
    }
}
