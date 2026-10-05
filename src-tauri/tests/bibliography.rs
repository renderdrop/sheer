//! The bibliographic record (ADR-119 items 4 to 6, 10): the merge of the user's record, XMP and Info, the record as an undoable
//! command, the round trip through a save, and hostile XMP and `/SHR_Bib`. The read tests need only lopdf; the document tests skip
//! when the PDFium library is not fetched.

#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use std::path::PathBuf;
use std::sync::OnceLock;

use serde_json::json;
use sheer_lib::commands::save::{SaveAck, SaveMode};
use sheer_lib::commands::AppState;
use sheer_lib::documents::DocumentId;
use sheer_lib::engine::{self, Engine};
use sheer_lib::error::ErrorCode;
use sheer_lib::limits;
use sheer_lib::model::bibliography::{BibField, BibKind, BibSource};
use sheer_lib::model::command::DocCommand;
use sheer_lib::pdfwrite::bibliography::{read, BibRead};
use sheer_lib::pdfwrite::load_untrusted;
use support::fixtures::{add_pages, Page};
use support::PdfBuilder;

struct Scratch(PathBuf);

impl Scratch {
    fn new(name: &str) -> Self {
        let path = std::env::temp_dir().join(format!("sheer-bib-{}-{name}", std::process::id()));
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

fn open(state: &AppState, scratch: &Scratch, name: &str, bytes: &[u8]) -> DocumentId {
    let path = scratch.file(name);
    std::fs::write(&path, bytes).unwrap();
    state.open_path(path).unwrap().expect("loaded").id
}

fn cmd(value: serde_json::Value) -> DocCommand {
    serde_json::from_value(value).unwrap()
}

fn contains(haystack: &[u8], needle: &str) -> bool {
    haystack
        .windows(needle.len())
        .any(|w| w == needle.as_bytes())
}

const XMP_HEAD: &str = "<?xpacket begin=\"x\" id=\"W5M0MpCehiHzreSzNTczkc9d\"?><x:xmpmeta xmlns:x=\"adobe:ns:meta/\">\
    <rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\" \
    xmlns:prism=\"http://prismstandard.org/namespaces/basic/2.0/\">";
const XMP_TAIL: &str = "</rdf:RDF></x:xmpmeta><?xpacket end=\"w\"?>";

fn xmp(body: &str) -> Vec<u8> {
    format!("{XMP_HEAD}<rdf:Description rdf:about=\"\">{body}</rdf:Description>{XMP_TAIL}")
        .into_bytes()
}

/// A file with an `/Info` (`info` entries), an optional XMP packet and optional extra `/Info` text (for `/SHR_Bib`).
fn file(info: &str, packet: Option<&[u8]>, extra_objects: &[(u32, &str)]) -> Vec<u8> {
    let mut builder = PdfBuilder::new();
    add_pages(&mut builder, &[Page::new("")]);
    builder.object(20, &format!("<< {info} >>"));
    let catalog = match packet {
        Some(packet) => {
            builder.stream(21, "/Type /Metadata /Subtype /XML", packet);
            "<< /Type /Catalog /Pages 2 0 R /Metadata 21 0 R >>"
        }
        None => "<< /Type /Catalog /Pages 2 0 R >>",
    };
    builder.object(1, catalog);
    for (id, body) in extra_objects {
        builder.object(*id, body);
    }
    builder.trailer("/Info 20 0 R");
    builder.finish(1)
}

fn read_bytes(bytes: &[u8]) -> BibRead {
    let doc = load_untrusted(bytes).unwrap();
    read(&doc).unwrap()
}

const USER_BIB: &str =
    "/SHR_Bib << /V 1 /K (book) /T (User Title) /Y (2020a) /P (1-9) /DOI (10.1000/abc) \
    /URL (https://example.com/x) /Acc (2026-10-05) /A [ << /F (Doe) /G (Jane) >> ] >>";

// --- Merge order ---

#[test]
fn the_user_record_beats_xmp_beats_info_per_field() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("merge");
    let packet = xmp(
        "<dc:title><rdf:Alt><rdf:li xml:lang=\"x-default\">XMP Title</rdf:li></rdf:Alt></dc:title>\
         <dc:creator><rdf:Seq><rdf:li>Roe, Richard</rdf:li></rdf:Seq></dc:creator>\
         <dc:publisher><rdf:Bag><rdf:li>XMP Press</rdf:li></rdf:Bag></dc:publisher>",
    );
    let bytes = file(
        &format!(
            "/Title (Info Title) /Author (Info Author) /CreationDate (D:20190102000000Z) /Subject (S) {USER_BIB}"
        ),
        Some(&packet),
        &[],
    );
    let id = open(state, &scratch, "merge.pdf", &bytes);
    let info = state.get_bibliography(id).unwrap();
    let record = &info.record;
    assert_eq!(record.kind, BibKind::Book);
    assert_eq!(record.title.as_deref(), Some("User Title"));
    assert_eq!(info.sources[&BibField::Title], BibSource::User);
    assert_eq!(record.authors.len(), 1);
    assert_eq!(record.authors[0].family, "Doe");
    assert_eq!(info.sources[&BibField::Authors], BibSource::User);
    // The user's year wins over the Info date; the publisher is XMP only; the volume is nobody's.
    assert_eq!(record.year.as_deref(), Some("2020a"));
    assert_eq!(info.sources[&BibField::Year], BibSource::User);
    assert_eq!(record.publisher.as_deref(), Some("XMP Press"));
    assert_eq!(info.sources[&BibField::Publisher], BibSource::Xmp);
    assert_eq!(record.volume, None);
    assert_eq!(info.sources[&BibField::Volume], BibSource::None);
    assert!(!info.pending && !info.dropped_by_strip);
    // The first answer is the model's from now on.
    assert_eq!(state.get_bibliography(id).unwrap(), info);
}

#[test]
fn without_a_user_record_xmp_comes_before_info() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("layers");
    let packet = xmp(
        "<dc:title>XMP Title</dc:title><dc:creator><rdf:Seq><rdf:li>Roe, Richard</rdf:li></rdf:Seq></dc:creator>",
    );
    let bytes = file(
        "/Title (Info Title) /Author (Info Author) /CreationDate (D:20190102000000Z)",
        Some(&packet),
        &[],
    );
    let id = open(state, &scratch, "layers.pdf", &bytes);
    let info = state.get_bibliography(id).unwrap();
    assert_eq!(info.record.title.as_deref(), Some("XMP Title"));
    assert_eq!(info.sources[&BibField::Title], BibSource::Xmp);
    assert_eq!(info.record.authors[0].family, "Roe");
    assert_eq!(info.sources[&BibField::Authors], BibSource::Xmp);
    assert_eq!(info.record.year.as_deref(), Some("2019"));
    assert_eq!(info.sources[&BibField::Year], BibSource::Info);

