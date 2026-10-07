//! The OCR pipe (ADR-134 item 2): a `u32` little-endian header length, the JSON header, then (requests only) a raw gray8 blob of
//! `w * h` bytes. Both directions are bounds-checked before anything is allocated; replies are untrusted and sanitized.

use std::io::{Read, Write};

use serde::{Deserialize, Serialize};

use super::limits;
use super::{OcrLine, OcrPageLayer, OcrWord};

/// What can be wrong with a message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WireError {
    /// The pipe ended in the middle of a message.
    Truncated,
    /// The header length is zero or above the bound.
    HeaderLength(u32),
    /// The header is not the JSON of the expected shape.
    Header,
    /// A field is outside its bound or not allowed.
    Invalid(&'static str),
    Io(String),
}

impl std::fmt::Display for WireError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            WireError::Truncated => write!(f, "truncated message"),
            WireError::HeaderLength(n) => write!(f, "header length {n} out of bounds"),
            WireError::Header => write!(f, "malformed header"),
            WireError::Invalid(what) => write!(f, "invalid {what}"),
            WireError::Io(e) => write!(f, "io: {e}"),
        }
    }
}

impl std::error::Error for WireError {}

impl From<std::io::Error> for WireError {
    fn from(error: std::io::Error) -> Self {
        if error.kind() == std::io::ErrorKind::UnexpectedEof {
            WireError::Truncated
        } else {
            WireError::Io(error.kind().to_string())
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OcrRequest {
    pub v: u32,
    pub id: u64,
    pub w: u32,
    pub h: u32,
    pub stride: u32,
    pub format: String,
    pub lang: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RawWord {
    pub t: String,
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct RawLine {
    pub words: Vec<RawWord>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct OcrReply {
    pub id: u64,
    pub ok: bool,
    #[serde(default)]
    pub angle: f32,
    #[serde(default)]
    pub lines: Vec<RawLine>,
    /// A short code for a failure (never text of the page).
    #[serde(default)]
    pub error: Option<String>,
}

/// Writes `header` as JSON with its length in front, then `blob`.
pub fn write_message(
    out: &mut impl Write,
    header: &impl Serialize,
    blob: &[u8],
) -> Result<(), WireError> {
    let json = serde_json::to_vec(header).map_err(|_| WireError::Header)?;
    let len = u32::try_from(json.len()).map_err(|_| WireError::Invalid("header size"))?;
    out.write_all(&len.to_le_bytes())?;
    out.write_all(&json)?;
    out.write_all(blob)?;
    out.flush()?;
    Ok(())
}

/// Reads one length-prefixed header of at most `cap` bytes. `Ok(None)` when the pipe ends cleanly before the first byte.
pub fn read_header(input: &mut impl Read, cap: usize) -> Result<Option<Vec<u8>>, WireError> {
    let mut len = [0u8; 4];
    let mut got = 0;
    while got < 4 {
        let n = input.read(&mut len[got..])?;
        if n == 0 {
            return if got == 0 {
                Ok(None)
            } else {
                Err(WireError::Truncated)
            };
        }
        got += n;
    }
    let len = u32::from_le_bytes(len);
    if len == 0 || len as usize > cap {
        return Err(WireError::HeaderLength(len));
    }
    // The length is within `cap`, so this allocation is bounded.
    let mut json = vec![0u8; len as usize];
    input.read_exact(&mut json)?;
    Ok(Some(json))
}

/// Checks the fields of a request against the bounds; the number of blob bytes that follow it is returned.
pub fn validate_request(request: &OcrRequest) -> Result<usize, WireError> {
    if request.v != 1 {
        return Err(WireError::Invalid("version"));
    }
    if request.format != "gray8" {
        return Err(WireError::Invalid("format"));
    }
    let side = limits::MAX_SIDE_PX;
    if request.w == 0 || request.h == 0 || request.w > side || request.h > side {
        return Err(WireError::Invalid("size"));
    }
    if u64::from(request.w) * u64::from(request.h) > limits::MAX_PIXELS {
        return Err(WireError::Invalid("pixels"));
    }
    if request.stride != request.w {
        return Err(WireError::Invalid("stride"));
    }
    if request.lang.is_empty()
        || request.lang.len() > 2
        || request
            .lang
            .iter()
            .any(|tag| !limits::LANGUAGES.contains(&tag.as_str()))
    {
        return Err(WireError::Invalid("language"));
    }
    Ok(request.w as usize * request.h as usize)
}

/// Reads a request and its bitmap. `Ok(None)` at a clean end of the pipe.
pub fn read_request(input: &mut impl Read) -> Result<Option<(OcrRequest, Vec<u8>)>, WireError> {
    let Some(json) = read_header(input, limits::MAX_REQUEST_HEADER)? else {
        return Ok(None);
    };
    let request: OcrRequest = serde_json::from_slice(&json).map_err(|_| WireError::Header)?;
    let n = validate_request(&request)?;
    let mut blob = vec![0u8; n];
    input.read_exact(&mut blob)?;
    Ok(Some((request, blob)))
}

/// Reads a reply (header only).
pub fn read_reply(input: &mut impl Read) -> Result<OcrReply, WireError> {
    let json = read_header(input, limits::MAX_REPLY)?.ok_or(WireError::Truncated)?;
    serde_json::from_slice(&json).map_err(|_| WireError::Header)
}

/// Turns an untrusted reply for a `w` x `h` bitmap into a page layer in pixels (the caller scales to points): at most
/// `MAX_WORDS` words, `MAX_WORD_CHARS` characters each, controls stripped, boxes clamped to the image, non-finite numbers refused,
/// words that are empty after cleaning dropped.
pub fn sanitize(reply: &OcrReply, w: u32, h: u32) -> Result<OcrPageLayer, WireError> {
    if !reply.ok {
        return Err(WireError::Invalid("reply: not ok"));
    }
    let words: usize = reply.lines.iter().map(|l| l.words.len()).sum();
    if words > limits::MAX_WORDS {
        return Err(WireError::Invalid("word count"));
    }
    if !reply.angle.is_finite() {
        return Err(WireError::Invalid("angle"));
    }
    let (wf, hf) = (w as f32, h as f32);
    let mut lines = Vec::new();
    for raw in &reply.lines {
        let mut line = OcrLine::default();
        for word in &raw.words {
            if ![word.x, word.y, word.w, word.h]
                .iter()
                .all(|v| v.is_finite())
            {
                return Err(WireError::Invalid("box"));
            }
            if word.t.chars().count() > limits::MAX_WORD_CHARS {
                return Err(WireError::Invalid("word length"));
            }
            let text: String = word
                .t
                .chars()
                .filter(|c| !c.is_control() && !c.is_whitespace())
                .collect();
            let x0 = word.x.clamp(0.0, wf);
            let y0 = word.y.clamp(0.0, hf);
            let x1 = (word.x + word.w).clamp(0.0, wf);
            let y1 = (word.y + word.h).clamp(0.0, hf);
            if text.is_empty() || x1 <= x0 || y1 <= y0 {
                continue;
            }
            line.words.push(OcrWord {
                text,
                rect: [x0, y0, x1, y1],
            });
        }
        if !line.words.is_empty() {
            lines.push(line);
        }
    }
    Ok(OcrPageLayer {
        lang: String::new(),
        angle_deg: reply.angle,
        dpi: 0.0,
        lines,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn request(w: u32, h: u32) -> OcrRequest {
        OcrRequest {
            v: 1,
            id: 7,
            w,
            h,
            stride: w,
            format: "gray8".into(),
            lang: vec!["de-DE".into()],
        }
    }

    #[test]
    fn a_request_round_trips_with_its_bitmap() {
        let mut buf = Vec::new();
        write_message(&mut buf, &request(3, 2), &[1, 2, 3, 4, 5, 6]).unwrap();
        let (got, blob) = read_request(&mut Cursor::new(buf)).unwrap().unwrap();
        assert_eq!(got, request(3, 2));
        assert_eq!(blob, [1, 2, 3, 4, 5, 6]);
    }

    #[test]
    fn a_clean_end_is_none_and_a_cut_is_truncated() {
        assert_eq!(read_request(&mut Cursor::new(Vec::new())).unwrap(), None);
        assert_eq!(
            read_request(&mut Cursor::new(vec![9, 0])).unwrap_err(),
            WireError::Truncated
        );
        let mut buf = Vec::new();
        write_message(&mut buf, &request(3, 2), &[1, 2, 3]).unwrap();
        assert_eq!(
            read_request(&mut Cursor::new(buf)).unwrap_err(),
            WireError::Truncated
        );
    }

    #[test]
    fn header_lengths_are_bounded_before_allocation() {
        for len in [0u32, 4097, u32::MAX] {
            let err = read_request(&mut Cursor::new(len.to_le_bytes().to_vec())).unwrap_err();
            assert_eq!(err, WireError::HeaderLength(len));
        }
        let huge = (limits::MAX_REPLY as u32 + 1).to_le_bytes().to_vec();
        assert!(matches!(
            read_reply(&mut Cursor::new(huge)),
            Err(WireError::HeaderLength(_))
        ));
    }

    #[test]
    fn a_malformed_header_is_refused() {
        let mut buf = 5u32.to_le_bytes().to_vec();
        buf.extend_from_slice(b"{nope");
        assert_eq!(
            read_request(&mut Cursor::new(buf)).unwrap_err(),
            WireError::Header
        );
    }

    #[test]
    fn requests_outside_the_bounds_are_refused() {
        let ok = request(100, 100);
        assert_eq!(validate_request(&ok), Ok(10_000));
        let mut bad = ok.clone();
        bad.w = limits::MAX_SIDE_PX + 1;
        bad.stride = bad.w;
        assert!(validate_request(&bad).is_err());
        let mut bad = ok.clone();
        bad.w = 8000;
        bad.h = 8000;
        bad.stride = 8000;
        assert_eq!(validate_request(&bad), Err(WireError::Invalid("pixels")));
        let mut bad = ok.clone();
        bad.stride = 101;
        assert_eq!(validate_request(&bad), Err(WireError::Invalid("stride")));
        let mut bad = ok.clone();
        bad.format = "bgra8".into();
        assert!(validate_request(&bad).is_err());
        let mut bad = ok.clone();
        bad.lang = vec!["../../x".into()];
        assert_eq!(validate_request(&bad), Err(WireError::Invalid("language")));
        let mut bad = ok;
        bad.w = 0;
        assert!(validate_request(&bad).is_err());
    }

    fn word(t: &str, x: f32, y: f32, w: f32, h: f32) -> RawWord {
        RawWord {
            t: t.into(),
            x,
            y,
            w,
            h,
        }
    }

    #[test]
    fn replies_are_cleaned_clamped_and_capped() {
        let reply = OcrReply {
            id: 1,
            ok: true,
            angle: 0.5,
            lines: vec![RawLine {
                words: vec![
                    word("Ha\u{0}llo\n", -5.0, 10.0, 50.0, 12.0),
                    word("\u{7}", 0.0, 0.0, 5.0, 5.0),
                    word("out", 500.0, 10.0, 5.0, 5.0),
                    word("wide", 90.0, 90.0, 50.0, 50.0),
                ],
            }],
            error: None,
        };
        let page = sanitize(&reply, 100, 100).unwrap();
        let words = &page.lines[0].words;
        assert_eq!(words.len(), 2);
        assert_eq!(words[0].text, "Hallo");
        assert_eq!(words[0].rect, [0.0, 10.0, 45.0, 22.0]);
        assert_eq!(words[1].rect, [90.0, 90.0, 100.0, 100.0]);
    }

    #[test]
    fn replies_with_non_finite_numbers_or_too_many_words_are_refused() {
        let mut reply = OcrReply {
            id: 1,
            ok: true,
            lines: vec![RawLine {
                words: vec![word("a", f32::NAN, 0.0, 1.0, 1.0)],
            }],
            ..OcrReply::default()
        };
        assert!(sanitize(&reply, 10, 10).is_err());
        reply.lines = vec![RawLine {
            words: (0..=limits::MAX_WORDS)
                .map(|_| word("a", 0.0, 0.0, 1.0, 1.0))
                .collect(),
        }];
        assert_eq!(
            sanitize(&reply, 10, 10),
            Err(WireError::Invalid("word count"))
        );
        reply.lines = vec![RawLine {
            words: vec![word(
                &"a".repeat(limits::MAX_WORD_CHARS + 1),
                0.0,
                0.0,
                1.0,
                1.0,
            )],
        }];
        assert!(sanitize(&reply, 10, 10).is_err());
        reply.ok = false;
        assert!(sanitize(&reply, 10, 10).is_err());
    }
}
