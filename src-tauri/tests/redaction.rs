//! True redaction against the real PDFium (ADR-047 §3, SECURITY D4): marked text is not in the saved file in any form a program could
//! read it back, the other page is intact, undo brings everything back. Skips when the PDFium library is not fetched.

#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use std::path::PathBuf;
use std::sync::mpsc;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde_json::json;
use sheer_lib::commands::jobs::{EventSink, JobEvent, JobRegistry};
use sheer_lib::commands::save::{SaveAck, SaveMode};
use sheer_lib::commands::AppState;
use sheer_lib::documents::{DocumentId, PageId};
use sheer_lib::engine::{self, Engine};
use sheer_lib::model::command::DocCommand;
use sheer_lib::model::redaction::RedactOptions;
use sheer_lib::pdfwrite::redact;
use support::fixtures::{add_pages, page_id, Page};
use support::{text_line, PdfBuilder};

const SECRET: &str = "SHEER-SECRET-4711";

struct Scratch(PathBuf);

impl Scratch {
    fn new(name: &str) -> Self {
        let path = std::env::temp_dir().join(format!("sheer-redact-{}-{name}", std::process::id()));
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

struct Collect(Mutex<mpsc::Sender<JobEvent>>);

impl EventSink for Collect {
    fn send(&self, event: JobEvent) {
        let _ = self.0.lock().unwrap().send(event);
    }
}

fn run_redaction(state: &AppState, id: DocumentId, opts: &RedactOptions) -> JobEvent {
    let jobs = Arc::new(JobRegistry::new());
    let (sender, receiver) = mpsc::channel();
    state
        .start_redaction(&jobs, id, opts, Arc::new(Collect(Mutex::new(sender))))
        .unwrap();
    loop {
        match receiver.recv_timeout(Duration::from_secs(120)).unwrap() {
            JobEvent::Progress { .. } => {}
            other => return other,
        }
    }
}

fn hex_utf16(text: &str) -> String {
    text.encode_utf16().map(|u| format!("{u:04X}")).collect()
}

/// A text string as UTF-16BE with a byte order mark, as a hex string token.
fn utf16_token(text: &str) -> String {
    format!("<FEFF{}>", hex_utf16(text))
}

/// Two pages. Page 1 has the secret in its text, a form field value, a link URI and a tagged `/ActualText`; the document has it in
/// `/Info /Title` and in XMP. Page 2 says something else.
fn fixture() -> Vec<u8> {
    let mut builder = PdfBuilder::new();
    let first = text_line(24, 72, 700, &format!("Account {SECRET} here"));
    let second = text_line(24, 72, 700, "Page two stays");
    add_pages(
        &mut builder,
        &[
            Page::new(&first).with("/Annots [100 0 R 101 0 R] /StructParents 0"),
            Page::new(&second),
        ],
    );
    let xmp = format!("<?xpacket begin='x'?><x:xmpmeta><dc:title>{SECRET}</dc:title></x:xmpmeta><?xpacket end='w'?>");
    builder
        .object(
            100,
            &format!(
                "<< /Type /Annot /Subtype /Widget /FT /Tx /T (acct) /V ({SECRET}) /Rect [72 600 272 620] /P {} 0 R >>",
                page_id(0)
            ),
        )
        .object(
            101,
            &format!(
                "<< /Type /Annot /Subtype /Link /Rect [72 500 272 520] /A << /S /URI /URI (https://example.com/{SECRET}) >> /P {} 0 R >>",
                page_id(0)
            ),
        )
        .object(
            102,
            &format!(
                "<< /Type /StructElem /S /P /P 103 0 R /Pg {} 0 R /ActualText {} >>",
                page_id(0),
                utf16_token(SECRET)
            ),
        )
        .object(
            103,
            "<< /Type /StructTreeRoot /K [102 0 R] >>",
        )
        .object(104, &format!("<< /Title ({SECRET}) /Producer (fixture) >>"))
        .stream(105, "/Type /Metadata /Subtype /XML", xmp.as_bytes())
        // Document-level places the text can hide: a bookmark, named JavaScript, an embedded file, a page label.
        .object(106, "<< /Type /Outlines /First 107 0 R /Last 107 0 R /Count 1 >>")
        .object(
            107,
            &format!("<< /Title ({SECRET}) /Parent 106 0 R /Dest [{} 0 R /Fit] >>", page_id(0)),
        )
        .object(108, &format!("<< /S /JavaScript /JS (app.alert('{SECRET}')) >>"))
        .object(
            109,
            &format!("<< /Type /Filespec /F (a.txt) /EF << /F 110 0 R >> /Desc ({SECRET}) >>"),
        )
        .stream(110, "/Type /EmbeddedFile", format!("attached {SECRET}").as_bytes())
        .object(
            1,
            &format!(
                "<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [100 0 R] >> \
                 /StructTreeRoot 103 0 R /MarkInfo << /Marked true >> /Metadata 105 0 R \
                 /Outlines 106 0 R /PageLabels << /Nums [0 << /P ({SECRET}) >>] >> \
                 /Names << /JavaScript << /Names [(boot) 108 0 R] >> /EmbeddedFiles << /Names [(a.txt) 109 0 R] >> >> \
                 /OpenAction 108 0 R >>"
            ),
        )
        .trailer("/Info 104 0 R /ID [<00112233445566778899AABBCCDDEEFF> <00112233445566778899AABBCCDDEEFF>]");
    builder.finish(1)
}

/// Where in the text layer of page `page` the secret is, as `(x, y, w, h)` page-space boxes per hit.
fn hits(state: &AppState, id: DocumentId, page: PageId) -> Vec<[f32; 4]> {
    let layer = state.text_layer(id, page).unwrap();
    let units: Vec<u16> = layer.text.encode_utf16().collect();
    let needle: Vec<u16> = SECRET.encode_utf16().collect();
    let mut found = Vec::new();
    let mut at = 0;
    while at + needle.len() <= units.len() {
        if units[at..at + needle.len()] == needle[..] {
            let mut rect = [f32::MAX, f32::MAX, f32::MIN, f32::MIN];
            for unit in at..at + needle.len() {
                let b = &layer.boxes[unit * 4..unit * 4 + 4];
                rect[0] = rect[0].min(b[0]);
                rect[1] = rect[1].min(b[1]);
                rect[2] = rect[2].max(b[0] + b[2]);
                rect[3] = rect[3].max(b[1] + b[3]);
            }
            found.push([rect[0], rect[1], rect[2] - rect[0], rect[3] - rect[1]]);
            at += needle.len();
        } else {
            at += 1;
        }
    }
    found
}

fn mark_command(page: u32, hits: &[[f32; 4]]) -> DocCommand {
    let marks: Vec<_> = hits
        .iter()
        .map(|[x, y, w, h]| {
            json!({
                "pageId": page, "source": "text",
                "quads": [[{"x": x, "y": y}, {"x": x + w, "y": y}, {"x": x, "y": y + h}, {"x": x + w, "y": y + h}]]
            })
        })
        .collect();
    serde_json::from_value(json!({"type": "markRedactions", "marks": marks})).unwrap()
}

fn find(haystack: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty() && haystack.windows(needle.len()).any(|w| w == needle)
}

/// Every spelling of the secret: PDFDocEncoding (= ASCII here), UTF-16BE (plain, as a hex string), hex of both, either case.
fn spellings() -> Vec<Vec<u8>> {
    let ascii = SECRET.as_bytes().to_vec();
    let utf16: Vec<u8> = SECRET.encode_utf16().flat_map(u16::to_be_bytes).collect();
    let hex = |bytes: &[u8]| -> String { bytes.iter().map(|b| format!("{b:02X}")).collect() };
    let mut all = vec![ascii.clone(), utf16.clone()];
    for bytes in [&ascii, &utf16] {
        all.push(hex(bytes).into_bytes());
        all.push(hex(bytes).to_lowercase().into_bytes());
    }
    all
}

/// The facts of the saved file; fails if the secret is in it in any spelling (raw, in a string, in a stream stored or inflated).
fn audit_clean(bytes: &[u8]) -> redact::Audit {
    let audit = redact::audit(bytes, &spellings()).unwrap();
    assert!(
        audit.leaks.is_empty(),
        "the secret is in: {:?}",
        audit.leaks
    );
    audit
}

#[test]
fn redacted_text_is_not_extractable_after_save() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("d4");
    let bytes = fixture();
    // The fixture does have the secret in every place the test is about.
    assert!(find(&bytes, SECRET.as_bytes()));
    let path = scratch.file("secret.pdf");
    std::fs::write(&path, &bytes).unwrap();
    let id = state.open_path(path.clone()).unwrap().expect("loaded").id;

    let found = hits(state, id, PageId::new(0));
    assert_eq!(found.len(), 1, "the text layer has the secret once");
    assert!(hits(state, id, PageId::new(1)).is_empty());
    let marked = state.apply_command(id, mark_command(0, &found)).unwrap();
    assert_eq!(marked.upserted.len(), 1);
    // Marks are model state: saving with only marks writes none of them and no redaction.
    let opts = RedactOptions {
        pages: None,
        remove_metadata: true,
    };

    let JobEvent::Done {
        changes, warnings, ..
    } = run_redaction(state, id, &opts)
    else {
        panic!("the redaction job did not finish");
    };
    let changes = changes.expect("the job reports its change set");
    assert!(
        warnings.is_empty(),
        "metadata and hidden data go too: {warnings:?}"
    );
    assert_eq!(changes.history.undo_label.as_deref(), Some("redact.apply"));
    let slots = changes.pages.as_ref().expect("the page list changed");
    assert_eq!((slots[0].origin, slots[0].rev), ("redacted", 1));
    assert_eq!((slots[1].origin, slots[1].rev), ("file", 0));
    // The redacted page has no text for PDFium, and the other one keeps it.
    assert!(!state
        .text_layer(id, PageId::new(0))
        .unwrap()
        .text
        .contains(SECRET));
    assert!(state
        .text_layer(id, PageId::new(1))
        .unwrap()
        .text
        .contains("Page two stays"));

    let saved = state.save_in_place(id, SaveAck::default()).unwrap();
    assert_eq!(saved.mode, SaveMode::Full);
    assert!(!saved.backup_created);

    let out = std::fs::read(&path).unwrap();
    let audit = audit_clean(&out);
    assert_eq!(audit.pages, 2);
    assert!(!audit.has_info, "no /Info");
    assert!(!audit.has_metadata, "no /Metadata");
    assert!(!audit.has_structure, "no structure tree");
    assert!(
        !audit.has_hidden_data,
        "no bookmarks, names, labels or open action"
    );
    assert_eq!(audit.xref_sections, 1, "one xref section");
    assert!(!audit.has_prev);
    let first_id = audit.id.expect("a new /ID");
    assert_ne!(
        first_id,
        vec![
            0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xAA, 0xBB, 0xCC, 0xDD,
            0xEE, 0xFF
        ]
    );

    // PDFium on the saved file: nothing on page 1, page 2 intact.
    assert!(!state
        .text_layer(id, PageId::new(0))
        .unwrap()
        .text
        .contains(SECRET));
    assert!(state
        .text_layer(id, PageId::new(1))
        .unwrap()
        .text
        .contains("Page two stays"));
    // The page the raster left is the page of the original: its size and no annotations.
    assert!(state
        .list_annotations(id, PageId::new(0))
        .unwrap()
        .is_empty());
}

#[test]
fn undo_brings_the_page_and_its_marks_back_and_cancel_free_failures_change_nothing() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("undo");
    let path = scratch.file("a.pdf");
    std::fs::write(&path, fixture()).unwrap();
    let id = state.open_path(path).unwrap().expect("loaded").id;

