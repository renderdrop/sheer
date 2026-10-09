//! Citations as the model has them (ADR-119): the cite record of a Highlight, and the shapes of `create_citations` and `list_citations`.
//!
//! `quote_of` (the text under a selection, with a cap) lives here too.

use serde::{Deserialize, Serialize};

use super::annotation::Rgb;
use super::geometry::Quad;
use super::ids::AnnotId;
use crate::documents::PageId;
use crate::error::AppError;
use crate::limits;

/// What makes a Highlight a citation: its quote (`/SHR_Cite /Q`, 1..=`limits::CITE_QUOTE_MAX` characters) and the group a selection across
/// pages shares (`/G`, 8 hex characters).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Cite {
    pub quote: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
}

/// One citation to create, on one page (`create_citations`: at most `limits::CITE_DRAFTS_MAX`, one per page).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CitationDraft {
    pub page_id: PageId,
    /// 1..=512 rectangles of the selection.
    pub quads: Vec<Quad>,
    pub color: Rgb,
    #[serde(default)]
    pub contents: String,
    #[serde(default)]
    pub tags: Vec<String>,
}

/// A citation as `list_citations` reports it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CitationInfo {
    pub id: AnnotId,
    pub page_id: PageId,
    /// The page label, or the position + 1 (resolved when listed).
    pub locator: String,
    pub quote: String,
    pub contents: String,
    pub tags: Vec<String>,
    pub group: Option<String>,
    pub color: Rgb,
}

/// Longest quote a comment card shows, in characters (`get_annotation_quote`).
pub const CARD_QUOTE_MAX: usize = 280;

/// The text of `text` (a box of `boxes` -- x, y, width, height -- per UTF-16 code unit) whose characters have their centre in a quad's
/// bounding box, from the first such character to the last; the whitespace between them is kept and collapsed to single spaces. A
/// quote longer than `cap` characters is cut to `cap - 1` and ends with `…`.
pub fn quote_of(text: &str, boxes: &[f32], quads: &[Quad], cap: usize) -> String {
    let areas: Vec<[f32; 4]> = quads
        .iter()
        .map(|quad| {
            let xs = quad.map(|p| p.x);
            let ys = quad.map(|p| p.y);
            [
                xs.iter().copied().fold(f32::INFINITY, f32::min),
                ys.iter().copied().fold(f32::INFINITY, f32::min),
                xs.iter().copied().fold(f32::NEG_INFINITY, f32::max),
                ys.iter().copied().fold(f32::NEG_INFINITY, f32::max),
            ]
        })
        .collect();
    let mut units = 0usize;
    let mut picked: Vec<(char, bool)> = Vec::new();
    for c in text.chars() {
        let hit = boxes.get(units * 4..units * 4 + 4).is_some_and(|b| {
            let (cx, cy) = (b[0] + b[2] / 2.0, b[1] + b[3] / 2.0);
            !c.is_whitespace()
                && areas
                    .iter()
                    .any(|a| cx >= a[0] && cx <= a[2] && cy >= a[1] && cy <= a[3])
        });
        picked.push((c, hit));
        units += c.len_utf16();
    }
    let first = picked.iter().position(|(_, hit)| *hit);
    let last = picked.iter().rposition(|(_, hit)| *hit);
    let (Some(first), Some(last)) = (first, last) else {
        return String::new();
    };
    let mut out = String::new();
    let mut gap = false;
    for (c, hit) in &picked[first..=last] {
        if c.is_whitespace() {
            gap = true;
        } else if *hit {
            if gap && !out.is_empty() {
                out.push(' ');
            }
            gap = false;
            out.push(*c);
        }
    }
    if out.chars().count() > cap {
        out = out.chars().take(cap.saturating_sub(1)).collect();
        out.push('…');
    }
    out
}

/// A quote of a citation (`/SHR_Cite /Q`, a patch) as it is stored: line ends (`\r\n`, `\r`) become `\n`, a tab becomes a space.
/// Quotes can span lines, so `\n` stays; every other control character is for [`check_quote`] to refuse.
pub fn normalize_quote(quote: &str) -> String {
    let mut out = String::with_capacity(quote.len());
    let mut chars = quote.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\r' => {
                if chars.peek() == Some(&'\n') {
                    chars.next();
                }
                out.push('\n');
            }
            '\t' => out.push(' '),
            other => out.push(other),
        }
    }
    out
}

/// A normalised quote ([`normalize_quote`]) of a citation: 1..=`CITE_QUOTE_MAX` characters, no control character but `\n`.
pub fn check_quote(quote: &str) -> Result<(), AppError> {
    let mut count = 0usize;
    for c in quote.chars() {
        count += 1;
        if count > limits::CITE_QUOTE_MAX || (c.is_control() && c != '\n') {
            return Err(AppError::invalid("quote"));
        }
    }
    if quote.trim().is_empty() {
        return Err(AppError::invalid("quote"));
    }
    Ok(())
}

