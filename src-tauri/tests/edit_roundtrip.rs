//! F11 item 4: every edit of an annotation (move, resize, restyle, text) keeps ONE annotation, for annotations made in this session and
//! for ones of the file, per kind, through the real save and PDFium. Skips when the library is not fetched.

#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde_json::{json, Value};
use sheer_lib::commands::render::{RenderPriority, RenderRequest};
use sheer_lib::commands::save::SaveAck;
use sheer_lib::commands::AppState;
use sheer_lib::documents::{DocumentId, PageId};
use sheer_lib::engine::{self, Engine};
use sheer_lib::model::annotation::Annotation;
use sheer_lib::model::command::DocCommand;
use sheer_lib::pdfwrite::inspect::list_annotations;
use support::fixtures::{add_pages, page_id, Page};
use support::PdfBuilder;

struct Scratch(PathBuf);

impl Scratch {
    fn new(name: &str) -> Self {
        let path = std::env::temp_dir().join(format!("sheer-edit-{}-{name}", std::process::id()));
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

fn data_dir() -> &'static Path {
    static DIR: OnceLock<Scratch> = OnceLock::new();
    &DIR.get_or_init(|| Scratch::new("data")).0
}

fn state() -> Option<&'static AppState> {
    static STATE: OnceLock<Option<AppState>> = OnceLock::new();
    STATE
        .get_or_init(|| {
            let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("pdfium");
            let library = engine::library_path(&root);
            library
                .is_file()
                .then(|| AppState::new(Engine::start(library)).with_data_dir(data_dir().to_owned()))
        })
        .as_ref()
}

fn base() -> Vec<u8> {
    let mut builder = PdfBuilder::new();
    add_pages(&mut builder, &[Page::new("")]);
    builder.object(1, "<< /Type /Catalog /Pages 2 0 R >>");
    let _ = page_id(0);
    builder.finish(1)
}

fn open(state: &AppState, scratch: &Scratch, bytes: &[u8]) -> (DocumentId, PathBuf) {
    let path = scratch.0.join("doc.pdf");
    std::fs::write(&path, bytes).unwrap();
    let info = state.open_path(path.clone()).unwrap().expect("loaded");
    (info.id, std::fs::canonicalize(path).unwrap())
}

fn run(state: &AppState, id: DocumentId, value: Value) -> Vec<Annotation> {
    let command: DocCommand = serde_json::from_value(value).unwrap();
    state.apply_command(id, command).unwrap().upserted
}

fn stroke(dx: f32) -> Value {
    json!({"points": [{"x": 72.0 + dx, "y": 300.0}, {"x": 120.0 + dx, "y": 340.0}],
           "outline": [{"x": 71.0 + dx, "y": 300.0}, {"x": 73.0 + dx, "y": 300.0}, {"x": 121.0 + dx, "y": 340.0}, {"x": 119.0 + dx, "y": 340.0}]})
}

/// (kind, draft extras, subtype in the file)
fn kinds() -> Vec<(&'static str, Value, &'static str)> {
    vec![
        (
            "highlight",
            json!({"quads": [[{"x": 72.0, "y": 80.0}, {"x": 172.0, "y": 80.0}, {"x": 72.0, "y": 92.0}, {"x": 172.0, "y": 92.0}]]}),
            "Highlight",
        ),
        (
            "note",
            json!({"at": {"x": 300.0, "y": 80.0}, "icon": "comment"}),
            "Text",
        ),
        (
            "freeText",
            json!({"box": {"x": 300.0, "y": 140.0, "w": 200.0, "h": 40.0}, "lines": ["Hello"], "fontSize": 12.0, "fill": null, "borderWidth": 1.0}),
            "FreeText",
        ),
        (
            "ink",
            json!({"strokes": [stroke(0.0)], "width": 2.0}),
            "Ink",
        ),
        (
            "rect",
            json!({"box": {"x": 72.0, "y": 400.0, "w": 100.0, "h": 60.0}, "width": 2.0, "fill": null, "dashed": false}),
            "Square",
        ),
        (
            "ellipse",
            json!({"box": {"x": 220.0, "y": 400.0, "w": 100.0, "h": 60.0}, "width": 2.0, "fill": null, "dashed": false}),
            "Circle",
        ),
        (
            "line",
            json!({"from": {"x": 72.0, "y": 520.0}, "to": {"x": 272.0, "y": 560.0}, "width": 2.0, "head": "none", "tail": "none"}),
            "Line",
        ),
    ]
}

