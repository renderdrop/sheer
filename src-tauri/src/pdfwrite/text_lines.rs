//! Runs to lines to paragraphs, and the mapping to PDFium's characters (ARCHITECTURE §13.2).
//!
//! The runs of the walker ([`super::ops_walk`]) arrive in the order of the content stream, which says nothing about reading order (a
//! form's footer is often drawn first). Lines are therefore built by geometry only: runs that run in the same direction, sit on one
//! baseline (the rise taken out) and follow one another without a big gap are one line; the lines are ordered by direction, baseline
//! (top of the page first) and then position along the baseline.
//!
//! The text of a line is PDFium's: every character of the text layer is matched to the walker glyph whose origin is within 0.3 times
//! the size of it (the Unicode seen so far on unambiguous matches breaks ties), so the line says what the user selects and copies,
//! whatever the font's `ToUnicode` says. A line none of whose glyphs a character reaches is `unmapped`.

use std::collections::{HashMap, HashSet};

use lopdf::{Document, ObjectId};

use super::ops_walk::{self, Budget, Font, FontKey, GlyphPos, Run, WalkSink};
use super::text_fonts::{font_map, CharStatus, FontKind, FontMap};
use crate::error::AppError;
use crate::fontprog::fallback;
use crate::limits;
use crate::model::geometry::{PageBox, Rect};
use crate::model::text_edit::{
    CharGeom, LineAlign, LineEditable, LineFont, LineKey, TextEditRefusal, TextLineInfo,
};

/// Most glyphs a page may have before it is `limit_exceeded`: the walk keeps every glyph.
const MAX_GLYPHS: usize = 600_000;
/// The match radius, in sizes of the glyph (ARCHITECTURE §13.2).
const MATCH_RADIUS: f64 = 0.3;
/// Directions within this angle (radians, one degree) are one direction.
const SAME_DIRECTION: f64 = 0.017_453;
/// A gap of more than this many space widths between two runs of a baseline starts a new line (table cells, columns).
const GAP_IN_SPACES: f64 = 3.0;

/// Alignment detected for a paragraph.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Align {
    Left,
    Right,
    Center,
}

/// One line: the runs on one baseline, in order. `index` is the `LineKey.line` it is named by.
#[derive(Debug, Clone, PartialEq)]
pub struct Line {
    pub index: u32,
    pub runs: Vec<Run>,
    pub text: String,
    pub bounds: Rect,
    pub dir: [f64; 2],
    pub paragraph: u32,
    pub font_name: String,
    pub size: f64,
    pub embedded: bool,
    pub subset: bool,
    pub editable: LineEditable,
}

/// Consecutive lines (indices into `PageLines.lines`).
#[derive(Debug, Clone, PartialEq)]
pub struct Paragraph {
    pub lines: std::ops::Range<u32>,
    pub align: Align,
    pub justified: bool,
}

/// Everything `text_edit_lines` and the probe answer from, in reading order.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PageLines {
    pub lines: Vec<Line>,
    pub paragraphs: Vec<Paragraph>,
}

/// Where a line is, in its own direction: the baseline (offset along the normal, the rise taken out) and the start and end along it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Span {
    pub baseline: f64,
    pub start: f64,
    pub end: f64,
}

impl Line {
    /// The first glyph's origin (page space), if the line has a glyph.
    pub fn first_glyph(&self) -> Option<&GlyphPos> {
        self.runs.iter().find_map(|run| run.glyphs.first())
    }

    /// The span of the line along its direction.
    pub fn span(&self) -> Option<Span> {
        let normal = [-self.dir[1], self.dir[0]];
        let mut start = f64::INFINITY;
        let mut end = f64::NEG_INFINITY;
        let mut baseline = None;
        for run in &self.runs {
            for g in &run.glyphs {
                let at = dot(g.origin, self.dir);
                start = start.min(at.min(at + g.adv));
                end = end.max(at.max(at + g.adv));
                baseline.get_or_insert(dot(g.origin, normal) - run.rise_page);
            }
        }
        (start <= end).then_some(Span {
            baseline: baseline?,
            start,
            end,
        })
    }
}

impl PageLines {
    /// The room between the end of line `index` and the start of the next line on the same baseline (same direction, baseline within a
    /// fifth of the size), by geometry and not by content order: `None` when nothing follows. A line that starts before this one ends
    /// is not "next" (it overlaps), it answers `Some(0.0)`.
    pub fn room_after(&self, index: u32) -> Option<f64> {
        let line = self.lines.get(index as usize)?;
        let me = line.span()?;
        let mut room: Option<f64> = None;
        for (i, other) in self.lines.iter().enumerate() {
            if i == index as usize || !parallel(line.dir, other.dir) {
                continue;
            }
            let Some(span) = other.span() else { continue };
            if (span.baseline - me.baseline).abs() > 0.2 * line.size.max(other.size) {
                continue;
            }
            if span.end <= me.start {
                continue;
            }
            let gap = (span.start - me.end).max(0.0);
            room = Some(room.map_or(gap, |r: f64| r.min(gap)));
        }
        room
    }

    /// The mirror of [`Self::room_after`]: the room between the line before on the same baseline and the start of line `index`;
    /// `None` when nothing precedes it. A line that ends after this one starts answers `Some(0.0)`.
    pub fn room_before(&self, index: u32) -> Option<f64> {
        let line = self.lines.get(index as usize)?;
        let me = line.span()?;
        let mut room: Option<f64> = None;
        for (i, other) in self.lines.iter().enumerate() {
            if i == index as usize || !parallel(line.dir, other.dir) {
                continue;
            }
            let Some(span) = other.span() else { continue };
            if (span.baseline - me.baseline).abs() > 0.2 * line.size.max(other.size) {
                continue;
            }
            if span.start >= me.end {
                continue;
            }
            let gap = (me.start - span.end).max(0.0);
            room = Some(room.map_or(gap, |r: f64| r.min(gap)));
        }
        room
    }
}

fn parallel(a: [f64; 2], b: [f64; 2]) -> bool {
    (a[1].atan2(a[0]) - b[1].atan2(b[0])).abs() <= SAME_DIRECTION
}

fn dot(a: [f64; 2], b: [f64; 2]) -> f64 {
    a[0] * b[0] + a[1] * b[1]
}

/// Collects the runs of a walk (and stops it when the page has more glyphs than [`MAX_GLYPHS`]).
#[derive(Default)]
struct Collect {
    runs: Vec<Run>,
    glyphs: usize,
}

