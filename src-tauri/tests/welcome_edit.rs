//! Replacing a line of the welcome document answers `tooComplex` (preview and apply). Root cause (found in v1.5.1, package B3): the replay reads
//! the page without PDFium's characters, and `text_lines::decode_plain` decodes a single-byte code as Latin-1. The WinAnsi codes 0x80 to 0x9F
//! (the welcome document's ellipsis 0x85 and en dash 0x96) come out as C1 controls (U+0085 is even white space), so `text_splice::plan_edit`
//! finds no character of the font's `to_code` for the glyph and refuses. Lines without such a code are replaced fine.
//!
//! Fixed: `decode_plain` decodes through the font's own map (as `remap_placeholders` does for two-byte fonts) and never to a C1 control.

#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use sheer_lib::model::text_edit::{LineKey, TextEdit, TextFit, TextScope};
use sheer_lib::pdfwrite::text_save;

fn welcome(name: &str) -> Vec<u8> {
    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join("welcome")
        .join(name);
    std::fs::read(path).unwrap()
}

fn tiny(content: &str) -> Vec<u8> {
    let mut b = support::PdfBuilder::new();
    b.object(1, "<< /Type /Catalog /Pages 2 0 R >>")
        .object(2, "<< /Type /Pages /Kids [4 0 R] /Count 1 >>")
        .object(
            3,
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
        )
        .object(
            4,
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 5 0 R \
             /Resources << /Font << /F1 3 0 R >> >> >>",
        )
        .stream(5, "", content.as_bytes());
    b.finish(1)
}

/// Line `line` replaced by `text`: `Err(reason)` of the refusal.
fn replace(bytes: &[u8], line: u32, text: &str) -> Result<(), Option<&'static str>> {
    let edit = TextEdit {
        key: LineKey { rev: 0, line },
        text: text.to_owned(),
        fit: TextFit::KeepStart,
        scope: TextScope::Line,
    };
    text_save::apply_edits(bytes.to_vec(), &[(0, vec![edit])])
        .map(|_| ())
        .map_err(|error| error.reason())
}

#[test]
fn lines_of_the_welcome_document_without_c1_codes_are_replaced() {
    let bytes = welcome("welcome-de.pdf");
    // Lines 1 to 3 and 5 to 8 (reading order) hold no code from 0x80 to 0x9F.
    for line in [1, 2, 3, 5, 6, 7, 8] {
        assert_eq!(replace(&bytes, line, "Ein anderer Text"), Ok(()), "{line}");
    }
}

#[test]
fn the_self_opened_line_of_the_german_welcome_document_can_be_replaced() {
    let bytes = welcome("welcome-de.pdf");
    assert_eq!(replace(&bytes, 4, "Ein anderer Text"), Ok(()));
    assert_eq!(replace(&bytes, 0, "Schritte"), Ok(()));
}

#[test]
fn a_line_with_an_ellipsis_or_an_en_dash_code_can_be_replaced() {
    for show in [r"(ab\205 cd)", r"(ab\226 cd)"] {
        let bytes = tiny(&format!("BT /F1 12 Tf 72 700 Td {show} Tj ET"));
        assert_eq!(replace(&bytes, 0, "X"), Ok(()), "{show}");
    }
}

#[test]
fn a_line_with_an_umlaut_code_is_replaced() {
    let bytes = tiny(r"BT /F1 12 Tf 72 700 Td (ab\326 cd) Tj ET");
    assert_eq!(replace(&bytes, 0, "X"), Ok(()));
}
