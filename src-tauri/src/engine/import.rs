//! The annotations of a page as the file has them, read on the worker into the model (ADR-003, ARCHITECTURE §5 annotations).
//!
//! PDFium only reads here; it never saves (ADR-002 §7). What the model edits is read into its own types: the three text markups
//! (with their quads), notes, free text, squares and circles. Link, widget and popup annotations are not annotations of the model
//! (links and forms have their own reads) and are left out. Everything else (ink and lines from other programs, stamps, squiggly,
//! file attachments, ...) comes as [`AnnotationBody::Opaque`]: it is listed with its rectangle, so the UI can show and select it, and
//! never changed. PDFium's own render keeps drawing it from its appearance stream.
//!
//! A file is hostile input: strings are cut to the limits and stripped of control characters, a coordinate that is not a number drops
//! its annotation, and at most `limits::MAX_IMPORT_PER_PAGE` annotations of a page are looked at. What PDFium cannot say (the
//! opacity, the stroke width, a free text's font size, a reply link) is read as the default; the original appearance is kept until the
//! annotation is modified.

use pdfium_render::prelude::*;

use super::space::{load_page, page_box};
use crate::error::AppError;
use crate::limits;
use crate::model::annotation::{AnnotationBody, Imported, NoteIcon, PdfOrigin, Rgb};
use crate::model::geometry::{PageBox, Point, Quad, Rect};

/// Colour of a highlight that has none; any other annotation without a colour is black.
const DEFAULT_MARKUP: Rgb = Rgb([255, 235, 0]);
const BLACK: Rgb = Rgb([0, 0, 0]);
/// What PDFium cannot tell us about a free text or a shape.
const DEFAULT_FONT_SIZE_PT: f32 = 12.0;
const DEFAULT_STROKE_PT: f32 = 1.0;

/// `text` without control characters (a tab and line breaks excepted; `\r` goes), at most `max` characters.
fn clean(text: &str, max: usize) -> String {
    text.chars()
        .filter(|c| !c.is_control() || matches!(c, '\n' | '\t'))
        .take(max)
        .collect()
}

fn rgb(color: &PdfColor) -> Rgb {
    Rgb([color.red(), color.green(), color.blue()])
}

/// The stroke and the fill colour of an annotation, read from the paths of its appearance. pdfium-render's `stroke_color()` and
/// `fill_color()` fall back, for an annotation that has an appearance stream, to a call that treats the annotation handle as a page
/// object and crashes PDFium, so they are never called. PDFium makes an appearance for the kinds it can (highlight, square, ...) when
/// it lists the annotations, so this finds the colours of those too.
fn path_colors(annotation: &PdfPageAnnotation<'_>) -> (Option<Rgb>, Option<Rgb>) {
    let (mut stroke, mut fill) = (None, None);
    for object in annotation.objects().iter().take(64) {
        let Some(path) = object.as_path_object() else {
            continue;
        };
        if stroke.is_none() && path.is_stroked().unwrap_or(false) {
            stroke = path.stroke_color().ok().map(|color| rgb(&color));
        }
        if fill.is_none()
            && path
                .fill_mode()
                .is_ok_and(|mode| mode != PdfPathFillMode::None)
        {
            fill = path
                .fill_color()
                .ok()
                .filter(|color| color.alpha() > 0)
                .map(|color| rgb(&color));
        }
    }
    // No objects: no appearance was drawn, and the annotation's own colours are the answer (`FPDFAnnot_GetColor` works then). An
    // appearance stream without any object would still take the crashing way; that is the one case left, and a rare one.
    if annotation.objects().len() == 0 {
        stroke = annotation.stroke_color().ok().map(|color| rgb(&color));
        fill = annotation
            .fill_color()
            .ok()
            .filter(|color| color.alpha() > 0)
            .map(|color| rgb(&color));
    }
    (stroke, fill)
}

/// The quads of a text markup, in page space. A markup without usable quads covers its rectangle.
fn quads_of(annotation: &PdfPageAnnotation<'_>, page_box: PageBox, rect: Rect) -> Vec<Quad> {
    let mut quads = Vec::new();
    for points in annotation.attachment_points().iter() {
        if quads.len() >= limits::MAX_ANNOT_QUADS {
            break;
        }
        // PDF order of the corners as Acrobat writes them: top left, top right, bottom left, bottom right.
        let corner = |x: PdfPoints, y: PdfPoints| page_box.point(x.value, y.value);
        let quad = (|| {
            Some([
                corner(points.x1(), points.y1())?,
                corner(points.x2(), points.y2())?,
                corner(points.x3(), points.y3())?,
                corner(points.x4(), points.y4())?,
            ])
        })();
        if let Some(quad) = quad {
            quads.push(quad);
        }
    }
    if quads.is_empty() {
        let (left, top) = (rect.x, rect.y);
        let (right, bottom) = (rect.x + rect.w, rect.y + rect.h);
        quads.push([
            Point { x: left, y: top },
            Point { x: right, y: top },
            Point { x: left, y: bottom },
            Point {
                x: right,
                y: bottom,
            },
        ]);
    }
    quads
}

