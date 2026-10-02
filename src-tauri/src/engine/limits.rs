//! Validation of render requests. Pure functions, no PDFium needed, so they are unit-tested directly.
//!
//! Every PDF is hostile input: page sizes come from the file and can be absurd, so the pixel budget is checked
//! against the real page size before any bitmap is allocated.

use crate::error::{AppError, ErrorCode};

/// Smallest accepted render scale (device pixels per PDF point).
pub const MIN_SCALE: f32 = 0.1;
/// Largest accepted render scale.
pub const MAX_SCALE: f32 = 8.0;
/// Pixel budget of one rendered page (width x height).
pub const MAX_PIXELS: u64 = 40_000_000;
/// Longest accepted side of a rendered page in pixels.
pub const MAX_DIMENSION: u32 = 32_768;

/// Checks that `scale` is finite and within `MIN_SCALE..=MAX_SCALE`.
pub fn validate_scale(scale: f32) -> Result<f32, AppError> {
    if scale.is_finite() && (MIN_SCALE..=MAX_SCALE).contains(&scale) {
        Ok(scale)
    } else {
        Err(ErrorCode::ScaleOutOfRange.into())
    }
}

/// Checks that `page_index < page_count`.
pub fn validate_page_index(page_index: u32, page_count: u32) -> Result<u32, AppError> {
    if page_index < page_count {
        Ok(page_index)
    } else {
        Err(ErrorCode::PageOutOfRange.into())
    }
}

/// Pixel size of a page rendered at `scale` (pixels per point), rounded up so no content is clipped.
///
/// Fails with `RenderTooLarge` if the page has no usable size, a side exceeds `MAX_DIMENSION` or the area exceeds
/// `MAX_PIXELS`.
pub fn pixel_size(width_pt: f32, height_pt: f32, scale: f32) -> Result<(u32, u32), AppError> {
    let scale = validate_scale(scale)?;
    let side = |points: f32| -> Result<u32, AppError> {
        if !points.is_finite() || points <= 0.0 {
            return Err(ErrorCode::RenderTooLarge.into());
        }
        let pixels = (f64::from(points) * f64::from(scale)).ceil().max(1.0);
        if pixels > f64::from(MAX_DIMENSION) {
            return Err(ErrorCode::RenderTooLarge.into());
        }
        // `pixels` is in 1..=MAX_DIMENSION here, so the cast is lossless.
        Ok(pixels as u32)
    };
    let (width, height) = (side(width_pt)?, side(height_pt)?);
    if u64::from(width) * u64::from(height) > MAX_PIXELS {
        return Err(ErrorCode::RenderTooLarge.into());
    }
    Ok((width, height))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn code<T: std::fmt::Debug>(result: Result<T, AppError>) -> ErrorCode {
        result.unwrap_err().code()
    }

    #[test]
    fn scale_accepts_the_inclusive_range() {
        assert_eq!(validate_scale(MIN_SCALE).unwrap(), MIN_SCALE);
        assert_eq!(validate_scale(1.0).unwrap(), 1.0);
        assert_eq!(validate_scale(MAX_SCALE).unwrap(), MAX_SCALE);
    }

    #[test]
    fn scale_rejects_out_of_range_and_non_finite() {
        for bad in [
            0.0,
            0.099,
            8.001,
            -1.0,
            f32::NAN,
            f32::INFINITY,
            f32::NEG_INFINITY,
        ] {
            assert_eq!(
                code(validate_scale(bad)),
                ErrorCode::ScaleOutOfRange,
                "{bad}"
            );
        }
    }

    #[test]
    fn page_index_must_be_below_page_count() {
        assert_eq!(validate_page_index(0, 1).unwrap(), 0);
        assert_eq!(validate_page_index(4, 5).unwrap(), 4);
        assert_eq!(code(validate_page_index(5, 5)), ErrorCode::PageOutOfRange);
        assert_eq!(code(validate_page_index(0, 0)), ErrorCode::PageOutOfRange);
        assert_eq!(
            code(validate_page_index(u32::MAX, 5)),
            ErrorCode::PageOutOfRange
        );
    }

    #[test]
    fn pixel_size_rounds_up() {
        assert_eq!(pixel_size(612.0, 792.0, 1.0).unwrap(), (612, 792));
        assert_eq!(pixel_size(200.5, 100.2, 1.0).unwrap(), (201, 101));
        assert_eq!(pixel_size(1.0, 1.0, 0.1).unwrap(), (1, 1));
    }

    #[test]
    fn pixel_size_enforces_the_pixel_budget() {
        // 6000 x 6000 = 36 MP fits, 6400 x 6400 = 40.96 MP does not.
        assert_eq!(pixel_size(6000.0, 6000.0, 1.0).unwrap(), (6000, 6000));
        assert_eq!(
            code(pixel_size(6400.0, 6400.0, 1.0)),
            ErrorCode::RenderTooLarge
        );
        // Exactly at the budget: 8000 x 5000 = 40 MP.
        assert_eq!(pixel_size(8000.0, 5000.0, 1.0).unwrap(), (8000, 5000));
        assert_eq!(
            code(pixel_size(8001.0, 5000.0, 1.0)),
            ErrorCode::RenderTooLarge
        );
    }

    #[test]
    fn pixel_size_enforces_the_side_limit() {
        // Thin and long: the area is small, but the side exceeds MAX_DIMENSION.
        assert_eq!(
            code(pixel_size(10.0, 40_000.0, 1.0)),
            ErrorCode::RenderTooLarge
        );
    }

    #[test]
    fn pixel_size_rejects_hostile_page_sizes() {
        for (w, h) in [
            (0.0, 100.0),
            (100.0, 0.0),
            (-5.0, 100.0),
            (f32::NAN, 100.0),
            (100.0, f32::INFINITY),
        ] {
            assert_eq!(code(pixel_size(w, h, 1.0)), ErrorCode::RenderTooLarge);
        }
    }

    #[test]
    fn pixel_size_validates_the_scale_first() {
        assert_eq!(
            code(pixel_size(100.0, 100.0, 9.0)),
            ErrorCode::ScaleOutOfRange
        );
    }
}
