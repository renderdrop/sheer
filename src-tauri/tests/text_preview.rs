//! The live preview of an edit (ADR-129 section 1): a PNG of the line's region from a draft text, a fallback character reported with its
//! face, an overflow in points, a stale generation dropped, and no change to the document (no undo step, same text layer). The PDFs are
//! generated here (ADR-126). Skips when the PDFium library is not fetched (fails instead when `CI` is set).

#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use std::path::PathBuf;
use std::sync::OnceLock;

use sheer_lib::commands::text_preview::{PreviewRequest, TextPreview};
use sheer_lib::commands::AppState;
use sheer_lib::documents::{DocumentId, PageId};
use sheer_lib::engine::{self, Engine};
use sheer_lib::error::ErrorCode;
use sheer_lib::model::text_edit::{FallbackFace, LineKey, TextFit, TextLineInfo, TextScope};
use support::{PdfBuilder, TempFile};

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
                std::env::var_os("CI").is_none(),
                "PDFium is missing and CI is set: fetch it before the tests"
            );
            None
        })
        .as_ref()
}

const CONTENT: &str = "BT /F1 24 Tf 72 700 Td (Hello world) Tj ET\n\
                       BT /F1 14 Tf 72 500 Td (Second line stays) Tj ET\n\
                       BT /F1 14 Tf 300 500 Td (Right) Tj ET\n";

fn pdf() -> Vec<u8> {
    let mut builder = PdfBuilder::new();
    builder
        .object(1, "<< /Type /Catalog /Pages 2 0 R >>")
        .object(2, "<< /Type /Pages /Kids [10 0 R] /Count 1 >>")
        .object(
            3,
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
        )
        .object(
            10,
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 11 0 R \
             /Resources << /Font << /F1 3 0 R >> >> >>",
        )
        .stream(11, "", CONTENT.as_bytes());
    builder.finish(1)
}

fn open(state: &AppState, name: &str) -> (DocumentId, TempFile) {
    let file = TempFile::write(name, &pdf());
    let id = state.open_path(file.0.clone()).unwrap().expect("loaded").id;
    (id, file)
}

fn line_with(state: &AppState, id: DocumentId, text: &str) -> TextLineInfo {
    state
        .text_edit_lines(id, PageId::new(0))
        .unwrap()
        .lines
        .into_iter()
        .find(|line| line.text.contains(text))
        .unwrap_or_else(|| panic!("no line with {text:?}"))
}

fn request(key: LineKey, text: &str, generation: u32) -> PreviewRequest {
    PreviewRequest {
        key,
        text: text.to_owned(),
        fit: TextFit::KeepStart,
        scope: TextScope::Line,
        generation,
        scale: 2.0,
    }
}

fn decode(preview: &TextPreview) -> (u32, u32, Vec<u8>) {
    let decoder = png::Decoder::new(std::io::Cursor::new(&preview.png));
    let mut reader = decoder.read_info().unwrap();
    let mut pixels = vec![0; reader.output_buffer_size().unwrap()];
    let info = reader.next_frame(&mut pixels).unwrap();
    (info.width, info.height, pixels)
}

#[test]
fn a_preview_draws_the_region_and_changes_nothing() {
    let Some(state) = state() else { return };
    let (id, _file) = open(state, "tp-region.pdf");
    let hello = line_with(state, id, "Hello world");
    let page = PageId::new(0);
    let text_before = state.text_layer(id, page).unwrap().text;

    // Unchanged text: the stored page, no overflow, no fallback.
    let same = state
        .text_edit_preview(id, page, request(hello.key, &hello.text, 1))
        .unwrap();
    assert_eq!(same.meta.generation, 1);
    assert_eq!(same.meta.overflow_pt, 0.0);
    assert_eq!(same.meta.fallback, None);
    let (width, height, _) = decode(&same);
    assert!(width > 0 && height > 0);
    let rect = same.meta.rect;
    assert!(rect.x <= hello.bounds.x && rect.x + rect.w >= hello.bounds.x + hello.bounds.w);
    assert!(rect.y <= hello.bounds.y && rect.y + rect.h >= hello.bounds.y + hello.bounds.h);
    assert!(
        (f64::from(width) - f64::from(rect.w * same.meta.px_per_pt)).abs() <= 1.5,
        "the picture is the region at its scale"
    );

    // A draft looks different, and the document is as it was.
    let changed = state
        .text_edit_preview(id, page, request(hello.key, "Hello there", 2))
        .unwrap();
    assert_eq!(changed.meta.rect, same.meta.rect);
    assert_ne!(decode(&changed).2, decode(&same).2);
    assert_eq!(state.text_layer(id, page).unwrap().text, text_before);
    // No edit was made: the page keeps revision 0 and its own source, so there is nothing to undo.
    assert_eq!(line_with(state, id, "Hello world").key.rev, 0);
}

