//! Font model of the text-editing spike: what a code of a font means (Unicode), how wide it is, and which characters the font can
//! still show (a character is available when some code of the font already maps to it and has a width).
//!
//! Simple fonts (Type1, TrueType) decode through lopdf's `/Encoding` + `/Differences` and an optional `/ToUnicode` overlay; composite
//! fonts (Type0 with `Identity-H`) need a `/ToUnicode`. Everything else carries a `problem` that makes an edit impossible.

use std::collections::HashMap;

use lopdf::{Dictionary, Document, Object};

/// Largest decoded `/ToUnicode` or other font stream that is read.
const MAX_FONT_STREAM: usize = 4 * 1024 * 1024;
/// Most entries of a code table (`/ToUnicode`, `/W`).
const MAX_ENTRIES: usize = 200_000;
/// Longest bfrange that is expanded.
const MAX_RANGE: u32 = 65_536;

#[derive(Debug)]
pub struct FontInfo {
    /// Bytes per code: 1 (simple) or 2 (Identity-H).
    pub code_len: usize,
    /// Code to text (usually one char, a ligature has more).
    pub decode: HashMap<u32, String>,
    /// Character to the lowest code that shows it.
    pub reverse: HashMap<char, u32>,
    widths: HashMap<u32, f64>,
    default_width: f64,
    pub embedded: bool,
    /// One of the standard 14 by name and not embedded: any viewer has the glyphs.
    pub std14: bool,
    /// Why no edit is possible in this font (Type3, vertical writing, no way to read the codes).
    pub problem: Option<&'static str>,
    pub bold: bool,
    pub italic: bool,
}

fn deref<'a>(doc: &'a Document, object: &'a Object) -> Option<&'a Object> {
    doc.dereference(object).ok().map(|(_, o)| o)
}

fn dict_of<'a>(doc: &'a Document, object: &'a Object) -> Option<&'a Dictionary> {
    match deref(doc, object)? {
        Object::Dictionary(d) => Some(d),
        Object::Stream(s) => Some(&s.dict),
        _ => None,
    }
}

fn number(doc: &Document, object: &Object) -> Option<f64> {
    match deref(doc, object)? {
        Object::Integer(i) => Some(*i as f64),
        Object::Real(r) => Some(f64::from(*r)),
        _ => None,
    }
}

fn name_of<'a>(doc: &'a Document, dict: &'a Dictionary, key: &[u8]) -> Option<&'a [u8]> {
    match deref(doc, dict.get(key).ok()?)? {
        Object::Name(n) => Some(n),
        _ => None,
    }
}

impl FontInfo {
    fn blank() -> Self {
        Self {
            code_len: 1,
            decode: HashMap::new(),
            reverse: HashMap::new(),
            widths: HashMap::new(),
            default_width: 500.0,
            embedded: false,
            std14: false,
            problem: None,
            bold: false,
            italic: false,
        }
    }

    fn broken(reason: &'static str) -> Self {
        Self {
            problem: Some(reason),
            ..Self::blank()
        }
    }

    /// Reads the font dictionary `font`.
    pub fn load(doc: &Document, font: &Dictionary) -> Self {
        let subtype = name_of(doc, font, b"Subtype").unwrap_or_default();
        match subtype {
            b"Type3" => Self::broken("Type3 font"),
            b"Type0" => Self::load_composite(doc, font),
            b"Type1" | b"MMType1" | b"TrueType" => Self::load_simple(doc, font),
            _ => Self::broken("unsupported font type"),
        }
    }

