//! Crop pages (ADR-047 §2) against the real PDFium, through the same `AppState` the commands use: margins on a rotated page, undo and
//! redo, the engine's copy following (annotations read after the crop are in the new page space), the saved CropBox read back by PDFium
//! (Trim, Bleed and Art boxes clipped, a reset writing the MediaBox), refused margins, and a job keeping the crop. Skips when the PDFium
//! library is not fetched.

// Test code: panicking on a broken fixture is the point.
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use std::path::PathBuf;
use std::sync::mpsc;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde_json::json;
use sheer_lib::commands::jobs::{EventSink, JobEvent, JobRegistry};
use sheer_lib::commands::save::SaveAck;
use sheer_lib::commands::AppState;
use sheer_lib::documents::{DocumentId, PageId};
use sheer_lib::engine::{self, Engine};
use sheer_lib::error::ErrorCode;
use sheer_lib::model::command::DocCommand;
use support::fixtures::{add_pages, page_id, Page};
use support::PdfBuilder;

struct Scratch(PathBuf);

impl Scratch {
    fn new(name: &str) -> Self {
        let path = std::env::temp_dir().join(format!("sheer-crop-{}-{name}", std::process::id()));
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

/// Three pages of 612 x 792: page 0 has a square (`/Rect [200 500 300 560]`), page 1 is turned 90 degrees and has a Trim, a Bleed and
/// an Art box, page 2 has a CropBox of the file.
fn fixture() -> Vec<u8> {
    let mut builder = PdfBuilder::new();
    add_pages(
        &mut builder,
        &[
            Page::new("").with("/Annots [100 0 R]"),
            Page::new("").with(
                "/Rotate 90 /TrimBox [10 10 600 780] /ArtBox [300 400 400 500] /BleedBox [0 0 612 792]",
            ),
            Page::new("").with("/CropBox [10 20 500 700]"),
        ],
    );
    builder.object(
        100,
        &format!(
            "<< /Type /Annot /Subtype /Square /Rect [200 500 300 560] /C [0 0 1] /NM (sq) /P {} 0 R >>",
            page_id(0)
        ),
    );
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

fn margins(page: u32, top: f32, right: f32, bottom: f32, left: f32) -> DocCommand {
    cmd(json!({"type": "cropPages", "pages": [page], "spec": {
        "type": "margins", "top": top, "right": right, "bottom": bottom, "left": left
    }}))
}

fn reset(page: u32) -> DocCommand {
    cmd(json!({"type": "cropPages", "pages": [page], "spec": {"type": "reset"}}))
}

fn square_rect(state: &AppState, id: DocumentId) -> (f32, f32) {
    let list = state.list_annotations(id, PageId::new(0)).unwrap();
    assert_eq!(list.len(), 1);
    (list[0].rect.x, list[0].rect.y)
}

/// The numbers of a box of page `index` of a file.
fn page_box(bytes: &[u8], index: usize, key: &[u8]) -> Option<Vec<f32>> {
    let parsed = sheer_lib::pdfwrite::produce::load(bytes).unwrap();
    let id = parsed.pages[index];
    let array = parsed
        .doc
        .get_dictionary(id)
        .unwrap()
        .get(key)
        .ok()?
        .as_array()
        .ok()?;
    Some(array.iter().map(|n| n.as_float().unwrap()).collect())
}

#[test]
fn margins_on_a_rotated_page_undo_and_redo() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("rotated");
    let id = open(state, &scratch, "a.pdf", &fixture());
    let before = state.pages(id).unwrap();
    assert_eq!(before[1].rotation, 90);
    assert!(before[1].crop.is_none());
    let media = before[1].media;

    // Margins are in page space before /Rotate: the page is 612 wide before it is turned, whatever it shows.
    let changes = state
        .apply_command(id, margins(1, 50.0, 20.0, 10.0, 30.0))
        .unwrap();
    assert_eq!(changes.history.undo_label.as_deref(), Some("page.crop"));
    let page = changes.pages.unwrap()[1].clone();
    assert_eq!((page.width, page.height), (612.0 - 50.0, 792.0 - 60.0));
    let crop = page.crop.unwrap();
    assert_eq!(
        (crop.top, crop.right, crop.bottom, crop.left),
        (50.0, 20.0, 10.0, 30.0)
    );
    assert_eq!(page.rotation, 90);
    assert_eq!(page.rev, before[1].rev + 1);
    assert_eq!(page.media, media);

    let undone = state.undo(id).unwrap().pages.unwrap();
    assert!(undone[1].crop.is_none());
    assert_eq!((undone[1].width, undone[1].height), (612.0, 792.0));
    assert_eq!(undone[1].rev, before[1].rev + 2);
    let redone = state.redo(id).unwrap().pages.unwrap();
    assert_eq!(redone[1].crop, page.crop);
}

#[test]
fn annotations_move_with_the_origin_and_the_engine_follows() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("origin");
    let id = open(state, &scratch, "a.pdf", &fixture());
    // The square is read from the file: x 200, top 792 - 560.
    let (x0, y0) = square_rect(state, id);
    assert_eq!(
        (x0, y0),
        (199.5, 231.5),
        "the border widens the rect by half its width"
    );
    state
        .apply_command(id, margins(0, 30.0, 0.0, 0.0, 50.0))
        .unwrap();
    assert_eq!(square_rect(state, id), (x0 - 50.0, y0 - 30.0));
    state.undo(id).unwrap();
    let (x0, y0) = square_rect(state, id);
    assert_eq!(
        (x0, y0),
        (199.5, 231.5),
        "the border widens the rect by half its width"
    );
    state.redo(id).unwrap();
    assert_eq!(square_rect(state, id), (x0 - 50.0, y0 - 30.0));
    assert_eq!(
        state.list_annotations(id, PageId::new(0)).unwrap()[0].sync,
        sheer_lib::model::annotation::Sync::Clean,
        "a shift of the origin is not an edit"
    );

    // A page that was not read before the crop is read in the cropped space: the engine's copy has the CropBox.
    let other = open(state, &scratch, "b.pdf", &fixture());
    state
        .apply_command(other, margins(0, 30.0, 0.0, 0.0, 50.0))
        .unwrap();
    assert_eq!(square_rect(state, other), (x0 - 50.0, y0 - 30.0));
}

#[test]
fn a_crop_is_saved_as_a_cropbox_and_read_back() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("save");
    let id = open(state, &scratch, "a.pdf", &fixture());
    let pages = state.pages(id).unwrap();
    // The CropBox of the file is read at load: 10 20 500 700 of 612 x 792.
    let file_crop = pages[2].crop.unwrap();
    assert_eq!(
        (
            file_crop.left,
            file_crop.bottom,
            file_crop.right,
            file_crop.top
        ),
        (10.0, 20.0, 112.0, 92.0)
    );

