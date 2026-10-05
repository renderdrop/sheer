//! The hostile corpus (`tests/fixtures/malformed/`, made by `tests/support/malformed.rs`) against the real PDFium, through the same
//! `AppState` the commands use, with PDFium in the engine child process (ADR-053). Every file is opened and then asked for what the viewer asks for: the page sizes, page 0 rendered,
//! its text layer and its links. The answer may be a document or a typed error. It may not be a panic, a hang, or an engine that is
//! dead afterwards (SECURITY P5, ORCHESTRATOR 13.3).
//!
//! Like the other engine tests this skips when PDFium has not been fetched (`npm run fetch-pdfium`). After changing a generator,
//! rewrite the files with
//!
//! ```text
//! SHEER_REGENERATE_FIXTURES=1 cargo test --manifest-path src-tauri/Cargo.toml --test fuzz_corpus
//! ```

// Test code: panicking on a broken fixture is the point (clippy.toml only exempts `#[test]` functions, not helpers).
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::mpsc;
use std::sync::Arc;
use std::time::Duration;

use sheer_lib::commands::render::{RenderPriority, RenderRequest};
use sheer_lib::commands::AppState;
use sheer_lib::documents::PageId;
use sheer_lib::engine::{self, Engine};
use sheer_lib::error::ErrorCode;
use support::{fixtures, malformed, PdfBuilder, TempFile};

/// How long one file may take for everything. A parser that loops on a cycle takes longer than this by far; a healthy file needs
/// well under a second. (A render that outlives its own 10 s deadline is a wedge, and then the engine replaces its worker.)
const PER_FILE: Duration = Duration::from_secs(15);

fn corpus_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("tests")
        .join("fixtures")
        .join("malformed")
}

fn state() -> Option<Arc<AppState>> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("pdfium");
    let library = engine::library_path(&root);
    if library.is_file() {
        // Through the engine child (ADR-053): a file that crashes or wedges PDFium costs a restart, never the app.
        Some(Arc::new(AppState::new(Engine::start_process(
            library,
            PathBuf::from(env!("CARGO_BIN_EXE_sheer")),
            None,
        ))))
    } else {
        // In CI a missing library is a failure, never a silent pass.
        assert!(
            std::env::var_os("CI").is_none(),
            "PDFium is missing and CI is set: fetch it before the tests"
        );
        eprintln!("skipping the fuzz corpus: {} not found", library.display());
        None
    }
}

#[test]
fn the_committed_corpus_is_what_the_generator_makes() {
    let regenerate = std::env::var_os("SHEER_REGENERATE_FIXTURES").is_some();
    let files = malformed::all();
    let mut stale = Vec::new();
    for (name, bytes) in &files {
        let path = corpus_dir().join(name);
        if regenerate {
            std::fs::write(&path, bytes).unwrap();
        } else if std::fs::read(&path).ok().as_deref() != Some(bytes.as_slice()) {
            stale.push(*name);
        }
    }
    assert!(
        stale.is_empty(),
        "tests/fixtures/malformed/{stale:?} differ from tests/support/malformed.rs: regenerate with SHEER_REGENERATE_FIXTURES=1"
    );
    // No file in the directory that the generator does not make.
    let made: BTreeSet<&str> = files.iter().map(|(name, _)| *name).collect();
    for entry in std::fs::read_dir(corpus_dir()).unwrap() {
        let name = entry.unwrap().file_name().into_string().unwrap();
        assert!(
            name == ".gitkeep" || made.contains(name.as_str()),
            "{name} is not made by tests/support/malformed.rs"
        );
    }
}

#[test]
fn the_corpus_is_big_small_and_made_of_distinct_files() {
    let files = malformed::all();
    assert!(files.len() >= 30, "only {} files", files.len());
    let names: BTreeSet<&str> = files.iter().map(|(name, _)| *name).collect();
    assert_eq!(names.len(), files.len(), "a name is used twice");
    for (name, bytes) in &files {
        assert!(bytes.len() < 32 * 1024, "{name} is {} bytes", bytes.len());
    }
}

/// Everything the viewer asks of a document, with every answer allowed to be an error. Returns the codes of the errors.
fn exercise(state: &AppState, name: &str, bytes: &[u8]) -> Vec<ErrorCode> {
    let file = TempFile::write(name, bytes);
    let mut errors = Vec::new();
    let opened = match state.open_path(file.0.clone()) {
        Ok(Some(info)) => info,
        Ok(None) => panic!("{name}: the file was reported as loading elsewhere"),
        Err(error) => return vec![error.code()],
    };
    let id = opened.id;
    let mut note = |result: Result<(), ErrorCode>| {
        if let Err(code) = result {
            errors.push(code);
        }
    };
    note(state.page_sizes(id).map(drop).map_err(|e| e.code()));
    let page = PageId::new(0);
    // The page id is the registry's, not the index: the first page of the document is the first the registry knows.
    for tile in [None, Some((0, 0))] {
        let request = RenderRequest {
            doc_id: id,
            page_id: page,
            bucket: 0,
            tile,
            priority: RenderPriority::Visible,
            generation: 1,
        };
        note(state.render_page(request).map(drop).map_err(|e| e.code()));
    }
    note(state.text_layer(id, page).map(drop).map_err(|e| e.code()));
    note(state.page_links(id, page).map(drop).map_err(|e| e.code()));
    note(
        state
            .list_annotations(id, page)
            .map(drop)
            .map_err(|e| e.code()),
    );
    note(state.close_document(id).map_err(|e| e.code()));
    errors
}

