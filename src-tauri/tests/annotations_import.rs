//! The annotations of a real PDF through the real PDFium: what `list_annotations` reads into the model (`engine::import`), and that the
//! commands then work on it. The unit tests of `model` and `commands::annotations` pin the rules down with an engine that is a double;
//! this shows what PDFium really says becomes what they expect. Skips, like the other engine tests, when the library is not fetched.

// Test code: panicking on a broken fixture is the point (clippy.toml only exempts `#[test]` functions, not helpers).
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use std::path::PathBuf;
use std::sync::OnceLock;

use sheer_lib::commands::AppState;
use sheer_lib::documents::PageId;
use sheer_lib::engine::{self, Engine};
use sheer_lib::model::annotation::{Annotation, AnnotationBody, Rgb, Sync};
use sheer_lib::model::command::DocCommand;
use support::fixtures::{add_pages, Page};
use support::{PdfBuilder, TempFile};

fn state() -> Option<&'static AppState> {
    static STATE: OnceLock<Option<AppState>> = OnceLock::new();
    STATE
        .get_or_init(|| {
            let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("pdfium");
            let library = engine::library_path(&root);
            if library.is_file() {
                Some(AppState::new(Engine::start(library)))
            } else {
                eprintln!(
                    "skipping annotation import test: {} not found",
                    library.display()
                );
                None
            }
        })
        .as_ref()
}

/// One US Letter page with one annotation of each kind the import knows, a link and a stamp. Objects 100 and on.
fn annotated() -> Vec<u8> {
    let mut builder = PdfBuilder::new();
    let ids: Vec<String> = (100..110).map(|id| format!("{id} 0 R")).collect();
    add_pages(
        &mut builder,
        &[Page::new("").with(&format!("/Annots [{}]", ids.join(" ")))],
    );
    let page = support::fixtures::page_id(0);
    let objects = [
        "/Subtype /Highlight /Rect [72 700 172 712] /QuadPoints [72 712 172 712 72 700 172 700] /C [1 1 0] /Contents (Marked) /T (Ada) /NM (hl-1) /M (D:20240102030405Z)",
        "/Subtype /Underline /Rect [72 650 172 662] /QuadPoints [72 662 172 662 72 650 172 650] /C [1 0 0]",
        "/Subtype /StrikeOut /Rect [72 620 172 632] /QuadPoints [72 632 172 632 72 620 172 620] /C [0 0 1]",
        "/Subtype /Text /Rect [400 700 420 720] /Contents (A note)",
        "/Subtype /FreeText /Rect [72 600 272 640] /Contents (Line one\nLine two) /DA (/Helv 12 Tf 0 g)",
        "/Subtype /Square /Rect [72 500 172 560] /C [0 0 1] /IC [1 0.5 0]",
        "/Subtype /Circle /Rect [200 500 300 560] /C [0 1 0]",
        "/Subtype /Ink /Rect [300 500 400 560] /InkList [[300 500 400 560]] /C [1 0 1]",
        "/Subtype /Link /Rect [72 400 272 420] /Border [0 0 0] /A << /S /URI /URI (https://example.com/) >>",
        "/Subtype /Stamp /Rect [72 300 172 340]",
    ];
    for (n, body) in (100u32..).zip(objects) {
        builder.object(n, &format!("<< /Type /Annot {body} /P {page} 0 R >>"));
    }
    builder.object(1, "<< /Type /Catalog /Pages 2 0 R >>");
    builder.finish(1)
}

fn kind(annotation: &Annotation) -> String {
    serde_json::to_value(annotation).unwrap()["kind"]
        .as_str()
        .unwrap()
        .to_owned()
}

