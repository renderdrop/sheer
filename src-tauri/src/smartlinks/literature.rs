//! `literature` detector (ADR-132, DESIGN §3.11 L1): "(Müller 2019)", "Müller et al. (2019)", "[12]", "[3, 7]" → the entry of the
//! bibliography section after a heading such as "Literatur" or "References". Pure over [`DocText`]; hand matchers, no regex.

use super::model::{Choice, DocText, Kind, Line, PageText, PtRect, SmartLink, Target};
use super::references::{pick, skip_ws, starts_with_ci, truncate_preview, union, LineText};

const HEADINGS: &[&str] = &[
    "literatur",
    "literaturverzeichnis",
    "quellen",
    "bibliography",
    "references",
];
const MAX_ENTRY_LINES: usize = 6;

#[derive(Debug, Clone, PartialEq)]
enum Key {
    Num(u32),
    Ay {
        surname: String,
        year: u32,
        suffix: Option<char>,
    },
}

#[derive(Debug, Clone)]
struct Entry {
    page: u32,
    rect: PtRect,
    text: String,
    text_lc: String,
    key: Key,
}

/// First 4-digit year 1500–2100 at `i` with an optional single lowercase suffix letter.
fn parse_year(c: &[char], i: usize) -> Option<(u32, Option<char>, usize)> {
    if i + 4 > c.len()
        || !c[i..i + 4].iter().all(char::is_ascii_digit)
        || (i > 0 && c[i - 1].is_ascii_digit())
    {
        return None;
    }
    if c.get(i + 4).is_some_and(char::is_ascii_digit) {
        return None;
    }
    let year: u32 = c[i..i + 4].iter().collect::<String>().parse().ok()?;
    if !(1500..=2100).contains(&year) {
        return None;
    }
    match c.get(i + 4) {
        Some(&s)
            if s.is_ascii_lowercase() && !c.get(i + 5).is_some_and(|x| x.is_alphanumeric()) =>
        {
            Some((year, Some(s), i + 5))
        }
        Some(x) if x.is_alphanumeric() => None,
        _ => Some((year, None, i + 4)),
    }
}

fn find_year(c: &[char]) -> Option<(u32, Option<char>)> {
    (0..c.len().min(250)).find_map(|i| parse_year(c, i).map(|(y, s, _)| (y, s)))
}

fn heading_key(text: &str) -> bool {
    let t = text.trim().trim_end_matches(':').trim();
    let t = t
        .trim_start_matches(|x: char| x.is_ascii_digit() || x == '.')
        .trim();
    HEADINGS.contains(&t.to_lowercase().as_str())
}

fn max_size(l: &Line) -> f32 {
    l.runs.iter().map(|r| r.size).fold(0.0_f32, f32::max)
}

/// `[12]` or `12.` at the start of an entry line.
fn numeric_start(c: &[char]) -> Option<u32> {
    let s = skip_ws(c, 0);
    let digits = |from: usize| {
        c[from.min(c.len())..]
            .iter()
            .take_while(|x| x.is_ascii_digit())
            .count()
    };
    if c.get(s) == Some(&'[') {
        let n = digits(s + 1);
        if (1..=3).contains(&n) && c.get(s + 1 + n) == Some(&']') {
            return c[s + 1..s + 1 + n].iter().collect::<String>().parse().ok();
        }
    } else {
        let n = digits(s);
        if (1..=3).contains(&n)
            && c.get(s + n) == Some(&'.')
            && c.get(s + n + 1).is_some_and(|x| x.is_whitespace())
        {
            return c[s..s + n].iter().collect::<String>().parse().ok();
        }
    }
    None
}

fn author_start(lines: &[Line], j: usize) -> Option<Key> {
    let lt = LineText::new(&lines[j]);
    let c = &lt.chars;
    let s = skip_ws(c, 0);
    if !c.get(s).is_some_and(|x| x.is_uppercase()) {
        return None;
    }
    let comma = c.iter().take(40).position(|&x| x == ',')?;
    let surname: String = c[s..comma].iter().collect();
    if surname.chars().count() < 2
        || !surname
            .chars()
            .all(|x| x.is_alphabetic() || matches!(x, '-' | '\'' | ' '))
    {
        return None;
    }
    let mut joined: Vec<char> = Vec::new();
    for l in lines.iter().skip(j).take(3) {
        joined.extend(LineText::new(l).chars);
        joined.push(' ');
    }
    let (year, suffix) = find_year(&joined)?;
    Some(Key::Ay {
        surname: surname.trim().to_lowercase(),
        year,
        suffix,
    })
}

