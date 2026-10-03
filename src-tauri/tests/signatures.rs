//! Signatures and marks (ADR-041 §5, §6) against the real PDFium, through the same `AppState` the commands use: every kind is created,
//! saved with an appearance stream, read back by PDFium as a typed annotation, and still movable afterwards; the image import enforces its
//! limits. Skips, like the other engine tests, when the library is not fetched.

// Test code: panicking on a broken fixture is the point (clippy.toml only exempts `#[test]` functions, not helpers).
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde_json::json;
use sheer_lib::commands::save::SaveAck;
use sheer_lib::commands::signatures::{SignatureRef, TypedFont};
use sheer_lib::commands::AppState;
use sheer_lib::documents::{DocumentId, PageId};
use sheer_lib::engine::{self, Engine};
use sheer_lib::error::ErrorCode;
use sheer_lib::model::annotation::{Annotation, SignatureRole};
use sheer_lib::model::command::DocCommand;
use sheer_lib::model::geometry::Point;
use sheer_lib::pdfwrite::inspect::list_annotations;
use sheer_lib::signatures::SignatureArt;
use support::fixtures::{add_pages, Page};
use support::PdfBuilder;

struct Scratch(PathBuf);

impl Scratch {
    fn new(name: &str) -> Self {
        let path = std::env::temp_dir().join(format!("sheer-sig-{}-{name}", std::process::id()));
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
                eprintln!(
                    "skipping the signature tests: {} not found",
                    library.display()
                );
                None
            }
        })
        .as_ref()
}

fn blank() -> Vec<u8> {
    let mut builder = PdfBuilder::new();
    add_pages(&mut builder, &[Page::new("")]);
    builder.object(1, "<< /Type /Catalog /Pages 2 0 R >>");
    builder.finish(1)
}

fn open(state: &AppState, scratch: &Scratch, name: &str, bytes: &[u8]) -> (DocumentId, PathBuf) {
    let path = scratch.file(name);
    std::fs::write(&path, bytes).unwrap();
    let info = state.open_path(path.clone()).unwrap().expect("loaded");
    (info.id, std::fs::canonicalize(path).unwrap())
}

fn command(value: serde_json::Value) -> DocCommand {
    serde_json::from_value(value).unwrap()
}

fn create(state: &AppState, id: DocumentId, draft: serde_json::Value) -> Annotation {
    let changes = state
        .apply_command(
            id,
            command(json!({"type": "createAnnotation", "draft": draft})),
        )
        .unwrap();
    changes.upserted.into_iter().next().unwrap()
}

fn pt(x: f32, y: f32) -> Point {
    Point { x, y }
}

/// A PNG file of a 40 x 20 picture: a red block with a transparent corner, on white.
fn picture_png(path: &Path) {
    let mut out = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut out, 40, 20);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().unwrap();
        let mut data = Vec::new();
        for y in 0..20u32 {
            for x in 0..40u32 {
                let ink = (5..35).contains(&x) && (4..16).contains(&y);
                let alpha = if x < 10 && y < 6 { 0 } else { 255 };
                data.extend_from_slice(&if ink {
                    [200, 20, 20, alpha]
                } else {
                    [255, 255, 255, 255]
                });
            }
        }
        writer.write_image_data(&data).unwrap();
    }
    std::fs::write(path, out).unwrap();
}

fn asset(state: &AppState, doc: DocumentId, draft: sheer_lib::signatures::DraftId) -> (u32, f32) {
    let info = state
        .use_signature(doc, &SignatureRef::Draft { id: draft }, None)
        .unwrap();
    let value = serde_json::to_value(&info).unwrap();
    (value["assetId"].as_u64().unwrap() as u32, info.aspect)
}

fn signature_draft(
    kind: &str,
    asset_id: u32,
    aspect: f32,
    role: &str,
    at: (f32, f32, f32, f32),
) -> serde_json::Value {
    json!({
        "pageId": 0, "kind": kind, "color": [20, 40, 160],
        "box": {"x": at.0, "y": at.1, "w": at.2, "h": at.3},
        "role": role, "art": {"type": "asset", "assetId": asset_id, "aspect": aspect}
    })
}

