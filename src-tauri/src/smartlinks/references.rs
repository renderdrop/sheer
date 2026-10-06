//! `references` detector (ADR-132, DESIGN §3.11 L1): "siehe S. 12", "pp. 12–14" → page; "Abb. 3", "Tab. 2", "Kapitel 4.2", "§ 5" → the caption
//! or heading line that starts with the same label. Pure over [`DocText`]; hand matchers, no regex.

use std::collections::HashMap;

use super::model::{DocText, Kind, Line, PageText, PtRect, SmartLink, Target};

const PREVIEW_MAX: usize = 280;
const MIN_SCORE: f32 = 0.75;

/// Caption/heading text cut to 280 characters at a word boundary plus an ellipsis.
pub(crate) fn truncate_preview(s: &str) -> String {
    let t = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if t.chars().count() <= PREVIEW_MAX {
        return t;
    }
    let cut: String = t.chars().take(PREVIEW_MAX - 1).collect();
    let next_is_space = t
        .chars()
        .nth(PREVIEW_MAX - 1)
        .is_some_and(char::is_whitespace);
    let base = if next_is_space {
        cut.as_str()
    } else {
        match cut.rfind(char::is_whitespace) {
            Some(p) => &cut[..p],
            None => cut.as_str(),
        }
    };
    format!("{}…", base.trim_end())
}

/// Exactly one candidate ≥ 0.75 and the runner-up ≤ score − 0.25 (ADR-132 §3).
pub(crate) fn pick(scores: &[f32]) -> Option<usize> {
    let mut best: Option<usize> = None;
    for (i, &s) in scores.iter().enumerate() {
        if best.is_none_or(|b| s > scores[b]) {
            best = Some(i);
        }
    }
    let b = best?;
    let s = scores[b];
    if s < MIN_SCORE {
        return None;
    }
    let second = scores
        .iter()
        .enumerate()
        .filter(|(i, _)| *i != b)
        .map(|(_, &x)| x)
        .fold(f32::MIN, f32::max);
    if second > s - 0.25 + 1e-4 {
        None
    } else {
        Some(b)
    }
}

pub(crate) fn union(a: PtRect, b: PtRect) -> PtRect {
    let x0 = a.x.min(b.x);
    let y0 = a.y.min(b.y);
    let x1 = (a.x + a.w).max(b.x + b.w);
    let y1 = (a.y + a.h).max(b.y + b.h);
    PtRect {
        x: x0,
        y: y0,
        w: x1 - x0,
        h: y1 - y0,
    }
}

/// A line as characters with the run boundaries, so a character range maps back to a box.
pub(crate) struct LineText<'a> {
    pub line: &'a Line,
    pub chars: Vec<char>,
    bounds: Vec<(usize, usize)>,
}

impl<'a> LineText<'a> {
    pub fn new(line: &'a Line) -> Self {
        let mut chars = Vec::new();
        let mut bounds = Vec::with_capacity(line.runs.len());
        for r in &line.runs {
            let s = chars.len();
            chars.extend(r.text.chars());
            bounds.push((s, chars.len()));
        }
        LineText {
            line,
            chars,
            bounds,
        }
    }

    /// Box of the character range `[a, b)`, proportional inside each run.
    pub fn rect(&self, a: usize, b: usize) -> PtRect {
        let mut out: Option<PtRect> = None;
        for (run, &(rs, re)) in self.line.runs.iter().zip(&self.bounds) {
            let (lo, hi) = (a.max(rs), b.min(re));
            if lo >= hi || re == rs {
                continue;
            }
            let len = (re - rs) as f32;
            let r = PtRect {
                x: run.rect.x + run.rect.w * (lo - rs) as f32 / len,
                y: run.rect.y,
                w: run.rect.w * (hi - lo) as f32 / len,
                h: run.rect.h,
            };
            out = Some(out.map_or(r, |o| union(o, r)));
        }
        out.unwrap_or(self.line.rect)
    }

