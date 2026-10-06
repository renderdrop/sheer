//! The re-break of a paragraph after one of its lines changed (ADR-129 §3, DESIGN §3.10 E2 "Reflow").
//!
//! A paragraph edit is ONE stored `TextEdit`; here it is expanded into per-line edits that the line splice ([`super::edit_line`]) applies.
//! The edited line's new words and the words of the lines after it are filled greedily into the paragraph's own lines (same baselines,
//! same left edge or alignment anchor, same font and size per line). The fill stops where it meets the original breaks again, so the
//! lines after that point stay byte for byte as they were. At most one line is added below the paragraph, and only when there is room;
//! otherwise the rest overflows on the last line (`textOverflow`). Other paragraphs, other columns and other pages are never touched.
//!
//! This module is a child of `text_splice` (`#[path]`), so it uses the splice's private lexer and operand reader.

use std::collections::{BTreeSet, HashSet};

use lopdf::{Document, ObjectId};

use super::super::ops_walk;
use super::super::text_lines::{self, Align, PageLines};
use super::{
    char_ok, code_bytes, edit_line, fmt_num, is_show, parse_show, refused, width_of, FallbackWidth,
    FontKind, Item, LineInput, LineSource, Outcome, OwnedLine, View,
};
use crate::error::AppError;
use crate::fontprog::fallback::Face;
use crate::model::text_edit::{ChangeWarning, LineKey, TextEdit};

/// A line may be this much (points) wider than its limit before a word moves down (float noise; below the splice's own `EPS`).
const SLACK: f64 = 0.02;
/// Distance kept to the next object on the baseline.
const NEXT_GAP: f64 = 4.0;
/// Distance kept to the edge of the crop box.
const CROP_MARGIN: f64 = 12.0;

/// Where one line of the paragraph is (page space, along its direction `[1, 0]`).
#[derive(Debug, Clone, Copy)]
pub(crate) struct LineGeom {
    pub start: f64,
    pub end: f64,
    pub baseline: f64,
    pub size: f64,
    /// The room to the next object on the same baseline (`PageLines::room_after`).
    pub room: Option<f64>,
}

/// The paragraph an edit names, as far as the re-break needs it.
#[derive(Debug, Clone)]
pub(crate) struct ParaGeom {
    /// The `LineKey::line` of each line, top to bottom (the lines of a column are not always next to each other in reading order).
    pub indices: Vec<u32>,
    pub lines: Vec<LineGeom>,
    pub align: Align,
    /// The paragraph is justified: its lines but the last end at the paragraph's right edge (ADR-130).
    pub justified: bool,
    /// The widest right edge and the smallest left edge of the lines.
    pub right: f64,
    pub left: f64,
    /// Crop box (or media box): `[x0, y0, x1, y1]`.
    pub crop: [f64; 4],
    /// Baseline and size of the nearest object below the paragraph in its horizontal range.
    pub below: Option<(f64, f64)>,
}