    // Info alone.
    let bytes = file(
        "/Title (Only Info) /Author (Ada Lovelace and Charles Babbage)",
        None,
        &[],
    );
    let id = open(state, &scratch, "info.pdf", &bytes);
    let info = state.get_bibliography(id).unwrap();
    assert_eq!(info.record.title.as_deref(), Some("Only Info"));
    assert_eq!(info.record.authors.len(), 2);
    assert_eq!(info.record.authors[0].given, "Ada");
    assert_eq!(info.sources[&BibField::Title], BibSource::Info);
    assert_eq!(info.sources[&BibField::Kind], BibSource::None);
}

// --- The command, undo, and the round trip ---

#[test]
fn a_record_is_one_undo_step_and_survives_a_save_and_reopen() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("trip");
    let original = file("/Title (Keep Me) /Author (Keep Author)", None, &[]);
    let id = open(state, &scratch, "trip.pdf", &original);

    // The file has to be read first.
    let early = state.apply_command(
        id,
        cmd(json!({"type": "setBibliography", "record": {"title": "x"}})),
    );
    assert_eq!(early.unwrap_err().code(), ErrorCode::InvalidArgument);
    state.get_bibliography(id).unwrap();

    let record = json!({
        "kind": "chapter",
        "authors": [{"family": "M\u{fc}ller", "given": "Jos\u{e9}"}, {"family": "Org", "given": ""}],
        "title": "A <Chapter> & \"Q\"", "year": "n.d.", "containerTitle": "The Book",
        "pages": "3\u{2013}9", "doi": "10.1000/xyz", "url": "https://example.com/a?b=1", "accessed": "2026-10-05"
    });
    let changes = state
        .apply_command(
            id,
            cmd(json!({"type": "setBibliography", "record": record})),
        )
        .unwrap();
    assert!(changes.history.dirty);
    let info = state.get_bibliography(id).unwrap();
    assert!(info.pending);
    assert_eq!(info.sources[&BibField::Title], BibSource::User);
    state.undo(id).unwrap();
    let info = state.get_bibliography(id).unwrap();
    assert!(!info.pending);
    assert_eq!(info.record.title.as_deref(), Some("Keep Me"));
    state.redo(id).unwrap();

    let saved = state.save_in_place(id, SaveAck::default()).unwrap();
    assert_eq!(saved.mode, SaveMode::Incremental);
    let written = std::fs::read(scratch.file("trip.pdf")).unwrap();
    assert_eq!(
        &written[..original.len()],
        &original[..],
        "an update on top of the file"
    );
    assert!(contains(&written, "/SHR_Bib"));

    // After the save the record is the file's: read again, nothing pending, /Title and /Author untouched.
    let info = state.get_bibliography(id).unwrap();
    assert!(!info.pending);
    assert_eq!(info.record.kind, BibKind::Chapter);
    assert_eq!(info.record.title.as_deref(), Some("A <Chapter> & \"Q\""));
    assert_eq!(info.record.authors[0].family, "M\u{fc}ller");
    assert_eq!(info.record.authors[1].given, "");
    assert_eq!(info.record.year.as_deref(), Some("n.d."));
    assert_eq!(info.record.accessed.as_deref(), Some("2026-10-05"));
    assert_eq!(info.sources[&BibField::Title], BibSource::User);
    let meta = state.get_metadata(id).unwrap();
    assert_eq!(meta.title.as_deref(), Some("Keep Me"));
    assert_eq!(meta.author.as_deref(), Some("Keep Author"));

    // A new session reads the same.
    let again = open(state, &scratch, "trip2.pdf", &written);
    let info = state.get_bibliography(again).unwrap();
    assert_eq!(info.record.container_title.as_deref(), Some("The Book"));

    // Metadata and bibliography edits together: one /Info, both written.
    state
        .apply_command(
            id,
            cmd(json!({"type": "setMetadata", "patch": {"title": "New Title"}})),
        )
        .unwrap();
    state
        .apply_command(
            id,
            cmd(json!({"type": "setBibliography", "record": {"kind": "book", "title": "Other"}})),
        )
        .unwrap();
    state.save_in_place(id, SaveAck::default()).unwrap();
    let info = state.get_bibliography(id).unwrap();
    assert_eq!(info.record.title.as_deref(), Some("Other"));
    assert_eq!(info.record.kind, BibKind::Book);
    assert_eq!(
        state.get_metadata(id).unwrap().title.as_deref(),
        Some("New Title")
    );
}

