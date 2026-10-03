//! Page operations against the real PDFium (ADR-036): reorder, rotate, delete, insert (blank and from a file), undo, and the saved file
//! read back: order, rotation and which annotation is on which page. Skips when the PDFium library is not fetched.

#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use std::path::PathBuf;
use std::sync::OnceLock;

use serde_json::json;
use sheer_lib::commands::save::{SaveAck, SaveAsOptions, SaveMode};
use sheer_lib::commands::AppState;
use sheer_lib::documents::{DocumentId, PageId};
use sheer_lib::engine::{self, Engine};
use sheer_lib::error::ErrorCode;
use sheer_lib::model::command::DocCommand;
use sheer_lib::pdfwrite::inspect::list_annotations;
use support::fixtures::{add_pages, page_id, Page};
use support::PdfBuilder;

struct Scratch(PathBuf);

impl Scratch {
    fn new(name: &str) -> Self {
        let path = std::env::temp_dir().join(format!("sheer-pages-{}-{name}", std::process::id()));
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

/// Three pages; page `i` has a square named `sq-i`.
fn base(pages: u32) -> Vec<u8> {
    let mut builder = PdfBuilder::new();
    let list: Vec<Page> = (0..pages)
        .map(|i| Page::new("").with(&format!("/Annots [{} 0 R]", 100 + i)))
        .collect();
    add_pages(&mut builder, &list);
    for i in 0..pages {
        builder.object(
            100 + i,
            &format!(
                "<< /Type /Annot /Subtype /Square /Rect [200 500 300 560] /C [0 0 1] /NM (sq-{i}) /P {} 0 R >>",
                page_id(i)
            ),
        );
    }
    builder.object(1, "<< /Type /Catalog /Pages 2 0 R >>");
    builder.finish(1)
}

fn open(state: &AppState, scratch: &Scratch, name: &str, bytes: &[u8]) -> DocumentId {
    let path = scratch.file(name);
    std::fs::write(&path, bytes).unwrap();
    state.open_path(path).unwrap().expect("loaded").id
}

fn cmd(value: serde_json::Value) -> DocCommand {
    serde_json::from_value(value).unwrap()
}

fn ids(state: &AppState, id: DocumentId) -> Vec<u32> {
    state
        .pages(id)
        .unwrap()
        .iter()
        .map(|page| page.id.get())
        .collect()
}

#[test]
fn reorder_rotate_delete_insert_save_and_read_back() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("round");
    let id = open(state, &scratch, "a.pdf", &base(3));
    assert_eq!(ids(state, id), [0, 1, 2]);

    state
        .apply_command(
            id,
            cmd(json!({"type": "rotatePages", "pages": [0], "quarterTurns": 1})),
        )
        .unwrap();
    let moved = state
        .apply_command(
            id,
            cmd(json!({"type": "movePages", "pages": [2], "toIndex": 0})),
        )
        .unwrap();
    assert_eq!(moved.pages.unwrap().len(), 3);
    assert_eq!(ids(state, id), [2, 0, 1]);
    let inserted = state
        .apply_command(id, cmd(json!({"type": "insertBlankPage", "at": 3})))
        .unwrap();
    assert_eq!(
        inserted.pages.unwrap()[3].id.get(),
        3,
        "new pages get new ids"
    );
    state
        .apply_command(id, cmd(json!({"type": "deletePages", "pages": [1]})))
        .unwrap();
    assert_eq!(ids(state, id), [2, 0, 3]);
    // The page the engine draws for an id follows the move.
    assert_eq!(state.list_annotations(id, PageId::new(2)).unwrap().len(), 1);

    // Undo brings the deleted page back at its place, with its annotation; redo takes it away again.
    state.undo(id).unwrap();
    assert_eq!(ids(state, id), [2, 0, 1, 3]);
    assert_eq!(state.list_annotations(id, PageId::new(1)).unwrap().len(), 1);
    state.redo(id).unwrap();
    assert_eq!(ids(state, id), [2, 0, 3]);
    assert!(state.list_annotations(id, PageId::new(1)).is_err());

    // The last page cannot be deleted.
    let refused = state.apply_command(id, cmd(json!({"type": "deletePages", "pages": [2, 0, 3]})));
    assert_eq!(refused.unwrap_err().code(), ErrorCode::InvalidArgument);

    state
        .apply_command(
            id,
            cmd(json!({"type": "createAnnotation", "draft": {
                "pageId": 2, "kind": "note", "color": [255, 235, 0],
                "at": {"x": 10.0, "y": 10.0}, "icon": "comment", "contents": "moved"
            }})),
        )
        .unwrap();

    let saved = state.save_in_place(id, SaveAck::default()).unwrap();
    assert_eq!(saved.mode, SaveMode::Incremental);
    assert_eq!(saved.changes.pages.as_ref().unwrap().len(), 3);
    assert_eq!(ids(state, id), [2, 0, 3], "ids survive a save");

    // Read the file back with another reader.
    let bytes = std::fs::read(scratch.file("a.pdf")).unwrap();
    let annotations = list_annotations(&bytes).unwrap();
    let on = |name: &str| {
        annotations
            .iter()
            .find(|a| a.name.as_deref() == Some(name))
            .map(|a| a.page_index)
    };
    assert_eq!(on("sq-2"), Some(0));
    assert_eq!(on("sq-0"), Some(1));
    assert_eq!(on("sq-1"), None, "the deleted page is out of the tree");
    assert!(annotations
        .iter()
        .any(|a| a.subtype == "Text" && a.page_index == 0));
    std::fs::copy(scratch.file("a.pdf"), scratch.file("b.pdf")).unwrap();
    let again = state
        .open_path(scratch.file("b.pdf"))
        .unwrap()
        .expect("loaded")
        .id;
    let pages = state.pages(again).unwrap();
    assert_eq!(pages.len(), 3);
    assert_eq!(pages[1].rotation, 90);
    assert_eq!(pages[0].rotation, 0);
    assert_eq!(pages[2].origin, "file");
}

#[test]
fn a_clean_copy_leaves_the_deleted_page_out_of_the_file() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("clean");
    let id = open(state, &scratch, "a.pdf", &base(3));
    state
        .apply_command(id, cmd(json!({"type": "deletePages", "pages": [1]})))
        .unwrap();
    let saved = state
        .save_as_with(
            id,
            &scratch.file("copy.pdf"),
            SaveAck::default(),
            SaveAsOptions { clean_copy: true },
        )
        .unwrap();
    assert_eq!(saved.mode, SaveMode::Full);
    let bytes = std::fs::read(scratch.file("copy.pdf")).unwrap();
    let names: Vec<_> = list_annotations(&bytes)
        .unwrap()
        .into_iter()
        .filter_map(|a| a.name)
        .collect();
    assert_eq!(names, ["sq-0", "sq-2"]);
    assert!(!String::from_utf8_lossy(&bytes).contains("sq-1"));
}

