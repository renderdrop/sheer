//! Picture signatures (ADR-041 §6): a PNG or JPEG the user picked, decoded with limits and re-encoded as a metadata-free PNG. A
//! picture is hostile input: the file is judged on its open handle, the format comes from the magic bytes (not the name), the
//! header is read and bounded before any pixel is decoded, and nothing of the original file survives (EXIF, ICC and text chunks
//! never reach the PNG: only the pixels do).

use std::fs::File;
use std::io::{Cursor, Read};
use std::path::Path;

use image::imageops::{self, FilterType};
use image::{DynamicImage, ImageDecoder, ImageFormat, ImageReader, Limits, RgbaImage};

use super::Art;
use crate::error::{AppError, ErrorCode};
use crate::storage::open_without_blocking;

/// The file may be this big.
pub const MAX_FILE_BYTES: u64 = 10 * 1024 * 1024;
/// Pixels per side and in all, and what the decoder may allocate.
pub const MAX_SIDE_PX: u32 = 4_000;
pub const MAX_PIXELS: u64 = 16_000_000;
pub const MAX_ALLOC_BYTES: u64 = 128 * 1024 * 1024;
/// The art is brought down to this on its long side.
pub const MAX_ART_SIDE_PX: u32 = 1_600;
/// The PNG of the art; a picture that does not fit is shrunk until it does.
pub const MAX_ART_BYTES: usize = 512 * 1024;
/// A pixel at least this bright (luminance, 0 to 255) becomes transparent when the background is removed.
pub const BACKGROUND_LUMINANCE: u32 = 235;
/// The smallest side the shrinking goes to.
const MIN_SHRUNK_SIDE_PX: u32 = 16;

/// Reads the file the user picked, judged on its open handle: a regular file of at most [`MAX_FILE_BYTES`], plain local spelling.
pub fn read_picked(path: &Path) -> Result<Vec<u8>, AppError> {
    if !crate::documents::intake::spelling_is_plain(path) {
        return Err(AppError::invalid("image"));
    }
    let file = open_without_blocking(path)?;
    read_handle(file)
}

fn read_handle(file: File) -> Result<Vec<u8>, AppError> {
    let meta = file.metadata()?;
    if !meta.is_file() || meta.len() == 0 {
        return Err(AppError::invalid("image"));
    }
    if meta.len() > MAX_FILE_BYTES {
        return Err(AppError::too_large("image", MAX_FILE_BYTES));
    }
    // The size can change after it was looked at: the read stops one byte past the limit.
    let mut bytes = Vec::new();
    file.take(MAX_FILE_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err(AppError::too_large("image", MAX_FILE_BYTES));
    }
    Ok(bytes)
}

/// PNG or JPEG by the first bytes; anything else is `None`.
fn sniff(bytes: &[u8]) -> Option<ImageFormat> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some(ImageFormat::Png)
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some(ImageFormat::Jpeg)
    } else {
        None
    }
}

fn decode_failed(error: image::ImageError) -> AppError {
    // A picture over the limits is a limit; one that does not decode is the user's problem, not the app's: invalid input, the
    // detail only in the log.
    if matches!(error, image::ImageError::Limits(_)) {
        return AppError::limit("image", MAX_PIXELS);
    }
    AppError::logged(ErrorCode::InvalidArgument, format!("image: {error}"))
}

fn decode(bytes: &[u8]) -> Result<RgbaImage, AppError> {
    let format = sniff(bytes).ok_or_else(|| AppError::invalid("image"))?;
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_SIDE_PX);
    limits.max_image_height = Some(MAX_SIDE_PX);
    limits.max_alloc = Some(MAX_ALLOC_BYTES);
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    reader.limits(limits);
    let mut decoder = reader.into_decoder().map_err(decode_failed)?;
    let (width, height) = decoder.dimensions();
    if width == 0
        || height == 0
        || width > MAX_SIDE_PX
        || height > MAX_SIDE_PX
        || u64::from(width) * u64::from(height) > MAX_PIXELS
    {
        return Err(AppError::limit("image", MAX_PIXELS));
    }
    // A phone's JPEG says how it is to be turned; the PNG will not carry that, so it is applied now.
    let orientation = decoder
        .orientation()
        .unwrap_or(image::metadata::Orientation::NoTransforms);
    let mut picture = DynamicImage::from_decoder(decoder).map_err(decode_failed)?;
    picture.apply_orientation(orientation);
    Ok(picture.to_rgba8())
}

/// Makes the near-white pixels transparent, and every transparent pixel `0 0 0 0` (nothing hides in the colour of a pixel that
/// cannot be seen).
fn clear_background(picture: &mut RgbaImage, remove_background: bool) {
    for pixel in picture.pixels_mut() {
        let [r, g, b, a] = pixel.0;
        let luminance = (299 * u32::from(r) + 587 * u32::from(g) + 114 * u32::from(b)) / 1000;
        if a == 0 || (remove_background && luminance >= BACKGROUND_LUMINANCE) {
            pixel.0 = [0, 0, 0, 0];
        }
    }
}

