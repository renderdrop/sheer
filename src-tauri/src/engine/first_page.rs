//! What page 1 says about the work: a title, a year and a DOI (`Job::FirstPageHints`, ADR-119 item 6).
//!
//! The page's text is read line by line with the size of its characters (as `derived_outline` does, whose half-point size classes
//! are used here). The title is the run of lines in the largest size when that size is larger than the body's; the year is the first
//! four-digit number from 1900 to 2100 that stands near "(c)", "copyright", a month or in parentheses; the DOI is the first
//! `10.NNNN/suffix` without the punctuation that ends a sentence. There is no author rule: a conservative one does not exist, so
//! `authors` is left to the user. Nothing leaves the machine and nothing is looked up.
//!
//! The page is hostile input: at most [`limits::BIB_FIRST_PAGE_CHARS_MAX`] characters are read, within
//! [`limits::BIB_FIRST_PAGE_BUDGET`] (what was read by then is used), and a font size that is NaN, zero, negative or huge makes
//! no size at all. [`hints_from_lines`] is pure, so the rules are tested without PDFium.

use std::collections::HashMap;
use std::time::Instant;

use pdfium_render::prelude::*;

use super::imprint;
use super::space::{load_page, page_box, page_count};
use super::text::{char_box, text_chars};
use crate::documents::sanitize_text;
use crate::error::AppError;
use crate::limits;
use crate::model::bibliography::FirstPageHints;

/// One line of the page.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct Line {
    /// Distance of the line's top from the page's top, in points.
    pub y: f32,
    /// The size most of its characters have, in half points.
    pub size: i32,
    pub text: String,
}

/// Most characters of one line that are kept.
const LINE_CHARS_MAX: usize = 600;

/// Line size (half points) when a font reports none.
const UNKNOWN_SIZE: i32 = 20;

fn size_key(points: f32) -> Option<i32> {
    (points.is_finite() && points > 0.0 && points < 2_000.0).then(|| (points * 2.0).round() as i32)
}

/// Reads the pages that can name the work (the first eight, which hold the title page and an imprint, and the last two) and finds
/// the hints. `engine_index` is always read too.
pub(super) fn read_hints(
    document: &PdfDocument<'_>,
    engine_index: u32,
) -> Result<FirstPageHints, AppError> {
    let started = Instant::now();
    let count = page_count(document)?;
    let first = limits::validate_page_index(engine_index, count)?;
    let mut wanted: Vec<u32> = (0..count.min(8)).collect();
    wanted.extend(count.saturating_sub(2).max(8)..count);
    if !wanted.contains(&first) {
        wanted.push(first);
    }
    let mut pages = Vec::new();
    for index in wanted {
        if started.elapsed() > limits::BIB_FIRST_PAGE_BUDGET {
            break;
        }
        let Ok(page) = load_page(document, index) else {
            continue;
        };
        // A page without readable text is skipped: the others may still say enough.
        if let Some(lines) = read_lines(&page, started) {
            pages.push(imprint::PageLines {
                index: index as usize,
                lines,
            });
        }
    }
    Ok(imprint::hints_from_pages(&pages))
}

