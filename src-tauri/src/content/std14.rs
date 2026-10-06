//! Widths of the standard 14 fonts used by text boxes: Helvetica, Times-Roman and Courier (ADR-047 §1). owned by package A.
//!
//! The widths are the AFM `WX` values (1/1000 em) of the Adobe core 14 metrics, indexed by WinAnsi code. Only the codes of
//! `WinAnsiEncoding` that have a glyph are known; [`winansi`] says which characters those are.

use crate::model::annotation::StdFont;

/// The PDF base font name of `font`.
pub const fn base_font(font: StdFont) -> &'static str {
    match font {
        StdFont::Sans => "Helvetica",
        StdFont::Serif => "Times-Roman",
        StdFont::Mono => "Courier",
    }
}

/// The WinAnsi (Windows-1252) code of `c`, or `None` if the encoding has no glyph for it (the five holes of Windows-1252 included).
pub fn winansi(c: char) -> Option<u8> {
    let u = u32::from(c);
    match u {
        0x20..=0x7E | 0xA0..=0xFF => u8::try_from(u).ok(),
        _ => match c {
            '\u{20AC}' => Some(0x80),
            '\u{201A}' => Some(0x82),
            '\u{0192}' => Some(0x83),
            '\u{201E}' => Some(0x84),
            '\u{2026}' => Some(0x85),
            '\u{2020}' => Some(0x86),
            '\u{2021}' => Some(0x87),
            '\u{02C6}' => Some(0x88),
            '\u{2030}' => Some(0x89),
            '\u{0160}' => Some(0x8A),
            '\u{2039}' => Some(0x8B),
            '\u{0152}' => Some(0x8C),
            '\u{017D}' => Some(0x8E),
            '\u{2018}' => Some(0x91),
            '\u{2019}' => Some(0x92),
            '\u{201C}' => Some(0x93),
            '\u{201D}' => Some(0x94),
            '\u{2022}' => Some(0x95),
            '\u{2013}' => Some(0x96),
            '\u{2014}' => Some(0x97),
            '\u{02DC}' => Some(0x98),
            '\u{2122}' => Some(0x99),
            '\u{0161}' => Some(0x9A),
            '\u{203A}' => Some(0x9B),
            '\u{0153}' => Some(0x9C),
            '\u{017E}' => Some(0x9E),
            '\u{0178}' => Some(0x9F),
            _ => None,
        },
    }
}

/// Helvetica widths of the codes 32 to 126.
const HELVETICA_ASCII: [u16; 95] = [
    278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278,
    278, // space to /
    556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, // 0 to ?
    1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, // @ to O
    667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, // P to _
    333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, // ` to o
    556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584, // p to ~
];

/// Times-Roman widths of the codes 32 to 126.
const TIMES_ASCII: [u16; 95] = [
    250, 333, 408, 500, 500, 833, 778, 180, 333, 333, 500, 564, 250, 333, 250,
    278, // space to /
    500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 278, 278, 564, 564, 564, 444, // 0 to ?
    921, 722, 667, 667, 722, 611, 556, 722, 722, 333, 389, 722, 611, 889, 722, 722, // @ to O
    556, 722, 667, 556, 611, 722, 722, 944, 722, 722, 611, 333, 278, 333, 469, 500, // P to _
    333, 444, 500, 444, 500, 444, 333, 500, 500, 278, 278, 500, 278, 778, 500, 500, // ` to o
    500, 500, 333, 389, 278, 500, 500, 722, 500, 500, 444, 480, 200, 480, 541, // p to ~
];

