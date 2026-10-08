//! The annotations of a page as the file has them, read on the worker into the model (ADR-003, ARCHITECTURE §5 annotations).
//!
//! PDFium only reads here; it never saves (ADR-002 §7). What the model edits is read into its own types: the three text markups
//! (with their quads), notes, free text, squares and circles (what PDFium cannot say is added from the file by `pdfwrite::foreign`). Link, widget and popup annotations are not annotations of the model
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
use crate::model::annotation::{
    normalize_angle, rotated_bounds, AnnotationBody, Imported, NoteIcon, PdfOrigin, Rgb,
    SignatureArtRef, SignatureRole, TextAlign, MIN_SIGNATURE_SIDE_PT,
};
use crate::model::geometry::{normalize_quad, PageBox, Point, Quad, Rect};
use crate::pdfwrite::appearance::FREE_TEXT_PAD_PT;
use crate::signatures::marks::{parse_name, split_turn, Named, Turn};

/// Colour of a highlight that has none; any other annotation without a colour is black.
const DEFAULT_MARKUP: Rgb = Rgb([255, 235, 0]);
const BLACK: Rgb = Rgb([0, 0, 0]);
/// What PDFium cannot tell us about a free text or a shape.
const DEFAULT_FONT_SIZE_PT: f32 = 12.0;
const DEFAULT_STROKE_PT: f32 = 1.0;

/// Format characters (Unicode category Cf): bidi controls, zero-width marks and the like. In an author or a note they can make text
/// read as something else, so they are not imported.
fn is_format_char(c: char) -> bool {
    matches!(u32::from(c),
        0x00AD | 0x0600..=0x0605 | 0x061C | 0x06DD | 0x070F | 0x0890..=0x0891 | 0x08E2 | 0x180E
        | 0x200B..=0x200F | 0x202A..=0x202E | 0x2060..=0x2064 | 0x2066..=0x206F | 0xFEFF
        | 0xFFF9..=0xFFFB | 0x110BD | 0x110CD | 0x13430..=0x1343F | 0x1BCA0..=0x1BCA3
        | 0x1D173..=0x1D17A | 0xE0001 | 0xE0020..=0xE007F)
}

/// `text` without control and format characters (a tab and line breaks excepted; `\r` goes), at most `max` characters.
pub(crate) fn clean(text: &str, max: usize) -> String {
    text.chars()
        .filter(|c| (!c.is_control() || matches!(c, '\n' | '\t')) && !is_format_char(*c))
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
    // No objects: either no appearance was drawn, or an /AP without any object exists. PDFium's colour calls on the annotation itself
    // (`FPDFAnnot_GetColor`, then the page-object fallback) crash the worker for the second kind, and the handle cannot tell the two
    // apart, so they are not called: the colour is the default of the kind.
    (stroke, fill)
}

/// What the appearance of a free text says about its look (ADR-110). PDFium has no accessor for `/DA`, `/Q` or `/BS` and the
/// appearance carries all of them (ours, and any other writer's): the text objects give size, colour and where the lines sit in the
/// box (left, centred or right), the stroked path gives the border.
struct FreeTextLook {
    font_size: f32,
    color: Option<Rgb>,
    border_width: f32,
    border_color: Option<Rgb>,
    align: TextAlign,
}

