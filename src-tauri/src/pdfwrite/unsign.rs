//! A copy of a signed document that carries no signature (ADR-121 section 1, `save_unsigned_copy`).
//!
//! [`strip_signatures`] takes the bytes of a plain, complete file (the Full snapshot of the document's current state) and removes what
//! only a signature gives meaning to: the signed fields with their values and widgets (a seal on an unsigned copy would mislead), the
//! catalog's `/Perms` (the DocMDP certification and any usage rights), `/DSS`, `/SigFlags` and the `/Lock` of the signature fields that
//! are left (empty ones stay). The result is written again as a new file in which nothing the signatures held is reachable. The original
//! is never touched: this works on bytes in memory.

use std::collections::HashSet;

use lopdf::{Dictionary, Object, ObjectId};

use super::{pagetree, sigread};
use crate::error::{AppError, ErrorCode};

fn failed(detail: impl std::fmt::Display) -> AppError {
    AppError::logged(ErrorCode::SaveFailed, format!("unsign: {detail}"))
}

/// `bytes` without signatures. `unsupported_feature` for an encrypted file.
pub fn strip_signatures(bytes: Vec<u8>) -> Result<Vec<u8>, AppError> {
    let mut doc = super::load_untrusted(&bytes)?;
    drop(bytes);
    if doc.is_encrypted() {
        return Err(AppError::unsupported("encrypted"));
    }
    let scan = sigread::scan_fields(&doc)?;
    let mut doomed: HashSet<ObjectId> = HashSet::new();
    let mut open_fields: Vec<ObjectId> = Vec::new();
    for field in &scan.fields {
        let Some(object) = field.object else {
            continue;
        };
        if !field.signed {
            open_fields.push(object);
            continue;
        }
        doomed.insert(object);
        if let Some(value) = field.value {
            doomed.insert(value);
        }
        // The widgets of a field that has children: kids that are no fields of their own.
        if let Ok(Object::Array(kids)) = doc.get_dictionary(object).and_then(|d| d.get(b"Kids")) {
            for kid in kids.iter().filter_map(|kid| kid.as_reference().ok()) {
                let is_field = doc
                    .get_dictionary(kid)
                    .is_ok_and(|d| d.has(b"T") || d.has(b"Kids"));
                if !is_field {
                    doomed.insert(kid);
                }
            }
        }
    }
    // Fields that stay lose the lock a signature put on them.
    for id in open_fields {
        if let Ok(dict) = doc.get_dictionary_mut(id) {
            dict.remove(b"Lock");
            dict.remove(b"SV");
        }
    }
    let catalog_id = doc
        .trailer
        .get(b"Root")
        .ok()
        .and_then(|root| root.as_reference().ok())
        .ok_or_else(|| failed("no catalog"))?;
    let acro_ref = {
        let catalog = doc.get_dictionary_mut(catalog_id).map_err(failed)?;
        catalog.remove(b"Perms");
        catalog.remove(b"DSS");
        match catalog.get_mut(b"AcroForm") {
            Ok(Object::Dictionary(acro)) => {
                clean_acro(acro);
                None
            }
            Ok(Object::Reference(id)) => Some(*id),
            _ => None,
        }
    };
    if let Some(id) = acro_ref {
        if let Ok(acro) = doc.get_dictionary_mut(id) {
            clean_acro(acro);
        }
    }
    let mut written = Vec::new();
    doc.save_to(&mut written).map_err(failed)?;
    drop(doc);
    // Nulls the references to the signed fields, drops what only they reached, and writes the result.
    let doomed: Vec<ObjectId> = doomed.into_iter().collect();
    pagetree::compact(written, &doomed)
}

