//! The bounds of the OCR pipe (ADR-134 item 9). A request is checked before anything is allocated for it; a reply is untrusted.

use std::time::Duration;

/// The longest side of a bitmap handed to the recognizer (Windows takes 10000).
pub const MAX_SIDE_PX: u32 = 8000;
/// The most pixels of one bitmap.
pub const MAX_PIXELS: u64 = 40_000_000;
/// The most words of one page a reply may hold.
pub const MAX_WORDS: usize = 20_000;
/// The most characters of one word.
pub const MAX_WORD_CHARS: usize = 128;
/// The most bytes of a reply header (the JSON).
pub const MAX_REPLY: usize = 8 * 1024 * 1024;
/// The most bytes of a request header.
pub const MAX_REQUEST_HEADER: usize = 4096;
/// How long one page may take before the child is killed.
pub const PAGE_TIMEOUT: Duration = Duration::from_secs(30);
/// The languages a request may name.
pub const LANGUAGES: &[&str] = &["de-DE", "en-US"];

/// The resolution pages are rendered at for recognition (ADR-134 item 4).
pub const TARGET_DPI: f32 = 300.0;
/// The lowest resolution a scan is rendered at when its image has less than [`TARGET_DPI`].
pub const MIN_IMAGE_DPI: f32 = 200.0;
/// The most child restarts per [`RESTART_WINDOW`] (as the engine).
pub const RESTART_BUDGET: usize = 5;
pub const RESTART_WINDOW: Duration = Duration::from_secs(600);
/// A page with fewer visible non-blank characters than this can be a scan.
pub const SCAN_MAX_CHARS: usize = 16;
/// The share of the crop box that images must cover for a scan.
pub const SCAN_COVER: f32 = 0.6;

/// The dpi to render a page at: [`TARGET_DPI`], or the effective resolution of its image when that is lower, but not under
/// [`MIN_IMAGE_DPI`]. `image_dpi` 0 (unknown) gives the target.
pub fn render_dpi(image_dpi: f32) -> f32 {
    if image_dpi.is_finite() && image_dpi > 0.0 && image_dpi < TARGET_DPI {
        image_dpi.max(MIN_IMAGE_DPI)
    } else {
        TARGET_DPI
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_render_dpi_follows_the_image_between_200_and_300() {
        assert_eq!(render_dpi(0.0), 300.0);
        assert_eq!(render_dpi(f32::NAN), 300.0);
        assert_eq!(render_dpi(600.0), 300.0);
        assert_eq!(render_dpi(250.0), 250.0);
        assert_eq!(render_dpi(96.0), 200.0);
    }
}
