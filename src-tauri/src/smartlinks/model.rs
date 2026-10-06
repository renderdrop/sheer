//! The shared types of smart-link detection (ADR-132, DESIGN §3.11). Detectors are pure functions over [`DocText`]; the engine
//! fills it from PDFium (one page at a time, bounded), the command layer turns [`SmartLink`]s into the wire payload.

use serde::{Deserialize, Serialize};

/// A rectangle in page points, origin top-left of the (unrotated) page, y down.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct PtRect {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

/// One run of characters with one size on one line: the unit detectors look at.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Run {
    pub text: String,
    pub rect: PtRect,
    pub size: f32,
    pub baseline: f32,
    pub bold: bool,
}

/// One text line of a page in reading order.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Line {
    pub runs: Vec<Run>,
    pub rect: PtRect,
}

/// What detection knows about one page.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PageText {
    pub page: u32,
    pub width: f32,
    pub height: f32,
    pub lines: Vec<Line>,
    pub body_size: f32,
}

/// The pages read so far plus the document facts detectors need.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct DocText {
    pub pages: Vec<PageText>,
    pub page_count: u32,
    pub labels: Vec<Option<String>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    Footnote,
    NoteBack,
    Contents,
    Reference,
    Literature,
}

/// Where a link goes: a page (0-based physical index) and optionally the target lines' box on it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Target {
    pub page: u32,
    pub rect: Option<PtRect>,
    /// The page number as printed on the source ("1", "iv"), when the link names one: contents lines and page references.
    #[serde(default)]
    pub label: Option<String>,
}

/// One detected link on `page`: the source box(es), its target, the preview text (≤ 280 chars) and the score that admitted it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SmartLink {
    pub kind: Kind,
    pub page: u32,
    pub rects: Vec<PtRect>,
    pub marker: String,
    pub target: Target,
    pub preview: String,
    pub score: f32,
}
