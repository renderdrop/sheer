//! Reading the signature fields of a document (ADR-121 sections 1 and 4, ARCHITECTURE section 5 "Certificate signatures (v1.4)").
//!
//! [`scan_fields`] lists the `/FT /Sig` fields of the AcroForm with what their `/V` dictionaries claim (ByteRange, the length of
//! `/Contents`, SubFilter, `/M`, `/Reason`, `/Location`, `/Name`) and the certification level of the catalog (`/Perms /DocMDP`).
//! Nothing is verified here: this is the file's own claim, for the lock and as the input of the validator. Every PDF is hostile input:
//! the walk is iterative, every object is visited once, the number of nodes, the depth, the number of fields, the length of names and
//! texts and the size of a ByteRange are capped (`limits::SIG_*`), and the document comes from `load_untrusted`.

use std::collections::HashSet;

use lopdf::{Dictionary, Document, Object, ObjectId};

use super::forms::decode_text;
use crate::error::{AppError, ErrorCode};
use crate::limits;
use crate::pdfsig::types::{SigField, SigScan};

/// Most numbers of a `/ByteRange` that are kept: a real one has four.
const BYTE_RANGE_MAX: usize = 16;
/// Most entries of a `/Reference` array that are looked at.
const REFERENCE_MAX: usize = 8;

/// [`scan_fields`] on the bytes of a file (through the pre-scan). An encrypted document is `unsupported_feature`.
pub fn scan_bytes(bytes: &[u8]) -> Result<SigScan, AppError> {
    let doc = super::load_untrusted(bytes)?;
    if doc.is_encrypted() {
        return Err(AppError::new(ErrorCode::UnsupportedFeature));
    }
    scan_fields(&doc)
}

/// The signature fields of `doc` in field-tree order (depth first), at most `limits::SIGS_PER_DOC_MAX` (then `truncated`), and the
/// certification level. A document without an AcroForm has none. Never panics and never recurses.
pub fn scan_fields(doc: &Document) -> Result<SigScan, AppError> {
    let mut scan = SigScan::default();
    let Ok(catalog) = doc.catalog() else {
        return Ok(scan);
    };
    scan.doc_mdp = doc_mdp(doc, catalog);
    let Some(acro) = dict_of(doc, catalog, b"AcroForm") else {
        return Ok(scan);
    };
    let roots: Vec<ObjectId> = match entry(doc, acro, b"Fields") {
        Some(Object::Array(items)) => items
            .iter()
            .take(limits::SIG_SCAN_NODES_MAX)
            .filter_map(|item| item.as_reference().ok())
            .collect(),
        _ => Vec::new(),
    };
    let mut stack: Vec<Node> = roots
        .into_iter()
        .rev()
        .map(|id| Node {
            id,
            name: String::new(),
            is_sig: false,
            depth: 1,
        })
        .collect();
    let mut visited: HashSet<ObjectId> = HashSet::new();
    while let Some(node) = stack.pop() {
        if !visited.insert(node.id) {
            continue;
        }
        if visited.len() > limits::SIG_SCAN_NODES_MAX {
            scan.truncated = true;
            break;
        }
        let Ok(dict) = doc.get_dictionary(node.id) else {
            continue;
        };
        let name = qualified(&node.name, dict);
        let is_sig = match dict.get(b"FT").ok().and_then(|ft| deref(doc, ft)) {
            Some(Object::Name(ft)) => ft == b"Sig",
            _ => node.is_sig,
        };
        let kids: Vec<ObjectId> = match entry(doc, dict, b"Kids") {
            Some(Object::Array(items)) => items
                .iter()
                .take(limits::SIG_SCAN_NODES_MAX)
                .filter_map(|item| item.as_reference().ok())
                .collect(),
            _ => Vec::new(),
        };
        // A kid with a partial name or kids of its own is a child field; the rest are the widgets of this field.
        let is_field_node = |kid: &ObjectId| {
            doc.get_dictionary(*kid)
                .is_ok_and(|d| d.has(b"T") || d.has(b"Kids"))
        };
        let (field_kids, widgets): (Vec<ObjectId>, Vec<ObjectId>) =
            kids.iter().copied().partition(is_field_node);
        if !field_kids.is_empty() {
            if node.depth < limits::SIG_SCAN_DEPTH_MAX {
                for kid in field_kids.into_iter().rev() {
                    stack.push(Node {
                        id: kid,
                        name: name.clone(),
                        is_sig,
                        depth: node.depth + 1,
                    });
                }
            } else {
                scan.truncated = true;
            }
            continue;
        }
        if !is_sig {
            continue;
        }
        if scan.fields.len() >= limits::SIGS_PER_DOC_MAX {
            scan.truncated = true;
            break;
        }
        let widget = widgets
            .first()
            .and_then(|id| doc.get_dictionary(*id).ok())
            .unwrap_or(dict);
        scan.fields
            .push(read_field(doc, node.id, dict, widget, name));
    }
    Ok(scan)
}

