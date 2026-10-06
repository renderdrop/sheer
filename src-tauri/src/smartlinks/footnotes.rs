//! Footnote detector (ADR-132 §2/§3, DESIGN §3.11 L1/L2): a raised marker in the body links to the note on the same page's lower part,
//! to a continued note on the next page, or to an entry of an endnote section; the note's leading marker links back (NoteBack).
//! Pure over [`DocText`]; notes and markers are indexed once per page (lazily) so a call stays linear in the pages it touches.

use std::collections::{HashMap, HashSet};

use super::model::{DocText, Kind, Line, PageText, PtRect, Run, SmartLink, Target};

/// Preview budget in chars including the ellipsis (wire limit 280).
const PREVIEW_MAX: usize = 280;
/// Endnote scan limits: pages per call and text per entry.
const MAX_PAGES: usize = 5000;
const MAX_NOTE_CHARS: usize = 2000;
const MAX_ENDNOTES: usize = 5000;
/// A marker is raised when its baseline is this far (in body sizes) above the line baseline, or it is this small.
const RAISE_FRAC: f32 = 0.25;
const SMALL_FRAC: f32 = 0.8;
/// A note line is smaller than the body by this factor.
const NOTE_FRAC: f32 = 0.97;
/// Notes on the same page live below this fraction of the page height.
const LOWER_FROM: f32 = 0.6;
const MIN_SCORE: f32 = 0.75;
const MIN_GAP: f32 = 0.25;
const HEADINGS: [&str; 4] = ["anmerkungen", "endnoten", "endnotes", "notes"];

#[derive(Debug, Clone)]
struct Marker {
    key: String,
    rect: PtRect,
    line_text: String,
}

#[derive(Debug, Clone)]
struct Note {
    key: String,
    marker_rect: PtRect,
    rect: PtRect,
    text: String,
    page_idx: usize,
    size_ratio: f32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct NoteRef {
    endnote: bool,
    page_idx: usize,
    idx: usize,
}

/// The endnote sections of the whole document, built once per revision (ADR-132 §5): the entries, the pages they sit on, and lookups
/// by marker key and by page.
#[derive(Debug, Clone, Default)]
pub struct FootnoteIndex {
    endnotes: Vec<Note>,
    endnote_pages: HashSet<usize>,
    by_key: HashMap<String, Vec<usize>>,
    by_page: HashMap<usize, Vec<usize>>,
}

/// Scans the endnote sections of `doc`.
pub fn build_footnote_index(doc: &DocText) -> FootnoteIndex {
    let n = doc.pages.len().min(MAX_PAGES);
    let (endnotes, endnote_pages) = build_endnotes(doc, n);
    let mut by_key: HashMap<String, Vec<usize>> = HashMap::new();
    let mut by_page: HashMap<usize, Vec<usize>> = HashMap::new();
    for (i, e) in endnotes.iter().enumerate() {
        by_key.entry(e.key.clone()).or_default().push(i);
        by_page.entry(e.page_idx).or_default().push(i);
    }
    FootnoteIndex {
        endnotes,
        endnote_pages,
        by_key,
        by_page,
    }
}

struct Ctx<'a> {
    doc: &'a DocText,
    notes: Vec<Option<Vec<Note>>>,
    markers: Vec<Option<Vec<Marker>>>,
    index: &'a FootnoteIndex,
}

