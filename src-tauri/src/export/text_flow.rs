//! "Save as text PDF" (F19.22, ADR-143), part 1: the recognized lines of the pages as flowing blocks. Headings, body paragraphs and
//! small print are told apart by the recognized size of a line against the body size of the whole document (the size most characters
//! have); heading sizes are clustered into at most three levels. Paragraphs end at a larger gap, a first-line indent, a short line
//! that ends a sentence, or a jump back up the page. A word hyphenated at a line end is joined again. No columns, no tables: the lines
//! are taken in the order the page gives them.
//!
//! Pure: the lines come from an OCR layer or the engine's reading of the page (`commands::text_pdf`), the blocks go to
//! `pdfwrite::text_pdf`. Every text here came from a hostile file or an untrusted recognizer, so it is only cleaned and counted.

use crate::limits;

/// One line of a page as it was recognized: its text, its size (the line's height, points), its box `[x0, y0, x1, y1]` (points, y
/// down) and whether all of it is bold (the engine knows; OCR never says).
#[derive(Debug, Clone, PartialEq)]
pub struct SourceLine {
    pub text: String,
    pub size: f32,
    pub rect: [f32; 4],
    pub bold: bool,
}

/// The lines of one page in reading order.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct SourcePage {
    pub lines: Vec<SourceLine>,
}

/// What a block is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum BlockKind {
    /// Level 1 (largest) to 3.
    Heading(u8),
    Body,
    /// Footnotes, captions: clearly smaller than the body.
    Small,
}

/// A paragraph or a heading.
#[derive(Debug, Clone, PartialEq)]
pub struct Block {
    pub kind: BlockKind,
    pub text: String,
}

/// The blocks of each page (in page order), and whether text was left out at `limits::TEXT_PDF_CHARS_MAX`.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Flow {
    pub pages: Vec<Vec<Block>>,
    pub truncated: bool,
}

/// A line this much larger than the body (or more) is a heading; this much smaller (or less) is small print.
const HEADING_RATIO: f32 = 1.2;
const SMALL_RATIO: f32 = 0.85;
/// Heading sizes within this ratio of the largest of their group are one level.
const LEVEL_RATIO: f32 = 0.9;
/// Longest line that can be a heading (characters); a bold body-size line up to this length counts as the lowest heading level.
const HEADING_CHARS_MAX: usize = 200;
const BOLD_HEADING_CHARS_MAX: usize = 80;
/// A gap this many sizes above the page's usual line gap starts a paragraph; an indent this many sizes, too.
const PARAGRAPH_GAP_SIZES: f32 = 0.5;
const INDENT_SIZES: f32 = 1.2;
/// A line shorter than this fraction of the text column that ends a sentence ends its paragraph.
const SHORT_LINE: f32 = 0.85;

/// A line, cleaned and measured.
#[derive(Debug, Clone)]
struct Clean {
    text: String,
    size: f32,
    rect: [f32; 4],
    bold: bool,
    chars: usize,
}

/// Control characters out, any run of white space one space, trimmed.
fn clean_text(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut space = false;
    for c in text.chars() {
        if c.is_whitespace() || c == '\u{200B}' {
            space = !out.is_empty();
            continue;
        }
        if c.is_control() || matches!(c, '\u{FEFF}' | '\u{FFFD}') {
            continue;
        }
        if space {
            out.push(' ');
            space = false;
        }
        out.push(c);
    }
    out
}

fn clean_page(page: &SourcePage) -> Vec<Clean> {
    page.lines
        .iter()
        .take(limits::MAX_SMART_LINES_PER_PAGE)
        .filter_map(|line| {
            let ok = line.size.is_finite()
                && line.size > 0.0
                && line.rect.iter().all(|v| v.is_finite())
                && line.rect[2] >= line.rect[0]
                && line.rect[3] >= line.rect[1];
            if !ok {
                return None;
            }
            let text = clean_text(&line.text);
            let chars = text.chars().count();
            (chars > 0).then_some(Clean {
                text,
                size: line.size.min(1_000.0),
                rect: line.rect,
                bold: line.bold,
                chars,
            })
        })
        .collect()
}

/// The size most characters have, in half points; the smaller one on a tie.
fn body_size(pages: &[Vec<Clean>]) -> f32 {
    let mut counts: std::collections::BTreeMap<u32, usize> = std::collections::BTreeMap::new();
    for line in pages.iter().flatten() {
        // Sizes are at most 1 000 (clean_page), so the half-point bucket fits.
        let bucket = (line.size * 2.0).round() as u32;
        *counts.entry(bucket).or_default() += line.chars;
    }
    let mut best: Option<(u32, usize)> = None;
    for (bucket, count) in counts {
        if best.is_none_or(|(_, n)| count > n) {
            best = Some((bucket, count));
        }
    }
    best.map_or(0.0, |(bucket, _)| bucket as f32 / 2.0)
}

