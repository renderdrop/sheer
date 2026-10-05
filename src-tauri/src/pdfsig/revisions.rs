//! The revisions of a PDF file and the layout of a signature's `/ByteRange` (ADR-121 section 4 steps ii; SECURITY P21).
//!
//! Bytes in, typed values out: no lopdf and no crypto here. Every PDF is hostile input, so the readers are bounded and never recurse:
//! the `startxref` / `/Prev` chain is followed at most `limits::SIG_REVISIONS_MAX` times with a visited set, a trailer or xref-stream
//! dictionary is tokenized iteratively (strings, names, nesting) and at most [`DICT_SCAN_MAX`] bytes are read for it, and the
//! `/Contents` gap is a single `<hex>` token whose size is bounded before it is decoded.

use std::collections::HashSet;

use crate::limits;
use crate::pdfsig::types::Cryptographic;

/// Most bytes of one trailer or xref-stream dictionary that are tokenized.
const DICT_SCAN_MAX: usize = 256 * 1024;
/// How far from the end of the file the last `startxref` is looked for.
const STARTXREF_TAIL: usize = 4096;
/// How far back from the `/Contents` gap the key `/Contents` has to be.
const KEY_LOOKBACK: usize = 64;

/// The revision ends of `bytes` in ascending order: the offset after the `%%EOF` marker (and its end-of-line) of every section on the
/// `startxref` / `/Prev` chain that is followed from the last `startxref`. At most `limits::SIG_REVISIONS_MAX` are kept; the flag says
/// the chain was longer. A file whose chain cannot be read has no revisions (the caller then treats every signature as `malformed`).
pub fn revision_ends(bytes: &[u8]) -> (Vec<u64>, bool) {
    let mut ends: Vec<u64> = Vec::new();
    let mut truncated = false;
    let Some(mut xref) = last_startxref(bytes) else {
        return (ends, false);
    };
    let mut seen: HashSet<u64> = HashSet::new();
    loop {
        if !seen.insert(xref) {
            break;
        }
        if seen.len() > limits::SIG_REVISIONS_MAX {
            truncated = true;
            break;
        }
        let Some(section) = read_section(bytes, xref) else {
            break;
        };
        match section.end {
            Some(end) => ends.push(end),
            None => break,
        }
        match section.prev {
            Some(prev) => xref = prev,
            None => break,
        }
    }
    ends.sort_unstable();
    ends.dedup();
    (ends, truncated)
}

/// Whether `value` is the end of a revision: one of `ends`, or the position right after its `%%EOF` marker (the end-of-line that
/// follows the marker may or may not be part of the signed range).
pub fn is_revision_end(bytes: &[u8], ends: &[u64], value: u64) -> bool {
    if ends.contains(&value) {
        return true;
    }
    let Ok(at) = usize::try_from(value) else {
        return false;
    };
    if at < 5 || at > bytes.len() || &bytes[at - 5..at] != b"%%EOF" {
        return false;
    }
    ends.iter().any(|&end| {
        usize::try_from(end).is_ok_and(|end| {
            end > at && end - at <= 2 && bytes[at..end].iter().all(|b| matches!(b, b'\r' | b'\n'))
        })
    })
}

/// Where the signature's two hashed ranges and its `/Contents` token are, checked against the file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Layout {
    /// End of the first range (`/ByteRange [0 a b c]`): the offset of the `<`.
    pub a: u64,
    /// Start of the second range: the offset after the `>`.
    pub b: u64,
    /// Length of the second range.
    pub c: u64,
}

impl Layout {
    /// The end of the signed revision: `b + c`.
    pub const fn end(&self) -> u64 {
        self.b + self.c
    }
}

