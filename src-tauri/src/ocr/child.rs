//! The OCR child loop (ADR-134): reads requests on stdin, answers on stdout, ends when stdin does. A request that breaks the framing
//! cannot be skipped (its blob would be read as the next header), so it gets an error reply and the child ends with code 2.

use std::io::{BufReader, BufWriter, Write};

use super::wire::{self, OcrReply, OcrRequest, WireError};

/// The recognizer behind the loop; a test double stands in for it where there is no OS recognizer.
pub trait Recognize {
    /// `Err` is a short code, never text of the page.
    fn recognize(&mut self, request: &OcrRequest, pixels: &[u8]) -> Result<OcrReply, String>;
}

#[cfg(windows)]
struct WinRecognize {
    current: Option<super::win::Recognizer>,
}

#[cfg(windows)]
impl Recognize for WinRecognize {
    fn recognize(&mut self, request: &OcrRequest, pixels: &[u8]) -> Result<OcrReply, String> {
        let tag = request.lang.first().cloned().unwrap_or_default();
        if self.current.as_ref().map(super::win::Recognizer::tag) != Some(tag.as_str()) {
            self.current = super::win::Recognizer::new(&tag)?;
        }
        let Some(recognizer) = self.current.as_ref() else {
            return Err("language_unavailable".to_owned());
        };
        let raw = recognizer.recognize(pixels, request.w, request.h)?;
        Ok(OcrReply {
            id: request.id,
            ok: true,
            angle: raw.angle,
            lines: raw.lines,
            error: None,
        })
    }
}

#[cfg(not(windows))]
struct NoRecognizer;

#[cfg(not(windows))]
impl Recognize for NoRecognizer {
    fn recognize(&mut self, _: &OcrRequest, _: &[u8]) -> Result<OcrReply, String> {
        Err("no_backend".to_owned())
    }
}

fn error_reply(id: u64, code: &str) -> OcrReply {
    OcrReply {
        id,
        ok: false,
        error: Some(code.to_owned()),
        ..OcrReply::default()
    }
}

/// The loop over `input` and `output`; the exit code.
pub fn serve(
    input: &mut impl std::io::Read,
    output: &mut impl Write,
    recognizer: &mut impl Recognize,
) -> i32 {
    loop {
        match wire::read_request(input) {
            Ok(None) => return 0,
            Ok(Some((request, pixels))) => {
                let reply = recognizer
                    .recognize(&request, &pixels)
                    .unwrap_or_else(|code| error_reply(request.id, &code));
                if wire::write_message(output, &reply, &[]).is_err() {
                    return 1;
                }
            }
            Err(error) => {
                let code = match error {
                    WireError::Truncated => "truncated",
                    WireError::HeaderLength(_) => "header_length",
                    WireError::Header => "header",
                    WireError::Invalid(_) => "invalid_request",
                    WireError::Io(_) => "io",
                };
                let _ = wire::write_message(output, &error_reply(0, code), &[]);
                return 2;
            }
        }
    }
}

/// Runs the child on stdin and stdout.
pub fn child_main() -> i32 {
    let mut input = BufReader::new(std::io::stdin().lock());
    let mut output = BufWriter::new(std::io::stdout().lock());
    #[cfg(windows)]
    let mut recognizer = WinRecognize { current: None };
    #[cfg(not(windows))]
    let mut recognizer = NoRecognizer;
    serve(&mut input, &mut output, &mut recognizer)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    struct Echo;
    impl Recognize for Echo {
        fn recognize(&mut self, request: &OcrRequest, pixels: &[u8]) -> Result<OcrReply, String> {
            assert_eq!(pixels.len(), (request.w * request.h) as usize);
            Ok(OcrReply {
                id: request.id,
                ok: true,
                ..OcrReply::default()
            })
        }
    }

    fn message(w: u32, h: u32, blob: usize) -> Vec<u8> {
        let request = OcrRequest {
            v: 1,
            id: 3,
            w,
            h,
            stride: w,
            format: "gray8".into(),
            lang: vec!["de-DE".into()],
        };
        let mut out = Vec::new();
        wire::write_message(&mut out, &request, &vec![0u8; blob]).unwrap();
        out
    }

    #[test]
    fn serves_requests_until_the_pipe_ends() {
        let mut input = message(2, 2, 4);
        input.extend(message(3, 1, 3));
        let mut output = Vec::new();
        assert_eq!(serve(&mut Cursor::new(input), &mut output, &mut Echo), 0);
        let mut cursor = Cursor::new(output);
        assert!(wire::read_reply(&mut cursor).unwrap().ok);
        assert!(wire::read_reply(&mut cursor).unwrap().ok);
    }

    #[test]
    fn a_malformed_header_gets_an_error_reply_and_ends_the_child() {
        let mut output = Vec::new();
        let input = u32::MAX.to_le_bytes().to_vec();
        assert_eq!(serve(&mut Cursor::new(input), &mut output, &mut Echo), 2);
        let reply = wire::read_reply(&mut Cursor::new(output)).unwrap();
        assert!(!reply.ok);
        assert_eq!(reply.error.as_deref(), Some("header_length"));
    }

    #[test]
    fn an_oversized_bitmap_is_refused_without_reading_it() {
        let input = message(9000, 10, 0);
        let mut output = Vec::new();
        assert_eq!(serve(&mut Cursor::new(input), &mut output, &mut Echo), 2);
        let reply = wire::read_reply(&mut Cursor::new(output)).unwrap();
        assert_eq!(reply.error.as_deref(), Some("invalid_request"));
    }

    #[test]
    fn the_flag_and_the_variable_are_both_required() {
        use std::ffi::{OsStr, OsString};
        let args = |a: &str| vec![OsString::from("sheer"), OsString::from(a)];
        let one = Some(OsStr::new("1"));
        assert!(crate::ocr::child_mode_requested(
            args("--sheer-ocr-child"),
            one
        ));
        assert!(!crate::ocr::child_mode_requested(
            args("--sheer-ocr-child"),
            None
        ));
        assert!(!crate::ocr::child_mode_requested(args("C:\\a.pdf"), one));
    }
}
