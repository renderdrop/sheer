//! Citations and tags against the real PDFium, through the same `AppState` the commands use (ADR-119, package C1): a citation is made from
//! the page text, saved as `/SHR_Cite` and `/SHR_Tags`, read back after a reopen; tags change and go; hostile keys are ignored; a page the
//! model never read keeps its keys. Skips, like the other engine tests, when the library is not fetched.

// Test code: panicking on a broken fixture is the point (clippy.toml only exempts `#[test]` functions, not helpers).
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde_json::json;
use sheer_lib::commands::save::SaveAck;
use sheer_lib::commands::AppState;
use sheer_lib::documents::{DocumentId, PageId};
use sheer_lib::engine::{self, Engine};
use sheer_lib::error::ErrorCode;
use sheer_lib::model::command::DocCommand;
use sheer_lib::model::quote::CitationDraft;
use sheer_lib::pdfwrite::sheer_keys;
use support::fixtures::{add_pages, page_id, Page};
use support::PdfBuilder;

struct Scratch(PathBuf);

impl Scratch {
    fn new(name: &str) -> Self {
        let path =
            std::env::temp_dir().join(format!("sheer-citations-{}-{name}", std::process::id()));
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
                    "skipping the citation tests: {} not found",
                    library.display()
                );
                None
            }
        })
        .as_ref()
}

fn open(state: &AppState, path: PathBuf) -> DocumentId {
    state.open_path(path).unwrap().expect("loaded").id
}

fn write(scratch: &Scratch, name: &str, bytes: &[u8]) -> PathBuf {
    let path = scratch.file(name);
    std::fs::write(&path, bytes).unwrap();
    std::fs::canonicalize(path).unwrap()
}

/// Reopens the saved file as a document of its own (a copy under another name).
fn reopen(state: &AppState, scratch: &Scratch, path: &Path, name: &str) -> DocumentId {
    let copy = scratch.file(name);
    std::fs::copy(path, &copy).unwrap();
    open(state, copy)
}

fn quad(x: f32, y: f32, w: f32, h: f32) -> serde_json::Value {
    json!([
        {"x": x, "y": y}, {"x": x + w, "y": y}, {"x": x, "y": y + h}, {"x": x + w, "y": y + h}
    ])
}

fn drafts(value: serde_json::Value) -> Vec<CitationDraft> {
    serde_json::from_value(value).unwrap()
}

/// The line "The quick brown fox jumps over the lazy dog." of page 0 of `fixtures::text()` (baseline 640 in PDF space, 152 in page space).
fn fox_draft(extra: serde_json::Value) -> serde_json::Value {
    let mut draft =
        json!({"pageId": 0, "quads": [quad(60.0, 135.0, 400.0, 25.0)], "color": [255, 248, 77]});
    for (key, value) in extra.as_object().unwrap() {
        draft[key] = value.clone();
    }
    draft
}

fn note_command(extra: serde_json::Value) -> DocCommand {
    let mut draft = json!({
        "pageId": 0, "kind": "note", "color": [255, 235, 0], "at": {"x": 300.0, "y": 80.0},
        "icon": "comment", "contents": "hi"
    });
    for (key, value) in extra.as_object().unwrap() {
        draft[key] = value.clone();
    }
    serde_json::from_value(json!({"type": "createAnnotation", "draft": draft})).unwrap()
}

#[test]
fn a_citation_is_made_from_the_page_text_saved_and_read_after_a_reopen() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("create");
    let path = write(&scratch, "doc.pdf", &support::fixtures::text());
    let id = open(state, path.clone());

    let changes = state
        .create_citations(
            id,
            drafts(json!([fox_draft(
                json!({"contents": "my comment", "tags": ["Method", "method", "Idea"]})
            )])),
        )
        .unwrap();
    assert_eq!(changes.upserted.len(), 1);
    assert!(changes.history.can_undo);

    let listed = state.list_citations(id).unwrap();
    assert_eq!(listed.len(), 1);
    assert!(listed[0].quote.contains("quick brown fox"), "{listed:?}");
    assert_eq!(listed[0].contents, "my comment");
    assert_eq!(listed[0].tags, ["Method", "Idea"]);
    assert_eq!(listed[0].group, None);
    assert!(!listed[0].locator.is_empty());

    state.save_in_place(id, SaveAck::default()).unwrap();
    let saved = std::fs::read(&path).unwrap();
    let keys = sheer_keys::read_page(&saved, 0).unwrap();
    assert_eq!(keys.len(), 1, "one annotation with keys on page 0");
    let found = keys.values().next().unwrap();
    assert_eq!(found.tags, ["Method", "Idea"]);
    assert_eq!(
        found.cite.as_ref().map(|c| c.quote.as_str()),
        Some(listed[0].quote.as_str())
    );

    let again = reopen(state, &scratch, &path, "copy.pdf");
    let relisted = state.list_citations(again).unwrap();
    assert_eq!(relisted.len(), 1);
    assert_eq!(relisted[0].quote, listed[0].quote);
    assert_eq!(relisted[0].contents, "my comment");
    assert_eq!(relisted[0].tags, ["Method", "Idea"]);
    assert_eq!(relisted[0].color, listed[0].color);
    // The summary says so too.
    let summaries = state.list_document_annotations(again).unwrap();
    assert!(summaries
        .iter()
        .any(|s| s.cite && s.tags == ["Method", "Idea"]));
}

