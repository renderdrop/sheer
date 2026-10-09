//! F20.7 (ADR-144): a comment over several separate text ranges is one markup annotation per page, the pages' annotations linked as a
//! group by `/IRT` + `/RT /Group` (ISO 32000-1 12.5.6.2). Through the real PDFium and the same `AppState` the commands use: a group is
//! made in one step, its text and its deletion act on all members, it is saved with the links and read back after a reopen; a group
//! written by another program is recognised; a broken or cyclic link reads as no group. Skips when the library is not fetched.

#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde_json::{json, Value};
use sheer_lib::commands::save::SaveAck;
use sheer_lib::commands::AppState;
use sheer_lib::documents::{DocumentId, PageId};
use sheer_lib::engine::{self, Engine};
use sheer_lib::model::annotation::Annotation;
use sheer_lib::model::command::DocCommand;
use sheer_lib::pdfwrite::inspect::list_annotations as file_annotations;
use sheer_lib::pdfwrite::reviews;
use support::fixtures::{add_pages, page_id, Page};
use support::PdfBuilder;

struct Scratch(PathBuf);

impl Scratch {
    fn new(name: &str) -> Self {
        let path = std::env::temp_dir().join(format!("sheer-groups-{}-{name}", std::process::id()));
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
            library
                .is_file()
                .then(|| AppState::new(Engine::start(library)).with_data_dir(data_dir().to_owned()))
        })
        .as_ref()
}

fn open(state: &AppState, path: &Path) -> DocumentId {
    let path = std::fs::canonicalize(path).unwrap();
    state.open_path(path).unwrap().expect("loaded").id
}

fn run(state: &AppState, id: DocumentId, value: Value) -> sheer_lib::model::doc_state::ChangeSet {
    let command: DocCommand = serde_json::from_value(value).unwrap();
    state.apply_command(id, command).unwrap()
}

fn quad(x: f32, y: f32, w: f32, h: f32) -> Value {
    json!([
        {"x": x, "y": y}, {"x": x + w, "y": y}, {"x": x, "y": y + h}, {"x": x + w, "y": y + h}
    ])
}

/// Two ranges on page 0 (one annotation with two quads) and one on page 2.
fn group_command() -> Value {
    json!({"type": "createAnnotationGroup", "drafts": [
        {"pageId": 0, "kind": "highlight", "color": [255, 235, 0], "contents": "one thought",
         "quads": [quad(72.0, 85.0, 200.0, 18.0), quad(72.0, 175.0, 120.0, 18.0)]},
        {"pageId": 2, "kind": "highlight", "color": [255, 235, 0], "contents": "one thought",
         "quads": [quad(72.0, 85.0, 200.0, 16.0)]}
    ]})
}

/// The only annotations of pages `first` and `member` of `bytes` are one group: the member links to the first by `/IRT` + `/RT /Group`
/// (the reader follows only such links to a group), the first links nowhere.
fn assert_grouped(bytes: &[u8], first: u32, member: u32) {
    let listed = file_annotations(bytes).unwrap();
    let on = |page: u32| {
        listed
            .iter()
            .filter(|a| a.page_index == page)
            .collect::<Vec<_>>()
    };
    assert!(!on(first).is_empty() && !on(member).is_empty());
    assert!(!on(first)[0].is_reply, "the first carries no link");
    assert!(on(member)[0].is_reply, "the member links to the first");
    let group = |page: u32| {
        reviews::read_page(bytes, page)
            .unwrap()
            .get(&0)
            .and_then(|link| link.group)
    };
    assert!(group(first).is_some());
    assert_eq!(group(first), group(member));
}

fn listed(state: &AppState, id: DocumentId, page: u32) -> Vec<Annotation> {
    state.list_annotations(id, PageId::new(page)).unwrap()
}