struct Node {
    id: ObjectId,
    name: String,
    is_sig: bool,
    depth: usize,
}

fn read_field(
    doc: &Document,
    id: ObjectId,
    dict: &Dictionary,
    widget: &Dictionary,
    name: String,
) -> SigField {
    let mut field = SigField {
        object: Some(id),
        name,
        page: widget
            .get(b"P")
            .ok()
            .or_else(|| dict.get(b"P").ok())
            .and_then(|p| p.as_reference().ok()),
        rect: entry(doc, widget, b"Rect").and_then(rect_of),
        ..SigField::default()
    };
    let Ok(value) = dict.get(b"V") else {
        return field;
    };
    let value_dict = match value {
        Object::Reference(target) => {
            field.value = Some(*target);
            doc.get_dictionary(*target).ok()
        }
        Object::Dictionary(inline) => Some(inline),
        _ => None,
    };
    let Some(sig) = value_dict else {
        return field;
    };
    field.signed = true;
    field.doc_timestamp =
        matches!(entry(doc, sig, b"Type"), Some(Object::Name(t)) if t == b"DocTimeStamp");
    field.sub_filter = match entry(doc, sig, b"SubFilter") {
        Some(Object::Name(name)) => Some(clean_name(name)),
        _ => None,
    };
    field.byte_range = match entry(doc, sig, b"ByteRange") {
        Some(Object::Array(items)) if items.len() <= BYTE_RANGE_MAX => items
            .iter()
            .map(|item| deref(doc, item).and_then(integer))
            .collect(),
        _ => None,
    };
    field.contents_len = match sig.get(b"Contents") {
        Ok(Object::String(bytes, _)) => Some(bytes.len()),
        _ => None,
    };
    field.signed_at = text_of(doc, sig, b"M");
    field.reason = text_of(doc, sig, b"Reason");
    field.location = text_of(doc, sig, b"Location");
    field.name_text = text_of(doc, sig, b"Name");
    field.cert_p = cert_level(doc, sig);
    field
}

/// The certification level of the catalog: `/Perms /DocMDP` names the certification signature, whose `/Reference` carries `/P`
/// (1..=3, 2 when the file does not say). `None` when the catalog has no `/DocMDP`.
fn doc_mdp(doc: &Document, catalog: &Dictionary) -> Option<u8> {
    let perms = dict_of(doc, catalog, b"Perms")?;
    let sig = dict_of(doc, perms, b"DocMDP")?;
    Some(cert_level(doc, sig).unwrap_or(2))
}

/// `/P` of the DocMDP transform of a signature dictionary's `/Reference` array.
fn cert_level(doc: &Document, sig: &Dictionary) -> Option<u8> {
    let Some(Object::Array(references)) = entry(doc, sig, b"Reference") else {
        return None;
    };
    for item in references.iter().take(REFERENCE_MAX) {
        let Some(Object::Dictionary(reference)) = deref(doc, item) else {
            continue;
        };
        if !matches!(entry(doc, reference, b"TransformMethod"), Some(Object::Name(m)) if m == b"DocMDP")
        {
            continue;
        }
        let p = dict_of(doc, reference, b"TransformParams")
            .and_then(|params| entry(doc, params, b"P"))
            .and_then(integer)
            .unwrap_or(2);
        return Some(u8::try_from(p.clamp(1, 3)).unwrap_or(2));
    }
    None
}

