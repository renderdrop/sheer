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

/// The turn of a stamp of ours and the size of its box before the turn, as a `/NM` suffix `-r<angle>-<w>-<h>` (ADR-105). PDFium
/// reads no custom key, so the name is where the turn survives a reload. The angle is in hundredths of a degree from 0 to 35999 (clockwise),
/// the sides are in hundredths of a point.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Turn {
    pub centi_degrees: u32,
    pub w_centi: u32,
    pub h_centi: u32,
}

const TURN_MARK: &str = "-r";

/// The name without its turn suffix, and the turn if it has a well formed one.
pub fn split_turn(name: &str) -> (&str, Option<Turn>) {
    let Some(at) = name.rfind(TURN_MARK) else {
        return (name, None);
    };
    let parse = |part: &str| {
        (!part.is_empty() && part.len() <= 8 && part.bytes().all(|b| b.is_ascii_digit()))
            .then(|| part.parse::<u32>().ok())
            .flatten()
    };
    let mut parts = name[at + TURN_MARK.len()..].split('-');
    let turn = match (parts.next(), parts.next(), parts.next(), parts.next()) {
        (Some(a), Some(w), Some(h), None) => parse(a)
            .filter(|a| *a < 36_000)
            .zip(parse(w))
            .zip(parse(h))
            .map(|((centi_degrees, w_centi), h_centi)| Turn {
                centi_degrees,
                w_centi,
                h_centi,
            }),
        _ => None,
    };
    match turn {
        Some(turn) => (&name[..at], Some(turn)),
        None => (name, None),
    }
}

/// `name` with its turn suffix replaced: none for no turn.
pub fn with_turn(name: &str, turn: Option<Turn>) -> String {
    let base = split_turn(name).0;
    match turn {
        Some(t) => format!(
            "{base}{TURN_MARK}{}-{}-{}",
            t.centi_degrees, t.w_centi, t.h_centi
        ),
        None => base.to_owned(),
    }
}

/// The turn of a box `w` by `h` points, `angle` degrees (any finite number); `None` for no turn or a value that is not a number.
#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
pub fn turn_of(angle: f32, w: f32, h: f32) -> Option<Turn> {
    let normal = crate::model::annotation::normalize_angle(angle)?;
    let centi = ((normal.rem_euclid(360.0)) * 100.0).round();
    if centi <= 0.0 || centi >= 36_000.0 || !w.is_finite() || !h.is_finite() || w < 0.0 || h < 0.0 {
        return None;
    }
    // The ranges are checked above, so the casts cannot lose anything but the fraction.
    Some(Turn {
        centi_degrees: centi as u32,
        w_centi: (w * 100.0).round().min(99_999_999.0) as u32,
        h_centi: (h * 100.0).round().min(99_999_999.0) as u32,
    })
}

/// Reads our `/NM` scheme; `None` for any other name.
pub fn parse_name(name: &str) -> Option<Named> {
    let name = split_turn(name).0;
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
    fn a_turn_suffix_round_trips_and_a_bad_one_is_not_a_turn() {
        let turn = turn_of(-90.0, 80.5, 20.0).unwrap();
        assert_eq!(turn.centi_degrees, 27_000);
        let name = with_turn("sheer-sig-0a1b", Some(turn));
        assert_eq!(name, "sheer-sig-0a1b-r27000-8050-2000");
        assert_eq!(split_turn(&name), ("sheer-sig-0a1b", Some(turn)));
        assert_eq!(parse_name(&name), Some(Named::Signature));
        let mark = with_turn("sheer-mark-cross-ff-r100-1-1", None);
        assert_eq!(mark, "sheer-mark-cross-ff");
        assert_eq!(turn_of(0.0, 10.0, 10.0), None);
        assert_eq!(turn_of(360.0, 10.0, 10.0), None);
        assert_eq!(turn_of(f32::NAN, 10.0, 10.0), None);
        for bad in [
            "sheer-sig-a-r36000-1-1",
            "sheer-sig-a-r5-1",
            "sheer-sig-a-rx-1-1",
            "sheer-sig-a-r5-1-1-1",
            "sheer-sig-a-r5--1",
        ] {
            assert_eq!(split_turn(bad).1, None, "{bad}");
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