#[test]
fn every_kind_is_saved_with_an_appearance_and_pdfium_reads_it_back() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("round-trip");
    let original = blank();
    let (id, path) = open(state, &scratch, "doc.pdf", &original);

    // Art: drawn, typed and a picture with alpha.
    let drawn = state
        .create_drawn_signature(
            SignatureRole::Signature,
            &[vec![
                pt(10.0, 10.0),
                pt(110.0, 12.0),
                pt(60.0, 60.0),
                pt(30.0, 40.0),
            ]],
        )
        .unwrap();
    let typed = state
        .create_typed_signature(SignatureRole::Initials, "A.L.", TypedFont::HomemadeApple)
        .unwrap();
    let SignatureArt::Vector { paths, .. } = &typed.art else {
        panic!("typed art is vector")
    };
    assert!(!paths.is_empty());
    let file = scratch.file("scan.png");
    picture_png(&file);
    let picture = state
        .import_signature_file(SignatureRole::Signature, &file, true)
        .unwrap();
    assert!(matches!(picture.art, SignatureArt::Raster { .. }));

    let (a_drawn, asp_drawn) = asset(state, id, drawn.id);
    let (a_typed, asp_typed) = asset(state, id, typed.id);
    let (a_pic, asp_pic) = asset(state, id, picture.id);
    let made = [
        create(
            state,
            id,
            signature_draft(
                "signature",
                a_drawn,
                asp_drawn,
                "signature",
                (72.0, 100.0, 150.0, 70.0),
            ),
        ),
        create(
            state,
            id,
            signature_draft(
                "signature",
                a_typed,
                asp_typed,
                "initials",
                (72.0, 200.0, 120.0, 30.0),
            ),
        ),
        create(
            state,
            id,
            signature_draft(
                "signature",
                a_pic,
                asp_pic,
                "signature",
                (72.0, 300.0, 120.0, 40.0),
            ),
        ),
        create(
            state,
            id,
            json!({"pageId": 0, "kind": "mark", "color": [0, 0, 0], "box": {"x": 300.0, "y": 100.0, "w": 20.0, "h": 20.0}, "glyph": "check"}),
        ),
        create(
            state,
            id,
            json!({"pageId": 0, "kind": "mark", "color": [0, 0, 0], "box": {"x": 300.0, "y": 140.0, "w": 20.0, "h": 20.0}, "glyph": "cross"}),
        ),
        create(
            state,
            id,
            json!({"pageId": 0, "kind": "mark", "color": [0, 0, 0], "box": {"x": 300.0, "y": 180.0, "w": 20.0, "h": 20.0}, "glyph": "dot"}),
        ),
    ];
    assert_eq!(made.len(), 6);

    state.save_in_place(id, SaveAck::default()).unwrap();
    let bytes = std::fs::read(&path).unwrap();
    assert_eq!(&bytes[..original.len()], original.as_slice());
    // The picture is an image XObject with a soft mask for its alpha.
    assert!(bytes.windows(6).any(|w| w == b"/SMask"));
    assert!(bytes.windows(6).any(|w| w == b"/Image"));

    let in_file = list_annotations(&bytes).unwrap();
    assert_eq!(in_file.len(), 6);
    let prefixes = [
        "sheer-sig-",
        "sheer-ini-",
        "sheer-sig-",
        "sheer-mark-check-",
        "sheer-mark-cross-",
        "sheer-mark-dot-",
    ];
    for (summary, prefix) in in_file.iter().zip(prefixes) {
        assert_eq!(summary.subtype, "Stamp");
        assert!(summary.has_appearance, "{prefix} has no /AP /N stream");
        assert!(
            summary
                .name
                .as_deref()
                .is_some_and(|n| n.starts_with(prefix)),
            "{prefix}"
        );
    }

    // PDFium opens the file and the stamps come back as signatures and marks, movable.
    let copy = scratch.file("copy.pdf");
    std::fs::copy(&path, &copy).unwrap();
    let reopened = state.open_path(copy.clone()).unwrap().expect("loaded").id;
    let listed = state.list_annotations(reopened, PageId::new(0)).unwrap();
    let values: Vec<serde_json::Value> = listed
        .iter()
        .map(|a| serde_json::to_value(a).unwrap())
        .collect();
    let kinds: Vec<&str> = values.iter().map(|v| v["kind"].as_str().unwrap()).collect();
    assert_eq!(
        kinds,
        [
            "signature",
            "signature",
            "signature",
            "mark",
            "mark",
            "mark"
        ]
    );
    assert_eq!(values[0]["role"], "signature");
    assert_eq!(values[1]["role"], "initials");
    assert_eq!(values[0]["art"], json!({"type": "file"}));
    let glyphs: Vec<&str> = values[3..]
        .iter()
        .map(|v| v["glyph"].as_str().unwrap())
        .collect();
    assert_eq!(glyphs, ["check", "cross", "dot"]);

    // Moving one of them and saving keeps its appearance (the file's art is kept by reference) and changes only its rectangle.
    state
        .apply_command(
            reopened,
            command(json!({"type": "moveAnnotations", "ids": [listed[0].id.get()], "dx": 50.0, "dy": 10.0})),
        )
        .unwrap();
    state.save_in_place(reopened, SaveAck::default()).unwrap();
    let after = list_annotations(&std::fs::read(&copy).unwrap()).unwrap();
    assert_eq!(after.len(), 6);
    assert!(after.iter().all(|s| s.has_appearance));
    assert!((after[0].rect[0] - (in_file[0].rect[0] + 50.0)).abs() < 0.1);
    assert!((after[0].rect[1] - (in_file[0].rect[1] - 10.0)).abs() < 0.1);
}