    // Nothing marked: the job is refused before it starts.
    let jobs = Arc::new(JobRegistry::new());
    let (sender, _receiver) = mpsc::channel();
    let refused = state.start_redaction(
        &jobs,
        id,
        &RedactOptions {
            pages: None,
            remove_metadata: false,
        },
        Arc::new(Collect(Mutex::new(sender))),
    );
    assert!(refused.is_err());

    let before = state.list_annotations(id, PageId::new(0)).unwrap().len();
    let found = hits(state, id, PageId::new(0));
    state.apply_command(id, mark_command(0, &found)).unwrap();
    let event = run_redaction(
        state,
        id,
        &RedactOptions {
            pages: Some(vec![PageId::new(0)]),
            remove_metadata: false,
        },
    );
    assert!(matches!(event, JobEvent::Done { .. }));
    assert!(!state
        .text_layer(id, PageId::new(0))
        .unwrap()
        .text
        .contains(SECRET));
    let undone = state.undo(id).unwrap();
    assert_eq!(undone.pages.unwrap()[0].origin, "file");
    assert!(state
        .text_layer(id, PageId::new(0))
        .unwrap()
        .text
        .contains(SECRET));
    assert_eq!(
        state.list_annotations(id, PageId::new(0)).unwrap().len(),
        before + 1,
        "the file annotations and the mark come back"
    );
    let redone = state.redo(id).unwrap();
    assert_eq!(redone.pages.unwrap()[0].origin, "redacted");
}

