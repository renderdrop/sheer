//! The one door lopdf loads foreign bytes through (SECURITY P12): [`load_untrusted`] looks at the raw bytes first, then calls
//! `Document::load_mem`. No other code in `src` calls `load_mem` (a test pins it).
//!
//! `Document::load_mem` decodes every object stream and xref stream it finds, with no bound on the output, so a file of a few kilobytes
//! can ask for gigabytes. The pre-scan finds the streams without parsing the file, normalizes the `#xx` escapes of names (so `/Obj#53tm`
//! is seen as `/ObjStm`), refuses an implausible `/N` or `/Length`, and inflates every object or xref stream into a counter under a
//! budget for the file as a whole. A stream whose filter chain it cannot evaluate (ASCII85 then Flate, LZW, run length, ...) counts at
//! the worst case of its filters, or is refused when that does not fit. The data of a stream is taken by its direct `/Length` when that
//! is within the file, else up to the next `endstream`. Ordinary streams (content, images) are not decoded by lopdf at load, so they are
//! only checked for an implausible `/Length`.
//!
//! This is defence in depth, a heuristic on bytes: it does not parse the file, so a hostile file can still fool it. The real bound is the
//! engine in its own process with an address-space limit (M7, SECURITY P6); until then the job timeout and stack bound the rest.

use std::io::Read;

use flate2::read::ZlibDecoder;
use lopdf::Document;

use crate::error::{AppError, ErrorCode};
use crate::limits;

/// Most objects an object stream may claim (`/N`).
const MAX_OBJSTM_OBJECTS: u64 = 200_000;
/// How far before `stream` the start of its dictionary is looked for.
const DICT_WINDOW: usize = 4096;
/// Worst case growth of a filter chain that is not just Flate (deflate's best ratio is about 1032:1).
const WORST_RATIO: u64 = 1032;

/// Loads `bytes` with lopdf after the pre-scan. The error is `damaged_file`.
pub fn load_untrusted(bytes: &[u8]) -> Result<Document, AppError> {
    check(bytes)?;
    Document::load_mem(bytes)
        .map_err(|error| AppError::logged(ErrorCode::DamagedFile, format!("lopdf: {error}")))
}

fn find(haystack: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    let rest = haystack.get(from..)?;
    rest.windows(needle.len())
        .position(|window| window == needle)
        .map(|at| at + from)
}

fn rfind(haystack: &[u8], needle: &[u8], to: usize) -> Option<usize> {
    let part = haystack.get(..to.min(haystack.len()))?;
    part.windows(needle.len())
        .rposition(|window| window == needle)
}

/// `dict` with every `#xx` escape (hexadecimal) replaced by its byte.
fn unescape_names(dict: &[u8]) -> Vec<u8> {
    let hex = |b: u8| char::from(b).to_digit(16);
    let mut out = Vec::with_capacity(dict.len());
    let mut at = 0;
    while let Some(&byte) = dict.get(at) {
        if byte == b'#' {
            if let (Some(high), Some(low)) = (
                dict.get(at + 1).copied().and_then(hex),
                dict.get(at + 2).copied().and_then(hex),
            ) {
                if let Ok(value) = u8::try_from(high * 16 + low) {
                    out.push(value);
                    at += 3;
                    continue;
                }
            }
        }
        out.push(byte);
        at += 1;
    }
    out
}

/// The integer written right after `key` in `dict` (`/Length 123`); `None` if there is none or it is an indirect reference.
fn int_after(dict: &[u8], key: &[u8]) -> Option<u64> {
    let mut from = 0;
    while let Some(at) = find(dict, key, from) {
        let mut cursor = at + key.len();
        from = cursor;
        // `/Length` must not be the start of a longer name (`/Length1`).
        if dict.get(cursor).is_some_and(u8::is_ascii_alphanumeric) {
            continue;
        }
        while dict.get(cursor).is_some_and(u8::is_ascii_whitespace) {
            cursor += 1;
        }
        let digits: Vec<u8> = dict
            .get(cursor..)?
            .iter()
            .copied()
            .take_while(u8::is_ascii_digit)
            .take(20)
            .collect();
        if digits.is_empty() {
            return None;
        }
        // `12 0 R` is a reference, not a length.
        let after = cursor + digits.len();
        let tail = dict.get(after..).unwrap_or_default();
        let mut words = tail
            .split(|b| b.is_ascii_whitespace())
            .filter(|w| !w.is_empty());
        let is_reference = matches!(
            (words.next(), words.next()),
            (Some(generation), Some(r)) if r.starts_with(b"R") && generation.iter().all(u8::is_ascii_digit)
        );
        if is_reference {
            return None;
        }
        return std::str::from_utf8(&digits).ok()?.parse().ok();
    }
    None
}