/// `(Helvetica, Times-Roman)` of a code from 128 up (a code with no glyph in WinAnsi is never asked for).
const fn high(code: u8) -> (u16, u16) {
    match code {
        0x80 | 0x83 | 0xA2..=0xA5 | 0xA7 | 0xAB | 0xB5 | 0xBB => (556, 500),
        0x82 => (222, 333),
        0x84 | 0x93 | 0x94 => (333, 444),
        0x85 | 0x89 | 0x97 => (1000, 1000),
        0x86 | 0x87 | 0x96 | 0xF0..=0xF6 | 0xF9..=0xFC | 0xFE => (556, 500),
        0x88 | 0x8B | 0x98 | 0x9B | 0xA1 | 0xA8 | 0xAD | 0xAF | 0xB4 | 0xB8 => (333, 333),
        0x8A => (667, 556),
        0x8C => (1000, 889),
        0x8E => (611, 611),
        0x91 | 0x92 => (222, 333),
        0x95 => (350, 350),
        0x99 => (1000, 980),
        0x9A => (500, 389),
        0x9C => (944, 722),
        0x9E => (500, 444),
        0x9F => (667, 722),
        0xA0 => (278, 250),
        0xA6 => (260, 200),
        0xA9 | 0xAE => (737, 760),
        0xAA => (370, 276),
        0xAC | 0xB1 | 0xD7 | 0xF7 => (584, 564),
        0xB0 => (400, 400),
        0xB2 | 0xB3 | 0xB9 => (333, 300),
        0xB6 => (537, 453),
        0xB7 => (278, 250),
        0xBA => (365, 310),
        0xBC..=0xBE => (834, 750),
        0xBF => (611, 444),
        0xC0..=0xC5 => (667, 722),
        0xC6 => (1000, 889),
        0xC7 => (722, 667),
        0xC8..=0xCB => (667, 611),
        0xCC..=0xCF => (278, 333),
        0xD0 | 0xD1 | 0xD9..=0xDC => (722, 722),
        0xD2..=0xD6 | 0xD8 => (778, 722),
        0xDD => (667, 722),
        0xDE => (667, 556),
        0xDF => (611, 500),
        0xE0..=0xE5 => (556, 444),
        0xE6 => (889, 667),
        0xE7 => (500, 444),
        0xE8..=0xEB => (556, 444),
        0xEC..=0xEF => (278, 278),
        0xF8 => (611, 500),
        0xFD | 0xFF => (500, 500),
        _ => (556, 500),
    }
}

/// The advance width of WinAnsi `code` in `font`, in 1/1000 em.
pub fn width(font: StdFont, code: u8) -> u16 {
    if font == StdFont::Mono {
        return 600;
    }
    let (helvetica, times) = match code {
        0x20..=0x7E => {
            let index = usize::from(code - 0x20);
            (HELVETICA_ASCII[index], TIMES_ASCII[index])
        }
        0x7F..=0xFF => high(code),
        _ => (556, 500),
    };
    if font == StdFont::Sans {
        helvetica
    } else {
        times
    }
}

/// The width in points of `text` set in `font` at `size`. A character with no WinAnsi code counts as a space.
#[allow(clippy::cast_precision_loss)]
pub fn text_width(font: StdFont, text: &str, size: f32) -> f32 {
    let units: u32 = text
        .chars()
        .map(|c| u32::from(width(font, winansi(c).unwrap_or(b' '))))
        .sum();
    units as f32 * size / 1000.0
}

/// The 14 standard fonts (ISO 32000 §9.6.2.2).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Std14 {
    Helvetica,
    HelveticaBold,
    HelveticaOblique,
    HelveticaBoldOblique,
    TimesRoman,
    TimesBold,
    TimesItalic,
    TimesBoldItalic,
    Courier,
    CourierBold,
    CourierOblique,
    CourierBoldOblique,
    Symbol,
    ZapfDingbats,
}

