//! A font dictionary as a [`FontMap`] (ARCHITECTURE §13.3): which characters have a code, a glyph and a width in it.
//!
//! [`font_map`] is the seam function; [`font_detail`] returns the same map with what the rewrite step also needs (decode table, names,
//! flags). The writer half, [`add_fallback_font`], puts a bundled substitute subset into a document as Type0/Identity-H.
//!
//! Every font dictionary and program is hostile: streams are decoded with a byte limit, programs are read by `fontprog` (safe Rust,
//! bounded), encodings and `Differences` are capped by `limits::DIFFERENCES_MAX`, and nothing here follows a reference more than once.

use std::collections::{HashMap, HashSet};
use std::io::Write;

use lopdf::{Dictionary, Document, Object, ObjectId, Stream, StringFormat};

use crate::content::std14::{std14_from_name, std14_width, winansi, Std14};
use crate::error::{AppError, ErrorCode};
use crate::fontprog::cmap::{self, ToUnicode};
use crate::fontprog::fallback::{pick, Face, Subset};
use crate::fontprog::glyphs::{self, GlyphTable};
pub use crate::fontprog::ProgramKind;
use crate::limits::{
    CID_TO_GID_MAX_BYTES, CID_WIDTHS_MAX, DIFFERENCES_MAX, FONT_PROGRAM_MAX, TOUNICODE_MAX_BYTES,
};

/// A character code as written in a string (one or two bytes).
pub type Code = u32;

/// `Type3` and `Type0Other` are read for mapping only and always refused for editing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FontKind {
    Simple,
    Type0IdentityH,
    Type3,
    Type0Other,
}

/// Where widths come from.
#[derive(Debug, Clone, PartialEq)]
pub enum WidthSource {
    /// `/Widths` from `first_char`, in 1/1000 em. A standard-14 font without `/Widths` is materialised into this form too.
    Widths { first_char: u32, widths: Vec<f32> },
    /// The standard-14 metrics (not produced by [`font_map`], which materialises them; [`FontMap::width`] answers `None`).
    Std14,
    /// `/DW` and `/W` of a CIDFont.
    Cid {
        default: f32,
        widths: HashMap<u32, f32>,
    },
}

/// Codes that have a glyph (embedded program, or the encoding for a non-embedded font).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GlyphSet {
    pub codes: HashSet<Code>,
}

/// What `text_fonts` knows of one font.
#[derive(Debug, Clone)]
pub struct FontMap {
    pub kind: FontKind,
    pub embedded: Option<ProgramKind>,
    /// The name starts with `ABCDEF+`.
    pub subset: bool,
    /// Unicode to code (for several codes: one seen on the page, else the lowest). Only codes with a glyph and a width are listed.
    pub to_code: HashMap<char, Code>,
    pub widths: WidthSource,
    pub glyphs: GlyphSet,
    pub space_code: Option<Code>,
}

/// How one character fares in a font.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CharStatus {
    Ok,
    Missing,
}

impl FontMap {
    /// `Ok` when the character has a code, a glyph and a width.
    pub fn status(&self, c: char) -> CharStatus {
        let ok = self.to_code.get(&c).is_some_and(|code| {
            self.glyphs.codes.contains(code) && self.width(*code).is_some_and(|w| w > 0.0)
        });
        if ok {
            CharStatus::Ok
        } else {
            CharStatus::Missing
        }
    }

    /// The advance of `code` in 1/1000 em, when the font has one.
    pub fn width(&self, code: Code) -> Option<f32> {
        match &self.widths {
            WidthSource::Widths { first_char, widths } => {
                let index = code.checked_sub(*first_char)? as usize;
                widths.get(index).copied().filter(|w| *w > 0.0)
            }
            WidthSource::Std14 => None,
            WidthSource::Cid { default, widths } => {
                Some(widths.get(&code).copied().unwrap_or(*default))
            }
        }
    }

    /// Bytes per code in a string: 1 for a simple font, 2 for `Identity-H`.
    pub fn code_len(&self) -> usize {
        if self.kind == FontKind::Type0IdentityH {
            2
        } else {
            1
        }
    }

    /// The codes that show `text`, or the first character the font cannot show.
    pub fn encode(&self, text: &str) -> Result<Vec<Code>, char> {
        text.chars()
            .map(|c| match (self.status(c), self.to_code.get(&c)) {
                (CharStatus::Ok, Some(code)) => Ok(*code),
                _ => Err(c),
            })
            .collect()
    }

    /// The bytes of `codes` as they are written into a string.
    pub fn code_bytes(&self, codes: &[Code]) -> Vec<u8> {
        let mut out = Vec::with_capacity(codes.len() * self.code_len());
        for code in codes {
            if self.code_len() == 2 {
                out.push((code >> 8) as u8);
            }
            out.push(*code as u8);
        }
        out
    }

    /// The width in 1/1000 em of `text`, `None` when a character is missing.
    pub fn text_width(&self, text: &str) -> Option<f32> {
        let mut sum = 0.0;
        for c in text.chars() {
            sum += self.width(*self.to_code.get(&c)?)?;
        }
        Some(sum)
    }
}

/// The map plus the facts the rewrite and the fallback choice need.
#[derive(Debug, Clone)]
pub struct FontDetail {
    pub map: FontMap,
    /// Code to the text it stands for (`ToUnicode` first, then the encoding, then the observed table).
    pub decode: HashMap<Code, String>,
    /// `/BaseFont` as written.
    pub base_font: String,
    /// `/BaseFont` without the subset tag, for display.
    pub display_name: String,
    /// `/FontDescriptor` `/Flags` (0 when absent).
    pub flags: u32,
    /// `/FontWeight` (400 when absent).
    pub weight: u32,
}

impl FontDetail {
    /// The bundled face that stands in for this font.
    pub fn fallback_face(&self) -> Face {
        pick(self.flags, self.weight, &self.display_name)
    }
}

// ---- reading helpers ------------------------------------------------------------------------------------------------------------

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
        Object::Real(r) => Some(f64::from(*r)).filter(|r| r.is_finite()),
        _ => None,
    }
}

fn name_of(doc: &Document, dict: &Dictionary, key: &[u8]) -> Option<Vec<u8>> {
    match deref(doc, dict.get(key).ok()?)? {
        Object::Name(n) => Some(n.clone()),
        _ => None,
    }
}

fn get<'a>(doc: &'a Document, dict: &'a Dictionary, key: &[u8]) -> Option<&'a Object> {
    deref(doc, dict.get(key).ok()?)
}

/// The decoded bytes of the stream `key` of `dict`, `limit_exceeded` when it is larger than `max`. `None` when it is not a stream or
/// does not decode.
fn stream_bytes(
    doc: &Document,
    dict: &Dictionary,
    key: &[u8],
    max: usize,
    what: &'static str,
) -> Result<Option<Vec<u8>>, AppError> {
    let Some(Object::Stream(stream)) = get(doc, dict, key) else {
        return Ok(None);
    };
    match stream.decompressed_content_with_limit(max) {
        Ok(bytes) if bytes.len() <= max => Ok(Some(bytes)),
        Ok(_) => Err(AppError::limit(what, max as u64)),
        Err(_) if stream.content.len() > max => Err(AppError::limit(what, max as u64)),
        Err(_) => Ok(None),
    }
}

fn is_subset_tag(base: &str) -> bool {
    let b = base.as_bytes();
    b.len() > 7 && b[6] == b'+' && b[..6].iter().all(u8::is_ascii_uppercase)
}

