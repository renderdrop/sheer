//! The read APIs of the backend (outline, text layer, search, links, document flags) against real PDFs and the real PDFium, through the
//! same `AppState` that the Tauri commands call. The PDFs are the fixtures of `tests/support/fixtures.rs` (the committed ones under
//! `tests/fixtures/`, and the generators for the sizes that do not belong in a repository: a deep and a wide outline, a page with more
//! text than a layer holds, a page of 1 500 links). The unit tests of the command modules cover the same commands with an engine that
//! is a double, which is where the bounds and the cancellation are pinned down; these tests show that what PDFium really says becomes
//! what the commands promise.
//!
//! PDFium can be bound once per process, so all tests share one `AppState`; they skip, like the engine tests, when the library has
//! not been fetched (`npm run fetch-pdfium`).

// Test code: panicking on a broken fixture is the point (clippy.toml only exempts `#[test]` functions, not helpers).
#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use sheer_lib::commands::links::LinkUi;
use sheer_lib::commands::AppState;
use sheer_lib::documents::{DocumentId, DocumentInfo, PageId};
use sheer_lib::engine::{self, Engine};
use sheer_lib::error::{AppError, ErrorCode};
use sheer_lib::limits;
use sheer_lib::model::geometry::Quad;
use sheer_lib::model::reading::{LinkTarget, OutlineNode, SearchEvent, SearchQuery, TextLayer};
use sheer_lib::security::links::SafeUrl;
use support::{fixtures, TempFile};

/// The one state of the process. `None` when the PDFium library has not been fetched.
fn state() -> Option<&'static AppState> {
    static STATE: OnceLock<Option<AppState>> = OnceLock::new();
    STATE
        .get_or_init(|| {
            let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("pdfium");
            let library = engine::library_path(&root);
            if library.is_file() {
                Some(AppState::new(Engine::start(library)))
            } else {
                eprintln!("skipping read API test: {} not found", library.display());
                None
            }
        })
        .as_ref()
}

fn fixture_path(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("tests")
        .join("fixtures")
        .join(name)
}

/// Opens a committed fixture. A file that is open already answers with the id it has, and one that another test is still loading
/// answers `None` (that request reports it), so this waits for the other one to be done.
fn open(state: &AppState, name: &str) -> DocumentInfo {
    for _ in 0..500 {
        if let Some(info) = state.open_path(fixture_path(name)).unwrap() {
            return info;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    panic!("{name} was never loaded");
}

/// A generated document in a temporary file, closed (and the file removed) when dropped.
struct Generated<'a> {
    state: &'a AppState,
    info: DocumentInfo,
    _file: TempFile,
}

impl<'a> Generated<'a> {
    fn new(state: &'a AppState, name: &str, bytes: &[u8]) -> Self {
        let file = TempFile::write(name, bytes);
        let info = state.open_path(file.0.clone()).unwrap().expect("loaded");
        Self {
            state,
            info,
            _file: file,
        }
    }

    fn id(&self) -> DocumentId {
        self.info.id
    }
}

impl Drop for Generated<'_> {
    fn drop(&mut self) {
        // The file can only be removed once PDFium has let go of it.
        let _ = self.state.close_document(self.info.id);
    }
}

fn page(index: u32) -> PageId {
    PageId::new(index)
}

fn assert_near(actual: f32, expected: f32, what: &str) {
    assert!(
        (actual - expected).abs() < 0.1,
        "{what}: {actual} is not {expected}"
    );
}

// --- document flags -------------------------------------------------------------------------------------------------

#[test]
fn the_flags_of_a_document_say_what_pdfium_found_in_it() {
    let Some(state) = state() else { return };
    let flags = |name: &str| {
        let flags = open(state, name).flags;
        (flags.encrypted, flags.xfa, flags.has_forms, flags.signed)
    };
    assert_eq!(flags("outline.pdf"), (false, false, false, false));
    assert_eq!(flags("form.pdf"), (false, false, true, false));
    assert_eq!(flags("xfa.pdf"), (false, true, true, false));
    assert_eq!(flags("signed.pdf"), (false, false, true, true));
    assert_eq!(flags("encrypted.pdf"), (true, false, false, false));
}

