//! Flatten (ADR-041 §4): the appearances of form widgets, and optionally of the other annotations, are burned into the page content,
//! and the widgets and the AcroForm go. A pure function on bytes (no PDFium, no files, no dialogs); `commands/jobs.rs` owns the job.
//!
//! The caller hands over a file in which every changed field already has its appearance (`forms::write_values`). Per page, each
//! annotation to burn becomes `q <matrix> cm /SheerFlN Do Q` after the page content, which is itself wrapped in `q … Q` so that
//! whatever state it leaves does not move the appearances. The matrix is the one of PDF 32000 §12.5.5 (algorithm 8.1): `/BBox`
//! through `/Matrix` fitted onto `/Rect`. `/Rect` is in default user space, so the page's `/Rotate` needs no extra step; a widget's
//! `/MK /R` is part of its appearance stream. The result is saved whole and its unreachable objects (the fields, their values) are
//! pruned, so nothing of a flattened field stays in the file. A `NoRotate` annotation keeps its upper-left corner (as displayed) and
//! stays upright on a rotated page: [`placement_upright`].

use std::collections::HashSet;

use lopdf::{Dictionary, Document, Object, ObjectId, Stream};
use serde::Deserialize;

use super::produce::{Control, Output, Phase, Warning};
use crate::error::{AppError, ErrorCode};
use crate::limits;

/// What to flatten.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FlattenScope {
    /// Form widgets only.
    Forms,
    /// Form widgets and every annotation that has an appearance (links and popups excepted).
    FormsAndAnnotations,
}

/// The options of `flatten_document`.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FlattenOptions {
    pub scope: FlattenScope,
}

/// Deepest `/Parent` chain looked at.
const MAX_DEPTH: usize = 64;
/// `/F` flags: Hidden and NoView.
const NOT_SHOWN: i64 = 2 | 32;
/// `/F` flag: NoRotate.
const NO_ROTATE: i64 = 16;
/// Most entries of the resources and XObject dictionaries copied over all pages (a shared huge dictionary is copied per page).
const MAX_RESOURCE_ENTRIES: usize = 400_000;

fn failed(detail: impl std::fmt::Display) -> AppError {
    AppError::logged(ErrorCode::SaveFailed, detail)
}

/// A matrix `[a b c d e f]`.
type Matrix = [f32; 6];

fn numbers<const N: usize>(doc: &Document, object: &Object) -> Option<[f32; N]> {
    let array = doc.dereference(object).ok()?.1.as_array().ok()?;
    if array.len() != N {
        return None;
    }
    let mut out = [0.0f32; N];
    for (slot, item) in out.iter_mut().zip(array) {
        let value = doc.dereference(item).ok()?.1.as_float().ok()?;
        if !value.is_finite() || value.abs() > 1.0e7 {
            return None;
        }
        *slot = value;
    }
    Some(out)
}

/// The matrix that puts the appearance stream `bbox` (with its own `matrix`) onto `rect`; `None` if either is degenerate.
pub fn placement(bbox: [f32; 4], matrix: Matrix, rect: [f32; 4]) -> Option<Matrix> {
    let corners = [
        (bbox[0], bbox[1]),
        (bbox[2], bbox[1]),
        (bbox[0], bbox[3]),
        (bbox[2], bbox[3]),
    ];
    let mut lo = (f32::MAX, f32::MAX);
    let mut hi = (f32::MIN, f32::MIN);
    for (x, y) in corners {
        let tx = matrix[0] * x + matrix[2] * y + matrix[4];
        let ty = matrix[1] * x + matrix[3] * y + matrix[5];
        lo = (lo.0.min(tx), lo.1.min(ty));
        hi = (hi.0.max(tx), hi.1.max(ty));
    }
    let (width, height) = (hi.0 - lo.0, hi.1 - lo.1);
    let target = [
        rect[0].min(rect[2]),
        rect[1].min(rect[3]),
        rect[0].max(rect[2]),
        rect[1].max(rect[3]),
    ];
    if !(width > 0.0 && height > 0.0) {
        return None;
    }
    let sx = (target[2] - target[0]) / width;
    let sy = (target[3] - target[1]) / height;
    let result = [
        sx,
        0.0,
        0.0,
        sy,
        target[0] - lo.0 * sx,
        target[1] - lo.1 * sy,
    ];
    result
        .iter()
        .all(|v| v.is_finite() && v.abs() < 1.0e9)
        .then_some(result)
}

