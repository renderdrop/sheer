//! Stamps (ADR-139 Addendum A1, ARCHITECTURE §16.1): the kinds, the two tones, the text rules and the sizing of a stamp. A stamp is a
//! `/Stamp` annotation with an appearance of our own (`pdfwrite::stamp_ap`); the text arrives localized from the UI and is stored as given.
//! Everything that arrives from the UI or from a file is hostile: control characters go, the length is bounded, and only WinAnsi
//! characters are accepted (the appearance uses the standard Helvetica fonts, not embedded).

use serde::{Deserialize, Serialize};

use super::annotation::Rgb;
use super::geometry::Rect;
use crate::content::std14::{self, Std14};
use crate::error::AppError;

/// The stamps the picker offers; `Custom` is the user's own text.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StampKind {
    Draft,
    Approved,
    Confidential,
    Received,
    Custom,
}

impl StampKind {
    /// The word in the `/NM` (`sheer-stamp-<word>-<hex>`) and in `/SHR_Stamp /K`.
    pub const fn word(self) -> &'static str {
        match self {
            Self::Draft => "draft",
            Self::Approved => "approved",
            Self::Confidential => "confidential",
            Self::Received => "received",
            Self::Custom => "custom",
        }
    }

    /// The kind a word names.
    pub fn from_word(word: &str) -> Option<Self> {
        Some(match word {
            "draft" => Self::Draft,
            "approved" => Self::Approved,
            "confidential" => Self::Confidential,
            "received" => Self::Received,
            "custom" => Self::Custom,
            _ => return None,
        })
    }

    /// The `/Name` of the annotation. Never absent: an absent name means Draft in a viewer that draws no appearances.
    pub const fn pdf_name(self) -> &'static str {
        match self {
            Self::Draft => "Draft",
            Self::Approved => "Approved",
            Self::Confidential => "Confidential",
            Self::Received => "Received",
            Self::Custom => "Custom",
        }
    }
}

/// The two colours of a stamp: Solar (yellow fill, ink text) and Ink (outline only).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StampTone {
    Solar,
    Ink,
}

impl StampTone {
    pub const fn word(self) -> &'static str {
        match self {
            Self::Solar => "Solar",
            Self::Ink => "Ink",
        }
    }

    pub fn from_word(word: &str) -> Option<Self> {
        match word {
            "Solar" => Some(Self::Solar),
            "Ink" => Some(Self::Ink),
            _ => None,
        }
    }
}

/// Solar, `--hl-solar` in `tokens.css`.
pub const SOLAR_RGB: Rgb = Rgb([0xff, 0xf8, 0x4d]);
/// Ink, `--color-ink` in `tokens.css`.
pub const INK_RGB: Rgb = Rgb([0x0f, 0x0f, 0x0f]);

/// The colour of a tone; the annotation's colour is always this.
pub const fn tone_rgb(tone: StampTone) -> Rgb {
    match tone {
        StampTone::Solar => SOLAR_RGB,
        StampTone::Ink => INK_RGB,
    }
}

/// The tone whose colour is nearer to `rgb`.
pub fn tone_near(rgb: Rgb) -> StampTone {
    let distance = |to: Rgb| -> i32 {
        rgb.0
            .iter()
            .zip(to.0)
            .map(|(a, b)| (i32::from(*a) - i32::from(b)).pow(2))
            .sum()
    };
    if distance(SOLAR_RGB) <= distance(INK_RGB) {
        StampTone::Solar
    } else {
        StampTone::Ink
    }
}

/// Most characters of the stamp text and of the date.
pub const TEXT_MAX: usize = 64;
pub const DATE_MAX: usize = 32;
/// Smallest box of a stamp, in points.
pub const MIN_W_PT: f32 = 24.0;
pub const MIN_H_PT: f32 = 12.0;
/// Font size of a stamp at its natural size, and the padding around the text.
pub const NATURAL_FONT_PT: f32 = 18.0;
pub const PAD_PT: f32 = 8.0;
/// The range of the fitted font size.
pub const MIN_FONT_PT: f32 = 6.0;
pub const MAX_FONT_PT: f32 = 72.0;
/// The date line is this part of the text size; the gap between the two lines is this part of the text size.
pub const DATE_SCALE: f32 = 0.6;
pub const LINE_GAP: f32 = 0.2;

