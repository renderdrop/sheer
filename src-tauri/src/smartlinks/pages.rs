//! Printed page numbers to physical pages (ADR-132 §3, DESIGN §3.11 "Page numbers"). A printed number resolves first to a page label (when
//! the file defines labels), else through an offset (physical = printed + offset) learned from page numbers in headers and footers and
//! confirmed by at least three contents lines whose title is found on the page the offset gives. No confirmed mapping resolves nothing.
//! Pure over [`DocText`]; pages are 0-based positions, as in [`DocText::pages`].

use std::collections::HashMap;

use super::model::DocText;
use super::toc::{Norms, TocEntry};

/// Lines whose title is found on the target page that confirm an offset.
const MIN_CONFIRMED: usize = 3;
/// Header and footer pages that must agree on an offset to propose it.
const MIN_VOTES: usize = 3;
/// A header or footer is within this fraction of the page height from its edge.
const EDGE: f32 = 0.09;
/// Offsets tried: the best-voted ones.
const MAX_CANDIDATES: usize = 6;

/// How printed numbers map to physical pages.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PageMap {
    /// The labels by position when the file defines real ones; empty otherwise.
    labels: Vec<Option<String>>,
    offset: Option<i32>,
    page_count: u32,
}

impl PageMap {
    /// A map from the labels of `doc` alone (empty labels: the identity of nothing, every number unresolved).
    pub fn from_labels(doc: &DocText) -> Self {
        Self {
            labels: doc.labels.clone(),
            offset: None,
            page_count: doc.page_count,
        }
    }

    /// The offset learned and confirmed, if there is one.
    pub fn offset(&self) -> Option<i32> {
        self.offset
    }

    /// The position of the page the printed `number` names. A label that matches exactly one page wins; else a confirmed offset gives it
    /// for a plain decimal number; a page past the document is `None`.
    pub fn resolve(&self, printed: &str) -> Option<u32> {
        let printed = printed.trim();
        if printed.is_empty() {
            return None;
        }
        let mut found = self
            .labels
            .iter()
            .enumerate()
            .filter(|(_, l)| {
                l.as_deref()
                    .is_some_and(|l| l.eq_ignore_ascii_case(printed))
            })
            .map(|(i, _)| i);
        if let Some(first) = found.next() {
            return found
                .next()
                .is_none()
                .then(|| u32::try_from(first).ok())
                .flatten()
                .filter(|&p| p < self.page_count);
        }
        let offset = self.offset?;
        let n: i64 = printed
            .chars()
            .all(|c| c.is_ascii_digit())
            .then(|| printed.parse().ok())
            .flatten()?;
        let physical = n.checked_add(i64::from(offset))?;
        u32::try_from(physical)
            .ok()
            .filter(|&p| p < self.page_count)
    }
}

/// The number a header or footer line says ("12", "- 12 -", "Seite 12", "Page 12", "12 / 340", "S. 12"), if it is one.
pub(crate) fn page_number_in(text: &str) -> Option<u32> {
    let t = text.trim();
    let mut words: Vec<&str> = t
        .split(|c: char| {
            c.is_whitespace() || matches!(c, '-' | '\u{2013}' | '\u{2014}' | '|' | '/')
        })
        .filter(|w| !w.is_empty())
        .collect();
    // "12 / 340": the page and the total.
    if words.len() == 2 && words.iter().all(|w| w.chars().all(|c| c.is_ascii_digit())) {
        words.truncate(1);
    }
    if let [lead, number] = words.as_slice() {
        let lead = lead.trim_end_matches('.').to_lowercase();
        if matches!(lead.as_str(), "seite" | "page" | "s" | "p" | "pg") {
            words = vec![number];
        }
    }
    let [word] = words.as_slice() else {
        return None;
    };
    if word.len() > 4 || !word.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    word.parse().ok().filter(|&n| n >= 1)
}

/// (position, number) of the page number found in the header or footer of each page, at most one per page.
pub(crate) fn footer_numbers(doc: &DocText) -> Vec<(u32, u32)> {
    let mut out = Vec::new();
    for page in &doc.pages {
        if page.height <= 0.0 {
            continue;
        }
        let edge = |l: &super::model::Line| {
            l.rect.y + l.rect.h <= page.height * EDGE || l.rect.y >= page.height * (1.0 - EDGE)
        };
        let found = page.lines.iter().filter(|l| edge(l)).find_map(|l| {
            let text: String = l
                .runs
                .iter()
                .map(|r| r.text.as_str())
                .collect::<Vec<_>>()
                .join(" ");
            page_number_in(&text)
        });
        if let Some(n) = found {
            out.push((page.page, n));
        }
    }
    out
}