/// The lines of one page, within the character and time limits; `None` if the page has no readable text.
fn read_lines(page: &PdfPage<'_>, started: Instant) -> Option<Vec<Line>> {
    let page_box = page_box(page).ok()?;
    let text_page = page.text().ok()?;
    let characters = text_page.chars();

    let mut lines: Vec<Line> = Vec::new();
    let mut text = String::new();
    let mut kept = 0usize;
    let mut sizes: Vec<(i32, u32)> = Vec::new();
    let mut first: Option<usize> = None;
    let mut flush = |text: &mut String,
                     sizes: &mut Vec<(i32, u32)>,
                     first: &mut Option<usize>,
                     kept: &mut usize| {
        let start = first.take();
        let sizes_here = std::mem::take(sizes);
        let line = std::mem::take(text);
        *kept = 0;
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
        let y = char_box(&characters, start, page_box).y;
        lines.push(Line {
            y,
            size,
            text: trimmed.to_owned(),
        });
    };

    let mut read = 0usize;
    for character in text_chars(&characters) {
        read += 1;
        if read > limits::BIB_FIRST_PAGE_CHARS_MAX
            || (read.is_multiple_of(2048) && started.elapsed() > limits::BIB_FIRST_PAGE_BUDGET)
        {
            break;
        }
        if matches!(character.c, '\n' | '\r') {
            flush(&mut text, &mut sizes, &mut first, &mut kept);
            continue;
        }
        if character.c.is_whitespace() {
            if !text.is_empty() && !text.ends_with(' ') && kept < LINE_CHARS_MAX {
                text.push(' ');
                kept += 1;
            }
            continue;
        }
        let Ok(c) = characters.get(character.first) else {
            continue;
        };
        // A font that reports no usable size (some exported decks) still makes a line, at a neutral size.
        let size = size_key(c.scaled_font_size().value).unwrap_or(UNKNOWN_SIZE);
        first.get_or_insert(character.first);
        match sizes.iter_mut().find(|(known, _)| *known == size) {
            Some((_, n)) => *n += 1,
            None => sizes.push((size, 1)),
        }
        if kept < LINE_CHARS_MAX {
            text.push(character.c);
            kept += 1;
        }
    }
    flush(&mut text, &mut sizes, &mut first, &mut kept);
    Some(lines)
}

/// The hints of the lines of one page (the unit tests of the title, year and DOI rules).
#[cfg(test)]
pub(super) fn hints_from_lines(lines: &[Line]) -> FirstPageHints {
    imprint::hints_from_pages(&[imprint::PageLines {
        index: 0,
        lines: lines.to_vec(),
    }])
}

/// The run of lines in the largest size, if that size is larger than the body's.
pub(super) fn find_title_at(lines: &[Line]) -> Option<(String, usize, usize)> {
    let mut by_size: HashMap<i32, u64> = HashMap::new();
    for line in lines {
        let n = line.text.chars().filter(|c| !c.is_whitespace()).count() as u64;
        *by_size.entry(line.size).or_insert(0) += n;
    }
    let (&body, _) = by_size
        .iter()
        .max_by_key(|&(&size, &count)| (count, std::cmp::Reverse(size)))?;
    // A bare title page (a few lines, no body text) has no body size: its smallest size stands in.
    let body = if lines.len() <= 4 {
        by_size.keys().copied().min().unwrap_or(body)
    } else {
        body
    };
    let eligible = |line: &Line| {
        line.text.chars().filter(|c| c.is_alphabetic()).count() >= 4
            && line.text.chars().filter(|c| c.is_alphabetic()).count() * 2
                >= line.text.chars().filter(|c| !c.is_whitespace()).count()
            && line.size > body
    };
    let largest = lines
        .iter()
        .filter(|line| eligible(line))
        .map(|line| line.size)
        .max()?;
    let start = lines
        .iter()
        .position(|line| eligible(line) && line.size == largest)?;
    let mut title = lines[start].text.clone();
    let mut last_y = lines[start].y;
    let mut end = start;
    for (offset, line) in lines[start + 1..].iter().enumerate() {
        let gap = line.y - last_y;
        // `size` is in half points: 0.8 of it is 1.6 lines.
        if line.size != largest
            || !(gap > 0.0 && gap <= largest as f32 * 0.8)
            || title.chars().count() >= limits::BIB_HEURISTIC_TITLE_MAX
        {
            break;
        }
        title.push(' ');
        title.push_str(&line.text);
        last_y = line.y;
        end = start + 1 + offset;
    }
    let flat = sanitize_text(title.trim(), limits::BIB_HEURISTIC_TITLE_MAX);
    let flat = flat.trim();
    (!flat.is_empty()).then(|| (flat.to_owned(), start, end))
}

/// Month names and usual abbreviations (English and German), lower case.
const MONTHS: [&str; 36] = [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
    "jan",
    "feb",
    "mar",
    "apr",
    "jun",
    "jul",
    "aug",
    "sep",
    "sept",
    "oct",
    "nov",
    "dec",
    "januar",
    "februar",
    "maerz",
    "märz",
    "mai",
    "juni",
    "juli",
    "oktober",
    "dezember",
    "okt",
    "dez",
    "mrz",
];