#[test]
fn a_character_the_font_lacks_is_reported_with_its_face() {
    let Some(state) = state() else { return };
    let (id, _file) = open(state, "tp-fallback.pdf");
    let hello = line_with(state, id, "Hello world");
    let preview = state
        .text_edit_preview(
            id,
            PageId::new(0),
            request(hello.key, "Hello \u{3a9}mega", 1),
        )
        .unwrap();
    let fallback = preview.meta.fallback.expect("a substitute face");
    assert_eq!(fallback.face, FallbackFace::Sans);
    // The substitute draws the whole run, so the characters of the run are named, the missing one among them.
    assert!(
        fallback.chars.contains(&"\u{3a9}".to_owned()),
        "{:?}",
        fallback.chars
    );
}

#[test]
fn text_past_the_room_reports_the_overflow() {
    let Some(state) = state() else { return };
    let (id, _file) = open(state, "tp-overflow.pdf");
    let hello = line_with(state, id, "Hello world");
    let page = PageId::new(0);
    let long = "W".repeat(60);
    let preview = state
        .text_edit_preview(id, page, request(hello.key, &long, 1))
        .unwrap();
    assert!(
        preview.meta.overflow_pt > 100.0,
        "{}",
        preview.meta.overflow_pt
    );
    // The right edge of the page bounds the region.
    assert!(preview.meta.rect.x + preview.meta.rect.w <= 612.5);

    // Next to a neighbour on the same baseline the room is the gap.
    let second = line_with(state, id, "Second line stays");
    let short = state
        .text_edit_preview(id, page, request(second.key, "Second line stays here", 2))
        .unwrap();
    assert!(short.meta.overflow_pt >= 0.0);
    let squeezed = state
        .text_edit_preview(id, page, request(second.key, "Second", 3))
        .unwrap();
    assert_eq!(squeezed.meta.overflow_pt, 0.0);
}

#[test]
fn stale_generations_and_bad_input_are_refused() {
    let Some(state) = state() else { return };
    let (id, _file) = open(state, "tp-stale.pdf");
    let hello = line_with(state, id, "Hello world");
    let page = PageId::new(0);
    state
        .text_edit_preview(id, page, request(hello.key, "Hello a", 10))
        .unwrap();
    let stale = state
        .text_edit_preview(id, page, request(hello.key, "Hello b", 9))
        .unwrap_err();
    assert_eq!(stale.code(), ErrorCode::Cancelled);

    let long = "a".repeat(2_001);
    let error = state
        .text_edit_preview(id, page, request(hello.key, &long, 11))
        .unwrap_err();
    assert_eq!(error.code(), ErrorCode::LimitExceeded);
    let mut bad = request(hello.key, "x", 12);
    bad.scale = 100.0;
    assert_eq!(
        state.text_edit_preview(id, page, bad).unwrap_err().code(),
        ErrorCode::InvalidArgument
    );
    let wrong_key = LineKey {
        rev: 5,
        line: hello.key.line,
    };
    assert_eq!(
        state
            .text_edit_preview(id, page, request(wrong_key, "x", 13))
            .unwrap_err()
            .code(),
        ErrorCode::InvalidArgument
    );
}