/// Widths of the codes 32 to 255 by WinAnsi code, 0 where WinAnsi has no glyph. Regular and Bold of Helvetica; the Oblique faces share
/// them. Taken from the advance widths of the bundled metric-compatible Arimo faces (Arimo = Helvetica/Arial metrics) and checked
/// against the AFM values of the regular table above (five codes where Arial and Helvetica differ are set to the AFM values).
const HELVETICA_TABLES: [[u16; 224]; 2] = [
    // HELV0
    [
        278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556,
        556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722,
        722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722,
        667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556,
        556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500,
        500, 334, 260, 334, 584, 0, 556, 0, 222, 556, 333, 1000, 556, 556, 333, 1000, 667, 333,
        1000, 0, 611, 0, 0, 222, 222, 333, 333, 350, 556, 1000, 333, 1000, 500, 333, 944, 0, 500,
        667, 278, 333, 556, 556, 556, 556, 260, 556, 333, 737, 370, 556, 584, 333, 737, 333, 400,
        584, 333, 333, 333, 556, 537, 278, 333, 333, 365, 556, 834, 834, 834, 611, 667, 667, 667,
        667, 667, 667, 1000, 722, 667, 667, 667, 667, 278, 278, 278, 278, 722, 722, 778, 778, 778,
        778, 778, 584, 778, 722, 722, 722, 722, 667, 667, 611, 556, 556, 556, 556, 556, 556, 889,
        500, 556, 556, 556, 556, 278, 278, 278, 278, 556, 556, 556, 556, 556, 556, 556, 584, 611,
        556, 556, 556, 556, 500, 556, 500,
    ],
    // HELV1
    [
        278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556,
        556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722,
        722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722,
        667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611,
        611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556,
        500, 389, 280, 389, 584, 0, 556, 0, 278, 556, 500, 1000, 556, 556, 333, 1000, 667, 333,
        1000, 0, 611, 0, 0, 278, 278, 500, 500, 350, 556, 1000, 333, 1000, 556, 333, 944, 0, 500,
        667, 278, 333, 556, 556, 556, 556, 280, 556, 333, 737, 370, 556, 584, 333, 737, 333, 400,
        584, 333, 333, 333, 611, 556, 278, 333, 333, 365, 556, 834, 834, 834, 611, 722, 722, 722,
        722, 722, 722, 1000, 722, 667, 667, 667, 667, 278, 278, 278, 278, 722, 722, 778, 778, 778,
        778, 778, 584, 778, 722, 722, 722, 722, 667, 667, 611, 556, 556, 556, 556, 556, 556, 889,
        556, 556, 556, 556, 556, 278, 278, 278, 278, 611, 611, 611, 611, 611, 611, 611, 584, 611,
        611, 611, 611, 611, 556, 611, 556,
    ],
];