    fn load_simple(doc: &Document, font: &Dictionary) -> Self {
        let mut info = Self::blank();
        let descriptor = font
            .get(b"FontDescriptor")
            .ok()
            .and_then(|d| dict_of(doc, d));
        info.embedded = descriptor
            .is_some_and(|d| d.has(b"FontFile") || d.has(b"FontFile2") || d.has(b"FontFile3"));
        let base = name_of(doc, font, b"BaseFont").unwrap_or_default();
        info.std14 = !info.embedded && is_std14(base);
        (info.bold, info.italic) = style(doc, base, descriptor);
        // Encoding, Differences and a /Encoding-less default, as lopdf reads them.
        if let Ok(encoding) = font.get_font_encoding_with_limit(doc, MAX_FONT_STREAM) {
            for code in 0..=255u8 {
                if let Ok(text) = Document::decode_text(&encoding, &[code]) {
                    if !text.is_empty() && text != "\u{0}" {
                        info.decode.insert(u32::from(code), text);
                    }
                }
            }
        }
        // A /ToUnicode wins for decoding (it is what text extraction sees).
        if let Some(map) = to_unicode(doc, font) {
            for (code, text) in map {
                if code <= 255 {
                    info.decode.insert(code, text);
                }
            }
        }
        let first = font
            .get(b"FirstChar")
            .ok()
            .and_then(|o| number(doc, o))
            .unwrap_or(0.0)
            .clamp(-1.0, 65_535.0);
        if let Some(Object::Array(items)) = font.get(b"Widths").ok().and_then(|o| deref(doc, o)) {
            for (i, item) in items.iter().take(256).enumerate() {
                if let Some(w) = number(doc, item) {
                    let code = first as i64 + i as i64;
                    if (0..=255).contains(&code) {
                        info.widths.insert(code as u32, w);
                    }
                }
            }
        }
        if let Some(missing) = descriptor
            .and_then(|d| d.get(b"MissingWidth").ok())
            .and_then(|o| number(doc, o))
        {
            info.default_width = missing;
        }
        info.build_reverse(|code, widths, std14| {
            widths.contains_key(&code) && widths.get(&code).is_some_and(|w| *w > 0.0)
                || (std14 && (32..=255).contains(&code))
        });
        info
    }

    fn load_composite(doc: &Document, font: &Dictionary) -> Self {
        let mut info = Self::blank();
        info.code_len = 2;
        match font.get(b"Encoding").ok().and_then(|o| deref(doc, o)) {
            Some(Object::Name(n)) if n == b"Identity-H" => {}
            Some(Object::Name(n)) if n == b"Identity-V" => {
                return Self::broken("vertical writing");
            }
            _ => return Self::broken("unsupported CMap"),
        }
        let Some(descendant) = font
            .get(b"DescendantFonts")
            .ok()
            .and_then(|o| deref(doc, o))
            .and_then(|o| o.as_array().ok())
            .and_then(|a| a.first())
            .and_then(|o| dict_of(doc, o))
        else {
            return Self::broken("no descendant font");
        };
        let descriptor = descendant
            .get(b"FontDescriptor")
            .ok()
            .and_then(|d| dict_of(doc, d));
        info.embedded = descriptor
            .is_some_and(|d| d.has(b"FontFile") || d.has(b"FontFile2") || d.has(b"FontFile3"));
        (info.bold, info.italic) = style(
            doc,
            name_of(doc, font, b"BaseFont").unwrap_or_default(),
            descriptor,
        );
        let Some(map) = to_unicode(doc, font) else {
            return Self::broken("no ToUnicode map");
        };
        info.decode = map;
        info.default_width = descendant
            .get(b"DW")
            .ok()
            .and_then(|o| number(doc, o))
            .unwrap_or(1000.0);
        if let Some(Object::Array(items)) = descendant.get(b"W").ok().and_then(|o| deref(doc, o)) {
            read_w(doc, items, &mut info.widths);
        }
        info.build_reverse(|_, _, _| true);
        info
    }

    fn build_reverse(&mut self, available: impl Fn(u32, &HashMap<u32, f64>, bool) -> bool) {
        let mut codes: Vec<u32> = self.decode.keys().copied().collect();
        codes.sort_unstable();
        for code in codes {
            let Some(text) = self.decode.get(&code) else {
                continue;
            };
            let mut chars = text.chars();
            if let (Some(c), None) = (chars.next(), chars.next()) {
                if !c.is_control() && available(code, &self.widths, self.std14) {
                    self.reverse.entry(c).or_insert(code);
                }
            }
        }
    }

    /// Advance width of `code` in 1/1000 em.
    pub fn width(&self, code: u32) -> f64 {
        if let Some(w) = self.widths.get(&code) {
            return *w;
        }
        if self.std14 && code <= 255 {
            return f64::from(crate::content::std14::width(
                crate::model::annotation::StdFont::Sans,
                code as u8,
            ));
        }
        self.default_width
    }

    /// The codes that show `text`, or the first character the font cannot show.
    pub fn encode(&self, text: &str) -> Result<Vec<u32>, char> {
        text.chars()
            .map(|c| self.reverse.get(&c).copied().ok_or(c))
            .collect()
    }