fn qualified(parent: &str, dict: &Dictionary) -> String {
    let own = match dict.get(b"T") {
        Ok(Object::String(bytes, _)) => decode_text(bytes, limits::SIG_FIELD_NAME_MAX),
        _ => String::new(),
    };
    let joined = match (parent.is_empty(), own.is_empty()) {
        (_, true) => parent.to_owned(),
        (true, false) => own,
        (false, false) => format!("{parent}.{own}"),
    };
    joined.chars().take(limits::SIG_FIELD_NAME_MAX).collect()
}

fn text_of(doc: &Document, dict: &Dictionary, key: &[u8]) -> Option<String> {
    match entry(doc, dict, key)? {
        Object::String(bytes, _) => {
            let text = decode_text(bytes, limits::SIG_TEXT_READ_MAX);
            (!text.is_empty()).then_some(text)
        }
        _ => None,
    }
}

fn clean_name(name: &[u8]) -> String {
    String::from_utf8_lossy(name)
        .chars()
        .filter(|c| c.is_ascii_graphic())
        .take(64)
        .collect()
}

fn rect_of(object: &Object) -> Option<[f32; 4]> {
    let Object::Array(items) = object else {
        return None;
    };
    if items.len() != 4 {
        return None;
    }
    let mut out = [0f32; 4];
    for (slot, item) in out.iter_mut().zip(items) {
        *slot = item.as_float().ok().filter(|v| v.is_finite())?;
    }
    Some(out)
}

fn integer(object: &Object) -> Option<i64> {
    match object {
        Object::Integer(value) => Some(*value),
        _ => None,
    }
}

fn deref<'a>(doc: &'a Document, object: &'a Object) -> Option<&'a Object> {
    doc.dereference(object).ok().map(|(_, object)| object)
}

fn entry<'a>(doc: &'a Document, dict: &'a Dictionary, key: &[u8]) -> Option<&'a Object> {
    dict.get(key).ok().and_then(|object| deref(doc, object))
}

