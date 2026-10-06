//! The offset lexer of a content stream and the splice that rewrites a line (ARCHITECTURE §13.4).
//!
//! The stream is never decoded and encoded again. [`lex`] finds every operator with the byte range of its operands; an edit replaces the
//! byte ranges of the show operators it changes (and inserts a `Tz` pair for `squeeze`), so every other byte stays as it was. A stream
//! the lexer is in doubt about (a stray delimiter, an inline image whose end cannot be checked) is refused as `tooComplex`.
//!
//! Layers: the lexer and the operand reader (here, first), [`edit_line`] (one line edit over lexed streams, with the geometry the walker
//! gave), [`replay_core`] (a list of edits, each key resolved after the ones before it, over a [`LineSource`]) and [`replay`] (the
//! production [`LineSource`]: `text_lines`, `text_fonts` and the bundled fallback faces).

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::ops::Range;
use std::time::Instant;

use lopdf::{Document, Object, ObjectId};

use super::ops_walk::{GlyphPos, OpRef};
use super::text_fonts::{font_map, FontKind, FontMap, WidthSource};
use super::text_lines::{self, Align, PageLines};
use crate::error::AppError;
use crate::fontprog::fallback::{pick, Face, FallbackStore};
use crate::limits;
use crate::model::text_edit::{
    ChangeWarning, FallbackFace, LineEditable, LineKey, TextEdit, TextEditRefusal, TextFit,
    TextScope,
};

#[path = "text_reflow.rs"]
mod text_reflow;

/// One operator with the byte range of its operands in the stream. An operator without operands has the empty range at its own start; an
/// inline image (`BI`) is one operator whose range is its dictionary. The operator's index in the vector is its `OpRef::index`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Tok {
    pub op: Vec<u8>,
    pub args: Range<u32>,
}

/// A font object the rewritten page needs in addition (the substitute of a face).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewFont {
    pub face: Face,
    /// The resource name written in `Tf` (`SheerFn...`).
    pub name: String,
}

/// The page after all its edits: the new content stream bytes (one stream), the new fonts and what the user is told.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rewritten {
    pub content: Vec<u8>,
    pub fonts: Vec<NewFont>,
    pub warnings: Vec<ChangeWarning>,
}

/// The resource name of the substitute font of `face` (`SheerFnSansR`, `SheerFnSerifBI`): the same face has the same name on every page.
pub fn resource_name(face: Face) -> String {
    let family = match face.family {
        FallbackFace::Sans => "Sans",
        FallbackFace::Serif => "Serif",
        FallbackFace::Mono => "Mono",
    };
    let style = match (face.bold, face.italic) {
        (false, false) => "R",
        (true, false) => "B",
        (false, true) => "I",
        (true, true) => "BI",
    };
    format!("SheerFn{family}{style}")
}

fn refused() -> AppError {
    TextEditRefusal::TooComplex.error()
}

// --- the lexer ---------------------------------------------------------------------------------------------------------

/// The lexer is in doubt: the caller refuses the edit.
#[derive(Debug, Clone, Copy)]
struct Doubt;
type Lx<T> = Result<T, Doubt>;

const MAX_DEPTH: usize = 32;
const MAX_Q_DEPTH: usize = 512;

const fn is_ws(b: u8) -> bool {
    matches!(b, 0 | 9 | 10 | 12 | 13 | 32)
}

const fn is_delim(b: u8) -> bool {
    matches!(
        b,
        b'(' | b')' | b'<' | b'>' | b'[' | b']' | b'{' | b'}' | b'/' | b'%'
    )
}

fn regular_end(b: &[u8], mut p: usize) -> usize {
    while p < b.len() && !is_ws(b[p]) && !is_delim(b[p]) {
        p += 1;
    }
    p
}

/// The first position at or after `p` that is neither white space nor a comment.
fn skip_ws(b: &[u8], mut p: usize) -> usize {
    loop {
        while p < b.len() && is_ws(b[p]) {
            p += 1;
        }
        if p < b.len() && b[p] == b'%' {
            while p < b.len() && b[p] != b'\n' && b[p] != b'\r' {
                p += 1;
            }
        } else {
            return p;
        }
    }
}

#[derive(Debug, Clone)]
enum Operand {
    Num { value: f64, range: Range<usize> },
    Str(Vec<u8>),
    Name(Range<usize>),
    Array(Vec<Operand>),
    Bool(bool),
    Other,
}

enum Scanned {
    Operand(Operand, usize),
    Word(Range<usize>),
}

fn literal_string(b: &[u8], p: usize) -> Lx<(Vec<u8>, usize)> {
    let mut out = Vec::new();
    let mut depth = 1usize;
    let mut i = p + 1;
    while i < b.len() {
        let c = b[i];
        match c {
            b'\\' => {
                i += 1;
                let e = *b.get(i).ok_or(Doubt)?;
                match e {
                    b'n' => out.push(10),
                    b'r' => out.push(13),
                    b't' => out.push(9),
                    b'b' => out.push(8),
                    b'f' => out.push(12),
                    b'\r' => {
                        if b.get(i + 1) == Some(&b'\n') {
                            i += 1;
                        }
                    }
                    b'\n' => {}
                    b'0'..=b'7' => {
                        let mut v = u32::from(e - b'0');
                        for _ in 0..2 {
                            match b.get(i + 1) {
                                Some(d @ b'0'..=b'7') => {
                                    i += 1;
                                    v = v * 8 + u32::from(d - b'0');
                                }
                                _ => break,
                            }
                        }
                        out.push((v & 0xFF) as u8);
                    }
                    other => out.push(other),
                }
                i += 1;
            }
            b'(' => {
                depth += 1;
                out.push(c);
                i += 1;
            }
            b')' => {
                depth -= 1;
                if depth == 0 {
                    return Ok((out, i + 1));
                }
                out.push(c);
                i += 1;
            }
            b'\r' => {
                out.push(b'\n');
                if b.get(i + 1) == Some(&b'\n') {
                    i += 1;
                }
                i += 1;
            }
            _ => {
                out.push(c);
                i += 1;
            }
        }
    }
    Err(Doubt)
}

fn hex_string(b: &[u8], p: usize) -> Lx<(Vec<u8>, usize)> {
    let mut out = Vec::new();
    let mut high: Option<u8> = None;
    let mut i = p + 1;
    while i < b.len() {
        let c = b[i];
        i += 1;
        let d = match c {
            b'0'..=b'9' => c - b'0',
            b'a'..=b'f' => c - b'a' + 10,
            b'A'..=b'F' => c - b'A' + 10,
            b'>' => {
                if let Some(h) = high {
                    out.push(h << 4);
                }
                return Ok((out, i));
            }
            c if is_ws(c) => continue,
            _ => return Err(Doubt),
        };
        match high.take() {
            Some(h) => out.push(h << 4 | d),
            None => high = Some(d),
        }
    }
    Err(Doubt)
}

fn scan_token(b: &[u8], p: usize, depth: usize) -> Lx<Scanned> {
    if depth > MAX_DEPTH {
        return Err(Doubt);
    }
    let c = *b.get(p).ok_or(Doubt)?;
    match c {
        b'/' => {
            let e = regular_end(b, p + 1);
            Ok(Scanned::Operand(Operand::Name(p..e), e))
        }
        b'(' => {
            let (s, e) = literal_string(b, p)?;
            Ok(Scanned::Operand(Operand::Str(s), e))
        }
        b'<' if b.get(p + 1) == Some(&b'<') => {
            let mut q = p + 2;
            loop {
                q = skip_ws(b, q);
                match b.get(q) {
                    None => return Err(Doubt),
                    Some(b'>') => {
                        return if b.get(q + 1) == Some(&b'>') {
                            Ok(Scanned::Operand(Operand::Other, q + 2))
                        } else {
                            Err(Doubt)
                        };
                    }
                    Some(_) => match scan_token(b, q, depth + 1)? {
                        Scanned::Operand(_, e) => q = e,
                        Scanned::Word(_) => return Err(Doubt),
                    },
                }
            }
        }
        b'<' => {
            let (s, e) = hex_string(b, p)?;
            Ok(Scanned::Operand(Operand::Str(s), e))
        }
        b'[' => {
            let mut items = Vec::new();
            let mut q = p + 1;
            loop {
                q = skip_ws(b, q);
                match b.get(q) {
                    None => return Err(Doubt),
                    Some(b']') => return Ok(Scanned::Operand(Operand::Array(items), q + 1)),
                    Some(_) => match scan_token(b, q, depth + 1)? {
                        Scanned::Operand(o, e) => {
                            items.push(o);
                            q = e;
                        }
                        Scanned::Word(_) => return Err(Doubt),
                    },
                }
            }
        }
        b']' | b')' | b'>' | b'{' | b'}' => Err(Doubt),
        _ => {
            let e = regular_end(b, p);
            let w = &b[p..e];
            if matches!(w[0], b'+' | b'-' | b'.' | b'0'..=b'9') {
                if !w
                    .iter()
                    .all(|c| matches!(c, b'+' | b'-' | b'.' | b'0'..=b'9'))
                {
                    return Err(Doubt);
                }
                let value = std::str::from_utf8(w)
                    .ok()
                    .and_then(|s| s.parse::<f64>().ok())
                    .unwrap_or(0.0);
                Ok(Scanned::Operand(Operand::Num { value, range: p..e }, e))
            } else if matches!(w, b"true" | b"false") {
                Ok(Scanned::Operand(Operand::Bool(w == b"true"), e))
            } else if w == b"null" {
                Ok(Scanned::Operand(Operand::Other, e))
            } else {
                Ok(Scanned::Word(p..e))
            }
        }
    }
}