/// Whether the labels of a file say more than the position: PDFium answers "1", "2", ... for a file without labels.
pub fn has_real_labels(labels: &[Option<String>]) -> bool {
    labels
        .iter()
        .enumerate()
        .any(|(i, l)| l.as_deref().is_some_and(|l| l != (i + 1).to_string()))
}

fn confirmations(doc: &DocText, entries: &[TocEntry], offset: i32, norms: &mut Norms<'_>) -> usize {
    let mut n = 0;
    for e in entries {
        if !e.printed.chars().all(|c| c.is_ascii_digit()) {
            continue;
        }
        let Ok(printed) = e.printed.parse::<i64>() else {
            continue;
        };
        let Some(target) = u32::try_from(printed + i64::from(offset))
            .ok()
            .filter(|&p| p < doc.page_count && p != e.page)
        else {
            continue;
        };
        if norms.title_on(target, &e.title).is_some() {
            n += 1;
        }
    }
    n
}

/// The page map of `doc`: its labels, and the offset the header and footer numbers propose that the contents `entries` confirm. When the
/// labels are real they decide and no offset is learned for numbers they do not know only if no confirmed offset exists.
pub fn learn(doc: &DocText, entries: &[TocEntry], norms: &mut Norms<'_>) -> PageMap {
    let mut map = PageMap::from_labels(doc);
    let mut votes: HashMap<i32, usize> = HashMap::new();
    for (pos, n) in footer_numbers(doc) {
        let (Ok(p), Ok(n)) = (i32::try_from(pos), i32::try_from(n)) else {
            continue;
        };
        *votes.entry(p - n).or_insert(0) += 1;
    }
    let mut candidates: Vec<(i32, usize)> =
        votes.into_iter().filter(|&(_, v)| v >= MIN_VOTES).collect();
    candidates.sort_by_key(|&(o, v)| (std::cmp::Reverse(v), o));
    candidates.truncate(MAX_CANDIDATES);
    let mut best: Option<(usize, usize, i32)> = None;
    for (offset, v) in candidates {
        let c = confirmations(doc, entries, offset, norms);
        if c >= MIN_CONFIRMED && best.is_none_or(|(bc, bv, _)| (c, v) > (bc, bv)) {
            best = Some((c, v, offset));
        }
    }
    map.offset = best.map(|(_, _, o)| o);
    map
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::smartlinks::model::PageText;
    use crate::smartlinks::toc::tests::{line_of, page_of, run};

    fn footer(text: &str) -> crate::smartlinks::model::Line {
        line_of(vec![run(text, 280.0, 770.0, 20.0, 10.0)])
    }

    fn body(text: &str) -> crate::smartlinks::model::Line {
        line_of(vec![run(text, 50.0, 100.0, 300.0, 10.0)])
    }

    fn entry(page: u32, title: &str, printed: &str) -> TocEntry {
        let r = crate::smartlinks::model::PtRect {
            x: 50.0,
            y: 100.0,
            w: 300.0,
            h: 10.0,
        };
        TocEntry {
            page,
            title: title.to_owned(),
            printed: printed.to_owned(),
            number_rect: r,
            line_rect: r,
        }
    }

    /// Cover, contents, then chapters on pages 2..: printed page 1 is physical 2 (offset +1).
    fn book(chapters: &[&str], footers: bool) -> DocText {
        let mut pages: Vec<PageText> = vec![
            page_of(0, vec![body("Cover")]),
            page_of(1, vec![body("Contents")]),
        ];
        for (i, title) in chapters.iter().enumerate() {
            let mut lines = vec![body(title)];
            if footers {
                lines.push(footer(&format!("{}", i + 1)));
            }
            pages.push(page_of(2 + i as u32, lines));
        }
        let n = pages.len() as u32;
        DocText {
            pages,
            page_count: n,
            labels: Vec::new(),
        }
    }

    #[test]
    fn footer_numbers_in_their_usual_spellings() {
        for (text, n) in [
            ("12", Some(12)),
            ("- 12 -", Some(12)),
            ("Seite 12", Some(12)),
            ("Page 12", Some(12)),
            ("S. 7", Some(7)),
            ("12 / 340", Some(12)),
            ("Annual report 12", None),
            ("2019", Some(2019)),
            ("12345", None),
            ("0", None),
            ("", None),
        ] {
            assert_eq!(page_number_in(text), n, "{text}");
        }
    }

    #[test]
    fn an_offset_is_learned_from_footers_and_confirmed_by_three_titles() {
        let doc = book(
            &["Alpha one", "Beta two", "Gamma three", "Delta four"],
            true,
        );
        let entries = vec![
            entry(1, "Alpha one", "1"),
            entry(1, "Beta two", "2"),
            entry(1, "Gamma three", "3"),
        ];
        let map = learn(&doc, &entries, &mut Norms::new(&doc));
        assert_eq!(map.offset(), Some(1));
        assert_eq!(map.resolve("1"), Some(2));
        assert_eq!(map.resolve("4"), Some(5));
        assert_eq!(map.resolve("5"), None, "past the document");
        assert_eq!(map.resolve("iv"), None, "no label, no roman numbers");
        assert_eq!(map.resolve(""), None);
    }

    #[test]
    fn two_confirmations_are_not_enough_and_wrong_titles_confirm_nothing() {
        let doc = book(
            &["Alpha one", "Beta two", "Gamma three", "Delta four"],
            true,
        );
        let two = vec![entry(1, "Alpha one", "1"), entry(1, "Beta two", "2")];
        assert_eq!(learn(&doc, &two, &mut Norms::new(&doc)).offset(), None);
        let wrong = vec![
            entry(1, "Alpha one", "2"),
            entry(1, "Beta two", "3"),
            entry(1, "Gamma three", "4"),
        ];
        assert_eq!(learn(&doc, &wrong, &mut Norms::new(&doc)).offset(), None);
        assert_eq!(learn(&doc, &[], &mut Norms::new(&doc)).resolve("1"), None);
    }

    #[test]
    fn without_footer_numbers_there_is_no_offset() {
        let doc = book(&["Alpha one", "Beta two", "Gamma three"], false);
        let entries = vec![
            entry(1, "Alpha one", "1"),
            entry(1, "Beta two", "2"),
            entry(1, "Gamma three", "3"),
        ];
        assert_eq!(learn(&doc, &entries, &mut Norms::new(&doc)).offset(), None);
    }

    #[test]
    fn labels_win_and_an_ambiguous_label_resolves_nothing() {
        let mut doc = book(&["A", "B", "C"], false);
        doc.labels = vec![
            Some("i".into()),
            Some("ii".into()),
            Some("1".into()),
            Some("2".into()),
            Some("1".into()),
        ];
        let map = PageMap::from_labels(&doc);
        assert_eq!(map.resolve("ii"), Some(1));
        assert_eq!(map.resolve("II"), Some(1));
        assert_eq!(map.resolve("2"), Some(3));
        assert_eq!(map.resolve("1"), None, "two pages are labelled 1");
        assert_eq!(map.resolve("9"), None);
    }

    #[test]
    fn conflicting_offsets_are_not_guessed() {
        // Chapters on pages 2..9; footers 1..4 then 1..4 again, so offsets +1 and +5 both have 4 votes.
        let mut doc = book(
            &[
                "Chapter A1 title",
                "Chapter B1 title",
                "Chapter C1 title",
                "Chapter D1 title",
                "Chapter A2 title",
                "Chapter B2 title",
                "Chapter C2 title",
                "Chapter D2 title",
            ],
            false,
        );
        for (i, page) in doc.pages.iter_mut().enumerate().skip(2) {
            let n = if i < 6 { i - 1 } else { i - 5 };
            page.lines.push(footer(&format!("{n}")));
        }
        // Titles that fit neither offset confirm nothing: no mapping at all.
        let none = vec![
            entry(1, "Chapter A1 title", "2"),
            entry(1, "Chapter B2 title", "1"),
            entry(1, "Chapter C2 title", "9"),
        ];
        let map = learn(&doc, &none, &mut Norms::new(&doc));
        assert_eq!(map.offset(), None);
        assert_eq!(map.resolve("1"), None);
        // Only one run's titles match: that offset is the single confirmed one.
        let first = vec![
            entry(1, "Chapter A1 title", "1"),
            entry(1, "Chapter B1 title", "2"),
            entry(1, "Chapter C1 title", "3"),
        ];
        assert_eq!(learn(&doc, &first, &mut Norms::new(&doc)).offset(), Some(1));
    }

    #[test]
    fn real_labels_are_told_from_the_positions() {
        let plain: Vec<Option<String>> = (1..=3).map(|n| Some(n.to_string())).collect();
        assert!(!has_real_labels(&plain));
        assert!(has_real_labels(&[Some("i".into()), Some("2".into())]));
        assert!(!has_real_labels(&[]));
    }
}
