//! New-file jobs (ADR-036 §6, M3 package R3) against the real PDFium, through the same `AppState` the commands use: extract, split,
//! merge and compress write files that PDFium opens again, nothing is overwritten, a cancelled split leaves nothing, and the hostile
//! corpus never panics a producer. Skips, like the other engine tests, when the library is not fetched.

// Test code: panicking on a broken fixture is the point.
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use sheer_lib::commands::jobs::{EventSink, JobEvent, JobId, JobRegistry, MergeInput, SplitPlan};
use sheer_lib::commands::AppState;
use sheer_lib::documents::{DocumentId, PageId};
use sheer_lib::engine::{self, Engine};
use sheer_lib::error::{AppError, ErrorCode};
use sheer_lib::pdfwrite::compress::{self, Preset};
use sheer_lib::pdfwrite::produce::{self, PageSel, Unattended};
use support::fixtures::numbered_pages;
use support::{malformed, PdfBuilder};

struct Scratch(PathBuf);

impl Scratch {
    fn new(name: &str) -> Self {
        let path = std::env::temp_dir().join(format!("sheer-jobs-{}-{name}", std::process::id()));
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
            if library.is_file() {
                Some(AppState::new(Engine::start(library)))
            } else {
                eprintln!("skipping the job tests: {} not found", library.display());
                None
            }
        })
        .as_ref()
}

struct Collect(Mutex<mpsc::Sender<JobEvent>>);

impl EventSink for Collect {
    fn send(&self, event: JobEvent) {
        let _ = self.0.lock().unwrap().send(event);
    }
}

fn channel() -> (Arc<dyn EventSink>, mpsc::Receiver<JobEvent>) {
    let (sender, receiver) = mpsc::channel();
    (Arc::new(Collect(Mutex::new(sender))), receiver)
}

/// Waits for the one final message of a job.
fn finish(receiver: &mpsc::Receiver<JobEvent>) -> JobEvent {
    loop {
        match receiver.recv_timeout(Duration::from_secs(60)).unwrap() {
            JobEvent::Progress { .. } => {}
            other => return other,
        }
    }
}

fn open(state: &AppState, scratch: &Scratch, name: &str, bytes: &[u8]) -> DocumentId {
    let path = scratch.file(name);
    std::fs::write(&path, bytes).unwrap();
    state.open_path(path).unwrap().expect("loaded").id
}

fn pages_of(path: &Path) -> usize {
    produce::load(&std::fs::read(path).unwrap())
        .unwrap()
        .pages
        .len()
}

fn done(event: JobEvent) -> (u32, u64, u64, Option<sheer_lib::documents::DocumentInfo>) {
    match event {
        JobEvent::Done {
            outputs,
            bytes_before,
            bytes_after,
            opened,
            ..
        } => (outputs, bytes_before, bytes_after, opened),
        other => panic!("expected done, got {other:?}"),
    }
}

#[test]
fn extract_writes_the_pages_and_opens_them() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("extract");
    let id = open(state, &scratch, "six.pdf", &numbered_pages(6, 2));
    let jobs = Arc::new(JobRegistry::new());
    let (sink, receiver) = channel();
    let target = scratch.file("out.pdf");
    state
        .start_extract(&jobs, id, &[PageId::new(4), PageId::new(1)], &target, sink)
        .unwrap();
    let (outputs, _, _, opened) = done(finish(&receiver));
    assert_eq!(outputs, 1);
    assert_eq!(opened.expect("opened as a document").page_count, 2);
    assert_eq!(pages_of(&target), 2);

    // The target may not be a document that is open.
    let (sink, _) = channel();
    let error = state
        .start_extract(&jobs, id, &[PageId::new(0)], &scratch.file("six.pdf"), sink)
        .unwrap_err();
    assert_eq!(error.code(), ErrorCode::IoInUse);
    // Unknown, repeated and no pages are refused before anything runs.
    for bad in [
        vec![],
        vec![PageId::new(99)],
        vec![PageId::new(1), PageId::new(1)],
    ] {
        let (sink, _) = channel();
        let error = state
            .start_extract(&jobs, id, &bad, &scratch.file("x.pdf"), sink)
            .unwrap_err();
        assert_eq!(error.code(), ErrorCode::InvalidArgument);
    }
    assert!(!scratch.file("x.pdf").exists());
}