/// The geometry of the paragraph of line `line`. Only horizontal left-to-right text is re-broken (`tooComplex` otherwise).
///
/// Where the reading order interleaves columns (row by row), `text_lines` leaves the lines of a column as paragraphs of their own;
/// the paragraph is then continued downwards here, inside the column of the last line (x range and left edge), by the rule of
/// `text_lines::paragraphs`: same left edge, size and family, and the baseline step of the lines before. It never crosses to a
/// neighbouring column, because a candidate must overlap the paragraph's x range and start at its left edge.
pub(crate) fn geometry(
    doc: &Document,
    page: ObjectId,
    pl: &PageLines,
    line: u32,
) -> Result<ParaGeom, AppError> {
    let para = pl
        .paragraphs
        .iter()
        .find(|p| p.lines.contains(&line))
        .ok_or(AppError::invalid("lineKey"))?;
    let horizontal = |l: &text_lines::Line| l.dir[1].abs() <= 0.01 && l.dir[0] > 0.0;
    let family = |l: &text_lines::Line| {
        l.font_name
            .split(['-', ',', ' '])
            .next()
            .unwrap_or_default()
            .to_owned()
    };
    let mut indices: Vec<u32> = para.lines.clone().collect();
    let mut geoms: Vec<LineGeom> = Vec::new();
    for i in &indices {
        let l = pl.lines.get(*i as usize).ok_or_else(refused)?;
        if !horizontal(l) {
            return Err(refused());
        }
        geoms.push(geom_of(pl, *i, l)?);
    }
    if para.align == Align::Left {
        // Each step adds one line, so there are at most as many steps as lines; the set and the running edges keep a step linear.
        let mut member: HashSet<u32> = indices.iter().copied().collect();
        let mut left = geoms.iter().map(|g| g.start).fold(f64::MAX, f64::min);
        let mut right = geoms.iter().map(|g| g.end).fold(f64::MIN, f64::max);
        while indices.len() < pl.lines.len() {
            let (Some(&last_i), Some(last), Some(first)) = (
                indices.last(),
                geoms.last().copied(),
                geoms.first().copied(),
            ) else {
                break;
            };
            let mut next: Option<(u32, LineGeom)> = None;
            for (j, other) in pl.lines.iter().enumerate() {
                let j = u32::try_from(j).unwrap_or(u32::MAX);
                let Some(span) = other.span() else { continue };
                if member.contains(&j)
                    || !horizontal(other)
                    || span.baseline >= last.baseline - 0.1 * last.size
                    || span.end <= left
                    || span.start >= right
                {
                    continue;
                }
                if next.is_none_or(|(_, n)| span.baseline > n.baseline) {
                    next = Some((j, geom_of(pl, j, other)?));
                }
            }
            let Some((j, g)) = next else { break };
            let other = pl.lines.get(j as usize).ok_or_else(refused)?;
            let step = last.baseline - g.baseline;
            let prev_step = geoms
                .len()
                .checked_sub(2)
                .and_then(|k| geoms.get(k))
                .map(|p| p.baseline - last.baseline);
            let reference = pl.lines.get(last_i as usize).ok_or_else(refused)?;
            // The next row of the reading order is the paragraph's own business (`text_lines` decided).
            let joins = j != last_i + 1
                && (g.start - first.start).abs() <= 1.0
                && (g.size - last.size).abs() <= 0.1 * g.size.max(last.size)
                && step >= 0.8 * last.size
                && step <= 1.6 * last.size.max(g.size)
                && prev_step.is_none_or(|p| (step - p).abs() <= 0.15 * p.abs().max(1e-6))
                && family(other) == family(reference);
            if !joins {
                break;
            }
            indices.push(j);
            member.insert(j);
            left = left.min(g.start);
            right = right.max(g.end);
            geoms.push(g);
        }
    }
    let Some(last) = geoms.last().copied() else {
        return Err(refused());
    };
    let mut right = geoms.iter().map(|l| l.end).fold(f64::MIN, f64::max);
    if para.justified && geoms.len() > 1 {
        // The paragraph's edge is where most of its lines end: one line that overshoots (a stretched line) must not move it.
        let inner: Vec<f64> = geoms[..geoms.len() - 1].iter().map(|l| l.end).collect();
        right = typical_edge(&inner).unwrap_or(right);
    }
    let left = geoms.iter().map(|l| l.start).fold(f64::MAX, f64::min);
    let crop = ops_walk::inherited(doc, page, b"CropBox")
        .or_else(|| ops_walk::inherited(doc, page, b"MediaBox"))
        .and_then(|o| ops_walk::box_of(doc, &o))
        .unwrap_or([0.0, 0.0, 612.0, 792.0]);
    let member_of_para: HashSet<u32> = indices.iter().copied().collect();
    let mut below: Option<(f64, f64)> = None;
    for (i, other) in pl.lines.iter().enumerate() {
        if member_of_para.contains(&u32::try_from(i).unwrap_or(u32::MAX)) {
            continue;
        }
        let Some(span) = other.span() else { continue };
        if !horizontal(other)
            || span.baseline >= last.baseline - 0.1 * last.size
            || span.end <= left
            || span.start >= right
        {
            continue;
        }
        if below.is_none_or(|(b, _)| span.baseline > b) {
            below = Some((span.baseline, other.size));
        }
    }
    Ok(ParaGeom {
        indices,
        lines: geoms,
        align: para.align,
        justified: para.justified,
        right,
        left,
        crop,
        below,
    })
}