/// Where the operators of a stream are: `starts[i]` is where operator `i` begins (the first operand when it has some is `args.start`),
/// `ends[i]` where it ends (after `EI` for an inline image).
struct Lexed {
    toks: Vec<Tok>,
    ends: Vec<u32>,
}

fn to_u32(n: usize) -> Lx<u32> {
    u32::try_from(n).map_err(|_| Doubt)
}

fn name_text(b: &[u8], r: &Range<usize>) -> Vec<u8> {
    b[r.start + 1..r.end].to_vec()
}

/// The end of an inline image whose `ID` ends at `id_end`, with its data checked (ARCHITECTURE §13.4: "a length check").
fn inline_image_end(b: &[u8], id_end: usize, entries: &[(Vec<u8>, Operand)]) -> Lx<usize> {
    let get = |short: &[u8], long: &[u8]| {
        entries
            .iter()
            .find(|(k, _)| k == short || k == long)
            .map(|(_, v)| v)
    };
    let num = |o: Option<&Operand>| match o {
        Some(Operand::Num { value, .. }) if *value >= 0.0 && value.fract() == 0.0 => {
            Some(*value as u64)
        }
        _ => None,
    };
    let filter = match get(b"F", b"Filter") {
        None => None,
        Some(Operand::Name(r)) => Some(name_text(b, r)),
        Some(Operand::Array(items)) => match items.first() {
            Some(Operand::Name(r)) => Some(name_text(b, r)),
            None => None,
            _ => return Err(Doubt),
        },
        Some(_) => return Err(Doubt),
    };
    // The data starts after one white-space byte (or CR LF).
    let first = *b.get(id_end).ok_or(Doubt)?;
    if !is_ws(first) {
        return Err(Doubt);
    }
    let mut starts = vec![id_end + 1];
    if first == b'\r' && b.get(id_end + 1) == Some(&b'\n') {
        starts.push(id_end + 2);
    }
    let after_ei = |q: usize| -> Option<usize> {
        let e = q + 2;
        (b.get(q..e) == Some(b"EI") && (e == b.len() || is_ws(b[e]) || is_delim(b[e]))).then_some(e)
    };
    let mask = matches!(get(b"IM", b"ImageMask"), Some(Operand::Bool(true)));
    let components = if mask {
        Some(1)
    } else {
        match get(b"CS", b"ColorSpace") {
            Some(Operand::Name(r)) => match name_text(b, r).as_slice() {
                b"G" | b"DeviceGray" | b"CalGray" => Some(1u64),
                b"RGB" | b"DeviceRGB" | b"CalRGB" => Some(3),
                b"CMYK" | b"DeviceCMYK" => Some(4),
                _ => None,
            },
            _ => None,
        }
    };
    let bpc = if mask {
        Some(1)
    } else {
        num(get(b"BPC", b"BitsPerComponent"))
    };
    if filter.is_none() {
        if let (Some(w), Some(h), Some(bpc), Some(n)) = (
            num(get(b"W", b"Width")),
            num(get(b"H", b"Height")),
            bpc,
            components,
        ) {
            let row = w
                .checked_mul(bpc)
                .and_then(|v| v.checked_mul(n))
                .map(|v| v.div_ceil(8))
                .ok_or(Doubt)?;
            let len = usize::try_from(row.checked_mul(h).ok_or(Doubt)?).map_err(|_| Doubt)?;
            for start in &starts {
                let data_end = start.checked_add(len).ok_or(Doubt)?;
                if data_end > b.len() {
                    continue;
                }
                let mut q = data_end;
                while q < b.len() && is_ws(b[q]) {
                    q += 1;
                }
                if let Some(e) = after_ei(q) {
                    return Ok(e);
                }
            }
            return Err(Doubt);
        }
    }
    // A filtered image (or a colour space of the resources): the length is not known, so `EI` must stand after white space, before white
    // space or the end, and what follows it must look like a content stream. ASCII filters have a sure end marker.
    let start = starts[0];
    let mut from = start;
    match filter.as_deref() {
        Some(b"AHx" | b"ASCIIHexDecode") => {
            from = b[start..]
                .iter()
                .position(|c| *c == b'>')
                .map(|i| start + i + 1)
                .ok_or(Doubt)?;
        }
        Some(b"A85" | b"ASCII85Decode") => {
            from = b[start..]
                .windows(2)
                .position(|w| w == b"~>")
                .map(|i| start + i + 2)
                .ok_or(Doubt)?;
        }
        _ => {}
    }
    let mut q = from;
    while q + 1 < b.len() {
        if b[q] == b'E' && b[q + 1] == b'I' && (q == start || is_ws(b[q - 1])) {
            if let Some(e) = after_ei(q) {
                let tail = &b[e..(e + 32).min(b.len())];
                if tail.iter().all(|c| is_ws(*c) || (0x20..0x7F).contains(c)) {
                    return Ok(e);
                }
            }
        }
        q += 1;
    }
    Err(Doubt)
}

fn lex_full(b: &[u8]) -> Lx<Lexed> {
    to_u32(b.len())?;
    let mut toks = Vec::new();
    let mut ends = Vec::new();
    let mut p = 0usize;
    let mut first: Option<usize> = None;
    let mut last_end = 0usize;
    loop {
        p = skip_ws(b, p);
        if p >= b.len() {
            break;
        }
        match scan_token(b, p, 0)? {
            Scanned::Operand(_, e) => {
                first.get_or_insert(p);
                last_end = e;
                p = e;
            }
            Scanned::Word(r) => {
                let op = b[r.clone()].to_vec();
                match op.as_slice() {
                    b"BI" => {
                        if first.is_some() {
                            return Err(Doubt);
                        }
                        let dict_start = skip_ws(b, r.end);
                        let mut q = dict_start;
                        let mut dict_end = dict_start;
                        let mut entries: Vec<(Vec<u8>, Operand)> = Vec::new();
                        let id_end = loop {
                            q = skip_ws(b, q);
                            if q >= b.len() {
                                return Err(Doubt);
                            }
                            match scan_token(b, q, 0)? {
                                Scanned::Word(w) if &b[w.clone()] == b"ID" => break w.end,
                                Scanned::Word(_) => return Err(Doubt),
                                Scanned::Operand(Operand::Name(k), e) => {
                                    let v = skip_ws(b, e);
                                    if v >= b.len() {
                                        return Err(Doubt);
                                    }
                                    match scan_token(b, v, 0)? {
                                        Scanned::Operand(value, ve) => {
                                            entries.push((name_text(b, &k), value));
                                            q = ve;
                                            dict_end = ve;
                                        }
                                        Scanned::Word(_) => return Err(Doubt),
                                    }
                                }
                                Scanned::Operand(..) => return Err(Doubt),
                            }
                        };
                        let end = inline_image_end(b, id_end, &entries)?;
                        toks.push(Tok {
                            op,
                            args: to_u32(dict_start)?..to_u32(dict_end)?,
                        });
                        ends.push(to_u32(end)?);
                        p = end;
                    }
                    b"ID" | b"EI" => return Err(Doubt),
                    _ => {
                        let args = match first.take() {
                            Some(f) => to_u32(f)?..to_u32(last_end)?,
                            None => to_u32(r.start)?..to_u32(r.start)?,
                        };
                        toks.push(Tok { op, args });
                        ends.push(to_u32(r.end)?);
                        p = r.end;
                    }
                }
                first = None;
            }
        }
    }
    if first.is_some() {
        return Err(Doubt);
    }
    Ok(Lexed { toks, ends })
}

/// Splits `stream` into operators with offsets; inline images are skipped by `BI..ID..EI` with a length check. `invalid_argument` on doubt
/// (the edit is then refused as `tooComplex`; the stream is never re-encoded).
pub fn lex(stream: &[u8]) -> Result<Vec<Tok>, AppError> {
    lex_full(stream)
        .map(|l| l.toks)
        .map_err(|_| AppError::invalid("content"))
}

fn operands(b: &[u8], r: &Range<u32>) -> Lx<Vec<Operand>> {
    let end = r.end as usize;
    let mut p = r.start as usize;
    let mut out = Vec::new();
    loop {
        p = skip_ws(b, p);
        if p >= end {
            return Ok(out);
        }
        match scan_token(b, p, 0)? {
            Scanned::Operand(o, e) => {
                out.push(o);
                p = e;
            }
            Scanned::Word(_) => return Err(Doubt),
        }
    }
}

// --- show operators as items -------------------------------------------------------------------------------------------

/// One element of a show operator: a glyph code (one or two bytes), a `TJ` number, or a run in the substitute font.
#[derive(Debug, Clone, PartialEq)]
enum Item {
    Glyph(Vec<u8>),
    Kern { text: String, value: f64 },
    Fallback { name: String, codes: Vec<u8> },
}

impl Item {
    fn kern(value: f64) -> Self {
        Self::Kern {
            text: fmt_num(value),
            value,
        }
    }
}

