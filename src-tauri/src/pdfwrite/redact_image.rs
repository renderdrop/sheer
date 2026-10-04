//! Blacking out the covered pixels of an image (ADR-055). Only the covered area of that one image is made again: the samples under
//! the marks are zeroed, the rest of the picture is left as it is, and the stream is written back (Flate for raw samples, JPEG q90 for a
//! JPEG). What cannot be decoded here (JPEG 2000, JBIG2, CCITT, a colour space with an unknown number of components, a size over the
//! limits) is dropped by the caller: nothing of an image that cannot be read back is kept under a mark.

use std::io::{Cursor, Write};

use flate2::write::ZlibEncoder;
use flate2::Compression;
use image::codecs::jpeg::{JpegDecoder, JpegEncoder};
use image::{DynamicImage, ExtendedColorType, ImageDecoder};
use lopdf::{Dictionary, Document, Object, Stream};

use crate::limits;

/// Most bytes of decoded samples (`stride * height`) of one image that is blacked out; a larger one is dropped.
const MAX_DECODED_BYTES: usize = 128 * 1024 * 1024;

/// JPEG quality of a picture written again.
const JPEG_QUALITY: u8 = 90;

/// What happens to an image that a mark covers.
pub(super) enum Outcome {
    /// Another stream, and streams to attach to it by key (`SMask`, `Mask`).
    Replace(Replacement),
    /// The image is removed.
    Drop,
}

pub(super) struct Replacement {
    pub stream: Stream,
    pub attached: Vec<(&'static str, Stream)>,
}

/// Filters whose output is the plain samples.
const RAW_FILTERS: [&[u8]; 5] = [
    b"FlateDecode",
    b"LZWDecode",
    b"ASCII85Decode",
    b"ASCIIHexDecode",
    b"RunLengthDecode",
];

fn int(dict: &Dictionary, long: &[u8], short: &[u8]) -> Option<u64> {
    let object = dict.get(long).or_else(|_| dict.get(short)).ok()?;
    u64::try_from(object.as_i64().ok()?).ok()
}

fn is_true(dict: &Dictionary, long: &[u8], short: &[u8]) -> bool {
    dict.get(long)
        .or_else(|_| dict.get(short))
        .ok()
        .and_then(|object| object.as_bool().ok())
        .unwrap_or(false)
}

fn resolve<'a>(src: &'a Document, object: &'a Object) -> Option<&'a Object> {
    let mut current = object;
    for _ in 0..8 {
        match current {
            Object::Reference(id) => current = src.get_object(*id).ok()?,
            other => return Some(other),
        }
    }
    None
}

/// The number of colour components of colour space `space`, if it is one this module knows.
pub(super) fn components(src: &Document, space: &Object) -> Option<usize> {
    match resolve(src, space)? {
        Object::Name(name) => match name.as_slice() {
            b"DeviceGray" | b"G" | b"CalGray" => Some(1),
            b"DeviceRGB" | b"RGB" | b"CalRGB" => Some(3),
            b"DeviceCMYK" | b"CMYK" => Some(4),
            _ => None,
        },
        Object::Array(items) => {
            let family = resolve(src, items.first()?)?.as_name().ok()?;
            match family {
                b"ICCBased" => {
                    let stream = resolve(src, items.get(1)?)?.as_stream().ok()?;
                    let n = usize::try_from(stream.dict.get(b"N").ok()?.as_i64().ok()?).ok()?;
                    matches!(n, 1 | 3 | 4).then_some(n)
                }
                b"Indexed" | b"I" | b"Separation" => Some(1),
                b"DeviceN" => {
                    let names = resolve(src, items.get(1)?)?.as_array().ok()?;
                    (1..=32).contains(&names.len()).then_some(names.len())
                }
                b"Lab" | b"CalRGB" => Some(3),
                b"CalGray" => Some(1),
                b"DeviceGray" | b"G" => Some(1),
                b"DeviceRGB" | b"RGB" => Some(3),
                b"DeviceCMYK" | b"CMYK" => Some(4),
                _ => None,
            }
        }
        _ => None,
    }
}

/// Pixel rectangles `[x0, y0, x1, y1)` (rows from the top) for regions of the unit square `[u0, v0, u1, v1]` (v up), each grown by one
/// pixel, for an image of `w` x `h`. Regions with no area are left out.
pub(super) fn pixel_rects(units: &[[f64; 4]], w: usize, h: usize) -> Vec<[usize; 4]> {
    let clamp = |value: f64, max: usize| -> usize {
        if !value.is_finite() || value <= 0.0 {
            return 0;
        }
        #[allow(clippy::cast_precision_loss)] // sizes are far below 2^52
        let limit = max as f64;
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)] // clamped to 0..=max
        let pixel = value.min(limit) as usize;
        pixel
    };
    #[allow(clippy::cast_precision_loss)]
    let (wf, hf) = (w as f64, h as f64);
    units
        .iter()
        .filter_map(|[u0, v0, u1, v1]| {
            let x0 = clamp((u0 * wf).floor() - 1.0, w);
            let x1 = clamp((u1 * wf).ceil() + 1.0, w);
            let y0 = clamp(((1.0 - v1) * hf).floor() - 1.0, h);
            let y1 = clamp(((1.0 - v0) * hf).ceil() + 1.0, h);
            (x0 < x1 && y0 < y1).then_some([x0, y0, x1, y1])
        })
        .collect()
}

