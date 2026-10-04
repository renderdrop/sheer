//! An outline derived from the look of the text, for a document without bookmarks (ADR-113, DESIGN §3.5 B8).
//!
//! The text of the pages is read line by line with the size of its characters. The body size is the size most characters have;
//! the sizes larger than it, from the largest, are the heading levels (at most three), and a line that is bold as a whole and
//! short is a heading one level below the smallest size. Lines that look like a running header or footer (the same text, digits
//! aside, at the same height on three pages or more) and page numbers are not headings; consecutive lines of one heading are one
//! entry. At most [`limits::MAX_DERIVED_ENTRIES`] entries are made.
//!
//! The file is hostile: the pages read, the characters read (per page and in all), the lines kept and the time are all bounded, and
//! what is not reached in time is left out; the entries made from what was read are still answered.

use std::collections::HashMap;
use std::time::Instant;

use pdfium_render::prelude::*;

use super::outline::OutlineItem;
use super::space::{load_page, page_box, PageSpot};
use super::text::{char_box, text_chars};
use crate::documents::sanitize_text;
use crate::limits;

/// One line of text of a page.
#[derive(Debug, Clone, PartialEq)]
struct Line {
    page: u32,
    /// Distance of the line's top from the page's top, in points.
    y: f32,
    /// The size most of its characters have, in half points.
    size: i32,
    bold: bool,
    text: String,
}

/// What was read of the document.
#[derive(Debug, Default)]
struct Reading {
    lines: Vec<Line>,
    /// Characters (no white space) by size in half points.
    sizes: HashMap<i32, u64>,
    chars: u64,
    bold_chars: u64,
    pages: u32,
}

/// Which look makes a line a heading: a size larger than the body's, or bold at the body's size.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Class {
    /// A size in half points.
    Size(i32),
    BoldBody,
}

fn size_key(points: f32) -> Option<i32> {
    (points.is_finite() && points > 0.0 && points < 2_000.0).then(|| (points * 2.0).round() as i32)
}