/// `a` then `b` (row vectors, PDF order).
fn multiply(a: Matrix, b: Matrix) -> Matrix {
    [
        a[0] * b[0] + a[1] * b[2],
        a[0] * b[1] + a[1] * b[3],
        a[2] * b[0] + a[3] * b[2],
        a[2] * b[1] + a[3] * b[3],
        a[4] * b[0] + a[5] * b[2] + b[4],
        a[4] * b[1] + a[5] * b[3] + b[5],
    ]
}

/// Like [`placement`] for a `NoRotate` annotation on a page turned by `rotation` (0, 90, 180 or 270 degrees clockwise): the appearance
/// is fitted to the rect as if the page were not turned and hangs down and to the right from the corner of the rect that is the
/// upper-left one as displayed, so that it is upright once the page is shown turned.
pub fn placement_upright(
    bbox: [f32; 4],
    matrix: Matrix,
    rect: [f32; 4],
    rotation: i64,
) -> Option<Matrix> {
    let (x0, y0) = (rect[0].min(rect[2]), rect[1].min(rect[3]));
    let (x1, y1) = (rect[0].max(rect[2]), rect[1].max(rect[3]));
    // Counter-clockwise rotation by `rotation`, and the displayed upper-left corner in user space.
    let (turn, anchor) = match rotation {
        90 => ([0.0, 1.0, -1.0, 0.0, 0.0, 0.0], (x0, y0)),
        180 => ([-1.0, 0.0, 0.0, -1.0, 0.0, 0.0], (x1, y0)),
        270 => ([0.0, -1.0, 1.0, 0.0, 0.0, 0.0], (x1, y1)),
        _ => return placement(bbox, matrix, rect),
    };
    let local = placement(bbox, matrix, [0.0, -(y1 - y0), x1 - x0, 0.0])?;
    let mut result = multiply(local, turn);
    result[4] += anchor.0;
    result[5] += anchor.1;
    result
        .iter()
        .all(|v| v.is_finite() && v.abs() < 1.0e9)
        .then_some(result)
}

/// The page's `/Rotate`, own or inherited, as 0, 90, 180 or 270.
fn page_rotation(doc: &Document, page: ObjectId) -> i64 {
    let mut id = page;
    for _ in 0..MAX_DEPTH {
        let Ok(dict) = doc.get_dictionary(id) else {
            break;
        };
        if let Some(value) = dict
            .get(b"Rotate")
            .ok()
            .and_then(|r| doc.dereference(r).ok())
            .and_then(|(_, r)| r.as_i64().ok())
        {
            return value.rem_euclid(360) / 90 * 90;
        }
        match dict.get(b"Parent").ok().and_then(|p| p.as_reference().ok()) {
            Some(parent) => id = parent,
            None => break,
        }
    }
    0
}

/// What to do with one entry of `/Annots`.
enum Verdict {
    Keep,
    Remove,
    Burn { stream: ObjectId, matrix: Matrix },
}

fn flags(dict: &Dictionary) -> i64 {
    dict.get(b"F")
        .ok()
        .and_then(|f| f.as_i64().ok())
        .unwrap_or(0)
}

fn subtype(dict: &Dictionary) -> &[u8] {
    dict.get(b"Subtype")
        .ok()
        .and_then(|s| s.as_name().ok())
        .unwrap_or(b"")
}

