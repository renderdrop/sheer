//! Annotations through the engine child (ADR-115): the child's reply to an import carries every kind the model has, also the ones
//! that never come from the UI (a stamp whose art is "in the file", an opaque kind). A reply the parent could not decode used to
//! restart the engine on every reopen of a file with a turned stamp, while the in-process engine read it fine.
//! Skips, like the other engine tests, when the library is not fetched.

// Test code: panicking on a broken fixture is the point (clippy.toml only exempts `#[test]` functions, not helpers).
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};

use serde_json::json;
use sheer_lib::commands::render::{RenderPriority, RenderRequest};
use sheer_lib::commands::save::SaveAck;
use sheer_lib::commands::signatures::SignatureRef;
use sheer_lib::commands::AppState;
use sheer_lib::documents::{DocumentId, PageId};
use sheer_lib::engine::{self, Engine};
use sheer_lib::model::annotation::SignatureRole;
use sheer_lib::model::command::DocCommand;
use sheer_lib::signatures::DrawCmd;
use support::fixtures::{add_pages, Page};
use support::PdfBuilder;

type Restarts = Arc<Mutex<Vec<Vec<DocumentId>>>>;

fn state() -> Option<&'static (AppState, Restarts)> {
    static STATE: OnceLock<Option<(AppState, Restarts)>> = OnceLock::new();
    STATE
        .get_or_init(|| {
            let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("pdfium");
            let library = engine::library_path(&root);
            library.is_file().then(|| {
                let restarts: Restarts = Arc::default();
                let sink = Arc::clone(&restarts);
                let engine = Engine::start_process(
                    library,
                    PathBuf::from(env!("CARGO_BIN_EXE_sheer")),
                    Some(Arc::new(move |lost| sink.lock().unwrap().push(lost))),
                );
                (AppState::new(engine), restarts)
            })
        })
        .as_ref()
}

fn command(value: serde_json::Value) -> DocCommand {
    serde_json::from_value(value).unwrap()
}

fn render(state: &AppState, id: DocumentId, page: u32) -> usize {
    state
        .render_page(RenderRequest {
            doc_id: id,
            page_id: PageId::new(page),
            bucket: 0,
            tile: None,
            priority: RenderPriority::Visible,
            generation: 1,
        })
        .unwrap()
        .len()
}

#[test]
fn a_turned_stamp_a_free_text_and_a_note_survive_save_and_reopen_without_an_engine_restart() {
    let Some((state, restarts)) = state() else {
        return;
    };
    let dir = std::env::temp_dir().join(format!("sheer-child-annots-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("doc.pdf");
    let mut builder = PdfBuilder::new();
    add_pages(&mut builder, &[Page::new(""), Page::new(""), Page::new("")]);
    builder.object(1, "<< /Type /Catalog /Pages 2 0 R >>");
    std::fs::write(&path, builder.finish(1)).unwrap();
    let id = state.open_path(path.clone()).unwrap().expect("loaded").id;

    let create = |draft: serde_json::Value| {
        state
            .apply_command(
                id,
                command(json!({"type": "createAnnotation", "draft": draft})),
            )
            .unwrap()
    };
    create(json!({
        "pageId": 0, "kind": "freeText", "color": [26, 127, 92], "contents": "A text comment that wraps over lines", "lines": ["A text comment that", "wraps over lines"],
        "box": {"x": 96.0, "y": 330.0, "w": 257.0, "h": 40.0}, "fontSize": 12.0, "align": "center",
        "fill": [255, 248, 77], "borderWidth": 1.0, "borderColor": [15, 15, 15]
    }));
    create(json!({
        "pageId": 0, "kind": "note", "color": [0, 0, 0], "contents": "Check this", "at": {"x": 471.0, "y": 97.5}, "icon": "note"
    }));
    let block = state
        .create_drawn_signature(
            SignatureRole::Signature,
            &[vec![
                DrawCmd::M(0.0, 0.0),
                DrawCmd::L(100.0, 0.0),
                DrawCmd::L(100.0, 25.0),
                DrawCmd::L(0.0, 25.0),
                DrawCmd::Z,
            ]],
        )
        .unwrap();
    let info = state
        .use_signature(id, &SignatureRef::Draft { id: block.id }, None)
        .unwrap();
    let asset_id = serde_json::to_value(&info).unwrap()["assetId"].clone();
    create(json!({
        "pageId": 0, "kind": "signature", "color": [15, 15, 15], "role": "signature", "angle": -55.34,
        "box": {"x": 422.0, "y": 497.0, "w": 220.5, "h": 36.0},
        "art": {"type": "asset", "assetId": asset_id, "aspect": info.aspect}
    }));
    state.save_in_place(id, SaveAck::default()).unwrap();
    state.close_document_checked(id, true).unwrap();

    let reopened = state.open_path(path).unwrap().expect("loaded").id;
    let listed = state.list_annotations(reopened, PageId::new(0)).unwrap();
    assert_eq!(listed.len(), 3);
    let stamp = listed
        .iter()
        .map(|a| serde_json::to_value(a).unwrap())
        .find(|v| v["kind"] == "signature")
        .unwrap();
    assert_eq!(stamp["art"], json!({"type": "file"}));
    assert!((stamp["angle"].as_f64().unwrap() + 55.34).abs() < 0.05);
    for page in 0..3 {
        assert!(render(state, reopened, page) > 100);
    }
    assert!(restarts.lock().unwrap().is_empty(), "the engine restarted");
    let _ = std::fs::remove_dir_all(dir);
}