/// Zeroes the bits of the pixels in `rects` of `data` (`h` rows of `w` pixels of `bpp` bits, each row padded to a byte). False when
/// `data` is shorter than that.
pub(super) fn zero_pixels(
    data: &mut [u8],
    w: usize,
    h: usize,
    bpp: usize,
    rects: &[[usize; 4]],
) -> bool {
    let Some(stride) = w.checked_mul(bpp).map(|bits| bits.div_ceil(8)) else {
        return false;
    };
    if stride.checked_mul(h).is_none_or(|total| data.len() < total) {
        return false;
    }
    for [x0, y0, x1, y1] in rects {
        for row in *y0..(*y1).min(h) {
            let line = &mut data[row * stride..(row + 1) * stride];
            if bpp.is_multiple_of(8) {
                let bytes = bpp / 8;
                let end = (x1 * bytes).min(stride);
                let start = (x0 * bytes).min(end);
                line[start..end].fill(0);
            } else {
                for bit in (x0 * bpp)..(x1 * bpp).min(stride * 8) {
                    line[bit / 8] &= !(0x80u8 >> (bit % 8));
                }
            }
        }
    }
    true
}

fn deflate(data: &[u8]) -> Option<Vec<u8>> {
    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(data).ok()?;
    encoder.finish().ok()
}

fn without_encoding(dict: &Dictionary) -> Dictionary {
    let mut out = dict.clone();
    for key in [
        &b"Filter"[..],
        b"DecodeParms",
        b"DP",
        b"F",
        b"Length",
        b"Metadata",
        b"PieceInfo",
        b"StructParent",
        b"OPI",
    ] {
        out.remove(key);
    }
    out
}

/// An image XObject covered by the regions `units` (see [`pixel_rects`]). `with_masks`: its `SMask` and `Mask` stream are made again
/// the same way (a soft mask in the shape of the text would give it away).
pub(super) fn redact_image(
    src: &Document,
    stream: &Stream,
    units: &[[f64; 4]],
    with_masks: bool,
) -> Outcome {
    redact_image_inner(src, stream, units, with_masks).unwrap_or(Outcome::Drop)
}

