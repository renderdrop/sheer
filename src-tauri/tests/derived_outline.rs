//! The outline derived from headings (ADR-113) against a generated PDF and the real PDFium, through the same `AppState` that the
//! Tauri command calls. Skips when the PDFium library has not been fetched (`npm run fetch-pdfium`).

#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use std::path::PathBuf;
use std::sync::OnceLock;

use sheer_lib::commands::AppState;
use sheer_lib::engine::{self, Engine};
use sheer_lib::model::reading::OutlineNode;
use support::fixtures::{add_pages, Page};
use support::{text_line, PdfBuilder, TempFile};

fn state() -> Option<&'static AppState> {
    static STATE: OnceLock<Option<AppState>> = OnceLock::new();
    STATE
        .get_or_init(|| {
            let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("pdfium");
            let library = engine::library_path(&root);
            library
                .is_file()
                .then(|| AppState::new(Engine::start(library)))
        })
        .as_ref()
}

fn document(pages: &[Page]) -> Vec<u8> {
    let mut builder = PdfBuilder::new();
    add_pages(&mut builder, pages);
    builder.object(1, "<< /Type /Catalog /Pages 2 0 R >>");
    builder.finish(1)
}

/// Three pages: a running header and a page number on each, three heading sizes, body text of 12 pt.
fn headed_pages() -> Vec<Page> {
    let body = "Body text of the document that runs on for a while and has plenty of characters.";
    let mut pages = Vec::new();
    for number in 1..=3u32 {
        let mut content = text_line(26, 72, 760, "Annual Report 2024");
        content.push_str(&text_line(12, 300, 30, &number.to_string()));
        match number {
            1 => {
                content.push_str(&text_line(30, 72, 700, "The Big Title"));
                content.push_str(&text_line(22, 72, 640, "First Chapter"));
                content.push_str(&text_line(17, 72, 600, "A Section"));
            }
            2 => content.push_str(&text_line(22, 72, 700, "Second Chapter")),
            _ => {
                content.push_str(&text_line(22, 72, 700, "Third Chapter that is long and"));
                content.push_str(&text_line(22, 72, 674, "continues on a second line"));
            }
        }
        for line in 0..8 {
            content.push_str(&text_line(12, 72, 540 - 20 * line, body));
        }
        pages.push(Page::new(&content));
    }
    pages
}

fn shape(nodes: &[OutlineNode]) -> Vec<(String, usize)> {
    nodes
        .iter()
        .map(|node| (node.title.clone(), node.children.len()))
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
fn a_document_without_bookmarks_gets_the_outline_of_its_headings() {
    let Some(state) = state() else { return };
    let (id, _file) = open(state, "derived.pdf", &document(&headed_pages()));
    let outline = state.outline(id).unwrap();
    // The running header (three pages, same place) and the page numbers are not headings.
    assert_eq!(shape(&outline), [("The Big Title".to_owned(), 3)]);
    assert!(outline.iter().all(|node| node.derived));
    let chapters = &outline[0].children;
    assert_eq!(
        shape(chapters),
        [
            ("First Chapter".to_owned(), 1),
            ("Second Chapter".to_owned(), 0),
            (
                "Third Chapter that is long and continues on a second line".to_owned(),
                0
            ),
        ]
    );
    assert_eq!(chapters[0].children[0].title, "A Section");
    let target = chapters[1].target.unwrap();
    assert_eq!(
        target.page_id,
        state.outline(id).unwrap()[0].children[1]
            .target
            .unwrap()
            .page_id
    );
    assert!(
        target.y > 50.0 && target.y < 120.0,
        "y is from the top: {}",
        target.y
    );
    state.close_document(id).unwrap();
}

#[test]
fn a_document_with_many_pages_and_heavy_text_is_read_within_its_limits() {
    let Some(state) = state() else { return };
    // 2 500 pages of 300 short headings each: more pages than are scanned, and entries beyond the cap.
    let mut content = String::new();
    for n in 0..300u32 {
        content.push_str(&text_line(
            20,
            72,
            760 - (n % 37) * 20,
            &format!("Item {}", char::from(b'a' + (n % 26) as u8)),
        ));
        content.push_str(&text_line(10, 300, 20 + (n % 3), "small"));
    }
    let pages: Vec<Page> = (0..2_500).map(|_| Page::new(&content)).collect();
    let started = std::time::Instant::now();
    let (id, _file) = open(state, "derived-big.pdf", &document(&pages));
    let outline = state.outline(id).unwrap();
    assert!(started.elapsed() < std::time::Duration::from_secs(30));
    fn count(nodes: &[OutlineNode]) -> usize {
        nodes.iter().map(|n| 1 + count(&n.children)).sum()
    }
    assert!(count(&outline) <= 200, "{}", count(&outline));
    state.close_document(id).unwrap();
}
