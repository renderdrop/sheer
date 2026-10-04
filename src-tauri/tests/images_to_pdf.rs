//! Images to PDF (ADR-049 §3, M6 package B) against the real PDFium, through the same `AppState` the command uses, minus the two
//! dialogs: page geometry and density, hostile and oversize images left out, a dropped batch, and an output that opens with the right
//! page count and sizes. Skips, like the other engine tests, when the library is not fetched.

// Test code: panicking on a broken fixture is the point.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::io::Cursor;
use std::path::PathBuf;
use std::sync::mpsc;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use sheer_lib::commands::jobs::{EventSink, JobEvent, JobRegistry};
use sheer_lib::commands::AppState;
use sheer_lib::documents::image_batch::{self, ImageBatch};
use sheer_lib::engine::{self, Engine};
use sheer_lib::error::ErrorCode;
use sheer_lib::export::from_images::{
    start_job, ImageSource, ImagesToPdfOptions, Inputs, Orientation, PaperSize,
};
use sheer_lib::pdfwrite::produce::{Phase, Warning};

struct Scratch(PathBuf);

impl Scratch {
    fn new(name: &str) -> Self {
        let path = std::env::temp_dir().join(format!("sheer-imgpdf-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }
    fn file(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }
    fn write(&self, name: &str, bytes: &[u8]) -> PathBuf {
        let path = self.file(name);
        std::fs::write(&path, bytes).unwrap();
        path
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
                    "skipping the images to PDF tests: {} not found",
                    library.display()
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

/// A PNG of `w` x `h` with a pHYs chunk of `dpi` when given.
fn png(w: u32, h: u32, dpi: Option<f32>) -> Vec<u8> {
    let mut out = Vec::new();
    let mut encoder = png::Encoder::new(&mut out, w, h);
    encoder.set_color(png::ColorType::Rgb);
    encoder.set_depth(png::BitDepth::Eight);
    if let Some(dpi) = dpi {
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let per_meter = (dpi / 0.0254).round() as u32;
        encoder.set_pixel_dims(Some(png::PixelDimensions {
            xppu: per_meter,
            yppu: per_meter,
            unit: png::Unit::Meter,
        }));
    }
    let mut writer = encoder.write_header().unwrap();
    writer
        .write_image_data(&vec![180u8; (w * h * 3) as usize])
        .unwrap();
    writer.finish().unwrap();
    out
}

fn jpeg(w: u32, h: u32) -> Vec<u8> {
    let image = image::RgbImage::from_pixel(w, h, image::Rgb([20, 120, 200]));
    let mut out = Cursor::new(Vec::new());
    image.write_to(&mut out, image::ImageFormat::Jpeg).unwrap();
    out.into_inner()
}

fn options(paper: PaperSize, orientation: Orientation, margin_pt: f32) -> ImagesToPdfOptions {
    ImagesToPdfOptions {
        source: ImageSource::Dialog,
        paper,
        orientation,
        margin_pt,
    }
}

struct Outcome {
    pages: Vec<[f32; 2]>,
    skipped: u32,
    warnings: Vec<Warning>,
}

fn run(
    state: &AppState,
    scratch: &Scratch,
    inputs: Inputs,
    opts: &ImagesToPdfOptions,
    target: &str,
) -> Result<Outcome, serde_json::Value> {
    let jobs = Arc::new(JobRegistry::new());
    let (sink, receiver) = channel();
    let target = scratch.file(target);
    start_job(state, &jobs, inputs, opts, &target, "Sheer", sink).unwrap();
    match finish(&receiver) {
        JobEvent::Done {
            outputs,
            opened,
            skipped,
            warnings,
            ..
        } => {
            assert_eq!(outputs, 1);
            let opened = opened.expect("the file opens as a tab");
            let pages = state.page_sizes(opened.id).unwrap().to_vec();
            assert_eq!(pages.len(), opened.page_count as usize);
            assert!(target.is_file());
            Ok(Outcome {
                pages,
                skipped,
                warnings,
            })
        }
        JobEvent::Failed(error) => {
            assert!(!target.exists(), "a failed job writes nothing");
            Err(serde_json::to_value(&error).unwrap())
        }
        other => panic!("unexpected {other:?}"),
    }
}

fn near(a: [f32; 2], b: [f32; 2]) {
    assert!(
        (a[0] - b[0]).abs() < 0.6 && (a[1] - b[1]).abs() < 0.6,
        "{a:?} != {b:?}"
    );
}

#[test]
fn fit_pages_follow_the_density_of_each_image_and_bad_files_are_left_out() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("fit");
    // 600 x 1200 at 300 dpi: 144 x 288 pt. 640 x 320 JPEG has no density: 150 dpi, 307.2 x 153.6 pt.
    let tall = scratch.write("1-tall.png", &png(600, 1200, Some(300.0)));
    let wide = scratch.write("2-wide.jpg", &jpeg(640, 320));
    // A density out of range (10 dpi) is not trusted either: 150 dpi, 200 x 100 px is 96 x 48 pt, then the height is clamped to 72 pt.
    let odd = scratch.write("3-odd.png", &png(200, 100, Some(10.0)));
    let broken = scratch.write("4-broken.png", b"\x89PNG\r\n\x1a\nnot really");
    let text = scratch.write("5-text.png", b"hello");
    let mut huge = png(2, 2, None);
    // The header claims 30000 x 30000 px: turned down before any pixel is decoded.
    huge[16..20].copy_from_slice(&30_000u32.to_be_bytes());
    huge[20..24].copy_from_slice(&30_000u32.to_be_bytes());
    let huge = scratch.write("6-huge.png", &huge);
    let gone = scratch.file("7-gone.png");

    let outcome = run(
        state,
        &scratch,
        Inputs::Paths(vec![tall, wide, odd, broken, text, huge, gone]),
        &options(PaperSize::Fit, Orientation::Auto, 0.0),
        "fit.pdf",
    )
    .unwrap();
    assert_eq!(outcome.pages.len(), 3);
    near(outcome.pages[0], [144.0, 288.0]);
    near(outcome.pages[1], [307.2, 153.6]);
    near(outcome.pages[2], [96.0, 72.0]);
    assert_eq!(outcome.skipped, 4);
    assert_eq!(outcome.warnings, vec![Warning::ImagesSkipped]);
}

#[test]
fn a4_and_letter_with_margins_orient_by_the_image() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("paper");
    let tall = scratch.write("a.png", &png(300, 600, None));
    let wide = scratch.write("b.jpg", &jpeg(600, 300));
    let a4 = run(
        state,
        &scratch,
        Inputs::Paths(vec![tall.clone(), wide.clone()]),
        &options(PaperSize::A4, Orientation::Auto, 34.0),
        "a4.pdf",
    )
    .unwrap();
    near(a4.pages[0], [595.28, 841.89]);
    near(a4.pages[1], [841.89, 595.28]);
    assert_eq!(a4.skipped, 0);
    assert!(a4.warnings.is_empty());

    let letter = run(
        state,
        &scratch,
        Inputs::Paths(vec![tall.clone(), wide.clone()]),
        &options(PaperSize::Letter, Orientation::Landscape, 0.0),
        "letter.pdf",
    )
    .unwrap();
    near(letter.pages[0], [792.0, 612.0]);
    near(letter.pages[1], [792.0, 612.0]);

    let portrait = run(
        state,
        &scratch,
        Inputs::Paths(vec![wide]),
        &options(PaperSize::Letter, Orientation::Portrait, 72.0),
        "portrait.pdf",
    )
    .unwrap();
    near(portrait.pages[0], [612.0, 792.0]);
}

#[test]
fn the_output_has_only_the_producer_and_the_images_fit_inside() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("producer");
    let one = scratch.write("one.png", &png(300, 150, None));
    run(
        state,
        &scratch,
        Inputs::Paths(vec![one]),
        &options(PaperSize::A4, Orientation::Auto, 36.0),
        "one.pdf",
    )
    .unwrap();
    // The file is written uncompressed by lopdf: the information dictionary and the page content can be read as text.
    let file = std::fs::read(scratch.file("one.pdf")).unwrap();
    let text = String::from_utf8_lossy(&file).into_owned();
    assert_eq!(text.matches("/Producer").count(), 1);
    assert!(text.contains("/Producer(Sheer)"), "{text}");
    for key in [
        "/Title",
        "/Author",
        "/Creator",
        "/CreationDate",
        "/ModDate",
        "/Subject",
    ] {
        assert!(!text.contains(key), "{key}");
    }
    // The page draws the image inside the margin: 841.89 - 72 wide, centred.
    let at = text.find("cm /Im0 Do").expect("the page draws the image");
    let start = text[..at].rfind("q ").unwrap();
    let numbers: Vec<f32> = text[start..at]
        .split_whitespace()
        .filter_map(|t| t.parse().ok())
        .collect();
    assert_eq!(numbers.len(), 6, "{text}");
    assert!((numbers[0] - (841.89 - 72.0)).abs() < 0.01);
    assert!((numbers[4] - 36.0).abs() < 0.01);
    assert!(numbers[5] >= 36.0);
}

#[test]
fn a_dropped_batch_is_read_in_natural_name_order() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("batch");
    let ten = scratch.write("p10.png", &png(100, 400, Some(72.0)));
    let two = scratch.write("p2.png", &png(100, 200, Some(72.0)));
    let pdf = scratch.write("doc.pdf", b"%PDF-1.4\n%%EOF\n");
    let note = scratch.write("notes.txt", b"text");
    let sorted = image_batch::sort_drop(vec![ten, pdf, note, two]);
    assert_eq!(
        (sorted.pdfs.len(), sorted.images.len(), sorted.skipped),
        (1, 2, 1)
    );
    let batch = image_batch::batches().add(ImageBatch {
        images: sorted.images,
    });
    let held = image_batch::batches().get(batch).unwrap();
    let mut opts = options(PaperSize::Fit, Orientation::Auto, 0.0);
    opts.source = ImageSource::Batch { batch };
    // The handles are read twice: a failed or repeated job leaves the batch usable.
    for name in ["batch1.pdf", "batch2.pdf"] {
        let outcome = run(
            state,
            &scratch,
            Inputs::Batch(Arc::clone(&held)),
            &opts,
            name,
        )
        .unwrap();
        near(outcome.pages[0], [100.0, 200.0]);
        near(outcome.pages[1], [100.0, 400.0]);
    }
    image_batch::batches().release(batch);
    assert!(image_batch::batches().get(batch).is_none());
}

#[test]
fn when_every_image_fails_nothing_is_written() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("allbad");
    let bad = scratch.write("bad.png", b"\x89PNG\r\n\x1a\nxx");
    let error = run(
        state,
        &scratch,
        Inputs::Paths(vec![bad, scratch.file("missing.jpg")]),
        &options(PaperSize::Fit, Orientation::Auto, 0.0),
        "none.pdf",
    )
    .err()
    .expect("fails");
    assert_eq!(error["code"], "invalid_argument");
    assert_eq!(error["params"]["what"], "image");
}

