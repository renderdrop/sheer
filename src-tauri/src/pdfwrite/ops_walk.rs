//! The operator walk shared by redaction and text editing (ARCHITECTURE §13.1): the content of a page and of the Form XObjects it
//! draws, with the full graphics and text state, reported glyph by glyph to a [`WalkSink`].
//!
//! The walk is read-only. Redaction ([`super::redact_content`]) rewrites operators as it goes and so keeps its own interpreter loop,
//! but runs on the same primitives that live here: the matrix and box arithmetic, the object readers, the font metrics ([`Font`],
//! [`Font::glyphs`]), the advance of a glyph ([`glyph_advance`]) and the nesting limit ([`MAX_STATE_DEPTH`]), so both read the same
//! geometry from the same content.
//!
//! Positions are in PDF user space of the page (the CTM of the page content is the identity); `origin` includes the text rise.
//! `GlyphPos::byte` counts in the string bytes of the operator: for `TJ` the strings of the array concatenated in order (numbers
//! between them take no bytes), for the others the one string operand. `OpRef::index` is the index of the operator in its content
//! stream as `Content::decode_strict` and the offset lexer both count them.

use std::collections::HashMap;
use std::ops::Range;
use std::rc::Rc;

use lopdf::content::{Content, Operation};
use lopdf::{Dictionary, Document, Object, ObjectId};

use crate::content::std14;
use crate::error::AppError;
use crate::limits;
use crate::model::annotation::StdFont;

/// Where an operator sits: the content stream of the page (index in `/Contents`) and the operator's index in it. Operators of a Form
/// XObject carry the stream index `u32::MAX` and are never edited.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct OpRef {
    pub stream: u32,
    pub index: u32,
}

/// The font a run is set in: the resource name used by `Tf` and the object it resolves to (`None` for a direct dictionary).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct FontKey {
    pub name: Vec<u8>,
    pub object: Option<ObjectId>,
}

/// One shown glyph. `byte` is the glyph's code bytes inside the string operand of `op`; `origin` is the baseline origin in page space,
/// `adv` the advance along `dir` (a unit vector) in page space, `size_eff` the font size times the text matrix scale.
#[derive(Debug, Clone, PartialEq)]
pub struct GlyphPos {
    pub op: OpRef,
    pub byte: Range<u32>,
    pub code: u32,
    pub origin: [f64; 2],
    pub adv: f64,
    pub size_eff: f64,
    pub dir: [f64; 2],
}

/// Consecutive glyphs of one font without a state change or a gap (ARCHITECTURE §13.1). `in_form` runs are not editable.
#[derive(Debug, Clone, PartialEq)]
pub struct Run {
    /// From the first operator of the run to one past the last.
    pub ops: Range<OpRef>,
    pub font: FontKey,
    pub in_form: bool,
    /// Text rendering mode (`Tr`); 3 is invisible.
    pub render_mode: u8,
    /// Text rise (`Ts`) in text space units.
    pub rise: f64,
    /// The rise in page units (what `origin` is raised by, along the normal of `dir`).
    pub rise_page: f64,
    /// Whether a clipping mode, a clip path that cuts the glyphs or an `ActualText` span is active.
    pub clipped: bool,
    pub glyphs: Vec<GlyphPos>,
}

/// What the walk may spend: operators and content bytes (`MAX_REDACT_OPS`, `MAX_REDACT_CONTENT_BYTES`). Every shown glyph costs one
/// operator.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Budget {
    pub ops: usize,
    pub bytes: usize,
}

impl Budget {
    pub const fn new() -> Self {
        Self {
            ops: limits::MAX_REDACT_OPS,
            bytes: limits::MAX_REDACT_CONTENT_BYTES,
        }
    }
}

impl Default for Budget {
    fn default() -> Self {
        Self::new()
    }
}

/// What the walk hands over, in drawing order.
pub trait WalkSink {
    /// A finished run.
    fn run(&mut self, run: Run) -> Result<(), AppError>;
    /// A path or image object with its bounding box in page space `[x0, y0, x1, y1]` (collision checks).
    fn object(&mut self, _bbox: [f64; 4]) {}
}

// --- shared primitives (also used by redaction) ----------------------------------------------------------------------------

pub(super) type Mat = [f64; 6];
/// `[x0, y0, x1, y1]`, normalized.
pub(super) type Box4 = [f64; 4];

pub(super) const IDENTITY: Mat = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];
pub(super) const MAX_STATE_DEPTH: usize = 512;
// --- geometry ---------------------------------------------------------------------------------------------------------

pub(super) fn mul(a: &Mat, b: &Mat) -> Mat {
    [
        a[0] * b[0] + a[1] * b[2],
        a[0] * b[1] + a[1] * b[3],
        a[2] * b[0] + a[3] * b[2],
        a[2] * b[1] + a[3] * b[3],
        a[4] * b[0] + a[5] * b[2] + b[4],
        a[4] * b[1] + a[5] * b[3] + b[5],
    ]
}

pub(super) fn apply(m: &Mat, x: f64, y: f64) -> (f64, f64) {
    (m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5])
}

