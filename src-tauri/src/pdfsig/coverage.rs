//! What a change after a signature is, and whether DocMDP allows it (ADR-121 section 4 step vii; SECURITY P24).
//!
//! The revision diff itself reads the file with lopdf (`pdfwrite/sigread.rs`); this module holds the rules, over key names only: no
//! lopdf and no crypto. Every changed object is classified as `signatures`, `formFill`, `annotations` or `other`. A class that DocMDP
//! allows is still reported: the report lists "annotations added after signing", it never calls a change harmless (shadow attacks).

use crate::pdfsig::types::{LaterChanges, Verdict};

/// What an object is, as far as the rules care.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Catalog,
    AcroForm,
    Page,
    /// An indirect array that is the `/Annots` of a page.
    AnnotsArray,
    /// An indirect array that is the `/Fields` of the AcroForm.
    FieldsArray,
    /// A signature dictionary (`/Type /Sig` or `/DocTimeStamp`).
    SigValue,
    /// A signature field (with or without its widget).
    SigField,
    /// A field or widget of another type.
    FormField,
    /// An annotation that is not a widget.
    Annot,
    Other,
}

/// How an object differs from the signed revision.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Change {
    /// The object did not exist.
    New,
    /// The object exists in both; these are the keys whose value differs (a key added or removed counts), contextual ones left out
    /// (`Annots` of a page, `Fields` of the AcroForm, `AcroForm` of the catalog: the caller classifies those from the array entries).
    Changed { keys: Vec<Vec<u8>> },
    /// The object was in the signed revision and is not in the file now.
    Removed,
}

impl LaterChanges {
    const SIGNATURES: Self = Self {
        signatures: true,
        form_fill: false,
        annotations: false,
        other: false,
    };
    const FORM_FILL: Self = Self {
        signatures: false,
        form_fill: true,
        annotations: false,
        other: false,
    };
    const ANNOTATIONS: Self = Self {
        signatures: false,
        form_fill: false,
        annotations: true,
        other: false,
    };
    pub const OTHER: Self = Self {
        signatures: false,
        form_fill: false,
        annotations: false,
        other: true,
    };

    /// The classes of both.
    #[must_use]
    pub const fn merge(self, more: Self) -> Self {
        Self {
            signatures: self.signatures || more.signatures,
            form_fill: self.form_fill || more.form_fill,
            annotations: self.annotations || more.annotations,
            other: self.other || more.other,
        }
    }

    /// Nothing changed.
    pub const fn is_empty(&self) -> bool {
        !(self.signatures || self.form_fill || self.annotations || self.other)
    }
}

/// The classes of one changed object. `kind` is what the object is now (what it was for a removed one); `before` what it was in the
/// signed revision (`None` for a new object). An object that became another kind is `other`. `had_value` says a signature field already
/// held a signature in the signed revision.
pub fn classify(
    kind: Kind,
    before: Option<Kind>,
    change: &Change,
    had_value: bool,
) -> LaterChanges {
    if before.is_some_and(|b| b != kind) {
        return LaterChanges::OTHER;
    }
    match change {
        Change::New => match kind {
            Kind::SigValue | Kind::SigField => LaterChanges::SIGNATURES,
            Kind::Annot => LaterChanges::ANNOTATIONS,
            _ => LaterChanges::OTHER,
        },
        Change::Removed => match kind {
            Kind::Annot => LaterChanges::ANNOTATIONS,
            _ => LaterChanges::OTHER,
        },
        Change::Changed { keys } => {
            let mut out = LaterChanges::default();
            for key in keys {
                out = out.merge(key_class(kind, key, had_value));
            }
            out
        }
    }
}

fn key_class(kind: Kind, key: &[u8], had_value: bool) -> LaterChanges {
    match kind {
        Kind::Catalog => match key {
            b"Perms" | b"DSS" | b"Extensions" => LaterChanges::SIGNATURES,
            _ => LaterChanges::OTHER,
        },
        Kind::AcroForm => match key {
            b"SigFlags" => LaterChanges::SIGNATURES,
            b"NeedAppearances" | b"DA" | b"DR" => LaterChanges::FORM_FILL,
            _ => LaterChanges::OTHER,
        },
        Kind::SigField => match key {
            // A signature that is replaced is not a signature that is added.
            b"V" if had_value => LaterChanges::OTHER,
            b"V" | b"AP" | b"AS" | b"M" => LaterChanges::SIGNATURES,
            _ => LaterChanges::OTHER,
        },
        Kind::FormField => match key {
            b"V" | b"AS" | b"AP" | b"M" => LaterChanges::FORM_FILL,
            _ => LaterChanges::OTHER,
        },
        Kind::Annot => LaterChanges::ANNOTATIONS,
        // A page may only gain annotations (the caller classifies them); an indirect array is classified from its entries; a signature
        // dictionary or any other object never changes in place.
        Kind::Page | Kind::AnnotsArray | Kind::FieldsArray | Kind::SigValue | Kind::Other => {
            LaterChanges::OTHER
        }
    }
}