/// Whether `group` is a group id: 8 lower-case hex characters.
pub fn is_group_id(group: &str) -> bool {
    group.len() == 8
        && group
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// A fresh group id (from the OS-seeded hasher of the standard library, a counter and the clock).
pub fn new_group_id() -> String {
    let name = crate::pdfwrite::annots::random_name();
    name.chars().take(8).collect()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::model::annotation::{Annotation, AnnotationBody};

    fn quad_of(x: f32, y: f32, w: f32, h: f32) -> Quad {
        use crate::model::geometry::Point;
        let p = |x, y| Point { x, y };
        [p(x, y), p(x + w, y), p(x, y + h), p(x + w, y + h)]
    }

    /// "ab cd" with a box of 10 x 10 per character on one line, and "ef" on the next.
    fn layer() -> (String, Vec<f32>) {
        let text = "ab cd\nef";
        let mut boxes = Vec::new();
        let (mut x, mut y) = (0.0f32, 0.0f32);
        for c in text.chars() {
            if c == '\n' {
                boxes.extend([0.0, 0.0, 0.0, 0.0]);
                x = 0.0;
                y += 12.0;
            } else {
                boxes.extend([x, y, 10.0, 10.0]);
                x += 10.0;
            }
        }
        (text.to_owned(), boxes)
    }

    #[test]
    fn the_quote_is_the_text_under_the_quads_with_whitespace_collapsed() {
        let (text, boxes) = layer();
        // The second letter to the first of "cd".
        let quote = quote_of(&text, &boxes, &[quad_of(11.0, 0.0, 30.0, 10.0)], 280);
        assert_eq!(quote, "b c");
        // Two lines: the break is a space.
        let both = quote_of(
            &text,
            &boxes,
            &[
                quad_of(0.0, 0.0, 50.0, 10.0),
                quad_of(0.0, 12.0, 20.0, 10.0),
            ],
            280,
        );
        assert_eq!(both, "ab cd ef");
        // Nothing under the quad.
        assert_eq!(
            quote_of(&text, &boxes, &[quad_of(500.0, 500.0, 5.0, 5.0)], 280),
            ""
        );
    }

    #[test]
    fn a_long_quote_is_cut_to_the_cap_and_a_character_of_two_code_units_keeps_its_box() {
        let long = "x".repeat(CARD_QUOTE_MAX + 50);
        let boxes: Vec<f32> = (0..long.len())
            .flat_map(|n| [n as f32, 0.0, 1.0, 1.0])
            .collect();
        let wide = [quad_of(0.0, 0.0, 10_000.0, 2.0)];
        let quote = quote_of(&long, &boxes, &wide, CARD_QUOTE_MAX);
        assert_eq!(quote.chars().count(), CARD_QUOTE_MAX);
        assert!(quote.ends_with('…'));
        // The citation cap is far larger: the same text is whole.
        let whole = quote_of(&long, &boxes, &wide, limits::CITE_QUOTE_MAX);
        assert_eq!(whole, long);
        // The emoji is two units; the character after it is at unit 3.
        let boxes = vec![
            0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0, 1.0, 50.0, 0.0, 1.0, 1.0,
        ];
        assert_eq!(
            quote_of("a😀b", &boxes, &[quad_of(49.0, 0.0, 3.0, 2.0)], 280),
            "b"
        );
    }

    #[test]
    fn a_quote_to_store_has_text_and_a_limit() {
        assert!(check_quote("a line\nand another").is_ok());
        assert!(check_quote("x").is_ok());
        assert!(check_quote("").is_err());
        assert!(check_quote("  \n ").is_err());
        assert!(check_quote("bell\u{7}").is_err());
        // Of the controls only the line feed stays; the others are normalised first (or refused).
        assert!(check_quote("a\tb").is_err() && check_quote("a\rb").is_err());
        assert_eq!(normalize_quote("a\r\nb\rc\td\ne"), "a\nb\nc d\ne");
        assert!(check_quote(&normalize_quote("a\r\nb\tc")).is_ok());
        assert!(check_quote(&"x".repeat(limits::CITE_QUOTE_MAX)).is_ok());
        assert!(check_quote(&"x".repeat(limits::CITE_QUOTE_MAX + 1)).is_err());
    }

    #[test]
    fn group_ids_are_eight_hex_characters_and_new_ones_differ() {
        let (a, b) = (new_group_id(), new_group_id());
        assert!(is_group_id(&a) && is_group_id(&b) && a != b);
        assert!(!is_group_id("0A1B2C3D") && !is_group_id("0a1b2c3") && !is_group_id("0a1b2c3g"));
    }
    #[test]
    fn an_annotation_without_cite_and_tags_still_deserializes() {
        let annotation = Annotation {
            id: AnnotId::new(1),
            page_id: PageId::new(0),
            rect: crate::model::geometry::Rect {
                x: 0.0,
                y: 0.0,
                w: 1.0,
                h: 1.0,
            },
            color: Rgb([1, 2, 3]),
            opacity: 1.0,
            contents: String::new(),
            author: None,
            modified: None,
            in_reply_to: None,
            state: None,
            locked: false,
            sync: crate::model::annotation::Sync::Clean,
            cite: None,
            tags: Vec::new(),
            group: None,
            body: AnnotationBody::Highlight { quads: Vec::new() },
        };
        let value = serde_json::to_value(&annotation).unwrap();
        assert!(value.get("cite").is_none() && value.get("tags").is_none());
        let back: Annotation = serde_json::from_value(value).unwrap();
        assert_eq!(back, annotation);
        let mut cited = annotation;
        cited.cite = Some(Cite {
            quote: "q".to_owned(),
            group: Some("0a1b2c3d".to_owned()),
        });
        cited.tags = vec!["x".to_owned()];
        let value = serde_json::to_value(&cited).unwrap();
        assert_eq!(value["cite"], json!({"quote": "q", "group": "0a1b2c3d"}));
        assert_eq!(serde_json::from_value::<Annotation>(value).unwrap(), cited);
    }
}