/// Entries of the bibliography section and its start `(page, line index)`.
fn build_entries(doc: &DocText) -> (Vec<Entry>, Option<(u32, usize)>) {
    let mut pages: Vec<&PageText> = doc.pages.iter().collect();
    pages.sort_by_key(|p| p.page);
    let mut found: Option<(u32, usize)> = None;
    'outer: for styled in [true, false] {
        for p in &pages {
            for (li, l) in p.lines.iter().enumerate() {
                let t = LineText::new(l).text();
                let is_style = max_size(l) > p.body_size * 1.08 || l.runs.iter().all(|r| r.bold);
                if heading_key(&t) && (is_style || !styled) {
                    found = Some((p.page, li));
                    break 'outer;
                }
            }
        }
    }
    let Some((hp, hli)) = found else {
        return (Vec::new(), None);
    };
    let mut entries = Vec::new();
    let mut ended = false;
    for p in pages.iter().filter(|p| p.page >= hp) {
        if ended {
            break;
        }
        let first = if p.page == hp { hli + 1 } else { 0 };
        let mut lines: &[Line] = &p.lines[first.min(p.lines.len())..];
        if let Some(e) = lines
            .iter()
            .position(|l| p.body_size > 0.0 && max_size(l) > p.body_size * 1.1)
        {
            lines = &lines[..e];
            ended = true;
        }
        collect_page(p.page, lines, &mut entries);
    }
    (entries, found)
}

fn collect_page(page: u32, lines: &[Line], out: &mut Vec<Entry>) {
    let mut starts: Vec<(usize, Key)> = Vec::new();
    let mut ay: Vec<(usize, Key)> = Vec::new();
    for j in 0..lines.len() {
        let lt = LineText::new(&lines[j]);
        if let Some(n) = numeric_start(&lt.chars) {
            starts.push((j, Key::Num(n)));
        } else if let Some(k) = author_start(lines, j) {
            let ok_prev = j == 0 || {
                let prev = LineText::new(&lines[j - 1]).text();
                prev.ends_with(['.', ')', ']', '/'])
                    || prev.chars().last().is_some_and(|x| x.is_ascii_digit())
                    || lines[j].rect.x < lines[j - 1].rect.x - 0.5
            };
            if ok_prev {
                ay.push((j, k));
            }
        }
    }
    // Hanging indent: continuation lines sit further right than the entry starts.
    if let Some(min_x) = ay.iter().map(|(j, _)| lines[*j].rect.x).reduce(f32::min) {
        starts.extend(
            ay.into_iter()
                .filter(|(j, _)| lines[*j].rect.x <= min_x + 1.0),
        );
    }
    starts.sort_by_key(|(j, _)| *j);
    for (n, (j, key)) in starts.iter().enumerate() {
        let end = starts
            .get(n + 1)
            .map_or(lines.len(), |s| s.0)
            .min(j + MAX_ENTRY_LINES);
        let mut rect = lines[*j].rect;
        let mut parts = Vec::new();
        for l in &lines[*j..end] {
            rect = union(rect, l.rect);
            parts.push(LineText::new(l).text());
        }
        let text = parts.join(" ");
        out.push(Entry {
            page,
            rect,
            text_lc: text.to_lowercase(),
            text,
            key: key.clone(),
        });
    }
}

struct Cit {
    key: CKey,
    start: usize,
    end: usize,
}

enum CKey {
    Num(u32),
    /// An inclusive numeric range, `lo < hi`, at most [`MAX_RANGE`] numbers.
    Range(u32, u32),
    Ay {
        surname: String,
        second: Option<String>,
        year: u32,
        suffix: Option<char>,
    },
}

