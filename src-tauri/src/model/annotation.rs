//! The annotation domain model (ADR-003 §2): what an annotation is, independent of PDFium and of the PDF file it came from.
//!
//! Page space as in [`super::geometry`]. The structs are the source of the wire format (camelCase, `kind` tags); the TypeScript
//! mirror is `src/api/annotations.ts`. Everything that arrives from the UI or from a file is checked here ([`Annotation::normalize`]):
//! counts, string lengths and numbers are bounded by `limits.rs`, coordinates are finite and within a page's range, and the bounding
//! rectangle ([`Annotation::rect`]) is always computed by Rust from the geometry, never taken from the caller.

use serde::{Deserialize, Deserializer, Serialize};

use super::geometry::{Point, Quad, Rect};
use super::ids::{AnnotId, AssetId};
use crate::documents::PageId;
use crate::error::AppError;
use crate::limits;

/// Side of the box a note icon occupies on the page, in points (notes do not scale with the zoom).
pub const NOTE_SIZE_PT: f32 = 20.0;

/// The review state a reply gives its parent (PDF 32000-1 section 12.5.6.3: `/StateModel /Review`, `/State`). A comment's status is the
/// state of its newest reply that has one; `None` is "reopened".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ReviewState {
    None,
    Accepted,
    Rejected,
    Cancelled,
    Completed,
}

impl ReviewState {
    /// The name `/State` has in the file.
    pub const fn pdf_name(self) -> &'static str {
        match self {
            Self::None => "None",
            Self::Accepted => "Accepted",
            Self::Rejected => "Rejected",
            Self::Cancelled => "Cancelled",
            Self::Completed => "Completed",
        }
    }

    /// The state a `/State` value of the Review model names; `Option::None` for anything else (a state of the Marked model included).
    pub fn from_pdf(text: &[u8]) -> Option<Self> {
        match text {
            b"None" => Some(Self::None),
            b"Accepted" => Some(Self::Accepted),
            b"Rejected" => Some(Self::Rejected),
            b"Cancelled" => Some(Self::Cancelled),
            b"Completed" => Some(Self::Completed),
            _ => Option::None,
        }
    }
}

/// A colour, 0 to 255 per channel.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Rgb(pub [u8; 3]);

/// How the end of a line is drawn.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LineEnd {
    None,
    OpenArrow,
    ClosedArrow,
}

/// The icon of a note.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NoteIcon {
    Comment,
    Note,
    Help,
}

/// Whether the annotation is in the file as it is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Sync {
    /// Created in this session, not in the file yet.
    New,
    /// As in the file.
    Clean,
    /// In the file, changed in this session.
    Modified,
}

/// One freehand stroke: the points the user drew, and the outline polygon that is filled (perfect-freehand output, ADR-003 §3).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Stroke {
    pub points: Vec<Point>,
    pub outline: Vec<Point>,
}

/// The smallest side of a signature or a mark, in points (ADR-041 §5).
pub const MIN_SIGNATURE_SIDE_PT: f32 = 4.0;
/// The bounds of `bounds` turned `angle` degrees about its centre.
pub fn rotated_bounds(bounds: Rect, angle: f32) -> Rect {
    let (sin, cos) = angle.to_radians().sin_cos();
    let w = bounds.w * cos.abs() + bounds.h * sin.abs();
    let h = bounds.w * sin.abs() + bounds.h * cos.abs();
    let (cx, cy) = (bounds.x + bounds.w / 2.0, bounds.y + bounds.h / 2.0);
    Rect {
        x: cx - w / 2.0,
        y: cy - h / 2.0,
        w,
        h,
    }
}

/// An angle in degrees brought into (-180, 180] and rounded to a hundredth; `None` if it is not a finite number.
pub fn normalize_angle(angle: f32) -> Option<f32> {
    if !angle.is_finite() {
        return None;
    }
    let mut turned = angle.rem_euclid(360.0);
    if turned > 180.0 {
        turned -= 360.0;
    }
    let rounded = (turned * 100.0).round() / 100.0;
    // -0 is no turn.
    Some(if rounded == 0.0 { 0.0 } else { rounded })
}

/// The range of a signature's aspect ratio (width over height).
pub const SIGNATURE_ASPECT_RANGE: std::ops::RangeInclusive<f32> = 0.01..=100.0;

/// What a signature is for: a full signature or initials.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SignatureRole {
    Signature,
    Initials,
}

/// The three marks of Fill & Sign for flat forms.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MarkGlyph {
    Check,
    Cross,
    Dot,
}

/// Where the picture of a signature comes from.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SignatureArtRef {
    /// Art of the document's asset store (`signatures::AssetStore`); the aspect ratio is width over height.
    Asset { asset_id: AssetId, aspect: f32 },
    /// The appearance that is in the file already: kept as it is. Only an import makes one. It does deserialize: the engine
    /// child's replies carry it (ADR-115); `Annotation::from_draft` refuses it from the UI.
    File,
}

/// The three faces of a text box (ADR-047 §1): the standard 14 Helvetica, Times-Roman and Courier, WinAnsi only.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StdFont {
    Sans,
    Serif,
    Mono,
}

/// Horizontal alignment of a text box.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TextAlign {
    #[default]
    Left,
    Center,
    Right,
}

/// Where a redaction mark came from: a text search or selection, or an area the user drew.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RedactSource {
    Text,
    Area,
}

/// What kind of annotation it is and the geometry that belongs to the kind.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum AnnotationBody {
    Highlight {
        quads: Vec<Quad>,
    },
    Underline {
        quads: Vec<Quad>,
    },
    Strikeout {
        quads: Vec<Quad>,
    },
    Note {
        at: Point,
        icon: NoteIcon,
    },
    FreeText {
        #[serde(rename = "box")]
        bounds: Rect,
        lines: Vec<String>,
        font_size: f32,
        fill: Option<Rgb>,
        border_width: f32,
        /// `/Q`: how each line sits in the box (ADR-110).
        #[serde(default)]
        align: TextAlign,
        /// Colour of the border; `None` draws it in the text colour (what older drafts and files have).
        #[serde(default)]
        border_color: Option<Rgb>,
    },
    Ink {
        strokes: Vec<Stroke>,
        width: f32,
    },
    Rect {
        #[serde(rename = "box")]
        bounds: Rect,
        width: f32,
        fill: Option<Rgb>,
        dashed: bool,
    },
    Ellipse {
        #[serde(rename = "box")]
        bounds: Rect,
        width: f32,
        fill: Option<Rgb>,
        dashed: bool,
    },
    Line {
        from: Point,
        to: Point,
        width: f32,
        head: LineEnd,
        tail: LineEnd,
    },
    /// A signature or initials (ADR-041 §5): a `/Stamp` named `sheer-sig-` or `sheer-ini-`.
    Signature {
        #[serde(rename = "box")]
        bounds: Rect,
        role: SignatureRole,
        art: SignatureArtRef,
        /// The turn of the box about its centre, in degrees, clockwise on the page (y down), in (-180, 180] (ADR-105). `box` is the
        /// box before the turn, `rect` the bounds of the turned box.
        #[serde(default)]
        angle: f32,
    },
    /// A check, a cross or a dot of Fill & Sign: a `/Stamp` named `sheer-mark-<glyph>-`, drawn in the annotation's colour.
    Mark {
        #[serde(rename = "box")]
        bounds: Rect,
        glyph: MarkGlyph,
        /// As for [`AnnotationBody::Signature`].
        #[serde(default)]
        angle: f32,
    },
    /// A text box (ADR-047 §1): page content, not a comment. Edited like an annotation until a save burns it into the page. `lines`
    /// is Rust's layout of `text` in the box (read-only for the UI); the box grows in height to fit it. The colour is the text's.
    TextBox {
        #[serde(rename = "box")]
        bounds: Rect,
        text: String,
        #[serde(default)]
        lines: Vec<String>,
        font: StdFont,
        font_size: f32,
        align: TextAlign,
    },
    /// An image (ADR-047 §1): page content like [`AnnotationBody::TextBox`]. The pixels are a document asset; `aspect` is width over height.
    Image {
        #[serde(rename = "box")]
        bounds: Rect,
        asset_id: AssetId,
        aspect: f32,
    },
    /// A mark for true redaction (ADR-047 §3): in the model only, never written to a file and never imported.
    RedactMark {
        quads: Vec<Quad>,
        source: RedactSource,
    },
    /// An annotation of a kind the model does not edit (ink and lines from other programs, stamps, squiggly, ...): listed so it can be
    /// shown and selected, never changed or deleted. Only an import makes one (it does deserialize, for the engine
    /// child's replies, ADR-115; `Annotation::from_draft` refuses it from the UI).
    Opaque {
        subtype: String,
    },
}