pub(super) fn invert(m: &Mat) -> Option<Mat> {
    let det = m[0] * m[3] - m[1] * m[2];
    if !det.is_finite() || det.abs() < 1e-12 {
        return None;
    }
    let inv = [
        m[3] / det,
        -m[1] / det,
        -m[2] / det,
        m[0] / det,
        (m[2] * m[5] - m[3] * m[4]) / det,
        (m[1] * m[4] - m[0] * m[5]) / det,
    ];
    inv.iter().all(|v| v.is_finite()).then_some(inv)
}

pub(super) fn translate(x: f64, y: f64) -> Mat {
    [1.0, 0.0, 0.0, 1.0, x, y]
}

pub(super) fn aabb(points: &[(f64, f64)]) -> Box4 {
    let mut b = [
        f64::INFINITY,
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::NEG_INFINITY,
    ];
    for (x, y) in points {
        b[0] = b[0].min(*x);
        b[1] = b[1].min(*y);
        b[2] = b[2].max(*x);
        b[3] = b[3].max(*y);
    }
    b
}

pub(super) fn overlaps(a: &Box4, b: &Box4) -> bool {
    a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]
}

pub(super) fn corners(b: &Box4) -> [(f64, f64); 4] {
    [(b[0], b[1]), (b[2], b[1]), (b[2], b[3]), (b[0], b[3])]
}

pub(super) fn box_under(m: &Mat, b: &Box4) -> Box4 {
    let points: Vec<(f64, f64)> = corners(b).iter().map(|(x, y)| apply(m, *x, *y)).collect();
    aabb(&points)
}

pub(super) fn finite_box(b: &Box4) -> bool {
    b.iter().all(|v| v.is_finite())
}

// --- objects ----------------------------------------------------------------------------------------------------------

pub(super) fn num(object: &Object) -> Option<f64> {
    match object {
        Object::Integer(i) => {
            #[allow(clippy::cast_precision_loss)] // content numbers are far below 2^52
            let value = *i as f64;
            Some(value)
        }
        Object::Real(r) => Some(f64::from(*r)),
        _ => None,
    }
    .filter(|v| v.is_finite())
}

pub(super) fn nums<const N: usize>(operands: &[Object]) -> Option<[f64; N]> {
    if operands.len() != N {
        return None;
    }
    let mut out = [0.0; N];
    for (slot, operand) in out.iter_mut().zip(operands) {
        *slot = num(operand)?;
    }
    Some(out)
}

#[allow(clippy::cast_possible_truncation)] // content numbers are written as f32
pub(super) fn real(value: f64) -> Object {
    Object::Real(value as f32)
}

pub(super) fn resolve<'a>(src: &'a Document, object: &'a Object) -> Option<&'a Object> {
    let mut current = object;
    for _ in 0..8 {
        match current {
            Object::Reference(id) => current = src.get_object(*id).ok()?,
            other => return Some(other),
        }
    }
    None
}

pub(super) fn resolve_dict<'a>(src: &'a Document, object: &'a Object) -> Option<&'a Dictionary> {
    match resolve(src, object)? {
        Object::Dictionary(dict) => Some(dict),
        Object::Stream(stream) => Some(&stream.dict),
        _ => None,
    }
}

pub(super) fn name_of<'a>(dict: &'a Dictionary, key: &[u8]) -> Option<&'a [u8]> {
    dict.get(key).ok()?.as_name().ok()
}

pub(super) fn dict_number(src: &Document, dict: &Dictionary, key: &[u8]) -> Option<f64> {
    num(resolve(src, dict.get(key).ok()?)?)
}

/// Four numbers of an array (`BBox`, `Matrix`'s six are read by [`matrix_of`]).
pub(super) fn box_of(src: &Document, object: &Object) -> Option<Box4> {
    let items = resolve(src, object)?.as_array().ok()?;
    if items.len() != 4 {
        return None;
    }
    let mut v = [0.0; 4];
    for (slot, item) in v.iter_mut().zip(items) {
        *slot = num(resolve(src, item)?)?;
    }
    Some([
        v[0].min(v[2]),
        v[1].min(v[3]),
        v[0].max(v[2]),
        v[1].max(v[3]),
    ])
}

pub(super) fn matrix_of(src: &Document, object: Option<&Object>) -> Mat {
    let Some(object) = object else {
        return IDENTITY;
    };
    let Some(items) = resolve(src, object).and_then(|o| o.as_array().ok()) else {
        return IDENTITY;
    };
    if items.len() != 6 {
        return IDENTITY;
    }
    let mut m = IDENTITY;
    for (slot, item) in m.iter_mut().zip(items) {
        match resolve(src, item).and_then(num) {
            Some(v) => *slot = v,
            None => return IDENTITY,
        }
    }
    m
}
/// What the cutter and the line builder need to know about a font.
#[derive(Clone)]
pub(super) struct Font {
    /// Codes are two bytes (a composite font with an Identity CMap or another one that is read as such).
    pub(super) two_byte: bool,
    /// The widths are the font's own: glyphs can be cut one by one.
    pub(super) exact: bool,
    pub(super) first: u32,
    pub(super) widths: Vec<f64>,
    pub(super) missing: f64,
    pub(super) standard: Option<StdFont>,
    pub(super) cid_widths: HashMap<u32, f64>,
    pub(super) default_width: f64,
    /// Vertical writing (an encoding that ends in `-V`).
    pub(super) vertical: bool,
    /// Text space per glyph-space unit (0.001 for most fonts).
    pub(super) unit: f64,
    pub(super) ascent: f64,
    pub(super) descent: f64,
    /// `Subtype` is `Type3`.
    pub(super) type3: bool,
    /// A composite font with the `Identity-H` encoding.
    pub(super) identity_h: bool,
    /// The font descriptor has a font program.
    pub(super) embedded: bool,
    /// `/Flags` and `/FontWeight` of the descriptor (0 and 400 without).
    pub(super) flags: u32,
    pub(super) weight: u32,
    /// `/BaseFont` with its subset tag.
    pub(super) base_name: String,
}