#[test]
fn bad_records_are_refused_and_change_nothing() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("bad");
    let id = open(state, &scratch, "bad.pdf", &file("/Title (T)", None, &[]));
    state.get_bibliography(id).unwrap();
    let authors: Vec<_> = (0..=limits::BIB_AUTHORS_MAX)
        .map(|n| json!({"family": format!("F{n}")}))
        .collect();
    for (record, code) in [
        (json!({"title": "a\u{7}b"}), ErrorCode::InvalidArgument),
        (json!({"title": "a\u{202E}b"}), ErrorCode::InvalidArgument),
        (
            json!({"title": "x".repeat(limits::BIB_FIELD_MAX + 1)}),
            ErrorCode::LimitExceeded,
        ),
        (
            json!({"year": "1".repeat(limits::BIB_YEAR_MAX + 1)}),
            ErrorCode::LimitExceeded,
        ),
        (
            json!({"doi": "10.1/".to_owned() + &"d".repeat(limits::BIB_DOI_MAX)}),
            ErrorCode::LimitExceeded,
        ),
        (
            json!({"url": "https://e.com/".to_owned() + &"u".repeat(limits::BIB_URL_MAX)}),
            ErrorCode::LimitExceeded,
        ),
        (
            json!({"accessed": "2026-13-01"}),
            ErrorCode::InvalidArgument,
        ),
        (
            json!({"accessed": "05.10.2026"}),
            ErrorCode::InvalidArgument,
        ),
        (json!({"doi": "https://evil"}), ErrorCode::InvalidArgument),
        (
            json!({"url": "file:///etc/passwd"}),
            ErrorCode::InvalidArgument,
        ),
        (json!({"authors": authors}), ErrorCode::LimitExceeded),
        (
            json!({"authors": [{"family": "x".repeat(limits::BIB_PERSON_MAX + 1)}]}),
            ErrorCode::LimitExceeded,
        ),
    ] {
        let result = state.apply_command(
            id,
            cmd(json!({"type": "setBibliography", "record": record})),
        );
        assert_eq!(result.unwrap_err().code(), code, "{record}");
    }
    assert!(!state.get_bibliography(id).unwrap().pending);
}