/// A number for a content stream: at most 3 decimals, no exponent.
fn fmt_num(value: f64) -> String {
    if !value.is_finite() {
        return "0".to_owned();
    }
    let text = format!("{value:.3}");
    let text = text.trim_end_matches('0').trim_end_matches('.');
    if text.is_empty() || text == "-0" {
        "0".to_owned()
    } else {
        text.to_owned()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ShowKind {
    Tj,
    TjArray,
    Quote,
    DoubleQuote,
}

#[derive(Debug, Clone)]
struct OpData {
    kind: ShowKind,
    items: Vec<Item>,
    /// The item index of each glyph, in order.
    glyph_items: Vec<usize>,
    /// `T*` (and the `Tw`/`Tc` of `"`) that the rewritten operator has to keep doing.
    prelude: String,
}

fn parse_show(b: &[u8], tok: &Tok, width: usize) -> Lx<OpData> {
    let ops = operands(b, &tok.args)?;
    let mut items = Vec::new();
    let mut glyph_items = Vec::new();
    let mut push_string = |s: &[u8], items: &mut Vec<Item>| -> Lx<()> {
        if width == 0 || !s.len().is_multiple_of(width) {
            return Err(Doubt);
        }
        for chunk in s.chunks(width) {
            glyph_items.push(items.len());
            items.push(Item::Glyph(chunk.to_vec()));
        }
        Ok(())
    };
    let text = |r: &Range<usize>| String::from_utf8_lossy(&b[r.clone()]).into_owned();
    let (kind, prelude) = match (tok.op.as_slice(), ops.as_slice()) {
        (b"Tj", [Operand::Str(s)]) => {
            push_string(s, &mut items)?;
            (ShowKind::Tj, String::new())
        }
        (b"'", [Operand::Str(s)]) => {
            push_string(s, &mut items)?;
            (ShowKind::Quote, "T*".to_owned())
        }
        (
            b"\"",
            [Operand::Num { range: aw, .. }, Operand::Num { range: ac, .. }, Operand::Str(s)],
        ) => {
            push_string(s, &mut items)?;
            (
                ShowKind::DoubleQuote,
                format!("{} Tw {} Tc T*", text(aw), text(ac)),
            )
        }
        (b"TJ", [Operand::Array(array)]) => {
            for el in array {
                match el {
                    Operand::Str(s) => push_string(s, &mut items)?,
                    Operand::Num { value, range } => items.push(Item::Kern {
                        text: text(range),
                        value: *value,
                    }),
                    _ => return Err(Doubt),
                }
            }
            (ShowKind::TjArray, String::new())
        }
        _ => return Err(Doubt),
    };
    Ok(OpData {
        kind,
        items,
        glyph_items,
        prelude,
    })
}

fn is_show(op: &[u8]) -> bool {
    matches!(op, b"Tj" | b"TJ" | b"'" | b"\"")
}

/// Operators that start a new text position: what follows does not move with the text before.
fn is_positioning(op: &[u8]) -> bool {
    matches!(
        op,
        b"Td" | b"TD" | b"Tm" | b"T*" | b"'" | b"\"" | b"BT" | b"ET"
    )
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut out = String::with_capacity(bytes.len() * 2 + 2);
    out.push('<');
    for b in bytes {
        let _ = write!(out, "{b:02X}");
    }
    out.push('>');
    out
}

/// The text of a show operator with these items: `[..] TJ`, with a substitute-font run as `/Fn s Tf [..] TJ /Orig s Tf`.
fn render(data: &OpData, font: &TextState) -> String {
    let mut out: Vec<String> = Vec::new();
    if !data.prelude.is_empty() {
        out.push(data.prelude.clone());
    }
    let mut parts: Vec<String> = Vec::new();
    let mut run: Vec<u8> = Vec::new();
    let flush_run = |run: &mut Vec<u8>, parts: &mut Vec<String>| {
        if !run.is_empty() {
            parts.push(hex(run));
            run.clear();
        }
    };
    let flush_array = |parts: &mut Vec<String>, out: &mut Vec<String>| {
        if !parts.is_empty() {
            out.push(format!("[{}] TJ", parts.join(" ")));
            parts.clear();
        }
    };
    for item in &data.items {
        match item {
            Item::Glyph(code) => run.extend_from_slice(code),
            Item::Kern { text, .. } => {
                flush_run(&mut run, &mut parts);
                parts.push(text.clone());
            }
            Item::Fallback { name, codes } => {
                flush_run(&mut run, &mut parts);
                flush_array(&mut parts, &mut out);
                out.push(format!(
                    "/{name} {size} Tf [{codes}] TJ {orig} {size} Tf",
                    size = font.size_text,
                    codes = hex(codes),
                    orig = String::from_utf8_lossy(&font.font_name),
                ));
            }
        }
    }
    flush_run(&mut run, &mut parts);
    flush_array(&mut parts, &mut out);
    if out.is_empty() || (out.len() == 1 && !data.prelude.is_empty()) {
        out.push("[] TJ".to_owned());
    }
    out.join(" ")
}

// --- the state in front of an operator ---------------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct TextState {
    /// The `Tf` name token as written (`/F1`).
    font_name: Vec<u8>,
    size_text: String,
    size: f64,
    tc: f64,
    tw: f64,
    /// `Tz` in percent.
    tz: f64,
}

impl Default for TextState {
    fn default() -> Self {
        Self {
            font_name: Vec::new(),
            size_text: "0".to_owned(),
            size: 0.0,
            tc: 0.0,
            tw: 0.0,
            tz: 100.0,
        }
    }
}

struct Flat {
    stream: usize,
    tok: usize,
}

struct View<'a> {
    st: Vec<&'a [u8]>,
    lexed: Vec<Lexed>,
    flat: Vec<Flat>,
    first_of: Vec<usize>,
}

impl<'a> View<'a> {
    fn new(streams: &'a [Vec<u8>]) -> Lx<Self> {
        let mut lexed = Vec::with_capacity(streams.len());
        let mut flat = Vec::new();
        let mut first_of = Vec::with_capacity(streams.len());
        for (stream, bytes) in streams.iter().enumerate() {
            let l = lex_full(bytes)?;
            first_of.push(flat.len());
            flat.extend((0..l.toks.len()).map(|tok| Flat { stream, tok }));
            lexed.push(l);
        }
        Ok(Self {
            st: streams.iter().map(Vec::as_slice).collect(),
            lexed,
            flat,
            first_of,
        })
    }

    fn tok(&self, pos: usize) -> &Tok {
        &self.lexed[self.flat[pos].stream].toks[self.flat[pos].tok]
    }

    fn end(&self, pos: usize) -> u32 {
        self.lexed[self.flat[pos].stream].ends[self.flat[pos].tok]
    }

    fn bytes(&self, pos: usize) -> &'a [u8] {
        self.st[self.flat[pos].stream]
    }

    fn pos_of(&self, op: OpRef) -> Option<usize> {
        let stream = usize::try_from(op.stream).ok()?;
        let index = usize::try_from(op.index).ok()?;
        let l = self.lexed.get(stream)?;
        (index < l.toks.len()).then(|| self.first_of[stream] + index)
    }

    /// For every operator: how many positioning operators lie at or before it. Two show operators with the same count follow each other
    /// without a new text position between them.
    fn chains(&self) -> Vec<u32> {
        let mut n = 0u32;
        (0..self.flat.len())
            .map(|pos| {
                if is_positioning(&self.tok(pos).op) {
                    n += 1;
                }
                n
            })
            .collect()
    }

    /// `Tf`, `Tc`, `Tw` and `Tz` in force in front of the operator at `pos` (`q`/`Q` restore them).
    fn state_at(&self, pos: usize) -> TextState {
        let mut stack: Vec<TextState> = Vec::new();
        let mut cur = TextState::default();
        for p in 0..pos {
            let tok = self.tok(p);
            match tok.op.as_slice() {
                b"q" => {
                    if stack.len() < MAX_Q_DEPTH {
                        stack.push(cur.clone());
                    }
                }
                b"Q" => {
                    if let Some(s) = stack.pop() {
                        cur = s;
                    }
                }
                b"Tf" => {
                    if let Ok(ops) = operands(self.bytes(p), &tok.args) {
                        if let [Operand::Name(n), Operand::Num { value, range }] = ops.as_slice() {
                            cur.font_name = self.bytes(p)[n.clone()].to_vec();
                            cur.size_text =
                                String::from_utf8_lossy(&self.bytes(p)[range.clone()]).into_owned();
                            cur.size = *value;
                        }
                    }
                }
                b"Tc" | b"Tw" | b"Tz" => {
                    if let Ok(ops) = operands(self.bytes(p), &tok.args) {
                        if let [Operand::Num { value, .. }] = ops.as_slice() {
                            match tok.op.as_slice() {
                                b"Tc" => cur.tc = *value,
                                b"Tw" => cur.tw = *value,
                                _ => cur.tz = *value,
                            }
                        }
                    }
                }
                b"\"" => {
                    if let Ok(ops) = operands(self.bytes(p), &tok.args) {
                        if let [Operand::Num { value: aw, .. }, Operand::Num { value: ac, .. }, _] =
                            ops.as_slice()
                        {
                            cur.tw = *aw;
                            cur.tc = *ac;
                        }
                    }
                }
                _ => {}
            }
        }
        cur
    }
}

// --- one line edit -----------------------------------------------------------------------------------------------------

