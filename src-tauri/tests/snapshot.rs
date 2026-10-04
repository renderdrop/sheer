//! The snapshot seam (ADR-049 §1) against the real PDFium: a document with unsaved edits is written into memory (Full, plain, never on
//! disk) and opened by the engine; a clean one is its own snapshot; the guard closes what it holds. Skips when the PDFium library is not
//! fetched (fails instead when `CI` is set).

#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use std::path::PathBuf;
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::time::Duration;

use serde_json::json;
use sheer_lib::commands::jobs::{EventSink, JobEvent, JobRegistry};
use sheer_lib::commands::{AppState, Opened};
use sheer_lib::documents::DocumentId;
use sheer_lib::documents::PageId;
use sheer_lib::engine::{self, Engine};
use sheer_lib::export::snapshot::{self, EngineDocRef, SnapshotGuard};
use sheer_lib::model::command::DocCommand;
use sheer_lib::model::redaction::RedactOptions;
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
            eprintln!("SKIPPED: PDFium is not fetched; the snapshot tests against the real engine did not run");
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
// --- What the snapshot contains -------------------------------------------------------------------------------------

const SECRET: &str = "SNAP-SECRET-4711";

fn command(value: serde_json::Value) -> DocCommand {
    serde_json::from_value(value).unwrap()
}

fn secret_pdf() -> Vec<u8> {
    let mut builder = PdfBuilder::new();
    let first = support::text_line(24, 72, 700, &format!("Account {SECRET} here"));
    add_pages(&mut builder, &[Page::new(&first), Page::new("")]);
    builder.object(1, "<< /Type /Catalog /Pages 2 0 R >>");
    builder.finish(1)
}

fn page_content(bytes: &[u8], page: usize) -> String {
    let doc = load_untrusted(bytes).unwrap();
    let id = *doc.get_pages().values().nth(page).unwrap();
    String::from_utf8_lossy(&doc.get_page_content(id)).into_owned()
}

fn snapshot_bytes(state: &AppState, id: DocumentId) -> (SnapshotGuard, Arc<[u8]>) {
    let guard = SnapshotGuard::current(state, id).unwrap();
    let bytes = guard
        .snapshot()
        .bytes
        .clone()
        .expect("a dirty document has bytes");
    (guard, bytes)
}

fn secret_hits(state: &AppState, id: DocumentId) -> Vec<[f32; 4]> {
    let layer = state.text_layer(id, PageId::new(0)).unwrap();
    let units: Vec<u16> = layer.text.encode_utf16().collect();
    let needle: Vec<u16> = SECRET.encode_utf16().collect();
    let at = units
        .windows(needle.len())
        .position(|w| w == needle.as_slice())
        .expect("the text layer has the secret");
    let mut rect = [f32::MAX, f32::MAX, f32::MIN, f32::MIN];
    for unit in at..at + needle.len() {
        let b = &layer.boxes[unit * 4..unit * 4 + 4];
        rect[0] = rect[0].min(b[0]);
        rect[1] = rect[1].min(b[1]);
        rect[2] = rect[2].max(b[0] + b[2]);
        rect[3] = rect[3].max(b[1] + b[3]);
    }
    vec![[rect[0], rect[1], rect[2] - rect[0], rect[3] - rect[1]]]
}

fn mark(hits: &[[f32; 4]]) -> DocCommand {
    let marks: Vec<_> = hits
        .iter()
        .map(|[x, y, w, h]| {
            json!({"pageId": 0, "source": "text",
                "quads": [[{"x": x, "y": y}, {"x": x + w, "y": y}, {"x": x, "y": y + h}, {"x": x + w, "y": y + h}]]})
        })
        .collect();
    command(json!({"type": "markRedactions", "marks": marks}))
}

#[test]
fn a_burned_text_box_is_page_content_in_the_snapshot() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("burn");
    let id = open(state, &scratch, &plain());
    state
        .apply_command(
            id,
            command(json!({"type": "createAnnotation", "draft": {
                "pageId": 0, "kind": "textBox", "color": [20, 40, 160], "opacity": 1.0,
                "box": {"x": 72.0, "y": 100.0, "w": 150.0, "h": 0.0},
                "text": "Burned in", "font": "serif", "fontSize": 14.0, "align": "left"
            }})),
        )
        .unwrap();
    let (guard, bytes) = snapshot_bytes(state, id);
    let content = page_content(&bytes, 0);
    assert!(
        content.contains("BT") && content.contains("Tj"),
        "{content}"
    );
    assert!(matches!(guard.engine(), EngineDocRef::Snapshot(_)));
}