#[test]
fn pages_of_another_file_are_inserted_and_saved() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("insert");
    let id = open(state, &scratch, "a.pdf", &base(2));
    let other = scratch.file("other.pdf");
    std::fs::write(&other, base(3)).unwrap();
    let source = match state.add_sources(vec![other]).remove(0) {
        sheer_lib::commands::pages::SourceResult::Ready {
            source_id,
            page_count,
            ..
        } => {
            assert_eq!(page_count, 3);
            source_id
        }
        failed => panic!("{failed:?}"),
    };
    let changes = state
        .apply_command(
            id,
            cmd(json!({"type": "insertPages", "source": source, "pages": [2, 0], "at": 1})),
        )
        .unwrap();
    let list = changes.pages.unwrap();
    assert_eq!(
        list.iter().map(|p| p.origin).collect::<Vec<_>>(),
        ["file", "imported", "imported", "file"]
    );
    let bad = state.apply_command(
        id,
        cmd(json!({"type": "insertPages", "source": source, "pages": [3], "at": 0})),
    );
    assert_eq!(bad.unwrap_err().code(), ErrorCode::InvalidArgument);
    state.save_in_place(id, SaveAck::default()).unwrap();
    let bytes = std::fs::read(scratch.file("a.pdf")).unwrap();
    let annotations = list_annotations(&bytes).unwrap();
    let on = |name: &str, nth: usize| {
        annotations
            .iter()
            .filter(|a| a.name.as_deref() == Some(name))
            .nth(nth)
            .map(|a| a.page_index)
    };
    assert_eq!(on("sq-0", 0), Some(0));
    assert_eq!(on("sq-2", 0), Some(1), "copied from the source's page 2");
    assert_eq!(on("sq-0", 1), Some(2));
    assert_eq!(on("sq-1", 0), Some(3));
    let pages = state.pages(id).unwrap();
    assert!(pages.iter().all(|p| p.origin == "file"));
}
fn source_of(state: &AppState, path: PathBuf) -> sheer_lib::model::page::SourceId {
    match state.add_sources(vec![path]).remove(0) {
        sheer_lib::commands::pages::SourceResult::Ready { source_id, .. } => source_id,
        failed => panic!("{failed:?}"),
    }
}

