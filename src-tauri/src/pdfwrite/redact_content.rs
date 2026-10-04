//! Surgical redaction of one page (ADR-055, supersedes the raster page of ADR-047 §3).
//!
//! The page's content is read as the operators it is made of and written again without what lies under the marks. What is outside
//! stays as it was, so it is still text, still selectable and searchable:
//!
//! - **Text.** A show operator (`Tj`, `TJ`, `'`, `"`) is cut per glyph: the width of each glyph comes from the font (`/Widths`, `/W`,
//!   the standard 14 metrics), its box from the text matrix and the CTM. A glyph that touches a mark is not written; its advance
//!   becomes a `TJ` kerning number, so the glyphs after it keep their place. A font whose widths are not known (no `/Widths`, not a
//!   regular standard font, a CMap other than Identity) is not cut per glyph: the whole show operator goes when its estimated box
//!   touches a mark.
//! - **Paths.** A stroke of lines is cut at the marks, a fill of axis-aligned rectangles has the marks cut out of it; any other painted
//!   path that touches a mark is dropped. Clip paths are kept (they paint nothing).
//! - **Images.** The covered pixels of an image (and of its soft mask) are zeroed and the image is written again
//!   ([`super::redact_image`]); one that cannot be decoded is dropped. Inline images likewise.
//! - **Forms.** A form XObject that touches a mark is processed the same way, recursively, into a copy used at that place only.
//! - **Shadings** (`sh`) are painted through a clip that leaves the marks out. **Annotations** of the page are not carried.
//!   Marked-content property lists (`/ActualText`, `/Alt`) are dropped.
//!
//! At the end a black rectangle is drawn for every mark. Anything this module cannot read is removed rather than kept: a show operator
//! with odd operands, a form or image it cannot decode, a path it cannot classify. A page whose content does not parse at all is an
//! error (`damaged_file`); the page is never turned into a picture. Everything is bounded (content bytes, operators, nesting, rectangle
//! tests) and nothing here panics on hostile input.

use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use lopdf::content::{Content, Operation};
use lopdf::{Dictionary, Document, Object, ObjectId, Stream, StringFormat};

use super::pagetree::{copy_page_with, materialize_inherited};
use super::redact_image::{self as pixels, Outcome};
use crate::content::std14;
use crate::error::{AppError, ErrorCode};
use crate::limits;
use crate::model::annotation::StdFont;
use crate::model::geometry::Rect;

/// Marker key of a page made here; [`super::redact::finish`] takes it out again after it scrubbed the page.
pub(super) const MARKER: &[u8] = b"SheerRedacted";

type Mat = [f64; 6];
/// `[x0, y0, x1, y1]`, normalized.
type Box4 = [f64; 4];

const IDENTITY: Mat = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];
/// Most graphics state levels (`q`).
const MAX_STATE_DEPTH: usize = 512;
/// Most rectangles `sh` is clipped by; more and the shading is dropped.
const MAX_SHADING_CUTS: usize = 256;
/// Most pieces a filled rectangle may be cut into.
const MAX_PIECES: usize = 10_000;

fn damaged(detail: &str) -> AppError {
    AppError::logged(ErrorCode::DamagedFile, format!("redaction: {detail}"))
}

fn too_big() -> AppError {
    AppError::limit("redactPage", limits::MAX_REDACT_OPS as u64)
}

// --- geometry ---------------------------------------------------------------------------------------------------------

fn mul(a: &Mat, b: &Mat) -> Mat {
    [
        a[0] * b[0] + a[1] * b[2],
        a[0] * b[1] + a[1] * b[3],
        a[2] * b[0] + a[3] * b[2],
        a[2] * b[1] + a[3] * b[3],
        a[4] * b[0] + a[5] * b[2] + b[4],
        a[4] * b[1] + a[5] * b[3] + b[5],
    ]
}

fn apply(m: &Mat, x: f64, y: f64) -> (f64, f64) {
    (m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5])
}