    state
        .apply_command(id, margins(0, 50.0, 20.0, 10.0, 30.0))
        .unwrap();
    state
        .apply_command(id, margins(1, 100.0, 100.0, 100.0, 100.0))
        .unwrap();
    state.apply_command(id, reset(2)).unwrap();
    state.save_in_place(id, SaveAck::default()).unwrap();

    let bytes = std::fs::read(scratch.file("a.pdf")).unwrap();
    assert_eq!(
        page_box(&bytes, 0, b"CropBox"),
        Some(vec![30.0, 10.0, 592.0, 742.0])
    );
    assert_eq!(
        page_box(&bytes, 1, b"CropBox"),
        Some(vec![100.0, 100.0, 512.0, 692.0])
    );
    assert_eq!(
        page_box(&bytes, 2, b"CropBox"),
        Some(vec![0.0, 0.0, 612.0, 792.0]),
        "a reset writes the MediaBox"
    );
    // Trim and Bleed are clipped to the crop; an Art box inside it stays.
    assert_eq!(
        page_box(&bytes, 1, b"TrimBox"),
        Some(vec![100.0, 100.0, 512.0, 692.0])
    );
    assert_eq!(
        page_box(&bytes, 1, b"BleedBox"),
        Some(vec![100.0, 100.0, 512.0, 692.0])
    );
    assert_eq!(
        page_box(&bytes, 1, b"ArtBox"),
        Some(vec![300.0, 400.0, 400.0, 500.0])
    );
    assert_eq!(
        page_box(&bytes, 1, b"MediaBox"),
        Some(vec![0.0, 0.0, 612.0, 792.0]),
        "the crop hides, never removes"
    );

    // PDFium reads the file back with the crops.
    std::fs::copy(scratch.file("a.pdf"), scratch.file("b.pdf")).unwrap();
    let again = state
        .open_path(scratch.file("b.pdf"))
        .unwrap()
        .expect("loaded")
        .id;
    let reread = state.pages(again).unwrap();
    let crop = reread[0].crop.unwrap();
    assert_eq!(
        (crop.top, crop.right, crop.bottom, crop.left),
        (50.0, 20.0, 10.0, 30.0)
    );
    assert_eq!((reread[0].width, reread[0].height), (562.0, 732.0));
    assert!(reread[2].crop.is_none());
    assert_eq!(reread[1].rotation, 90);
    // The square is where it was on the page, in the new space.
    assert_eq!(square_rect(state, again), (169.5, 181.5));
}

