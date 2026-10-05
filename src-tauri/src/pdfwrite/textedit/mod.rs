//! Text-editing feasibility spike (v1.5): replace one word on a page and keep the rest of the file. Not wired into the IPC handler on
//! purpose; [`replace_word`] has the shape the command would have (page index, old text, new text, file bytes in and out) and stays
//! internal until the spike is judged. It lives below `pdfwrite` because only that module may use lopdf.
//!
//! How it works: the content of the page (and of the Form XObjects it draws) is walked with the full text state (`scan`), every code
//! is decoded to Unicode (`font`) and the word is looked up in the line of glyphs it sits on, even when it is split over strings or
//! `TJ` elements. The replacement is written
//! - in the same font when every character already has a code with a width in that font (**Works**),
//! - else, or when the font is not embedded (and not one of the standard 14), as a Helvetica run (bold/italic follow the original
//!   font) switched in with `Tf` and switched back after it (**Fallback**),
//! - and nothing happens when the word is not found, is invisible text (`Tr 3`, an OCR layer), sits in a Type3 / vertical /
//!   unreadable font, or the file is encrypted (**Impossible**).
//!
//! The result is an incremental update (the original bytes stay untouched, so signatures of earlier revisions keep their coverage).
//! The line start is kept. The rest of the line moves with the word (`layout`): runs that are positioned by their own `Td`/`Tm`
//! are shifted by the width delta; a run that would collide with the next one is squeezed with `Tz` (down to 85 %), else the
//! overflow is reported in `notes`. Whether the glyph outline of a character exists in the font program is not checked (only the
//! code table and widths are), which is the main open risk of the Works verdict.

mod font;
mod layout;
mod scan;

use lopdf::content::{Content, Operation};
use lopdf::{Dictionary, IncrementalDocument, Object, ObjectId, Stream, StringFormat};

use super::prescan;
use crate::content::std14;
use crate::error::AppError;
use crate::model::annotation::StdFont;
use scan::{Kind, ScanError, Scanner, Target, Unit};

const MAX_TEXT_CHARS: usize = 256;
/// Smallest `Tz` the spike squeezes a replacement to.
const MIN_SQUEEZE: f64 = 0.85;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// Rewritten in the original font.
    Works,
    /// The replaced run is Helvetica.
    Fallback { reason: String },
    /// Nothing was changed.
    Impossible { reason: String },
}

#[derive(Debug)]
pub struct SpikeOutcome {
    /// The new file; empty when the outcome is `Impossible`.
    pub bytes: Vec<u8>,
    pub outcome: Outcome,
    /// New width minus old width of the word, in text-space points (positive: the line grew).
    pub width_delta: f64,
    /// Layout remarks: runs that moved, a squeeze, an overflow the spike could not avoid.
    pub notes: Vec<String>,
}

fn impossible(reason: impl Into<String>) -> Result<SpikeOutcome, AppError> {
    Ok(SpikeOutcome {
        bytes: Vec::new(),
        outcome: Outcome::Impossible {
            reason: reason.into(),
        },
        width_delta: 0.0,
        notes: Vec::new(),
    })
}

struct Hit {
    unit: usize,
    lo: usize,
    hi: usize,
}

/// The Helvetica face that stands in for `font`: resource name and base font.
fn helvetica_for(font: &font::FontInfo) -> (&'static [u8], &'static str) {
    match (font.bold, font.italic) {
        (false, false) => (b"SheerHelv", "Helvetica"),
        (true, false) => (b"SheerHelvB", "Helvetica-Bold"),
        (false, true) => (b"SheerHelvI", "Helvetica-Oblique"),
        (true, true) => (b"SheerHelvBI", "Helvetica-BoldOblique"),
    }
}