fn dict_of<'a>(doc: &'a Document, dict: &'a Dictionary, key: &[u8]) -> Option<&'a Dictionary> {
    entry(doc, dict, key)?.as_dict().ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::dictionary;

    /// A one-page document with an AcroForm whose fields are built by `f`; returns the document and the page id.
    fn document(build: impl FnOnce(&mut Document, ObjectId) -> Vec<Object>) -> Document {
        let mut doc = Document::with_version("1.7");
        let pages = doc.new_object_id();
        let page = doc.add_object(dictionary! {
            "Type" => "Page", "Parent" => pages, "MediaBox" => vec![0.into(), 0.into(), 200.into(), 200.into()],
        });
        doc.objects.insert(
            pages,
            Object::Dictionary(dictionary! {
                "Type" => "Pages", "Kids" => vec![page.into()], "Count" => 1,
            }),
        );
        let fields = build(&mut doc, page);
        let acro = doc.add_object(dictionary! { "Fields" => fields, "SigFlags" => 3 });
        let catalog = doc.add_object(dictionary! {
            "Type" => "Catalog", "Pages" => pages, "AcroForm" => acro,
        });
        doc.trailer.set("Root", catalog);
        doc
    }

    fn signature(doc: &mut Document, extra: Dictionary) -> ObjectId {
        let mut sig = dictionary! {
            "Type" => "Sig", "Filter" => "Adobe.PPKLite", "SubFilter" => "ETSI.CAdES.detached",
            "ByteRange" => vec![0.into(), 10.into(), 30.into(), 5.into()],
            "Contents" => Object::String(vec![0; 100], lopdf::StringFormat::Hexadecimal),
            "M" => Object::string_literal("D:20261005101500+02'00'"),
            "Reason" => Object::string_literal("I approve"),
            "Location" => Object::string_literal("Berlin"),
            "Name" => Object::string_literal("Ada"),
        };
        for (key, value) in extra {
            sig.set(key, value);
        }
        doc.add_object(sig)
    }

    fn sig_field(
        doc: &mut Document,
        page: ObjectId,
        name: &str,
        value: Option<ObjectId>,
    ) -> Object {
        let mut field = dictionary! {
            "FT" => "Sig", "T" => Object::string_literal(name), "Subtype" => "Widget", "P" => page,
            "Rect" => vec![10.into(), 10.into(), 90.into(), 40.into()],
        };
        if let Some(value) = value {
            field.set("V", value);
        }
        doc.add_object(field).into()
    }

    #[test]
    fn a_signed_field_reports_what_its_value_claims() {
        let doc = document(|doc, page| {
            let sig = signature(doc, Dictionary::new());
            vec![sig_field(doc, page, "Signature1", Some(sig))]
        });
        let scan = scan_fields(&doc).unwrap();
        assert_eq!(scan.fields.len(), 1);
        assert_eq!(scan.doc_mdp, None);
        let field = &scan.fields[0];
        assert!(field.signed);
        assert_eq!(field.name, "Signature1");
        assert_eq!(field.sub_filter.as_deref(), Some("ETSI.CAdES.detached"));
        assert_eq!(field.byte_range, Some(vec![0, 10, 30, 5]));
        assert_eq!(field.contents_len, Some(100));
        assert_eq!(field.signed_at.as_deref(), Some("D:20261005101500+02'00'"));
        assert_eq!(field.reason.as_deref(), Some("I approve"));
        assert_eq!(field.location.as_deref(), Some("Berlin"));
        assert_eq!(field.name_text.as_deref(), Some("Ada"));
        assert_eq!(field.rect, Some([10.0, 10.0, 90.0, 40.0]));
        assert!(field.page.is_some() && field.value.is_some() && !field.doc_timestamp);
    }

    #[test]
    fn an_empty_field_is_unsigned_and_other_field_types_are_skipped() {
        let doc = document(|doc, page| {
            let text = doc.add_object(dictionary! {
                "FT" => "Tx", "T" => Object::string_literal("Name"), "V" => Object::string_literal("x"),
            });
            vec![text.into(), sig_field(doc, page, "Empty", None)]
        });
        let scan = scan_fields(&doc).unwrap();
        assert_eq!(scan.fields.len(), 1);
        assert!(!scan.fields[0].signed);
        assert_eq!(scan.fields[0].contents_len, None);
    }

    #[test]
    fn doc_mdp_is_read_from_the_perms_dictionary() {
        for (p, expected) in [(Some(1), 1u8), (Some(3), 3), (None, 2), (Some(9), 3)] {
            let mut doc = document(|doc, page| {
                let mut params = dictionary! { "Type" => "TransformParams", "V" => "1.2" };
                if let Some(p) = p {
                    params.set("P", p);
                }
                let reference = dictionary! {
                    "Type" => "SigRef", "TransformMethod" => "DocMDP", "TransformParams" => params,
                };
                let sig = signature(doc, dictionary! { "Reference" => vec![reference.into()] });
                vec![sig_field(doc, page, "Cert", Some(sig))]
            });
            let sig_id = scan_fields(&doc).unwrap().fields[0].value.unwrap();
            let catalog_id = doc.trailer.get(b"Root").unwrap().as_reference().unwrap();
            let perms = dictionary! { "DocMDP" => sig_id };
            if let Ok(Object::Dictionary(catalog)) = doc.get_object_mut(catalog_id) {
                catalog.set("Perms", perms);
            }
            let scan = scan_fields(&doc).unwrap();
            assert_eq!(scan.doc_mdp, Some(expected), "P = {p:?}");
            assert_eq!(scan.fields[0].cert_p, Some(expected));
        }
    }

    #[test]
    fn nested_fields_get_qualified_names_and_inherit_the_type() {
        let doc = document(|doc, page| {
            let sig = signature(doc, Dictionary::new());
            let child = doc.add_object(dictionary! {
                "T" => Object::string_literal("sig"), "V" => sig, "Subtype" => "Widget", "P" => page,
            });
            let parent = doc.add_object(dictionary! {
                "FT" => "Sig", "T" => Object::string_literal("form"), "Kids" => vec![child.into()],
            });
            vec![parent.into()]
        });
        let scan = scan_fields(&doc).unwrap();
        assert_eq!(scan.fields.len(), 1);
        assert_eq!(scan.fields[0].name, "form.sig");
        assert!(scan.fields[0].signed);
    }

    #[test]
    fn hostile_trees_are_bounded() {
        // A field that is its own kid, two fields that are each other's kids, and a chain deeper than the cap.
        let doc = document(|doc, _page| {
            let a = doc.new_object_id();
            let b = doc.new_object_id();
            doc.objects.insert(
                a,
                Object::Dictionary(dictionary! {
                    "FT" => "Sig", "T" => Object::string_literal("a"), "Kids" => vec![a.into(), b.into()],
                }),
            );
            doc.objects.insert(
                b,
                Object::Dictionary(dictionary! {
                    "T" => Object::string_literal("b"), "Kids" => vec![a.into()],
                }),
            );
            let mut inner: Option<ObjectId> = None;
            for _ in 0..(limits::SIG_SCAN_DEPTH_MAX + 20) {
                let kids = inner.map(|id| vec![Object::from(id)]).unwrap_or_default();
                inner = Some(doc.add_object(dictionary! {
                    "FT" => "Sig", "T" => Object::string_literal("n"), "Kids" => kids,
                }));
            }
            vec![a.into(), inner.map(Object::from).unwrap_or(Object::Null)]
        });
        let scan = scan_fields(&doc).unwrap();
        assert!(scan.fields.is_empty());
        assert!(scan.truncated, "the deep chain hit the depth cap");
    }

    #[test]
    fn more_fields_than_the_cap_are_cut() {
        let doc = document(|doc, page| {
            (0..limits::SIGS_PER_DOC_MAX + 5)
                .map(|i| sig_field(doc, page, &format!("S{i}"), None))
                .collect()
        });
        let scan = scan_fields(&doc).unwrap();
        assert_eq!(scan.fields.len(), limits::SIGS_PER_DOC_MAX);
        assert!(scan.truncated);
    }

    #[test]
    fn odd_values_are_read_as_absent_not_as_errors() {
        let doc = document(|doc, page| {
            let sig = signature(
                doc,
                dictionary! {
                    "ByteRange" => vec![0.into(); BYTE_RANGE_MAX + 1],
                    "Contents" => 5, "M" => 7, "SubFilter" => Object::string_literal("x"),
                },
            );
            let inline = doc.add_object(dictionary! {
                "FT" => "Sig", "T" => Object::string_literal("inline"),
                "V" => dictionary! { "SubFilter" => "adbe.pkcs7.detached" },
            });
            vec![sig_field(doc, page, "odd", Some(sig)), inline.into()]
        });
        let scan = scan_fields(&doc).unwrap();
        let odd = &scan.fields[0];
        assert!(odd.signed);
        assert_eq!(
            (
                odd.byte_range.clone(),
                odd.contents_len,
                odd.signed_at.clone(),
                odd.sub_filter.clone()
            ),
            (None, None, None, None)
        );
        let inline = &scan.fields[1];
        assert!(inline.signed && inline.value.is_none());
        assert_eq!(inline.sub_filter.as_deref(), Some("adbe.pkcs7.detached"));
    }

    #[test]
    fn a_document_without_a_form_has_no_fields() {
        let mut doc = Document::with_version("1.7");
        let pages = doc.add_object(
            dictionary! { "Type" => "Pages", "Kids" => Vec::<Object>::new(), "Count" => 0 },
        );
        let catalog = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages });
        doc.trailer.set("Root", catalog);
        assert_eq!(scan_fields(&doc).unwrap(), SigScan::default());
    }

    #[test]
    fn scan_bytes_reads_a_saved_file_through_the_pre_scan() {
        let mut doc = document(|doc, page| {
            let sig = signature(doc, Dictionary::new());
            vec![sig_field(doc, page, "Signature1", Some(sig))]
        });
        let mut bytes = Vec::new();
        doc.save_to(&mut bytes).unwrap();
        let scan = scan_bytes(&bytes).unwrap();
        assert_eq!(scan.fields.len(), 1);
        assert_eq!(scan.fields[0].contents_len, Some(100));
        assert!(scan_bytes(b"%PDF-1.7\nnot a pdf").is_err());
    }
}