/// The patches the frontend sends for a restyle and a resize (`patchOf`, inspector `patchFor`), per kind.
fn edits(kind: &str) -> Vec<Value> {
    let mut patches = vec![
        json!({"color": [10, 20, 200]}),
        json!({"opacity": 0.5}),
        json!({"contents": "edited"}),
    ];
    match kind {
        "freeText" => {
            patches.push(json!({"lines": ["Changed", "text"]}));
            patches.push(json!({"box": {"x": 310.0, "y": 150.0, "w": 220.0, "h": 50.0}}));
            patches.push(json!({"fontSize": 14.0, "fill": [255, 255, 0], "borderWidth": 2.0}));
        }
        "ink" => {
            patches.push(json!({"strokes": [stroke(20.0)]}));
            patches.push(json!({"width": 4.0}));
        }
        "rect" | "ellipse" => {
            patches.push(json!({"box": {"x": 90.0, "y": 410.0, "w": 120.0, "h": 70.0}}));
            patches.push(json!({"width": 3.0, "fill": [1, 2, 3], "dashed": true}));
        }
        "line" => {
            patches.push(json!({"from": {"x": 80.0, "y": 530.0}, "to": {"x": 280.0, "y": 570.0}}));
            patches.push(json!({"width": 3.0, "head": "closedArrow", "tail": "openArrow"}));
        }
        "note" => patches.push(json!({"at": {"x": 310.0, "y": 90.0}, "icon": "help"})),
        _ => {}
    }
    patches
}

fn count(path: &Path, subtype: &str) -> usize {
    list_annotations(&std::fs::read(path).unwrap())
        .unwrap()
        .iter()
        .filter(|s| s.subtype == subtype)
        .count()
}

#[test]
fn editing_a_new_annotation_modifies_it_and_the_file_has_exactly_one() {
    let Some(state) = state() else { return };
    for (kind, extra, subtype) in kinds() {
        let scratch = Scratch::new(kind);
        let (id, path) = open(state, &scratch, &base());
        let mut draft = json!({"pageId": 0, "kind": kind, "color": [200, 30, 30], "contents": "x"});
        for (key, value) in extra.as_object().unwrap() {
            draft[key] = value.clone();
        }
        let made = run(
            state,
            id,
            json!({"type": "createAnnotation", "draft": draft}),
        );
        let before = made[0].clone();
        let mut last = before.clone();
        for patch in edits(kind) {
            let up = run(
                state,
                id,
                json!({"type": "updateAnnotation", "id": before.id, "patch": patch, "coalesce": format!("resize.{}", before.id.get())}),
            );
            assert_eq!(up.len(), 1, "{kind}: one annotation changes");
            assert_eq!(up[0].id, before.id, "{kind}");
            last = up[0].clone();
        }
        let moved = run(
            state,
            id,
            json!({"type": "moveAnnotations", "ids": [before.id], "dx": 15.0, "dy": -10.0}),
        );
        assert_eq!(moved.len(), 1, "{kind}");
        assert!(
            (moved[0].rect.x - (last.rect.x + 15.0)).abs() < 0.01,
            "{kind} moved"
        );
        assert_eq!(
            state.list_annotations(id, PageId::new(0)).unwrap().len(),
            1,
            "{kind}: one in the model"
        );
        state.save_in_place(id, SaveAck::default()).unwrap();
        assert_eq!(count(&path, subtype), 1, "{kind}: exactly one in the file");
        assert_eq!(
            state.list_annotations(id, PageId::new(0)).unwrap().len(),
            1,
            "{kind}: one in the model after the save"
        );
        // A second round after the save: it is in the file now, an edit updates in place.
        run(
            state,
            id,
            json!({"type": "moveAnnotations", "ids": [before.id], "dx": 5.0, "dy": 5.0}),
        );
        run(
            state,
            id,
            json!({"type": "updateAnnotation", "id": before.id, "patch": {"color": [0, 0, 0]}}),
        );
        state.save_in_place(id, SaveAck::default()).unwrap();
        assert_eq!(
            count(&path, subtype),
            1,
            "{kind}: still one after the second save"
        );
    }
}

