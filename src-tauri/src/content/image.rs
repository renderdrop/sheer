//! Image import for the page (ADR-047 §1). owned by package A.
//!
//! The file is judged at its opened handle, its header is read before it is decoded, EXIF orientation applies, all metadata is
//! dropped, and the result is stored as a document asset (opaque: JPEG q90; alpha: Flate RGB + `/SMask`).

use std::fs::File;
use std::io::{Cursor, Read};
use std::path::Path;
use std::sync::Arc;

use flate2::read::ZlibDecoder;
use flate2::write::ZlibEncoder;
use flate2::Compression;
use image::codecs::jpeg::JpegEncoder;
use image::imageops::FilterType;
use image::{
    DynamicImage, ExtendedColorType, ImageDecoder, ImageFormat, ImageReader, Limits, RgbaImage,
};
use serde::Serialize;

use crate::error::{AppError, ErrorCode};
use crate::limits;
use crate::model::doc_state::DocState;
use crate::model::ids::AssetId;

/// JPEG quality of an opaque picture.
const JPEG_QUALITY: u8 = 90;
/// How often a picture that is too big when stored is made smaller (by [`SHRINK_FACTOR`]) before it is turned down.
const MAX_SHRINKS: u32 = 6;
const SHRINK_FACTOR: f32 = 0.7;

/// What the UI is told about an inserted image (`ImageAssetInfo`). `height` is in pixels after downsizing; `aspect` is width over height.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageAssetInfo {
    pub asset_id: AssetId,
    pub width: u32,
    pub height: u32,
    pub aspect: f32,
}

/// The stored pixels of an image asset: exactly what the page's image XObject holds.
#[derive(Debug, Clone, PartialEq)]
pub enum Pixels {
    /// A baseline JPEG, RGB (`/DCTDecode`).
    Jpeg(Vec<u8>),
    /// Zlib-compressed RGB8 and, beside it, zlib-compressed Gray8 alpha (`/FlateDecode`, the second one the `/SMask`).
    Flate { rgb: Vec<u8>, alpha: Vec<u8> },
}

/// An image the document holds (`AssetStore::add_image`): metadata-free, at most 4 096 px on the long side.
#[derive(Debug, Clone, PartialEq)]
pub struct ImageAsset {
    pub width: u32,
    pub height: u32,
    pub pixels: Pixels,
}

impl ImageAsset {
    /// Width over height.
    #[allow(clippy::cast_precision_loss)]
    pub fn aspect(&self) -> f32 {
        self.width as f32 / self.height as f32
    }

    /// The bytes the asset holds.
    pub fn byte_size(&self) -> usize {
        match &self.pixels {
            Pixels::Jpeg(bytes) => bytes.len(),
            Pixels::Flate { rgb, alpha } => rgb.len() + alpha.len(),
        }
    }
}

/// Reads the opened PNG or JPEG `file`, stores it as an asset of `state` and describes it.
pub fn import(state: &mut DocState, file: File) -> Result<ImageAssetInfo, AppError> {
    let asset = prepare(file)?;
    store(state, asset)
}

/// Puts `asset` into the assets of `state`.
pub fn store(state: &mut DocState, asset: ImageAsset) -> Result<ImageAssetInfo, AppError> {
    let (width, height, aspect) = (asset.width, asset.height, asset.aspect());
    let asset_id = state.assets_mut().add_image(Arc::new(asset))?;
    Ok(ImageAssetInfo {
        asset_id,
        width,
        height,
        aspect,
    })
}

/// Opens the file the user picked (plain local spelling); it is judged on its handle by [`prepare`].
pub fn open_picked(path: &Path) -> Result<File, AppError> {
    if !crate::documents::intake::spelling_is_plain(path) {
        return Err(AppError::invalid("image"));
    }
    Ok(crate::storage::open_without_blocking(path)?)
}

