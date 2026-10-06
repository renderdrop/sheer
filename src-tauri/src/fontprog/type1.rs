//! Type1 programs (`FontFile`): a bounded scan of the cleartext part and of the `eexec` part for `/Encoding` and `/CharStrings` names.
//! No charstring is executed: each one is decrypted (a plain byte loop) and only looked at for drawing operators.

use crate::error::AppError;
use crate::limits::{FONT_GLYPHS_MAX, FONT_PROGRAM_MAX};

/// What the scan found.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Type1Info {
    /// The built-in encoding: code to glyph name. Empty when the font says `StandardEncoding` (or has none).
    pub encoding: Vec<(u8, String)>,
    /// Names in `/CharStrings`, with the number of charstring bytes (0 = empty outline).
    pub char_strings: Vec<(String, u32)>,
}

/// Longest glyph name and longest single charstring that are accepted.
const NAME_MAX: usize = 128;
const CHARSTRING_MAX: usize = 64 << 10;

const EEXEC_KEY: u16 = 55_665;
const CHARSTRING_KEY: u16 = 4_330;

/// Joins the segments of a PFB file; anything else is returned as it is.
fn unwrap_pfb(data: &[u8]) -> Vec<u8> {
    if data.first() != Some(&0x80) {
        return data.to_vec();
    }
    let mut out = Vec::new();
    let mut i = 0;
    while i + 6 <= data.len() && data[i] == 0x80 {
        let kind = data[i + 1];
        if kind == 3 {
            break;
        }
        let len = u32::from_le_bytes([data[i + 2], data[i + 3], data[i + 4], data[i + 5]]) as usize;
        let start = i + 6;
        let end = start.saturating_add(len).min(data.len());
        out.extend_from_slice(&data[start..end]);
        i = end;
    }
    out
}

fn find(hay: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    if needle.is_empty() || hay.len() < needle.len() {
        return None;
    }
    (from..=hay.len() - needle.len()).find(|&i| &hay[i..i + needle.len()] == needle)
}

fn is_space(b: u8) -> bool {
    matches!(b, b' ' | b'\t' | b'\r' | b'\n' | 0x0C | 0)
}

fn decrypt(data: &[u8], key: u16, skip: usize) -> Vec<u8> {
    let mut r = key;
    let mut out = Vec::with_capacity(data.len().saturating_sub(skip));
    for (i, &c) in data.iter().enumerate() {
        let plain = c ^ (r >> 8) as u8;
        r = (u16::from(c).wrapping_add(r))
            .wrapping_mul(52_845)
            .wrapping_add(22_719);
        if i >= skip {
            out.push(plain);
        }
    }
    out
}

/// A reader over the text of a PostScript part: words, `/names`, integers.
struct Text<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> Text<'a> {
    fn skip_space(&mut self) {
        while self.pos < self.data.len() && is_space(self.data[self.pos]) {
            self.pos += 1;
        }
    }

    /// The next whitespace-delimited word (a `/name` includes its slash).
    fn word(&mut self) -> Option<&'a [u8]> {
        self.skip_space();
        let start = self.pos;
        if start >= self.data.len() {
            return None;
        }
        self.pos += 1;
        while self.pos < self.data.len() {
            let b = self.data[self.pos];
            if is_space(b) || matches!(b, b'/' | b'{' | b'}' | b'[' | b']' | b'(') {
                break;
            }
            self.pos += 1;
        }
        Some(&self.data[start..self.pos])
    }
}

fn int(word: &[u8]) -> Option<usize> {
    if word.is_empty() || word.len() > 9 || !word.iter().all(u8::is_ascii_digit) {
        return None;
    }
    std::str::from_utf8(word).ok()?.parse().ok()
}

fn name(word: &[u8]) -> Option<String> {
    let body = word.strip_prefix(b"/")?;
    (body.len() <= NAME_MAX && body.is_ascii()).then(|| String::from_utf8_lossy(body).into_owned())
}

/// `/Encoding 256 array ... dup 65 /A put ... readonly def` or `/Encoding StandardEncoding def`.
fn scan_encoding(clear: &[u8]) -> Vec<(u8, String)> {
    let mut out = Vec::new();
    let Some(at) = find(clear, b"/Encoding", 0) else {
        return out;
    };
    let mut t = Text {
        data: clear,
        pos: at + b"/Encoding".len(),
    };
    let mut words = 0usize;
    while let Some(w) = t.word() {
        words += 1;
        if w == b"StandardEncoding" || w == b"def" || words > 8 * 256 + 64 {
            break;
        }
        if w == b"dup" {
            let code = t.word().and_then(int);
            let glyph = t.word().and_then(name);
            if let (Some(code), Some(glyph)) = (code, glyph) {
                if let Ok(code) = u8::try_from(code) {
                    if glyph != ".notdef" && out.len() < 256 {
                        out.push((code, glyph));
                    }
                }
            }
        }
    }
    out
}