/// Regular, Bold, Italic and BoldItalic of Times, from the advance widths of Tinos (Times New Roman metrics), five codes set to the AFM values.
const TIMES_TABLES: [[u16; 224]; 4] = [
    // TIMES0
    [
        250, 333, 408, 500, 500, 833, 778, 180, 333, 333, 500, 564, 250, 333, 250, 278, 500, 500,
        500, 500, 500, 500, 500, 500, 500, 500, 278, 278, 564, 564, 564, 444, 921, 722, 667, 667,
        722, 611, 556, 722, 722, 333, 389, 722, 611, 889, 722, 722, 556, 722, 667, 556, 611, 722,
        722, 944, 722, 722, 611, 333, 278, 333, 469, 500, 333, 444, 500, 444, 500, 444, 333, 500,
        500, 278, 278, 500, 278, 778, 500, 500, 500, 500, 333, 389, 278, 500, 500, 722, 500, 500,
        444, 480, 200, 480, 541, 0, 500, 0, 333, 500, 444, 1000, 500, 500, 333, 1000, 556, 333,
        889, 0, 611, 0, 0, 333, 333, 444, 444, 350, 500, 1000, 333, 980, 389, 333, 722, 0, 444,
        722, 250, 333, 500, 500, 500, 500, 200, 500, 333, 760, 276, 500, 564, 333, 760, 333, 400,
        564, 300, 300, 333, 500, 453, 250, 333, 300, 310, 500, 750, 750, 750, 444, 722, 722, 722,
        722, 722, 722, 889, 667, 611, 611, 611, 611, 333, 333, 333, 333, 722, 722, 722, 722, 722,
        722, 722, 564, 722, 722, 722, 722, 722, 722, 556, 500, 444, 444, 444, 444, 444, 444, 667,
        444, 444, 444, 444, 444, 278, 278, 278, 278, 500, 500, 500, 500, 500, 500, 500, 564, 500,
        500, 500, 500, 500, 500, 500, 500,
    ],
    // TIMES1
    [
        250, 333, 555, 500, 500, 1000, 833, 278, 333, 333, 500, 570, 250, 333, 250, 278, 500, 500,
        500, 500, 500, 500, 500, 500, 500, 500, 333, 333, 570, 570, 570, 500, 930, 722, 667, 722,
        722, 667, 611, 778, 778, 389, 500, 778, 667, 944, 722, 778, 611, 778, 722, 556, 667, 722,
        722, 1000, 722, 722, 667, 333, 278, 333, 581, 500, 333, 500, 556, 444, 556, 444, 333, 500,
        556, 278, 333, 556, 278, 833, 556, 500, 556, 556, 444, 389, 333, 556, 500, 722, 500, 500,
        444, 394, 220, 394, 520, 0, 500, 0, 333, 500, 500, 1000, 500, 500, 333, 1000, 556, 333,
        1000, 0, 667, 0, 0, 333, 333, 500, 500, 350, 500, 1000, 333, 1000, 389, 333, 722, 0, 444,
        722, 250, 333, 500, 500, 500, 500, 220, 500, 333, 747, 300, 500, 570, 333, 747, 333, 400,
        570, 300, 300, 333, 556, 540, 250, 333, 300, 330, 500, 750, 750, 750, 500, 722, 722, 722,
        722, 722, 722, 1000, 722, 667, 667, 667, 667, 389, 389, 389, 389, 722, 722, 778, 778, 778,
        778, 778, 570, 778, 722, 722, 722, 722, 722, 611, 556, 500, 500, 500, 500, 500, 500, 722,
        444, 444, 444, 444, 444, 278, 278, 278, 278, 500, 556, 500, 500, 500, 500, 500, 570, 500,
        556, 556, 556, 556, 500, 556, 500,
    ],
    // TIMES2
    [
        250, 333, 420, 500, 500, 833, 778, 214, 333, 333, 500, 675, 250, 333, 250, 278, 500, 500,
        500, 500, 500, 500, 500, 500, 500, 500, 333, 333, 675, 675, 675, 500, 920, 611, 611, 667,
        722, 611, 611, 722, 722, 333, 444, 667, 556, 833, 667, 722, 611, 722, 611, 500, 556, 722,
        611, 833, 611, 556, 556, 389, 278, 389, 422, 500, 333, 500, 500, 444, 500, 444, 278, 500,
        500, 278, 278, 444, 278, 722, 500, 500, 500, 500, 389, 389, 278, 500, 444, 667, 444, 444,
        389, 400, 275, 400, 541, 0, 500, 0, 333, 500, 556, 889, 500, 500, 333, 1000, 500, 333, 944,
        0, 556, 0, 0, 333, 333, 556, 556, 350, 500, 889, 333, 980, 389, 333, 667, 0, 389, 556, 250,
        389, 500, 500, 500, 500, 275, 500, 333, 760, 276, 500, 675, 333, 760, 333, 400, 675, 300,
        300, 333, 500, 523, 250, 333, 300, 310, 500, 750, 750, 750, 500, 611, 611, 611, 611, 611,
        611, 889, 667, 611, 611, 611, 611, 333, 333, 333, 333, 722, 667, 722, 722, 722, 722, 722,
        675, 722, 722, 722, 722, 722, 556, 611, 500, 500, 500, 500, 500, 500, 500, 667, 444, 444,
        444, 444, 444, 278, 278, 278, 278, 500, 500, 500, 500, 500, 500, 500, 675, 500, 500, 500,
        500, 500, 444, 500, 444,
    ],
    // TIMES3
    [
        250, 389, 555, 500, 500, 833, 778, 278, 333, 333, 500, 570, 250, 333, 250, 278, 500, 500,
        500, 500, 500, 500, 500, 500, 500, 500, 333, 333, 570, 570, 570, 500, 832, 667, 667, 667,
        722, 667, 667, 722, 778, 389, 500, 667, 611, 889, 722, 722, 611, 722, 667, 556, 611, 722,
        667, 889, 667, 611, 611, 333, 278, 333, 570, 500, 333, 500, 500, 444, 500, 444, 333, 500,
        556, 278, 278, 500, 278, 778, 556, 500, 500, 500, 389, 389, 278, 556, 444, 667, 500, 444,
        389, 348, 220, 348, 570, 0, 500, 0, 333, 500, 500, 1000, 500, 500, 333, 1000, 556, 333,
        944, 0, 611, 0, 0, 333, 333, 500, 500, 350, 500, 1000, 333, 1000, 389, 333, 722, 0, 389,
        611, 250, 389, 500, 500, 500, 500, 220, 500, 333, 747, 266, 500, 606, 333, 747, 333, 400,
        570, 300, 300, 333, 576, 500, 250, 333, 300, 300, 500, 750, 750, 750, 500, 667, 667, 667,
        667, 667, 667, 944, 667, 667, 667, 667, 667, 389, 389, 389, 389, 722, 722, 722, 722, 722,
        722, 722, 570, 722, 722, 722, 722, 722, 611, 611, 500, 500, 500, 500, 500, 500, 500, 722,
        444, 444, 444, 444, 444, 278, 278, 278, 278, 500, 556, 500, 500, 500, 500, 500, 570, 500,
        556, 556, 556, 556, 444, 500, 444,
    ],
];

