//! The merged outline of a document (F19.20, DESIGN §3.11): the entries of its table of contents (the confirmed contents links) and the
//! headings found in the text (font size, weight, numbering), in document order, one entry per page and normalised title. Pure over
//! [`DocText`] and [`Analysis`]; the command layer puts the bookmarks of the file first and maps positions to page ids.

use std::collections::{HashMap, HashSet};

use super::index::Analysis;
use super::model::{DocText, Kind, Line, PageText};
use crate::limits;

/// Most entries made, deepest level and longest title (characters).
const MAX_ENTRIES: usize = 2_000;
pub const MAX_LEVEL: u8 = 4;
const MAX_TITLE: usize = 200;
/// A heading is at least this much larger than the body text, or bold at about the body size.
const BIG: f32 = 1.2;
const BOLD_MIN: f32 = 0.95;
/// A running header or footer: the same text on this many pages.
const REPEATS: usize = 3;
/// Longest heading line (characters) and most words of a bold-only heading.
const MAX_LINE: usize = 140;
const MAX_BOLD_LINE: usize = 90;
const MAX_BOLD_WORDS: usize = 12;

/// One entry: the position of its page, how far down it the heading is (points from the top), its title and its level (1 = top).
#[derive(Debug, Clone, PartialEq)]
pub struct Entry {
    pub page: u32,
    pub y: f32,
    pub title: String,
    pub level: u8,
}

