//! The PDF engine as a child process (ADR-053 §1) against the real PDFium: the same executable started with `--sheer-engine` serves
//! the same frames as the in-process worker, and a child that is killed in the middle of a render is replaced, the open documents are
//! reopened with their rotations, and a document that was in flight at two deaths is shut out. Skips, like the other engine tests,
//! when PDFium has not been fetched (`npm run fetch-pdfium`).

// Test code: panicking on a broken fixture is the point.
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use std::fs::File;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use sheer_lib::documents::DocumentId;
use sheer_lib::engine::{self, Engine, Priority, RenderKey, RenderSpec};
use sheer_lib::error::ErrorCode;
use support::fixtures::numbered_pages;
use support::{PdfBuilder, TempFile};

fn id(n: u32) -> DocumentId {
    serde_json::from_value(serde_json::json!(n)).unwrap()
}

fn library() -> Option<PathBuf> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("pdfium");
    let library = engine::library_path(&root);
    if library.is_file() {
        Some(library)
    } else {
        // In CI a missing library is a failure, never a silent pass.
        assert!(
            std::env::var_os("CI").is_none(),
            "PDFium is missing and CI is set: fetch it before the tests"
        );
        eprintln!(
            "skipping the engine process tests: {} not found",
            library.display()
        );
        None
    }
}

/// One in-process engine for the whole test binary: two of them in one process would be two PDFium libraries at once.
fn shared_local(library: PathBuf) -> &'static Engine {
    static LOCAL: OnceLock<Engine> = OnceLock::new();
    LOCAL.get_or_init(|| Engine::start(library))
}

type Restarts = Arc<Mutex<Vec<Vec<DocumentId>>>>;

/// An engine in a child process of the real executable, and what it reported about restarts.
fn process_engine(library: PathBuf) -> (Engine, Restarts) {
    let restarts: Restarts = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&restarts);
    let engine = Engine::start_process(
        library,
        PathBuf::from(env!("CARGO_BIN_EXE_sheer")),
        Some(Arc::new(move |lost| sink.lock().unwrap().push(lost))),
    );
    (engine, restarts)
}

fn open(engine: &Engine, doc: DocumentId, file: &TempFile) -> u32 {
    engine
        .open(doc, File::open(&file.0).unwrap(), |_| true)
        .unwrap()
}

fn render(engine: &Engine, doc: DocumentId) -> Result<Vec<u8>, ErrorCode> {
    engine
        .render(RenderSpec {
            key: RenderKey {
                id: doc,
                page_index: 0,
                bucket: 0,
                tile: None,
            },
            priority: Priority::Visible,
            generation: 1,
        })
        .map(|frame| frame.to_vec())
        .map_err(|error| error.code())
}

/// Ends process `pid` from outside, the way a crash does.
fn kill(pid: u32) {
    #[cfg(windows)]
    let status = Command::new("taskkill")
        .args(["/F", "/PID", &pid.to_string()])
        .output();
    #[cfg(not(windows))]
    let status = Command::new("kill").args(["-9", &pid.to_string()]).output();
    assert!(status.unwrap().status.success(), "could not kill {pid}");
}

/// A tiling pattern whose step is a ten-thousandth of a point: PDFium works for minutes inside one render call.
fn wedge() -> Vec<u8> {
    let mut builder = PdfBuilder::new();
    builder.object(1, "<< /Type /Catalog /Pages 2 0 R >>");
    builder.object(2, "<< /Type /Pages /Kids [10 0 R] /Count 1 >>");
    builder.object(
        10,
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 11 0 R \
         /Resources << /Pattern << /P0 20 0 R >> /ColorSpace << /Cs0 [/Pattern] >> >> >>",
    );
    builder.stream(11, "", b"/Cs0 cs /P0 scn 0 0 600 780 re f");
    builder.stream(
        20,
        "/Type /Pattern /PatternType 1 /PaintType 1 /TilingType 1 /BBox [0 0 10 10] /XStep 0.0001 /YStep 0.0001",
        b"0 0 5 5 re f",
    );
    builder.finish(1)
}

/// Starts a render of `doc` on another thread, waits until the child is busy with it, kills the child, and returns the render's
/// answer.
fn kill_mid_render(engine: &Engine, doc: DocumentId) -> Result<Vec<u8>, ErrorCode> {
    let renderer = engine.clone();
    let handle = thread::spawn(move || render(&renderer, doc));
    thread::sleep(Duration::from_millis(700));
    kill(engine.child_id().expect("a child is running"));
    let started = Instant::now();
    let answer = handle.join().unwrap();
    assert!(
        started.elapsed() < Duration::from_secs(8),
        "the caller waited for its deadline instead of hearing of the death"
    );
    answer
}