#[test]
fn a_crop_is_in_the_snapshot_as_a_cropbox() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("crop");
    let id = open(state, &scratch, &plain());
    state
        .apply_command(
            id,
            command(json!({"type": "cropPages", "pages": [0], "spec": {
                "type": "margins", "top": 50.0, "right": 20.0, "bottom": 10.0, "left": 30.0
            }})),
        )
        .unwrap();
    let (_guard, bytes) = snapshot_bytes(state, id);
    let parsed = sheer_lib::pdfwrite::produce::load(&bytes).unwrap();
    let dict = parsed.doc.get_dictionary(parsed.pages[0]).unwrap();
    assert!(dict.get(b"CropBox").is_ok(), "the crop is written");
    let other = parsed.doc.get_dictionary(parsed.pages[1]).unwrap();
    assert!(
        other.get(b"CropBox").is_err(),
        "the other page is not cropped"
    );
}

struct Collect(Mutex<mpsc::Sender<JobEvent>>);

impl EventSink for Collect {
    fn send(&self, event: JobEvent) {
        let _ = self.0.lock().unwrap().send(event);
    }
}

#[test]
fn marks_alone_write_no_mark_and_an_applied_redaction_is_a_raster() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("redact");
    let id = open(state, &scratch, &secret_pdf());
    let found = secret_hits(state, id);
    state.apply_command(id, mark(&found)).unwrap();
    // Marks are model state: whatever the snapshot is, it has no redaction mark and the text is still there.
    let marks_only = SnapshotGuard::current(state, id).unwrap();
    if let Some(bytes) = &marks_only.snapshot().bytes {
        assert_eq!(annotation_count(bytes), 0, "no redaction mark is written");
        assert!(page_content(bytes, 0).contains(SECRET));
    }
    drop(marks_only);

    let jobs = Arc::new(JobRegistry::new());
    let (sender, receiver) = mpsc::channel();
    let opts = RedactOptions {
        pages: None,
        remove_metadata: true,
    };
    state
        .start_redaction(&jobs, id, &opts, Arc::new(Collect(Mutex::new(sender))))
        .unwrap();
    loop {
        match receiver.recv_timeout(Duration::from_secs(120)).unwrap() {
            JobEvent::Progress { .. } => {}
            JobEvent::Done { .. } => break,
            _ => panic!("the redaction did not finish"),
        }
    }
    let (_guard, bytes) = snapshot_bytes(state, id);
    let content = page_content(&bytes, 0);
    assert!(
        !content.contains("Tj"),
        "the redacted page has no text: {content}"
    );
    assert!(!bytes.windows(SECRET.len()).any(|w| w == SECRET.as_bytes()));
    assert!(
        content.contains("Do"),
        "the page is a raster now: {content}"
    );
    assert_eq!(annotation_count(&bytes), 0);
}

#[test]
fn the_snapshot_of_an_encrypted_original_is_a_plain_file() {
    use sheer_lib::pdfwrite::crypt;
    let Some(state) = state() else { return };
    let scratch = Scratch::new("encrypted");
    let bytes = crypt::testing::encrypt_legacy(&plain(), 4, "user4", "owner4").unwrap();
    let path = scratch.0.join("locked.pdf");
    std::fs::write(&path, &bytes).unwrap();
    let id = match state.open_outcome(path).unwrap() {
        Opened::Locked { id, .. } => {
            state
                .unlock(id, zeroize::Zeroizing::new("user4".to_owned()))
                .unwrap();
            id
        }
        _ => panic!("the file asks for its password"),
    };
    note(state, id);
    let (guard, snap) = snapshot_bytes(state, id);
    assert!(
        !crypt::testing::is_encrypted(&snap),
        "no password for the engine"
    );
    assert_eq!(annotation_count(&snap), 1);
    assert!(matches!(guard.engine(), EngineDocRef::Snapshot(_)));
}

#[test]
fn a_refused_snapshot_leaves_nothing_open_and_the_next_one_works() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("refused");
    let id = open(state, &scratch, &plain());
    note(state, id);
    let junk: Arc<[u8]> = Arc::from(&b"not a pdf at all"[..]);
    assert!(snapshot::open_bytes(state, junk).is_err());
    let guard = SnapshotGuard::current(state, id).unwrap();
    assert!(matches!(guard.engine(), EngineDocRef::Snapshot(_)));
}
