//! The fixed geometry of the Fill & Sign marks (ADR-041 §5): check, cross and dot as filled shapes in the unit square (x right, y down),
//! stretched to the annotation's box. The PDF appearance is drawn from these numbers and the UI's overlay draws the same.

use crate::model::annotation::MarkGlyph;

/// What a mark is made of.
pub enum Shape {
    /// One closed polygon, nonzero fill.
    Polygon(&'static [[f32; 2]]),
    /// The ellipse inscribed in the square, inset by this much on each side.
    Disc { inset: f32 },
}

const CHECK: [[f32; 2]; 6] = [
    [0.06, 0.56],
    [0.19, 0.44],
    [0.38, 0.64],
    [0.80, 0.08],
    [0.94, 0.20],
    [0.38, 0.92],
];

const CROSS: [[f32; 2]; 12] = [
    [0.12, 0.04],
    [0.50, 0.42],
    [0.88, 0.04],
    [0.96, 0.12],
    [0.58, 0.50],
    [0.96, 0.88],
    [0.88, 0.96],
    [0.50, 0.58],
    [0.12, 0.96],
    [0.04, 0.88],
    [0.42, 0.50],
    [0.04, 0.12],
];

pub const fn shape(glyph: MarkGlyph) -> Shape {
    match glyph {
        MarkGlyph::Check => Shape::Polygon(&CHECK),
        MarkGlyph::Cross => Shape::Polygon(&CROSS),
        MarkGlyph::Dot => Shape::Disc { inset: 0.15 },
    }
}

/// The word of a glyph in an annotation's `/NM`.
pub const fn word(glyph: MarkGlyph) -> &'static str {
    match glyph {
        MarkGlyph::Check => "check",
        MarkGlyph::Cross => "cross",
        MarkGlyph::Dot => "dot",
    }
}

/// The glyph a `/NM` word says.
pub fn from_word(word: &str) -> Option<MarkGlyph> {
    match word {
        "check" => Some(MarkGlyph::Check),
        "cross" => Some(MarkGlyph::Cross),
        "dot" => Some(MarkGlyph::Dot),
        _ => None,
    }
}

/// What a `/NM` of ours says about the annotation (`sheer-sig-<hex>`, `sheer-ini-<hex>`, `sheer-mark-<glyph>-<hex>`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Named {
    Signature,
    Initials,
    Mark(MarkGlyph),
}

fn is_token(text: &str) -> bool {
    !text.is_empty() && text.len() <= 64 && text.bytes().all(|b| b.is_ascii_alphanumeric())
}

/// Reads our `/NM` scheme; `None` for any other name.
pub fn parse_name(name: &str) -> Option<Named> {
    if let Some(rest) = name.strip_prefix("sheer-sig-") {
        return is_token(rest).then_some(Named::Signature);
    }
    if let Some(rest) = name.strip_prefix("sheer-ini-") {
        return is_token(rest).then_some(Named::Initials);
    }
    let rest = name.strip_prefix("sheer-mark-")?;
    let (glyph, token) = rest.split_once('-')?;
    is_token(token).then(|| from_word(glyph).map(Named::Mark))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_round_trip_and_others_are_none() {
        assert_eq!(parse_name("sheer-sig-0a1b"), Some(Named::Signature));
        assert_eq!(parse_name("sheer-ini-0a1b"), Some(Named::Initials));
        assert_eq!(
            parse_name("sheer-mark-cross-ff"),
            Some(Named::Mark(MarkGlyph::Cross))
        );
        for bad in [
            "",
            "sheer-sig-",
            "sheer-sig-a b",
            "sheer-mark-star-ff",
            "sheer-mark-dot",
            "other",
            "sheer-i0-1",
        ] {
            assert_eq!(parse_name(bad), None, "{bad}");
        }
    }

    #[test]
    fn shapes_stay_in_the_unit_square() {
        for glyph in [MarkGlyph::Check, MarkGlyph::Cross] {
            let Shape::Polygon(points) = shape(glyph) else {
                panic!("not a polygon")
            };
            assert!(points
                .iter()
                .flatten()
                .all(|value| (0.0..=1.0).contains(value)));
        }
    }
}