impl AnnotationBody {
    fn is_opaque(&self) -> bool {
        matches!(self, Self::Opaque { .. })
    }

    /// A text box or an image: page content that a save burns into the page. Not a comment, and not written as an annotation.
    pub fn is_content(&self) -> bool {
        matches!(self, Self::TextBox { .. } | Self::Image { .. })
    }

    /// A redaction mark: model only.
    pub fn is_redact_mark(&self) -> bool {
        matches!(self, Self::RedactMark { .. })
    }

    /// Whether the annotation has a place in the file as an annotation (`/Annots`): not content, not a mark.
    pub fn is_written_as_annotation(&self) -> bool {
        !self.is_content() && !self.is_redact_mark()
    }
}

/// An annotation as the UI sees it (ADR-003 §2).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Annotation {
    pub id: AnnotId,
    pub page_id: PageId,
    /// The bounding box, computed by Rust from the geometry.
    pub rect: Rect,
    pub color: Rgb,
    pub opacity: f32,
    pub contents: String,
    pub author: Option<String>,
    pub modified: Option<String>,
    /// The annotation this one replies to (`/IRT`).
    pub in_reply_to: Option<AnnotId>,
    /// Set on a review reply (a note without text that only gives its parent a state); the UI does not draw it on the page.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state: Option<ReviewState>,
    pub locked: bool,
    pub sync: Sync,
    /// Set on a citation (a Highlight with `/SHR_Cite`, ADR-119); `null` for any other annotation. Old data and old engine
    /// messages have no such key.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cite: Option<super::quote::Cite>,
    /// Tag names (`/SHR_Tags`, at most `limits::TAGS_PER_ANNOT`), see `model::tags`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
    #[serde(flatten)]
    pub body: AnnotationBody,
}

/// An annotation to create: an [`Annotation`] without the fields Rust assigns (`id`, `rect`, `sync`, `modified`).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnnotationDraft {
    pub page_id: PageId,
    pub color: Rgb,
    #[serde(default = "full_opacity")]
    pub opacity: f32,
    #[serde(default)]
    pub contents: String,
    #[serde(default)]
    pub author: Option<String>,
    #[serde(default)]
    pub in_reply_to: Option<AnnotId>,
    /// Makes the draft a review reply: needs `in_reply_to`, a note body and no text.
    #[serde(default)]
    pub state: Option<ReviewState>,
    #[serde(default)]
    pub locked: bool,
    /// Tag names (ADR-119), validated like a patch.
    #[serde(default)]
    pub tags: Vec<String>,
    /// Makes a Highlight a citation. Rust only (`create_citations` takes the quote from the page text): never read from the UI.
    #[serde(default, skip_deserializing)]
    pub cite: Option<super::quote::Cite>,
    #[serde(flatten)]
    pub body: AnnotationBody,
}

fn full_opacity() -> f32 {
    1.0
}

/// `Some(None)` for an explicit `null` (clear the field), `None` for a missing key (leave it).
fn nullable<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

/// A change to an annotation: only the fields that are present change. A field that does not belong to the kind is refused
/// (`invalid_argument`, `patch`); an unknown key does not even parse.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AnnotationPatch {
    pub color: Option<Rgb>,
    pub opacity: Option<f32>,
    pub contents: Option<String>,
    #[serde(default, deserialize_with = "nullable")]
    pub author: Option<Option<String>>,
    pub locked: Option<bool>,
    pub quads: Option<Vec<Quad>>,
    pub at: Option<Point>,
    pub icon: Option<NoteIcon>,
    #[serde(rename = "box")]
    pub bounds: Option<Rect>,
    pub lines: Option<Vec<String>>,
    pub font_size: Option<f32>,
    #[serde(default, deserialize_with = "nullable")]
    pub fill: Option<Option<Rgb>>,
    pub border_width: Option<f32>,
    /// The border colour of a free text (ADR-110).
    pub border_color: Option<Rgb>,
    pub strokes: Option<Vec<Stroke>>,
    pub width: Option<f32>,
    pub dashed: Option<bool>,
    pub from: Option<Point>,
    pub to: Option<Point>,
    pub head: Option<LineEnd>,
    pub tail: Option<LineEnd>,
    pub text: Option<String>,
    pub font: Option<StdFont>,
    pub align: Option<TextAlign>,
    /// The turn of a signature or a mark (ADR-105), in degrees.
    pub angle: Option<f32>,
    /// Replaces the tag names (ADR-119; coalesce key `tags`): 0..=`TAGS_PER_ANNOT` names, see `model::tags::clean_names`.
    pub tags: Option<Vec<String>>,
    /// Replaces the quote of a citation, 1..=`CITE_QUOTE_MAX` characters (ADR-119); `invalid_argument` (`patch`) on anything else.
    pub quote: Option<String>,
}

/// Where an annotation sits in the PDF it was imported from. Rust only; the UI never sees it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct PdfOrigin {
    pub page_index: u32,
    /// Position in the page's `/Annots` when it was loaded.
    pub annot_index: u32,
    /// `/NM`, the annotation's identity across reloads.
    pub name: Option<String>,
}

/// An annotation as the engine reads it from a file (`engine::import`), before it has an id.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Imported {
    pub origin: PdfOrigin,
    pub body: AnnotationBody,
    /// Used for [`AnnotationBody::Opaque`] only; every other kind gets its rectangle from its geometry.
    pub rect: Rect,
    pub color: Rgb,
    pub opacity: f32,
    pub contents: String,
    pub author: Option<String>,
    pub modified: Option<String>,
    pub locked: bool,
    /// The file marks the annotation Hidden: PDFium does not draw it, and undo must not show it (`DocState::hidden_origins`).
    pub hidden: bool,
}

// --- Validation ------------------------------------------------------------------------------------------------

fn coordinate(value: f32, what: &'static str) -> Result<(), AppError> {
    if value.is_finite() && value.abs() <= limits::MAX_PAGE_SIDE_PT {
        Ok(())
    } else {
        Err(AppError::invalid(what))
    }
}

fn check_point(point: Point, what: &'static str) -> Result<(), AppError> {
    coordinate(point.x, what)?;
    coordinate(point.y, what)
}

fn check_rect(rect: Rect, what: &'static str) -> Result<(), AppError> {
    for value in [rect.x, rect.y, rect.w, rect.h] {
        coordinate(value, what)?;
    }
    if rect.w < 0.0 || rect.h < 0.0 {
        return Err(AppError::invalid(what));
    }
    Ok(())
}

fn check_width(width: f32, what: &'static str) -> Result<(), AppError> {
    if width.is_finite() && (0.0..=limits::MAX_ANNOT_STROKE_PT).contains(&width) {
        Ok(())
    } else {
        Err(AppError::invalid(what))
    }
}

/// `text` has at most `max` characters and no NUL or other control character (a tab, and a line break when `multiline`, excepted).
fn check_text(text: &str, max: usize, multiline: bool, what: &'static str) -> Result<(), AppError> {
    let mut count = 0usize;
    for c in text.chars() {
        count += 1;
        let allowed = !c.is_control() || c == '\t' || (multiline && (c == '\n' || c == '\r'));
        if count > max || !allowed {
            return Err(AppError::invalid(what));
        }
    }
    Ok(())
}

/// The box of a signature or a mark: in range and at least [`MIN_SIGNATURE_SIDE_PT`] on each side.
fn check_stamp_box(bounds: Rect) -> Result<(), AppError> {
    check_rect(bounds, "box")?;
    if bounds.w < MIN_SIGNATURE_SIDE_PT || bounds.h < MIN_SIGNATURE_SIDE_PT {
        return Err(AppError::invalid("box"));
    }
    Ok(())
}