fn free_text_look(annotation: &PdfPageAnnotation<'_>, left: f32, right: f32) -> FreeTextLook {
    let mut look = FreeTextLook {
        font_size: DEFAULT_FONT_SIZE_PT,
        color: None,
        border_width: 0.0,
        border_color: None,
        align: TextAlign::Left,
    };
    let (mut sized, mut border) = (false, false);
    // Gaps of each line to the box's left and right edge, and whether every line fits one of the alignments.
    let (mut all_left, mut all_right, mut any_line) = (true, true, false);
    for object in annotation.objects().iter().take(256) {
        if let Some(text) = object.as_text_object() {
            if !sized {
                let size = text.scaled_font_size().value;
                if size.is_finite()
                    && (limits::MIN_FONT_SIZE_PT..=limits::MAX_FONT_SIZE_PT).contains(&size)
                {
                    look.font_size = size;
                }
                look.color = text.fill_color().ok().map(|color| rgb(&color));
                sized = true;
            }
            // A text object with no extent (an empty string) says nothing about the alignment.
            if let Ok(bounds) = text
                .bounds()
                .map_err(|_| ())
                .and_then(|b| (b.width().value > 0.0).then_some(b).ok_or(()))
            {
                let slack = 2.0 + 0.1 * look.font_size;
                let gap_left = bounds.left().value - left;
                let gap_right = right - bounds.right().value;
                any_line = true;
                all_left &= (gap_left - FREE_TEXT_PAD_PT).abs() <= slack;
                all_right &= (gap_right - FREE_TEXT_PAD_PT).abs() <= slack;
            }
        } else if let Some(path) = object.as_path_object() {
            if !border && path.is_stroked().unwrap_or(false) {
                let width = path.stroke_width().map_or(0.0, |w| w.value);
                if width.is_finite() && width > 0.0 && width <= limits::MAX_ANNOT_STROKE_PT {
                    look.border_width = width;
                    look.border_color = path.stroke_color().ok().map(|color| rgb(&color));
                    border = true;
                }
            }
        }
    }
    look.align = match (any_line, all_left, all_right) {
        (false, ..) | (_, true, _) => TextAlign::Left,
        (_, false, true) => TextAlign::Right,
        _ => TextAlign::Center,
    };
    look
}