#[test]
fn a_staged_removal_of_the_metadata_drops_the_record() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("strip");
    let id = open(state, &scratch, "strip.pdf", &file("/Title (T)", None, &[]));
    state.get_bibliography(id).unwrap();
    state
        .apply_command(
            id,
            cmd(json!({"type": "setBibliography", "record": {"title": "Secret SHEER-BIB-4711"}})),
        )
        .unwrap();
    assert!(!state.get_bibliography(id).unwrap().dropped_by_strip);
    state
        .apply_command(id, cmd(json!({"type": "removeMetadata"})))
        .unwrap();
    assert!(state.get_bibliography(id).unwrap().dropped_by_strip);
    state.save_in_place(id, SaveAck::default()).unwrap();
    let written = std::fs::read(scratch.file("strip.pdf")).unwrap();
    assert!(!contains(&written, "SHR_Bib"));
    assert!(!contains(&written, "SHEER-BIB-4711"));
    let info = state.get_bibliography(id).unwrap();
    assert_eq!(info.record.title, None);
    assert!(!info.pending && !info.dropped_by_strip);
}

// --- Hostile XMP ---

#[test]
fn hostile_xmp_gives_nothing_and_never_hurts_the_rest() {
    let doctype = format!(
        "<?xml version=\"1.0\"?><!DOCTYPE foo [<!ENTITY xxe SYSTEM \"file:///etc/passwd\">]>{}",
        String::from_utf8(xmp("<dc:title>&xxe;</dc:title>")).unwrap()
    );
    let laughs = "<?xml version=\"1.0\"?><!DOCTYPE lolz [<!ENTITY lol \"lol\">\
        <!ENTITY lol2 \"&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;\">\
        <!ENTITY lol3 \"&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;\">]><dc:title>&lol3;</dc:title>"
        .to_owned();
    let deep = format!(
        "{XMP_HEAD}{}x{}{XMP_TAIL}",
        "<a>".repeat(limits::BIB_XMP_DEPTH_MAX + 5),
        "</a>".repeat(limits::BIB_XMP_DEPTH_MAX + 5)
    );
    let mut bad_utf8 = xmp("<dc:title>ABCD</dc:title>");
    let at = bad_utf8.windows(4).position(|w| w == b"ABCD").unwrap();
    bad_utf8[at] = 0xC3;
    bad_utf8[at + 1] = 0x28;
    let wrong_ns = xmp("");
    let wrong_ns = String::from_utf8(wrong_ns).unwrap().replace(
        "<rdf:Description rdf:about=\"\">",
        "<rdf:Description xmlns:dc=\"http://evil.example/dc\"><dc:title>Wrong</dc:title>",
    );
    let corpus: Vec<Vec<u8>> = vec![
        doctype.into_bytes(),
        laughs.into_bytes(),
        deep.into_bytes(),
        bad_utf8,
        wrong_ns.into_bytes(),
        b"<xmp".to_vec(),
        b"\xFF\xFE<\0x\0>\0".to_vec(),
        Vec::new(),
    ];
    for (n, packet) in corpus.iter().enumerate() {
        let bytes = file("/Title (From Info)", Some(packet), &[]);
        let got = read_bytes(&bytes);
        assert_eq!(got.xmp.title, None, "case {n}");
        assert!(got.xmp.authors.is_empty(), "case {n}");
        assert_eq!(got.info.title.as_deref(), Some("From Info"), "case {n}");
    }
}