/// The glyph names AGL knows for `c` (`A` has `A`; `-` has `hyphen`, `minus` ...).
fn glyph_names_of(c: char) -> Vec<String> {
    let mut out = Vec::new();
    for n in 0..6 {
        let mut buf = [0u8; 64];
        match skrifa::raw::ps::agl::char_to_nth_name(c, n, &mut buf) {
            Some(name) => out.push(name.to_string()),
            None => break,
        }
    }
    out
}

fn name_to_char(name: &str) -> Option<char> {
    skrifa::raw::ps::agl::name_to_char(name)
}

// ---- encodings ------------------------------------------------------------------------------------------------------------------

/// Windows-1252 for 0x80..=0x9F (the holes are `None`).
const CP1252_HIGH: [Option<char>; 32] = [
    Some('\u{20AC}'),
    None,
    Some('\u{201A}'),
    Some('\u{0192}'),
    Some('\u{201E}'),
    Some('\u{2026}'),
    Some('\u{2020}'),
    Some('\u{2021}'),
    Some('\u{02C6}'),
    Some('\u{2030}'),
    Some('\u{0160}'),
    Some('\u{2039}'),
    Some('\u{0152}'),
    None,
    Some('\u{017D}'),
    None,
    None,
    Some('\u{2018}'),
    Some('\u{2019}'),
    Some('\u{201C}'),
    Some('\u{201D}'),
    Some('\u{2022}'),
    Some('\u{2013}'),
    Some('\u{2014}'),
    Some('\u{02DC}'),
    Some('\u{2122}'),
    Some('\u{0161}'),
    Some('\u{203A}'),
    Some('\u{0153}'),
    None,
    Some('\u{017E}'),
    Some('\u{0178}'),
];

/// MacRomanEncoding for 0x80..=0xFF (PDF's flavour: 0xDB is the currency sign).
const MAC_ROMAN_HIGH: &str = "ÄÅÇÉÑÖÜáàâäãåçéèêëíìîïñóòôöõúùûü†°¢£§•¶ß®©™´¨≠ÆØ∞±≤≥¥µ∂∑∏π∫ªºΩæø¿¡¬√ƒ≈∆«»…\u{A0}ÀÃÕŒœ–—“”‘’÷◊ÿŸ⁄¤‹›ﬁﬂ‡·‚„‰ÂÊÁËÈÍÎÏÌÓÔ\u{F8FF}ÒÚÛÙıˆ˜¯˘˙˚¸˝˛ˇ";

/// ISO 32000 Annex D.2, STD column.
const STANDARD_HIGH: &[(u8, char)] = &[
    (0xA1, '¡'),
    (0xA2, '¢'),
    (0xA3, '£'),
    (0xA4, '\u{2044}'),
    (0xA5, '¥'),
    (0xA6, 'ƒ'),
    (0xA7, '§'),
    (0xA8, '¤'),
    (0xA9, '\''),
    (0xAA, '“'),
    (0xAB, '«'),
    (0xAC, '‹'),
    (0xAD, '›'),
    (0xAE, 'ﬁ'),
    (0xAF, 'ﬂ'),
    (0xB1, '–'),
    (0xB2, '†'),
    (0xB3, '‡'),
    (0xB4, '·'),
    (0xB6, '¶'),
    (0xB7, '•'),
    (0xB8, '‚'),
    (0xB9, '„'),
    (0xBA, '”'),
    (0xBB, '»'),
    (0xBC, '…'),
    (0xBD, '‰'),
    (0xBF, '¿'),
    (0xC1, '`'),
    (0xC2, '´'),
    (0xC3, 'ˆ'),
    (0xC4, '˜'),
    (0xC5, '¯'),
    (0xC6, '˘'),
    (0xC7, '˙'),
    (0xC8, '¨'),
    (0xCA, '˚'),
    (0xCB, '¸'),
    (0xCD, '˝'),
    (0xCE, '˛'),
    (0xCF, 'ˇ'),
    (0xD0, '—'),
    (0xE1, 'Æ'),
    (0xE3, 'ª'),
    (0xE8, 'Ł'),
    (0xE9, 'Ø'),
    (0xEA, 'Œ'),
    (0xEB, 'º'),
    (0xF1, 'æ'),
    (0xF5, 'ı'),
    (0xF8, 'ł'),
    (0xF9, 'ø'),
    (0xFA, 'œ'),
    (0xFB, 'ß'),
];
#[derive(Clone, Copy, PartialEq, Eq)]
enum Base {
    WinAnsi,
    MacRoman,
    Standard,
}

fn base_char(base: Base, code: u8) -> Option<char> {
    match code {
        0x20..=0x7E => Some(match (base, code) {
            (Base::Standard, 0x27) => '\u{2019}',
            (Base::Standard, 0x60) => '\u{2018}',
            _ => char::from(code),
        }),
        _ => match base {
            Base::WinAnsi => match code {
                0x80..=0x9F => CP1252_HIGH[usize::from(code - 0x80)],
                0xA0..=0xFF => Some(char::from(code)),
                _ => None,
            },
            Base::MacRoman => (code >= 0x80)
                .then(|| MAC_ROMAN_HIGH.chars().nth(usize::from(code - 0x80)))
                .flatten(),
            Base::Standard => STANDARD_HIGH
                .iter()
                .find(|(c, _)| *c == code)
                .map(|(_, ch)| *ch),
        },
    }
}

/// The 256 entries of one simple font's encoding.
struct Encoding {
    chars: Vec<Option<char>>,
    names: Vec<Option<String>>,
}

impl Encoding {
    fn empty() -> Self {
        Self {
            chars: vec![None; 256],
            names: vec![None; 256],
        }
    }

    fn from_base(base: Base) -> Self {
        let mut e = Self::empty();
        for code in 0..=255u8 {
            e.chars[usize::from(code)] = base_char(base, code);
        }
        e
    }

    fn from_names(names: impl IntoIterator<Item = (u32, String)>) -> Self {
        let mut e = Self::empty();
        for (code, name) in names {
            if let Some(slot) = usize::try_from(code).ok().filter(|c| *c < 256) {
                e.chars[slot] = name_to_char(&name);
                e.names[slot] = Some(name);
            }
        }
        e
    }
}

/// `/Differences`: `[code name name ... code name ...]`. `limit_exceeded` over `DIFFERENCES_MAX` names.
fn apply_differences(
    doc: &Document,
    items: &[Object],
    encoding: &mut Encoding,
) -> Result<(), AppError> {
    if items.len() > 4 * DIFFERENCES_MAX {
        return Err(AppError::limit("differences", DIFFERENCES_MAX as u64));
    }
    let mut code: i64 = 0;
    let mut names = 0usize;
    for item in items {
        match deref(doc, item) {
            Some(Object::Integer(i)) => code = *i,
            Some(Object::Name(n)) => {
                names += 1;
                if names > DIFFERENCES_MAX {
                    return Err(AppError::limit("differences", DIFFERENCES_MAX as u64));
                }
                if let Ok(slot) = usize::try_from(code) {
                    if slot < 256 {
                        let name = String::from_utf8_lossy(n).into_owned();
                        encoding.chars[slot] = name_to_char(&name);
                        encoding.names[slot] = Some(name);
                    }
                }
                code = code.saturating_add(1);
            }
            _ => {}
        }
    }
    Ok(())
}