/// The box of the pixels that are not transparent: `(x, y, w, h)`.
fn content_box(picture: &RgbaImage) -> Option<(u32, u32, u32, u32)> {
    let (mut left, mut top) = (u32::MAX, u32::MAX);
    let (mut right, mut bottom) = (0u32, 0u32);
    for (x, y, pixel) in picture.enumerate_pixels() {
        if pixel.0[3] != 0 {
            left = left.min(x);
            top = top.min(y);
            right = right.max(x);
            bottom = bottom.max(y);
        }
    }
    (left != u32::MAX).then(|| (left, top, right - left + 1, bottom - top + 1))
}

/// A PNG of `picture`: RGBA8, no other chunk than what the format needs.
pub fn encode_png(picture: &RgbaImage) -> Result<Vec<u8>, AppError> {
    let fail = |error: png::EncodingError| AppError::logged(ErrorCode::Internal, error);
    let mut out = Vec::new();
    let mut encoder = png::Encoder::new(&mut out, picture.width(), picture.height());
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    encoder.set_compression(png::Compression::High);
    let mut writer = encoder.write_header().map_err(fail)?;
    writer.write_image_data(picture.as_raw()).map_err(fail)?;
    writer.finish().map_err(fail)?;
    Ok(out)
}

fn scaled(picture: &RgbaImage, factor: f32) -> RgbaImage {
    let side = |value: u32| ((value as f32 * factor).round() as u32).max(1);
    imageops::resize(
        picture,
        side(picture.width()),
        side(picture.height()),
        FilterType::Triangle,
    )
}

/// The art of the picture in `bytes` (the contents of a PNG or JPEG file). `invalid_argument` (`image`) for a format that is not one
/// of the two, a picture that does not decode, or one with nothing in it once the background is gone; `limit_exceeded` (`image`) for
/// more than [`MAX_SIDE_PX`] pixels on a side or [`MAX_PIXELS`] in all, or a result that stays above [`MAX_ART_BYTES`]; `too_large`
/// for more than [`MAX_FILE_BYTES`].
pub fn import(bytes: &[u8], remove_background: bool) -> Result<Art, AppError> {
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err(AppError::too_large("image", MAX_FILE_BYTES));
    }
    let mut picture = decode(bytes)?;
    clear_background(&mut picture, remove_background);
    let (x, y, w, h) = content_box(&picture).ok_or_else(|| AppError::invalid("image"))?;
    let mut picture = imageops::crop_imm(&picture, x, y, w, h).to_image();
    let longest = picture.width().max(picture.height());
    if longest > MAX_ART_SIDE_PX {
        picture = scaled(&picture, MAX_ART_SIDE_PX as f32 / longest as f32);
    }
    loop {
        let png = encode_png(&picture)?;
        if png.len() <= MAX_ART_BYTES {
            return Ok(Art::Raster {
                w: picture.width(),
                h: picture.height(),
                png,
            });
        }
        if picture.width().min(picture.height()) <= MIN_SHRUNK_SIDE_PX {
            return Err(AppError::limit("image", MAX_ART_BYTES as u64));
        }
        picture = scaled(&picture, 0.75);
    }
}

/// The pixels of a PNG made by [`import`] (our own output, so the limits are the art's).
pub fn decode_art(png: &[u8]) -> Result<RgbaImage, AppError> {
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_ART_SIDE_PX);
    limits.max_image_height = Some(MAX_ART_SIDE_PX);
    limits.max_alloc = Some(MAX_ALLOC_BYTES);
    let mut reader = ImageReader::with_format(Cursor::new(png), ImageFormat::Png);
    reader.limits(limits);
    reader
        .decode()
        .map(|picture| picture.to_rgba8())
        .map_err(|error| AppError::logged(ErrorCode::Internal, format!("art: {error}")))
}

