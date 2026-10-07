//! Stamps (ADR-139, ARCHITECTURE §16.1) against the real PDFium through the same `AppState` the commands use: a stamp is written as a
//! `/Stamp` with our own appearance and keys, other renderers draw it, a reopened file gives it back as an editable stamp, undo and redo
//! work, and hostile text is refused or stripped. Skips, like the other engine tests, when the library is not fetched.

// Test code: panicking on a broken fixture is the point (clippy.toml only exempts `#[test]` functions, not helpers).
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde_json::json;
use sheer_lib::commands::render::{RenderPriority, RenderRequest};
use sheer_lib::commands::save::SaveAck;
use sheer_lib::commands::AppState;
use sheer_lib::documents::{DocumentId, PageId};
use sheer_lib::engine::{self, Engine};
use sheer_lib::error::UiError;
use sheer_lib::model::annotation::{Annotation, AnnotationBody, Sync};
use sheer_lib::model::command::DocCommand;
use sheer_lib::model::stamp::{StampKind, StampTone};
use sheer_lib::pdfwrite::inspect::list_annotations;
use support::fixtures::{add_pages, Page};
use support::PdfBuilder;

struct Scratch(PathBuf);

impl Scratch {
    fn new(name: &str) -> Self {
        let path = std::env::temp_dir().join(format!("sheer-stamps-{}-{name}", std::process::id()));
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
                eprintln!("skipping the stamp tests: {} not found", library.display());
                None
            }
        })
        .as_ref()
}

/// One blank US Letter page, with a stamp named like ours but with an empty `/Contents`, and one with a text that is too long.
fn base() -> Vec<u8> {
    let mut builder = PdfBuilder::new();
    add_pages(
        &mut builder,
        &[Page::new("").with("/Annots [100 0 R 101 0 R]")],
    );
    let page = support::fixtures::page_id(0);
    let long = "A".repeat(500);
    builder.object(
        100,
        &format!("<< /Type /Annot /Subtype /Stamp /Rect [400 100 500 140] /NM (sheer-stamp-draft-ab12) /P {page} 0 R >>"),
    );
    builder.object(
        101,
        &format!("<< /Type /Annot /Subtype /Stamp /Rect [400 200 500 240] /NM (sheer-stamp-custom-cd34) /Contents ({long}) /P {page} 0 R >>"),
    );
    builder.object(1, "<< /Type /Catalog /Pages 2 0 R >>");
    builder.finish(1)
}

fn open(state: &AppState, scratch: &Scratch, name: &str) -> (DocumentId, PathBuf) {
    let path = scratch.file(name);
    std::fs::write(&path, base()).unwrap();
    let info = state.open_path(path.clone()).unwrap().expect("loaded");
    (info.id, std::fs::canonicalize(path).unwrap())
}

fn command(value: serde_json::Value) -> DocCommand {
    serde_json::from_value(value).unwrap()
}

fn draft(body: serde_json::Value) -> serde_json::Value {
    let mut draft = json!({"pageId": 0, "kind": "stamp", "color": [0, 0, 0]});
    for (key, value) in body.as_object().unwrap() {
        draft[key] = value.clone();
    }
    draft
}

fn try_create(
    state: &AppState,
    id: DocumentId,
    body: serde_json::Value,
) -> Result<Annotation, sheer_lib::error::AppError> {
    state
        .apply_command(
            id,
            command(json!({"type": "createAnnotation", "draft": draft(body)})),
        )
        .map(|changes| changes.upserted.into_iter().next().unwrap())
}

fn create(state: &AppState, id: DocumentId, body: serde_json::Value) -> Annotation {
    try_create(state, id, body).unwrap()
}

fn render(state: &AppState, id: DocumentId) -> (u32, Vec<u8>) {
    let frame = state
        .render_page(RenderRequest {
            doc_id: id,
            page_id: PageId::new(0),
            bucket: 0,
            tile: None,
            priority: RenderPriority::Visible,
            generation: 1,
        })
        .unwrap();
    let width = u32::from_le_bytes(frame[8..12].try_into().unwrap());
    let decoder = png::Decoder::new(std::io::Cursor::new(&frame[16..]));
    let mut reader = decoder.read_info().unwrap();
    let mut pixels = vec![0; reader.output_buffer_size().unwrap()];
    reader.next_frame(&mut pixels).unwrap();
    (width, pixels)
}

/// The RGB of the pixel at page position (`x`, `y`) of a frame rendered at bucket 0.
fn pixel(frame: &(u32, Vec<u8>), x: f32, y: f32) -> [u8; 3] {
    let scale = frame.0 as f32 / 612.0;
    let (px, py) = ((x * scale) as usize, (y * scale) as usize);
    let at = (py * frame.0 as usize + px) * 3;
    [frame.1[at], frame.1[at + 1], frame.1[at + 2]]
}

