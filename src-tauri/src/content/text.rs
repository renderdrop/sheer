//! Text box layout (ADR-047 §1). owned by package A.
//!
//! Greedy word wrap with the AFM widths of [`super::std14`]: LF breaks a paragraph, a word that is wider than the box is broken between
//! characters, trailing spaces never count. The line height is [`LINE_HEIGHT`] times the font size.

use super::std14::{text_width, winansi};
use crate::error::AppError;
use crate::limits;
use crate::model::annotation::{StdFont, TextAlign};
use crate::model::geometry::Rect;

/// The distance of two baselines, in font sizes.
pub const LINE_HEIGHT: f32 = 1.2;

/// The height of `lines` lines of `size`.
#[allow(clippy::cast_precision_loss)]
pub fn height_of(lines: usize, size: f32) -> f32 {
    lines as f32 * size * LINE_HEIGHT
}

/// Breaks `text` (LF breaks) into lines that fit `width` points set in `font` at `size`, and returns them with the height they need.
/// A character the font has no WinAnsi code for is `AppError::bad_char`; more than 500 lines is `limit_exceeded` (`text`).
pub fn layout(
    text: &str,
    font: StdFont,
    size: f32,
    width: f32,
) -> Result<(Vec<String>, f32), AppError> {
    if !size.is_finite() || size <= 0.0 || !width.is_finite() {
        return Err(AppError::invalid("fontSize"));
    }
    let mut lines = Vec::new();
    for paragraph in text.split('\n') {
        if let Some(bad) = paragraph
            .chars()
            .find(|c| *c != '\r' && winansi(*c).is_none())
        {
            return Err(AppError::bad_char(bad));
        }
        let paragraph: String = paragraph.chars().filter(|c| *c != '\r').collect();
        wrap(&paragraph, font, size, width, &mut lines);
        if lines.len() > limits::MAX_TEXT_BOX_LINES {
            return Err(AppError::limit("text", limits::MAX_TEXT_BOX_LINES as u64));
        }
    }
    let height = height_of(lines.len(), size);
    Ok((lines, height))
}

fn wrap(paragraph: &str, font: StdFont, size: f32, width: f32, out: &mut Vec<String>) {
    let mut line = String::new();
    let mut line_width = 0.0f32;
    for word in paragraph.split_inclusive(' ') {
        let body = word.trim_end_matches(' ');
        let body_width = text_width(font, body, size);
        if !line.is_empty() && line_width + body_width > width {
            out.push(line.trim_end().to_owned());
            line.clear();
            line_width = 0.0;
        }
        if body_width > width {
            // Wider than the box on its own: break between characters (at least one per line, so this ends).
            for c in word.chars() {
                let mut buffer = [0u8; 4];
                let char_width = text_width(font, c.encode_utf8(&mut buffer), size);
                if !line.is_empty() && line_width + char_width > width && c != ' ' {
                    out.push(line.trim_end().to_owned());
                    line.clear();
                    line_width = 0.0;
                }
                line.push(c);
                line_width += char_width;
            }
        } else {
            line.push_str(word);
            line_width += text_width(font, word, size);
        }
    }
    out.push(line.trim_end().to_owned());
}

/// What `model::annotation` calls on create and update: lays `text` out in `bounds`, stores the `lines`, and sets `bounds.h` to the
/// height they need (the draft's height is ignored).
pub fn layout_box(
    bounds: &mut Rect,
    text: &str,
    lines: &mut Vec<String>,
    font: StdFont,
    size: f32,
    _align: TextAlign,
) -> Result<(), AppError> {
    let (laid, height) = layout(text, font, size, bounds.w)?;
    *lines = laid;
    bounds.h = height;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wraps_at_the_width_and_grows_the_height() {
        // Courier 10 pt: 6 pt per character, 5 characters per 30 pt.
        let (lines, height) = layout("aaa bbb ccc", StdFont::Mono, 10.0, 30.0).unwrap();
        assert_eq!(lines, ["aaa", "bbb", "ccc"]);
        assert!((height - 36.0).abs() < 1e-3);
    }

    #[test]
    fn keeps_blank_lines_and_breaks_long_words() {
        let (lines, _) = layout("a\n\nbbbbbbbbbbbb", StdFont::Mono, 10.0, 30.0).unwrap();
        assert_eq!(lines, ["a", "", "bbbbb", "bbbbb", "bb"]);
        let (empty, height) = layout("", StdFont::Sans, 10.0, 30.0).unwrap();
        assert_eq!(empty, [""]);
        assert!((height - 12.0).abs() < 1e-3);
    }

    #[test]
    fn proportional_widths_decide_the_break() {
        // "iiii" is 4 * 222 = 888 units: 8.88 pt at 10 pt; "WWWW" is 3 776 units.
        let (lines, _) = layout("iiii WWWW", StdFont::Sans, 10.0, 40.0).unwrap();
        assert_eq!(lines, ["iiii", "WWWW"]);
        let (one, _) = layout("iiii iiii", StdFont::Sans, 10.0, 40.0).unwrap();
        assert_eq!(one, ["iiii iiii"]);
    }

    #[test]
    fn non_winansi_is_reported_with_the_char() {
        let error = layout("ok \u{4e2d}", StdFont::Serif, 12.0, 100.0).unwrap_err();
        let json = serde_json::to_value(crate::error::UiError::from(error)).unwrap();
        assert_eq!(json["params"]["char"], "\u{4e2d}");
        assert!(layout("Grüße € – “x”", StdFont::Serif, 12.0, 100.0).is_ok());
    }

    #[test]
    fn box_height_follows_the_lines() {
        let mut bounds = Rect {
            x: 0.0,
            y: 0.0,
            w: 30.0,
            h: 999.0,
        };
        let mut lines = Vec::new();
        layout_box(
            &mut bounds,
            "aaa bbb",
            &mut lines,
            StdFont::Mono,
            10.0,
            TextAlign::Left,
        )
        .unwrap();
        assert_eq!(lines, ["aaa", "bbb"]);
        assert!((bounds.h - 24.0).abs() < 1e-3);
    }
}
