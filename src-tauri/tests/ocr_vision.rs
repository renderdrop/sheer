//! macOS OCR round trips (ADR-137 item 2): generated text pages are drawn by PDFium and recognized through the real `sheer-ocr`
//! sidecar (Apple Vision). Run only with `SHEER_OCR=1` and `SHEER_OCR_SIDECAR=<path to the built sidecar>` (the macOS CI job);
//! everywhere else they return at once.

// Test code: panicking on a broken fixture is the point.
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use std::collections::BTreeMap;
use std::fs::File;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

use sheer_lib::documents::Registry;

use sheer_lib::engine::{self, Engine, SearchSpec};
use sheer_lib::export::snapshot::EngineDocRef;
use sheer_lib::ocr::backend::{self, BackendKind, ChildClient, OcrError};
use sheer_lib::ocr::{limits, OcrLine, OcrPageLayer, OcrWord};
use sheer_lib::pdfwrite::ocr_layer::{apply_ocr_layers, PageGeom};
use sheer_lib::pdfwrite::redact::RasterPixels;
use support::fixtures::{self, Page};
use support::PdfBuilder;
use unicode_normalization::UnicodeNormalization;

/// `None` unless this is the macOS CI job; else the sidecar path.
fn sidecar() -> Option<PathBuf> {
    if std::env::var("SHEER_OCR").as_deref() != Ok("1") {
        return None;
    }
    Some(PathBuf::from(
        std::env::var("SHEER_OCR_SIDECAR").expect("SHEER_OCR_SIDECAR"),
    ))
}

/// PDFium is not thread-safe and the test harness runs tests in parallel: one engine for the whole file, and one test at a time
/// holds it (two engines binding the library at once crashed the process with SIGSEGV on macOS CI).
fn start_engine() -> (MutexGuard<'static, ()>, &'static Engine) {
    static SERIAL: Mutex<()> = Mutex::new(());
    static ENGINE: OnceLock<Engine> = OnceLock::new();
    let serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let engine = ENGINE.get_or_init(|| {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("pdfium");
        let library = engine::library_path(&root);
        assert!(library.is_file(), "PDFium is not fetched");
        Engine::start(library)
    });
    (serial, engine)
}

fn text_pdf(lines: &[&str]) -> Vec<u8> {
    let mut content = String::new();
    for (line, text) in lines.iter().enumerate() {
        content.push_str(&support::text_line(18, 72, 700 - 40 * line as u32, text));
    }
    let mut builder = PdfBuilder::new();
    fixtures::add_pages(&mut builder, &[Page::new(&content)]);
    builder.object(1, "<< /Type /Catalog /Pages 2 0 R >>");
    builder.finish(1)
}

/// Renders page 0 of `pdf` for OCR: (gray pixels, width, height).
fn render_gray(engine: &Engine, pdf: &[u8]) -> (Vec<u8>, u32, u32) {
    let id = engine.open_snapshot(pdf.to_vec().into()).unwrap();
    let page = engine
        .render_for_ocr(EngineDocRef::Snapshot(id), 0, 300.0, limits::MAX_SIDE_PX)
        .unwrap();
    engine.close_snapshot(id).unwrap();
    let RasterPixels::Gray8(gray) = page.pixels else {
        panic!("not gray");
    };
    (gray, page.width, page.height)
}

fn words_of(layer: &OcrPageLayer) -> Vec<String> {
    layer
        .lines
        .iter()
        .flat_map(|l| l.words.iter().map(|w| w.text.clone()))
        .collect()
}

fn normalized(word: &str) -> String {
    word.trim_matches(|c: char| !c.is_alphanumeric())
        .nfc()
        .collect::<String>()
        .to_lowercase()
}

#[test]
fn vision_reads_a_generated_page_through_the_sidecar() {
    let Some(sidecar) = sidecar() else { return };
    let (_serial, engine) = start_engine();
    let pdf = text_pdf(&["The quick brown fox jumps", "over the lazy dog today"]);
    let (gray, w, h) = render_gray(engine, &pdf);

    let mut client = ChildClient::new(sidecar);
    let layer = client
        .recognize(&gray, w, h, "en-US", limits::PAGE_TIMEOUT)
        .unwrap();
    let words = words_of(&layer);
    for expected in ["quick", "brown", "jumps", "lazy", "dog"] {
        assert!(
            words.iter().any(|w| w.eq_ignore_ascii_case(expected)),
            "{expected} not found in {words:?}"
        );
    }
    for word in layer.lines.iter().flat_map(|l| &l.words) {
        let [x0, y0, x1, y1] = word.rect;
        assert!(x0 >= 0.0 && y0 >= 0.0 && x1 <= w as f32 && y1 <= h as f32);
        assert!(x1 > x0 && y1 > y0);
    }

    // The same sidecar answers a second page.
    let blank = vec![255u8; 64 * 64];
    assert!(client
        .recognize(&blank, 64, 64, "en-US", limits::PAGE_TIMEOUT)
        .is_ok());
}