/// A PNG of the art that fits `max_px` on its long side (the art itself if it fits already): its size and bytes.
pub fn preview(png: &[u8], max_px: u32) -> Result<(u32, u32, Vec<u8>), AppError> {
    let picture = decode_art(png)?;
    let longest = picture.width().max(picture.height());
    if longest <= max_px {
        return Ok((picture.width(), picture.height(), png.to_vec()));
    }
    let small = scaled(&picture, max_px as f32 / longest as f32);
    Ok((small.width(), small.height(), encode_png(&small)?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgba;

    fn code<T>(result: Result<T, AppError>) -> ErrorCode {
        result
            .err()
            .map(|e| e.code())
            .unwrap_or(ErrorCode::Internal)
    }

    /// A white sheet with a dark 20 x 10 block at (30, 40).
    fn sheet(width: u32, height: u32) -> RgbaImage {
        let mut picture = RgbaImage::from_pixel(width, height, Rgba([255, 255, 255, 255]));
        for y in 40..50 {
            for x in 30..50 {
                picture.put_pixel(x, y, Rgba([10, 20, 30, 255]));
            }
        }
        picture
    }

    fn jpeg(picture: &RgbaImage) -> Vec<u8> {
        let rgb = DynamicImage::ImageRgba8(picture.clone()).to_rgb8();
        let mut out = Vec::new();
        rgb.write_to(&mut Cursor::new(&mut out), ImageFormat::Jpeg)
            .unwrap();
        out
    }

    #[test]
    fn a_png_is_trimmed_and_its_white_removed() {
        let png = encode_png(&sheet(100, 100)).unwrap();
        let Art::Raster { w, h, png } = import(&png, true).unwrap() else {
            panic!("not raster")
        };
        assert_eq!((w, h), (20, 10));
        let back = decode_art(&png).unwrap();
        assert_eq!(back.get_pixel(0, 0).0[3], 255);
    }

    #[test]
    fn without_background_removal_the_sheet_stays() {
        let png = encode_png(&sheet(100, 100)).unwrap();
        let Art::Raster { w, h, .. } = import(&png, false).unwrap() else {
            panic!("not raster")
        };
        assert_eq!((w, h), (100, 100));
    }

    #[test]
    fn a_jpeg_is_accepted_and_comes_out_as_a_png() {
        let Art::Raster { png, .. } = import(&jpeg(&sheet(64, 64)), true).unwrap() else {
            panic!("not raster")
        };
        assert!(png.starts_with(b"\x89PNG"));
    }

    #[test]
    fn the_png_has_no_ancillary_chunks() {
        // A PNG with a text chunk goes in; the chunks of what comes out are the ones a picture needs.
        let mut with_text = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut with_text, 40, 40);
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            encoder
                .add_text_chunk("Comment".to_owned(), "secret location".to_owned())
                .unwrap();
            let mut writer = encoder.write_header().unwrap();
            writer
                .write_image_data(
                    &vec![0u8; 40 * 40 * 4]
                        .iter()
                        .map(|_| 1u8)
                        .collect::<Vec<_>>(),
                )
                .unwrap();
        }
        assert!(with_text.windows(7).any(|w| w == b"Comment"));
        let Art::Raster { png, .. } = import(&with_text, false).unwrap() else {
            panic!("not raster")
        };
        assert!(!png.windows(7).any(|w| w == b"Comment"));
        assert!(!png
            .windows(4)
            .any(|w| w == b"tEXt" || w == b"iTXt" || w == b"eXIf" || w == b"iCCP"));
    }

    #[test]
    fn other_formats_and_nothing_are_refused() {
        assert_eq!(
            code(import(b"GIF89a....", false)),
            ErrorCode::InvalidArgument
        );
        assert_eq!(code(import(b"%PDF-1.7", false)), ErrorCode::InvalidArgument);
        assert_eq!(
            code(import(b"\x89PNG\r\n\x1a\ntruncated", false)),
            ErrorCode::InvalidArgument
        );
        // All white with the background removed: nothing is left.
        let png = encode_png(&RgbaImage::from_pixel(8, 8, Rgba([255, 255, 255, 255]))).unwrap();
        assert_eq!(code(import(&png, true)), ErrorCode::InvalidArgument);
    }
    #[test]
    fn the_pixel_limits_are_enforced_before_decoding() {
        // 4 001 pixels wide: refused from the header alone.
        let wide = encode_png(&RgbaImage::new(MAX_SIDE_PX + 1, 1)).unwrap();
        assert_eq!(code(import(&wide, false)), ErrorCode::LimitExceeded);
        let tall = encode_png(&RgbaImage::new(1, MAX_SIDE_PX + 1)).unwrap();
        assert_eq!(code(import(&tall, false)), ErrorCode::LimitExceeded);
        assert_eq!(MAX_PIXELS, u64::from(MAX_SIDE_PX) * u64::from(MAX_SIDE_PX));
    }

    #[test]
    fn a_file_over_10_mib_is_too_large() {
        let big = vec![0u8; MAX_FILE_BYTES as usize + 1];
        assert_eq!(code(import(&big, false)), ErrorCode::TooLarge);
    }

    #[test]
    fn the_art_is_brought_down_to_1600_px_and_the_preview_to_what_was_asked() {
        let mut picture = RgbaImage::from_pixel(3_000, 600, Rgba([0, 0, 0, 255]));
        picture.put_pixel(0, 0, Rgba([255, 0, 0, 255]));
        let png = encode_png(&picture).unwrap();
        let Art::Raster { w, h, png } = import(&png, false).unwrap() else {
            panic!("not raster")
        };
        assert_eq!((w, h), (1_600, 320));
        let (pw, ph, small) = preview(&png, 100).unwrap();
        assert_eq!((pw, ph), (100, 20));
        assert!(small.starts_with(b"\x89PNG"));
        let (fw, _, same) = preview(&png, 1_600).unwrap();
        assert_eq!(fw, 1_600);
        assert_eq!(same, png);
    }

    #[test]
    fn a_picked_file_must_be_a_regular_file() {
        let dir = std::env::temp_dir().join(format!("sheer-raster-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(code(read_picked(&dir)), ErrorCode::InvalidArgument);
        let file = dir.join("a.png");
        std::fs::write(&file, encode_png(&sheet(50, 60)).unwrap()).unwrap();
        assert!(read_picked(&file).is_ok());
        let empty = dir.join("empty.png");
        std::fs::write(&empty, b"").unwrap();
        assert_eq!(code(read_picked(&empty)), ErrorCode::InvalidArgument);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