/// The right edge most of the (inner, justified) lines share: their median.
pub(crate) fn typical_edge(ends: &[f64]) -> Option<f64> {
    let mut sorted: Vec<f64> = ends.iter().copied().filter(|e| e.is_finite()).collect();
    sorted.sort_by(f64::total_cmp);
    sorted.get(sorted.len() / 2).copied()
}

fn geom_of(pl: &PageLines, index: u32, l: &text_lines::Line) -> Result<LineGeom, AppError> {
    let span = l.span().ok_or_else(refused)?;
    Ok(LineGeom {
        start: span.start,
        end: span.end,
        baseline: span.baseline,
        size: l.size,
        room: pl.room_after(index),
    })
}

/// The width (page units) of the free space of line `i`, from its start (left) or in all (right, centre).
fn avail(geo: &ParaGeom, i: usize) -> f64 {
    let n = geo.lines.len();
    let Some(g) = geo.lines.get(i) else {
        return 0.0;
    };
    match geo.align {
        Align::Right | Align::Center if n > 1 => geo.right - geo.left,
        _ => {
            let right = if n > 1 {
                geo.right
            } else {
                geo.crop[2] - CROP_MARGIN
            };
            let limit = match g.room {
                Some(room) => right.min(g.end + room - NEXT_GAP),
                None => right,
            };
            // A line that already sticks out keeps its width, except in a justified paragraph (its edge is the paragraph's).
            let limit = if geo.justified && n > 1 {
                limit
            } else {
                limit.max(g.end)
            };
            (limit - g.start).max(0.0)
        }
    }
}

/// What the width of a text in the font of one line needs: the text state at its first glyph.
struct Measure {
    size: f64,
    tc: f64,
    tw: f64,
    tz: f64,
    mscale: f64,
}

impl Measure {
    fn of(streams: &[Vec<u8>], line: &OwnedLine) -> Result<Self, AppError> {
        let view = View::new(streams).map_err(|_| refused())?;
        let g = line.glyphs.first().ok_or_else(refused)?;
        let pos = view.pos_of(g.op).ok_or_else(refused)?;
        let st = view.state_at(pos);
        if st.size <= 0.0 || !st.size.is_finite() {
            return Err(refused());
        }
        Ok(Self {
            size: st.size,
            tc: st.tc,
            tw: st.tw,
            tz: st.tz / 100.0,
            mscale: g.size_eff / st.size,
        })
    }

    fn adv(&self, w: f64, space: bool) -> f64 {
        ((w / 1000.0 * self.size) + self.tc + if space { self.tw } else { 0.0 })
            * self.tz
            * self.mscale
    }

    /// The width of `text` in the font of `line`; a character the font lacks is measured in the substitute face.
    fn width(&self, line: &OwnedLine, text: &str, fw: FallbackWidth<'_>) -> f64 {
        let font = &line.font;
        let single = font.kind != FontKind::Type0IdentityH;
        text.chars()
            .map(|c| {
                let code = font.to_code.get(&c).copied().filter(|_| char_ok(font, c));
                match code {
                    Some(code) => {
                        self.adv(width_of(font, code).unwrap_or(500.0), single && code == 32)
                    }
                    None => self.adv(fw(line.face, c).map_or(500.0, f64::from), false),
                }
            })
            .sum()
    }
}

/// A new line: the bytes inserted after the last show operator of the paragraph.
struct Insertion {
    stream: usize,
    at: usize,
    text: String,
}