fn name_word(c: &[char], i: usize) -> Option<(String, usize)> {
    if !c.get(i).is_some_and(|x| x.is_uppercase()) {
        return None;
    }
    let mut j = i;
    while j < c.len() && (c[j].is_alphabetic() || matches!(c[j], '-' | '\'')) {
        j += 1;
    }
    (j - i >= 2).then(|| (c[i..j].iter().collect(), j))
}

/// After the year: end, or ", S. 4" / ", p. 4" (page of the cited work).
fn tail_ok(c: &[char], end: usize) -> bool {
    let r = skip_ws(c, end);
    if r >= c.len() {
        return true;
    }
    if c[r] != ',' {
        return false;
    }
    let k = skip_ws(c, r + 1);
    ["s.", "p.", "pp.", "seite", "page"]
        .iter()
        .any(|kw| starts_with_ci(c, k, kw))
}

fn and_word(c: &[char], i: usize) -> Option<usize> {
    if c.get(i) == Some(&'&') {
        return Some(i + 1);
    }
    for w in ["und", "and"] {
        if starts_with_ci(c, i, w) && c.get(i + w.len()).is_some_and(|x| x.is_whitespace()) {
            return Some(i + w.len());
        }
    }
    None
}

/// "Müller 2019", "Müller & Schmidt, 2019, S. 4", "Müller et al. 2019" (optionally after "vgl."/"see").
fn parse_segment(seg: &[char]) -> Option<(CKey, usize)> {
    let mut i = skip_ws(seg, 0);
    for p in ["vgl.", "siehe", "see", "cf."] {
        if starts_with_ci(seg, i, p) && seg.get(i + p.len()).is_some_and(|x| x.is_whitespace()) {
            i = skip_ws(seg, i + p.len());
            break;
        }
    }
    let (w1, j) = name_word(seg, i)?;
    i = j;
    let mut second = None;
    let k = skip_ws(seg, i);
    if starts_with_ci(seg, k, "et al") {
        i = k + 5;
        if seg.get(i) == Some(&'.') {
            i += 1;
        }
    } else if let Some(j2) = and_word(seg, k) {
        let (w2, j3) = name_word(seg, skip_ws(seg, j2))?;
        second = Some(w2.to_lowercase());
        i = j3;
    }
    i = skip_ws(seg, i);
    if seg.get(i) == Some(&',') {
        i += 1;
    }
    i = skip_ws(seg, i);
    let (year, suffix, end) = parse_year(seg, i)?;
    tail_ok(seg, end).then(|| {
        (
            CKey::Ay {
                surname: w1.to_lowercase(),
                second,
                year,
                suffix,
            },
            end,
        )
    })
}

/// Capitalised name(s) directly before "(": returns the key skeleton and the start index.
fn narrative_name(c: &[char], paren: usize) -> Option<(String, Option<String>, usize)> {
    let mut toks: Vec<(usize, usize)> = Vec::new();
    let mut j = paren;
    while toks.len() < 4 {
        while j > 0 && c[j - 1].is_whitespace() {
            j -= 1;
        }
        let e = j;
        while j > 0 && !c[j - 1].is_whitespace() {
            j -= 1;
        }
        if e == j {
            break;
        }
        toks.push((j, e));
    }
    let tok = |n: usize| -> Option<String> { toks.get(n).map(|&(s, e)| c[s..e].iter().collect()) };
    let word = |n: usize| -> Option<(String, usize)> {
        let &(s, e) = toks.get(n)?;
        let (w, end) = name_word(c, s)?;
        (end == e).then_some((w, s))
    };
    if tok(0).as_deref() == Some("al.") && tok(1).as_deref() == Some("et") {
        let (w, s) = word(2)?;
        return Some((w.to_lowercase(), None, s));
    }
    let (w2, s2) = word(0)?;
    if matches!(tok(1).as_deref(), Some("&" | "und" | "and")) {
        if let Some((w1, s1)) = word(2) {
            return Some((w1.to_lowercase(), Some(w2.to_lowercase()), s1));
        }
    }
    Some((w2.to_lowercase(), None, s2))
}

