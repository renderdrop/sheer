//! The text of one page as lines and runs, for smart links (`Job::SmartText`, ADR-132, DESIGN §3.11 L10).
//!
//! The characters of the page are read in PDFium's order, and a run is a stretch of characters of one line with the same size, the same
//! baseline and the same weight (a raised footnote marker is a run of its own). The boxes are in page points, origin top left, y down,
//! before `/Rotate`, like the text layer's. A space joins the larger of the two runs it stands between, so that a marker never carries one.
//!
//! The page is hostile input: characters, lines, runs and the time are bounded (`limits::*_SMART_*`), a size or a position that is not a
//! number makes the character count as nothing, and what is past a limit is left out. [`build_page`] is pure, so the rules are tested
//! without PDFium.

use std::collections::HashMap;
use std::time::Instant;

use pdfium_render::prelude::*;

use super::space::{load_page, page_box};
use super::text::{char_box, text_chars};
use crate::error::AppError;
use crate::limits;
use crate::model::geometry::Rect;
use crate::smartlinks::model::{Line, PageText, PtRect, Run};

/// Sizes differ when they are more than this far apart (points); baselines likewise.
const SIZE_TOLERANCE: f32 = 0.25;
const BASELINE_TOLERANCE: f32 = 0.6;
/// A horizontal gap of more than this many sizes between two characters of a line splits the run.
const GAP_SIZES: f32 = 1.5;

/// One character as the reader found it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) struct RawChar {
    pub c: char,
    pub rect: Rect,
    pub size: f32,
    /// The y of the character's origin on the page, y down.
    pub baseline: f32,
    pub bold: bool,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) enum Item {
    /// A line break (PDFium's generated one).
    Break,
    /// Any white space.
    Space,
    Char(RawChar),
}

fn pt(rect: Rect) -> PtRect {
    PtRect {
        x: rect.x,
        y: rect.y,
        w: rect.w,
        h: rect.h,
    }
}