/// Plans the line below the paragraph that shows `text`; `None` when there is no room or the splice cannot do it with certainty.
fn plan_added_line(
    streams: &[Vec<u8>],
    last: &OwnedLine,
    geo: &ParaGeom,
    text: &str,
    fw: FallbackWidth<'_>,
) -> Option<Insertion> {
    let font = &last.font;
    if matches!(font.kind, FontKind::Type3 | FontKind::Type0Other) || text.is_empty() {
        return None;
    }
    let width = if font.kind == FontKind::Type0IdentityH {
        2
    } else {
        1
    };
    if !text.chars().all(|c| char_ok(font, c)) {
        return None;
    }
    let n = geo.lines.len();
    let g = geo.lines.last()?;
    let pitch = if n >= 2 {
        geo.lines.get(n - 2)?.baseline - g.baseline
    } else {
        1.2 * g.size
    };
    if !pitch.is_finite() || pitch < 0.5 * g.size {
        return None;
    }
    // Room: the free space below the last line (to the next object, or to the crop box minus its margin) holds one more line.
    let bottom = g.baseline - 0.25 * g.size;
    let ceiling = match geo.below {
        Some((baseline, size)) => baseline + 0.75 * size,
        None => geo.crop[1] + CROP_MARGIN,
    };
    if bottom - ceiling < pitch {
        return None;
    }
    let view = View::new(streams).ok()?;
    let first = last.glyphs.first()?;
    if (first.origin[1] - g.baseline).abs() > 0.01 {
        return None; // a text rise
    }
    let mut positions = Vec::with_capacity(last.glyphs.len());
    for glyph in &last.glyphs {
        let pos = view.pos_of(glyph.op)?;
        if !matches!(view.tok(pos).op.as_slice(), b"Tj" | b"TJ") {
            return None;
        }
        positions.push(pos);
    }
    let first_pos = *positions.iter().min()?;
    let last_pos = *positions.iter().max()?;
    let chain = view.chains();
    if positions.iter().any(|p| chain[*p] != chain[first_pos]) {
        return None;
    }
    // The text line matrix starts at the first glyph and no other show operator of the chain follows: `Td` there and back is exact.
    let before = (0..first_pos)
        .rev()
        .take_while(|p| chain[*p] == chain[first_pos])
        .any(|p| is_show(&view.tok(p).op));
    let after = (last_pos + 1..view.flat.len())
        .take_while(|p| chain[*p] == chain[last_pos])
        .any(|p| is_show(&view.tok(p).op));
    if before || after {
        return None;
    }
    let data = parse_show(view.bytes(first_pos), view.tok(first_pos), width).ok()?;
    if !matches!(data.items.first(), Some(Item::Glyph(_))) {
        return None;
    }
    let state = view.state_at(last_pos);
    if state.size <= 0.0 || !state.size.is_finite() {
        return None;
    }
    let m = Measure::of(streams, last).ok()?;
    let w = m.width(last, text, fw);
    let start = match geo.align {
        Align::Left => g.start,
        Align::Right => g.end - w,
        Align::Center => (g.start + g.end) / 2.0 - w / 2.0,
    };
    let mscale = first.size_eff / state.size;
    let tz = state.tz / 100.0;
    let tx = (start - first.origin[0]) / (mscale * tz);
    let ty = -pitch / mscale;
    if !tx.is_finite() || !ty.is_finite() {
        return None;
    }
    let mut hex = String::with_capacity(text.len() * 2 * width);
    for c in text.chars() {
        let code = *font.to_code.get(&c)?;
        for b in code_bytes(code, width) {
            hex.push_str(&format!("{b:02X}"));
        }
    }
    Some(Insertion {
        stream: view.flat[last_pos].stream,
        at: view.end(last_pos) as usize,
        text: format!(
            " {} {} Td <{hex}> Tj {} {} Td",
            fmt_num(tx),
            fmt_num(ty),
            fmt_num(-tx),
            fmt_num(-ty)
        ),
    })
}

fn at(geo: &ParaGeom, i: usize) -> Result<u32, AppError> {
    geo.indices.get(i).copied().ok_or_else(refused)
}

fn push_warning(warnings: &mut Vec<ChangeWarning>, w: ChangeWarning) {
    if !warnings.contains(&w) {
        warnings.push(w);
    }
}

fn merge(
    outcome: Outcome,
    warnings: &mut Vec<ChangeWarning>,
    fallback: &mut Vec<(Face, BTreeSet<char>)>,
) {
    for w in outcome.warnings {
        push_warning(warnings, w);
    }
    if let Some((face, chars)) = outcome.fallback {
        match fallback.iter_mut().find(|(f, _)| *f == face) {
            Some((_, set)) => set.extend(chars.chars()),
            None => fallback.push((face, chars.chars().collect())),
        }
    }
}