#[test]
fn the_flags_are_part_of_what_the_ui_is_told_about_a_document() {
    let Some(state) = state() else { return };
    let info = open(state, "signed.pdf");
    let wire = serde_json::to_value(&info).unwrap();
    assert_eq!(
        wire["flags"],
        serde_json::json!({ "encrypted": false, "xfa": false, "hasForms": true, "signed": true })
    );
    // A document that is asked for again keeps its flags.
    assert_eq!(open(state, "signed.pdf").flags, info.flags);
}

#[test]
fn an_encrypted_document_with_an_empty_password_opens_and_reads() {
    // Also shows that the encrypted fixture is encrypted correctly: its content stream only reads if the key is right.
    let Some(state) = state() else { return };
    let info = open(state, "encrypted.pdf");
    let layer = state.text_layer(info.id, page(0)).unwrap();
    assert_eq!(layer.text, "Secret page");
}

// --- outline --------------------------------------------------------------------------------------------------------

/// A node as a test compares it: the title, the target as (page, y) and the number of children.
type Shape = (String, Option<(u32, f32)>, usize);

fn shape(nodes: &[OutlineNode]) -> Vec<Shape> {
    nodes
        .iter()
        .map(|node| {
            let target = node.target.map(|target| {
                let id = serde_json::to_value(target.page_id)
                    .unwrap()
                    .as_u64()
                    .unwrap();
                (u32::try_from(id).unwrap(), target.y)
            });
            (node.title.clone(), target, node.children.len())
        })
        .collect()
}

fn count(nodes: &[OutlineNode]) -> usize {
    nodes.iter().map(|node| 1 + count(&node.children)).sum()
}

fn depth(nodes: &[OutlineNode]) -> usize {
    nodes
        .iter()
        .map(|node| 1 + depth(&node.children))
        .max()
        .unwrap_or(0)
}

#[test]
fn the_outline_has_the_titles_the_targets_and_the_nesting_of_the_file() {
    let Some(state) = state() else { return };
    let outline = state.outline(open(state, "outline.pdf").id).unwrap();
    let long = "A".repeat(limits::MAX_OUTLINE_TITLE_CHARS);
    assert_eq!(
        shape(&outline),
        [
            ("Chapter 1".to_owned(), Some((0, 92.0)), 2),
            // From an action and not a /Dest, with a title in UTF-16 and non-ASCII letters.
            (
                "\u{dc}bersicht \u{2013} Gr\u{f6}\u{df}e".to_owned(),
                Some((1, 392.0)),
                0
            ),
            // A URI action, a jump into another file, a destination that is no page: none of them goes to a page of this document.
            ("Website".to_owned(), None, 0),
            ("Other file".to_owned(), None, 0),
            ("Not a page".to_owned(), None, 0),
            // A line break is a space, and the direction override is gone.
            ("Line break".to_owned(), None, 0),
            (long, None, 0),
            ("No destination".to_owned(), None, 0),
            // /Fit has no position: the top of the page.
            ("Fit".to_owned(), Some((2, 0.0)), 0),
        ]
    );
    assert_eq!(
        shape(&outline[0].children),
        [
            // Heights: the top of the page is 792, so y = 500 in user space is 292 from the top.
            ("Section 1.1".to_owned(), Some((1, 292.0)), 0),
            // Page 3 has a crop box from (36, 36) to (576, 756): its top is 756, so y = 600 is 156 from the top of the page.
            ("Section 1.2".to_owned(), Some((2, 156.0)), 0),
        ]
    );
}

