//! Reading the signature fields of a document (ADR-121 sections 1 and 4, ARCHITECTURE section 5 "Certificate signatures (v1.4)").
//!
//! [`scan_fields`] lists the `/FT /Sig` fields of the AcroForm with what their `/V` dictionaries claim (ByteRange, the length of
//! `/Contents`, SubFilter, `/M`, `/Reason`, `/Location`, `/Name`) and the certification level of the catalog (`/Perms /DocMDP`).
//! Nothing is verified here: this is the file's own claim, for the lock and as the input of the validator. Every PDF is hostile input:
//! the walk is iterative, every object is visited once, the number of nodes, the depth, the number of fields, the length of names and
//! texts and the size of a ByteRange are capped (`limits::SIG_*`), and the document comes from `load_untrusted`.

use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::time::Instant;

use lopdf::{Dictionary, Document, Object, ObjectId};

use super::forms::decode_text;
use crate::documents::sanitize_text;
use crate::error::{AppError, ErrorCode};
use crate::limits;
use crate::pdfsig::coverage::{self, Change, Kind};
use crate::pdfsig::revisions as chain;
use crate::pdfsig::types::{
    Coverage, Cryptographic, LaterChanges, SigField, SigScan, SignatureInfo, SignatureKind,
    SignatureLock, SubFilter, Trust,
};
use crate::pdfsig::verify::{self, RawSignature};

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

// --- Validation (ADR-121 section 4) ----------------------------------------------------------------------------------------

/// The revision ends of a file (`pdfsig::revisions`): at most `limits::SIG_REVISIONS_MAX`, else `limit_exceeded` (`revisions`).
pub fn revisions(bytes: &[u8]) -> Result<Vec<u64>, AppError> {
    let (ends, truncated) = chain::revision_ends(bytes);
    if truncated {
        return Err(AppError::limit(
            "revisions",
            limits::SIG_REVISIONS_MAX as u64,
        ));
    }
    Ok(ends)
}

/// One signature as validated, with what the command layer needs besides the wire type.
#[derive(Debug, Clone, PartialEq)]
pub struct Validated {
    /// The wire value; `widget` is `None` here (the command layer maps `page_index` to a page id).
    pub info: SignatureInfo,
    /// SHA-256 of the signer certificate (what a pin holds), 64 lowercase hex digits.
    pub fingerprint: Option<String>,
    /// The page of the seal in the file (0-based) and its rectangle `[llx lly urx ury]` (normalized); `None` for an invisible one.
    pub page_index: Option<u32>,
    pub rect: Option<[f32; 4]>,
    /// `b + c` of a signature whose layout holds: the end of the bytes it covers.
    pub signed_end: Option<u64>,
}

/// The validated signatures of a file.
#[derive(Debug, Clone, PartialEq)]
pub struct Validation {
    pub signatures: Vec<Validated>,
    pub truncated: bool,
    pub lock: SignatureLock,
}