fn clean_acro(acro: &mut Dictionary) {
    acro.remove(b"SigFlags");
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pdfsig::types::SigScan;
    use lopdf::{dictionary, Document, StringFormat};

    /// A one-page document with a certified signature field (widget merged) and an empty signature field.
    fn signed_document() -> Vec<u8> {
        let mut doc = Document::with_version("1.7");
        let pages = doc.new_object_id();
        let signature = doc.new_object_id();
        let widget = doc.new_object_id();
        let empty = doc.new_object_id();
        let page = doc.add_object(dictionary! {
            "Type" => "Page", "Parent" => pages,
            "MediaBox" => vec![0.into(), 0.into(), 200.into(), 200.into()],
            "Annots" => vec![widget.into(), empty.into()],
        });
        doc.objects.insert(
            pages,
            Object::Dictionary(dictionary! {
                "Type" => "Pages", "Kids" => vec![page.into()], "Count" => 1,
            }),
        );
        doc.objects.insert(
            signature,
            Object::Dictionary(dictionary! {
                "Type" => "Sig", "Filter" => "Adobe.PPKLite", "SubFilter" => "ETSI.CAdES.detached",
                "ByteRange" => vec![0.into(), 10.into(), 30.into(), 5.into()],
                "Contents" => Object::String(vec![0; 64], StringFormat::Hexadecimal),
                "Reference" => vec![Object::Dictionary(dictionary! {
                    "Type" => "SigRef", "TransformMethod" => "DocMDP",
                    "TransformParams" => dictionary! { "Type" => "TransformParams", "P" => 2, "V" => "1.2" },
                })],
            }),
        );
        doc.objects.insert(
            widget,
            Object::Dictionary(dictionary! {
                "FT" => "Sig", "T" => Object::string_literal("Signature1"), "Subtype" => "Widget", "P" => page,
                "Rect" => vec![10.into(), 10.into(), 90.into(), 40.into()], "V" => signature,
            }),
        );
        doc.objects.insert(
            empty,
            Object::Dictionary(dictionary! {
                "FT" => "Sig", "T" => Object::string_literal("Signature2"), "Subtype" => "Widget", "P" => page,
                "Rect" => vec![10.into(), 50.into(), 90.into(), 80.into()],
                "Lock" => dictionary! { "Action" => "All" },
            }),
        );
        let acro = doc.add_object(
            dictionary! { "Fields" => vec![widget.into(), empty.into()], "SigFlags" => 3 },
        );
        let catalog = doc.add_object(dictionary! {
            "Type" => "Catalog", "Pages" => pages, "AcroForm" => acro,
            "Perms" => dictionary! { "DocMDP" => signature },
        });
        doc.trailer.set("Root", catalog);
        let mut out = Vec::new();
        doc.save_to(&mut out).expect("serialises");
        out
    }

    fn contains(haystack: &[u8], needle: &[u8]) -> bool {
        haystack.windows(needle.len()).any(|w| w == needle)
    }

    #[test]
    fn nothing_of_the_signature_survives_and_the_empty_field_stays() {
        let original = signed_document();
        assert!(contains(&original, b"/ByteRange"));
        let before = sigread::scan_bytes(&original).expect("scans");
        assert_eq!(before.doc_mdp, Some(2));
        let stripped = strip_signatures(original).expect("strips");
        for token in [
            &b"/ByteRange"[..],
            b"/Perms",
            b"/DocMDP",
            b"/SigFlags",
            b"/Lock",
            b"Signature1",
        ] {
            assert!(
                !contains(&stripped, token),
                "{}",
                String::from_utf8_lossy(token)
            );
        }
        let after = sigread::scan_bytes(&stripped).expect("scans");
        assert_eq!(after.doc_mdp, None);
        assert_eq!(after.fields.len(), 1);
        assert!(!after.fields[0].signed);
        assert_eq!(after.fields[0].name, "Signature2");
        let doc = crate::pdfwrite::load_untrusted(&stripped).expect("loads");
        assert_eq!(doc.get_pages().len(), 1);
        // The page lists the empty widget only.
        let page_id = *doc.get_pages().values().next().expect("page");
        let annots = doc
            .get_dictionary(page_id)
            .and_then(|page| page.get(b"Annots"))
            .and_then(Object::as_array)
            .expect("annots");
        assert_eq!(annots.len(), 1);
    }

    #[test]
    fn a_file_without_signatures_keeps_its_page() {
        let mut doc = Document::with_version("1.7");
        let pages = doc.new_object_id();
        let page = doc.add_object(dictionary! {
            "Type" => "Page", "Parent" => pages,
            "MediaBox" => vec![0.into(), 0.into(), 200.into(), 200.into()],
        });
        doc.objects.insert(
            pages,
            Object::Dictionary(
                dictionary! { "Type" => "Pages", "Kids" => vec![page.into()], "Count" => 1 },
            ),
        );
        let catalog = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages });
        doc.trailer.set("Root", catalog);
        let mut bytes = Vec::new();
        doc.save_to(&mut bytes).expect("serialises");
        let out = strip_signatures(bytes).expect("strips");
        assert_eq!(
            sigread::scan_bytes(&out).expect("scans"),
            SigScan::default()
        );
        assert_eq!(
            crate::pdfwrite::load_untrusted(&out)
                .expect("loads")
                .get_pages()
                .len(),
            1
        );
    }
}
