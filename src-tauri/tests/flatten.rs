//! Flatten (ADR-041 §4, M4 package S2): the appearances of widgets are burned into the page, the widgets and the form go, the file
//! opens again in PDFium with the text still there (text layer), also on a rotated page, and the hostile corpus never panics it.
//! Skips the PDFium parts, like the other engine tests, when the library is not fetched.

// Test code: panicking on a broken fixture is the point.
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use std::path::PathBuf;
use std::sync::mpsc;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use sheer_lib::commands::jobs::{EventSink, JobEvent, JobRegistry};
use sheer_lib::commands::AppState;
use sheer_lib::documents::{DocumentId, DocumentInfo, PageId};
use sheer_lib::engine::{self, Engine};
use sheer_lib::error::ErrorCode;
use sheer_lib::pdfwrite::flatten::{flatten, FlattenOptions, FlattenScope};
use sheer_lib::pdfwrite::produce::{Unattended, Warning};
use support::{malformed, PdfBuilder};

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

struct Scratch(PathBuf);

impl Scratch {
    fn new(name: &str) -> Self {
        let path = std::env::temp_dir().join(format!("sheer-flat-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// A one page form: a text field whose appearance says "Ada Lovelace", a checkbox on ("Checked" is its on appearance, `/Off` is empty),
/// a highlight annotation with an appearance, and a link. `rotate` is the page's `/Rotate`.
fn form(rotate: u16) -> Vec<u8> {
    let mut pdf = PdfBuilder::new();
    pdf.object(
        1,
        "<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [100 0 R 101 0 R] /NeedAppearances true >> /Perms << /DocMDP 9 0 R >> >>",
    )
    .object(2, "<< /Type /Pages /Kids [10 0 R] /Count 1 >>")
    .object(3, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>")
    .object(
        10,
        &format!(
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Rotate {rotate} /Annots [100 0 R 101 0 R 102 0 R 103 0 R] \
             /Contents 11 0 R /Resources << /Font << /F1 3 0 R >> >> >>"
        ),
    )
    .stream(11, "", b"BT /F1 24 Tf 72 740 Td (Form) Tj ET")
    .object(
        100,
        "<< /Type /Annot /Subtype /Widget /FT /Tx /T (name) /V (Ada Lovelace) /Rect [72 700 272 720] /P 10 0 R /F 4 \
         /AP << /N 110 0 R >> >>",
    )
    .stream(
        110,
        "/Type /XObject /Subtype /Form /BBox [0 0 200 20] /Resources << /Font << /Helv 3 0 R >> >>",
        b"/Tx BMC q BT /Helv 12 Tf 2 5 Td (Ada Lovelace) Tj ET Q EMC",
    )
    .object(
        101,
        "<< /Type /Annot /Subtype /Widget /FT /Btn /T (agree) /V /Yes /AS /Yes /Rect [72 650 92 670] /P 10 0 R /F 4 \
         /AP << /N << /Yes 111 0 R /Off 112 0 R >> >> >>",
    )
    .stream(
        111,
        "/Type /XObject /Subtype /Form /BBox [0 0 20 20] /Resources << /Font << /Helv 3 0 R >> >>",
        b"BT /Helv 8 Tf 1 6 Td (Checked) Tj ET",
    )
    .stream(112, "/Type /XObject /Subtype /Form /BBox [0 0 20 20]", b"")
    .object(
        102,
        "<< /Type /Annot /Subtype /Highlight /Rect [72 600 272 620] /QuadPoints [72 620 272 620 72 600 272 600] /C [1 1 0] /F 4 \
         /AP << /N 113 0 R >> >>",
    )
    .stream(
        113,
        "/Type /XObject /Subtype /Form /BBox [72 600 272 620] /Resources << /Font << /Helv 3 0 R >> >>",
        b"BT /Helv 10 Tf 80 605 Td (Marked) Tj ET",
    )
    .object(
        103,
        "<< /Type /Annot /Subtype /Link /Rect [0 0 50 50] /Border [0 0 0] /A << /S /URI /URI (https://example.org/) >> >>",
    )
    .object(9, "<< /Type /Sig /Filter /Adobe.PPKLite >>");
    pdf.finish(1)
}

struct Collect(Mutex<mpsc::Sender<JobEvent>>);

impl EventSink for Collect {
    fn send(&self, event: JobEvent) {
        let _ = self.0.lock().unwrap().send(event);
    }
}

fn open(state: &AppState, scratch: &Scratch, name: &str, bytes: &[u8]) -> DocumentInfo {
    let path = scratch.0.join(name);
    std::fs::write(&path, bytes).unwrap();
    state.open_path(path).unwrap().expect("loaded")
}

fn text_of(state: &AppState, id: DocumentId) -> String {
    state.text_layer(id, PageId::new(0)).unwrap().text
}

fn flat(bytes: &[u8], scope: FlattenScope) -> sheer_lib::pdfwrite::produce::Output {
    flatten(bytes, scope, &Unattended).unwrap()
}

#[test]
fn flattening_a_form_keeps_the_values_visible_and_removes_the_widgets() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("form");
    let before = open(state, &scratch, "before.pdf", &form(0));
    assert!(before.flags.has_forms);

    let out = flat(&form(0), FlattenScope::Forms);
    assert_eq!(out.pages, 1);
    assert_eq!(out.warnings, vec![Warning::SignaturesRemoved]);
    let info = open(state, &scratch, "after.pdf", &out.bytes);
    let id = info.id;
    assert!(!info.flags.has_forms, "no AcroForm is left");
    let text = text_of(state, id);
    assert!(text.contains("Form"), "{text:?}");
    assert!(text.contains("Ada Lovelace"), "{text:?}");
    assert!(text.contains("Checked"), "{text:?}");
    // The markup annotation is not part of a forms-only flatten, and the link stays.
    assert!(!text.contains("Marked"), "{text:?}");
    let annotations = state.list_annotations(id, PageId::new(0)).unwrap();
    assert!(!annotations.is_empty(), "highlight stays");
    // The old field values are not in the new file.
    assert!(!String::from_utf8_lossy(&out.bytes).contains("/Widget"));
    assert!(!String::from_utf8_lossy(&out.bytes).contains("/AcroForm"));
}

#[test]
fn flattening_annotations_too_burns_the_markup_and_keeps_links() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("all");
    let out = flat(&form(0), FlattenScope::FormsAndAnnotations);
    let id = open(state, &scratch, "all.pdf", &out.bytes).id;
    let text = text_of(state, id);
    assert!(text.contains("Marked"), "{text:?}");
    assert!(text.contains("Ada Lovelace"), "{text:?}");
    assert!(!String::from_utf8_lossy(&out.bytes).contains("/Highlight"));
    assert!(String::from_utf8_lossy(&out.bytes).contains("/Link"));
}

#[test]
fn a_rotated_page_keeps_its_rotation_and_its_text() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("rotated");
    for rotate in [90u16, 180, 270] {
        let out = flat(&form(rotate), FlattenScope::Forms);
        let id = open(state, &scratch, &format!("r{rotate}.pdf"), &out.bytes).id;
        let layer = state.text_layer(id, PageId::new(0)).unwrap();
        assert!(
            layer.text.contains("Ada Lovelace"),
            "{rotate}: {:?}",
            layer.text
        );
        assert_eq!(layer.rotation, rotate, "{rotate}");
    }
}

#[test]
fn the_fixture_form_flattens_to_a_page_without_a_form() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("fixture");
    let source =
        std::fs::read(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/form.pdf"))
            .unwrap();
    // The fixture's field has no appearance: nothing to burn, but the field and the form are gone and the page text stays.
    let out = flat(&source, FlattenScope::Forms);
    let info = open(state, &scratch, "fixture.pdf", &out.bytes);
    let id = info.id;
    assert!(!info.flags.has_forms);
    assert!(text_of(state, id).contains("Form"));
}

#[test]
fn the_job_writes_a_new_file_opens_it_and_leaves_the_original_alone() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("job");
    let source = form(0);
    let id = open(state, &scratch, "src.pdf", &source).id;
    let jobs = Arc::new(JobRegistry::new());
    let (sender, receiver) = mpsc::channel();
    let sink: Arc<dyn EventSink> = Arc::new(Collect(Mutex::new(sender)));
    let target = scratch.0.join("flat.pdf");
    state
        .start_flatten(
            &jobs,
            id,
            FlattenOptions {
                scope: FlattenScope::Forms,
            },
            &target,
            sink,
        )
        .unwrap();
    let event = loop {
        match receiver.recv_timeout(Duration::from_secs(60)).unwrap() {
            JobEvent::Progress { .. } => {}
            other => break other,
        }
    };
    let JobEvent::Done {
        outputs, opened, ..
    } = event
    else {
        panic!("expected done, got {event:?}");
    };
    assert_eq!(outputs, 1);
    let opened = opened.expect("opened");
    assert!(!opened.flags.has_forms);
    assert!(text_of(state, opened.id).contains("Ada Lovelace"));
    assert_eq!(std::fs::read(scratch.0.join("src.pdf")).unwrap(), source);
    // The open original is not a target.
    let (sender, _keep) = mpsc::channel();
    let sink: Arc<dyn EventSink> = Arc::new(Collect(Mutex::new(sender)));
    let error = state
        .start_flatten(
            &jobs,
            id,
            FlattenOptions {
                scope: FlattenScope::Forms,
            },
            &scratch.0.join("src.pdf"),
            sink,
        )
        .unwrap_err();
    assert_eq!(error.code(), ErrorCode::IoInUse);
}

#[test]
fn the_hostile_corpus_never_panics_flatten() {
    for (name, bytes) in malformed::all() {
        for scope in [FlattenScope::Forms, FlattenScope::FormsAndAnnotations] {
            let outcome =
                std::panic::catch_unwind(|| flatten(&bytes, scope, &Unattended).map(|_| ()));
            let result = outcome.unwrap_or_else(|_| panic!("{name} panicked flatten"));
            if let Err(error) = result {
                assert_ne!(error.code(), ErrorCode::Internal, "{name}");
            }
        }
    }
}
