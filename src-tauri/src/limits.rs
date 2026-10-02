//! Every numeric bound of the backend, in one place (SECURITY P5, I1; ARCHITECTURE §5).
//!
//! Every PDF is hostile input: page sizes, page counts and file sizes come from the file and can be absurd, so the
//! limits are checked before memory is allocated. The checks are pure functions without PDFium, so they are
//! unit-tested directly. Frontend mirrors live in `src/lib/zoom.ts` (scale) and must stay in sync.

use std::time::Duration;

use crate::error::AppError;

// --- Render requests --------------------------------------------------------------------------------------------

/// Smallest accepted render scale (device pixels per PDF point).
pub const MIN_SCALE: f32 = 0.1;
/// Largest accepted render scale.
pub const MAX_SCALE: f32 = 8.0;
/// Longest accepted side of one rendered frame in pixels (ADR-002 §6: a frame is at most 4096 x 4096).
pub const MAX_RENDER_SIDE_PX: u32 = 4096;
/// Pixel budget of one rendered frame (width x height). Bounds the bitmap and the encoded PNG to tens of MiB.
pub const MAX_RENDER_PIXELS: u64 = 4096 * 4096;

// --- Documents --------------------------------------------------------------------------------------------------

/// Upper bound for simultaneously open documents (bounds memory held by the engine).
pub const MAX_OPEN_DOCUMENTS: usize = 32;
/// Longest file name (in characters) that is reported to the frontend for display; longer ones are cut.
pub const MAX_DISPLAY_NAME_CHARS: usize = 255;
/// Largest PDF file the app opens (ARCHITECTURE §4: 2 GiB).
pub const MAX_PDF_FILE_BYTES: u64 = 2 * 1024 * 1024 * 1024;

// --- Settings ---------------------------------------------------------------------------------------------------

/// Largest settings file that is read. A real one is well under 1 KiB; anything bigger is damaged or foreign and the
/// defaults are used instead (the file is user-writable, so its size is not trusted).
pub const MAX_SETTINGS_FILE_BYTES: u64 = 64 * 1024;

/// Range and default of the left panel's width in px (DESIGN 2, 3.8: 192 to 400, default 248). The frontend mirrors them as
/// `LEFT_PANEL_WIDTH` in `src/api/app.ts` and `PANEL` in `src/components/tokens.ts`; a test there fails on drift.
pub const LEFT_PANEL_MIN_WIDTH: u16 = 192;
pub const LEFT_PANEL_MAX_WIDTH: u16 = 400;
pub const LEFT_PANEL_DEFAULT_WIDTH: u16 = 248;
const _: () = assert!(
    LEFT_PANEL_MIN_WIDTH < LEFT_PANEL_DEFAULT_WIDTH
        && LEFT_PANEL_DEFAULT_WIDTH < LEFT_PANEL_MAX_WIDTH,
    "the left panel range must be ordered: minimum, default, maximum"
);

// --- Engine worker ----------------------------------------------------------------------------------------------

/// Deadline for loading a document (ADR-002 §8).
pub const OPEN_TIMEOUT: Duration = Duration::from_secs(20);
/// Deadline for rendering one page (ADR-002 §8).
pub const RENDER_TIMEOUT: Duration = Duration::from_secs(10);
/// Deadline for control jobs that only release resources (close).
pub const CONTROL_TIMEOUT: Duration = Duration::from_secs(5);
/// Pending jobs before new ones are refused with `engine_timeout` (back-pressure; callers never block on a full queue).
pub const ENGINE_QUEUE_DEPTH: usize = 64;
/// PDFium recurses on nested structures; give the worker more stack than the 2 MiB default (ADR-002 §1).
pub const ENGINE_STACK_BYTES: usize = 16 * 1024 * 1024;

// --- Validation -------------------------------------------------------------------------------------------------

/// Checks that `scale` is finite and within `MIN_SCALE..=MAX_SCALE`.
pub fn validate_scale(scale: f32) -> Result<f32, AppError> {
    if scale.is_finite() && (MIN_SCALE..=MAX_SCALE).contains(&scale) {
        Ok(scale)
    } else {
        Err(AppError::invalid("scale"))
    }
}

/// Checks that `page_index < page_count`.
pub fn validate_page_index(page_index: u32, page_count: u32) -> Result<u32, AppError> {
    if page_index < page_count {
        Ok(page_index)
    } else {
        Err(AppError::invalid("page"))
    }
}

/// Checks that a PDF file of `len` bytes may be opened.
pub fn validate_file_size(len: u64) -> Result<u64, AppError> {
    if len <= MAX_PDF_FILE_BYTES {
        Ok(len)
    } else {
        Err(AppError::too_large("file_size", MAX_PDF_FILE_BYTES))
    }
}

/// Pixel size of a page rendered at `scale` (pixels per point), rounded up so no content is clipped.
///
/// Fails with `limit_exceeded` if the page has no usable size, a side exceeds `MAX_RENDER_SIDE_PX` or the area exceeds
/// `MAX_RENDER_PIXELS`. Page sizes come from the file, so this runs on the real size before any bitmap is allocated.
pub fn pixel_size(width_pt: f32, height_pt: f32, scale: f32) -> Result<(u32, u32), AppError> {
    pixel_size_within(
        width_pt,
        height_pt,
        scale,
        MAX_RENDER_SIDE_PX,
        MAX_RENDER_PIXELS,
    )
}