/// The normal appearance stream of `annot`: `/AP /N`, for a dictionary of states the one `/AS` names.
fn normal_appearance(doc: &Document, annot: &Dictionary) -> Option<ObjectId> {
    let ap = doc
        .dereference(annot.get(b"AP").ok()?)
        .ok()?
        .1
        .as_dict()
        .ok()?;
    let normal = ap.get(b"N").ok()?;
    let (id, object) = doc.dereference(normal).ok()?;
    match object {
        Object::Stream(_) => id,
        Object::Dictionary(states) => {
            let state = annot.get(b"AS").ok()?.as_name().ok()?;
            let chosen = states.get(state).ok()?;
            let (id, object) = doc.dereference(chosen).ok()?;
            matches!(object, Object::Stream(_)).then_some(id).flatten()
        }
        _ => None,
    }
}

fn is_signature(doc: &Document, annot: &Dictionary) -> bool {
    let mut current = annot;
    for _ in 0..MAX_DEPTH {
        if let Ok(kind) = current.get(b"FT").and_then(Object::as_name) {
            return kind == b"Sig";
        }
        let Some(parent) = current
            .get(b"Parent")
            .ok()
            .and_then(|p| doc.dereference(p).ok())
            .and_then(|(_, p)| p.as_dict().ok())
        else {
            return false;
        };
        current = parent;
    }
    false
}

fn has_value(doc: &Document, annot: &Dictionary) -> bool {
    let mut current = annot;
    for _ in 0..MAX_DEPTH {
        if current.has(b"V") {
            return true;
        }
        let Some(parent) = current
            .get(b"Parent")
            .ok()
            .and_then(|p| doc.dereference(p).ok())
            .and_then(|(_, p)| p.as_dict().ok())
        else {
            return false;
        };
        current = parent;
    }
    false
}

fn judge(
    doc: &Document,
    annot: &Dictionary,
    scope: FlattenScope,
    rotation: i64,
    signed: &mut bool,
) -> Verdict {
    let kind = subtype(annot);
    let widget = kind == b"Widget";
    if !widget {
        if scope != FlattenScope::FormsAndAnnotations || kind == b"Link" || kind == b"Popup" {
            return Verdict::Keep;
        }
        // An annotation without an appearance has nothing to burn; it stays.
        if normal_appearance(doc, annot).is_none() && flags(annot) & NOT_SHOWN == 0 {
            return Verdict::Keep;
        }
    } else if is_signature(doc, annot) && has_value(doc, annot) {
        *signed = true;
    }
    if flags(annot) & NOT_SHOWN != 0 {
        return Verdict::Remove;
    }
    let Some(stream) = normal_appearance(doc, annot) else {
        return Verdict::Remove;
    };
    let Some(rect) = annot.get(b"Rect").ok().and_then(|r| numbers::<4>(doc, r)) else {
        return Verdict::Remove;
    };
    let Ok(Object::Stream(form)) = doc.get_object(stream) else {
        return Verdict::Remove;
    };
    let Some(bbox) = form
        .dict
        .get(b"BBox")
        .ok()
        .and_then(|b| numbers::<4>(doc, b))
    else {
        return Verdict::Remove;
    };
    let matrix = form
        .dict
        .get(b"Matrix")
        .ok()
        .and_then(|m| numbers::<6>(doc, m))
        .unwrap_or([1.0, 0.0, 0.0, 1.0, 0.0, 0.0]);
    let placed = if flags(annot) & NO_ROTATE != 0 {
        placement_upright(bbox, matrix, rect, rotation)
    } else {
        placement(bbox, matrix, rect)
    };
    match placed {
        Some(matrix) => Verdict::Burn { stream, matrix },
        None => Verdict::Remove,
    }
}

