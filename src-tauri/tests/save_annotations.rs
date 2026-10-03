//! Saving annotations (ADR-004, M2 package P8) against the real PDFium, through the same `AppState` the commands use: every annotation
//! type is written with an appearance stream and read back, the file is the original followed by an update, the original is backed
//! up once, nothing is left beside the file, the welcome document is never written to, and a hostile file never panics the save.
//! Skips, like the other engine tests, when the library is not fetched.

// Test code: panicking on a broken fixture is the point (clippy.toml only exempts `#[test]` functions, not helpers).
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use serde_json::json;
use sheer_lib::commands::render::{RenderPriority, RenderRequest};
use sheer_lib::commands::save::{SaveAck, SaveResult, SaveWarning};
use sheer_lib::commands::AppState;
use sheer_lib::documents::{DocKind, DocumentId, PageId};
use sheer_lib::engine::{self, Engine};
use sheer_lib::error::ErrorCode;
use sheer_lib::events::AppEvent;
use sheer_lib::model::annotation::{Annotation, AnnotationBody, Sync};
use sheer_lib::model::command::DocCommand;
use sheer_lib::pdfwrite::inspect::{list_annotations, Summary};
use support::fixtures::{add_pages, page_id, Page};
use support::{malformed, PdfBuilder};

/// A scratch directory of this process that holds the files of one test and is removed when the test ends.
struct Scratch(PathBuf);