#[test]
fn annotations_of_inserted_pages_join_the_model_and_leave_with_an_undo() {
    use sheer_lib::model::annotation::Sync;
    let Some(state) = state() else { return };
    let scratch = Scratch::new("insert-annots");
    let id = open(state, &scratch, "a.pdf", &base(1));
    let other = scratch.file("other.pdf");
    std::fs::write(&other, base(2)).unwrap();
    let source = source_of(state, other);
    let changes = state
        .apply_command(
            id,
            cmd(json!({"type": "insertPages", "source": source, "pages": [1], "at": 1})),
        )
        .unwrap();
    let page = changes.pages.unwrap()[1].id;
    let listed = state.list_annotations(id, page).unwrap();
    assert_eq!(listed.len(), 1, "read from the engine's copy of the page");
    let annotation = listed[0].clone();
    assert_eq!(annotation.sync, Sync::Clean);
    assert_eq!(annotation.page_id, page);
    assert_eq!(state.list_document_annotations(id).unwrap().len(), 2);

    // Editable: a move makes it modified; deleting and undoing work too.
    let moved = state
        .apply_command(
            id,
            cmd(json!({"type": "moveAnnotations", "ids": [annotation.id], "dx": 10.0, "dy": 0.0})),
        )
        .unwrap();
    assert_eq!(moved.upserted[0].sync, Sync::Modified);
    state.undo(id).unwrap();
    let deleted = state
        .apply_command(
            id,
            cmd(json!({"type": "deleteAnnotations", "ids": [annotation.id]})),
        )
        .unwrap();
    assert_eq!(deleted.removed, [annotation.id]);
    assert!(state.list_annotations(id, page).unwrap().is_empty());
    state.undo(id).unwrap();
    assert_eq!(state.list_annotations(id, page).unwrap().len(), 1);

    // Undo of the insert takes the page and its annotations out; redo brings them back.
    state.undo(id).unwrap();
    assert_eq!(state.list_document_annotations(id).unwrap().len(), 1);
    assert!(state.list_annotations(id, page).is_err());
    state.redo(id).unwrap();
    assert_eq!(state.list_annotations(id, page).unwrap().len(), 1);

    // Saved, the page's square is in the file once, and the model still has it once.
    state.save_in_place(id, SaveAck::default()).unwrap();
    let bytes = std::fs::read(scratch.file("a.pdf")).unwrap();
    let on_page_1 = list_annotations(&bytes)
        .unwrap()
        .iter()
        .filter(|a| a.page_index == 1 && a.subtype == "Square")
        .count();
    assert_eq!(on_page_1, 1);
    let after = state.pages(id).unwrap();
    assert_eq!(state.list_annotations(id, after[1].id).unwrap().len(), 1);
    assert_eq!(state.list_document_annotations(id).unwrap().len(), 2);
}

