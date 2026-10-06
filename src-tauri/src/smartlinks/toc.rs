//! `toc` detector (ADR-132 §2, DESIGN §3.11 L1): a contents line is a title, dot leaders (or a clear gap) and a page number at the line
//! end; three such lines in a block make a contents block. A line links to the page its number names (through [`PageMap`]) only when the
//! title is found on that page: a number the file does not confirm makes no link. Pure over [`DocText`].

use std::collections::HashMap;

use super::model::{DocText, Kind, Line, PageText, PtRect, SmartLink, Target};
use super::pages::PageMap;
use super::references::{truncate_preview, LineText};

/// Lines of a block need at least this many entries.
const MIN_BLOCK: usize = 3;
/// Matching lines further apart than this (in lines) are different blocks (wrapped titles and part headings fit between).
const MAX_BLOCK_GAP: usize = 3;
/// Leader characters (dots, ellipsis, middle dots) needed before the number.
const MIN_LEADERS: usize = 3;
/// A page number has at most this many digits.
const MAX_DIGITS: usize = 4;
/// Without leaders the number stands alone in its run, this many sizes right of the title.
const GAP_SIZES: f32 = 1.5;
/// Longest title kept, in characters.
const MAX_TITLE: usize = 200;
/// A wrapped title's first line is at most this many line heights above its second.
const WRAP_LINES: f32 = 2.0;
const MIN_LINE_H: f32 = 8.0;
/// Titles are compared by their first characters (letters and digits only).
const KEY_CHARS: usize = 60;
/// A title found on its page needs at least this many letters and digits to count.
const MIN_KEY: usize = 4;
/// A title without its section number must still have this many letters to be compared that way.
const MIN_BARE: usize = 6;
/// A line that is only the beginning of a wrapped heading has at least this many letters and digits.
const MIN_PREFIX: usize = 12;
const SCORE: f32 = 0.95;

/// One line of a contents block.
#[derive(Debug, Clone, PartialEq)]
pub struct TocEntry {
    /// The page the contents line is on (`PageText::page`).
    pub page: u32,
    pub title: String,
    /// The page number as printed ("12", "iv").
    pub printed: String,
    pub number_rect: PtRect,
    pub line_rect: PtRect,
}

fn is_leader(c: char) -> bool {
    matches!(
        c,
        '.' | '\u{2026}' | '\u{b7}' | '\u{2022}' | '\u{2024}' | '\u{22ef}'
    )
}

fn is_roman(word: &str) -> bool {
    let w: Vec<char> = word.chars().collect();
    if w.is_empty() || w.len() > 6 {
        return false;
    }
    let lower = w.iter().all(|c| "ivxlcdm".contains(*c));
    let upper = w.iter().all(|c| "IVXLCDM".contains(*c));
    (lower || upper) && w.len() >= 2 || (w.len() == 1 && matches!(w[0], 'i' | 'v' | 'x'))
}

fn is_decimal(word: &str) -> bool {
    !word.is_empty()
        && word.len() <= MAX_DIGITS
        && word.chars().all(|c| c.is_ascii_digit())
        && word.parse::<u32>().is_ok_and(|n| n >= 1)
}