/// `text` without control and format characters (a stamp is one line).
pub fn clean(text: &str) -> String {
    text.chars()
        .filter(|c| !c.is_control() && !matches!(*c, '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}' | '\u{FEFF}'))
        .collect()
}

/// `invalid_argument` `stamp` for the first character in `text` that WinAnsi has no glyph for.
fn winansi_only(text: &str) -> Result<(), AppError> {
    match text
        .chars()
        .find(|c| std14::winansi(*c).is_none() || *c < ' ')
    {
        Some(c) => Err(AppError::bad_stamp_char(c)),
        None => Ok(()),
    }
}

/// Checks (and cleans) the text and the date of a stamp: `text` 1..=[`TEXT_MAX`] characters, `date` at most [`DATE_MAX`], both WinAnsi.
pub fn check_texts(text: &mut String, date: &mut Option<String>) -> Result<(), AppError> {
    *text = clean(text);
    if let Some(d) = date {
        *d = clean(d);
        if d.is_empty() {
            *date = None;
        }
    }
    let length = text.chars().count();
    if length == 0 || length > TEXT_MAX {
        return Err(AppError::invalid("stamp"));
    }
    winansi_only(text)?;
    if let Some(d) = date {
        if d.chars().count() > DATE_MAX {
            return Err(AppError::invalid("stamp"));
        }
        winansi_only(d)?;
    }
    Ok(())
}

/// A new `Received` stamp carries the date (an imported one may have lost it with its `/SHR_Stamp`).
pub fn require_date(kind: StampKind, date: &Option<String>) -> Result<(), AppError> {
    if kind == StampKind::Received && date.is_none() {
        return Err(AppError::invalid("stamp"));
    }
    Ok(())
}

/// The width of `text` in `font` at `size` points (WinAnsi; a character without a glyph counts as a space).
pub fn text_width(font: Std14, text: &str, size: f32) -> f32 {
    text.chars()
        .map(|c| {
            let code = std14::winansi(c).unwrap_or(b' ');
            f32::from(std14::std14_width(font, code).unwrap_or(556))
        })
        .sum::<f32>()
        * size
        / 1000.0
}

fn width_of(text: &str, size: f32) -> f32 {
    text_width(Std14::HelveticaBold, text, size)
}

fn width_regular(text: &str, size: f32) -> f32 {
    text_width(Std14::Helvetica, text, size)
}

/// The size of a stamp at its natural size (text at [`NATURAL_FONT_PT`], padded), in points.
pub fn natural_size(text: &str, date: Option<&str>) -> (f32, f32) {
    let mut w = width_of(text, NATURAL_FONT_PT);
    let mut h = NATURAL_FONT_PT;
    if let Some(date) = date {
        let size = NATURAL_FONT_PT * DATE_SCALE;
        w = w.max(width_regular(date, size));
        h += NATURAL_FONT_PT * LINE_GAP + size;
    }
    (w + 2.0 * PAD_PT, h + 2.0 * PAD_PT)
}

/// The text size that fits `text` (and `date`) into a box `w` by `h`: one line, the smaller of the height fit and the width fit.
pub fn fitted_font(text: &str, date: Option<&str>, w: f32, h: f32) -> f32 {
    let inner_w = (w - 2.0 * PAD_PT.min(w / 4.0)).max(1.0);
    let inner_h = (h - 2.0 * PAD_PT.min(h / 4.0)).max(1.0);
    let height_factor = if date.is_some() {
        1.0 + LINE_GAP + DATE_SCALE
    } else {
        1.0
    };
    let by_height = inner_h / height_factor;
    let mut unit_w = width_of(text, 1.0);
    if let Some(date) = date {
        unit_w = unit_w.max(width_regular(date, DATE_SCALE));
    }
    let by_width = if unit_w > 0.0 {
        inner_w / unit_w
    } else {
        by_height
    };
    by_height.min(by_width).clamp(MIN_FONT_PT, MAX_FONT_PT)
}