/// `/Resources` of `page`, own or inherited, as a dictionary to change.
fn effective_resources(doc: &Document, page: ObjectId) -> Dictionary {
    let mut id = page;
    for _ in 0..MAX_DEPTH {
        let Ok(dict) = doc.get_dictionary(id) else {
            break;
        };
        if let Some(found) = dict
            .get(b"Resources")
            .ok()
            .and_then(|r| doc.dereference(r).ok())
            .and_then(|(_, r)| r.as_dict().ok())
        {
            return found.clone();
        }
        match dict.get(b"Parent").ok().and_then(|p| p.as_reference().ok()) {
            Some(parent) => id = parent,
            None => break,
        }
    }
    Dictionary::new()
}

fn stream_of(doc: &mut Document, content: Vec<u8>) -> ObjectId {
    doc.add_object(Stream::new(Dictionary::new(), content))
}

fn number_text(value: f32) -> String {
    format!("{value:.5}")
}

/// Flattens `bytes`. Pages without a widget to flatten are not touched.
pub fn flatten(
    bytes: &[u8],
    scope: FlattenScope,
    control: &dyn Control,
) -> Result<Output, AppError> {
    control.check()?;
    let mut doc = super::prescan::load_untrusted(bytes)?;
    if doc.is_encrypted() || doc.encryption_state.is_some() {
        return Err(AppError::new(ErrorCode::UnsupportedFeature));
    }
    let pages: Vec<ObjectId> = doc.get_pages().values().copied().collect();
    let total = u32::try_from(pages.len()).unwrap_or(u32::MAX);
    limits::validate_page_count(total)?;
    let mut signed = false;
    let mut burned_total = 0usize;
    let mut copied = 0usize;

    for (at, &page) in pages.iter().enumerate() {
        control.check()?;
        control.progress(Phase::Write, u32::try_from(at).unwrap_or(u32::MAX), total);
        let Some(entries) = doc
            .get_dictionary(page)
            .ok()
            .and_then(|p| p.get(b"Annots").ok())
            .and_then(|a| doc.dereference(a).ok())
            .and_then(|(_, a)| a.as_array().ok())
            .cloned()
        else {
            continue;
        };
        if entries.len() > limits::MAX_ANNOTS_ARRAY {
            return Err(AppError::limit(
                "annotations",
                limits::MAX_ANNOTS_ARRAY as u64,
            ));
        }
        let rotation = page_rotation(&doc, page);
        // Judge every entry; a popup follows its parent.
        let mut verdicts: Vec<Verdict> = Vec::with_capacity(entries.len());
        let mut gone: HashSet<ObjectId> = HashSet::new();
        for entry in &entries {
            let (id, object) = match doc.dereference(entry) {
                Ok(found) => found,
                Err(_) => {
                    verdicts.push(Verdict::Keep);
                    continue;
                }
            };
            let verdict = match object.as_dict() {
                Ok(annot) => judge(&doc, annot, scope, rotation, &mut signed),
                Err(_) => Verdict::Keep,
            };
            if !matches!(verdict, Verdict::Keep) {
                if let Some(id) = id {
                    gone.insert(id);
                }
            }
            verdicts.push(verdict);
        }
        if scope == FlattenScope::FormsAndAnnotations {
            for (entry, verdict) in entries.iter().zip(verdicts.iter_mut()) {
                let Ok((_, Object::Dictionary(annot))) = doc.dereference(entry) else {
                    continue;
                };
                let orphaned = subtype(annot) == b"Popup"
                    && annot
                        .get(b"Parent")
                        .ok()
                        .and_then(|p| p.as_reference().ok())
                        .is_some_and(|parent| gone.contains(&parent));
                if orphaned {
                    *verdict = Verdict::Remove;
                }
            }
        }
        if verdicts.iter().all(|v| matches!(v, Verdict::Keep)) {
            continue;
        }

        let burns: Vec<(ObjectId, Matrix)> = verdicts
            .iter()
            .filter_map(|v| match v {
                Verdict::Burn { stream, matrix } => Some((*stream, *matrix)),
                _ => None,
            })
            .collect();
        burned_total += burns.len();
        if burned_total > limits::MAX_ANNOTATIONS_PER_DOC {
            return Err(AppError::limit(
                "annotations",
                limits::MAX_ANNOTATIONS_PER_DOC as u64,
            ));
        }
        let kept: Vec<Object> = entries
            .iter()
            .zip(&verdicts)
            .filter(|(_, v)| matches!(v, Verdict::Keep))
            .map(|(entry, _)| entry.clone())
            .collect();

        if !burns.is_empty() {
            burn_into_page(&mut doc, page, &burns, &mut copied)?;
        }
        let dict = doc.get_dictionary_mut(page).map_err(failed)?;
        if kept.is_empty() {
            dict.remove(b"Annots");
        } else {
            dict.set("Annots", Object::Array(kept));
        }
    }

    // The widgets and the form go; so do signature-related permissions, which would no longer verify.
    let catalog_id = doc
        .trailer
        .get(b"Root")
        .ok()
        .and_then(|r| r.as_reference().ok())
        .ok_or_else(|| failed("no catalog"))?;
    {
        let catalog = doc.get_dictionary_mut(catalog_id).map_err(failed)?;
        catalog.remove(b"AcroForm");
        if catalog.remove(b"Perms").is_some() {
            signed = true;
        }
    }
    doc.prune_objects();

    let mut warnings = Vec::new();
    if signed {
        warnings.push(Warning::SignaturesRemoved);
    }
    control.check()?;
    let mut out = Vec::new();
    doc.save_to(&mut out).map_err(failed)?;
    control.progress(Phase::Validate, 0, 1);
    super::save::validate(&out, total)?;
    control.progress(Phase::Validate, 1, 1);
    Ok(Output {
        bytes: out,
        pages: total,
        warnings,
    })
}