impl Scratch {
    fn new(name: &str) -> Self {
        let path = std::env::temp_dir().join(format!("sheer-save-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }

    fn file(&self, name: &str) -> PathBuf {
        self.0.join(name)
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
            if library.is_file() {
                Some(AppState::new(Engine::start(library)).with_data_dir(data_dir().to_owned()))
            } else {
                eprintln!("skipping the save tests: {} not found", library.display());
                None
            }
        })
        .as_ref()
}

/// Two US Letter pages. Page 0 has a highlight (`/NM (hl-1)`), a stamp and a square; page 1 has no annotations at all.
fn base() -> Vec<u8> {
    let mut builder = PdfBuilder::new();
    add_pages(
        &mut builder,
        &[
            Page::new("").with("/Annots [100 0 R 101 0 R 102 0 R]"),
            Page::new(""),
        ],
    );
    let page = page_id(0);
    let objects = [
        "/Subtype /Highlight /Rect [72 700 172 712] /QuadPoints [72 712 172 712 72 700 172 700] /C [1 1 0] /Contents (Marked) /T (Ada) /NM (hl-1)",
        "/Subtype /Stamp /Rect [72 300 172 340] /NM (stamp-1)",
        "/Subtype /Square /Rect [200 500 300 560] /C [0 0 1] /NM (sq-1) /Contents (Old square)",
    ];
    for (n, body) in (100u32..).zip(objects) {
        builder.object(n, &format!("<< /Type /Annot {body} /P {page} 0 R >>"));
    }
    builder.object(1, "<< /Type /Catalog /Pages 2 0 R >>");
    builder.finish(1)
}

fn open(state: &AppState, scratch: &Scratch, name: &str, bytes: &[u8]) -> (DocumentId, PathBuf) {
    let path = scratch.file(name);
    std::fs::write(&path, bytes).unwrap();
    let info = state.open_path(path.clone()).unwrap().expect("loaded");
    (info.id, std::fs::canonicalize(path).unwrap())
}

fn command(value: serde_json::Value) -> DocCommand {
    serde_json::from_value(value).unwrap()
}

fn create(state: &AppState, id: DocumentId, draft: serde_json::Value) -> Annotation {
    let changes = state
        .apply_annotation_command(
            id,
            command(json!({"type": "createAnnotation", "draft": draft})),
        )
        .unwrap();
    changes.upserted.into_iter().next().unwrap()
}

fn quad(x: f32, y: f32, w: f32, h: f32) -> serde_json::Value {
    json!([
        {"x": x, "y": y}, {"x": x + w, "y": y}, {"x": x, "y": y + h}, {"x": x + w, "y": y + h}
    ])
}

/// One annotation of every type the model writes, on page 1, at known places. Returns (kind, id, expected page rect).
fn create_every_type(state: &AppState, id: DocumentId) -> Vec<(&'static str, Annotation)> {
    let common = |kind: &str| json!({"pageId": 1, "kind": kind, "color": [200, 30, 30], "opacity": 0.8, "author": "Ada", "contents": format!("a {kind}")});
    let with = |kind: &str, extra: serde_json::Value| {
        let mut draft = common(kind);
        for (key, value) in extra.as_object().unwrap() {
            draft[key] = value.clone();
        }
        draft
    };
    let mut made = Vec::new();
    let mut add = |kind: &'static str, draft| made.push((kind, create(state, id, draft)));
    add(
        "highlight",
        with(
            "highlight",
            json!({"quads": [quad(72.0, 80.0, 100.0, 12.0)]}),
        ),
    );
    add(
        "underline",
        with(
            "underline",
            json!({"quads": [quad(72.0, 120.0, 100.0, 12.0)]}),
        ),
    );
    add(
        "strikeout",
        with(
            "strikeout",
            json!({"quads": [quad(72.0, 160.0, 100.0, 12.0)]}),
        ),
    );
    add(
        "note",
        with(
            "note",
            json!({"at": {"x": 300.0, "y": 80.0}, "icon": "comment"}),
        ),
    );
    add(
        "freeText",
        with(
            "freeText",
            json!({"box": {"x": 300.0, "y": 140.0, "w": 200.0, "h": 40.0}, "lines": ["Hello (world)", "Zweite Zeile \u{e4}\u{f6}\u{fc}"], "fontSize": 12.0, "fill": [255, 255, 200], "borderWidth": 1.0}),
        ),
    );
    add(
        "ink",
        with(
            "ink",
            json!({"strokes": [{"points": [{"x": 72.0, "y": 300.0}, {"x": 120.0, "y": 340.0}], "outline": [{"x": 71.0, "y": 300.0}, {"x": 73.0, "y": 300.0}, {"x": 121.0, "y": 340.0}, {"x": 119.0, "y": 340.0}]}], "width": 2.0}),
        ),
    );
    add(
        "rect",
        with(
            "rect",
            json!({"box": {"x": 72.0, "y": 400.0, "w": 100.0, "h": 60.0}, "width": 2.0, "fill": [255, 200, 0], "dashed": true}),
        ),
    );
    add(
        "ellipse",
        with(
            "ellipse",
            json!({"box": {"x": 220.0, "y": 400.0, "w": 100.0, "h": 60.0}, "width": 2.0, "fill": null, "dashed": false}),
        ),
    );
    add(
        "line",
        with(
            "line",
            json!({"from": {"x": 72.0, "y": 520.0}, "to": {"x": 272.0, "y": 560.0}, "width": 2.0, "head": "closedArrow", "tail": "openArrow"}),
        ),
    );
    made
}

fn read(path: &Path) -> Vec<u8> {
    std::fs::read(path).unwrap()
}

fn render(state: &AppState, id: DocumentId, page: u32) -> (u32, u32, Vec<u8>) {
    let frame = state
        .render_page(RenderRequest {
            doc_id: id,
            page_id: PageId::new(page),
            bucket: 0,
            tile: None,
            priority: RenderPriority::Visible,
            generation: 1,
        })
        .unwrap();
    let width = u32::from_le_bytes(frame[8..12].try_into().unwrap());
    let height = u32::from_le_bytes(frame[12..16].try_into().unwrap());
    let decoder = png::Decoder::new(std::io::Cursor::new(&frame[16..]));
    let mut reader = decoder.read_info().unwrap();
    let mut pixels = vec![0; reader.output_buffer_size().unwrap()];
    reader.next_frame(&mut pixels).unwrap();
    (width, height, pixels)
}

/// The RGB of the pixel at page position (`x`, `y`) of a frame rendered at bucket 0 (4/3 pixel per point).
fn pixel(frame: &(u32, u32, Vec<u8>), x: f32, y: f32) -> [u8; 3] {
    let scale = frame.0 as f32 / 612.0;
    let (px, py) = ((x * scale) as usize, (y * scale) as usize);
    let at = (py * frame.0 as usize + px) * 3;
    [frame.2[at], frame.2[at + 1], frame.2[at + 2]]
}

fn near(a: f32, b: f32) -> bool {
    (a - b).abs() < 0.05
}

#[test]
fn every_type_is_written_with_an_appearance_and_pdfium_reads_it_back() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("round-trip");
    let original = base();
    let (id, path) = open(state, &scratch, "doc.pdf", &original);
    let before = render(state, id, 1);
    let made = create_every_type(state, id);

    let saved = state.save_in_place(id, SaveAck::default()).unwrap();
    assert!(
        saved.backup_created,
        "the first save over the original backs it up"
    );
    assert!(saved.changes.upserted.iter().all(|a| a.sync == Sync::Clean));
    assert_eq!(saved.changes.upserted.len(), made.len());
    assert!(!saved.changes.history.dirty && !saved.changes.history.can_undo);

    // An incremental update: the original bytes first, then more.
    let bytes = read(&path);
    assert!(bytes.len() > original.len());
    assert_eq!(&bytes[..original.len()], original.as_slice());

    // Every annotation we wrote is in the file with an appearance stream, a name, and the rectangle the model computed (PDF space is y up).
    let in_file = list_annotations(&bytes).unwrap();
    let page_one: Vec<&Summary> = in_file.iter().filter(|s| s.page_index == 1).collect();
    assert_eq!(page_one.len(), made.len());
    for ((kind, annotation), summary) in made.iter().zip(&page_one) {
        assert!(summary.has_appearance, "{kind} has no /AP /N stream");
        assert!(
            summary.name.as_deref().is_some_and(|n| n.len() == 32),
            "{kind}"
        );
        let rect = annotation.rect;
        assert!(
            near(summary.rect[0], rect.x)
                && near(summary.rect[2], rect.x + rect.w)
                && near(summary.rect[1], 792.0 - rect.y - rect.h)
                && near(summary.rect[3], 792.0 - rect.y),
            "{kind}: {:?} vs {rect:?}",
            summary.rect
        );
    }
    let subtypes: Vec<&str> = page_one.iter().map(|s| s.subtype.as_str()).collect();
    assert_eq!(
        subtypes,
        [
            "Highlight",
            "Underline",
            "StrikeOut",
            "Text",
            "FreeText",
            "Ink",
            "Square",
            "Circle",
            "Line"
        ]
    );
    // The quads of the highlight: the corners in the order the model gives them.
    let quads = &page_one[0].quad_points;
    assert_eq!(quads.len(), 8);
    assert!(near(quads[0], 72.0) && near(quads[1], 792.0 - 80.0));
    assert!(near(quads[6], 172.0) && near(quads[7], 792.0 - 92.0));
    // The old annotations of page 0 are untouched.
    assert_eq!(in_file.iter().filter(|s| s.page_index == 0).count(), 3);

    // PDFium opens the saved file (a copy under another name, so that it is a document of its own) and imports what it can.
    let copy = scratch.file("copy.pdf");
    std::fs::copy(&path, &copy).unwrap();
    let reopened = state.open_path(copy).unwrap().expect("loaded").id;
    let listed = state.list_annotations(reopened, PageId::new(1)).unwrap();
    let kinds: Vec<String> = listed
        .iter()
        .map(|a| {
            serde_json::to_value(a).unwrap()["kind"]
                .as_str()
                .unwrap()
                .to_owned()
        })
        .collect();
    assert_eq!(
        kinds,
        [
            "highlight",
            "underline",
            "strikeout",
            "note",
            "freeText",
            "opaque",
            "rect",
            "ellipse",
            "opaque"
        ]
    );
    let highlight = &listed[0];
    assert_eq!(highlight.author.as_deref(), Some("Ada"));
    assert_eq!(highlight.contents, "a highlight");
    let AnnotationBody::Highlight { quads } = &highlight.body else {
        panic!("not a highlight")
    };
    assert!(near(quads[0][0].x, 72.0) && near(quads[0][0].y, 80.0));
    assert!(near(quads[0][3].x, 172.0) && near(quads[0][3].y, 92.0));
    let free = listed
        .iter()
        .find_map(|a| match &a.body {
            AnnotationBody::FreeText { lines, .. } => Some(lines.clone()),
            _ => None,
        })
        .unwrap();
    assert_eq!(free[0], "Hello (world)");

    // The appearance is what PDFium draws: the page is not the blank page it was, at the highlight (yellow-ish multiply of red) and the rectangle.
    let after = render(state, id, 1);
    assert_ne!(
        before.2, after.2,
        "the saved page renders like the unsaved one"
    );
    let marked = pixel(&after, 120.0, 86.0);
    assert!(marked != [255, 255, 255], "highlight not drawn: {marked:?}");
    let filled = pixel(&after, 120.0, 430.0);
    assert!(
        filled[0] > 200 && filled[2] < 100,
        "rect fill not drawn: {filled:?}"
    );

    // The same document goes on: the annotations are clean, and a second save with no change writes nothing and backs up nothing.
    let again = state.save_in_place(id, SaveAck::default()).unwrap();
    assert!(!again.backup_created);
    assert_eq!(read(&path), bytes);
}

#[test]
fn a_changed_and_a_deleted_annotation_of_the_file_are_updated_in_place_and_positions_follow() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("update");
    let (id, path) = open(state, &scratch, "doc.pdf", &base());
    let page = PageId::new(0);
    let listed = state.list_annotations(id, page).unwrap();
    let highlight = listed.iter().find(|a| a.contents == "Marked").unwrap().id;
    let square = listed
        .iter()
        .find(|a| matches!(a.body, AnnotationBody::Rect { .. }))
        .unwrap()
        .id;
    state
        .apply_annotation_command(
            id,
            command(json!({"type": "updateAnnotation", "id": highlight, "patch": {"color": [0, 200, 0], "contents": "Changed"}})),
        )
        .unwrap();
    state
        .apply_annotation_command(
            id,
            command(json!({"type": "deleteAnnotations", "ids": [square]})),
        )
        .unwrap();
    let new = create(
        state,
        id,
        json!({"pageId": 0, "kind": "note", "color": [255, 235, 0], "at": {"x": 400.0, "y": 100.0}, "icon": "note", "contents": "reply", "inReplyTo": highlight}),
    );
    state.save_in_place(id, SaveAck::default()).unwrap();