/// Footnote and NoteBack links of `page` (the `PageText::page` value). Empty when the page was not read or has no body size.
pub fn detect(doc: &DocText, page: u32, index: &FootnoteIndex) -> Vec<SmartLink> {
    let Some(idx) = doc.pages.iter().position(|p| p.page == page) else {
        return Vec::new();
    };
    if doc.pages[idx].body_size <= 0.0 {
        return Vec::new();
    }
    let mut cx = Ctx::new(doc, index);
    let mut out = Vec::new();

    // Footnote: markers of this page.
    cx.ensure_markers(idx);
    let markers = cx.markers[idx].clone().unwrap_or_default();
    for m in &markers {
        if let Some((nref, score)) = cx.resolve(idx, m) {
            let n = cx.note(nref).clone();
            out.push(SmartLink {
                kind: Kind::Footnote,
                page,
                rects: vec![m.rect],
                marker: m.key.clone(),
                target: Target {
                    page: doc.pages[n.page_idx].page,
                    rect: Some(n.rect),
                },
                preview: preview(&n.text),
                score,
            });
        }
    }

    // NoteBack: notes of this page whose marker has exactly one source.
    let mut refs: Vec<NoteRef> = Vec::new();
    cx.ensure_notes(idx);
    let local = cx.notes[idx].as_ref().map_or(0, Vec::len);
    refs.extend((0..local).map(|i| NoteRef {
        endnote: false,
        page_idx: idx,
        idx: i,
    }));
    refs.extend(
        index
            .by_page
            .get(&idx)
            .map_or(&[][..], Vec::as_slice)
            .iter()
            .map(|&i| NoteRef {
                endnote: true,
                page_idx: idx,
                idx: i,
            }),
    );
    for nref in refs {
        let n = cx.note(nref).clone();
        let sources: Vec<usize> = if nref.endnote {
            (0..=idx).collect()
        } else {
            vec![idx.saturating_sub(1), idx]
        };
        let mut found: Vec<(Marker, usize, f32)> = Vec::new();
        let mut seen: HashSet<usize> = HashSet::new();
        for s in sources {
            if !seen.insert(s) {
                continue;
            }
            cx.ensure_markers(s);
            let ms = cx.markers[s].clone().unwrap_or_default();
            for m in ms.into_iter().filter(|m| m.key == n.key) {
                if let Some((r, score)) = cx.resolve(s, &m) {
                    if r == nref {
                        found.push((m, s, score));
                    }
                }
            }
        }
        if found.len() == 1 {
            let (m, s, score) = found.remove(0);
            out.push(SmartLink {
                kind: Kind::NoteBack,
                page,
                rects: vec![n.marker_rect],
                marker: n.key.clone(),
                target: Target {
                    page: doc.pages[s].page,
                    rect: Some(m.rect),
                },
                preview: preview(&m.line_text),
                score,
            });
        }
    }
    out
}

impl<'a> Ctx<'a> {
    fn new(doc: &'a DocText, index: &'a FootnoteIndex) -> Self {
        Ctx {
            doc,
            notes: vec![None; doc.pages.len()],
            markers: vec![None; doc.pages.len()],
            index,
        }
    }

    fn note(&self, r: NoteRef) -> &Note {
        if r.endnote {
            &self.index.endnotes[r.idx]
        } else {
            // Indexed by `resolve`/`detect` after `ensure_notes`.
            &self.notes[r.page_idx]
                .as_ref()
                .map_or(&[][..], Vec::as_slice)[r.idx]
        }
    }

    fn ensure_notes(&mut self, i: usize) {
        if i >= self.notes.len() || self.notes[i].is_some() {
            return;
        }
        let v = if self.index.endnote_pages.contains(&i) {
            Vec::new()
        } else {
            page_notes(&self.doc.pages[i], i)
        };
        self.notes[i] = Some(v);
    }

    fn ensure_markers(&mut self, i: usize) {
        if i >= self.markers.len() || self.markers[i].is_some() {
            return;
        }
        self.markers[i] = Some(page_markers(&self.doc.pages[i]));
    }

    /// The single note a marker on page `s` points to, with its score (ADR-132 §3), or `None`.
    fn resolve(&mut self, s: usize, m: &Marker) -> Option<(NoteRef, f32)> {
        self.ensure_markers(s);
        let dup = self.markers[s]
            .as_ref()
            .map_or(0, |v| v.iter().filter(|x| x.key == m.key).count());
        if dup != 1 {
            return None;
        }
        let page = &self.doc.pages[s];
        let mut cands: Vec<(f32, NoteRef)> = Vec::new();
        self.ensure_notes(s);
        if let Some(ns) = &self.notes[s] {
            for (i, n) in ns.iter().enumerate() {
                if n.key == m.key && n.rect.y >= page.height * LOWER_FROM && n.rect.y > m.rect.y {
                    let bonus = if n.size_ratio < 0.85 { 0.05 } else { 0.0 };
                    cands.push((
                        0.9 + bonus,
                        NoteRef {
                            endnote: false,
                            page_idx: s,
                            idx: i,
                        },
                    ));
                }
            }
        }
        if cands.is_empty()
            && s + 1 < self.doc.pages.len()
            && self.doc.pages[s + 1].page == page.page + 1
        {
            self.ensure_notes(s + 1);
            if let Some(ns) = &self.notes[s + 1] {
                for (i, n) in ns.iter().enumerate() {
                    if n.key == m.key {
                        cands.push((
                            0.78,
                            NoteRef {
                                endnote: false,
                                page_idx: s + 1,
                                idx: i,
                            },
                        ));
                    }
                }
            }
        }
        if cands.is_empty() {
            for &i in self.index.by_key.get(&m.key).map_or(&[][..], Vec::as_slice) {
                let n = &self.index.endnotes[i];
                if n.page_idx >= s {
                    cands.push((
                        0.8,
                        NoteRef {
                            endnote: true,
                            page_idx: n.page_idx,
                            idx: i,
                        },
                    ));
                }
            }
        }
        cands.sort_by(|a, b| b.0.total_cmp(&a.0));
        let (best, nref) = *cands.first()?;
        let runner = cands.get(1).map_or(0.0, |c| c.0);
        (best >= MIN_SCORE && runner <= best - MIN_GAP).then_some((nref, best))
    }
}