fn refused(detail: &str) -> AppError {
    AppError::logged(ErrorCode::DamagedFile, format!("pre-scan: {detail}"))
}

/// What a filter does to the size, by name.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Filter {
    Flate,
    /// Any other filter that grows data, or one that is not known.
    Other,
    /// An image codec: lopdf does not decode it.
    Image,
}

/// The filters a stream dictionary names, in the order written. An empty list means none.
fn filters(dict: &[u8]) -> Vec<Filter> {
    const NAMES: [(&[u8], Filter); 14] = [
        (b"/FlateDecode", Filter::Flate),
        (b"/Fl", Filter::Flate),
        (b"/LZWDecode", Filter::Other),
        (b"/LZW", Filter::Other),
        (b"/ASCII85Decode", Filter::Other),
        (b"/A85", Filter::Other),
        (b"/ASCIIHexDecode", Filter::Other),
        (b"/AHx", Filter::Other),
        (b"/RunLengthDecode", Filter::Other),
        (b"/RL", Filter::Other),
        (b"/Crypt", Filter::Other),
        (b"/CCITTFaxDecode", Filter::Image),
        (b"/DCTDecode", Filter::Image),
        (b"/JPXDecode", Filter::Image),
    ];
    let Some(start) = find(dict, b"/Filter", 0) else {
        return Vec::new();
    };
    let rest = dict.get(start + b"/Filter".len()..).unwrap_or_default();
    // The value is a name or an array; it ends at the first name that is not a filter.
    let mut found = Vec::new();
    let mut at = 0;
    while let Some(slash) = find(rest, b"/", at) {
        let name_end = rest
            .get(slash + 1..)
            .and_then(|tail| tail.iter().position(|b| b" \t\r\n/[]<>()".contains(b)))
            .map_or(rest.len(), |p| slash + 1 + p);
        let name = rest.get(slash..name_end).unwrap_or_default();
        match NAMES.iter().find(|(known, _)| *known == name) {
            Some((_, kind)) => found.push(*kind),
            None => {
                if found.is_empty() {
                    // A filter this scan does not know: it cannot be evaluated.
                    found.push(Filter::Other);
                }
                break;
            }
        }
        at = name_end;
    }
    if found.is_empty() {
        found.push(Filter::Other);
    }
    found
}

/// Checks `bytes` against the bounds above: `damaged_file` for a stream length longer than the file, more objects in an object stream
/// than `MAX_OBJSTM_OBJECTS`, or more decoded bytes in all object and xref streams than `limits::MAX_LOAD_DECODED_BYTES`.
pub fn check(bytes: &[u8]) -> Result<(), AppError> {
    check_with(bytes, limits::MAX_LOAD_DECODED_BYTES as u64)
}