fn union(a: PtRect, b: PtRect) -> PtRect {
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

/// A box of a character that carries one: finite, not the corner placeholder of a generated character.
fn usable(rect: Rect) -> bool {
    [rect.x, rect.y, rect.w, rect.h]
        .iter()
        .all(|n| n.is_finite())
        && (rect.w > 0.0 || rect.h > 0.0)
}

fn size_key(points: f32) -> Option<i32> {
    (points.is_finite() && points > 0.0 && points < 2_000.0).then(|| (points * 2.0).round() as i32)
}

struct Builder {
    runs: Vec<Run>,
    run: Option<Run>,
    run_chars: usize,
    pending_space: bool,
    /// The right edge of the last character added to the line.
    last_right: f32,
    lines: Vec<Line>,
    sizes: HashMap<i32, u64>,
    chars: usize,
}

impl Builder {
    fn finish_run(&mut self) -> Option<Run> {
        self.run_chars = 0;
        self.run.take()
    }

    fn push_run(&mut self, run: Run) {
        if self.runs.len() < limits::MAX_SMART_RUNS_PER_LINE && !run.text.trim().is_empty() {
            self.runs.push(run);
        }
    }

    fn finish_line(&mut self) {
        if let Some(run) = self.finish_run() {
            self.push_run(run);
        }
        self.pending_space = false;
        let runs = std::mem::take(&mut self.runs);
        let Some(first) = runs.first() else { return };
        let rect = runs
            .iter()
            .skip(1)
            .fold(first.rect, |a, r| union(a, r.rect));
        if self.lines.len() < limits::MAX_SMART_LINES_PER_PAGE {
            self.lines.push(Line { runs, rect });
        }
    }

    fn add(&mut self, ch: RawChar) {
        let Some(key) = size_key(ch.size) else { return };
        if !usable(ch.rect) || !ch.baseline.is_finite() {
            return;
        }
        *self.sizes.entry(key).or_insert(0) += 1;
        self.chars += 1;
        // A gap wider than this many sizes starts a run of its own (the page number of a contents line stands alone), with a space.
        let gap = self.run.is_some() && ch.rect.x - self.last_right > GAP_SIZES * ch.size;
        self.last_right = ch.rect.x + ch.rect.w;
        if gap {
            self.pending_space = true;
        }
        let same = self.run.as_ref().is_some_and(|run| {
            (run.size - ch.size).abs() <= SIZE_TOLERANCE
                && (run.baseline - ch.baseline).abs() <= BASELINE_TOLERANCE
                && run.bold == ch.bold
                && !gap
        });
        if same && self.run_chars < limits::MAX_SMART_RUN_CHARS {
            if let Some(run) = self.run.as_mut() {
                if self.pending_space {
                    run.text.push(' ');
                }
                run.text.push(ch.c);
                run.rect = union(run.rect, pt(ch.rect));
                self.run_chars += 1;
            }
            self.pending_space = false;
            return;
        }
        if same {
            // A run that is too long: the rest of it is left out.
            self.pending_space = false;
            return;
        }
        let mut next = Run {
            text: ch.c.to_string(),
            rect: pt(ch.rect),
            size: ch.size,
            baseline: ch.baseline,
            bold: ch.bold,
        };
        let space = std::mem::take(&mut self.pending_space);
        if let Some(mut prev) = self.finish_run() {
            if space {
                if next.size >= prev.size - SIZE_TOLERANCE {
                    next.text.insert(0, ' ');
                } else {
                    prev.text.push(' ');
                }
            }
            self.push_run(prev);
        }
        self.run_chars = 1;
        self.run = Some(next);
    }
}

/// The page `page` of `width` x `height` points made of `items`: lines in reading order of runs, and the size most characters have
/// (the smaller one on a tie) as `body_size` (0 for a page without text).
pub(super) fn build_page(
    items: impl IntoIterator<Item = Item>,
    page: u32,
    width: f32,
    height: f32,
) -> PageText {
    let mut b = Builder {
        runs: Vec::new(),
        run: None,
        run_chars: 0,
        pending_space: false,
        last_right: 0.0,
        lines: Vec::new(),
        sizes: HashMap::new(),
        chars: 0,
    };
    for item in items {
        if b.chars >= limits::MAX_SMART_CHARS_PER_PAGE
            || b.lines.len() >= limits::MAX_SMART_LINES_PER_PAGE
        {
            break;
        }
        match item {
            Item::Break => b.finish_line(),
            Item::Space => b.pending_space = b.run.is_some(),
            Item::Char(ch) => b.add(ch),
        }
    }
    b.finish_line();
    let body = b
        .sizes
        .iter()
        .max_by_key(|&(&size, &count)| (count, std::cmp::Reverse(size)))
        .map_or(0.0, |(&size, _)| size as f32 / 2.0);
    PageText {
        page,
        width,
        height,
        lines: b.lines,
        body_size: body,
    }
}

fn is_bold(character: &PdfPageTextChar<'_>) -> bool {
    matches!(
        character.font_weight(),
        Some(PdfFontWeight::Weight600)
            | Some(PdfFontWeight::Weight700Bold)
            | Some(PdfFontWeight::Weight800)
            | Some(PdfFontWeight::Weight900)
    ) || matches!(character.font_weight(), Some(PdfFontWeight::Custom(w)) if (600..=1_000).contains(&w))
        || character.font_is_bold_reenforced()
}

/// Reads page `index` (below the page count, the caller checked) as runs and lines.
pub(super) fn read_page(document: &PdfDocument<'_>, index: u32) -> Result<PageText, AppError> {
    let started = Instant::now();
    let page = load_page(document, index)?;
    let page_box = page_box(&page)?;
    let bounds = page.boundaries().bounding().ok().map(|b| b.bounds);
    let (width, height) = bounds.map_or((0.0, 0.0), |b| {
        (
            (b.right().value - b.left().value).abs(),
            (b.top().value - b.bottom().value).abs(),
        )
    });
    let (width, height) = if width.is_finite() && height.is_finite() {
        (width, height)
    } else {
        (0.0, 0.0)
    };
    let empty = |page| PageText {
        page,
        width,
        height,
        lines: Vec::new(),
        body_size: 0.0,
    };
    if started.elapsed() > limits::SMART_PAGE_BUDGET {
        return Ok(empty(index));
    }
    let Ok(text_page) = page.text() else {
        return Ok(empty(index));
    };
    let characters = text_page.chars();

    let mut items: Vec<Item> = Vec::new();
    let mut read = 0usize;
    for character in text_chars(&characters) {
        read += 1;
        if read > limits::MAX_SMART_CHARS_PER_PAGE * 2
            || (read.is_multiple_of(2048) && started.elapsed() > limits::SMART_PAGE_BUDGET)
        {
            break;
        }
        if matches!(character.c, '\n' | '\r') {
            items.push(Item::Break);
            continue;
        }
        if character.c.is_whitespace() {
            items.push(Item::Space);
            continue;
        }
        let Ok(raw) = characters.get(character.first) else {
            continue;
        };
        let Ok((x, y)) = raw.origin() else { continue };
        let Some(origin) = page_box.point(x.value, y.value) else {
            continue;
        };
        items.push(Item::Char(RawChar {
            c: character.c,
            rect: char_box(&characters, character.first, page_box),
            size: raw.scaled_font_size().value,
            baseline: origin.y,
            bold: is_bold(&raw),
        }));
    }
    Ok(build_page(items, index, width, height))
}

/// Whether a page a child answered keeps the promises of [`build_page`]: the limits, finite numbers, and `page` as asked. A reply that
/// does not is refused by the parent.
pub(crate) fn plausible(page: &PageText, index: u32) -> bool {
    let finite = |r: &PtRect| {
        [r.x, r.y, r.w, r.h]
            .iter()
            .all(|n| n.is_finite() && n.abs() < 1e7)
            && r.w >= 0.0
            && r.h >= 0.0
    };
    page.page == index
        && page.width.is_finite()
        && page.height.is_finite()
        && page.body_size.is_finite()
        && (0.0..2_000.0).contains(&page.body_size)
        && page.lines.len() <= limits::MAX_SMART_LINES_PER_PAGE
        && page.lines.iter().all(|line| {
            line.runs.len() <= limits::MAX_SMART_RUNS_PER_LINE
                && finite(&line.rect)
                && line.runs.iter().all(|run| {
                    run.text.chars().count() <= limits::MAX_SMART_RUN_CHARS + 1
                        && finite(&run.rect)
                        && run.size.is_finite()
                        && run.size > 0.0
                        && run.size < 2_000.0
                        && run.baseline.is_finite()
                })
        })
        && page
            .lines
            .iter()
            .flat_map(|l| &l.runs)
            .map(|r| r.text.chars().count())
            .sum::<usize>()
            <= limits::MAX_SMART_CHARS_PER_PAGE * 2
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ch(c: char, x: f32, y: f32, size: f32, baseline: f32) -> Item {
        Item::Char(RawChar {
            c,
            rect: Rect {
                x,
                y,
                w: size * 0.5,
                h: size,
            },
            size,
            baseline,
            bold: false,
        })
    }

    fn word(s: &str, x: f32, y: f32, size: f32, baseline: f32) -> Vec<Item> {
        s.chars()
            .enumerate()
            .map(|(i, c)| ch(c, x + i as f32 * size * 0.5, y, size, baseline))
            .collect()
    }

    #[test]
    fn a_raised_marker_is_a_run_of_its_own_and_the_space_stays_with_the_larger_run() {
        let mut items = word("claim", 50.0, 100.0, 10.0, 110.0);
        items.extend(word("1", 75.0, 98.0, 6.0, 105.0));
        items.push(Item::Space);
        items.extend(word("goes", 82.0, 100.0, 10.0, 110.0));
        items.push(Item::Break);
        items.extend(word("2", 50.0, 700.0, 6.0, 706.0));
        items.extend(word("note", 56.0, 700.0, 6.0, 706.0));
        let page = build_page(items, 4, 600.0, 800.0);
        assert_eq!(page.page, 4);
        assert_eq!(page.lines.len(), 2);
        let texts: Vec<&str> = page.lines[0].runs.iter().map(|r| r.text.as_str()).collect();
        assert_eq!(texts, ["claim", "1", " goes"]);
        assert!(page.lines[0].runs[1].baseline < page.lines[0].runs[0].baseline);
        assert_eq!(
            page.lines[1].runs.len(),
            1,
            "same size and baseline is one run"
        );
        assert_eq!(page.lines[1].runs[0].text, "2note");
        assert_eq!(page.body_size, 10.0);
        assert!(page.lines[0].rect.w >= page.lines[0].runs[0].rect.w);
    }

    #[test]
    fn spaces_inside_a_run_stay_and_empty_lines_are_not_kept() {
        let mut items = vec![Item::Space, Item::Break, Item::Break];
        items.extend(word("a", 0.0, 0.0, 10.0, 8.0));
        items.push(Item::Space);
        items.extend(word("b", 6.0, 0.0, 10.0, 8.0));
        let page = build_page(items, 0, 100.0, 100.0);
        assert_eq!(page.lines.len(), 1);
        assert_eq!(page.lines[0].runs[0].text, "a b");
    }

    #[test]
    fn hostile_sizes_and_boxes_count_as_nothing() {
        let bad = [f32::NAN, f32::INFINITY, 0.0, -3.0, 5_000.0];
        let mut items = Vec::new();
        for (i, size) in bad.into_iter().enumerate() {
            items.push(ch('x', i as f32, 0.0, size, 5.0));
        }
        items.push(ch('y', 0.0, 0.0, 10.0, f32::NAN));
        items.push(Item::Char(RawChar {
            c: 'z',
            rect: Rect {
                x: f32::NAN,
                y: 0.0,
                w: 1.0,
                h: 1.0,
            },
            size: 10.0,
            baseline: 5.0,
            bold: false,
        }));
        let page = build_page(items, 0, 10.0, 10.0);
        assert!(page.lines.is_empty());
        assert_eq!(page.body_size, 0.0);
    }

    #[test]
    fn the_limits_bound_lines_runs_and_characters() {
        let mut items = Vec::new();
        for n in 0..(limits::MAX_SMART_LINES_PER_PAGE + 50) {
            items.extend(word("ab", 0.0, n as f32, 10.0, n as f32 + 8.0));
            items.push(Item::Break);
        }
        let page = build_page(items, 0, 10.0, 10.0);
        assert_eq!(page.lines.len(), limits::MAX_SMART_LINES_PER_PAGE);
        assert!(plausible(&page, 0));

        // Alternating sizes make a run per character.
        let mut items = Vec::new();
        for n in 0..(limits::MAX_SMART_RUNS_PER_LINE * 3) {
            let size = if n % 2 == 0 { 10.0 } else { 6.0 };
            items.push(ch('q', n as f32, 0.0, size, 8.0));
        }
        let page = build_page(items, 0, 10.0, 10.0);
        assert_eq!(page.lines[0].runs.len(), limits::MAX_SMART_RUNS_PER_LINE);

        // One long run is cut.
        let long: Vec<Item> = (0..limits::MAX_SMART_RUN_CHARS + 500)
            .map(|n| ch('w', n as f32, 0.0, 10.0, 8.0))
            .collect();
        let page = build_page(long, 0, 10.0, 10.0);
        assert_eq!(
            page.lines[0].runs[0].text.chars().count(),
            limits::MAX_SMART_RUN_CHARS
        );
    }

    #[test]
    fn a_wide_gap_splits_the_run_and_a_space_joins_the_larger_side() {
        let mut items = word("Einleitung", 50.0, 100.0, 10.0, 110.0);
        items.extend(word("12", 450.0, 100.0, 10.0, 110.0));
        let page = build_page(items, 0, 600.0, 800.0);
        let texts: Vec<&str> = page.lines[0].runs.iter().map(|r| r.text.as_str()).collect();
        assert_eq!(texts, ["Einleitung", " 12"]);
    }

    #[test]
    fn the_body_size_is_the_one_most_characters_have_and_the_smaller_on_a_tie() {
        let mut items = word("aaaa", 0.0, 0.0, 10.0, 8.0);
        items.push(Item::Break);
        items.extend(word("bbbb", 0.0, 20.0, 8.0, 28.0));
        assert_eq!(build_page(items, 0, 1.0, 1.0).body_size, 8.0);
    }

    #[test]
    fn a_reply_over_the_limits_or_not_finite_is_not_plausible() {
        let page = build_page(word("abc", 0.0, 0.0, 10.0, 8.0), 2, 10.0, 10.0);
        assert!(plausible(&page, 2));
        assert!(!plausible(&page, 3));
        let mut bad = page.clone();
        bad.lines[0].runs[0].baseline = f32::NAN;
        assert!(!plausible(&bad, 2));
        let mut bad = page.clone();
        bad.lines[0].runs[0].text = "x".repeat(limits::MAX_SMART_RUN_CHARS + 2);
        assert!(!plausible(&bad, 2));
        let mut bad = page.clone();
        bad.lines = vec![bad.lines[0].clone(); limits::MAX_SMART_LINES_PER_PAGE + 1];
        assert!(!plausible(&bad, 2));
        let mut bad = page;
        bad.body_size = f32::INFINITY;
        assert!(!plausible(&bad, 2));
    }
}