/// What [`edit_line`] needs to know of the line it edits (the walker's and the mapper's answer).
pub(crate) struct LineInput<'a> {
    /// The glyphs of the line, in the order of `text`.
    pub glyphs: Vec<&'a GlyphPos>,
    pub text: &'a str,
    pub font: &'a FontMap,
    /// The substitute face of the line's font.
    pub face: Face,
    pub align: Align,
    /// The line is an inner line of a justified paragraph.
    pub justified: bool,
    /// The right edge (along `dir`, page space) the line may grow to: the paragraph's, or the page's for a one-line paragraph.
    pub right_limit: Option<f64>,
}

/// The advance of a character of a substitute face in 1/1000 em, or `None` when the face lacks it.
pub(crate) type FallbackWidth<'a> = &'a dyn Fn(Face, char) -> Option<f32>;

/// What an edit did besides changing bytes.
#[derive(Debug, Default, Clone, PartialEq)]
pub(crate) struct Outcome {
    pub warnings: Vec<ChangeWarning>,
    /// The face and the characters written in it.
    pub fallback: Option<(Face, String)>,
}

fn width_of(font: &FontMap, code: u32) -> Option<f64> {
    match &font.widths {
        WidthSource::Widths { first_char, widths } => code
            .checked_sub(*first_char)
            .and_then(|i| widths.get(i as usize))
            .map(|w| f64::from(*w)),
        WidthSource::Cid { default, widths } => {
            Some(f64::from(widths.get(&code).copied().unwrap_or(*default)))
        }
        // The standard-14 metrics carry no name here: Helvetica's stand in (the Latin letters of the 14 differ little in the
        // geometry checks the width serves).
        WidthSource::Std14 => u8::try_from(code).ok().map(|c| {
            f64::from(crate::content::std14::width(
                crate::model::annotation::StdFont::Sans,
                c,
            ))
        }),
    }
}

fn char_ok(font: &FontMap, c: char) -> bool {
    font.to_code
        .get(&c)
        .is_some_and(|code| font.glyphs.codes.contains(code) && width_of(font, *code).is_some())
}

fn code_bytes(code: u32, width: usize) -> Vec<u8> {
    (0..width)
        .rev()
        .map(|i| ((code >> (8 * i)) & 0xFF) as u8)
        .collect()
}

fn code_value(bytes: &[u8]) -> u32 {
    bytes.iter().fold(0, |a, b| a << 8 | u32::from(*b))
}

/// One character of the line's text and the glyph that shows it (a separator the walker's text added has none).
struct Cell {
    c: char,
    glyph: Option<usize>,
}

/// Counts the word gaps of a text as its characters are fed in order: a run of whitespace between two words is one gap; leading and
/// trailing whitespace are none. `next` answers the number of gaps before the character.
#[derive(Default)]
struct GapCounter {
    runs: usize,
    seen_word: bool,
    pending: bool,
}

impl GapCounter {
    fn next(&mut self, c: char) -> usize {
        if c.is_whitespace() {
            if self.seen_word {
                self.pending = true;
            }
        } else {
            if self.pending {
                self.runs += 1;
                self.pending = false;
            }
            self.seen_word = true;
        }
        self.runs
    }
}

#[derive(Debug, Clone, Copy)]
enum Ins {
    /// The first deleted glyph: the new text takes its place.
    Replace(usize),
    After(usize),
    Before(usize),
}

struct Splice {
    stream: usize,
    range: Range<u32>,
    text: String,
}

const EPS: f64 = 0.05;
/// A stretched gap grows by at most this many space widths, and a line never needs to shrink its gaps below this share of one (ADR-130).
const STRETCH_MAX: f64 = 4.0;
const STRETCH_MIN: f64 = 0.5;

/// Edits one line: replaces the text of `input` by `new_text` in `streams` (the page's content streams, decoded), touching only the show
/// operators the change needs. `tooComplex` for anything the splice cannot do with certainty.
#[allow(clippy::too_many_lines, clippy::cognitive_complexity)]
pub(crate) fn edit_line(
    streams: &mut [Vec<u8>],
    input: &LineInput<'_>,
    new_text: &str,
    fit: TextFit,
    fallback_width: FallbackWidth<'_>,
) -> Result<Outcome, AppError> {
    let (splices, outcome) = plan_edit(streams, input, new_text, fit, fallback_width)?;
    let mut splices = splices;
    splices.sort_by(|a, b| {
        (b.stream, b.range.start, b.range.end).cmp(&(a.stream, a.range.start, a.range.end))
    });
    for s in &splices {
        let bytes = &mut streams[s.stream];
        let (a, b) = (s.range.start as usize, s.range.end as usize);
        if a > b || b > bytes.len() {
            return Err(refused());
        }
        bytes.splice(a..b, s.text.bytes());
    }
    Ok(outcome)
}

