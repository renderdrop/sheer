//! Searching one page, on the worker (ARCHITECTURE §5, `search`).
//!
//! A search of a document is one job per page at the lowest priority (ADR-002 §2, §3): the pages of the viewport are drawn before
//! the next page is searched, and the caller checks its cancel flag between two pages. This module is the job. It reads the page's
//! text (the same characters as the text layer, `engine::text`), finds the hits in it (`model::find`: Unicode case, hyphenated
//! words, white space) and then asks PDFium for the box of each character of each hit, which become the hit's rectangles: one for
//! each line it runs over. Text that is not set in lines (it is turned by an angle that is not a multiple of 180 degrees) gets one
//! rectangle per character.

use pdfium_render::prelude::*;

use super::space::{load_page, page_box};
use super::text::{char_box, text_chars, TextChar};
use crate::error::{AppError, ErrorCode};
use crate::limits;
use crate::model::find::find;
use crate::model::geometry::{PageBox, Point, Quad, Rect};

/// What to look for. The text is checked by the caller (`limits::validate_search_text`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchSpec {
    pub text: String,
    /// Upper and lower case are different letters.
    pub match_case: bool,
    /// A hit is a whole word: the characters on either side are not letters.
    pub whole_word: bool,
}

/// The rectangles of one hit: the boxes of its characters, those on one line joined. A character is on the line of the one before
/// it if the middle of each is between the top and the bottom of the other.
fn hit_quads(
    characters: &PdfPageTextChars<'_>,
    covered: &[TextChar],
    page_box: PageBox,
) -> Vec<Quad> {
    // The rectangles in page space: x, y of the top left corner, and the size.
    let mut rects: Vec<Rect> = Vec::new();
    for character in covered {
        let rect = char_box(characters, character.first, page_box);
        // A character with no area (a generated line break) has nothing to show.
        if rect.w <= 0.0 && rect.h <= 0.0 {
            continue;
        }
        match rects.last_mut() {
            Some(line) if on_one_line(line, &rect) => {
                let right = (line.x + line.w).max(rect.x + rect.w);
                let bottom = (line.y + line.h).max(rect.y + rect.h);
                line.x = line.x.min(rect.x);
                line.y = line.y.min(rect.y);
                line.w = right - line.x;
                line.h = bottom - line.y;
            }
            _ => rects.push(rect),
        }
    }
    rects
        .iter()
        .take(limits::MAX_QUADS_PER_HIT)
        .map(quad_of)
        .collect()
}

fn on_one_line(line: &Rect, next: &Rect) -> bool {
    let (line_mid, next_mid) = (line.y + line.h / 2.0, next.y + next.h / 2.0);
    (line.y..=line.y + line.h).contains(&next_mid) && (next.y..=next.y + next.h).contains(&line_mid)
}

/// The rectangle as four corners: top left, top right, bottom left, bottom right.
fn quad_of(rect: &Rect) -> Quad {
    let (left, right) = (rect.x, rect.x + rect.w);
    let (top, bottom) = (rect.y, rect.y + rect.h);
    [
        Point { x: left, y: top },
        Point { x: right, y: top },
        Point { x: left, y: bottom },
        Point {
            x: right,
            y: bottom,
        },
    ]
}

/// Searches page `index` (below the page count, the caller checked) and returns its first `limit` hits in reading order, each as
/// the quads of the text it covers, in page space.
pub(super) fn search_page(
    document: &PdfDocument<'_>,
    index: u32,
    spec: &SearchSpec,
    limit: usize,
) -> Result<Vec<Vec<Quad>>, AppError> {
    let page = load_page(document, index)?;
    let page_box = page_box(&page)?;
    let text_page = page
        .text()
        .map_err(|error| AppError::logged(ErrorCode::DamagedFile, format!("{error:?}")))?;
    let characters = text_page.chars();

    let page_chars: Vec<TextChar> = text_chars(&characters)
        .take(limits::MAX_SEARCH_PAGE_CHARS)
        .collect();
    let text: Vec<char> = page_chars.iter().map(|character| character.c).collect();
    Ok(
        find(&text, &spec.text, spec.match_case, spec.whole_word, limit)
            .into_iter()
            .map(|(first, last)| hit_quads(&characters, &page_chars[first..=last], page_box))
            // A hit that PDFium cannot place has nothing to show.
            .filter(|quads| !quads.is_empty())
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x: f32, y: f32, w: f32, h: f32) -> Rect {
        Rect { x, y, w, h }
    }

    #[test]
    fn characters_are_on_one_line_if_the_middle_of_each_is_within_the_other() {
        let line = rect(10.0, 100.0, 50.0, 12.0);
        assert!(on_one_line(&line, &rect(60.0, 100.5, 8.0, 12.0)));
        // A taller character (a capital next to small letters) on the same baseline.
        assert!(on_one_line(&line, &rect(60.0, 98.0, 8.0, 15.0)));
        // The next line down, and the line above.
        assert!(!on_one_line(&line, &rect(10.0, 115.0, 8.0, 12.0)));
        assert!(!on_one_line(&line, &rect(10.0, 85.0, 8.0, 12.0)));
    }

    #[test]
    fn a_rectangle_is_four_corners_top_left_top_right_bottom_left_bottom_right() {
        let quad = quad_of(&rect(10.0, 20.0, 30.0, 5.0));
        let corners: Vec<(f32, f32)> = quad.iter().map(|point| (point.x, point.y)).collect();
        assert_eq!(
            corners,
            [(10.0, 20.0), (40.0, 20.0), (10.0, 25.0), (40.0, 25.0)]
        );
    }
}
