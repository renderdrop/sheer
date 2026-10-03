//! Rendering a page for true redaction (ADR-047 §3). Only the worker calls this.

use pdfium_render::prelude::*;

use super::space::load_page;
use crate::error::{AppError, ErrorCode};
use crate::limits;
use crate::model::geometry::Rect;
use crate::pdfwrite::redact::RasterPage;

fn internal(detail: impl std::fmt::Debug) -> AppError {
    AppError::logged(ErrorCode::Internal, format!("{detail:?}"))
}

/// The bitmap size for a page of `width_pt` x `height_pt` points drawn at `dpi`, lowered so that it stays within
/// `MAX_REDACT_SIDE_PX` per side and `MAX_REDACT_PIXELS`: `(width, height)` in pixels. A page that would need less than
/// `MIN_REDACT_DPI` for that (or `dpi` itself below it) is `limit_exceeded` (`redactPage`).
pub(super) fn raster_size(width_pt: f32, height_pt: f32, dpi: f32) -> Result<(u32, u32), AppError> {
    let too_large = || AppError::limit("redactPage", limits::MAX_REDACT_PIXELS);
    if !(width_pt.is_finite() && height_pt.is_finite() && width_pt > 0.0 && height_pt > 0.0) {
        return Err(AppError::invalid("page"));
    }
    if !dpi.is_finite() || dpi < limits::MIN_REDACT_DPI {
        return Err(too_large());
    }
    let (w, h) = (f64::from(width_pt), f64::from(height_pt));
    let side = f64::from(limits::MAX_REDACT_SIDE_PX);
    #[allow(clippy::cast_precision_loss)] // 16 million is exact in an f64
    let area = limits::MAX_REDACT_PIXELS as f64;
    let scale = (f64::from(dpi) / 72.0)
        .min(side / w.max(h))
        .min((area / (w * h)).sqrt());
    if scale * 72.0 < f64::from(limits::MIN_REDACT_DPI) - 1e-6 {
        return Err(too_large());
    }
    // Rounded down, so that the caps hold.
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)] // 1..=4096 by the caps above
    let pixels =
        |points: f64| ((points * scale).floor() as u32).clamp(1, limits::MAX_REDACT_SIDE_PX);
    Ok((pixels(w), pixels(h)))
}

/// Fills the rectangles of `burn` (page space: points from the top left, before the rotation), each grown by one pixel, with black in
/// `rgb` (`width` x `height`, tightly packed). A rectangle that is not a number or lies outside is cut to the bitmap or ignored.
pub(super) fn burn_rects(
    rgb: &mut [u8],
    width: u32,
    height: u32,
    scale: (f32, f32),
    burn: &[Rect],
) {
    let clamp = |value: f32, max: u32| -> usize {
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        // clamped to 0..=max first
        let pixel = value.clamp(0.0, max as f32) as usize;
        pixel
    };
    let row_bytes = width as usize * 3;
    for rect in burn {
        let numbers = [rect.x, rect.y, rect.w, rect.h];
        if !numbers.iter().all(|n| n.is_finite()) || rect.w < 0.0 || rect.h < 0.0 {
            continue;
        }
        let x0 = clamp((rect.x * scale.0).floor() - 1.0, width);
        let x1 = clamp(((rect.x + rect.w) * scale.0).ceil() + 1.0, width);
        let y0 = clamp((rect.y * scale.1).floor() - 1.0, height);
        let y1 = clamp(((rect.y + rect.h) * scale.1).ceil() + 1.0, height);
        if x0 >= x1 {
            continue;
        }
        for row in y0..y1 {
            let start = row * row_bytes;
            if let Some(span) = rgb.get_mut(start + x0 * 3..start + x1 * 3) {
                span.fill(0);
            }
        }
    }
}

/// Draws page `engine_index` as PDFium shows it (file content, file annotations and form widgets with their file appearances, crop
/// applied) at `dpi`, fills every rectangle of `burn` (page space, grown by 1 px) with opaque black in the bitmap, and returns the bitmap
/// (Gray8 if every pixel is grey, else RGB8). A page that would need less than 72 dpi to stay within 4 096 px per side and 16 MP is
/// `limit_exceeded` (`redactPage`).
///
/// The bitmap is the page *before* its `/Rotate` (the raster page gets the rotation back): the page is turned to 0 for the draw and
/// turned back right after, on every path.
pub(super) fn render_for_redaction(
    document: &PdfDocument<'_>,
    engine_index: u32,
    dpi: f32,
    burn: &[Rect],
) -> Result<RasterPage, AppError> {
    let count = u32::try_from(document.pages().len()).unwrap_or(0);
    if engine_index >= count {
        return Err(AppError::invalid("page"));
    }
    let mut page = load_page(document, engine_index)?;
    let turned = page.rotation().map_err(internal)?;
    page.set_rotation(PdfPageRenderRotation::None);
    let result = draw(&page, dpi, burn);
    page.set_rotation(turned);
    result
}

