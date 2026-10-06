//! The walker's operator budget: when it runs out the error names the walk (`contentOps`), not text editing, since redaction walks too.

#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use sheer_lib::error::{AppError, ErrorCode, UiError};
use sheer_lib::pdfwrite::ops_walk::{Budget, Run, WalkSink};
use sheer_lib::pdfwrite::text_io::PageDoc;
use support::PdfBuilder;

struct Nothing;

impl WalkSink for Nothing {
    fn run(&mut self, _run: Run) -> Result<(), AppError> {
        Ok(())
    }

    fn object(&mut self, _bbox: [f64; 4]) {}
}

fn page_with_text() -> Vec<u8> {
    let mut b = PdfBuilder::new();
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
        .stream(5, "", b"BT /F1 12 Tf 72 700 Td (Hello world) Tj ET");
    b.finish(1)
}

#[test]
fn an_exhausted_operator_budget_is_a_limit_named_for_the_walk() {
    let doc = PageDoc::load(&page_with_text()).unwrap();
    let page = doc.pages()[0];
    let mut budget = Budget::new();
    doc.walk(page, &mut budget, &mut Nothing)
        .expect("a full budget walks the page");
    let mut empty = Budget {
        ops: 1,
        ..Budget::new()
    };
    let error = doc.walk(page, &mut empty, &mut Nothing).unwrap_err();
    assert_eq!(error.code(), ErrorCode::LimitExceeded);
    let ui = serde_json::to_value(UiError::from(error)).unwrap();
    assert_eq!(ui["params"]["what"], "contentOps");
}