/// Replaces the first visible occurrence of `old` on page `page` (0-based) by `new`. See the module documentation.
#[allow(clippy::too_many_lines)]
pub fn replace_word(
    input: &[u8],
    page: u32,
    old: &str,
    new: &str,
) -> Result<SpikeOutcome, AppError> {
    let bad = |s: &str| s.chars().count() > MAX_TEXT_CHARS || s.chars().any(char::is_control);
    if old.is_empty() || bad(old) || bad(new) {
        return Err(AppError::invalid("text"));
    }
    let doc = prescan::load_untrusted(input)?;
    if doc.is_encrypted() {
        return impossible("encrypted file");
    }
    let Some(page_id) = doc.get_pages().get(&page.saturating_add(1)).copied() else {
        return Err(AppError::not_found("page"));
    };
    let Ok(content) = scan::page_content(&doc, page_id) else {
        return impossible("page content cannot be read");
    };
    let mut scanner = Scanner::new(&doc);
    let scanned = scanner.scan(
        Target::Page(page_id),
        &content,
        scan::page_resources(&doc, page_id),
        [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
        0,
    );
    match scanned {
        Ok(()) => {}
        Err(ScanError::Unparseable) => return impossible("content stream cannot be parsed"),
        Err(ScanError::Limit(what)) => return impossible(format!("limit reached: {what}")),
    }
    let mut units = std::mem::take(&mut scanner.units);

    let (hit, saw_invisible) = find(&units, old);
    let Some(hit) = hit else {
        if saw_invisible {
            return impossible("invisible text (Tr 3, OCR layer)");
        }
        let problem = units
            .iter()
            .flat_map(|u| u.sites.iter())
            .find_map(|s| s.font.problem);
        return impossible(match problem {
            Some(p) => format!("text not found ({p} on the page)"),
            None => "text not found on the page".to_owned(),
        });
    };
    let unit = &mut units[hit.unit];
    let glyphs = &unit.glyphs[hit.lo..hit.hi];
    let first = &unit.sites[glyphs[0].site];
    if let Some(problem) = first.font.problem {
        return impossible(problem);
    }
    let font = std::rc::Rc::clone(&first.font);
    let (font_name, size, tc, th) = (first.font_name.clone(), first.size, first.tc, first.th);
    let same_font = glyphs
        .iter()
        .all(|g| unit.sites[g.site].font_name == font_name);
    let old_width: f64 = glyphs.iter().map(|g| g.adv).sum();

    let encoded = font.encode(new);
    let reason = if !(font.embedded || font.std14) {
        Some("font not embedded".to_owned())
    } else if !same_font {
        Some("word spans several fonts".to_owned())
    } else if let Err(c) = &encoded {
        Some(format!("glyph '{c}' missing in the font"))
    } else {
        None
    };

    // The replacement bytes and its width.
    let (new_bytes, mut new_width, outcome) = match (reason, encoded) {
        (None, Ok(codes)) => {
            let w: f64 = codes
                .iter()
                .map(|c| (font.width(*c) / 1000.0 * size + tc) * th)
                .sum();
            (font.code_bytes(&codes), w, Outcome::Works)
        }
        (reason, _) => {
            let mut bytes = Vec::new();
            for c in new.chars() {
                match std14::winansi(c) {
                    Some(b) => bytes.push(b),
                    None => return impossible(format!("'{c}' has no glyph in Helvetica")),
                }
            }
            let w = (f64::from(std14::text_width(StdFont::Sans, new, size as f32))
                + new.chars().count() as f64 * tc)
                * th;
            (
                bytes,
                w,
                Outcome::Fallback {
                    reason: reason.unwrap_or_default(),
                },
            )
        }
    };
    let fallback = matches!(outcome, Outcome::Fallback { .. });

    // How the rest of the line reacts, and whether the new run has to be squeezed.
    let line = layout::analyse(unit, hit.lo, hit.hi);
    let mut notes = Vec::new();
    let mut squeeze = None;
    let mut delta = new_width - old_width;
    if let Some(slack) = line.slack {
        let allowed = slack - 0.15 * size.abs() * line.scale;
        if delta * line.scale > allowed && new_width > 0.0 {
            let target = old_width + allowed.max(0.0) / line.scale;
            let factor = (target / new_width).clamp(MIN_SQUEEZE, 1.0);
            if factor < 1.0 {
                squeeze = Some(factor);
                new_width *= factor;
                delta = new_width - old_width;
                notes.push(format!(
                    "replacement squeezed to Tz {:.0} %",
                    factor * 100.0
                ));
            }
            if delta * line.scale > allowed + 1e-6 {
                notes.push(
                    "overflow: the word is wider than the room before the next run".to_owned(),
                );
            }
        }
    }
    if line.moved_runs > 0 && delta.abs() > 1e-6 {
        layout::shift_following(&mut unit.ops, &line, delta);
        notes.push(format!(
            "{} following run(s) on the line moved by {delta:+.2} units",
            line.moved_runs
        ));
    }

    // Ranges of the strings that hold the word, in content order.
    let mut ranges: Vec<(usize, Option<usize>, usize, usize)> = Vec::new();
    let mut last_site = usize::MAX;
    for g in &unit.glyphs[hit.lo..hit.hi] {
        if g.site == last_site {
            if let Some(r) = ranges.last_mut() {
                r.2 = r.2.min(g.start);
                r.3 = r.3.max(g.end);
            }
        } else {
            let s = &unit.sites[g.site];
            ranges.push((s.op, s.elem, g.start, g.end));
            last_site = g.site;
        }
    }
    ranges.sort_by_key(|r| std::cmp::Reverse((r.0, r.1)));
    let helv = helvetica_for(&font);
    let th_percent = (th * 100.0, squeeze.map(|f| th * f * 100.0));
    if ranges.is_empty() {
        return impossible("word has no string range");
    }
    let last = ranges.len() - 1;
    for (k, (op, elem, s, e)) in ranges.iter().copied().enumerate() {
        let is_first = k == last;
        if is_first && (fallback || squeeze.is_some()) {
            let face = fallback.then_some(helv.0);
            let Some(ops) = split_op(
                &unit.ops[op],
                elem,
                (s, e),
                (&font_name, size),
                face,
                th_percent,
                &new_bytes,
            ) else {
                return impossible("unexpected operator layout");
            };
            unit.ops.splice(op..=op, ops);
        } else if let Some(bytes) = string_mut(&mut unit.ops[op], elem) {
            if e > bytes.len() || s > e {
                return impossible("string range out of bounds");
            }
            bytes.splice(
                s..e,
                if is_first {
                    new_bytes.clone()
                } else {
                    Vec::new()
                },
            );
        } else {
            return impossible("unexpected operator layout");
        }
        // The kerns between two removed pieces of one `TJ` belonged to the old word.
        if let (Some(hi), Some(next)) = (elem, ranges.get(k + 1)) {
            if let (true, Some(lo)) = (next.0 == op, next.1) {
                if let Some(Object::Array(items)) = unit.ops[op].operands.first_mut() {
                    let mut at = hi.min(items.len());
                    while at > lo + 1 {
                        at -= 1;
                        if matches!(items[at], Object::Integer(_) | Object::Real(_)) {
                            items.remove(at);
                        }
                    }
                }
            }
        }
    }

    let target = unit.target;
    let ops = std::mem::take(&mut unit.ops);
    let mut resources = unit.resources.clone();
    if fallback {
        // Resolve an indirect `/Font` dictionary now; the document moves into the update below.
        if let Some(fonts) = resources
            .get(b"Font")
            .ok()
            .and_then(|f| doc.dereference(f).ok())
            .and_then(|(_, f)| f.as_dict().ok())
        {
            resources.set("Font", Object::Dictionary(fonts.clone()));
        }
    }
    let bytes = write_update(
        input,
        doc,
        target,
        ops,
        fallback.then_some((resources, helv)),
    )?;
    Ok(SpikeOutcome {
        bytes,
        outcome,
        width_delta: delta,
        notes,
    })
}

/// The first visible hit of `old` (whole word preferred) and whether an invisible one was skipped.
fn find(units: &[Unit], old: &str) -> (Option<Hit>, bool) {
    let needle: Vec<char> = old.chars().collect();
    let mut any: Option<Hit> = None;
    let mut saw_invisible = false;
    for (u, unit) in units.iter().enumerate() {
        let line: Vec<char> = unit
            .glyphs
            .iter()
            .map(|g| if g.kind == Kind::Char { g.ch } else { '\u{0}' })
            .collect();
        if line.len() < needle.len() {
            continue;
        }
        for lo in 0..=line.len() - needle.len() {
            let hi = lo + needle.len();
            if line[lo..hi] != needle[..] || !unit.glyphs[lo].first || !unit.glyphs[hi - 1].last {
                continue;
            }
            if unit.glyphs[lo..hi]
                .iter()
                .any(|g| unit.sites[g.site].invisible)
            {
                saw_invisible = true;
                continue;
            }
            let word = |c: Option<&char>| c.is_some_and(|c| c.is_alphanumeric());
            let whole = !word(lo.checked_sub(1).and_then(|i| line.get(i))) && !word(line.get(hi));
            let hit = Hit { unit: u, lo, hi };
            if whole {
                return (Some(hit), saw_invisible);
            }
            any.get_or_insert(hit);
        }
    }
    (any, saw_invisible)
}

fn string_mut(op: &mut Operation, elem: Option<usize>) -> Option<&mut Vec<u8>> {
    let object = match elem {
        Some(k) => match op.operands.first_mut() {
            Some(Object::Array(items)) => items.get_mut(k)?,
            _ => return None,
        },
        None => op.operands.last_mut()?,
    };
    match object {
        Object::String(bytes, _) => Some(bytes),
        _ => None,
    }
}

fn literal(bytes: Vec<u8>) -> Object {
    Object::String(bytes, StringFormat::Literal)
}

fn tf(name: &[u8], size: f64) -> Operation {
    Operation::new(
        "Tf",
        vec![Object::Name(name.to_vec()), Object::Real(size as f32)],
    )
}

/// The operators that replace `op` when `range` of its string (element `elem` of a `TJ`) becomes `new`, optionally in the fallback
/// face `face` and/or with a squeezed `Tz` (`th_percent` = (original, squeezed)).
fn split_op(
    op: &Operation,
    elem: Option<usize>,
    range: (usize, usize),
    (font_name, size): (&[u8], f64),
    face: Option<&[u8]>,
    th_percent: (f64, Option<f64>),
    new: &[u8],
) -> Option<Vec<Operation>> {
    let (s, e) = range;
    let mut out = Vec::new();
    let (before, after): (Vec<Object>, Vec<Object>);
    let text_of = |o: &Object| match o {
        Object::String(b, _) if s <= e && e <= b.len() => Some((b[..s].to_vec(), b[e..].to_vec())),
        _ => None,
    };
    let as_array = op.operator == "TJ";
    if as_array {
        let Some(Object::Array(items)) = op.operands.first() else {
            return None;
        };
        let k = elem?;
        let (pre, post) = text_of(items.get(k)?)?;
        let mut b: Vec<Object> = items[..k].to_vec();
        if !pre.is_empty() {
            b.push(literal(pre));
        }
        let mut a: Vec<Object> = Vec::new();
        if !post.is_empty() {
            a.push(literal(post));
        }
        a.extend_from_slice(&items[k + 1..]);
        (before, after) = (b, a);
    } else {
        let (pre, post) = text_of(op.operands.last()?)?;
        before = if pre.is_empty() {
            vec![]
        } else {
            vec![literal(pre)]
        };
        after = if post.is_empty() {
            vec![]
        } else {
            vec![literal(post)]
        };
        match op.operator.as_str() {
            "'" => out.push(Operation::new("T*", vec![])),
            "\"" => {
                out.push(Operation::new("Tw", vec![op.operands.first()?.clone()]));
                out.push(Operation::new("Tc", vec![op.operands.get(1)?.clone()]));
                out.push(Operation::new("T*", vec![]));
            }
            _ => {}
        }
    }
    let show = |items: Vec<Object>| {
        if as_array {
            Operation::new("TJ", vec![Object::Array(items)])
        } else {
            Operation::new("Tj", items)
        }
    };
    let tz = |percent: f64| Operation::new("Tz", vec![Object::Real(percent as f32)]);
    if !before.is_empty() {
        out.push(show(before));
    }
    if let Some(face) = face {
        out.push(tf(face, size));
    }
    if let Some(squeezed) = th_percent.1 {
        out.push(tz(squeezed));
    }
    out.push(Operation::new("Tj", vec![literal(new.to_vec())]));
    if th_percent.1.is_some() {
        out.push(tz(th_percent.0));
    }
    if face.is_some() {
        out.push(tf(font_name, size));
    }
    if !after.is_empty() {
        out.push(show(after));
    }
    Some(out)
}

fn write_update(
    input: &[u8],
    doc: lopdf::Document,
    target: Target,
    ops: Vec<Operation>,
    fallback: Option<(Dictionary, (&[u8], &str))>,
) -> Result<Vec<u8>, AppError> {
    let failed = |what: &str| AppError::logged(crate::error::ErrorCode::SaveFailed, what);
    let data = Content { operations: ops }
        .encode()
        .map_err(|e| failed(&format!("encode content: {e}")))?;
    let mut inc = IncrementalDocument::create_from(input.to_vec(), doc);
    let resources = match fallback {
        Some((mut res, (name, base))) => {
            let mut helvetica = Dictionary::new();
            helvetica.set("Type", Object::Name(b"Font".to_vec()));
            helvetica.set("Subtype", Object::Name(b"Type1".to_vec()));
            helvetica.set("BaseFont", Object::Name(base.as_bytes().to_vec()));
            helvetica.set("Encoding", Object::Name(b"WinAnsiEncoding".to_vec()));
            let id = inc.new_document.add_object(helvetica);
            let mut fonts = match res.get(b"Font") {
                Ok(Object::Dictionary(d)) => d.clone(),
                _ => Dictionary::new(),
            };
            fonts.set(name.to_vec(), Object::Reference(id));
            res.set("Font", Object::Dictionary(fonts));
            Some(res)
        }
        None => None,
    };
    match target {
        Target::Page(page) => {
            let mut dict = inc
                .get_prev_documents()
                .get_dictionary(page)
                .map_err(|_| failed("page dictionary"))?
                .clone();
            let stream = inc
                .new_document
                .add_object(Stream::new(Dictionary::new(), data));
            dict.set("Contents", Object::Reference(stream));
            if let Some(res) = resources {
                dict.set("Resources", Object::Dictionary(res));
            }
            inc.new_document.set_object(page, Object::Dictionary(dict));
        }
        Target::Form(id) => rewrite_form(&mut inc, id, data, resources)?,
    }
    let mut out = Vec::new();
    inc.save_to(&mut out)
        .map_err(|e| failed(&format!("save: {e}")))?;
    Ok(out)
}

fn rewrite_form(
    inc: &mut IncrementalDocument,
    id: ObjectId,
    data: Vec<u8>,
    resources: Option<Dictionary>,
) -> Result<(), AppError> {
    let mut stream = match inc.get_prev_documents().get_object(id) {
        Ok(Object::Stream(s)) => s.clone(),
        _ => {
            return Err(AppError::logged(
                crate::error::ErrorCode::SaveFailed,
                "form stream",
            ))
        }
    };
    stream.dict.remove(b"Filter");
    stream.dict.remove(b"DecodeParms");
    stream.dict.set("Length", data.len() as i64);
    stream.content = data;
    if let Some(res) = resources {
        stream.dict.set("Resources", Object::Dictionary(res));
    }
    inc.new_document.set_object(id, Object::Stream(stream));
    Ok(())
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod corpus;