#[test]
fn an_outline_that_is_a_cycle_ends() {
    let Some(state) = state() else { return };
    let outline = state.outline(open(state, "outline-cycle.pdf").id).unwrap();
    // C's /Next is A (an earlier sibling), A.1's /First is A (its own parent) and its /Next is itself: all four are read, once.
    assert_eq!(
        shape(&outline),
        [
            ("A".to_owned(), Some((0, 0.0)), 1),
            ("B".to_owned(), Some((1, 0.0)), 0),
            ("C".to_owned(), Some((0, 0.0)), 0),
        ]
    );
    assert_eq!(
        shape(&outline[0].children),
        [("A.1".to_owned(), Some((1, 0.0)), 0)]
    );
    assert_eq!(count(&outline), 4);
}

#[test]
fn a_document_without_an_outline_has_an_empty_one() {
    let Some(state) = state() else { return };
    let info = state
        .open_path(fixture_path("minimal.pdf"))
        .unwrap()
        .unwrap();
    assert!(state.outline(info.id).unwrap().is_empty());
}

#[test]
fn an_outline_deeper_than_32_levels_is_cut_at_the_32nd() {
    let Some(state) = state() else { return };
    let ladder = Generated::new(state, "deep.pdf", &fixtures::deep_outline(100));
    let outline = state.outline(ladder.id()).unwrap();
    assert_eq!(depth(&outline), limits::MAX_OUTLINE_DEPTH);
    assert_eq!(outline[0].title, "Level 1");
}

#[test]
fn an_outline_of_more_than_10_000_nodes_is_cut_at_10_000() {
    let Some(state) = state() else { return };
    let wide = Generated::new(state, "wide.pdf", &fixtures::wide_outline(10_500));
    let outline = state.outline(wide.id()).unwrap();
    assert_eq!(count(&outline), limits::MAX_OUTLINE_NODES);
    assert_eq!(outline[0].title, "Item 1");
    assert_eq!(outline.last().unwrap().title, "Item 10000");
}

// --- links ----------------------------------------------------------------------------------------------------------

/// What a link of `links.pdf` page 1 goes to, in short: `url:..`, `page:index,y` or `blocked`.
fn kind(target: &LinkTarget) -> String {
    match target {
        LinkTarget::Url { url } => format!("url:{url}"),
        LinkTarget::Page { page_id, y } => {
            let id = serde_json::to_value(page_id).unwrap().as_u64().unwrap();
            format!("page:{id},{y}")
        }
        LinkTarget::Blocked => "blocked".to_owned(),
    }
}

#[test]
fn every_kind_of_link_is_a_page_a_url_the_app_opens_or_blocked() {
    let Some(state) = state() else { return };
    let id = open(state, "links.pdf").id;
    let links = state.page_links(id, page(0)).unwrap();
    let kinds: Vec<String> = links.iter().map(|link| kind(&link.target)).collect();
    assert_eq!(
        kinds,
        [
            "url:https://example.com/docs",
            "url:mailto:team@example.com?subject=Hello",
            "blocked",    // file:
            "blocked",    // javascript: as a URI
            "blocked",    // a JavaScript action
            "blocked",    // Launch
            "blocked",    // GoToR, a jump into another file
            "page:2,100", // GoTo, page 3 (crop box top 700) at user y = 600
            "page:1,0",   // /Dest [page 2 /Fit]
            "page:1,492", // GoTo a named destination: FitH 300 on page 2
            "blocked",    // a URL with a space
            "url:HTTP://EXAMPLE.COM/UP",
            "blocked", // a destination that is no page
            "blocked", // credentials in front of the host
        ]
    );
    // The text annotation between the links is not one, and no link is listed twice: the indices are 0..14 in order.
    assert_eq!(
        links.iter().map(|link| link.index).collect::<Vec<_>>(),
        (0..14).collect::<Vec<_>>()
    );
    // The first link is at user space [72, 700, 272, 720] on a page 792 high.
    let rect = links[0].rect;
    assert_eq!((rect.x, rect.y, rect.w, rect.h), (72.0, 72.0, 200.0, 20.0));
    // Pages without links have none.
    assert!(state.page_links(id, page(1)).unwrap().is_empty());
}