#[test]
fn a_group_is_one_step_shares_its_text_and_deletion_and_survives_a_save_and_a_reopen() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("own");
    let path = scratch.file("doc.pdf");
    std::fs::write(&path, support::fixtures::text()).unwrap();
    let id = open(state, &path);
    listed(state, id, 0);
    listed(state, id, 2);

    let made = run(state, id, group_command());
    assert_eq!(made.upserted.len(), 2);
    let key = made.upserted[0].group.clone().expect("a group key");
    assert!(made
        .upserted
        .iter()
        .all(|a| a.group.as_deref() == Some(key.as_str())));
    assert_eq!(
        made.history.undo_label.as_deref(),
        Some("annotation.create")
    );

    // The text of one member is the group's.
    let second = made
        .upserted
        .iter()
        .find(|a| a.page_id == PageId::new(2))
        .unwrap()
        .id;
    let edited = run(
        state,
        id,
        json!({"type": "updateAnnotation", "id": second.get(), "patch": {"contents": "a better thought"}}),
    );
    assert_eq!(edited.upserted.len(), 2);
    assert!(edited
        .upserted
        .iter()
        .all(|a| a.contents == "a better thought"));

    // Deleting one member deletes the group; one undo brings both back.
    let deleted = run(
        state,
        id,
        json!({"type": "deleteAnnotations", "ids": [second.get()]}),
    );
    assert_eq!(deleted.removed.len(), 2);
    let undone = state.undo(id).unwrap();
    assert_eq!(undone.upserted.len(), 2);

    state.save_in_place(id, SaveAck::default()).unwrap();
    let bytes = std::fs::read(&path).unwrap();
    assert_grouped(&bytes, 0, 2);
    let first = file_annotations(&bytes)
        .unwrap()
        .into_iter()
        .find(|a| a.page_index == 0)
        .unwrap();
    assert_eq!(
        first.quad_points.len(),
        16,
        "both ranges of page 0 are one annotation"
    );

    let copy = scratch.file("copy.pdf");
    std::fs::copy(&path, &copy).unwrap();
    let again = open(state, &copy);
    let summaries = state.list_document_annotations(again).unwrap();
    assert_eq!(summaries.len(), 2);
    let reread = summaries[0].group.clone().expect("the group is read back");
    assert_eq!(summaries[1].group.as_deref(), Some(reread.as_str()));
    assert!(summaries
        .iter()
        .all(|s| s.contents == "a better thought" && s.in_reply_to.is_none()));
    state.close_document(again).unwrap();
    state.close_document(id).unwrap();
}

/// Page 0: a highlight (100) that is the first of a group; page 1: its member (200), two underlines linked to each other (201, 202:
/// a ring), a highlight linked to an object that does not exist (203) and one linked to a popup (204, 205).
fn foreign_file() -> Vec<u8> {
    let mut builder = PdfBuilder::new();
    add_pages(
        &mut builder,
        &[
            Page::new("").with("/Annots [100 0 R]"),
            Page::new("").with("/Annots [200 0 R 201 0 R 202 0 R 203 0 R 204 0 R 205 0 R]"),
        ],
    );
    let (p0, p1) = (page_id(0), page_id(1));
    builder.object(
        100,
        &format!("<< /Type /Annot /Subtype /Highlight /Rect [72 700 172 712] /QuadPoints [72 712 172 712 72 700 172 700] /C [1 1 0] /Contents (shared) /NM (other-1) /P {p0} 0 R >>"),
    );
    let member = |rect: &str, extra: &str| {
        format!("<< /Type /Annot /Subtype /Highlight /Rect [{rect}] /QuadPoints [72 612 172 612 72 600 172 600] /C [1 1 0] {extra} /P {p1} 0 R >>")
    };
    builder.object(200, &member("72 600 172 612", "/IRT 100 0 R /RT /Group"));
    builder.object(
        201,
        &format!("<< /Type /Annot /Subtype /Underline /Rect [72 500 172 512] /QuadPoints [72 512 172 512 72 500 172 500] /C [0 0 1] /IRT 202 0 R /RT /Group /P {p1} 0 R >>"),
    );
    builder.object(
        202,
        &format!("<< /Type /Annot /Subtype /Underline /Rect [72 400 172 412] /QuadPoints [72 412 172 412 72 400 172 400] /C [0 0 1] /IRT 201 0 R /RT /Group /P {p1} 0 R >>"),
    );
    builder.object(203, &member("72 300 172 312", "/IRT 999 0 R /RT /Group"));
    builder.object(204, &member("72 200 172 212", "/IRT 205 0 R /RT /Group"));
    builder.object(205, "<< /Type /Annot /Subtype /Popup /Rect [0 0 10 10] >>");
    builder.object(1, "<< /Type /Catalog /Pages 2 0 R >>");
    builder.finish(1)
}

#[test]
fn a_group_of_another_program_is_recognised_and_broken_links_are_no_group() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("foreign");
    let path = scratch.file("foreign.pdf");
    std::fs::write(&path, foreign_file()).unwrap();
    let id = open(state, &path);
    // The member's page first: the first's page has not been read yet, the key is the same anyway.
    let second = listed(state, id, 1);
    let first = listed(state, id, 0);
    assert_eq!(second.len(), 5, "{second:?}");
    let key = first[0].group.clone().expect("the first is in the group");
    assert_eq!(second[0].group.as_deref(), Some(key.as_str()));
    assert!(
        second[1..]
            .iter()
            .all(|a| a.group.is_none() && a.in_reply_to.is_none()),
        "{second:?}"
    );

    // A change to the member writes the group again with the standard links.
    run(
        state,
        id,
        json!({"type": "updateAnnotation", "id": second[0].id.get(), "patch": {"contents": "edited"}}),
    );
    assert_eq!(listed(state, id, 0)[0].contents, "edited");
    state.save_in_place(id, SaveAck::default()).unwrap();
    assert_grouped(&std::fs::read(&path).unwrap(), 0, 1);
    state.close_document(id).unwrap();
}