#[test]
fn a_signature_needs_a_live_asset_and_a_sane_box() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("validation");
    let (id, _) = open(state, &scratch, "doc.pdf", &blank());
    let apply = |draft: serde_json::Value| {
        state
            .apply_command(
                id,
                command(json!({"type": "createAnnotation", "draft": draft})),
            )
            .err()
            .map(|e| e.code())
    };
    // No such asset.
    assert_eq!(
        apply(signature_draft(
            "signature",
            99,
            2.0,
            "signature",
            (10.0, 10.0, 80.0, 40.0)
        )),
        Some(ErrorCode::InvalidArgument)
    );
    let drawn = state
        .create_drawn_signature(
            SignatureRole::Signature,
            &[vec![pt(0.0, 0.0), pt(100.0, 0.0), pt(100.0, 50.0)]],
        )
        .unwrap();
    let (asset_id, aspect) = asset(state, id, drawn.id);
    // Too small a box, and art that claims to be "in the file".
    assert_eq!(
        apply(signature_draft(
            "signature",
            asset_id,
            aspect,
            "signature",
            (10.0, 10.0, 3.0, 40.0)
        )),
        Some(ErrorCode::InvalidArgument)
    );
    let mut from_file = signature_draft(
        "signature",
        asset_id,
        aspect,
        "signature",
        (10.0, 10.0, 80.0, 40.0),
    );
    from_file["art"] = json!({"type": "file"});
    // It does not even parse: only an import makes art "in the file".
    assert!(serde_json::from_value::<DocCommand>(
        json!({"type": "createAnnotation", "draft": from_file})
    )
    .is_err());
    assert_eq!(
        apply(signature_draft(
            "signature",
            asset_id,
            aspect,
            "signature",
            (10.0, 10.0, 80.0, 40.0)
        )),
        None
    );
}