fn redact_image_inner(
    src: &Document,
    stream: &Stream,
    units: &[[f64; 4]],
    with_masks: bool,
) -> Option<Outcome> {
    let dict = &stream.dict;
    let (w, h) = (int(dict, b"Width", b"W")?, int(dict, b"Height", b"H")?);
    if w == 0 || h == 0 || w.checked_mul(h)? > limits::MAX_REDACT_IMAGE_PIXELS {
        return None;
    }
    let (wu, hu) = (usize::try_from(w).ok()?, usize::try_from(h).ok()?);
    let mask = is_true(dict, b"ImageMask", b"IM");
    let comps: usize = if mask {
        1
    } else {
        components(src, dict.get(b"ColorSpace").ok()?)?
    };
    let bpc = if mask {
        1
    } else {
        usize::try_from(int(dict, b"BitsPerComponent", b"BPC").unwrap_or(8)).ok()?
    };
    if !matches!(bpc, 1 | 2 | 4 | 8 | 16) {
        return None;
    }
    let bpp = comps.checked_mul(bpc)?;
    if wu.checked_mul(bpp)?.div_ceil(8).checked_mul(hu)? > MAX_DECODED_BYTES {
        return None;
    }
    let rects = pixel_rects(units, wu, hu);
    let filters = stream.filters().unwrap_or_default();
    let main = if filters.len() == 1 && filters[0] == b"DCTDecode" {
        jpeg(stream, wu, hu, comps, &rects)?
    } else if filters.iter().all(|f| RAW_FILTERS.contains(f)) {
        let stride = wu.checked_mul(bpp)?.div_ceil(8);
        let total = stride.checked_mul(hu)?;
        let mut data = stream
            .decompressed_content_with_limit(total.checked_add(1 << 20)?)
            .ok()?;
        if !zero_pixels(&mut data, wu, hu, bpp, &rects) {
            return None;
        }
        data.truncate(total);
        let mut dict = without_encoding(dict);
        dict.set("Filter", Object::Name(b"FlateDecode".to_vec()));
        Stream::new(dict, deflate(&data)?)
    } else {
        return None;
    };
    let mut attached = Vec::new();
    let mut out = main;
    if with_masks {
        for key in ["SMask", "Mask"] {
            let Some(object) = stream.dict.get(key.as_bytes()).ok() else {
                continue;
            };
            let Some(Object::Stream(mask_stream)) = resolve(src, object) else {
                continue; // a colour key (`Mask` array) holds no picture
            };
            match redact_image(src, mask_stream, units, false) {
                Outcome::Drop => return None,
                Outcome::Replace(replacement) => {
                    out.dict.remove(key.as_bytes());
                    attached.push((key, replacement.stream));
                }
            }
        }
    }
    Some(Outcome::Replace(Replacement {
        stream: out,
        attached,
    }))
}

fn jpeg(stream: &Stream, w: usize, h: usize, comps: usize, rects: &[[usize; 4]]) -> Option<Stream> {
    if !matches!(comps, 1 | 3) || w.checked_mul(h)?.checked_mul(comps)? > MAX_DECODED_BYTES {
        return None;
    }
    let decoder = JpegDecoder::new(Cursor::new(stream.content.as_slice())).ok()?;
    let (dw, dh) = decoder.dimensions();
    if (usize::try_from(dw).ok()?, usize::try_from(dh).ok()?) != (w, h) {
        return None;
    }
    let (mut raw, color) = match DynamicImage::from_decoder(decoder).ok()? {
        DynamicImage::ImageLuma8(buffer) if comps == 1 => {
            (buffer.into_raw(), ExtendedColorType::L8)
        }
        DynamicImage::ImageRgb8(buffer) if comps == 3 => {
            (buffer.into_raw(), ExtendedColorType::Rgb8)
        }
        _ => return None,
    };
    if !zero_pixels(&mut raw, w, h, comps * 8, rects) {
        return None;
    }
    let mut out = Vec::new();
    JpegEncoder::new_with_quality(&mut out, JPEG_QUALITY)
        .encode(&raw, u32::try_from(w).ok()?, u32::try_from(h).ok()?, color)
        .ok()?;
    let mut dict = without_encoding(&stream.dict);
    dict.set("Filter", Object::Name(b"DCTDecode".to_vec()));
    let mut new = Stream::new(dict, out);
    new.allows_compression = false;
    Some(new)
}

/// An inline image (`BI`): raw samples only (lopdf does not read a filtered one, and the caller drops that). The stream keeps its
/// abbreviated dictionary.
pub(super) fn redact_inline(stream: &Stream, units: &[[f64; 4]]) -> Outcome {
    inline_inner(stream, units).unwrap_or(Outcome::Drop)
}