/// Decodes the charstring `cs` far enough to say whether it draws: a move, line, curve, `seac` or a subroutine call.
fn draws(cs: &[u8]) -> bool {
    let mut i = 0;
    while i < cs.len() {
        match cs[i] {
            // rmoveto, hmoveto, vmoveto, rlineto, hlineto, vlineto, rrcurveto, vhcurveto, hvcurveto, callsubr
            5..=8 | 10 | 21 | 22 | 4 | 30 | 31 => return true,
            12 => {
                // seac (6) draws two glyphs; callothersubr (16) is flex or hint replacement.
                if matches!(cs.get(i + 1), Some(6 | 16)) {
                    return true;
                }
                i += 2;
            }
            0..=31 => i += 1,
            32..=246 => i += 1,
            247..=254 => i += 2,
            255 => i += 5,
        }
    }
    false
}

fn scan_char_strings(private: &[u8]) -> Result<Vec<(String, u32)>, AppError> {
    let mut out = Vec::new();
    let Some(at) = find(private, b"/CharStrings", 0) else {
        return Ok(out);
    };
    // lenIV: the number of random bytes in front of each charstring (default 4).
    let len_iv = find(private, b"/lenIV", 0)
        .and_then(|p| {
            Text {
                data: private,
                pos: p + b"/lenIV".len(),
            }
            .word()
            .and_then(int)
        })
        .map_or(4, |n| n.min(16));
    let mut t = Text {
        data: private,
        pos: at + b"/CharStrings".len(),
    };
    // `/CharStrings 229 dict dup begin`
    while let Some(w) = t.word() {
        if w == b"begin" {
            break;
        }
        if w.starts_with(b"/") {
            return Ok(out);
        }
    }
    while let Some(w) = t.word() {
        if w == b"end" {
            break;
        }
        let Some(glyph) = name(w) else {
            continue;
        };
        let (Some(len), Some(_rd)) = (t.word().and_then(int), t.word()) else {
            break;
        };
        // One separator byte follows RD, then `len` binary bytes.
        let start = t.pos + 1;
        let Some(end) = start.checked_add(len) else {
            break;
        };
        if len > CHARSTRING_MAX || end > private.len() {
            break;
        }
        let plain = decrypt(&private[start..end], CHARSTRING_KEY, len_iv);
        let size = if draws(&plain) {
            u32::try_from(plain.len().max(1)).unwrap_or(u32::MAX)
        } else {
            0
        };
        if out.len() >= FONT_GLYPHS_MAX {
            return Err(AppError::limit("fontGlyphs", FONT_GLYPHS_MAX as u64));
        }
        out.push((glyph, size));
        t.pos = end;
    }
    Ok(out)
}