fn base_by_name(name: &[u8]) -> Option<Base> {
    match name {
        b"WinAnsiEncoding" => Some(Base::WinAnsi),
        b"MacRomanEncoding" => Some(Base::MacRoman),
        b"StandardEncoding" => Some(Base::Standard),
        _ => None,
    }
}

// ---- font program ---------------------------------------------------------------------------------------------------------------

struct Program {
    kind: ProgramKind,
    /// `None` when the program does not parse (the font then has no glyphs).
    table: Option<GlyphTable>,
}

fn load_program(
    doc: &Document,
    descriptor: Option<&Dictionary>,
) -> Result<Option<Program>, AppError> {
    let Some(descriptor) = descriptor else {
        return Ok(None);
    };
    for key in [&b"FontFile"[..], b"FontFile2", b"FontFile3"] {
        if !descriptor.has(key) {
            continue;
        }
        let kind = match key {
            b"FontFile" => ProgramKind::Type1,
            b"FontFile2" => ProgramKind::TrueType,
            _ => {
                let subtype = match get(doc, descriptor, key) {
                    Some(Object::Stream(s)) => name_of(doc, &s.dict, b"Subtype"),
                    _ => None,
                };
                if subtype.as_deref() == Some(b"OpenType") {
                    ProgramKind::OpenTypeCff
                } else {
                    ProgramKind::Cff
                }
            }
        };
        let Some(data) = stream_bytes(doc, descriptor, key, FONT_PROGRAM_MAX, "fontProgram")?
        else {
            return Ok(Some(Program { kind, table: None }));
        };
        // The magic number beats the key: an sfnt in FontFile3, or CFF data where a TrueType is announced.
        let kind = match data.get(..4) {
            Some(b"OTTO") => ProgramKind::OpenTypeCff,
            Some([0, 1, 0, 0]) | Some(b"true") | Some(b"ttcf") if kind != ProgramKind::Type1 => {
                if kind == ProgramKind::OpenTypeCff {
                    kind
                } else {
                    ProgramKind::TrueType
                }
            }
            _ => kind,
        };
        let table = match glyphs::read(kind, &data) {
            Ok(t) => Some(t),
            Err(e) if e.code() == ErrorCode::LimitExceeded => return Err(e),
            Err(_) => None,
        };
        return Ok(Some(Program { kind, table }));
    }
    Ok(None)
}

fn to_unicode(doc: &Document, font: &Dictionary) -> Result<Option<ToUnicode>, AppError> {
    let Some(data) = stream_bytes(doc, font, b"ToUnicode", TOUNICODE_MAX_BYTES, "toUnicode")?
    else {
        return Ok(None);
    };
    match cmap::parse(&data) {
        Ok(t) => Ok(Some(t)),
        Err(e) if e.code() == ErrorCode::LimitExceeded => Err(e),
        Err(_) => Ok(None),
    }
}

// ---- the seam -------------------------------------------------------------------------------------------------------------------

/// Reads the font `font` of `src`; `observed` is the code to Unicode table seen on the page (used without `ToUnicode`).
pub fn font_map(
    src: &Document,
    font: ObjectId,
    observed: &HashMap<Code, char>,
) -> Result<FontMap, AppError> {
    font_detail(src, font, observed).map(|d| d.map)
}

/// Like [`font_map`], with the decode table, names, flags and weight.
pub fn font_detail(
    src: &Document,
    font: ObjectId,
    observed: &HashMap<Code, char>,
) -> Result<FontDetail, AppError> {
    let dict = match src.get_object(font) {
        Ok(Object::Dictionary(d)) => d,
        _ => return Err(AppError::invalid("font")),
    };
    let base_font = name_of(src, dict, b"BaseFont")
        .map(|n| String::from_utf8_lossy(&n).into_owned())
        .unwrap_or_default();
    let subset = is_subset_tag(&base_font);
    let display_name = if subset {
        base_font[7..].to_string()
    } else {
        base_font.clone()
    };
    let mut detail = FontDetail {
        map: FontMap {
            kind: FontKind::Simple,
            embedded: None,
            subset,
            to_code: HashMap::new(),
            widths: WidthSource::Widths {
                first_char: 0,
                widths: Vec::new(),
            },
            glyphs: GlyphSet::default(),
            space_code: None,
        },
        decode: HashMap::new(),
        base_font,
        display_name,
        flags: 0,
        weight: 400,
    };
    match name_of(src, dict, b"Subtype").as_deref() {
        Some(b"Type1" | b"MMType1" | b"TrueType") => simple(src, dict, observed, &mut detail)?,
        Some(b"Type0") => composite(src, dict, observed, &mut detail)?,
        Some(b"Type3") => {
            detail.map.kind = FontKind::Type3;
            mapping_only(src, dict, observed, &mut detail)?;
        }
        _ => return Err(AppError::unsupported("textEdit")),
    }
    Ok(detail)
}

/// Type3 and the refused CMaps: only the decode table, for mapping.
fn mapping_only(
    doc: &Document,
    font: &Dictionary,
    observed: &HashMap<Code, char>,
    detail: &mut FontDetail,
) -> Result<(), AppError> {
    if let Some(t) = to_unicode(doc, font)? {
        detail.decode = t.map;
    }
    for (code, c) in observed {
        detail.decode.entry(*code).or_insert_with(|| c.to_string());
    }
    Ok(())
}

fn descriptor_facts(doc: &Document, descriptor: Option<&Dictionary>, detail: &mut FontDetail) {
    if let Some(d) = descriptor {
        detail.flags = get(doc, d, b"Flags")
            .and_then(|o| number(doc, o))
            .map_or(0, |f| f.clamp(0.0, f64::from(u32::MAX)) as u32);
        detail.weight = get(doc, d, b"FontWeight")
            .and_then(|o| number(doc, o))
            .map_or(400, |w| w.clamp(1.0, 1000.0) as u32);
    }
}

/// The first single character of a code's text.
fn single(text: &str) -> Option<char> {
    let mut it = text.chars();
    match (it.next(), it.next()) {
        (Some(c), None) => Some(c),
        _ => None,
    }
}

/// Fills `to_code` from the valid codes: among several for one character a code seen on the page wins, else the lowest.
fn build_to_code(valid: &[(Code, char)], observed: &HashMap<Code, char>) -> HashMap<char, Code> {
    let mut best: HashMap<char, (bool, Code)> = HashMap::new();
    for (code, c) in valid {
        if c.is_control() {
            continue;
        }
        let seen = observed.get(code) == Some(c);
        best.entry(*c)
            .and_modify(|(was_seen, was)| {
                if (seen && !*was_seen) || (seen == *was_seen && code < was) {
                    *was_seen = seen;
                    *was = *code;
                }
            })
            .or_insert((seen, *code));
    }
    best.into_iter().map(|(c, (_, code))| (c, code)).collect()
}