/// Reads one page into `reading`. `false` when a limit was reached and the reading ends.
fn read_page(
    document: &PdfDocument<'_>,
    index: u32,
    reading: &mut Reading,
    started: Instant,
) -> bool {
    let Ok(page) = load_page(document, index) else {
        return true;
    };
    let Ok(page_box) = page_box(&page) else {
        return true;
    };
    let Ok(text_page) = page.text() else {
        return true;
    };
    let characters = text_page.chars();

    let mut text = String::new();
    let mut sizes: Vec<(i32, u32)> = Vec::new();
    let mut first: Option<usize> = None;
    let mut page_lines = 0usize;
    let mut read = 0usize;

    // `flush` closes the current line.
    let mut lines: Vec<Line> = Vec::new();
    let flush = |text: &mut String,
                 sizes: &mut Vec<(i32, u32)>,
                 first: &mut Option<usize>,
                 reading: &mut Reading,
                 lines: &mut Vec<Line>| {
        let start = first.take();
        let sizes_here = std::mem::take(sizes);
        let line = std::mem::take(text);
        let trimmed = line.trim();
        let (Some(start), Some(&(size, _))) = (
            start,
            sizes_here
                .iter()
                .max_by_key(|&&(size, count)| (count, size)),
        ) else {
            return;
        };
        if trimmed.is_empty() {
            return;
        }
        let Ok(character) = characters.get(start) else {
            return;
        };
        let weight_bold = matches!(
            character.font_weight(),
            Some(PdfFontWeight::Weight600)
                | Some(PdfFontWeight::Weight700Bold)
                | Some(PdfFontWeight::Weight800)
                | Some(PdfFontWeight::Weight900)
        ) || matches!(character.font_weight(), Some(PdfFontWeight::Custom(w)) if (600..=1_000).contains(&w));
        let name = character.font_name().to_lowercase();
        let bold = weight_bold
            || character.font_is_bold_reenforced()
            || ["bold", "black", "heavy"]
                .iter()
                .any(|word| name.contains(word));
        let rect = char_box(&characters, start, page_box);
        lines.push(Line {
            page: index,
            y: rect.y,
            size,
            bold,
            text: trimmed.to_owned(),
        });
        if bold {
            reading.bold_chars += trimmed.chars().filter(|c| !c.is_whitespace()).count() as u64;
        }
    };

    for character in text_chars(&characters) {
        read += 1;
        reading.chars += 1;
        if read > limits::MAX_DERIVED_CHARS_PER_PAGE
            || reading.chars > limits::MAX_DERIVED_CHARS as u64
            || (read.is_multiple_of(4096) && started.elapsed() > limits::DERIVED_OUTLINE_BUDGET)
        {
            flush(&mut text, &mut sizes, &mut first, reading, &mut lines);
            reading.lines.append(&mut lines);
            return reading.chars <= limits::MAX_DERIVED_CHARS as u64
                && started.elapsed() <= limits::DERIVED_OUTLINE_BUDGET;
        }
        if matches!(character.c, '\n' | '\r') {
            flush(&mut text, &mut sizes, &mut first, reading, &mut lines);
            page_lines += 1;
            if page_lines >= limits::MAX_DERIVED_LINES_PER_PAGE {
                break;
            }
            continue;
        }
        if character.c.is_whitespace() {
            if !text.is_empty() && !text.ends_with(' ') {
                text.push(' ');
            }
            continue;
        }
        let Ok(c) = characters.get(character.first) else {
            continue;
        };
        let Some(size) = size_key(c.scaled_font_size().value) else {
            continue;
        };
        first.get_or_insert(character.first);
        if text.chars().count() < limits::MAX_DERIVED_TITLE_CHARS * 4 {
            text.push(character.c);
        }
        match sizes.iter_mut().find(|(known, _)| *known == size) {
            Some((_, count)) => *count += 1,
            None => sizes.push((size, 1)),
        }
        *reading.sizes.entry(size).or_insert(0) += 1;
    }
    flush(&mut text, &mut sizes, &mut first, reading, &mut lines);
    lines.truncate(limits::MAX_DERIVED_LINES_PER_PAGE);
    reading.lines.append(&mut lines);
    reading.lines.len() < limits::MAX_DERIVED_LINES
}

/// A number alone, a Roman numeral alone, "Page 3 of 10": no heading.
fn is_page_number(text: &str) -> bool {
    let lower = text.to_lowercase();
    let rest: Vec<&str> = lower
        .split(|c: char| c.is_whitespace() || matches!(c, '/' | '-' | '\u{2013}' | '.' | '(' | ')'))
        .filter(|word| {
            !word.is_empty() && !matches!(*word, "page" | "pages" | "seite" | "von" | "of")
        })
        .collect();
    rest.iter()
        .all(|word| word.chars().all(|c| c.is_ascii_digit()) || is_roman(word))
}

/// A Roman numeral (written as the rules have it, so that "civil" and "mild" are words).
fn is_roman(word: &str) -> bool {
    const SYMBOLS: [(&str, u32); 13] = [
        ("m", 1000),
        ("cm", 900),
        ("d", 500),
        ("cd", 400),
        ("c", 100),
        ("xc", 90),
        ("l", 50),
        ("xl", 40),
        ("x", 10),
        ("ix", 9),
        ("v", 5),
        ("iv", 4),
        ("i", 1),
    ];
    if word.is_empty() || word.len() > 8 || !word.chars().all(|c| "ivxlcdm".contains(c)) {
        return false;
    }
    let mut rest = word;
    let mut value = 0u32;
    let mut written = String::new();
    // Greedy parse; the numeral is valid when writing the value back gives the same word.
    for (symbol, n) in SYMBOLS {
        while let Some(after) = rest.strip_prefix(symbol) {
            rest = after;
            value += n;
        }
    }
    if !rest.is_empty() || value == 0 || value >= 4000 {
        return false;
    }
    let mut left = value;
    for (symbol, n) in SYMBOLS {
        while left >= n {
            written.push_str(symbol);
            left -= n;
        }
    }
    written == word
}