#[test]
fn a_redacted_r4_file_is_saved_again_and_opens_with_the_same_password() {
    use sheer_lib::commands::Opened;
    use sheer_lib::pdfwrite::crypt;
    let Some(state) = state() else { return };
    let scratch = Scratch::new("r4");
    let bytes = crypt::testing::encrypt_legacy(&fixture(), 4, "user4", "owner4").unwrap();
    let path = scratch.file("r4.pdf");
    std::fs::write(&path, &bytes).unwrap();
    let id = match state.open_outcome(path.clone()).unwrap() {
        Opened::Locked { id, .. } => {
            state
                .unlock(id, zeroize::Zeroizing::new("user4".to_owned()))
                .unwrap();
            id
        }
        _ => panic!("the R4 file asks for its password"),
    };
    let found = hits(state, id, PageId::new(0));
    assert_eq!(found.len(), 1);
    state.apply_command(id, mark_command(0, &found)).unwrap();
    let opts = RedactOptions {
        pages: None,
        remove_metadata: true,
    };
    assert!(matches!(
        run_redaction(state, id, &opts),
        JobEvent::Done { .. }
    ));
    let ack = SaveAck {
        rewrite_encrypted: true,
        ..SaveAck::default()
    };
    state.save_in_place(id, ack).unwrap();

    let written = std::fs::read(&path).unwrap();
    assert!(crypt::testing::is_encrypted(&written));
    // The same password still opens the file (the key of R4 comes from the first `/ID` string), a wrong one does not.
    assert!(crypt::read_protection_with(&written, Some("user4")).is_ok());
    assert!(crypt::read_protection_with(&written, Some("wrong")).is_err());
    let again = scratch.file("again.pdf");
    std::fs::write(&again, &written).unwrap();
    let Opened::Locked { id: second, .. } = state.open_outcome(again).unwrap() else {
        panic!("the saved file is still protected");
    };
    state
        .unlock(second, zeroize::Zeroizing::new("user4".to_owned()))
        .unwrap();
    assert!(state
        .text_layer(second, PageId::new(1))
        .unwrap()
        .text
        .contains("Page two stays"));
    assert!(!state
        .text_layer(second, PageId::new(0))
        .unwrap()
        .text
        .contains(SECRET));
}