    let in_file = list_annotations(&read(&path)).unwrap();
    let subtypes: Vec<&str> = in_file.iter().map(|s| s.subtype.as_str()).collect();
    assert_eq!(
        subtypes,
        ["Highlight", "Stamp", "Text"],
        "the square is gone, the stamp stays"
    );
    assert!(
        in_file[0].has_appearance,
        "the changed highlight got a new appearance"
    );
    assert_eq!(in_file[0].name.as_deref(), Some("hl-1"), "the name is kept");
    assert!(in_file[2].is_reply, "the reply points at its parent");

    // The model knows where everything is now: change the highlight again and the file still has one of it.
    state
        .apply_annotation_command(
            id,
            command(json!({"type": "updateAnnotation", "id": highlight, "patch": {"contents": "Twice"}})),
        )
        .unwrap();
    state
        .apply_annotation_command(
            id,
            command(json!({"type": "updateAnnotation", "id": new.id, "patch": {"contents": "edited reply"}})),
        )
        .unwrap();
    state.save_in_place(id, SaveAck::default()).unwrap();
    let in_file = list_annotations(&read(&path)).unwrap();
    let subtypes: Vec<&str> = in_file.iter().map(|s| s.subtype.as_str()).collect();
    assert_eq!(subtypes, ["Highlight", "Stamp", "Text"]);
    // And PDFium, loading the file as it is now, sees the second change.
    let copy = scratch.file("copy.pdf");
    std::fs::copy(&path, &copy).unwrap();
    let other = state.open_path(copy).unwrap().expect("loaded").id;
    let seen = state.list_annotations(other, page).unwrap();
    assert!(seen.iter().any(|a| a.contents == "Twice"));
    assert!(seen.iter().any(|a| a.contents == "edited reply"));
    assert!(!seen.iter().any(|a| a.contents == "Old square"));
}