pub(super) struct Glyph {
    pub(super) start: usize,
    pub(super) end: usize,
    /// Advance in text space per unit of font size (before character and word spacing).
    pub(super) width: f64,
    pub(super) space: bool,
}

impl Font {
    /// The font used when `Tf` names none that exists: nothing is known, so nothing is cut finely.
    pub(super) fn unknown() -> Self {
        Self {
            two_byte: false,
            vertical: false,
            exact: false,
            first: 0,
            widths: Vec::new(),
            missing: 0.0,
            standard: None,
            cid_widths: HashMap::new(),
            default_width: 600.0,
            unit: 0.001,
            ascent: 0.95,
            descent: -0.25,
            type3: false,
            identity_h: false,
            embedded: false,
            flags: 0,
            weight: 400,
            base_name: String::new(),
        }
    }

    pub(super) fn load(src: &Document, dict: &Dictionary) -> Self {
        let mut font = Self::unknown();
        let subtype = name_of(dict, b"Subtype").unwrap_or_default();
        let descriptor_of = |d: &Dictionary| -> Option<Dictionary> {
            resolve_dict(src, d.get(b"FontDescriptor").ok()?).cloned()
        };
        let mut descriptor = descriptor_of(dict);
        if subtype == b"Type0" {
            font.two_byte = true;
            let encoding = dict.get(b"Encoding").ok().and_then(|e| resolve(src, e));
            // Only Identity-H is read exactly: other CMaps may mix code lengths and Identity-V runs the other way.
            font.exact = matches!(encoding, Some(Object::Name(name)) if name == b"Identity-H");
            font.vertical = !matches!(encoding, Some(Object::Name(name)) if name.ends_with(b"-H"));
            font.identity_h = font.exact;
            let descendant = dict
                .get(b"DescendantFonts")
                .ok()
                .and_then(|d| resolve(src, d))
                .and_then(|d| d.as_array().ok())
                .and_then(|items| items.first())
                .and_then(|d| resolve_dict(src, d));
            if let Some(descendant) = descendant {
                font.default_width = dict_number(src, descendant, b"DW").unwrap_or(1000.0);
                if descriptor.is_none() {
                    descriptor = descriptor_of(descendant);
                }
                if !font.read_cid_widths(src, descendant) {
                    font.exact = false;
                }
            }
        } else {
            if subtype == b"Type3" {
                font.unit = matrix_of(src, dict.get(b"FontMatrix").ok())[0];
                if !(font.unit.is_finite() && font.unit > 0.0) {
                    font.unit = 0.001;
                    font.exact = false;
                }
            }
            font.first = dict_number(src, dict, b"FirstChar").map_or(0, |v| {
                #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
                let first = v.clamp(0.0, 65_535.0) as u32;
                first
            });
            let widths = dict
                .get(b"Widths")
                .ok()
                .and_then(|w| resolve(src, w))
                .and_then(|w| w.as_array().ok());
            if let Some(widths) = widths {
                font.widths = widths
                    .iter()
                    .take(70_000)
                    .map(|w| resolve(src, w).and_then(num).unwrap_or(0.0))
                    .collect();
                font.exact = true;
            } else {
                let base = name_of(dict, b"BaseFont").unwrap_or_default();
                font.standard = standard_font(base);
                font.exact = font.standard.is_some() && simple_encoding(src, dict);
            }
        }
        if subtype == b"Type3" {
            // A Type3 glyph is any drawing and can lie far outside its advance: it is cut per operator.
            font.exact = false;
        }
        font.type3 = subtype == b"Type3";
        font.base_name =
            String::from_utf8_lossy(name_of(dict, b"BaseFont").unwrap_or_default()).into_owned();
        if let Some(descriptor) = descriptor {
            font.embedded = [&b"FontFile"[..], b"FontFile2", b"FontFile3"]
                .iter()
                .any(|k| descriptor.has(k));
            font.flags = dict_number(src, &descriptor, b"Flags")
                .map_or(0, |v| v.clamp(0.0, 4_294_967_295.0) as u32);
            font.weight = dict_number(src, &descriptor, b"FontWeight")
                .map_or(400, |v| v.clamp(0.0, 1000.0) as u32);
            font.missing = dict_number(src, &descriptor, b"MissingWidth").unwrap_or(0.0);
            if let Some(a) = dict_number(src, &descriptor, b"Ascent").filter(|a| *a > 0.0) {
                font.ascent = (a / 1000.0).clamp(0.5, 1.3);
            }
            if let Some(d) = dict_number(src, &descriptor, b"Descent").filter(|d| *d != 0.0) {
                font.descent = (-d.abs() / 1000.0).clamp(-0.6, -0.05);
            }
        }
        font
    }

