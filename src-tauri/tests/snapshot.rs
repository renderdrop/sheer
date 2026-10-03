//! The snapshot seam (ADR-049 §1) against the real PDFium: a document with unsaved edits is written into memory (Full, plain, never on
//! disk) and opened by the engine; a clean one is its own snapshot; the guard closes what it holds. Skips when the PDFium library is not
//! fetched (fails instead when `CI` is set).

#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use std::path::PathBuf;
use std::sync::OnceLock;

use serde_json::json;
use sheer_lib::commands::{AppState, Opened};
use sheer_lib::documents::DocumentId;
use sheer_lib::engine::{self, Engine};
use sheer_lib::export::snapshot::{self, EngineDocRef, SnapshotGuard};
use sheer_lib::model::command::DocCommand;
use sheer_lib::pdfwrite::load_untrusted;
use sheer_lib::pdfwrite::save::{write_to_memory, SavePlan};
use support::fixtures::{add_pages, Page};
use support::PdfBuilder;

struct Scratch(PathBuf);

impl Scratch {
    fn new(name: &str) -> Self {
        let path =
            std::env::temp_dir().join(format!("sheer-snapshot-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }

    fn listing(&self) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(&self.0)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
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

fn plain() -> Vec<u8> {
    let mut builder = PdfBuilder::new();
    add_pages(&mut builder, &[Page::new(""), Page::new("")]);
    builder.object(1, "<< /Type /Catalog /Pages 2 0 R >>");
    builder.finish(1)
}

fn open(state: &AppState, scratch: &Scratch, bytes: &[u8]) -> DocumentId {
    let path = scratch.0.join("doc.pdf");
    std::fs::write(&path, bytes).unwrap();
    match state.open_outcome(path).unwrap() {
        Opened::Ready(info) => info.id,
        _ => panic!("the fixture opens without a password"),
    }
}

fn note(state: &AppState, id: DocumentId) {
    let command: DocCommand = serde_json::from_value(json!({"type": "createAnnotation", "draft": {
        "pageId": 0, "kind": "note", "color": [255, 235, 0],
        "at": {"x": 10.0, "y": 10.0}, "icon": "comment", "contents": "hello"
    }}))
    .unwrap();
    state.apply_command(id, command).unwrap();
}

fn annotation_count(bytes: &[u8]) -> usize {
    let doc = load_untrusted(bytes).unwrap();
    let page = *doc.get_pages().values().next().unwrap();
    doc.get_page_annotations(page).unwrap_or_default().len()
}

#[test]
fn a_clean_document_is_its_own_snapshot() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("clean");
    let id = open(state, &scratch, &plain());
    let snapshot = snapshot::current(state, id).unwrap();
    assert!(snapshot.bytes.is_none());
    assert_eq!(snapshot.engine, EngineDocRef::Live(id));
}

#[test]
fn the_snapshot_of_a_dirty_document_has_the_unsaved_edits_and_never_touches_the_disk() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("dirty");
    let original = plain();
    let id = open(state, &scratch, &original);
    note(state, id);
    let before = scratch.listing();

    let guard = SnapshotGuard::current(state, id).unwrap();
    let EngineDocRef::Snapshot(_) = guard.engine() else {
        panic!("a document with unsaved changes is written into memory");
    };
    let bytes = guard.snapshot().bytes.clone().expect("bytes");
    // The unsaved note is in it, as a whole file: one cross-reference section, two pages, no password.
    assert_eq!(annotation_count(&bytes), 1);
    assert_eq!(load_untrusted(&bytes).unwrap().get_pages().len(), 2);
    assert_eq!(bytes.windows(9).filter(|w| *w == b"startxref").count(), 1);
    // The disk is as it was: same file, same folder, still unsaved in the model.
    assert_eq!(std::fs::read(scratch.0.join("doc.pdf")).unwrap(), original);
    assert_eq!(scratch.listing(), before);
    assert!(state.has_unsaved_changes(id));
    drop(guard);
    assert_eq!(scratch.listing(), before);
    // Another snapshot after the first one was closed.
    let again = SnapshotGuard::current(state, id).unwrap();
    assert_ne!(again.engine(), EngineDocRef::Live(id));
}

#[test]
fn a_snapshot_of_a_document_with_changed_pages_has_the_new_page_list() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("pages");
    let id = open(state, &scratch, &plain());
    let command: DocCommand =
        serde_json::from_value(json!({"type": "deletePages", "pages": [1]})).unwrap();
    state.apply_command(id, command).unwrap();
    let snapshot = snapshot::current(state, id).unwrap();
    let guard = SnapshotGuard::hold(state, snapshot);
    let bytes = guard.snapshot().bytes.clone().expect("bytes");
    assert_eq!(load_untrusted(&bytes).unwrap().get_pages().len(), 1);
}

#[test]
fn write_to_memory_makes_a_whole_plain_file() {
    let bytes = write_to_memory(&SavePlan::default(), &plain()).unwrap();
    assert_eq!(load_untrusted(&bytes).unwrap().get_pages().len(), 2);
    assert_eq!(bytes.windows(9).filter(|w| *w == b"startxref").count(), 1);
    assert!(write_to_memory(&SavePlan::default(), b"not a pdf").is_err());
}