#[allow(clippy::too_many_lines, clippy::cognitive_complexity)]
fn plan_edit(
    streams: &[Vec<u8>],
    input: &LineInput<'_>,
    new_text: &str,
    fit: TextFit,
    fallback_width: FallbackWidth<'_>,
) -> Result<(Vec<Splice>, Outcome), AppError> {
    let view = View::new(streams).map_err(|_| refused())?;
    let glyphs = &input.glyphs;
    let font = input.font;
    if glyphs.is_empty() || matches!(font.kind, FontKind::Type3 | FontKind::Type0Other) {
        return Err(refused());
    }
    let width = if font.kind == FontKind::Type0IdentityH {
        2
    } else {
        1
    };

    // The show operators of the line, and the item each glyph is.
    let mut ops: BTreeMap<usize, OpData> = BTreeMap::new();
    let mut at: Vec<(usize, usize)> = Vec::with_capacity(glyphs.len()); // (op position, item index)
    for g in glyphs {
        let pos = view.pos_of(g.op).ok_or_else(refused)?;
        if !is_show(&view.tok(pos).op) || g.byte.len() != width {
            return Err(refused());
        }
        if let std::collections::btree_map::Entry::Vacant(v) = ops.entry(pos) {
            v.insert(parse_show(view.bytes(pos), view.tok(pos), width).map_err(|_| refused())?);
        }
        let data = &ops[&pos];
        let ord = g.byte.start as usize / width;
        let item = *data.glyph_items.get(ord).ok_or_else(refused)?;
        match &data.items[item] {
            Item::Glyph(code) if code_value(code) == g.code => at.push((pos, item)),
            _ => return Err(refused()),
        }
    }

    // The characters of the text against the glyphs.
    let known: HashSet<u32> = font.to_code.values().copied().collect();
    let mut cells: Vec<Cell> = Vec::new();
    let mut chars = input.text.chars().peekable();
    for (gi, g) in glyphs.iter().enumerate() {
        loop {
            let c = chars.next().ok_or_else(refused)?;
            if font.to_code.get(&c) == Some(&g.code) || !known.contains(&g.code) {
                cells.push(Cell { c, glyph: Some(gi) });
                break;
            }
            if c.is_whitespace() {
                cells.push(Cell { c, glyph: None });
                continue;
            }
            return Err(refused());
        }
    }
    for c in chars {
        if !c.is_whitespace() {
            return Err(refused());
        }
        cells.push(Cell { c, glyph: None });
    }

    // The diff in characters.
    let old: Vec<char> = cells.iter().map(|c| c.c).collect();
    let new: Vec<char> = new_text.chars().collect();
    if old == new {
        return Ok((Vec::new(), Outcome::default()));
    }
    let mut p = old.iter().zip(&new).take_while(|(a, b)| a == b).count();
    let room = old.len().min(new.len()) - p;
    let mut s = old
        .iter()
        .rev()
        .zip(new.iter().rev())
        .take(room)
        .take_while(|(a, b)| a == b)
        .count();
    let wants_fallback = new[p..new.len() - s].iter().any(|c| !char_ok(font, *c));
    if wants_fallback {
        // Only the changed words go to the substitute font: the word around every edited character (ADR-125 addendum 1).
        while p > 0 && !new[p - 1].is_whitespace() {
            p -= 1;
        }
        let mut end = new.len() - s;
        while end < new.len() && !new[end].is_whitespace() {
            end += 1;
        }
        s = new.len() - end;
    }
    let region: String = new[p..new.len() - s].iter().collect();
    let (a, b) = (p, old.len() - s);
    let deleted: Vec<usize> = cells[a..b].iter().filter_map(|c| c.glyph).collect();
    let ins = if let Some(first) = deleted.first() {
        Ins::Replace(*first)
    } else if region.is_empty() {
        return Ok((Vec::new(), Outcome::default()));
    } else if let Some(g) = cells[..a].iter().rev().find_map(|c| c.glyph) {
        Ins::After(g)
    } else if let Some(g) = cells[b..].iter().find_map(|c| c.glyph) {
        Ins::Before(g)
    } else {
        return Err(refused());
    };
    let anchor = match ins {
        Ins::Replace(g) | Ins::After(g) | Ins::Before(g) => g,
    };
    let (first_pos, anchor_item) = at[anchor];

    // The new text as items, and its advance.
    let state = view.state_at(first_pos);
    if state.size <= 0.0 || !state.size.is_finite() {
        return Err(refused());
    }
    let anchor_glyph = glyphs[anchor];
    let dir = anchor_glyph.dir;
    let mscale = anchor_glyph.size_eff / state.size;
    let tz = state.tz / 100.0;
    let adv_of = |w: f64, space: bool| {
        ((w / 1000.0 * state.size) + state.tc + if space { state.tw } else { 0.0 }) * tz * mscale
    };
    let mut new_items: Vec<Item> = Vec::new();
    let mut new_adv = 0.0;
    let mut new_advs: Vec<f64> = Vec::new(); // per character of the region (empty for a substitute-font run)
    let mut fallback = None;
    if wants_fallback && !region.is_empty() {
        let mut codes = Vec::with_capacity(region.len() * 2);
        for c in region.chars() {
            let cid = u16::try_from(u32::from(c)).map_err(|_| refused())?;
            let w = fallback_width(input.face, c).ok_or_else(refused)?;
            new_adv += adv_of(f64::from(w), false);
            codes.extend_from_slice(&cid.to_be_bytes());
        }
        new_items.push(Item::Fallback {
            name: resource_name(input.face),
            codes,
        });
        fallback = Some((input.face, region.clone()));
    } else {
        for c in region.chars() {
            let code = *font.to_code.get(&c).ok_or_else(refused)?;
            let w = width_of(font, code).ok_or_else(refused)?;
            let adv = adv_of(w, width == 1 && code == 32);
            new_advs.push(adv);
            new_adv += adv;
            new_items.push(Item::Glyph(code_bytes(code, width)));
        }
    }

    // Chains: show operators that follow each other without a new text position.
    let chain = view.chains();
    let chain_a = chain[first_pos];
    let in_a = |gi: usize| chain[at[gi].0] == chain_a;
    let cross = deleted.iter().any(|g| !in_a(*g));
    let old_adv_a: f64 = deleted
        .iter()
        .filter(|g| in_a(**g))
        .map(|g| glyphs[*g].adv)
        .sum();
    let mut delta = new_adv - old_adv_a;
    let proj = |v: [f64; 2]| v[0] * dir[0] + v[1] * dir[1];
    let end_of = |gi: usize| proj(glyphs[gi].origin) + glyphs[gi].adv;
    let del_set: HashSet<usize> = deleted.iter().copied().collect();
    let after_anchor = |gi: usize| {
        let key = at[gi];
        let a = (first_pos, anchor_item);
        if matches!(ins, Ins::Before(_)) {
            key >= a
        } else {
            key > a
        }
    };
    let shifting: Vec<usize> = (0..glyphs.len())
        .filter(|gi| !del_set.contains(gi) && in_a(*gi) && after_anchor(*gi))
        .collect();
    let region_end_old = match ins {
        Ins::Replace(_) => deleted
            .iter()
            .filter(|g| in_a(**g))
            .map(|g| end_of(*g))
            .fold(f64::MIN, f64::max),
        Ins::After(g) => end_of(g),
        Ins::Before(g) => proj(glyphs[g].origin),
    };
    let chain_end_old = shifting
        .iter()
        .map(|g| end_of(*g))
        .fold(region_end_old, f64::max);
    let line_right_old = (0..glyphs.len()).map(end_of).fold(f64::MIN, f64::max);
    let anchored_start = (0..glyphs.len())
        .filter(|gi| {
            !del_set.contains(gi)
                && !shifting.contains(gi)
                && proj(glyphs[*gi].origin) >= region_end_old - EPS
        })
        .map(|gi| proj(glyphs[gi].origin))
        .fold(f64::MAX, f64::min);
    let unit_anchor = anchor_glyph.size_eff * tz; // page units of one em (a TJ number of 1000)

    let mut warnings = Vec::new();
    let mut extra_prefix: HashMap<usize, String> = HashMap::new();
    let mut extra_suffix: HashMap<usize, String> = HashMap::new();
    let mut leading_shift = 0.0;
    let mut shift_at: Vec<(usize, f64)> = Vec::new(); // (operator, page units of one em there)
    let mut spread = 0.0;
    // The stretch of a justified line: the page units each word gap gets, the gaps before each kept glyph and before each new item.
    let mut edge: Option<f64> = None;
    let mut kept_gb: HashMap<usize, usize> = HashMap::new();
    let mut new_gb: Vec<Option<usize>> = vec![None; new_items.len()];

    let aligned = matches!(input.align, Align::Right | Align::Center);
    // A justified line is stretched back to the paragraph's right edge over all its word gaps (ADR-130), whatever its chains.
    let stretch_possible =
        input.justified && !aligned && fit != TextFit::Squeeze && input.right_limit.is_some();
    // A glyph of a later chain that stays cannot follow the shift of an aligned line.
    let stranded =
        (0..glyphs.len()).any(|g| !in_a(g) && !del_set.contains(&g) && at[g].0 > first_pos);
    if cross
        && (fit == TextFit::Squeeze
            || (aligned && stranded)
            || (input.justified && !stretch_possible))
    {
        return Err(refused());
    }
    if cross && aligned {
        // The replaced word spreads over several chains (a font without the new characters, one glyph per operator): the whole
        // replaced stretch counts, measured on the page.
        let first_start = deleted
            .iter()
            .map(|g| proj(glyphs[*g].origin))
            .fold(f64::MAX, f64::min);
        let last_end = deleted.iter().map(|g| end_of(*g)).fold(f64::MIN, f64::max);
        delta = new_adv - (last_end - first_start);
    }

    // `squeeze`: Tz down to 85 % around the line.
    if fit == TextFit::Squeeze && delta > EPS && !cross {
        let line_ops: Vec<usize> = ops.keys().copied().collect();
        let (lo, hi) = (line_ops[0], line_ops[line_ops.len() - 1]);
        let balanced = (lo..=hi).all(|p| !matches!(view.tok(p).op.as_slice(), b"q" | b"Q"));
        if balanced {
            let total_old: f64 = glyphs.iter().map(|g| g.adv).sum();
            let total_new = total_old + delta;
            let r = (total_old / total_new).max(0.85);
            if r < 1.0 {
                extra_prefix.insert(lo, format!("{} Tz ", fmt_num(state.tz * r)));
                extra_suffix.insert(hi, format!(" {} Tz", fmt_num(state.tz)));
                delta = total_new * r - total_old;
            }
        }
    }

    // The line keeps its anchor when it is right-aligned or centred.
    if matches!(input.align, Align::Right | Align::Center) && delta.abs() > EPS {
        // Chains before the anchor's (a trailing space shown on its own, say) move with it; one after it cannot follow.
        if stranded {
            return Err(refused());
        }
        // The first show operator of every chain of the line gets the shift, in the units of its own first glyph.
        let mut firsts: BTreeMap<u32, usize> = BTreeMap::new();
        for g in (0..glyphs.len()).filter(|g| at[*g].0 <= first_pos) {
            let entry = firsts.entry(chain[at[g].0]).or_insert(g);
            if at[g] < at[*entry] {
                *entry = g;
            }
        }
        for g in firsts.into_values() {
            let pos = at[g].0;
            let unit = glyphs[g].size_eff * view.state_at(pos).tz / 100.0;
            if unit <= 0.0 || !unit.is_finite() {
                return Err(refused());
            }
            shift_at.push((pos, unit));
        }
        leading_shift = if input.align == Align::Right {
            -delta
        } else {
            -delta / 2.0
        };
        delta = 0.0;
    } else if stretch_possible {
        if let Some(limit) = input.right_limit {
            let mut gc = GapCounter::default();
            let mut l_nat = f64::MIN;
            let shifting_set: HashSet<usize> = shifting.iter().copied().collect();
            let mut visit = |cell: &Cell, g: usize| {
                if let Some(gi) = cell.glyph {
                    kept_gb.insert(gi, g);
                    if !cell.c.is_whitespace() {
                        let shift = if shifting_set.contains(&gi) {
                            delta
                        } else {
                            0.0
                        };
                        l_nat = l_nat.max(end_of(gi) + shift);
                    }
                }
            };
            for cell in &cells[..a] {
                let g = gc.next(cell.c);
                visit(cell, g);
            }
            let mut region_gap = false;
            let mut region_gb: Vec<Option<usize>> = Vec::new();
            if fallback.is_some() {
                let mut first = None;
                for c in region.chars() {
                    let g = gc.next(c);
                    first.get_or_insert(g);
                    region_gap |= c.is_whitespace();
                }
                region_gb.push(first);
            } else {
                region_gb.extend(region.chars().map(|c| Some(gc.next(c))));
            }
            for cell in &cells[b..] {
                let g = gc.next(cell.c);
                visit(cell, g);
            }
            let tail_only = cells[b..].iter().all(|c| c.c.is_whitespace());
            let region_start = match ins {
                Ins::Replace(g) | Ins::Before(g) => proj(glyphs[g].origin),
                Ins::After(g) => end_of(g),
            };
            if region.chars().any(|c| !c.is_whitespace()) {
                let trailing: f64 = if tail_only {
                    new_advs
                        .iter()
                        .rev()
                        .zip(region.chars().rev())
                        .take_while(|(_, c)| c.is_whitespace())
                        .map(|(w, _)| *w)
                        .sum()
                } else {
                    0.0
                };
                l_nat = l_nat.max(region_start + new_adv - trailing);
            }
            if gc.runs > 0
                && !region_gap
                && l_nat > f64::MIN / 2.0
                && unit_anchor > 0.0
                && unit_anchor.is_finite()
            {
                let per_gap = (limit - l_nat) / gc.runs as f64;
                let per_em = per_gap * 1000.0 / unit_anchor;
                let space_w = font
                    .to_code
                    .get(&' ')
                    .and_then(|c| width_of(font, *c))
                    .filter(|w| *w > 0.0)
                    .unwrap_or(250.0);
                if per_em <= STRETCH_MAX * space_w && per_em >= -STRETCH_MIN * space_w {
                    edge = Some(per_gap);
                    new_gb = region_gb;
                    delta = 0.0;
                }
            }
        }
        if edge.is_none() {
            kept_gb.clear();
        }
    } else if input.justified && delta.abs() > EPS {
        spread = delta;
        delta = 0.0;
    }

    // The items of the operators the edit changes.
    let mut work: BTreeMap<usize, Vec<Item>> = BTreeMap::new();
    let mut work_gb: BTreeMap<usize, Vec<Option<usize>>> = BTreeMap::new();
    let mut touched: BTreeSet<usize> = BTreeSet::new();
    let glyph_at: HashMap<(usize, usize), usize> =
        at.iter().enumerate().map(|(gi, k)| (*k, gi)).collect();
    let deleted_items: HashSet<(usize, usize)> = deleted.iter().map(|g| at[*g]).collect();
    let later_in_chain = |pos: usize| {
        (pos + 1..view.flat.len())
            .take_while(|p| chain[*p] == chain[pos])
            .any(|p| is_show(&view.tok(p).op))
    };
    for (pos, data) in &ops {
        let mut out: Vec<Item> = Vec::with_capacity(data.items.len() + 2);
        let mut ogb: Vec<Option<usize>> = Vec::with_capacity(data.items.len() + 2);
        let mut pending = 0.0;
        let mut pending_unit = unit_anchor;
        let in_chain_a = chain[*pos] == chain_a;
        let gone = |idx: usize| deleted_items.contains(&(*pos, idx));
        let nearest_glyph = |from: usize, forward: bool| -> Option<usize> {
            if forward {
                (from + 1..data.items.len()).find(|i| matches!(data.items[*i], Item::Glyph(_)))
            } else {
                (0..from)
                    .rev()
                    .find(|i| matches!(data.items[*i], Item::Glyph(_)))
            }
        };
        for (idx, item) in data.items.iter().enumerate() {
            match item {
                Item::Glyph(_) if gone(idx) => {
                    touched.insert(*pos);
                    if matches!(ins, Ins::Replace(_)) && (*pos, idx) == (first_pos, anchor_item) {
                        out.extend(new_items.iter().cloned());
                        ogb.extend(new_gb.iter().copied());
                    }
                    if !in_chain_a {
                        if let Some(gi) = glyph_at.get(&(*pos, idx)) {
                            pending += glyphs[*gi].adv;
                            pending_unit = glyphs[*gi].size_eff * view.state_at(*pos).tz / 100.0;
                        }
                    }
                    continue;
                }
                Item::Kern { .. } => {
                    let prev = nearest_glyph(idx, false).is_some_and(gone);
                    let next = nearest_glyph(idx, true).is_some_and(gone);
                    if prev && next {
                        touched.insert(*pos);
                        continue;
                    }
                }
                _ => {}
            }
            if pending > 0.0 {
                out.push(Item::kern(-pending * 1000.0 / pending_unit));
                ogb.push(None);
                pending = 0.0;
            }
            if matches!(ins, Ins::Before(_)) && (*pos, idx) == (first_pos, anchor_item) {
                touched.insert(*pos);
                out.extend(new_items.iter().cloned());
                ogb.extend(new_gb.iter().copied());
            }
            out.push(item.clone());
            ogb.push(match item {
                Item::Glyph(_) => glyph_at
                    .get(&(*pos, idx))
                    .and_then(|gi| kept_gb.get(gi))
                    .copied(),
                _ => None,
            });
            if matches!(ins, Ins::After(_)) && (*pos, idx) == (first_pos, anchor_item) {
                touched.insert(*pos);
                out.extend(new_items.iter().cloned());
                ogb.extend(new_gb.iter().copied());
            }
        }
        if pending > 0.0 && later_in_chain(*pos) {
            out.push(Item::kern(-pending * 1000.0 / pending_unit));
            ogb.push(None);
        }
        work.insert(*pos, out);
        work_gb.insert(*pos, ogb);
    }

    // A stretched line: every word gap grows by the same amount; each chain gets the growth before its first glyph as a leading kern.
    if let Some(per_gap) = edge {
        let mut prev: Option<(u32, usize)> = None;
        let mut last_gap = 0usize;
        let mut inserts: Vec<(usize, usize, f64)> = Vec::new();
        for (pos, gbs) in &work_gb {
            for (idx, g) in gbs.iter().enumerate() {
                let Some(g) = *g else { continue };
                // Gap indices must grow in stream order: a line drawn out of reading order cannot be stretched by kerns.
                if g < last_gap {
                    return Err(refused());
                }
                last_gap = g;
                let gaps = match prev {
                    Some((c, before)) if c == chain[*pos] => g.saturating_sub(before),
                    _ => g,
                };
                prev = Some((chain[*pos], g));
                if gaps > 0 && per_gap.abs() > 1e-6 {
                    inserts.push((*pos, idx, gaps as f64 * per_gap));
                }
            }
        }
        let mut units: HashMap<usize, f64> = HashMap::new();
        for (gi, (pos, _)) in at.iter().enumerate() {
            if let std::collections::hash_map::Entry::Vacant(v) = units.entry(*pos) {
                v.insert(glyphs[gi].size_eff * view.state_at(*pos).tz / 100.0);
            }
        }
        for (pos, idx, grow) in inserts.into_iter().rev() {
            let unit = units.get(&pos).copied().unwrap_or(0.0);
            if unit <= 0.0 || !unit.is_finite() {
                return Err(refused());
            }
            touched.insert(pos);
            let items = work.get_mut(&pos).ok_or_else(refused)?;
            let value = -grow * 1000.0 / unit;
            let merge = idx.checked_sub(1).and_then(|k| match items.get(k) {
                Some(Item::Kern { value: old, .. }) => Some((k, *old)),
                _ => None,
            });
            match merge {
                Some((k, old)) => items[k] = Item::kern(old + value),
                None => items.insert(idx, Item::kern(value)),
            }
        }
    }

    // A justified line without a limit spreads the change over its word gaps (squeeze); an aligned line moves its start.
    if spread.abs() > EPS {
        let mut gaps: Vec<(usize, usize)> = Vec::new();
        let mut last_glyph: Option<(usize, usize)> = None;
        for (pos, items) in &work {
            if chain[*pos] != chain_a {
                continue;
            }
            for (idx, item) in items.iter().enumerate() {
                match item {
                    Item::Glyph(code) => {
                        last_glyph = Some((*pos, idx));
                        let space = match font.space_code {
                            Some(sc) => code_value(code) == sc && code.len() == width,
                            None => width == 1 && code == &[32],
                        };
                        if space {
                            gaps.push((*pos, idx));
                        }
                    }
                    // A space glyph with a kern behind it is one gap.
                    Item::Kern { value, .. }
                        if *value <= -150.0
                            && gaps.last() != Some(&(*pos, idx.wrapping_sub(1))) =>
                    {
                        gaps.push((*pos, idx));
                    }
                    _ => {}
                }
            }
        }
        gaps.retain(|g| last_glyph.is_some_and(|l| *g < l));
        if !gaps.is_empty() {
            let per_gap = spread * 1000.0 / unit_anchor / gaps.len() as f64;
            for (pos, idx) in gaps.into_iter().rev() {
                touched.insert(pos);
                if let Some(items) = work.get_mut(&pos) {
                    let kern_at = match items[idx] {
                        Item::Kern { .. } => Some(idx),
                        _ => {
                            matches!(items.get(idx + 1), Some(Item::Kern { .. })).then_some(idx + 1)
                        }
                    };
                    match kern_at {
                        Some(k) => {
                            if let Item::Kern { value, .. } = items[k] {
                                items[k] = Item::kern(value + per_gap);
                            }
                        }
                        None => items.insert(idx + 1, Item::kern(per_gap)),
                    }
                }
            }
        } else {
            delta = spread;
        }
    }
    if leading_shift.abs() > EPS {
        for (pos, unit) in &shift_at {
            touched.insert(*pos);
            let items = work.get_mut(pos).ok_or_else(refused)?;
            items.insert(0, Item::kern(-leading_shift * 1000.0 / unit));
        }
    }

    // Does the new line fit?
    if delta > EPS {
        let beyond_next = anchored_start < f64::MAX && chain_end_old + delta > anchored_start + EPS;
        let beyond_edge = input.right_limit.is_some_and(|limit| {
            chain_end_old >= line_right_old - EPS && chain_end_old + delta > limit + EPS
        });
        if beyond_next || beyond_edge {
            warnings.push(ChangeWarning::TextOverflow);
        }
    }
    if fallback.is_some() {
        warnings.push(ChangeWarning::FontFallback);
    }

    // The byte ranges.
    let mut splices = Vec::new();
    let mut folded: HashSet<usize> = HashSet::new();
    for pos in &touched {
        let data = ops.get(pos).ok_or_else(refused)?;
        let items = work.remove(pos).ok_or_else(refused)?;
        let rewritten = OpData {
            kind: data.kind,
            items,
            glyph_items: Vec::new(),
            prelude: data.prelude.clone(),
        };
        let mut text = render(&rewritten, &view.state_at(first_pos));
        if let Some(prefix) = extra_prefix.get(pos) {
            text.insert_str(0, prefix);
            folded.insert(*pos);
        }
        if let Some(suffix) = extra_suffix.get(pos) {
            text.push_str(suffix);
            folded.insert(*pos);
        }
        splices.push(Splice {
            stream: view.flat[*pos].stream,
            range: view.tok(*pos).args.start..view.end(*pos),
            text,
        });
    }
    for (pos, prefix) in &extra_prefix {
        if !folded.contains(pos) || !touched.contains(pos) {
            splices.push(Splice {
                stream: view.flat[*pos].stream,
                range: view.tok(*pos).args.start..view.tok(*pos).args.start,
                text: prefix.clone(),
            });
        }
    }
    for (pos, suffix) in &extra_suffix {
        if !touched.contains(pos) {
            splices.push(Splice {
                stream: view.flat[*pos].stream,
                range: view.end(*pos)..view.end(*pos),
                text: suffix.clone(),
            });
        }
    }
    Ok((splices, Outcome { warnings, fallback }))
}