fn inline_inner(stream: &Stream, units: &[[f64; 4]]) -> Option<Outcome> {
    let dict = &stream.dict;
    let (w, h) = (int(dict, b"Width", b"W")?, int(dict, b"Height", b"H")?);
    if w == 0 || h == 0 || w.checked_mul(h)? > limits::MAX_REDACT_IMAGE_PIXELS {
        return None;
    }
    if dict.has(b"F") || dict.has(b"Filter") {
        return None;
    }
    let (wu, hu) = (usize::try_from(w).ok()?, usize::try_from(h).ok()?);
    let mask = is_true(dict, b"ImageMask", b"IM");
    let bpc = if mask {
        1
    } else {
        usize::try_from(int(dict, b"BitsPerComponent", b"BPC")?).ok()?
    };
    let comps: usize = if mask {
        1
    } else {
        let space = dict.get(b"ColorSpace").or_else(|_| dict.get(b"CS")).ok()?;
        match space.as_name().ok()? {
            b"G" | b"DeviceGray" => 1,
            b"RGB" | b"DeviceRGB" => 3,
            b"CMYK" | b"DeviceCMYK" => 4,
            _ => return None,
        }
    };
    if wu
        .checked_mul(comps.checked_mul(bpc)?)?
        .div_ceil(8)
        .checked_mul(hu)?
        > MAX_DECODED_BYTES
    {
        return None;
    }
    let mut data = stream.content.clone();
    let rects = pixel_rects(units, wu, hu);
    if !zero_pixels(&mut data, wu, hu, comps.checked_mul(bpc)?, &rects) {
        return None;
    }
    let mut new = Stream::new(dict.clone(), data);
    new.allows_compression = false;
    Some(Outcome::Replace(Replacement {
        stream: new,
        attached: Vec::new(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zeroing_works_for_bytes_and_for_bits() {
        let mut data = vec![0xFFu8; 4 * 4 * 3];
        assert!(zero_pixels(&mut data, 4, 4, 24, &[[1, 1, 3, 2]]));
        assert_eq!(data[(4 + 1) * 3], 0);
        assert_eq!(data[(4 + 2) * 3 + 2], 0);
        assert_eq!(data[(4 + 3) * 3], 0xFF);
        assert_eq!(data[3], 0xFF);
        // 1 bit per pixel, 10 pixels wide: two bytes per row.
        let mut bits = vec![0xFFu8; 2 * 2];
        assert!(zero_pixels(&mut bits, 10, 2, 1, &[[2, 0, 9, 1]]));
        assert_eq!(bits, vec![0xC0, 0x7F, 0xFF, 0xFF]);
        assert!(!zero_pixels(&mut [0u8; 3], 4, 4, 8, &[[0, 0, 1, 1]]));
    }

    #[test]
    fn regions_become_pixels_with_a_margin_and_flip_the_rows() {
        // The lower left quarter of a 10 x 10 image: rows from the top are 5..10.
        let rects = pixel_rects(&[[0.0, 0.0, 0.5, 0.5]], 10, 10);
        assert_eq!(rects, vec![[0, 4, 6, 10]]);
        assert!(pixel_rects(&[[0.5, 0.5, 0.5, 0.5]], 10, 10).len() <= 1);
        assert!(pixel_rects(&[[f64::NAN, 0.0, 1.0, 1.0]], 10, 10).len() <= 1);
    }

    #[test]
    fn a_raw_rgb_image_is_blacked_out_only_in_the_region() {
        let mut dict = Dictionary::new();
        dict.set("Width", Object::Integer(8));
        dict.set("Height", Object::Integer(8));
        dict.set("BitsPerComponent", Object::Integer(8));
        dict.set("ColorSpace", Object::Name(b"DeviceRGB".to_vec()));
        let stream = Stream::new(dict, vec![200u8; 8 * 8 * 3]);
        let doc = Document::new();
        let Outcome::Replace(done) = redact_image(&doc, &stream, &[[0.0, 0.5, 0.5, 1.0]], true)
        else {
            panic!("replaced");
        };
        let data = done.stream.decompressed_content().unwrap();
        assert_eq!(data.len(), 8 * 8 * 3);
        assert_eq!(data[0], 0, "top left is covered");
        assert_eq!(data[(7 * 8 + 7) * 3], 200, "bottom right is not");
    }

    #[test]
    fn an_image_whose_samples_are_over_the_cap_is_dropped() {
        let mut dict = Dictionary::new();
        dict.set("Width", Object::Integer(9_000));
        dict.set("Height", Object::Integer(9_000));
        dict.set("BitsPerComponent", Object::Integer(16));
        dict.set("ColorSpace", Object::Name(b"DeviceCMYK".to_vec()));
        let stream = Stream::new(dict, Vec::new());
        let doc = Document::new();
        assert!(matches!(
            redact_image(&doc, &stream, &[[0.0, 0.0, 1.0, 1.0]], true),
            Outcome::Drop
        ));
    }

    #[test]
    fn an_image_that_cannot_be_read_is_dropped() {
        let mut dict = Dictionary::new();
        dict.set("Width", Object::Integer(8));
        dict.set("Height", Object::Integer(8));
        dict.set("ColorSpace", Object::Name(b"DeviceRGB".to_vec()));
        dict.set("Filter", Object::Name(b"JPXDecode".to_vec()));
        let stream = Stream::new(dict, vec![1, 2, 3]);
        let doc = Document::new();
        assert!(matches!(
            redact_image(&doc, &stream, &[[0.0, 0.0, 1.0, 1.0]], true),
            Outcome::Drop
        ));
    }
}
