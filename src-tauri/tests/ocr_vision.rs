//! macOS OCR round trip (ADR-137 item 2): a generated text page is drawn by PDFium and recognized through the real `sheer-ocr`
//! sidecar (Apple Vision). Runs only with `SHEER_OCR=1` and `SHEER_OCR_SIDECAR=<path to the built sidecar>` (the macOS CI job);
//! everywhere else it returns at once.

// Test code: panicking on a broken fixture is the point.
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use std::path::PathBuf;

use sheer_lib::engine::{self, Engine};
use sheer_lib::export::snapshot::EngineDocRef;
use sheer_lib::ocr::backend::ChildClient;
use sheer_lib::ocr::limits;
use sheer_lib::pdfwrite::redact::RasterPixels;
use support::fixtures::{self, Page};
use support::PdfBuilder;

#[test]
fn vision_reads_a_generated_page_through_the_sidecar() {
    if std::env::var("SHEER_OCR").as_deref() != Ok("1") {
        return;
    }
    let sidecar = PathBuf::from(std::env::var("SHEER_OCR_SIDECAR").expect("SHEER_OCR_SIDECAR"));
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("pdfium");
    let library = engine::library_path(&root);
    assert!(library.is_file(), "PDFium is not fetched");
    let engine = Engine::start(library);

    let mut content = String::new();
    for (line, text) in ["The quick brown fox jumps", "over the lazy dog today"]
        .iter()
        .enumerate()
    {
        content.push_str(&support::text_line(18, 72, 700 - 40 * line as u32, text));
    }
    let mut builder = PdfBuilder::new();
    fixtures::add_pages(&mut builder, &[Page::new(&content)]);
    builder.object(1, "<< /Type /Catalog /Pages 2 0 R >>");
    let id = engine.open_snapshot(builder.finish(1).into()).unwrap();
    let page = engine
        .render_for_ocr(EngineDocRef::Snapshot(id), 0, 300.0, limits::MAX_SIDE_PX)
        .unwrap();
    let RasterPixels::Gray8(gray) = &page.pixels else {
        panic!("not gray");
    };

    let mut client = ChildClient::new(sidecar);
    let layer = client
        .recognize(gray, page.width, page.height, "en-US", limits::PAGE_TIMEOUT)
        .unwrap();
    let words: Vec<&str> = layer
        .lines
        .iter()
        .flat_map(|l| l.words.iter().map(|w| w.text.as_str()))
        .collect();
    for expected in ["quick", "brown", "jumps", "lazy", "dog"] {
        assert!(
            words.iter().any(|w| w.eq_ignore_ascii_case(expected)),
            "{expected} not found in {words:?}"
        );
    }
    for word in layer.lines.iter().flat_map(|l| &l.words) {
        let [x0, y0, x1, y1] = word.rect;
        assert!(x0 >= 0.0 && y0 >= 0.0 && x1 <= page.width as f32 && y1 <= page.height as f32);
        assert!(x1 > x0 && y1 > y0);
    }

    // The same sidecar answers a second page.
    let blank = vec![255u8; 64 * 64];
    assert!(client
        .recognize(&blank, 64, 64, "en-US", limits::PAGE_TIMEOUT)
        .is_ok());
    engine.close_snapshot(id).unwrap();
}