/// The turn of a signature or a mark: a finite number in (-180, 180] (the model normalises it first).
fn check_stamp_angle(angle: f32) -> Result<(), AppError> {
    if angle.is_finite() && angle > -180.0 && angle <= 180.0 {
        Ok(())
    } else {
        Err(AppError::invalid("angle"))
    }
}

fn check_quads(quads: &[Quad]) -> Result<(), AppError> {
    if quads.is_empty() {
        return Err(AppError::invalid("quads"));
    }
    if quads.len() > limits::MAX_ANNOT_QUADS {
        return Err(AppError::limit("quads", limits::MAX_ANNOT_QUADS as u64));
    }
    quads
        .iter()
        .flatten()
        .try_for_each(|point| check_point(*point, "quads"))
}

fn check_strokes(strokes: &[Stroke]) -> Result<(), AppError> {
    if strokes.is_empty() {
        return Err(AppError::invalid("strokes"));
    }
    if strokes.len() > limits::MAX_INK_STROKES {
        return Err(AppError::limit("strokes", limits::MAX_INK_STROKES as u64));
    }
    let mut total = 0usize;
    for stroke in strokes {
        if stroke.points.is_empty() {
            return Err(AppError::invalid("strokes"));
        }
        if stroke.points.len() > limits::MAX_INK_POINTS_PER_STROKE
            || stroke.outline.len() > limits::MAX_INK_POINTS_PER_STROKE
        {
            return Err(AppError::limit(
                "points",
                limits::MAX_INK_POINTS_PER_STROKE as u64,
            ));
        }
        total += stroke.points.len() + stroke.outline.len();
        if total > limits::MAX_INK_POINTS_TOTAL {
            return Err(AppError::limit(
                "points",
                limits::MAX_INK_POINTS_TOTAL as u64,
            ));
        }
        stroke
            .points
            .iter()
            .chain(&stroke.outline)
            .try_for_each(|point| check_point(*point, "strokes"))?;
    }
    Ok(())
}

/// Collects the extent of some points.
struct Extent {
    min: Point,
    max: Point,
    empty: bool,
}

impl Extent {
    fn new() -> Self {
        Self {
            min: Point { x: 0.0, y: 0.0 },
            max: Point { x: 0.0, y: 0.0 },
            empty: true,
        }
    }

    fn add(&mut self, point: Point) {
        if self.empty {
            self.min = point;
            self.max = point;
            self.empty = false;
        } else {
            self.min.x = self.min.x.min(point.x);
            self.min.y = self.min.y.min(point.y);
            self.max.x = self.max.x.max(point.x);
            self.max.y = self.max.y.max(point.y);
        }
    }

    fn rect(&self, pad: f32) -> Rect {
        Rect {
            x: self.min.x - pad,
            y: self.min.y - pad,
            w: self.max.x - self.min.x + 2.0 * pad,
            h: self.max.y - self.min.y + 2.0 * pad,
        }
    }
}

fn padded(rect: Rect, pad: f32) -> Rect {
    Rect {
        x: rect.x - pad,
        y: rect.y - pad,
        w: rect.w + 2.0 * pad,
        h: rect.h + 2.0 * pad,
    }
}

impl AnnotationBody {
    /// Checks the geometry and returns the bounding box. `rect` is what an opaque annotation brings along.
    fn check(&self, rect: Rect) -> Result<Rect, AppError> {
        match self {
            Self::Highlight { quads } | Self::Underline { quads } | Self::Strikeout { quads } => {
                check_quads(quads)?;
                let mut extent = Extent::new();
                quads.iter().flatten().for_each(|point| extent.add(*point));
                Ok(extent.rect(0.0))
            }
            Self::Note { at, .. } => {
                check_point(*at, "at")?;
                Ok(Rect {
                    x: at.x,
                    y: at.y,
                    w: NOTE_SIZE_PT,
                    h: NOTE_SIZE_PT,
                })
            }
            Self::FreeText {
                bounds,
                lines,
                font_size,
                border_width,
                ..
            } => {
                check_rect(*bounds, "box")?;
                if lines.len() > limits::MAX_FREE_TEXT_LINES {
                    return Err(AppError::limit("lines", limits::MAX_FREE_TEXT_LINES as u64));
                }
                for line in lines {
                    check_text(line, limits::MAX_FREE_TEXT_LINE_CHARS, false, "lines")?;
                }
                if !font_size.is_finite()
                    || !(limits::MIN_FONT_SIZE_PT..=limits::MAX_FONT_SIZE_PT).contains(font_size)
                {
                    return Err(AppError::invalid("fontSize"));
                }
                check_width(*border_width, "borderWidth")?;
                Ok(*bounds)
            }
            Self::Ink { strokes, width } => {
                check_width(*width, "width")?;
                check_strokes(strokes)?;
                let mut extent = Extent::new();
                for stroke in strokes {
                    stroke
                        .points
                        .iter()
                        .chain(&stroke.outline)
                        .for_each(|point| extent.add(*point));
                }
                Ok(extent.rect(width / 2.0))
            }
            Self::Rect { bounds, width, .. } | Self::Ellipse { bounds, width, .. } => {
                check_rect(*bounds, "box")?;
                check_width(*width, "width")?;
                Ok(padded(*bounds, width / 2.0))
            }
            Self::Line {
                from,
                to,
                width,
                head,
                tail,
            } => {
                check_point(*from, "from")?;
                check_point(*to, "to")?;
                check_width(*width, "width")?;
                let mut extent = Extent::new();
                extent.add(*from);
                extent.add(*to);
                // An arrow head (3 widths + 6 pt long, 30 degrees) reaches out sideways by less than this.
                let arrow = if *head == LineEnd::None && *tail == LineEnd::None {
                    0.0
                } else {
                    (width * 5.0).max(width * 1.5 + 3.0)
                };
                Ok(extent.rect(width / 2.0 + arrow))
            }
            Self::Signature {
                bounds, art, angle, ..
            } => {
                check_stamp_box(*bounds)?;
                if let SignatureArtRef::Asset { aspect, .. } = art {
                    if !aspect.is_finite() || !SIGNATURE_ASPECT_RANGE.contains(aspect) {
                        return Err(AppError::invalid("art"));
                    }
                }
                check_stamp_angle(*angle)?;
                Ok(rotated_bounds(*bounds, *angle))
            }
            Self::Mark { bounds, angle, .. } => {
                check_stamp_box(*bounds)?;
                check_stamp_angle(*angle)?;
                Ok(rotated_bounds(*bounds, *angle))
            }
            Self::TextBox {
                bounds,
                text,
                font_size,
                ..
            } => {
                check_rect(*bounds, "box")?;
                if bounds.w < limits::MIN_CONTENT_BOX_PT {
                    return Err(AppError::invalid("box"));
                }
                check_text(text, limits::MAX_TEXT_BOX_CHARS, true, "text")?;
                if !font_size.is_finite()
                    || !(limits::MIN_TEXT_BOX_FONT_PT..=limits::MAX_TEXT_BOX_FONT_PT)
                        .contains(font_size)
                {
                    return Err(AppError::invalid("fontSize"));
                }
                Ok(*bounds)
            }
            Self::Image { bounds, aspect, .. } => {
                check_rect(*bounds, "box")?;
                if bounds.w < limits::MIN_CONTENT_BOX_PT || bounds.h < limits::MIN_CONTENT_BOX_PT {
                    return Err(AppError::invalid("box"));
                }
                if !aspect.is_finite() || !SIGNATURE_ASPECT_RANGE.contains(aspect) {
                    return Err(AppError::invalid("aspect"));
                }
                Ok(*bounds)
            }
            Self::RedactMark { quads, .. } => {
                check_quads(quads)?;
                crate::model::redaction::check_mark(self)?;
                let mut extent = Extent::new();
                quads.iter().flatten().for_each(|point| extent.add(*point));
                Ok(extent.rect(0.0))
            }
            Self::Opaque { subtype } => {
                check_text(subtype, limits::MAX_ANNOT_AUTHOR_CHARS, false, "subtype")?;
                check_rect(rect, "rect")?;
                Ok(rect)
            }
        }
    }

