//! Images to PDF, rendered by the real PDFium (F15 A6, ADR-106 addendum): every page must show the whole picture, down to its last rows.
//! A decoder that stops early leaves the rest of the image flat grey. Skips when PDFium has not been fetched.

// Test code: panicking on a broken fixture is the point.
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use std::fs::File;
use std::path::PathBuf;
use std::sync::OnceLock;

use image::codecs::jpeg::JpegEncoder;
use image::ExtendedColorType;
use sheer_lib::content::image::prepare_bytes;
use sheer_lib::documents::DocumentId;
use sheer_lib::engine::{self, Engine, Priority, RenderKey, RenderSpec};
use sheer_lib::model::geometry::Rect;
use sheer_lib::pdfwrite::images_pdf::{build, ImagePage};
use support::TempFile;

fn engine() -> Option<&'static Engine> {
    static ENGINE: OnceLock<Option<Engine>> = OnceLock::new();
    ENGINE
        .get_or_init(|| {
            let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("pdfium");
            let library = engine::library_path(&root);
            if !library.is_file() {
                eprintln!("SKIPPED: PDFium is not fetched ({} not found); the images-to-PDF render test did not run", library.display());
                return None;
            }
            Some(Engine::start(library))
        })
        .as_ref()
}

/// A photo-like picture: smooth colour fields plus fine noise, so the entropy-coded scan is long.
fn picture(width: u32, height: u32) -> Vec<u8> {
    let mut seed = 12345u32;
    let mut px = Vec::with_capacity((width * height * 3) as usize);
    for y in 0..height {
        for x in 0..width {
            seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            let noise = (seed >> 24) as i32 % 24 - 12;
            let bottom = y * 4 > height * 3;
            let base = if bottom {
                [20, 40, 220]
            } else {
                [(x * 255 / width) as i32, (y * 255 / height) as i32, 90]
            };
            for c in base {
                px.push((c + noise).clamp(0, 255) as u8);
            }
        }
    }
    let mut out = Vec::new();
    JpegEncoder::new_with_quality(&mut out, 92)
        .encode(&px, width, height, ExtendedColorType::Rgb8)
        .unwrap();
    out
}

fn render(engine: &Engine, id: DocumentId, page: u32) -> (u32, u32, Vec<u8>) {
    let frame = engine
        .render(RenderSpec {
            key: RenderKey {
                id,
                page_index: page,
                bucket: 0,
                tile: None,
                thumbnail: false,
            },
            priority: Priority::Visible,
            generation: 1,
        })
        .unwrap();
    let width = u32::from_le_bytes(frame[8..12].try_into().unwrap());
    let height = u32::from_le_bytes(frame[12..16].try_into().unwrap());
    let png_bytes = &frame[16..];
    let mut reader = png::Decoder::new(std::io::Cursor::new(png_bytes))
        .read_info()
        .unwrap();
    let mut buffer = vec![0; reader.output_buffer_size().unwrap()];
    reader.next_frame(&mut buffer).unwrap();
    (width, height, buffer)
}

fn child_engine() -> Option<&'static Engine> {
    static ENGINE: OnceLock<Option<Engine>> = OnceLock::new();
    ENGINE
        .get_or_init(|| {
            let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("pdfium");
            let library = engine::library_path(&root);
            if !library.is_file() {
                eprintln!("SKIPPED: PDFium is not fetched ({} not found); the images-to-PDF child test did not run", library.display());
                return None;
            }
            Some(Engine::start_process(library, PathBuf::from(env!("CARGO_BIN_EXE_sheer")), None))
        })
        .as_ref()
}

/// The two render tests decode four big JPEGs each; run in parallel on a slow CI runner (debug build, 3 cores) the in-process
/// open could hit the engine deadline. They take turns.
static SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[test]
fn big_jpegs_render_to_their_last_rows_in_process() {
    let _turn = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(engine) = engine() {
        check(engine, 9001);
    }
}

/// The app's path: PDFium in the engine child reads the file through the parent (a read that ended at a block border used to
/// come back short, and the rest of a big JPEG was grey).
#[test]
fn big_jpegs_render_to_their_last_rows_through_the_engine_child() {
    let _turn = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(engine) = child_engine() {
        check(engine, 9002);
    }
}

fn check(engine: &Engine, doc: u32) {
    let sizes = [(4000, 3000), (3000, 4000), (1200, 800), (4096, 4096)];
    let pages: Vec<ImagePage> = sizes
        .iter()
        .map(|&(w, h)| ImagePage {
            image: prepare_bytes(&picture(w, h)).unwrap(),
            size_pt: [400.0, 400.0],
            place: Rect {
                x: 0.0,
                y: 0.0,
                w: 400.0,
                h: 400.0,
            },
        })
        .collect();
    let pdf = build(&pages, "Sheer").unwrap();
    let file = TempFile::write("images-render.pdf", &pdf);
    let id: DocumentId = serde_json::from_value(serde_json::json!(doc)).unwrap();
    assert_eq!(
        engine
            .open(id, File::open(&file.0).unwrap(), |_| true)
            .unwrap_or_else(|error| panic!("open failed: {error:?}")),
        sizes.len() as u32
    );
    for (page, &(w, h)) in sizes.iter().enumerate() {
        let (width, height, rgb) = render(engine, id, page as u32);
        assert_eq!((width, height), (400, 400));
        let at = |x: usize, y: usize| {
            let i = (y * width as usize + x) * 3;
            [rgb[i], rgb[i + 1], rgb[i + 2]]
        };
        // The last rows are the blue band (the bottom quarter of every source picture): not grey, not white.
        let p = at(200, 396);
        assert!(
            p[2] > 150 && p[0] < 90,
            "page {page} ({w}x{h}): bottom row is {p:?}"
        );
    }
    engine.close(id).unwrap();
}