impl WalkSink for Collect {
    fn run(&mut self, run: Run) -> Result<(), AppError> {
        self.glyphs += run.glyphs.len();
        if self.glyphs > MAX_GLYPHS {
            return Err(AppError::limit("textEditGlyphs", MAX_GLYPHS as u64));
        }
        self.runs.push(run);
        Ok(())
    }
}

/// The lines of `page`; `chars` are PDFium's characters (the Unicode check of the mapping). At most `limits::TEXT_EDIT_LINES_PER_PAGE`.
pub fn lines(src: &Document, page: ObjectId, chars: &[CharGeom]) -> Result<PageLines, AppError> {
    let mut sink = Collect::default();
    ops_walk::walk(src, page, &mut Budget::new(), &mut sink)?;
    let origin = page_origin(src, page);
    Ok(build(src, page, sink.runs, chars, origin))
}

/// Left edge and top edge of the page's box in user space (the crop box inside the media box), as the UI measures from.
fn page_origin(src: &Document, page: ObjectId) -> (f32, f32) {
    let get =
        |key: &[u8]| ops_walk::inherited(src, page, key).and_then(|o| ops_walk::box_of(src, &o));
    let media = get(b"MediaBox").unwrap_or([0.0, 0.0, 612.0, 792.0]);
    let b = match get(b"CropBox") {
        Some(c) => [
            c[0].max(media[0]),
            c[1].max(media[1]),
            c[2].min(media[2]),
            c[3].min(media[3]),
        ],
        None => media,
    };
    #[allow(clippy::cast_possible_truncation)] // page coordinates are far below f32's range
    (b[0] as f32, b[3] as f32)
}

/// A baseline cluster's pieces before they are lines.
struct Segment {
    runs: Vec<usize>,
}

struct RunInfo {
    id: usize,
    base: f64,
    x0: f64,
    x1: f64,
    size: f64,
    space: f64,
}

/// A stretched line of justified text can have gaps beyond `GAP_IN_SPACES` and so falls apart. A band of
/// segments is joined again when its gaps stay moderate and the whole band spans exactly the edges of a
/// whole single-segment line next to it (columns and table cells never do).
fn join_justified_bands(segments: &mut Vec<(usize, Segment)>, extents: &HashMap<usize, RunInfo>) {
    /// The widest gap of a stretched line, in spaces.
    const STRETCH_IN_SPACES: f64 = 12.0;
    struct Seg {
        cluster: usize,
        base: f64,
        x0: f64,
        x1: f64,
        size: f64,
        space: f64,
    }
    let info: Vec<Option<Seg>> = segments
        .iter()
        .map(|(cluster, s)| {
            let runs: Vec<&RunInfo> = s.runs.iter().filter_map(|id| extents.get(id)).collect();
            let first = runs.first()?;
            Some(Seg {
                cluster: *cluster,
                base: first.base,
                x0: runs.iter().map(|r| r.x0).fold(f64::INFINITY, f64::min),
                x1: runs.iter().map(|r| r.x1).fold(f64::NEG_INFINITY, f64::max),
                size: first.size,
                space: first.space,
            })
        })
        .collect();
    // Bands: consecutive segments of one cluster on one baseline.
    let mut bands: Vec<std::ops::Range<usize>> = Vec::new();
    let mut band_of: Vec<usize> = Vec::with_capacity(info.len());
    let mut at = 0;
    while at < info.len() {
        let mut end = at + 1;
        if let Some(a) = &info[at] {
            while end < info.len()
                && info[end].as_ref().is_some_and(|b| {
                    b.cluster == a.cluster && (b.base - a.base).abs() <= 0.2 * a.size.min(b.size)
                })
            {
                end += 1;
            }
        }
        band_of.extend(std::iter::repeat_n(bands.len(), end - at));
        bands.push(at..end);
        at = end;
    }
    let single_of = |band: Option<&std::ops::Range<usize>>| -> Option<&Seg> {
        let band = band?;
        if band.len() == 1 {
            info[band.start].as_ref()
        } else {
            None
        }
    };
    let mut joined: Vec<bool> = vec![false; segments.len()];
    for (bi, band) in bands.iter().enumerate() {
        if band.len() < 2 {
            continue;
        }
        let parts: Option<Vec<&Seg>> = band.clone().map(|i| info[i].as_ref()).collect();
        let Some(parts) = parts else { continue };
        let (x0, x1) = (parts[0].x0, parts[parts.len() - 1].x1);
        let size = parts[0].size;
        let moderate = parts
            .windows(2)
            .all(|w| w[1].x0 - w[0].x1 <= STRETCH_IN_SPACES * w[1].space.max(0.1 * size));
        // The edges of a justified line agree up to its stretched trailing space.
        let tolerance = 1.0 + parts[0].space.max(0.1 * size);
        let neighbour = |n: Option<&Seg>| {
            n.is_some_and(|n| {
                let step = (n.base - parts[0].base).abs();
                n.cluster == parts[0].cluster
                    && step > 0.2 * size
                    && step <= 1.6 * size.max(n.size)
                    && (n.size - size).abs() <= 0.1 * size.max(n.size)
                    && (n.x0 - x0).abs() <= tolerance
                    && (n.x1 - x1).abs() <= tolerance
            })
        };
        let before = single_of(bi.checked_sub(1).and_then(|b| bands.get(b)));
        let after = single_of(bands.get(bi + 1));
        let (near_before, near_after) = (neighbour(before), neighbour(after));
        // A strongly stretched line (a few words across the whole measure) must sit between two whole lines of the
        // same edges and a regular line step; a table row or a column pair never does.
        let join = if moderate {
            near_before || near_after
        } else {
            match (before, after) {
                (Some(b), Some(a)) if near_before && near_after => {
                    let (s1, s2) = (parts[0].base - b.base, a.base - parts[0].base);
                    (s1 - s2).abs() <= 0.15 * s1.abs().max(s2.abs())
                }
                _ => false,
            }
        };
        if join {
            for i in band.clone() {
                joined[i] = true;
            }
        }
    }
    let mut out: Vec<(usize, Segment)> = Vec::with_capacity(segments.len());
    for (i, (cluster, seg)) in std::mem::take(segments).into_iter().enumerate() {
        let continues = i > 0 && joined[i] && band_of[i] == band_of[i - 1];
        match out.last_mut() {
            Some((_, last)) if continues => last.runs.extend(seg.runs),
            _ => out.push((cluster, seg)),
        }
    }
    *segments = out;
}
/// What is known about a font while the lines are built.
struct FontInfo {
    font: Option<Font>,
    /// Width of a space in em (a guess for composite fonts).
    space_em: f64,
    /// Code to character by the font's own encoding (lowest character per code); empty when the font has no map.
    inverse: HashMap<u32, char>,
}