#[test]
fn a_selection_across_pages_is_one_undo_step_with_a_shared_group() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("group");
    let path = write(&scratch, "doc.pdf", &support::fixtures::text());
    let id = open(state, path.clone());
    let changes = state
        .create_citations(
            id,
            drafts(json!([
                fox_draft(json!({})),
                // "needle needle needle" on page 2 (baseline 700 in PDF space).
                {"pageId": 2, "quads": [quad(60.0, 80.0, 300.0, 20.0)], "color": [125, 235, 181]}
            ])),
        )
        .unwrap();
    assert_eq!(changes.upserted.len(), 2);
    let listed = state.list_citations(id).unwrap();
    assert_eq!(listed.len(), 2);
    assert!(listed[0].group.is_some() && listed[0].group == listed[1].group);
    assert!(listed[1].quote.contains("needle"));
    assert_eq!(listed[0].page_id, PageId::new(0));
    assert_eq!(listed[1].page_id, PageId::new(2));
    assert_eq!(listed[1].locator, "3");

    let undone = state.undo(id).unwrap();
    assert_eq!(undone.removed.len(), 2, "one step took both back");
    assert!(state.list_citations(id).unwrap().is_empty());
    state.redo(id).unwrap();
    assert_eq!(state.list_citations(id).unwrap().len(), 2);

    state.save_in_place(id, SaveAck::default()).unwrap();
    let again = reopen(state, &scratch, &path, "copy.pdf");
    let relisted = state.list_citations(again).unwrap();
    assert_eq!(relisted.len(), 2);
    assert_eq!(relisted[0].group, listed[0].group);
}

#[test]
fn bad_drafts_are_refused_and_change_nothing() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("bad");
    let path = write(&scratch, "doc.pdf", &support::fixtures::text());
    let id = open(state, path);
    let code = |value: serde_json::Value| {
        state
            .create_citations(id, drafts(value))
            .unwrap_err()
            .code()
    };
    assert_eq!(code(json!([])), ErrorCode::InvalidArgument);
    // No text under the selection.
    assert_eq!(
        code(json!([{"pageId": 0, "quads": [quad(500.0, 700.0, 10.0, 10.0)], "color": [1, 2, 3]}])),
        ErrorCode::InvalidArgument
    );
    // The same page twice, no quads, too many drafts, too many tags, a page that is not there.
    assert_eq!(
        code(json!([fox_draft(json!({})), fox_draft(json!({}))])),
        ErrorCode::InvalidArgument
    );
    assert_eq!(
        code(json!([{"pageId": 0, "quads": [], "color": [1, 2, 3]}])),
        ErrorCode::InvalidArgument
    );
    let many: Vec<serde_json::Value> = (0..65)
        .map(|_| json!({"pageId": 0, "quads": [quad(0.0, 0.0, 1.0, 1.0)], "color": [1, 2, 3]}))
        .collect();
    assert_eq!(code(json!(many)), ErrorCode::LimitExceeded);
    let nine: Vec<String> = (0..9).map(|n| format!("t{n}")).collect();
    assert_eq!(
        code(json!([fox_draft(json!({"tags": nine}))])),
        ErrorCode::InvalidArgument
    );
    assert_eq!(
        code(json!([{"pageId": 99, "quads": [quad(0.0, 0.0, 1.0, 1.0)], "color": [1, 2, 3]}])),
        ErrorCode::InvalidArgument
    );
    assert!(state.list_citations(id).unwrap().is_empty());
    assert!(!state
        .list_document_annotations(id)
        .unwrap()
        .iter()
        .any(|s| s.cite));
}

#[test]
fn tags_round_trip_on_any_markup_and_removing_them_removes_the_key() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("tags");
    let path = write(&scratch, "doc.pdf", &support::fixtures::text());
    let id = open(state, path.clone());
    let made = state
        .apply_command(
            id,
            note_command(json!({"tags": ["Todo", "\u{dc}berpr\u{fc}fen"]})),
        )
        .unwrap();
    let note = made.upserted[0].id;
    state.save_in_place(id, SaveAck::default()).unwrap();
    let again = reopen(state, &scratch, &path, "copy.pdf");
    let listed = state.list_annotations(again, PageId::new(0)).unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].tags, ["Todo", "\u{dc}berpr\u{fc}fen"]);
    assert!(listed[0].cite.is_none());

    // A patch changes the tags (undoable), and an empty list takes the key out of the file.
    let patch = |tags: serde_json::Value| -> DocCommand {
        serde_json::from_value(json!({"type": "updateAnnotation", "id": note, "coalesce": "tags", "patch": {"tags": tags}})).unwrap()
    };
    let changed = state.apply_command(id, patch(json!(["One"]))).unwrap();
    assert_eq!(changed.upserted[0].tags, ["One"]);
    state.undo(id).unwrap();
    let changed = state.apply_command(id, patch(json!([]))).unwrap();
    assert!(changed.upserted[0].tags.is_empty());
    state.save_in_place(id, SaveAck::default()).unwrap();
    let saved = std::fs::read(&path).unwrap();
    assert!(sheer_keys::read_page(&saved, 0).unwrap().is_empty());
}