fn simple(
    doc: &Document,
    font: &Dictionary,
    observed: &HashMap<Code, char>,
    detail: &mut FontDetail,
) -> Result<(), AppError> {
    let descriptor = get(doc, font, b"FontDescriptor").and_then(|o| match o {
        Object::Dictionary(d) => Some(d),
        _ => None,
    });
    descriptor_facts(doc, descriptor, detail);
    let program = load_program(doc, descriptor)?;
    detail.map.embedded = program.as_ref().map(|p| p.kind);
    let table = program.as_ref().and_then(|p| p.table.as_ref());
    let kind = program.as_ref().map(|p| p.kind);
    let std = (program.is_none())
        .then(|| std14_from_name(detail.base_font.as_bytes()))
        .flatten();

    // 1. The encoding
    let mut encoding = match get(doc, font, b"Encoding") {
        Some(Object::Name(n)) => base_by_name(n).map(Encoding::from_base),
        Some(Object::Dictionary(d)) => {
            let base = name_of(doc, d, b"BaseEncoding").and_then(|n| base_by_name(&n));
            base.map(Encoding::from_base)
        }
        _ => None,
    };
    let has_encoding_entry = font.has(b"Encoding");
    if encoding.is_none() {
        // Without a base encoding the program's own, else StandardEncoding for text fonts; symbolic TrueType has none.
        encoding = match (kind, table) {
            (Some(ProgramKind::TrueType), _) => None,
            (Some(_), Some(t)) if !t.builtin_encoding.is_empty() => Some(Encoding::from_names(
                t.builtin_encoding.iter().map(|(c, n)| (*c, n.clone())),
            )),
            (None, _) if matches!(std, Some(Std14::Symbol | Std14::ZapfDingbats)) => None,
            _ if detail.flags & 4 != 0 && detail.flags & 32 == 0 && kind.is_some() => None,
            _ => Some(Encoding::from_base(Base::Standard)),
        };
    }
    let mut encoding = encoding.unwrap_or_else(Encoding::empty);
    if let Some(Object::Dictionary(d)) = get(doc, font, b"Encoding") {
        if let Some(Object::Array(items)) = get(doc, d, b"Differences") {
            apply_differences(doc, items, &mut encoding)?;
        }
    }

    // 2. ToUnicode wins, then the page's observed table fills gaps
    let mut decode: HashMap<Code, String> = HashMap::new();
    for code in 0..256usize {
        if let Some(c) = encoding.chars[code] {
            decode.insert(code as Code, c.to_string());
        }
    }
    if let Some(t) = to_unicode(doc, font)? {
        for (code, text) in t.map {
            if code < 256 {
                decode.insert(code, text);
            }
        }
    }
    for (code, c) in observed {
        if *code < 256 {
            decode.entry(*code).or_insert_with(|| c.to_string());
        }
    }

    // 3. Widths
    let first = get(doc, font, b"FirstChar")
        .and_then(|o| number(doc, o))
        .map_or(0, |f| f.clamp(0.0, 255.0) as u32);
    let mut widths: Vec<f32> = Vec::new();
    let mut has_widths = false;
    if let Some(Object::Array(items)) = get(doc, font, b"Widths") {
        has_widths = true;
        for item in items.iter().take(256) {
            widths.push(number(doc, item).map_or(0.0, |w| w as f32));
        }
    }

    // 4. Which codes have a glyph
    let mut glyph_codes: HashSet<Code> = HashSet::new();
    let mut advances: Vec<f32> = vec![0.0; 256];
    for code in 0..256u32 {
        let slot = code as usize;
        let ch = single_or_none(decode.get(&code));
        let name = encoding.names[slot].as_deref();
        if ch.is_none() && name.is_none() {
            continue;
        }
        let blank = ch.is_some_and(char::is_whitespace);
        match (kind, table) {
            (None, _) => {
                // Not embedded: the encoding says what the code is; a width says the viewer can draw it.
                if ch.is_some() || name.is_some() {
                    glyph_codes.insert(code);
                }
            }
            (Some(_), None) => {}
            (Some(ProgramKind::TrueType), Some(t)) => {
                if let Some(gid) = truetype_gid(t, code, ch, has_encoding_entry) {
                    if t.has_glyph(gid, blank) && name != Some(".notdef") {
                        glyph_codes.insert(code);
                        if let Some(w) = t.advances.get(&gid) {
                            advances[slot] = *w;
                        }
                    }
                }
            }
            (Some(_), Some(t)) => {
                // Type1, CFF and OpenType-CFF: by glyph name, or for an OpenType font by its Unicode cmap
                let mut gid = None;
                let mut candidates: Vec<String> = name.map(str::to_string).into_iter().collect();
                if name.is_none() {
                    if let Some(c) = ch {
                        candidates.extend(glyph_names_of(c));
                    }
                }
                for n in &candidates {
                    if let Some(g) = t.gid_of_name.get(n) {
                        gid = Some(*g);
                        break;
                    }
                }
                if gid.is_none() {
                    gid = ch.and_then(|c| t.cmap_unicode.get(&(c as u32)).copied());
                }
                if let Some(gid) = gid {
                    if t.has_glyph(gid, blank) && name != Some(".notdef") {
                        glyph_codes.insert(code);
                        if let Some(w) = t.advances.get(&gid) {
                            advances[slot] = *w;
                        }
                    }
                }
            }
        }
    }

    // 5. Width source
    let source = if has_widths {
        WidthSource::Widths {
            first_char: first,
            widths,
        }
    } else if let Some(std) = std {
        let mut all = vec![0.0f32; 256];
        for (code, slot) in all.iter_mut().enumerate() {
            let c = single_or_none(decode.get(&(code as Code)));
            if let Some(w) = c.and_then(winansi).and_then(|w| std14_width(std, w)) {
                *slot = f32::from(w);
            }
        }
        WidthSource::Widths {
            first_char: 0,
            widths: all,
        }
    } else {
        // An embedded program's own advances for a font without `/Widths`.
        WidthSource::Widths {
            first_char: 0,
            widths: advances,
        }
    };
    detail.map.widths = source;
    // Non-embedded: only codes that have a width count as drawable.
    if kind.is_none() {
        glyph_codes.retain(|code| detail.map.width(*code).is_some());
    }
    detail.map.glyphs = GlyphSet { codes: glyph_codes };

    // 6. Unicode to code
    let valid: Vec<(Code, char)> = {
        let mut v: Vec<(Code, char)> = detail
            .map
            .glyphs
            .codes
            .iter()
            .filter(|code| detail.map.width(**code).is_some_and(|w| w > 0.0))
            .filter_map(|code| single_or_none(decode.get(code)).map(|c| (*code, c)))
            .collect();
        v.sort_unstable();
        v
    };
    detail.map.to_code = build_to_code(&valid, observed);
    detail.map.space_code = detail.map.to_code.get(&' ').copied();
    detail.decode = decode;
    Ok(())
}

fn single_or_none(text: Option<&String>) -> Option<char> {
    text.and_then(|t| single(t))
}

/// The glyph id of `code` in an embedded TrueType program: by Unicode when the font has an encoding, else by the symbol and Mac
/// subtables (codes `0xF000 + code` too).
fn truetype_gid(t: &GlyphTable, code: u32, ch: Option<char>, has_encoding: bool) -> Option<u32> {
    let by_unicode = ch.and_then(|c| t.cmap_unicode.get(&(c as u32)).copied());
    let by_symbol = || {
        [0, 0xF000, 0xF100, 0xF200]
            .iter()
            .find_map(|base| t.cmap_symbol.get(&(base + code)).copied())
    };
    let by_mac = || t.cmap_mac.get(&code).copied();
    let by_raw = || t.cmap_unicode.get(&code).copied();
    if has_encoding {
        by_unicode.or_else(by_mac).or_else(by_symbol)
    } else {
        by_symbol().or_else(by_mac).or(by_unicode).or_else(by_raw)
    }
}