fn font_info(src: &Document, page: ObjectId, key: &FontKey) -> FontInfo {
    let font = match key.object {
        Some(id) => src
            .get_dictionary(id)
            .ok()
            .map(|dict| Font::load(src, dict)),
        None => ops_walk::page_font(src, page, &key.name),
    };
    let space_em = font
        .as_ref()
        .filter(|f| !f.two_byte)
        .map(|f| f.width_of(32))
        .filter(|w| *w > 0.0)
        .unwrap_or(0.25);
    let mut inverse: HashMap<u32, char> = HashMap::new();
    if let Some(map) = key
        .object
        .and_then(|id| font_map(src, id, &HashMap::new()).ok())
    {
        for (c, code) in &map.to_code {
            let slot = inverse.entry(*code).or_insert(*c);
            *slot = (*slot).min(*c);
        }
    }
    FontInfo {
        font,
        space_em,
        inverse,
    }
}

#[allow(clippy::too_many_lines)]
fn build(
    src: &Document,
    page: ObjectId,
    runs: Vec<Run>,
    chars: &[CharGeom],
    (left, top): (f32, f32),
) -> PageLines {
    let runs: Vec<Run> = runs.into_iter().filter(|r| !r.glyphs.is_empty()).collect();
    let mut fonts: HashMap<FontKey, FontInfo> = HashMap::new();
    for run in &runs {
        fonts
            .entry(run.font.clone())
            .or_insert_with(|| font_info(src, page, &run.font));
    }
    // 1. Directions: runs within a degree of each other.
    let angle = |r: &Run| r.glyphs[0].dir[1].atan2(r.glyphs[0].dir[0]);
    let mut order: Vec<usize> = (0..runs.len()).collect();
    order.sort_by(|a, b| angle(&runs[*a]).total_cmp(&angle(&runs[*b])));
    let mut clusters: Vec<Vec<usize>> = Vec::new();
    let mut first_angle = f64::NAN;
    for id in order {
        let a = angle(&runs[id]);
        if clusters.is_empty() || a - first_angle > SAME_DIRECTION {
            clusters.push(Vec::new());
            first_angle = a;
        }
        if let Some(last) = clusters.last_mut() {
            last.push(id);
        }
    }
    // 2. Per direction: baselines, then segments along them.
    let mut segments: Vec<(usize, Segment)> = Vec::new();
    let mut extents: HashMap<usize, RunInfo> = HashMap::new();
    for (cluster, ids) in clusters.iter().enumerate() {
        let dir = runs[ids[0]].glyphs[0].dir;
        let normal = [-dir[1], dir[0]];
        let mut list: Vec<RunInfo> = ids
            .iter()
            .map(|&id| {
                let run = &runs[id];
                let first = &run.glyphs[0];
                let last = &run.glyphs[run.glyphs.len() - 1];
                let size = run
                    .glyphs
                    .iter()
                    .map(|g| g.size_eff)
                    .fold(0.0f64, f64::max)
                    .max(1e-3);
                let x0 = dot(first.origin, dir);
                let space = fonts.get(&run.font).map_or(0.25, |f| f.space_em) * size;
                RunInfo {
                    id,
                    base: dot(first.origin, normal) - run.rise_page,
                    x0,
                    x1: (dot(last.origin, dir) + last.adv).max(x0),
                    size,
                    space,
                }
            })
            .collect();
        list.sort_by(|a, b| b.base.total_cmp(&a.base));
        for info in &list {
            extents.insert(
                info.id,
                RunInfo {
                    id: info.id,
                    base: info.base,
                    x0: info.x0,
                    x1: info.x1,
                    size: info.size,
                    space: info.space,
                },
            );
        }
        let at = 0;
        while at < list.len() {
            let reference = list[at].base;
            let mut end = at + 1;
            while end < list.len()
                && (list[end].base - reference).abs() <= 0.2 * list[end].size.min(list[at].size)
            {
                end += 1;
            }
            let mut band: Vec<RunInfo> = list.drain(at..end).collect();
            band.sort_by(|a, b| a.x0.total_cmp(&b.x0));
            let mut seg: Option<(Segment, f64, f64)> = None;
            for info in band {
                let joins = seg.as_ref().is_some_and(|(_, seg_end, space)| {
                    let gap = info.x0 - seg_end;
                    gap <= GAP_IN_SPACES * space.max(info.space) && gap >= -0.5 * info.size
                });
                if joins {
                    if let Some((s, seg_end, space)) = seg.as_mut() {
                        s.runs.push(info.id);
                        *seg_end = seg_end.max(info.x1);
                        *space = info.space;
                    }
                } else {
                    if let Some((s, _, _)) = seg.take() {
                        segments.push((cluster, s));
                    }
                    seg = Some((
                        Segment {
                            runs: vec![info.id],
                        },
                        info.x1,
                        info.space,
                    ));
                }
            }
            if let Some((s, _, _)) = seg.take() {
                segments.push((cluster, s));
            }
            // `drain` moved the band out, so `at` now points at the next band.
        }
    }
    join_justified_bands(&mut segments, &extents);
    segments.truncate(limits::TEXT_EDIT_LINES_PER_PAGE);
    // 3. Lines (reading order = segment order).
    let mut slots: Vec<Option<Run>> = runs.into_iter().map(Some).collect();
    let mut lines: Vec<Line> = Vec::with_capacity(segments.len());
    for (_, seg) in &segments {
        let runs: Vec<Run> = seg.runs.iter().filter_map(|&id| slots[id].take()).collect();
        let dir = runs[0].glyphs[0].dir;
        lines.push(Line {
            index: u32::try_from(lines.len()).unwrap_or(u32::MAX),
            runs,
            text: String::new(),
            bounds: Rect {
                x: 0.0,
                y: 0.0,
                w: 0.0,
                h: 0.0,
            },
            dir,
            paragraph: 0,
            font_name: String::new(),
            size: 0.0,
            embedded: false,
            subset: false,
            editable: LineEditable::Same,
        });
    }
    fill(src, page, &mut lines, &fonts, chars, left, top);
    let paragraphs = paragraphs(&mut lines, &segments, &fonts);
    PageLines { lines, paragraphs }
}

/// A glyph of the page in the flat list the matching runs on.
struct Flat {
    origin: [f64; 2],
    code: u32,
    font: usize,
}

