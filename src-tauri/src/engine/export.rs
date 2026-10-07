// owned by package A
//! Rendering a page for an export or a print (ADR-049 §2, §4). Only the worker calls this.

use pdfium_render::prelude::*;

use super::snapshot::Snapshots;
use super::space::load_page;
use super::worker::Documents;
use crate::error::{AppError, ErrorCode};
use crate::export::images::fit;
use crate::export::snapshot::EngineDocRef;
use crate::limits;
use crate::pdfwrite::redact::{RasterPage, RasterPixels};

fn internal(detail: impl std::fmt::Debug) -> AppError {
    AppError::logged(ErrorCode::Internal, format!("{detail:?}"))
}

/// Draws page `engine_index` of `doc` at `dpi` as RGB8 on white, annotations on or off (off also hides widgets), turned by
/// `rotate_quarter` quarter turns clockwise. The bitmap stays within `MAX_EXPORT_SIDE_PX` per side and `MAX_EXPORT_PIXELS` (the
/// dpi is lowered if needed; the caller that wants to tell the user asks [`fit`] first).
pub(super) fn render<'a>(
    documents: &Documents<'a>,
    snapshots: &Snapshots<'a>,
    doc: EngineDocRef,
    engine_index: u32,
    dpi: f32,
    annotations: bool,
    rotate_quarter: u8,
) -> Result<RasterPage, AppError> {
    let document = match doc {
        EngineDocRef::Live(id) => documents.get(&id),
        EngineDocRef::Snapshot(id) => snapshots.get(&id),
    }
    .ok_or(AppError::not_found("document"))?;
    let count = u32::try_from(document.pages().len()).unwrap_or(0);
    if engine_index >= count {
        return Err(AppError::invalid("page"));
    }
    let page = load_page(document, engine_index)?;
    let Some(size) = fit(page.width().value, page.height().value, dpi) else {
        return Err(AppError::limit("pixels", limits::MAX_EXPORT_PIXELS));
    };
    let to_i32 = |value: u32| i32::try_from(value).map_err(|_| internal("bitmap size"));
    let (width, height) = (to_i32(size.width)?, to_i32(size.height)?);
    // BGR with PDFium's reverse-byte-order flag gives RGB rows; the clear colour is white.
    let config = PdfRenderConfig::new()
        .set_target_size(width, height)
        .set_format(PdfBitmapFormat::BGR)
        .set_reverse_byte_order(true)
        .render_annotations(annotations)
        .render_form_data(annotations);
    let mut bitmap = PdfBitmap::empty(width, height, PdfBitmapFormat::BGR).map_err(internal)?;
    page.render_into_bitmap_with_config(&mut bitmap, &config)
        .map_err(internal)?;
    if (bitmap.width(), bitmap.height()) != (width, height) {
        return Err(internal("the bitmap is not the size asked for"));
    }
    let raw = bitmap.as_raw_bytes();
    let stride = raw.len() / size.height as usize;
    let row_bytes = size.width as usize * 3;
    if stride < row_bytes {
        return Err(internal("the bitmap rows are too short"));
    }
    let mut rgb = Vec::with_capacity(row_bytes * size.height as usize);
    for row in raw.chunks_exact(stride).take(size.height as usize) {
        rgb.extend_from_slice(&row[..row_bytes]);
    }
    drop(bitmap);
    let (rgb, width, height) = rotate_rgb(rgb, size.width, size.height, rotate_quarter);
    Ok(RasterPage::from_rgb(rgb, width, height))
}

/// The lowest resolution a page is recognized at; a page that needs less to fit is refused (`page_too_large`, ADR-134 item 4).
pub(super) const OCR_MIN_DPI: f32 = 150.0;

/// The bitmap for recognizing a `width_pt` x `height_pt` page at `dpi`: lowered to keep the longest side within `max_side` and the
/// area within the OCR pixel cap. `(width, height, effective dpi)`; `None` below [`OCR_MIN_DPI`] or when the size is not a number.
pub(super) fn ocr_fit(
    width_pt: f32,
    height_pt: f32,
    dpi: f32,
    max_side: u32,
) -> Option<(u32, u32, f32)> {
    if !(width_pt.is_finite() && height_pt.is_finite() && width_pt > 0.0 && height_pt > 0.0)
        || !dpi.is_finite()
        || dpi <= 0.0
        || max_side == 0
    {
        return None;
    }
    let (w, h) = (f64::from(width_pt), f64::from(height_pt));
    #[allow(clippy::cast_precision_loss)] // 40 million is exact in an f64
    let area = crate::ocr::limits::MAX_PIXELS as f64;
    let scale = (f64::from(dpi) / 72.0)
        .min(f64::from(max_side) / w.max(h))
        .min((area / (w * h)).sqrt());
    if scale * 72.0 < f64::from(OCR_MIN_DPI) - 1e-6 {
        return None;
    }
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    // 1..=max_side by the caps above
    let pixels = |points: f64| ((points * scale).floor() as u32).clamp(1, max_side);
    #[allow(clippy::cast_possible_truncation)]
    let effective = (scale * 72.0) as f32;
    Some((pixels(w), pixels(h), effective))
}