/// Applies one paragraph edit to `streams`: the lines from the edited one on get the re-broken words.
#[allow(clippy::too_many_lines)]
pub(super) fn reflow(
    streams: &mut [Vec<u8>],
    edit: &TextEdit,
    source: &mut dyn LineSource,
    fallback: &mut Vec<(Face, BTreeSet<char>)>,
    warnings: &mut Vec<ChangeWarning>,
    fw: FallbackWidth<'_>,
) -> Result<(), AppError> {
    let geo = source.paragraph(streams, fallback, edit.key)?;
    let n = geo.lines.len();
    let e = geo
        .indices
        .iter()
        .position(|i| *i == edit.key.line)
        .ok_or(AppError::invalid("lineKey"))?;

    // The lines from the edited one on, as they are now, and what their font measures.
    let mut old: Vec<OwnedLine> = Vec::with_capacity(n - e);
    let mut measures: Vec<Measure> = Vec::with_capacity(n - e);
    for i in e..n {
        let line = source.line(
            streams,
            fallback,
            LineKey {
                rev: edit.key.rev,
                line: at(&geo, i)?,
            },
        )?;
        measures.push(Measure::of(streams, &line)?);
        old.push(line);
    }

    // The words: the edited line's new ones, then the original ones of the lines after it.
    let new_words: Vec<&str> = edit.text.split_whitespace().collect();
    let e_count = new_words.len();
    let mut words: Vec<&str> = new_words;
    let mut o_end: Vec<usize> = Vec::with_capacity(old.len());
    let mut cum = 0usize;
    for (k, line) in old.iter().enumerate() {
        let count = line.text.split_whitespace().count();
        cum += count;
        o_end.push(cum);
        if k > 0 {
            words.extend(line.text.split_whitespace());
        }
    }
    let o_e = o_end.first().copied().unwrap_or(0);
    let total = words.len();

    // Greedy fill, until the breaks are the original ones again. The width of a line is summed word by word (the measure is additive).
    let mut targets: Vec<String> = Vec::with_capacity(old.len());
    let mut p = 0usize;
    let mut synced = false;
    for (k, (line, m)) in old.iter().zip(&measures).enumerate() {
        let width = avail(&geo, e + k);
        let space_w = m.width(line, " ", fw);
        let mut text = String::new();
        let mut text_w = 0.0;
        while let Some(word) = words.get(p) {
            let w = m.width(line, word, fw);
            if text.is_empty() {
                text_w = w;
            } else {
                let candidate = text_w + space_w + w;
                if candidate > width + SLACK {
                    break;
                }
                text.push(' ');
                text_w = candidate;
            }
            text.push_str(word);
            p += 1;
        }
        targets.push(text);
        if p >= e_count && o_end.get(k) == Some(&(p + o_e - e_count)) {
            synced = true;
            break;
        }
    }

    // What is left: one more line below the paragraph if there is room, else it overflows on the last line.
    let mut added: Option<String> = None;
    if !synced && p < total {
        let rest = words[p..].join(" ");
        let last = old.last().ok_or_else(refused)?;
        if plan_added_line(streams, last, &geo, &rest, fw).is_some() {
            let m = measures.last().ok_or_else(refused)?;
            if m.width(last, &rest, fw) > avail(&geo, n - 1) + SLACK {
                push_warning(warnings, ChangeWarning::TextOverflow);
            }
            added = Some(rest);
        } else if let Some(t) = targets.last_mut() {
            if !t.is_empty() {
                t.push(' ');
            }
            t.push_str(&rest);
            push_warning(warnings, ChangeWarning::TextOverflow);
        }
    }

    // Apply: the lines that keep text from the top down, then the emptied ones from the bottom up (so no index moves under us).
    let order: Vec<usize> = (0..targets.len())
        .filter(|k| !targets[*k].is_empty())
        .chain((0..targets.len()).rev().filter(|k| targets[*k].is_empty()))
        .collect();
    for k in order {
        let (Some(target), Some(before)) = (targets.get(k), old.get(k)) else {
            continue;
        };
        if *target == before.text {
            continue;
        }
        let line = source.line(
            streams,
            fallback,
            LineKey {
                rev: edit.key.rev.max(1),
                line: at(&geo, e + k)?,
            },
        )?;
        let input = LineInput {
            glyphs: line.glyphs.iter().collect(),
            text: &line.text,
            font: &line.font,
            face: line.face,
            align: line.align,
            // Every re-broken line but the paragraph's last is stretched to the right edge; the last keeps its natural width.
            justified: geo.justified && (e + k + 1 < n || added.is_some()),
            // The limit the fill used (the line already fits it); an overflow the fill could not avoid is warned of below.
            right_limit: geo.lines.get(e + k).map(|g| g.start + avail(&geo, e + k)),
        };
        let outcome = edit_line(streams, &input, target, edit.fit, fw)?;
        merge(outcome, warnings, fallback);
    }

    if let Some(text) = added {
        let last = source.line(
            streams,
            fallback,
            LineKey {
                rev: edit.key.rev.max(1),
                line: at(&geo, n - 1)?,
            },
        )?;
        let insertion = plan_added_line(streams, &last, &geo, &text, fw).ok_or_else(refused)?;
        let bytes = streams.get_mut(insertion.stream).ok_or_else(refused)?;
        if insertion.at > bytes.len() {
            return Err(refused());
        }
        bytes.splice(insertion.at..insertion.at, insertion.text.bytes());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use lopdf::{Dictionary, Object, Stream};

    use super::super::replay;
    use super::*;
    use crate::fontprog::fallback::FallbackStore;
    use crate::model::text_edit::{TextFit, TextScope};
    use crate::pdfwrite::text_lines;

    fn name(n: &str) -> Object {
        Object::Name(n.as_bytes().to_vec())
    }

    fn doc_for(content: &str) -> (Document, ObjectId) {
        let mut doc = Document::with_version("1.5");
        let pages_id = doc.new_object_id();
        let font = doc.add_object(Dictionary::from_iter([
            ("Type", name("Font")),
            ("Subtype", name("Type1")),
            ("BaseFont", name("Helvetica")),
            ("Encoding", name("WinAnsiEncoding")),
        ]));
        let fonts = Dictionary::from_iter([("F1", Object::Reference(font))]);
        let resources = Dictionary::from_iter([("Font", Object::Dictionary(fonts))]);
        let stream = doc.add_object(Stream::new(Dictionary::new(), content.as_bytes().to_vec()));
        let page = doc.add_object(Dictionary::from_iter([
            ("Type", name("Page")),
            ("Parent", Object::Reference(pages_id)),
            (
                "MediaBox",
                Object::Array(vec![
                    Object::Integer(0),
                    Object::Integer(0),
                    Object::Integer(612),
                    Object::Integer(792),
                ]),
            ),
            ("Contents", Object::Reference(stream)),
        ]));
        let pages = Dictionary::from_iter([
            ("Type", name("Pages")),
            ("Count", Object::Integer(1)),
            ("Kids", Object::Array(vec![Object::Reference(page)])),
            ("Resources", Object::Dictionary(resources)),
        ]);
        doc.objects.insert(pages_id, Object::Dictionary(pages));
        (doc, page)
    }

    /// `(text, start, end, baseline)` of every line of `content`, in reading order.
    fn layout(content: &str) -> Vec<(String, f64, f64, f64)> {
        let (doc, page) = doc_for(content);
        text_lines::lines(&doc, page, &[])
            .unwrap()
            .lines
            .iter()
            .map(|l| {
                let s = l.span().unwrap();
                (l.text.clone(), s.start, s.end, s.baseline)
            })
            .collect()
    }

    fn line(x: f64, y: f64, size: f64, text: &str) -> String {
        format!("BT /F1 {size} Tf {x} {y} Td ({text}) Tj ET\n")
    }

    const P: [&str; 3] = [
        "The quick brown fox jumps over the lazy dog and",
        "keeps running through the green forest until the",
        "evening comes and goes.",
    ];

    fn paragraph(x: f64, top: f64) -> String {
        sized(x, top, 12.0)
    }

    fn sized(x: f64, top: f64, size: f64) -> String {
        P.iter()
            .enumerate()
            .map(|(i, t)| line(x, top - 14.0 * i as f64, size, t))
            .collect()
    }

    fn reflow_of(
        content: &str,
        at_text: &str,
        new_text: &str,
    ) -> Result<(String, Vec<ChangeWarning>), AppError> {
        let (doc, page) = doc_for(content);
        let all = text_lines::lines(&doc, page, &[]).unwrap();
        let index = all
            .lines
            .iter()
            .position(|l| l.text.starts_with(at_text))
            .unwrap();
        let edits = [TextEdit {
            key: LineKey {
                rev: 0,
                line: index as u32,
            },
            text: new_text.to_owned(),
            fit: TextFit::KeepStart,
            scope: TextScope::Paragraph,
        }];
        let r = replay(&doc, page, &edits, &FallbackStore::default())?;
        Ok((String::from_utf8(r.content).unwrap(), r.warnings))
    }

    fn words(lines: &[(String, f64, f64, f64)]) -> Vec<String> {
        lines
            .iter()
            .flat_map(|l| l.0.split_whitespace().map(str::to_owned))
            .collect()
    }

    #[test]
    fn a_longer_line_pushes_its_last_words_down_within_the_paragraph() {
        let before = paragraph(72.0, 700.0);
        let old = layout(&before);
        assert_eq!(old.len(), 3, "{old:?}");
        let right = old.iter().map(|l| l.2).fold(0.0, f64::max);
        let new_text = "The very quick brown fox jumps over the lazy dog and";
        let (after, warnings) = reflow_of(&before, P[0], new_text).unwrap();
        assert!(warnings.is_empty(), "{warnings:?}");
        let now = layout(&after);
        assert_eq!(now.len(), 3, "{now:?}");
        let expect: Vec<String> = format!("{new_text} {} {}", P[1], P[2])
            .split_whitespace()
            .map(str::to_owned)
            .collect();
        assert_eq!(words(&now), expect);
        for (l, o) in now.iter().zip(&old) {
            assert!((l.1 - 72.0).abs() < 0.01, "left edge {l:?}");
            assert!((l.3 - o.3).abs() < 0.01, "baseline {l:?}");
            assert!(l.2 <= right + SLACK + 0.01, "right edge {l:?} > {right}");
        }
    }

    #[test]
    fn the_rest_gets_one_new_line_when_there_is_room() {
        let before = paragraph(72.0, 700.0);
        let new_text = format!("{} then also a good deal of further words", P[0]);
        let (after, warnings) = reflow_of(&before, P[0], &new_text).unwrap();
        assert!(warnings.is_empty(), "{warnings:?}");
        let now = layout(&after);
        assert_eq!(now.len(), 4, "{now:?}");
        let expect: Vec<String> = format!("{new_text} {} {}", P[1], P[2])
            .split_whitespace()
            .map(str::to_owned)
            .collect();
        assert_eq!(words(&now), expect);
        let added = &now[3];
        assert!((added.1 - 72.0).abs() < 0.01, "left edge {added:?}");
        assert!((added.3 - (700.0 - 3.0 * 14.0)).abs() < 0.01, "{added:?}");
        // The lines after the new one in the stream are still where they were: the position is restored.
        assert!(after.contains("Td <"));
    }

    #[test]
    fn without_room_the_rest_overflows_on_the_last_line() {
        let before = format!(
            "{}{}",
            paragraph(72.0, 700.0),
            line(72.0, 654.0, 10.0, "FOOTER")
        );
        let new_text = format!("{} then also a good deal of further words", P[0]);
        let (after, warnings) = reflow_of(&before, P[0], &new_text).unwrap();
        assert_eq!(warnings, vec![ChangeWarning::TextOverflow]);
        let now = layout(&after);
        assert_eq!(now.len(), 4, "{now:?}");
        assert_eq!(now[3].0, "FOOTER");
        assert!(now[2].0.ends_with("goes."), "{now:?}");
        assert!(after.contains("(FOOTER) Tj"));
    }

    #[test]
    fn another_paragraph_is_not_touched() {
        let other = format!(
            "{}{}",
            line(72.0, 560.0, 12.0, "Second paragraph, first line is here."),
            line(72.0, 546.0, 12.0, "and its second line.")
        );
        let before = format!("{}{other}", paragraph(72.0, 700.0));
        let new_text = format!("{} then also a good deal of further words", P[0]);
        let (after, _) = reflow_of(&before, P[0], &new_text).unwrap();
        assert!(after.ends_with(&other), "{after}");
        let now = layout(&after);
        assert_eq!(now.len(), 6, "{now:?}");
    }

    #[test]
    fn replaying_without_the_edit_gives_the_original_stream() {
        let before = paragraph(72.0, 700.0);
        let new_text = format!("{} then also a good deal of further words", P[0]);
        let (after, _) = reflow_of(&before, P[0], &new_text).unwrap();
        assert_ne!(after, before);
        let (doc, page) = doc_for(&before);
        let undone = replay(&doc, page, &[], &FallbackStore::default()).unwrap();
        assert_eq!(undone.content, before.as_bytes());
    }

    #[test]
    fn a_two_column_page_stays_in_its_column() {
        let left = sized(72.0, 700.0, 10.0);
        let right = sized(320.0, 700.0, 10.0);
        let before = format!("{left}{right}");
        let old = layout(&before);
        assert_eq!(old.len(), 6, "{old:?}");
        let new_text = format!("{} then also a good deal of further words", P[0]);
        let (after, _) = reflow_of(&before, P[0], &new_text).unwrap();
        let now = layout(&after);
        let in_left: Vec<_> = now.iter().filter(|l| l.1 < 200.0).cloned().collect();
        let in_right: Vec<_> = now.iter().filter(|l| l.1 >= 200.0).cloned().collect();
        assert_eq!(in_right.len(), 3, "{now:?}");
        assert_eq!(
            in_right,
            old.iter()
                .filter(|l| l.1 >= 200.0)
                .cloned()
                .collect::<Vec<_>>()
        );
        assert!(in_left.iter().all(|l| l.2 < 320.0), "{in_left:?}");
        assert!(after.ends_with(&right) || after.contains(&right), "{after}");
    }

    /// A justified paragraph of `texts` (a `Tw` per line makes every line but the last end at the same edge); the edge.
    fn justified_paragraph(texts: &[&str]) -> (String, f64) {
        let natural: Vec<f64> = texts
            .iter()
            .map(|t| layout(&line(72.0, 700.0, 12.0, t))[0].2 - 72.0)
            .collect();
        let inner = texts.len() - 1;
        let edge = natural[..inner].iter().copied().fold(0.0, f64::max) + 8.0;
        let mut out = String::new();
        for (i, t) in texts.iter().enumerate() {
            let tw = if i < inner {
                (edge - natural[i]) / t.matches(' ').count() as f64
            } else {
                0.0
            };
            let y = 700.0 - 14.0 * i as f64;
            out.push_str(&format!("BT /F1 12 Tf {tw} Tw 72 {y} Td ({t}) Tj ET\n"));
        }
        (out, 72.0 + edge)
    }

    #[test]
    fn re_broken_inner_lines_of_a_justified_paragraph_stretch_and_the_last_stays_natural() {
        let (before, edge) = justified_paragraph(&P);
        let old = layout(&before);
        assert_eq!(old.len(), 3, "{old:?}");
        assert!((old[0].2 - edge).abs() < 0.1 && (old[1].2 - edge).abs() < 0.1);
        let new_text = format!("{} then also a good deal", P[0]);
        let (after, _) = reflow_of(&before, P[0], &new_text).unwrap();
        let now = layout(&after);
        assert!(now.len() >= 3, "{now:?}");
        let (last, inner) = now.split_last().unwrap();
        for l in inner {
            assert!(
                (l.2 - edge).abs() < 1.0,
                "inner line {l:?} misses the edge {edge}"
            );
        }
        assert!(
            last.2 < edge - 4.0,
            "the last line stays natural: {last:?} vs {edge}"
        );
    }
}