/// A grid of the flat glyphs by position.
struct Grid {
    cell: f64,
    cells: HashMap<(i64, i64), Vec<usize>>,
}

impl Grid {
    fn new(glyphs: &[Flat]) -> Self {
        let cell = 16.0;
        let mut cells: HashMap<(i64, i64), Vec<usize>> = HashMap::new();
        for (id, g) in glyphs.iter().enumerate() {
            cells.entry(Self::key(cell, g.origin)).or_default().push(id);
        }
        Self { cell, cells }
    }

    #[allow(clippy::cast_possible_truncation)] // coordinates are bounded by the page
    fn key(cell: f64, p: [f64; 2]) -> (i64, i64) {
        ((p[0] / cell).floor() as i64, (p[1] / cell).floor() as i64)
    }

    /// The glyphs within `radius` of `p`, nearest first, with their distance.
    fn near(&self, glyphs: &[Flat], p: [f64; 2], radius: f64) -> Vec<(usize, f64)> {
        let (cx, cy) = Self::key(self.cell, p);
        #[allow(clippy::cast_possible_truncation)]
        let reach = ((radius / self.cell).ceil() as i64).clamp(1, 6);
        let mut out = Vec::new();
        for x in cx - reach..=cx + reach {
            for y in cy - reach..=cy + reach {
                for &id in self.cells.get(&(x, y)).map_or(&[][..], Vec::as_slice) {
                    let o = glyphs[id].origin;
                    let d = (o[0] - p[0]).hypot(o[1] - p[1]);
                    if d <= radius {
                        out.push((id, d));
                    }
                }
            }
        }
        out.sort_by(|a, b| a.1.total_cmp(&b.1));
        out
    }
}

fn char_size(c: &CharGeom, fallback: f64) -> f64 {
    if c.size.is_finite() && c.size > 0.0 {
        f64::from(c.size)
    } else {
        fallback
    }
}

/// Text, bounds, font and the `unmapped` mark of every line.
#[allow(clippy::too_many_lines)]
fn fill(
    src: &Document,
    _page: ObjectId,
    lines: &mut [Line],
    fonts: &HashMap<FontKey, FontInfo>,
    chars: &[CharGeom],
    left: f32,
    top: f32,
) {
    // The flat list of glyphs, line by line.
    let mut keys: Vec<FontKey> = Vec::new();
    let mut key_of: HashMap<FontKey, usize> = HashMap::new();
    let mut flat: Vec<Flat> = Vec::new();
    let mut first_of_line: Vec<usize> = Vec::with_capacity(lines.len() + 1);
    for line in lines.iter() {
        first_of_line.push(flat.len());
        for run in &line.runs {
            let font = *key_of.entry(run.font.clone()).or_insert_with(|| {
                keys.push(run.font.clone());
                keys.len() - 1
            });
            for g in &run.glyphs {
                flat.push(Flat {
                    origin: g.origin,
                    code: g.code,
                    font,
                });
            }
        }
    }
    first_of_line.push(flat.len());
    // Matching: unambiguous characters first, the Unicode they teach settles the others.
    let grid = Grid::new(&flat);
    let mut assigned: Vec<Option<usize>> = vec![None; chars.len()];
    let mut deferred: Vec<(usize, Vec<(usize, f64)>)> = Vec::new();
    for (ci, c) in chars.iter().enumerate() {
        if c.generated {
            continue;
        }
        let size = char_size(c, 10.0);
        let cands = grid.near(
            &flat,
            [f64::from(c.origin[0]), f64::from(c.origin[1])],
            MATCH_RADIUS * size,
        );
        match cands.as_slice() {
            [] => {}
            [only] => assigned[ci] = Some(only.0),
            [nearest, next, ..] if next.1 > nearest.1 + 0.15 * size => {
                assigned[ci] = Some(nearest.0);
            }
            _ => deferred.push((ci, cands)),
        }
    }
    let mut observed: Vec<HashMap<u32, char>> = vec![HashMap::new(); keys.len()];
    let mut count = vec![0u32; flat.len()];
    for id in assigned.iter().flatten() {
        count[*id] += 1;
    }
    for (ci, id) in assigned.iter().enumerate() {
        if let (Some(id), Some(ch)) = (id, char::from_u32(chars[ci].unicode)) {
            if count[*id] == 1 {
                observed[flat[*id].font].entry(flat[*id].code).or_insert(ch);
            }
        }
    }
    for (ci, cands) in deferred {
        let c = &chars[ci];
        let size = char_size(c, 10.0);
        let window = cands[0].1 + 0.15 * size;
        let ch = char::from_u32(c.unicode);
        let pick = cands
            .iter()
            .take_while(|(_, d)| *d <= window)
            .find(|(id, _)| {
                ch.is_some() && observed[flat[*id].font].get(&flat[*id].code) == ch.as_ref()
            })
            .unwrap_or(&cands[0]);
        assigned[ci] = Some(pick.0);
    }
    // The characters of each glyph in text-layer order, and the spaces PDFium put between glyphs.
    let mut of_glyph: Vec<Vec<char>> = vec![Vec::new(); flat.len()];
    let mut space_after: HashSet<usize> = HashSet::new();
    let mut last: Option<usize> = None;
    for (ci, c) in chars.iter().enumerate() {
        if c.generated {
            if c.unicode == 0x20 {
                if let Some(id) = last {
                    space_after.insert(id);
                }
            }
            continue;
        }
        if let Some(id) = assigned[ci] {
            if let Some(ch) = char::from_u32(c.unicode) {
                of_glyph[id].push(ch);
            }
            last = Some(id);
        }
    }
    let have_chars = !chars.is_empty();
    // The lines.
    let page_box = PageBox::new(left, top);
    let mut maps: HashMap<usize, Option<FontMap>> = HashMap::new();
    for (li, line) in lines.iter_mut().enumerate() {
        let (lo, hi) = (first_of_line[li], first_of_line[li + 1]);
        // A run of nothing but spaces (a tab drawn under `ActualText`, a stroked blank) is no reason to refuse the text beside it.
        let mut id = lo;
        for run in &mut line.runs {
            let ids = id..id + run.glyphs.len();
            id = ids.end;
            if run.clipped
                && ids.clone().all(|g| {
                    of_glyph[g].iter().all(|c| c.is_whitespace())
                        && (!of_glyph[g].is_empty() || flat[g].code == 32)
                })
            {
                run.clipped = false;
            }
        }
        let mut text = String::new();
        let mut matched = 0usize;
        let mut line_chars: HashMap<usize, HashSet<char>> = HashMap::new();
        for id in lo..hi {
            let chs = &of_glyph[id];
            if !chs.is_empty() {
                matched += 1;
            }
            text.extend(chs.iter());
            line_chars
                .entry(flat[id].font)
                .or_default()
                .extend(chs.iter());
            if id + 1 < hi && space_after.contains(&id) && !text.ends_with(' ') {
                text.push(' ');
            }
        }
        if !have_chars {
            text = decode_plain(line, fonts);
        }
        let (key, size) = {
            let main = main_run(line);
            let size = main
                .glyphs
                .iter()
                .map(|g| g.size_eff)
                .fold(0.0f64, f64::max);
            (main.font.clone(), size)
        };
        let font = fonts.get(&key).and_then(|i| i.font.as_ref());
        line.font_name = font
            .map(|f| strip_subset(&f.base_name))
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| String::from_utf8_lossy(&key.name).into_owned());
        line.embedded = font.is_some_and(|f| f.embedded);
        line.subset = font.is_some_and(|f| strip_subset(&f.base_name) != f.base_name);
        line.size = size;
        line.text = text.chars().take(limits::TEXT_EDIT_LINE_CHARS).collect();
        line.bounds = bounds_of(line, fonts, page_box);
        line.editable = if have_chars && matched == 0 {
            LineEditable::No {
                reason: TextEditRefusal::Unmapped,
            }
        } else {
            editable_of(src, line, &keys, &line_chars, &observed, fonts, &mut maps)
        };
    }
}