/// Draws page `engine_index` of `doc` for recognition: Gray8 on white, annotations (and widgets) off, as displayed (PDFium applies
/// `/Rotate`), within `max_side` per side. `limit_exceeded` `page_too_large` when the page cannot be drawn at [`OCR_MIN_DPI`].
pub(super) fn render_gray<'a>(
    documents: &Documents<'a>,
    snapshots: &Snapshots<'a>,
    doc: EngineDocRef,
    engine_index: u32,
    dpi: f32,
    max_side: u32,
) -> Result<RasterPage, AppError> {
    let document = match doc {
        EngineDocRef::Live(id) => documents.get(&id),
        EngineDocRef::Snapshot(id) => snapshots.get(&id),
    }
    .ok_or(AppError::not_found("document"))?;
    let count = u32::try_from(document.pages().len()).unwrap_or(0);
    if engine_index >= count {
        return Err(AppError::invalid("page"));
    }
    let page = load_page(document, engine_index)?;
    let max_side = max_side.min(crate::ocr::limits::MAX_SIDE_PX);
    let Some((w, h, _)) = ocr_fit(page.width().value, page.height().value, dpi, max_side) else {
        return Err(AppError::limit("page_too_large", u64::from(max_side)));
    };
    let to_i32 = |value: u32| i32::try_from(value).map_err(|_| internal("bitmap size"));
    let (width, height) = (to_i32(w)?, to_i32(h)?);
    // PDFium's Gray bitmap draws nothing reliably: draw BGR (as the export does) and reduce to gray here.
    let config = PdfRenderConfig::new()
        .set_target_size(width, height)
        .set_format(PdfBitmapFormat::BGR)
        .set_reverse_byte_order(true)
        .render_annotations(false)
        .render_form_data(false);
    let mut bitmap = PdfBitmap::empty(width, height, PdfBitmapFormat::BGR).map_err(internal)?;
    page.render_into_bitmap_with_config(&mut bitmap, &config)
        .map_err(internal)?;
    if (bitmap.width(), bitmap.height()) != (width, height) {
        return Err(internal("the bitmap is not the size asked for"));
    }
    let raw = bitmap.as_raw_bytes();
    let stride = raw.len() / h as usize;
    let row_bytes = w as usize * 3;
    if stride < row_bytes {
        return Err(internal("the bitmap rows are too short"));
    }
    let mut gray = Vec::with_capacity(w as usize * h as usize);
    for row in raw.chunks_exact(stride).take(h as usize) {
        gray.extend(row[..row_bytes].as_chunks::<3>().0.iter().map(|p| {
            ((u32::from(p[0]) * 77 + u32::from(p[1]) * 150 + u32::from(p[2]) * 29) >> 8) as u8
        }));
    }
    Ok(RasterPage {
        pixels: RasterPixels::Gray8(gray),
        width: w,
        height: h,
    })
}

/// Tightly packed RGB8 rows of `width` x `height` turned by `quarter` quarter turns clockwise.
fn rotate_rgb(rgb: Vec<u8>, width: u32, height: u32, quarter: u8) -> (Vec<u8>, u32, u32) {
    let (w, h) = (width as usize, height as usize);
    let pixel = |x: usize, y: usize| rgb.get((y * w + x) * 3..(y * w + x) * 3 + 3);
    let mut out = Vec::with_capacity(rgb.len());
    match quarter % 4 {
        0 => (rgb, width, height),
        1 => {
            // New (x, y) comes from old (y, h - 1 - x); new size is h x w.
            for y in 0..w {
                for x in 0..h {
                    out.extend_from_slice(pixel(y, h - 1 - x).unwrap_or(&[255, 255, 255]));
                }
            }
            (out, height, width)
        }
        2 => {
            for y in 0..h {
                for x in 0..w {
                    out.extend_from_slice(pixel(w - 1 - x, h - 1 - y).unwrap_or(&[255, 255, 255]));
                }
            }
            (out, width, height)
        }
        _ => {
            for y in 0..w {
                for x in 0..h {
                    out.extend_from_slice(pixel(w - 1 - y, x).unwrap_or(&[255, 255, 255]));
                }
            }
            (out, height, width)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 2 x 1: red, green.
    fn two() -> Vec<u8> {
        vec![255, 0, 0, 0, 255, 0]
    }

    #[test]
    fn the_ocr_fit_keeps_the_side_and_refuses_below_the_minimum_dpi() {
        // A4 at 300 dpi is 2480 x 3508, within the side cap.
        let (w, h, dpi) = ocr_fit(595.0, 842.0, 300.0, 8000).unwrap();
        assert_eq!((w, h), (2479, 3508));
        assert!((dpi - 300.0).abs() < 0.1);
        // A 40 inch poster is lowered to fit 8000 px (200 dpi), still allowed.
        let (w, h, dpi) = ocr_fit(2880.0, 1440.0, 300.0, 8000).unwrap();
        assert!(w <= 8000 && h <= 8000 && (dpi - 200.0).abs() < 0.1);
        // 60 inches needs 133 dpi: refused.
        assert!(ocr_fit(4320.0, 1000.0, 300.0, 8000).is_none());
        assert!(ocr_fit(f32::NAN, 100.0, 300.0, 8000).is_none());
        assert!(ocr_fit(100.0, 100.0, 300.0, 0).is_none());
    }

    #[test]
    fn quarter_turns_move_the_pixels_clockwise() {
        let (a, w, h) = rotate_rgb(two(), 2, 1, 1);
        assert_eq!((w, h), (1, 2));
        assert_eq!(a, [255, 0, 0, 0, 255, 0]); // red on top, green below
        let (b, w, h) = rotate_rgb(two(), 2, 1, 2);
        assert_eq!((w, h), (2, 1));
        assert_eq!(b, [0, 255, 0, 255, 0, 0]);
        let (c, w, h) = rotate_rgb(two(), 2, 1, 3);
        assert_eq!((w, h), (1, 2));
        assert_eq!(c, [0, 255, 0, 255, 0, 0]); // green on top
        assert_eq!(rotate_rgb(two(), 2, 1, 4).0, two());
    }
}