/// A page with a highlight carrying `extra` keys, then a page without annotations.
fn with_keys(extra: &str) -> Vec<u8> {
    let mut builder = PdfBuilder::new();
    add_pages(
        &mut builder,
        &[Page::new("").with("/Annots [100 0 R]"), Page::new("")],
    );
    let page = page_id(0);
    builder.object(
        100,
        &format!("<< /Type /Annot /Subtype /Highlight /Rect [72 700 172 712] /QuadPoints [72 712 172 712 72 700 172 700] /C [1 1 0] /Contents (Marked) /NM (hl-1) /P {page} 0 R {extra} >>"),
    );
    builder.object(1, "<< /Type /Catalog /Pages 2 0 R >>");
    builder.finish(1)
}

#[test]
fn hostile_keys_in_a_file_are_ignored_without_failing_the_page() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("hostile");
    let long = "q".repeat(20_000);
    let many: String = (0..500).map(|n| format!("(t{n}) ")).collect();
    let cases = [
        (
            "version",
            "/SHR_Cite << /V 2 /Q (x) >>".to_owned(),
            false,
            0,
        ),
        (
            "type",
            "/SHR_Cite (nope) /SHR_Tags (nope)".to_owned(),
            false,
            0,
        ),
        ("noquote", "/SHR_Cite << /V 1 >>".to_owned(), false, 0),
        (
            "oversize",
            format!("/SHR_Cite << /V 1 /Q ({long}) >> /SHR_Tags [({long})]"),
            false,
            0,
        ),
        ("many", format!("/SHR_Tags [{many}]"), false, 8),
        (
            "good",
            "/SHR_Cite << /V 1 /Q (The quote) /G (0a1b2c3d) >> /SHR_Tags [(a) (A) (b)]".to_owned(),
            true,
            2,
        ),
    ];
    for (name, keys, cited, tags) in cases {
        let path = write(&scratch, &format!("{name}.pdf"), &with_keys(&keys));
        let id = open(state, path);
        let listed = state.list_annotations(id, PageId::new(0)).unwrap();
        assert_eq!(listed.len(), 1, "{name}");
        assert_eq!(listed[0].cite.is_some(), cited, "{name}");
        assert_eq!(listed[0].tags.len(), tags, "{name}");
        assert_eq!(
            state.list_citations(id).unwrap().len(),
            usize::from(cited),
            "{name}"
        );
    }
}

#[test]
fn the_keys_of_an_annotation_the_writer_did_not_read_or_does_not_know_stay() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("keep");
    let keys = "/SHR_Cite << /V 1 /Q (Kept quote) >> /SHR_Tags [(keep)] /SHR_Future (x)";
    let path = write(&scratch, "unread.pdf", &with_keys(keys));
    let id = open(state, path.clone());
    // Page 0 is never read by the model; a note on it is written, the highlight is left as it is.
    state.apply_command(id, note_command(json!({}))).unwrap();
    state.save_in_place(id, SaveAck::default()).unwrap();
    let saved = std::fs::read(&path).unwrap();
    let kept = sheer_keys::read_page(&saved, 0).unwrap();
    assert_eq!(kept.len(), 1);
    assert_eq!(kept[&0].tags, ["keep"]);
    assert_eq!(
        kept[&0].cite.as_ref().map(|c| c.quote.as_str()),
        Some("Kept quote")
    );

    // A page the model read and rewrote keeps the keys the model has and the Sheer keys it does not know.
    let path = write(&scratch, "read.pdf", &with_keys(keys));
    let id = open(state, path.clone());
    let listed = state.list_annotations(id, PageId::new(0)).unwrap();
    assert_eq!(listed[0].tags, ["keep"]);
    state
        .apply_command(
            id,
            serde_json::from_value(json!({"type": "updateAnnotation", "id": listed[0].id,
                "patch": {"color": [10, 20, 30], "quote": "Edited quote"}}))
            .unwrap(),
        )
        .unwrap();
    state.save_in_place(id, SaveAck::default()).unwrap();
    let saved = std::fs::read(&path).unwrap();
    let kept = sheer_keys::read_page(&saved, 0).unwrap();
    assert_eq!(kept[&0].tags, ["keep"]);
    assert_eq!(
        kept[&0].cite.as_ref().map(|c| c.quote.as_str()),
        Some("Edited quote")
    );
    assert!(
        saved.windows(11).any(|w| w == b"/SHR_Future"),
        "a key the model does not know is kept"
    );
}