#[test]
fn refused_margins_change_nothing() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("refused");
    let id = open(state, &scratch, "a.pdf", &fixture());
    let rev = state.pages(id).unwrap()[0].rev;
    for bad in [
        margins(0, 400.0, 0.0, 400.0, 0.0),
        margins(0, 0.0, 300.0, 0.0, 400.0),
        margins(0, -5.0, 0.0, 0.0, 0.0),
    ] {
        assert_eq!(
            state.apply_command(id, bad).unwrap_err().code(),
            ErrorCode::InvalidArgument
        );
    }
    let unknown = state.apply_command(id, reset(9)).unwrap_err();
    assert_eq!(unknown.code(), ErrorCode::InvalidArgument);
    assert_eq!(state.pages(id).unwrap()[0].rev, rev);
    assert!(!state.undo(id).unwrap().history.can_redo);
}

struct Collect(Mutex<mpsc::Sender<JobEvent>>);

impl EventSink for Collect {
    fn send(&self, event: JobEvent) {
        let _ = self.0.lock().unwrap().send(event);
    }
}

#[test]
fn extract_keeps_the_crop_of_the_session() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("extract");
    let id = open(state, &scratch, "a.pdf", &fixture());
    state
        .apply_command(id, margins(0, 50.0, 20.0, 10.0, 30.0))
        .unwrap();
    state.apply_command(id, reset(2)).unwrap();
    let jobs = Arc::new(JobRegistry::new());
    let (sender, receiver) = mpsc::channel();
    let sink: Arc<dyn EventSink> = Arc::new(Collect(Mutex::new(sender)));
    let target = scratch.file("out.pdf");
    state
        .start_extract(&jobs, id, &[PageId::new(0), PageId::new(2)], &target, sink)
        .unwrap();
    loop {
        match receiver.recv_timeout(Duration::from_secs(60)).unwrap() {
            JobEvent::Progress { .. } => {}
            JobEvent::Done { .. } => break,
            other => panic!("expected done, got {other:?}"),
        }
    }
    let bytes = std::fs::read(&target).unwrap();
    assert_eq!(
        page_box(&bytes, 0, b"CropBox"),
        Some(vec![30.0, 10.0, 592.0, 742.0])
    );
    assert_eq!(
        page_box(&bytes, 1, b"CropBox"),
        Some(vec![0.0, 0.0, 612.0, 792.0])
    );
}

fn run_job(receiver: &mpsc::Receiver<JobEvent>) {
    loop {
        match receiver.recv_timeout(Duration::from_secs(60)).unwrap() {
            JobEvent::Progress { .. } => {}
            JobEvent::Done { .. } => break,
            other => panic!("expected done, got {other:?}"),
        }
    }
}

fn sink() -> (Arc<dyn EventSink>, mpsc::Receiver<JobEvent>) {
    let (sender, receiver) = mpsc::channel();
    (Arc::new(Collect(Mutex::new(sender))), receiver)
}

#[test]
fn split_merge_and_flatten_keep_the_crop_of_the_session() {
    use sheer_lib::commands::jobs::{MergeInput, SplitPlan};
    use sheer_lib::pdfwrite::flatten::{FlattenOptions, FlattenScope};
    let Some(state) = state() else { return };
    let scratch = Scratch::new("jobs");
    let id = open(state, &scratch, "a.pdf", &fixture());
    let plain = open(state, &scratch, "p.pdf", &fixture());
    state
        .apply_command(id, margins(0, 50.0, 20.0, 10.0, 30.0))
        .unwrap();
    state.apply_command(id, reset(2)).unwrap();
    let jobs = Arc::new(JobRegistry::new());
    let cropped = vec![30.0, 10.0, 592.0, 742.0];
    let media = vec![0.0, 0.0, 612.0, 792.0];

    let folder = scratch.file("parts");
    std::fs::create_dir_all(&folder).unwrap();
    let (s, r) = sink();
    let plan = SplitPlan::EveryN {
        n: 1,
        pattern: None,
    };
    state.start_split(&jobs, id, &plan, &folder, s).unwrap();
    run_job(&r);
    let part = |n: u32| std::fs::read(folder.join(format!("a-0{n}.pdf"))).unwrap();
    assert_eq!(page_box(&part(1), 0, b"CropBox"), Some(cropped.clone()));
    assert_eq!(page_box(&part(3), 0, b"CropBox"), Some(media.clone()));

    let (s, r) = sink();
    let target = scratch.file("merged.pdf");
    let inputs = [
        MergeInput::Document { doc_id: plain },
        MergeInput::Document { doc_id: id },
    ];
    state.start_merge(&jobs, &inputs, &target, s).unwrap();
    run_job(&r);
    let merged = std::fs::read(&target).unwrap();
    assert_eq!(page_box(&merged, 0, b"CropBox"), None);
    assert_eq!(page_box(&merged, 3, b"CropBox"), Some(cropped.clone()));
    assert_eq!(page_box(&merged, 5, b"CropBox"), Some(media.clone()));

    let (s, r) = sink();
    let target = scratch.file("flat.pdf");
    let options = FlattenOptions {
        scope: FlattenScope::Forms,
    };
    state.start_flatten(&jobs, id, options, &target, s).unwrap();
    run_job(&r);
    let flat = std::fs::read(&target).unwrap();
    assert_eq!(page_box(&flat, 0, b"CropBox"), Some(cropped));
    assert_eq!(page_box(&flat, 2, b"CropBox"), Some(media));
}

