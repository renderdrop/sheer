//! Editing existing text end to end (ADR-125, ARCHITECTURE §13): a same-font edit changes nothing outside the line's box, the new text
//! is what PDFium extracts, undo puts the original page back, and every refusal class (DESIGN E5) is found. The PDFs are generated here
//! (ADR-126). Skips when the PDFium library is not fetched (fails instead when `CI` is set).

#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use std::path::PathBuf;
use std::sync::OnceLock;

use serde_json::json;
use sheer_lib::commands::render::{RenderPriority, RenderRequest};
use sheer_lib::commands::AppState;
use sheer_lib::documents::{DocumentId, PageId};
use sheer_lib::engine::{self, Engine};
use sheer_lib::error::{AppError, ErrorCode};
use sheer_lib::model::command::DocCommand;
use sheer_lib::model::text_edit::{LineEditable, TextEditRefusal, TextLineInfo};
use support::{fixtures, PdfBuilder, TempFile};

fn state() -> Option<&'static AppState> {
    static STATE: OnceLock<Option<AppState>> = OnceLock::new();
    STATE
        .get_or_init(|| {
            let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("pdfium");
            let library = engine::library_path(&root);
            if library.is_file() {
                return Some(AppState::new(Engine::start(library)));
            }
            // In CI a missing library is a failure, never a silent pass.
            assert!(
                std::env::var_os("CI").is_none(),
                "PDFium is missing and CI is set: fetch it before the tests"
            );
            None
        })
        .as_ref()
}

/// An extra object: a dictionary body, or a stream with its dictionary entries and data.
enum Obj<'a> {
    Dict(u32, &'a str),
    Stream(u32, &'a str, &'a [u8]),
}

/// One US Letter page with `content`, Helvetica as `/F1` (WinAnsi, not embedded), `fonts` more entries of its font resources, `objects`
/// added as they are (ids from 20 on) and `catalog` entries.
fn pdf(content: &str, fonts: &str, objects: &[Obj], catalog: &str) -> Vec<u8> {
    let mut builder = PdfBuilder::new();
    builder
        .object(1, &format!("<< /Type /Catalog /Pages 2 0 R {catalog} >>"))
        .object(2, "<< /Type /Pages /Kids [10 0 R] /Count 1 >>")
        .object(
            3,
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
        )
        .object(
            10,
            &format!(
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 11 0 R \
                 /Resources << /Font << /F1 3 0 R {fonts} >> >> >>"
            ),
        )
        .stream(11, "", content.as_bytes());
    for object in objects {
        match object {
            Obj::Dict(id, body) => builder.object(*id, body),
            Obj::Stream(id, dict, data) => builder.stream(*id, dict, data),
        };
    }
    builder.finish(1)
}

fn open(state: &AppState, name: &str, bytes: &[u8]) -> (DocumentId, TempFile) {
    let file = TempFile::write(name, bytes);
    let id = state.open_path(file.0.clone()).unwrap().expect("loaded").id;
    (id, file)
}

fn edit(page: u32, rev: u32, line: u32, text: &str) -> DocCommand {
    serde_json::from_value(json!({
        "type": "editTextLine", "pageId": page, "key": {"rev": rev, "line": line},
        "text": text, "fit": "keepStart", "scope": "line"
    }))
    .unwrap()
}

fn lines(state: &AppState, id: DocumentId) -> Vec<TextLineInfo> {
    state
        .text_edit_lines(id, PageId::new(0))
        .unwrap_or_else(|error| panic!("text_edit_lines: {:?} {:?}", error.code(), error.reason()))
        .lines
}

fn line_with<'a>(all: &'a [TextLineInfo], text: &str) -> &'a TextLineInfo {
    all.iter()
        .find(|line| line.text.contains(text))
        .unwrap_or_else(|| {
            panic!(
                "no line with {text:?} in {:?}",
                all.iter().map(|l| &l.text).collect::<Vec<_>>()
            )
        })
}

const SCALE_BUCKET: i16 = 4;