    /// Reads `/W` of a CIDFont; false when it holds more than the limit or is not what the format says.
    pub(super) fn read_cid_widths(&mut self, src: &Document, descendant: &Dictionary) -> bool {
        let Some(array) = descendant
            .get(b"W")
            .ok()
            .and_then(|w| resolve(src, w))
            .and_then(|w| w.as_array().ok())
        else {
            return true;
        };
        let mut index = 0;
        let mut spent = 0u32;
        while index < array.len() {
            let Some(first) = resolve(src, &array[index]).and_then(num) else {
                return false;
            };
            #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
            let first = first.clamp(0.0, 65_535.0) as u32;
            match array.get(index + 1).and_then(|n| resolve(src, n)) {
                Some(Object::Array(list)) => {
                    for (offset, width) in (0u32..).zip(list.iter().take(70_000)) {
                        let width = resolve(src, width).and_then(num).unwrap_or(0.0);
                        self.cid_widths.insert(first.saturating_add(offset), width);
                    }
                    index += 2;
                }
                Some(other) => {
                    let (Some(last), Some(width)) = (
                        num(other),
                        array
                            .get(index + 2)
                            .and_then(|w| resolve(src, w))
                            .and_then(num),
                    ) else {
                        return false;
                    };
                    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
                    let last = last.clamp(0.0, 65_535.0) as u32;
                    spent = spent.saturating_add(last.max(first) - first + 1);
                    if spent > 2_000_000 {
                        return false;
                    }
                    for cid in first..=last.max(first) {
                        self.cid_widths.insert(cid, width);
                    }
                    index += 3;
                }
                None => return false,
            }
            if self.cid_widths.len() > 70_000 {
                return false;
            }
        }
        true
    }

    pub(super) fn width_of(&self, code: u32) -> f64 {
        let units = if self.two_byte {
            self.cid_widths
                .get(&code)
                .copied()
                .unwrap_or(self.default_width)
        } else if !self.widths.is_empty() {
            code.checked_sub(self.first)
                .and_then(|i| self.widths.get(i as usize))
                .copied()
                .unwrap_or(self.missing)
        } else if let Some(standard) = self.standard {
            u8::try_from(code).map_or(self.default_width, |c| f64::from(std14::width(standard, c)))
        } else {
            self.default_width
        };
        units * self.unit
    }

    /// The glyphs of a string.
    pub(super) fn glyphs(&self, bytes: &[u8]) -> Vec<Glyph> {
        let mut out = Vec::with_capacity(bytes.len());
        if self.two_byte {
            let mut at = 0;
            while at < bytes.len() {
                let end = (at + 2).min(bytes.len());
                let code = bytes[at..end]
                    .iter()
                    .fold(0u32, |acc, b| (acc << 8) | u32::from(*b));
                out.push(Glyph {
                    start: at,
                    end,
                    width: self.width_of(code),
                    space: false,
                });
                at = end;
            }
        } else {
            for (at, byte) in bytes.iter().enumerate() {
                out.push(Glyph {
                    start: at,
                    end: at + 1,
                    width: self.width_of(u32::from(*byte)),
                    space: *byte == b' ',
                });
            }
        }
        out
    }
}

/// The standard font whose widths are the regular ones, by base font name (a subset prefix is ignored). Bold and italic faces of
/// Times and the bold faces of Helvetica have other widths and are not matched.
pub(super) fn standard_font(base: &[u8]) -> Option<StdFont> {
    let name = String::from_utf8_lossy(base);
    let name = name.split_once('+').map_or(&*name, |(_, rest)| rest);
    match name {
        "Helvetica" | "Helvetica-Oblique" | "Arial" | "ArialMT" | "Arial-ItalicMT" => {
            Some(StdFont::Sans)
        }
        "Times-Roman" | "TimesNewRoman" | "TimesNewRomanPSMT" => Some(StdFont::Serif),
        n if n.starts_with("Courier") => Some(StdFont::Mono),
        _ => None,
    }
}

/// Whether the font's codes are WinAnsi (or the ASCII range every encoding shares): no `/Differences`, no other base encoding.
pub(super) fn simple_encoding(src: &Document, dict: &Dictionary) -> bool {
    match dict.get(b"Encoding").ok().and_then(|e| resolve(src, e)) {
        None => true,
        Some(Object::Name(name)) => name == b"WinAnsiEncoding",
        Some(Object::Dictionary(encoding)) => {
            !encoding.has(b"Differences")
                && name_of(encoding, b"BaseEncoding").is_none_or(|n| n == b"WinAnsiEncoding")
        }
        _ => false,
    }
}
/// The advance of one glyph in text space (ARCHITECTURE §13.1): `((w0 * Tfs) + Tc + Tw) * Tz`; `word_spacing` is `Tw` for a
/// single-byte code 32 and 0 for every other glyph.
pub(super) fn glyph_advance(width: f64, size: f64, tc: f64, word_spacing: f64, th: f64) -> f64 {
    (width * size + tc + word_spacing) * th
}

/// `a` and `b` intersected (an empty result has `x0 > x1` or `y0 > y1`).
fn intersect(a: &Box4, b: &Box4) -> Box4 {
    [
        a[0].max(b[0]),
        a[1].max(b[1]),
        a[2].min(b[2]),
        a[3].min(b[3]),
    ]
}

fn inside(b: &Box4, p: [f64; 2]) -> bool {
    const SLACK: f64 = 1.0;
    p[0] >= b[0] - SLACK && p[0] <= b[2] + SLACK && p[1] >= b[1] - SLACK && p[1] <= b[3] + SLACK
}

