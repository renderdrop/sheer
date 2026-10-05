//! Content-stream walk of the text-editing spike: follows the text state through the page (and the Form XObjects it draws), decodes
//! every shown string to Unicode and positions each code, so a word can be found even when its glyphs are split over several
//! strings, `TJ` elements or operators.

use std::collections::HashMap;
use std::rc::Rc;

use lopdf::content::{Content, Operation};
use lopdf::{Dictionary, Document, Object, ObjectId};

use super::font::FontInfo;

pub const MAX_CONTENT_BYTES: usize = 64 * 1024 * 1024;
const MAX_OPS: usize = 2_000_000;
const MAX_GLYPHS: usize = 3_000_000;
const MAX_UNITS: usize = 64;
const MAX_DEPTH: usize = 8;
const MAX_STACK: usize = 256;

pub type Mat = [f64; 6];
const IDENTITY: Mat = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];

/// `a` applied first, then `b` (row-vector convention of PDF).
pub fn mul(a: &Mat, b: &Mat) -> Mat {
    [
        a[0] * b[0] + a[1] * b[2],
        a[0] * b[1] + a[1] * b[3],
        a[2] * b[0] + a[3] * b[2],
        a[2] * b[1] + a[3] * b[3],
        a[4] * b[0] + a[5] * b[2] + b[4],
        a[4] * b[1] + a[5] * b[3] + b[5],
    ]
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Target {
    Page(ObjectId),
    Form(ObjectId),
}

/// One shown string (a `Tj` string or one string element of a `TJ`).
#[derive(Debug)]
pub struct Site {
    pub op: usize,
    pub elem: Option<usize>,
    pub font: Rc<FontInfo>,
    pub font_name: Vec<u8>,
    pub size: f64,
    pub tc: f64,
    pub th: f64,
    pub invisible: bool,
    /// Device length of one text-space unit, and the unit direction of the baseline on the page.
    pub scale: f64,
    pub ddir: [f64; 2],
    /// `a` and `b` of the text matrix: where one text-space unit goes in user space.
    pub tm_ab: [f64; 2],
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Char,
    /// A visible gap between two runs that has no space code (inserted for matching only).
    Gap,
    Break,
}

#[derive(Debug)]
pub struct Glyph {
    pub kind: Kind,
    pub ch: char,
    pub site: usize,
    pub start: usize,
    pub end: usize,
    /// First and last char of its code (a ligature code has several chars).
    pub first: bool,
    pub last: bool,
    /// Advance of the code in text space units (points at scale 1), on the last char only.
    pub adv: f64,
    /// Device positions of the origin and the end of the advance (chars only).
    pub p0: [f64; 2],
    pub p1: [f64; 2],
}

/// A content stream with everything the walk found in it.
pub struct Unit {
    pub target: Target,
    pub ops: Vec<Operation>,
    pub resources: Dictionary,
    pub sites: Vec<Site>,
    pub glyphs: Vec<Glyph>,
}

#[derive(Clone)]
struct State {
    ctm: Mat,
    font: Option<Rc<FontInfo>>,
    font_name: Vec<u8>,
    size: f64,
    tc: f64,
    tw: f64,
    th: f64,
    tl: f64,
    tr: i64,
}

pub enum ScanError {
    Unparseable,
    Limit(&'static str),
}

pub struct Scanner<'a> {
    pub doc: &'a Document,
    pub units: Vec<Unit>,
    ops_seen: usize,
    glyphs_seen: usize,
}

fn deref<'a>(doc: &'a Document, object: &'a Object) -> Option<&'a Object> {
    doc.dereference(object).ok().map(|(_, o)| o)
}

fn num(object: &Object) -> Option<f64> {
    match object {
        Object::Integer(i) => Some(*i as f64),
        Object::Real(r) => Some(f64::from(*r)),
        _ => None,
    }
}

fn nums<const N: usize>(operands: &[Object]) -> Option<[f64; N]> {
    let mut out = [0.0; N];
    if operands.len() < N {
        return None;
    }
    for (slot, o) in out.iter_mut().zip(operands) {
        *slot = num(o).filter(|v| v.is_finite())?;
    }
    Some(out)
}

/// The inherited `/Resources` of a page.
pub fn page_resources(doc: &Document, page: ObjectId) -> Dictionary {
    let mut at = page;
    for _ in 0..64 {
        let Ok(dict) = doc.get_dictionary(at) else {
            break;
        };
        if let Ok(res) = dict.get(b"Resources") {
            if let Some(Object::Dictionary(d)) = deref(doc, res) {
                return d.clone();
            }
        }
        match dict.get(b"Parent") {
            Ok(Object::Reference(parent)) => at = *parent,
            _ => break,
        }
    }
    Dictionary::new()
}

/// The decoded content of a page (all `/Contents` streams joined).
pub fn page_content(doc: &Document, page: ObjectId) -> Result<Vec<u8>, ScanError> {
    doc.get_page_content_with_limit(page, MAX_CONTENT_BYTES)
        .map_err(|_| ScanError::Unparseable)
}

impl<'a> Scanner<'a> {
    pub fn new(doc: &'a Document) -> Self {
        Self {
            doc,
            units: Vec::new(),
            ops_seen: 0,
            glyphs_seen: 0,
        }
    }

    /// Walks the content of `target` and every Form XObject it draws.
    pub fn scan(
        &mut self,
        target: Target,
        content: &[u8],
        resources: Dictionary,
        ctm: Mat,
        depth: usize,
    ) -> Result<(), ScanError> {
        if depth > MAX_DEPTH || self.units.len() >= MAX_UNITS {
            return Err(ScanError::Limit("form nesting"));
        }
        let ops = Content::decode(content)
            .map_err(|_| ScanError::Unparseable)?
            .operations;
        self.ops_seen += ops.len();
        if self.ops_seen > MAX_OPS {
            return Err(ScanError::Limit("operators"));
        }
        let mut unit = Unit {
            target,
            ops: Vec::new(),
            resources,
            sites: Vec::new(),
            glyphs: Vec::new(),
        };
        let mut forms: Vec<(usize, ObjectId, Mat)> = Vec::new();
        self.walk(&ops, &mut unit, ctm, &mut forms)?;
        unit.ops = ops;
        let resources = unit.resources.clone();
        self.units.push(unit);
        for (_, id, form_ctm) in forms {
            let Some(Object::Stream(stream)) = self.doc.get_object(id).ok() else {
                continue;
            };
            let data = stream
                .decompressed_content_with_limit(MAX_CONTENT_BYTES)
                .map_err(|_| ScanError::Unparseable)?;
            let own = stream
                .dict
                .get(b"Resources")
                .ok()
                .and_then(|r| deref(self.doc, r))
                .and_then(|r| r.as_dict().ok())
                .cloned()
                .unwrap_or_else(|| resources.clone());
            self.scan(Target::Form(id), &data, own, form_ctm, depth + 1)?;
        }
        Ok(())
    }

    fn font_of(
        &self,
        unit: &Unit,
        cache: &mut HashMap<Vec<u8>, Rc<FontInfo>>,
        name: &[u8],
    ) -> Option<Rc<FontInfo>> {
        if let Some(found) = cache.get(name) {
            return Some(Rc::clone(found));
        }
        let fonts = unit.resources.get(b"Font").ok()?;
        let fonts = deref(self.doc, fonts)?.as_dict().ok()?;
        let dict = deref(self.doc, fonts.get(name).ok()?)?.as_dict().ok()?;
        let info = Rc::new(FontInfo::load(self.doc, dict));
        cache.insert(name.to_vec(), Rc::clone(&info));
        Some(info)
    }

    #[allow(clippy::too_many_lines)]
    fn walk(
        &mut self,
        ops: &[Operation],
        unit: &mut Unit,
        ctm: Mat,
        forms: &mut Vec<(usize, ObjectId, Mat)>,
    ) -> Result<(), ScanError> {
        let mut cache: HashMap<Vec<u8>, Rc<FontInfo>> = HashMap::new();
        let mut state = State {
            ctm,
            font: None,
            font_name: Vec::new(),
            size: 0.0,
            tc: 0.0,
            tw: 0.0,
            th: 1.0,
            tl: 0.0,
            tr: 0,
        };
        let mut stack: Vec<State> = Vec::new();
        let (mut tm, mut tlm) = (IDENTITY, IDENTITY);
        let mut prev: Option<([f64; 2], f64, [f64; 2])> = None;
        for (index, op) in ops.iter().enumerate() {
            let a = &op.operands;
            match op.operator.as_str() {
                "q" => {
                    if stack.len() >= MAX_STACK {
                        return Err(ScanError::Limit("graphics state depth"));
                    }
                    stack.push(state.clone());
                }
                "Q" => {
                    if let Some(s) = stack.pop() {
                        state = s;
                    }
                }
                "cm" => {
                    if let Some(m) = nums::<6>(a) {
                        state.ctm = mul(&m, &state.ctm);
                    }
                }
                "BT" => {
                    tm = IDENTITY;
                    tlm = IDENTITY;
                }
                "Tf" => {
                    if let (Some(Object::Name(n)), Some(size)) = (a.first(), a.get(1).and_then(num))
                    {
                        state.font = self.font_of(unit, &mut cache, n);
                        state.font_name = n.clone();
                        state.size = size;
                    }
                }
                "Tc" => state.tc = a.first().and_then(num).unwrap_or(0.0),
                "Tw" => state.tw = a.first().and_then(num).unwrap_or(0.0),
                "Tz" => state.th = a.first().and_then(num).unwrap_or(100.0) / 100.0,
                "TL" => state.tl = a.first().and_then(num).unwrap_or(0.0),
                "Tr" => state.tr = a.first().and_then(num).map_or(0, |v| v as i64),
                "Td" | "TD" => {
                    if let Some([x, y]) = nums::<2>(a) {
                        if op.operator == "TD" {
                            state.tl = -y;
                        }
                        tlm = mul(&[1.0, 0.0, 0.0, 1.0, x, y], &tlm);
                        tm = tlm;
                    }
                }
                "Tm" => {
                    if let Some(m) = nums::<6>(a) {
                        tm = m;
                        tlm = m;
                    }
                }
                "T*" => {
                    tlm = mul(&[1.0, 0.0, 0.0, 1.0, 0.0, -state.tl], &tlm);
                    tm = tlm;
                }
                "Tj" | "'" | "\"" | "TJ" => {
                    if matches!(op.operator.as_str(), "'" | "\"") {
                        if op.operator == "\"" {
                            if let Some([aw, ac]) = nums::<2>(a) {
                                state.tw = aw;
                                state.tc = ac;
                            }
                        }
                        tlm = mul(&[1.0, 0.0, 0.0, 1.0, 0.0, -state.tl], &tlm);
                        tm = tlm;
                    }
                    let Some(font) = state.font.clone() else {
                        continue;
                    };
                    let mut shown = |elem: Option<usize>, bytes: &[u8], tm: &mut Mat| -> bool {
                        let room = MAX_GLYPHS.saturating_sub(self.glyphs_seen);
                        if room == 0 || unit.sites.len() >= MAX_GLYPHS {
                            return true;
                        }
                        let site = unit.sites.len();
                        unit.sites.push(Site {
                            op: index,
                            elem,
                            font: Rc::clone(&font),
                            font_name: state.font_name.clone(),
                            size: state.size,
                            tc: state.tc,
                            th: state.th,
                            invisible: state.tr == 3,
                            scale: mul(tm, &state.ctm)[0].hypot(mul(tm, &state.ctm)[1]),
                            ddir: unit_dir(&mul(tm, &state.ctm)),
                            tm_ab: [tm[0], tm[1]],
                        });
                        let before = unit.glyphs.len();
                        show(
                            &state,
                            &font,
                            bytes,
                            site,
                            tm,
                            &mut prev,
                            &mut unit.glyphs,
                            room,
                        );
                        self.glyphs_seen += unit.glyphs.len() - before;
                        self.glyphs_seen >= MAX_GLYPHS
                    };
                    match op.operator.as_str() {
                        "TJ" => {
                            if let Some(Object::Array(items)) = a.first() {
                                for (k, item) in items.iter().enumerate() {
                                    match item {
                                        Object::String(bytes, _) => {
                                            if shown(Some(k), bytes, &mut tm) {
                                                return Err(ScanError::Limit("glyphs"));
                                            }
                                        }
                                        other => {
                                            if let Some(n) = num(other) {
                                                let tx = -n / 1000.0 * state.size * state.th;
                                                tm = mul(&[1.0, 0.0, 0.0, 1.0, tx, 0.0], &tm);
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        _ => {
                            if let Some(Object::String(bytes, _)) = a.last() {
                                if shown(None, bytes, &mut tm) {
                                    return Err(ScanError::Limit("glyphs"));
                                }
                            }
                        }
                    }
                }
                "Do" => {
                    let Some(Object::Name(n)) = a.first() else {
                        continue;
                    };
                    let xobjects = unit
                        .resources
                        .get(b"XObject")
                        .ok()
                        .and_then(|x| deref(self.doc, x))
                        .and_then(|x| x.as_dict().ok());
                    let Some(Object::Reference(id)) = xobjects.and_then(|x| x.get(n).ok()) else {
                        continue;
                    };
                    if let Ok(Object::Stream(s)) = self.doc.get_object(*id) {
                        if s.dict.get(b"Subtype").ok() == Some(&Object::Name(b"Form".to_vec())) {
                            let m = s
                                .dict
                                .get(b"Matrix")
                                .ok()
                                .and_then(|m| deref(self.doc, m))
                                .and_then(|m| m.as_array().ok())
                                .map(|m| {
                                    m.iter().map(|v| num(v).unwrap_or(0.0)).collect::<Vec<_>>()
                                })
                                .and_then(|m| <[f64; 6]>::try_from(m).ok())
                                .unwrap_or(IDENTITY);
                            forms.push((index, *id, mul(&m, &state.ctm)));
                        }
                    }
                }
                _ => {}
            }
        }
        Ok(())
    }
}

/// Decodes and positions the codes of `bytes`, appending glyphs.
#[allow(clippy::type_complexity, clippy::too_many_arguments)]
fn show(
    state: &State,
    font: &FontInfo,
    bytes: &[u8],
    site: usize,
    tm: &mut Mat,
    prev: &mut Option<([f64; 2], f64, [f64; 2])>,
    out: &mut Vec<Glyph>,
    room: usize,
) {
    let step = font.code_len;
    let mut at = 0;
    let cap = out.len().saturating_add(room);
    while at + step <= bytes.len() && out.len() < cap {
        let code = bytes[at..at + step]
            .iter()
            .fold(0u32, |a, b| (a << 8) | u32::from(*b));
        let width = font.width(code) / 1000.0;
        let mut tx = width * state.size + state.tc;
        if step == 1 && code == 32 {
            tx += state.tw;
        }
        tx *= state.th;
        let device = mul(tm, &state.ctm);
        let start = [device[4], device[5]];
        let em = state.size.abs() * device[0].hypot(device[1]);
        let dir = {
            let l = device[0].hypot(device[1]);
            if l > 1e-9 {
                [device[0] / l, device[1] / l]
            } else {
                [1.0, 0.0]
            }
        };
        if let Some((end, prev_em, prev_dir)) = *prev {
            let d = [start[0] - end[0], start[1] - end[1]];
            let along = d[0] * dir[0] + d[1] * dir[1];
            let across = (d[0] * dir[1] - d[1] * dir[0]).abs();
            let reference = em.max(prev_em).max(1e-6);
            let turned = (dir[0] - prev_dir[0]).abs() + (dir[1] - prev_dir[1]).abs() > 0.05;
            let kind = if across > 0.3 * reference
                || along < -0.3 * reference
                || turned
                || along > 8.0 * reference
            {
                Some(Kind::Break)
            } else if along > 0.12 * reference {
                Some(Kind::Gap)
            } else {
                None
            };
            if let Some(kind) = kind {
                out.push(Glyph {
                    kind,
                    ch: if kind == Kind::Gap { ' ' } else { '\u{0}' },
                    site,
                    start: at,
                    end: at,
                    first: true,
                    last: true,
                    adv: 0.0,
                    p0: start,
                    p1: start,
                });
            }
        }
        *tm = mul(&[1.0, 0.0, 0.0, 1.0, tx, 0.0], tm);
        let after = mul(tm, &state.ctm);
        *prev = Some(([after[4], after[5]], em, dir));
        let text = font
            .decode
            .get(&code)
            .cloned()
            .unwrap_or_else(|| "\u{FFFD}".to_owned());
        let count = text.chars().count().max(1);
        for (k, ch) in text.chars().enumerate() {
            out.push(Glyph {
                kind: Kind::Char,
                ch,
                site,
                start: at,
                end: at + step,
                first: k == 0,
                last: k + 1 == count,
                adv: if k + 1 == count { tx } else { 0.0 },
                p0: start,
                p1: [after[4], after[5]],
            });
        }
        at += step;
    }
}

/// The unit vector of the baseline direction of `device`.
pub fn unit_dir(device: &Mat) -> [f64; 2] {
    let l = device[0].hypot(device[1]);
    if l > 1e-9 {
        [device[0] / l, device[1] / l]
    } else {
        [1.0, 0.0]
    }
}