/// The page as pixels at two device pixels per point: `(width, height, RGB)`.
fn render(state: &AppState, id: DocumentId) -> (usize, usize, Vec<u8>) {
    let frame = state
        .render_page(RenderRequest {
            doc_id: id,
            page_id: PageId::new(0),
            bucket: SCALE_BUCKET,
            tile: None,
            priority: RenderPriority::Visible,
            generation: 1,
        })
        .unwrap();
    let word = |at: usize| u32::from_le_bytes(frame[at..at + 4].try_into().unwrap()) as usize;
    let (width, height) = (word(8), word(12));
    let decoder = png::Decoder::new(std::io::Cursor::new(&frame[16..]));
    let mut reader = decoder.read_info().unwrap();
    let mut pixels = vec![0; reader.output_buffer_size().unwrap()];
    reader.next_frame(&mut pixels).unwrap();
    (width, height, pixels)
}

/// The box `[x0, y0, x1, y1]` (pixels) of the pixels that differ, if any.
fn diff_box(a: &(usize, usize, Vec<u8>), b: &(usize, usize, Vec<u8>)) -> Option<[usize; 4]> {
    assert_eq!((a.0, a.1), (b.0, b.1), "same frame size");
    let mut found: Option<[usize; 4]> = None;
    for y in 0..a.1 {
        for x in 0..a.0 {
            let at = (y * a.0 + x) * 3;
            if a.2[at..at + 3] != b.2[at..at + 3] {
                let [x0, y0, x1, y1] = found.unwrap_or([x, y, x, y]);
                found = Some([x0.min(x), y0.min(y), x1.max(x), y1.max(y)]);
            }
        }
    }
    found
}

/// Whether the pixel box lies inside the line's box (page points; the origin may be either bottom-left or top-left, so both are
/// tried) with a margin of 3 points.
fn inside_line_box(found: [usize; 4], line: &TextLineInfo, page_height: f64) -> bool {
    let scale = 2f64.powf(f64::from(SCALE_BUCKET) / 4.0);
    let b = &line.bounds;
    let (x0, x1) = (f64::from(b.x) - 3.0, f64::from(b.x + b.w) + 3.0);
    let top_left = (f64::from(b.y) - 3.0, f64::from(b.y + b.h) + 3.0);
    let bottom_left = (
        page_height - f64::from(b.y + b.h) - 3.0,
        page_height - f64::from(b.y) + 3.0,
    );
    let px = |v: usize| v as f64 / scale;
    let [fx0, fy0, fx1, fy1] = found;
    let columns = px(fx0) >= x0 && px(fx1 + 1) <= x1;
    let rows = |(y0, y1): (f64, f64)| px(fy0) >= y0 && px(fy1 + 1) <= y1;
    columns && (rows(top_left) || rows(bottom_left))
}

fn text_of(state: &AppState, id: DocumentId) -> String {
    state.text_layer(id, PageId::new(0)).unwrap().text
}

fn refused(error: &AppError, reason: &str) -> bool {
    error.code() == ErrorCode::UnsupportedFeature && error.reason() == Some(reason)
}

const TWO_LINES: &str = "BT /F1 24 Tf 72 700 Td (Hello world) Tj ET\n\
                         BT /F1 14 Tf 72 500 Td (Second line stays) Tj ET\n";

