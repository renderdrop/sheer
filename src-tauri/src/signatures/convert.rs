//! Art to and from the library's own type (`storage::signatures::Art`, ADR-041 §7): the library keeps vector art with whole-number
//! box sizes and raster art as base64 text. What comes back from the library is checked again (the file is the user's, and a copy of
//! the data folder is not trusted more than a PDF).

use super::{raster, vector, Art};
use crate::error::AppError;
use crate::model::annotation::{SignatureRole, SIGNATURE_ASPECT_RANGE};
use crate::model::geometry::Point;
use crate::storage::signatures::{Art as Stored, Role};

const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Standard base64 with padding.
pub fn encode_base64(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let (a, b, c) = (
            chunk[0],
            chunk.get(1).copied().unwrap_or(0),
            chunk.get(2).copied().unwrap_or(0),
        );
        let group = (u32::from(a) << 16) | (u32::from(b) << 8) | u32::from(c);
        for (index, shift) in [18, 12, 6, 0].into_iter().enumerate() {
            if index <= chunk.len() {
                out.push(char::from(ALPHABET[(group >> shift) as usize & 63]));
            } else {
                out.push('=');
            }
        }
    }
    out
}

fn sextet(byte: u8) -> Option<u32> {
    ALPHABET
        .iter()
        .position(|candidate| *candidate == byte)
        .map(|index| index as u32)
}

/// Decodes standard base64 with padding; `None` for anything else.
pub fn decode_base64(text: &str) -> Option<Vec<u8>> {
    let bytes = text.as_bytes();
    if bytes.is_empty() || !bytes.len().is_multiple_of(4) {
        return None;
    }
    let mut out = Vec::with_capacity(bytes.len() / 4 * 3);
    let last = bytes.len() / 4 - 1;
    for (index, quad) in bytes.chunks(4).enumerate() {
        let pad = quad.iter().rev().take_while(|b| **b == b'=').count();
        if pad > 2 || (pad > 0 && index != last) {
            return None;
        }
        let mut group = 0u32;
        for byte in &quad[..4 - pad] {
            group = (group << 6) | sextet(*byte)?;
        }
        group <<= 6 * pad as u32;
        let triple = [(group >> 16) as u8, (group >> 8) as u8, group as u8];
        out.extend_from_slice(&triple[..3 - pad]);
    }
    Some(out)
}

pub fn role_to_stored(role: SignatureRole) -> Role {
    match role {
        SignatureRole::Signature => Role::Signature,
        SignatureRole::Initials => Role::Initials,
    }
}

pub fn role_from_stored(role: Role) -> SignatureRole {
    match role {
        Role::Signature => SignatureRole::Signature,
        Role::Initials => SignatureRole::Initials,
    }
}

/// The art as the library stores it. The width of vector art is rounded up so that the polygons stay inside the box.
#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
pub fn to_stored(art: &Art) -> Stored {
    match art {
        Art::Vector { w, h, paths } => Stored::Vector {
            w: w.ceil() as u32,
            h: h.ceil() as u32,
            paths: paths
                .iter()
                .map(|path| path.iter().map(|p| [p.x, p.y]).collect())
                .collect(),
        },
        Art::Raster { w, h, png } => Stored::Raster {
            w: *w,
            h: *h,
            png: encode_base64(png),
        },
    }
}

/// The art a stored entry holds, checked. `invalid_argument` (`art`) if it is not what the library writes.
#[allow(clippy::cast_precision_loss)]
pub fn from_stored(stored: &Stored) -> Result<Art, AppError> {
    let bad = || AppError::invalid("art");
    match stored {
        Stored::Vector { w, h, paths } => {
            let (w, h) = (*w as f32, *h as f32);
            let total: usize = paths.iter().map(Vec::len).sum();
            if w < 1.0
                || h < 1.0
                || !SIGNATURE_ASPECT_RANGE.contains(&(w / h))
                || paths.is_empty()
                || paths.len() > vector::MAX_POLYGONS
                || total > vector::MAX_POINTS_TOTAL
                || paths.iter().any(|path| {
                    path.len() < 3
                        || path.iter().any(|[x, y]| {
                            !x.is_finite()
                                || !y.is_finite()
                                || *x < -w
                                || *x > 2.0 * w
                                || *y < -h
                                || *y > 2.0 * h
                        })
                })
            {
                return Err(bad());
            }
            Ok(Art::Vector {
                w,
                h,
                paths: paths
                    .iter()
                    .map(|path| path.iter().map(|[x, y]| Point { x: *x, y: *y }).collect())
                    .collect(),
            })
        }
        Stored::Raster { png, .. } => {
            let bytes = decode_base64(png).ok_or_else(bad)?;
            if bytes.len() > raster::MAX_ART_BYTES {
                return Err(bad());
            }
            // The size is the picture's own, not what the entry says.
            let picture = raster::decode_art(&bytes).map_err(|_| bad())?;
            Ok(Art::Raster {
                w: picture.width(),
                h: picture.height(),
                png: bytes,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_matches_the_standard() {
        for (plain, coded) in [
            (&b""[..], ""),
            (b"f", "Zg=="),
            (b"fo", "Zm8="),
            (b"foo", "Zm9v"),
            (b"foob", "Zm9vYg=="),
            (b"fooba", "Zm9vYmE="),
            (b"foobar", "Zm9vYmFy"),
        ] {
            assert_eq!(encode_base64(plain), coded);
            if !plain.is_empty() {
                assert_eq!(decode_base64(coded).as_deref(), Some(plain));
            }
        }
        for bad in ["", "abc", "ab=d", "a===", "Zm9v!A==", "Zg==Zg=="] {
            assert_eq!(decode_base64(bad), None, "{bad}");
        }
    }

    #[test]
    fn art_goes_to_the_library_and_back() {
        let vector = Art::Vector {
            w: 2000.4,
            h: 1000.0,
            paths: vec![vec![
                Point { x: 0.0, y: 0.0 },
                Point { x: 2000.0, y: 10.0 },
                Point { x: 50.0, y: 1000.0 },
            ]],
        };
        let Art::Vector { w, h, paths } = from_stored(&to_stored(&vector)).unwrap() else {
            panic!("not vector")
        };
        assert_eq!((w, h), (2001.0, 1000.0));
        assert_eq!(paths[0].len(), 3);

        let picture = image::RgbaImage::from_pixel(5, 3, image::Rgba([1, 2, 3, 255]));
        let png = raster::encode_png(&picture).unwrap();
        let raster = Art::Raster {
            w: 5,
            h: 3,
            png: png.clone(),
        };
        let Art::Raster { w, h, png: back } = from_stored(&to_stored(&raster)).unwrap() else {
            panic!("not raster")
        };
        assert_eq!((w, h), (5, 3));
        assert_eq!(back, png);
    }

    #[test]
    fn stored_art_that_is_not_ours_is_refused() {
        let bad_vector = Stored::Vector {
            w: 10,
            h: 10,
            paths: vec![vec![[0.0, 0.0], [f32::NAN, 1.0], [1.0, 1.0]]],
        };
        assert!(from_stored(&bad_vector).is_err());
        let not_png = Stored::Raster {
            w: 1,
            h: 1,
            png: encode_base64(b"not a png"),
        };
        assert!(from_stored(&not_png).is_err());
    }
}