#[test]
fn a_page_with_more_than_1000_links_lists_the_first_1000() {
    let Some(state) = state() else { return };
    let many = Generated::new(state, "links.pdf", &fixtures::many_links(1_500));
    let links = state.page_links(many.id(), page(0)).unwrap();
    assert_eq!(links.len(), limits::MAX_PAGE_LINKS);
    assert_eq!(
        kind(&links[0].target),
        "url:https://example.com/0".to_owned()
    );
    assert_eq!(
        kind(&links[999].target),
        "url:https://example.com/999".to_owned()
    );
    assert_eq!(links[999].index, 999);
}

#[test]
fn a_url_of_2048_bytes_is_a_url_and_one_byte_more_is_blocked() {
    let Some(state) = state() else { return };
    let prefix = "https://example.com/";
    for (extra, expected_url) in [(0usize, true), (1, false)] {
        let url = format!(
            "{prefix}{}",
            "a".repeat(limits::MAX_URL_LEN - prefix.len() + extra)
        );
        let doc = Generated::new(state, "long-url.pdf", &fixtures::one_link(&url));
        let links = state.page_links(doc.id(), page(0)).unwrap();
        assert_eq!(links.len(), 1);
        match &links[0].target {
            LinkTarget::Url { url: seen } => {
                assert!(expected_url, "{} bytes were accepted", url.len());
                assert_eq!(seen, &url);
            }
            LinkTarget::Blocked => assert!(!expected_url, "{} bytes were refused", url.len()),
            other => panic!("{other:?}"),
        }
    }
}

/// A dialog and an opener that write down what they were asked to do.
struct RecordingUi {
    agree: bool,
    shown: Mutex<Vec<String>>,
    opened: Mutex<Vec<String>>,
}

impl LinkUi for RecordingUi {
    fn confirm(&self, url: &SafeUrl) -> bool {
        self.shown.lock().unwrap().push(url.as_str().to_owned());
        self.agree
    }

    fn open(&self, url: &SafeUrl) -> Result<(), AppError> {
        self.opened.lock().unwrap().push(url.as_str().to_owned());
        Ok(())
    }
}

#[test]
fn only_a_url_link_is_opened_and_only_after_the_user_confirmed_the_url_the_document_has() {
    let Some(state) = state() else { return };
    let id = open(state, "links.pdf").id;
    let ui = RecordingUi {
        agree: true,
        shown: Mutex::default(),
        opened: Mutex::default(),
    };

    // The three that go somewhere the app does not (a program, a script, a file), a page, and one that is not there: refused, and
    // the user is not even asked.
    for index in [2, 3, 4, 5, 6, 7, 8, 10, 12, 13, 14, 1_000] {
        let error = state.open_link(id, page(0), index, &ui).unwrap_err();
        assert_eq!(error.code(), ErrorCode::InvalidArgument, "link {index}");
    }
    assert!(ui.shown.lock().unwrap().is_empty());
    assert!(ui.opened.lock().unwrap().is_empty());

    for (index, expected) in [
        (0, "https://example.com/docs"),
        (1, "mailto:team@example.com?subject=Hello"),
        (11, "HTTP://EXAMPLE.COM/UP"),
    ] {
        state.open_link(id, page(0), index, &ui).unwrap();
        assert_eq!(ui.shown.lock().unwrap().last().unwrap(), expected);
        assert_eq!(ui.opened.lock().unwrap().last().unwrap(), expected);
    }
    assert_eq!(ui.opened.lock().unwrap().len(), 3);

    let declining = RecordingUi {
        agree: false,
        shown: Mutex::default(),
        opened: Mutex::default(),
    };
    state.open_link(id, page(0), 0, &declining).unwrap();
    assert_eq!(declining.shown.lock().unwrap().len(), 1);
    assert!(declining.opened.lock().unwrap().is_empty());
}

// --- the text layer -------------------------------------------------------------------------------------------------

fn units(text: &str) -> usize {
    text.encode_utf16().count()
}