/// Judges the opened handle (a regular file of at most 20 MiB), reads it and makes an asset of it. Does not touch any document.
pub fn prepare(file: File) -> Result<ImageAsset, AppError> {
    let meta = file.metadata()?;
    if !meta.is_file() || meta.len() == 0 {
        return Err(AppError::invalid("image"));
    }
    let max = limits::MAX_IMAGE_FILE_BYTES;
    if meta.len() > max {
        return Err(AppError::too_large("image", max));
    }
    // The size can change after it was looked at: the read stops one byte past the limit.
    let mut bytes = Vec::new();
    file.take(max + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > max {
        return Err(AppError::too_large("image", max));
    }
    prepare_bytes(&bytes)
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

/// The size the file's own header claims: the IHDR of a PNG, the first start-of-frame of a JPEG. `None` if it cannot be found (the
/// decoder then reports it).
fn header_dims(bytes: &[u8], format: ImageFormat) -> Option<(u32, u32)> {
    let be32 = |at: usize| -> Option<u32> {
        Some(u32::from_be_bytes(bytes.get(at..at + 4)?.try_into().ok()?))
    };
    let be16 = |at: usize| -> Option<u32> {
        Some(u32::from(u16::from_be_bytes(
            bytes.get(at..at + 2)?.try_into().ok()?,
        )))
    };
    match format {
        ImageFormat::Png => (bytes.get(12..16)? == b"IHDR").then_some((be32(16)?, be32(20)?)),
        ImageFormat::Jpeg => {
            let mut at = 2;
            while at + 4 <= bytes.len() {
                if bytes[at] != 0xFF {
                    return None;
                }
                let marker = bytes[at + 1];
                match marker {
                    0xFF => at += 1,
                    0x01 | 0xD0..=0xD8 => at += 2,
                    0xC0..=0xCF if !matches!(marker, 0xC4 | 0xC8 | 0xCC) => {
                        return Some((be16(at + 7)?, be16(at + 5)?));
                    }
                    0xD9 | 0xDA => return None,
                    _ => at += 2 + usize::try_from(be16(at + 2)?).ok()?,
                }
            }
            None
        }
        _ => None,
    }
}

fn check_dims(width: u32, height: u32) -> Result<(), AppError> {
    if width == 0
        || height == 0
        || width > limits::MAX_INSERT_IMAGE_SIDE_PX
        || height > limits::MAX_INSERT_IMAGE_SIDE_PX
        || u64::from(width) * u64::from(height) > limits::MAX_INSERT_IMAGE_PIXELS
    {
        return Err(AppError::limit("image", limits::MAX_INSERT_IMAGE_PIXELS));
    }
    Ok(())
}

fn decode_failed(error: image::ImageError) -> AppError {
    if matches!(error, image::ImageError::Limits(_)) {
        return AppError::limit("image", limits::MAX_INSERT_IMAGE_PIXELS);
    }
    AppError::logged(ErrorCode::InvalidArgument, format!("image: {error}"))
}

fn internal(error: impl std::fmt::Display) -> AppError {
    AppError::logged(ErrorCode::Internal, format!("image: {error}"))
}

/// Decodes `bytes` (the contents of a PNG or JPEG file) under the intake limits and makes an asset: the header is read and bounded
/// before any pixel is decoded, EXIF orientation is applied, nothing but the pixels is kept, a picture over 4 096 px on its long side is
/// brought down to that, and the pixels are stored as JPEG q90 (opaque) or Flate RGB with a Flate alpha plane.
#[allow(clippy::cast_precision_loss)]
pub fn prepare_bytes(bytes: &[u8]) -> Result<ImageAsset, AppError> {
    if bytes.len() as u64 > limits::MAX_IMAGE_FILE_BYTES {
        return Err(AppError::too_large("image", limits::MAX_IMAGE_FILE_BYTES));
    }
    let format = sniff(bytes).ok_or_else(|| AppError::invalid("image"))?;
    // The header is read by hand first: a picture over the limits is turned down before any decoder sees it.
    if let Some((width, height)) = header_dims(bytes, format) {
        check_dims(width, height)?;
    }
    let mut decode_limits = Limits::default();
    decode_limits.max_image_width = Some(limits::MAX_INSERT_IMAGE_SIDE_PX);
    decode_limits.max_image_height = Some(limits::MAX_INSERT_IMAGE_SIDE_PX);
    decode_limits.max_alloc = Some(limits::MAX_IMAGE_DECODE_ALLOC_BYTES);
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    reader.limits(decode_limits);
    let mut decoder = reader.into_decoder().map_err(decode_failed)?;
    let (width, height) = decoder.dimensions();
    check_dims(width, height)?;
    let orientation = decoder
        .orientation()
        .unwrap_or(image::metadata::Orientation::NoTransforms);
    let mut picture = DynamicImage::from_decoder(decoder).map_err(decode_failed)?;
    picture.apply_orientation(orientation);
    // One RGBA copy at most (a 40 MP picture is 160 MB): kept when something is see-through, dropped for RGB otherwise.
    let mut picture = if picture.color().has_alpha() {
        let rgba = picture.to_rgba8();
        if rgba.pixels().any(|p| p.0[3] != 255) {
            DynamicImage::ImageRgba8(rgba)
        } else {
            DynamicImage::ImageRgb8(DynamicImage::ImageRgba8(rgba).to_rgb8())
        }
    } else {
        DynamicImage::ImageRgb8(picture.to_rgb8())
    };
    let longest = picture.width().max(picture.height());
    if longest > limits::MAX_IMAGE_STORED_SIDE_PX {
        picture = fitted(
            &picture,
            limits::MAX_IMAGE_STORED_SIDE_PX as f32 / longest as f32,
        );
    }
    for _ in 0..=MAX_SHRINKS {
        let asset = encode(&picture)?;
        if asset.byte_size() as u64 <= limits::MAX_IMAGE_STORED_BYTES {
            return Ok(asset);
        }
        picture = fitted(&picture, SHRINK_FACTOR);
    }
    Err(AppError::limit("image", limits::MAX_IMAGE_STORED_BYTES))
}

#[allow(
    clippy::cast_precision_loss,
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss
)]
fn fitted(picture: &DynamicImage, factor: f32) -> DynamicImage {
    let side = |value: u32| ((value as f32 * factor).round() as u32).max(1);
    picture.resize_exact(
        side(picture.width()),
        side(picture.height()),
        FilterType::Triangle,
    )
}

