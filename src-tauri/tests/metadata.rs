//! Document metadata against the real PDFium and lopdf (ADR-047 §5): read with hostile strings filtered, an edit written
//! incrementally with a regenerated XMP packet, and a removal that leaves no `/Info`, `/Metadata` or `/PieceInfo` in the file.
//! Skips when the PDFium library is not fetched.

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
use sheer_lib::model::command::DocCommand;
use sheer_lib::model::metadata::MetadataPending;
use sheer_lib::pdfwrite::crypt;
use support::fixtures::{add_pages, Page};
use support::PdfBuilder;

struct Scratch(PathBuf);

impl Scratch {
    fn new(name: &str) -> Self {
        let path = std::env::temp_dir().join(format!("sheer-meta-{}-{name}", std::process::id()));
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

fn hex_utf16(text: &str) -> String {
    let mut out = String::from("<FEFF");
    for unit in text.encode_utf16() {
        out.push_str(&format!("{unit:04X}"));
    }
    out.push('>');
    out
}

/// A document with every kind of metadata: an `/Info` with hostile and long strings, an XMP packet and a `/PieceInfo`.
fn fixture() -> Vec<u8> {
    let mut builder = PdfBuilder::new();
    add_pages(&mut builder, &[Page::new("")]);
    // A title with a control character, a bidi override and a zero width space.
    let title = "Re\u{7}port\u{202E}fdp\u{200B}.exe";
    let keywords = "k".repeat(1_500);
    builder.object(
        20,
        &format!(
            "<< /Title {} /Author {} /Subject (Secret SHEER-SECRET-4711) /Keywords ({keywords}) /Creator (Writer) \
             /Producer (Maker 1.0) /CreationDate (D:20240229101500+01'00') /ModDate (D:20240301000000Z) >>",
            hex_utf16(title),
            hex_utf16("Jos\u{e9} \u{4e2d}")
        ),
    );
    let xmp = "<?xpacket begin=\"x\"?><x:xmpmeta><dc:title>SHEER-SECRET-4711</dc:title></x:xmpmeta><?xpacket end=\"w\"?>";
    builder.stream(21, "/Type /Metadata /Subtype /XML", xmp.as_bytes());
    builder.object(22, "<< /Private (SHEER-SECRET-4711) >>");
    builder.object(
        1,
        "<< /Type /Catalog /Pages 2 0 R /Metadata 21 0 R /PieceInfo << /App << /Data 22 0 R >> >> >>",
    );
    builder.trailer("/Info 20 0 R");
    builder.finish(1)
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

#[test]
fn a_file_is_read_with_hostile_strings_filtered_and_dates_in_iso() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("read");
    let id = open(state, &scratch, "m.pdf", &fixture());
    let meta = state.get_metadata(id).unwrap();
    assert_eq!(meta.title.as_deref(), Some("Reportfdp.exe"));
    assert_eq!(meta.author.as_deref(), Some("Jos\u{e9} \u{4e2d}"));
    assert_eq!(meta.creator.as_deref(), Some("Writer"));
    let keywords = meta.keywords.clone().unwrap();
    assert_eq!(keywords.chars().count(), 1_000);
    assert!(meta.truncated);
    assert_eq!(meta.created.as_deref(), Some("2024-02-29T10:15:00+01:00"));
    assert_eq!(meta.modified.as_deref(), Some("2024-03-01T00:00:00Z"));
    assert_eq!(meta.pdf_version, "1.7");
    assert!(meta.xmp.present && meta.xmp.bytes > 50);
    assert_eq!(meta.pending, MetadataPending::None);
    // Read once: the second answer is the model's.
    assert_eq!(state.get_metadata(id).unwrap(), meta);
}

#[test]
fn an_edit_is_one_undo_step_and_is_written_incrementally_with_a_new_xmp() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("edit");
    let original = fixture();
    let id = open(state, &scratch, "m.pdf", &original);

    // Editing needs the values read first.
    let early = state.apply_command(
        id,
        cmd(json!({"type": "setMetadata", "patch": {"title": "x"}})),
    );
    assert_eq!(early.unwrap_err().code(), ErrorCode::InvalidArgument);
    state.get_metadata(id).unwrap();

    // What the UI sends is checked: controls and too long.
    let control = state.apply_command(
        id,
        cmd(json!({"type": "setMetadata", "patch": {"title": "a\u{7}b"}})),
    );
    assert_eq!(control.unwrap_err().code(), ErrorCode::InvalidArgument);
    let bidi = state.apply_command(
        id,
        cmd(json!({"type": "setMetadata", "patch": {"author": "a\u{202E}b"}})),
    );
    assert_eq!(bidi.unwrap_err().code(), ErrorCode::InvalidArgument);
    let long = "x".repeat(1_001);
    let too_long = state.apply_command(
        id,
        cmd(json!({"type": "setMetadata", "patch": {"subject": long}})),
    );
    assert_eq!(too_long.unwrap_err().code(), ErrorCode::LimitExceeded);

    let changes = state
        .apply_command(
            id,
            cmd(json!({"type": "setMetadata", "patch": {"title": "New <T> & \"Q\"", "author": null}})),
        )
        .unwrap();
    assert!(changes.history.dirty);
    let meta = state.get_metadata(id).unwrap();
    assert_eq!(
        (meta.title.as_deref(), meta.author.as_deref()),
        (Some("New <T> & \"Q\""), None)
    );
    assert_eq!(meta.pending, MetadataPending::Edited);
    state.undo(id).unwrap();
    let meta = state.get_metadata(id).unwrap();
    assert_eq!(meta.author.as_deref(), Some("Jos\u{e9} \u{4e2d}"));
    assert_eq!(meta.pending, MetadataPending::None);
    state.redo(id).unwrap();

    let saved = state.save_in_place(id, SaveAck::default()).unwrap();
    assert_eq!(saved.mode, SaveMode::Incremental);
    let written = std::fs::read(scratch.file("m.pdf")).unwrap();
    assert_eq!(
        &written[..original.len()],
        &original[..],
        "an update on top of the file"
    );

    let title = crypt::testing::info_string(&written, b"Title").unwrap();
    assert_eq!(title, b"New <T> & \"Q\"");
    assert!(crypt::testing::info_string(&written, b"Author").is_none());
    // What was not edited is as the file had it, byte for byte (the hostile title was edited; the subject was not).
    assert_eq!(
        crypt::testing::info_string(&written, b"Subject").unwrap(),
        b"Secret SHEER-SECRET-4711"
    );
    assert_eq!(
        crypt::testing::info_string(&written, b"Keywords")
            .unwrap()
            .len(),
        1_500
    );
    assert_ne!(
        crypt::testing::info_string(&written, b"ModDate").unwrap(),
        b"D:20240301000000Z"
    );
    // The XMP packet is regenerated from the values, escaped; the old text is shadowed.
    let xmp = crypt::testing::xmp_text(&written).unwrap();
    assert!(xmp.contains("New &lt;T&gt; &amp; &quot;Q&quot;"), "{xmp}");
    assert!(!xmp.contains("<T>"));
    assert!(
        !xmp.contains("<x:xmpmeta><dc:title>"),
        "the old packet is replaced"
    );

    // The file reads back as the session had it, and nothing is pending any more.
    let meta = state.get_metadata(id).unwrap();
    assert_eq!(meta.title.as_deref(), Some("New <T> & \"Q\""));
    assert_eq!(meta.author, None);
    assert_eq!(meta.pending, MetadataPending::None);
}

#[test]
fn a_removal_leaves_no_info_no_metadata_and_no_piece_info() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("strip");
    let id = open(state, &scratch, "m.pdf", &fixture());