fn widget_rect(state: &AppState, id: DocumentId) -> (f32, f32) {
    let info = state.get_form_fields(id).unwrap();
    let rect = info.fields[0].widgets[0].rect;
    (rect.x, rect.y)
}

#[test]
fn form_widgets_shift_with_the_crop_and_back_on_undo() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("widgets");
    let bytes = support::fixtures::form();
    let id = open(state, &scratch, "f.pdf", &bytes);
    let (x0, y0) = widget_rect(state, id);
    state
        .apply_command(id, margins(0, 30.0, 0.0, 0.0, 50.0))
        .unwrap();
    assert_eq!(widget_rect(state, id), (x0 - 50.0, y0 - 30.0));
    state.undo(id).unwrap();
    assert_eq!(widget_rect(state, id), (x0, y0));
    state.redo(id).unwrap();
    assert_eq!(widget_rect(state, id), (x0 - 50.0, y0 - 30.0));

    // A form read for the first time after the crop is moved into the cropped space as well.
    let late = open(state, &scratch, "g.pdf", &bytes);
    state
        .apply_command(late, margins(0, 30.0, 0.0, 0.0, 50.0))
        .unwrap();
    assert_eq!(widget_rect(state, late), (x0 - 50.0, y0 - 30.0));
}

/// The bytes of the content streams of page `index` of a file, and its Resources entry, as the file has them.
fn page_content(bytes: &[u8], index: usize) -> (Vec<u8>, String) {
    let parsed = sheer_lib::pdfwrite::produce::load(bytes).unwrap();
    let dict = parsed.doc.get_dictionary(parsed.pages[index]).unwrap();
    let contents = dict.get(b"Contents").unwrap();
    // One stream, or an array of them.
    let ids: Vec<_> = match contents.as_array() {
        Ok(items) => items.iter().filter_map(|o| o.as_reference().ok()).collect(),
        Err(_) => contents.as_reference().into_iter().collect(),
    };
    let mut out = Vec::new();
    for id in ids {
        let stream = parsed.doc.get_object(id).unwrap().as_stream().unwrap();
        out.extend_from_slice(
            &stream
                .decompressed_content()
                .unwrap_or_else(|_| stream.content.clone()),
        );
    }
    let resources = format!("{:?}", dict.get(b"Resources").unwrap());
    (out, resources)
}

/// Regression F19.7: a crop only writes the CropBox. The content stream, the resources and the MediaBox of the page are the ones of the
/// source, the page is not rasterised, and the text of the visible area reads the same after the save and a reopen.
#[test]
fn a_crop_changes_only_the_cropbox_and_the_text_stays() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("textstays");
    let source = support::fixtures::text();
    let id = open(state, &scratch, "t.pdf", &source);
    let before = state.text_layer(id, PageId::new(0)).unwrap();
    assert!(before.text.contains("quick brown fox"));

    // Margins that keep the text lines.
    state
        .apply_command(id, margins(0, 60.0, 40.0, 200.0, 40.0))
        .unwrap();
    state.save_in_place(id, SaveAck::default()).unwrap();
    let bytes = std::fs::read(scratch.file("t.pdf")).unwrap();

    assert_eq!(
        page_content(&bytes, 0),
        page_content(&source, 0),
        "content and resources are untouched"
    );
    assert_eq!(page_content(&bytes, 1), page_content(&source, 1));
    assert_eq!(
        page_box(&bytes, 0, b"MediaBox"),
        Some(vec![0.0, 0.0, 612.0, 792.0])
    );
    assert_eq!(
        page_box(&bytes, 0, b"CropBox"),
        Some(vec![40.0, 200.0, 572.0, 732.0])
    );
    assert_eq!(
        page_box(&bytes, 1, b"CropBox"),
        None,
        "other pages get no box"
    );

    std::fs::copy(scratch.file("t.pdf"), scratch.file("u.pdf")).unwrap();
    let again = state
        .open_path(scratch.file("u.pdf"))
        .unwrap()
        .expect("loaded")
        .id;
    let after = state.text_layer(again, PageId::new(0)).unwrap();
    assert_eq!(
        after.text, before.text,
        "the text of the visible area is extracted unchanged"
    );
    assert_eq!(after.boxes.len(), before.boxes.len());
}
