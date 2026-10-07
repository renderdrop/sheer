//! FX-SAVE regression: a highlight or a stamp on the committed `text.pdf` saves in place, and the header/footer reads right after
//! the save work (the frontend overlay asks for them after every save).

#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use std::path::PathBuf;
use std::sync::OnceLock;

use serde_json::json;
use sheer_lib::commands::save::SaveAck;
use sheer_lib::commands::AppState;
use sheer_lib::engine::{self, Engine};
use sheer_lib::model::command::DocCommand;

fn state() -> Option<&'static AppState> {
    static STATE: OnceLock<Option<AppState>> = OnceLock::new();
    STATE
        .get_or_init(|| {
            let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("pdfium");
            let library = engine::library_path(&root);
            library.is_file().then(|| {
                let dir =
                    std::env::temp_dir().join(format!("sheer-textpdf-{}", std::process::id()));
                std::fs::create_dir_all(&dir).unwrap();
                AppState::new(Engine::start(library)).with_data_dir(dir)
            })
        })
        .as_ref()
}

fn run(kind: &str, draft: serde_json::Value) {
    let Some(state) = state() else { return };
    let dir = std::env::temp_dir().join(format!("sheer-textpdf-{}-{kind}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let copy = dir.join("text.pdf");
    std::fs::copy(
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/text.pdf"),
        &copy,
    )
    .unwrap();
    let info = state.open_path(copy).unwrap().expect("loaded");
    let id = info.id;
    let command: DocCommand =
        serde_json::from_value(json!({"type": "createAnnotation", "draft": draft})).unwrap();
    state.apply_command(id, command).unwrap();
    state.save_in_place(id, SaveAck::default()).unwrap();
    let found = state.get_header_footer(id).unwrap();
    let pages = vec![sheer_lib::documents::PageId::new(0)];
    state
        .resolve_header_footer(id, found.spec.clone(), &pages)
        .unwrap();
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_highlight_on_text_pdf_saves() {
    run(
        "hl",
        json!({"pageId": 0, "kind": "highlight", "color": [255, 235, 0], "opacity": 0.5, "quads": [[
            {"x": 72.0, "y": 700.0}, {"x": 172.0, "y": 700.0}, {"x": 72.0, "y": 712.0}, {"x": 172.0, "y": 712.0}]]}),
    );
}

#[test]
fn a_stamp_on_text_pdf_saves() {
    run(
        "stamp",
        json!({"pageId": 0, "kind": "stamp", "color": [0, 0, 0], "box": {"x": 72.0, "y": 100.0, "w": 0.0, "h": 0.0}, "stamp": "draft", "text": "DRAFT", "tone": "ink"}),
    );
}