#[test]
fn bad_requests_are_refused_before_anything_runs() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("refused");
    let one = scratch.write("one.png", &png(10, 10, None));
    let jobs = Arc::new(JobRegistry::new());
    let try_start = |inputs: Inputs, margin: f32, target: &str| {
        let (sink, _) = channel();
        start_job(
            state,
            &jobs,
            inputs,
            &options(PaperSize::Fit, Orientation::Auto, margin),
            &scratch.file(target),
            "Sheer",
            sink,
        )
        .unwrap_err()
    };
    assert_eq!(
        try_start(Inputs::Paths(vec![one.clone()]), 73.0, "a.pdf").code(),
        ErrorCode::InvalidArgument
    );
    assert_eq!(
        try_start(Inputs::Paths(vec![one.clone()]), f32::NAN, "a.pdf").code(),
        ErrorCode::InvalidArgument
    );
    assert_eq!(
        try_start(Inputs::Paths(Vec::new()), 0.0, "a.pdf").code(),
        ErrorCode::InvalidArgument
    );
    assert_eq!(
        try_start(Inputs::Paths(vec![one.clone(); 501]), 0.0, "a.pdf").code(),
        ErrorCode::LimitExceeded
    );
    assert!(!scratch.file("a.pdf").exists());
}

#[test]
fn a_batch_is_listed_previewed_extended_and_read_in_the_chosen_order() {
    use sheer_lib::export::from_images::{add_to_batch, batch_preview, list_batch, validate_order};
    let scratch = Scratch::new("ordered");
    let a = scratch.write("a.png", &png(100, 200, Some(72.0)));
    let b = scratch.write("b.jpg", &jpeg(300, 150));
    let c = scratch.write("c.png", &png(100, 100, Some(72.0)));
    let first = add_to_batch(None, vec![a, b]).unwrap().unwrap();
    assert_eq!((first.count, first.added, first.skipped), (2, 2, 0));
    let second = add_to_batch(Some(first.batch), vec![c, scratch.file("gone.png")])
        .unwrap()
        .unwrap();
    assert_eq!((second.batch, second.count), (first.batch, 3));
    let list = list_batch(first.batch).unwrap();
    let names: Vec<&str> = list.iter().map(|i| i.name.as_str()).collect();
    assert_eq!(names, ["a.png", "b.jpg", "c.png"]);
    assert_eq!((list[1].width, list[1].height), (300, 150));
    let frame = batch_preview(first.batch, 0, 64).unwrap();
    assert!(frame.starts_with(b"SHR1"));
    assert!(Arc::ptr_eq(
        &frame,
        &batch_preview(first.batch, 0, 64).unwrap()
    ));
    assert_eq!(
        batch_preview(first.batch, 0, 8).unwrap_err().code(),
        ErrorCode::InvalidArgument
    );
    assert!(batch_preview(first.batch, 9, 64).is_err());
    assert!(add_to_batch(Some(999_999), vec![scratch.file("a.png")]).is_err());

    let held = image_batch::batches().get(first.batch).unwrap();
    let order = validate_order(&[2, 0], 3).unwrap();
    assert!(validate_order(&[0, 0], 3).is_err());
    assert!(validate_order(&[3], 3).is_err());
    assert!(validate_order(&[], 3).is_err());
    if let Some(state) = state() {
        let mut opts = options(PaperSize::Fit, Orientation::Auto, 0.0);
        opts.source = ImageSource::Batch { batch: first.batch };
        let outcome = run(
            state,
            &scratch,
            Inputs::Ordered(held, order),
            &opts,
            "o.pdf",
        )
        .unwrap();
        assert_eq!(outcome.pages.len(), 2);
        near(outcome.pages[0], [100.0, 100.0]);
        near(outcome.pages[1], [100.0, 200.0]);
    }
    image_batch::batches().release(first.batch);
}

