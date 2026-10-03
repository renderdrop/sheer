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
