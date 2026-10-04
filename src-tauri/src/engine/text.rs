//! The text of a page with the box of every character, read on the worker (ARCHITECTURE §5, `get_text_layer`).
//!
//! The UI lays an invisible layer of text over the page image, so that text can be selected and copied: it needs the characters
//! and where each of them is. PDFium reads the page's text in the order of the content stream, and adds the line breaks and
//! spaces it infers; each character comes with its box (the "loose" one, which has the height of the font and so makes a selection
//! of a whole line without gaps). At most `limits::MAX_TEXT_CHARS` characters are read: a page is a file's content, and a page
//! with millions of characters is made to be a problem, not read.
//!
//! [`text_chars`] is the one reading of a page's characters, shared with the search (`engine::search`), so that the text that can be
//! selected is the text that can be found.

use pdfium_render::prelude::*;

use super::space::{load_page, page_box};
use crate::error::{AppError, ErrorCode};
use crate::limits;
use crate::model::geometry::{PageBox, Rect};

/// The text of a page and the boxes of its characters: four numbers (x, y, width, height, in page space) for every UTF-16 code unit of
/// `text`, so `text[i]` is in the box `boxes[4 * i..4 * i + 4]` however JavaScript counts. A character that is two code units (an
/// emoji) has its box twice.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct TextPage {
    pub text: String,
    pub boxes: Vec<f32>,
    /// The page has more text than `limits::MAX_TEXT_CHARS`; what is here is the beginning.
    pub truncated: bool,
    /// The page's own `/Rotate` in degrees (0, 90, 180, 270); the boxes are before it.
    pub rotation: u16,
}

/// Whether a character is left out of the text: what is not text, and the controls other than the line breaks and the tab. PDFium
/// marks the hyphen at the end of a line that continues a word with one (U+0002), so a hyphenated word reads as one; the others
/// would be invisible in the layer and are noise when it is copied.
fn is_left_out(c: char) -> bool {
    c.is_control() && !matches!(c, '\n' | '\r' | '\t')
}

/// A character of the page's text and where PDFium has it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct TextChar {
    pub c: char,
    /// The position of the character in PDFium's list, and of the last one it was made from: a character outside the Basic
    /// Multilingual Plane comes from PDFium as two characters (the halves of a surrogate pair, where PDFium's characters are 16 bit
    /// wide, as on Windows) and is one here. Otherwise the two are equal.
    pub first: usize,
    pub last: usize,
}

/// The characters of a page's text, in PDFium's order, without what [`is_left_out`] says and with the surrogate pairs put together
/// (a half without its other half is left out).
pub(super) struct TextChars<'c, 'a> {
    chars: &'c PdfPageTextChars<'a>,
    next: usize,
}

pub(super) fn text_chars<'c, 'a>(chars: &'c PdfPageTextChars<'a>) -> TextChars<'c, 'a> {
    TextChars { chars, next: 0 }
}

impl TextChars<'_, '_> {
    /// The Unicode value PDFium has for the character at `position`, if there is one.
    fn value(&self, position: usize) -> Option<u32> {
        self.chars
            .get(position)
            .ok()
            .map(|character| character.unicode_value())
    }
}

impl Iterator for TextChars<'_, '_> {
    type Item = TextChar;

    fn next(&mut self) -> Option<TextChar> {
        while self.next < self.chars.len() {
            let first = self.next;
            self.next += 1;
            let Some(value) = self.value(first) else {
                continue;
            };
            let c = match value {
                0xD800..=0xDBFF => match self
                    .value(self.next)
                    .filter(|low| (0xDC00..=0xDFFF).contains(low))
                {
                    Some(low) => {
                        self.next += 1;
                        char::from_u32(0x1_0000 + ((value - 0xD800) << 10) + (low - 0xDC00))
                    }
                    None => None,
                },
                0xDC00..=0xDFFF => None,
                _ => char::from_u32(value),
            };
            if let Some(c) = c.filter(|&c| !is_left_out(c)) {
                return Some(TextChar {
                    c,
                    first,
                    last: self.next - 1,
                });
            }
        }
        None
    }
}

/// The box of a character that PDFium cannot place (a generated line break, mostly): nothing, at the page's corner.
const NO_BOX: Rect = Rect {
    x: 0.0,
    y: 0.0,
    w: 0.0,
    h: 0.0,
};

/// The loose box of the character at `position`, in page space.
pub(super) fn char_box(chars: &PdfPageTextChars<'_>, position: usize, page_box: PageBox) -> Rect {
    chars
        .get(position)
        .ok()
        .and_then(|character| character.loose_bounds().ok())
        .and_then(|bounds| {
            page_box.rect(
                bounds.left().value,
                bounds.bottom().value,
                bounds.right().value,
                bounds.top().value,
            )
        })
        .unwrap_or(NO_BOX)
}

/// Reads the text layer of page `index` (below the page count, the caller checked).
pub(super) fn read_text(document: &PdfDocument<'_>, index: u32) -> Result<TextPage, AppError> {
    let page = load_page(document, index)?;
    let page_box = page_box(&page)?;
    let text_page = page
        .text()
        .map_err(|error| AppError::logged(ErrorCode::DamagedFile, format!("{error:?}")))?;
    let characters = text_page.chars();

    let mut text = String::new();
    let mut boxes: Vec<f32> = Vec::new();
    let mut units = 0usize;
    let mut truncated = false;
    for character in text_chars(&characters) {
        let width = character.c.len_utf16();
        if units + width > limits::MAX_TEXT_CHARS {
            truncated = true;
            break;
        }
        let rect = char_box(&characters, character.first, page_box);
        text.push(character.c);
        for _ in 0..width {
            boxes.extend([rect.x, rect.y, rect.w, rect.h]);
        }
        units += width;
    }
    Ok(TextPage {
        text,
        boxes,
        truncated,
        rotation: page_rotation(&page),
    })
}

/// The page's `/Rotate` as 0, 90, 180 or 270; 0 when PDFium cannot say.
fn page_rotation(page: &PdfPage<'_>) -> u16 {
    match page.rotation() {
        Ok(PdfPageRenderRotation::Degrees90) => 90,
        Ok(PdfPageRenderRotation::Degrees180) => 180,
        Ok(PdfPageRenderRotation::Degrees270) => 270,
        _ => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn controls_are_left_out_except_the_line_breaks_and_the_tab() {
        for kept in [
            'a',
            ' ',
            '\n',
            '\r',
            '\t',
            '\u{fc}',
            '\u{1f600}',
            '\u{200d}',
        ] {
            assert!(!is_left_out(kept), "{kept:?}");
        }
        // U+0002 is what PDFium puts for the hyphen of a hyphenated line end.
        for left_out in [
            '\0', '\u{1}', '\u{2}', '\u{7}', '\u{1b}', '\u{7f}', '\u{85}',
        ] {
            assert!(is_left_out(left_out), "{left_out:?}");
        }
    }
}