fn deflate(data: &[u8]) -> Result<Vec<u8>, AppError> {
    use std::io::Write;
    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(data).map_err(internal)?;
    encoder.finish().map_err(internal)
}

fn encode(picture: &DynamicImage) -> Result<ImageAsset, AppError> {
    let (width, height) = (picture.width(), picture.height());
    let pixels = match picture {
        DynamicImage::ImageRgba8(rgba) => {
            let raw = rgba.as_raw();
            let mut rgb = Vec::with_capacity(raw.len() / 4 * 3);
            let mut alpha = Vec::with_capacity(raw.len() / 4);
            for pixel in raw.as_chunks::<4>().0 {
                rgb.extend_from_slice(&pixel[..3]);
                alpha.push(pixel[3]);
            }
            Pixels::Flate {
                rgb: deflate(&rgb)?,
                alpha: deflate(&alpha)?,
            }
        }
        other => {
            let rgb = other.to_rgb8();
            let mut out = Vec::new();
            JpegEncoder::new_with_quality(&mut out, JPEG_QUALITY)
                .encode(rgb.as_raw(), width, height, ExtendedColorType::Rgb8)
                .map_err(internal)?;
            Pixels::Jpeg(out)
        }
    };
    Ok(ImageAsset {
        width,
        height,
        pixels,
    })
}

fn inflate(data: &[u8], expected: usize) -> Result<Vec<u8>, AppError> {
    let mut out = Vec::with_capacity(expected);
    ZlibDecoder::new(data)
        .take(expected as u64 + 1)
        .read_to_end(&mut out)
        .map_err(internal)?;
    if out.len() != expected {
        return Err(internal("asset size"));
    }
    Ok(out)
}

/// The pixels of `asset` as RGBA8.
fn decode_asset(asset: &ImageAsset) -> Result<RgbaImage, AppError> {
    let (w, h) = (asset.width, asset.height);
    let count = w as usize * h as usize;
    match &asset.pixels {
        Pixels::Jpeg(bytes) => image::load_from_memory_with_format(bytes, ImageFormat::Jpeg)
            .map(|picture| picture.to_rgba8())
            .map_err(internal),
        Pixels::Flate { rgb, alpha } => {
            let rgb = inflate(rgb, count * 3)?;
            let alpha = inflate(alpha, count)?;
            let mut raw = Vec::with_capacity(count * 4);
            for (color, a) in rgb.as_chunks::<3>().0.iter().zip(alpha) {
                raw.extend_from_slice(color);
                raw.push(a);
            }
            RgbaImage::from_raw(w, h, raw).ok_or_else(|| internal("asset size"))
        }
    }
}

/// A frame for `get_asset_preview`: the SHR1 PNG of asset `id`, at most `max_px` on the long side.
pub fn preview(state: &DocState, id: AssetId, max_px: u16) -> Result<Vec<u8>, AppError> {
    let asset = state
        .assets()
        .image(id)
        .ok_or_else(|| AppError::not_found("asset"))?;
    asset_frame(asset, u32::from(max_px))
}