/// The title in the form entries are compared in: lower case letters and digits, without a leading section number.
pub fn normalize(title: &str) -> String {
    let t = title.trim().trim_start_matches('§').trim_start();
    let t = strip_numbering(t);
    t.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

/// The depth of a leading section number ("1" = 1, "2.3" = 2, "4.1.2." = 3), or `None`.
pub fn numbering_depth(text: &str) -> Option<u8> {
    let t = text.trim_start();
    let end = t
        .find(|c: char| !(c.is_ascii_digit() || c == '.'))
        .unwrap_or(t.len());
    let head = t[..end].trim_end_matches('.');
    if head.is_empty() || !head.starts_with(|c: char| c.is_ascii_digit()) || head.len() > 12 {
        return None;
    }
    if t[end..].chars().next().is_some_and(|c| !c.is_whitespace()) {
        return None;
    }
    if !t[end..].trim_start().starts_with(char::is_alphabetic) {
        return None;
    }
    let parts: Vec<&str> = head.split('.').collect();
    if parts.iter().any(|p| p.is_empty() || p.len() > 3) {
        return None;
    }
    u8::try_from(parts.len()).ok().map(|d| d.min(MAX_LEVEL))
}

fn strip_numbering(t: &str) -> &str {
    if numbering_depth(t).is_some() {
        let end = t
            .find(|c: char| !(c.is_ascii_digit() || c == '.'))
            .unwrap_or(t.len());
        t[end..].trim_start()
    } else {
        t
    }
}

fn line_text(line: &Line) -> String {
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
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn cut(title: &str) -> String {
    title.chars().take(MAX_TITLE).collect()
}

/// The median of the body sizes of the pages that have one.
fn doc_body(doc: &DocText) -> f32 {
    let mut sizes: Vec<f32> = doc
        .pages
        .iter()
        .map(|p| p.body_size)
        .filter(|s| s.is_finite() && *s > 0.0)
        .collect();
    sizes.sort_by(f32::total_cmp);
    sizes.get(sizes.len() / 2).copied().unwrap_or(0.0)
}

#[derive(Debug, Clone)]
struct Cand {
    page: u32,
    li: usize,
    y: f32,
    size: f32,
    bold: bool,
    big: bool,
    text: String,
    depth: Option<u8>,
}

fn is_bold(line: &Line) -> bool {
    let mut any = false;
    for r in line.runs.iter().filter(|r| !r.text.trim().is_empty()) {
        if !r.bold {
            return false;
        }
        any = true;
    }
    any
}

fn line_size(line: &Line) -> f32 {
    // The size most of the line's characters have.
    let mut by: Vec<(f32, usize)> = Vec::new();
    for r in &line.runs {
        let n = r.text.chars().filter(|c| !c.is_whitespace()).count();
        if n == 0 || !r.size.is_finite() {
            continue;
        }
        match by.iter_mut().find(|(s, _)| (s - r.size).abs() < 0.3) {
            Some(e) => e.1 += n,
            None => by.push((r.size, n)),
        }
    }
    by.into_iter().max_by_key(|e| e.1).map_or(0.0, |e| e.0)
}

fn is_leader_line(text: &str) -> bool {
    text.contains("...") || text.contains("\u{2026}") || text.contains(" . . .")
}

fn candidates(page: &PageText, body: f32) -> Vec<Cand> {
    let bold_lines = page.lines.iter().filter(|l| is_bold(l)).count();
    // A page that is mostly bold has bold paragraphs, not bold headings.
    let bold_page = bold_lines * 2 > page.lines.len().max(1);
    let mut out = Vec::new();
    for (li, line) in page.lines.iter().enumerate() {
        let text = line_text(line);
        let len = text.chars().count();
        let letters = text.chars().filter(|c| c.is_alphabetic()).count();
        if !(2..=MAX_LINE).contains(&len)
            || letters < 2
            || letters * 2 < len
            || is_leader_line(&text)
        {
            continue;
        }
        let size = line_size(line);
        if size <= 0.0 || !line.rect.y.is_finite() {
            continue;
        }
        let depth = numbering_depth(&text);
        let big = size >= BIG * body;
        let bold = is_bold(line) && size >= BOLD_MIN * body && !bold_page;
        let ends_sentence = text.ends_with(['.', ',', ';', ':']);
        let words = text.split_whitespace().count();
        let heading = (big && (!ends_sentence || depth.is_some()))
            || (bold
                && len <= MAX_BOLD_LINE
                && words <= MAX_BOLD_WORDS
                && (depth.is_some() || !ends_sentence));
        if heading {
            out.push(Cand {
                page: page.page,
                li,
                y: line.rect.y,
                size,
                bold,
                big,
                text,
                depth,
            });
        }
    }
    out
}

/// The headings of the text in document order. Running headers and footers (the same text, digits aside, on three pages or more)
/// and lines of a contents block are not headings; consecutive lines of one heading are one entry.
pub fn headings(doc: &DocText) -> Vec<Entry> {
    let body = doc_body(doc);
    if body <= 0.0 {
        return Vec::new();
    }
    let mut all: Vec<Vec<Cand>> = Vec::new();
    let mut repeats: HashMap<String, HashSet<u32>> = HashMap::new();
    for page in &doc.pages {
        let pb = if page.body_size > 0.0 && page.body_size >= 0.9 * body {
            page.body_size
        } else {
            body
        };
        let cands = candidates(page, pb);
        for c in &cands {
            let key: String = c.text.chars().filter(|ch| !ch.is_ascii_digit()).collect();
            repeats.entry(key).or_default().insert(c.page);
        }
        all.push(cands);
    }
    // Wrapped headings: the next line of the same look right below is part of the same entry.
    let mut merged: Vec<Cand> = Vec::new();
    for (pi, cands) in all.into_iter().enumerate() {
        let page = &doc.pages[pi];
        let mut prev: Option<Cand> = None;
        for c in cands {
            let key: String = c.text.chars().filter(|ch| !ch.is_ascii_digit()).collect();
            if repeats.get(&key).is_some_and(|p| p.len() >= REPEATS) {
                continue;
            }
            if let Some(p) = prev.as_mut() {
                let gap = c.y - page.lines.get(p.li).map_or(p.y, |l| l.rect.y + l.rect.h);
                if c.li == p.li + 1
                    && c.depth.is_none()
                    && (c.size - p.size).abs() < 0.3
                    && c.bold == p.bold
                    && gap < 0.6 * p.size
                    && p.text.chars().count() + c.text.chars().count() < MAX_LINE
                {
                    p.text.push(' ');
                    p.text.push_str(&c.text);
                    p.li = c.li;
                    continue;
                }
            }
            if let Some(p) = prev.replace(c) {
                merged.push(p);
            }
        }
        if let Some(p) = prev {
            merged.push(p);
        }
    }
    // Levels: a section number gives its depth; otherwise the larger the size, the higher the level.
    let mut sizes: Vec<f32> = Vec::new();
    for c in merged.iter().filter(|c| c.depth.is_none() && c.big) {
        if !sizes.iter().any(|s| (s - c.size).abs() < 0.3) {
            sizes.push(c.size);
        }
    }
    sizes.sort_by(|a, b| b.total_cmp(a));
    sizes.truncate(usize::from(MAX_LEVEL - 1));
    let sized = u8::try_from(sizes.len()).unwrap_or(MAX_LEVEL);
    let mut out: Vec<Entry> = Vec::new();
    for c in merged {
        let level = match c.depth {
            Some(d) => d,
            None if c.big => sizes
                .iter()
                .position(|s| (s - c.size).abs() < 0.3)
                .and_then(|i| u8::try_from(i + 1).ok())
                .unwrap_or(sized.max(1)),
            None => (sized + 1).min(MAX_LEVEL),
        };
        out.push(Entry {
            page: c.page,
            y: c.y.max(0.0),
            title: cut(&c.text),
            level: level.clamp(1, MAX_LEVEL),
        });
        if out.len() >= MAX_ENTRIES.min(limits::MAX_OUTLINE_NODES) {
            break;
        }
    }
    out
}

/// The entries of the table of contents: every confirmed contents link, at the page and line it points to. The level is the depth of
/// the section number, or else the indentation rank of the line within its contents page.
pub fn toc_entries(analysis: &Analysis) -> Vec<Entry> {
    let mut pages: Vec<u32> = analysis.toc.keys().copied().collect();
    pages.sort_unstable();
    let mut out = Vec::new();
    for p in pages {
        let links: Vec<_> = analysis.toc[&p]
            .iter()
            .filter(|l| l.kind == Kind::Contents)
            .collect();
        let mut xs: Vec<f32> = Vec::new();
        for l in &links {
            if let Some(r) = l.rects.get(1) {
                if !xs.iter().any(|x| (x - r.x).abs() < 3.0) {
                    xs.push(r.x);
                }
            }
        }
        xs.sort_by(f32::total_cmp);
        for l in links {
            let indent = l
                .rects
                .get(1)
                .and_then(|r| xs.iter().position(|x| (x - r.x).abs() < 3.0))
                .and_then(|i| u8::try_from(i + 1).ok())
                .unwrap_or(1);
            let level = numbering_depth(&l.marker)
                .unwrap_or(indent)
                .clamp(1, MAX_LEVEL);
            out.push(Entry {
                page: l.target.page,
                y: l.target.rect.map_or(0.0, |r| r.y.max(0.0)),
                title: cut(l.marker.trim()),
                level,
            });
        }
    }
    out
}

/// The table of contents merged with the headings, in document order; an entry of both counts once (same page and normalised title),
/// the contents entry winning (its title is the author's). Empty titles are dropped.
pub fn merged(toc: Vec<Entry>, headings: Vec<Entry>) -> Vec<Entry> {
    let mut seen: HashSet<(u32, String)> = HashSet::new();
    let mut out: Vec<Entry> = Vec::new();
    for e in toc.into_iter().chain(headings) {
        let key = normalize(&e.title);
        if key.is_empty() || !seen.insert((e.page, key)) {
            continue;
        }
        out.push(e);
    }
    out.sort_by(|a, b| a.page.cmp(&b.page).then(a.y.total_cmp(&b.y)));
    out.truncate(MAX_ENTRIES);
    out
}

/// The merged outline of an analysed document.
pub fn outline(doc: &DocText, analysis: &Analysis) -> Vec<Entry> {
    merged(toc_entries(analysis), headings(doc))
}

/// `extra` without the entries `base` (bookmarks as page and title) already has, in the order given.
pub fn without(extra: Vec<Entry>, base: &HashSet<(u32, String)>) -> Vec<Entry> {
    extra
        .into_iter()
        .filter(|e| !base.contains(&(e.page, normalize(&e.title))))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::smartlinks::model::{PtRect, Run};

    fn run(text: &str, y: f32, size: f32, bold: bool) -> Run {
        Run {
            text: text.into(),
            rect: PtRect {
                x: 50.0,
                y,
                w: 6.0 * text.chars().count() as f32,
                h: size,
            },
            size,
            baseline: y + size,
            bold,
        }
    }

    fn line(text: &str, y: f32, size: f32, bold: bool) -> Line {
        let r = run(text, y, size, bold);
        Line {
            rect: r.rect,
            runs: vec![r],
        }
    }

    fn page(n: u32, lines: Vec<Line>) -> PageText {
        PageText {
            page: n,
            width: 600.0,
            height: 800.0,
            lines,
            body_size: 11.0,
        }
    }

    fn body(y: f32) -> Line {
        line("A sentence of running text that ends here.", y, 11.0, false)
    }

    fn doc(pages: Vec<PageText>) -> DocText {
        let n = u32::try_from(pages.len()).unwrap_or(0);
        DocText {
            pages,
            page_count: n,
            labels: Vec::new(),
        }
    }

    #[test]
    fn headings_by_size_weight_and_numbering() {
        let d = doc(vec![
            page(
                0,
                vec![
                    line("Introduction", 60.0, 20.0, true),
                    body(100.0),
                    line("Background", 130.0, 15.0, true),
                    body(160.0),
                    line("2.1 Method details", 190.0, 11.0, true),
                    body(210.0),
                    line("Bold remark", 240.0, 11.0, true),
                    body(260.0),
                    line(
                        "Not a heading because it is a sentence.",
                        290.0,
                        11.0,
                        false,
                    ),
                ],
            ),
            page(1, vec![body(60.0), body(80.0)]),
        ]);
        let h = headings(&d);
        let t: Vec<(&str, u8)> = h.iter().map(|e| (e.title.as_str(), e.level)).collect();
        assert_eq!(
            t,
            vec![
                ("Introduction", 1),
                ("Background", 2),
                ("2.1 Method details", 2),
                ("Bold remark", 3),
            ]
        );
    }

    #[test]
    fn wrapped_headings_are_one_entry_and_running_heads_are_none() {
        let mut pages = Vec::new();
        for n in 0..4 {
            let mut lines = vec![line("Report 2024", 20.0, 16.0, true), body(100.0)];
            if n == 1 {
                lines.push(line("A long chapter title that", 200.0, 18.0, true));
                lines.push(line("wraps onto a second line", 221.0, 18.0, true));
            }
            pages.push(page(n, lines));
        }
        let h = headings(&doc(pages));
        assert_eq!(h.len(), 1, "{h:?}");
        assert_eq!(
            h[0].title,
            "A long chapter title that wraps onto a second line"
        );
        assert_eq!(h[0].page, 1);
    }

    #[test]
    fn a_page_of_bold_paragraphs_has_no_bold_headings_and_leader_lines_are_none() {
        let bold_page = page(
            0,
            vec![
                line("First bold paragraph line", 60.0, 11.0, true),
                line("Second bold paragraph line", 80.0, 11.0, true),
                line("Third bold paragraph line", 100.0, 11.0, true),
            ],
        );
        let toc = page(1, vec![line("1 Intro ........ 4", 60.0, 16.0, true)]);
        assert!(headings(&doc(vec![bold_page, toc])).is_empty());
    }

    #[test]
    fn numbering_and_normalising() {
        assert_eq!(numbering_depth("1 Intro"), Some(1));
        assert_eq!(numbering_depth("2.3. Methods"), Some(2));
        assert_eq!(numbering_depth("4.1.2 Deep"), Some(3));
        assert_eq!(numbering_depth("2024 was a year"), None);
        assert_eq!(numbering_depth("3,5 kg"), None);
        assert_eq!(numbering_depth("Intro"), None);
        assert_eq!(normalize("1.2 Hello, World!"), normalize("Hello World"));
        assert_eq!(normalize("§ 12 Zweck"), normalize("Zweck"));
    }

    #[test]
    fn merge_dedupes_by_page_and_title_and_keeps_document_order() {
        let e = |page, y, title: &str, level| Entry {
            page,
            y,
            title: title.into(),
            level,
        };
        let toc = vec![e(2, 50.0, "2 Methods", 1), e(0, 40.0, "Intro", 1)];
        let heads = vec![
            e(0, 40.0, "1 Intro", 1),
            e(2, 50.0, "Methods", 1),
            e(3, 10.0, "Results", 1),
        ];
        let m = merged(toc, heads);
        let t: Vec<&str> = m.iter().map(|x| x.title.as_str()).collect();
        assert_eq!(t, vec!["Intro", "2 Methods", "Results"]);
        let base: HashSet<(u32, String)> = [(3, normalize("Results"))].into_iter().collect();
        assert_eq!(without(m, &base).len(), 2);
    }

    #[test]
    fn hostile_input_is_bounded() {
        let mut l = line("Heading", f32::NAN, f32::INFINITY, true);
        l.rect.y = f32::NAN;
        let d = doc(vec![page(0, vec![l, line("", 1.0, 11.0, true)])]);
        assert!(headings(&d).is_empty());
        assert!(headings(&DocText::default()).is_empty());
    }
}