/// The annotation at `position` of the page as an [`Imported`]; `None` for the kinds the model leaves to PDFium, and for an annotation
/// whose rectangle is not a number.
fn read_one(
    annotation: &PdfPageAnnotation<'_>,
    page_box: PageBox,
    page_index: u32,
    position: u32,
) -> Option<Imported> {
    let kind = annotation.annotation_type();
    if matches!(
        kind,
        PdfPageAnnotationType::Link
            | PdfPageAnnotationType::Widget
            | PdfPageAnnotationType::XfaWidget
            | PdfPageAnnotationType::Popup
    ) {
        return None;
    }
    let bounds = annotation.bounds().ok()?;
    let rect = page_box.rect(
        bounds.left().value,
        bounds.bottom().value,
        bounds.right().value,
        bounds.top().value,
    )?;
    let (stroke, fill) = path_colors(annotation);
    let contents = annotation
        .contents()
        .map(|text| clean(&text, limits::MAX_ANNOT_CONTENTS_CHARS))
        .unwrap_or_default();

    let (body, color) = match kind {
        PdfPageAnnotationType::Highlight => (
            AnnotationBody::Highlight {
                quads: quads_of(annotation, page_box, rect),
            },
            stroke.or(fill).unwrap_or(DEFAULT_MARKUP),
        ),
        PdfPageAnnotationType::Underline => (
            AnnotationBody::Underline {
                quads: quads_of(annotation, page_box, rect),
            },
            stroke.unwrap_or(BLACK),
        ),
        PdfPageAnnotationType::Strikeout => (
            AnnotationBody::Strikeout {
                quads: quads_of(annotation, page_box, rect),
            },
            stroke.unwrap_or(BLACK),
        ),
        PdfPageAnnotationType::Text => (
            AnnotationBody::Note {
                at: Point {
                    x: rect.x,
                    y: rect.y,
                },
                icon: NoteIcon::Note,
            },
            stroke.or(fill).unwrap_or(DEFAULT_MARKUP),
        ),
        PdfPageAnnotationType::FreeText => (
            AnnotationBody::FreeText {
                bounds: rect,
                lines: contents
                    .split('\n')
                    .take(limits::MAX_FREE_TEXT_LINES)
                    .map(|line| {
                        line.chars()
                            .take(limits::MAX_FREE_TEXT_LINE_CHARS)
                            .collect()
                    })
                    .collect(),
                font_size: DEFAULT_FONT_SIZE_PT,
                fill,
                border_width: 0.0,
            },
            stroke.unwrap_or(BLACK),
        ),
        PdfPageAnnotationType::Square => (
            AnnotationBody::Rect {
                bounds: rect,
                width: DEFAULT_STROKE_PT,
                fill,
                dashed: false,
            },
            stroke.unwrap_or(BLACK),
        ),
        PdfPageAnnotationType::Circle => (
            AnnotationBody::Ellipse {
                bounds: rect,
                width: DEFAULT_STROKE_PT,
                fill,
                dashed: false,
            },
            stroke.unwrap_or(BLACK),
        ),
        other => (
            AnnotationBody::Opaque {
                subtype: format!("{other:?}"),
            },
            stroke.unwrap_or(BLACK),
        ),
    };
    Some(Imported {
        origin: PdfOrigin {
            page_index,
            annot_index: position,
            name: annotation
                .name()
                .map(|name| clean(&name, limits::MAX_ANNOT_AUTHOR_CHARS))
                .filter(|name| !name.is_empty()),
        },
        body,
        rect,
        color,
        opacity: 1.0,
        contents,
        author: annotation
            .creator()
            .map(|author| clean(&author, limits::MAX_ANNOT_AUTHOR_CHARS))
            .filter(|author| !author.is_empty()),
        modified: annotation
            .modification_date()
            .map(|date| clean(&date, limits::MAX_ANNOT_DATE_CHARS))
            .filter(|date| !date.is_empty()),
        locked: annotation.is_locked(),
    })
}

/// Reads the annotations of page `index` (below the page count, the caller checked).
pub(super) fn read_annotations(
    document: &PdfDocument<'_>,
    index: u32,
) -> Result<Vec<Imported>, AppError> {
    let page = load_page(document, index)?;
    let page_box = page_box(&page)?;
    let annotations = page.annotations();
    let scanned = annotations.len().min(limits::MAX_IMPORT_PER_PAGE);
    let mut imported = Vec::new();
    for (position, at) in (0..scanned).zip(0u32..) {
        let Ok(annotation) = annotations.get(position) else {
            continue;
        };
        if let Some(item) = read_one(&annotation, page_box, index, at) {
            imported.push(item);
        }
    }
    Ok(imported)
}