#[test]
fn the_first_save_backs_the_original_up_once_and_nothing_is_left_beside_the_file() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("backup");
    let original = base();
    let (id, path) = open(state, &scratch, "Rechnung Ä.pdf", &original);
    create(
        state,
        id,
        json!({"pageId": 1, "kind": "note", "color": [255, 235, 0], "at": {"x": 10.0, "y": 10.0}, "icon": "note"}),
    );
    let first = state.save_in_place(id, SaveAck::default()).unwrap();
    assert!(first.backup_created);
    let backups = data_dir().join("backups");
    let backed_up: Vec<PathBuf> = std::fs::read_dir(&backups)
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| {
            p.file_name()
                .unwrap()
                .to_string_lossy()
                .contains("Rechnung")
        })
        .collect();
    assert_eq!(backed_up.len(), 1);
    assert_eq!(
        read(&backed_up[0]),
        original,
        "the backup is the original, byte for byte"
    );

    create(
        state,
        id,
        json!({"pageId": 1, "kind": "note", "color": [255, 235, 0], "at": {"x": 40.0, "y": 10.0}, "icon": "note"}),
    );
    let second = state.save_in_place(id, SaveAck::default()).unwrap();
    assert!(
        !second.backup_created,
        "only the first save of a session backs up"
    );
    let names: Vec<String> = std::fs::read_dir(path.parent().unwrap())
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert!(
        names.iter().all(|n| !n.ends_with(".tmp")),
        "a temp file was left: {names:?}"
    );
}