/// Letters and digits of `s`, lower case: the form titles are compared in.
pub(crate) fn norm(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

/// The first characters of a normalised title, or `None` for a title too short to be told from other text.
pub(crate) fn title_key(title: &str) -> Option<String> {
    let key: String = norm(title).chars().take(KEY_CHARS).collect();
    (key.chars().count() >= MIN_KEY).then_some(key)
}

/// The (start, end) character range of every run of a line.
fn bounds(line: &Line) -> Vec<(usize, usize)> {
    let mut at = 0usize;
    line.runs
        .iter()
        .map(|r| {
            let s = at;
            at += r.text.chars().count();
            (s, at)
        })
        .collect()
}

struct Parsed {
    title: String,
    printed: String,
    number: (usize, usize),
}

/// Title, printed number and the number's character range of a contents line, if the line is one.
fn parse_line(lt: &LineText<'_>) -> Option<Parsed> {
    let c = &lt.chars;
    let mut end = c.len();
    while end > 0 && c[end - 1].is_whitespace() {
        end -= 1;
    }
    let mut start = end;
    while start > 0 && c[start - 1].is_alphanumeric() {
        start -= 1;
    }
    if start == end || start == 0 {
        return None;
    }
    let token: String = c[start..end].iter().collect();
    // The title must not run into the number ("ISO9001").
    if !(c[start - 1].is_whitespace() || is_leader(c[start - 1])) {
        return None;
    }
    let decimal = is_decimal(&token);
    if !decimal && !is_roman(&token) {
        return None;
    }
    // The leaders in front of the number: dots, ellipses and the white space between them.
    let mut cut = start;
    let mut leaders = 0usize;
    while cut > 0 && (is_leader(c[cut - 1]) || c[cut - 1].is_whitespace()) {
        if is_leader(c[cut - 1]) {
            leaders += 1;
        }
        cut -= 1;
    }
    let title_chars = &c[..cut];
    let title: String = title_chars.iter().collect::<String>().trim().to_owned();
    if title.chars().filter(|c| c.is_alphabetic()).count() < 2 {
        return None;
    }
    if leaders < MIN_LEADERS {
        // No leaders: the number has to stand apart, in a run of its own, clearly right of the title.
        if !decimal || leaders > 0 {
            return None;
        }
        let spans = bounds(lt.line);
        let at = spans.iter().position(|&(s, e)| s <= start && start < e)?;
        let run = &lt.line.runs[at];
        if at == 0
            || spans[at].0 != start && !c[spans[at].0..start].iter().all(|c| c.is_whitespace())
        {
            return None;
        }
        let prev = &lt.line.runs[at - 1];
        if run.rect.x - (prev.rect.x + prev.rect.w) < GAP_SIZES * run.size.max(prev.size) {
            return None;
        }
    }
    Some(Parsed {
        title: title.chars().take(MAX_TITLE).collect(),
        printed: token,
        number: (start, end),
    })
}

/// The contents entries of `page`: lines that match, in blocks of at least three.
pub fn detect_entries(page: &PageText) -> Vec<TocEntry> {
    let mut hits: Vec<(usize, TocEntry)> = Vec::new();
    for (i, line) in page.lines.iter().enumerate() {
        let lt = LineText::new(line);
        if let Some(p) = parse_line(&lt) {
            hits.push((
                i,
                TocEntry {
                    page: page.page,
                    title: p.title,
                    printed: p.printed,
                    number_rect: lt.rect(p.number.0, p.number.1),
                    line_rect: line.rect,
                },
            ));
        }
    }
    let hit_lines: std::collections::HashSet<usize> = hits.iter().map(|(i, _)| *i).collect();
    let mut blocks: Vec<Vec<(usize, TocEntry)>> = Vec::new();
    let mut last: Option<usize> = None;
    for (i, e) in hits {
        match blocks.last_mut() {
            Some(block) if last.is_some_and(|l| i - l <= MAX_BLOCK_GAP) => block.push((i, e)),
            _ => blocks.push(vec![(i, e)]),
        }
        last = Some(i);
    }
    let mut out = Vec::new();
    for block in blocks.into_iter().filter(|b| b.len() >= MIN_BLOCK) {
        let first = block[0].0;
        for (i, mut e) in block {
            // A title that wraps: the line above it, when it is no entry itself and not before the first entry of the block (that is the
            // heading of the contents), is the beginning of the title.
            if i > first + 1 && !hit_lines.contains(&(i - 1)) {
                if let (Some(prev), Some(line)) = (page.lines.get(i - 1), page.lines.get(i)) {
                    if line.rect.y - prev.rect.y <= WRAP_LINES * prev.rect.h.max(MIN_LINE_H) {
                        let head: String = prev.runs.iter().map(|r| r.text.as_str()).collect();
                        let head = head.trim();
                        if !head.is_empty() {
                            e.title = format!("{head} {}", e.title)
                                .chars()
                                .take(MAX_TITLE)
                                .collect();
                        }
                    }
                }
            }
            out.push(e);
        }
    }
    out
}

/// A page with its lines in the form titles are compared in; built once per page and kept while an analysis runs.
struct PageNorm {
    lines: Vec<(String, PtRect)>,
}

impl PageNorm {
    fn new(page: &PageText) -> Self {
        let lines: Vec<(String, PtRect)> = page
            .lines
            .iter()
            .map(|l| {
                let text: String = l.runs.iter().map(|r| r.text.as_str()).collect();
                (norm(&text), l.rect)
            })
            .collect();

        Self { lines }
    }

    /// The box of the line the title starts on, if the page has it: a line that begins with the title, or (for a heading that wraps) a line
    /// that is at least half of the title and its beginning. A title in the middle of a line is not a heading (the second line of a wrapped
    /// contents title is not found in the body text).
    fn find(&self, key: &str) -> Option<PtRect> {
        let half = key.chars().count() / 2;
        // A heading may carry a section number the contents title lacks ("1 Introduction" for "Introduction"): without leading digits too.
        let bare = key.trim_start_matches(|c: char| c.is_ascii_digit());
        let bare = (bare.chars().count() >= MIN_BARE).then_some(bare);
        self.lines
            .iter()
            .find(|(s, _)| {
                s.starts_with(key)
                    || (s.chars().count() >= MIN_PREFIX.max(half) && key.starts_with(s.as_str()))
                    || bare.is_some_and(|b| {
                        s.trim_start_matches(|c: char| c.is_ascii_digit())
                            .starts_with(b)
                    })
            })
            .map(|&(_, r)| r)
    }
}

/// The pages of a document in the form titles are compared in, built page by page when asked.
pub struct Norms<'a> {
    doc: &'a DocText,
    cache: HashMap<u32, Option<PageNorm>>,
}