// ---- text helpers ----

fn sup_digit(c: char) -> Option<char> {
    Some(match c {
        '⁰' => '0',
        '¹' => '1',
        '²' => '2',
        '³' => '3',
        '⁴' => '4',
        '⁵' => '5',
        '⁶' => '6',
        '⁷' => '7',
        '⁸' => '8',
        '⁹' => '9',
        _ => return None,
    })
}

fn valid_number(s: &str) -> bool {
    !s.is_empty() && s.len() <= 3 && !s.starts_with('0') && s.bytes().all(|b| b.is_ascii_digit())
}

/// A whole string that is a marker: 1–999, superscript digits, `*`, `†`, `‡`. Returns the normalised key.
fn parse_marker(s: &str) -> Option<String> {
    let t = s.trim();
    if matches!(t, "*" | "†" | "‡") {
        return Some(t.to_string());
    }
    if valid_number(t) {
        return Some(t.to_string());
    }
    let mapped: Option<String> = t.chars().map(sup_digit).collect();
    mapped.filter(|m| valid_number(m))
}

fn is_sup_only(s: &str) -> bool {
    let t = s.trim();
    !t.is_empty() && t.chars().all(|c| sup_digit(c).is_some())
}

/// Splits `word¹` into (char count of the prefix, key) when the text ends in superscript digits and has a non-empty prefix.
fn trailing_sup(text: &str) -> Option<(usize, String)> {
    let chars: Vec<char> = text.chars().collect();
    let tail = chars
        .iter()
        .rev()
        .take_while(|c| sup_digit(**c).is_some())
        .count();
    if tail == 0 || tail == chars.len() {
        return None;
    }
    let key: String = chars[chars.len() - tail..]
        .iter()
        .filter_map(|c| sup_digit(*c))
        .collect();
    valid_number(&key).then_some((chars.len() - tail, key))
}

fn run_text(line: &Line) -> String {
    let mut s = String::new();
    for r in &line.runs {
        if !s.is_empty()
            && !s.ends_with(char::is_whitespace)
            && !r.text.starts_with(char::is_whitespace)
        {
            s.push(' ');
        }
        s.push_str(&r.text);
    }
    collapse(&s)
}