#[test]
fn split_by_n_and_by_ranges_never_overwrite() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("split");
    let id = open(state, &scratch, "five.pdf", &numbered_pages(5, 2));
    let jobs = Arc::new(JobRegistry::new());
    let folder = scratch.file("parts");
    std::fs::create_dir_all(&folder).unwrap();
    let run = |plan: SplitPlan| {
        let (sink, receiver) = channel();
        state.start_split(&jobs, id, &plan, &folder, sink).unwrap();
        done(finish(&receiver))
    };
    let (outputs, ..) = run(SplitPlan::EveryN {
        n: 2,
        pattern: None,
    });
    assert_eq!(outputs, 3);
    let sizes: Vec<usize> = (1..=3)
        .map(|n| pages_of(&folder.join(format!("five-0{n}.pdf"))))
        .collect();
    assert_eq!(sizes, vec![2, 2, 1]);

    // Again: the same names are taken, so the new files get " (2)" and the first ones stay as they were.
    let first = std::fs::read(folder.join("five-01.pdf")).unwrap();
    run(SplitPlan::Ranges {
        text: "1-2, 5".into(),
        pattern: Some("part-{n}-{pages}".into()),
    });
    assert_eq!(pages_of(&folder.join("part-01-1-2.pdf")), 2);
    assert_eq!(pages_of(&folder.join("part-02-5.pdf")), 1);
    run(SplitPlan::EveryN {
        n: 5,
        pattern: Some("five-01".into()),
    });
    assert_eq!(pages_of(&folder.join("five-01 (2).pdf")), 5);
    assert_eq!(std::fs::read(folder.join("five-01.pdf")).unwrap(), first);

    // Bad plans fail before a file is made.
    for plan in [
        SplitPlan::EveryN {
            n: 0,
            pattern: None,
        },
        SplitPlan::Ranges {
            text: "1-9".into(),
            pattern: None,
        },
    ] {
        let (sink, _) = channel();
        assert_eq!(
            state
                .start_split(&jobs, id, &plan, &folder, sink)
                .unwrap_err()
                .code(),
            ErrorCode::InvalidArgument
        );
    }
}

#[test]
fn a_cancelled_split_leaves_no_files() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("cancel");
    let id = open(state, &scratch, "big.pdf", &numbered_pages(900, 7));
    let jobs = Arc::new(JobRegistry::new());
    let folder = scratch.file("parts");
    std::fs::create_dir_all(&folder).unwrap();
    let (sink, receiver) = channel();
    let job: JobId = state
        .start_split(
            &jobs,
            id,
            &SplitPlan::EveryN {
                n: 1,
                pattern: None,
            },
            &folder,
            sink,
        )
        .unwrap();
    jobs.cancel(job);
    match finish(&receiver) {
        JobEvent::Cancelled => assert_eq!(std::fs::read_dir(&folder).unwrap().count(), 0),
        // It was quicker than the cancel: then it is complete.
        JobEvent::Done { outputs, .. } => {
            assert_eq!(
                std::fs::read_dir(&folder).unwrap().count(),
                outputs as usize
            );
        }
        other => panic!("{other:?}"),
    }
}