fn draw(page: &PdfPage<'_>, dpi: f32, burn: &[Rect]) -> Result<RasterPage, AppError> {
    let (width_pt, height_pt) = (page.width().value, page.height().value);
    let (width, height) = raster_size(width_pt, height_pt, dpi)?;
    let to_i32 = |value: u32| i32::try_from(value).map_err(|_| internal("bitmap size"));
    // BGR with PDFium's reverse-byte-order flag gives RGB rows (as the tile renderer does).
    let config = PdfRenderConfig::new()
        .set_target_size(to_i32(width)?, to_i32(height)?)
        .set_format(PdfBitmapFormat::BGR)
        .set_reverse_byte_order(true);
    let mut bitmap = PdfBitmap::empty(to_i32(width)?, to_i32(height)?, PdfBitmapFormat::BGR)
        .map_err(internal)?;
    page.render_into_bitmap_with_config(&mut bitmap, &config)
        .map_err(internal)?;
    if (bitmap.width(), bitmap.height()) != (to_i32(width)?, to_i32(height)?) {
        return Err(internal("the bitmap is not the size asked for"));
    }
    let raw = bitmap.as_raw_bytes();
    drop(bitmap);
    let stride = raw.len() / height as usize;
    let row_bytes = width as usize * 3;
    if stride < row_bytes {
        return Err(internal("the bitmap rows are too short"));
    }
    let mut rgb = Vec::with_capacity(row_bytes * height as usize);
    for row in raw.chunks_exact(stride).take(height as usize) {
        rgb.extend_from_slice(&row[..row_bytes]);
    }
    #[allow(clippy::cast_precision_loss)] // sizes are at most 4 096
    let scale = (width as f32 / width_pt, height as f32 / height_pt);
    burn_rects(&mut rgb, width, height, scale, burn);
    Ok(RasterPage::from_rgb(rgb, width, height))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x: f32, y: f32, w: f32, h: f32) -> Rect {
        Rect { x, y, w, h }
    }

    #[test]
    fn a_letter_page_is_drawn_at_200_dpi() {
        assert_eq!(raster_size(612.0, 792.0, 200.0).unwrap(), (1700, 2200));
    }

    #[test]
    fn a_big_page_is_lowered_to_the_side_and_pixel_caps() {
        // A0 poster: 2384 x 3370 pt. 4096 px on the long side = 87.5 dpi (and 4096 x 2897 = 11.9 MP).
        let (w, h) = raster_size(2384.0, 3370.0, 200.0).unwrap();
        assert!(w.max(h) <= 4096 && u64::from(w) * u64::from(h) <= 16_000_000);
        assert!(w.max(h) > 4000);
        // Square page: the pixel cap binds first (4000 x 4000 = 16 MP).
        let (w, h) = raster_size(3000.0, 3000.0, 200.0).unwrap();
        assert!(u64::from(w) * u64::from(h) <= 16_000_000 && w >= 3999);
    }

    #[test]
    fn a_page_that_would_need_under_72_dpi_is_too_large() {
        let error = raster_size(7200.0, 7200.0, 200.0).unwrap_err();
        assert_eq!(error.code(), ErrorCode::LimitExceeded);
        assert!(raster_size(612.0, 792.0, 50.0).is_err());
        assert!(raster_size(f32::NAN, 792.0, 200.0).is_err());
        // Exactly 72 dpi fits.
        assert!(raster_size(4096.0 / 1.0, 3900.0, 200.0).is_ok());
    }

    #[test]
    fn marks_are_filled_black_with_one_pixel_around_and_never_outside() {
        let (w, h) = (20u32, 10u32);
        let mut rgb = vec![255u8; (w * h * 3) as usize];
        // 2 px per point: the mark covers x 3..5 pt, y 2..3 pt = pixels 6..10 x 4..6.
        burn_rects(&mut rgb, w, h, (2.0, 2.0), &[rect(3.0, 2.0, 2.0, 1.0)]);
        let black = |x: usize, y: usize| rgb[(y * w as usize + x) * 3] == 0;
        for y in 0..h as usize {
            for x in 0..w as usize {
                let inside = (5..=10).contains(&x) && (3..=6).contains(&y);
                assert_eq!(black(x, y), inside, "pixel {x},{y}");
            }
        }
        // A mark past the edge and one that is not a number change nothing out of range and do not panic.
        let mut again = vec![255u8; (w * h * 3) as usize];
        burn_rects(
            &mut again,
            w,
            h,
            (2.0, 2.0),
            &[
                rect(1000.0, 1000.0, 5.0, 5.0),
                rect(f32::NAN, 0.0, 1.0, 1.0),
                rect(-50.0, -50.0, 55.0, 55.0),
            ],
        );
        assert!(again[0] == 0, "a mark half outside is cut to the bitmap");
        assert!(again[(9 * w as usize + 19) * 3] == 255);
    }
}
