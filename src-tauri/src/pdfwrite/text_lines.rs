//! Runs to lines to paragraphs, and the mapping to PDFium's characters (ARCHITECTURE §13.2).
//!
//! W0 seam: signatures only, [`lines`] and [`probe`] are `not_yet`.

use lopdf::{Document, ObjectId};

use super::ops_walk::Run;
use crate::error::AppError;
use crate::model::geometry::Rect;
use crate::model::text_edit::{CharGeom, LineEditable, TextLineInfo};

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

/// The lines of `page`; `chars` are PDFium's characters (the Unicode check of the mapping). At most `limits::TEXT_EDIT_LINES_PER_PAGE`.
pub fn lines(_src: &Document, _page: ObjectId, _chars: &[CharGeom]) -> Result<PageLines, AppError> {
    Err(AppError::not_yet())
}

/// The line that holds the character at UTF-16 index `unit` of the text layer, as the UI is told (`unmapped` is a refusal, not an error).
pub fn probe(
    _lines: &PageLines,
    _chars: &[CharGeom],
    _unit: u32,
) -> Result<TextLineInfo, AppError> {
    Err(AppError::not_yet())
}