/// Validates every signature of `bytes` (a file as it is on disk). An encrypted file is `unsupported_feature`. Past `deadline` the
/// signatures not yet looked at are `unverifiable` and the result `truncated`. Never panics: each signature runs under `catch_unwind`.
pub fn validate_bytes(bytes: &[u8], deadline: Instant) -> Result<Validation, AppError> {
    let doc = super::load_untrusted(bytes)?;
    if doc.is_encrypted() {
        return Err(AppError::new(ErrorCode::UnsupportedFeature));
    }
    let scan = scan_fields(&doc)?;
    let (ends, ends_truncated) = chain::revision_ends(bytes);
    let pages: HashMap<ObjectId, u32> = doc
        .get_pages()
        .into_iter()
        .map(|(number, id)| (id, number.saturating_sub(1)))
        .collect();
    let mut prefixes: HashMap<u64, Option<Document>> = HashMap::new();
    let mut truncated = scan.truncated;
    let mut signatures = Vec::new();
    for field in scan.fields.iter().filter(|field| field.signed) {
        let index = u32::try_from(signatures.len()).unwrap_or(u32::MAX);
        if Instant::now() >= deadline {
            truncated = true;
            signatures.push(skeleton(
                index,
                field,
                scan.doc_mdp,
                Cryptographic::Unverifiable,
            ));
            continue;
        }
        let env = Env {
            bytes,
            doc: &doc,
            ends: &ends,
            ends_truncated,
            pages: &pages,
            doc_mdp: scan.doc_mdp,
        };
        let one = catch_unwind(AssertUnwindSafe(|| {
            validate_one(&env, index, field, &mut prefixes)
        }))
        .unwrap_or_else(|_| skeleton(index, field, scan.doc_mdp, Cryptographic::Malformed));
        signatures.push(one);
    }
    let lock = if signatures.is_empty() {
        SignatureLock::None
    } else {
        SignatureLock::from_doc_mdp(scan.doc_mdp)
    };
    Ok(Validation {
        signatures,
        truncated,
        lock,
    })
}

struct Env<'a> {
    bytes: &'a [u8],
    doc: &'a Document,
    ends: &'a [u64],
    ends_truncated: bool,
    pages: &'a HashMap<ObjectId, u32>,
    doc_mdp: Option<u8>,
}

fn kind_of_field(field: &SigField) -> SignatureKind {
    if field.doc_timestamp {
        SignatureKind::DocTimestamp
    } else if let Some(p) = field.cert_p {
        SignatureKind::Certification { p }
    } else {
        SignatureKind::Approval
    }
}

/// The report entry of a signature with nothing verified: what the field claims and `verdict`.
fn skeleton(
    index: u32,
    field: &SigField,
    doc_mdp: Option<u8>,
    verdict: Cryptographic,
) -> Validated {
    let _ = doc_mdp;
    let sub_filter = field
        .sub_filter
        .as_deref()
        .map_or(SubFilter::Other, |name| {
            SubFilter::from_name(name.as_bytes())
        });
    Validated {
        info: SignatureInfo {
            index,
            field_name: sanitize_text(&field.name, limits::SIG_FIELD_NAME_MAX),
            kind: kind_of_field(field),
            sub_filter,
            signer: None,
            claimed_time: field
                .signed_at
                .as_deref()
                .and_then(verify::parse_pdf_date)
                .map(|(iso, _)| iso),
            reason: field
                .reason
                .as_deref()
                .map(|t| sanitize_text(t, limits::SIG_TEXT_READ_MAX)),
            location: field
                .location
                .as_deref()
                .map(|t| sanitize_text(t, limits::SIG_TEXT_READ_MAX)),
            cryptographic: verdict,
            weak_algorithm: false,
            timestamp_present: sub_filter == SubFilter::EtsiRfc3161,
            coverage: Coverage::WholeFile,
            cert_valid_at_claimed_time: false,
            trust: Trust::NotTrusted,
            widget: None,
        },
        fingerprint: None,
        page_index: None,
        rect: None,
        signed_end: None,
    }
}