// --- replay ------------------------------------------------------------------------------------------------------------

/// The line an edit names, as the walker, the line builder and the font reader see it in the state after the edits before.
pub(crate) struct OwnedLine {
    pub glyphs: Vec<GlyphPos>,
    pub text: String,
    pub font: FontMap,
    pub face: Face,
    pub align: Align,
    pub justified: bool,
    pub right_limit: Option<f64>,
}

/// Resolves a [`LineKey`] against the content streams as they are after the edits before it.
pub(crate) trait LineSource {
    /// `streams` are the content streams now; `fallback` the faces and characters the edits so far wrote in substitute fonts.
    fn line(
        &mut self,
        streams: &[Vec<u8>],
        fallback: &[(Face, BTreeSet<char>)],
        key: LineKey,
    ) -> Result<OwnedLine, AppError>;

    /// The geometry of the paragraph that holds line `key.line` (for the re-break of a paragraph edit, [`text_reflow`]).
    fn paragraph(
        &mut self,
        _streams: &[Vec<u8>],
        _fallback: &[(Face, BTreeSet<char>)],
        _key: LineKey,
    ) -> Result<text_reflow::ParaGeom, AppError> {
        Err(refused())
    }
}

/// The result of a replay over decoded streams.
pub(crate) struct Replayed {
    pub streams: Vec<Vec<u8>>,
    pub warnings: Vec<ChangeWarning>,
    pub fallback: Vec<(Face, BTreeSet<char>)>,
}

