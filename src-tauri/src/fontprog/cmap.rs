//! The `ToUnicode` CMap parser (`bfchar`, `bfrange`), bounded by `limits::TOUNICODE_*`.
//!
//! Only the two bf sections are read; `codespacerange` and `usecmap` are ignored (the codes of an editable font are one byte, or two
//! for `Identity-H`). No PostScript is executed: the stream is cut into tokens and only `<hex>`, `[`, `]` and words are looked at.

use std::collections::HashMap;

use crate::error::AppError;
use crate::limits::{
    TOUNICODE_DEST_UNITS, TOUNICODE_MAX_BYTES, TOUNICODE_MAX_MAPPINGS, TOUNICODE_RANGE_MAX,
};

/// Character code to the text it stands for (at most `limits::TOUNICODE_DEST_UNITS` UTF-16 units each).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ToUnicode {
    pub map: HashMap<u32, String>,
}

impl ToUnicode {
    /// The reverse lookup for one character: every code that maps to exactly `c`, ascending.
    pub fn codes_for(&self, c: char) -> Vec<u32> {
        let mut buf = [0u8; 4];
        let wanted: &str = c.encode_utf8(&mut buf);
        let mut codes: Vec<u32> = self
            .map
            .iter()
            .filter(|(_, text)| text.as_str() == wanted)
            .map(|(code, _)| *code)
            .collect();
        codes.sort_unstable();
        codes
    }
}

#[derive(Debug, PartialEq)]
enum Tok {
    Hex(Vec<u8>),
    Open,
    Close,
    Word(Vec<u8>),
}

/// Cuts the stream into tokens; stops after `limit` of them (the caller treats that as over the limit).
fn tokens(data: &[u8], limit: usize) -> Option<Vec<Tok>> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < data.len() {
        if out.len() >= limit {
            return None;
        }
        match data[i] {
            b'<' if data.get(i + 1) != Some(&b'<') => {
                let mut j = i + 1;
                let mut digits: Vec<u8> = Vec::new();
                while j < data.len() && data[j] != b'>' {
                    if let Some(d) = (data[j] as char).to_digit(16) {
                        // `to_digit(16)` is below 16, the cast cannot truncate.
                        #[allow(clippy::cast_possible_truncation)]
                        digits.push(d as u8);
                    }
                    j += 1;
                }
                if digits.len() % 2 == 1 {
                    digits.push(0);
                }
                out.push(Tok::Hex(
                    digits.chunks(2).map(|p| p[0] * 16 + p[1]).collect(),
                ));
                i = j + 1;
            }
            b'[' => {
                out.push(Tok::Open);
                i += 1;
            }
            b']' => {
                out.push(Tok::Close);
                i += 1;
            }
            b'%' => {
                while i < data.len() && data[i] != b'\n' && data[i] != b'\r' {
                    i += 1;
                }
            }
            c if c.is_ascii_alphabetic() => {
                let start = i;
                while i < data.len() && data[i].is_ascii_alphanumeric() {
                    i += 1;
                }
                out.push(Tok::Word(data[start..i].to_vec()));
            }
            _ => i += 1,
        }
    }
    Some(out)
}

fn code_of(bytes: &[u8]) -> Option<u32> {
    (!bytes.is_empty() && bytes.len() <= 4)
        .then(|| bytes.iter().fold(0u32, |a, b| (a << 8) | u32::from(*b)))
}

/// The UTF-16BE `bytes` as text; `None` when it is longer than `TOUNICODE_DEST_UNITS` units.
fn utf16(bytes: &[u8]) -> Option<String> {
    if bytes.len() > TOUNICODE_DEST_UNITS * 2 {
        return None;
    }
    let units: Vec<u16> = bytes
        .chunks(2)
        .map(|p| (u16::from(p[0]) << 8) | u16::from(*p.get(1).unwrap_or(&0)))
        .collect();
    Some(
        char::decode_utf16(units)
            .map(|r| r.unwrap_or('\u{FFFD}'))
            .collect(),
    )
}

/// `dst` with its last UTF-16 unit raised by `by`.
fn bumped(dst: &[u8], by: u32) -> Option<String> {
    let mut bytes = dst.to_vec();
    if bytes.len() >= 2 {
        let n = bytes.len();
        let unit = (u32::from(bytes[n - 2]) << 8) | u32::from(bytes[n - 1]);
        let unit = unit.wrapping_add(by);
        bytes[n - 2] = (unit >> 8) as u8;
        bytes[n - 1] = unit as u8;
    }
    utf16(&bytes)
}