#[test]
fn vision_reads_german_umlauts_and_sharp_s() {
    let Some(sidecar) = sidecar() else { return };
    let (_serial, engine) = start_engine();
    let expected = ["Größe", "Prüfung", "Straße", "Änderung", "Übung", "schön"];
    let pdf = text_pdf(&[
        "Größe und Prüfung",
        "Straße und Änderung",
        "Übung ist schön",
    ]);
    let (gray, w, h) = render_gray(engine, &pdf);
    let mut client = ChildClient::new(sidecar);
    let layer = client
        .recognize(&gray, w, h, "de-DE", limits::PAGE_TIMEOUT)
        .unwrap();
    let words: Vec<String> = words_of(&layer).iter().map(|w| normalized(w)).collect();
    let found = expected
        .iter()
        .filter(|e| words.contains(&normalized(e)))
        .count();
    assert!(
        found * 5 >= expected.len() * 4,
        "only {found} of {} found in {words:?}",
        expected.len()
    );
}

#[test]
fn vision_capabilities_offer_both_languages_and_refuse_others() {
    let Some(sidecar) = sidecar() else { return };
    let caps = backend::capabilities();
    assert_eq!(caps.backend, BackendKind::Vision);
    assert!(caps.has("de-DE"), "{caps:?}");
    assert!(caps.has("en-US"), "{caps:?}");
    assert!(!caps.has("fr-FR"));
    let mut client = ChildClient::new(sidecar);
    let blank = vec![255u8; 64 * 64];
    assert!(client
        .recognize(&blank, 64, 64, "fr-FR", limits::PAGE_TIMEOUT)
        .is_err());
    assert!(client
        .recognize(&blank, 64, 64, "../x", limits::PAGE_TIMEOUT)
        .is_err());
    // The refusal costs nothing: an allowed language still works.
    assert!(client
        .recognize(&blank, 64, 64, "de-DE", limits::PAGE_TIMEOUT)
        .is_ok());
}

#[test]
fn vision_layer_is_saved_incrementally_and_found_by_search() {
    let Some(sidecar) = sidecar() else { return };
    let (_serial, engine) = start_engine();
    let original = text_pdf(&["The quick brown fox jumps", "over the lazy dog today"]);
    let (gray, w, h) = render_gray(engine, &original);
    let mut client = ChildClient::new(sidecar);
    let layer = client
        .recognize(&gray, w, h, "en-US", limits::PAGE_TIMEOUT)
        .unwrap();

    // Pixels to points: the generated page is 612 x 792 (crop box, no rotation).
    let geom = PageGeom {
        crop: [0.0, 0.0, 612.0, 792.0],
        rotate: 0,
    };
    let (dw, dh) = geom.display_size();
    let (sx, sy) = (dw / w as f32, dh / h as f32);
    let points = OcrPageLayer {
        lang: layer.lang.clone(),
        angle_deg: layer.angle_deg,
        dpi: 300.0,
        lines: layer
            .lines
            .iter()
            .map(|l| OcrLine {
                words: l
                    .words
                    .iter()
                    .map(|wd| OcrWord {
                        text: wd.text.clone(),
                        rect: [
                            wd.rect[0] * sx,
                            wd.rect[1] * sy,
                            wd.rect[2] * sx,
                            wd.rect[3] * sy,
                        ],
                    })
                    .collect(),
            })
            .collect(),
    };
    let mut layers = BTreeMap::new();
    layers.insert(0u32, points);
    let saved = apply_ocr_layers(original.clone(), &layers, true).unwrap();
    assert!(saved.len() > original.len());
    assert_eq!(&saved[..original.len()], &original[..], "not a prefix");

    let dir = std::env::temp_dir().join(format!("sheer-ocr-vision-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("ocr.pdf");
    std::fs::write(&path, &saved).unwrap();
    let registry = Registry::new();
    let id = registry.register(path.clone()).unwrap();
    let pages = engine
        .open(id, File::open(&path).unwrap(), |_| true)
        .unwrap();
    assert_eq!(pages, 1);
    for token in ["quick", "brown", "jumps", "lazy"] {
        let spec = Arc::new(SearchSpec {
            text: token.into(),
            match_case: false,
            whole_word: false,
        });
        let hits = engine.search_page(id, 0, spec, 5).unwrap();
        assert!(!hits.is_empty(), "{token} not found by search");
    }
    let _ = engine.close(id);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn vision_killed_sidecar_fails_only_that_page_and_restarts() {
    let Some(sidecar) = sidecar() else { return };
    let (_serial, engine) = start_engine();
    let pdf = text_pdf(&["The quick brown fox jumps", "over the lazy dog today"]);
    let (gray, w, h) = render_gray(engine, &pdf);
    let mut client = ChildClient::new(sidecar);
    client
        .recognize(&gray, w, h, "en-US", limits::PAGE_TIMEOUT)
        .unwrap();
    assert_eq!(client.spawned, 1);

    // Kill the child while it works on the next page (or, if it is faster, just after).
    let pid = client.child_id().expect("a running sidecar");
    let outcome = std::thread::scope(|scope| {
        scope.spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(30));
            let _ = std::process::Command::new("kill")
                .args(["-9", &pid.to_string()])
                .status();
        });
        client.recognize(&gray, w, h, "en-US", limits::PAGE_TIMEOUT)
    });
    if let Err(e) = &outcome {
        assert!(
            matches!(e, OcrError::ChildDied | OcrError::BadReply(_)),
            "{e}"
        );
    }
    // Make sure the kill has landed; the next page runs in a fresh child.
    std::thread::sleep(std::time::Duration::from_millis(200));
    let next = client
        .recognize(&gray, w, h, "en-US", limits::PAGE_TIMEOUT)
        .unwrap();
    assert!(words_of(&next).iter().any(|w| normalized(w) == "quick"));
    assert!(client.spawned >= 2, "no restart: {}", client.spawned);
}