#[test]
fn merge_joins_documents_and_opens_the_result() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("merge");
    let a = open(state, &scratch, "a.pdf", &numbered_pages(2, 1));
    let b = open(state, &scratch, "b.pdf", &numbered_pages(3, 1));
    let jobs = Arc::new(JobRegistry::new());
    let (sink, receiver) = channel();
    let target = scratch.file("ab.pdf");
    let inputs = [
        MergeInput::Document { doc_id: b },
        MergeInput::Document { doc_id: a },
    ];
    state.start_merge(&jobs, &inputs, &target, sink).unwrap();
    let (outputs, _, _, opened) = done(finish(&receiver));
    assert_eq!(outputs, 1);
    assert_eq!(opened.unwrap().page_count, 5);
    assert_eq!(pages_of(&target), 5);
    // One input is not a merge.
    let (sink, _) = channel();
    assert!(state
        .start_merge(&jobs, &inputs[..1], &scratch.file("one.pdf"), sink)
        .is_err());
}

fn image_document() -> Vec<u8> {
    let (width, height) = (1200u32, 1200u32);
    let mut state = 7u32;
    let pixels: Vec<u8> = (0..width * height * 3)
        .map(|_| {
            state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            (state >> 24) as u8
        })
        .collect();
    let mut jpeg = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 95)
        .encode(&pixels, width, height, image::ExtendedColorType::Rgb8)
        .unwrap();
    let mut builder = PdfBuilder::new();
    builder.object(1, "<< /Type /Catalog /Pages 2 0 R >>");
    builder.object(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
    builder.object(
        3,
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /XObject << /Im0 5 0 R >> >> >>",
    );
    builder.stream(4, "", b"q 612 0 0 792 0 0 cm /Im0 Do Q");
    builder.stream(
        5,
        "/Type /XObject /Subtype /Image /Width 1200 /Height 1200 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode",
        &jpeg,
    );
    builder.finish(1)
}

#[test]
fn compress_writes_a_smaller_file_and_says_so_when_it_cannot() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("compress");
    let id = open(state, &scratch, "scan.pdf", &image_document());
    let jobs = Arc::new(JobRegistry::new());

    let estimate = state.estimate_compression(id).unwrap();
    assert!(estimate.presets.screen < estimate.current);
    assert!(estimate.presets.screen <= estimate.presets.ebook);

    let (sink, receiver) = channel();
    let target = scratch.file("small.pdf");
    state
        .start_compress(&jobs, id, Preset::Screen, &target, sink)
        .unwrap();
    let (outputs, before, after, opened) = done(finish(&receiver));
    assert_eq!(outputs, 1);
    assert!(after < before);
    let small = opened.expect("opened");

    // The result cannot get smaller by the same preset: nothing is written, nothing opens.
    let (sink, receiver) = channel();
    let again = scratch.file("smaller.pdf");
    state
        .start_compress(&jobs, small.id, Preset::Screen, &again, sink)
        .unwrap();
    let (outputs, _, _, opened) = done(finish(&receiver));
    assert_eq!(outputs, 0);
    assert!(opened.is_none());
    assert!(!again.exists());
}

#[test]
fn the_hostile_corpus_never_panics_a_producer() {
    for (name, bytes) in malformed::all() {
        let outcome = std::panic::catch_unwind(|| {
            let produced = produce::load(&bytes)
                .and_then(|parsed| produce::build_one(&parsed, &[PageSel::plain(0)], &Unattended));
            let squeezed = compress::compress(&bytes, Preset::Screen, &Unattended);
            let sampled = compress::estimate(&bytes, &Preset::ALL, &Unattended);
            (
                produced.map(|_| ()),
                squeezed.map(|_| ()),
                sampled.map(|_| ()),
            )
        });
        let (produced, squeezed, sampled) =
            outcome.unwrap_or_else(|_| panic!("{name} panicked a producer"));
        for result in [produced, squeezed, sampled] {
            if let Err(error) = result {
                assert_ne!(error.code(), ErrorCode::Internal, "{name}");
            }
        }
    }
    // An encrypted file is refused, not rewritten.
    let error: AppError = produce::load(&support::fixtures::encrypted()).unwrap_err();
    assert_eq!(error.code(), ErrorCode::UnsupportedFeature);
}