/// The frontend once sent `resize:<id>` as the coalesce key; the backend only accepts `[A-Za-z0-9._-]`, so every resize was refused with
/// "This request was invalid". The key must keep that form.
#[test]
fn a_coalesce_key_with_a_colon_is_refused_and_one_with_a_dot_is_not() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("coalesce");
    let (id, _) = open(state, &scratch, &base());
    let made = run(
        state,
        id,
        json!({"type": "createAnnotation", "draft": {"pageId": 0, "kind": "rect", "color": [1, 2, 3],
            "box": {"x": 10.0, "y": 10.0, "w": 50.0, "h": 50.0}, "width": 1.0, "fill": null, "dashed": false}}),
    );
    let update = |key: &str| {
        let command: DocCommand =
            serde_json::from_value(json!({"type": "updateAnnotation", "id": made[0].id,
            "patch": {"box": {"x": 12.0, "y": 12.0, "w": 50.0, "h": 50.0}}, "coalesce": key}))
            .unwrap();
        state.apply_command(id, command)
    };
    assert!(update("resize:1").is_err());
    assert!(update("resize.1").is_ok());
}

fn render(state: &AppState, id: DocumentId) -> (u32, Vec<u8>) {
    let frame = state
        .render_page(RenderRequest {
            doc_id: id,
            page_id: PageId::new(0),
            bucket: 0,
            tile: None,
            priority: RenderPriority::Visible,
            generation: 1,
        })
        .unwrap();
    let width = u32::from_le_bytes(frame[8..12].try_into().unwrap());
    let decoder = png::Decoder::new(std::io::Cursor::new(&frame[16..]));
    let mut reader = decoder.read_info().unwrap();
    let mut pixels = vec![0; reader.output_buffer_size().unwrap()];
    reader.next_frame(&mut pixels).unwrap();
    (width, pixels)
}

fn is_white_at(frame: &(u32, Vec<u8>), x: f32, y: f32) -> bool {
    let scale = frame.0 as f32 / 612.0;
    let at = ((y * scale) as usize * frame.0 as usize + (x * scale) as usize) * 3;
    frame.1[at..at + 3] == [255, 255, 255]
}

/// A rectangle that was saved and then moved is not drawn by the page bitmap at its old place any more (the overlay draws it moved).
#[test]
fn a_saved_then_moved_rectangle_leaves_no_ghost_in_the_page_bitmap() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("ghost");
    let (id, path) = open(state, &scratch, &base());
    let made = run(
        state,
        id,
        json!({"type": "createAnnotation", "draft": {"pageId": 0, "kind": "rect", "color": [200, 0, 0],
            "box": {"x": 72.0, "y": 400.0, "w": 100.0, "h": 60.0}, "width": 2.0, "fill": [200, 0, 0], "dashed": false}}),
    );
    assert!(
        is_white_at(&render(state, id), 120.0, 430.0),
        "a new annotation is not in the bitmap"
    );
    state.save_in_place(id, SaveAck::default()).unwrap();
    assert!(
        !is_white_at(&render(state, id), 120.0, 430.0),
        "a saved one is"
    );
    run(
        state,
        id,
        json!({"type": "moveAnnotations", "ids": [made[0].id], "dx": 200.0, "dy": 0.0}),
    );
    assert!(
        is_white_at(&render(state, id), 120.0, 430.0),
        "the moved one is hidden at its old place"
    );
    state.save_in_place(id, SaveAck::default()).unwrap();
    assert_eq!(count(&path, "Square"), 1);
    assert!(is_white_at(&render(state, id), 120.0, 430.0));
    assert!(!is_white_at(&render(state, id), 320.0, 430.0));
}