#[test]
fn the_text_layer_has_the_text_and_a_box_for_every_character_in_page_space() {
    let Some(state) = state() else { return };
    let id = open(state, "text.pdf").id;
    let layer = state.text_layer(id, page(0)).unwrap();
    assert_eq!(
        layer.text,
        "Gr\u{fc}\u{df}e aus M\u{fc}nchen\r\nCaf\u{e9} Cr\u{e8}me \u{2013} na\u{ef}ve fa\u{e7}ade \u{20ac} 5\r\n\
         The quick brown fox jumps over the lazy dog.\r\nA word that is hyphenated across two lines.\r\n\
         Repeat repeat REPEAT Repeated.\r\nThe stra\u{df}e ends here."
    );
    assert!(!layer.truncated);
    assert_eq!(layer.boxes.len(), 4 * units(&layer.text));

    // "G" of the first line: Helvetica 14 pt at x = 72, baseline y = 700 on a page 792 high. The box is the font's: about 15.6 pt
    // high, from about 12.7 pt below the baseline... in page space (y down) it starts at 792 - 712.67 = 79.33.
    let first = &layer.boxes[..4];
    assert_near(first[0], 72.0, "x of the first character");
    assert_near(first[1], 79.33, "y of the first character");
    assert!(first[2] > 5.0 && first[2] < 15.0, "width {}", first[2]);
    assert_near(first[3], 15.62, "height of the first character");

    // Every box is a number inside the page, and a character that is not a line break has an area.
    for (index, (c, rect)) in layer.text.chars().zip(layer.boxes.chunks(4)).enumerate() {
        assert!(
            rect.iter().all(|value| value.is_finite()),
            "box {index} of {c:?}: {rect:?}"
        );
        assert!(
            rect[0] >= 0.0 && rect[0] + rect[2] <= 612.0,
            "{c:?} {rect:?}"
        );
        assert!(
            rect[1] >= 0.0 && rect[1] + rect[3] <= 792.0,
            "{c:?} {rect:?}"
        );
        if c != '\r' && c != '\n' {
            assert!(rect[2] > 0.0 && rect[3] > 0.0, "{c:?} {rect:?}");
        }
    }
}

#[test]
fn text_of_a_rotated_page_is_in_unrotated_page_space() {
    let Some(state) = state() else { return };
    let id = open(state, "text.pdf").id;
    // Page 2 has /Rotate 90 and "Turned page" at (72, 700) in user space: page space is before the rotation, so it reads as on an
    // upright page (x = 72, y from the top 792 - 712.67), whatever the page looks like on screen.
    let layer = state.text_layer(id, page(1)).unwrap();
    assert!(layer.text.ends_with("Turned page"));
    let at = 4 * (units(&layer.text) - "Turned page".len());
    assert_near(layer.boxes[at], 72.0, "x of the T");
    assert_near(layer.boxes[at + 1], 792.0 - 712.67, "y of the T");
}

#[test]
fn a_character_outside_the_basic_multilingual_plane_is_one_character_with_a_box_for_each_of_its_code_units(
) {
    // PDFium on Windows hands such a character over as two surrogate halves; the layer puts them together.
    let Some(state) = state() else { return };
    let id = open(state, "text.pdf").id;
    let layer = state.text_layer(id, page(1)).unwrap();
    assert!(layer.text.starts_with('\u{1f600}'));
    assert_eq!(units("\u{1f600}"), 2);
    assert_eq!(layer.boxes.len(), 4 * units(&layer.text));
    assert_eq!(
        layer.boxes[..4],
        layer.boxes[4..8],
        "the two halves share the box"
    );
    assert!(layer.boxes[2] > 0.0);
}

#[test]
fn a_page_with_more_than_200_000_characters_is_cut_there_and_says_so() {
    let Some(state) = state() else { return };
    let heavy = Generated::new(state, "heavy.pdf", &fixtures::heavy_text_page(400, 200));
    let layer: TextLayer = state.text_layer(heavy.id(), page(0)).unwrap();
    assert!(layer.truncated, "{} characters", units(&layer.text));
    assert_eq!(units(&layer.text), limits::MAX_TEXT_CHARS);
    assert_eq!(layer.boxes.len(), 4 * limits::MAX_TEXT_CHARS);
}

// --- search ---------------------------------------------------------------------------------------------------------