    // A removal can be staged before the values were read, and undone.
    state
        .apply_command(id, cmd(json!({"type": "removeMetadata"})))
        .unwrap();
    assert_eq!(
        state.get_metadata(id).unwrap().pending,
        MetadataPending::Remove
    );
    state.undo(id).unwrap();
    assert_eq!(
        state.get_metadata(id).unwrap().pending,
        MetadataPending::None
    );
    state.redo(id).unwrap();
    assert_eq!(
        state.get_metadata(id).unwrap().pending,
        MetadataPending::Remove
    );

    let saved = state.save_in_place(id, SaveAck::default()).unwrap();
    assert_eq!(saved.mode, SaveMode::Full);
    assert!(!saved.backup_created);
    assert!(
        saved.warnings.is_empty(),
        "no backup is wanted, so none is skipped"
    );

    let written = std::fs::read(scratch.file("m.pdf")).unwrap();
    for needle in [
        "SHEER-SECRET-4711",
        "/Metadata",
        "/PieceInfo",
        "/Info",
        "/Title",
        "/Producer",
    ] {
        assert!(!contains(&written, needle), "{needle} is still in the file");
    }
    assert_eq!(
        written.windows(5).filter(|w| *w == b"\nxref").count(),
        1,
        "one xref section"
    );
    assert_eq!(
        crypt::testing::has_info_and_pages(&written),
        Some((false, 1))
    );
    let meta = state.get_metadata(id).unwrap();
    assert!(meta.title.is_none() && meta.creator.is_none() && !meta.xmp.present);
    assert_eq!(meta.pending, MetadataPending::None);
}