#[test]
fn a_file_that_changed_on_disk_is_not_overwritten_before_the_user_agrees() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("changed");
    let (id, path) = open(state, &scratch, "doc.pdf", &base());
    create(
        state,
        id,
        json!({"pageId": 1, "kind": "note", "color": [255, 235, 0], "at": {"x": 10.0, "y": 10.0}, "icon": "note"}),
    );
    // Another program appends a newline.
    let mut bytes = read(&path);
    bytes.push(b'\n');
    std::fs::write(&path, &bytes).unwrap();
    let error = state.save_in_place(id, SaveAck::default()).unwrap_err();
    assert_eq!(error.code(), ErrorCode::NeedsConfirmation);
    assert_eq!(read(&path), bytes, "nothing was written");
    let ack = SaveAck {
        file_changed: true,
        ..SaveAck::default()
    };
    state.save_in_place(id, ack).unwrap();
    assert!(read(&path).len() > bytes.len());
}

#[test]
fn a_document_with_unsaved_changes_does_not_close_without_discard() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("close");
    let (id, _) = open(state, &scratch, "doc.pdf", &base());
    state
        .close_document_checked(id, false)
        .unwrap_or_else(|e| panic!("{e}"));
    let (id, _) = open(state, &scratch, "doc.pdf", &base());
    create(
        state,
        id,
        json!({"pageId": 1, "kind": "note", "color": [255, 235, 0], "at": {"x": 10.0, "y": 10.0}, "icon": "note"}),
    );
    assert_eq!(
        state.close_document_checked(id, false).unwrap_err().code(),
        ErrorCode::UnsavedChanges
    );
    state.save_in_place(id, SaveAck::default()).unwrap();
    state.close_document_checked(id, false).unwrap();
    let (id, _) = open(state, &scratch, "doc.pdf", &base());
    create(
        state,
        id,
        json!({"pageId": 1, "kind": "note", "color": [255, 235, 0], "at": {"x": 10.0, "y": 10.0}, "icon": "note"}),
    );
    state.close_document_checked(id, true).unwrap();
}

#[test]
fn save_as_writes_a_new_file_and_the_document_lives_there_from_then_on() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("save-as");
    let original = base();
    let (id, path) = open(state, &scratch, "doc.pdf", &original);
    create(
        state,
        id,
        json!({"pageId": 1, "kind": "note", "color": [255, 235, 0], "at": {"x": 10.0, "y": 10.0}, "icon": "note"}),
    );
    // The dialog may leave the extension out; the name is judged like an opened one.
    let result = state
        .save_as(id, &scratch.file("copy"), SaveAck::default())
        .unwrap();
    assert_eq!(result.document.display_name, "copy.pdf");
    assert!(!result.backup_created);
    assert_eq!(read(&path), original, "the file it came from is untouched");
    let copy = scratch.file("copy.pdf");
    assert_eq!(&read(&copy)[..original.len()], original.as_slice());
    assert_eq!(list_annotations(&read(&copy)).unwrap().len(), 4);
    // From now on a save goes to the new file.
    create(
        state,
        id,
        json!({"pageId": 1, "kind": "note", "color": [255, 235, 0], "at": {"x": 50.0, "y": 10.0}, "icon": "note"}),
    );
    state.save_in_place(id, SaveAck::default()).unwrap();
    assert_eq!(list_annotations(&read(&copy)).unwrap().len(), 5);
    assert_eq!(read(&path), original);
    // A folder or a path in a folder that is not there is refused, nothing is created.
    assert!(state
        .save_as(
            id,
            &scratch.0.join("nowhere").join("x.pdf"),
            SaveAck::default()
        )
        .is_err());
    assert!(!scratch.0.join("nowhere").exists());
}

