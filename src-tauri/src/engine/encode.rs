//! Render frames: the binary format `render_page` returns (ADR-002 §6). Pure Rust (`png` crate), no PDFium types, so
//! it is unit-tested directly.
//!
//! Layout, all integers little-endian:
//!
//! | Offset | Size | Field |
//! |---|---|---|
//! | 0 | 4 | magic `"SHR1"` |
//! | 4 | 1 | format: `1` = PNG, 8-bit RGB (the only one produced); `2` = raw RGBA8 is reserved for the spike gate |
//! | 5 | 3 | reserved, zero |
//! | 8 | 4 | `u32` width in pixels |
//! | 12 | 4 | `u32` height in pixels |
//! | 16 | n | payload |
//!
//! The frontend mirrors this in `src/api/frame.ts`.

use std::io::Write;

use crate::error::{AppError, ErrorCode};

/// First four bytes of every frame.
pub const FRAME_MAGIC: [u8; 4] = *b"SHR1";
/// Frame format byte for a PNG payload (8-bit RGB).
pub const FORMAT_PNG_RGB: u8 = 1;
/// Size of the frame header in bytes.
pub const FRAME_HEADER_BYTES: usize = 16;

fn frame_header(width: u32, height: u32) -> Vec<u8> {
    let mut header = Vec::with_capacity(FRAME_HEADER_BYTES);
    header.extend_from_slice(&FRAME_MAGIC);
    header.push(FORMAT_PNG_RGB);
    header.extend_from_slice(&[0, 0, 0]);
    header.extend_from_slice(&width.to_le_bytes());
    header.extend_from_slice(&height.to_le_bytes());
    header
}

/// Encodes 8-bit RGB rows as a frame (header + PNG).
///
/// `stride` is the byte distance between rows (PDFium pads rows to 4 bytes). Rows are streamed to the encoder one by
/// one, and the PNG is appended to the header in a single buffer, so no second full-size copy of the image is made.
pub fn encode_frame(
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
    let mut out = frame_header(width, height);
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

/// Splits a frame into `(width, height, png_payload)`. Test helper; the frontend has its own parser.
#[cfg(test)]
pub(crate) fn split_frame(frame: &[u8]) -> (u32, u32, &[u8]) {
    assert!(frame.len() > FRAME_HEADER_BYTES, "frame too short");
    assert_eq!(&frame[..4], &FRAME_MAGIC);
    assert_eq!(frame[4], FORMAT_PNG_RGB);
    assert_eq!(&frame[5..8], &[0, 0, 0]);
    let word =
        |at: usize| u32::from_le_bytes([frame[at], frame[at + 1], frame[at + 2], frame[at + 3]]);
    (word(8), word(12), &frame[FRAME_HEADER_BYTES..])
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
        let frame = encode_frame(2, 2, 8, &data).unwrap();
        let (width, height, png) = split_frame(&frame);
        assert_eq!((width, height), (2, 2));
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
        let (info, pixels) = decode(png);
        assert_eq!((info.width, info.height), (2, 2));
        assert_eq!(info.color_type, png::ColorType::Rgb);
        assert_eq!(
            &pixels[..12],
            &[255, 0, 0, 0, 255, 0, 0, 0, 255, 10, 20, 30]
        );
    }

    #[test]
    fn header_layout_matches_adr_002() {
        let data = vec![0u8; 300 * 3 * 2];
        let frame = encode_frame(300, 2, 300 * 3, &data).unwrap();
        // "SHR1", format 1, three reserved zero bytes, width 300 = 0x012C and height 2, both little-endian.
        assert_eq!(
            &frame[..FRAME_HEADER_BYTES],
            &[b'S', b'H', b'R', b'1', 1, 0, 0, 0, 0x2C, 0x01, 0, 0, 2, 0, 0, 0]
        );
    }

    #[test]
    fn rejects_inconsistent_layouts() {
        let data = [0u8; 12];
        for (w, h, stride) in [(0, 2, 6), (2, 0, 6), (2, 2, 5), (2, 3, 6)] {
            assert_eq!(
                encode_frame(w, h, stride, &data).unwrap_err().code(),
                ErrorCode::Internal,
                "{w}x{h} stride {stride}"
            );
        }
    }
}