/// Opens `path` as a document when the job reports the start of the write (before the file is built).
struct OpenAtWrite {
    state: &'static AppState,
    path: PathBuf,
    inner: Collect,
}

impl EventSink for OpenAtWrite {
    fn send(&self, event: JobEvent) {
        if matches!(
            event,
            JobEvent::Progress {
                phase: Phase::Write,
                done: 0,
                ..
            }
        ) {
            self.state.open_path(self.path.clone()).unwrap();
        }
        self.inner.send(event);
    }
}

#[test]
fn a_target_opened_while_the_job_runs_is_not_replaced() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("raced");
    let image = scratch.write("a.png", &png(20, 10, None));
    // Any valid PDF will do as the file that gets opened in between.
    let seed = run(
        state,
        &scratch,
        Inputs::Paths(vec![image.clone()]),
        &options(PaperSize::Fit, Orientation::Auto, 0.0),
        "seed.pdf",
    );
    assert!(seed.is_ok());
    let target = scratch.file("target.pdf");
    std::fs::copy(scratch.file("seed.pdf"), &target).unwrap();
    let before = std::fs::read(&target).unwrap();
    let jobs = Arc::new(JobRegistry::new());
    let (tx, receiver) = mpsc::channel();
    let sink = Arc::new(OpenAtWrite {
        state,
        path: target.clone(),
        inner: Collect(Mutex::new(tx)),
    });
    start_job(
        state,
        &jobs,
        Inputs::Paths(vec![image]),
        &options(PaperSize::A4, Orientation::Auto, 0.0),
        &target,
        "Sheer",
        sink,
    )
    .unwrap();
    match finish(&receiver) {
        JobEvent::Failed(error) => {
            assert_eq!(serde_json::to_value(&error).unwrap()["code"], "io_in_use");
        }
        other => panic!("unexpected {other:?}"),
    }
    assert_eq!(
        std::fs::read(&target).unwrap(),
        before,
        "the file is untouched"
    );
}