fn welcome_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join("welcome")
        .join("welcome-en.pdf")
}

#[test]
fn the_welcome_document_is_never_written_in_place_but_can_be_saved_as() {
    let Some(state) = state() else { return };
    let resource = read(&welcome_path());
    let AppEvent::Opened { document } =
        state.open_welcome(welcome_path(), "Welcome.pdf".to_owned())
    else {
        panic!("the welcome document did not open")
    };
    assert_eq!(document.kind, DocKind::Welcome);
    let id = document.id;
    create(
        state,
        id,
        json!({"pageId": 0, "kind": "note", "color": [255, 235, 0], "at": {"x": 10.0, "y": 10.0}, "icon": "note"}),
    );
    let error = state.save_in_place(id, SaveAck::default()).unwrap_err();
    assert_eq!(error.code(), ErrorCode::ReadOnly);
    assert_eq!(
        read(&welcome_path()),
        resource,
        "the bundled file is as it was"
    );
    // Closing it never asks about changes.
    // Save As is what the UI offers instead.
    let scratch = Scratch::new("welcome");
    let result = state
        .save_as(id, &scratch.file("mine.pdf"), SaveAck::default())
        .unwrap();
    assert_eq!(result.document.kind, DocKind::User);
    assert_eq!(read(&welcome_path()), resource);
    assert_eq!(
        &read(&scratch.file("mine.pdf"))[..resource.len()],
        resource.as_slice()
    );
    state.close_document_checked(id, false).unwrap();
}

#[test]
fn saving_what_the_hostile_corpus_lets_open_never_panics_and_leaves_the_engine_alive() {
    let Some(state) = state() else { return };
    let state: Arc<AppState> = Arc::new(state.clone());
    for (name, bytes) in malformed::all() {
        let scratch = Scratch::new(&format!("hostile-{}", name.replace('.', "-")));
        let path = scratch.file(name);
        std::fs::write(&path, &bytes).unwrap();
        let (sender, receiver) = mpsc::channel();
        let worker = Arc::clone(&state);
        let handle = std::thread::spawn(move || {
            let outcome = (|| -> Result<(), ErrorCode> {
                let info = worker
                    .open_path(path.clone())
                    .map_err(|e| e.code())?
                    .ok_or(ErrorCode::Internal)?;
                let draft = json!({"pageId": 0, "kind": "note", "color": [255, 235, 0], "at": {"x": 10.0, "y": 10.0}, "icon": "note"});
                let created = worker.apply_annotation_command(
                    info.id,
                    command(json!({"type": "createAnnotation", "draft": draft})),
                );
                let saved = created.map_err(|e| e.code()).and_then(|_| {
                    worker
                        .save_in_place(info.id, SaveAck::default())
                        .map(drop)
                        .map_err(|e| e.code())
                });
                let _ = worker.close_document_checked(info.id, true);
                saved
            })();
            let _ = sender.send(outcome);
        });
        let outcome = receiver
            .recv_timeout(Duration::from_secs(90))
            .unwrap_or_else(|_| panic!("{name}: no answer: a hang or a panic"));
        handle.join().unwrap_or_else(|_| panic!("{name}: panicked"));
        if let Err(code) = outcome {
            assert_ne!(
                code,
                ErrorCode::Internal,
                "{name}: an internal error is a bug"
            );
        }
    }
    // The engine still works after all of it.
    let scratch = Scratch::new("after-hostile");
    let (id, path) = open(&state, &scratch, "doc.pdf", &base());
    create(
        &state,
        id,
        json!({"pageId": 1, "kind": "note", "color": [255, 235, 0], "at": {"x": 10.0, "y": 10.0}, "icon": "note"}),
    );
    state.save_in_place(id, SaveAck::default()).unwrap();
    assert!(list_annotations(&read(&path)).unwrap().len() >= 4);
}