fn pixel_size_within(
    width_pt: f32,
    height_pt: f32,
    scale: f32,
    max_side: u32,
    max_pixels: u64,
) -> Result<(u32, u32), AppError> {
    let scale = validate_scale(scale)?;
    let side = |points: f32| -> Result<u32, AppError> {
        if !points.is_finite() || points <= 0.0 {
            return Err(AppError::limit("dimension", u64::from(max_side)));
        }
        let pixels = (f64::from(points) * f64::from(scale)).ceil().max(1.0);
        if pixels > f64::from(max_side) {
            return Err(AppError::limit("dimension", u64::from(max_side)));
        }
        // `pixels` is in 1..=max_side here, so the cast is lossless.
        Ok(pixels as u32)
    };
    let (width, height) = (side(width_pt)?, side(height_pt)?);
    if u64::from(width) * u64::from(height) > max_pixels {
        return Err(AppError::limit("pixels", max_pixels));
    }
    Ok((width, height))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorCode;

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
                ErrorCode::InvalidArgument,
                "{bad}"
            );
        }
    }

    #[test]
    fn page_index_must_be_below_page_count() {
        assert_eq!(validate_page_index(0, 1).unwrap(), 0);
        assert_eq!(validate_page_index(4, 5).unwrap(), 4);
        assert_eq!(code(validate_page_index(5, 5)), ErrorCode::InvalidArgument);
        assert_eq!(code(validate_page_index(0, 0)), ErrorCode::InvalidArgument);
        assert_eq!(
            code(validate_page_index(u32::MAX, 5)),
            ErrorCode::InvalidArgument
        );
    }

    #[test]
    fn file_size_is_capped() {
        assert_eq!(validate_file_size(0).unwrap(), 0);
        assert_eq!(
            validate_file_size(MAX_PDF_FILE_BYTES).unwrap(),
            MAX_PDF_FILE_BYTES
        );
        assert_eq!(
            code(validate_file_size(MAX_PDF_FILE_BYTES + 1)),
            ErrorCode::TooLarge
        );
        assert_eq!(code(validate_file_size(u64::MAX)), ErrorCode::TooLarge);
    }

    #[test]
    fn pixel_size_rounds_up() {
        assert_eq!(pixel_size(612.0, 792.0, 1.0).unwrap(), (612, 792));
        assert_eq!(pixel_size(200.5, 100.2, 1.0).unwrap(), (201, 101));
        assert_eq!(pixel_size(1.0, 1.0, 0.1).unwrap(), (1, 1));
    }

    #[test]
    fn pixel_size_enforces_the_frame_side_limit() {
        // Exactly 4096 fits; one more point does not.
        assert_eq!(pixel_size(4096.0, 100.0, 1.0).unwrap(), (4096, 100));
        let error = pixel_size(4097.0, 100.0, 1.0).unwrap_err();
        assert_eq!(error.code(), ErrorCode::LimitExceeded);
        // Thin and long: the area is small, but the side exceeds the limit.
        assert_eq!(
            code(pixel_size(10.0, 40_000.0, 1.0)),
            ErrorCode::LimitExceeded
        );
        // A scale that pushes an A4 page over the side limit.
        assert_eq!(
            code(pixel_size(595.0, 842.0, 5.0)),
            ErrorCode::LimitExceeded
        );
    }

    #[test]
    fn pixel_size_enforces_the_pixel_budget() {
        // The largest allowed frame (4096 x 4096) is exactly the budget.
        assert_eq!(pixel_size(4096.0, 4096.0, 1.0).unwrap(), (4096, 4096));
        assert_eq!(
            u64::from(MAX_RENDER_SIDE_PX) * u64::from(MAX_RENDER_SIDE_PX),
            MAX_RENDER_PIXELS
        );
        // With a smaller budget the area check fires although both sides pass: 100 x 100 = 10 000 > 9 999.
        assert_eq!(
            pixel_size_within(100.0, 100.0, 1.0, 200, 10_000).unwrap(),
            (100, 100)
        );
        let error = pixel_size_within(100.0, 100.0, 1.0, 200, 9_999).unwrap_err();
        assert_eq!(error.code(), ErrorCode::LimitExceeded);
    }

    #[test]
    fn pixel_size_rejects_hostile_page_sizes() {
        for (w, h) in [
            (0.0, 100.0),
            (100.0, 0.0),
            (-5.0, 100.0),
            (f32::NAN, 100.0),
            (100.0, f32::INFINITY),
            (f32::MAX, f32::MAX),
        ] {
            assert_eq!(code(pixel_size(w, h, 1.0)), ErrorCode::LimitExceeded);
        }
    }

    #[test]
    fn pixel_size_validates_the_scale_first() {
        assert_eq!(
            code(pixel_size(100.0, 100.0, 9.0)),
            ErrorCode::InvalidArgument
        );
    }

    #[test]
    fn deadlines_are_ordered_by_job_weight() {
        const _: () = assert!(CONTROL_TIMEOUT.as_secs() < RENDER_TIMEOUT.as_secs());
        const _: () = assert!(RENDER_TIMEOUT.as_secs() <= OPEN_TIMEOUT.as_secs());
    }
}