/// The level of every heading size: sorted from the largest, a size within [`LEVEL_RATIO`] of the first of its group joins it, three
/// groups at most (the rest are level 3).
fn heading_levels(mut sizes: Vec<f32>) -> Vec<(f32, u8)> {
    sizes.sort_by(|a, b| b.total_cmp(a));
    sizes.dedup();
    let mut out = Vec::with_capacity(sizes.len());
    let mut level = 0u8;
    let mut group_top = f32::INFINITY;
    for size in sizes {
        if size < group_top * LEVEL_RATIO {
            level = (level + 1).min(3);
            group_top = size;
        }
        out.push((size, level));
    }
    out
}

/// A page number or a running number alone on the first or last line: digits (or a short roman numeral) with dashes around.
fn is_page_number(text: &str) -> bool {
    let core = text.trim_matches(|c: char| matches!(c, '-' | '–' | '—' | ' ' | '.'));
    let digits = !core.is_empty() && core.len() <= 6 && core.chars().all(|c| c.is_ascii_digit());
    let roman = !core.is_empty()
        && core.len() <= 6
        && core.chars().all(|c| "ivxlcIVXLC".contains(c))
        && core.chars().all(|c| c.is_ascii_lowercase());
    digits || roman
}

fn ends_sentence(text: &str) -> bool {
    text.trim_end().chars().last().is_some_and(|c| {
        matches!(
            c,
            '.' | '!' | '?' | ':' | '"' | '\u{201C}' | '\u{201D}' | '\u{00BB}' | '\u{00AB}' | ')'
        )
    })
}

fn starts_lowercase(text: &str) -> bool {
    text.chars().next().is_some_and(char::is_lowercase)
}

/// Appends a line to a block's text: a word hyphenated at the line end is joined again when the next line goes on in lower case.
fn join(into: &mut String, next: &str) {
    if into.is_empty() {
        into.push_str(next);
        return;
    }
    let mut tail = into.chars().rev();
    let last = tail.next();
    let before = tail.next();
    let hyphen = matches!(last, Some('-' | '\u{00AD}' | '\u{2010}'));
    if hyphen && before.is_some_and(char::is_alphabetic) && starts_lowercase(next) {
        into.pop();
        into.push_str(next);
        return;
    }
    if last == Some('\u{00AD}') {
        into.pop();
    }
    into.push(' ');
    into.push_str(next);
}

/// The median of `values` (0 for none).
fn median(mut values: Vec<f32>) -> f32 {
    values.sort_by(f32::total_cmp);
    values.get(values.len() / 2).copied().unwrap_or(0.0)
}