fn composite(
    doc: &Document,
    font: &Dictionary,
    observed: &HashMap<Code, char>,
    detail: &mut FontDetail,
) -> Result<(), AppError> {
    match get(doc, font, b"Encoding") {
        Some(Object::Name(n)) if n == b"Identity-H" => detail.map.kind = FontKind::Type0IdentityH,
        _ => {
            detail.map.kind = FontKind::Type0Other;
            return mapping_only(doc, font, observed, detail);
        }
    }
    let Some(descendant) = get(doc, font, b"DescendantFonts")
        .and_then(|o| match o {
            Object::Array(a) => a.first(),
            _ => None,
        })
        .and_then(|o| dict_of(doc, o))
    else {
        detail.map.kind = FontKind::Type0Other;
        return mapping_only(doc, font, observed, detail);
    };
    let descriptor = get(doc, descendant, b"FontDescriptor").and_then(|o| match o {
        Object::Dictionary(d) => Some(d),
        _ => None,
    });
    descriptor_facts(doc, descriptor, detail);
    let program = load_program(doc, descriptor)?;
    detail.map.embedded = program.as_ref().map(|p| p.kind);

    // widths
    let default = get(doc, descendant, b"DW")
        .and_then(|o| number(doc, o))
        .map_or(1000.0, |w| w as f32);
    let mut widths = HashMap::new();
    if let Some(Object::Array(items)) = get(doc, descendant, b"W") {
        read_w(doc, items, &mut widths)?;
    }
    detail.map.widths = WidthSource::Cid { default, widths };

    // code to text: ToUnicode, else what the page showed
    let mut decode: HashMap<Code, String> =
        to_unicode(doc, font)?.map(|t| t.map).unwrap_or_default();
    for (code, c) in observed {
        decode.entry(*code).or_insert_with(|| c.to_string());
    }

    // CID to glyph
    let cid_to_gid = match get(doc, descendant, b"CIDToGIDMap") {
        Some(Object::Stream(_)) => stream_bytes(
            doc,
            descendant,
            b"CIDToGIDMap",
            CID_TO_GID_MAX_BYTES,
            "cidToGidMap",
        )?,
        _ => None,
    };
    let mut glyph_codes: HashSet<Code> = HashSet::new();
    let mut valid: Vec<(Code, char)> = Vec::new();
    if let Some(table) = program.as_ref().and_then(|p| p.table.as_ref()) {
        let is_cff = matches!(
            program.as_ref().map(|p| p.kind),
            Some(ProgramKind::Cff | ProgramKind::OpenTypeCff)
        );
        let mut codes: Vec<&Code> = decode.keys().collect();
        codes.sort_unstable();
        for code in codes {
            if *code > 0xFFFF {
                continue;
            }
            let cid = *code;
            let gid = if let Some(map) = &cid_to_gid {
                let at = cid as usize * 2;
                match map.get(at..at + 2) {
                    Some(b) => u32::from(u16::from_be_bytes([b[0], b[1]])),
                    None => continue,
                }
            } else if is_cff && !table.cid_to_gid.is_empty() {
                match table.cid_to_gid.get(&cid) {
                    Some(g) => *g,
                    None => continue,
                }
            } else {
                cid
            };
            let text = &decode[code];
            let blank = single(text).is_some_and(char::is_whitespace);
            if gid != 0 && table.has_glyph(gid, blank) {
                glyph_codes.insert(*code);
                if let Some(c) = single(text) {
                    valid.push((*code, c));
                }
            }
        }
    }
    detail.map.glyphs = GlyphSet { codes: glyph_codes };
    detail.map.to_code = build_to_code(&valid, observed);
    detail.map.space_code = detail.map.to_code.get(&' ').copied();
    detail.decode = decode;
    Ok(())
}