/// Everything a search sent, until it ended.
#[derive(Default)]
struct Found {
    pages: Vec<(PageId, Vec<Vec<Quad>>)>,
    progress: Vec<(u32, u32)>,
    done: Option<bool>,
    failed: bool,
}

impl Found {
    fn hits(&self) -> usize {
        self.pages.iter().map(|(_, hits)| hits.len()).sum()
    }
}

fn query(text: &str, match_case: bool, whole_word: bool, max_hits: u32) -> SearchQuery {
    SearchQuery {
        text: text.to_owned(),
        match_case,
        whole_word,
        max_hits,
    }
}

/// A document has one search at a time (a new one cancels the old one, which then goes quiet), so tests that search the same document
/// take turns.
fn search_turn() -> std::sync::MutexGuard<'static, ()> {
    static TURN: Mutex<()> = Mutex::new(());
    TURN.lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn search(state: &AppState, id: DocumentId, query: SearchQuery) -> Found {
    let _turn = search_turn();
    let (sender, receiver) = mpsc::channel();
    state
        .start_search(id, query, move |event| sender.send(event).is_ok())
        .unwrap();
    let mut found = Found::default();
    loop {
        match receiver.recv_timeout(Duration::from_secs(60)) {
            Ok(SearchEvent::Hits { page_id, hits }) => found.pages.push((page_id, hits)),
            Ok(SearchEvent::Progress { done, total }) => found.progress.push((done, total)),
            Ok(SearchEvent::Done { truncated }) => {
                found.done = Some(truncated);
                return found;
            }
            Ok(SearchEvent::Failed { .. }) => {
                found.failed = true;
                return found;
            }
            Err(error) => panic!("the search did not end: {error}"),
        }
    }
}

fn find(state: &AppState, id: DocumentId, text: &str, match_case: bool, whole_word: bool) -> Found {
    search(state, id, query(text, match_case, whole_word, 1_000))
}

#[test]
fn search_finds_non_ascii_text_whatever_the_case() {
    let Some(state) = state() else { return };
    let id = open(state, "text.pdf").id;
    // PDFium's own search folds the case of ASCII letters only, so `M\u{dc}NCHEN` would not find `M\u{fc}nchen`.
    assert_eq!(find(state, id, "M\u{dc}NCHEN", false, false).hits(), 1);
    assert_eq!(find(state, id, "m\u{fc}nchen", false, false).hits(), 1);
    assert_eq!(find(state, id, "M\u{dc}NCHEN", true, false).hits(), 0);
    assert_eq!(find(state, id, "M\u{fc}nchen", true, false).hits(), 1);
    assert_eq!(
        find(state, id, "gr\u{fc}\u{df}e AUS", false, false).hits(),
        1
    );
    assert_eq!(
        find(state, id, "CAF\u{c9} CR\u{c8}ME", false, false).hits(),
        1
    );
    assert_eq!(find(state, id, "na\u{ef}ve", true, true).hits(), 1);
    assert_eq!(find(state, id, "\u{20ac}", true, false).hits(), 1);
    // `\u{df}` is not `ss`: only lower-casing is done.
    assert_eq!(find(state, id, "STRASSE", false, false).hits(), 0);
    assert_eq!(find(state, id, "STRA\u{1e9e}E", false, false).hits(), 1);
    // The emoji of page 2 is one character, in the text and in the query.
    let emoji = find(state, id, "\u{1f600}", true, false);
    assert_eq!((emoji.hits(), emoji.pages[0].0), (1, page(1)));
}