    /// Bytes of `codes` as they are written into a string.
    pub fn code_bytes(&self, codes: &[u32]) -> Vec<u8> {
        let mut out = Vec::with_capacity(codes.len() * self.code_len);
        for code in codes {
            if self.code_len == 2 {
                out.push((code >> 8) as u8);
            }
            out.push(*code as u8);
        }
        out
    }
}

fn is_std14(base: &[u8]) -> bool {
    let name = String::from_utf8_lossy(base).to_ascii_lowercase();
    ["helvetica", "arial", "times", "courier"]
        .iter()
        .any(|p| name.starts_with(p))
}

/// The `/W` array of a CID font: `c [w1 w2 ...]` and `c1 c2 w`.
fn read_w(doc: &Document, items: &[Object], out: &mut HashMap<u32, f64>) {
    let mut i = 0;
    while i < items.len() && out.len() < MAX_ENTRIES {
        let Some(first) =
            number(doc, &items[i]).filter(|f| f.is_finite() && (0.0..=4_294_967_295.0).contains(f))
        else {
            return;
        };
        match items.get(i + 1).and_then(|o| deref(doc, o)) {
            Some(Object::Array(list)) => {
                for (k, w) in list.iter().enumerate().take(MAX_RANGE as usize) {
                    if let Some(w) = number(doc, w) {
                        if let Some(code) = (first as u32).checked_add(k as u32) {
                            out.insert(code, w);
                        }
                    }
                }
                i += 2;
            }
            Some(_) => {
                let (Some(last), Some(w)) = (
                    items.get(i + 1).and_then(|o| number(doc, o)),
                    items.get(i + 2).and_then(|o| number(doc, o)),
                ) else {
                    return;
                };
                let (a, b) = (first as u32, if last.is_finite() { last as u32 } else { 0 });
                if b >= a && b - a < MAX_RANGE {
                    for code in a..=b {
                        out.insert(code, w);
                    }
                }
                i += 3;
            }
            None => return,
        }
    }
}

#[derive(Debug, PartialEq)]
enum Tok {
    Hex(Vec<u8>),
    Open,
    Close,
    Word(Vec<u8>),
}

