//! PDF to images (ADR-049 §2) against the real PDFium, through the same `AppState` the commands use: names, formats, conflicts
//! (keep both, replace, cancel), dpi lowering, the limits, cancel and the copy permission. Skips, like the other engine tests, when
//! the library is not fetched.

// Test code: panicking on a broken fixture is the point.
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use sheer_lib::commands::jobs::{EventSink, JobEvent, JobRegistry};
use sheer_lib::commands::{AppState, Opened};
use sheer_lib::documents::{DocumentId, PageId};
use sheer_lib::engine::{self, Engine};
use sheer_lib::error::ErrorCode;
use sheer_lib::export::images::{
    resolve_on, start_in_folder, ConflictChoice, ExportStart, ImageExportOptions, ImageFormat,
};
use sheer_lib::model::protection::{Permission, PermissionSet};
use sheer_lib::model::ranges::PageSelection;
use sheer_lib::pdfwrite::crypt;
use sheer_lib::pdfwrite::produce::Warning;
use sheer_lib::security::secret::{PendingProtection, Secret};
use support::fixtures::{add_pages, numbered_pages, Page};
use support::PdfBuilder;
use zeroize::Zeroizing;

struct Scratch(PathBuf);

impl Scratch {
    fn new(name: &str) -> Self {
        let path = std::env::temp_dir().join(format!("sheer-img-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }
    fn file(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }
    fn out(&self) -> PathBuf {
        let out = self.0.join("out");
        std::fs::create_dir_all(&out).unwrap();
        out
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
                eprintln!(
                    "skipping the image export tests: {} not found",
                    library.display()
                );
                assert!(
                    std::env::var_os("CI").is_none(),
                    "PDFium is missing and CI is set: fetch it before the tests"
                );
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

fn finish(receiver: &mpsc::Receiver<JobEvent>) -> JobEvent {
    loop {
        match receiver.recv_timeout(Duration::from_secs(120)).unwrap() {
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

fn opts(pages: PageSelection, format: ImageFormat, dpi: f32) -> ImageExportOptions {
    ImageExportOptions {
        pages,
        dpi,
        format,
        jpeg_quality: 80,
        annotations: true,
    }
}

fn names_in(folder: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(folder)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

fn png_size(path: &Path) -> (u32, u32) {
    let bytes = std::fs::read(path).unwrap();
    assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n");
    let word = |at: usize| u32::from_be_bytes(bytes[at..at + 4].try_into().unwrap());
    (word(16), word(20))
}

/// Runs an export to its final event.
fn run(
    state: &AppState,
    doc: DocumentId,
    options: &ImageExportOptions,
    folder: &Path,
) -> (ExportStart, Option<JobEvent>) {
    let registry = Arc::new(JobRegistry::new());
    let (sink, receiver) = channel();
    let answer = start_in_folder(state, &registry, doc, options, folder, sink).unwrap();
    let event = matches!(answer, ExportStart::Started { .. }).then(|| finish(&receiver));
    (answer, event)
}

#[test]
fn png_pages_are_named_by_the_file_and_sized_by_the_dpi() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("png");
    let id = open(state, &scratch, "Ten & Pages.pdf", &numbered_pages(10, 2));
    let out = scratch.out();
    let selection = PageSelection::Ranges {
        text: "2-3, 10".into(),
    };
    let (answer, event) = run(state, id, &opts(selection, ImageFormat::Png, 144.0), &out);
    assert!(matches!(answer, ExportStart::Started { .. }));
    let Some(JobEvent::Done {
        outputs, warnings, ..
    }) = event
    else {
        panic!("expected done, got {event:?}");
    };
    assert_eq!(outputs, 3);
    assert!(warnings.is_empty());
    assert_eq!(
        names_in(&out),
        [
            "Ten & Pages-p02.png",
            "Ten & Pages-p03.png",
            "Ten & Pages-p10.png"
        ]
    );
    // Letter at 144 dpi.
    assert_eq!(png_size(&out.join("Ten & Pages-p02.png")), (1224, 1584));
}

#[test]
fn jpeg_is_flattened_on_white_and_current_page_is_one_file() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("jpeg");
    let id = open(state, &scratch, "doc.pdf", &numbered_pages(3, 2));
    let out = scratch.out();
    let selection = PageSelection::Current {
        page_id: PageId::new(1),
    };
    let (_, event) = run(state, id, &opts(selection, ImageFormat::Jpeg, 72.0), &out);
    assert!(matches!(event, Some(JobEvent::Done { outputs: 1, .. })));
    assert_eq!(names_in(&out), ["doc-p2.jpg"]);
    let bytes = std::fs::read(out.join("doc-p2.jpg")).unwrap();
    assert_eq!(&bytes[..2], &[0xff, 0xd8]);
    let decoded = image::load_from_memory(&bytes).unwrap().to_rgb8();
    assert_eq!(decoded.dimensions(), (612, 792));
    // The corner of the page is white paper, not black or transparent.
    let corner = decoded.get_pixel(2, 2).0;
    assert!(corner.iter().all(|&c| c >= 250), "{corner:?}");
}

#[test]
fn existing_files_ask_and_each_choice_does_what_it_says() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("conflict");
    let id = open(state, &scratch, "doc.pdf", &numbered_pages(2, 2));
    let out = scratch.out();
    std::fs::write(out.join("doc-p1.png"), b"old").unwrap();
    let options = opts(PageSelection::All, ImageFormat::Png, 36.0);
    let registry = Arc::new(JobRegistry::new());

    // The answer names the clash and writes nothing.
    let (sink, _) = channel();
    let answer = start_in_folder(state, &registry, id, &options, &out, sink).unwrap();
    let ExportStart::Conflicts {
        ticket,
        count,
        names,
    } = answer
    else {
        panic!("expected conflicts, got {answer:?}");
    };
    assert_eq!(
        (count, names.as_slice()),
        (1, ["doc-p1.png".to_owned()].as_slice())
    );
    assert_eq!(names_in(&out), ["doc-p1.png"]);

    // Cancel: nothing, and the ticket is used up.
    let (sink, _) = channel();
    assert!(
        resolve_on(state, &registry, ticket, ConflictChoice::Cancel, sink)
            .unwrap()
            .is_none()
    );
    let (sink, _) = channel();
    assert!(
        resolve_on(state, &registry, ticket, ConflictChoice::KeepBoth, sink)
            .unwrap()
            .is_none()
    );
    assert_eq!(std::fs::read(out.join("doc-p1.png")).unwrap(), b"old");

    // Keep both: the old file stays, the new one is `doc-p1 (2).png`.
    let (sink, _) = channel();
    let ExportStart::Conflicts { ticket, .. } =
        start_in_folder(state, &registry, id, &options, &out, sink).unwrap()
    else {
        panic!("conflict expected");
    };
    let (sink, receiver) = channel();
    resolve_on(state, &registry, ticket, ConflictChoice::KeepBoth, sink)
        .unwrap()
        .expect("a job");
    assert!(matches!(
        finish(&receiver),
        JobEvent::Done { outputs: 2, .. }
    ));
    assert_eq!(
        names_in(&out),
        ["doc-p1 (2).png", "doc-p1.png", "doc-p2.png"]
    );
    assert_eq!(std::fs::read(out.join("doc-p1.png")).unwrap(), b"old");

    // Replace: the old content is gone.
    let (sink, _) = channel();
    let ExportStart::Conflicts { ticket, count, .. } =
        start_in_folder(state, &registry, id, &options, &out, sink).unwrap()
    else {
        panic!("conflict expected");
    };
    assert_eq!(count, 2);
    let (sink, receiver) = channel();
    resolve_on(state, &registry, ticket, ConflictChoice::Replace, sink)
        .unwrap()
        .expect("a job");
    assert!(matches!(
        finish(&receiver),
        JobEvent::Done { outputs: 2, .. }
    ));
    assert_eq!(
        names_in(&out),
        ["doc-p1 (2).png", "doc-p1.png", "doc-p2.png"]
    );
    assert_eq!(png_size(&out.join("doc-p1.png")), (306, 396));
}

#[test]
fn replace_never_writes_through_a_link() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("link");
    let id = open(state, &scratch, "doc.pdf", &numbered_pages(1, 1));
    let out = scratch.out();
    let secret_file = scratch.file("precious.txt");
    std::fs::write(&secret_file, b"keep me").unwrap();
    #[cfg(unix)]
    let linked = std::os::unix::fs::symlink(&secret_file, out.join("doc-p1.png")).is_ok();
    #[cfg(windows)]
    let linked = std::os::windows::fs::symlink_file(&secret_file, out.join("doc-p1.png")).is_ok();
    if !linked {
        eprintln!("skipping: cannot create a symlink here");
        return;
    }
    let options = opts(PageSelection::All, ImageFormat::Png, 36.0);
    let registry = Arc::new(JobRegistry::new());
    let (sink, _) = channel();
    let ExportStart::Conflicts { ticket, .. } =
        start_in_folder(state, &registry, id, &options, &out, sink).unwrap()
    else {
        panic!("a link in the way is a conflict");
    };
    let (sink, receiver) = channel();
    resolve_on(state, &registry, ticket, ConflictChoice::Replace, sink)
        .unwrap()
        .expect("a job");
    assert!(matches!(finish(&receiver), JobEvent::Failed(_)));
    assert_eq!(std::fs::read(&secret_file).unwrap(), b"keep me");
}

/// A document of one page that is `side` points square.
fn square_page(side: u32) -> Vec<u8> {
    let mut builder = PdfBuilder::new();
    let page =
        Page::new("0 0 1 rg 0 0 100 100 re f").with(&format!("/MediaBox [0 0 {side} {side}]"));
    add_pages(&mut builder, &[page]);
    builder.object(1, "<< /Type /Catalog /Pages 2 0 R >>");
    builder.finish(1)
}

#[test]
fn a_page_over_the_limits_is_lowered_with_a_warning_or_refused() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("limits");
    let out = scratch.out();
    // 5 000 pt square at 300 dpi would be 20 833 px a side.
    let id = open(state, &scratch, "big.pdf", &square_page(5_000));
    let (_, event) = run(
        state,
        id,
        &opts(PageSelection::All, ImageFormat::Jpeg, 300.0),
        &out,
    );
    let Some(JobEvent::Done { warnings, .. }) = event else {
        panic!("expected done, got {event:?}");
    };
    assert_eq!(warnings, [Warning::DpiLowered]);
    let decoded = image::open(out.join("big-p1.jpg")).unwrap();
    assert!(
        decoded.width() <= 10_000
            && u64::from(decoded.width()) * u64::from(decoded.height()) <= 64_000_000
    );
    assert!(
        decoded.width() >= 7_900,
        "the highest dpi that fits, not less"
    );
}

#[test]
fn bad_options_are_refused_before_anything_runs() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("bad");
    let id = open(state, &scratch, "doc.pdf", &numbered_pages(2, 2));
    let out = scratch.out();
    let registry = Arc::new(JobRegistry::new());
    for options in [
        opts(PageSelection::All, ImageFormat::Png, 10.0),
        opts(PageSelection::All, ImageFormat::Png, 900.0),
        opts(
            PageSelection::Ranges { text: "3".into() },
            ImageFormat::Png,
            72.0,
        ),
        opts(
            PageSelection::Ranges { text: "".into() },
            ImageFormat::Png,
            72.0,
        ),
    ] {
        let (sink, _) = channel();
        let error = start_in_folder(state, &registry, id, &options, &out, sink).unwrap_err();
        assert_eq!(error.code(), ErrorCode::InvalidArgument, "{options:?}");
    }
    assert!(names_in(&out).is_empty());
}

#[test]
fn cancel_keeps_the_files_already_written() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("cancel");
    let id = open(state, &scratch, "many.pdf", &numbered_pages(40, 2));
    let out = scratch.out();
    let registry = Arc::new(JobRegistry::new());
    let (sink, receiver) = channel();
    let options = opts(PageSelection::All, ImageFormat::Png, 600.0);
    let ExportStart::Started { job_id } =
        start_in_folder(state, &registry, id, &options, &out, sink).unwrap()
    else {
        panic!("started expected");
    };
    // Wait for the first page to be written, then stop.
    loop {
        match receiver.recv_timeout(Duration::from_secs(120)).unwrap() {
            JobEvent::Progress { done, .. } if done >= 2 => break,
            JobEvent::Progress { .. } => {}
            other => panic!("the job ended too soon: {other:?}"),
        }
    }
    registry.cancel(job_id);
    assert!(matches!(finish(&receiver), JobEvent::Cancelled));
    let written = names_in(&out);
    assert!(
        !written.is_empty() && written.len() < 40,
        "{}",
        written.len()
    );
    // Every file that is there is whole.
    for name in &written {
        png_size(&out.join(name));
    }
}

#[test]
fn a_document_that_forbids_copying_is_not_exported() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("permission");
    let mut builder = PdfBuilder::new();
    add_pages(&mut builder, &[Page::new("")]);
    builder.object(1, "<< /Type /Catalog /Pages 2 0 R >>");
    let plain = builder.finish(1);
    let protect = |allow: &[Permission]| {
        let pending = PendingProtection::Protect {
            open: Some(Secret::new("user-pw").unwrap()),
            owner: Secret::new("owner-pw").unwrap(),
            allow: PermissionSet::from_list(allow),
        };
        crypt::encrypt_bytes(&plain, &pending).unwrap()
    };
    let open_with_user_password = |name: &str, bytes: Vec<u8>| {
        let path = scratch.file(name);
        std::fs::write(&path, bytes).unwrap();
        let Opened::Locked { id, .. } = state.open_outcome(path).unwrap() else {
            panic!("an open password was set");
        };
        state
            .unlock(id, Zeroizing::new("user-pw".to_owned()))
            .unwrap()
            .id
    };
    let out = scratch.out();
    let registry = Arc::new(JobRegistry::new());
    let options = opts(PageSelection::All, ImageFormat::Png, 36.0);

    let locked = open_with_user_password("a.pdf", protect(&[Permission::Print]));
    let (sink, _) = channel();
    let error = start_in_folder(state, &registry, locked, &options, &out, sink).unwrap_err();
    assert_eq!(error.code(), ErrorCode::ReadOnly);
    assert!(names_in(&out).is_empty());

    let allowed = open_with_user_password("b.pdf", protect(&[Permission::Copy]));
    let (_, event) = run(state, allowed, &options, &out);
    assert!(
        matches!(event, Some(JobEvent::Done { outputs: 1, .. })),
        "{event:?}"
    );
}