#[test]
fn a_page_is_read_into_the_model_with_typed_kinds_and_opaque_leftovers() {
    let Some(state) = state() else { return };
    let file = TempFile::write("annotated.pdf", &annotated());
    let info = state.open_path(file.0.clone()).unwrap().expect("loaded");
    let page = PageId::new(0);
    let listed = state.list_annotations(info.id, page).unwrap();

    // The link is not an annotation of the model; everything else is, in the order of the page.
    let kinds: Vec<String> = listed.iter().map(kind).collect();
    assert_eq!(
        kinds,
        [
            "highlight",
            "underline",
            "strikeout",
            "note",
            "freeText",
            "rect",
            "ellipse",
            "opaque",
            "opaque"
        ]
    );
    assert!(listed
        .iter()
        .all(|a| a.sync == Sync::Clean && a.page_id == page));

    let highlight = &listed[0];
    // None of these has an appearance stream, and the colour calls on an annotation itself are not made (they crash PDFium for an /AP
    // without objects, and the two cannot be told apart): the default colour of the kind. The path route is covered by saved files.
    assert_eq!(highlight.color, Rgb([255, 235, 0]));
    assert_eq!(highlight.contents, "Marked");
    assert_eq!(highlight.author.as_deref(), Some("Ada"));
    assert!(highlight
        .modified
        .as_deref()
        .is_some_and(|d| d.starts_with("D:2024")));
    let AnnotationBody::Highlight { quads } = &highlight.body else {
        panic!("not a highlight")
    };
    assert_eq!(quads.len(), 1);
    // The page is 792 pt high: y = 712 in PDF space is 80 from the top.
    assert_eq!((quads[0][0].x, quads[0][0].y), (72.0, 80.0));
    assert_eq!((quads[0][3].x, quads[0][3].y), (172.0, 92.0));
    assert_eq!(
        (
            highlight.rect.x,
            highlight.rect.y,
            highlight.rect.w,
            highlight.rect.h
        ),
        (72.0, 80.0, 100.0, 12.0)
    );

    let AnnotationBody::FreeText { lines, .. } = &listed[4].body else {
        panic!("not free text")
    };
    assert_eq!(lines, &["Line one", "Line two"]);
    let AnnotationBody::Rect { fill, .. } = &listed[5].body else {
        panic!("not a square")
    };
    assert_eq!(*fill, None);
    let subtypes: Vec<&str> = listed[7..]
        .iter()
        .map(|a| match &a.body {
            AnnotationBody::Opaque { subtype } => subtype.as_str(),
            _ => "typed",
        })
        .collect();
    assert_eq!(subtypes, ["Ink", "Stamp"]);

    // A second list answers from the model, with the same ids.
    assert_eq!(state.list_annotations(info.id, page).unwrap(), listed);
    state.close_document(info.id).unwrap();
}

#[test]
fn commands_work_on_what_was_read_and_opaque_annotations_stay_read_only() {
    let Some(state) = state() else { return };
    let file = TempFile::write("annotated-commands.pdf", &annotated());
    let info = state.open_path(file.0.clone()).unwrap().expect("loaded");
    let page = PageId::new(0);
    let listed = state.list_annotations(info.id, page).unwrap();
    let command =
        |value: serde_json::Value| -> DocCommand { serde_json::from_value(value).unwrap() };

    let id = listed[0].id;
    let moved = state
        .apply_command(
            info.id,
            command(
                serde_json::json!({"type": "moveAnnotations", "ids": [id], "dx": 10.0, "dy": 5.0}),
            ),
        )
        .unwrap();
    assert_eq!(moved.upserted[0].sync, Sync::Modified);
    assert_eq!(moved.upserted[0].rect.x, 82.0);
    assert!(moved.history.dirty);
    let undone = state.undo(info.id).unwrap();
    assert_eq!(undone.upserted[0], listed[0]);
    assert!(!undone.history.dirty);

    let opaque = listed[7].id;
    let refused = state.apply_command(
        info.id,
        command(serde_json::json!({"type": "deleteAnnotations", "ids": [opaque]})),
    );
    assert!(refused.is_err());
    state.close_document(info.id).unwrap();
}