#[test]
fn every_malformed_file_ends_in_a_document_or_a_typed_error_never_a_panic_or_a_hang() {
    let Some(state) = state() else { return };
    for (name, bytes) in malformed::all() {
        let (sender, receiver) = mpsc::channel();
        let worker_state = Arc::clone(&state);
        let bytes_for_worker = bytes.clone();
        let handle = std::thread::spawn(move || {
            let codes = exercise(&worker_state, name, &bytes_for_worker);
            let _ = sender.send(codes);
        });
        let codes = receiver.recv_timeout(PER_FILE).unwrap_or_else(|_| {
            panic!("{name}: no answer within {PER_FILE:?}: a hang, or a panic")
        });
        handle.join().unwrap_or_else(|_| panic!("{name}: panicked"));
        eprintln!("{name}: {codes:?}");
        assert!(
            !codes.contains(&ErrorCode::Internal),
            "{name}: an internal error is a bug the file found: {codes:?}"
        );
        if name.starts_with("annots-") {
            assert!(
                !codes.contains(&ErrorCode::EngineCrashed),
                "{name}: the engine must report our own annotations: {codes:?}"
            );
        }
    }
    // The engine is still alive and still right after all of that.
    let good = fixtures::outline();
    let codes = exercise(&state, "after-the-corpus.pdf", &good);
    assert!(codes.is_empty(), "{codes:?}");
}

// --- known wedges (SECURITY P5, ROADMAP "Politur M1") ---
//
// Two files make PDFium work for a very long time inside one call. Since M7 (ADR-053) PDFium runs in the engine child, which the
// parent kills at the deadline, so they run with the rest. They are not in `malformed::all()` only because each costs the render
// deadline (twice, for the second strike). What they pin down is the part that is ours: the caller gets a typed error at its
// deadline, the engine restarts, and a good file opens afterwards.
//
// Note on the command line (`documents::intake::paths_from_args`): a dotless file name that follows a bare `--flag` is taken for
// the flag's value and skipped; give such a file with a path separator or an extension.

/// A tiling pattern whose step is a ten-thousandth of a point, painted over most of the page: billions of tiles.
fn tiny_xstep_tiling() -> Vec<u8> {
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

/// A Form XObject that draws itself twice: the number of draws doubles with every level it is allowed to go down.
fn self_calling_form() -> Vec<u8> {
    let mut builder = PdfBuilder::new();
    builder.object(1, "<< /Type /Catalog /Pages 2 0 R >>");
    builder.object(2, "<< /Type /Pages /Kids [10 0 R] /Count 1 >>");
    builder.object(
        10,
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 11 0 R \
         /Resources << /XObject << /Fm0 20 0 R >> >> >>",
    );
    builder.stream(11, "", b"/Fm0 Do");
    builder.stream(
        20,
        "/Type /XObject /Subtype /Form /BBox [0 0 612 792] /Resources << /XObject << /Fm0 20 0 R >> >>",
        b"0 0 5 5 re f /Fm0 Do /Fm0 Do",
    );
    builder.finish(1)
}

/// One wedge file, then a good one on the same engine: the wedge ends in typed errors within the render deadline plus the time the
/// engine needs to notice, and the engine is usable again without a restart.
fn wedge_then_recovery(name: &'static str, bytes: Vec<u8>) {
    let Some(state) = state() else { return };
    let codes = exercise(&state, name, &bytes);
    eprintln!("{name}: {codes:?}");
    assert!(!codes.contains(&ErrorCode::Internal), "{name}: {codes:?}");
    let good = fixtures::outline();
    // One file per test: the wedge tests run in parallel in one process, and a shared temp name collided on Windows
    // while the other test's engine still held the file open.
    let after = exercise(&state, &format!("after-{name}"), &good);
    assert!(
        after.is_empty(),
        "the engine did not recover after {name}: {after:?}"
    );
}

#[test]
fn a_tiny_xstep_tiling_pattern_ends_in_a_typed_error_and_the_engine_recovers() {
    wedge_then_recovery("tiny-xstep-tiling.pdf", tiny_xstep_tiling());
}

#[test]
fn a_self_calling_form_xobject_ends_in_a_typed_error_and_the_engine_recovers() {
    wedge_then_recovery("self-calling-form.pdf", self_calling_form());
}
