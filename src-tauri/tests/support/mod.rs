//! Test PDFs, built in code so that every byte of a fixture is explained and the files in `tests/fixtures/` can be checked against
//! their source (`tests/fixtures_up_to_date.rs`).
//!
//! `PdfBuilder` writes a classic PDF (header, numbered objects, a cross-reference table, a trailer) and nothing else: no
//! compression, no object streams, so a fixture can be read in a text editor. The fixtures themselves are in [`fixtures`]; the
//! generators that make a document of a size that does not belong in the repository (a deep outline, thousands of links, a
//! hundred pages) are there too, and the tests that need one write it to a temporary file.

// Every test crate that includes this module uses some of it.
#![allow(dead_code)]

pub mod fixtures;

use std::collections::BTreeMap;
use std::path::PathBuf;

/// Builds a PDF from numbered objects.
#[derive(Default)]
pub struct PdfBuilder {
    objects: BTreeMap<u32, Vec<u8>>,
    trailer: String,
}

impl PdfBuilder {
    pub fn new() -> Self {
        Self::default()
    }

    /// Adds object `id` with `body` (a dictionary, an array, a number: whatever goes between `obj` and `endobj`).
    pub fn object(&mut self, id: u32, body: &str) -> &mut Self {
        self.object_bytes(id, body.as_bytes().to_vec())
    }

    pub fn object_bytes(&mut self, id: u32, body: Vec<u8>) -> &mut Self {
        let mut bytes = format!("{id} 0 obj\n").into_bytes();
        bytes.extend_from_slice(&body);
        bytes.extend_from_slice(b"\nendobj\n");
        assert!(
            self.objects.insert(id, bytes).is_none(),
            "object {id} twice"
        );
        self
    }

    /// Adds a stream object: `dict` is the entries of its dictionary (without `/Length`).
    pub fn stream(&mut self, id: u32, dict: &str, data: &[u8]) -> &mut Self {
        let mut body = format!("<< {dict} /Length {} >>\nstream\n", data.len()).into_bytes();
        body.extend_from_slice(data);
        body.extend_from_slice(b"\nendstream");
        self.object_bytes(id, body)
    }

    /// Entries added to the trailer (`/Encrypt 9 0 R /ID [...]`).
    pub fn trailer(&mut self, entries: &str) -> &mut Self {
        self.trailer = entries.to_owned();
        self
    }

    /// The file: object `root` is the catalog. Ids that are not used are free entries of the table.
    pub fn finish(&self, root: u32) -> Vec<u8> {
        let mut out = b"%PDF-1.7\n%\xE2\xE3\xCF\xD3\n".to_vec();
        let size = self.objects.keys().next_back().copied().unwrap_or(0) + 1;
        let mut offsets = vec![None; size as usize];
        for (&id, bytes) in &self.objects {
            offsets[id as usize] = Some(out.len());
            out.extend_from_slice(bytes);
        }
        let xref = out.len();
        out.extend_from_slice(format!("xref\n0 {size}\n").as_bytes());
        out.extend_from_slice(b"0000000000 65535 f \n");
        for offset in offsets.iter().skip(1) {
            match offset {
                Some(offset) => {
                    out.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes())
                }
                None => out.extend_from_slice(b"0000000000 65535 f \n"),
            }
        }
        out.extend_from_slice(
            format!(
                "trailer\n<< /Size {size} /Root {root} 0 R {} >>\nstartxref\n{xref}\n%%EOF\n",
                self.trailer
            )
            .as_bytes(),
        );
        out
    }
}

/// A PDF text string as UTF-16BE with a byte order mark, as a hex string: how a title or a name with characters outside
/// PDFDocEncoding is written.
pub fn text_string(text: &str) -> String {
    let mut hex = String::from("<FEFF");
    for unit in text.encode_utf16() {
        hex.push_str(&format!("{unit:04X}"));
    }
    hex.push('>');
    hex
}

/// `text` as a literal string of the content stream in WinAnsiEncoding (what the fixtures' fonts use): ASCII as it is, Latin-1
/// letters and a few punctuation marks as octal escapes. Panics for a character that WinAnsi has not.
pub fn win_ansi(text: &str) -> String {
    let mut out = String::from("(");
    for c in text.chars() {
        let code = match c {
            '(' | ')' | '\\' => {
                out.push('\\');
                out.push(c);
                continue;
            }
            ' '..='~' => {
                out.push(c);
                continue;
            }
            '\u{a0}'..='\u{ff}' => c as u32,
            '\u{20ac}' => 0x80,
            '\u{2013}' => 0x96,
            '\u{2014}' => 0x97,
            '\u{2018}' => 0x91,
            '\u{2019}' => 0x92,
            '\u{201c}' => 0x93,
            '\u{201d}' => 0x94,
            '\u{201e}' => 0x84,
            '\u{2026}' => 0x85,
            _ => panic!("{c:?} is not in WinAnsiEncoding"),
        };
        out.push_str(&format!("\\{code:03o}"));
    }
    out.push(')');
    out
}

/// One line of text of a content stream: Helvetica (`/F1`) at `size` with the text origin at (`x`, `y`).
pub fn text_line(size: u32, x: u32, y: u32, text: &str) -> String {
    format!("BT /F1 {size} Tf {x} {y} Td {} Tj ET\n", win_ansi(text))
}

/// A path under the system's temporary directory that is unique to this process and `name`, removed with the returned guard.
pub struct TempFile(pub PathBuf);

impl TempFile {
    pub fn write(name: &str, bytes: &[u8]) -> Self {
        let path = std::env::temp_dir().join(format!("sheer-test-{}-{name}", std::process::id()));
        std::fs::write(&path, bytes).expect("write the temporary PDF");
        Self(path)
    }
}

impl Drop for TempFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}