/// Most numbers one range run may span (DESIGN §3.11 L14, hostile input bound).
const MAX_RANGE: u32 = 50;

/// `c[from..to]` as a number of 1-3 digits.
fn small_number(c: &[char], from: usize, to: usize) -> Option<u32> {
    if from >= to || to - from > 3 || !c[from..to].iter().all(char::is_ascii_digit) {
        return None;
    }
    c[from..to].iter().collect::<String>().parse().ok()
}

/// The parts of a numeric bracket `c[from..to]` (between "[" and "]"): each comma/semicolon-separated part is its own run, a number or
/// a range "3–5" / "3-5" / "3—5". `None` if the bracket holds anything else. A range that is reversed, zero-based or wider than
/// [`MAX_RANGE`] numbers yields no run (the other parts stay).
fn bracket_parts(c: &[char], from: usize, to: usize) -> Option<Vec<Cit>> {
    let mut out = Vec::new();
    let mut seg = from;
    while seg <= to {
        let end = (seg..to).find(|&k| matches!(c[k], ',' | ';')).unwrap_or(to);
        let mut a = seg;
        let mut b = end;
        while a < b && c[a].is_whitespace() {
            a += 1;
        }
        while b > a && c[b - 1].is_whitespace() {
            b -= 1;
        }
        if a < b {
            let dash = (a..b).find(|&k| matches!(c[k], '–' | '-' | '—'));
            if let Some(d) = dash {
                let (mut l, mut r) = (d, d + 1);
                while l > a && c[l - 1].is_whitespace() {
                    l -= 1;
                }
                while r < b && c[r].is_whitespace() {
                    r += 1;
                }
                let lo = small_number(c, a, l)?;
                let hi = small_number(c, r, b)?;
                if lo >= 1 && hi >= lo && hi - lo < MAX_RANGE {
                    out.push(Cit {
                        key: if hi == lo {
                            CKey::Num(lo)
                        } else {
                            CKey::Range(lo, hi)
                        },
                        start: a,
                        end: b,
                    });
                }
            } else {
                let n = small_number(c, a, b)?;
                out.push(Cit {
                    key: CKey::Num(n),
                    start: a,
                    end: b,
                });
            }
        } else if end < to || seg < to {
            // an empty part ("[3,,5]", "[,]") is no citation list
            return None;
        }
        seg = end + 1;
    }
    Some(out)
}

/// Citations of a line. In a numeric bracket each comma-separated part is its own run: "[3, 7]" links 3 and 7, "[3–5]" is one range
/// run (a chooser over the resolved numbers), "[3, 5–7]" a plain "3" and a range "5–7".
fn scan_citations(c: &[char]) -> Vec<Cit> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < c.len() {
        match c[i] {
            '[' if i == 0 || !c[i - 1].is_alphanumeric() => {
                if let Some(close) = c.iter().skip(i).take(40).position(|&x| x == ']') {
                    let close = i + close;
                    if let Some(nums) = bracket_parts(c, i + 1, close) {
                        out.extend(nums);
                    }
                    i = close + 1;
                    continue;
                }
            }
            '(' => {
                if let Some(rel) = c
                    .iter()
                    .skip(i + 1)
                    .take(120)
                    .position(|&x| x == ')' || x == '(')
                {
                    let close = i + 1 + rel;
                    if c[close] == ')' {
                        paren(c, i, close, &mut out);
                        i = close + 1;
                        continue;
                    }
                }
            }
            _ => {}
        }
        i += 1;
    }
    out
}