#[test]
fn an_annotation_without_a_name_is_found_again_behind_a_dropped_widget() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("no-nm");
    let id = open(state, &scratch, "a.pdf", &base(1));
    // The source page: a widget (dropped by the copy), then two squares that have no /NM.
    let mut builder = PdfBuilder::new();
    add_pages(
        &mut builder,
        &[Page::new("").with("/Annots [100 0 R 101 0 R 102 0 R]")],
    );
    builder.object(
        100,
        "<< /Type /Annot /Subtype /Widget /FT /Tx /T (f) /Rect [10 700 90 720] >>",
    );
    builder.object(
        101,
        "<< /Type /Annot /Subtype /Square /Rect [10 10 60 60] /C [1 0 0] >>",
    );
    builder.object(
        102,
        "<< /Type /Annot /Subtype /Square /Rect [200 500 300 560] /C [0 0 1] >>",
    );
    builder.object(1, "<< /Type /Catalog /Pages 2 0 R >>");
    let other = scratch.file("other.pdf");
    std::fs::write(&other, builder.finish(1)).unwrap();
    let source = source_of(state, other);
    let page = state
        .apply_command(
            id,
            cmd(json!({"type": "insertPages", "source": source, "pages": [0], "at": 1})),
        )
        .unwrap()
        .pages
        .unwrap()[1]
        .id;
    let listed = state.list_annotations(id, page).unwrap();
    assert_eq!(
        listed.len(),
        2,
        "the widget is not an annotation of the model"
    );
    let left = listed.iter().find(|a| a.rect.x < 100.0).unwrap();
    state
        .apply_command(
            id,
            cmd(json!({"type": "deleteAnnotations", "ids": [left.id]})),
        )
        .unwrap();
    state.save_in_place(id, SaveAck::default()).unwrap();
    let bytes = std::fs::read(scratch.file("a.pdf")).unwrap();
    let squares: Vec<_> = list_annotations(&bytes)
        .unwrap()
        .into_iter()
        .filter(|a| a.page_index == 1 && a.subtype == "Square")
        .collect();
    assert_eq!(squares.len(), 1, "the deleted square is gone");
    assert!(
        squares[0].rect[0] > 100.0,
        "and the other one is the one left"
    );
}

#[test]
fn a_page_change_in_a_signed_file_asks_first_and_writes_nothing_until_agreed() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("signed");
    let id = open(state, &scratch, "s.pdf", &support::fixtures::signed());
    state
        .apply_command(
            id,
            cmd(json!({"type": "rotatePages", "pages": [0], "quarterTurns": 1})),
        )
        .unwrap();
    let before = std::fs::read(scratch.file("s.pdf")).unwrap();
    let error = state.save_in_place(id, SaveAck::default()).unwrap_err();
    assert_eq!(error.code(), ErrorCode::NeedsConfirmation);
    assert_eq!(std::fs::read(scratch.file("s.pdf")).unwrap(), before);
    let ack = SaveAck {
        break_signature: true,
        ..SaveAck::default()
    };
    state.save_in_place(id, ack).unwrap();
    assert!(std::fs::read(scratch.file("s.pdf")).unwrap().len() > before.len());
}

#[test]
fn a_clean_copy_of_a_signed_file_asks_first_and_an_unchanged_signed_file_saves_without_asking() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("signed-copy");
    let id = open(state, &scratch, "s.pdf", &support::fixtures::signed());
    let error = state
        .save_as_with(
            id,
            &scratch.file("c.pdf"),
            SaveAck::default(),
            SaveAsOptions { clean_copy: true },
        )
        .unwrap_err();
    assert_eq!(error.code(), ErrorCode::NeedsConfirmation);
    assert!(!scratch.file("c.pdf").exists());
    state.save_in_place(id, SaveAck::default()).unwrap();
}

#[test]
fn the_last_page_is_never_deleted_and_the_refusal_changes_nothing() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("last");
    let id = open(state, &scratch, "a.pdf", &base(2));
    state
        .apply_command(id, cmd(json!({"type": "deletePages", "pages": [0]})))
        .unwrap();
    assert!(state
        .apply_command(id, cmd(json!({"type": "deletePages", "pages": [1]})))
        .is_err());
    assert_eq!(ids(state, id), [1]);
    assert_eq!(state.list_annotations(id, PageId::new(1)).unwrap().len(), 1);
    state.undo(id).unwrap();
    assert_eq!(ids(state, id), [0, 1]);
    assert_eq!(state.list_annotations(id, PageId::new(0)).unwrap().len(), 1);
}