fn validate_one(
    env: &Env<'_>,
    index: u32,
    field: &SigField,
    prefixes: &mut HashMap<u64, Option<Document>>,
) -> Validated {
    let mut out = skeleton(index, field, env.doc_mdp, Cryptographic::Malformed);
    let (page_index, rect) = seal_place(env, field);
    out.page_index = page_index;
    out.rect = rect;
    let sub_filter = out.info.sub_filter;
    // Step (ii): the layout of the ByteRange and the /Contents gap.
    let layout = match field.byte_range.as_deref() {
        Some(range) => chain::check_layout(env.bytes, range, env.ends, env.ends_truncated),
        None => Err(Cryptographic::Malformed),
    };
    let layout = match layout {
        Ok(layout) => layout,
        Err(verdict) => {
            out.info.cryptographic = verdict;
            return out;
        }
    };
    out.signed_end = Some(layout.end());
    let (Ok(a), Ok(b), Ok(end)) = (
        usize::try_from(layout.a),
        usize::try_from(layout.b),
        usize::try_from(layout.end()),
    ) else {
        return out;
    };
    // The token in the gap is the dictionary's own /Contents (a decoy elsewhere cannot verify: the real one would be hashed).
    let contents = match chain::gap_hex(env.bytes, &layout) {
        Ok(contents) => contents,
        Err(verdict) => {
            out.info.cryptographic = verdict;
            return out;
        }
    };
    let own = sig_contents(env.doc, field);
    if own.as_deref() != Some(contents.as_slice()) || contents.iter().all(|byte| *byte == 0) {
        // Empty, null or somebody else's /Contents: universal signature forgery and wrapping end here.
        return out;
    }
    // Steps (iii) to (vi).
    let claimed = field.signed_at.as_deref().and_then(verify::parse_pdf_date);
    let mut ranges = (&env.bytes[..a]).chain(&env.bytes[b..end]);
    let checked = verify::check(
        &RawSignature {
            sub_filter,
            contents: &contents,
            claimed_unix: claimed.as_ref().map(|(_, unix)| *unix),
        },
        &mut ranges,
    );
    out.info.cryptographic = checked.cryptographic;
    out.info.weak_algorithm = checked.weak_algorithm;
    out.info.signer = checked.signer;
    out.info.timestamp_present |= checked.timestamp_present;
    out.info.cert_valid_at_claimed_time = checked.cert_valid_at_claimed_time;
    out.info.claimed_time = claimed.map(|(iso, _)| iso).or(checked.cms_signing_time);
    out.fingerprint = checked.signer_fingerprint;
    // Step (vii): coverage.
    out.info.coverage = coverage_of(env, layout.end(), prefixes);
    out
}

/// Whether the signed revision is the whole file, else what was changed after it.
fn coverage_of(env: &Env<'_>, end: u64, prefixes: &mut HashMap<u64, Option<Document>>) -> Coverage {
    let Ok(at) = usize::try_from(end) else {
        return Coverage::WholeFile;
    };
    let rest = env.bytes.get(at..).unwrap_or(&[]);
    if rest.iter().all(|b| b.is_ascii_whitespace() || *b == 0) {
        return Coverage::WholeFile;
    }
    let revision = env
        .ends
        .iter()
        .position(|e| *e >= end)
        .map_or(1, |i| u32::try_from(i + 1).unwrap_or(u32::MAX));
    let prefix = prefixes.entry(end).or_insert_with(|| {
        // The signed bytes have to be a document of their own (the same pre-scan as every file).
        super::load_untrusted(&env.bytes[..at]).ok()
    });
    let later = match prefix {
        Some(old) => {
            let diff = catch_unwind(AssertUnwindSafe(|| revision_diff(old, env.doc)));
            match diff {
                Ok(diff) => {
                    let mut later = diff.later;
                    // Bytes after the signed revision that change nothing visible in the object set are still not the signed file.
                    let nothing = later.is_empty();
                    later.other |= diff.truncated || nothing;
                    later
                }
                Err(_) => LaterChanges::OTHER,
            }
        }
        None => LaterChanges::OTHER,
    };
    Coverage::EarlierRevision {
        revision,
        later,
        verdict: coverage::verdict(later, env.doc_mdp),
    }
}

/// The decoded `/Contents` of the signature dictionary of `field`, as lopdf read it.
fn sig_contents(doc: &Document, field: &SigField) -> Option<Vec<u8>> {
    let dict = doc.get_dictionary(field.object?).ok()?;
    let value = match dict.get(b"V").ok()? {
        Object::Reference(target) => doc.get_dictionary(*target).ok()?,
        Object::Dictionary(inline) => inline,
        _ => return None,
    };
    match value.get(b"Contents").ok()? {
        Object::String(bytes, _) => Some(bytes.clone()),
        _ => None,
    }
}