/// The run of a line with the most glyphs (it names the font).
fn main_run(line: &Line) -> &Run {
    let mut best = &line.runs[0];
    for run in &line.runs {
        if run.glyphs.len() > best.glyphs.len() {
            best = run;
        }
    }
    best
}

fn strip_subset(name: &str) -> String {
    match name.split_once('+') {
        Some((tag, rest)) if tag.len() == 6 && tag.bytes().all(|b| b.is_ascii_uppercase()) => {
            rest.to_owned()
        }
        _ => name.to_owned(),
    }
}

/// The text of a line without PDFium's characters: codes through the font's own encoding (single-byte codes without one as Latin-1), a space where the glyphs are far apart.
fn decode_plain(line: &Line, fonts: &HashMap<FontKey, FontInfo>) -> String {
    let mut out = String::new();
    let mut prev_end: Option<f64> = None;
    for run in &line.runs {
        let info = fonts.get(&run.font);
        let two = info
            .and_then(|i| i.font.as_ref())
            .is_some_and(|f| f.two_byte);
        for g in &run.glyphs {
            let at = dot(g.origin, line.dir);
            if prev_end.is_some_and(|e| at - e > 0.2 * g.size_eff) && !out.ends_with(' ') {
                out.push(' ');
            }
            prev_end = Some(at + g.adv);
            let mapped = info.and_then(|i| i.inverse.get(&g.code)).copied();
            if let Some(c) = mapped {
                out.push(c);
            } else if two || (0x80..0xA0).contains(&g.code) {
                // No character known: a placeholder (never a C1 control).
                out.push('\u{fffd}');
            } else {
                out.push(char::from_u32(g.code).unwrap_or('\u{fffd}'));
            }
        }
    }
    out
}

/// Same, fallback or (only `unmapped` is decided here, the refusals are `text_refuse`'s) whether the characters have glyphs.
fn editable_of(
    src: &Document,
    line: &Line,
    keys: &[FontKey],
    line_chars: &HashMap<usize, HashSet<char>>,
    observed: &[HashMap<u32, char>],
    fonts: &HashMap<FontKey, FontInfo>,
    maps: &mut HashMap<usize, Option<FontMap>>,
) -> LineEditable {
    let main = main_run(line);
    let info = fonts.get(&main.font).and_then(|i| i.font.as_ref());
    let face = || {
        let (flags, weight, name) = info.map_or((0, 400, String::new()), |f| {
            (f.flags, f.weight, f.base_name.clone())
        });
        LineEditable::Fallback {
            face: fallback::pick(flags, weight, &name).family,
        }
    };
    let mut all_ok = true;
    for (font_index, set) in line_chars {
        let Some(key) = keys.get(*font_index) else {
            all_ok = false;
            continue;
        };
        let Some(object) = key.object else {
            all_ok = false;
            continue;
        };
        let map = maps
            .entry(*font_index)
            .or_insert_with(|| font_map(src, object, &observed[*font_index]).ok());
        match map {
            Some(map) => {
                if matches!(map.kind, FontKind::Type3 | FontKind::Type0Other) {
                    // Refused by the classifier; the line is not claimed as editable in its own font.
                    all_ok = false;
                } else if set.iter().any(|c| map.status(*c) == CharStatus::Missing) {
                    all_ok = false;
                }
            }
            None => all_ok = false,
        }
    }
    if all_ok {
        LineEditable::Same
    } else {
        face()
    }
}

/// The union of the glyph boxes of a line in the page space of the UI.
fn bounds_of(line: &Line, fonts: &HashMap<FontKey, FontInfo>, page_box: Option<PageBox>) -> Rect {
    let zero = Rect {
        x: 0.0,
        y: 0.0,
        w: 0.0,
        h: 0.0,
    };
    let mut points: Vec<(f64, f64)> = Vec::new();
    let normal = [-line.dir[1], line.dir[0]];
    for run in &line.runs {
        let font = fonts.get(&run.font).and_then(|i| i.font.as_ref());
        let (ascent, descent) = font.map_or((0.95, -0.25), |f| (f.ascent, f.descent));
        for g in &run.glyphs {
            for along in [0.0, g.adv] {
                for up in [ascent * g.size_eff, descent * g.size_eff] {
                    points.push((
                        g.origin[0] + line.dir[0] * along + normal[0] * up,
                        g.origin[1] + line.dir[1] * along + normal[1] * up,
                    ));
                }
            }
        }
    }
    let b = box_of_points(&points);
    #[allow(clippy::cast_possible_truncation)] // page coordinates fit f32
    page_box
        .and_then(|p| p.rect(b[0] as f32, b[1] as f32, b[2] as f32, b[3] as f32))
        .unwrap_or(zero)
}

fn box_of_points(points: &[(f64, f64)]) -> [f64; 4] {
    ops_walk::aabb(points)
}

