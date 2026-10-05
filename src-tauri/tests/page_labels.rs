//! `Job::PageLabels` and `Job::FirstPageHints` (ADR-119) against generated PDFs and the real PDFium, through the same `AppState` and
//! engine the commands use. When the PDFium library has not been fetched (`npm run fetch-pdfium`) the tests say so loudly on stderr
//! and are skipped; set `SHEER_REQUIRE_PDFIUM=1` to make that a failure (CI).

#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use std::path::PathBuf;
use std::sync::OnceLock;

use sheer_lib::commands::AppState;
use sheer_lib::engine::{self, Engine};
use support::fixtures::{add_pages, Page};
use support::{text_line, PdfBuilder, TempFile};

fn state() -> Option<&'static AppState> {
    static STATE: OnceLock<Option<AppState>> = OnceLock::new();
    STATE
        .get_or_init(|| {
            let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("pdfium");
            let library = engine::library_path(&root);
            if library.is_file() {
                return Some(AppState::new(Engine::start(library)));
            }
            assert!(
                std::env::var_os("SHEER_REQUIRE_PDFIUM").is_none(),
                "PDFium is not fetched ({}) but SHEER_REQUIRE_PDFIUM is set",
                library.display()
            );
            eprintln!(
                "SKIPPED: PDFium is not fetched ({} not found); the page-label and first-page tests did NOT run",
                library.display()
            );
            None
        })
        .as_ref()
}

fn document(pages: &[Page], catalog_extra: &str) -> Vec<u8> {
    let mut builder = PdfBuilder::new();
    add_pages(&mut builder, pages);
    builder.object(
        1,
        &format!("<< /Type /Catalog /Pages 2 0 R {catalog_extra} >>"),
    );
    builder.finish(1)
}

fn blank(count: usize) -> Vec<Page> {
    (0..count)
        .map(|n| Page::new(&text_line(12, 72, 700, &format!("page {n}"))))
        .collect()
}

fn open(
    state: &AppState,
    name: &str,
    bytes: &[u8],
) -> (sheer_lib::documents::DocumentId, TempFile) {
    let file = TempFile::write(name, bytes);
    let info = state.open_path(file.0.clone()).unwrap().expect("loaded");
    (info.id, file)
}

#[test]
fn roman_decimal_and_prefixed_ranges_are_read_per_page() {
    let Some(state) = state() else { return };
    let bytes = document(
        &blank(6),
        "/PageLabels << /Nums [0 << /S /r >> 3 << /S /D >> 5 << /P (A-) /S /D /St 7 >> ] >>",
    );
    let (id, _file) = open(state, "labels.pdf", &bytes);
    let labels = state.engine().page_labels(id).unwrap();
    let expected: Vec<Option<String>> = ["i", "ii", "iii", "1", "2", "A-7"]
        .iter()
        .map(|s| Some((*s).to_owned()))
        .collect();
    assert_eq!(labels, expected);
    state.close_document(id).unwrap();
}

#[test]
fn a_hostile_prefix_is_cleaned_and_cut() {
    let Some(state) = state() else { return };
    let prefix = "x".repeat(200);
    let bytes = document(
        &blank(2),
        &format!("/PageLabels << /Nums [0 << /P ({prefix}) /S /D >> ] >>"),
    );
    let (id, _file) = open(state, "long-labels.pdf", &bytes);
    let labels = state.engine().page_labels(id).unwrap();
    assert_eq!(labels.len(), 2);
    for label in labels.iter().flatten() {
        assert!(label.chars().count() <= sheer_lib::limits::PAGE_LABEL_MAX);
    }
    state.close_document(id).unwrap();
}

#[test]
fn a_document_without_labels_has_no_label_per_page() {
    let Some(state) = state() else { return };
    let (id, _file) = open(state, "no-labels.pdf", &document(&blank(3), ""));
    let labels = state.engine().page_labels(id).unwrap();
    // PDFium answers either nothing or the plain page number; the caller's fallback covers the first.
    assert_eq!(labels.len(), 3);
    state.close_document(id).unwrap();
}

#[test]
fn page_one_gives_title_year_and_doi() {
    let Some(state) = state() else { return };
    let mut content = text_line(10, 72, 760, "Journal of Examples");
    content.push_str(&text_line(26, 72, 700, "On the Nature of Examples"));
    for line in 0..6 {
        content.push_str(&text_line(
            12,
            72,
            600 - 20 * line,
            "Body text of the paper that runs on for a good while and has many characters.",
        ));
    }
    content.push_str(&text_line(9, 72, 60, "(c) 2021 The Authors"));
    content.push_str(&text_line(9, 72, 40, "https://doi.org/10.1234/abc.5678."));
    let mut pages = vec![Page::new(&content)];
    pages.extend(blank(1));
    let (id, _file) = open(state, "first.pdf", &document(&pages, ""));
    let hints = state.engine().first_page_hints(id, 0).unwrap();
    assert_eq!(hints.title.as_deref(), Some("On the Nature of Examples"));
    assert_eq!(hints.year.as_deref(), Some("2021"));
    assert_eq!(hints.doi.as_deref(), Some("10.1234/abc.5678"));
    // Page 2 has nothing of the kind; a page that does not exist is an error, not a panic.
    assert_eq!(state.engine().first_page_hints(id, 1).unwrap().doi, None);
    assert!(state.engine().first_page_hints(id, 9).is_err());
    state.close_document(id).unwrap();
}