/// Step (ii): `[0 a b c]` of four non-negative integers with `a < b` and `b + c` within the file and at the end of a revision, and the
/// gap `[a, b)` exactly one `<hex>` token that follows the key `/Contents`. The verdict is `malformed` for a layout that is wrong, and
/// `unverifiable` when the revision chain was cut by its cap and the end may lie beyond it.
pub fn check_layout(
    bytes: &[u8],
    byte_range: &[i64],
    ends: &[u64],
    ends_truncated: bool,
) -> Result<Layout, Cryptographic> {
    let [first, a, b, c] = byte_range else {
        return Err(Cryptographic::Malformed);
    };
    let (Ok(first), Ok(a), Ok(b), Ok(c)) = (
        u64::try_from(*first),
        u64::try_from(*a),
        u64::try_from(*b),
        u64::try_from(*c),
    ) else {
        return Err(Cryptographic::Malformed);
    };
    let len = bytes.len() as u64;
    let end = b.checked_add(c).ok_or(Cryptographic::Malformed)?;
    // Greater a < b also keeps the two ranges apart: they cannot overlap.
    if first != 0 || a == 0 || a >= b || b > len || end > len || c == 0 {
        return Err(Cryptographic::Malformed);
    }
    let max_gap = 2 * limits::SIG_CONTENTS_READ_MAX as u64 + 2 + 2 * GAP_SPACE_SLACK;
    if b - a > max_gap {
        return Err(Cryptographic::Malformed);
    }
    if !is_revision_end(bytes, ends, end) {
        return Err(
            if ends_truncated && end > ends.last().copied().unwrap_or(0) {
                Cryptographic::Unverifiable
            } else {
                Cryptographic::Malformed
            },
        );
    }
    let layout = Layout { a, b, c };
    gap_hex(bytes, &layout)?;
    Ok(layout)
}

/// White space the hex token may hold besides its digits (a signer may wrap the placeholder).
const GAP_SPACE_SLACK: u64 = 4096;

/// The bytes of the `/Contents` token of `layout`: the hex digits between `<` and `>` decoded (an odd last digit counts as followed by
/// 0, as PDF says). The token has to follow the key `/Contents`; white space inside is skipped; any other byte makes it `malformed`.
pub fn gap_hex(bytes: &[u8], layout: &Layout) -> Result<Vec<u8>, Cryptographic> {
    let (Ok(a), Ok(b)) = (usize::try_from(layout.a), usize::try_from(layout.b)) else {
        return Err(Cryptographic::Malformed);
    };
    let gap = bytes.get(a..b).ok_or(Cryptographic::Malformed)?;
    let (Some(b'<'), Some(b'>')) = (gap.first(), gap.last()) else {
        return Err(Cryptographic::Malformed);
    };
    // The key before it, with white space in between.
    let from = a.saturating_sub(KEY_LOOKBACK);
    let before = trim_end_ws(&bytes[from..a]);
    if !before.ends_with(b"/Contents") {
        return Err(Cryptographic::Malformed);
    }
    let inner = &gap[1..gap.len() - 1];
    let mut out = Vec::with_capacity(inner.len() / 2 + 1);
    let mut high: Option<u8> = None;
    for &byte in inner {
        let digit = match byte {
            b'0'..=b'9' => byte - b'0',
            b'a'..=b'f' => byte - b'a' + 10,
            b'A'..=b'F' => byte - b'A' + 10,
            b' ' | b'\t' | b'\r' | b'\n' | 0x0C | 0 => continue,
            _ => return Err(Cryptographic::Malformed),
        };
        match high.take() {
            Some(h) => out.push(h << 4 | digit),
            None => high = Some(digit),
        }
    }
    if let Some(h) = high {
        out.push(h << 4);
    }
    if out.len() > limits::SIG_CONTENTS_READ_MAX {
        return Err(Cryptographic::Malformed);
    }
    Ok(out)
}

fn trim_end_ws(mut bytes: &[u8]) -> &[u8] {
    while let [rest @ .., last] = bytes {
        if is_space(*last) {
            bytes = rest;
        } else {
            break;
        }
    }
    bytes
}

// --- The chain ---------------------------------------------------------------------------------------------------------