#[test]
fn search_finds_a_word_that_a_line_break_cut_in_two_and_a_phrase_across_lines() {
    let Some(state) = state() else { return };
    let id = open(state, "text.pdf").id;
    // "hyphen-" at the end of a line, "ated" at the start of the next: PDFium keeps the hyphen in its text and so does not find
    // "hyphenated"; the layer, and so the search, does not have it.
    let hyphenated = find(state, id, "hyphenated", false, false);
    assert_eq!(hyphenated.hits(), 1);
    let quads = &hyphenated.pages[0].1[0];
    assert_eq!(
        quads.len(),
        2,
        "one rectangle for each line the word runs over"
    );
    // The lines are 30 pt apart: line 4 and line 5 of the page.
    assert_near(
        quads[1][0].y - quads[0][0].y,
        30.0,
        "distance of the two lines",
    );
    // The first part is "hyphen" at the right end of its line, the second "ated" at the left margin.
    assert!(quads[0][0].x > 150.0);
    assert_near(quads[1][0].x, 72.0, "left edge of the second part");

    // A phrase that wraps: "dog." at the end of a line, "A word" on the next.
    let phrase = find(state, id, "dog. a word", false, false);
    assert_eq!(phrase.hits(), 1);
    assert_eq!(phrase.pages[0].1[0].len(), 2);
    // The query's own white space does not matter.
    assert_eq!(
        find(state, id, "  the   quick \t brown  ", false, false).hits(),
        1
    );
}

#[test]
fn search_honours_match_case_and_whole_word() {
    let Some(state) = state() else { return };
    let id = open(state, "text.pdf").id;
    // "Repeat repeat REPEAT Repeated."
    assert_eq!(find(state, id, "repeat", false, false).hits(), 4);
    assert_eq!(find(state, id, "repeat", true, false).hits(), 1);
    assert_eq!(find(state, id, "repeat", false, true).hits(), 3);
    assert_eq!(find(state, id, "REPEAT", true, true).hits(), 1);
    assert_eq!(
        find(state, id, "hyphen", false, true).hits(),
        0,
        "a prefix of a longer word"
    );
}

#[test]
fn a_hit_is_the_rectangle_of_its_characters_in_page_space() {
    let Some(state) = state() else { return };
    let id = open(state, "text.pdf").id;
    // "fox" in "The quick brown fox jumps ...", the third line: baseline y = 640, 14 pt Helvetica.
    let found = find(state, id, "fox", true, true);
    let quad = found.pages[0].1[0][0];
    let [top_left, top_right, bottom_left, bottom_right] = quad;
    assert_eq!((top_left.y, top_right.y), (top_right.y, top_left.y));
    assert_eq!(
        (bottom_left.y, bottom_right.y),
        (bottom_right.y, bottom_left.y)
    );
    assert_eq!((top_left.x, bottom_left.x), (bottom_left.x, top_left.x));
    assert_near(top_left.y, 792.0 - 652.67, "top of the line");
    assert_near(bottom_left.y - top_left.y, 15.62, "height of the line");
    // "The quick brown " is 16 characters of about 7 pt each: the word starts around 72 + 100 and is three letters wide.
    assert!(top_left.x > 150.0 && top_left.x < 220.0, "{}", top_left.x);
    let width = top_right.x - top_left.x;
    assert!(width > 15.0 && width < 30.0, "{width}");
}

#[test]
fn a_search_reports_pages_with_hits_in_order_then_progress_and_done() {
    let Some(state) = state() else { return };
    let id = open(state, "text.pdf").id;
    let found = find(state, id, "needle", false, false);
    assert_eq!(found.hits(), 30);
    assert_eq!(found.pages.len(), 1);
    assert_eq!(found.pages[0].0, page(2));
    assert_eq!(found.done, Some(false));
    assert_eq!(found.progress.last(), Some(&(3, 3)));
    assert!(found
        .progress
        .iter()
        .all(|&(done, total)| total == 3 && done <= 3));
    // Nothing found is a search that is done, not an error.
    let none = find(state, id, "no such words", false, false);
    assert_eq!(
        (none.hits(), none.done, none.failed),
        (0, Some(false), false)
    );
}

