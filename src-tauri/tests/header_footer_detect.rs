//! Detection of an existing running header and page numbers (F19.12, ARCHITECTURE §16.2) through the real PDFium and the same
//! `AppState` the command uses. Skips when the library is not fetched.

#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use std::path::PathBuf;

use sheer_lib::commands::hf_detect::{DetectedEdge, DetectedKind, DetectedSlot};
use sheer_lib::commands::AppState;
use sheer_lib::engine::{self, Engine};
use support::fixtures::{add_pages, Page};
use support::{text_line, PdfBuilder};

fn pdf(count: u32) -> Vec<u8> {
    let pages: Vec<Page> = (1..=count)
        .map(|n| {
            let mut c = text_line(9, 72, 750, "Annual report 2026");
            c.push_str(&text_line(9, 300, 30, &format!("Page {n} of {count}")));
            c.push_str(&text_line(
                12,
                72,
                500,
                &format!("Body text number {n} in the middle of the page"),
            ));
            Page::new(&c)
        })
        .collect();
    let mut builder = PdfBuilder::new();
    add_pages(&mut builder, &pages);
    builder.object(1, "<< /Type /Catalog /Pages 2 0 R >>");
    builder.finish(1)
}

#[test]
fn a_running_header_and_page_numbers_are_detected() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("pdfium");
    let library = engine::library_path(&root);
    if !library.is_file() {
        eprintln!("skipping: {} not found", library.display());
        return;
    }
    let state = AppState::new(Engine::start(library));
    let dir = std::env::temp_dir().join(format!("sheer-hf-detect-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("running.pdf");
    std::fs::write(&path, pdf(5)).unwrap();
    let info = loop {
        match state.open_path(path.clone()).unwrap() {
            Some(info) => break info,
            None => std::thread::sleep(std::time::Duration::from_millis(10)),
        }
    };
    let found = state.detect_header_footer(info.id).unwrap();
    let _ = std::fs::remove_dir_all(&dir);
    assert_eq!((found.sampled, found.page_count), (5, 5));
    let header = found
        .items
        .iter()
        .find(|i| i.edge == DetectedEdge::Header)
        .expect("header");
    assert_eq!(header.text, "Annual report 2026");
    assert_eq!(
        (header.slot, header.kind, header.pages),
        (DetectedSlot::Left, DetectedKind::Text, 5)
    );
    assert!(
        header.rect.y < 60.0 && header.rect.x >= 70.0,
        "{:?}",
        header.rect
    );
    let number = found
        .items
        .iter()
        .find(|i| i.edge == DetectedEdge::Footer)
        .expect("page number");
    assert_eq!(number.kind, DetectedKind::PageNumber);
    assert_eq!(number.slot, DetectedSlot::Center);
    assert!(number.rect.y > 700.0, "{:?}", number.rect);
    assert_eq!(
        found.items.len(),
        2,
        "the body is no header: {:?}",
        found.items
    );
}

/// A page with a cream rectangle over its bottom band and one text line on it.
fn tinted() -> Vec<u8> {
    let mut c = String::from("0.98 0.9 0.7 rg 0 0 612 100 re f 0 g\n");
    c.push_str(&text_line(9, 72, 40, "Old footer text"));
    let mut builder = PdfBuilder::new();
    add_pages(&mut builder, &[Page::new(&c)]);
    builder.object(1, "<< /Type /Catalog /Pages 2 0 R >>");
    builder.finish(1)
}

#[test]
fn the_page_colour_under_a_box_is_sampled_from_a_small_render() {
    use sheer_lib::commands::hf_detect::sample_fill;
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("pdfium");
    let library = engine::library_path(&root);
    if !library.is_file() {
        eprintln!("skipping: {} not found", library.display());
        return;
    }
    let state = AppState::new(Engine::start(library));
    let dir = std::env::temp_dir().join(format!("sheer-hf-fill-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("tinted.pdf");
    std::fs::write(&path, tinted()).unwrap();
    let info = loop {
        match state.open_path(path.clone()).unwrap() {
            Some(info) => break info,
            None => std::thread::sleep(std::time::Duration::from_millis(10)),
        }
    };
    let raster = state
        .engine()
        .render_for_redaction(info.id, 0, 72.0, Vec::new())
        .unwrap();
    let _ = std::fs::remove_dir_all(&dir);
    // The footer band (page y 700..780, y down) is cream, the text on it is the minority; the top is white and snaps to white.
    let cream = sample_fill(&raster, 612.0, 792.0, [60.0, 730.0, 200.0, 760.0]).unwrap();
    assert!(
        cream.0[0] >= 245 && (225..=235).contains(&cream.0[1]) && (175..=185).contains(&cream.0[2]),
        "{cream:?}"
    );
    let white = sample_fill(&raster, 612.0, 792.0, [60.0, 20.0, 200.0, 40.0]).unwrap();
    assert_eq!(white.0, [255, 255, 255]);
    assert!(sample_fill(&raster, 612.0, 792.0, [f32::NAN, 0.0, 1.0, 1.0]).is_none());
}
#[test]
fn the_colour_is_found_under_the_box_on_a_turned_page() {
    use sheer_lib::commands::hf_detect::sample_fill;
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("pdfium");
    let library = engine::library_path(&root);
    if !library.is_file() {
        eprintln!("skipping: {} not found", library.display());
        return;
    }
    let state = AppState::new(Engine::start(library));
    let dir = std::env::temp_dir().join(format!("sheer-hf-fill90-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("turned.pdf");
    let mut builder = PdfBuilder::new();
    add_pages(
        &mut builder,
        &[Page::new("0.98 0.9 0.7 rg 0 0 612 100 re f\n").with("/Rotate 90")],
    );
    builder.object(1, "<< /Type /Catalog /Pages 2 0 R >>");
    std::fs::write(&path, builder.finish(1)).unwrap();
    let info = loop {
        match state.open_path(path.clone()).unwrap() {
            Some(info) => break info,
            None => std::thread::sleep(std::time::Duration::from_millis(10)),
        }
    };
    let raster = state
        .engine()
        .render_for_redaction(info.id, 0, 72.0, Vec::new())
        .unwrap();
    let _ = std::fs::remove_dir_all(&dir);
    // Page space is the unrotated page whatever /Rotate says: the raster is 612 x 792 and the cream band is at the bottom of it.
    assert_eq!((raster.width, raster.height), (612, 792));
    let cream = sample_fill(&raster, 612.0, 792.0, [60.0, 730.0, 200.0, 760.0]).unwrap();
    assert!((225..=235).contains(&cream.0[1]), "{cream:?}");
    let white = sample_fill(&raster, 612.0, 792.0, [60.0, 20.0, 200.0, 40.0]).unwrap();
    assert_eq!(white.0, [255, 255, 255]);
}
