//! PNG encoding of a rendered page. Pure Rust (`png` crate), no PDFium types, so it is unit-tested directly.

use std::io::Write;

use crate::error::{AppError, ErrorCode};

/// Encodes 8-bit RGB rows as a PNG.
///
/// `stride` is the byte distance between rows (PDFium pads rows to 4 bytes). Rows are streamed to the encoder one by
/// one, so no second full-size copy of the image is made.
pub fn encode_rgb(
    width: u32,
    height: u32,
    stride: usize,
    data: &[u8],
) -> Result<Vec<u8>, AppError> {
    let row_len = (width as usize)
        .checked_mul(3)
        .ok_or(AppError::new(ErrorCode::Internal))?;
    let needed = stride
        .checked_mul(height as usize)
        .ok_or(AppError::new(ErrorCode::Internal))?;
    if width == 0 || height == 0 || stride < row_len || data.len() < needed {
        return Err(AppError::logged(
            ErrorCode::Internal,
            format!(
                "bitmap layout mismatch: {width}x{height}, stride {stride}, {} bytes",
                data.len()
            ),
        ));
    }

    let fail = |error: png::EncodingError| AppError::logged(ErrorCode::Internal, error);
    let mut out = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut out, width, height);
        encoder.set_color(png::ColorType::Rgb);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.set_compression(png::Compression::Fast);
        let mut writer = encoder.write_header().map_err(fail)?;
        {
            let mut stream = writer.stream_writer().map_err(fail)?;
            for row in data.chunks(stride).take(height as usize) {
                stream
                    .write_all(&row[..row_len])
                    .map_err(|error| AppError::logged(ErrorCode::Internal, error))?;
            }
            stream.finish().map_err(fail)?;
        }
        writer.finish().map_err(fail)?;
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decode(bytes: &[u8]) -> (png::OutputInfo, Vec<u8>) {
        let decoder = png::Decoder::new(std::io::Cursor::new(bytes));
        let mut reader = decoder.read_info().unwrap();
        let mut buffer = vec![0; reader.output_buffer_size().unwrap()];
        let info = reader.next_frame(&mut buffer).unwrap();
        (info, buffer)
    }

    #[test]
    fn round_trips_pixels_and_drops_row_padding() {
        // 2x2 image, stride 8 (6 bytes of pixels + 2 bytes of padding per row).
        #[rustfmt::skip]
        let data = [
            255, 0, 0,   0, 255, 0,   9, 9,
            0, 0, 255,   10, 20, 30,  9, 9,
        ];
        let png = encode_rgb(2, 2, 8, &data).unwrap();
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
        let (info, pixels) = decode(&png);
        assert_eq!((info.width, info.height), (2, 2));
        assert_eq!(info.color_type, png::ColorType::Rgb);
        assert_eq!(
            &pixels[..12],
            &[255, 0, 0, 0, 255, 0, 0, 0, 255, 10, 20, 30]
        );
    }

    #[test]
    fn rejects_inconsistent_layouts() {
        let data = [0u8; 12];
        for (w, h, stride) in [(0, 2, 6), (2, 0, 6), (2, 2, 5), (2, 3, 6)] {
            assert_eq!(
                encode_rgb(w, h, stride, &data).unwrap_err().code(),
                ErrorCode::Internal,
                "{w}x{h} stride {stride}"
            );
        }
    }
}