/// Parses the decoded stream. `limit_exceeded` over the limits, `invalid_argument` for a stream that is not a CMap.
pub fn parse(data: &[u8]) -> Result<ToUnicode, AppError> {
    if data.len() > TOUNICODE_MAX_BYTES {
        return Err(AppError::limit("toUnicode", TOUNICODE_MAX_BYTES as u64));
    }
    let toks = tokens(data, 8 * TOUNICODE_MAX_MAPPINGS)
        .ok_or(AppError::limit("toUnicode", TOUNICODE_MAX_MAPPINGS as u64))?;
    let is_cmap = toks.iter().any(|t| {
        matches!(t, Tok::Word(w) if w == b"begincmap" || w == b"beginbfchar" || w == b"beginbfrange")
    });
    if !is_cmap {
        return Err(AppError::invalid("toUnicode"));
    }
    let too_many = || AppError::limit("toUnicode", TOUNICODE_MAX_MAPPINGS as u64);
    let mut map: HashMap<u32, String> = HashMap::new();
    let put = |map: &mut HashMap<u32, String>, code: u32, text: Option<String>| {
        let Some(text) = text else {
            return Ok(());
        };
        map.insert(code, text);
        if map.len() > TOUNICODE_MAX_MAPPINGS {
            return Err(too_many());
        }
        Ok(())
    };
    let mut i = 0;
    while i < toks.len() {
        match &toks[i] {
            Tok::Word(w) if w == b"beginbfchar" => {
                i += 1;
                while let (Some(Tok::Hex(src)), Some(Tok::Hex(dst))) =
                    (toks.get(i), toks.get(i + 1))
                {
                    if let Some(code) = code_of(src) {
                        put(&mut map, code, utf16(dst))?;
                    }
                    i += 2;
                }
            }
            Tok::Word(w) if w == b"beginbfrange" => {
                i += 1;
                while let (Some(Tok::Hex(lo)), Some(Tok::Hex(hi))) = (toks.get(i), toks.get(i + 1))
                {
                    let (Some(lo), Some(hi)) = (code_of(lo), code_of(hi)) else {
                        break;
                    };
                    i += 2;
                    if hi >= lo && hi - lo >= TOUNICODE_RANGE_MAX {
                        return Err(AppError::limit("toUnicode", u64::from(TOUNICODE_RANGE_MAX)));
                    }
                    let ok = hi >= lo;
                    match toks.get(i) {
                        Some(Tok::Hex(dst)) => {
                            if ok {
                                for code in lo..=hi {
                                    put(&mut map, code, bumped(dst, code - lo))?;
                                }
                            }
                            i += 1;
                        }
                        Some(Tok::Open) => {
                            i += 1;
                            let mut k = 0u32;
                            while let Some(Tok::Hex(dst)) = toks.get(i) {
                                if let (true, Some(code)) = (ok, lo.checked_add(k)) {
                                    if code <= hi {
                                        put(&mut map, code, utf16(dst))?;
                                    }
                                }
                                k = k.saturating_add(1);
                                i += 1;
                            }
                            if toks.get(i) == Some(&Tok::Close) {
                                i += 1;
                            }
                        }
                        _ => break,
                    }
                }
            }
            _ => i += 1,
        }
    }
    Ok(ToUnicode { map })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorCode;

    #[test]
    fn chars_ranges_and_reverse() {
        let cmap = b"/CIDInit begincmap 2 beginbfchar <0003> <0020> <0004> <00660069> endbfchar \
            2 beginbfrange <0010> <0012> <0041> <0020> <0021> [<0061> <0062>] endbfrange endcmap";
        let map = parse(cmap).unwrap();
        assert_eq!(map.map[&3], " ");
        assert_eq!(map.map[&4], "fi");
        assert_eq!(map.map[&0x11], "B");
        assert_eq!(map.map[&0x21], "b");
        assert_eq!(map.codes_for('B'), vec![0x11]);
        assert!(map.codes_for('f').is_empty(), "ligature is not exactly f");
    }

    #[test]
    fn several_codes_for_one_char_ascend() {
        let map = parse(b"begincmap 2 beginbfchar <0009> <0041> <0002> <0041> endbfchar endcmap")
            .unwrap();
        assert_eq!(map.codes_for('A'), vec![2, 9]);
    }

    #[test]
    fn not_a_cmap_is_invalid() {
        let err = parse(b"hello world").unwrap_err();
        assert_eq!(err.code(), ErrorCode::InvalidArgument);
    }

    #[test]
    fn hostile_range_is_over_the_limit() {
        let err = parse(b"1 beginbfrange <0000> <FFFFFFFF> <0041> endbfrange").unwrap_err();
        assert_eq!(err.code(), ErrorCode::LimitExceeded);
    }

    #[test]
    fn mappings_are_capped() {
        let mut data = String::from("begincmap 2 beginbfrange\n");
        for n in 0..3u32 {
            data.push_str(&format!(
                "<{:08X}> <{:08X}> <0041>\n",
                n * 70_000,
                n * 70_000 + 65_000
            ));
        }
        data.push_str("endbfrange");
        let err = parse(data.as_bytes()).unwrap_err();
        assert_eq!(err.code(), ErrorCode::LimitExceeded);
    }

    #[test]
    fn long_destination_is_dropped() {
        let dst = "0041".repeat(TOUNICODE_DEST_UNITS + 1);
        let data = format!("begincmap 1 beginbfchar <01> <{dst}> endbfchar");
        assert!(parse(data.as_bytes()).unwrap().map.is_empty());
    }

    #[test]
    fn truncated_and_oversized_input_never_panics() {
        let good = b"begincmap 1 beginbfrange <0000> <00FF> <0020> endbfrange endcmap";
        for n in 0..good.len() {
            let _ = parse(&good[..n]);
        }
        let big = vec![b'<'; TOUNICODE_MAX_BYTES + 1];
        assert_eq!(parse(&big).unwrap_err().code(), ErrorCode::LimitExceeded);
        let _ = parse(&[b'['; 5_000]);
    }
}