    /// Moves the geometry by (`dx`, `dy`).
    fn translate(&mut self, dx: f32, dy: f32) {
        let shift = |point: &mut Point| {
            point.x += dx;
            point.y += dy;
        };
        match self {
            Self::Highlight { quads } | Self::Underline { quads } | Self::Strikeout { quads } => {
                quads.iter_mut().flatten().for_each(shift);
            }
            Self::Note { at, .. } => shift(at),
            Self::FreeText { bounds, .. }
            | Self::Rect { bounds, .. }
            | Self::Ellipse { bounds, .. }
            | Self::Signature { bounds, .. }
            | Self::Mark { bounds, .. }
            | Self::TextBox { bounds, .. }
            | Self::Image { bounds, .. } => {
                bounds.x += dx;
                bounds.y += dy;
            }
            Self::Ink { strokes, .. } => {
                for stroke in strokes {
                    stroke
                        .points
                        .iter_mut()
                        .chain(&mut stroke.outline)
                        .for_each(shift);
                }
            }
            Self::Line { from, to, .. } => {
                shift(from);
                shift(to);
            }
            Self::RedactMark { quads, .. } => quads.iter_mut().flatten().for_each(shift),
            Self::Opaque { .. } => {}
        }
    }
}

impl Annotation {
    /// Checks every field and recomputes `rect` from the geometry. Run on everything that enters the model.
    pub fn normalize(&mut self) -> Result<(), AppError> {
        if !self.opacity.is_finite() || !(0.0..=1.0).contains(&self.opacity) {
            return Err(AppError::invalid("opacity"));
        }
        check_text(
            &self.contents,
            limits::MAX_ANNOT_CONTENTS_CHARS,
            true,
            "contents",
        )?;
        if let Some(author) = &self.author {
            check_text(author, limits::MAX_ANNOT_AUTHOR_CHARS, false, "author")?;
        }
        if let Some(modified) = &self.modified {
            check_text(modified, limits::MAX_ANNOT_DATE_CHARS, false, "modified")?;
        }
        if self.in_reply_to == Some(self.id) {
            return Err(AppError::invalid("inReplyTo"));
        }
        self.check_citation()?;
        if let AnnotationBody::Signature { angle, .. } | AnnotationBody::Mark { angle, .. } =
            &mut self.body
        {
            *angle = normalize_angle(*angle).ok_or_else(|| AppError::invalid("angle"))?;
        }
        self.body.check(self.rect)?;
        // Rust lays a text box out: the lines, and a box that is as tall as they are (ADR-047 §1).
        if let AnnotationBody::TextBox {
            bounds,
            text,
            lines,
            font,
            font_size,
            align,
        } = &mut self.body
        {
            crate::content::text::layout_box(bounds, text, lines, *font, *font_size, *align)?;
        }
        self.rect = self.body.check(self.rect)?;
        Ok(())
    }

    /// The annotation `draft` becomes under `id`, last modified `now`. Validated.
    pub fn from_draft(id: AnnotId, draft: &AnnotationDraft, now: &str) -> Result<Self, AppError> {
        if draft.body.is_opaque() {
            return Err(AppError::invalid("kind"));
        }
        // Art that is "in the file" is the import's: a new signature always brings its own.
        if matches!(
            draft.body,
            AnnotationBody::Signature {
                art: SignatureArtRef::File,
                ..
            }
        ) {
            return Err(AppError::invalid("art"));
        }
        let mut annotation = Self {
            id,
            page_id: draft.page_id,
            rect: Rect {
                x: 0.0,
                y: 0.0,
                w: 0.0,
                h: 0.0,
            },
            color: draft.color,
            opacity: draft.opacity,
            contents: draft.contents.clone(),
            author: draft.author.clone(),
            modified: Some(now.to_owned()),
            in_reply_to: draft.in_reply_to,
            state: draft.state,
            locked: draft.locked,
            sync: Sync::New,
            cite: draft.cite.clone(),
            tags: super::tags::clean_names(&draft.tags)?,
            body: draft.body.clone(),
        };
        if draft.state.is_some()
            && (draft.in_reply_to.is_none()
                || !matches!(draft.body, AnnotationBody::Note { .. })
                || !draft.contents.is_empty())
        {
            return Err(AppError::invalid("state"));
        }
        annotation.normalize()?;
        Ok(annotation)
    }

    /// The cite record and the tags are well formed: only a Highlight is a citation (a quote of 1..=`CITE_QUOTE_MAX` characters, a group
    /// of 8 hex characters if any), and an opaque annotation has no tags (the model does not change it).
    fn check_citation(&self) -> Result<(), AppError> {
        if let Some(cite) = &self.cite {
            if !matches!(self.body, AnnotationBody::Highlight { .. }) {
                return Err(AppError::invalid("cite"));
            }
            super::quote::check_quote(&cite.quote).map_err(|_| AppError::invalid("quote"))?;
            if cite
                .group
                .as_deref()
                .is_some_and(|group| !super::quote::is_group_id(group))
            {
                return Err(AppError::invalid("cite"));
            }
        }
        if self.tags.len() > limits::TAGS_PER_ANNOT {
            return Err(AppError::invalid("tags"));
        }
        for tag in &self.tags {
            let length = tag.chars().count();
            if length == 0 || length > limits::TAG_NAME_MAX || tag.chars().any(char::is_control) {
                return Err(AppError::invalid("tags"));
            }
        }
        Ok(())
    }

    /// Gives an annotation just read from the file what its `/SHR_Cite` and `/SHR_Tags` say (ADR-119). The file is hostile input: what
    /// does not pass is left out (a quote of the wrong length, a cite on something that is not a Highlight, tags on an opaque one).
    pub fn apply_file_keys(&mut self, cite: Option<&super::quote::Cite>, tags: &[String]) {
        if self.is_opaque() {
            return;
        }
        self.tags = super::tags::clean_names_lenient(tags.iter().cloned());
        self.cite = cite
            .filter(|_| matches!(self.body, AnnotationBody::Highlight { .. }))
            .map(|cite| super::quote::Cite {
                quote: super::quote::normalize_quote(&cite.quote),
                group: cite
                    .group
                    .clone()
                    .filter(|group| super::quote::is_group_id(group)),
            })
            .filter(|cite| super::quote::check_quote(&cite.quote).is_ok());
    }

    /// Whether the user may change or delete it.
    pub fn is_opaque(&self) -> bool {
        self.body.is_opaque()
    }