/// The quads of a text markup, in page space. A markup without usable quads covers its rectangle.
fn quads_of(annotation: &PdfPageAnnotation<'_>, page_box: PageBox, rect: Rect) -> Vec<Quad> {
    let mut quads = Vec::new();
    // Counted before they are checked, so a markup of nothing but bad quads ends too.
    for points in annotation
        .attachment_points()
        .iter()
        .take(limits::MAX_ANNOT_QUADS * 4)
    {
        if quads.len() >= limits::MAX_ANNOT_QUADS {
            break;
        }
        // The corners come in the order the writer chose (Acrobat: top left, top right, bottom left, bottom right; the specification and
        // other programs: counterclockwise), so they are put in the model's order.
        let corner = |x: PdfPoints, y: PdfPoints| page_box.point(x.value, y.value);
        let quad = (|| {
            Some(normalize_quad([
                corner(points.x1(), points.y1())?,
                corner(points.x2(), points.y2())?,
                corner(points.x3(), points.y3())?,
                corner(points.x4(), points.y4())?,
            ]))
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

/// How far (points) the bounds of the turned box the name describes may be from the file's `/Rect` before the name is not believed
/// (another program moved or resized the stamp since).
const TURN_TOLERANCE_PT: f32 = 1.0;

/// The box before the turn, and its angle, that a name's turn describes for a stamp at `rect`; `None` if the name does not fit the rect.
fn turned_box(rect: Rect, turn: Turn) -> Option<(Rect, f32)> {
    let angle = normalize_angle(f32::from(u16::try_from(turn.centi_degrees).ok()?) / 100.0)?;
    let (w, h) = (turn.w_centi as f32 / 100.0, turn.h_centi as f32 / 100.0);
    if w < MIN_SIGNATURE_SIDE_PT || h < MIN_SIGNATURE_SIDE_PT || angle == 0.0 {
        return None;
    }
    let bounds = Rect {
        x: rect.x + rect.w / 2.0 - w / 2.0,
        y: rect.y + rect.h / 2.0 - h / 2.0,
        w,
        h,
    };
    let turned = rotated_bounds(bounds, angle);
    let near = |a: f32, b: f32| (a - b).abs() <= TURN_TOLERANCE_PT;
    (near(turned.x, rect.x)
        && near(turned.y, rect.y)
        && near(turned.w, rect.w)
        && near(turned.h, rect.h))
    .then_some((bounds, angle))
}

/// The body and colour of a stamp of ours read from the file: `None` if the name is not a stamp name, the box is too small, or the text
/// (the annotation's `/Contents`) does not pass the checks. The text comes from `/Contents`, not from the appearance stream: the appearance is
/// our own output but stays unparsed, so a hostile content stream never reaches the model (decided; the two agree for every stamp we write). The date comes later from `/SHR_Stamp` (`DocState::apply_sheer_keys`).
fn imported_stamp(
    named: Option<Named>,
    contents: &str,
    rect: Rect,
    paint: Option<Rgb>,
) -> Option<(AnnotationBody, Rgb)> {
    let Some(Named::Stamp(kind)) = named else {
        return None;
    };
    let mut text = contents.to_owned();
    crate::model::stamp::check_texts(&mut text, &mut None).ok()?;
    // A forged `/Rect` of absurd size stays opaque: no stamp is larger than a page can be.
    let side = limits::MAX_PAGE_SIDE_PT;
    if !(rect.w.is_finite() && rect.h.is_finite())
        || rect.w < crate::model::stamp::MIN_W_PT
        || rect.h < crate::model::stamp::MIN_H_PT
        || rect.w > side
        || rect.h > side
    {
        return None;
    }
    let tone = crate::model::stamp::tone_near(paint.unwrap_or(BLACK));
    Some((
        AnnotationBody::Stamp {
            bounds: rect,
            stamp: kind,
            text,
            date: None,
            tone,
        },
        crate::model::stamp::tone_rgb(tone),
    ))
}

/// What the `/NM` of a stamp says about it, if it is one of ours.
fn stamp_kind(annotation: &PdfPageAnnotation<'_>) -> Option<Named> {
    parse_name(&annotation.name()?)
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
        // Acrobat ends the lines of a note and of a free text with a bare carriage return: they stay line breaks.
        .map(|text| {
            clean(
                &text.replace("\r\n", "\n").replace('\r', "\n"),
                limits::MAX_ANNOT_CONTENTS_CHARS,
            )
        })
        .unwrap_or_default();

    // Parsed once: the match guard only tests it, the arm takes it.
    let mut own_stamp = if kind == PdfPageAnnotationType::Stamp {
        imported_stamp(stamp_kind(annotation), &contents, rect, fill.or(stroke))
    } else {
        None
    };
    let (body, color) = match kind {
        PdfPageAnnotationType::Highlight => (
            AnnotationBody::Highlight {
                quads: quads_of(annotation, page_box, rect),
            },
            // The fill is the colour; a citation's appearance also has a stroked rule.
            fill.or(stroke).unwrap_or(DEFAULT_MARKUP),
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
        PdfPageAnnotationType::FreeText => {
            let look = free_text_look(annotation, bounds.left().value, bounds.right().value);
            (
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
                    font_size: look.font_size,
                    fill,
                    border_width: look.border_width,
                    align: look.align,
                    border_color: look.border_color,
                },
                look.color.unwrap_or(BLACK),
            )
        }
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
        // A stamp of ours with a text the model accepts (`sheer-stamp-<kind>-`, ARCHITECTURE §16.1); one that fails the checks stays opaque.
        PdfPageAnnotationType::Stamp if own_stamp.is_some() => own_stamp.take().unwrap_or((
            AnnotationBody::Opaque {
                subtype: String::new(),
            },
            BLACK,
        )),
        // Our own stamps (`sheer-sig-`, `sheer-ini-`, `sheer-mark-<glyph>-`, ADR-041 §5) come back as signatures and marks, so they can
        // be moved and scaled; any other stamp stays opaque. A stamp too small for the model to hold stays opaque too.
        PdfPageAnnotationType::Stamp
            if stamp_kind(annotation).is_some()
                && !matches!(stamp_kind(annotation), Some(Named::Stamp(_)))
                && rect.w >= MIN_SIGNATURE_SIDE_PT
                && rect.h >= MIN_SIGNATURE_SIDE_PT =>
        {
            // A turned one of ours has its box and angle in its name (ADR-105); the rect is the bounds of the turned box.
            let (bounds, angle) = annotation
                .name()
                .and_then(|name| split_turn(&name).1)
                .and_then(|turn| turned_box(rect, turn))
                .unwrap_or((rect, 0.0));
            let body = match stamp_kind(annotation) {
                Some(Named::Mark(glyph)) => AnnotationBody::Mark {
                    bounds,
                    glyph,
                    angle,
                },
                other => AnnotationBody::Signature {
                    bounds,
                    role: if other == Some(Named::Initials) {
                        SignatureRole::Initials
                    } else {
                        SignatureRole::Signature
                    },
                    art: SignatureArtRef::File,
                    angle,
                },
            };
            (body, fill.or(stroke).unwrap_or(BLACK))
        }
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
        hidden: annotation.is_hidden(),
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
    // The position of an annotation is its place among the entries that are not popups, as every reader of the file counts them
    // (`pdfwrite::reviews`, `foreign`, `save::Slots`); PDFium lists the popups in between.
    let mut at = 0u32;
    for position in 0..scanned {
        let Ok(annotation) = annotations.get(position) else {
            at = at.saturating_add(1);
            continue;
        };
        if annotation.annotation_type() == PdfPageAnnotationType::Popup {
            continue;
        }
        if let Some(item) = read_one(&annotation, page_box, index, at) {
            imported.push(item);
        }
        at = at.saturating_add(1);
    }
    Ok(imported)
}

/// The index PDFium lists each annotation under, by position (counted without popups, see [`read_annotations`]): built once per page.
fn raw_indexes(annotations: &PdfPageAnnotations<'_>) -> Vec<usize> {
    (0..annotations.len().min(limits::MAX_IMPORT_PER_PAGE))
        .filter(|raw| {
            !matches!(annotations.get(*raw), Ok(a) if a.annotation_type() == PdfPageAnnotationType::Popup)
        })
        .collect()
}

/// Sets the Hidden flag of each `(page index, position)` in `hide` and clears it in `show`, in PDFium's memory only. A position the page
/// does not have is skipped (the file is hostile). A page that is out of range is `invalid_argument`.
pub(super) fn set_hidden(
    document: &PdfDocument<'_>,
    hide: &[(u32, u32)],
    show: &[(u32, u32)],
) -> Result<(), AppError> {
    let count = u32::try_from(document.pages().len()).unwrap_or(0);
    let wanted = hide
        .iter()
        .map(|at| (*at, true))
        .chain(show.iter().map(|at| (*at, false)))
        .take(limits::MAX_ANNOTATIONS_PER_DOC.saturating_mul(2));
    // Per page, so each page is loaded and its positions mapped once.
    let mut by_page: std::collections::BTreeMap<u32, Vec<(usize, bool)>> = Default::default();
    for ((page_index, position), hidden) in wanted {
        let page_index = limits::validate_page_index(page_index, count)?;
        if let Ok(position) = usize::try_from(position) {
            by_page
                .entry(page_index)
                .or_default()
                .push((position, hidden));
        }
    }
    for (page_index, changes) in by_page {
        let page = load_page(document, page_index)?;
        let annotations = page.annotations();
        let raw = raw_indexes(annotations);
        for (position, hidden) in changes {
            let found = raw.get(position).map(|raw| annotations.get(*raw));
            if let Some(Ok(mut annotation)) = found {
                // A flag PDFium refuses to set only leaves the original drawn; nothing else depends on it.
                let _ = annotation.set_is_hidden(hidden);
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(w: f32, h: f32) -> Rect {
        Rect {
            x: 0.0,
            y: 0.0,
            w,
            h,
        }
    }

    #[test]
    fn a_forged_stamp_with_an_oversized_or_tiny_rect_stays_opaque() {
        let named = Some(Named::Stamp(crate::model::stamp::StampKind::Draft));
        assert!(imported_stamp(named, "DRAFT", rect(100.0, 34.0), None).is_some());
        assert!(imported_stamp(named, "DRAFT", rect(1.0e9, 34.0), None).is_none());
        assert!(imported_stamp(named, "DRAFT", rect(100.0, f32::INFINITY), None).is_none());
        assert!(imported_stamp(named, "DRAFT", rect(100.0, f32::NAN), None).is_none());
        assert!(imported_stamp(named, "DRAFT", rect(100.0, 1.0), None).is_none());
    }

    #[test]
    fn imported_text_loses_control_and_format_characters() {
        assert_eq!(
            clean("a\u{202E}b\u{200B}c\u{FEFF}d\u{2066}e\r\u{7}", 99),
            "abcde"
        );
        assert_eq!(clean("l1\nl2\tx", 99), "l1\nl2\tx");
        assert_eq!(
            clean("\u{E4}\u{4E2D}\u{1F600}", 99),
            "\u{E4}\u{4E2D}\u{1F600}"
        );
        assert_eq!(clean("abcdef", 3), "abc");
    }
}