#[test]
fn a_huge_xmp_packet_is_not_read_and_a_long_value_is_capped() {
    let huge = vec![b' '; usize::try_from(limits::MAX_XMP_BYTES).unwrap() + 10];
    let got = read_bytes(&file("/Title (T)", Some(&huge), &[]));
    assert_eq!(got.xmp, Default::default());

    let long = "w".repeat(1_000_000);
    let packet = xmp(&format!("<dc:title>{long}</dc:title>"));
    let got = read_bytes(&file("/Title (T)", Some(&packet), &[]));
    assert_eq!(
        got.xmp.title.unwrap().chars().count(),
        limits::BIB_FIELD_MAX
    );

    // Many persons: capped.
    let creators: String = (0..500)
        .map(|n| format!("<rdf:li>Family{n}, Given</rdf:li>"))
        .collect();
    let packet = xmp(&format!(
        "<dc:creator><rdf:Seq>{creators}</rdf:Seq></dc:creator>"
    ));
    let got = read_bytes(&file("/Title (T)", Some(&packet), &[]));
    assert_eq!(got.xmp.authors.len(), limits::BIB_AUTHORS_MAX);
}

// --- Hostile /SHR_Bib ---

#[test]
fn a_hostile_shr_bib_is_filtered_or_ignored() {
    // Wrong version, wrong container types: no record.
    for info in [
        "/SHR_Bib << /V 2 /T (x) >>",
        "/SHR_Bib << /V (1) /T (x) >>",
        "/SHR_Bib << /T (x) >>",
        "/SHR_Bib (a string)",
        "/SHR_Bib [ 1 2 3 ]",
        "/SHR_Bib 42",
        "/SHR_Bib 30 0 R",
    ] {
        let bytes = file(info, None, &[(30, "30 0 R")]);
        assert_eq!(read_bytes(&bytes).record, None, "{info}");
    }
    // A reference loop and wrongly typed fields do not hang or crash and give an empty or partial record.
    let bytes = file(
        "/SHR_Bib << /V 1 /T 31 0 R /Y << /Deep << /Deeper [ [ [ [ 1 ] ] ] ] >> >> /K 5 /A 32 0 R /P [ (x) ] >>",
        None,
        &[(31, "31 0 R"), (32, "[ 32 0 R 33 0 R ]"), (33, "<< /F 33 0 R >>")],
    );
    let record = read_bytes(&bytes).record.unwrap();
    assert_eq!(record.title, None);
    assert_eq!(record.year, None);
    assert_eq!(record.pages, None);
    assert!(record.authors.is_empty());
    assert_eq!(record.kind, BibKind::Article);

    // Too many authors, long and hostile strings, bad shapes.
    let authors: String = (0..200)
        .map(|n| format!("<< /F (Fam{n}) /G (G) >> 7 (str) null "))
        .collect();
    let long = "L".repeat(100_000);
    let bytes = file(
        &format!(
            "/SHR_Bib << /V 1 /K (nonsense) /T ({long}) /Y ({long}) /DOI (not a doi) /URL (javascript:alert(1)) /Acc (31.12.2026) \
             /C <FEFF00410007202E0042> /A [ {authors} ] >>"
        ),
        None,
        &[],
    );
    let record = read_bytes(&bytes).record.unwrap();
    assert_eq!(record.title.unwrap().chars().count(), limits::BIB_FIELD_MAX);
    assert_eq!(record.year.unwrap().chars().count(), limits::BIB_YEAR_MAX);
    assert_eq!(record.doi, None);
    assert_eq!(record.url, None);
    assert_eq!(record.accessed, None);
    assert_eq!(record.container_title.as_deref(), Some("AB"));
    assert_eq!(record.authors.len(), limits::BIB_AUTHORS_MAX);
    assert_eq!(record.kind, BibKind::Article);
}

#[test]
fn a_hostile_file_through_the_command_still_answers() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("hostile");
    let packet = format!(
        "<?xml version=\"1.0\"?><!DOCTYPE x [<!ENTITY a \"b\">]>{}",
        String::from_utf8(xmp("<dc:title>&a;</dc:title>")).unwrap()
    );
    let bytes = file(
        "/Title (Info Title) /SHR_Bib << /V 1 /A 5 /T [ (x) ] >>",
        Some(packet.as_bytes()),
        &[],
    );
    let id = open(state, &scratch, "h.pdf", &bytes);
    let info = state.get_bibliography(id).unwrap();
    assert_eq!(info.record.title.as_deref(), Some("Info Title"));
    assert_eq!(info.sources[&BibField::Title], BibSource::Info);
}