/// The blocks of `pages`. With `join_pages`, a paragraph that runs over a page break (the page's last body text does not end a
/// sentence and the next page goes on in lower case) is one block, on the earlier page.
pub fn flow(pages: &[SourcePage], join_pages: bool) -> Flow {
    let mut cleaned: Vec<Vec<Clean>> = pages.iter().map(clean_page).collect();
    // Running page numbers out: alone on the first or the last line of a page with more lines.
    for lines in &mut cleaned {
        if lines.len() > 2 {
            if lines.last().is_some_and(|l| is_page_number(&l.text)) {
                lines.pop();
            }
            if lines.first().is_some_and(|l| is_page_number(&l.text)) {
                lines.remove(0);
            }
        }
    }
    let body = body_size(&cleaned);
    let is_heading_size = |line: &Clean| {
        body > 0.0 && line.size >= body * HEADING_RATIO && line.chars <= HEADING_CHARS_MAX
    };
    let levels = heading_levels(
        cleaned
            .iter()
            .flatten()
            .filter(|l| is_heading_size(l))
            .map(|l| l.size)
            .collect(),
    );
    let kind_of = |line: &Clean| -> BlockKind {
        if is_heading_size(line) {
            let level = levels
                .iter()
                .find(|(size, _)| *size == line.size)
                .map_or(3, |(_, level)| *level);
            return BlockKind::Heading(level.clamp(1, 3));
        }
        if line.bold
            && line.chars <= BOLD_HEADING_CHARS_MAX
            && line.size >= body * SMALL_RATIO
            && !ends_sentence(&line.text)
        {
            return BlockKind::Heading(3);
        }
        if body > 0.0 && line.size <= body * SMALL_RATIO {
            return BlockKind::Small;
        }
        BlockKind::Body
    };

    let mut out = Flow::default();
    let mut budget = limits::TEXT_PDF_CHARS_MAX;
    for lines in &cleaned {
        let mut blocks: Vec<Block> = Vec::new();
        let kinds: Vec<BlockKind> = lines.iter().map(kind_of).collect();
        // The page's usual gap between two lines of one kind, and its text column.
        let usual_gap = median(
            lines
                .windows(2)
                .zip(kinds.windows(2))
                .filter(|(_, k)| k[0] == k[1])
                .map(|(l, _)| l[1].rect[1] - l[0].rect[3])
                .filter(|gap| gap.is_finite())
                .collect(),
        );
        let left = lines
            .iter()
            .map(|l| l.rect[0])
            .fold(f32::INFINITY, f32::min);
        let right = lines
            .iter()
            .map(|l| l.rect[2])
            .fold(f32::NEG_INFINITY, f32::max);
        let column = (right - left).max(1.0);
        let mut previous: Option<(&Clean, BlockKind)> = None;
        for (line, &kind) in lines.iter().zip(&kinds) {
            if budget == 0 {
                out.truncated = true;
                break;
            }
            let text: String = if line.chars > budget {
                out.truncated = true;
                line.text.chars().take(budget).collect()
            } else {
                line.text.clone()
            };
            budget = budget.saturating_sub(line.chars);
            let same_block = previous.is_some_and(|(prev, prev_kind)| {
                if prev_kind != kind {
                    return false;
                }
                let size = prev.size.max(line.size);
                let gap = line.rect[1] - prev.rect[3];
                if gap > usual_gap.max(0.0) + PARAGRAPH_GAP_SIZES * size
                    || line.rect[1] < prev.rect[1] - size
                {
                    return false;
                }
                if let BlockKind::Heading(_) = kind {
                    return true;
                }
                let indented = line.rect[0] - prev.rect[0] > INDENT_SIZES * size;
                let short_end =
                    prev.rect[2] - left < SHORT_LINE * column && ends_sentence(&prev.text);
                !indented && !short_end
            });
            match blocks.last_mut() {
                Some(block) if same_block => join(&mut block.text, &text),
                _ => blocks.push(Block { kind, text }),
            }
            previous = Some((line, kind));
        }
        if join_pages {
            let carries = blocks.first().is_some_and(|first| {
                first.kind == BlockKind::Body && starts_lowercase(&first.text)
            });
            let open = out
                .pages
                .iter_mut()
                .rev()
                .find(|page| !page.is_empty())
                .and_then(|page| page.last_mut())
                .filter(|last| last.kind == BlockKind::Body && !ends_sentence(&last.text));
            if let (true, Some(last)) = (carries, open) {
                let first = blocks.remove(0);
                join(&mut last.text, &first.text);
            }
        }
        out.pages.push(blocks);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A line at `y` (top), `size` high, from `x0` to `x1`.
    fn line(text: &str, size: f32, y: f32, x0: f32, x1: f32) -> SourceLine {
        SourceLine {
            text: text.to_owned(),
            size,
            rect: [x0, y, x1, y + size],
            bold: false,
        }
    }

    fn body(text: &str, y: f32) -> SourceLine {
        line(text, 10.0, y, 50.0, 500.0)
    }

    #[test]
    fn headings_by_size_cluster_into_levels_and_body_is_the_common_size() {
        let page = SourcePage {
            lines: vec![
                line("Big Title", 24.0, 40.0, 50.0, 300.0),
                line("Section One", 15.0, 80.0, 50.0, 200.0),
                body(
                    "The body text runs on and on across the whole column",
                    110.0,
                ),
                body(
                    "and keeps going here with more words in the paragraph.",
                    123.0,
                ),
                line("Subsection", 14.0, 150.0, 50.0, 200.0),
                body(
                    "More body text that fills the line to the right edge.",
                    175.0,
                ),
                line("1 A footnote in small print.", 7.0, 700.0, 50.0, 300.0),
            ],
        };
        let flow = flow(&[page], false);
        let kinds: Vec<BlockKind> = flow.pages[0].iter().map(|b| b.kind).collect();
        assert_eq!(
            kinds,
            [
                BlockKind::Heading(1),
                BlockKind::Heading(2),
                BlockKind::Body,
                BlockKind::Heading(2),
                BlockKind::Body,
                BlockKind::Small
            ]
        );
        assert_eq!(
            flow.pages[0][2].text,
            "The body text runs on and on across the whole column and keeps going here with more words in the paragraph."
        );
        assert!(!flow.truncated);
    }

    #[test]
    fn paragraphs_split_at_gaps_indents_and_short_sentence_ends() {
        let page = SourcePage {
            lines: vec![
                body(
                    "First paragraph line one that is long enough to fill",
                    100.0,
                ),
                line("the column. Short end.", 10.0, 113.0, 50.0, 200.0),
                body(
                    "Second paragraph begins here and runs to the edge of",
                    126.0,
                ),
                body("the column again, then a big gap follows this line,", 139.0),
                body(
                    "Third paragraph after the gap goes on to the right side",
                    170.0,
                ),
                line(
                    "Indented fourth paragraph starts here with more text",
                    10.0,
                    183.0,
                    80.0,
                    500.0,
                ),
            ],
        };
        let flow = flow(&[page], false);
        let texts: Vec<&str> = flow.pages[0].iter().map(|b| b.text.as_str()).collect();
        assert_eq!(texts.len(), 4, "{texts:?}");
        assert!(texts[0].ends_with("Short end."));
        assert!(texts[1].starts_with("Second") && texts[1].ends_with("this line,"));
        assert!(texts[2].starts_with("Third"));
        assert!(texts[3].starts_with("Indented"));
    }

    #[test]
    fn hyphenated_words_join_and_page_numbers_go() {
        let page = SourcePage {
            lines: vec![
                line("12", 10.0, 20.0, 290.0, 300.0),
                body("A word that is hyphen-", 100.0),
                body("ated across lines, and a dash - stays.", 113.0),
                body("Ok", 126.0),
                line("- 13 -", 10.0, 800.0, 280.0, 310.0),
            ],
        };
        let flow = flow(&[page], false);
        assert_eq!(flow.pages[0].len(), 1);
        assert_eq!(
            flow.pages[0][0].text,
            "A word that is hyphenated across lines, and a dash - stays. Ok"
        );
    }

    #[test]
    fn a_paragraph_over_a_page_break_is_joined_only_when_asked() {
        let one = SourcePage {
            lines: vec![
                body("The sentence starts on the first page and goes", 100.0),
                body("on to the very end of the first page without a", 113.0),
            ],
        };
        let two = SourcePage {
            lines: vec![
                body("break where the paragraph goes on and", 100.0),
                body("ends here on the second page.", 113.0),
                body("A new paragraph on the second page starts here", 150.0),
                body("and continues on this line", 163.0),
            ],
        };
        let joined = flow(&[one.clone(), two.clone()], true);
        assert_eq!(joined.pages[0].len(), 1);
        assert!(joined.pages[0][0].text.ends_with(
            "without a break where the paragraph goes on and ends here on the second page."
        ));
        assert_eq!(joined.pages[1].len(), 1);
        let apart = flow(&[one, two], false);
        assert_eq!(apart.pages[1].len(), 2);
    }

    #[test]
    fn hostile_lines_are_cleaned_or_dropped() {
        let page = SourcePage {
            lines: vec![
                line("bad", f32::NAN, 10.0, 0.0, 10.0),
                line("  \u{0007}tab\there\u{FEFF}  ", 10.0, 20.0, 0.0, 100.0),
                SourceLine {
                    text: "inverted".into(),
                    size: 10.0,
                    rect: [10.0, 10.0, 0.0, 0.0],
                    bold: false,
                },
                line("   ", 10.0, 40.0, 0.0, 100.0),
                line("huge", 1.0e30, 60.0, 0.0, 100.0),
            ],
        };
        let flow = flow(&[page], false);
        let texts: Vec<&str> = flow.pages[0].iter().map(|b| b.text.as_str()).collect();
        assert_eq!(texts, ["tab here", "huge"]);
        assert!(matches!(flow.pages[0][1].kind, BlockKind::Heading(_)));
    }

    #[test]
    fn the_character_budget_is_enforced() {
        let page = SourcePage {
            lines: (0..limits::MAX_SMART_LINES_PER_PAGE)
                .map(|n| body(&"x".repeat(10_000), n as f32 * 13.0))
                .collect(),
        };
        let pages = vec![page; 5];
        let flow = flow(&pages, false);
        let total: usize = flow
            .pages
            .iter()
            .flatten()
            .map(|b| b.text.chars().count())
            .sum();
        assert!(flow.truncated);
        // The budget counts the recognized characters; the spaces that join lines come on top.
        assert!(total <= limits::TEXT_PDF_CHARS_MAX + 5 * limits::MAX_SMART_LINES_PER_PAGE);
    }

    #[test]
    fn bold_short_lines_are_headings_and_no_text_is_no_blocks() {
        let mut heading = body("Introduction", 80.0);
        heading.bold = true;
        let page = SourcePage {
            lines: vec![heading, body("Body text follows here.", 100.0)],
        };
        let flow = flow(&[page, SourcePage::default()], false);
        assert_eq!(flow.pages[0][0].kind, BlockKind::Heading(3));
        assert!(flow.pages[1].is_empty());
    }
}