/// Gives a zero-size draft box its natural size at the click (`x`, `y` is the top-left, as the UI sends it); otherwise checks the box:
/// at least [`MIN_W_PT`] by [`MIN_H_PT`].
pub fn size_box(bounds: &mut Rect, text: &str, date: Option<&str>) -> Result<(), AppError> {
    if bounds.w == 0.0 && bounds.h == 0.0 {
        let (w, h) = natural_size(text, date);
        bounds.w = w;
        bounds.h = h;
    }
    if bounds.w < MIN_W_PT || bounds.h < MIN_H_PT {
        return Err(AppError::invalid("box"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tones_mirror_the_tokens_and_are_told_apart() {
        assert_eq!(tone_rgb(StampTone::Solar), Rgb([255, 248, 77]));
        assert_eq!(tone_rgb(StampTone::Ink), Rgb([15, 15, 15]));
        assert_eq!(tone_near(Rgb([250, 240, 90])), StampTone::Solar);
        assert_eq!(tone_near(Rgb([0, 0, 0])), StampTone::Ink);
    }

    /// The Rust constants are the tokens (a hex value of `src/styles/tokens.css` read at build time), so a token change breaks this test.
    #[test]
    fn the_tone_colours_equal_the_css_tokens() {
        let css = include_str!("../../../src/styles/tokens.css");
        let token = |name: &str| -> Rgb {
            let rest = css
                .lines()
                .find_map(|l| l.trim().strip_prefix(name)?.trim_start().strip_prefix(':'))
                .expect("token present");
            let hex = rest
                .split_whitespace()
                .next()
                .unwrap()
                .trim_end_matches(';')
                .trim_start_matches('#');
            let v = |i: usize| u8::from_str_radix(&hex[i..i + 2], 16).unwrap();
            Rgb([v(0), v(2), v(4)])
        };
        assert_eq!(SOLAR_RGB, token("--hl-solar"));
        assert_eq!(INK_RGB, token("--color-ink"));
    }

    #[test]
    fn words_round_trip() {
        for kind in [
            StampKind::Draft,
            StampKind::Approved,
            StampKind::Confidential,
            StampKind::Received,
            StampKind::Custom,
        ] {
            assert_eq!(StampKind::from_word(kind.word()), Some(kind));
        }
        assert_eq!(StampKind::from_word("x"), None);
    }

    #[test]
    fn texts_are_cleaned_bounded_and_winansi() {
        let mut text = "Gepr\u{fc}ft\u{7}\n\u{202E}".to_owned();
        let mut date = Some("\u{7}".to_owned());
        check_texts(&mut text, &mut date).unwrap();
        assert_eq!(text, "Gepr\u{fc}ft");
        assert_eq!(date, None);
        let mut long = "A".repeat(TEXT_MAX + 1);
        assert!(check_texts(&mut long, &mut None).is_err());
        let mut cjk = "\u{4e2d}".to_owned();
        assert!(check_texts(&mut cjk, &mut None).is_err());
        let mut empty = "\u{7}".to_owned();
        assert!(check_texts(&mut empty, &mut None).is_err());
        let mut received = "RECEIVED".to_owned();
        assert!(require_date(StampKind::Received, &None).is_err());
        assert!(require_date(StampKind::Custom, &None).is_ok());
        let mut dated = Some("07.10.2026".to_owned());
        check_texts(&mut received, &mut dated).unwrap();
        assert!(require_date(StampKind::Received, &dated).is_ok());
        let mut long_date = Some("1".repeat(DATE_MAX + 1));
        let mut ok = "X".to_owned();
        assert!(check_texts(&mut ok, &mut long_date).is_err());
    }

    #[test]
    fn a_zero_box_gets_its_natural_size_and_a_small_one_is_refused() {
        let mut zero = Rect {
            x: 10.0,
            y: 10.0,
            w: 0.0,
            h: 0.0,
        };
        size_box(&mut zero, "DRAFT", None).unwrap();
        assert!(zero.w > 60.0 && (zero.h - 34.0).abs() < 0.01);
        let mut tiny = Rect {
            x: 0.0,
            y: 0.0,
            w: 10.0,
            h: 10.0,
        };
        assert!(size_box(&mut tiny, "DRAFT", None).is_err());
    }

    #[test]
    fn the_font_is_fitted_to_the_box() {
        let wide = fitted_font("DRAFT", None, 400.0, 34.0);
        let narrow = fitted_font("DRAFT", None, 60.0, 34.0);
        assert!(narrow < wide);
        assert!((MIN_FONT_PT..=MAX_FONT_PT).contains(&wide));
        assert!(width_of("DRAFT", narrow) <= 60.0);
    }
}
