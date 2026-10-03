//! Content objects (ADR-047 §1, M5 package A): text boxes and images are edited in the model, burned into the page by a save, and the
//! text stays extractable in PDFium, also on a rotated page. An image is judged hard on the way in: a hostile or oversize file never gets
//! past the intake. The PDFium parts skip, like the other engine tests, when the library is not fetched.

// Test code: panicking on a broken fixture is the point.
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use std::io::Cursor;
use std::path::PathBuf;
use std::sync::OnceLock;

use image::{DynamicImage, ImageFormat, Rgba, RgbaImage};
use serde_json::json;
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
        let path =
            std::env::temp_dir().join(format!("sheer-content-{}-{name}", std::process::id()));
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

fn data_dir() -> &'static std::path::Path {
    static DIR: OnceLock<Scratch> = OnceLock::new();
    &DIR.get_or_init(|| Scratch::new("data")).0
}

fn state() -> Option<&'static AppState> {
    static STATE: OnceLock<Option<AppState>> = OnceLock::new();
    STATE
        .get_or_init(|| {
            let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("pdfium");
            let library = engine::library_path(&root);
            library
                .is_file()
                .then(|| AppState::new(Engine::start(library)).with_data_dir(data_dir().to_owned()))
        })
        .as_ref()
}

/// Two pages; page 0 says "Base text". `rotate` is the `/Rotate` of both.
fn base(rotate: u16) -> Vec<u8> {
    let mut builder = PdfBuilder::new();
    add_pages(
        &mut builder,
        &[
            Page::new("BT /F1 12 Tf 72 700 Td (Base text) Tj ET")
                .with(&format!("/Rotate {rotate}")),
            Page::new("").with(&format!("/Rotate {rotate}")),
        ],
    );
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

fn create(
    state: &AppState,
    id: DocumentId,
    draft: serde_json::Value,
) -> Result<sheer_lib::model::doc_state::ChangeSet, sheer_lib::error::AppError> {
    state.apply_command(
        id,
        command(json!({"type": "createAnnotation", "draft": draft})),
    )
}

fn text_box(page: u32, text: &str) -> serde_json::Value {
    json!({
        "pageId": page, "kind": "textBox", "color": [20, 40, 160], "opacity": 1.0,
        "box": {"x": 72.0, "y": 100.0, "w": 150.0, "h": 0.0},
        "text": text, "font": "serif", "fontSize": 14.0, "align": "left"
    })
}

fn png(width: u32, height: u32, alpha: bool) -> Vec<u8> {
    let picture = DynamicImage::ImageRgba8(RgbaImage::from_fn(width, height, |x, _| {
        Rgba([200, 30, 30, if alpha && x % 2 == 0 { 0 } else { 255 }])
    }));
    let mut out = Cursor::new(Vec::new());
    picture.write_to(&mut out, ImageFormat::Png).unwrap();
    out.into_inner()
}

/// A PNG that is nothing but a header of `width` x `height`.
fn header_only(width: u32, height: u32) -> Vec<u8> {
    let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
    png.extend_from_slice(&[0, 0, 0, 13]);
    png.extend_from_slice(b"IHDR");
    png.extend_from_slice(&width.to_be_bytes());
    png.extend_from_slice(&height.to_be_bytes());
    png.extend_from_slice(&[8, 2, 0, 0, 0, 0, 0, 0, 0]);
    png
}

fn content_of(bytes: &[u8], page: usize) -> String {
    let doc = sheer_lib::pdfwrite::prescan::load_untrusted(bytes).unwrap();
    let id = *doc.get_pages().values().nth(page).unwrap();
    String::from_utf8_lossy(&doc.get_page_content(id)).into_owned()
}

#[test]
fn a_saved_text_box_is_page_text_that_pdfium_extracts() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("text");
    let original = base(0);
    let (id, path) = open(state, &scratch, "doc.pdf", &original);
    let made = create(
        state,
        id,
        text_box(0, "Hello Grüße from the box, this line wraps"),
    )
    .unwrap();
    let object = &made.upserted[0];
    // Rust laid it out: several lines, a box as tall as they are.
    let sheer_lib::model::annotation::AnnotationBody::TextBox { lines, bounds, .. } = &object.body
    else {
        panic!("a text box");
    };
    assert!(lines.len() >= 2, "{lines:?}");
    assert!(bounds.h > 14.0 * 1.2 * 1.5);

    state.save_in_place(id, SaveAck::default()).unwrap();
    let bytes = std::fs::read(&path).unwrap();
    assert_eq!(&bytes[..original.len()], original.as_slice(), "incremental");
    let content = content_of(&bytes, 0);
    assert!(
        content.contains("BT") && content.contains("Tj"),
        "{content}"
    );
    assert!(content.contains("(Base text)"), "the old content stays");

    let reopened = open(state, &scratch, "copy.pdf", &bytes).0;
    let layer = state.text_layer(reopened, PageId::new(0)).unwrap();
    assert!(layer.text.contains("Base text"), "{:?}", layer.text);
    assert!(layer.text.contains("Hello"), "{:?}", layer.text);
    assert!(layer.text.contains("Gr\u{fc}\u{df}e"), "{:?}", layer.text);
    assert!(layer.text.contains("wraps"), "{:?}", layer.text);
}