/// Paragraphs of the ordered lines (ARCHITECTURE §13.2); sets `Line::paragraph`.
fn paragraphs(
    lines: &mut [Line],
    segments: &[(usize, Segment)],
    fonts: &HashMap<FontKey, FontInfo>,
) -> Vec<Paragraph> {
    struct M {
        cluster: usize,
        base: f64,
        x0: f64,
        x1: f64,
        size: f64,
        family: String,
        gap: Option<f64>,
    }
    let metrics: Vec<Option<M>> = lines
        .iter()
        .zip(segments)
        .map(|(line, (cluster, _))| {
            if line.text.trim().is_empty() {
                return None; // a blank line separates paragraphs
            }
            let span = line.span()?;
            let family = line
                .font_name
                .split(['-', ',', ' '])
                .next()
                .unwrap_or_default()
                .to_owned();
            Some(M {
                cluster: *cluster,
                base: span.baseline,
                x0: span.start,
                x1: span.end,
                size: line.size.max(1e-3),
                family,
                gap: word_gap(line, fonts),
            })
        })
        .collect();
    const LEFT: u8 = 1;
    const RIGHT: u8 = 2;
    const CENTER: u8 = 4;
    let mut start = 0usize;
    let mut mask = LEFT | RIGHT | CENTER;
    let mut prev_step: Option<f64> = None;
    let mut paragraphs: Vec<Paragraph> = Vec::new();
    let finish = |paragraphs: &mut Vec<Paragraph>, from: usize, to: usize, mask: u8| {
        let align = if mask & LEFT != 0 {
            Align::Left
        } else if mask & RIGHT != 0 {
            Align::Right
        } else {
            Align::Center
        };
        let inner: Vec<&M> = (from..to.saturating_sub(1))
            .filter_map(|i| metrics[i].as_ref())
            .collect();
        let right_edges_equal = inner.len() >= 2 && {
            let lo = inner.iter().map(|m| m.x1).fold(f64::INFINITY, f64::min);
            let hi = inner.iter().map(|m| m.x1).fold(f64::NEG_INFINITY, f64::max);
            hi - lo <= 0.3 * inner[0].size
        };
        let gaps: Vec<f64> = inner.iter().filter_map(|m| m.gap).collect();
        let varying = gaps.len() >= 2 && {
            let lo = gaps.iter().copied().fold(f64::INFINITY, f64::min);
            let hi = gaps.iter().copied().fold(f64::NEG_INFINITY, f64::max);
            let mean = gaps.iter().sum::<f64>() / gaps.len() as f64;
            hi - lo > 0.03 * mean.max(1e-6)
        };
        paragraphs.push(Paragraph {
            lines: u32::try_from(from).unwrap_or(u32::MAX)..u32::try_from(to).unwrap_or(u32::MAX),
            align,
            justified: align == Align::Left && right_edges_equal && varying,
        });
    };
    for i in 1..=lines.len() {
        let joined = i < lines.len()
            && match (&metrics[i - 1], &metrics[i]) {
                (Some(a), Some(b)) => {
                    let step = a.base - b.base;
                    let same_step =
                        prev_step.is_none_or(|p| (step - p).abs() <= 0.15 * p.abs().max(1e-6));
                    let pair = (if (a.x0 - b.x0).abs() <= 1.0 { LEFT } else { 0 })
                        | (if (a.x1 - b.x1).abs() <= 1.0 { RIGHT } else { 0 })
                        | (if ((a.x0 + a.x1) - (b.x0 + b.x1)).abs() <= 2.0 {
                            CENTER
                        } else {
                            0
                        });
                    let ok = a.cluster == b.cluster
                        && a.family == b.family
                        && (a.size - b.size).abs() <= 0.1 * a.size.max(b.size)
                        && step > 0.0
                        && step <= 1.6 * b.size.max(a.size)
                        && same_step
                        && mask & pair != 0;
                    if ok {
                        mask &= pair;
                        prev_step = Some(step);
                    }
                    ok
                }
                _ => false,
            };
        if !joined {
            finish(&mut paragraphs, start, i, mask);
            start = i;
            mask = LEFT | RIGHT | CENTER;
            prev_step = None;
        }
    }
    // A one-line paragraph has no edges of its own to tell its alignment: judge it against the text block it sits in
    // (the edges of the multi-line paragraphs of its direction). Blocks that overlap horizontally are one column;
    // a multi-column page has one block per column.
    let mut blocks: HashMap<usize, Vec<(f64, f64)>> = HashMap::new();
    for p in paragraphs.iter().filter(|p| p.lines.len() >= 2) {
        let mut extent: Option<(usize, f64, f64)> = None;
        for m in metrics[p.lines.start as usize..p.lines.end as usize]
            .iter()
            .flatten()
        {
            let e = extent.get_or_insert((m.cluster, m.x0, m.x1));
            e.1 = e.1.min(m.x0);
            e.2 = e.2.max(m.x1);
        }
        if let Some((cluster, x0, x1)) = extent {
            blocks.entry(cluster).or_default().push((x0, x1));
        }
    }
    for columns in blocks.values_mut() {
        columns.sort_by(|a, b| a.0.total_cmp(&b.0));
        let mut merged: Vec<(f64, f64)> = Vec::with_capacity(columns.len());
        for &(x0, x1) in columns.iter() {
            match merged.last_mut() {
                Some(last) if x0 <= last.1 => last.1 = last.1.max(x1),
                _ => merged.push((x0, x1)),
            }
        }
        *columns = merged;
    }
    // A direction without any multi-line paragraph (an invoice's address block, say) is judged against all its lines.
    // That judgement is conservative (`classify_loose`).
    let mut loose: HashMap<usize, Vec<(f64, f64, f64)>> = HashMap::new();
    for m in metrics.iter().flatten() {
        if !blocks.contains_key(&m.cluster) {
            loose
                .entry(m.cluster)
                .or_default()
                .push((m.x0, m.x1, m.size));
        }
    }
    for p in &mut paragraphs {
        if p.lines.len() != 1 || p.align != Align::Left {
            continue;
        }
        let Some(m) = metrics[p.lines.start as usize].as_ref() else {
            continue;
        };
        if let Some(cluster_lines) = loose.get(&m.cluster) {
            p.align = classify_loose(cluster_lines, (m.x0, m.x1, m.size));
            continue;
        }
        let Some(columns) = blocks.get(&m.cluster) else {
            continue;
        };
        // The line's own column(s): every one it overlaps, else the nearest.
        let mut own = columns.iter().filter(|c| c.0 < m.x1 && c.1 > m.x0);
        let (left, right) = match own.next() {
            Some(first) => own.fold(*first, |a, c| (a.0.min(c.0), a.1.max(c.1))),
            None => {
                let mid = (m.x0 + m.x1) / 2.0;
                let dist = |c: &(f64, f64)| (mid - (c.0 + c.1) / 2.0).abs();
                match columns.iter().min_by(|a, b| dist(a).total_cmp(&dist(b))) {
                    Some(c) => *c,
                    None => continue,
                }
            }
        };
        if m.x0 - left <= m.size {
            continue; // starts at the block's left edge: left
        }
        if (m.x1 - right).abs() <= 2.0 {
            p.align = Align::Right;
        } else if ((m.x0 + m.x1) - (left + right)).abs() <= 4.0 {
            p.align = Align::Center;
        }
    }
    for (pi, p) in paragraphs.iter().enumerate() {
        for line in &mut lines[p.lines.start as usize..p.lines.end as usize] {
            line.paragraph = u32::try_from(pi).unwrap_or(u32::MAX);
        }
    }
    paragraphs
}