/// The page (0-based, in the file) and the normalized rectangle of a visible seal.
fn seal_place(env: &Env<'_>, field: &SigField) -> (Option<u32>, Option<[f32; 4]>) {
    let rect = field.rect.and_then(|[x0, y0, x1, y1]| {
        let (left, right) = (x0.min(x1), x0.max(x1));
        let (bottom, top) = (y0.min(y1), y0.max(y1));
        (right > left && top > bottom).then_some([left, bottom, right, top])
    });
    if rect.is_none() {
        return (None, None);
    }
    let page = field
        .page
        .and_then(|id| env.pages.get(&id).copied())
        .or_else(|| {
            // Without /P the page is the one whose /Annots lists the widget.
            let widget = field.object?;
            env.pages.iter().find_map(|(page, index)| {
                let dict = env.doc.get_dictionary(*page).ok()?;
                match entry(env.doc, dict, b"Annots")? {
                    Object::Array(items) => items
                        .iter()
                        .take(limits::SIG_SCAN_NODES_MAX)
                        .any(|item| item.as_reference().is_ok_and(|id| id == widget))
                        .then_some(*index),
                    _ => None,
                }
            })
        });
    (page, rect)
}

// --- The revision diff ---------------------------------------------------------------------------------------------------

/// What differs between the signed revision and the file now.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Diff {
    pub later: LaterChanges,
    /// More than `limits::SIG_DIFF_OBJECTS_MAX` objects changed: the rest was not classified.
    pub truncated: bool,
}

/// What the rules need to know about the shape of a document.
struct Shape<'a> {
    doc: &'a Document,
    catalog: Option<ObjectId>,
    acroform: Option<ObjectId>,
    pages: HashSet<ObjectId>,
    annots_arrays: HashSet<ObjectId>,
    fields_arrays: HashSet<ObjectId>,
}

impl<'a> Shape<'a> {
    fn new(doc: &'a Document) -> Self {
        let catalog = doc
            .trailer
            .get(b"Root")
            .ok()
            .and_then(|root| root.as_reference().ok());
        let catalog_dict = catalog.and_then(|id| doc.get_dictionary(id).ok());
        let acroform = catalog_dict
            .and_then(|c| c.get(b"AcroForm").ok())
            .and_then(|a| a.as_reference().ok());
        let pages: HashSet<ObjectId> = doc.get_pages().into_values().collect();
        let annots_arrays = pages
            .iter()
            .filter_map(|id| doc.get_dictionary(*id).ok())
            .filter_map(|page| page.get(b"Annots").ok()?.as_reference().ok())
            .collect();
        let fields_arrays = acroform
            .and_then(|id| doc.get_dictionary(id).ok())
            .and_then(|form| form.get(b"Fields").ok()?.as_reference().ok())
            .into_iter()
            .collect();
        Self {
            doc,
            catalog,
            acroform,
            pages,
            annots_arrays,
            fields_arrays,
        }
    }

    fn kind(&self, id: ObjectId, object: &Object) -> Kind {
        if Some(id) == self.catalog {
            return Kind::Catalog;
        }
        if Some(id) == self.acroform {
            return Kind::AcroForm;
        }
        if self.pages.contains(&id) {
            return Kind::Page;
        }
        if self.annots_arrays.contains(&id) {
            return Kind::AnnotsArray;
        }
        if self.fields_arrays.contains(&id) {
            return Kind::FieldsArray;
        }
        match object {
            Object::Dictionary(dict) => self.dict_kind(dict),
            _ => Kind::Other,
        }
    }