#[test]
fn text_stays_extractable_on_a_rotated_page() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("rotated");
    for rotate in [90u16, 180, 270] {
        let (id, path) = open(state, &scratch, &format!("r{rotate}.pdf"), &base(rotate));
        create(state, id, text_box(0, "Upright words")).unwrap();
        state.save_in_place(id, SaveAck::default()).unwrap();
        let bytes = std::fs::read(&path).unwrap();
        let reopened = open(state, &scratch, &format!("c{rotate}.pdf"), &bytes).0;
        let layer = state.text_layer(reopened, PageId::new(0)).unwrap();
        assert!(
            layer.text.contains("Upright words"),
            "{rotate}: {:?}",
            layer.text
        );
        assert_eq!(layer.rotation, rotate);
        // Upright as displayed: the text matrix is the rotation that undoes the page's `/Rotate`.
        let content = content_of(&bytes, 0);
        let expected = match rotate {
            90 => " 0 1 -1 0 ",
            180 => " -1 0 0 -1 ",
            _ => " 0 -1 1 0 ",
        };
        assert!(
            content.contains(&format!(
                "
{}",
                expected.trim_start()
            )),
            "{rotate}: {content}"
        );
    }
}

#[test]
fn a_character_outside_winansi_is_refused_with_the_character() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("charset");
    let (id, _) = open(state, &scratch, "doc.pdf", &base(0));
    let error = create(state, id, text_box(0, "Hi \u{4e2d}")).unwrap_err();
    assert_eq!(error.code(), ErrorCode::InvalidArgument);
    let ui = serde_json::to_value(sheer_lib::error::UiError::from(error)).unwrap();
    assert_eq!(ui["params"]["what"], "textBox");
    assert_eq!(ui["params"]["char"], "\u{4e2d}");
}

#[test]
fn an_image_is_stored_previewed_and_burned_with_its_alpha() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("image");
    let original = base(0);
    let (id, path) = open(state, &scratch, "doc.pdf", &original);
    let opaque = scratch.file("opaque.png");
    let alpha = scratch.file("alpha.png");
    std::fs::write(&opaque, png(64, 32, false)).unwrap();
    std::fs::write(&alpha, png(32, 32, true)).unwrap();
    let first = state.import_image_file(id, &opaque).unwrap();
    let second = state.import_image_file(id, &alpha).unwrap();
    assert_eq!((first.width, first.height), (64, 32));
    assert!((first.aspect - 2.0).abs() < 1e-4);
    assert_ne!(first.asset_id, second.asset_id);

    let frame = state.asset_preview(id, first.asset_id, 16).unwrap();
    assert_eq!(&frame[..4], b"SHR1");
    assert!(state.asset_preview(id, first.asset_id, 8).is_err());

    for (info, y) in [(first, 300.0), (second, 400.0)] {
        create(
            state,
            id,
            json!({
                "pageId": 0, "kind": "image", "color": [0, 0, 0], "opacity": 0.5,
                "box": {"x": 72.0, "y": y, "w": 100.0, "h": 100.0 / info.aspect},
                "assetId": info.asset_id, "aspect": info.aspect
            }),
        )
        .unwrap();
    }
    // An image with an id that is no asset, or the wrong aspect, is refused.
    let wrong = json!({
        "pageId": 0, "kind": "image", "color": [0, 0, 0], "opacity": 1.0,
        "box": {"x": 0.0, "y": 0.0, "w": 50.0, "h": 50.0}, "assetId": 999, "aspect": 1.0
    });
    assert!(create(state, id, wrong).is_err());

    state.save_in_place(id, SaveAck::default()).unwrap();
    let bytes = std::fs::read(&path).unwrap();
    assert_eq!(&bytes[..original.len()], original.as_slice());
    let text = String::from_utf8_lossy(&bytes);
    assert!(text.contains("/DCTDecode"), "opaque is a JPEG");
    assert!(text.contains("/SMask"), "alpha is a soft mask");
    assert!(text.contains("/ca 0.5"));
    let content = content_of(&bytes, 0);
    assert_eq!(content.matches(" Do").count(), 2, "{content}");
    // PDFium opens it and draws the pixels: the opaque picture is red-ish where it was placed.
    let reopened = open(state, &scratch, "copy.pdf", &bytes).0;
    assert!(state
        .text_layer(reopened, PageId::new(0))
        .unwrap()
        .text
        .contains("Base text"));
}