struct Section {
    /// `/Prev` of the trailer or xref-stream dictionary.
    prev: Option<u64>,
    /// The end of the revision this section belongs to.
    end: Option<u64>,
}

fn is_space(byte: u8) -> bool {
    matches!(byte, b' ' | b'\t' | b'\r' | b'\n' | 0x0C | 0)
}

fn is_delimiter(byte: u8) -> bool {
    matches!(
        byte,
        b'(' | b')' | b'<' | b'>' | b'[' | b']' | b'{' | b'}' | b'/' | b'%'
    )
}

fn find(haystack: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    if from >= haystack.len() || needle.is_empty() {
        return None;
    }
    haystack[from..]
        .windows(needle.len())
        .position(|window| window == needle)
        .map(|at| at + from)
}

fn rfind(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack
        .windows(needle.len())
        .rposition(|window| window == needle)
}

fn skip_space(bytes: &[u8], mut at: usize) -> usize {
    while at < bytes.len() && is_space(bytes[at]) {
        at += 1;
    }
    at
}

fn read_uint(bytes: &[u8], at: usize) -> Option<(u64, usize)> {
    let mut end = at;
    let mut value: u64 = 0;
    while end < bytes.len() && bytes[end].is_ascii_digit() {
        value = value
            .checked_mul(10)?
            .checked_add(u64::from(bytes[end] - b'0'))?;
        end += 1;
    }
    (end > at).then_some((value, end))
}

fn last_startxref(bytes: &[u8]) -> Option<u64> {
    let tail_from = bytes.len().saturating_sub(STARTXREF_TAIL);
    let at = tail_from + rfind(&bytes[tail_from..], b"startxref")?;
    let (value, _) = read_uint(bytes, skip_space(bytes, at + b"startxref".len()))?;
    (value < bytes.len() as u64).then_some(value)
}

fn read_section(bytes: &[u8], xref: u64) -> Option<Section> {
    let start = usize::try_from(xref).ok()?;
    let mut at = skip_space(bytes, start);
    let dict_from = if bytes.get(at..)?.starts_with(b"xref") {
        // A classic table: its entries are digits, `n` and `f`, so the first `trailer` is this section's.
        let trailer = find(bytes, b"trailer", at)?;
        trailer + b"trailer".len()
    } else {
        // An xref stream: `N G obj << ... >>`.
        let (_, next) = read_uint(bytes, at)?;
        at = skip_space(bytes, next);
        let (_, next) = read_uint(bytes, at)?;
        at = skip_space(bytes, next);
        if !bytes.get(at..)?.starts_with(b"obj") {
            return None;
        }
        at + 3
    };
    let (prev, dict_end) = scan_dictionary(bytes, dict_from)?;
    // The revision ends at the `%%EOF` that follows the next `startxref` and its number.
    let end = find(bytes, b"startxref", dict_end).and_then(|marker| {
        let (_, after) = read_uint(bytes, skip_space(bytes, marker + b"startxref".len()))?;
        let eof = skip_space(bytes, after);
        bytes
            .get(eof..)?
            .starts_with(b"%%EOF")
            .then(|| after_eol(bytes, eof + 5) as u64)
    });
    Some(Section { prev, end })
}

fn after_eol(bytes: &[u8], at: usize) -> usize {
    match (bytes.get(at), bytes.get(at + 1)) {
        (Some(b'\r'), Some(b'\n')) => at + 2,
        (Some(b'\r' | b'\n'), _) => at + 1,
        _ => at,
    }
}