#[test]
fn a_same_font_edit_changes_only_the_line_and_undo_puts_the_page_back() {
    let Some(state) = state() else { return };
    let (id, _file) = open(state, "te-same.pdf", &pdf(TWO_LINES, "", &[], ""));
    let before = render(state, id);
    let original_text = text_of(state, id);
    let all = lines(state, id);
    let hello = line_with(&all, "Hello world");
    assert_eq!(
        hello.editable,
        LineEditable::Same,
        "Helvetica keeps its font"
    );
    assert_eq!(hello.key.rev, 0);

    let changes = state
        .apply_command(id, edit(0, hello.key.rev, hello.key.line, "Hello there"))
        .unwrap();
    assert_eq!(changes.history.undo_label.as_deref(), Some("editText.undo"));
    assert!(changes.warnings.is_empty(), "{:?}", changes.warnings);
    let slots = changes.pages.expect("the swapped slot");
    assert_eq!(slots[0].origin, "textEdited");

    // The extracted text is the new text, the other line is untouched.
    let text = text_of(state, id);
    assert!(text.contains("Hello there"), "{text:?}");
    assert!(!text.contains("Hello world"), "{text:?}");
    assert!(text.contains("Second line stays"), "{text:?}");
    // Everything that changed on the page is inside the line's box.
    let after = render(state, id);
    let found = diff_box(&before, &after).expect("the line looks different");
    assert!(
        inside_line_box(found, hello, after.1 as f64 / 2.0),
        "the render changed outside the line box: {found:?} vs {:?}",
        hello.bounds
    );

    // Undo: the file's page again, pixel for pixel and text for text.
    let undone = state.undo(id).unwrap();
    assert_eq!(undone.pages.expect("page list")[0].origin, "file");
    assert_eq!(render(state, id), before);
    assert_eq!(text_of(state, id), original_text);
    // The page has no edits left: the next key is of revision 0 and the line is the original one.
    let again = lines(state, id);
    assert_eq!(line_with(&again, "Hello world").key.rev, 0);
    // Redo brings the edit back.
    state.redo(id).unwrap();
    assert!(text_of(state, id).contains("Hello there"));
}

#[test]
fn a_line_over_the_limit_is_refused_before_any_replay() {
    let Some(state) = state() else { return };
    let (id, _file) = open(state, "te-long.pdf", &pdf(TWO_LINES, "", &[], ""));
    let all = lines(state, id);
    let hello = line_with(&all, "Hello world");
    let long = "a".repeat(2_001);
    let error = state
        .apply_command(id, edit(0, 0, hello.key.line, &long))
        .unwrap_err();
    assert_eq!(error.code(), ErrorCode::LimitExceeded);
}

#[test]
fn unchanged_text_is_no_step_and_a_stale_key_is_refused() {
    let Some(state) = state() else { return };
    let (id, _file) = open(state, "te-nostep.pdf", &pdf(TWO_LINES, "", &[], ""));
    let all = lines(state, id);
    let hello = line_with(&all, "Hello world");
    let unchanged = state
        .apply_command(id, edit(0, 0, hello.key.line, &hello.text))
        .unwrap();
    assert_eq!(unchanged.history.undo_label, None, "no undo step");
    assert!(unchanged.pages.is_none());

    state
        .apply_command(id, edit(0, 0, hello.key.line, "Hello again"))
        .unwrap();
    // The first edit made revision 1: the key of revision 0 is refused, the keys of the new list work, and each edit is its own step.
    let error = state
        .apply_command(id, edit(0, 0, hello.key.line, "Stale"))
        .unwrap_err();
    assert_eq!(error.code(), ErrorCode::InvalidArgument);
    let all = lines(state, id);
    let second = line_with(&all, "Second line stays");
    assert_eq!(second.key.rev, 1);
    state
        .apply_command(id, edit(0, 1, second.key.line, "Second line goes"))
        .unwrap();
    let text = text_of(state, id);
    assert!(
        text.contains("Hello again") && text.contains("Second line goes"),
        "{text:?}"
    );
    state.undo(id).unwrap();
    let text = text_of(state, id);
    assert!(
        text.contains("Hello again") && text.contains("Second line stays"),
        "{text:?}"
    );
    state.undo(id).unwrap();
    assert!(text_of(state, id).contains("Hello world"));
}

#[test]
fn a_signed_document_refuses() {
    let Some(state) = state() else { return };
    let (id, _file) = open(state, "te-signed.pdf", &fixtures::signed());
    // Probe, line list and apply refuse with the very same error: `read_only` `signed`.
    let wire =
        |error: AppError| serde_json::to_value(sheer_lib::error::UiError::from(error)).unwrap();
    let probe = wire(state.text_edit_probe(id, PageId::new(0), 0).unwrap_err());
    let list = wire(state.text_edit_lines(id, PageId::new(0)).unwrap_err());
    let apply = wire(
        state
            .apply_command(id, edit(0, 0, 0, "Changed"))
            .unwrap_err(),
    );
    assert_eq!(probe["code"], "read_only");
    assert_eq!(probe["params"]["what"], "signed");
    assert_eq!(probe, list);
    assert_eq!(probe, apply);
}