/// The text with its digits made alike, to find the same running header on every page.
fn repeat_key(text: &str, y: f32) -> (String, i32) {
    let normal: String = text
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_digit() { '#' } else { c })
        .collect();
    (normal, (y / 4.0).round() as i32)
}

fn one_line(raw: &str) -> String {
    let flat = raw.replace(['\r', '\n', '\t'], " ");
    sanitize_text(flat.trim(), limits::MAX_DERIVED_TITLE_CHARS)
        .trim()
        .to_owned()
}

struct Entry {
    level: u8,
    title: String,
    page: u32,
    y: f32,
    /// The class and the last line's top, for the merge of the next line.
    class: Class,
    last_y: f32,
    size: i32,
}

/// The entries of a reading, flat, in document order.
fn entries(reading: &Reading) -> Vec<Entry> {
    // The body size: the one most characters have (the smaller one on a tie).
    let Some((&body, _)) = reading
        .sizes
        .iter()
        .max_by_key(|&(&size, &count)| (count, std::cmp::Reverse(size)))
    else {
        return Vec::new();
    };

    // Running headers and footers: the same text at the same height on three pages or more.
    let mut repeats: HashMap<(String, i32), (u32, u32)> = HashMap::new();
    for line in &reading.lines {
        let slot = repeats
            .entry(repeat_key(&line.text, line.y))
            .or_insert((line.page, 0));
        if slot.1 == 0 || slot.0 != line.page {
            slot.0 = line.page;
            slot.1 += 1;
        }
    }
    let bold_ok = reading.bold_chars * 2 <= reading.chars;
    let class_of = |line: &Line| -> Option<Class> {
        let chars = line.text.chars().count();
        if !line.text.chars().any(char::is_alphabetic) || is_page_number(&line.text) {
            return None;
        }
        if repeats
            .get(&repeat_key(&line.text, line.y))
            .is_some_and(|&(_, pages)| pages >= 3)
        {
            return None;
        }
        if line.size >= body + 2 && chars <= limits::MAX_DERIVED_TITLE_CHARS * 2 {
            Some(Class::Size(line.size))
        } else if bold_ok
            && line.bold
            && line.size >= body
            && chars <= 80
            && !line.text.ends_with(['.', ',', ';', ':'])
        {
            Some(Class::BoldBody)
        } else {
            None
        }
    };

    let classified: Vec<(&Line, Option<Class>)> = reading
        .lines
        .iter()
        .map(|line| (line, class_of(line)))
        .collect();

    // The levels: the largest sizes first, at most three.
    let mut classes: Vec<Class> = classified.iter().filter_map(|&(_, class)| class).collect();
    classes.sort_by(|a, b| b.cmp(a));
    classes.dedup();
    // `Size` sorts below `BoldBody` in the derive order; bold at the body size is the lowest level.
    classes.sort_by_key(|class| match class {
        Class::Size(size) => (0, std::cmp::Reverse(*size)),
        Class::BoldBody => (1, std::cmp::Reverse(0)),
    });
    classes.truncate(usize::from(limits::MAX_DERIVED_LEVELS));

    let mut out: Vec<Entry> = Vec::new();
    for (line, class) in classified {
        let Some(class) = class else { continue };
        let Some(rank) = classes.iter().position(|&known| known == class) else {
            continue;
        };
        // Another line of the heading just above: the same class on the same page, one line height further down.
        if let Some(last) = out.last_mut() {
            let gap = line.y - last.last_y;
            if last.page == line.page
                && last.class == class
                && gap > 0.0
                // `size` is in half points: 0.8 of it is 1.6 lines.
                && gap <= f32::from(i16::try_from(last.size).unwrap_or(0)) * 0.8
                && last.title.chars().count() < limits::MAX_DERIVED_TITLE_CHARS
            {
                last.title.push(' ');
                last.title.push_str(&line.text);
                last.last_y = line.y;
                continue;
            }
        }
        out.push(Entry {
            level: rank as u8 + 1,
            title: line.text.clone(),
            page: line.page,
            y: line.y,
            class,
            last_y: line.y,
            size: line.size,
        });
    }
    out.retain(|entry| !one_line(&entry.title).is_empty());
    out.truncate(limits::MAX_DERIVED_ENTRIES);
    out
}