/// Scans a `FontFile` (PFA, PFB or the bare binary form PDF uses). `limit_exceeded` over the font limits, `invalid_argument` when
/// there is neither an `/Encoding` nor a `/CharStrings` to be found.
pub fn scan(data: &[u8]) -> Result<Type1Info, AppError> {
    if data.len() > FONT_PROGRAM_MAX {
        return Err(AppError::limit("fontProgram", FONT_PROGRAM_MAX as u64));
    }
    let data = unwrap_pfb(data);
    let eexec = find(&data, b"eexec", 0);
    let clear_end = eexec.unwrap_or(data.len());
    let encoding = scan_encoding(&data[..clear_end]);
    let private = match eexec {
        None => data.clone(),
        Some(at) => {
            let mut start = at + b"eexec".len();
            while start < data.len() && is_space(data[start]) {
                start += 1;
            }
            let body = &data[start..];
            let hex = body.len() >= 4 && body[..4].iter().all(u8::is_ascii_hexdigit);
            if hex {
                let digits: Vec<u8> = body
                    .iter()
                    .filter_map(|b| (*b as char).to_digit(16))
                    .map(|d| d as u8)
                    .collect();
                let raw: Vec<u8> = digits
                    .chunks(2)
                    .filter(|p| p.len() == 2)
                    .map(|p| p[0] * 16 + p[1])
                    .collect();
                decrypt(&raw, EEXEC_KEY, 4)
            } else {
                decrypt(body, EEXEC_KEY, 4)
            }
        }
    };
    let char_strings = scan_char_strings(&private)?;
    if encoding.is_empty() && char_strings.is_empty() {
        return Err(AppError::invalid("fontProgram"));
    }
    Ok(Type1Info {
        encoding,
        char_strings,
    })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::error::ErrorCode;

    fn encrypt(plain: &[u8], key: u16, prefix: usize) -> Vec<u8> {
        let mut r = key;
        let mut out = Vec::new();
        for &p in std::iter::repeat_n(&0u8, prefix).chain(plain.iter()) {
            let c = p ^ (r >> 8) as u8;
            r = (u16::from(c).wrapping_add(r))
                .wrapping_mul(52_845)
                .wrapping_add(22_719);
            out.push(c);
        }
        out
    }

    /// A tiny Type1 program: `.notdef` (empty), `space` (empty) and `A` (a line), with a built-in encoding of two codes.
    pub(crate) fn sample(hex: bool) -> Vec<u8> {
        let notdef = encrypt(&[139, 248, 136, 13, 14], CHARSTRING_KEY, 4); // 0 500 hsbw endchar
        let a = encrypt(&[139, 248, 136, 13, 239, 239, 5, 14], CHARSTRING_KEY, 4); // ... rlineto endchar
        let mut private = b"dup /Private 8 dict dup begin /RD {string currentfile exch readstring pop} executeonly def \
            /lenIV 4 def 3 index /CharStrings 3 dict dup begin\n"
            .to_vec();
        for (n, cs) in [(".notdef", &notdef), ("space", &notdef), ("A", &a)] {
            private.extend_from_slice(format!("/{n} {} RD ", cs.len()).as_bytes());
            private.extend_from_slice(cs);
            private.extend_from_slice(b" ND\n");
        }
        private.extend_from_slice(b"end end readonly put\n");
        let sealed = encrypt(&private, EEXEC_KEY, 4);
        let mut out = b"%!PS-AdobeFont-1.0: Test\n/Encoding 256 array\n0 1 255 {1 index exch /.notdef put} for\n\
            dup 32 /space put\ndup 65 /A put\nreadonly def\ncurrentfile eexec\n"
            .to_vec();
        if hex {
            for b in sealed {
                out.extend_from_slice(format!("{b:02x}").as_bytes());
            }
        } else {
            out.extend_from_slice(&sealed);
        }
        out.extend_from_slice(b"\n0000000000\ncleartomark\n");
        out
    }

    #[test]
    fn binary_and_hex_eexec_are_read() {
        for hex in [false, true] {
            let info = scan(&sample(hex)).unwrap();
            assert_eq!(
                info.encoding,
                vec![(32, "space".to_string()), (65, "A".to_string())]
            );
            let names: Vec<&str> = info.char_strings.iter().map(|(n, _)| n.as_str()).collect();
            assert_eq!(names, [".notdef", "space", "A"]);
            assert_eq!(info.char_strings[0].1, 0, "empty outline");
            assert_eq!(info.char_strings[1].1, 0);
            assert!(info.char_strings[2].1 > 0, "A draws");
        }
    }

    #[test]
    fn pfb_segments_are_joined() {
        let raw = sample(false);
        let split = find(&raw, b"eexec\n", 0).unwrap() + 6;
        let mut pfb = vec![0x80, 1];
        pfb.extend_from_slice(&(split as u32).to_le_bytes());
        pfb.extend_from_slice(&raw[..split]);
        pfb.extend_from_slice(&[0x80, 2]);
        pfb.extend_from_slice(&((raw.len() - split) as u32).to_le_bytes());
        pfb.extend_from_slice(&raw[split..]);
        pfb.extend_from_slice(&[0x80, 3]);
        assert_eq!(scan(&pfb).unwrap().char_strings.len(), 3);
    }

    #[test]
    fn standard_encoding_gives_no_entries() {
        let mut data = sample(false);
        let text = b"/Encoding StandardEncoding def\n";
        let at = find(&data, b"/Encoding 256", 0).unwrap();
        let end = find(&data, b"currentfile", 0).unwrap();
        data.splice(at..end, text.iter().copied());
        let info = scan(&data).unwrap();
        assert!(info.encoding.is_empty());
        assert_eq!(info.char_strings.len(), 3);
    }

    #[test]
    fn hostile_input_is_bounded() {
        let good = sample(false);
        for n in (0..good.len()).step_by(7) {
            let _ = scan(&good[..n]);
        }
        // a charstring length that points far beyond the data
        let evil = b"/Encoding StandardEncoding def currentfile eexec";
        let mut data = evil.to_vec();
        data.extend_from_slice(&encrypt(
            b"/CharStrings 1 dict dup begin /A 999999999 RD xx ND end",
            EEXEC_KEY,
            4,
        ));
        let _ = scan(&data);
        assert_eq!(
            scan(b"nothing to see").unwrap_err().code(),
            ErrorCode::InvalidArgument
        );
        assert_eq!(
            scan(&vec![0u8; FONT_PROGRAM_MAX + 1]).unwrap_err().code(),
            ErrorCode::LimitExceeded
        );
        // an encoding that never ends
        let mut cyc = b"/Encoding 256 array ".to_vec();
        for _ in 0..100_000 {
            cyc.extend_from_slice(b"dup 1 /A put ");
        }
        let _ = scan(&cyc);
        // random-looking bytes through the decrypt path
        let noise: Vec<u8> = (0..4096u32)
            .map(|i| (i.wrapping_mul(2_654_435_761) >> 13) as u8)
            .collect();
        let mut with_eexec = b"eexec ".to_vec();
        with_eexec.extend_from_slice(&noise);
        let _ = scan(&with_eexec);
    }
}