/// Marks and a save: marks are model state and never reach the file, so the text is still there (marks are not redaction).
#[test]
fn a_save_with_only_marks_writes_no_mark_and_leaves_the_text() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("marks");
    let bytes = fixture();
    let path = scratch.file("m.pdf");
    std::fs::write(&path, &bytes).unwrap();
    let id = state.open_path(path.clone()).unwrap().expect("loaded").id;
    let found = hits(state, id, PageId::new(0));
    state.apply_command(id, mark_command(0, &found)).unwrap();
    state.save_in_place(id, SaveAck::default()).unwrap();
    let out = std::fs::read(&path).unwrap();
    let audit = redact::audit(&out, &[b"Redact".to_vec(), b"redactMark".to_vec()]).unwrap();
    assert!(
        audit.leaks.is_empty(),
        "a mark was written: {:?}",
        audit.leaks
    );
    assert!(
        find(&out, SECRET.as_bytes()),
        "the secret is still in the file"
    );
    assert!(state
        .text_layer(id, PageId::new(0))
        .unwrap()
        .text
        .contains(SECRET));
}

/// Without removeMetadata the page content goes, the job says that bookmarks and the like were kept, and they are in the file.
#[test]
fn without_remove_metadata_hidden_data_stays_and_the_job_says_so() {
    use sheer_lib::pdfwrite::produce::Warning;
    let Some(state) = state() else { return };
    let scratch = Scratch::new("kept");
    let path = scratch.file("k.pdf");
    std::fs::write(&path, fixture()).unwrap();
    let id = state.open_path(path.clone()).unwrap().expect("loaded").id;
    let found = hits(state, id, PageId::new(0));
    state.apply_command(id, mark_command(0, &found)).unwrap();
    let opts = RedactOptions {
        pages: None,
        remove_metadata: false,
    };
    let JobEvent::Done { warnings, .. } = run_redaction(state, id, &opts) else {
        panic!("the redaction job did not finish");
    };
    assert_eq!(warnings, vec![Warning::HiddenDataKept]);
    state.save_in_place(id, SaveAck::default()).unwrap();
    let out = std::fs::read(&path).unwrap();
    // What was on the page is gone: its text, the link, the field.
    let page_things: Vec<Vec<u8>> = ["Account", "example.com", "acct"]
        .iter()
        .map(|t| t.as_bytes().to_vec())
        .collect();
    let gone = redact::audit(&out, &page_things).unwrap();
    assert!(gone.leaks.is_empty(), "page content left: {:?}", gone.leaks);
    // The document-level data was kept on purpose, so the secret is still in it.
    let kept = redact::audit(&out, &spellings()).unwrap();
    assert!(!kept.leaks.is_empty());
    assert!(kept.has_hidden_data && kept.has_info);
    assert!(!kept.has_structure, "the structure tree goes either way");
    assert!(!state
        .text_layer(id, PageId::new(0))
        .unwrap()
        .text
        .contains(SECRET));
}