/// The first year (1900 to 2100) standing as a word of its own, near a copyright sign, "copyright", a month name or in parentheses.
pub(super) fn find_year(text: &str) -> Option<String> {
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0;
    while i + 4 <= chars.len() {
        let digits = &chars[i..i + 4];
        let standalone = digits.iter().all(char::is_ascii_digit)
            && (i == 0 || !chars[i - 1].is_alphanumeric())
            && chars.get(i + 4).is_none_or(|c| !c.is_alphanumeric());
        if standalone {
            let year: u32 = digits.iter().collect::<String>().parse().unwrap_or(0);
            if (1900..=2100).contains(&year) && year_context(&chars, i) {
                return Some(year.to_string());
            }
            i += 4;
        } else {
            i += 1;
        }
    }
    None
}

fn year_context(chars: &[char], at: usize) -> bool {
    let before: String = chars[at.saturating_sub(40)..at]
        .iter()
        .collect::<String>()
        .to_lowercase();
    let after: String = chars[at + 4..(at + 4 + 6).min(chars.len())]
        .iter()
        .collect();
    // A copyright line may name the holder before the year ("(c) The Authors, exclusively licensed to X 2024").
    let wide: String = chars[at.saturating_sub(90)..at]
        .iter()
        .collect::<String>()
        .to_lowercase();
    let licence: String = chars[at.saturating_sub(160)..at]
        .iter()
        .collect::<String>()
        .to_lowercase();
    licence.contains("lizenziert")
        || licence.contains("licensed to")
        || wide.contains('\u{a9}')
        || wide.contains("(c)")
        || wide.contains("copyright")
        || before.contains("auflage")
        || before.contains("edition")
        || before.contains("aufl.")
        || before.contains("erschienen")
        || before
            .rsplit(|c: char| !c.is_alphabetic())
            .filter(|word| !word.is_empty())
            .take(3)
            .any(|word| MONTHS.contains(&word))
        || (before.trim_end().ends_with('(') && after.trim_start().starts_with(')'))
}

/// The first DOI of `text` and where it is (byte range).
pub(super) fn find_doi(text: &str) -> Option<(String, std::ops::Range<usize>)> {
    let bytes = text.as_bytes();
    let mut from = 0;
    while let Some(found) = text[from..].find("10.") {
        let start = from + found;
        from = start + 3;
        if start > 0 && bytes[start - 1].is_ascii_alphanumeric() {
            continue;
        }
        let digits = bytes[start + 3..]
            .iter()
            .take_while(|b| b.is_ascii_digit())
            .count();
        let slash = start + 3 + digits;
        if !(4..=9).contains(&digits) || bytes.get(slash) != Some(&b'/') {
            continue;
        }
        let end = text[slash + 1..]
            .find(char::is_whitespace)
            .map_or(text.len(), |n| slash + 1 + n);
        let suffix = clean_doi_tail(&text[slash + 1..end]);
        if suffix.is_empty() {
            continue;
        }
        let doi: String = format!("{}{suffix}", &text[start..=slash])
            .chars()
            .take(limits::BIB_DOI_MAX)
            .collect();
        let span = start..slash + 1 + suffix.len();
        return Some((doi, span));
    }
    None
}