/// Whether any pixel in the page rectangle is not white.
fn has_ink(frame: &(u32, Vec<u8>), rect: &sheer_lib::model::geometry::Rect) -> bool {
    let mut y = rect.y;
    while y < rect.y + rect.h {
        let mut x = rect.x;
        while x < rect.x + rect.w {
            if pixel(frame, x, y) != [255, 255, 255] {
                return true;
            }
            x += 1.0;
        }
        y += 1.0;
    }
    false
}

fn stamp_parts(annotation: &Annotation) -> (StampKind, String, Option<String>, StampTone) {
    match &annotation.body {
        AnnotationBody::Stamp {
            stamp,
            text,
            date,
            tone,
            ..
        } => (*stamp, text.clone(), date.clone(), *tone),
        other => panic!("not a stamp: {other:?}"),
    }
}

#[test]
fn a_stamp_is_saved_with_our_appearance_and_keys_and_pdfium_draws_it() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("write");
    let (id, path) = open(state, &scratch, "doc.pdf");
    let original = std::fs::read(&path).unwrap();

    // A zero-size box gets the natural size; umlauts and the euro sign are WinAnsi and work.
    let solar = create(
        state,
        id,
        json!({"box": {"x": 72.0, "y": 100.0, "w": 0.0, "h": 0.0}, "stamp": "custom", "text": "Gepr\u{fc}ft \u{20ac}", "date": "07.10.2026", "tone": "solar", "color": [1, 2, 3]}),
    );
    let ink = create(
        state,
        id,
        json!({"box": {"x": 72.0, "y": 300.0, "w": 0.0, "h": 0.0}, "stamp": "draft", "text": "DRAFT", "tone": "ink"}),
    );
    assert_eq!(solar.color.0, [255, 248, 77], "a draft colour is ignored");
    assert_eq!(solar.contents, "Gepr\u{fc}ft \u{20ac}");
    assert!(
        solar.rect.w > 60.0 && solar.rect.h > 40.0,
        "{:?}",
        solar.rect
    );

    state.save_in_place(id, SaveAck::default()).unwrap();
    let bytes = std::fs::read(&path).unwrap();
    assert_eq!(
        &bytes[..original.len()],
        original.as_slice(),
        "an incremental update"
    );
    let text = String::from_utf8_lossy(&bytes[original.len()..]).replace(' ', "");
    for needle in [
        "/Subtype /Stamp",
        "/Name /Custom",
        "/Name /Draft",
        "/SHR_Stamp",
        "/BaseFont /Helvetica-Bold",
        "/WinAnsiEncoding",
    ] {
        assert!(text.contains(&needle.replace(' ', "")), "missing {needle}");
    }

    let in_file = list_annotations(&bytes).unwrap();
    let ours: Vec<_> = in_file
        .iter()
        .filter(|s| {
            s.name
                .as_deref()
                .is_some_and(|n| n.starts_with("sheer-stamp-"))
        })
        .collect();
    assert_eq!(ours.len(), 4, "the two foreign-looking ones and ours");
    for word in ["custom", "draft"] {
        let prefix = format!("sheer-stamp-{word}-");
        assert!(
            ours.iter()
                .any(|s| s.has_appearance
                    && s.name.as_deref().is_some_and(|n| n.starts_with(&prefix)))
        );
    }
    assert_eq!(
        ours.iter().filter(|s| s.has_appearance).count(),
        2,
        "ours have the appearance, the foreign-looking ones none"
    );

    // PDFium draws the saved appearance: Solar fills (yellow near the corner, away from the text), Ink only strokes.
    let frame = render(state, id);
    let yellow = pixel(&frame, solar.rect.x + 10.0, solar.rect.y + 3.0);
    assert!(
        yellow[0] > 230 && yellow[1] > 220 && yellow[2] < 140,
        "{yellow:?}"
    );
    assert!(has_ink(&frame, &solar.rect));
    assert!(has_ink(&frame, &ink.rect));
    assert_eq!(
        pixel(&frame, ink.rect.x + 10.0, ink.rect.y + 3.0),
        [255, 255, 255]
    );
}