fn paren(c: &[char], open: usize, close: usize, out: &mut Vec<Cit>) {
    let mut seg_start = open + 1;
    let mut first = true;
    while seg_start <= close {
        let seg_end = c[seg_start..close]
            .iter()
            .position(|&x| x == ';')
            .map_or(close, |p| seg_start + p);
        let seg = &c[seg_start..seg_end];
        let lead = skip_ws(seg, 0);
        let trimmed_end = seg
            .iter()
            .rposition(|x| !x.is_whitespace())
            .map_or(0, |p| p + 1);
        if lead < trimmed_end {
            if let Some((key, _)) = parse_segment(seg) {
                out.push(Cit {
                    key,
                    start: seg_start + lead,
                    end: seg_start + trimmed_end,
                });
            } else if first {
                // "Müller et al. (2019)": the name stands in front of the bracket.
                if let Some((year, suffix, end)) = parse_year(seg, lead) {
                    if tail_ok(seg, end) {
                        if let Some((surname, second, start)) = narrative_name(c, open) {
                            out.push(Cit {
                                key: CKey::Ay {
                                    surname,
                                    second,
                                    year,
                                    suffix,
                                },
                                start,
                                end: close + 1,
                            });
                        }
                    }
                }
            }
        }
        first = false;
        seg_start = seg_end + 1;
    }
}

fn surname_matches(entry: &str, cited: &str) -> bool {
    entry == cited || entry.ends_with(&format!(" {cited}"))
}

/// The bibliography of the whole document, built once per revision (ADR-132 §5).
#[derive(Debug, Clone, Default)]
pub struct LitIndex {
    entries: Vec<Entry>,
    section: Option<(u32, usize)>,
}

/// Finds the bibliography section of `doc` and its entries.
pub fn build_lit_index(doc: &DocText) -> LitIndex {
    let (entries, section) = build_entries(doc);
    LitIndex { entries, section }
}

pub fn detect(doc: &DocText, page: u32, index: &LitIndex) -> Vec<SmartLink> {
    let Some(pt) = doc.pages.iter().find(|p| p.page == page) else {
        return Vec::new();
    };
    let (entries, section) = (&index.entries, index.section);
    if entries.is_empty() {
        return Vec::new();
    }
    let mut out = Vec::new();
    for (li, line) in pt.lines.iter().enumerate() {
        if section.is_some_and(|(hp, hli)| page > hp || (page == hp && li >= hli)) {
            continue;
        }
        let lt = LineText::new(line);
        for cit in scan_citations(&lt.chars) {
            if let CKey::Range(lo, hi) = cit.key {
                out.extend(range_link(entries, &lt, &cit, page, lo, hi));
                continue;
            }
            let (cands, scores): (Vec<&Entry>, Vec<f32>) = entries
                .iter()
                .filter_map(|e| score(e, &cit.key).map(|s| (e, s)))
                .unzip();
            let Some(b) = pick(&scores) else { continue };
            let e = cands[b];
            out.push(SmartLink {
                kind: Kind::Literature,
                page,
                rects: vec![lt.rect(cit.start, cit.end)],
                marker: lt.string(cit.start, cit.end),
                target: Target {
                    page: e.page,
                    rect: Some(e.rect),
                    label: None,
                },
                choices: Vec::new(),
                preview: truncate_preview(&e.text),
                score: scores[b],
            });
        }
    }
    out
}

/// Longest entry preview of one range choice, in characters (DESIGN §3.11 L14).
const CHOICE_PREVIEW: usize = 120;

fn cut_words(text: &str, max: usize) -> String {
    let t = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if t.chars().count() <= max {
        return t;
    }
    let cut: String = t.chars().take(max - 1).collect();
    let at_space = t.chars().nth(max - 1).is_some_and(char::is_whitespace);
    let base = if at_space {
        cut.as_str()
    } else {
        cut.rfind(char::is_whitespace)
            .map_or(cut.as_str(), |p| &cut[..p])
    };
    format!("{}…", base.trim_end())
}