fn collapse(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn union(a: PtRect, b: PtRect) -> PtRect {
    let x = a.x.min(b.x);
    let y = a.y.min(b.y);
    let r = (a.x + a.w).max(b.x + b.w);
    let bt = (a.y + a.h).max(b.y + b.h);
    PtRect {
        x,
        y,
        w: r - x,
        h: bt - y,
    }
}

/// Note text cut to the preview budget at a word boundary, "…" appended when cut.
fn preview(text: &str) -> String {
    let t = collapse(text);
    if t.chars().count() <= PREVIEW_MAX {
        return t;
    }
    let budget = PREVIEW_MAX - 1;
    let cut: String = t.chars().take(budget).collect();
    let next_is_space = t.chars().nth(budget).is_some_and(char::is_whitespace);
    let base = if next_is_space {
        cut.as_str()
    } else {
        match cut.rfind(char::is_whitespace) {
            Some(p) if p > 0 => &cut[..p],
            _ => cut.as_str(),
        }
    };
    format!("{}…", base.trim_end())
}

fn frac_rect(r: PtRect, from: usize, to: usize, total: usize) -> PtRect {
    if total == 0 {
        return r;
    }
    let t = total as f32;
    PtRect {
        x: r.x + r.w * from as f32 / t,
        y: r.y,
        w: r.w * (to - from) as f32 / t,
        h: r.h,
    }
}

// ---- markers ----

fn page_markers(p: &PageText) -> Vec<Marker> {
    let body = p.body_size;
    let mut out = Vec::new();
    for line in &p.lines {
        let base = line
            .runs
            .iter()
            .filter(|r| r.size > SMALL_FRAC * body)
            .map(|r| r.baseline)
            .fold(f32::NEG_INFINITY, f32::max);
        if !base.is_finite() {
            continue;
        }
        let mut text: Option<String> = None;
        for (ri, run) in line.runs.iter().enumerate() {
            if ri == 0 {
                continue; // line-start numbers are list numbers or page numbers
            }
            let prev_ok = |tail: &str| {
                !tail.chars().last().is_some_and(|c| {
                    c.is_ascii_digit() || matches!(c, '^' | '+' | '-' | '=' | '/' | '(' | '·')
                })
            };
            let found = if let Some(key) = parse_marker(&run.text) {
                let raised = is_sup_only(&run.text)
                    || run.size <= SMALL_FRAC * body
                    || base - run.baseline >= RAISE_FRAC * body;
                (raised && prev_ok(&line.runs[ri - 1].text)).then_some((key, run.rect))
            } else if let Some((pre, key)) = trailing_sup(&run.text) {
                let prefix: String = run.text.chars().take(pre).collect();
                let total = run.text.chars().count();
                (prev_ok(&prefix) && run.size > SMALL_FRAC * body)
                    .then(|| (key, frac_rect(run.rect, pre, total, total)))
            } else {
                None
            };
            if let Some((key, rect)) = found {
                let lt = text.get_or_insert_with(|| run_text(line)).clone();
                out.push(Marker {
                    key,
                    rect,
                    line_text: lt,
                });
            }
        }
    }
    out
}

// ---- notes ----

/// Parses a leading marker of a line: (key, marker rect, rest text of the line). `need_small` demands a run smaller than the body.
fn note_start(line: &Line, body: f32, need_small: bool) -> Option<(String, PtRect, String)> {
    let first: &Run = line.runs.iter().find(|r| !r.text.trim().is_empty())?;
    if need_small && first.size >= NOTE_FRAC * body {
        return None;
    }
    let skip = first.text.chars().take_while(|c| c.is_whitespace()).count();
    let t: String = first.text.chars().skip(skip).collect();
    let total = first.text.chars().count();
    let chars: Vec<char> = t.chars().collect();
    let (key, len) = if chars.first().is_some_and(|c| sup_digit(*c).is_some()) {
        let n = chars
            .iter()
            .take_while(|c| sup_digit(**c).is_some())
            .count();
        let k: String = chars[..n].iter().filter_map(|c| sup_digit(*c)).collect();
        (valid_number(&k).then_some(k)?, n)
    } else if chars.first().is_some_and(char::is_ascii_digit) {
        let n = chars.iter().take_while(|c| c.is_ascii_digit()).count();
        let k: String = chars[..n].iter().collect();
        if !valid_number(&k)
            || chars
                .get(n)
                .is_some_and(|c| !(c.is_whitespace() || matches!(c, '.' | ')' | ':' | ']')))
        {
            return None;
        }
        (k, n)
    } else if chars.first().is_some_and(|c| matches!(c, '*' | '†' | '‡')) {
        (chars[0].to_string(), 1)
    } else {
        return None;
    };
    let rest_first: String = chars[len..].iter().collect();
    let rect = if rest_first.trim().is_empty() {
        first.rect
    } else {
        frac_rect(first.rect, skip, skip + len, total)
    };
    let mut rest = rest_first;
    let mut after_first = false;
    for r in &line.runs {
        if std::ptr::eq(r, first) {
            after_first = true;
            continue;
        }
        if after_first {
            rest.push(' ');
            rest.push_str(&r.text);
        }
    }
    let rest = collapse(
        rest.trim_start_matches(|c: char| c.is_whitespace() || matches!(c, '.' | ')' | ':' | ']')),
    );
    (!rest.is_empty()).then_some((key, rect, rest))
}

/// All small-text notes of a page (any position; callers filter by region): marker line plus continuation lines.
fn page_notes(p: &PageText, page_idx: usize) -> Vec<Note> {
    let body = p.body_size;
    let mut out: Vec<Note> = Vec::new();
    let mut i = 0;
    while i < p.lines.len() {
        let line = &p.lines[i];
        let Some((key, marker_rect, mut text)) = note_start(line, body, true) else {
            i += 1;
            continue;
        };
        let size = line.runs.first().map_or(body, |r| r.size);
        let mut rect = line.rect;
        let mut j = i + 1;
        while j < p.lines.len() {
            let l = &p.lines[j];
            let small = l.runs.first().is_some_and(|r| r.size < NOTE_FRAC * body);
            if !small || note_start(l, body, true).is_some() || l.rect.y < rect.y {
                break;
            }
            text.push(' ');
            text.push_str(&run_text(l));
            rect = union(rect, l.rect);
            j += 1;
        }
        out.push(Note {
            key,
            marker_rect,
            rect,
            text: collapse(&text),
            page_idx,
            size_ratio: size / body,
        });
        i = j.max(i + 1);
    }
    out
}

/// Entries of endnote sections ("Anmerkungen", "Endnoten", "Notes" heading), and the pages they sit on.
fn build_endnotes(doc: &DocText, n: usize) -> (Vec<Note>, HashSet<usize>) {
    let mut entries: Vec<Note> = Vec::new();
    let mut pages: HashSet<usize> = HashSet::new();
    let heading_at = |p: &PageText| {
        p.lines.iter().position(|l| {
            let t = run_text(l).to_lowercase();
            HEADINGS.contains(&t.trim_end_matches(':').trim())
        })
    };
    let mut in_section = false;
    for (pi, p) in doc.pages.iter().enumerate().take(n) {
        let start = match heading_at(p) {
            Some(h) => {
                in_section = true;
                h + 1
            }
            None if in_section => 0,
            None => continue,
        };
        let mut current: Option<usize> = None;
        for l in p.lines.iter().skip(start) {
            if entries.len() >= MAX_ENDNOTES {
                break;
            }
            if let Some((key, marker_rect, text)) = note_start(l, p.body_size, false) {
                entries.push(Note {
                    key,
                    marker_rect,
                    rect: l.rect,
                    text,
                    page_idx: pi,
                    size_ratio: 1.0,
                });
                current = Some(entries.len() - 1);
                pages.insert(pi);
            } else if let Some(c) = current {
                let e = &mut entries[c];
                if e.text.len() < MAX_NOTE_CHARS {
                    e.text.push(' ');
                    e.text.push_str(&run_text(l));
                    e.rect = union(e.rect, l.rect);
                }
            }
        }
        if current.is_none() && heading_at(p).is_none() {
            in_section = false;
        }
    }
    (entries, pages)
}

#[cfg(test)]
mod tests {
    use super::*;

    const BODY: f32 = 11.0;

    fn run(text: &str, x: f32, y: f32, size: f32, baseline: f32) -> Run {
        Run {
            text: text.into(),
            rect: PtRect {
                x,
                y,
                w: 6.0 * text.chars().count() as f32,
                h: size,
            },
            size,
            baseline,
            bold: false,
        }
    }

    fn line(runs: Vec<Run>) -> Line {
        let mut rect = runs[0].rect;
        for r in &runs[1..] {
            rect = union(rect, r.rect);
        }
        Line { runs, rect }
    }

    /// Body line with a raised marker after the first words.
    fn body_with_marker(y: f32, before: &str, marker: &str) -> Line {
        line(vec![
            run(before, 50.0, y, BODY, y + 10.0),
            run(
                marker,
                50.0 + 6.0 * before.chars().count() as f32,
                y,
                7.0,
                y + 4.0,
            ),
            run(" goes on.", 150.0, y, BODY, y + 10.0),
        ])
    }

    fn note_line(y: f32, marker: &str, text: &str) -> Line {
        line(vec![
            run(marker, 50.0, y, 8.0, y + 8.0),
            run(text, 60.0, y, 8.0, y + 8.0),
        ])
    }

    fn plain(y: f32, text: &str) -> Line {
        line(vec![run(text, 50.0, y, BODY, y + 10.0)])
    }

    fn page(n: u32, lines: Vec<Line>) -> PageText {
        PageText {
            page: n,
            width: 600.0,
            height: 800.0,
            lines,
            body_size: BODY,
        }
    }

    fn doc(pages: Vec<PageText>) -> DocText {
        let n = pages.len() as u32;
        DocText {
            pages,
            page_count: n,
            labels: Vec::new(),
        }
    }

    fn detect(d: &DocText, page: u32) -> Vec<SmartLink> {
        super::detect(d, page, &build_footnote_index(d))
    }

    #[test]
    fn hostile_input_does_not_panic() {
        let nan = PtRect {
            x: f32::NAN,
            y: -1.0,
            w: -2.0,
            h: f32::INFINITY,
        };
        let mut odd = run("e\u{301}ÄÖÜ\u{301}¹²", 50.0, 100.0, f32::NAN, f32::NAN);
        odd.rect = nan;
        let empty = Line {
            runs: vec![run("", 0.0, 0.0, BODY, 0.0)],
            rect: nan,
        };
        let none = Line {
            runs: Vec::new(),
            rect: nan,
        };
        let long = plain(140.0, &format!("1{}", "9".repeat(40)));
        let d = doc(vec![page(
            0,
            vec![
                line(vec![run("Wort", 50.0, 80.0, BODY, 90.0), odd]),
                empty,
                none,
                long,
                body_with_marker(100.0, "ÄÖ\u{301}", "12345678901234567890"),
                note_line(700.0, "12345678901234567890", "Zehn+ Ziffern"),
                note_line(715.0, "\u{301}¹", "Combining first"),
            ],
        )]);
        assert!(detect(&d, 0).iter().all(|l| l.marker.len() <= 3));
    }

    #[test]
    fn happy_path_footnote_and_note_back() {
        let d = doc(vec![page(
            0,
            vec![
                plain(80.0, "Intro line"),
                body_with_marker(100.0, "A claim", "1"),
                note_line(700.0, "1", "See the source, p. 4."),
            ],
        )]);
        let links = detect(&d, 0);
        assert_eq!(links.len(), 2);
        let f = links.iter().find(|l| l.kind == Kind::Footnote).unwrap();
        assert_eq!(f.marker, "1");
        assert_eq!(f.target.page, 0);
        assert!(f.target.rect.unwrap().y >= 690.0);
        assert_eq!(f.preview, "See the source, p. 4.");
        assert!(f.score >= 0.9);
        let b = links.iter().find(|l| l.kind == Kind::NoteBack).unwrap();
        assert_eq!(b.target.page, 0);
        assert_eq!(b.target.rect.unwrap(), f.rects[0]);
        assert!(b.preview.starts_with("A claim"));
    }

    #[test]
    fn superscript_glyph_marker_and_symbol() {
        let l1 = line(vec![
            run("Word", 50.0, 100.0, BODY, 110.0),
            run("²", 80.0, 100.0, BODY, 110.0),
            run(" more", 90.0, 100.0, BODY, 110.0),
        ]);
        let d = doc(vec![page(0, vec![l1, note_line(700.0, "2", "Two.")])]);
        let links = detect(&d, 0);
        assert!(links
            .iter()
            .any(|l| l.kind == Kind::Footnote && l.marker == "2"));
        let l2 = body_with_marker(100.0, "Star", "†");
        let d = doc(vec![page(
            0,
            vec![l2, note_line(700.0, "†", "Dagger note")],
        )]);
        assert_eq!(detect(&d, 0).len(), 2);
    }

    #[test]
    fn continued_note_on_next_page() {
        let d = doc(vec![
            page(0, vec![body_with_marker(100.0, "Late claim", "3")]),
            page(
                1,
                vec![
                    plain(80.0, "Next"),
                    note_line(200.0, "3", "Note on next page."),
                ],
            ),
        ]);
        let f = detect(&d, 0);
        assert_eq!(f.len(), 1);
        assert_eq!(f[0].target.page, 1);
        assert!((f[0].score - 0.78).abs() < 1e-3);
        let b = detect(&d, 1);
        assert_eq!(b.len(), 1);
        assert_eq!(b[0].kind, Kind::NoteBack);
        assert_eq!(b[0].target.page, 0);
    }

    #[test]
    fn endnotes_section() {
        let end = page(
            2,
            vec![
                plain(60.0, "Notes"),
                plain(100.0, "1 First endnote text"),
                plain(120.0, "continues here"),
                plain(140.0, "2. Second endnote"),
            ],
        );
        let d = doc(vec![
            page(0, vec![body_with_marker(100.0, "Claim", "2")]),
            page(1, vec![plain(100.0, "Nothing")]),
            end,
        ]);
        let f = detect(&d, 0);
        assert_eq!(f.len(), 1);
        assert_eq!(f[0].target.page, 2);
        assert_eq!(f[0].preview, "Second endnote");
        let b = detect(&d, 2);
        assert_eq!(b.len(), 1);
        assert_eq!(b[0].kind, Kind::NoteBack);
        assert_eq!(b[0].marker, "2");
        assert_eq!(b[0].target.page, 0);
    }

    #[test]
    fn ambiguity_gives_no_link() {
        // Two identical notes.
        let d = doc(vec![page(
            0,
            vec![
                body_with_marker(100.0, "A", "1"),
                note_line(700.0, "1", "One"),
                note_line(720.0, "1", "Other one"),
            ],
        )]);
        assert!(detect(&d, 0).iter().all(|l| l.kind != Kind::Footnote));
        // Two identical markers on the page: no footnote, no note back.
        let d = doc(vec![page(
            0,
            vec![
                body_with_marker(100.0, "A", "1"),
                body_with_marker(120.0, "B", "1"),
                note_line(700.0, "1", "One"),
            ],
        )]);
        assert!(detect(&d, 0).is_empty());
    }

    #[test]
    fn exponents_years_page_numbers_list_numbers_excluded() {
        let exp = line(vec![
            run("x2", 50.0, 100.0, BODY, 110.0),
            run("2", 62.0, 100.0, 7.0, 104.0),
            run(" + 1", 70.0, 100.0, BODY, 110.0),
        ]);
        let caret = line(vec![
            run("a^", 50.0, 120.0, BODY, 130.0),
            run("2", 62.0, 120.0, 7.0, 124.0),
        ]);
        let year = line(vec![
            run("In 1999", 50.0, 140.0, BODY, 150.0),
            run("1", 100.0, 140.0, 7.0, 144.0),
        ]);
        let list = line(vec![
            run("1", 50.0, 160.0, 7.0, 164.0),
            run(" item", 60.0, 160.0, BODY, 170.0),
        ]);
        let pageno = line(vec![run("12", 300.0, 780.0, BODY, 790.0)]);
        let d = doc(vec![page(
            0,
            vec![
                exp,
                caret,
                year,
                list,
                pageno,
                note_line(700.0, "1", "A"),
                note_line(715.0, "2", "B"),
            ],
        )]);
        assert!(
            detect(&d, 0).iter().all(|l| l.kind != Kind::Footnote),
            "{:?}",
            detect(&d, 0)
        );
    }

    #[test]
    fn preview_is_cut_at_word_boundary() {
        let long = "word ".repeat(100);
        let p = preview(&long);
        assert!(p.chars().count() <= 280 && p.ends_with("word…"));
        assert_eq!(preview("short  text"), "short text");
        let no_space = "x".repeat(400);
        assert_eq!(preview(&no_space).chars().count(), 280);
    }

    #[test]
    fn unknown_page_or_no_body_is_empty() {
        let d = doc(vec![page(0, vec![])]);
        assert!(detect(&d, 5).is_empty());
        assert!(detect(&d, 0).is_empty());
        let mut d2 = d.clone();
        d2.pages[0].body_size = 0.0;
        assert!(detect(&d2, 0).is_empty());
    }

    #[test]
    fn marker_parsing() {
        assert_eq!(parse_marker("12").as_deref(), Some("12"));
        assert_eq!(parse_marker("¹²").as_deref(), Some("12"));
        assert_eq!(parse_marker("0"), None);
        assert_eq!(parse_marker("1000"), None);
        assert_eq!(parse_marker("‡").as_deref(), Some("‡"));
        assert_eq!(parse_marker("a"), None);
    }
}