    fn dict_kind(&self, dict: &Dictionary) -> Kind {
        let type_is = |name: &[u8]| matches!(entry(self.doc, dict, b"Type"), Some(Object::Name(t)) if t == name);
        if type_is(b"Sig")
            || type_is(b"DocTimeStamp")
            || (dict.has(b"ByteRange") && dict.has(b"Contents") && dict.has(b"SubFilter"))
        {
            return Kind::SigValue;
        }
        let widget =
            matches!(entry(self.doc, dict, b"Subtype"), Some(Object::Name(t)) if t == b"Widget");
        if widget || dict.has(b"FT") || dict.has(b"T") {
            return if self.is_sig_field(dict) {
                Kind::SigField
            } else {
                Kind::FormField
            };
        }
        if dict.has(b"Subtype") && dict.has(b"Rect") {
            return Kind::Annot;
        }
        Kind::Other
    }

    fn is_sig_field(&self, dict: &Dictionary) -> bool {
        let mut current = dict;
        for _ in 0..limits::SIG_SCAN_DEPTH_MAX {
            if let Some(Object::Name(ft)) = entry(self.doc, current, b"FT") {
                return ft == b"Sig";
            }
            match current
                .get(b"Parent")
                .ok()
                .and_then(|p| p.as_reference().ok())
                .and_then(|id| self.doc.get_dictionary(id).ok())
            {
                Some(parent) => current = parent,
                None => return false,
            }
        }
        false
    }

    fn is_widget(&self, dict: &Dictionary) -> bool {
        matches!(entry(self.doc, dict, b"Subtype"), Some(Object::Name(t)) if t == b"Widget")
    }