/// Replays `edits` over `streams`: the key of each edit is resolved after the edits before it, so the result depends on the list and
/// nothing else (undo is a replay of one edit less).
pub(crate) fn replay_core(
    mut streams: Vec<Vec<u8>>,
    edits: &[TextEdit],
    source: &mut dyn LineSource,
    fallback_width: FallbackWidth<'_>,
    deadline: Option<Instant>,
) -> Result<Replayed, AppError> {
    if edits.len() > limits::TEXT_EDITS_PER_PAGE {
        return Err(AppError::limit(
            "textEdit",
            limits::TEXT_EDITS_PER_PAGE as u64,
        ));
    }
    let mut warnings: Vec<ChangeWarning> = Vec::new();
    let mut fallback: Vec<(Face, BTreeSet<char>)> = Vec::new();
    for (k, edit) in edits.iter().enumerate() {
        if deadline.is_some_and(|d| Instant::now() > d) {
            return Err(AppError::limit(
                "textEdit",
                limits::TEXT_EDIT_REPLAY_TIMEOUT.as_secs(),
            ));
        }
        if usize::try_from(edit.key.rev) != Ok(k) {
            return Err(AppError::invalid("lineKey"));
        }
        if edit.scope == TextScope::Paragraph {
            text_reflow::reflow(
                &mut streams,
                edit,
                source,
                &mut fallback,
                &mut warnings,
                fallback_width,
            )?;
            continue;
        }
        let line = source.line(&streams, &fallback, edit.key)?;
        let input = LineInput {
            glyphs: line.glyphs.iter().collect(),
            text: &line.text,
            font: &line.font,
            face: line.face,
            align: line.align,
            justified: line.justified,
            right_limit: line.right_limit,
        };
        let outcome = edit_line(&mut streams, &input, &edit.text, edit.fit, fallback_width)?;
        for w in outcome.warnings {
            if !warnings.contains(&w) {
                warnings.push(w);
            }
        }
        if let Some((face, chars)) = outcome.fallback {
            match fallback.iter_mut().find(|(f, _)| *f == face) {
                Some((_, set)) => set.extend(chars.chars()),
                None => fallback.push((face, chars.chars().collect())),
            }
        }
    }
    Ok(Replayed {
        streams,
        warnings,
        fallback,
    })
}

/// The characters a rewritten page draws in its substitute fonts, per face, read back from its content (the codes of a substitute font
/// are UTF-16 code units, so the stream says which characters the font program has to hold).
pub(crate) fn fallback_chars(r: &Rewritten) -> Result<Vec<(Face, BTreeSet<char>)>, AppError> {
    let lexed = lex_full(&r.content).map_err(|_| refused())?;
    let names: Vec<(Vec<u8>, Face)> = r
        .fonts
        .iter()
        .map(|f| (format!("/{}", f.name).into_bytes(), f.face))
        .collect();
    let mut out: Vec<(Face, BTreeSet<char>)> = Vec::new();
    let mut current: Option<Face> = None;
    for tok in &lexed.toks {
        match tok.op.as_slice() {
            b"Tf" => {
                let ops = operands(&r.content, &tok.args).map_err(|_| refused())?;
                current = match ops.first() {
                    Some(Operand::Name(n)) => names
                        .iter()
                        .find(|(name, _)| name.as_slice() == &r.content[n.clone()])
                        .map(|(_, f)| *f),
                    _ => None,
                };
            }
            op if is_show(op) => {
                let Some(face) = current else { continue };
                let ops = operands(&r.content, &tok.args).map_err(|_| refused())?;
                let mut strings: Vec<&Vec<u8>> = Vec::new();
                for o in &ops {
                    match o {
                        Operand::Str(s) => strings.push(s),
                        Operand::Array(items) => {
                            for i in items {
                                if let Operand::Str(s) = i {
                                    strings.push(s);
                                }
                            }
                        }
                        _ => {}
                    }
                }
                let mut set = BTreeSet::new();
                for s in strings {
                    if s.len() % 2 != 0 {
                        return Err(refused());
                    }
                    for pair in s.chunks(2) {
                        let unit = u32::from(pair[0]) << 8 | u32::from(pair[1]);
                        set.insert(char::from_u32(unit).ok_or_else(refused)?);
                    }
                }
                match out.iter_mut().find(|(f, _)| *f == face) {
                    Some((_, chars)) => chars.extend(set),
                    None => out.push((face, set)),
                }
            }
            _ => {}
        }
    }
    Ok(out)
}

// --- the production line source ----------------------------------------------------------------------------------------

fn resolve<'a>(doc: &'a Document, object: &'a Object) -> Option<&'a Object> {
    doc.dereference(object).ok().map(|(_, o)| o)
}

/// The `/Contents` streams of `page` in order.
pub(super) fn content_stream_ids(doc: &Document, page: ObjectId) -> Vec<ObjectId> {
    let Ok(dict) = doc.get_dictionary(page) else {
        return Vec::new();
    };
    let items: Vec<Object> = match dict.get(b"Contents") {
        Ok(Object::Reference(id)) => match doc.get_object(*id) {
            Ok(Object::Array(items)) => items.clone(),
            _ => vec![Object::Reference(*id)],
        },
        Ok(Object::Array(items)) => items.clone(),
        _ => Vec::new(),
    };
    items
        .iter()
        .take(limits::TEXT_EDIT_LINES_PER_PAGE * 20)
        .filter_map(|o| match o {
            Object::Reference(id) if matches!(doc.get_object(*id), Ok(Object::Stream(_))) => {
                Some(*id)
            }
            _ => None,
        })
        .collect()
}

fn decode_streams(doc: &Document, ids: &[ObjectId]) -> Result<Vec<Vec<u8>>, AppError> {
    let mut left = limits::MAX_REDACT_CONTENT_BYTES;
    let mut out = Vec::with_capacity(ids.len());
    for id in ids {
        let Ok(Object::Stream(stream)) = doc.get_object(*id) else {
            return Err(refused());
        };
        let bytes = stream
            .decompressed_content_with_limit(left)
            .map_err(|_| refused())?;
        left = left.saturating_sub(bytes.len());
        out.push(bytes);
    }
    Ok(out)
}