impl<'a> Norms<'a> {
    pub fn new(doc: &'a DocText) -> Self {
        Self {
            doc,
            cache: HashMap::new(),
        }
    }

    /// The box of the line where `title` is on page `page`; `None` if it is not there or too short to tell.
    pub fn title_on(&mut self, page: u32, title: &str) -> Option<PtRect> {
        let key = title_key(title)?;
        let doc = self.doc;
        self.cache
            .entry(page)
            .or_insert_with(|| doc.pages.iter().find(|p| p.page == page).map(PageNorm::new))
            .as_ref()?
            .find(&key)
    }
}

/// The contents links of every page, from the entries and the page mapping: a link needs a target the mapping gives, that is not the
/// contents page itself, and the title on that page. Keyed by the page of the contents line.
pub fn links(
    doc: &DocText,
    entries: &[TocEntry],
    map: &PageMap,
    norms: &mut Norms<'_>,
) -> HashMap<u32, Vec<SmartLink>> {
    let mut out: HashMap<u32, Vec<SmartLink>> = HashMap::new();
    for e in entries {
        let Some(target) = map.resolve(&e.printed).filter(|&t| t < doc.page_count) else {
            continue;
        };
        if target == e.page {
            continue;
        }
        let Some(rect) = norms.title_on(target, &e.title) else {
            continue;
        };
        let preview = doc
            .pages
            .iter()
            .find(|p| p.page == target)
            .and_then(|p| p.lines.iter().find(|l| l.rect == rect))
            .map(|l| truncate_preview(&l.runs.iter().map(|r| r.text.as_str()).collect::<String>()))
            .unwrap_or_default();
        out.entry(e.page).or_default().push(SmartLink {
            kind: Kind::Contents,
            page: e.page,
            rects: vec![e.number_rect, e.line_rect],
            marker: e.title.clone(),
            target: Target {
                page: target,
                rect: Some(rect),
                label: Some(e.printed.clone()),
            },
            choices: Vec::new(),
            preview,
            score: SCORE,
        });
    }
    out
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::smartlinks::model::Run;

    pub fn run(text: &str, x: f32, y: f32, w: f32, size: f32) -> Run {
        Run {
            text: text.to_owned(),
            rect: PtRect { x, y, w, h: size },
            size,
            baseline: y + size,
            bold: false,
        }
    }

    pub fn line_of(runs: Vec<Run>) -> Line {
        let mut rect = runs[0].rect;
        for r in &runs[1..] {
            let x1 = (rect.x + rect.w).max(r.rect.x + r.rect.w);
            let y1 = (rect.y + rect.h).max(r.rect.y + r.rect.h);
            rect.x = rect.x.min(r.rect.x);
            rect.y = rect.y.min(r.rect.y);
            rect.w = x1 - rect.x;
            rect.h = y1 - rect.y;
        }
        Line { runs, rect }
    }

    pub fn leader_line(y: f32, title: &str, number: &str) -> Line {
        line_of(vec![run(
            &format!("{title} {} {number}", ". ".repeat(20).trim()),
            50.0,
            y,
            400.0,
            10.0,
        )])
    }

    pub fn gap_line(y: f32, title: &str, number: &str) -> Line {
        line_of(vec![
            run(title, 50.0, y, 200.0, 10.0),
            run(&format!(" {number}"), 450.0, y, 12.0, 10.0),
        ])
    }

    pub fn page_of(n: u32, lines: Vec<Line>) -> PageText {
        PageText {
            page: n,
            width: 600.0,
            height: 800.0,
            lines,
            body_size: 10.0,
        }
    }

    fn plain(y: f32, text: &str) -> Line {
        line_of(vec![run(text, 50.0, y, 300.0, 10.0)])
    }

    #[test]
    fn three_lines_with_leaders_make_a_block_and_two_do_not() {
        let three = page_of(
            1,
            vec![
                plain(60.0, "Contents"),
                leader_line(100.0, "1 Introduction", "3"),
                leader_line(120.0, "2 Methods", "9"),
                leader_line(140.0, "3 Results", "17"),
            ],
        );
        let entries = detect_entries(&three);
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].title, "1 Introduction");
        assert_eq!(entries[0].printed, "3");
        assert_eq!(entries[2].printed, "17");
        assert!(
            entries[0].number_rect.x > 300.0,
            "{:?}",
            entries[0].number_rect
        );
        assert_eq!(entries[1].line_rect.y, 120.0);

        let two = page_of(
            1,
            vec![
                leader_line(100.0, "1 Introduction", "3"),
                leader_line(120.0, "2 Methods", "9"),
            ],
        );
        assert!(detect_entries(&two).is_empty());
    }

    #[test]
    fn a_number_alone_in_its_run_right_of_the_title_counts_without_leaders() {
        let page = page_of(
            1,
            vec![
                gap_line(100.0, "Einleitung", "3"),
                gap_line(120.0, "Grundlagen", "9"),
                gap_line(140.0, "Ergebnisse", "17"),
            ],
        );
        assert_eq!(detect_entries(&page).len(), 3);

        // The number right behind the title is not a contents line.
        let tight = page_of(
            1,
            (0..3)
                .map(|i| {
                    line_of(vec![
                        run("Einleitung", 50.0, 100.0 + 20.0 * i as f32, 100.0, 10.0),
                        run(" 3", 152.0, 100.0 + 20.0 * i as f32, 6.0, 10.0),
                    ])
                })
                .collect(),
        );
        assert!(detect_entries(&tight).is_empty());
    }

    #[test]
    fn body_lines_that_end_in_a_number_are_not_contents() {
        let page = page_of(
            1,
            vec![
                plain(100.0, "The result is shown in table 3"),
                plain(120.0, "Revenue grew by 12"),
                plain(140.0, "ISO9001"),
                plain(160.0, "Chapter ... 5"),
            ],
        );
        assert!(detect_entries(&page).is_empty());
    }

    #[test]
    fn roman_numbers_need_leaders_and_a_wrapped_title_stays_in_the_block() {
        let page = page_of(
            1,
            vec![
                leader_line(100.0, "Preface", "iv"),
                plain(120.0, "A title that wraps onto"),
                leader_line(140.0, "a second line", "vii"),
                leader_line(160.0, "Index", "300"),
                // Far away: a different block of one.
                plain(200.0, "a"),
                plain(220.0, "b"),
                plain(240.0, "c"),
                plain(260.0, "d"),
                leader_line(500.0, "Lonely", "5"),
            ],
        );
        let e = detect_entries(&page);
        assert_eq!(e.len(), 3);
        assert_eq!(e[0].printed, "iv");
        assert_eq!(e[1].printed, "vii");
        assert_eq!(e[1].title, "A title that wraps onto a second line");
        assert_eq!(
            e[0].title, "Preface",
            "the first entry takes nothing from above"
        );
    }

    #[test]
    fn links_need_a_confirmed_target_with_the_title_on_it_and_never_the_contents_page() {
        let toc = page_of(
            1,
            vec![
                leader_line(100.0, "Introduction", "1"),
                leader_line(120.0, "Methods", "2"),
                leader_line(140.0, "Results", "3"),
            ],
        );
        let doc = DocText {
            pages: vec![
                page_of(0, vec![plain(60.0, "Cover")]),
                toc.clone(),
                page_of(
                    2,
                    vec![plain(60.0, "1 Introduction"), plain(80.0, "Body text.")],
                ),
                page_of(3, vec![plain(60.0, "Methods and more")]),
                page_of(4, vec![plain(60.0, "Nothing here")]),
            ],
            page_count: 5,
            labels: vec![
                None,
                None,
                Some("1".into()),
                Some("2".into()),
                Some("3".into()),
            ],
        };
        let entries = detect_entries(&toc);
        let map = PageMap::from_labels(&doc);
        let links = links(&doc, &entries, &map, &mut Norms::new(&doc));
        let l = &links[&1];
        assert_eq!(l.len(), 2, "Results is not on page 4");
        assert_eq!(l[0].target.page, 2);
        assert_eq!(l[0].target.rect.unwrap().y, 60.0);
        assert_eq!(l[0].preview, "1 Introduction");
        assert_eq!(l[0].rects.len(), 2);
        assert_eq!(
            l[0].target.label.as_deref(),
            Some("1"),
            "the printed number travels with the link"
        );
        assert_eq!(l[1].target.label.as_deref(), Some("2"));
        assert_eq!(l[1].target.page, 3);
    }

    #[test]
    fn a_title_is_a_heading_only_at_the_start_of_a_line_and_wrapped_ones_by_their_first_half() {
        let doc = DocText {
            pages: vec![page_of(
                0,
                vec![
                    plain(
                        60.0,
                        "und Betreibens von Infrastrukturanlagen der Eisenbahn",
                    ),
                    plain(80.0, "7. Handlungsfelder und"),
                    plain(100.0, "Maßnahmen im Überblick"),
                    plain(120.0, "Kapitel"),
                ],
            )],
            page_count: 1,
            labels: vec![],
        };
        let mut norms = Norms::new(&doc);
        assert!(
            norms.title_on(0, "Infrastruktur").is_none(),
            "inside a body line"
        );
        assert_eq!(
            norms.title_on(0, "Maßnahmen").unwrap().y,
            100.0,
            "starts a line"
        );
        let wrapped = norms.title_on(0, "7. Handlungsfelder und Maßnahmen im Überblick");
        assert_eq!(wrapped.unwrap().y, 80.0);
        assert!(
            norms
                .title_on(0, "Kapitel zur Geschichte der Stadt")
                .is_none(),
            "a short line is not half of it"
        );
    }

    #[test]
    fn norm_keeps_letters_and_digits_lower_case_and_short_titles_have_no_key() {
        assert_eq!(norm("1.2  Fußnoten, Ü!"), "12fußnotenü");
        assert_eq!(title_key("A1"), None);
        assert!(title_key("Introduction").is_some());
    }
}