    pub fn string(&self, a: usize, b: usize) -> String {
        self.chars[a.min(self.chars.len())..b.min(self.chars.len())]
            .iter()
            .collect()
    }

    pub fn text(&self) -> String {
        self.string(0, self.chars.len()).trim().to_string()
    }
}

pub(crate) fn skip_ws(c: &[char], mut i: usize) -> usize {
    while i < c.len() && c[i].is_whitespace() {
        i += 1;
    }
    i
}

pub(crate) fn starts_with_ci(c: &[char], i: usize, kw: &str) -> bool {
    let mut j = i;
    for k in kw.chars() {
        match c.get(j) {
            Some(&x) if x.to_lowercase().eq(k.to_lowercase()) => j += 1,
            _ => return false,
        }
    }
    true
}

fn word_boundary(c: &[char], i: usize) -> bool {
    i == 0 || !c[i - 1].is_alphanumeric()
}

/// Digits with optional `.digits` groups (4.2.1); a trailing dot is not part of it.
fn scan_number(c: &[char], i: usize) -> Option<(String, usize)> {
    let mut j = i;
    let mut out = String::new();
    for seg in 0..4 {
        let s = j;
        while j < c.len() && c[j].is_ascii_digit() {
            j += 1;
        }
        if j == s || j - s > 4 {
            return None;
        }
        out.extend(&c[s..j]);
        if seg < 3 && j + 1 < c.len() && c[j] == '.' && c[j + 1].is_ascii_digit() {
            out.push('.');
            j += 1;
        } else {
            return Some((out, j));
        }
    }
    Some((out, j))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum Fam {
    Fig,
    Tab,
    Sec,
    Para,
}

const LABELS: &[(&str, Fam)] = &[
    ("abbildung", Fam::Fig),
    ("abb.", Fam::Fig),
    ("figure", Fam::Fig),
    ("fig.", Fam::Fig),
    ("tabelle", Fam::Tab),
    ("tab.", Fam::Tab),
    ("table", Fam::Tab),
    ("kapitel", Fam::Sec),
    ("chapter", Fam::Sec),
    ("abschnitt", Fam::Sec),
    ("section", Fam::Sec),
    ("§", Fam::Para),
];

struct Label {
    fam: Fam,
    num: String,
    end: usize,
}

fn label_at(c: &[char], i: usize) -> Option<Label> {
    if !word_boundary(c, i) || (i > 0 && c[i - 1] == '§') {
        return None;
    }
    for &(kw, fam) in LABELS {
        if !starts_with_ci(c, i, kw) {
            continue;
        }
        let mut j = i + kw.chars().count();
        let k = skip_ws(c, j);
        let loose = kw.ends_with('.') || kw == "§";
        if k == j && !loose {
            continue;
        }
        j = k;
        let Some((num, end)) = scan_number(c, j) else {
            continue;
        };
        if c.get(end).is_some_and(|x| x.is_alphanumeric()) {
            continue;
        }
        return Some(Label { fam, num, end });
    }
    None
}

fn heading_style(p: &PageText, line: &Line) -> bool {
    if line.runs.is_empty() {
        return false;
    }
    let max = line.runs.iter().map(|r| r.size).fold(0.0_f32, f32::max);
    (p.body_size > 0.0 && max > p.body_size * 1.08) || line.runs.iter().all(|r| r.bold)
}

/// A contents / list-of-figures line: dot leaders and a page number at the end.
fn looks_like_toc(text: &str) -> bool {
    let t = text.trim_end();
    let digits = t.chars().rev().take_while(char::is_ascii_digit).count();
    if digits == 0 || digits > 4 {
        return false;
    }
    let head: Vec<char> = t.chars().take(t.chars().count() - digits).collect();
    let mut run = 0;
    for &ch in head.iter().rev().skip_while(|x| x.is_whitespace()) {
        if matches!(ch, '.' | '…' | '·') {
            run += 1;
        } else {
            break;
        }
    }
    run >= 3 || (head.last().is_some_and(|x| *x == '…'))
}

struct Cand {
    page: u32,
    rect: PtRect,
    text: String,
    score: f32,
    id: (usize, usize),
}

type Index = HashMap<(Fam, String), Vec<Cand>>;

fn build_index(doc: &DocText) -> Index {
    let mut idx: Index = HashMap::new();
    for (pi, p) in doc.pages.iter().enumerate() {
        for (li, line) in p.lines.iter().enumerate() {
            let lt = LineText::new(line);
            let text = lt.text();
            if text.is_empty() || looks_like_toc(&text) {
                continue;
            }
            let start = skip_ws(&lt.chars, 0);
            let heading = heading_style(p, line);
            let mut push = |fam: Fam, num: String, score: f32, rect: PtRect, text: String| {
                idx.entry((fam, num)).or_default().push(Cand {
                    page: p.page,
                    rect,
                    text,
                    score,
                    id: (pi, li),
                });
            };
            if let Some(l) = label_at(&lt.chars, start) {
                match l.fam {
                    Fam::Fig | Fam::Tab => {
                        let r = skip_ws(&lt.chars, l.end);
                        let delim = r >= lt.chars.len()
                            || matches!(lt.chars[r], ':' | '.' | '–' | '—' | '-');
                        let bold = line.runs.first().is_some_and(|x| x.bold);
                        if delim || bold {
                            let (rect, full) = caption_extent(p, li, &lt);
                            push(l.fam, l.num, if delim { 0.9 } else { 0.8 }, rect, full);
                        }
                    }
                    Fam::Sec | Fam::Para => {
                        if heading {
                            push(l.fam, l.num, 0.9, line.rect, text);
                        }
                    }
                }
            } else if heading {
                if let Some((num, end)) = scan_number(&lt.chars, start) {
                    let mut j = end;
                    if lt.chars.get(j) == Some(&'.') {
                        j += 1;
                    }
                    let k = skip_ws(&lt.chars, j);
                    if k > j && lt.chars.get(k).is_some_and(|x| x.is_alphabetic()) {
                        push(Fam::Sec, num, 0.85, line.rect, text);
                    }
                }
            }
        }
    }
    idx
}

/// A caption may wrap: take up to two tightly following lines that do not start a label themselves.
fn caption_extent(p: &PageText, li: usize, lt: &LineText) -> (PtRect, String) {
    let mut rect = lt.line.rect;
    let mut text = lt.text();
    let mut cur = lt.line;
    for next in p.lines.iter().skip(li + 1).take(2) {
        let nt = LineText::new(next);
        let gap = next.rect.y - (cur.rect.y + cur.rect.h);
        let starts_label = label_at(&nt.chars, skip_ws(&nt.chars, 0)).is_some();
        if gap >= 0.6 * cur.rect.h
            || starts_label
            || next.rect.x < cur.rect.x - 1.0
            || nt.text().is_empty()
        {
            break;
        }
        rect = union(rect, next.rect);
        text.push(' ');
        text.push_str(&nt.text());
        cur = next;
    }
    (rect, text)
}

/// "§ 5 BGB": after the number (and Abs./Satz/… details) a capitalised law abbreviation follows.
fn law_follows(c: &[char], from: usize) -> bool {
    const SKIP: &[&str] = &[
        "abs.", "abs", "satz", "s.", "nr.", "nr", "buchst.", "lit.", "alt.", "und", "bis", "f.",
        "ff.", "des", "der", "i.v.m.", "§", "§§", ",",
    ];
    let rest: String = c[from.min(c.len())..].iter().collect();
    for tok in rest.split_whitespace().take(10) {
        let lower = tok.to_lowercase();
        let bare = lower.trim_end_matches(',');
        if SKIP.contains(&bare) || bare.chars().next().is_some_and(|x| x.is_ascii_digit()) {
            continue;
        }
        let word = tok.trim_matches(|x: char| !x.is_alphanumeric());
        let upper = word.chars().filter(|x| x.is_uppercase()).count();
        return word.chars().next().is_some_and(char::is_uppercase)
            && upper >= 2
            && word.chars().count() <= 10
            && word.chars().all(char::is_alphabetic);
    }
    false
}

struct PageRef {
    first: String,
    end: usize,
    strong: bool,
}

const PAGE_KWS: &[&str] = &["pp.", "p.", "s.", "seite", "page"];

fn page_ref_at(c: &[char], i: usize) -> Option<PageRef> {
    if !word_boundary(c, i) {
        return None;
    }
    let before: String = c[..i].iter().collect::<String>().to_lowercase();
    let before = before.trim_end();
    let strong = ["siehe", "vgl.", "vgl", "see", "cf.", "cf"]
        .iter()
        .any(|w| {
            before.ends_with(w)
                && before
                    .chars()
                    .rev()
                    .nth(w.chars().count())
                    .is_none_or(|x| !x.is_alphanumeric())
        });
    for &kw in PAGE_KWS {
        if !starts_with_ci(c, i, kw) {
            continue;
        }
        let word_kw = !kw.ends_with('.');
        if word_kw && !(strong || ["auf", "on", "to"].iter().any(|w| before.ends_with(w))) {
            continue;
        }
        let j = i + kw.chars().count();
        let k = skip_ws(c, j);
        if word_kw && k == j {
            continue;
        }
        let Some((num, mut end)) = scan_number(c, k) else {
            continue;
        };
        if num.contains('.') {
            continue;
        }
        if c.get(end).is_some_and(|x| x.is_alphanumeric()) {
            continue;
        }
        if matches!(c.get(end), Some('–' | '-' | '—'))
            && c.get(end + 1).is_some_and(char::is_ascii_digit)
        {
            if let Some((_, e2)) = scan_number(c, end + 1) {
                end = e2;
            }
        }
        let m = skip_ws(c, end);
        for f in ["ff.", "f."] {
            if starts_with_ci(c, m, f) && !c.get(m + f.len()).is_some_and(|x| x.is_alphanumeric()) {
                end = m + f.len();
                break;
            }
        }
        // "Seite 3 von 10" is a page footer, not a reference.
        let after: String = c[skip_ws(c, end).min(c.len())..]
            .iter()
            .take(4)
            .collect::<String>()
            .to_lowercase();
        if after.starts_with("von ") || after.starts_with("of ") {
            continue;
        }
        return Some(PageRef {
            first: num,
            end,
            strong,
        });
    }
    None
}

/// "(Müller 2019, S. 4)": the page belongs to the cited work, not to this document.
fn after_citation_year(c: &[char], i: usize) -> bool {
    let mut j = i;
    while j > 0 && c[j - 1].is_whitespace() {
        j -= 1;
    }
    if j == 0 || c[j - 1] != ',' {
        return false;
    }
    j -= 1;
    if j > 0 && c[j - 1].is_ascii_lowercase() {
        j -= 1;
    }
    j >= 4 && c[j - 4..j].iter().all(char::is_ascii_digit)
}

pub fn detect(doc: &DocText, page: u32, map: &dyn Fn(&str) -> Option<u32>) -> Vec<SmartLink> {
    let Some(pi) = doc.pages.iter().position(|p| p.page == page) else {
        return Vec::new();
    };
    let pt = &doc.pages[pi];
    let mut index: Option<Index> = None;
    let mut out = Vec::new();
    for (li, line) in pt.lines.iter().enumerate() {
        let lt = LineText::new(line);
        let c = &lt.chars;
        let whole = lt.text();
        let edge = pt.height > 0.0
            && (line.rect.y < pt.height * 0.05 || line.rect.y + line.rect.h > pt.height * 0.95);
        let mut i = 0;
        while i < c.len() {
            if let Some(l) = label_at(c, i) {
                let idx = index.get_or_insert_with(|| build_index(doc));
                let mut skip = l.fam == Fam::Para && law_follows(c, l.end);
                let key = (l.fam, l.num.clone());
                let cands = idx.get(&key).map(Vec::as_slice).unwrap_or(&[]);
                let scores: Vec<f32> = cands.iter().map(|x| x.score).collect();
                if !skip {
                    if let Some(b) = pick(&scores) {
                        let t = &cands[b];
                        skip = t.id == (pi, li);
                        if !skip {
                            out.push(SmartLink {
                                kind: Kind::Reference,
                                page,
                                rects: vec![lt.rect(i, l.end)],
                                marker: lt.string(i, l.end),
                                target: Target {
                                    page: t.page,
                                    rect: Some(t.rect),
                                },
                                preview: truncate_preview(&t.text),
                                score: t.score,
                            });
                        }
                    }
                }
                i = l.end;
                continue;
            }
            if let Some(r) = page_ref_at(c, i) {
                let marker = lt.string(i, r.end);
                let own_footer = edge || whole == marker.trim();
                if !own_footer && !after_citation_year(c, i) {
                    let mapped = map(&r.first).filter(|&p| p < doc.page_count);
                    if let Some(phys) = mapped {
                        out.push(SmartLink {
                            kind: Kind::Reference,
                            page,
                            rects: vec![lt.rect(i, r.end)],
                            marker,
                            target: Target {
                                page: phys,
                                rect: None,
                            },
                            preview: String::new(),
                            score: if r.strong { 0.9 } else { 0.8 },
                        });
                    }
                }
                i = r.end;
                continue;
            }
            i += 1;
        }
    }
    out
}

#[cfg(test)]
pub(crate) mod testutil {
    use crate::smartlinks::model::{Line, PageText, PtRect, Run};

    pub fn ln(text: &str, x: f32, y: f32, size: f32, bold: bool) -> Line {
        let rect = PtRect {
            x,
            y,
            w: 5.0 * text.chars().count() as f32,
            h: size,
        };
        Line {
            runs: vec![Run {
                text: text.to_string(),
                rect,
                size,
                baseline: y + size,
                bold,
            }],
            rect,
        }
    }

    pub fn body(text: &str, y: f32) -> Line {
        ln(text, 72.0, y, 10.0, false)
    }

    pub fn pg(page: u32, lines: Vec<Line>) -> PageText {
        PageText {
            page,
            width: 600.0,
            height: 800.0,
            lines,
            body_size: 10.0,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::testutil::*;
    use super::*;

    fn doc(pages: Vec<PageText>, count: u32) -> DocText {
        DocText {
            pages,
            page_count: count,
            labels: Vec::new(),
        }
    }

    fn ident(s: &str) -> Option<u32> {
        s.parse::<u32>().ok().map(|n| n - 1)
    }

    #[test]
    fn page_refs_variants() {
        let d = doc(
            vec![pg(
                0,
                vec![
                    body("Das zeigt sich, siehe S. 12 deutlich.", 100.0),
                    body("Dazu vgl. S. 3 f. und weiter.", 120.0),
                    body("As discussed, see p. 5.", 140.0),
                    body("Compare pp. 7\u{2013}9 for more.", 160.0),
                ],
            )],
            20,
        );
        let l = detect(&d, 0, &ident);
        let t: Vec<u32> = l.iter().map(|x| x.target.page).collect();
        assert_eq!(t, vec![11, 2, 4, 6]);
        assert_eq!(l[1].marker, "S. 3 f.");
        assert_eq!(l[3].marker, "pp. 7\u{2013}9");
        assert!(l
            .iter()
            .all(|x| x.kind == Kind::Reference && x.preview.is_empty() && x.score >= 0.75));
    }

    #[test]
    fn page_ref_negatives() {
        let d = doc(
            vec![pg(
                0,
                vec![
                    body("siehe S. 99", 100.0),
                    body("(Müller 2019, S. 4)", 120.0),
                    body("S. 3", 140.0),
                    body("Seite 3 von 10", 160.0),
                    ln("siehe S. 2", 72.0, 790.0, 10.0, false),
                ],
            )],
            10,
        );
        assert!(detect(&d, 0, &ident).is_empty());
        // unmapped printed number: no link
        let d2 = doc(vec![pg(0, vec![body("siehe S. 2 hier", 100.0)])], 10);
        assert!(detect(&d2, 0, &|_| None).is_empty());
    }

    #[test]
    fn caption_and_heading_targets() {
        let d = doc(
            vec![
                pg(
                    0,
                    vec![
                        body(
                            "Wie Abb. 3 und Tabelle 2 zeigen, siehe Kapitel 4.2 und § 5.",
                            100.0,
                        ),
                        body("Abbildung 3: Ein Diagramm", 300.0),
                        body("Tab. 2: Werte", 320.0),
                    ],
                ),
                pg(
                    1,
                    vec![
                        ln("4.2 Methoden", 72.0, 100.0, 14.0, true),
                        ln("§ 5 Pflichten", 72.0, 200.0, 14.0, true),
                    ],
                ),
            ],
            2,
        );
        let l = detect(&d, 0, &ident);
        let m: Vec<&str> = l.iter().map(|x| x.marker.as_str()).collect();
        assert_eq!(m, vec!["Abb. 3", "Tabelle 2", "Kapitel 4.2", "§ 5"]);
        assert_eq!(l[0].target.page, 0);
        assert_eq!(l[0].preview, "Abbildung 3: Ein Diagramm");
        assert_eq!(l[2].target.page, 1);
        assert_eq!(l[2].preview, "4.2 Methoden");
        assert_eq!(l[3].preview, "§ 5 Pflichten");
        assert!(l[0].target.rect.is_some());
    }

    #[test]
    fn own_label_law_and_ambiguity_are_none() {
        let d = doc(
            vec![
                pg(
                    0,
                    vec![
                        body("Abbildung 3: Ein Diagramm (siehe auch Abb. 3)", 100.0),
                        body("Nach § 5 BGB und § 6 Abs. 2 StGB gilt das.", 120.0),
                        body("Siehe Abb. 7 und Abb. 8.", 140.0),
                    ],
                ),
                pg(
                    1,
                    vec![
                        body("Abb. 7: Eins", 100.0),
                        body("Abb. 7: Zwei", 300.0),
                        body("Abb. 8 zeigt etwas anderes", 400.0),
                    ],
                ),
            ],
            2,
        );
        // Abb. 7 has two captions; Abb. 8 has none (body text starting with the label is no caption)
        assert!(detect(&d, 0, &ident).is_empty());
    }

    #[test]
    fn list_of_figures_line_is_not_a_caption() {
        let d = doc(
            vec![
                pg(
                    0,
                    vec![
                        body("Abbildung 1: Titel ........ 5", 100.0),
                        body("siehe Abb. 1", 140.0),
                    ],
                ),
                pg(4, vec![body("Abbildung 1: Titel", 100.0)]),
            ],
            6,
        );
        let l = detect(&d, 0, &ident);
        assert!(!l.is_empty() && l.iter().all(|x| x.target.page == 4));
    }

    #[test]
    fn preview_truncates_at_word_boundary() {
        let long = format!("Abb. 1: {}", "wort ".repeat(100));
        let p = truncate_preview(&long);
        assert!(p.chars().count() <= 280 && p.ends_with("wort…"));
        assert_eq!(truncate_preview("kurz"), "kurz");
    }
}