    /// This annotation with `patch` applied and `modified` set to `now`, validated. A field that does not belong to the kind is
    /// `invalid_argument` (`patch`).
    pub fn patched(&self, patch: &AnnotationPatch, now: &str) -> Result<Self, AppError> {
        let mut next = self.clone();
        if let Some(tags) = &patch.tags {
            next.tags = super::tags::clean_names(tags)?;
        }
        if let Some(quote) = &patch.quote {
            // Only a citation has a quote.
            let cite = next
                .cite
                .as_mut()
                .ok_or_else(|| AppError::invalid("patch"))?;
            let quote = super::quote::normalize_quote(quote);
            super::quote::check_quote(&quote).map_err(|_| AppError::invalid("patch"))?;
            cite.quote = quote;
        }
        if let Some(color) = patch.color {
            next.color = color;
        }
        if let Some(opacity) = patch.opacity {
            next.opacity = opacity;
        }
        if let Some(contents) = &patch.contents {
            next.contents.clone_from(contents);
        }
        if let Some(author) = &patch.author {
            next.author.clone_from(author);
        }
        if let Some(locked) = patch.locked {
            next.locked = locked;
        }
        let wrong = || AppError::invalid("patch");
        let AnnotationPatch {
            quads,
            at,
            icon,
            bounds,
            lines,
            font_size,
            fill,
            border_width,
            border_color,
            strokes,
            width,
            dashed,
            from,
            to,
            head,
            tail,
            text,
            font,
            align,
            angle,
            ..
        } = patch;
        // Every geometry field of the patch must be one the kind has; `take` marks the ones used, and what is left over is wrong.
        let mut left = [
            quads.is_some(),
            at.is_some(),
            icon.is_some(),
            bounds.is_some(),
            lines.is_some(),
            font_size.is_some(),
            fill.is_some(),
            border_width.is_some(),
            border_color.is_some(),
            strokes.is_some(),
            width.is_some(),
            dashed.is_some(),
            from.is_some(),
            to.is_some(),
            head.is_some(),
            tail.is_some(),
            text.is_some(),
            font.is_some(),
            align.is_some(),
            angle.is_some(),
        ]
        .iter()
        .filter(|present| **present)
        .count();
        let mut used = |present: bool| {
            if present {
                left -= 1;
            }
        };
        fn set<T: Clone>(slot: &mut T, value: &Option<T>, used: &mut impl FnMut(bool)) {
            if let Some(value) = value {
                slot.clone_from(value);
                used(true);
            }
        }
        match &mut next.body {
            AnnotationBody::Highlight { quads: q }
            | AnnotationBody::Underline { quads: q }
            | AnnotationBody::Strikeout { quads: q } => set(q, quads, &mut used),
            AnnotationBody::Note { at: a, icon: i } => {
                set(a, at, &mut used);
                set(i, icon, &mut used);
            }
            AnnotationBody::FreeText {
                bounds: b,
                lines: l,
                font_size: f,
                fill: fl,
                border_width: bw,
                align: al,
                border_color: bc,
            } => {
                set(b, bounds, &mut used);
                set(l, lines, &mut used);
                set(f, font_size, &mut used);
                set(fl, fill, &mut used);
                set(bw, border_width, &mut used);
                set(al, align, &mut used);
                if let Some(color) = border_color {
                    *bc = Some(*color);
                    used(true);
                }
            }
            AnnotationBody::Ink {
                strokes: s,
                width: w,
            } => {
                set(s, strokes, &mut used);
                set(w, width, &mut used);
            }
            AnnotationBody::Rect {
                bounds: b,
                width: w,
                fill: fl,
                dashed: d,
            }
            | AnnotationBody::Ellipse {
                bounds: b,
                width: w,
                fill: fl,
                dashed: d,
            } => {
                set(b, bounds, &mut used);
                set(w, width, &mut used);
                set(fl, fill, &mut used);
                set(d, dashed, &mut used);
            }
            AnnotationBody::Line {
                from: f,
                to: t,
                width: w,
                head: h,
                tail: tl,
            } => {
                set(f, from, &mut used);
                set(t, to, &mut used);
                set(w, width, &mut used);
                set(h, head, &mut used);
                set(tl, tail, &mut used);
            }
            AnnotationBody::Signature {
                bounds: b,
                angle: turn,
                ..
            }
            | AnnotationBody::Mark {
                bounds: b,
                angle: turn,
                ..
            } => {
                set(b, bounds, &mut used);
                set(turn, angle, &mut used);
            }
            AnnotationBody::Image { bounds: b, .. } => {
                set(b, bounds, &mut used);
            }
            AnnotationBody::TextBox {
                bounds: b,
                text: t,
                font: fo,
                font_size: f,
                align: al,
                ..
            } => {
                set(b, bounds, &mut used);
                set(t, text, &mut used);
                set(fo, font, &mut used);
                set(f, font_size, &mut used);
                set(al, align, &mut used);
            }
            AnnotationBody::RedactMark { .. } => {}
            AnnotationBody::Opaque { .. } => {}
        }
        if left != 0 {
            return Err(wrong());
        }
        next.modified = Some(now.to_owned());
        if next.sync == Sync::Clean {
            next.sync = Sync::Modified;
        }
        next.normalize()?;
        Ok(next)
    }

    /// This annotation moved by (`dx`, `dy`) points, `modified` set to `now`. Validated: it must stay within the page range.
    pub fn moved(&self, dx: f32, dy: f32, now: &str) -> Result<Self, AppError> {
        if !dx.is_finite() || !dy.is_finite() {
            return Err(AppError::invalid("delta"));
        }
        let mut next = self.clone();
        next.body.translate(dx, dy);
        next.modified = Some(now.to_owned());
        if next.sync == Sync::Clean {
            next.sync = Sync::Modified;
        }
        next.normalize()?;
        Ok(next)
    }