/// The only line of the page is refused for `reason`, and applying an edit to it says so.
fn assert_refused(name: &str, bytes: &[u8], reason: TextEditRefusal) {
    let Some(state) = state() else { return };
    let (id, _file) = open(state, name, bytes);
    let all = lines(state, id);
    let first = all
        .first()
        .unwrap_or_else(|| panic!("{name}: no line found"));
    assert_eq!(
        first.editable,
        LineEditable::No { reason },
        "{name}: {:?}",
        first.text
    );
    let error = state
        .apply_command(id, edit(0, 0, first.key.line, "Changed"))
        .unwrap_err();
    assert!(
        refused(&error, reason.as_str()),
        "{name}: {:?}",
        error.code()
    );
}

#[test]
fn invisible_ocr_text_is_refused() {
    assert_refused(
        "te-ocr.pdf",
        &pdf(
            "BT 3 Tr /F1 24 Tf 72 700 Td (Scanned words) Tj ET\n",
            "",
            &[],
            "",
        ),
        TextEditRefusal::Invisible,
    );
}

#[test]
fn clip_mode_text_is_refused() {
    assert_refused(
        "te-clip.pdf",
        &pdf(
            "BT 5 Tr /F1 24 Tf 72 700 Td (Clipped words) Tj ET\n",
            "",
            &[],
            "",
        ),
        TextEditRefusal::Clip,
    );
}

#[test]
fn type3_text_is_refused() {
    assert_refused(
        "te-type3.pdf",
        &pdf(
            "BT /F3 24 Tf 72 700 Td (aaaa) Tj ET\n",
            "/F3 20 0 R",
            &[
                Obj::Dict(
                    20,
                    "<< /Type /Font /Subtype /Type3 /FontBBox [0 0 1000 1000] /FontMatrix [0.001 0 0 0.001 0 0] \
                     /CharProcs << /a 21 0 R >> /Encoding << /Type /Encoding /Differences [97 /a] >> \
                     /FirstChar 97 /LastChar 97 /Widths [600] >>",
                ),
                Obj::Stream(21, "", b"600 0 d0 0 0 500 500 re f"),
            ],
            "",
        ),
        TextEditRefusal::Type3,
    );
}

#[test]
fn rotated_text_is_refused() {
    assert_refused(
        "te-rotated.pdf",
        &pdf(
            "BT /F1 24 Tf 0.9 0.4 -0.4 0.9 72 600 Tm (Rotated words) Tj ET\n",
            "",
            &[],
            "",
        ),
        TextEditRefusal::Vertical,
    );
}

#[test]
fn a_font_without_a_unicode_map_is_refused() {
    // Glyph names nobody knows and no /ToUnicode: PDFium and the encoding cannot say which characters these are.
    assert_refused(
        "te-cmap.pdf",
        &pdf(
            "BT /F4 24 Tf 72 700 Td (abcd) Tj ET\n",
            "/F4 20 0 R",
            &[Obj::Dict(
                20,
                "<< /Type /Font /Subtype /Type1 /BaseFont /Mystery /FirstChar 97 /LastChar 100 \
                 /Widths [500 500 500 500] /Encoding << /Type /Encoding /Differences [97 /g1 /g2 /g3 /g4] >> >>",
            )],
            "",
        ),
        TextEditRefusal::Cmap,
    );
}

#[test]
fn text_in_a_form_xobject_is_refused() {
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
             /Resources << /XObject << /Fm1 12 0 R >> >> >>",
        )
        .stream(11, "", b"/Fm1 Do\n")
        .stream(
            12,
            "/Type /XObject /Subtype /Form /BBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >>",
            b"BT /F1 24 Tf 72 700 Td (Words in a form) Tj ET\n",
        );
    assert_refused("te-form.pdf", &builder.finish(1), TextEditRefusal::InForm);
}

#[test]
fn text_under_actual_text_is_refused() {
    assert_refused(
        "te-actual.pdf",
        &pdf(
            "/Span << /ActualText (Something else) >> BDC BT /F1 24 Tf 72 700 Td (Replaced words) Tj ET EMC\n",
            "",
            &[],
            "",
        ),
        TextEditRefusal::ActualText,
    );
}