/// The font descriptor flags, weight and base font name of a font object (through `/DescendantFonts` for a composite font).
fn face_of(doc: &Document, font: ObjectId) -> Face {
    let dict = doc.get_dictionary(font).ok();
    let name = dict
        .and_then(|d| d.get(b"BaseFont").ok())
        .and_then(|o| o.as_name().ok())
        .map(|n| String::from_utf8_lossy(n).into_owned())
        .unwrap_or_default();
    let descendant = dict
        .and_then(|d| d.get(b"DescendantFonts").ok())
        .and_then(|o| resolve(doc, o))
        .and_then(|o| o.as_array().ok())
        .and_then(|a| a.first())
        .and_then(|o| resolve(doc, o))
        .and_then(|o| o.as_dict().ok());
    let descriptor = descendant
        .or(dict)
        .and_then(|d| d.get(b"FontDescriptor").ok())
        .and_then(|o| resolve(doc, o))
        .and_then(|o| o.as_dict().ok());
    let flags = descriptor
        .and_then(|d| d.get(b"Flags").ok())
        .and_then(|o| o.as_i64().ok())
        .and_then(|v| u32::try_from(v).ok())
        .unwrap_or(0);
    let weight = descriptor
        .and_then(|d| d.get(b"FontWeight").ok())
        .and_then(|o| o.as_i64().ok())
        .and_then(|v| u32::try_from(v).ok())
        .unwrap_or(400);
    pick(flags, weight, &name)
}

fn media_right(doc: &Document, page: ObjectId) -> Option<f64> {
    let mut id = page;
    for _ in 0..limits::MAX_PARENT_CHAIN {
        let dict = doc.get_dictionary(id).ok()?;
        if let Ok(obj) = dict.get(b"MediaBox") {
            let arr = resolve(doc, obj)?.as_array().ok()?;
            let n = |i: usize| {
                arr.get(i)
                    .and_then(|o| resolve(doc, o))
                    .and_then(|o| o.as_float().ok())
            };
            let (x0, x1) = (n(0)?, n(2)?);
            return Some(f64::from(x0.max(x1)));
        }
        id = dict.get(b"Parent").ok()?.as_reference().ok()?;
    }
    None
}

/// Replaces the placeholder characters of `text` by the characters of the glyph at the same index; a text with another count than
/// the glyphs (a space was inserted between far-apart glyphs) is left as it is.
fn remap_placeholders(text: &str, codes: &[u32], inverse: &HashMap<u32, char>) -> String {
    if text.chars().count() != codes.len() {
        return text.to_owned();
    }
    text.chars()
        .zip(codes)
        .map(|(c, code)| {
            if c == '\u{fffd}' {
                inverse.get(code).copied().unwrap_or(c)
            } else {
                c
            }
        })
        .collect()
}

/// The production [`LineSource`]: the original document with the edits so far written into a working copy, so `text_lines` sees them.
struct DocLines<'a> {
    src: &'a Document,
    page: ObjectId,
    ids: Vec<ObjectId>,
    work: Option<Document>,
    store: &'a FallbackStore,
    /// The page's lines for the state `key` fingerprints (the streams and the substitute characters): reading several lines of one
    /// state scans the page once.
    cache: Option<(u64, PageLines)>,
}

impl DocLines<'_> {
    /// Brings the working copy and the line cache to the state of `streams`.
    fn refresh(
        &mut self,
        streams: &[Vec<u8>],
        fallback: &[(Face, BTreeSet<char>)],
        rev: u32,
    ) -> Result<(), AppError> {
        use std::hash::{Hash, Hasher};
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        (rev > 0).hash(&mut hasher);
        streams.hash(&mut hasher);
        format!("{fallback:?}").hash(&mut hasher);
        let key = hasher.finish();
        if self.cache.as_ref().is_some_and(|(k, _)| *k == key) {
            return Ok(());
        }
        self.sync(streams, fallback, rev)?;
        let doc: &Document = self.work.as_ref().unwrap_or(self.src);
        let lines = text_lines::lines(doc, self.page, &[])?;
        self.cache = Some((key, lines));
        Ok(())
    }

    /// Writes the streams of the edits so far into the working copy (`rev` 0 is the original, nothing to write).
    fn sync(
        &mut self,
        streams: &[Vec<u8>],
        fallback: &[(Face, BTreeSet<char>)],
        rev: u32,
    ) -> Result<(), AppError> {
        if rev > 0 {
            let mut work = self.work.take().unwrap_or_else(|| self.src.clone());
            for (id, bytes) in self.ids.iter().zip(streams) {
                if let Some(Object::Stream(stream)) = work.objects.get_mut(id) {
                    stream.dict.remove(b"Filter");
                    stream.dict.remove(b"DecodeParms");
                    stream.set_content(bytes.clone());
                }
            }
            if !fallback.is_empty() {
                super::text_save::install_fonts(&mut work, self.page, fallback, self.store)?;
            }
            self.work = Some(work);
        }
        Ok(())
    }
}

impl LineSource for DocLines<'_> {
    fn paragraph(
        &mut self,
        streams: &[Vec<u8>],
        fallback: &[(Face, BTreeSet<char>)],
        key: LineKey,
    ) -> Result<text_reflow::ParaGeom, AppError> {
        self.refresh(streams, fallback, key.rev)?;
        let doc: &Document = self.work.as_ref().unwrap_or(self.src);
        let (_, lines) = self.cache.as_ref().ok_or_else(refused)?;
        text_reflow::geometry(doc, self.page, lines, key.line)
    }

    fn line(
        &mut self,
        streams: &[Vec<u8>],
        fallback: &[(Face, BTreeSet<char>)],
        key: LineKey,
    ) -> Result<OwnedLine, AppError> {
        self.refresh(streams, fallback, key.rev)?;
        let doc: &Document = self.work.as_ref().unwrap_or(self.src);
        let (_, lines) = self.cache.as_ref().ok_or_else(refused)?;
        let index = usize::try_from(key.line).map_err(|_| AppError::invalid("lineKey"))?;
        let line = lines.lines.get(index).ok_or(AppError::invalid("lineKey"))?;
        if let LineEditable::No { reason } = line.editable {
            return Err(reason.error());
        }
        let font_key = line.runs.first().map(|r| &r.font).ok_or_else(refused)?;
        if line.runs.iter().any(|r| &r.font != font_key || r.in_form) {
            return Err(refused());
        }
        let object = font_key.object.ok_or_else(refused)?;
        let font = font_map(doc, object, &HashMap::new())?;
        let face = face_of(doc, object);
        let paragraph = lines
            .paragraphs
            .iter()
            .find(|p| p.lines.contains(&key.line));
        let justified = paragraph.is_some_and(|p| p.justified && key.line + 1 < p.lines.end);
        let align = paragraph.map_or(Align::Left, |p| p.align);
        let dir = line.dir;
        let right_limit = if dir[1].abs() < 0.01 && dir[0] > 0.0 {
            match paragraph {
                Some(p) if p.lines.len() > 1 => {
                    let ends: Vec<f64> = lines.lines[p.lines.start as usize..p.lines.end as usize]
                        .iter()
                        .map(|l| f64::from(l.bounds.x + l.bounds.w))
                        .collect();
                    if p.justified {
                        // The edge most inner lines share, not the one a stretched line overshoots to.
                        text_reflow::typical_edge(&ends[..ends.len() - 1])
                    } else {
                        ends.iter().copied().reduce(f64::max)
                    }
                }
                _ => media_right(doc, self.page),
            }
        } else {
            None
        };
        let glyphs: Vec<_> = line.runs.iter().flat_map(|r| r.glyphs.clone()).collect();
        // Without PDFium's characters the text of a two-byte font is a placeholder per glyph: the font's own map says the characters.
        let mut text = line.text.clone();
        if text.contains('\u{fffd}') {
            let mut inverse: HashMap<u32, char> = HashMap::new();
            for (c, code) in &font.to_code {
                let slot = inverse.entry(*code).or_insert(*c);
                *slot = (*slot).min(*c);
            }
            let codes: Vec<u32> = glyphs.iter().map(|g| g.code).collect();
            text = remap_placeholders(&text, &codes, &inverse);
        }
        Ok(OwnedLine {
            glyphs,
            text,
            font,
            face,
            align,
            justified,
            right_limit,
        })
    }
}

/// Replays `edits` (each key resolved against the state after the edits before it) over the original content of `page`. The substitute
/// glyphs of `fonts` are the ones the whole save needs.
pub fn replay(
    src: &Document,
    page: ObjectId,
    edits: &[TextEdit],
    fonts: &FallbackStore,
) -> Result<Rewritten, AppError> {
    let ids = content_stream_ids(src, page);
    if ids.is_empty() {
        return Err(refused());
    }
    let streams = decode_streams(src, &ids)?;
    let replayed = if edits.is_empty() {
        Replayed {
            streams,
            warnings: Vec::new(),
            fallback: Vec::new(),
        }
    } else {
        let mut source = DocLines {
            src,
            page,
            ids,
            work: None,
            store: fonts,
            cache: None,
        };
        let width = |face: Face, c: char| face.advance(c);
        replay_core(
            streams,
            edits,
            &mut source,
            &width,
            Some(Instant::now() + limits::TEXT_EDIT_REPLAY_TIMEOUT),
        )?
    };
    let mut content = Vec::new();
    for (i, s) in replayed.streams.iter().enumerate() {
        if i > 0 {
            content.push(b'\n');
        }
        content.extend_from_slice(s);
    }
    Ok(Rewritten {
        content,
        fonts: replayed
            .fallback
            .iter()
            .map(|(face, _)| NewFont {
                face: *face,
                name: resource_name(*face),
            })
            .collect(),
        warnings: replayed.warnings,
    })
}

#[cfg(test)]
mod tests;