/// The link of a range run: every number of `lo..=hi` is resolved on its own (L2); ≥ 2 resolved → one run with `choices`, exactly 1 →
/// a plain link to it, none → no link.
fn range_link(
    entries: &[Entry],
    lt: &LineText,
    cit: &Cit,
    page: u32,
    lo: u32,
    hi: u32,
) -> Option<SmartLink> {
    let mut found: Vec<(u32, &Entry, f32)> = Vec::new();
    for n in lo..=hi {
        let (cands, scores): (Vec<&Entry>, Vec<f32>) = entries
            .iter()
            .filter_map(|e| score(e, &CKey::Num(n)).map(|s| (e, s)))
            .unzip();
        if let Some(b) = pick(&scores) {
            found.push((n, cands[b], scores[b]));
        }
    }
    let rects = vec![lt.rect(cit.start, cit.end)];
    let marker = lt.string(cit.start, cit.end);
    let target = |e: &Entry| Target {
        page: e.page,
        rect: Some(e.rect),
        label: None,
    };
    match found.as_slice() {
        [] => None,
        [(_, e, s)] => Some(SmartLink {
            kind: Kind::Literature,
            page,
            rects,
            marker,
            target: target(e),
            choices: Vec::new(),
            preview: truncate_preview(&e.text),
            score: *s,
        }),
        [(_, first, _), ..] => Some(SmartLink {
            kind: Kind::Literature,
            page,
            rects,
            marker,
            target: target(first),
            choices: found
                .iter()
                .map(|(n, e, _)| Choice {
                    number: *n,
                    preview: cut_words(&e.text, CHOICE_PREVIEW),
                    target: target(e),
                })
                .collect(),
            preview: String::new(),
            score: found.iter().map(|f| f.2).fold(1.0, f32::min),
        }),
    }
}