/// Wraps the page content and appends the appearances `burns` (stream, placement).
fn burn_into_page(
    doc: &mut Document,
    page: ObjectId,
    burns: &[(ObjectId, Matrix)],
    copied: &mut usize,
) -> Result<(), AppError> {
    let mut resources = effective_resources(doc, page);
    *copied += resources.len();
    let mut xobjects = resources
        .get(b"XObject")
        .ok()
        .and_then(|x| doc.dereference(x).ok())
        .and_then(|(_, x)| x.as_dict().ok())
        .cloned()
        .unwrap_or_default();
    *copied += xobjects.len();
    if *copied > MAX_RESOURCE_ENTRIES {
        return Err(AppError::limit("resources", MAX_RESOURCE_ENTRIES as u64));
    }

    let mut tail = String::from("Q\n");
    let mut next = 0usize;
    for &(stream, matrix) in burns {
        // The stream is a Form XObject whatever its dictionary says.
        if let Ok(Object::Stream(form)) = doc.get_object_mut(stream) {
            form.dict.set("Type", Object::Name(b"XObject".to_vec()));
            form.dict.set("Subtype", Object::Name(b"Form".to_vec()));
        }
        let name = loop {
            let candidate = format!("SheerFl{next}");
            next += 1;
            if !xobjects.has(candidate.as_bytes()) {
                break candidate;
            }
        };
        xobjects.set(name.as_bytes().to_vec(), Object::Reference(stream));
        tail.push_str(&format!(
            "q {} {} {} {} {} {} cm /{name} Do Q\n",
            number_text(matrix[0]),
            number_text(matrix[1]),
            number_text(matrix[2]),
            number_text(matrix[3]),
            number_text(matrix[4]),
            number_text(matrix[5]),
        ));
    }
    resources.set("XObject", Object::Dictionary(xobjects));

    let existing: Vec<Object> = {
        let dict = doc.get_dictionary(page).map_err(failed)?;
        match dict.get(b"Contents").ok().map(|c| doc.dereference(c)) {
            Some(Ok((_, Object::Array(items)))) => items.clone(),
            Some(Ok((Some(id), Object::Stream(_)))) => vec![Object::Reference(id)],
            _ => Vec::new(),
        }
    };
    let head = stream_of(doc, b"q\n".to_vec());
    let end = stream_of(doc, tail.into_bytes());
    let mut contents = Vec::with_capacity(existing.len() + 2);
    contents.push(Object::Reference(head));
    contents.extend(existing);
    contents.push(Object::Reference(end));

    let dict = doc.get_dictionary_mut(page).map_err(failed)?;
    dict.set("Contents", Object::Array(contents));
    dict.set("Resources", Object::Dictionary(resources));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pdfwrite::produce::Unattended;

    #[test]
    fn placement_fits_the_transformed_box_onto_the_rect() {
        let identity = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];
        let m = placement(
            [0.0, 0.0, 100.0, 20.0],
            identity,
            [50.0, 60.0, 250.0, 100.0],
        )
        .unwrap();
        assert_eq!(m, [2.0, 0.0, 0.0, 2.0, 50.0, 60.0]);
        // A 90 degree appearance matrix: the box is 20 x 100 after it.
        let rotate = [0.0, 1.0, -1.0, 0.0, 0.0, 0.0];
        let m = placement([0.0, 0.0, 100.0, 20.0], rotate, [10.0, 10.0, 30.0, 110.0]).unwrap();
        assert_eq!(m, [1.0, 0.0, 0.0, 1.0, 30.0, 10.0]);
        assert!(placement([0.0, 0.0, 0.0, 20.0], identity, [0.0, 0.0, 1.0, 1.0]).is_none());
        // A rect given from the other corner is the same rect.
        assert_eq!(
            placement([0.0, 0.0, 10.0, 10.0], identity, [20.0, 20.0, 10.0, 10.0]),
            placement([0.0, 0.0, 10.0, 10.0], identity, [10.0, 10.0, 20.0, 20.0])
        );
    }

    fn close(a: Matrix, b: Matrix) {
        for (x, y) in a.iter().zip(b) {
            assert!((x - y).abs() < 1.0e-4, "{a:?} != {b:?}");
        }
    }

    #[test]
    fn a_no_rotate_annotation_hangs_from_the_displayed_upper_left_corner() {
        let identity = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];
        let (bbox, rect) = ([0.0, 0.0, 40.0, 20.0], [100.0, 100.0, 140.0, 120.0]);
        // Not turned: the same as the plain placement.
        close(
            placement_upright(bbox, identity, rect, 0).unwrap(),
            placement(bbox, identity, rect).unwrap(),
        );
        // Turned 90 degrees clockwise: the displayed upper-left corner is the lower-left one in user space, and the form's
        // lower-left corner lies at its right (user x grows downwards in the display).
        let m = placement_upright(bbox, identity, rect, 90).unwrap();
        close(m, [0.0, 1.0, -1.0, 0.0, 120.0, 100.0]);
        // The form's upper-left corner (0, 20) is the anchor.
        close(
            [m[2] * 20.0 + m[4], m[3] * 20.0 + m[5], 0.0, 0.0, 0.0, 0.0],
            [100.0, 100.0, 0.0, 0.0, 0.0, 0.0],
        );
        let m = placement_upright(bbox, identity, rect, 180).unwrap();
        close(m, [-1.0, 0.0, 0.0, -1.0, 140.0, 120.0]);
        let m = placement_upright(bbox, identity, rect, 270).unwrap();
        close(
            [m[2] * 20.0 + m[4], m[3] * 20.0 + m[5], 0.0, 0.0, 0.0, 0.0],
            [140.0, 120.0, 0.0, 0.0, 0.0, 0.0],
        );
    }

    #[test]
    fn garbage_is_an_error_not_a_panic() {
        assert!(flatten(b"%PDF-1.4 nonsense", FlattenScope::Forms, &Unattended).is_err());
    }
}