#[test]
fn the_image_import_enforces_its_limits() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("limits");
    let write = |name: &str, bytes: &[u8]| {
        let path = scratch.file(name);
        std::fs::write(&path, bytes).unwrap();
        path
    };
    let import = |path: &Path| {
        state
            .import_signature_file(SignatureRole::Signature, path, false)
            .err()
            .map(|e| e.code())
    };
    // Not a PNG or a JPEG.
    assert_eq!(
        import(&write("a.png", b"GIF89a-not-a-png")),
        Some(ErrorCode::InvalidArgument)
    );
    assert_eq!(
        import(&write("b.png", b"%PDF-1.7\n")),
        Some(ErrorCode::InvalidArgument)
    );
    // More than 4 000 pixels on a side: refused from the header.
    let mut wide = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut wide, 4_001, 1);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().unwrap();
        writer.write_image_data(&vec![255u8; 4_001 * 4]).unwrap();
    }
    assert_eq!(
        import(&write("c.png", &wide)),
        Some(ErrorCode::LimitExceeded)
    );
    // A file over 10 MiB.
    let big = vec![0u8; 10 * 1024 * 1024 + 1];
    assert_eq!(import(&write("d.png", &big)), Some(ErrorCode::TooLarge));
    // A directory is no picture.
    assert_eq!(import(&scratch.0), Some(ErrorCode::InvalidArgument));
}

#[test]
fn a_typed_signature_has_outlines_and_bad_text_is_refused() {
    let Some(state) = state() else { return };
    let draft = state
        .create_typed_signature(
            SignatureRole::Signature,
            "Grace Hopper",
            TypedFont::HomemadeApple,
        )
        .unwrap();
    let SignatureArt::Vector { w, h, paths } = draft.art else {
        panic!("vector")
    };
    assert!(w > h && !paths.is_empty());
    for text in ["", "a\u{0}b", "\u{4E2D}"] {
        assert!(state
            .create_typed_signature(SignatureRole::Signature, text, TypedFont::HomemadeApple)
            .is_err());
    }
}

/// The RGB of the pixel at page position (`x`, `y`) of page `page` rendered at bucket 0 (4/3 pixel per point).
fn pixel_at(state: &AppState, id: DocumentId, page: u32, x: f32, y: f32) -> [u8; 3] {
    use sheer_lib::commands::render::{RenderPriority, RenderRequest};
    let frame = state
        .render_page(RenderRequest {
            doc_id: id,
            page_id: PageId::new(page),
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
    let scale = width as f32 / 612.0;
    let (px, py) = ((x * scale) as usize, (y * scale) as usize);
    let at = (py * width as usize + px) * 3;
    [pixels[at], pixels[at + 1], pixels[at + 2]]
}

#[test]
fn a_saved_mark_and_picture_are_drawn_by_pdfium() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("render");
    let (id, path) = open(state, &scratch, "doc.pdf", &blank());
    create(
        state,
        id,
        json!({"pageId": 0, "kind": "mark", "color": [0, 0, 0], "box": {"x": 100.0, "y": 100.0, "w": 40.0, "h": 40.0}, "glyph": "dot"}),
    );
    let file = scratch.file("scan.png");
    picture_png(&file);
    let picture = state
        .import_signature_file(SignatureRole::Signature, &file, true)
        .unwrap();
    let (asset_id, aspect) = asset(state, id, picture.id);
    create(
        state,
        id,
        signature_draft(
            "signature",
            asset_id,
            aspect,
            "signature",
            (200.0, 100.0, 90.0, 40.0),
        ),
    );
    state.save_in_place(id, SaveAck::default()).unwrap();
    let copy = scratch.file("copy.pdf");
    std::fs::copy(&path, &copy).unwrap();
    let reopened = state.open_path(copy).unwrap().expect("loaded").id;
    // The centre of the dot is black; the middle of the picture is its red ink; the page elsewhere is white.
    let dot = pixel_at(state, reopened, 0, 120.0, 120.0);
    assert!(dot.iter().all(|c| *c < 60), "dot: {dot:?}");
    let ink = pixel_at(state, reopened, 0, 245.0, 120.0);
    assert!(ink[0] > 150 && ink[1] < 80, "ink: {ink:?}");
    assert_eq!(pixel_at(state, reopened, 0, 400.0, 400.0), [255, 255, 255]);
}