fn score(e: &Entry, k: &CKey) -> Option<f32> {
    match (&e.key, k) {
        (Key::Num(a), CKey::Num(b)) => (a == b).then_some(0.9),
        (
            Key::Ay {
                surname,
                year,
                suffix,
            },
            CKey::Ay {
                surname: cs,
                second,
                year: cy,
                suffix: csuf,
            },
        ) => {
            if year != cy || !surname_matches(surname, cs) {
                return None;
            }
            let mut s: f32 = 0.8;
            match (csuf, suffix) {
                (Some(a), Some(b)) if a == b => s += 0.1,
                (Some(_), _) => return None,
                _ => {}
            }
            if let Some(sec) = second {
                s += if e.text_lc.contains(sec.as_str()) {
                    0.1
                } else {
                    -0.3
                };
            }
            Some(s.min(1.0))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::smartlinks::references::testutil::*;

    fn doc(pages: Vec<PageText>) -> DocText {
        let n = pages.len() as u32;
        DocText {
            pages,
            page_count: n,
            labels: Vec::new(),
        }
    }

    fn detect(d: &DocText, page: u32) -> Vec<SmartLink> {
        super::detect(d, page, &build_lit_index(d))
    }

    #[test]
    fn hostile_input_does_not_panic_or_link() {
        use crate::smartlinks::model::Run;
        let nan = PtRect {
            x: f32::NAN,
            y: -3.0,
            w: -1.0,
            h: f32::NEG_INFINITY,
        };
        let mut bad = body(
            "Siehe [12345678901] und [1] (Müller 20199) (e\u{301} 2019)",
            100.0,
        );
        bad.rect = nan;
        bad.runs[0].rect = nan;
        let mut empty = body("", 120.0);
        empty.runs = vec![Run {
            text: String::new(),
            rect: nan,
            size: f32::NAN,
            baseline: f32::NAN,
            bold: true,
        }];
        let mut none = body("x", 140.0);
        none.runs.clear();
        let d = doc(vec![
            pg(
                0,
                vec![
                    bad,
                    empty,
                    none,
                    body("(ÄÖÜ\u{308}, 2019) [1\u{301}] ((((((", 160.0),
                ],
            ),
            pg(
                1,
                vec![
                    head("Literatur", 80.0),
                    body("[1] Ä\u{301}. Eins.", 120.0),
                    body("Ö\u{308}, A. (2019). Zwei. 12345678901234567890", 140.0),
                ],
            ),
        ]);
        let l = detect(&d, 0);
        // The ten-digit number and the five-digit year are no citations; "[1]" is one.
        assert!(l
            .iter()
            .all(|x| x.marker != "12345678901" && !x.marker.contains("20199")));
        assert!(detect(&d, 9).is_empty());
    }

    fn head(text: &str, y: f32) -> Line {
        ln(text, 72.0, y, 16.0, true)
    }

    fn bib_ay() -> PageText {
        pg(
            2,
            vec![
                head("Literaturverzeichnis", 80.0),
                body(
                    "Müller, A. & Schmidt, B. (2019). Ein Titel, der lang ist. Journal 4, 1-10.",
                    120.0,
                ),
                body("Meier, C. (2018a). Erster Titel. Berlin: Verlag.", 140.0),
                body("Meier, C. (2018b). Zweiter Titel. Berlin: Verlag.", 160.0),
                body("Weber, D. (2020). Noch einer. Hamburg: Verlag.", 180.0),
            ],
        )
    }

    #[test]
    fn author_year_families() {
        let d = doc(vec![
            pg(
                0,
                vec![
                    body(
                        "Das ist belegt (Müller & Schmidt 2019) und auch (Weber, 2020, S. 4).",
                        100.0,
                    ),
                    body("Weber et al. (2020) zeigen es; vgl. (Meier 2018a).", 120.0),
                ],
            ),
            pg(1, vec![body("Nichts.", 100.0)]),
            bib_ay(),
        ]);
        let l = detect(&d, 0);
        let m: Vec<&str> = l.iter().map(|x| x.marker.as_str()).collect();
        assert_eq!(
            m,
            vec![
                "Müller & Schmidt 2019",
                "Weber, 2020, S. 4",
                "Weber et al. (2020)",
                "Meier 2018a"
            ]
        );
        assert!(l
            .iter()
            .all(|x| x.kind == Kind::Literature && x.target.page == 2 && x.score >= 0.75));
        assert!(l[0].preview.starts_with("Müller, A. & Schmidt, B. (2019)"));
        assert!(l[3].preview.contains("Erster Titel"));
    }

    #[test]
    fn ambiguity_is_none() {
        let d = doc(vec![
            pg(
                0,
                vec![body("Siehe (Meier 2018) und (Müller 2019).", 100.0)],
            ),
            pg(
                1,
                vec![
                    head("References", 80.0),
                    body("Meier, C. (2018a). Erster. Berlin.", 120.0),
                    body("Meier, C. (2018b). Zweiter. Berlin.", 140.0),
                    body("Müller, A. (2019). Eins. Berlin.", 160.0),
                    body("Müller, B. (2019). Zwei. Berlin.", 180.0),
                ],
            ),
        ]);
        assert!(detect(&d, 0).is_empty());
    }

    #[test]
    fn second_author_disambiguates() {
        let d = doc(vec![
            pg(0, vec![body("Siehe (Müller & Schmidt 2019).", 100.0)]),
            pg(
                1,
                vec![
                    head("Bibliography", 80.0),
                    body("Müller, B. (2019). Zwei. Berlin.", 120.0),
                    body("Müller, A. & Schmidt, C. (2019). Eins. Berlin.", 140.0),
                ],
            ),
        ]);
        let l = detect(&d, 0);
        assert_eq!(l.len(), 1);
        assert!(l[0].preview.contains("Eins"));
    }

    #[test]
    fn numeric_each_number_own_link() {
        let d = doc(vec![
            pg(0, vec![body("Siehe [12], dann [3, 7] und [3–5].", 100.0)]),
            pg(
                1,
                vec![
                    head("Quellen", 80.0),
                    body("[3] Autor A. Titel drei.", 120.0),
                    body("[5] Autor B. Titel fünf.", 140.0),
                    body("[7] Autor C. Titel sieben.", 160.0),
                    body("[12] Autor D. Titel zwölf,", 180.0),
                    body("    zweite Zeile.", 190.0),
                ],
            ),
        ]);
        let l = detect(&d, 0);
        let m: Vec<&str> = l.iter().map(|x| x.marker.as_str()).collect();
        // "[3–5]" is one range run; 4 has no entry, so it lists 3 and 5.
        assert_eq!(m, vec!["12", "3", "7", "3–5"]);
        assert!(l[0].preview.contains("zwölf") && l[0].preview.contains("zweite Zeile"));
        assert!(l[1].preview.contains("drei"));
        let nums: Vec<u32> = l[3].choices.iter().map(|c| c.number).collect();
        assert_eq!(nums, vec![3, 5]);
        assert!(l[3].choices[1].preview.contains("fünf") && l[3].choices[1].target.page == 1);
        assert!(l[0].choices.is_empty() && l[3].preview.is_empty());
    }

    fn range_doc(text: &str, entries: &[u32]) -> DocText {
        let mut lines = vec![head("Literatur", 80.0)];
        for (i, n) in entries.iter().enumerate() {
            let long = "Wort ".repeat(40);
            lines.push(body(
                &format!("[{n}] Autor {n}. {long}"),
                100.0 + 20.0 * i as f32,
            ));
        }
        doc(vec![pg(0, vec![body(text, 100.0)]), pg(1, lines)])
    }

    #[test]
    fn range_runs_with_choices() {
        let d = range_doc("A [3-5] B [3, 5–7] C [8–9]", &[3, 4, 5, 7]);
        let l = detect(&d, 0);
        let m: Vec<&str> = l.iter().map(|x| x.marker.as_str()).collect();
        // [3-5]: 3, 4, 5 → chooser; "3": plain; "5–7": 5, 7 (6 absent) → chooser; "8–9": nothing.
        assert_eq!(m, vec!["3-5", "3", "5–7"]);
        let nums = |i: usize| -> Vec<u32> { l[i].choices.iter().map(|c| c.number).collect() };
        assert_eq!(nums(0), vec![3, 4, 5]);
        assert!(l[1].choices.is_empty() && !l[1].preview.is_empty());
        assert_eq!(nums(2), vec![5, 7]);
        assert!(l[0]
            .choices
            .iter()
            .all(|c| c.preview.chars().count() <= 120));
        assert!(l[0].choices[0].preview.ends_with('…'));
        assert_eq!(l[0].rects.len(), 1);
    }

    #[test]
    fn range_with_one_resolved_number_is_a_plain_link() {
        let d = range_doc("Siehe [4–6].", &[4]);
        let l = detect(&d, 0);
        assert_eq!(l.len(), 1);
        assert!(l[0].choices.is_empty() && l[0].preview.starts_with("[4] Autor 4"));
    }

    #[test]
    fn hostile_ranges_make_no_link() {
        let nums: Vec<u32> = (1..=120).collect();
        let d = range_doc(
            "[5–3] [0–2] [1–51] [1-1000] [3--5] [3–] [–5] [3,,5] [1–2–3]",
            &nums,
        );
        assert!(detect(&d, 0).is_empty());
        // exactly 50 numbers is the limit
        let ok = range_doc("[1–50] [1–51]", &nums);
        let l = detect(&ok, 0);
        assert_eq!(l.len(), 1);
        assert_eq!(l[0].choices.len(), 50);
        // equal bounds are one number
        let eq = range_doc("[2–2]", &nums);
        let l = detect(&eq, 0);
        assert!(l.len() == 1 && l[0].choices.is_empty());
    }

    #[test]
    fn numbered_dot_entries_and_missing_entry() {
        let d = doc(vec![
            pg(0, vec![body("Siehe [1] und [9].", 100.0)]),
            pg(
                1,
                vec![
                    head("Literatur", 80.0),
                    body("1. Erster Eintrag.", 120.0),
                    body("2. Zweiter Eintrag.", 140.0),
                ],
            ),
        ]);
        let l = detect(&d, 0);
        assert_eq!(l.len(), 1);
        assert_eq!(l[0].marker, "1");
    }

    #[test]
    fn no_bibliography_no_links() {
        let d = doc(vec![pg(
            0,
            vec![body("Siehe [1] und (Müller 2019).", 100.0)],
        )]);
        assert!(detect(&d, 0).is_empty());
    }

    #[test]
    fn duplicate_numbers_are_none_and_bib_lines_are_skipped() {
        let d = doc(vec![pg(
            0,
            vec![
                body("Siehe [1].", 100.0),
                head("References", 200.0),
                body("[1] A. Eins.", 240.0),
                body("[1] B. Zwei.", 260.0),
            ],
        )]);
        assert!(detect(&d, 0).is_empty());
        // the bibliography's own labels are no citations
        let d2 = doc(vec![pg(
            0,
            vec![head("References", 200.0), body("[1] A. Eins.", 240.0)],
        )]);
        assert!(detect(&d2, 0).is_empty());
    }
}