/// The alignment of a single line in a direction without any multi-line paragraph. `lines` are the `(x0, x1, size)` of every line of the
/// direction, `line` is one of them. Left unless: at least three lines, the line clearly narrower than their block, the left edges ragged,
/// and its right edge shared with another line (right) or its centre on the block's centre (centred).
fn classify_loose(lines: &[(f64, f64, f64)], line: (f64, f64, f64)) -> Align {
    let (x0, x1, size) = line;
    if lines.len() < 3 {
        return Align::Left;
    }
    let left = lines.iter().map(|l| l.0).fold(f64::INFINITY, f64::min);
    let right = lines.iter().map(|l| l.1).fold(f64::NEG_INFINITY, f64::max);
    let max_x0 = lines.iter().map(|l| l.0).fold(f64::NEG_INFINITY, f64::max);
    if x0 - left <= size || x1 - x0 > 0.85 * (right - left) || max_x0 - left <= size {
        return Align::Left;
    }
    let shares_right = lines.iter().filter(|l| (l.1 - x1).abs() <= 2.0).count() >= 2;
    if (x1 - right).abs() <= 2.0 && shares_right {
        Align::Right
    } else if ((x0 + x1) - (left + right)).abs() <= 4.0 {
        Align::Center
    } else {
        Align::Left
    }
}

/// The mean width of the word gaps of a line (a space glyph's advance plus the extra a `TJ` number leaves), `None` without a gap.
fn word_gap(line: &Line, fonts: &HashMap<FontKey, FontInfo>) -> Option<f64> {
    let mut gaps: Vec<f64> = Vec::new();
    for run in &line.runs {
        let two = fonts
            .get(&run.font)
            .and_then(|i| i.font.as_ref())
            .is_some_and(|f| f.two_byte);
        for pair in run.glyphs.windows(2) {
            let (g, next) = (&pair[0], &pair[1]);
            let step = dot(
                [next.origin[0] - g.origin[0], next.origin[1] - g.origin[1]],
                line.dir,
            );
            let extra = (step - g.adv).max(0.0);
            let word = if !two && g.code == 32 { g.adv } else { 0.0 };
            if word + extra > 0.05 * g.size_eff {
                gaps.push(word + extra);
            }
        }
    }
    (!gaps.is_empty()).then(|| gaps.iter().sum::<f64>() / gaps.len() as f64)
}

/// The line that holds the character at UTF-16 index `unit` of the text layer, as the UI is told (`unmapped` is a refusal, not an error).
pub fn probe(lines: &PageLines, chars: &[CharGeom], unit: u32) -> Result<TextLineInfo, AppError> {
    let unmapped = || TextLineInfo {
        key: LineKey {
            rev: 0,
            line: u32::MAX,
        },
        text: String::new(),
        bounds: Rect {
            x: 0.0,
            y: 0.0,
            w: 0.0,
            h: 0.0,
        },
        paragraph: 0,
        justified: false,
        align: LineAlign::Left,
        font: LineFont {
            name: String::new(),
            size: 0.0,
            embedded: false,
            subset: false,
        },
        editable: LineEditable::No {
            reason: TextEditRefusal::Unmapped,
        },
    };
    // The character at the unit: the last one that starts at or before it.
    let after = chars.partition_point(|c| c.utf16 <= unit);
    let Some(mut at) = after.checked_sub(1) else {
        return Ok(unmapped());
    };
    if chars[at].generated {
        // A generated character (a space or break PDFium made) belongs to its neighbour: the one before, else the one after.
        at = (0..at)
            .rev()
            .find(|i| !chars[*i].generated)
            .or_else(|| (at + 1..chars.len()).find(|i| !chars[*i].generated))
            .unwrap_or(at);
        if chars[at].generated {
            return Ok(unmapped());
        }
    }
    let c = &chars[at];
    let origin = [f64::from(c.origin[0]), f64::from(c.origin[1])];
    let ch = char::from_u32(c.unicode);
    let mut cands: Vec<(usize, f64)> = Vec::new();
    for (li, line) in lines.lines.iter().enumerate() {
        for run in &line.runs {
            for g in &run.glyphs {
                let d = (g.origin[0] - origin[0]).hypot(g.origin[1] - origin[1]);
                if d <= MATCH_RADIUS * char_size(c, g.size_eff) {
                    cands.push((li, d));
                }
            }
        }
    }
    cands.sort_by(|a, b| a.1.total_cmp(&b.1));
    let size = char_size(c, 10.0);
    let Some(nearest) = cands.first() else {
        return Ok(unmapped());
    };
    let window = nearest.1 + 0.15 * size;
    let pick = cands
        .iter()
        .take_while(|(_, d)| *d <= window)
        .find(|(li, _)| ch.is_some_and(|ch| lines.lines[*li].text.contains(ch)))
        .unwrap_or(nearest);
    let line = &lines.lines[pick.0];
    Ok(line_info(lines, line, 0))
}

/// The wire shape of `line` in revision `rev` (text capped at `limits::TEXT_EDIT_LINE_CHARS`).
pub fn line_info(lines: &PageLines, line: &Line, rev: u32) -> TextLineInfo {
    let paragraph = lines.paragraphs.get(line.paragraph as usize);
    TextLineInfo {
        key: LineKey {
            rev,
            line: line.index,
        },
        text: line
            .text
            .chars()
            .take(limits::TEXT_EDIT_LINE_CHARS)
            .collect(),
        bounds: line.bounds,
        paragraph: line.paragraph,
        justified: paragraph.is_some_and(|p| p.justified),
        align: match paragraph.map_or(Align::Left, |p| p.align) {
            Align::Left => LineAlign::Left,
            Align::Right => LineAlign::Right,
            Align::Center => LineAlign::Center,
        },
        #[allow(clippy::cast_possible_truncation)]
        font: LineFont {
            name: line.font_name.clone(),
            size: line.size as f32,
            embedded: line.embedded,
            subset: line.subset,
        },
        editable: line.editable,
    }
}