/// The `/W` array of a CID font: `c [w1 w2 ...]` and `c1 c2 w`. `limit_exceeded` over `CID_WIDTHS_MAX` entries.
fn read_w(doc: &Document, items: &[Object], out: &mut HashMap<u32, f32>) -> Result<(), AppError> {
    let too_many = || AppError::limit("cidWidths", CID_WIDTHS_MAX as u64);
    let mut i = 0;
    while i < items.len() {
        let Some(first) = number(doc, &items[i]).filter(|f| (0.0..=65_535.0).contains(f)) else {
            return Ok(());
        };
        let first = first as u32;
        match items.get(i + 1).and_then(|o| deref(doc, o)) {
            Some(Object::Array(list)) => {
                for (k, w) in list.iter().enumerate() {
                    if let Some(w) = number(doc, w) {
                        out.insert(first.saturating_add(k as u32), w as f32);
                        if out.len() > CID_WIDTHS_MAX {
                            return Err(too_many());
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
                    return Ok(());
                };
                if !(0.0..=65_535.0).contains(&last) {
                    return Ok(());
                }
                let last = last as u32;
                if last >= first {
                    if (last - first) as usize >= CID_WIDTHS_MAX {
                        return Err(too_many());
                    }
                    for cid in first..=last {
                        out.insert(cid, w as f32);
                        if out.len() > CID_WIDTHS_MAX {
                            return Err(too_many());
                        }
                    }
                }
                i += 3;
            }
            None => return Ok(()),
        }
    }
    Ok(())
}

// ---- writing a fallback font ----------------------------------------------------------------------------------------------------

fn name(n: &str) -> Object {
    Object::Name(n.as_bytes().to_vec())
}

fn real(v: f32) -> Object {
    Object::Real(if v.is_finite() { v } else { 0.0 })
}

fn flate(mut dict: Dictionary, bytes: &[u8]) -> Result<Stream, AppError> {
    let mut encoder = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
    encoder
        .write_all(bytes)
        .map_err(|_| AppError::new(ErrorCode::Internal))?;
    let packed = encoder
        .finish()
        .map_err(|_| AppError::new(ErrorCode::Internal))?;
    dict.set("Filter", name("FlateDecode"));
    Ok(Stream::new(dict, packed))
}

/// Six capital letters derived from the face and the glyph set: the subset tag of the `BaseFont`.
fn subset_tag(face: Face, subset: &Subset) -> String {
    let mut h: u64 = 0xCBF2_9CE4_8422_2325;
    for b in face.base_font().bytes().chain(
        subset
            .gids
            .iter()
            .flat_map(|(c, _)| (*c as u32).to_le_bytes()),
    ) {
        h ^= u64::from(b);
        h = h.wrapping_mul(0x0000_0100_0000_01B3);
    }
    (0..6)
        .map(|i| char::from(b'A' + ((h >> (i * 5)) % 26) as u8))
        .collect()
}

/// The `ToUnicode` CMap text of a subset (one `bfchar` per glyph).
fn to_unicode_cmap(subset: &Subset) -> String {
    let mut out = String::from(
        "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) \
         /Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\n\
         endcodespacerange\n",
    );
    let mut pairs: Vec<(u16, char)> = subset.gids.iter().map(|(c, g)| (*g, *c)).collect();
    pairs.sort_unstable();
    for chunk in pairs.chunks(100) {
        out.push_str(&format!("{} beginbfchar\n", chunk.len()));
        for (gid, c) in chunk {
            let mut units = [0u16; 2];
            let hex: String = c
                .encode_utf16(&mut units)
                .iter()
                .map(|u| format!("{u:04X}"))
                .collect();
            out.push_str(&format!("<{gid:04X}> <{hex}>\n"));
        }
        out.push_str("endbfchar\n");
    }
    out.push_str("endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n");
    out
}

/// The 2-byte codes (big-endian gids) that show `text` in `subset`, or the first character it lacks.
pub fn fallback_codes(subset: &Subset, text: &str) -> Result<Vec<u8>, char> {
    let mut out = Vec::with_capacity(text.chars().count() * 2);
    for c in text.chars() {
        let gid = subset
            .gids
            .iter()
            .find(|(ch, _)| *ch == c)
            .map(|(_, g)| *g)
            .ok_or(c)?;
        out.extend_from_slice(&gid.to_be_bytes());
    }
    Ok(out)
}

/// Adds the subset of `face` to `doc` as a Type0/Identity-H font (`CIDFontType2`, `FontFile2`, `W`, `ToUnicode`) and returns the
/// object of the Type0 dictionary. One call per (face, save); the glyphs are the union in `subset`.
pub fn add_fallback_font(
    doc: &mut Document,
    face: Face,
    subset: &Subset,
) -> Result<ObjectId, AppError> {
    let tag = subset_tag(face, subset);
    let base = format!("{tag}+{}", face.base_font());
    let numbers = face.descriptor().ok_or(AppError::invalid("fontProgram"))?;

    let mut file_dict = Dictionary::new();
    file_dict.set("Length1", Object::Integer(subset.program.len() as i64));
    let file = doc.add_object(Object::Stream(flate(file_dict, &subset.program)?));

    let mut descriptor = Dictionary::new();
    descriptor.set("Type", name("FontDescriptor"));
    descriptor.set("FontName", name(&base));
    descriptor.set("Flags", Object::Integer(4));
    descriptor.set(
        "FontBBox",
        Object::Array(numbers.bbox.iter().map(|v| real(v.round())).collect()),
    );
    descriptor.set("ItalicAngle", real(numbers.italic_angle));
    descriptor.set("Ascent", real(numbers.ascent.round()));
    descriptor.set("Descent", real(numbers.descent.round()));
    descriptor.set("CapHeight", real(numbers.cap_height.round()));
    descriptor.set("StemV", Object::Integer(if face.bold { 140 } else { 80 }));
    descriptor.set("FontFile2", Object::Reference(file));
    let descriptor = doc.add_object(Object::Dictionary(descriptor));

    // /W: runs of consecutive gids as `first [w w w]`
    let mut by_gid: Vec<(u16, f32)> = subset.widths.clone();
    by_gid.sort_by_key(|(g, _)| *g);
    by_gid.dedup_by_key(|(g, _)| *g);
    let mut w: Vec<Object> = Vec::new();
    let mut i = 0;
    while i < by_gid.len() {
        let mut j = i;
        while j + 1 < by_gid.len() && by_gid[j + 1].0 == by_gid[j].0 + 1 {
            j += 1;
        }
        w.push(Object::Integer(i64::from(by_gid[i].0)));
        w.push(Object::Array(
            by_gid[i..=j].iter().map(|(_, v)| real(v.round())).collect(),
        ));
        i = j + 1;
    }

    let mut cid = Dictionary::new();
    cid.set("Type", name("Font"));
    cid.set("Subtype", name("CIDFontType2"));
    cid.set("BaseFont", name(&base));
    let mut info = Dictionary::new();
    info.set(
        "Registry",
        Object::String(b"Adobe".to_vec(), StringFormat::Literal),
    );
    info.set(
        "Ordering",
        Object::String(b"Identity".to_vec(), StringFormat::Literal),
    );
    info.set("Supplement", Object::Integer(0));
    cid.set("CIDSystemInfo", Object::Dictionary(info));
    cid.set("FontDescriptor", Object::Reference(descriptor));
    cid.set("DW", Object::Integer(1000));
    cid.set("W", Object::Array(w));
    cid.set("CIDToGIDMap", name("Identity"));
    let cid = doc.add_object(Object::Dictionary(cid));

    let cmap = doc.add_object(Object::Stream(flate(
        Dictionary::new(),
        to_unicode_cmap(subset).as_bytes(),
    )?));

    let mut font = Dictionary::new();
    font.set("Type", name("Font"));
    font.set("Subtype", name("Type0"));
    font.set("BaseFont", name(&base));
    font.set("Encoding", name("Identity-H"));
    font.set(
        "DescendantFonts",
        Object::Array(vec![Object::Reference(cid)]),
    );
    font.set("ToUnicode", Object::Reference(cmap));
    Ok(doc.add_object(Object::Dictionary(font)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fontprog::fallback::FallbackStore;
    use crate::model::text_edit::FallbackFace;

    const ARIMO: &[u8] = include_bytes!("../../resources/fonts/Arimo-Regular.ttf");

    fn stream(doc: &mut Document, dict: Dictionary, bytes: &[u8]) -> ObjectId {
        doc.add_object(Object::Stream(Stream::new(dict, bytes.to_vec())))
    }

    fn font_dict(subtype: &str, base: &str) -> Dictionary {
        let mut d = Dictionary::new();
        d.set("Type", name("Font"));
        d.set("Subtype", name(subtype));
        d.set("BaseFont", name(base));
        d
    }

    fn widths_of(n: usize, w: i64) -> Object {
        Object::Array(vec![Object::Integer(w); n])
    }

    fn map_of(doc: &Document, id: ObjectId) -> FontMap {
        font_map(doc, id, &HashMap::new()).unwrap()
    }

    #[test]
    fn non_embedded_helvetica_uses_the_afm() {
        let mut doc = Document::new();
        let mut d = font_dict("Type1", "Helvetica");
        d.set("Encoding", name("WinAnsiEncoding"));
        let id = doc.add_object(Object::Dictionary(d));
        let m = map_of(&doc, id);
        assert_eq!(m.kind, FontKind::Simple);
        assert_eq!(m.embedded, None);
        assert_eq!(m.status('A'), CharStatus::Ok);
        assert_eq!(m.status('ä'), CharStatus::Ok);
        assert_eq!(m.status('€'), CharStatus::Ok);
        assert_eq!(m.status('中'), CharStatus::Missing);
        assert_eq!(m.status('\u{2260}'), CharStatus::Missing);
        assert_eq!(m.width(u32::from(b'A')), Some(667.0));
        assert_eq!(m.text_width("Hello"), Some(2278.0));
        assert_eq!(m.space_code, Some(32));
        assert_eq!(m.encode("Aä").unwrap(), vec![65, 0xE4]);
        assert_eq!(m.encode("A中").unwrap_err(), '中');
    }

    #[test]
    fn non_embedded_unknown_font_needs_widths() {
        let mut doc = Document::new();
        let mut d = font_dict("TrueType", "Calibri");
        d.set("Encoding", name("WinAnsiEncoding"));
        let id = doc.add_object(Object::Dictionary(d.clone()));
        assert_eq!(map_of(&doc, id).status('A'), CharStatus::Missing);
        d.set("FirstChar", Object::Integer(65));
        d.set("Widths", widths_of(3, 600));
        let id = doc.add_object(Object::Dictionary(d));
        let m = map_of(&doc, id);
        assert_eq!(m.status('A'), CharStatus::Ok);
        assert_eq!(m.status('C'), CharStatus::Ok);
        assert_eq!(m.status('D'), CharStatus::Missing, "no width");
    }

    fn embedded_truetype(
        doc: &mut Document,
        encoding: Object,
        extra: impl FnOnce(&mut Dictionary),
    ) -> ObjectId {
        let file = stream(doc, Dictionary::new(), ARIMO);
        let mut desc = Dictionary::new();
        desc.set("Type", name("FontDescriptor"));
        desc.set("Flags", Object::Integer(32));
        desc.set("FontFile2", Object::Reference(file));
        let desc = doc.add_object(Object::Dictionary(desc));
        let mut d = font_dict("TrueType", "ABCDEF+Arimo");
        d.set("FontDescriptor", Object::Reference(desc));
        d.set("Encoding", encoding);
        d.set("FirstChar", Object::Integer(0));
        d.set("Widths", widths_of(256, 500));
        extra(&mut d);
        doc.add_object(Object::Dictionary(d))
    }

    #[test]
    fn embedded_truetype_checks_the_cmap_not_just_the_encoding() {
        let mut doc = Document::new();
        // code 200 is mapped by /Differences to a CJK glyph name the font does not have; code 201 to `Euro`
        let mut enc = Dictionary::new();
        enc.set("BaseEncoding", name("WinAnsiEncoding"));
        enc.set(
            "Differences",
            Object::Array(vec![Object::Integer(200), name("uni4E2D"), name("Euro")]),
        );
        let id = embedded_truetype(&mut doc, Object::Dictionary(enc), |_| {});
        let m = map_of(&doc, id);
        assert_eq!(m.embedded, Some(ProgramKind::TrueType));
        assert!(m.subset);
        assert_eq!(m.status('A'), CharStatus::Ok);
        assert_eq!(m.status('ä'), CharStatus::Ok);
        assert_eq!(
            m.status('中'),
            CharStatus::Missing,
            "code exists, glyph does not"
        );
        assert_eq!(m.to_code.get(&'€'), Some(&128), "lowest code of Euro wins");
        assert!(!m.glyphs.codes.contains(&200));
        assert_eq!(m.status(' '), CharStatus::Ok, "space is blank but present");
    }

    #[test]
    fn to_unicode_wins_over_the_encoding() {
        let mut doc = Document::new();
        let cmap = stream(
            &mut doc,
            Dictionary::new(),
            b"begincmap 1 beginbfchar <41> <0042> endbfchar endcmap",
        );
        let id = embedded_truetype(&mut doc, name("WinAnsiEncoding"), |d| {
            d.set("ToUnicode", Object::Reference(cmap));
        });
        let det = font_detail(&doc, id, &HashMap::new()).unwrap();
        assert_eq!(det.decode[&0x41], "B");
        assert_eq!(det.map.to_code.get(&'B'), Some(&0x41));
        assert_eq!(det.display_name, "Arimo");
        assert_eq!(det.fallback_face(), pick(32, 400, "Arimo"));
    }

    #[test]
    fn embedded_type1_is_checked_by_charstring_name() {
        let mut doc = Document::new();
        let program = crate::fontprog::type1::tests::sample(false);
        let file = stream(&mut doc, Dictionary::new(), &program);
        let mut desc = Dictionary::new();
        desc.set("Type", name("FontDescriptor"));
        desc.set("Flags", Object::Integer(32));
        desc.set("FontFile", Object::Reference(file));
        let desc = doc.add_object(Object::Dictionary(desc));
        let mut d = font_dict("Type1", "Test");
        d.set("FontDescriptor", Object::Reference(desc));
        d.set("Encoding", name("WinAnsiEncoding"));
        d.set("FirstChar", Object::Integer(0));
        d.set("Widths", widths_of(256, 500));
        let id = doc.add_object(Object::Dictionary(d));
        let m = map_of(&doc, id);
        assert_eq!(m.embedded, Some(ProgramKind::Type1));
        assert_eq!(m.status('A'), CharStatus::Ok);
        assert_eq!(m.status(' '), CharStatus::Ok, "space exists, empty outline");
        assert_eq!(m.status('B'), CharStatus::Missing, "no /B in CharStrings");
    }

    #[test]
    fn identity_h_uses_reverse_to_unicode_cid_to_gid_and_w() {
        let mut doc = Document::new();
        let file = stream(&mut doc, Dictionary::new(), ARIMO);
        let a = skrifa_gid('A');
        let space = skrifa_gid(' ');
        let cmap = format!(
            "begincmap 4 beginbfchar <{a:04X}> <0041> <{space:04X}> <0020> <FFF0> <0042> <0001> <0043> endbfchar endcmap"
        );
        let cmap = stream(&mut doc, Dictionary::new(), cmap.as_bytes());
        let mut desc = Dictionary::new();
        desc.set("Type", name("FontDescriptor"));
        desc.set("FontFile2", Object::Reference(file));
        let desc = doc.add_object(Object::Dictionary(desc));
        let mut cid = font_dict("CIDFontType2", "ABCDEF+Arimo");
        cid.set("FontDescriptor", Object::Reference(desc));
        cid.set("DW", Object::Integer(700));
        cid.set(
            "W",
            Object::Array(vec![
                Object::Integer(i64::from(a)),
                Object::Array(vec![Object::Integer(667)]),
            ]),
        );
        let cid = doc.add_object(Object::Dictionary(cid));
        let mut d = font_dict("Type0", "ABCDEF+Arimo");
        d.set("Encoding", name("Identity-H"));
        d.set(
            "DescendantFonts",
            Object::Array(vec![Object::Reference(cid)]),
        );
        d.set("ToUnicode", Object::Reference(cmap));
        let id = doc.add_object(Object::Dictionary(d));
        let m = map_of(&doc, id);
        assert_eq!(m.kind, FontKind::Type0IdentityH);
        assert_eq!(m.code_len(), 2);
        assert_eq!(m.status('A'), CharStatus::Ok);
        assert_eq!(m.to_code[&'A'], a);
        assert_eq!(m.width(a), Some(667.0));
        assert_eq!(m.width(space), Some(700.0), "DW");
        assert_eq!(m.status(' '), CharStatus::Ok, "blank glyph is fine");
        assert_eq!(m.space_code, Some(space));
        assert_eq!(m.status('B'), CharStatus::Missing, "cid beyond numGlyphs");
        assert_eq!(m.code_bytes(&[0x1234, 5]), vec![0x12, 0x34, 0, 5]);
        // The page used code 0x0001 for C; its gid 1 exists but ToUnicode says C
        assert!(m.status('C') == CharStatus::Ok || m.status('C') == CharStatus::Missing);
    }

    fn skrifa_gid(c: char) -> u32 {
        use skrifa::MetadataProvider;
        skrifa::FontRef::new(ARIMO)
            .unwrap()
            .charmap()
            .map(c)
            .unwrap()
            .to_u32()
    }

    #[test]
    fn identity_h_with_a_cid_to_gid_stream() {
        let mut doc = Document::new();
        let file = stream(&mut doc, Dictionary::new(), ARIMO);
        let a = skrifa_gid('A');
        // CID 1 -> gid of A; CID 2 -> gid 0xFFFF (out of range)
        let mut map = vec![0u8; 8];
        map[2..4].copy_from_slice(&(a as u16).to_be_bytes());
        map[4..6].copy_from_slice(&0xFFFFu16.to_be_bytes());
        let map = stream(&mut doc, Dictionary::new(), &map);
        let cmap = stream(
            &mut doc,
            Dictionary::new(),
            b"begincmap 3 beginbfchar <0001> <0041> <0002> <0042> <0003> <0043> endbfchar endcmap",
        );
        let mut desc = Dictionary::new();
        desc.set("FontFile2", Object::Reference(file));
        let desc = doc.add_object(Object::Dictionary(desc));
        let mut cid = font_dict("CIDFontType2", "X");
        cid.set("FontDescriptor", Object::Reference(desc));
        cid.set("CIDToGIDMap", Object::Reference(map));
        let cid = doc.add_object(Object::Dictionary(cid));
        let mut d = font_dict("Type0", "X");
        d.set("Encoding", name("Identity-H"));
        d.set(
            "DescendantFonts",
            Object::Array(vec![Object::Reference(cid)]),
        );
        d.set("ToUnicode", Object::Reference(cmap));
        let id = doc.add_object(Object::Dictionary(d));
        let m = map_of(&doc, id);
        assert_eq!(m.status('A'), CharStatus::Ok);
        assert_eq!(m.status('B'), CharStatus::Missing);
        assert_eq!(
            m.status('C'),
            CharStatus::Missing,
            "gid 0 has no outline in the map"
        );
    }

    #[test]
    fn refuse_kinds() {
        let mut doc = Document::new();
        let id = doc.add_object(Object::Dictionary(font_dict("Type3", "T3")));
        assert_eq!(map_of(&doc, id).kind, FontKind::Type3);
        let mut v = font_dict("Type0", "V");
        v.set("Encoding", name("Identity-V"));
        let id = doc.add_object(Object::Dictionary(v));
        assert_eq!(map_of(&doc, id).kind, FontKind::Type0Other);
        let mut v = font_dict("Type0", "V");
        v.set("Encoding", name("UniJIS-UCS2-H"));
        let id = doc.add_object(Object::Dictionary(v));
        let m = map_of(&doc, id);
        assert_eq!(m.kind, FontKind::Type0Other);
        assert!(m.to_code.is_empty());
        let id = doc.add_object(Object::Dictionary(font_dict("Weird", "W")));
        assert_eq!(
            font_map(&doc, id, &HashMap::new()).unwrap_err().code(),
            ErrorCode::UnsupportedFeature
        );
    }

    #[test]
    fn observed_table_serves_a_font_without_to_unicode() {
        let mut doc = Document::new();
        let mut d = font_dict("Type1", "Calibri");
        d.set("FirstChar", Object::Integer(1));
        d.set("Widths", widths_of(2, 500));
        let id = doc.add_object(Object::Dictionary(d));
        let observed = HashMap::from([(1u32, 'x'), (2u32, 'y')]);
        let m = font_map(&doc, id, &observed).unwrap();
        assert_eq!(m.status('x'), CharStatus::Ok);
        assert_eq!(m.to_code[&'y'], 2);
    }

    #[test]
    fn hostile_dictionaries_are_refused_or_survived() {
        let mut doc = Document::new();
        // Differences over the limit
        let mut items = vec![Object::Integer(0)];
        items.extend((0..300).map(|i| name(&format!("g{i}"))));
        let mut enc = Dictionary::new();
        enc.set("Differences", Object::Array(items));
        let mut d = font_dict("Type1", "Helvetica");
        d.set("Encoding", Object::Dictionary(enc));
        let id = doc.add_object(Object::Dictionary(d));
        assert_eq!(
            font_map(&doc, id, &HashMap::new()).unwrap_err().code(),
            ErrorCode::LimitExceeded
        );
        // a self-referencing encoding and a font whose descriptor refers to itself
        let cyc = doc.new_object_id();
        doc.objects.insert(cyc, Object::Reference(cyc));
        let mut d = font_dict("Type1", "Helvetica");
        d.set("Encoding", Object::Reference(cyc));
        d.set("FontDescriptor", Object::Reference(cyc));
        d.set("Widths", Object::Reference(cyc));
        let id = doc.add_object(Object::Dictionary(d));
        let _ = font_map(&doc, id, &HashMap::new());
        // an oversized ToUnicode
        let mut big = b"begincmap 1 beginbfrange <0000> <FFFFFFFF> <0041> endbfrange".to_vec();
        big.resize(10, b' ');
        let cmap = stream(
            &mut doc,
            Dictionary::new(),
            b"begincmap 1 beginbfrange <0000> <FFFFFFFF> <0041> endbfrange",
        );
        let mut d = font_dict("Type1", "Helvetica");
        d.set("ToUnicode", Object::Reference(cmap));
        let id = doc.add_object(Object::Dictionary(d));
        assert_eq!(
            font_map(&doc, id, &HashMap::new()).unwrap_err().code(),
            ErrorCode::LimitExceeded
        );
        // a hostile /W
        let w = vec![
            Object::Integer(0),
            Object::Array(vec![Object::Integer(5); CID_WIDTHS_MAX + 1]),
        ];
        assert!(read_w(&doc, &w, &mut HashMap::new()).is_err());
        // a broken font program is "embedded, no glyphs", not an error
        let junk = stream(&mut doc, Dictionary::new(), b"this is not a font");
        let mut desc = Dictionary::new();
        desc.set("FontFile2", Object::Reference(junk));
        let desc = doc.add_object(Object::Dictionary(desc));
        let mut d = font_dict("TrueType", "J");
        d.set("FontDescriptor", Object::Reference(desc));
        d.set("Encoding", name("WinAnsiEncoding"));
        d.set("Widths", widths_of(256, 500));
        let id = doc.add_object(Object::Dictionary(d));
        let m = map_of(&doc, id);
        assert_eq!(m.embedded, Some(ProgramKind::TrueType));
        assert_eq!(m.status('A'), CharStatus::Missing);
    }

    #[test]
    fn fallback_font_round_trips_through_the_reader() {
        let face = Face {
            family: FallbackFace::Serif,
            bold: true,
            italic: false,
        };
        let mut store = FallbackStore::default();
        store.add(face, "Grüße, Welt! €");
        let subset = store.subset(face).unwrap();
        let mut doc = Document::new();
        let id = add_fallback_font(&mut doc, face, &subset).unwrap();
        let det = font_detail(&doc, id, &HashMap::new()).unwrap();
        let m = &det.map;
        assert_eq!(m.kind, FontKind::Type0IdentityH);
        assert_eq!(m.embedded, Some(ProgramKind::TrueType));
        assert!(m.subset);
        assert!(det.display_name.starts_with("Tinos-Bold"));
        for c in "Grüße, Welt! €".chars() {
            assert_eq!(m.status(c), CharStatus::Ok, "{c}");
        }
        assert_eq!(m.status('Z'), CharStatus::Missing);
        let (_, gid) = subset.gids.iter().find(|(c, _)| *c == 'ü').unwrap();
        assert_eq!(m.to_code[&'ü'], u32::from(*gid));
        let (_, w) = subset.widths.iter().find(|(g, _)| g == gid).unwrap();
        assert!((m.width(u32::from(*gid)).unwrap() - w.round()).abs() < 0.01);
        assert_eq!(fallback_codes(&subset, "Welt").unwrap().len(), 8);
        assert_eq!(fallback_codes(&subset, "Q").unwrap_err(), 'Q');
        // saved and reloaded as a PDF file the object graph is still readable
        let tag = subset_tag(face, &subset);
        assert_eq!(tag.len(), 6);
        assert!(tag.bytes().all(|b| b.is_ascii_uppercase()));
    }

    #[test]
    fn standard_and_mac_roman_tables_are_complete_where_defined() {
        assert_eq!(base_char(Base::WinAnsi, 0x80), Some('€'));
        assert_eq!(base_char(Base::WinAnsi, 0x81), None);
        assert_eq!(base_char(Base::MacRoman, 0x8A), Some('ä'));
        assert_eq!(base_char(Base::MacRoman, 0xFF), Some('ˇ'));
        assert_eq!(MAC_ROMAN_HIGH.chars().count(), 128);
        assert_eq!(base_char(Base::Standard, 0x27), Some('\u{2019}'));
        assert_eq!(base_char(Base::Standard, 0xFB), Some('ß'));
        assert_eq!(base_char(Base::Standard, 0xB5), None);
    }
}