/// The walk ran out of operators: a neutral key, since redaction and text editing both walk (the redaction's own work budget is `redactPage`).
fn too_big() -> AppError {
    AppError::limit("contentOps", limits::MAX_REDACT_OPS as u64)
}

fn unreadable() -> AppError {
    AppError::invalid("content")
}

// --- the walk ---------------------------------------------------------------------------------------------------------------

#[derive(Clone)]
struct Gs {
    ctm: Mat,
    font: Option<Rc<Font>>,
    key: FontKey,
    size: f64,
    tc: f64,
    tw: f64,
    th: f64,
    tl: f64,
    rise: f64,
    tr: u8,
    /// The bounding box of the clip paths in force (`None`: only the page).
    clip: Option<Box4>,
}

impl Gs {
    fn new(ctm: Mat) -> Self {
        Self {
            ctm,
            font: None,
            key: FontKey {
                name: Vec::new(),
                object: None,
            },
            size: 0.0,
            tc: 0.0,
            tw: 0.0,
            th: 1.0,
            tl: 0.0,
            rise: 0.0,
            tr: 0,
            clip: None,
        }
    }
}

/// The state of one content stream (or of the content streams of the page, which continue one another).
struct Ctx {
    gs: Gs,
    stack: Vec<Gs>,
    tm: Mat,
    tlm: Mat,
    /// Bounding box of the path under construction, and whether a clip operator is waiting for its painting operator.
    path: Option<Box4>,
    pending_clip: bool,
    /// Marked content, innermost last: whether the sequence carries `/ActualText`.
    marks: Vec<bool>,
    cur: Option<Run>,
    in_form: bool,
}

impl Ctx {
    fn new(gs: Gs, marks: Vec<bool>, in_form: bool) -> Self {
        Self {
            gs,
            stack: Vec::new(),
            tm: IDENTITY,
            tlm: IDENTITY,
            path: None,
            pending_clip: false,
            marks,
            cur: None,
            in_form,
        }
    }

    fn extend_path(&mut self, points: &[(f64, f64)]) {
        let ctm = self.gs.ctm;
        let mapped: Vec<(f64, f64)> = points.iter().map(|(x, y)| apply(&ctm, *x, *y)).collect();
        let b = aabb(&mapped);
        if !finite_box(&b) {
            return;
        }
        self.path = Some(match self.path {
            Some(p) => [
                p[0].min(b[0]),
                p[1].min(b[1]),
                p[2].max(b[2]),
                p[3].max(b[3]),
            ],
            None => b,
        });
    }
}

/// The resources a content stream runs in, with the fonts read from them.
struct Res {
    dict: Dictionary,
    fonts: HashMap<Vec<u8>, Option<(Rc<Font>, FontKey)>>,
}

impl Res {
    fn new(src: &Document, object: Option<&Object>) -> Self {
        Self {
            dict: object
                .and_then(|o| resolve_dict(src, o))
                .cloned()
                .unwrap_or_default(),
            fonts: HashMap::new(),
        }
    }

    fn sub_dict<'a>(&'a self, src: &'a Document, key: &[u8]) -> Option<&'a Dictionary> {
        resolve_dict(src, self.dict.get(key).ok()?)
    }

    fn font(&mut self, src: &Document, name: &[u8]) -> Option<(Rc<Font>, FontKey)> {
        if let Some(found) = self.fonts.get(name) {
            return found.clone();
        }
        let found = self.sub_dict(src, b"Font").and_then(|fonts| {
            let entry = fonts.get(name).ok()?;
            let dict = resolve_dict(src, entry)?;
            let object = entry.as_reference().ok();
            Some((
                Rc::new(Font::load(src, dict)),
                FontKey {
                    name: name.to_vec(),
                    object,
                },
            ))
        });
        self.fonts.insert(name.to_vec(), found.clone());
        found
    }
}

/// The value of an inheritable page key.
pub(super) fn inherited(src: &Document, page: ObjectId, key: &[u8]) -> Option<Object> {
    let mut at = page;
    for _ in 0..64 {
        let dict = src.get_dictionary(at).ok()?;
        if let Ok(value) = dict.get(key) {
            return Some(value.clone());
        }
        match dict.get(b"Parent") {
            Ok(Object::Reference(parent)) => at = *parent,
            _ => return None,
        }
    }
    None
}

/// The inheritable `/Resources` of a page (for the callers that resolve a font by its name).
pub(super) fn page_font(src: &Document, page: ObjectId, name: &[u8]) -> Option<Font> {
    let resources = inherited(src, page, b"Resources")?;
    let mut res = Res::new(src, Some(&resources));
    res.font(src, name).map(|(font, _)| (*font).clone())
}

struct Walker<'a> {
    src: &'a Document,
    budget: &'a mut Budget,
    sink: &'a mut dyn WalkSink,
    /// The forms being walked (cycles).
    forms: Vec<ObjectId>,
}

/// One element of a show operator.
enum Item<'o> {
    Text(&'o [u8]),
    Adjust(f64),
}