#[cfg(test)]
mod loose_tests {
    use super::{classify_loose, Align};

    const S: f64 = 10.0;

    #[test]
    fn a_left_address_block_stays_left() {
        let block = [(96.0, 160.0, S), (96.0, 220.0, S), (96.0, 146.0, S)];
        for l in block {
            assert_eq!(classify_loose(&block, l), Align::Left);
        }
    }

    #[test]
    fn an_indented_list_item_that_is_the_widest_stays_left() {
        let block = [(96.0, 200.0, S), (120.0, 300.0, S), (96.0, 180.0, S)];
        assert_eq!(classify_loose(&block, block[1]), Align::Left);
    }

    #[test]
    fn a_right_aligned_block_is_right() {
        let block = [
            (96.0, 164.0, S),
            (441.0, 502.5, S),
            (405.0, 502.5, S),
            (445.0, 502.5, S),
        ];
        assert_eq!(classify_loose(&block, block[1]), Align::Right);
        assert_eq!(classify_loose(&block, block[0]), Align::Left);
    }

    #[test]
    fn a_centred_heading_without_paragraphs_is_centred() {
        let block = [(72.0, 540.0, S), (271.0, 341.0, S), (72.0, 400.0, S)];
        assert_eq!(classify_loose(&block, block[1]), Align::Center);
    }

    #[test]
    fn fewer_than_three_lines_stay_left() {
        let block = [(72.0, 540.0, S), (271.0, 341.0, S)];
        assert_eq!(classify_loose(&block, block[1]), Align::Left);
    }
}

#[cfg(test)]
mod geometry_tests {
    use super::{paragraphs, Line, PageLines, Segment};
    use crate::model::geometry::Rect;
    use crate::model::text_edit::LineEditable;
    use crate::pdfwrite::ops_walk::{FontKey, GlyphPos, OpRef, Run};
    use std::collections::HashMap;

    /// A line of one glyph spanning `x0..x1` on the baseline `y`.
    fn line(index: u32, text: &str, x0: f64, x1: f64, y: f64) -> Line {
        let at = OpRef {
            stream: 0,
            index: 0,
        };
        let glyph = GlyphPos {
            op: at,
            byte: 0..1,
            code: 65,
            origin: [x0, y],
            adv: x1 - x0,
            size_eff: 10.0,
            dir: [1.0, 0.0],
        };
        let run = Run {
            ops: at..at,
            font: FontKey {
                name: b"F1".to_vec(),
                object: None,
            },
            in_form: false,
            render_mode: 0,
            rise: 0.0,
            rise_page: 0.0,
            clipped: false,
            glyphs: vec![glyph],
        };
        Line {
            index,
            runs: vec![run],
            text: text.to_owned(),
            bounds: Rect {
                x: 0.0,
                y: 0.0,
                w: 0.0,
                h: 0.0,
            },
            dir: [1.0, 0.0],
            paragraph: 0,
            font_name: "Times-Roman".to_owned(),
            size: 10.0,
            embedded: false,
            subset: false,
            editable: LineEditable::Same,
        }
    }

    fn group(mut lines: Vec<Line>) -> Vec<std::ops::Range<u32>> {
        let segments: Vec<(usize, Segment)> = lines
            .iter()
            .map(|_| (0, Segment { runs: Vec::new() }))
            .collect();
        paragraphs(&mut lines, &segments, &HashMap::new())
            .into_iter()
            .map(|p| p.lines)
            .collect()
    }

    #[test]
    fn evenly_stepped_left_lines_are_one_paragraph() {
        let lines = vec![
            line(0, "a", 72.0, 200.0, 700.0),
            line(1, "b", 72.0, 180.0, 688.0),
            line(2, "c", 72.0, 150.0, 676.0),
        ];
        assert_eq!(group(lines), vec![0..3]);
    }

    #[test]
    fn a_blank_line_breaks_a_paragraph() {
        let lines = vec![
            line(0, "a", 72.0, 200.0, 700.0),
            line(1, "  ", 72.0, 100.0, 688.0),
            line(2, "c", 72.0, 150.0, 676.0),
        ];
        let got = group(lines);
        assert_eq!(got.len(), 3, "the blank line stands alone: {got:?}");
        assert_eq!(got[0], 0..1);
        assert_eq!(got[2], 2..3);
    }

    #[test]
    fn a_far_step_or_other_size_starts_a_new_paragraph() {
        let far = vec![
            line(0, "a", 72.0, 200.0, 700.0),
            line(1, "b", 72.0, 180.0, 640.0),
        ];
        assert_eq!(group(far), vec![0..1, 1..2]);
        let mut big = vec![
            line(0, "a", 72.0, 200.0, 700.0),
            line(1, "b", 72.0, 180.0, 688.0),
        ];
        big[1].size = 20.0;
        assert_eq!(group(big), vec![0..1, 1..2]);
    }

    fn page(lines: Vec<Line>) -> PageLines {
        PageLines {
            lines,
            paragraphs: Vec::new(),
        }
    }

    #[test]
    fn room_before_is_the_gap_to_the_line_ending_before() {
        let p = page(vec![
            line(0, "a", 10.0, 50.0, 700.0),
            line(1, "b", 80.0, 120.0, 700.0),
        ]);
        assert_eq!(p.room_before(1), Some(30.0));
        assert_eq!(p.room_before(0), None, "nothing precedes the first");
        assert_eq!(p.room_before(9), None, "no such line");
    }

    #[test]
    fn room_before_ignores_other_baselines_and_answers_zero_on_overlap() {
        let other_row = page(vec![
            line(0, "a", 10.0, 50.0, 650.0),
            line(1, "b", 80.0, 120.0, 700.0),
        ]);
        assert_eq!(other_row.room_before(1), None);
        let overlap = page(vec![
            line(0, "a", 10.0, 90.0, 700.0),
            line(1, "b", 80.0, 120.0, 700.0),
        ]);
        assert_eq!(overlap.room_before(1), Some(0.0));
    }
}