    /// The entries of an array value (an indirect array is followed once).
    fn entries(&self, value: Option<&'a Object>) -> Vec<&'a Object> {
        match value {
            Some(Object::Array(items)) => items.iter().collect(),
            Some(Object::Reference(id)) => match self.doc.objects.get(id) {
                Some(Object::Array(items)) => items.iter().collect(),
                _ => Vec::new(),
            },
            _ => Vec::new(),
        }
    }
}

fn object_dict(object: &Object) -> Option<&Dictionary> {
    match object {
        Object::Dictionary(dict) => Some(dict),
        Object::Stream(stream) => Some(&stream.dict),
        _ => None,
    }
}

/// The keys whose value differs between two dictionaries (a key present on one side only counts), except `skip`.
fn differing_keys(old: &Dictionary, new: &Dictionary, skip: &[&[u8]]) -> Vec<Vec<u8>> {
    let mut keys: Vec<Vec<u8>> = Vec::new();
    for (key, value) in new.iter() {
        if !skip.contains(&key.as_slice()) && old.get(key).ok() != Some(value) {
            keys.push(key.clone());
        }
    }
    for (key, _) in old.iter() {
        if !skip.contains(&key.as_slice()) && !new.has(key) {
            keys.push(key.clone());
        }
    }
    keys
}

/// Entries that were added to and removed from an array, by reference; an inline entry that differs counts as both.
fn array_delta<'a>(
    old: &[&'a Object],
    new: &[&'a Object],
) -> (Vec<ObjectId>, Vec<ObjectId>, bool /* inline differs */) {
    let old_refs: HashSet<ObjectId> = old.iter().filter_map(|o| o.as_reference().ok()).collect();
    let new_refs: HashSet<ObjectId> = new.iter().filter_map(|o| o.as_reference().ok()).collect();
    let inline = |items: &[&Object]| -> Vec<Object> {
        items
            .iter()
            .filter(|o| o.as_reference().is_err())
            .map(|o| (*o).clone())
            .collect()
    };
    let inline_differs = inline(old) != inline(new);
    let added = new
        .iter()
        .filter_map(|o| o.as_reference().ok())
        .filter(|id| !old_refs.contains(id))
        .collect();
    let removed = old
        .iter()
        .filter_map(|o| o.as_reference().ok())
        .filter(|id| !new_refs.contains(id))
        .collect();
    (added, removed, inline_differs)
}

/// What a change of the `/Annots` array of a page is, from its entries.
fn annots_change(
    old: &Shape<'_>,
    new: &Shape<'_>,
    old_value: Option<&Object>,
    new_value: Option<&Object>,
) -> LaterChanges {
    let (old_items, new_items) = (old.entries(old_value), new.entries(new_value));
    if old_items.len().max(new_items.len()) > limits::SIG_SCAN_NODES_MAX {
        return LaterChanges::OTHER;
    }
    let (added, removed, inline) = array_delta(&old_items, &new_items);
    let mut out = if inline {
        LaterChanges::OTHER
    } else {
        LaterChanges::default()
    };
    for id in added {
        out = out.merge(match new.doc.get_dictionary(id) {
            Ok(dict) => {
                let widget = new.is_widget(dict);
                coverage::added_annotation(widget, widget && new.is_sig_field(dict))
            }
            Err(_) => LaterChanges::OTHER,
        });
    }
    for id in removed {
        out = out.merge(match old.doc.get_dictionary(id) {
            Ok(dict) => coverage::removed_annotation(old.dict_kind(dict) == Kind::Annot),
            Err(_) => LaterChanges::OTHER,
        });
    }
    out
}

/// What a change of the AcroForm's `/Fields` array is, from its entries.
fn fields_change(
    old: &Shape<'_>,
    new: &Shape<'_>,
    old_value: Option<&Object>,
    new_value: Option<&Object>,
) -> LaterChanges {
    let (old_items, new_items) = (old.entries(old_value), new.entries(new_value));
    if old_items.len().max(new_items.len()) > limits::SIG_SCAN_NODES_MAX {
        return LaterChanges::OTHER;
    }
    let (added, removed, inline) = array_delta(&old_items, &new_items);
    let mut out = if inline || !removed.is_empty() {
        LaterChanges::OTHER
    } else {
        LaterChanges::default()
    };
    for id in added {
        out = out.merge(match new.doc.get_dictionary(id) {
            Ok(dict) => coverage::added_field(new.is_sig_field(dict)),
            Err(_) => LaterChanges::OTHER,
        });
    }
    out
}

/// What the AcroForm dictionary changing from `old_form` (none: there was no form) to `new_form` is.
fn acroform_change(
    old: &Shape<'_>,
    new: &Shape<'_>,
    old_form: Option<&Dictionary>,
    new_form: &Dictionary,
) -> LaterChanges {
    let empty = Dictionary::new();
    let old_form = old_form.unwrap_or(&empty);
    let keys = differing_keys(old_form, new_form, &[b"Fields"]);
    let mut out = coverage::classify(
        Kind::AcroForm,
        Some(Kind::AcroForm),
        &Change::Changed { keys },
        false,
    );
    if old_form.get(b"Fields").ok() != new_form.get(b"Fields").ok() {
        out = out.merge(fields_change(
            old,
            new,
            old_form.get(b"Fields").ok(),
            new_form.get(b"Fields").ok(),
        ));
    }
    out
}

fn form_dict<'a>(shape: &Shape<'a>) -> Option<&'a Dictionary> {
    let catalog = shape.doc.get_dictionary(shape.catalog?).ok()?;
    dict_of(shape.doc, catalog, b"AcroForm")
}

/// The objects an annotation's appearance owns that are new or are the appearance streams themselves, with the class of the annotation.
fn claim_appearances(
    shape: &Shape<'_>,
    old: &Document,
    dict: &Dictionary,
    class: LaterChanges,
    claims: &mut HashMap<ObjectId, LaterChanges>,
) {
    let Some(Object::Dictionary(ap)) = entry(shape.doc, dict, b"AP") else {
        return;
    };
    let mut direct: Vec<ObjectId> = Vec::new();
    for value in ap.iter().map(|(_, v)| v) {
        match value {
            Object::Reference(id) => direct.push(*id),
            Object::Dictionary(states) => {
                direct.extend(states.iter().filter_map(|(_, v)| v.as_reference().ok()));
            }
            _ => {}
        }
    }
    claim_from(shape, old, direct, class, claims, true);
}