/// Walks `page` of `src`. `limit_exceeded` when a budget runs out, `invalid_argument` for content that does not parse.
pub fn walk(
    src: &Document,
    page: ObjectId,
    budget: &mut Budget,
    sink: &mut dyn WalkSink,
) -> Result<(), AppError> {
    let dict = src
        .get_dictionary(page)
        .map_err(|_| AppError::invalid("page"))?;
    let resources = inherited(src, page, b"Resources");
    let mut res = Res::new(src, resources.as_ref());
    let mut streams: Vec<&lopdf::Stream> = Vec::new();
    match dict.get(b"Contents").ok().and_then(|c| resolve(src, c)) {
        Some(Object::Stream(stream)) => streams.push(stream),
        Some(Object::Array(items)) => {
            for item in items.iter().take(100_000) {
                if let Some(Object::Stream(stream)) = resolve(src, item) {
                    streams.push(stream);
                }
            }
        }
        _ => {}
    }
    let mut walker = Walker {
        src,
        budget,
        sink,
        forms: Vec::new(),
    };
    let mut ctx = Ctx::new(Gs::new(IDENTITY), Vec::new(), false);
    for (n, stream) in streams.into_iter().enumerate() {
        let data = stream
            .decompressed_content_with_limit(walker.budget.bytes)
            .map_err(|e| decode_error(&e))?;
        walker.budget.bytes = walker
            .budget
            .bytes
            .checked_sub(data.len())
            .ok_or_else(too_big)?;
        let ops = Content::decode_strict(&data)
            .map_err(|_| unreadable())?
            .operations;
        drop(data);
        walker.exec(
            &ops,
            &mut ctx,
            &mut res,
            u32::try_from(n).unwrap_or(u32::MAX),
            0,
        )?;
    }
    walker.flush(&mut ctx)
}