/// The DOI's suffix without what ends a sentence: dots, commas, quotes, a closing bracket without its opening one.
fn clean_doi_tail(raw: &str) -> &str {
    let mut tail = raw;
    loop {
        let Some(last) = tail.chars().next_back() else {
            return tail;
        };
        let opens = |open: char| tail.chars().filter(|&c| c == open).count();
        let cut = match last {
            '.' | ',' | ';' | ':' | '!' | '?' | '"' | '\'' | '\u{201d}' | '\u{2019}' => true,
            ')' => opens('(') < opens(')'),
            ']' => opens('[') < opens(']'),
            '>' | '}' => true,
            _ => false,
        };
        if !cut {
            return tail;
        }
        tail = &tail[..tail.len() - last.len_utf8()];
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(y: f32, size: f32, text: &str) -> Line {
        Line {
            y,
            size: size_key(size).unwrap(),
            text: text.to_owned(),
        }
    }

    const BODY: &str =
        "Body text of the paper that runs on for a good while and has many characters.";

    #[test]
    fn the_largest_size_run_is_the_title_and_wrapped_lines_join() {
        let hints = hints_from_lines(&[
            line(40.0, 10.0, "Journal of Examples"),
            line(90.0, 24.0, "A Study of Things That"),
            line(116.0, 24.0, "Wrap Over Two Lines"),
            line(170.0, 12.0, BODY),
            line(190.0, 12.0, BODY),
        ]);
        assert_eq!(
            hints.title.as_deref(),
            Some("A Study of Things That Wrap Over Two Lines")
        );
    }

    #[test]
    fn no_larger_size_than_the_body_is_no_title() {
        let hints = hints_from_lines(&[line(40.0, 12.0, BODY), line(60.0, 12.0, BODY)]);
        assert_eq!(hints.title, None);
        assert_eq!(hints_from_lines(&[]), FirstPageHints::default());
    }

    #[test]
    fn a_title_is_cut_at_300_characters() {
        let long = "word ".repeat(100);
        let body = BODY.repeat(20);
        let hints = hints_from_lines(&[line(40.0, 24.0, &long), line(100.0, 12.0, &body)]);
        assert!(hints.title.unwrap().chars().count() <= limits::BIB_HEURISTIC_TITLE_MAX);
    }

    #[test]
    fn hostile_sizes_make_no_key_and_do_not_skew_the_title() {
        for size in [f32::NAN, 0.0, -3.0, f32::INFINITY, 1e30, 2_000.0] {
            assert_eq!(size_key(size), None, "{size}");
        }
        // A line whose sizes were all invalid never gets here (no key), so only valid lines are compared.
        let hints = hints_from_lines(&[
            line(40.0, 1_999.0, "Huge but valid"),
            line(90.0, 12.0, BODY),
        ]);
        assert_eq!(hints.title.as_deref(), Some("Huge but valid"));
    }

    #[test]
    fn a_year_needs_a_context() {
        let year = |text: &str| find_year(text);
        assert_eq!(year("Published 2019 in a place"), None);
        assert_eq!(year("\u{a9} 2021 The Authors"), Some("2021".to_owned()));
        assert_eq!(year("Copyright 1999 by X"), Some("1999".to_owned()));
        assert_eq!(year("Received 12 March 2015"), Some("2015".to_owned()));
        assert_eq!(year("Smith et al. (2008)"), Some("2008".to_owned()));
        assert_eq!(year("\u{a9} 1850 and \u{a9} 2150"), None);
        assert_eq!(year("\u{a9} 12345"), None);
        assert_eq!(year("\u{a9} x2020"), None);
    }

    #[test]
    fn the_doi_is_cleaned_and_its_digits_are_no_year() {
        let hints = hints_from_lines(&[
            line(40.0, 12.0, "https://doi.org/10.1016/j.cell.2020.05.001."),
            line(60.0, 12.0, BODY),
        ]);
        assert_eq!(hints.doi.as_deref(), Some("10.1016/j.cell.2020.05.001"));
        assert_eq!(hints.year, None);
        let paren = find_doi("see (doi:10.1234/abc(1)2).").unwrap().0;
        assert_eq!(paren, "10.1234/abc(1)2");
        let closed = find_doi("(10.1234/abc)").unwrap().0;
        assert_eq!(closed, "10.1234/abc");
        assert!(find_doi("10.12/abc").is_none());
        assert!(find_doi("x10.1234/abc").is_none());
        assert!(find_doi("10.1234/").is_none());
        assert!(find_doi("10.1234567890/abc").is_none());
    }

    #[test]
    fn a_giant_doi_is_cut() {
        let text = format!("10.1234/{}", "a".repeat(5_000));
        assert_eq!(
            find_doi(&text).unwrap().0.chars().count(),
            limits::BIB_DOI_MAX
        );
    }
}