#[test]
fn a_save_result_holds_no_path() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("wire");
    let (id, path) = open(state, &scratch, "doc.pdf", &base());
    create(
        state,
        id,
        json!({"pageId": 1, "kind": "note", "color": [255, 235, 0], "at": {"x": 10.0, "y": 10.0}, "icon": "note"}),
    );
    let result: SaveResult = state.save_in_place(id, SaveAck::default()).unwrap();
    let wire = serde_json::to_string(&result).unwrap();
    assert!(!wire.contains(&*scratch.0.to_string_lossy()), "{wire}");
    assert!(!wire.contains(&*path.to_string_lossy()), "{wire}");
}

#[test]
fn a_page_with_rotate_is_saved_in_page_space_and_the_opacity_reads_back_as_ca() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("rotate");
    let mut builder = PdfBuilder::new();
    add_pages(&mut builder, &[Page::new("").with("/Rotate 90")]);
    builder.object(1, "<< /Type /Catalog /Pages 2 0 R >>");
    let (id, path) = open(state, &scratch, "turned.pdf", &builder.finish(1));
    let square = create(
        state,
        id,
        json!({"pageId": 0, "kind": "rect", "color": [10, 20, 200], "opacity": 0.5,
               "box": {"x": 100.0, "y": 50.0, "w": 80.0, "h": 40.0}, "width": 2.0, "fill": null, "dashed": false}),
    );
    let saved = state.save_in_place(id, SaveAck::default()).unwrap();
    assert!(saved.warnings.is_empty());

    let bytes = read(&path);
    // Page space is before /Rotate, so the rectangle is the one of an upright page (y up in the file).
    let in_file = list_annotations(&bytes).unwrap();
    let written = in_file.iter().find(|s| s.subtype == "Square").unwrap();
    assert!(written.has_appearance);
    let rect = square.rect;
    assert!(
        near(written.rect[0], rect.x)
            && near(written.rect[2], rect.x + rect.w)
            && near(written.rect[1], 792.0 - rect.y - rect.h)
            && near(written.rect[3], 792.0 - rect.y),
        "{:?} vs {rect:?}",
        written.rect
    );
    // The opacity is /CA of the annotation.
    assert!(
        written.opacity.is_some_and(|ca| near(ca, 0.5)),
        "{:?}",
        written.opacity
    );
    // The file loads again and the page is still turned: PDFium reopened it under the same id.
    assert_eq!(state.list_annotations(id, PageId::new(0)).unwrap().len(), 1);
}

#[test]
fn a_save_without_a_data_folder_says_that_no_backup_was_made() {
    if state().is_none() {
        return;
    }
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("pdfium");
    let state = AppState::new(Engine::start(engine::library_path(&root)));
    let scratch = Scratch::new("no-backup");
    let (id, path) = open(&state, &scratch, "doc.pdf", &base());
    create(
        &state,
        id,
        json!({"pageId": 1, "kind": "note", "color": [255, 235, 0], "at": {"x": 10.0, "y": 10.0}, "icon": "note"}),
    );
    let saved = state.save_in_place(id, SaveAck::default()).unwrap();
    assert!(!saved.backup_created);
    assert_eq!(saved.warnings, [SaveWarning::BackupSkipped]);
    assert!(read(&path).len() > base().len(), "the file was saved");
    let wire = serde_json::to_value(&saved).unwrap();
    assert_eq!(wire["warnings"], json!(["backupSkipped"]));
}

#[test]
fn an_empty_author_is_saved_without_a_t_entry_and_reads_back_as_none() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("noauthor");
    let (id, path) = open(state, &scratch, "noauthor.pdf", &base());
    let made = create(
        state,
        id,
        json!({"pageId": 1, "kind": "note", "color": [255, 235, 0], "at": {"x": 10.0, "y": 10.0}, "icon": "note", "author": "", "contents": "x"}),
    );
    assert!(made.author.as_deref().unwrap_or("").is_empty());
    state.save_in_place(id, SaveAck::default()).unwrap();
    let bytes = read(&path);
    let tail = String::from_utf8_lossy(&bytes[base().len()..]).into_owned();
    assert!(tail.contains("/Subtype /Text") || tail.contains("/Subtype/Text"));
    assert!(!tail.contains("/T ("), "no /T entry for an empty author");
    assert!(!tail.contains("/T("), "no /T entry for an empty author");
}