    /// The annotation `imported` becomes under `id`: clean, as in the file. `None` if it does not pass the checks (the file is
    /// hostile input: such an annotation is left out instead of failing the page).
    pub fn from_import(id: AnnotId, page_id: PageId, imported: &Imported) -> Option<Self> {
        let mut annotation = Self {
            id,
            page_id,
            rect: imported.rect,
            color: imported.color,
            opacity: imported.opacity,
            contents: imported.contents.clone(),
            author: imported.author.clone(),
            modified: imported.modified.clone(),
            in_reply_to: None,
            state: None,
            locked: imported.locked,
            sync: Sync::Clean,
            cite: None,
            tags: Vec::new(),
            body: imported.body.clone(),
        };
        annotation.normalize().ok()?;
        Some(annotation)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorCode;
    use serde_json::json;

    fn pt(x: f32, y: f32) -> Point {
        Point { x, y }
    }

    pub(crate) fn quad(x: f32, y: f32, w: f32, h: f32) -> Quad {
        [pt(x, y), pt(x + w, y), pt(x, y + h), pt(x + w, y + h)]
    }

    pub(crate) fn highlight(page: u32) -> AnnotationDraft {
        serde_json::from_value(json!({
            "pageId": page, "kind": "highlight", "color": [255, 235, 0],
            "quads": [[{"x":10.0,"y":20.0},{"x":60.0,"y":20.0},{"x":10.0,"y":32.0},{"x":60.0,"y":32.0}]]
        }))
        .expect("a highlight draft")
    }

    fn code(result: Result<impl std::fmt::Debug, AppError>) -> ErrorCode {
        result.unwrap_err().code()
    }

    #[test]
    fn a_draft_parses_with_defaults_and_becomes_an_annotation_with_a_computed_rect() {
        let draft = highlight(0);
        assert_eq!(draft.opacity, 1.0);
        assert_eq!(draft.contents, "");
        let annotation = Annotation::from_draft(AnnotId::new(7), &draft, "now").unwrap();
        assert_eq!(annotation.id, AnnotId::new(7));
        assert_eq!(annotation.sync, Sync::New);
        assert_eq!(annotation.modified.as_deref(), Some("now"));
        assert_eq!(
            annotation.rect,
            Rect {
                x: 10.0,
                y: 20.0,
                w: 50.0,
                h: 12.0
            }
        );
    }

    #[test]
    fn the_wire_format_is_camel_case_with_a_kind_tag_and_the_geometry_next_to_the_common_fields() {
        let annotation = Annotation::from_draft(AnnotId::new(1), &highlight(2), "t").unwrap();
        let value = serde_json::to_value(&annotation).unwrap();
        assert_eq!(value["kind"], "highlight");
        assert_eq!(value["pageId"], 2);
        assert_eq!(value["sync"], "new");
        assert_eq!(value["inReplyTo"], serde_json::Value::Null);
        assert_eq!(value["color"], json!([255, 235, 0]));
        assert!(value["quads"].is_array());
        let free: AnnotationDraft = serde_json::from_value(json!({
            "pageId": 0, "kind": "freeText", "color": [0, 0, 0],
            "box": {"x": 1.0, "y": 2.0, "w": 100.0, "h": 40.0},
            "lines": ["Hello"], "fontSize": 12.0, "fill": null, "borderWidth": 0.0
        }))
        .unwrap();
        let free = Annotation::from_draft(AnnotId::new(2), &free, "t").unwrap();
        let value = serde_json::to_value(&free).unwrap();
        assert_eq!(value["kind"], "freeText");
        assert_eq!(value["box"]["w"], 100.0);
        assert_eq!(value["fontSize"], 12.0);
        // It reads back as it was written.
        let back: Annotation = serde_json::from_value(value).unwrap();
        assert_eq!(back, free);
    }

    #[test]
    fn an_opaque_annotation_cannot_be_made_from_the_wire() {
        let parsed = serde_json::from_value::<AnnotationDraft>(json!({
            "pageId": 0, "kind": "opaque", "subtype": "Ink", "color": [0, 0, 0]
        }));
        // It parses (ADR-115: the engine child's replies carry it); making an annotation of it is refused.
        let parsed = parsed.unwrap();
        assert_eq!(
            code(Annotation::from_draft(AnnotId::new(1), &parsed, "t")),
            ErrorCode::InvalidArgument
        );
        let draft = AnnotationDraft {
            body: AnnotationBody::Opaque {
                subtype: "Ink".into(),
            },
            ..highlight(0)
        };
        assert_eq!(
            code(Annotation::from_draft(AnnotId::new(1), &draft, "t")),
            ErrorCode::InvalidArgument
        );
    }

    #[test]
    fn every_kind_gets_a_bounding_box_that_includes_its_stroke() {
        let ink = AnnotationBody::Ink {
            strokes: vec![Stroke {
                points: vec![pt(10.0, 10.0), pt(30.0, 20.0)],
                outline: vec![pt(9.0, 9.0), pt(31.0, 21.0)],
            }],
            width: 4.0,
        };
        assert_eq!(
            ink.check(Rect {
                x: 0.0,
                y: 0.0,
                w: 0.0,
                h: 0.0
            })
            .unwrap(),
            Rect {
                x: 7.0,
                y: 7.0,
                w: 26.0,
                h: 16.0
            }
        );
        let square = AnnotationBody::Rect {
            bounds: Rect {
                x: 10.0,
                y: 10.0,
                w: 20.0,
                h: 20.0,
            },
            width: 2.0,
            fill: None,
            dashed: false,
        };
        assert_eq!(
            square
                .check(Rect {
                    x: 0.0,
                    y: 0.0,
                    w: 0.0,
                    h: 0.0
                })
                .unwrap(),
            Rect {
                x: 9.0,
                y: 9.0,
                w: 22.0,
                h: 22.0
            }
        );
        let line = AnnotationBody::Line {
            from: pt(0.0, 0.0),
            to: pt(100.0, 0.0),
            width: 2.0,
            head: LineEnd::None,
            tail: LineEnd::ClosedArrow,
        };
        let rect = line
            .check(Rect {
                x: 0.0,
                y: 0.0,
                w: 0.0,
                h: 0.0,
            })
            .unwrap();
        // 1 for the stroke and 10 for the arrow, on each side.
        assert_eq!(
            rect,
            Rect {
                x: -11.0,
                y: -11.0,
                w: 122.0,
                h: 22.0
            }
        );
        let note = AnnotationBody::Note {
            at: pt(5.0, 6.0),
            icon: NoteIcon::Note,
        };
        assert_eq!(
            note.check(Rect {
                x: 0.0,
                y: 0.0,
                w: 0.0,
                h: 0.0
            })
            .unwrap(),
            Rect {
                x: 5.0,
                y: 6.0,
                w: NOTE_SIZE_PT,
                h: NOTE_SIZE_PT
            }
        );
    }

    #[test]
    fn numbers_that_are_not_numbers_or_out_of_range_are_refused() {
        let mut draft = highlight(0);
        draft.opacity = f32::NAN;
        assert_eq!(
            code(Annotation::from_draft(AnnotId::new(1), &draft, "t")),
            ErrorCode::InvalidArgument
        );
        draft.opacity = 1.5;
        assert_eq!(
            code(Annotation::from_draft(AnnotId::new(1), &draft, "t")),
            ErrorCode::InvalidArgument
        );
        let mut far = highlight(0);
        far.body = AnnotationBody::Highlight {
            quads: vec![quad(0.0, 0.0, f32::INFINITY, 1.0)],
        };
        assert_eq!(
            code(Annotation::from_draft(AnnotId::new(1), &far, "t")),
            ErrorCode::InvalidArgument
        );
        far.body = AnnotationBody::Highlight {
            quads: vec![quad(20_000.0, 0.0, 1.0, 1.0)],
        };
        assert_eq!(
            code(Annotation::from_draft(AnnotId::new(1), &far, "t")),
            ErrorCode::InvalidArgument
        );
        let wide = AnnotationBody::Ink {
            strokes: vec![Stroke {
                points: vec![pt(0.0, 0.0)],
                outline: vec![],
            }],
            width: 500.0,
        };
        assert!(wide
            .check(Rect {
                x: 0.0,
                y: 0.0,
                w: 0.0,
                h: 0.0
            })
            .is_err());
    }

    #[test]
    fn counts_and_string_lengths_are_bounded() {
        let mut draft = highlight(0);
        draft.body = AnnotationBody::Highlight { quads: vec![] };
        assert_eq!(
            code(Annotation::from_draft(AnnotId::new(1), &draft, "t")),
            ErrorCode::InvalidArgument
        );
        draft.body = AnnotationBody::Highlight {
            quads: vec![quad(0.0, 0.0, 1.0, 1.0); limits::MAX_ANNOT_QUADS + 1],
        };
        assert_eq!(
            code(Annotation::from_draft(AnnotId::new(1), &draft, "t")),
            ErrorCode::LimitExceeded
        );

        let mut text = highlight(0);
        text.contents = "x".repeat(limits::MAX_ANNOT_CONTENTS_CHARS);
        assert!(Annotation::from_draft(AnnotId::new(1), &text, "t").is_ok());
        text.contents.push('x');
        assert_eq!(
            code(Annotation::from_draft(AnnotId::new(1), &text, "t")),
            ErrorCode::InvalidArgument
        );
        text.contents = "a\0b".into();
        assert_eq!(
            code(Annotation::from_draft(AnnotId::new(1), &text, "t")),
            ErrorCode::InvalidArgument
        );
        text.contents = "two\nlines\tand a tab".into();
        assert!(Annotation::from_draft(AnnotId::new(1), &text, "t").is_ok());
        text.author = Some("x".repeat(limits::MAX_ANNOT_AUTHOR_CHARS + 1));
        text.contents.clear();
        assert_eq!(
            code(Annotation::from_draft(AnnotId::new(1), &text, "t")),
            ErrorCode::InvalidArgument
        );

        let many_points = AnnotationBody::Ink {
            strokes: vec![Stroke {
                points: vec![pt(1.0, 1.0); limits::MAX_INK_POINTS_PER_STROKE + 1],
                outline: vec![],
            }],
            width: 1.0,
        };
        assert_eq!(
            many_points
                .check(Rect {
                    x: 0.0,
                    y: 0.0,
                    w: 0.0,
                    h: 0.0
                })
                .unwrap_err()
                .code(),
            ErrorCode::LimitExceeded
        );
        let too_many_strokes = AnnotationBody::Ink {
            strokes: vec![
                Stroke {
                    points: vec![pt(1.0, 1.0)],
                    outline: vec![]
                };
                limits::MAX_INK_STROKES + 1
            ],
            width: 1.0,
        };
        assert!(too_many_strokes
            .check(Rect {
                x: 0.0,
                y: 0.0,
                w: 0.0,
                h: 0.0
            })
            .is_err());
        // The total of 50 000 points is reached by 6 strokes of 9 000 points and outlines together.
        let heavy = Stroke {
            points: vec![pt(1.0, 1.0); 9_000],
            outline: vec![pt(1.0, 1.0); 9_000],
        };
        let total = AnnotationBody::Ink {
            strokes: vec![heavy; 3],
            width: 1.0,
        };
        assert_eq!(
            total
                .check(Rect {
                    x: 0.0,
                    y: 0.0,
                    w: 0.0,
                    h: 0.0
                })
                .unwrap_err()
                .code(),
            ErrorCode::LimitExceeded
        );

        let free = AnnotationBody::FreeText {
            bounds: Rect {
                x: 0.0,
                y: 0.0,
                w: 10.0,
                h: 10.0,
            },
            lines: vec!["a\nb".into()],
            font_size: 12.0,
            fill: None,
            border_width: 0.0,
            align: TextAlign::Left,
            border_color: None,
        };
        assert!(
            free.check(Rect {
                x: 0.0,
                y: 0.0,
                w: 0.0,
                h: 0.0
            })
            .is_err(),
            "a line has no line break"
        );
    }

    #[test]
    fn a_patch_changes_only_what_it_names_and_marks_a_clean_annotation_modified() {
        let mut base = Annotation::from_draft(AnnotId::new(1), &highlight(0), "t0").unwrap();
        base.sync = Sync::Clean;
        let patch: AnnotationPatch =
            serde_json::from_value(json!({"color": [1, 2, 3], "contents": "hi"})).unwrap();
        let next = base.patched(&patch, "t1").unwrap();
        assert_eq!(next.color, Rgb([1, 2, 3]));
        assert_eq!(next.contents, "hi");
        assert_eq!(next.sync, Sync::Modified);
        assert_eq!(next.modified.as_deref(), Some("t1"));
        assert_eq!(next.body, base.body);
        assert_eq!(base.contents, "", "the original is untouched");
    }

    #[test]
    fn a_patch_with_a_field_of_another_kind_or_an_unknown_key_is_refused() {
        let base = Annotation::from_draft(AnnotId::new(1), &highlight(0), "t").unwrap();
        let wrong: AnnotationPatch = serde_json::from_value(json!({"width": 2.0})).unwrap();
        assert_eq!(code(base.patched(&wrong, "t")), ErrorCode::InvalidArgument);
        let mixed: AnnotationPatch =
            serde_json::from_value(json!({"color": [0, 0, 0], "dashed": true})).unwrap();
        assert_eq!(code(base.patched(&mixed, "t")), ErrorCode::InvalidArgument);
        assert!(serde_json::from_value::<AnnotationPatch>(json!({"id": 4})).is_err());
        assert!(serde_json::from_value::<AnnotationPatch>(json!({"sync": "clean"})).is_err());
    }

    #[test]
    fn a_null_fill_clears_it_and_a_missing_one_leaves_it() {
        let draft: AnnotationDraft = serde_json::from_value(json!({
            "pageId": 0, "kind": "rect", "color": [0, 0, 0],
            "box": {"x": 1.0, "y": 1.0, "w": 5.0, "h": 5.0}, "width": 1.0, "fill": [9, 9, 9], "dashed": false
        }))
        .unwrap();
        let base = Annotation::from_draft(AnnotId::new(1), &draft, "t").unwrap();
        let clear: AnnotationPatch = serde_json::from_value(json!({"fill": null})).unwrap();
        let AnnotationBody::Rect { fill, .. } = base.patched(&clear, "t").unwrap().body else {
            panic!("kind changed")
        };
        assert_eq!(fill, None);
        let keep: AnnotationPatch = serde_json::from_value(json!({"width": 3.0})).unwrap();
        let AnnotationBody::Rect { fill, width, .. } = base.patched(&keep, "t").unwrap().body
        else {
            panic!("kind changed")
        };
        assert_eq!((fill, width), (Some(Rgb([9, 9, 9])), 3.0));
    }

    #[test]
    fn moving_shifts_all_geometry_and_the_rect_and_stays_within_the_page_range() {
        let base = Annotation::from_draft(AnnotId::new(1), &highlight(0), "t").unwrap();
        let moved = base.moved(5.0, -2.0, "t2").unwrap();
        assert_eq!(
            moved.rect,
            Rect {
                x: 15.0,
                y: 18.0,
                w: 50.0,
                h: 12.0
            }
        );
        assert_eq!(
            code(base.moved(f32::NAN, 0.0, "t")),
            ErrorCode::InvalidArgument
        );
        assert_eq!(
            code(base.moved(1.0e6, 0.0, "t")),
            ErrorCode::InvalidArgument
        );
    }

    #[test]
    fn an_annotation_cannot_reply_to_itself() {
        let mut draft = highlight(0);
        draft.in_reply_to = Some(AnnotId::new(3));
        assert_eq!(
            code(Annotation::from_draft(AnnotId::new(3), &draft, "t")),
            ErrorCode::InvalidArgument
        );
        assert!(Annotation::from_draft(AnnotId::new(4), &draft, "t").is_ok());
    }

    #[test]
    fn an_import_that_fails_the_checks_is_left_out() {
        let good = Imported {
            origin: PdfOrigin {
                page_index: 0,
                annot_index: 0,
                name: None,
            },
            body: AnnotationBody::Opaque {
                subtype: "Ink".into(),
            },
            rect: Rect {
                x: 1.0,
                y: 1.0,
                w: 5.0,
                h: 5.0,
            },
            color: Rgb([0, 0, 0]),
            opacity: 1.0,
            contents: String::new(),
            author: None,
            modified: Some("D:20240101".into()),
            locked: false,
            hidden: false,
        };
        let made = Annotation::from_import(AnnotId::new(1), PageId::new(0), &good).unwrap();
        assert_eq!(made.sync, Sync::Clean);
        assert!(made.is_opaque());
        let mut bad = good;
        bad.rect.w = f32::NAN;
        assert!(Annotation::from_import(AnnotId::new(1), PageId::new(0), &bad).is_none());
    }

    fn signature(asset: u32, w: f32, h: f32) -> AnnotationDraft {
        let mut draft: AnnotationDraft = serde_json::from_value(json!({
            "pageId": 0, "kind": "signature", "color": [0, 0, 0], "role": "initials",
            "box": {"x": 10.0, "y": 20.0, "w": 80.0, "h": 40.0},
            "art": {"type": "asset", "assetId": asset, "aspect": 2.0}
        }))
        .unwrap();
        // Set after parsing: JSON has no NaN.
        if let AnnotationBody::Signature { bounds, .. } = &mut draft.body {
            bounds.w = w;
            bounds.h = h;
        }
        draft
    }

    #[test]
    fn signatures_and_marks_parse_and_get_their_rect_from_the_box() {
        let annotation =
            Annotation::from_draft(AnnotId::new(1), &signature(3, 80.0, 40.0), "t").unwrap();
        assert_eq!(
            annotation.rect,
            Rect {
                x: 10.0,
                y: 20.0,
                w: 80.0,
                h: 40.0
            }
        );
        let wire = serde_json::to_value(&annotation).unwrap();
        assert_eq!(wire["kind"], "signature");
        assert_eq!(wire["role"], "initials");
        assert_eq!(
            wire["art"],
            json!({"type": "asset", "assetId": 3, "aspect": 2.0})
        );
        let mark: AnnotationDraft = serde_json::from_value(json!({
            "pageId": 0, "kind": "mark", "color": [0, 0, 0], "glyph": "cross",
            "box": {"x": 1.0, "y": 2.0, "w": 10.0, "h": 10.0}
        }))
        .unwrap();
        let mark = Annotation::from_draft(AnnotId::new(2), &mark, "t").unwrap();
        assert!(matches!(
            mark.body,
            AnnotationBody::Mark {
                glyph: MarkGlyph::Cross,
                ..
            }
        ));
    }

    #[test]
    fn signature_boxes_and_art_are_checked() {
        for (w, h) in [
            (3.9, 40.0),
            (40.0, 3.9),
            (f32::NAN, 40.0),
            (-5.0, 40.0),
            (1e9, 40.0),
        ] {
            assert_eq!(
                code(Annotation::from_draft(
                    AnnotId::new(1),
                    &signature(1, w, h),
                    "t"
                )),
                ErrorCode::InvalidArgument,
                "{w} x {h}"
            );
        }
        let mut bad_aspect = signature(1, 80.0, 40.0);
        if let AnnotationBody::Signature { art, .. } = &mut bad_aspect.body {
            *art = SignatureArtRef::Asset {
                asset_id: AssetId::new(1),
                aspect: 0.0,
            };
        }
        assert_eq!(
            code(Annotation::from_draft(AnnotId::new(1), &bad_aspect, "t")),
            ErrorCode::InvalidArgument
        );
        // Art "in the file" is not accepted from the UI, in a draft or at all.
        let mut from_file = signature(1, 80.0, 40.0);
        if let AnnotationBody::Signature { art, .. } = &mut from_file.body {
            *art = SignatureArtRef::File;
        }
        assert_eq!(
            code(Annotation::from_draft(AnnotId::new(1), &from_file, "t")),
            ErrorCode::InvalidArgument
        );
        // It parses (the engine child's replies carry it, ADR-115) and is refused by the draft check.
        let parsed: AnnotationDraft = serde_json::from_value(json!({
            "pageId": 0, "kind": "signature", "color": [0, 0, 0], "role": "signature",
            "box": {"x": 1.0, "y": 1.0, "w": 10.0, "h": 10.0}, "art": {"type": "file"}
        }))
        .unwrap();
        assert_eq!(
            code(Annotation::from_draft(AnnotId::new(1), &parsed, "t")),
            ErrorCode::InvalidArgument
        );
    }

    #[test]
    fn a_signature_patch_moves_the_box_and_nothing_else() {
        let base = Annotation::from_draft(AnnotId::new(1), &signature(1, 80.0, 40.0), "t").unwrap();
        let patch: AnnotationPatch =
            serde_json::from_value(json!({"box": {"x": 0.0, "y": 0.0, "w": 40.0, "h": 20.0}}))
                .unwrap();
        let next = base.patched(&patch, "t2").unwrap();
        assert_eq!(next.rect.w, 40.0);
        let wrong: AnnotationPatch = serde_json::from_value(json!({"lines": ["x"]})).unwrap();
        assert_eq!(code(base.patched(&wrong, "t2")), ErrorCode::InvalidArgument);
        let moved = base.moved(5.0, -5.0, "t3").unwrap();
        assert_eq!((moved.rect.x, moved.rect.y), (15.0, 15.0));
    }

    #[test]
    fn a_turn_is_normalised_validated_and_gives_the_rect_of_the_turned_box() {
        let base = Annotation::from_draft(AnnotId::new(1), &signature(1, 80.0, 40.0), "t").unwrap();
        let turn = |angle: serde_json::Value| -> AnnotationPatch {
            serde_json::from_value(json!({ "angle": angle })).unwrap()
        };
        let quarter = base.patched(&turn(json!(450.0)), "t2").unwrap();
        let AnnotationBody::Signature { angle, bounds, .. } = &quarter.body else {
            panic!("a signature")
        };
        assert_eq!(*angle, 90.0);
        assert_eq!(bounds.w, 80.0);
        // The box 80 x 40 at (10, 20) turned a quarter about its centre (50, 40): 40 x 80 around the same centre.
        assert!((quarter.rect.w - 40.0).abs() < 0.01 && (quarter.rect.h - 80.0).abs() < 0.01);
        assert!((quarter.rect.x - 30.0).abs() < 0.01 && (quarter.rect.y - 0.0).abs() < 0.01);
        assert_eq!(quarter.sync, Sync::New);
        let half = base.patched(&turn(json!(-180.0)), "t2").unwrap();
        assert!(matches!(
            half.body,
            AnnotationBody::Signature { angle: 180.0, .. }
        ));
        // Not a number never gets in; a patch for a kind without a turn is refused.
        let mut hostile = base.clone();
        if let AnnotationBody::Signature { angle, .. } = &mut hostile.body {
            *angle = f32::INFINITY;
        }
        assert_eq!(
            code(hostile.moved(1.0, 1.0, "t")),
            ErrorCode::InvalidArgument
        );
        assert_eq!(normalize_angle(f32::NAN), None);
        assert_eq!(normalize_angle(-0.001), Some(0.0));
        let note = Annotation::from_draft(
            AnnotId::new(2),
            &serde_json::from_value(json!({
                "pageId": 0, "kind": "note", "color": [0, 0, 0], "at": {"x": 5.0, "y": 5.0}, "icon": "note"
            }))
            .unwrap(),
            "t",
        )
        .unwrap();
        assert_eq!(
            code(note.patched(&turn(json!(10.0)), "t")),
            ErrorCode::InvalidArgument
        );
    }

    fn patch(value: serde_json::Value) -> AnnotationPatch {
        serde_json::from_value(value).expect("a patch")
    }

    fn cited(page: u32) -> Annotation {
        let mut draft = highlight(page);
        draft.cite = Some(super::super::quote::Cite {
            quote: "the quote".to_owned(),
            group: Some("0a1b2c3d".to_owned()),
        });
        Annotation::from_draft(AnnotId::new(1), &draft, "t").unwrap()
    }

    #[test]
    fn a_draft_brings_tags_but_never_a_cite_from_the_wire() {
        let draft: AnnotationDraft = serde_json::from_value(json!({
            "pageId": 0, "kind": "highlight", "color": [1, 2, 3], "quads": [[{"x":1.0,"y":1.0},{"x":5.0,"y":1.0},{"x":1.0,"y":3.0},{"x":5.0,"y":3.0}]],
            "tags": [" a ", "A", "b"], "cite": {"quote": "forged"}
        }))
        .unwrap();
        assert!(draft.cite.is_none(), "the UI cannot set a quote");
        let a = Annotation::from_draft(AnnotId::new(1), &draft, "t").unwrap();
        assert_eq!(a.tags, ["a", "b"]);
        let mut bad = highlight(0);
        bad.tags = vec![String::new()];
        assert_eq!(
            code(Annotation::from_draft(AnnotId::new(1), &bad, "t")),
            ErrorCode::InvalidArgument
        );
        // A cite is only for a Highlight and needs a quote.
        let mut note = highlight(0);
        note.body = AnnotationBody::Note {
            at: pt(1.0, 1.0),
            icon: NoteIcon::Note,
        };
        note.cite = cited(0).cite;
        assert!(Annotation::from_draft(AnnotId::new(1), &note, "t").is_err());
        let mut empty = highlight(0);
        empty.cite = Some(super::super::quote::Cite {
            quote: " ".to_owned(),
            group: None,
        });
        assert!(Annotation::from_draft(AnnotId::new(1), &empty, "t").is_err());
    }

    #[test]
    fn a_patch_sets_tags_and_the_quote_of_a_citation_and_refuses_what_does_not_fit() {
        let a = cited(0);
        let tagged = a
            .patched(
                &patch(json!({"tags": ["x", "X", "y"], "quote": "new"})),
                "t2",
            )
            .unwrap();
        assert_eq!(tagged.tags, ["x", "y"]);
        assert_eq!(tagged.cite.as_ref().map(|c| c.quote.as_str()), Some("new"));
        assert_eq!(
            tagged.cite.and_then(|c| c.group).as_deref(),
            Some("0a1b2c3d")
        );
        // No quote on a plain highlight, an empty or too long quote, a bad tag list.
        let plain = Annotation::from_draft(AnnotId::new(2), &highlight(0), "t").unwrap();
        assert_eq!(
            code(plain.patched(&patch(json!({"quote": "x"})), "t")),
            ErrorCode::InvalidArgument
        );
        assert!(plain.patched(&patch(json!({"tags": ["ok"]})), "t").is_ok());
        for quote in [String::new(), "x".repeat(2001)] {
            assert_eq!(
                code(a.patched(&patch(json!({"quote": quote})), "t")),
                ErrorCode::InvalidArgument
            );
        }
        assert!(a
            .patched(&patch(json!({"quote": "x".repeat(2000)})), "t")
            .is_ok());
        let nine: Vec<String> = (0..9).map(|n| format!("t{n}")).collect();
        assert_eq!(
            code(a.patched(&patch(json!({"tags": nine})), "t")),
            ErrorCode::InvalidArgument
        );
        assert_eq!(
            code(a.patched(&patch(json!({"tags": ["x".repeat(41)]})), "t")),
            ErrorCode::InvalidArgument
        );
    }

    #[test]
    fn what_a_file_says_is_applied_with_bounds() {
        let cite = super::super::quote::Cite {
            quote: "q".to_owned(),
            group: Some("nothex!!".to_owned()),
        };
        let mut a = Annotation::from_draft(AnnotId::new(1), &highlight(0), "t").unwrap();
        a.apply_file_keys(
            Some(&cite),
            &["a".to_owned(), "A".to_owned(), String::new()],
        );
        assert_eq!(a.tags, ["a"]);
        assert_eq!(a.cite.as_ref().map(|c| c.quote.as_str()), Some("q"));
        assert_eq!(a.cite.and_then(|c| c.group), None, "a bad group is dropped");
        // Not a highlight: no cite; opaque: nothing at all.
        let mut note = Annotation::from_draft(AnnotId::new(1), &highlight(0), "t").unwrap();
        note.body = AnnotationBody::Note {
            at: pt(1.0, 1.0),
            icon: NoteIcon::Note,
        };
        note.apply_file_keys(Some(&cite), &["t".to_owned()]);
        assert!(note.cite.is_none() && note.tags == ["t"]);
        let mut opaque = note.clone();
        opaque.body = AnnotationBody::Opaque {
            subtype: "Stamp".to_owned(),
        };
        opaque.tags.clear();
        opaque.apply_file_keys(Some(&cite), &["t".to_owned()]);
        assert!(opaque.cite.is_none() && opaque.tags.is_empty());
    }
}