/// Classes of an entry added to an `/Annots` array (`widget_sig`: the entry is a signature widget; `widget`: a widget of any field).
pub const fn added_annotation(widget: bool, widget_sig: bool) -> LaterChanges {
    match (widget, widget_sig) {
        (_, true) => LaterChanges::SIGNATURES,
        (false, false) => LaterChanges::ANNOTATIONS,
        // A new form field is a change of the form, not a fill.
        (true, false) => LaterChanges::OTHER,
    }
}

/// Classes of an entry added to the AcroForm's `/Fields`.
pub const fn added_field(sig: bool) -> LaterChanges {
    if sig {
        LaterChanges::SIGNATURES
    } else {
        LaterChanges::OTHER
    }
}

/// Classes of an entry that left an `/Annots` array: a removed annotation is an annotation change, anything else is `other`.
pub const fn removed_annotation(plain_annotation: bool) -> LaterChanges {
    if plain_annotation {
        LaterChanges::ANNOTATIONS
    } else {
        LaterChanges::OTHER
    }
}

/// The verdict of the later changes against the DocMDP level `p` of the document (1 no changes, 2 form fill and signatures, 3 and
/// annotations). No certification (`None`) is judged like 2: a signer who did not certify still did not agree to a rewrite.
pub const fn verdict(later: LaterChanges, p: Option<u8>) -> Verdict {
    let level = match p {
        Some(1) => 1,
        Some(3) => 3,
        _ => 2,
    };
    let allowed = !later.other
        && (!later.signatures || level >= 2)
        && (!later.form_fill || level >= 2)
        && (!later.annotations || level >= 3);
    if allowed {
        Verdict::Allowed
    } else {
        Verdict::Disallowed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keys(names: &[&str]) -> Change {
        Change::Changed {
            keys: names.iter().map(|k| k.as_bytes().to_vec()).collect(),
        }
    }

    #[test]
    fn form_fill_touches_values_and_appearances_only() {
        let fill = classify(
            Kind::FormField,
            Some(Kind::FormField),
            &keys(&["V", "AP"]),
            false,
        );
        assert_eq!(fill, LaterChanges::FORM_FILL);
        let moved = classify(
            Kind::FormField,
            Some(Kind::FormField),
            &keys(&["V", "Rect"]),
            false,
        );
        assert!(moved.other && moved.form_fill);
    }

    #[test]
    fn a_replaced_signature_is_other_and_a_filled_empty_field_is_not() {
        let k = keys(&["V"]);
        assert_eq!(
            classify(Kind::SigField, Some(Kind::SigField), &k, false),
            LaterChanges::SIGNATURES
        );
        assert_eq!(
            classify(Kind::SigField, Some(Kind::SigField), &k, true),
            LaterChanges::OTHER
        );
        assert_eq!(
            classify(
                Kind::SigValue,
                Some(Kind::SigValue),
                &keys(&["Contents"]),
                false
            ),
            LaterChanges::OTHER
        );
    }

    #[test]
    fn an_object_that_changes_its_type_is_other() {
        assert_eq!(
            classify(Kind::Annot, Some(Kind::Other), &keys(&["Contents"]), false),
            LaterChanges::OTHER
        );
        assert_eq!(
            classify(Kind::Other, Some(Kind::Annot), &keys(&["Contents"]), false),
            LaterChanges::OTHER
        );
    }

    #[test]
    fn new_and_removed_objects() {
        assert_eq!(
            classify(Kind::Annot, None, &Change::New, false),
            LaterChanges::ANNOTATIONS
        );
        assert_eq!(
            classify(Kind::Page, None, &Change::New, false),
            LaterChanges::OTHER
        );
        assert_eq!(
            classify(Kind::SigField, None, &Change::New, false),
            LaterChanges::SIGNATURES
        );
        assert_eq!(
            classify(Kind::SigField, Some(Kind::SigField), &Change::Removed, true),
            LaterChanges::OTHER
        );
        assert_eq!(
            classify(Kind::Annot, Some(Kind::Annot), &Change::Removed, false),
            LaterChanges::ANNOTATIONS
        );
    }

    #[test]
    fn the_verdict_follows_the_docmdp_level() {
        let sig = LaterChanges::SIGNATURES;
        let fill = LaterChanges::FORM_FILL;
        let note = LaterChanges::ANNOTATIONS;
        let other = LaterChanges::OTHER;
        assert_eq!(verdict(LaterChanges::default(), Some(1)), Verdict::Allowed);
        assert_eq!(verdict(sig, Some(1)), Verdict::Disallowed);
        assert_eq!(verdict(fill, Some(1)), Verdict::Disallowed);
        assert_eq!(verdict(sig.merge(fill), Some(2)), Verdict::Allowed);
        assert_eq!(verdict(note, Some(2)), Verdict::Disallowed);
        assert_eq!(verdict(note, Some(3)), Verdict::Allowed);
        assert_eq!(verdict(note, None), Verdict::Disallowed);
        assert_eq!(verdict(fill, None), Verdict::Allowed);
        assert_eq!(verdict(other, Some(3)), Verdict::Disallowed);
    }
}