#[test]
fn a_line_of_too_many_pieces_is_refused() {
    let mut content = String::from("BT /F1 12 Tf 72 400 Td\n");
    for index in 0..80 {
        let letter = char::from(b'a' + (index % 26) as u8);
        content.push_str(&format!("({letter}) Tj 7 0 Td\n"));
    }
    content.push_str("ET\n");
    assert_refused(
        "te-complex.pdf",
        &pdf(&content, "", &[], ""),
        TextEditRefusal::TooComplex,
    );
}

#[test]
fn a_script_the_editor_cannot_set_is_refused() {
    let Some(state) = state() else { return };
    let (id, _file) = open(state, "te-script.pdf", &pdf(TWO_LINES, "", &[], ""));
    let all = lines(state, id);
    let hello = line_with(&all, "Hello world");
    // Typing Hebrew into a Latin line: the probe cannot know, the apply refuses.
    let error = state
        .apply_command(id, edit(0, 0, hello.key.line, "שלום"))
        .unwrap_err();
    assert!(refused(&error, "script"), "{:?}", error.code());
    assert!(
        text_of(state, id).contains("Hello world"),
        "nothing changed"
    );
}

#[test]
fn a_page_that_is_not_from_the_file_is_refused() {
    let Some(state) = state() else { return };
    let (id, _file) = open(state, "te-blank.pdf", &pdf(TWO_LINES, "", &[], ""));
    let command: DocCommand =
        serde_json::from_value(json!({"type": "insertBlankPage", "at": 1})).unwrap();
    let changes = state.apply_command(id, command).unwrap();
    let blank = changes.pages.expect("page list")[1].id;
    let error = state.text_edit_lines(id, blank).unwrap_err();
    assert!(refused(&error, "notFileSource"), "{:?}", error.code());
    let error = state.text_edit_probe(id, blank, 0).unwrap_err();
    assert!(refused(&error, "notFileSource"), "{:?}", error.code());
}

#[test]
fn edits_are_saved_incrementally_and_a_second_edit_saves_again() {
    use sheer_lib::commands::save::{SaveAck, SaveMode};
    let Some(state) = state() else { return };
    let original = pdf(TWO_LINES, "", &[], "");
    let (id, file) = open(state, "te-save.pdf", &original);
    let all = lines(state, id);
    let hello = line_with(&all, "Hello world");
    state
        .apply_command(id, edit(0, 0, hello.key.line, "Hello there"))
        .unwrap();
    let saved = state.save_in_place(id, SaveAck::default()).unwrap();
    assert_eq!(saved.mode, SaveMode::Incremental);
    let first = std::fs::read(&file.0).unwrap();
    assert!(
        first.starts_with(&original),
        "the original bytes are a prefix"
    );
    assert!(first.len() > original.len());
    let copy = TempFile::write("te-save-copy.pdf", &first);
    let reopened = state.open_path(copy.0.clone()).unwrap().expect("loaded").id;
    let text = text_of(state, reopened);
    assert!(
        text.contains("Hello there") && !text.contains("Hello world"),
        "{text:?}"
    );
    assert!(text.contains("Second line stays"), "{text:?}");

    // The saved page is a plain file page again; a second edit on it saves on top of the first.
    let all = lines(state, id);
    assert_eq!(all[0].key.rev, 0, "no edit left to replay");
    let second = line_with(&all, "Second line stays");
    state
        .apply_command(id, edit(0, 0, second.key.line, "Second line goes"))
        .unwrap();
    let saved = state.save_in_place(id, SaveAck::default()).unwrap();
    assert_eq!(saved.mode, SaveMode::Incremental);
    let after = std::fs::read(&file.0).unwrap();
    assert!(after.starts_with(&first));
    let copy = TempFile::write("te-save-copy2.pdf", &after);
    let reopened = state.open_path(copy.0.clone()).unwrap().expect("loaded").id;
    let text = text_of(state, reopened);
    assert!(
        text.contains("Hello there") && text.contains("Second line goes"),
        "{text:?}"
    );
}