#[test]
fn a_search_stops_at_max_hits_and_says_it_was_cut() {
    let Some(state) = state() else { return };
    let id = open(state, "text.pdf").id;
    let cut = search(state, id, query("needle", false, false, 10));
    assert_eq!(cut.hits(), 10);
    assert_eq!(cut.done, Some(true));
    // Exactly as many hits as there are is not cut; one fewer is.
    let exact = search(state, id, query("needle", false, false, 30));
    assert_eq!((exact.hits(), exact.done), (30, Some(false)));
    let one_short = search(state, id, query("needle", false, false, 29));
    assert_eq!((one_short.hits(), one_short.done), (29, Some(true)));
    // A search that is cut on an earlier page does not go on to the later ones.
    let first_page = search(state, id, query("the", false, false, 2));
    assert_eq!((first_page.hits(), first_page.done), (2, Some(true)));
    assert_eq!(first_page.pages[0].0, page(0));
}

#[test]
fn a_cancelled_search_goes_quiet_and_other_searches_are_not_affected() {
    let Some(state) = state() else { return };
    let pages = Generated::new(state, "long.pdf", &fixtures::numbered_pages(400, 1));
    let search_id = Arc::new(AtomicU32::new(u32::MAX));
    let (sender, receiver) = mpsc::channel();
    let seen = Arc::new(Mutex::new(0usize));
    let (id_for_callback, seen_for_callback, state_for_callback) =
        (Arc::clone(&search_id), Arc::clone(&seen), state.clone());
    let started = state
        .start_search(
            pages.id(),
            query("needle", false, false, 50_000),
            move |event| {
                *seen_for_callback.lock().unwrap() += 1;
                // The first hit is the moment to cancel.
                if matches!(event, SearchEvent::Hits { .. }) {
                    let id = id_for_callback.load(Ordering::SeqCst);
                    if id != u32::MAX {
                        state_for_callback.cancel_search(id);
                    }
                }
                sender.send(event).is_ok()
            },
        )
        .unwrap();
    search_id.store(started, Ordering::SeqCst);

    // Wait for the search to have been cancelled and gone quiet: no `done`, and the messages stop coming.
    let mut last = 0usize;
    for _ in 0..50 {
        std::thread::sleep(Duration::from_millis(100));
        let now = *seen.lock().unwrap();
        if now == last && now > 0 {
            break;
        }
        last = now;
    }
    let mut events = Vec::new();
    while let Ok(event) = receiver.try_recv() {
        events.push(event);
    }
    assert!(
        events.len() < 400,
        "a search of 400 pages with a hit on each sent {} messages although it was cancelled at the first hit",
        events.len()
    );
    assert!(!events
        .iter()
        .any(|event| matches!(event, SearchEvent::Done { .. })));
    // A search that is started after it runs to its end.
    let again = search(state, pages.id(), query("needle", false, false, 50_000));
    assert_eq!((again.hits(), again.done), (400, Some(false)));
}

#[test]
fn a_search_of_a_document_that_is_closed_meanwhile_ends_quietly() {
    let Some(state) = state() else { return };
    let pages = Generated::new(state, "closing.pdf", &fixtures::numbered_pages(400, 1));
    let (sender, receiver) = mpsc::channel();
    state
        .start_search(
            pages.id(),
            query("needle", false, false, 50_000),
            move |event| sender.send(event).is_ok(),
        )
        .unwrap();
    // The first message, then the document goes away.
    receiver.recv_timeout(Duration::from_secs(30)).unwrap();
    state.close_document(pages.id()).unwrap();
    std::thread::sleep(Duration::from_millis(500));
    let mut events = Vec::new();
    while let Ok(event) = receiver.try_recv() {
        events.push(event);
    }
    assert!(!events
        .iter()
        .any(|event| matches!(event, SearchEvent::Failed { .. })));
    assert!(events.len() < 400);
}

#[test]
fn a_search_of_a_big_document_finds_what_is_on_the_pages_it_is_on() {
    let Some(state) = state() else { return };
    let pages = Generated::new(state, "big.pdf", &fixtures::numbered_pages(120, 40));
    let found = find(state, pages.id(), "needle", false, false);
    let on: Vec<PageId> = found.pages.iter().map(|(page_id, _)| *page_id).collect();
    assert_eq!(on, [page(39), page(79), page(119)]);
    assert_eq!(found.progress.last(), Some(&(120, 120)));
}