fn check_with(bytes: &[u8], decoded_budget: u64) -> Result<(), AppError> {
    let size = bytes.len() as u64;
    let mut budget = decoded_budget;
    let mut from = 0;
    while let Some(keyword) = find(bytes, b"stream", from) {
        from = keyword + b"stream".len();
        // The keyword follows the dictionary's `>>`; `endstream` does not.
        let before = bytes.get(..keyword).unwrap_or_default();
        let trimmed = before
            .iter()
            .rposition(|b| !b.is_ascii_whitespace())
            .map_or(0, |p| p + 1);
        if !before
            .get(..trimmed)
            .is_some_and(|text| text.ends_with(b">>"))
        {
            continue;
        }
        let window_start = keyword.saturating_sub(DICT_WINDOW);
        let start = rfind(bytes, b"obj", keyword).map_or(window_start, |s| s.max(window_start));
        let dict = unescape_names(bytes.get(start..keyword).unwrap_or_default());
        let length = int_after(&dict, b"/Length");
        if length.is_some_and(|length| length > size) {
            return Err(refused("stream longer than the file"));
        }
        let is_objstm = find(&dict, b"/ObjStm", 0).is_some();
        let is_xref = find(&dict, b"/XRef", 0).is_some();
        if is_objstm && int_after(&dict, b"/N").is_some_and(|n| n > MAX_OBJSTM_OBJECTS) {
            return Err(refused("object stream with too many objects"));
        }
        // Only these two kinds are decoded when lopdf loads a file.
        if !(is_objstm || is_xref) {
            continue;
        }
        let mut data_start = keyword + b"stream".len();
        if bytes.get(data_start) == Some(&b'\r') {
            data_start += 1;
        }
        if bytes.get(data_start) == Some(&b'\n') {
            data_start += 1;
        }
        let by_length = length
            .and_then(|length| usize::try_from(length).ok())
            .and_then(|length| data_start.checked_add(length))
            .filter(|end| *end <= bytes.len());
        let data_end = by_length
            .unwrap_or_else(|| find(bytes, b"endstream", data_start).unwrap_or(bytes.len()));
        let data = bytes.get(data_start..data_end).unwrap_or_default();
        let chain = filters(&dict);
        match chain.as_slice() {
            [] => {
                budget = budget
                    .checked_sub(data.len() as u64)
                    .ok_or_else(|| refused("object streams are too large"))?;
            }
            [Filter::Image] => {}
            [Filter::Flate] => {
                // Inflate into the void, one more byte than the budget allows: that byte is the proof of a bomb.
                let mut decoder = ZlibDecoder::new(data).take(budget.saturating_add(1));
                let mut chunk = [0u8; 16 * 1024];
                let mut decoded = 0u64;
                loop {
                    match decoder.read(&mut chunk) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => decoded += n as u64,
                    }
                }
                if decoded > budget {
                    return Err(refused("object streams decode to too much"));
                }
                budget -= decoded;
            }
            _ => {
                // A chain that is not just Flate: counted at its worst case.
                let worst = (data.len() as u64).saturating_mul(WORST_RATIO);
                budget = budget
                    .checked_sub(worst)
                    .ok_or_else(|| refused("a filter chain that cannot be checked is too large"))?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use flate2::write::ZlibEncoder;
    use flate2::Compression;

    use super::*;

    fn objstm(n: u64, data: &[u8], length: u64) -> Vec<u8> {
        let mut out = format!(
            "%PDF-1.5\n4 0 obj\n<< /Type /ObjStm /N {n} /First 5 /Filter /FlateDecode /Length {length} >>\nstream\n"
        )
        .into_bytes();
        out.extend_from_slice(data);
        out.extend_from_slice(b"\nendstream\nendobj\n");
        out
    }

    /// `file` with `from` in its dictionary (the part before the stream data) replaced by `to`.
    fn rewrite_dict(file: &[u8], from: &str, to: &str) -> Vec<u8> {
        let split = file.windows(6).position(|w| w == b"stream").unwrap();
        let head = String::from_utf8_lossy(&file[..split]).replace(from, to);
        let mut out = head.into_bytes();
        out.extend_from_slice(&file[split..]);
        out
    }

    fn deflate(raw: &[u8]) -> Vec<u8> {
        let mut encoder = ZlibEncoder::new(Vec::new(), Compression::best());
        encoder.write_all(raw).unwrap();
        encoder.finish().unwrap()
    }

    #[test]
    fn an_ordinary_object_stream_and_plain_files_pass() {
        let packed = deflate(b"1 0 << /A 1 >>");
        assert!(check(&objstm(1, &packed, packed.len() as u64)).is_ok());
        assert!(check(b"%PDF-1.4\n%%EOF\n").is_ok());
    }

    #[test]
    fn an_implausible_n_or_length_is_refused() {
        let packed = deflate(b"x");
        let many = objstm(9_000_000, &packed, packed.len() as u64);
        assert_eq!(check(&many).unwrap_err().code(), ErrorCode::DamagedFile);
        let long = objstm(1, &packed, 4_000_000_000);
        assert_eq!(check(&long).unwrap_err().code(), ErrorCode::DamagedFile);
    }

    #[test]
    fn an_indirect_length_is_not_taken_for_a_number() {
        let packed = deflate(b"x");
        let file = objstm(1, &packed, 0);
        let file = rewrite_dict(&file, "/Length 0", "/Length 99999999 0 R");
        assert!(check(&file).is_ok());
    }

    #[test]
    fn a_stream_that_inflates_past_the_budget_is_refused() {
        let zeros = vec![0u8; 3 * 1024 * 1024];
        let packed = deflate(&zeros);
        assert!(packed.len() < 64 * 1024, "a bomb is small");
        let bomb = objstm(1, &packed, packed.len() as u64);
        assert_eq!(
            check_with(&bomb, 1024 * 1024).unwrap_err().code(),
            ErrorCode::DamagedFile
        );
        assert!(check_with(&bomb, 4 * 1024 * 1024).is_ok());
    }

    #[test]
    fn escaped_names_are_seen_for_what_they_are() {
        let zeros = vec![0u8; 3 * 1024 * 1024];
        let packed = deflate(&zeros);
        let bomb = objstm(1, &packed, packed.len() as u64);
        let file = rewrite_dict(&bomb, "/ObjStm", "/Obj#53tm");
        let file = rewrite_dict(&file, "/FlateDecode", "/Flate#44ecode");
        assert!(check_with(&file, 4 * 1024 * 1024).is_ok());
        assert!(check_with(&file, 1024 * 1024).is_err());
    }

    #[test]
    fn xref_streams_and_filter_chains_are_counted() {
        let zeros = vec![0u8; 3 * 1024 * 1024];
        let packed = deflate(&zeros);
        let bomb = objstm(1, &packed, packed.len() as u64);
        let xref = rewrite_dict(&bomb, "/ObjStm", "/XRef");
        assert!(check_with(&xref, 1024 * 1024).is_err());
        // ASCII85 then Flate cannot be evaluated: it counts at the worst case and is refused when that does not fit.
        let chain = rewrite_dict(&bomb, "/FlateDecode", "[/ASCII85Decode /FlateDecode]");
        assert!(check_with(&chain, 1024 * 1024 * 1024).is_ok());
        assert!(check_with(&chain, 1024 * 1024).is_err());
    }

    #[test]
    fn the_length_decides_where_the_data_ends() {
        // A fake `endstream` at the start of the data does not cut it short: the bomb behind it is the data's, counted by /Length.
        let zeros = vec![0u8; 3 * 1024 * 1024];
        let mut data = deflate(&zeros);
        let mut fake = b"endstream\n".to_vec();
        fake.append(&mut data);
        let file = objstm(1, &fake, fake.len() as u64);
        // Garbage in front makes the inflate fail at once; what matters is that the cut is by length and nothing panics.
        assert!(check_with(&file, 1024).is_ok());
        // Without a direct length the data ends at the first `endstream`: here, at once.
        let indirect = rewrite_dict(&file, &format!("/Length {}", fake.len()), "/Length 1 0 R");
        assert!(check_with(&indirect, 1024).is_ok());
    }

    #[test]
    fn no_other_code_calls_load_mem() {
        fn walk(dir: &std::path::Path, hits: &mut Vec<String>) {
            for entry in std::fs::read_dir(dir).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    walk(&path, hits);
                } else if path.extension().is_some_and(|e| e == "rs")
                    && path.file_name().is_some_and(|n| n != "prescan.rs")
                {
                    let text = std::fs::read_to_string(&path).unwrap();
                    if text.contains("load_mem(") || text.contains("Document::load(") {
                        hits.push(path.display().to_string());
                    }
                }
            }
        }
        let mut hits = Vec::new();
        walk(
            &std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src"),
            &mut hits,
        );
        assert!(
            hits.is_empty(),
            "raw lopdf loads outside prescan.rs: {hits:?}"
        );
    }
}
