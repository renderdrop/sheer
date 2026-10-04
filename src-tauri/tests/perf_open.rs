//! Performance budget bench (ROADMAP M7, ADR-053 section 4): a generated 500-page PDF opens and reports its page count in
//! under one second.
//!
//! Ignored by default: timing on a debug build or a shared CI runner is noise, and the test needs PDFium
//! (`npm run fetch-pdfium`). Run it in release-like conditions with
//!
//! ```text
//! npm run bench          # = cargo test --release --test perf_open -- --ignored --nocapture
//! ```
//!
//! It asserts the budget, so a regression fails the run; the measured time is printed either way. Without the PDFium library
//! it skips with a message instead of failing.

// Test code: panicking on a broken fixture is the point.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::fmt::Write as _;
use std::fs::{self, File};
use std::path::PathBuf;
use std::time::{Duration, Instant};

use sheer_lib::documents::Registry;
use sheer_lib::engine::{self, Engine};

const PAGES: u32 = 500;
const BUDGET: Duration = Duration::from_secs(1);

/// 500 pages, classic xref table, one small content stream per page.
fn synthetic_pdf(pages: u32) -> Vec<u8> {
    let mut out: Vec<u8> = b"%PDF-1.4\n".to_vec();
    let mut offsets: Vec<usize> = Vec::new();
    let mut object = |out: &mut Vec<u8>, body: &str| {
        offsets.push(out.len());
        let number = offsets.len();
        out.extend_from_slice(format!("{number} 0 obj\n{body}\nendobj\n").as_bytes());
    };
    object(&mut out, "<< /Type /Catalog /Pages 2 0 R >>");
    let kids = (0..pages).fold(String::new(), |mut kids, index| {
        write!(kids, "{} 0 R ", 4 + 2 * index).unwrap();
        kids
    });
    object(
        &mut out,
        &format!("<< /Type /Pages /Kids [{kids}] /Count {pages} >>"),
    );
    object(
        &mut out,
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    );
    for index in 0..pages {
        let content = 5 + 2 * index;
        object(
            &mut out,
            &format!(
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents {content} 0 R \
                 /Resources << /Font << /F1 3 0 R >> >> >>"
            ),
        );
        let stream = format!("BT /F1 24 Tf 50 700 Td (Page {}) Tj ET", index + 1);
        object(
            &mut out,
            &format!(
                "<< /Length {} >>\nstream\n{stream}\nendstream",
                stream.len()
            ),
        );
    }
    let xref_at = out.len();
    let count = offsets.len() + 1;
    let mut table = format!("xref\n0 {count}\n0000000000 65535 f \n");
    for offset in &offsets {
        writeln!(table, "{offset:010} 00000 n ").unwrap();
    }
    write!(
        table,
        "trailer\n<< /Size {count} /Root 1 0 R >>\nstartxref\n{xref_at}\n%%EOF\n"
    )
    .unwrap();
    out.extend_from_slice(table.as_bytes());
    out
}

#[test]
#[ignore = "timing bench: run with `npm run bench` (release build, PDFium fetched)"]
fn a_500_page_pdf_opens_and_reports_its_page_count_in_under_a_second() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("pdfium");
    let library = engine::library_path(&root);
    if !library.is_file() {
        eprintln!(
            "skipping: {} not found (npm run fetch-pdfium)",
            library.display()
        );
        return;
    }
    let dir = std::env::temp_dir().join(format!("sheer-perf-open-{}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    let path = dir.join("perf-500.pdf");
    fs::write(&path, synthetic_pdf(PAGES)).unwrap();

    let engine = Engine::start(library);
    // Warm-up: the engine thread (or child) binds PDFium on first use; the budget is about opening a document, not about that.
    let registry = Registry::new();
    let warm = registry.register(path.clone()).unwrap();
    engine
        .open(warm, File::open(&path).unwrap(), |_| true)
        .unwrap();
    engine.close(warm).unwrap();

    let id = registry.register(path.clone()).unwrap();
    let started = Instant::now();
    let pages = engine
        .open(id, File::open(&path).unwrap(), |_| true)
        .unwrap();
    let elapsed = started.elapsed();
    eprintln!(
        "perf_open: {PAGES} pages opened in {elapsed:?} (budget {BUDGET:?}, debug_assertions: {})",
        cfg!(debug_assertions)
    );
    assert_eq!(pages, PAGES);
    assert!(elapsed < BUDGET, "open took {elapsed:?}, budget {BUDGET:?}");
    engine.close(id).unwrap();
    let _ = fs::remove_dir_all(&dir);
}
