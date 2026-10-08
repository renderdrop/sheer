//! F19.1 (ADR-141): comments made by other programs are read into the model as regular, editable comments through the real PDFium, and
//! survive a save and a reopen. The fixtures are generated here and mimic what Acrobat writes (page 1) and what Foxit/Okular-style
//! writers write (page 2: counterclockwise quad corners, other date spellings, no author, `/RT /Group`). Skips when the library is not fetched.

#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde_json::{json, Value};
use sheer_lib::commands::save::SaveAck;
use sheer_lib::commands::AppState;
use sheer_lib::documents::{DocumentId, PageId};
use sheer_lib::engine::{self, Engine};
use sheer_lib::model::annotation::{
    Annotation, AnnotationBody, NoteIcon, ReviewState, Rgb, Sync, TextAlign,
};
use sheer_lib::model::command::DocCommand;
use sheer_lib::model::geometry::Point;
use sheer_lib::pdfwrite::inspect::list_annotations as file_annotations;
use support::fixtures::{add_pages, page_id, Page};
use support::PdfBuilder;

struct Scratch(PathBuf);

impl Scratch {
    fn new(name: &str) -> Self {
        let path =
            std::env::temp_dir().join(format!("sheer-foreign-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
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

/// Page 1 as Acrobat writes it (objects 100..), page 2 as Foxit/Okular-style writers do (objects 200..).
fn foreign_file() -> Vec<u8> {
    let mut builder = PdfBuilder::new();
    let first: Vec<String> = (100..=113).map(|n| format!("{n} 0 R")).collect();
    let second: Vec<String> = (200..=203).map(|n| format!("{n} 0 R")).collect();
    add_pages(
        &mut builder,
        &[
            Page::new("").with(&format!("/Annots [{}]", first.join(" "))),
            Page::new("").with(&format!("/Annots [{}]", second.join(" "))),
        ],
    );
    let (p0, p1) = (page_id(0), page_id(1));
    let acrobat = [
        // 100: a highlight with a comment, a popup (101) and an Acrobat date with an offset.
        r"/Subtype /Highlight /Rect [72 700 172 712] /QuadPoints [72 712 172 712 72 700 172 700] /C [1 0.92 0] /CA 0.5 /Contents (Check this) /T (Alice) /Subj (Highlight) /M (D:20261007101500+02'00') /CreationDate (D:20261007101000+02'00') /NM (acro-1) /F 4 /Popup 101 0 R",
        r"/Subtype /Popup /Rect [200 600 400 700] /Parent 100 0 R /Open false",
        // 102: a reply with /RT /R and an icon, 103: a note with a Help icon, 104: a review state on it.
        r"/Subtype /Text /Rect [172 712 192 732] /Name /Comment /Contents (Agreed) /T (Bob) /IRT 100 0 R /RT /R /M (D:20261007111500Z) /NM (acro-2) /F 28",
        r"/Subtype /Text /Rect [400 700 420 720] /Name /Help /Contents (Question) /T (Alice) /M (D:20261007120000Z) /C [1 1 0] /F 28",
        r"/Subtype /Text /Rect [400 700 420 720] /Contents (Accepted set by Bob) /T (Bob) /IRT 103 0 R /RT /R /StateModel (Review) /State (Accepted) /M (D:20261007130000Z) /F 28",
        // 105: a free text with carriage returns, /DA, /Q and a background.
        r"/Subtype /FreeText /Rect [72 600 272 640] /Contents (Line one\rLine two) /DA (/Helv 14 Tf 1 0 0 rg) /Q 1 /C [1 1 0.8] /BS << /W 2 /S /S >> /T (Alice) /M (D:20261007140000Z)",
        // 106: a dashed square with an interior colour and opacity.
        r"/Subtype /Square /Rect [72 500 172 560] /C [0 0 1] /IC [1 0.5 0] /BS << /W 3 /S /D /D [3] >> /CA 0.4 /Contents (box) /T (Alice)",
        // 107: an ink with a width and a text.
        r"/Subtype /Ink /Rect [296 496 384 544] /InkList [[300 500 340 540 380 500]] /BS << /W 4 >> /C [1 0 1] /Contents (scribble) /T (Alice)",
        // 108..111: kinds with no model type of their own, or only a close one.
        r"/Subtype /Squiggly /Rect [72 400 172 412] /QuadPoints [72 412 172 412 72 400 172 400] /C [0 0.5 0] /Contents (typo) /T (Cy)",
        r"/Subtype /Polygon /Rect [72 300 172 360] /Vertices [72 300 172 300 122 360] /C [1 0 0] /Contents (poly text) /T (Cy)",
        r"/Subtype /Caret /Rect [72 250 82 262] /Contents (insert here) /T (Cy) /Sy /P",
        r"/Subtype /Stamp /Rect [72 150 172 190] /Name /Approved /Contents (stamp text) /T (Dan)",
        // 112: a line with an arrow end; 113: a free text with only rich text.
        r"/Subtype /Line /Rect [250 150 350 190] /L [260 160 340 180] /LE [/None /OpenArrow] /BS << /W 2 >> /C [0 0 0] /Contents (arrow text) /T (Alice)",
        r#"/Subtype /FreeText /Rect [72 90 272 130] /Contents () /RC (<?xml version="1.0"?><body xmlns="http://www.w3.org/1999/xhtml"><p dir="ltr"><span style="font-size:12pt">from &amp; rich</span></p></body>) /DA (/Helv 12 Tf 0 g) /T (Alice)"#,
    ];
    for (n, body) in (100u32..).zip(acrobat) {
        builder.object(n, &format!("<< /Type /Annot {body} /P {p0} 0 R >>"));
    }
    let other = [
        // 200: counterclockwise corners, no author, no /Contents, a Foxit date.
        r"/Subtype /Highlight /Rect [72 700 172 712] /QuadPoints [72 700 172 700 172 712 72 712] /C [0.5 1 0.5] /M (D:20261008090000Z00'00') /NM (fx-1)",
        // 201: a note by a viewer with its own icon name and ISO date, 202: its reply in a group.
        r"/Subtype /Text /Rect [300 700 320 720] /Name /Key /Contents (viewer note) /T (Okular user) /CreationDate (2026-10-08T09:30:00+02:00) /NM (fx-2)",
        r"/Subtype /Text /Rect [300 700 320 720] /Contents (group member) /T (Eve) /IRT 201 0 R /RT /Group /M (20261008100000)",
        // 203: a popup without its parent.
        r"/Subtype /Popup /Rect [0 0 10 10]",
    ];
    for (n, body) in (200u32..).zip(other) {
        builder.object(n, &format!("<< /Type /Annot {body} /P {p1} 0 R >>"));
    }
    builder.object(1, "<< /Type /Catalog /Pages 2 0 R >>");
    builder.finish(1)
}

fn open(state: &AppState, path: &Path) -> DocumentId {
    state
        .open_path(path.to_owned())
        .unwrap()
        .expect("loaded")
        .id
}

fn kind(annotation: &Annotation) -> String {
    serde_json::to_value(annotation).unwrap()["kind"]
        .as_str()
        .unwrap()
        .to_owned()
}

fn run(state: &AppState, id: DocumentId, value: Value) -> Vec<Annotation> {
    let command: DocCommand = serde_json::from_value(value).unwrap();
    state.apply_command(id, command).unwrap().upserted
}

fn subtypes(path: &Path) -> BTreeMap<String, usize> {
    let mut counts = BTreeMap::new();
    for entry in file_annotations(&std::fs::read(path).unwrap()).unwrap() {
        *counts.entry(entry.subtype).or_insert(0) += 1;
    }
    counts
}

#[test]
fn comments_of_acrobat_and_other_programs_are_adopted_as_regular_comments() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("adopt");
    let path = scratch.0.join("foreign.pdf");
    std::fs::write(&path, foreign_file()).unwrap();
    let id = open(state, &path);

    let page = state.list_annotations(id, PageId::new(0)).unwrap();
    let kinds: Vec<String> = page.iter().map(kind).collect();
    assert_eq!(
        kinds,
        [
            "highlight", "note", "note", "note", "freeText", "rect", "ink", "underline", "opaque",
            "opaque", "opaque", "line", "freeText"
        ],
        "popups are not comments; the squiggly line is an underline; polygon, caret and stamp stay listed"
    );
    assert!(page.iter().all(|a| a.sync == Sync::Clean));

    // The highlight: text, author, date in UTC, colour, opacity, quad.
    let highlight = &page[0];
    assert_eq!(highlight.contents, "Check this");
    assert_eq!(highlight.author.as_deref(), Some("Alice"));
    assert_eq!(highlight.modified.as_deref(), Some("2026-10-07T08:15:00Z"));
    assert_eq!(highlight.color, Rgb([255, 235, 0]));
    assert_eq!(highlight.opacity, 0.5);
    let AnnotationBody::Highlight { quads } = &highlight.body else {
        panic!("not a highlight")
    };
    assert_eq!(quads[0][0], Point { x: 72.0, y: 80.0 });

    // The reply: threaded under the highlight, with its icon; the review state sits on the question.
    let reply = &page[1];
    assert_eq!(reply.in_reply_to, Some(highlight.id));
    assert_eq!(
        (reply.contents.as_str(), reply.author.as_deref()),
        ("Agreed", Some("Bob"))
    );
    assert!(matches!(
        reply.body,
        AnnotationBody::Note {
            icon: NoteIcon::Comment,
            ..
        }
    ));
    assert!(matches!(
        page[2].body,
        AnnotationBody::Note {
            icon: NoteIcon::Help,
            ..
        }
    ));
    assert_eq!(page[2].color, Rgb([255, 255, 0]));
    assert_eq!(page[3].in_reply_to, Some(page[2].id));
    assert_eq!(page[3].state, Some(ReviewState::Accepted));

    // The free text: line breaks from carriage returns, size, colour, alignment, background, border.
    let AnnotationBody::FreeText {
        lines,
        font_size,
        fill,
        border_width,
        align,
        ..
    } = &page[4].body
    else {
        panic!("not a free text")
    };
    assert_eq!(lines, &["Line one", "Line two"]);
    assert_eq!(
        (*font_size, *border_width, *align),
        (14.0, 2.0, TextAlign::Center)
    );
    assert_eq!(*fill, Some(Rgb([255, 255, 204])));
    assert_eq!(page[4].color, Rgb([255, 0, 0]));

    // The square: width, dash, interior, opacity, colour.
    let AnnotationBody::Rect {
        width,
        fill,
        dashed,
        ..
    } = &page[5].body
    else {
        panic!("not a square")
    };
    assert_eq!(
        (*width, *dashed, *fill),
        (3.0, true, Some(Rgb([255, 128, 0])))
    );
    assert_eq!((page[5].opacity, page[5].color), (0.4, Rgb([0, 0, 255])));

    // The ink: one stroke of three points, y turned, with the width.
    let AnnotationBody::Ink { strokes, width } = &page[6].body else {
        panic!("not an ink")
    };
    assert_eq!(
        (*width, strokes.len(), strokes[0].points.len()),
        (4.0, 1, 3)
    );
    assert_eq!(strokes[0].points[0], Point { x: 300.0, y: 292.0 });
    assert_eq!(page[6].color, Rgb([255, 0, 255]));

    // Whatever has no model kind keeps its text and author.
    for (annotation, text, author) in [
        (&page[7], "typo", "Cy"),
        (&page[8], "poly text", "Cy"),
        (&page[9], "insert here", "Cy"),
        (&page[10], "stamp text", "Dan"),
        (&page[11], "arrow text", "Alice"),
    ] {
        assert_eq!(annotation.contents, text);
        assert_eq!(annotation.author.as_deref(), Some(author));
    }
    assert!(matches!(
        &page[11].body,
        AnnotationBody::Line { head, .. } if *head == sheer_lib::model::annotation::LineEnd::OpenArrow
    ));
    let AnnotationBody::FreeText { lines, .. } = &page[12].body else {
        panic!("not a free text")
    };
    assert_eq!(lines, &["from & rich"]);
    assert_eq!(page[12].contents, "from & rich");

    // Page 2: counterclockwise corners come out in the model's order; dates in other spellings; a group member is threaded.
    let other = state.list_annotations(id, PageId::new(1)).unwrap();
    assert_eq!(
        other.len(),
        3,
        "the popup without a parent is not a comment"
    );
    let AnnotationBody::Highlight { quads } = &other[0].body else {
        panic!("not a highlight")
    };
    assert_eq!(
        quads[0],
        [
            Point { x: 72.0, y: 80.0 },
            Point { x: 172.0, y: 80.0 },
            Point { x: 72.0, y: 92.0 },
            Point { x: 172.0, y: 92.0 }
        ]
    );
    assert_eq!(other[0].modified.as_deref(), Some("2026-10-08T09:00:00Z"));
    assert_eq!(other[1].modified.as_deref(), Some("2026-10-08T07:30:00Z"));
    assert_eq!(other[2].modified.as_deref(), Some("2026-10-08T10:00:00Z"));
    assert_eq!(other[2].in_reply_to, Some(other[1].id));
    assert!(matches!(
        other[1].body,
        AnnotationBody::Note {
            icon: NoteIcon::Note,
            ..
        }
    ));

    // The panel lists every one of them once, replies threaded, and no popups.
    let summaries = state.list_document_annotations(id).unwrap();
    assert_eq!(summaries.len(), 16);
    assert!(summaries.iter().all(|s| !s.kind.is_empty()));
    assert_eq!(
        summaries.iter().filter(|s| s.in_reply_to.is_some()).count(),
        3
    );
    state.close_document(id).unwrap();
}

#[test]
fn edited_foreign_comments_are_saved_back_without_loss_or_duplicate_popups() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("roundtrip");
    let path = scratch.0.join("foreign.pdf");
    std::fs::write(&path, foreign_file()).unwrap();
    let before = subtypes(&path);
    assert_eq!(before.get("Popup"), Some(&2));
    let id = open(state, &path);
    let page = state.list_annotations(id, PageId::new(0)).unwrap();

    // Edit the reply's text, restyle the highlight, move the ink and the polygon's neighbours, reword the free text.
    run(
        state,
        id,
        json!({"type": "updateAnnotation", "id": page[1].id, "patch": {"contents": "edited reply"}}),
    );
    run(
        state,
        id,
        json!({"type": "updateAnnotation", "id": page[0].id, "patch": {"color": [10, 200, 10]}}),
    );
    run(
        state,
        id,
        json!({"type": "moveAnnotations", "ids": [page[6].id], "dx": 10.0, "dy": 5.0}),
    );
    run(
        state,
        id,
        json!({"type": "updateAnnotation", "id": page[4].id, "patch": {"lines": ["Changed", "text"]}}),
    );
    // A new reply to a foreign comment.
    run(
        state,
        id,
        json!({"type": "createAnnotation", "draft": {"pageId": 0, "kind": "note", "color": [255, 235, 0],
            "at": {"x": 450.0, "y": 80.0}, "icon": "note", "contents": "my answer", "inReplyTo": page[0].id}}),
    );
    state.save_in_place(id, SaveAck::default()).unwrap();
    state.close_document(id).unwrap();

    let after = subtypes(&path);
    let mut expected = before.clone();
    *expected.entry("Text".into()).or_insert(0) += 1;
    // The file keeps every annotation; a rewritten highlight keeps at most the popup it had, never a second one.
    let popups = after.get("Popup").copied().unwrap_or(0);
    assert!(popups <= 2, "popups after the save: {popups}");
    expected.remove("Popup");
    let mut got = after.clone();
    got.remove("Popup");
    expected.remove("Popup");
    assert_eq!(got, expected, "no annotation is lost or doubled");

    // Reopened: the same comments, the edits, the thread.
    let id = open(state, &path);
    let page = state.list_annotations(id, PageId::new(0)).unwrap();
    assert_eq!(page.len(), 14);
    let highlight = page.iter().find(|a| a.contents == "Check this").unwrap();
    assert_eq!(highlight.color, Rgb([10, 200, 10]));
    assert_eq!(highlight.author.as_deref(), Some("Alice"));
    let reply = page.iter().find(|a| a.contents == "edited reply").unwrap();
    assert_eq!(reply.in_reply_to, Some(highlight.id));
    assert_eq!(reply.author.as_deref(), Some("Bob"));
    let mine = page.iter().find(|a| a.contents == "my answer").unwrap();
    assert_eq!(mine.in_reply_to, Some(highlight.id));
    let accepted = page
        .iter()
        .find(|a| a.contents == "Accepted set by Bob")
        .unwrap();
    assert_eq!(accepted.state, Some(ReviewState::Accepted));
    assert!(accepted.in_reply_to.is_some());
    let AnnotationBody::FreeText { lines, align, .. } =
        &page.iter().find(|a| kind(a) == "freeText").unwrap().body
    else {
        panic!()
    };
    assert_eq!(lines, &["Changed", "text"]);
    assert_eq!(*align, TextAlign::Center);
    let ink = page.iter().find(|a| kind(a) == "ink").unwrap();
    let AnnotationBody::Ink { strokes, .. } = &ink.body else {
        panic!()
    };
    assert_eq!(strokes[0].points.len(), 3);
    assert!((strokes[0].points[0].x - 310.0).abs() < 0.1);
    // What was never touched is as it was: kind, text and author of the opaque ones.
    for (text, author) in [
        ("poly text", "Cy"),
        ("insert here", "Cy"),
        ("stamp text", "Dan"),
    ] {
        let found = page.iter().find(|a| a.contents == text).unwrap();
        assert_eq!(kind(found), "opaque");
        assert_eq!(found.author.as_deref(), Some(author));
    }
    state.close_document(id).unwrap();
}

/// Ink and squiggly points land where the engine puts the page: a cropped page measures from the crop box's top left, and `/Rotate`
/// does not change page space (it is applied on display).
#[test]
fn ink_and_squiggly_points_follow_the_crop_box_and_ignore_rotate() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("rotated");
    let path = scratch.0.join("rotated.pdf");
    let mut builder = PdfBuilder::new();
    add_pages(
        &mut builder,
        &[Page::new("").with("/Rotate 90 /CropBox [100 100 500 700] /Annots [100 0 R 101 0 R]")],
    );
    let p0 = page_id(0);
    builder.object(100, &format!("<< /Type /Annot /Subtype /Ink /Rect [140 290 210 340] /InkList [[150 300 200 330]] /BS << /W 2 >> /C [1 0 0] /P {p0} 0 R >>"));
    builder.object(101, &format!("<< /Type /Annot /Subtype /Squiggly /Rect [150 400 250 412] /QuadPoints [150 412 250 412 150 400 250 400] /C [0 0.5 0] /P {p0} 0 R >>"));
    builder.object(1, "<< /Type /Catalog /Pages 2 0 R >>");
    std::fs::write(&path, builder.finish(1)).unwrap();
    let id = open(state, &path);
    let page = state.list_annotations(id, PageId::new(0)).unwrap();
    let AnnotationBody::Ink { strokes, .. } = &page[0].body else {
        panic!("not an ink")
    };
    // The crop box's top edge is y = 700: (150, 300) is (50, 400) on the page.
    assert_eq!(strokes[0].points[0], Point { x: 50.0, y: 400.0 });
    assert_eq!(strokes[0].points[1], Point { x: 100.0, y: 370.0 });
    let AnnotationBody::Underline { quads } = &page[1].body else {
        panic!("not an underline")
    };
    assert_eq!(quads[0][0], Point { x: 50.0, y: 288.0 });
    assert_eq!(quads[0][3], Point { x: 150.0, y: 300.0 });
    state.close_document(id).unwrap();
}

/// The owner's own file with comments from another program (ID `owner-pdf-E1`, `review/owner/INDEX.md`): it may be damaged. Opening and
/// listing must never fail; what was adopted is counted by kind, never named. Skips without the index or the library.
#[test]
fn the_owner_sample_opens_and_lists_without_failing() {
    let Some(state) = state() else { return };
    let Some(file) = support::corpus::file("owner-pdf-E1") else {
        return;
    };
    let Ok(Some(info)) = state.open_path(file) else {
        eprintln!("owner-pdf-E1: does not open (allowed: the file may be damaged)");
        return;
    };
    let summaries = state.list_document_annotations(info.id).unwrap();
    let mut by_kind: BTreeMap<&str, usize> = BTreeMap::new();
    for summary in &summaries {
        *by_kind.entry(summary.kind).or_insert(0) += 1;
    }
    eprintln!(
        "owner-pdf-E1: {} comments by kind {by_kind:?}",
        summaries.len()
    );
    state.close_document(info.id).unwrap();
}