#[test]
fn a_reopened_stamp_is_an_editable_sheer_stamp_and_a_foreign_one_stays_opaque() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("reopen");
    let (id, path) = open(state, &scratch, "doc.pdf");
    create(
        state,
        id,
        json!({"box": {"x": 72.0, "y": 100.0, "w": 0.0, "h": 0.0}, "stamp": "received", "text": "RECEIVED", "date": "Oct 7, 2026", "tone": "ink"}),
    );
    state.save_in_place(id, SaveAck::default()).unwrap();

    let copy = scratch.file("copy.pdf");
    std::fs::copy(&path, &copy).unwrap();
    let other = state.open_path(copy).unwrap().expect("loaded").id;
    let listed = state.list_annotations(other, PageId::new(0)).unwrap();
    let stamps: Vec<_> = listed
        .iter()
        .filter(|a| matches!(a.body, AnnotationBody::Stamp { .. }))
        .collect();
    assert_eq!(stamps.len(), 1);
    let mine = stamps[0];
    assert_eq!(mine.sync, Sync::Clean);
    assert_eq!(
        stamp_parts(mine),
        (
            StampKind::Received,
            "RECEIVED".to_owned(),
            Some("Oct 7, 2026".to_owned()),
            StampTone::Ink
        )
    );
    assert_eq!(mine.color.0, [15, 15, 15]);
    // The two stamps with our prefix but unusable contents are listed, not editable.
    let opaque = listed
        .iter()
        .filter(|a| matches!(a.body, AnnotationBody::Opaque { .. }))
        .count();
    assert_eq!(opaque, 2);

    // It is editable: the text and the tone change, the file keeps one stamp of it, in place.
    state
        .apply_command(
            other,
            command(json!({"type": "updateAnnotation", "id": mine.id, "patch": {"stampText": "Eingang", "stampTone": "solar", "stampDate": "07.10.2026"}, "coalesce": "stamp"})),
        )
        .unwrap();
    state.save_in_place(other, SaveAck::default()).unwrap();
    let again = std::fs::read(scratch.file("copy.pdf")).unwrap();
    let count = list_annotations(&again)
        .unwrap()
        .iter()
        .filter(|s| s.subtype == "Stamp")
        .count();
    assert_eq!(count, 3);
    let copy2 = scratch.file("copy2.pdf");
    std::fs::copy(scratch.file("copy.pdf"), &copy2).unwrap();
    let third = state.open_path(copy2).unwrap().expect("loaded").id;
    let listed = state.list_annotations(third, PageId::new(0)).unwrap();
    let edited = listed
        .iter()
        .find(|a| matches!(a.body, AnnotationBody::Stamp { .. }))
        .unwrap();
    assert_eq!(
        stamp_parts(edited),
        (
            StampKind::Received,
            "Eingang".to_owned(),
            Some("07.10.2026".to_owned()),
            StampTone::Solar
        )
    );
}

#[test]
fn a_stamp_can_be_moved_deleted_and_undone() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("undo");
    let (id, _) = open(state, &scratch, "doc.pdf");
    let stamp = create(
        state,
        id,
        json!({"box": {"x": 72.0, "y": 100.0, "w": 0.0, "h": 0.0}, "stamp": "approved", "text": "APPROVED", "tone": "solar"}),
    );
    let moved = state
        .apply_command(
            id,
            command(json!({"type": "moveAnnotations", "ids": [stamp.id], "dx": 10.0, "dy": 5.0})),
        )
        .unwrap();
    assert_eq!(moved.upserted[0].rect.x, stamp.rect.x + 10.0);
    let undone = state.undo(id).unwrap();
    assert_eq!(undone.upserted[0].rect.x, stamp.rect.x);
    state.redo(id).unwrap();
    let deleted = state
        .apply_command(
            id,
            command(json!({"type": "deleteAnnotations", "ids": [stamp.id]})),
        )
        .unwrap();
    assert_eq!(deleted.removed, vec![stamp.id]);
    let back = state.undo(id).unwrap();
    assert_eq!(back.upserted[0].id, stamp.id);
    // Undoing the creation takes it away again.
    state.undo(id).unwrap();
    let undone = state.undo(id).unwrap();
    assert_eq!(undone.removed, vec![stamp.id]);
}

#[test]
fn hostile_text_is_stripped_or_refused() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("hostile");
    let (id, _) = open(state, &scratch, "doc.pdf");
    let at = json!({"x": 72.0, "y": 100.0, "w": 0.0, "h": 0.0});

    let clean = create(
        state,
        id,
        json!({"box": at, "stamp": "custom", "text": "Ok\u{7}\n\u{202E}!", "tone": "ink"}),
    );
    assert_eq!(stamp_parts(&clean).1, "Ok!", "control characters go");

    let code = |body: serde_json::Value| {
        let error = try_create(state, id, body).unwrap_err();
        let ui = UiError::from(error);
        serde_json::to_value(ui).unwrap()
    };
    let long = code(json!({"box": at, "stamp": "custom", "text": "A".repeat(65), "tone": "ink"}));
    assert_eq!(long["code"], "invalid_argument");
    let cjk = code(json!({"box": at, "stamp": "custom", "text": "\u{4e2d}", "tone": "ink"}));
    assert_eq!(cjk["params"], json!({"what": "stamp", "char": "\u{4e2d}"}));
    for body in [
        json!({"box": at, "stamp": "custom", "text": "", "tone": "ink"}),
        json!({"box": at, "stamp": "custom", "text": "\u{7}", "tone": "ink"}),
        json!({"box": at, "stamp": "received", "text": "RECEIVED", "tone": "ink"}),
        json!({"box": at, "stamp": "custom", "text": "x", "date": "1".repeat(33), "tone": "ink"}),
        json!({"box": {"x": 1.0, "y": 1.0, "w": 10.0, "h": 5.0}, "stamp": "custom", "text": "x", "tone": "ink"}),
    ] {
        assert!(try_create(state, id, body.clone()).is_err(), "{body}");
    }
}