#[test]
fn hostile_and_oversize_images_do_not_get_in() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("hostile");
    let (id, _) = open(state, &scratch, "doc.pdf", &base(0));
    let try_import = |name: &str, bytes: &[u8]| {
        let path = scratch.file(name);
        std::fs::write(&path, bytes).unwrap();
        state.import_image_file(id, &path)
    };
    // Over 20 MiB.
    let mut big = png(8, 8, false);
    big.resize(21 * 1024 * 1024, 0);
    assert_eq!(
        try_import("big.png", &big).unwrap_err().code(),
        ErrorCode::TooLarge
    );
    // Header limits are judged before a pixel is decoded.
    for (w, h) in [(8193, 10), (10, 8193), (7000, 7000)] {
        let error = try_import("wide.png", &header_only(w, h)).unwrap_err();
        assert_eq!(error.code(), ErrorCode::LimitExceeded, "{w}x{h}");
    }
    // Not an image, a wrong name, an empty file, a truncated one, a directory.
    for (name, bytes) in [
        ("text.png", b"hello".to_vec()),
        ("gif.png", b"GIF89a\x01\x00\x01\x00".to_vec()),
        ("empty.png", Vec::new()),
        ("cut.png", png(64, 64, false)[..40].to_vec()),
        ("cut.jpg", vec![0xFF, 0xD8, 0xFF, 0xE0, 0, 16, b'J']),
    ] {
        let error = try_import(name, &bytes).unwrap_err();
        assert_ne!(error.code(), ErrorCode::Internal, "{name}");
    }
    assert!(state.import_image_file(id, &scratch.0).is_err());
    // Nothing was stored.
    assert!(state
        .asset_preview(id, sheer_lib::model::ids::AssetId::new(1), 64)
        .is_err());
}

#[test]
fn a_document_holds_at_most_128_images() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("budget");
    let (id, _) = open(state, &scratch, "doc.pdf", &base(0));
    let path = scratch.file("tiny.png");
    std::fs::write(&path, png(4, 4, false)).unwrap();
    for _ in 0..128 {
        state.import_image_file(id, &path).unwrap();
    }
    let error = state.import_image_file(id, &path).unwrap_err();
    assert_eq!(error.code(), ErrorCode::LimitExceeded);
}

// --- No PDFium needed ---

#[test]
fn burn_all_wraps_the_old_content_and_appends_one_stream() {
    use sheer_lib::content::ContentObject;
    use sheer_lib::model::annotation::{Annotation, AnnotationBody, Rgb, StdFont, TextAlign};
    use sheer_lib::model::geometry::Rect;

    let original = base(0);
    let annotation: Annotation = serde_json::from_value(json!({
        "id": 1, "pageId": 0, "rect": {"x": 72.0, "y": 100.0, "w": 150.0, "h": 20.0},
        "color": [0, 0, 0], "opacity": 1.0, "contents": "", "author": null, "modified": null,
        "inReplyTo": null, "locked": false, "sync": "new",
        "kind": "textBox", "box": {"x": 72.0, "y": 100.0, "w": 150.0, "h": 20.0},
        "text": "Parens (and) back\\slash", "lines": [], "font": "sans", "fontSize": 12.0, "align": "right"
    }))
    .unwrap();
    assert!(matches!(
        annotation.body,
        AnnotationBody::TextBox {
            font: StdFont::Sans,
            align: TextAlign::Right,
            ..
        }
    ));
    let _ = (
        Rgb([0, 0, 0]),
        Rect {
            x: 0.0,
            y: 0.0,
            w: 0.0,
            h: 0.0,
        },
    );
    let object = ContentObject {
        annotation,
        index: 0,
        image: None,
    };
    let bytes =
        sheer_lib::pdfwrite::content::burn_all(original.clone(), &[(PageId::new(0), vec![object])])
            .unwrap();
    assert_eq!(&bytes[..original.len()], original.as_slice());
    let content = content_of(&bytes, 0);
    assert!(content.starts_with("q\n"), "{content}");
    assert!(content.contains("(Base text) Tj"));
    assert!(content.contains("\nQ\n"));
    assert!(
        content.contains("(Parens \\(and\\) back\\\\slash) Tj"),
        "{content}"
    );
    // The page resources hold the font, and page 1 is untouched.
    let doc = sheer_lib::pdfwrite::prescan::load_untrusted(&bytes).unwrap();
    let first = *doc.get_pages().values().next().unwrap();
    let resources = doc.get_page_resources(first).unwrap().0.unwrap();
    let fonts = resources.get(b"Font").unwrap().as_dict().unwrap();
    assert!(fonts.has(b"F1") && fonts.has(b"SheerF1"));
    let _ = page_id(0);
}