impl Walker<'_> {
    fn flush(&mut self, c: &mut Ctx) -> Result<(), AppError> {
        match c.cur.take() {
            Some(run) if !run.glyphs.is_empty() => self.sink.run(run),
            _ => Ok(()),
        }
    }

    #[allow(clippy::too_many_lines)]
    fn exec(
        &mut self,
        ops: &[Operation],
        c: &mut Ctx,
        res: &mut Res,
        stream: u32,
        depth: usize,
    ) -> Result<(), AppError> {
        for (i, op) in ops.iter().enumerate() {
            self.budget.ops = self.budget.ops.checked_sub(1).ok_or_else(too_big)?;
            let at = OpRef {
                stream,
                index: u32::try_from(i).unwrap_or(u32::MAX),
            };
            let a = op.operands.as_slice();
            let name = op.operator.as_str();
            match name {
                "q" => {
                    self.flush(c)?;
                    if c.stack.len() >= MAX_STATE_DEPTH {
                        return Err(AppError::limit("graphicsState", MAX_STATE_DEPTH as u64));
                    }
                    c.stack.push(c.gs.clone());
                }
                "Q" => {
                    self.flush(c)?;
                    if let Some(previous) = c.stack.pop() {
                        c.gs = previous;
                    }
                }
                "cm" => {
                    self.flush(c)?;
                    if let Some(m) = nums::<6>(a) {
                        c.gs.ctm = mul(&m, &c.gs.ctm);
                    }
                }
                "BT" => {
                    self.flush(c)?;
                    c.tm = IDENTITY;
                    c.tlm = IDENTITY;
                }
                "ET" => self.flush(c)?,
                "Tc" | "Tw" | "Tz" | "TL" | "Ts" | "Tr" => {
                    self.flush(c)?;
                    if let Some(v) = a.first().and_then(num) {
                        match name {
                            "Tc" => c.gs.tc = v,
                            "Tw" => c.gs.tw = v,
                            "Tz" => c.gs.th = v / 100.0,
                            "TL" => c.gs.tl = v,
                            "Ts" => c.gs.rise = v,
                            _ => {
                                #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
                                let mode = v.clamp(0.0, 7.0) as u8;
                                c.gs.tr = mode;
                            }
                        }
                    }
                }
                "Tf" => {
                    self.flush(c)?;
                    if let (Some(Object::Name(font_name)), Some(size)) =
                        (a.first(), a.get(1).and_then(num))
                    {
                        c.gs.size = size;
                        match res.font(self.src, font_name) {
                            Some((font, key)) => {
                                c.gs.font = Some(font);
                                c.gs.key = key;
                            }
                            None => {
                                c.gs.font = None;
                                c.gs.key = FontKey {
                                    name: font_name.clone(),
                                    object: None,
                                };
                            }
                        }
                    }
                }
                "Td" | "TD" => {
                    self.flush(c)?;
                    if let Some([tx, ty]) = nums::<2>(a) {
                        if name == "TD" {
                            c.gs.tl = -ty;
                        }
                        c.tlm = mul(&translate(tx, ty), &c.tlm);
                        c.tm = c.tlm;
                    }
                }
                "Tm" => {
                    self.flush(c)?;
                    if let Some(m) = nums::<6>(a) {
                        c.tm = m;
                        c.tlm = m;
                    }
                }
                "T*" => {
                    self.flush(c)?;
                    c.tlm = mul(&translate(0.0, -c.gs.tl), &c.tlm);
                    c.tm = c.tlm;
                }
                "Tj" | "TJ" | "'" | "\"" => self.show(op, at, c)?,
                "BMC" | "BDC" => {
                    self.flush(c)?;
                    let actual = name == "BDC" && self.has_actual_text(a.get(1), res);
                    c.marks.push(actual);
                }
                "EMC" => {
                    self.flush(c)?;
                    c.marks.pop();
                }
                "m" | "l" => {
                    if let Some([x, y]) = nums::<2>(a) {
                        c.extend_path(&[(x, y)]);
                    }
                }
                "c" => {
                    if let Some([x1, y1, x2, y2, x3, y3]) = nums::<6>(a) {
                        c.extend_path(&[(x1, y1), (x2, y2), (x3, y3)]);
                    }
                }
                "v" | "y" => {
                    if let Some([x1, y1, x2, y2]) = nums::<4>(a) {
                        c.extend_path(&[(x1, y1), (x2, y2)]);
                    }
                }
                "re" => {
                    if let Some([x, y, w, h]) = nums::<4>(a) {
                        c.extend_path(&[(x, y), (x + w, y), (x + w, y + h), (x, y + h)]);
                    }
                }
                "W" | "W*" => c.pending_clip = true,
                "S" | "s" | "f" | "F" | "f*" | "B" | "B*" | "b" | "b*" | "n" => {
                    let painted = name != "n";
                    let path = c.path.take();
                    if painted {
                        if let Some(b) = path {
                            self.sink.object(b);
                        }
                    }
                    if std::mem::take(&mut c.pending_clip) {
                        let b = path.unwrap_or([1.0, 1.0, 0.0, 0.0]);
                        c.gs.clip = Some(match c.gs.clip {
                            Some(old) => intersect(&old, &b),
                            None => b,
                        });
                    }
                }
                "BI" => {
                    let b = box_under(&c.gs.ctm, &[0.0, 0.0, 1.0, 1.0]);
                    if finite_box(&b) {
                        self.sink.object(b);
                    }
                }
                "Do" => self.do_xobject(a, c, res, depth)?,
                _ => {}
            }
        }
        Ok(())
    }

    /// Whether the property list of a `BDC` (inline, or a name of `/Properties`) has `/ActualText`.
    fn has_actual_text(&self, props: Option<&Object>, res: &Res) -> bool {
        match props {
            Some(Object::Dictionary(d)) => d.has(b"ActualText"),
            Some(Object::Name(n)) => res
                .sub_dict(self.src, b"Properties")
                .and_then(|p| p.get(n).ok())
                .and_then(|o| resolve_dict(self.src, o))
                .is_some_and(|d| d.has(b"ActualText")),
            _ => false,
        }
    }

    /// A show operator: every glyph with its position.
    fn show(&mut self, op: &Operation, at: OpRef, c: &mut Ctx) -> Result<(), AppError> {
        if matches!(op.operator.as_str(), "'" | "\"") {
            self.flush(c)?;
        }
        let name = op.operator.as_str();
        let a = op.operands.as_slice();
        let mut items: Vec<Item<'_>> = Vec::new();
        match (name, a) {
            ("Tj", [Object::String(bytes, _)]) => items.push(Item::Text(bytes)),
            ("TJ", [Object::Array(list)]) => {
                for item in list {
                    match item {
                        Object::String(bytes, _) => items.push(Item::Text(bytes)),
                        other => {
                            if let Some(v) = num(other) {
                                items.push(Item::Adjust(v));
                            }
                        }
                    }
                }
            }
            ("'", [Object::String(bytes, _)]) => items.push(Item::Text(bytes)),
            ("\"", [aw, ac, Object::String(bytes, _)]) => {
                if let (Some(aw), Some(ac)) = (num(aw), num(ac)) {
                    c.gs.tw = aw;
                    c.gs.tc = ac;
                    items.push(Item::Text(bytes));
                }
            }
            _ => {}
        }
        if matches!(name, "'" | "\"") {
            c.tlm = mul(&translate(0.0, -c.gs.tl), &c.tlm);
            c.tm = c.tlm;
        }
        let font =
            c.gs.font
                .clone()
                .unwrap_or_else(|| Rc::new(Font::unknown()));
        let mut base = 0u32;
        for item in items {
            match item {
                Item::Adjust(v) => {
                    c.tm = mul(&translate(-v / 1000.0 * c.gs.size * c.gs.th, 0.0), &c.tm);
                }
                Item::Text(bytes) => {
                    for glyph in font.glyphs(bytes) {
                        self.budget.ops = self.budget.ops.checked_sub(1).ok_or_else(too_big)?;
                        let code = bytes[glyph.start..glyph.end]
                            .iter()
                            .fold(0u32, |acc, b| (acc << 8) | u32::from(*b));
                        let word = if glyph.space { c.gs.tw } else { 0.0 };
                        let advance = glyph_advance(glyph.width, c.gs.size, c.gs.tc, word, c.gs.th);
                        let m = mul(&c.tm, &c.gs.ctm);
                        let (sx, sy) = (m[0].hypot(m[1]), m[2].hypot(m[3]));
                        let dir = if sx > 1e-9 {
                            [m[0] / sx, m[1] / sx]
                        } else {
                            [1.0, 0.0]
                        };
                        let (ox, oy) = apply(&m, 0.0, c.gs.rise);
                        let first = base + u32::try_from(glyph.start).unwrap_or(u32::MAX);
                        let last = base + u32::try_from(glyph.end).unwrap_or(u32::MAX);
                        let pos = GlyphPos {
                            op: at,
                            byte: first..last,
                            code,
                            origin: [ox, oy],
                            adv: advance * sx,
                            size_eff: c.gs.size.abs() * sy,
                            dir,
                        };
                        if [ox, oy, pos.adv, pos.size_eff]
                            .iter()
                            .all(|v| v.is_finite())
                        {
                            self.add_glyph(c, at, pos, c.gs.rise * sy)?;
                        }
                        c.tm = mul(&translate(advance, 0.0), &c.tm);
                    }
                    base += u32::try_from(bytes.len()).unwrap_or(u32::MAX);
                }
            }
        }
        Ok(())
    }

    /// Appends `pos` to the current run, which a gap or a turn closes first.
    fn add_glyph(
        &mut self,
        c: &mut Ctx,
        at: OpRef,
        pos: GlyphPos,
        rise_page: f64,
    ) -> Result<(), AppError> {
        let break_here = c
            .cur
            .as_ref()
            .and_then(|r| r.glyphs.last())
            .is_some_and(|last| {
                let end = [
                    last.origin[0] + last.dir[0] * last.adv,
                    last.origin[1] + last.dir[1] * last.adv,
                ];
                let d = [pos.origin[0] - end[0], pos.origin[1] - end[1]];
                let along = d[0] * pos.dir[0] + d[1] * pos.dir[1];
                let across = -d[0] * pos.dir[1] + d[1] * pos.dir[0];
                let em = pos.size_eff.max(last.size_eff).max(1e-6);
                let turned =
                    (pos.dir[0] - last.dir[0]).abs() + (pos.dir[1] - last.dir[1]).abs() > 0.02;
                across.abs() > 0.2 * em || along > em || along < -0.3 * em || turned
            });
        if break_here {
            self.flush(c)?;
        }
        let gs = &c.gs;
        let run = c.cur.get_or_insert_with(|| Run {
            ops: at..at,
            font: gs.key.clone(),
            in_form: c.in_form,
            render_mode: gs.tr,
            rise: gs.rise,
            rise_page,
            clipped: false,
            glyphs: Vec::new(),
        });
        if run.glyphs.is_empty() {
            run.ops.start = at;
        }
        run.ops.end = OpRef {
            stream: at.stream,
            index: at.index.saturating_add(1),
        };
        let end = [
            pos.origin[0] + pos.dir[0] * pos.adv,
            pos.origin[1] + pos.dir[1] * pos.adv,
        ];
        let cut = gs
            .clip
            .is_some_and(|b| !(inside(&b, pos.origin) && inside(&b, end)));
        if gs.tr >= 4 || c.marks.iter().any(|m| *m) || cut {
            run.clipped = true;
        }
        run.glyphs.push(pos);
        Ok(())
    }

    /// `Do`: an image is an object, a form is walked (read-only, its runs are `in_form`).
    fn do_xobject(
        &mut self,
        a: &[Object],
        c: &mut Ctx,
        res: &mut Res,
        depth: usize,
    ) -> Result<(), AppError> {
        self.flush(c)?;
        let src = self.src;
        let Some(Object::Name(name)) = a.first() else {
            return Ok(());
        };
        let Some(entry) = res
            .sub_dict(src, b"XObject")
            .and_then(|d| d.get(name).ok())
            .cloned()
        else {
            return Ok(());
        };
        let id = entry.as_reference().ok();
        let Some(Object::Stream(stream)) = resolve(src, &entry) else {
            return Ok(());
        };
        match name_of(&stream.dict, b"Subtype").unwrap_or_default() {
            b"Image" => {
                let b = box_under(&c.gs.ctm, &[0.0, 0.0, 1.0, 1.0]);
                if finite_box(&b) {
                    self.sink.object(b);
                }
            }
            b"Form" => {
                if depth + 1 > limits::MAX_REDACT_FORM_DEPTH
                    || id.is_some_and(|id| self.forms.contains(&id))
                {
                    return Ok(());
                }
                let Ok(data) = stream.decompressed_content_with_limit(self.budget.bytes) else {
                    return Ok(());
                };
                self.budget.bytes = self
                    .budget
                    .bytes
                    .checked_sub(data.len())
                    .ok_or_else(too_big)?;
                let Ok(content) = Content::decode_strict(&data) else {
                    return Ok(());
                };
                drop(data);
                let mut gs = c.gs.clone();
                gs.ctm = mul(&matrix_of(src, stream.dict.get(b"Matrix").ok()), &c.gs.ctm);
                let mut inner = Ctx::new(gs, c.marks.clone(), true);
                if let Some(id) = id {
                    self.forms.push(id);
                }
                let result = match stream.dict.get(b"Resources").ok() {
                    Some(own) => {
                        let mut own = Res::new(src, Some(own));
                        self.exec(
                            &content.operations,
                            &mut inner,
                            &mut own,
                            u32::MAX,
                            depth + 1,
                        )
                    }
                    None => self.exec(&content.operations, &mut inner, res, u32::MAX, depth + 1),
                };
                if id.is_some() {
                    self.forms.pop();
                }
                result?;
                self.flush(&mut inner)?;
            }
            _ => {}
        }
        Ok(())
    }
}

/// A stream that cannot be decoded: `limit_exceeded` when it is the size that stopped it, else the content is unreadable.
fn decode_error(error: &lopdf::Error) -> AppError {
    match error {
        lopdf::Error::Decompress(lopdf::DecompressError::MemoryLimitExceeded { .. }) => too_big(),
        _ => unreadable(),
    }
}