/// Claims `roots` (when `roots_always`) and, down to depth 4 and 256 objects, the new objects they reference.
fn claim_from(
    shape: &Shape<'_>,
    old: &Document,
    roots: Vec<ObjectId>,
    class: LaterChanges,
    claims: &mut HashMap<ObjectId, LaterChanges>,
    roots_always: bool,
) {
    let mut queue: Vec<(ObjectId, usize)> = roots.into_iter().map(|id| (id, 0)).collect();
    let mut seen: HashSet<ObjectId> = HashSet::new();
    while let Some((id, depth)) = queue.pop() {
        if seen.len() >= 256 || !seen.insert(id) {
            continue;
        }
        let is_new = !old.objects.contains_key(&id);
        if is_new || (roots_always && depth == 0) {
            claims
                .entry(id)
                .and_modify(|c| *c = c.merge(class))
                .or_insert(class);
        }
        if depth >= 4 {
            continue;
        }
        let Some(object) = shape.doc.objects.get(&id) else {
            continue;
        };
        let Some(dict) = object_dict(object) else {
            continue;
        };
        for (_, value) in dict.iter() {
            collect_refs(value, &mut |next| queue.push((next, depth + 1)), 0);
        }
    }
}

fn collect_refs(value: &Object, push: &mut dyn FnMut(ObjectId), depth: usize) {
    if depth > 8 {
        return;
    }
    match value {
        Object::Reference(id) => push(*id),
        Object::Array(items) => items
            .iter()
            .take(limits::SIG_SCAN_NODES_MAX)
            .for_each(|item| collect_refs(item, push, depth + 1)),
        Object::Dictionary(dict) => dict
            .iter()
            .for_each(|(_, v)| collect_refs(v, push, depth + 1)),
        _ => {}
    }
}