/// The standard font a `/BaseFont` names (also the common aliases Arial, TimesNewRoman, CourierNew with their style suffixes), or `None`.
/// A subset tag (`ABCDEF+`) is not removed; callers pass the name of a non-embedded font.
pub fn std14_from_name(base: &[u8]) -> Option<Std14> {
    let name: String = String::from_utf8_lossy(base)
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect::<String>()
        .to_ascii_lowercase();
    let bold = name.contains("bold");
    let italic = name.contains("italic") || name.contains("oblique");
    let family = if name.starts_with("helvetica") || name.starts_with("arial") {
        0
    } else if name.starts_with("timesnewroman") || name.starts_with("times") {
        1
    } else if name.starts_with("couriernew") || name.starts_with("courier") {
        2
    } else if name == "symbol" || name.starts_with("symbolmt") {
        return Some(Std14::Symbol);
    } else if name.starts_with("zapfdingbats") {
        return Some(Std14::ZapfDingbats);
    } else {
        return None;
    };
    Some(match (family, bold, italic) {
        (0, false, false) => Std14::Helvetica,
        (0, true, false) => Std14::HelveticaBold,
        (0, false, true) => Std14::HelveticaOblique,
        (0, true, true) => Std14::HelveticaBoldOblique,
        (1, false, false) => Std14::TimesRoman,
        (1, true, false) => Std14::TimesBold,
        (1, false, true) => Std14::TimesItalic,
        (1, true, true) => Std14::TimesBoldItalic,
        (_, false, false) => Std14::Courier,
        (_, true, false) => Std14::CourierBold,
        (_, false, true) => Std14::CourierOblique,
        (_, true, true) => Std14::CourierBoldOblique,
    })
}

/// The AFM advance width in 1/1000 em of the character with WinAnsi `code` in `font`. `None` for a code WinAnsi has no glyph for, and
/// for Symbol and ZapfDingbats (their own encodings; no verified metrics are bundled).
pub fn std14_width(font: Std14, code: u8) -> Option<u16> {
    let index = usize::from(code).checked_sub(32)?;
    let width = match font {
        Std14::Helvetica | Std14::HelveticaOblique => HELVETICA_TABLES[0][index],
        Std14::HelveticaBold | Std14::HelveticaBoldOblique => HELVETICA_TABLES[1][index],
        Std14::TimesRoman => TIMES_TABLES[0][index],
        Std14::TimesBold => TIMES_TABLES[1][index],
        Std14::TimesItalic => TIMES_TABLES[2][index],
        Std14::TimesBoldItalic => TIMES_TABLES[3][index],
        Std14::Courier | Std14::CourierBold | Std14::CourierOblique | Std14::CourierBoldOblique => {
            if winansi_has_glyph(code) {
                600
            } else {
                0
            }
        }
        Std14::Symbol | Std14::ZapfDingbats => return None,
    };
    (width > 0).then_some(width)
}