#[test]
fn an_appearance_without_objects_and_format_characters_are_survived() {
    let Some(state) = state() else { return };
    let mut builder = PdfBuilder::new();
    add_pages(
        &mut builder,
        &[Page::new("").with("/Annots [100 0 R 101 0 R]")],
    );
    let page = support::fixtures::page_id(0);
    // A square whose /AP /N is a form with nothing in it, and a note whose text and author carry bidi and zero-width characters.
    builder.stream(102, "/Type /XObject /Subtype /Form /BBox [0 0 100 60]", b"");
    builder.object(
        100,
        &format!("<< /Type /Annot /Subtype /Square /Rect [72 500 172 560] /C [0 0 1] /IC [1 0.5 0] /AP << /N 102 0 R >> /P {page} 0 R >>"),
    );
    builder.object(
        101,
        &format!("<< /Type /Annot /Subtype /Text /Rect [400 700 420 720] /Contents <FEFF202E0061200B0062> /T <FEFF202E004100640061FEFF> /P {page} 0 R >>"),
    );
    builder.object(1, "<< /Type /Catalog /Pages 2 0 R >>");
    let file = TempFile::write("empty-ap.pdf", &builder.finish(1));
    let info = state.open_path(file.0.clone()).unwrap().expect("loaded");
    let listed = state.list_annotations(info.id, PageId::new(0)).unwrap();
    assert_eq!(listed.len(), 2);
    assert_eq!(listed[1].contents, "ab");
    assert_eq!(listed[1].author.as_deref(), Some("Ada"));
    // The worker is alive: the page can be listed again and another document opens.
    assert_eq!(
        state.list_annotations(info.id, PageId::new(0)).unwrap(),
        listed
    );
    state.close_document(info.id).unwrap();
}

fn square_page(with_square: bool) -> Vec<u8> {
    let mut builder = PdfBuilder::new();
    let annots = if with_square { "/Annots [100 0 R]" } else { "" };
    add_pages(&mut builder, &[Page::new("").with(annots)]);
    let page = support::fixtures::page_id(0);
    if with_square {
        builder.object(
            100,
            &format!("<< /Type /Annot /Subtype /Square /Rect [72 500 172 560] /C [0 0 1] /IC [1 0.5 0] /P {page} 0 R >>"),
        );
    }
    builder.object(1, "<< /Type /Catalog /Pages 2 0 R >>");
    builder.finish(1)
}

fn frame(state: &AppState, id: sheer_lib::documents::DocumentId) -> Vec<u8> {
    use sheer_lib::commands::render::{RenderPriority, RenderRequest};
    state
        .render_page(RenderRequest {
            doc_id: id,
            page_id: PageId::new(0),
            bucket: 0,
            tile: None,
            priority: RenderPriority::Visible,
            generation: 1,
        })
        .unwrap()
        .as_ref()
        .clone()
}

#[test]
fn the_original_of_a_changed_or_deleted_annotation_leaves_the_render_and_comes_back_on_undo() {
    let Some(state) = state() else { return };
    let with = TempFile::write("square-with.pdf", &square_page(true));
    let without = TempFile::write("square-without.pdf", &square_page(false));
    let blank = state.open_path(without.0.clone()).unwrap().expect("loaded");
    let blank_frame = frame(state, blank.id);
    let info = state.open_path(with.0.clone()).unwrap().expect("loaded");
    let original = frame(state, info.id);
    assert_ne!(original, blank_frame, "the square is drawn by PDFium");

    let listed = state.list_annotations(info.id, PageId::new(0)).unwrap();
    let id = listed[0].id;
    let command =
        |value: serde_json::Value| -> DocCommand { serde_json::from_value(value).unwrap() };

    // Moved: the original no longer shows at its place (the overlay draws the moved one).
    state
        .apply_command(
            info.id,
            command(
                serde_json::json!({"type": "moveAnnotations", "ids": [id], "dx": 100.0, "dy": 0.0}),
            ),
        )
        .unwrap();
    assert_eq!(frame(state, info.id), blank_frame);
    state.undo(info.id).unwrap();
    assert_eq!(frame(state, info.id), original);
    state.redo(info.id).unwrap();
    assert_eq!(frame(state, info.id), blank_frame);
    state.undo(info.id).unwrap();
    assert_eq!(frame(state, info.id), original);

    // Deleted: gone from the render; undo brings it back.
    state
        .apply_command(
            info.id,
            command(serde_json::json!({"type": "deleteAnnotations", "ids": [id]})),
        )
        .unwrap();
    assert_eq!(frame(state, info.id), blank_frame);
    state.undo(info.id).unwrap();
    assert_eq!(frame(state, info.id), original);

    state.close_document(info.id).unwrap();
    state.close_document(blank.id).unwrap();
}