#[test]
fn the_child_serves_the_same_frames_as_the_in_process_worker() {
    let Some(library) = library() else { return };
    let (child, _) = process_engine(library.clone());
    let local = shared_local(library);
    let file = TempFile::write("parity.pdf", &numbered_pages(3, 2));
    assert_eq!(open(&child, id(1), &file), 3);
    assert_eq!(open(local, id(1), &file), 3);
    assert!(child.child_id().is_some());
    assert_eq!(
        child.page_sizes(id(1)).unwrap(),
        local.page_sizes(id(1)).unwrap()
    );
    for page in 0..3 {
        let key = RenderKey {
            id: id(1),
            page_index: page,
            bucket: 0,
            tile: None,
        };
        let spec = RenderSpec {
            key,
            priority: Priority::Visible,
            generation: 1,
        };
        assert_eq!(
            child.render(spec).unwrap(),
            local.render(spec).unwrap(),
            "page {page}"
        );
    }
    // Reads travel too, and so do errors.
    assert_eq!(
        child.text_layer(id(1), 0).unwrap(),
        local.text_layer(id(1), 0).unwrap()
    );
    assert_eq!(
        child.text_layer(id(1), 99).unwrap_err().code(),
        ErrorCode::InvalidArgument
    );
    child.close(id(1)).unwrap();
    assert!(child.page_sizes(id(1)).is_err());
}

#[test]
fn a_child_killed_mid_render_is_replaced_and_the_documents_come_back_as_they_were() {
    let Some(library) = library() else { return };
    let (child, restarts) = process_engine(library.clone());
    let local = shared_local(library);
    let good = TempFile::write("rotated.pdf", &numbered_pages(2, 2));
    let bad = TempFile::write("wedge.pdf", &wedge());
    open(&child, id(1), &good);
    open(local, id(11), &good);
    open(&child, id(2), &bad);
    child.set_page_rotations(id(1), vec![(0, 90)]).unwrap();
    local.set_page_rotations(id(11), vec![(0, 90)]).unwrap();
    child
        .set_annotations_hidden(id(1), vec![(0, 0)], vec![])
        .unwrap();
    let first_child = child.child_id().unwrap();

    // The wedge render is in flight when the child dies.
    assert_eq!(
        kill_mid_render(&child, id(2)),
        Err(ErrorCode::EngineCrashed)
    );
    assert_ne!(child.child_id().unwrap(), first_child, "no new child");
    assert_eq!(
        restarts.lock().unwrap().as_slice(),
        [Vec::<DocumentId>::new()]
    );

    // The other document is back with its rotation: its frame is the rotated one, as the in-process engine draws it.
    let after = render(&child, id(1)).unwrap();
    assert_eq!(after, render(local, id(11)).unwrap());
    assert_eq!(
        child.page_sizes(id(1)).unwrap(),
        local.page_sizes(id(11)).unwrap()
    );

    // The wedge document is in flight at a second death: it is shut out, and the app is told.
    assert_eq!(
        kill_mid_render(&child, id(2)),
        Err(ErrorCode::EngineCrashed)
    );
    assert_eq!(restarts.lock().unwrap().last().unwrap(), &vec![id(2)]);
    assert_eq!(render(&child, id(2)), Err(ErrorCode::EngineCrashed));
    assert_eq!(render(&child, id(1)).unwrap(), after);

    // Closing it clears the quarantine; opening the good file again works.
    child.close(id(2)).unwrap();
    open(&child, id(3), &good);
    assert!(render(&child, id(3)).is_ok());
}

#[test]
fn a_render_past_its_deadline_kills_the_child_and_the_engine_recovers() {
    let Some(library) = library() else { return };
    let (child, restarts) = process_engine(library);
    let good = TempFile::write("deadline-good.pdf", &numbered_pages(1, 1));
    let bad = TempFile::write("deadline-wedge.pdf", &wedge());
    open(&child, id(1), &good);
    open(&child, id(2), &bad);
    let started = Instant::now();
    assert_eq!(render(&child, id(2)), Err(ErrorCode::EngineTimeout));
    assert!(started.elapsed() < Duration::from_secs(30));
    // The caller gives up at the same moment as the engine does: the restart may still be under way.
    let until = Instant::now() + Duration::from_secs(20);
    while restarts.lock().unwrap().is_empty() && Instant::now() < until {
        thread::sleep(Duration::from_millis(50));
    }
    assert_eq!(restarts.lock().unwrap().len(), 1);
    assert!(render(&child, id(1)).is_ok());
}

#[test]
fn deaths_past_the_restart_budget_leave_the_engine_unavailable() {
    let Some(library) = library() else { return };
    let (child, restarts) = process_engine(library);
    let good = TempFile::write("budget.pdf", &numbered_pages(1, 1));
    open(&child, id(1), &good);
    // A snapshot job names no document, so no document is struck down while the budget runs out.
    let snapshot = Arc::<[u8]>::from(numbered_pages(1, 1));
    for _ in 0..sheer_lib::limits::ENGINE_RESTART_BUDGET {
        kill(child.child_id().unwrap());
        let error = child.open_snapshot(Arc::clone(&snapshot)).unwrap_err();
        assert_eq!(error.code(), ErrorCode::EngineCrashed);
    }
    assert!(render(&child, id(1)).is_ok());
    kill(child.child_id().unwrap());
    assert_eq!(
        child
            .open_snapshot(Arc::clone(&snapshot))
            .unwrap_err()
            .code(),
        ErrorCode::EngineCrashed
    );
    // The budget is spent: the document is lost, and nothing starts again.
    assert_eq!(restarts.lock().unwrap().last().unwrap(), &vec![id(1)]);
    assert_eq!(
        child.open_snapshot(snapshot).unwrap_err().code(),
        ErrorCode::EngineUnavailable
    );
    assert_eq!(render(&child, id(1)), Err(ErrorCode::EngineCrashed));
}