/// Tokenizes the dictionary that starts at or after `from` (iteratively, depth counted) and returns its top-level `/Prev` and the
/// offset after its closing `>>`.
fn scan_dictionary(bytes: &[u8], from: usize) -> Option<(Option<u64>, usize)> {
    let limit = bytes.len().min(from.saturating_add(DICT_SCAN_MAX));
    let mut at = skip_space(bytes, from);
    if !bytes.get(at..limit)?.starts_with(b"<<") {
        return None;
    }
    let mut depth = 0usize;
    let mut prev = None;
    while at < limit {
        match bytes[at] {
            b if is_space(b) => at += 1,
            b'%' => {
                while at < limit && !matches!(bytes[at], b'\r' | b'\n') {
                    at += 1;
                }
            }
            b'<' if bytes.get(at + 1) == Some(&b'<') => {
                depth += 1;
                at += 2;
            }
            b'<' => {
                at += 1;
                while at < limit && bytes[at] != b'>' {
                    at += 1;
                }
                at += 1;
            }
            b'>' if bytes.get(at + 1) == Some(&b'>') => {
                depth = depth.checked_sub(1)?;
                at += 2;
                if depth == 0 {
                    return Some((prev, at));
                }
            }
            b'(' => {
                let mut nesting = 0usize;
                while at < limit {
                    match bytes[at] {
                        b'\\' => at += 1,
                        b'(' => nesting += 1,
                        b')' => {
                            nesting -= 1;
                            if nesting == 0 {
                                break;
                            }
                        }
                        _ => {}
                    }
                    at += 1;
                }
                at += 1;
            }
            b'/' => {
                let name_start = at + 1;
                at = name_start;
                while at < limit && !is_space(bytes[at]) && !is_delimiter(bytes[at]) {
                    at += 1;
                }
                if depth == 1 && &bytes[name_start..at] == b"Prev" {
                    let value = skip_space(bytes, at);
                    if let Some((number, _)) = read_uint(bytes, value) {
                        prev = Some(number);
                    }
                }
            }
            _ => {
                // A number, keyword, bracket or stray delimiter.
                at += 1;
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file_with_revisions() -> (Vec<u8>, Vec<u64>) {
        // Not a real document: only the sections the chain walk reads. Offsets are patched in.
        let mut bytes = b"%PDF-1.7\n".to_vec();
        let first = bytes.len();
        bytes.extend_from_slice(
            b"xref\n0 1\n0000000000 65535 f \ntrailer\n<< /Size 1 /Root 1 0 R >>\nstartxref\n",
        );
        bytes.extend_from_slice(format!("{first}\n%%EOF\n").as_bytes());
        let end_one = bytes.len() as u64;
        let second = bytes.len();
        bytes.extend_from_slice(
            format!("xref\n0 1\n0000000000 65535 f \ntrailer\n<< /Size 1 /Prev {first} /Info (a >> b) >>\nstartxref\n{second}\n%%EOF\n")
                .as_bytes(),
        );
        let end_two = bytes.len() as u64;
        (bytes, vec![end_one, end_two])
    }

    #[test]
    fn the_chain_gives_the_revision_ends_in_order() {
        let (bytes, ends) = file_with_revisions();
        assert_eq!(revision_ends(&bytes), (ends.clone(), false));
        // The end with or without its end-of-line.
        assert!(is_revision_end(&bytes, &ends, ends[0]));
        assert!(is_revision_end(&bytes, &ends, ends[0] - 1));
        assert!(!is_revision_end(&bytes, &ends, ends[0] - 2));
    }

    #[test]
    fn a_loop_in_the_chain_ends() {
        let mut bytes = b"%PDF-1.7\nxref\n0 1\n0000000000 65535 f \ntrailer\n<< /Prev 9 >>\nstartxref\n9\n%%EOF\n".to_vec();
        assert_eq!(revision_ends(&bytes).0.len(), 1);
        bytes.truncate(20);
        assert_eq!(revision_ends(&bytes), (Vec::new(), false));
        assert_eq!(revision_ends(b""), (Vec::new(), false));
    }

    #[test]
    fn a_long_chain_is_cut_at_the_cap() {
        let mut bytes = b"%PDF-1.7\n".to_vec();
        let mut prev: Option<usize> = None;
        for _ in 0..limits::SIG_REVISIONS_MAX + 5 {
            let at = bytes.len();
            let link = prev.map(|p| format!("/Prev {p}")).unwrap_or_default();
            bytes.extend_from_slice(
                format!("xref\n0 1\n0000000000 65535 f \ntrailer\n<< {link} >>\nstartxref\n{at}\n%%EOF\n").as_bytes(),
            );
            prev = Some(at);
        }
        let (ends, truncated) = revision_ends(&bytes);
        assert!(truncated);
        assert!(ends.len() <= limits::SIG_REVISIONS_MAX);
    }

    fn signed_like(gap: &str, key: &str) -> (Vec<u8>, Layout, Vec<u64>) {
        let mut bytes = b"%PDF-1.7\n".to_vec();
        bytes.extend_from_slice(key.as_bytes());
        let a = bytes.len() as u64;
        bytes.extend_from_slice(gap.as_bytes());
        let b = bytes.len() as u64;
        bytes.extend_from_slice(
            b" >>
endobj
",
        );
        let xref = bytes.len();
        bytes.extend_from_slice(
            format!(
                "xref
0 1
0000000000 65535 f 
trailer
<< >>
startxref
{xref}
%%EOF
"
            )
            .as_bytes(),
        );
        let c = bytes.len() as u64 - b;
        let (ends, _) = revision_ends(&bytes);
        (bytes, Layout { a, b, c }, ends)
    }

    #[test]
    fn the_gap_must_be_one_hex_token_after_contents() {
        let (bytes, layout, ends) = signed_like("<00ff>", "<< /Contents ");
        let range = [0, layout.a as i64, layout.b as i64, layout.c as i64];
        assert_eq!(check_layout(&bytes, &range, &ends, false), Ok(layout));
        assert_eq!(gap_hex(&bytes, &layout), Ok(vec![0x00, 0xff]));
        for (gap, key) in [
            ("<00zz>", "<< /Contents "),
            ("<00ff>", "<< /Other "),
            ("(00ff)", "<< /Contents "),
            ("<00ff", "<< /Contents "),
        ] {
            let (bytes, layout, ends) = signed_like(gap, key);
            let range = [0, layout.a as i64, layout.b as i64, layout.c as i64];
            assert_eq!(
                check_layout(&bytes, &range, &ends, false),
                Err(Cryptographic::Malformed),
                "{gap} after {key}"
            );
        }
    }

    #[test]
    fn a_hostile_byte_range_is_malformed_and_never_panics() {
        let (bytes, layout, ends) = signed_like("<00ff>", "<< /Contents ");
        let (a, b, c) = (layout.a as i64, layout.b as i64, layout.c as i64);
        let len = bytes.len() as i64;
        let cases: Vec<Vec<i64>> = vec![
            vec![],
            vec![0, a, b],
            vec![0, a, b, c, 1],
            vec![1, a, b, c],
            vec![0, b, a, c],
            vec![0, a, a, c],
            vec![0, a, b - 1, c],
            vec![0, a, b, c - 2],
            vec![0, a, b, c + 1],
            vec![0, -1, b, c],
            vec![0, a, -5, c],
            vec![0, a, b, -1],
            vec![0, a, b, i64::MAX],
            vec![0, a, i64::MAX, 1],
            vec![0, i64::MAX, i64::MAX, i64::MAX],
            vec![0, 0, b, c],
            vec![0, a, b, 0],
            vec![0, a, len, 0],
        ];
        for range in cases {
            assert_eq!(
                check_layout(&bytes, &range, &ends, false),
                Err(Cryptographic::Malformed),
                "{range:?}"
            );
        }
    }

    #[test]
    fn an_oversized_gap_is_refused_before_it_is_decoded() {
        let big = format!(
            "<{}>",
            "0".repeat(2 * limits::SIG_CONTENTS_READ_MAX + 20_000)
        );
        let (bytes, layout, ends) = signed_like(&big, "<< /Contents ");
        let range = [0, layout.a as i64, layout.b as i64, layout.c as i64];
        assert_eq!(
            check_layout(&bytes, &range, &ends, false),
            Err(Cryptographic::Malformed)
        );
    }
}