/// A redacting save deletes the backups of the file it saves over (a backup is a copy of what was taken out).
#[test]
fn a_redacting_save_deletes_the_backups_of_its_target() {
    use sheer_lib::storage::backup;
    let Some(state) = state() else { return };
    let scratch = Scratch::new("backups");
    let data = scratch.file("data");
    let state = state.clone().with_data_dir(data.clone());
    let bytes = fixture();
    let path = scratch.file("b.pdf");
    std::fs::write(&path, &bytes).unwrap();
    let id = state.open_path(path.clone()).unwrap().expect("loaded").id;
    let canonical = std::fs::canonicalize(&path).unwrap();
    let folder = data.join("backups");
    let seeded = backup::write_backup(&folder, "20261003T120000Z", &canonical, &bytes).unwrap();
    let other = backup::write_backup(
        &folder,
        "20261003T120000Z",
        &scratch.file("other.pdf"),
        &bytes,
    )
    .unwrap();
    assert!(seeded.exists());
    let found = hits(&state, id, PageId::new(0));
    state.apply_command(id, mark_command(0, &found)).unwrap();
    let opts = RedactOptions {
        pages: None,
        remove_metadata: true,
    };
    assert!(matches!(
        run_redaction(&state, id, &opts),
        JobEvent::Done { .. }
    ));
    let saved = state.save_in_place(id, SaveAck::default()).unwrap();
    assert!(!saved.backup_created);
    assert!(!seeded.exists(), "the backup of the target is gone");
    assert!(other.exists(), "another file's backup is not touched");
}