fn invert(m: &Mat) -> Option<Mat> {
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

fn translate(x: f64, y: f64) -> Mat {
    [1.0, 0.0, 0.0, 1.0, x, y]
}

fn aabb(points: &[(f64, f64)]) -> Box4 {
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

fn overlaps(a: &Box4, b: &Box4) -> bool {
    a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]
}

fn corners(b: &Box4) -> [(f64, f64); 4] {
    [(b[0], b[1]), (b[2], b[1]), (b[2], b[3]), (b[0], b[3])]
}

fn box_under(m: &Mat, b: &Box4) -> Box4 {
    let points: Vec<(f64, f64)> = corners(b).iter().map(|(x, y)| apply(m, *x, *y)).collect();
    aabb(&points)
}

fn finite_box(b: &Box4) -> bool {
    b.iter().all(|v| v.is_finite())
}

// --- objects ----------------------------------------------------------------------------------------------------------

fn num(object: &Object) -> Option<f64> {
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

fn nums<const N: usize>(operands: &[Object]) -> Option<[f64; N]> {
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
fn real(value: f64) -> Object {
    Object::Real(value as f32)
}

fn resolve<'a>(src: &'a Document, object: &'a Object) -> Option<&'a Object> {
    let mut current = object;
    for _ in 0..8 {
        match current {
            Object::Reference(id) => current = src.get_object(*id).ok()?,
            other => return Some(other),
        }
    }
    None
}

fn resolve_dict<'a>(src: &'a Document, object: &'a Object) -> Option<&'a Dictionary> {
    match resolve(src, object)? {
        Object::Dictionary(dict) => Some(dict),
        Object::Stream(stream) => Some(&stream.dict),
        _ => None,
    }
}

fn name_of<'a>(dict: &'a Dictionary, key: &[u8]) -> Option<&'a [u8]> {
    dict.get(key).ok()?.as_name().ok()
}

fn dict_number(src: &Document, dict: &Dictionary, key: &[u8]) -> Option<f64> {
    num(resolve(src, dict.get(key).ok()?)?)
}

/// Four numbers of an array (`BBox`, `Matrix`'s six are read by [`matrix_of`]).
fn box_of(src: &Document, object: &Object) -> Option<Box4> {
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

fn matrix_of(src: &Document, object: Option<&Object>) -> Mat {
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

// --- fonts ------------------------------------------------------------------------------------------------------------

/// What the cutter needs to know about a font.
struct Font {
    /// Codes are two bytes (a composite font with an Identity CMap or another one that is read as such).
    two_byte: bool,
    /// The widths are the font's own: glyphs can be cut one by one.
    exact: bool,
    first: u32,
    widths: Vec<f64>,
    missing: f64,
    standard: Option<StdFont>,
    cid_widths: HashMap<u32, f64>,
    default_width: f64,
    /// Vertical writing (an encoding that ends in `-V`).
    vertical: bool,
    /// Text space per glyph-space unit (0.001 for most fonts).
    unit: f64,
    ascent: f64,
    descent: f64,
}

struct Glyph {
    start: usize,
    end: usize,
    /// Advance in text space per unit of font size (before character and word spacing).
    width: f64,
    space: bool,
}

impl Font {
    /// The font used when `Tf` names none that exists: nothing is known, so nothing is cut finely.
    fn unknown() -> Self {
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
        }
    }

    fn load(src: &Document, dict: &Dictionary) -> Self {
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
        if let Some(descriptor) = descriptor {
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
    fn read_cid_widths(&mut self, src: &Document, descendant: &Dictionary) -> bool {
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

    fn width_of(&self, code: u32) -> f64 {
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
    fn glyphs(&self, bytes: &[u8]) -> Vec<Glyph> {
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
fn standard_font(base: &[u8]) -> Option<StdFont> {
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
fn simple_encoding(src: &Document, dict: &Dictionary) -> bool {
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

// --- resources --------------------------------------------------------------------------------------------------------

/// The resources a content stream runs in, owned so that names for the objects made here can be added.
struct Res {
    dict: Dictionary,
    fonts: HashMap<Vec<u8>, Rc<Font>>,
    /// XObject names whose use was replaced, and those used as they are.
    replaced: HashSet<Vec<u8>>,
    kept: HashSet<Vec<u8>>,
}

impl Res {
    fn new(src: &Document, object: Option<&Object>) -> Self {
        let dict = object
            .and_then(|o| resolve_dict(src, o))
            .cloned()
            .unwrap_or_default();
        Self {
            dict,
            fonts: HashMap::new(),
            replaced: HashSet::new(),
            kept: HashSet::new(),
        }
    }

    fn sub_dict(&self, src: &Document, key: &[u8]) -> Option<Dictionary> {
        resolve_dict(src, self.dict.get(key).ok()?).cloned()
    }

    fn font(&mut self, src: &Document, name: &[u8]) -> Rc<Font> {
        if let Some(font) = self.fonts.get(name) {
            return font.clone();
        }
        let font = self
            .sub_dict(src, b"Font")
            .and_then(|fonts| {
                fonts
                    .get(name)
                    .ok()
                    .and_then(|f| resolve_dict(src, f))
                    .map(|f| Font::load(src, f))
            })
            .unwrap_or_else(Font::unknown);
        let font = Rc::new(font);
        self.fonts.insert(name.to_vec(), font.clone());
        font
    }

    fn xobject(&self, src: &Document, name: &[u8]) -> Option<Object> {
        self.sub_dict(src, b"XObject")?.get(name).ok().cloned()
    }

    fn set_xobject(&mut self, src: &Document, name: &[u8], value: Option<Object>) {
        let mut xobjects = self.sub_dict(src, b"XObject").unwrap_or_default();
        match value {
            Some(value) => xobjects.set(name.to_vec(), value),
            None => {
                xobjects.remove(name);
            }
        }
        self.dict.set("XObject", Object::Dictionary(xobjects));
    }

    /// The original entries of every XObject whose uses were all replaced go: they hold what the marks cover.
    fn finish(&mut self, src: &Document) {
        let gone: Vec<Vec<u8>> = self
            .replaced
            .iter()
            .filter(|name| !self.kept.contains(*name))
            .cloned()
            .collect();
        for name in gone {
            self.set_xobject(src, &name, None);
        }
    }
}

// --- the interpreter --------------------------------------------------------------------------------------------------

/// State of one redaction of one page.
struct Job<'a> {
    src: &'a Document,
    /// The marks in the user space of the page.
    rects: Vec<Box4>,
    overrides: HashMap<ObjectId, Object>,
    next_id: u32,
    ops_left: usize,
    work_left: u64,
    names: u32,
    forms: Vec<ObjectId>,
}

#[derive(Clone)]
struct Gs {
    ctm: Mat,
    font: Option<Rc<Font>>,
    size: f64,
    tc: f64,
    tw: f64,
    th: f64,
    tl: f64,
    rise: f64,
    line_width: f64,
}

#[derive(Clone)]
enum Item {
    Text(Vec<u8>),
    Adjust(f64),
}

#[derive(Clone)]
enum Seg {
    Move(f64, f64),
    Line(f64, f64),
    Curve,
    Close,
    Rect(f64, f64, f64, f64),
}

/// The path being built: its operators as they came, and what they say.
#[derive(Default)]
struct Path {
    ops: Vec<Operation>,
    segs: Vec<Seg>,
    points: Vec<(f64, f64)>,
    clip: Option<Operation>,
    bad: bool,
}

impl Job<'_> {
    fn charge(&mut self, cost: usize) -> Result<(), AppError> {
        let cost = u64::try_from(cost).unwrap_or(u64::MAX).max(1);
        self.work_left = self.work_left.checked_sub(cost).ok_or_else(too_big)?;
        Ok(())
    }

    fn hit(&mut self, b: &Box4) -> Result<bool, AppError> {
        self.charge(self.rects.len())?;
        Ok(finite_box(b) && self.rects.iter().any(|r| overlaps(b, r)))
    }

    fn fresh(&mut self, object: Object) -> ObjectId {
        let id = (self.next_id, 0);
        self.next_id = self.next_id.saturating_add(1);
        self.overrides.insert(id, object);
        id
    }

    fn new_name(&mut self, res: &Res) -> Vec<u8> {
        loop {
            self.names += 1;
            let name = format!("SheerR{}", self.names).into_bytes();
            if res.xobject(self.src, &name).is_none() {
                return name;
            }
        }
    }

    /// Runs `ops` in `ctm0`; the operators to write, and whether anything changed.
    fn run(
        &mut self,
        ops: Vec<Operation>,
        ctm0: Mat,
        res: &mut Res,
        depth: usize,
    ) -> Result<(Vec<Operation>, bool), AppError> {
        let mut out: Vec<Operation> = Vec::with_capacity(ops.len());
        let mut changed = false;
        let mut gs = Gs {
            ctm: ctm0,
            font: None,
            size: 0.0,
            tc: 0.0,
            tw: 0.0,
            th: 1.0,
            tl: 0.0,
            rise: 0.0,
            line_width: 1.0,
        };
        let mut stack: Vec<Gs> = Vec::new();
        let (mut tm, mut tlm) = (IDENTITY, IDENTITY);
        let mut path = Path::default();
        let mut open_path = false;
        for op in ops {
            self.ops_left = self.ops_left.checked_sub(1).ok_or_else(too_big)?;
            let name = op.operator.as_str();
            let building = matches!(name, "m" | "l" | "c" | "v" | "y" | "h" | "re");
            let ending = matches!(
                name,
                "S" | "s" | "f" | "F" | "f*" | "B" | "B*" | "b" | "b*" | "n"
            );
            let clipping = matches!(name, "W" | "W*");
            if open_path && !(building || ending || clipping) {
                // A path with no painting operator after it: written as it came.
                out.append(&mut path.ops);
                path = Path::default();
                open_path = false;
            }
            if building {
                open_path = true;
                self.extend_path(&mut path, &op, &gs.ctm);
                path.ops.push(op);
                continue;
            }
            if clipping {
                path.clip = Some(op);
                continue;
            }
            if ending {
                let finished = std::mem::take(&mut path);
                open_path = false;
                self.paint(finished, &op, &gs, &mut out, &mut changed)?;
                continue;
            }
            match name {
                "q" => {
                    if stack.len() >= MAX_STATE_DEPTH {
                        return Err(damaged("graphics state nesting"));
                    }
                    stack.push(gs.clone());
                    out.push(op);
                }
                "Q" => {
                    if let Some(previous) = stack.pop() {
                        gs = previous;
                        out.push(op);
                    } else {
                        changed = true; // an unmatched Q would pop the state of the caller
                    }
                }
                "cm" => {
                    let m = nums::<6>(&op.operands).ok_or_else(|| damaged("cm operands"))?;
                    gs.ctm = mul(&m, &gs.ctm);
                    out.push(op);
                }
                "w" => {
                    gs.line_width = op.operands.first().and_then(num).unwrap_or(1.0).abs();
                    out.push(op);
                }
                "BT" => {
                    tm = IDENTITY;
                    tlm = IDENTITY;
                    out.push(op);
                }
                "Tc" | "Tw" | "Tz" | "TL" | "Ts" => {
                    let value = op.operands.first().and_then(num);
                    match (name, value) {
                        ("Tc", Some(v)) => gs.tc = v,
                        ("Tw", Some(v)) => gs.tw = v,
                        ("Tz", Some(v)) => gs.th = v / 100.0,
                        ("TL", Some(v)) => gs.tl = v,
                        ("Ts", Some(v)) => gs.rise = v,
                        _ => return Err(damaged("text state operands")),
                    }
                    out.push(op);
                }
                "Tf" => {
                    let font_name = op.operands.first().and_then(|o| o.as_name().ok());
                    let size = op.operands.get(1).and_then(num);
                    let (Some(font_name), Some(size)) = (font_name, size) else {
                        return Err(damaged("Tf operands"));
                    };
                    gs.font = Some(res.font(self.src, font_name));
                    gs.size = size;
                    out.push(op);
                }
                "Td" | "TD" => {
                    let [tx, ty] = nums::<2>(&op.operands).ok_or_else(|| damaged("Td operands"))?;
                    if name == "TD" {
                        gs.tl = -ty;
                    }
                    tlm = mul(&translate(tx, ty), &tlm);
                    tm = tlm;
                    out.push(op);
                }
                "Tm" => {
                    tm = nums::<6>(&op.operands).ok_or_else(|| damaged("Tm operands"))?;
                    tlm = tm;
                    out.push(op);
                }
                "T*" => {
                    tlm = mul(&translate(0.0, -gs.tl), &tlm);
                    tm = tlm;
                    out.push(op);
                }
                "Tj" | "TJ" | "'" | "\"" => {
                    self.show(&op, &mut gs, &mut tm, &mut tlm, &mut out, &mut changed)?;
                }
                "Do" => self.do_xobject(op, &gs, res, depth, &mut out, &mut changed)?,
                "sh" => {
                    if self.shade(op, &gs, &mut out)? {
                        changed = true;
                    }
                }
                "BI" => self.inline_image(op, &gs, &mut out, &mut changed)?,
                "BDC" => {
                    // Property lists carry `/ActualText` and `/Alt`; only optional content (layers) keeps its list.
                    let tag = op.operands.first().cloned();
                    let is_layer = matches!(&tag, Some(Object::Name(n)) if n == b"OC");
                    match (is_layer, tag) {
                        (false, Some(tag @ Object::Name(_))) => {
                            out.push(Operation::new("BMC", vec![tag]));
                            changed = true;
                        }
                        _ => out.push(op),
                    }
                }
                "DP" | "MP" => changed = true,
                _ => out.push(op),
            }
        }
        if open_path {
            out.append(&mut path.ops);
        }
        // The state is closed again: a form or the page may not leave a `q` open.
        for _ in 0..stack.len() {
            out.push(Operation::new("Q", Vec::new()));
        }
        Ok((out, changed))
    }

    fn extend_path(&mut self, path: &mut Path, op: &Operation, ctm: &Mat) {
        let n = |i: usize| op.operands.get(i).and_then(num);
        let mut add = |x: f64, y: f64| path.points.push(apply(ctm, x, y));
        let needed = match op.operator.as_str() {
            "m" | "l" => 2,
            "c" => 6,
            "v" | "y" | "re" => 4,
            _ => 0,
        };
        if op.operands.len() != needed || (0..needed).any(|i| n(i).is_none()) {
            path.bad = true;
            return;
        }
        match op.operator.as_str() {
            "m" => {
                let (x, y) = (n(0).unwrap_or(0.0), n(1).unwrap_or(0.0));
                add(x, y);
                path.segs.push(Seg::Move(x, y));
            }
            "l" => {
                let (x, y) = (n(0).unwrap_or(0.0), n(1).unwrap_or(0.0));
                add(x, y);
                path.segs.push(Seg::Line(x, y));
            }
            "c" => {
                for i in 0..3 {
                    add(n(2 * i).unwrap_or(0.0), n(2 * i + 1).unwrap_or(0.0));
                }
                path.segs.push(Seg::Curve);
            }
            "v" | "y" => {
                for i in 0..2 {
                    add(n(2 * i).unwrap_or(0.0), n(2 * i + 1).unwrap_or(0.0));
                }
                path.segs.push(Seg::Curve);
            }
            "re" => {
                let (x, y, w, h) = (
                    n(0).unwrap_or(0.0),
                    n(1).unwrap_or(0.0),
                    n(2).unwrap_or(0.0),
                    n(3).unwrap_or(0.0),
                );
                add(x, y);
                add(x + w, y);
                add(x + w, y + h);
                add(x, y + h);
                path.segs.push(Seg::Rect(x, y, w, h));
            }
            _ => path.segs.push(Seg::Close),
        }
    }

    /// A path with its painting operator.
    fn paint(
        &mut self,
        path: Path,
        op: &Operation,
        gs: &Gs,
        out: &mut Vec<Operation>,
        changed: &mut bool,
    ) -> Result<(), AppError> {
        let kind = op.operator.as_str();
        if path.ops.is_empty() && path.clip.is_none() {
            out.push(op.clone());
            return Ok(());
        }
        let stroke = matches!(kind, "S" | "s" | "B" | "B*" | "b" | "b*");
        let fill = matches!(kind, "f" | "F" | "f*" | "B" | "B*" | "b" | "b*");
        let even_odd = matches!(kind, "f*" | "B*" | "b*");
        let close = matches!(kind, "s" | "b" | "b*");
        if kind == "n" && path.clip.is_none() {
            // Paints nothing and clips nothing: it is not content.
            *changed = true;
            return Ok(());
        }
        let touches = if path.bad {
            true
        } else {
            let mut b = aabb(&path.points);
            if stroke && finite_box(&b) {
                let scale = (gs.ctm[0].hypot(gs.ctm[1])).max(gs.ctm[2].hypot(gs.ctm[3]));
                let grow = (gs.line_width * scale).max(0.5);
                b = [b[0] - grow, b[1] - grow, b[2] + grow, b[3] + grow];
            }
            self.hit(&b)?
        };
        let emit_original = |out: &mut Vec<Operation>, path: Path| {
            out.extend(path.ops);
            if let Some(clip) = path.clip {
                out.push(clip);
            }
            out.push(op.clone());
        };
        if !touches {
            emit_original(out, path);
            return Ok(());
        }
        *changed = true;
        if path.bad {
            return Ok(());
        }
        if let Some(clip) = path.clip {
            // The clip stays (it paints nothing); the painting goes.
            out.extend(path.ops);
            out.push(clip);
            out.push(Operation::new("n", Vec::new()));
            return Ok(());
        }
        let Some(inverse) = invert(&gs.ctm) else {
            return Ok(());
        };
        let rects_only = path
            .segs
            .iter()
            .all(|s| matches!(s, Seg::Rect(..) | Seg::Close))
            && path.segs.iter().any(|s| matches!(s, Seg::Rect(..)));
        let axis_aligned = (gs.ctm[1].abs() < 1e-9 && gs.ctm[2].abs() < 1e-9)
            || (gs.ctm[0].abs() < 1e-9 && gs.ctm[3].abs() < 1e-9);
        let rect_count = path
            .segs
            .iter()
            .filter(|s| matches!(s, Seg::Rect(..)))
            .count();
        let lines_only = path.segs.iter().all(|s| !matches!(s, Seg::Curve));
        if fill && !(rects_only && axis_aligned && (!even_odd || rect_count == 1)) {
            return Ok(()); // dropped: a fill that is not made of rectangles
        }
        if fill {
            let mut pieces: Vec<Box4> = Vec::new();
            for seg in &path.segs {
                if let Seg::Rect(x, y, w, h) = seg {
                    let (a, b) = (apply(&gs.ctm, *x, *y), apply(&gs.ctm, x + w, y + h));
                    pieces.push(aabb(&[a, b]));
                }
            }
            let pieces = self.subtract(pieces)?;
            if pieces.len() > MAX_PIECES {
                return Ok(());
            }
            let emitted = !pieces.is_empty();
            for piece in pieces {
                let b = box_under(&inverse, &piece);
                out.push(Operation::new(
                    "re",
                    vec![real(b[0]), real(b[1]), real(b[2] - b[0]), real(b[3] - b[1])],
                ));
            }
            if emitted {
                out.push(Operation::new(
                    if even_odd { "f*" } else { "f" },
                    Vec::new(),
                ));
            }
        }
        if stroke {
            if !lines_only {
                return Ok(());
            }
            let polylines = polylines_of(&path.segs, close, &gs.ctm);
            let cut = self.cut_lines(&polylines)?;
            let any_line = !cut.is_empty();
            for line in cut {
                for (i, (x, y)) in line.iter().enumerate() {
                    let (ux, uy) = apply(&inverse, *x, *y);
                    out.push(Operation::new(
                        if i == 0 { "m" } else { "l" },
                        vec![real(ux), real(uy)],
                    ));
                }
            }
            if any_line {
                out.push(Operation::new("S", Vec::new()));
            }
        }
        Ok(())
    }

    /// `pieces` minus every mark, as rectangles.
    fn subtract(&mut self, pieces: Vec<Box4>) -> Result<Vec<Box4>, AppError> {
        let mut current = pieces;
        for index in 0..self.rects.len() {
            let x = self.rects[index];
            self.charge(current.len())?;
            let mut next = Vec::with_capacity(current.len());
            for p in current {
                if !overlaps(&p, &x) {
                    next.push(p);
                    continue;
                }
                if p[0] < x[0] {
                    next.push([p[0], p[1], x[0], p[3]]);
                }
                if p[2] > x[2] {
                    next.push([x[2], p[1], p[2], p[3]]);
                }
                let (left, right) = (p[0].max(x[0]), p[2].min(x[2]));
                if p[1] < x[1] {
                    next.push([left, p[1], right, x[1]]);
                }
                if p[3] > x[3] {
                    next.push([left, x[3], right, p[3]]);
                }
            }
            if next.len() > MAX_PIECES {
                return Ok(next);
            }
            current = next;
        }
        Ok(current)
    }

    /// The parts of `lines` (page space) that are outside every mark, as polylines.
    fn cut_lines(&mut self, lines: &[Vec<(f64, f64)>]) -> Result<Vec<Vec<(f64, f64)>>, AppError> {
        let mut out: Vec<Vec<(f64, f64)>> = Vec::new();
        for line in lines {
            let mut current: Vec<(f64, f64)> = Vec::new();
            for pair in line.windows(2) {
                let (p, q) = (pair[0], pair[1]);
                self.charge(self.rects.len())?;
                let mut inside: Vec<(f64, f64)> = Vec::new();
                for r in &self.rects {
                    if let Some(span) = clip_segment(p, q, r) {
                        inside.push(span);
                    }
                }
                inside.sort_by(|a, b| a.0.total_cmp(&b.0));
                let mut outside: Vec<(f64, f64)> = Vec::new();
                let mut from = 0.0;
                for (a, b) in inside {
                    if a > from {
                        outside.push((from, a));
                    }
                    from = from.max(b);
                }
                if from < 1.0 {
                    outside.push((from, 1.0));
                }
                let at = |t: f64| (p.0 + (q.0 - p.0) * t, p.1 + (q.1 - p.1) * t);
                let mut ended_at_one = false;
                for (a, b) in outside {
                    if b - a <= 1e-9 {
                        continue;
                    }
                    if a <= 1e-9 && !current.is_empty() {
                        current.push(at(b));
                    } else {
                        if current.len() >= 2 {
                            out.push(std::mem::take(&mut current));
                        }
                        current = vec![at(a), at(b)];
                    }
                    ended_at_one = b >= 1.0 - 1e-9;
                    if !ended_at_one && current.len() >= 2 {
                        out.push(std::mem::take(&mut current));
                    }
                }
                if !ended_at_one {
                    if current.len() >= 2 {
                        out.push(std::mem::take(&mut current));
                    } else {
                        current.clear();
                    }
                }
            }
            if current.len() >= 2 {
                out.push(current);
            }
        }
        Ok(out)
    }

    /// A show operator, cut per glyph where the font allows.
    fn show(
        &mut self,
        op: &Operation,
        gs: &mut Gs,
        tm: &mut Mat,
        tlm: &mut Mat,
        out: &mut Vec<Operation>,
        changed: &mut bool,
    ) -> Result<(), AppError> {
        let mut before: Vec<Operation> = Vec::new();
        let items: Option<Vec<Item>> = match op.operator.as_str() {
            "Tj" => match op.operands.as_slice() {
                [Object::String(bytes, _)] => Some(vec![Item::Text(bytes.clone())]),
                _ => None,
            },
            "TJ" => match op.operands.as_slice() {
                [Object::Array(list)] => list
                    .iter()
                    .map(|item| match item {
                        Object::String(bytes, _) => Some(Item::Text(bytes.clone())),
                        other => num(other).map(Item::Adjust),
                    })
                    .collect(),
                _ => None,
            },
            "'" => match op.operands.as_slice() {
                [Object::String(bytes, _)] => {
                    before.push(Operation::new("T*", Vec::new()));
                    Some(vec![Item::Text(bytes.clone())])
                }
                _ => None,
            },
            _ => match op.operands.as_slice() {
                [aw, ac, Object::String(bytes, _)] => match (num(aw), num(ac)) {
                    (Some(aw), Some(ac)) => {
                        gs.tw = aw;
                        gs.tc = ac;
                        before.push(Operation::new("Tw", vec![real(aw)]));
                        before.push(Operation::new("Tc", vec![real(ac)]));
                        before.push(Operation::new("T*", Vec::new()));
                        Some(vec![Item::Text(bytes.clone())])
                    }
                    _ => None,
                },
                _ => None,
            },
        };
        // The effect of the line move of `'` and `"` on the matrices, which happens in every case.
        if matches!(op.operator.as_str(), "'" | "\"") {
            *tlm = mul(&translate(0.0, -gs.tl), tlm);
            *tm = *tlm;
        }
        let Some(items) = items else {
            // Odd operands: the operator is not written (nothing can be said about where it would show).
            *changed = true;
            return Ok(());
        };
        let font = gs.font.clone().unwrap_or_else(|| Rc::new(Font::unknown()));
        let (size, th) = (gs.size, gs.th);
        let matrix = mul(tm, &gs.ctm);
        let glyph_lists: Vec<Option<Vec<Glyph>>> = items
            .iter()
            .map(|item| match item {
                Item::Text(bytes) => Some(font.glyphs(bytes)),
                Item::Adjust(_) => None,
            })
            .collect();
        let count: usize = glyph_lists.iter().flatten().map(Vec::len).sum();
        self.charge(count.saturating_mul(self.rects.len().max(1)))?;
        // Where each glyph is, and whether it is under a mark.
        let mut tx = 0.0;
        let mut removed: Vec<Vec<bool>> = Vec::with_capacity(items.len());
        let mut advances: Vec<Vec<f64>> = Vec::with_capacity(items.len());
        let mut any = false;
        let (top, bottom) = (font.ascent * size + gs.rise, font.descent * size + gs.rise);
        let start = tx;
        let (mut lo, mut hi) = (tx, tx);
        let mut adjust_total = 0.0f64;
        for (item, glyphs) in items.iter().zip(&glyph_lists) {
            let (mut flags, mut moves) = (Vec::new(), Vec::new());
            if let Item::Adjust(value) = item {
                adjust_total += value.abs() / 1000.0 * size.abs() * th.abs();
            }
            match (item, glyphs) {
                (Item::Adjust(value), _) => {
                    tx -= value / 1000.0 * size * th;
                    lo = lo.min(tx);
                    hi = hi.max(tx);
                }
                (Item::Text(_), Some(glyphs)) => {
                    for glyph in glyphs {
                        let drawn = glyph.width * size * th;
                        let space = if glyph.space { gs.tw } else { 0.0 };
                        let advance = drawn + (gs.tc + space) * th;
                        // Padded, and never thinner than a tenth of an em: a zero-width glyph is still drawn.
                        let em = size.abs() * th.abs();
                        let (gx0, gx1) = (
                            tx.min(tx + drawn) - 0.02 * em,
                            tx.max(tx + drawn) + 0.02 * em,
                        );
                        let gx1 = gx1.max(gx0 + 0.1 * em);
                        let pad = 0.05 * size.abs();
                        let b = box_under(
                            &matrix,
                            &[gx0, bottom.min(top) - pad, gx1, bottom.max(top) + pad],
                        );
                        let under = font.exact && self.rects.iter().any(|r| overlaps(&b, r));
                        any |= under;
                        flags.push(under);
                        moves.push(advance);
                        tx += advance;
                        lo = lo.min(tx);
                        hi = hi.max(tx);
                    }
                }
                _ => {}
            }
            removed.push(flags);
            advances.push(moves);
        }
        let end = tx;
        if !font.exact && count > 0 {
            // Widths are a guess: the whole operator goes if a conservative extent touches a mark. Every glyph may be 1.2 em wide
            // (or tall, in vertical writing) and move by the spacing; every adjustment counts in full; the boxes of the guess
            // (`lo`..`hi`) are included. Horizontal text gets 1.5 em above and below, vertical text 1.2 em either side.
            let em = size.abs() * th.abs();
            let per_glyph = 1.2 * em + (gs.tc.abs() + gs.tw.abs()) * th.abs();
            let reach = count as f64 * per_glyph + adjust_total + 1.2 * em;
            let x0 = lo.min(start - reach.min(adjust_total + 0.2 * em));
            let x1 = hi.max(start + reach);
            let tall = 1.5 * size.abs();
            let b = if font.vertical {
                let down = count as f64 * (1.2 * size.abs() + gs.tc.abs() + gs.tw.abs())
                    + adjust_total
                    + 1.2 * size.abs();
                box_under(
                    &matrix,
                    &[
                        -1.2 * em - adjust_total,
                        gs.rise - down,
                        1.2 * em + adjust_total,
                        gs.rise + tall,
                    ],
                )
            } else {
                box_under(&matrix, &[x0, gs.rise - tall, x1, gs.rise + tall])
            };
            any = self.hit(&b)?;
        }
        let total = end - start;
        *tm = mul(&translate(total, 0.0), tm);
        if !any {
            out.extend(before);
            out.push(op.clone());
            return Ok(());
        }
        *changed = true;
        out.extend(before);
        if !font.exact {
            // The guessed advance stays, so what follows keeps its place as far as it can.
            if size != 0.0 && total != 0.0 {
                let units = -total / (size * th) * 1000.0;
                out.push(Operation::new("TJ", vec![Object::Array(vec![real(units)])]));
            }
            return Ok(());
        }
        let mut array: Vec<Object> = Vec::new();
        let mut kept: Vec<u8> = Vec::new();
        let mut gap = 0.0f64;
        let flush = |array: &mut Vec<Object>, kept: &mut Vec<u8>| {
            if !kept.is_empty() {
                array.push(Object::String(
                    std::mem::take(kept),
                    StringFormat::Hexadecimal,
                ));
            }
        };
        for (index, item) in items.iter().enumerate() {
            match item {
                Item::Adjust(value) => {
                    flush(&mut array, &mut kept);
                    if gap != 0.0 {
                        array.push(real(-gap));
                        gap = 0.0;
                    }
                    array.push(real(*value));
                }
                Item::Text(bytes) => {
                    let glyphs = glyph_lists[index].as_deref().unwrap_or_default();
                    for (glyph_index, glyph) in glyphs.iter().enumerate() {
                        if removed[index][glyph_index] && size != 0.0 && th != 0.0 {
                            flush(&mut array, &mut kept);
                            gap += advances[index][glyph_index] / (size * th) * 1000.0;
                        } else if removed[index][glyph_index] {
                            // A size or width of zero has no advance to keep; the glyph is simply not written.
                        } else {
                            if gap != 0.0 {
                                flush(&mut array, &mut kept);
                                array.push(real(-gap));
                                gap = 0.0;
                            }
                            kept.extend_from_slice(&bytes[glyph.start..glyph.end]);
                        }
                    }
                }
            }
        }
        flush(&mut array, &mut kept);
        if gap != 0.0 {
            array.push(real(-gap));
        }
        if !array.is_empty() {
            out.push(Operation::new("TJ", vec![Object::Array(array)]));
        }
        Ok(())
    }

    /// `Do`: an image or a form.
    fn do_xobject(
        &mut self,
        op: Operation,
        gs: &Gs,
        res: &mut Res,
        depth: usize,
        out: &mut Vec<Operation>,
        changed: &mut bool,
    ) -> Result<(), AppError> {
        let src = self.src;
        let Some(name) = op
            .operands
            .first()
            .and_then(|o| o.as_name().ok())
            .map(<[u8]>::to_vec)
        else {
            *changed = true;
            return Ok(());
        };
        let Some(entry) = res.xobject(src, &name) else {
            out.push(op); // PDFium draws nothing for a name that is not there
            return Ok(());
        };
        let id = entry.as_reference().ok();
        let Some(Object::Stream(stream)) = resolve(src, &entry) else {
            *changed = true;
            res.replaced.insert(name);
            return Ok(());
        };
        let subtype = name_of(&stream.dict, b"Subtype").unwrap_or_default();
        let unit = [0.0, 0.0, 1.0, 1.0];
        let page_box = match subtype {
            b"Image" => box_under(&gs.ctm, &unit),
            b"Form" => {
                let matrix = mul(&matrix_of(src, stream.dict.get(b"Matrix").ok()), &gs.ctm);
                match stream.dict.get(b"BBox").ok().and_then(|b| box_of(src, b)) {
                    Some(b) => box_under(&matrix, &b),
                    None => [
                        f64::NEG_INFINITY,
                        f64::NEG_INFINITY,
                        f64::INFINITY,
                        f64::INFINITY,
                    ],
                }
            }
            _ => [
                f64::NEG_INFINITY,
                f64::NEG_INFINITY,
                f64::INFINITY,
                f64::INFINITY,
            ],
        };
        let wide = page_box[0].is_infinite();
        if !(wide || self.hit(&page_box)?) {
            res.kept.insert(name);
            out.push(op);
            return Ok(());
        }
        match subtype {
            b"Image" => {
                let Some(inverse) = invert(&gs.ctm) else {
                    *changed = true;
                    res.replaced.insert(name);
                    return Ok(());
                };
                let units = self.units_for(&page_box, &inverse)?;
                match pixels::redact_image(src, stream, &units, true) {
                    Outcome::Drop => {
                        *changed = true;
                        res.replaced.insert(name);
                    }
                    Outcome::Replace(done) => {
                        *changed = true;
                        let mut new = done.stream;
                        for (key, attached) in done.attached {
                            let attached_id = self.fresh(Object::Stream(attached));
                            new.dict.set(key, Object::Reference(attached_id));
                        }
                        let new_id = self.fresh(Object::Stream(new));
                        let fresh_name = self.new_name(res);
                        res.set_xobject(src, &fresh_name, Some(Object::Reference(new_id)));
                        res.kept.insert(fresh_name.clone());
                        res.replaced.insert(name);
                        out.push(Operation::new("Do", vec![Object::Name(fresh_name)]));
                    }
                }
            }
            b"Form" => {
                if let Some(form) = self.redact_form(stream, id, gs, res, depth)? {
                    *changed = true;
                    let new_id = self.fresh(Object::Stream(form));
                    let fresh_name = self.new_name(res);
                    res.set_xobject(src, &fresh_name, Some(Object::Reference(new_id)));
                    res.kept.insert(fresh_name.clone());
                    res.replaced.insert(name);
                    out.push(Operation::new("Do", vec![Object::Name(fresh_name)]));
                } else {
                    res.kept.insert(name.clone());
                    out.push(op);
                }
            }
            _ => {
                *changed = true;
                res.replaced.insert(name);
            }
        }
        Ok(())
    }

    /// The new stream of a form that a mark touches, or `None` if it came out the same (or could not be read and is dropped: then
    /// `Some` of an empty form). Unreadable forms are replaced by an empty one.
    fn redact_form(
        &mut self,
        stream: &Stream,
        id: Option<ObjectId>,
        gs: &Gs,
        parent: &mut Res,
        depth: usize,
    ) -> Result<Option<Stream>, AppError> {
        let src = self.src;
        let empty = || {
            let mut dict = Dictionary::new();
            dict.set("Type", Object::Name(b"XObject".to_vec()));
            dict.set("Subtype", Object::Name(b"Form".to_vec()));
            dict.set("BBox", Object::Array(vec![Object::Integer(0); 4]));
            Some(Stream::new(dict, Vec::new()))
        };
        if depth >= limits::MAX_REDACT_FORM_DEPTH || id.is_some_and(|id| self.forms.contains(&id)) {
            return Ok(empty());
        }
        let Ok(bytes) = stream.decompressed_content_with_limit(limits::MAX_REDACT_CONTENT_BYTES)
        else {
            return Ok(empty());
        };
        let Ok(content) = Content::decode_strict(&bytes) else {
            return Ok(empty());
        };
        let matrix = mul(&matrix_of(src, stream.dict.get(b"Matrix").ok()), &gs.ctm);
        if let Some(id) = id {
            self.forms.push(id);
        }
        let own = stream.dict.get(b"Resources").ok();
        let result = if let Some(own) = own {
            let mut res = Res::new(src, Some(own));
            let run = self.run(content.operations, matrix, &mut res, depth + 1);
            res.finish(src);
            run.map(|(ops, changed)| (ops, changed, Some(res.dict)))
        } else {
            self.run(content.operations, matrix, parent, depth + 1)
                .map(|(ops, changed)| (ops, changed, None))
        };
        if id.is_some() {
            self.forms.pop();
        }
        let (ops, changed, resources) = result?;
        if !changed {
            return Ok(None);
        }
        let mut dict = stream.dict.clone();
        for key in [
            &b"Filter"[..],
            b"DecodeParms",
            b"Length",
            b"Metadata",
            b"PieceInfo",
            b"StructParents",
        ] {
            dict.remove(key);
        }
        if let Some(resources) = resources {
            dict.set("Resources", Object::Dictionary(resources));
        }
        Ok(Some(Stream::new(dict, encode(&ops))))
    }

    /// The marks that touch `page_box` as regions of the unit square of an image drawn by `inverse`'s matrix.
    fn units_for(&mut self, page_box: &Box4, inverse: &Mat) -> Result<Vec<Box4>, AppError> {
        self.charge(self.rects.len())?;
        let mut units = Vec::new();
        for r in &self.rects {
            if !overlaps(page_box, r) {
                continue;
            }
            let b = box_under(inverse, r);
            let clipped = [b[0].max(0.0), b[1].max(0.0), b[2].min(1.0), b[3].min(1.0)];
            if clipped[0] < clipped[2] && clipped[1] < clipped[3] {
                units.push(clipped);
            }
        }
        Ok(units)
    }

    /// A shading: painted through a clip that leaves the marks out. True if it changed.
    fn shade(
        &mut self,
        op: Operation,
        gs: &Gs,
        out: &mut Vec<Operation>,
    ) -> Result<bool, AppError> {
        if self.rects.is_empty() {
            out.push(op);
            return Ok(false);
        }
        let Some(inverse) = invert(&gs.ctm) else {
            return Ok(true);
        };
        if self.rects.len() > MAX_SHADING_CUTS {
            return Ok(true);
        }
        out.push(Operation::new("q", Vec::new()));
        let huge = [-1.0e7, -1.0e7, 1.0e7, 1.0e7];
        for r in &self.rects {
            // The whole plane one way round, the mark the other: the clip is the plane without the mark.
            let outer = corners(&huge);
            let mut inner = corners(r);
            inner.reverse();
            for ring in [outer, inner] {
                for (i, (x, y)) in ring.iter().enumerate() {
                    let (ux, uy) = apply(&inverse, *x, *y);
                    out.push(Operation::new(
                        if i == 0 { "m" } else { "l" },
                        vec![real(ux), real(uy)],
                    ));
                }
                out.push(Operation::new("h", Vec::new()));
            }
            out.push(Operation::new("W", Vec::new()));
            out.push(Operation::new("n", Vec::new()));
        }
        out.push(op);
        out.push(Operation::new("Q", Vec::new()));
        Ok(true)
    }

    /// An inline image.
    fn inline_image(
        &mut self,
        op: Operation,
        gs: &Gs,
        out: &mut Vec<Operation>,
        changed: &mut bool,
    ) -> Result<(), AppError> {
        let Some(Object::Stream(stream)) = op.operands.first() else {
            // lopdf could not read it (a filter): it may be under a mark and cannot be cut, so it is not written.
            *changed = true;
            return Ok(());
        };
        let page_box = box_under(&gs.ctm, &[0.0, 0.0, 1.0, 1.0]);
        if !self.hit(&page_box)? {
            out.push(op);
            return Ok(());
        }
        *changed = true;
        let Some(inverse) = invert(&gs.ctm) else {
            return Ok(());
        };
        let units = self.units_for(&page_box, &inverse)?;
        if let Outcome::Replace(done) = pixels::redact_inline(stream, &units) {
            out.push(Operation::new("BI", vec![Object::Stream(done.stream)]));
        }
        Ok(())
    }
}

/// The polylines of a path of straight segments, in page space; `close` closes every subpath.
fn polylines_of(segs: &[Seg], close: bool, ctm: &Mat) -> Vec<Vec<(f64, f64)>> {
    let mut lines: Vec<Vec<(f64, f64)>> = Vec::new();
    let mut current: Vec<(f64, f64)> = Vec::new();
    let finish = |lines: &mut Vec<Vec<(f64, f64)>>, current: &mut Vec<(f64, f64)>, closed: bool| {
        if closed && current.len() > 1 {
            let first = current[0];
            current.push(first);
        }
        if current.len() > 1 {
            lines.push(std::mem::take(current));
        } else {
            current.clear();
        }
    };
    for seg in segs {
        match seg {
            Seg::Move(x, y) => {
                finish(&mut lines, &mut current, close);
                current.push(apply(ctm, *x, *y));
            }
            Seg::Line(x, y) => current.push(apply(ctm, *x, *y)),
            Seg::Close => finish(&mut lines, &mut current, true),
            Seg::Rect(x, y, w, h) => {
                finish(&mut lines, &mut current, close);
                current = vec![
                    apply(ctm, *x, *y),
                    apply(ctm, x + w, *y),
                    apply(ctm, x + w, y + h),
                    apply(ctm, *x, y + h),
                ];
                finish(&mut lines, &mut current, true);
            }
            Seg::Curve => {}
        }
    }
    finish(&mut lines, &mut current, close);
    lines
}

/// The parameter span `(t0, t1)` of the segment `p`-`q` that is inside `r` (Liang-Barsky), if it has any length.
fn clip_segment(p: (f64, f64), q: (f64, f64), r: &Box4) -> Option<(f64, f64)> {
    let (dx, dy) = (q.0 - p.0, q.1 - p.1);
    let (mut t0, mut t1) = (0.0f64, 1.0f64);
    for (d, distance) in [
        (-dx, p.0 - r[0]),
        (dx, r[2] - p.0),
        (-dy, p.1 - r[1]),
        (dy, r[3] - p.1),
    ] {
        if d == 0.0 {
            if distance <= 0.0 {
                return None;
            }
        } else {
            let t = distance / d;
            if d < 0.0 {
                t0 = t0.max(t);
            } else {
                t1 = t1.min(t);
            }
        }
    }
    (t1 - t0 > 1e-12).then_some((t0, t1))
}

// --- writing operators ------------------------------------------------------------------------------------------------

fn write_object(buffer: &mut Vec<u8>, object: &Object, depth: usize) {
    if depth > 32 {
        buffer.extend_from_slice(b"null");
        return;
    }
    match object {
        Object::Boolean(true) => buffer.extend_from_slice(b"true"),
        Object::Boolean(false) => buffer.extend_from_slice(b"false"),
        Object::Integer(i) => buffer.extend_from_slice(i.to_string().as_bytes()),
        Object::Real(r) => {
            let mut text = if r.is_finite() {
                format!("{r:.5}")
            } else {
                "0".to_owned()
            };
            if text.contains('.') {
                text = text.trim_end_matches('0').trim_end_matches('.').to_owned();
            }
            if text.is_empty() || text == "-" || text == "-0" {
                text = "0".to_owned();
            }
            buffer.extend_from_slice(text.as_bytes());
        }
        Object::Name(name) => {
            buffer.push(b'/');
            for byte in name {
                if (0x21..=0x7E).contains(byte) && !b"#()<>[]{}/%".contains(byte) {
                    buffer.push(*byte);
                } else {
                    buffer.extend_from_slice(format!("#{byte:02X}").as_bytes());
                }
            }
        }
        Object::String(bytes, _) => {
            buffer.push(b'<');
            for byte in bytes {
                buffer.extend_from_slice(format!("{byte:02X}").as_bytes());
            }
            buffer.push(b'>');
        }
        Object::Array(items) => {
            buffer.push(b'[');
            for item in items {
                write_object(buffer, item, depth + 1);
                buffer.push(b' ');
            }
            buffer.push(b']');
        }
        Object::Dictionary(dict) => {
            buffer.extend_from_slice(b"<<");
            for (key, value) in dict {
                write_object(buffer, &Object::Name(key.clone()), depth + 1);
                buffer.push(b' ');
                write_object(buffer, value, depth + 1);
                buffer.push(b' ');
            }
            buffer.extend_from_slice(b">>");
        }
        _ => buffer.extend_from_slice(b"null"),
    }
}

/// Content stream bytes for `ops`.
fn encode(ops: &[Operation]) -> Vec<u8> {
    let mut buffer = Vec::new();
    for op in ops {
        if op.operator == "BI" {
            if let Some(Object::Stream(stream)) = op.operands.first() {
                buffer.extend_from_slice(b"BI");
                for (key, value) in &stream.dict {
                    buffer.push(b' ');
                    write_object(&mut buffer, &Object::Name(key.clone()), 0);
                    buffer.push(b' ');
                    write_object(&mut buffer, value, 0);
                }
                buffer.extend_from_slice(b" ID\n");
                buffer.extend_from_slice(&stream.content);
                buffer.extend_from_slice(b"\nEI\n");
            }
            continue;
        }
        for operand in &op.operands {
            write_object(&mut buffer, operand, 0);
            buffer.push(b' ');
        }
        buffer.extend_from_slice(op.operator.as_bytes());
        buffer.push(b'\n');
    }
    buffer
}

// --- the page ---------------------------------------------------------------------------------------------------------

/// The marks in the user space of the page, clamped to `shown` (`[x0, y0, x1, y1]`). `burn` is in page space: points from the top left
/// of the shown box, before the rotation. Marks that are not numbers, are empty or lie outside are left out.
fn user_rects(shown: &Box4, burn: &[Rect]) -> Result<Vec<Box4>, AppError> {
    if burn.len() > limits::MAX_REDACT_RECTS_PER_PAGE {
        return Err(AppError::limit(
            "redactPage",
            limits::MAX_REDACT_RECTS_PER_PAGE as u64,
        ));
    }
    let mut out = Vec::with_capacity(burn.len());
    for rect in burn {
        let numbers = [rect.x, rect.y, rect.w, rect.h].map(f64::from);
        if !numbers.iter().all(|n| n.is_finite()) || rect.w < 0.0 || rect.h < 0.0 {
            continue;
        }
        let x0 = (shown[0] + numbers[0]).max(shown[0]);
        let x1 = (shown[0] + numbers[0] + numbers[2]).min(shown[2]);
        let y1 = (shown[3] - numbers[1]).min(shown[3]);
        let y0 = (shown[3] - numbers[1] - numbers[3]).max(shown[1]);
        if x0 < x1 && y0 < y1 {
            out.push([x0, y0, x1, y1]);
        }
    }
    Ok(out)
}

fn read_shown(shown: [f32; 4]) -> Result<Box4, AppError> {
    let b = shown.map(f64::from);
    if !b.iter().all(|v| v.is_finite()) || b[2] <= b[0] || b[3] <= b[1] {
        return Err(AppError::invalid("page"));
    }
    Ok(b)
}

/// The decoded content of a page: its `/Contents` streams one after another.
fn page_content(src: &Document, page: &Dictionary) -> Result<Vec<u8>, AppError> {
    let mut streams: Vec<&Stream> = Vec::new();
    match page.get(b"Contents").ok().and_then(|c| resolve(src, c)) {
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
    let mut content = Vec::new();
    for stream in streams {
        let remaining = limits::MAX_REDACT_CONTENT_BYTES.saturating_sub(content.len());
        let data = stream
            .decompressed_content_with_limit(remaining)
            .map_err(|_| damaged("page content cannot be decoded"))?;
        content.extend_from_slice(&data);
        content.push(b'\n');
    }
    Ok(content)
}

/// A one-page PDF of page `page` of `src` without what lies under `burn` (see the module documentation). The page is the shown box
/// `shown` moved to the origin, with `rotation` as its `/Rotate`.
pub fn redacted_page(
    src: &Document,
    page: ObjectId,
    shown: [f32; 4],
    rotation: u16,
    burn: &[Rect],
) -> Result<Vec<u8>, AppError> {
    let shown = read_shown(shown)?;
    let rects = user_rects(&shown, burn)?;
    let mut dict = src
        .get_dictionary(page)
        .map_err(|_| damaged("page"))?
        .clone();
    materialize_inherited(src, &mut dict);
    let content = page_content(src, &dict)?;
    let parsed = Content::decode_strict(&content)
        .map_err(|_| damaged("page content does not parse"))?
        .operations;
    drop(content);
    let max_id = src.objects.keys().map(|id| id.0).max().unwrap_or(0);
    let mut job = Job {
        src,
        rects: rects.clone(),
        overrides: HashMap::new(),
        next_id: max_id.saturating_add(1),
        ops_left: limits::MAX_REDACT_OPS,
        work_left: limits::MAX_REDACT_WORK,
        names: 0,
        forms: Vec::new(),
    };
    let mut res = Res::new(src, dict.get(b"Resources").ok());
    let (mut ops, _) = job.run(parsed, IDENTITY, &mut res, 0)?;
    res.finish(src);
    // The page is moved to the origin, and the marks are painted black on top.
    let (dx, dy) = (-shown[0], -shown[1]);
    let moved = dx != 0.0 || dy != 0.0;
    if moved {
        ops.insert(
            0,
            Operation::new(
                "cm",
                vec![
                    real(1.0),
                    real(0.0),
                    real(0.0),
                    real(1.0),
                    real(dx),
                    real(dy),
                ],
            ),
        );
        ops.insert(0, Operation::new("q", Vec::new()));
        ops.push(Operation::new("Q", Vec::new()));
    }
    if !rects.is_empty() {
        ops.push(Operation::new("q", Vec::new()));
        ops.push(Operation::new("g", vec![Object::Integer(0)]));
        for r in &rects {
            ops.push(Operation::new(
                "re",
                vec![
                    real(r[0] + dx),
                    real(r[1] + dy),
                    real(r[2] - r[0]),
                    real(r[3] - r[1]),
                ],
            ));
        }
        ops.push(Operation::new("f", Vec::new()));
        ops.push(Operation::new("Q", Vec::new()));
    }
    let contents_id = job.fresh(Object::Stream(Stream::new(Dictionary::new(), encode(&ops))));
    for key in [
        &b"Annots"[..],
        b"CropBox",
        b"TrimBox",
        b"BleedBox",
        b"ArtBox",
        b"AA",
        b"Thumb",
        b"PieceInfo",
        b"Metadata",
        b"StructParents",
        b"B",
        b"Parent",
        b"LastModified",
    ] {
        dict.remove(key);
    }
    dict.set("Contents", Object::Reference(contents_id));
    dict.set("Resources", Object::Dictionary(res.dict));
    dict.set(
        "MediaBox",
        Object::Array(vec![
            Object::Integer(0),
            Object::Integer(0),
            real(shown[2] - shown[0]),
            real(shown[3] - shown[1]),
        ]),
    );
    dict.set("Rotate", Object::Integer(i64::from(rotation % 360)));
    dict.set(MARKER.to_vec(), Object::Boolean(true));
    let overrides = std::mem::take(&mut job.overrides);
    let mut target = Document::with_version("1.5");
    let mut budget = 0usize;
    let new_page = copy_page_with(src, page, dict, overrides, &mut target, &mut budget)?;
    finish_document(target, new_page)
}

/// A one-page PDF of a blank page of `size` with the marks painted black (a blank page has nothing to cut).
pub fn redacted_blank(size: [f32; 2], rotation: u16, burn: &[Rect]) -> Result<Vec<u8>, AppError> {
    let shown = read_shown([0.0, 0.0, size[0], size[1]])?;
    let rects = user_rects(&shown, burn)?;
    let mut target = Document::with_version("1.5");
    let mut ops: Vec<Operation> = Vec::new();
    if !rects.is_empty() {
        ops.push(Operation::new("g", vec![Object::Integer(0)]));
        for r in &rects {
            ops.push(Operation::new(
                "re",
                vec![real(r[0]), real(r[1]), real(r[2] - r[0]), real(r[3] - r[1])],
            ));
        }
        ops.push(Operation::new("f", Vec::new()));
    }
    let contents = target.add_object(Stream::new(Dictionary::new(), encode(&ops)));
    let mut dict = Dictionary::new();
    dict.set("Type", Object::Name(b"Page".to_vec()));
    dict.set(
        "MediaBox",
        Object::Array(vec![
            Object::Integer(0),
            Object::Integer(0),
            real(shown[2]),
            real(shown[3]),
        ]),
    );
    dict.set("Resources", Object::Dictionary(Dictionary::new()));
    dict.set("Contents", Object::Reference(contents));
    dict.set("Rotate", Object::Integer(i64::from(rotation % 360)));
    dict.set(MARKER.to_vec(), Object::Boolean(true));
    let page = target.add_object(dict);
    finish_document(target, page)
}

/// Wraps `page` of `target` in a catalog and a page tree and writes the file.
fn finish_document(mut target: Document, page: ObjectId) -> Result<Vec<u8>, AppError> {
    let pages_id = target.new_object_id();
    if let Ok(dict) = target.get_dictionary_mut(page) {
        dict.set("Parent", Object::Reference(pages_id));
    }
    let mut pages = Dictionary::new();
    pages.set("Type", Object::Name(b"Pages".to_vec()));
    pages.set("Kids", Object::Array(vec![Object::Reference(page)]));
    pages.set("Count", Object::Integer(1));
    target.objects.insert(pages_id, Object::Dictionary(pages));
    let mut catalog = Dictionary::new();
    catalog.set("Type", Object::Name(b"Catalog".to_vec()));
    catalog.set("Pages", Object::Reference(pages_id));
    let catalog_id = target.add_object(catalog);
    target.trailer.set("Root", Object::Reference(catalog_id));
    let mut out = Vec::new();
    target
        .save_to(&mut out)
        .map_err(|error| AppError::logged(ErrorCode::SaveFailed, format!("lopdf: {error}")))?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x: f32, y: f32, w: f32, h: f32) -> Rect {
        Rect { x, y, w, h }
    }

    /// A one-page document with `content` and a Helvetica without widths as `/F1`.
    fn page_doc(content: &str) -> (Document, ObjectId) {
        page_doc_with(content, |_| {})
    }

    /// As [`page_doc`], with `font` able to change the dictionary of `/F1`.
    fn page_doc_with(content: &str, tweak: impl FnOnce(&mut Dictionary)) -> (Document, ObjectId) {
        let mut doc = Document::with_version("1.5");
        let contents = doc.add_object(Stream::new(Dictionary::new(), content.as_bytes().to_vec()));
        let font = {
            let mut d = Dictionary::new();
            d.set("Type", Object::Name(b"Font".to_vec()));
            d.set("Subtype", Object::Name(b"Type1".to_vec()));
            d.set("BaseFont", Object::Name(b"Helvetica".to_vec()));
            tweak(&mut d);
            doc.add_object(d)
        };
        let mut fonts = Dictionary::new();
        fonts.set("F1", Object::Reference(font));
        let mut resources = Dictionary::new();
        resources.set("Font", Object::Dictionary(fonts));
        let pages_id = doc.new_object_id();
        let mut page = Dictionary::new();
        page.set("Type", Object::Name(b"Page".to_vec()));
        page.set("Parent", Object::Reference(pages_id));
        page.set(
            "MediaBox",
            Object::Array(vec![
                Object::Integer(0),
                Object::Integer(0),
                Object::Integer(200),
                Object::Integer(200),
            ]),
        );
        page.set("Resources", Object::Dictionary(resources));
        page.set("Contents", Object::Reference(contents));
        let page_id = doc.add_object(page);
        let mut pages = Dictionary::new();
        pages.set("Type", Object::Name(b"Pages".to_vec()));
        pages.set("Kids", Object::Array(vec![Object::Reference(page_id)]));
        pages.set("Count", Object::Integer(1));
        doc.objects.insert(pages_id, Object::Dictionary(pages));
        let catalog = {
            let mut d = Dictionary::new();
            d.set("Type", Object::Name(b"Catalog".to_vec()));
            d.set("Pages", Object::Reference(pages_id));
            doc.add_object(d)
        };
        doc.trailer.set("Root", Object::Reference(catalog));
        (doc, page_id)
    }

    /// The decoded content of the only page of `bytes`.
    fn content_of(bytes: &[u8]) -> String {
        let doc = crate::pdfwrite::prescan::load_untrusted(bytes).unwrap();
        let page = *doc.get_pages().values().next().unwrap();
        String::from_utf8_lossy(&doc.get_page_content(page)).into_owned()
    }

    fn run(content: &str, burn: &[Rect]) -> String {
        let (doc, page) = page_doc(content);
        let bytes = redacted_page(&doc, page, [0.0, 0.0, 200.0, 200.0], 0, burn).unwrap();
        content_of(&bytes)
    }

    #[test]
    fn text_outside_the_mark_stays_and_the_glyphs_under_it_go() {
        // Helvetica 10 pt at x 10: "ABCDEFGH" is 667 667 722 722 667 611 778 722 wide = 6.67 6.67 7.22 ... pt.
        // "C" starts at 10 + 13.34 = 23.34 and ends at 30.56; the mark covers x 24..30, so only C is under it.
        let content = "BT /F1 10 Tf 10 100 Td (ABCDEFGH) Tj ET";
        let out = run(content, &[rect(24.0, 90.0, 6.0, 12.0)]);
        assert!(out.contains("<4142>"), "A and B stay: {out}");
        assert!(out.contains("<4445464748>"), "D to H stay: {out}");
        assert!(!out.contains("43"), "C is gone: {out}");
        // The advance of C (722) is a kerning number between the two parts.
        assert!(out.contains("-722"), "{out}");
    }

    fn name_object(text: &[u8]) -> Object {
        Object::Name(text.to_vec())
    }

    fn run_with(content: &str, tweak: impl FnOnce(&mut Dictionary), burn: &[Rect]) -> String {
        let (doc, page) = page_doc_with(content, tweak);
        let bytes = redacted_page(&doc, page, [0.0, 0.0, 200.0, 200.0], 0, burn).unwrap();
        content_of(&bytes)
    }

    #[test]
    fn a_tj_adjustment_moves_the_glyphs_under_the_mark_and_they_still_go() {
        // Helvetica 10 pt at x 10: "abc" then a gap of 50 pt, so "secret" starts near x 10 + 15 + 50 = 75 (user y 100..110).
        let content = "BT /F1 10 Tf 10 100 Td [(abc) -5000 (secret)] TJ ET";
        let out = run(content, &[rect(78.0, 90.0, 12.0, 12.0)]);
        assert!(out.contains("<616263>"), "abc stays: {out}");
        assert!(!out.contains("736563726574"), "secret is not whole: {out}");
        assert!(
            !out.contains("<73>") && !out.contains("<656372>"),
            "the glyphs under the mark are gone: {out}"
        );
        // A font with unknown widths: the whole operator goes when the extent can reach the mark, the gap included.
        let out = run_with(
            "BT /F1 10 Tf 10 100 Td [(abc) -20000 (secret)] TJ ET",
            |d| d.set("BaseFont", name_object(b"Helvetica-Bold")),
            &[rect(150.0, 90.0, 20.0, 12.0)],
        );
        assert!(
            !out.contains("736563726574") && !out.contains("616263"),
            "{out}"
        );
    }

    #[test]
    fn vertical_and_type3_text_are_cut_per_operator_with_a_conservative_box() {
        let vertical = |d: &mut Dictionary| {
            d.set("Subtype", name_object(b"Type0"));
            d.set("Encoding", name_object(b"Identity-V"));
            let mut descendant = Dictionary::new();
            descendant.set("Type", name_object(b"Font"));
            descendant.set("Subtype", name_object(b"CIDFontType2"));
            descendant.set("DW", Object::Integer(1000));
            d.set(
                "DescendantFonts",
                Object::Array(vec![Object::Dictionary(descendant)]),
            );
        };
        // Vertical glyphs run down from y 190; the mark is far below the first glyph.
        let out = run_with(
            "BT /F1 10 Tf 100 190 Td <00410042004300440045> Tj ET",
            vertical,
            &[rect(95.0, 40.0, 20.0, 10.0)],
        );
        assert!(!out.contains("0041"), "{out}");
        let type3 = |d: &mut Dictionary| {
            d.set("Subtype", name_object(b"Type3"));
            d.set(
                "FontMatrix",
                Object::Array(vec![
                    Object::Real(0.001),
                    Object::Integer(0),
                    Object::Integer(0),
                    Object::Real(0.001),
                    Object::Integer(0),
                    Object::Integer(0),
                ]),
            );
            d.set("Widths", Object::Array(vec![Object::Integer(0)]));
            d.set("FirstChar", Object::Integer(65));
        };
        let out = run_with(
            "BT /F1 10 Tf 100 100 Td (AAA) Tj ET",
            type3,
            &[rect(95.0, 88.0, 15.0, 14.0)],
        );
        assert!(!out.contains("414141"), "{out}");
    }

    #[test]
    fn a_mark_far_from_the_text_changes_nothing_but_the_black_box() {
        let out = run(
            "BT /F1 10 Tf 10 100 Td (Hello) Tj ET",
            &[rect(150.0, 10.0, 20.0, 20.0)],
        );
        assert!(
            out.contains("Hello") || out.contains("<48656C6C6F>") || out.contains("Tj"),
            "{out}"
        );
        assert!(out.contains(" re"), "the black box is drawn");
    }

    #[test]
    fn a_line_is_cut_at_the_mark_and_a_filled_rectangle_has_a_hole() {
        // A horizontal line from x 10 to 190 at y 50; the mark covers x 90..110 (page space y from the top: 150 - 10..150 + 10).
        let content = "1 w 10 50 m 190 50 l S 0.5 g 10 120 180 40 re f";
        let out = run(content, &[rect(90.0, 140.0, 20.0, 20.0)]);
        assert!(
            !out.contains("10 50 m 190 50 l"),
            "the whole line is gone: {out}"
        );
        assert!(
            out.contains("90 50 l") || out.contains("90.0 50 l"),
            "{out}"
        );
        assert!(out.contains("110 50 m"), "{out}");
        // The mark is at y (200 - 140 - 20) = 40 to 60: the rectangle at y 120..160 is not touched.
        assert!(out.contains("10 120 180 40 re"), "{out}");
        // Now a rectangle that is crossed.
        let out = run("0.5 g 10 30 180 40 re f", &[rect(90.0, 140.0, 20.0, 20.0)]);
        assert!(!out.contains("10 30 180 40 re"), "{out}");
        assert!(out.contains("re"), "{out}");
    }

    #[test]
    fn a_curve_under_a_mark_is_dropped_and_one_outside_stays() {
        let content = "10 10 m 20 40 60 40 90 10 c S 150 150 m 160 190 180 190 190 150 c S";
        let out = run(content, &[rect(10.0, 140.0, 80.0, 50.0)]);
        assert!(!out.contains("20 40 60 40 90 10 c"), "{out}");
        assert!(out.contains("160 190 180 190 190 150 c"), "{out}");
    }

    #[test]
    fn marked_content_properties_and_annotations_are_not_kept() {
        let content = "/Span <</ActualText (SECRET)>> BDC BT /F1 10 Tf 10 100 Td (x) Tj ET EMC";
        let out = run(content, &[rect(150.0, 10.0, 20.0, 20.0)]);
        assert!(
            !out.contains("SECRET") && !out.contains("5345435245"),
            "{out}"
        );
        assert!(out.contains("BMC"), "{out}");
    }

    #[test]
    fn a_form_is_cut_into_a_copy_and_an_image_is_blacked_out() {
        let (mut doc, page) = page_doc("q 100 0 0 100 50 50 cm /Im1 Do Q /Fm1 Do");
        let mut image = Dictionary::new();
        image.set("Subtype", Object::Name(b"Image".to_vec()));
        image.set("Width", Object::Integer(10));
        image.set("Height", Object::Integer(10));
        image.set("BitsPerComponent", Object::Integer(8));
        image.set("ColorSpace", Object::Name(b"DeviceGray".to_vec()));
        let image_id = doc.add_object(Stream::new(image, vec![200u8; 100]));
        let mut form = Dictionary::new();
        form.set("Subtype", Object::Name(b"Form".to_vec()));
        form.set(
            "BBox",
            Object::Array(vec![
                Object::Integer(0),
                Object::Integer(0),
                Object::Integer(200),
                Object::Integer(200),
            ]),
        );
        let form_id = doc.add_object(Stream::new(
            form,
            b"BT /F1 10 Tf 10 20 Td (INSIDE) Tj ET".to_vec(),
        ));
        let mut xobjects = Dictionary::new();
        xobjects.set("Im1", Object::Reference(image_id));
        xobjects.set("Fm1", Object::Reference(form_id));
        if let Ok(page_dict) = doc.get_dictionary_mut(page) {
            if let Ok(Object::Dictionary(resources)) = page_dict.get_mut(b"Resources") {
                resources.set("XObject", Object::Dictionary(xobjects));
            }
        }
        // The mark: the top left quarter of the image (page y 0..50 from the top = user y 150..200 ... image at 50..150).
        let burn = [rect(50.0, 50.0, 50.0, 50.0), rect(5.0, 170.0, 100.0, 25.0)];
        let bytes = redacted_page(&doc, page, [0.0, 0.0, 200.0, 200.0], 0, &burn).unwrap();
        let out = crate::pdfwrite::prescan::load_untrusted(&bytes).unwrap();
        let xobjects: Vec<&Stream> = out
            .objects
            .values()
            .filter_map(|o| o.as_stream().ok())
            .filter(|s| s.dict.has(b"Subtype"))
            .collect();
        let image = xobjects
            .iter()
            .find(|s| name_of(&s.dict, b"Subtype") == Some(b"Image".as_slice()))
            .expect("the image is still there");
        let data = image.decompressed_content().unwrap();
        assert_eq!(data.len(), 100);
        assert_eq!(
            xobjects
                .iter()
                .filter(|s| name_of(&s.dict, b"Subtype") == Some(b"Image".as_slice()))
                .count(),
            1,
            "the original image is not in the file next to the new one"
        );
        assert_eq!(data[0], 0, "the top left pixel is under the first mark");
        assert_eq!(data[99], 200, "the bottom right pixel is not");
        for object in out.objects.values() {
            if let Object::Stream(stream) = object {
                let text = stream.decompressed_content().unwrap_or_default();
                let text = String::from_utf8_lossy(&text).to_string();
                assert!(
                    !text.contains("494E5349") && !text.contains("INSIDE"),
                    "{text}"
                );
            }
        }
        assert!(data.contains(&0), "something is blacked out");
        assert!(data.contains(&200), "something is kept");
    }

    #[test]
    fn a_page_that_does_not_parse_is_refused_and_never_a_picture() {
        let (doc, page) = page_doc("BT /F1 10 Tf (unterminated Tj");
        let error = redacted_page(
            &doc,
            page,
            [0.0, 0.0, 200.0, 200.0],
            0,
            &[rect(0.0, 0.0, 5.0, 5.0)],
        );
        assert!(error.is_err());
    }

    #[test]
    fn marks_that_are_not_numbers_or_outside_the_page_are_ignored() {
        let rects = user_rects(
            &[0.0, 0.0, 100.0, 100.0],
            &[
                rect(f32::NAN, 0.0, 1.0, 1.0),
                rect(500.0, 500.0, 5.0, 5.0),
                rect(-10.0, -10.0, 20.0, 20.0),
            ],
        )
        .unwrap();
        assert_eq!(rects, vec![[0.0, 90.0, 10.0, 100.0]]);
    }

    #[test]
    fn the_page_is_moved_to_the_origin_when_its_box_does_not_start_there() {
        let (doc, page) = page_doc("BT /F1 10 Tf 60 100 Td (Hi) Tj ET");
        let bytes = redacted_page(
            &doc,
            page,
            [50.0, 50.0, 150.0, 150.0],
            90,
            &[rect(0.0, 0.0, 5.0, 5.0)],
        )
        .unwrap();
        let out = crate::pdfwrite::prescan::load_untrusted(&bytes).unwrap();
        let pid = *out.get_pages().values().next().unwrap();
        let dict = out.get_dictionary(pid).unwrap();
        assert_eq!(dict.get(b"Rotate").unwrap().as_i64().unwrap(), 90);
        let media = dict.get(b"MediaBox").unwrap().as_array().unwrap();
        assert_eq!(media[2].as_float().unwrap(), 100.0);
        let content = content_of(&bytes);
        assert!(content.contains("1 0 0 1 -50 -50 cm"), "{content}");
    }
}
