//! The operator walk shared by redaction and text editing (ARCHITECTURE §13.1): the content of a page and of the Form XObjects it
//! draws, with the full graphics and text state, reported glyph by glyph to a [`WalkSink`].
//!
//! W0 seam: signatures only, [`walk`] is `not_yet`.

use std::ops::Range;

use lopdf::{Document, ObjectId};

use crate::error::AppError;
use crate::limits;

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
    pub ops: Range<OpRef>,
    pub font: FontKey,
    pub in_form: bool,
    /// Text rendering mode (`Tr`); 3 is invisible.
    pub render_mode: u8,
    /// Text rise (`Ts`) in text space units.
    pub rise: f64,
    /// Whether a clipping mode, a clip path or an `ActualText` span is active.
    pub clipped: bool,
    pub glyphs: Vec<GlyphPos>,
}

/// What the walk may spend: operators and content bytes (`MAX_REDACT_OPS`, `MAX_REDACT_CONTENT_BYTES`).
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

/// Walks `page` of `src`. `limit_exceeded` when a budget runs out, `invalid_argument` for content that does not parse.
pub fn walk(
    _src: &Document,
    _page: ObjectId,
    _budget: &mut Budget,
    _sink: &mut dyn WalkSink,
) -> Result<(), AppError> {
    Err(AppError::not_yet())
}