/// The SHR1 PNG frame of `asset`, at most `max_px` on the long side.
#[allow(clippy::cast_precision_loss)]
pub fn asset_frame(asset: &ImageAsset, max_px: u32) -> Result<Vec<u8>, AppError> {
    let mut picture = DynamicImage::ImageRgba8(decode_asset(asset)?);
    let longest = picture.width().max(picture.height());
    if longest > max_px {
        picture = fitted(&picture, max_px as f32 / longest as f32);
    }
    let rgba = picture.to_rgba8();
    let png = crate::signatures::raster::encode_png(&rgba)?;
    Ok(crate::signatures::preview_frame(
        rgba.width(),
        rgba.height(),
        &png,
    ))
}

/// Whether the asset of a new image exists and has this aspect (checked when the image annotation is created).
pub fn check_asset(state: &DocState, id: AssetId, aspect: f32) -> Result<(), AppError> {
    match state.assets().image(id) {
        Some(asset) if (asset.aspect() - aspect).abs() <= 0.01 * aspect.max(1.0) => Ok(()),
        _ => Err(AppError::invalid("asset")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgba;

    fn encoded(picture: &DynamicImage, format: ImageFormat) -> Vec<u8> {
        let mut out = Cursor::new(Vec::new());
        picture.write_to(&mut out, format).unwrap();
        out.into_inner()
    }

    #[test]
    fn opaque_png_becomes_a_jpeg() {
        let picture = DynamicImage::ImageRgb8(image::RgbImage::from_pixel(
            40,
            20,
            image::Rgb([200, 30, 30]),
        ));
        let asset = prepare_bytes(&encoded(&picture, ImageFormat::Png)).unwrap();
        assert!(matches!(asset.pixels, Pixels::Jpeg(ref b) if b.starts_with(&[0xFF, 0xD8])));
        assert_eq!((asset.width, asset.height), (40, 20));
        assert!((asset.aspect() - 2.0).abs() < 1e-6);
    }

    #[test]
    fn png_with_alpha_keeps_it_in_a_plane() {
        let picture = DynamicImage::ImageRgba8(RgbaImage::from_fn(8, 8, |x, _| {
            Rgba([10, 20, 30, if x < 4 { 0 } else { 255 }])
        }));
        let asset = prepare_bytes(&encoded(&picture, ImageFormat::Png)).unwrap();
        let Pixels::Flate { ref alpha, .. } = asset.pixels else {
            panic!("alpha expected");
        };
        let plane = inflate(alpha, 64).unwrap();
        assert_eq!(plane[0], 0);
        assert_eq!(plane[7], 255);
        let back = decode_asset(&asset).unwrap();
        assert_eq!(back.get_pixel(7, 0).0, [10, 20, 30, 255]);
    }

    #[test]
    fn a_png_whose_alpha_is_all_opaque_is_a_jpeg() {
        let picture = DynamicImage::ImageRgba8(RgbaImage::from_pixel(8, 8, Rgba([1, 2, 3, 255])));
        let asset = prepare_bytes(&encoded(&picture, ImageFormat::Png)).unwrap();
        assert!(matches!(asset.pixels, Pixels::Jpeg(_)));
    }

    #[test]
    fn large_pictures_are_brought_down() {
        let picture = DynamicImage::ImageRgb8(image::RgbImage::new(5000, 100));
        let asset = prepare_bytes(&encoded(&picture, ImageFormat::Png)).unwrap();
        assert_eq!(asset.width, 4096);
        assert_eq!(asset.height, 82);
    }

    #[test]
    fn unknown_formats_and_garbage_are_refused() {
        assert!(prepare_bytes(b"GIF89a....").is_err());
        assert!(prepare_bytes(b"\x89PNG\r\n\x1a\ntruncated").is_err());
        assert!(prepare_bytes(&[0xFF, 0xD8, 0xFF, 0x00]).is_err());
    }

    #[test]
    fn a_header_over_the_limit_is_refused_before_decoding() {
        // A PNG header (IHDR) of 9 000 x 100 and nothing after it: the dimension check fires, no pixels are allocated.
        let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
        png.extend_from_slice(&[0, 0, 0, 13]);
        png.extend_from_slice(b"IHDR");
        png.extend_from_slice(&9000u32.to_be_bytes());
        png.extend_from_slice(&100u32.to_be_bytes());
        png.extend_from_slice(&[8, 2, 0, 0, 0]);
        png.extend_from_slice(&[0, 0, 0, 0]);
        let error = prepare_bytes(&png).unwrap_err();
        assert_eq!(error.code(), ErrorCode::LimitExceeded);
    }
}