fn build(entries: &[Entry], position: &mut usize, min_level: u8) -> Vec<OutlineItem> {
    let mut items = Vec::new();
    while let Some(entry) = entries.get(*position) {
        if entry.level < min_level {
            break;
        }
        *position += 1;
        let children = build(entries, position, entry.level + 1);
        items.push(OutlineItem {
            title: one_line(&entry.title),
            target: Some(PageSpot {
                page_index: entry.page,
                y: entry.y.max(0.0),
            }),
            children,
            derived: true,
        });
    }
    items
}

/// The tree of a reading.
fn tree(reading: &Reading) -> Vec<OutlineItem> {
    build(&entries(reading), &mut 0, 1)
}

/// Derives the outline of `document` (`page_count` pages) from its text. Empty when nothing looks like a heading.
pub(super) fn derive_outline(document: &PdfDocument<'_>, page_count: u32) -> Vec<OutlineItem> {
    let started = Instant::now();
    let mut reading = Reading::default();
    for index in 0..page_count.min(limits::MAX_DERIVED_PAGES) {
        if !read_page(document, index, &mut reading, started) {
            break;
        }
        reading.pages += 1;
        if started.elapsed() > limits::DERIVED_OUTLINE_BUDGET {
            break;
        }
    }
    tree(&reading)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(page: u32, y: f32, size: f32, bold: bool, text: &str) -> Line {
        Line {
            page,
            y,
            size: size_key(size).unwrap(),
            bold,
            text: text.to_owned(),
        }
    }

    fn reading(lines: Vec<Line>) -> Reading {
        let mut reading = Reading::default();
        for line in &lines {
            let n = line.text.chars().filter(|c| !c.is_whitespace()).count() as u64;
            *reading.sizes.entry(line.size).or_insert(0) += n;
            reading.chars += n;
            if line.bold {
                reading.bold_chars += n;
            }
        }
        reading.lines = lines;
        reading
    }

    fn shape(items: &[OutlineItem]) -> Vec<(String, usize)> {
        items
            .iter()
            .map(|item| (item.title.clone(), item.children.len()))
            .collect()
    }

    const BODY: &str = "This is a long line of ordinary body text that has many characters in it.";

    #[test]
    fn sizes_above_the_body_make_three_levels_and_a_fourth_size_is_left_out() {
        let tree = tree(&reading(vec![
            line(0, 60.0, 30.0, false, "Title"),
            line(0, 100.0, 12.0, false, BODY),
            line(0, 120.0, 22.0, false, "Chapter"),
            line(0, 140.0, 12.0, false, BODY),
            line(0, 160.0, 17.0, false, "Section"),
            line(0, 180.0, 12.0, false, BODY),
            line(0, 200.0, 14.0, false, "Tiny heading"),
            line(0, 220.0, 12.0, false, BODY),
            line(1, 60.0, 22.0, false, "Second chapter"),
            line(1, 100.0, 12.0, false, BODY),
        ]));
        assert_eq!(shape(&tree), [("Title".to_owned(), 2)]);
        assert_eq!(
            shape(&tree[0].children),
            [("Chapter".to_owned(), 1), ("Second chapter".to_owned(), 0)]
        );
        assert_eq!(tree[0].children[0].children[0].title, "Section");
        assert!(tree.iter().all(|item| item.derived));
        let spot = tree[0].children[1].target.unwrap();
        assert_eq!((spot.page_index, spot.y), (1, 60.0));
    }

    #[test]
    fn consecutive_lines_of_a_heading_are_one_entry() {
        let tree = tree(&reading(vec![
            line(0, 60.0, 24.0, false, "A heading that"),
            line(0, 86.0, 24.0, false, "runs over two lines"),
            line(0, 140.0, 12.0, false, BODY),
            line(0, 160.0, 24.0, false, "Far away"),
        ]));
        assert_eq!(
            shape(&tree),
            [
                ("A heading that runs over two lines".to_owned(), 0),
                ("Far away".to_owned(), 0)
            ]
        );
    }

    #[test]
    fn running_headers_and_page_numbers_are_no_headings() {
        let mut lines = Vec::new();
        for page in 0..4 {
            lines.push(line(page, 20.0, 20.0, false, "Annual report 2024"));
            lines.push(line(page, 100.0, 12.0, false, BODY));
            lines.push(line(page, 760.0, 20.0, false, &format!("{}", page + 1)));
            lines.push(line(
                page,
                770.0,
                20.0,
                false,
                &format!("Page {} of 4", page + 1),
            ));
        }
        lines.push(line(1, 50.0, 20.0, false, "Real heading"));
        let tree = tree(&reading(lines));
        assert_eq!(shape(&tree), [("Real heading".to_owned(), 0)]);
        assert!(
            is_page_number("xiv") && is_page_number("- 12 -") && !is_page_number("Introduction")
        );
    }

    #[test]
    fn a_short_bold_line_at_body_size_is_the_lowest_level_unless_the_whole_text_is_bold() {
        let lines = vec![
            line(0, 60.0, 24.0, false, "Big"),
            line(0, 100.0, 12.0, false, BODY),
            line(0, 120.0, 12.0, true, "Bold lead"),
            line(0, 140.0, 12.0, false, BODY),
            line(0, 160.0, 12.0, true, "A bold sentence that ends."),
        ];
        let tree1 = tree(&reading(lines));
        assert_eq!(shape(&tree1), [("Big".to_owned(), 1)]);
        assert_eq!(tree1[0].children[0].title, "Bold lead");

        let all_bold: Vec<Line> = (0..6)
            .map(|n| {
                line(
                    0,
                    60.0 + 20.0 * n as f32,
                    12.0,
                    true,
                    "Bold body line of a bold document",
                )
            })
            .collect();
        assert!(tree(&reading(all_bold)).is_empty());
    }

    #[test]
    fn at_most_200_entries_and_titles_of_at_most_200_characters() {
        let mut lines = vec![line(0, 700.0, 12.0, false, BODY); 300];
        for n in 0..500u32 {
            lines.push(line(
                n % 50,
                60.0 + n as f32,
                20.0,
                false,
                &format!(
                    "Heading {}{}",
                    (b'a' + (n % 26) as u8) as char,
                    (b'a' + (n / 26) as u8) as char
                ),
            ));
        }
        lines.push(line(0, 5.0, 20.0, false, &"w".repeat(400)));
        let tree = tree(&reading(lines));
        assert_eq!(tree.len(), limits::MAX_DERIVED_ENTRIES);
        let mut long_lines = vec![line(0, 700.0, 12.0, false, BODY); 20];
        long_lines.push(line(0, 60.0, 20.0, false, &"w".repeat(300)));
        let long = entries(&reading(long_lines));
        assert!(one_line(&long[0].title).chars().count() <= limits::MAX_DERIVED_TITLE_CHARS);
    }

    #[test]
    fn nothing_that_looks_like_a_heading_is_an_empty_outline() {
        assert!(tree(&reading(vec![line(0, 60.0, 12.0, false, BODY)])).is_empty());
        assert!(tree(&Reading::default()).is_empty());
    }
}