/// WinAnsi has a glyph for the code (32 to 126, 128 to 255 except the holes of Windows-1252).
fn winansi_has_glyph(code: u8) -> bool {
    matches!(code, 0x20..=0x7E | 0xA0..=0xFF)
        || (0x80..=0x9F).contains(&code) && !matches!(code, 0x81 | 0x8D | 0x8F | 0x90 | 0x9D)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_afm_widths() {
        assert_eq!(width(StdFont::Sans, b'A'), 667);
        assert_eq!(width(StdFont::Sans, b'i'), 222);
        assert_eq!(width(StdFont::Serif, b'A'), 722);
        assert_eq!(width(StdFont::Serif, b' '), 250);
        assert_eq!(width(StdFont::Mono, b'W'), 600);
        assert_eq!(width(StdFont::Sans, 0xE4), 556);
        assert_eq!(width(StdFont::Serif, 0xDF), 500);
        assert_eq!(width(StdFont::Sans, 0x80), 556);
    }

    #[test]
    fn hello_world_in_helvetica() {
        // H 722 e 556 l 222 l 222 o 556 = 2278
        assert!((text_width(StdFont::Sans, "Hello", 10.0) - 22.78).abs() < 1e-3);
    }

    #[test]
    fn winansi_maps_german_and_rejects_others() {
        assert_eq!(winansi('ä'), Some(0xE4));
        assert_eq!(winansi('ß'), Some(0xDF));
        assert_eq!(winansi('€'), Some(0x80));
        assert_eq!(winansi('\u{201C}'), Some(0x93));
        assert_eq!(winansi('中'), None);
        assert_eq!(winansi('\u{81}'), None);
        assert_eq!(winansi('\n'), None);
    }
}

#[cfg(test)]
mod std14_tests {
    use super::*;

    #[test]
    fn tables_agree_with_the_regular_afm_widths() {
        for code in 32u8..=255 {
            if !winansi_has_glyph(code) {
                assert_eq!(std14_width(Std14::Helvetica, code), None, "{code}");
                continue;
            }
            assert_eq!(
                std14_width(Std14::Helvetica, code),
                Some(width(StdFont::Sans, code)),
                "Helvetica {code}"
            );
            assert_eq!(
                std14_width(Std14::TimesRoman, code),
                Some(width(StdFont::Serif, code)),
                "Times {code}"
            );
            assert_eq!(std14_width(Std14::CourierBold, code), Some(600));
        }
    }

    #[test]
    fn known_afm_values_of_the_other_faces() {
        // Helvetica-Bold: A 722, a 556, space 278; Times-Bold: A 722, a 500; Times-Italic: A 611, a 500; Times-BoldItalic: A 667.
        assert_eq!(std14_width(Std14::HelveticaBold, b'A'), Some(722));
        assert_eq!(std14_width(Std14::HelveticaBold, b'a'), Some(556));
        assert_eq!(std14_width(Std14::HelveticaBoldOblique, b'a'), Some(556));
        assert_eq!(std14_width(Std14::TimesBold, b'A'), Some(722));
        assert_eq!(std14_width(Std14::TimesBold, b'a'), Some(500));
        assert_eq!(std14_width(Std14::TimesItalic, b'A'), Some(611));
        assert_eq!(std14_width(Std14::TimesBoldItalic, b'A'), Some(667));
        assert_eq!(std14_width(Std14::Symbol, b'A'), None);
    }

    #[test]
    fn names_and_aliases() {
        assert_eq!(
            std14_from_name(b"Helvetica-BoldOblique"),
            Some(Std14::HelveticaBoldOblique)
        );
        assert_eq!(std14_from_name(b"Arial,Bold"), Some(Std14::HelveticaBold));
        assert_eq!(
            std14_from_name(b"TimesNewRomanPS-ItalicMT"),
            Some(Std14::TimesItalic)
        );
        assert_eq!(std14_from_name(b"Times-Roman"), Some(Std14::TimesRoman));
        assert_eq!(std14_from_name(b"CourierNewPSMT"), Some(Std14::Courier));
        assert_eq!(std14_from_name(b"Symbol"), Some(Std14::Symbol));
        assert_eq!(std14_from_name(b"ZapfDingbats"), Some(Std14::ZapfDingbats));
        assert_eq!(std14_from_name(b"Calibri"), None);
    }
}