fn tokens(data: &[u8]) -> Vec<Tok> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < data.len() && out.len() < 4 * MAX_ENTRIES {
        match data[i] {
            b'<' if data.get(i + 1) != Some(&b'<') => {
                let mut j = i + 1;
                let mut digits = Vec::new();
                while j < data.len() && data[j] != b'>' {
                    if let Some(d) = (data[j] as char).to_digit(16) {
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
    out
}

fn code_of(bytes: &[u8]) -> Option<u32> {
    (bytes.len() <= 4).then(|| bytes.iter().fold(0u32, |a, b| (a << 8) | u32::from(*b)))
}

fn utf16(bytes: &[u8]) -> String {
    let units: Vec<u16> = bytes
        .chunks(2)
        .map(|p| (u16::from(p[0]) << 8) | u16::from(*p.get(1).unwrap_or(&0)))
        .collect();
    char::decode_utf16(units)
        .map(|r| r.unwrap_or('\u{FFFD}'))
        .collect()
}

/// `dst` with its last UTF-16 unit raised by `by`.
fn bumped(dst: &[u8], by: u32) -> String {
    let mut bytes = dst.to_vec();
    if bytes.len() >= 2 {
        let n = bytes.len();
        let unit = ((u32::from(bytes[n - 2]) << 8) | u32::from(bytes[n - 1])).wrapping_add(by);
        bytes[n - 2] = (unit >> 8) as u8;
        bytes[n - 1] = unit as u8;
    }
    utf16(&bytes)
}

/// Parses the bfchar and bfrange sections of a ToUnicode CMap.
pub fn parse_cmap(data: &[u8]) -> HashMap<u32, String> {
    let toks = tokens(data);
    let mut map = HashMap::new();
    let mut i = 0;
    while i < toks.len() && map.len() < MAX_ENTRIES {
        match &toks[i] {
            Tok::Word(w) if w == b"beginbfchar" => {
                i += 1;
                while let (Some(Tok::Hex(src)), Some(Tok::Hex(dst))) =
                    (toks.get(i), toks.get(i + 1))
                {
                    if map.len() >= MAX_ENTRIES {
                        break;
                    }
                    if let Some(code) = code_of(src) {
                        map.insert(code, utf16(dst));
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
                    if map.len() >= MAX_ENTRIES {
                        break;
                    }
                    i += 2;
                    let ok = hi >= lo && hi - lo < MAX_RANGE;
                    match toks.get(i) {
                        Some(Tok::Hex(dst)) => {
                            if ok {
                                for code in lo..=hi {
                                    if map.len() >= MAX_ENTRIES {
                                        break;
                                    }
                                    map.insert(code, bumped(dst, code - lo));
                                }
                            }
                            i += 1;
                        }
                        Some(Tok::Open) => {
                            i += 1;
                            let mut k = 0;
                            while let Some(Tok::Hex(dst)) = toks.get(i) {
                                if map.len() >= MAX_ENTRIES {
                                    break;
                                }
                                if let (true, Some(code)) = (ok, lo.checked_add(k)) {
                                    if code <= hi {
                                        map.insert(code, utf16(dst));
                                    }
                                }
                                k += 1;
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
        if i < toks.len() && !matches!(&toks[i], Tok::Word(_)) {
            i += 1;
        }
    }
    map
}

fn to_unicode(doc: &Document, font: &Dictionary) -> Option<HashMap<u32, String>> {
    let stream = deref(doc, font.get(b"ToUnicode").ok()?)?.as_stream().ok()?;
    let data = stream
        .decompressed_content_with_limit(MAX_FONT_STREAM)
        .ok()?;
    Some(parse_cmap(&data))
}

/// Bold and italic from the base font name and the descriptor (`/Flags` italic and force-bold bits, `/FontWeight`).
fn style(doc: &Document, base: &[u8], descriptor: Option<&Dictionary>) -> (bool, bool) {
    let name = String::from_utf8_lossy(base).to_ascii_lowercase();
    let flags = descriptor
        .and_then(|d| d.get(b"Flags").ok())
        .and_then(|o| number(doc, o))
        .map_or(0, |f| f as i64);
    let weight = descriptor
        .and_then(|d| d.get(b"FontWeight").ok())
        .and_then(|o| number(doc, o))
        .unwrap_or(400.0);
    let bold = ["bold", "black", "heavy", "semibold", "demi"]
        .iter()
        .any(|k| name.contains(k))
        || flags & 0x4_0000 != 0
        || weight >= 700.0;
    let italic = name.contains("italic") || name.contains("oblique") || flags & 0x40 != 0;
    (bold, italic)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cmap_chars_and_ranges() {
        let cmap = b"/CIDInit begincmap 2 beginbfchar <0003> <0020> <0004> <00660069> endbfchar \
            2 beginbfrange <0010> <0012> <0041> <0020> <0021> [<0061> <0062>] endbfrange endcmap";
        let map = parse_cmap(cmap);
        assert_eq!(map[&3], " ");
        assert_eq!(map[&4], "fi");
        assert_eq!(map[&0x11], "B");
        assert_eq!(map[&0x12], "C");
        assert_eq!(map[&0x21], "b");
    }

    #[test]
    fn hostile_range_is_ignored() {
        let map = parse_cmap(b"1 beginbfrange <0000> <FFFFFFFF> <0041> endbfrange");
        assert!(map.is_empty());
    }
}

#[cfg(test)]
mod limit_tests {
    use super::*;

    #[test]
    fn huge_bfrange_stays_within_the_entry_cap() {
        let mut data = String::from("1 beginbfrange\n");
        for n in 0..10u32 {
            data.push_str(&format!(
                "<{:08X}> <{:08X}> <0041>\n",
                n * 70_000,
                n * 70_000 + 65_000
            ));
        }
        data.push_str("endbfrange");
        assert!(parse_cmap(data.as_bytes()).len() <= MAX_ENTRIES);
    }

    #[test]
    fn hostile_w_array_does_not_overflow() {
        let doc = Document::new();
        let items = vec![
            Object::Real(f32::NAN),
            Object::Integer(-5),
            Object::Integer(1),
        ];
        let mut out = HashMap::new();
        read_w(&doc, &items, &mut out);
        let items = vec![
            Object::Real(4_294_967_295.0),
            Object::Array(vec![Object::Integer(1), Object::Integer(2)]),
        ];
        read_w(&doc, &items, &mut out);
    }
}