/// Classifies what changed between `old` (the signed revision) and `new` (the file now), by `pdfsig::coverage`'s rules. Never panics
/// and never recurses on file data; at most `limits::SIG_DIFF_OBJECTS_MAX` changed objects are classified (then `truncated`).
pub fn revision_diff(old: &Document, new: &Document) -> Diff {
    let (old_shape, new_shape) = (Shape::new(old), Shape::new(new));
    let mut diff = Diff::default();
    let mut later = LaterChanges::default();
    // A different catalog, or a security handler that appeared or changed, is a different document.
    if old.trailer.get(b"Root").ok() != new.trailer.get(b"Root").ok()
        || old.trailer.get(b"Encrypt").ok() != new.trailer.get(b"Encrypt").ok()
    {
        later.other = true;
    }
    let mut claims: HashMap<ObjectId, LaterChanges> = HashMap::new();
    let mut deferred: Vec<ObjectId> = Vec::new();
    let mut changed = 0usize;
    for (id, object) in &new.objects {
        if is_structural(object) {
            continue;
        }
        let old_object = old.objects.get(id);
        if old_object == Some(object) {
            continue;
        }
        changed += 1;
        if changed > limits::SIG_DIFF_OBJECTS_MAX {
            diff.truncated = true;
            break;
        }
        let kind = new_shape.kind(*id, object);
        let before = old_object.map(|o| old_shape.kind(*id, o));
        let new_dict = object_dict(object);
        let old_dict = old_object.and_then(object_dict);
        match kind {
            Kind::AcroForm => {
                let Some(new_form) = new_dict else {
                    later.other = true;
                    continue;
                };
                later = later.merge(acroform_change(
                    &old_shape,
                    &new_shape,
                    form_dict(&old_shape),
                    new_form,
                ));
            }
            Kind::AnnotsArray | Kind::FieldsArray => {
                // A new array is the owner's business (the page's or the form's key that points to it).
                if let Some(old_object) = old_object {
                    later = later.merge(if kind == Kind::AnnotsArray {
                        annots_change(&old_shape, &new_shape, Some(old_object), Some(object))
                    } else {
                        fields_change(&old_shape, &new_shape, Some(old_object), Some(object))
                    });
                }
            }
            Kind::Page | Kind::Catalog => {
                let (Some(new_dict), Some(old_dict)) = (new_dict, old_dict) else {
                    later.other = true;
                    continue;
                };
                if before != Some(kind) {
                    later.other = true;
                    continue;
                }
                let contextual: &[u8] = if kind == Kind::Page {
                    b"Annots"
                } else {
                    b"AcroForm"
                };
                let keys = differing_keys(old_dict, new_dict, &[contextual]);
                later = later.merge(coverage::classify(
                    kind,
                    before,
                    &Change::Changed { keys },
                    false,
                ));
                if old_dict.get(contextual).ok() != new_dict.get(contextual).ok() {
                    later = later.merge(if kind == Kind::Page {
                        annots_change(
                            &old_shape,
                            &new_shape,
                            old_dict.get(b"Annots").ok(),
                            new_dict.get(b"Annots").ok(),
                        )
                    } else {
                        match form_dict(&new_shape) {
                            Some(form) => {
                                acroform_change(&old_shape, &new_shape, form_dict(&old_shape), form)
                            }
                            None => LaterChanges::OTHER,
                        }
                    });
                }
            }
            _ => {
                let change = match (old_object, new_dict, old_dict) {
                    (None, _, _) => Change::New,
                    (Some(_), Some(new_dict), Some(old_dict)) => Change::Changed {
                        keys: differing_keys(old_dict, new_dict, &[]),
                    },
                    // A stream or another value that changed in place.
                    (Some(_), _, _) => Change::Changed {
                        keys: vec![b"*".to_vec()],
                    },
                };
                let had_value = old_dict.is_some_and(|d| d.has(b"V"));
                let class = coverage::classify(kind, before, &change, had_value);
                if kind == Kind::Other {
                    if before.is_some_and(|b| b != Kind::Other) {
                        later.other = true;
                    } else {
                        deferred.push(*id);
                    }
                    continue;
                }
                later = later.merge(class);
                if before.is_none_or(|b| b == kind) {
                    if let Some(dict) = new_dict {
                        match kind {
                            Kind::Annot | Kind::FormField | Kind::SigField if !class.other => {
                                claim_appearances(&new_shape, old, dict, class, &mut claims);
                            }
                            Kind::SigValue if !class.other => {
                                let refs = {
                                    let mut found = Vec::new();
                                    for (_, value) in dict.iter() {
                                        collect_refs(value, &mut |r| found.push(r), 0);
                                    }
                                    found
                                };
                                claim_from(&new_shape, old, refs, class, &mut claims, false);
                            }
                            _ => {}
                        }
                    }
                }
            }
        }
    }
    // Objects of no known kind are `other` unless a changed annotation or signature owns them.
    for id in deferred {
        later = later.merge(claims.get(&id).copied().unwrap_or(LaterChanges::OTHER));
    }
    // What the signed revision had and the file does not.
    if !diff.truncated {
        for (id, object) in &old.objects {
            if is_structural(object) || new.objects.contains_key(id) {
                continue;
            }
            later = later.merge(coverage::classify(
                old_shape.kind(*id, object),
                Some(old_shape.kind(*id, object)),
                &Change::Removed,
                false,
            ));
        }
    }
    diff.later = later;
    if diff.truncated {
        diff.later.other = true;
    }
    diff
}

/// Cross-reference and object streams are the file's own bookkeeping, not content.
fn is_structural(object: &Object) -> bool {
    matches!(
        object,
        Object::Stream(stream)
            if matches!(stream.dict.get(b"Type"), Ok(Object::Name(t)) if t == b"XRef" || t == b"ObjStm")
    )
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
