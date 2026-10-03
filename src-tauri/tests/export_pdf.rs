//! Export a copy (ADR-049 §5) against the real PDFium, through the same `AppState` the command uses: each annotations mode on a document
//! with unsaved edits, removal of the metadata, the open file and document untouched, an encrypted copy that opens with the same
//! password, restricted documents, and a target that is the open document. Skips when the PDFium library is not fetched (fails
//! instead when `CI` is set).

#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use std::path::PathBuf;
use std::sync::mpsc;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::Duration;

use serde_json::json;
use sheer_lib::commands::jobs::{EventSink, JobEvent};
use sheer_lib::commands::save::SaveAck;
use sheer_lib::commands::{AppState, Opened};
use sheer_lib::documents::{DocumentId, DocumentInfo};
use sheer_lib::engine::{self, Engine};
use sheer_lib::error::ErrorCode;
use sheer_lib::model::command::DocCommand;
use sheer_lib::model::protection::{Permission, PermissionSet};
use sheer_lib::pdfwrite::crypt;
use sheer_lib::pdfwrite::export::{AnnotationsMode, PdfExportOptions};
use sheer_lib::pdfwrite::load_untrusted;
use sheer_lib::pdfwrite::produce::Warning;
use sheer_lib::security::secret::{PendingProtection, Secret};
use support::fixtures::{add_pages, Page};
use support::PdfBuilder;
use zeroize::Zeroizing;

struct Scratch(PathBuf);

impl Scratch {
    fn new(name: &str) -> Self {
        let path = std::env::temp_dir().join(format!("sheer-export-{}-{name}", std::process::id()));
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
            if library.is_file() {
                return Some(AppState::new(Engine::start(library)));
            }
            assert!(
                std::env::var_os("CI").is_none(),
                "PDFium is missing and CI is set: fetch it before the tests"
            );
            None
        })
        .as_ref()
}

/// The jobs of the app are two at a time: the tests of this file take turns.
fn serial() -> MutexGuard<'static, ()> {
    static LOCK: Mutex<()> = Mutex::new(());
    LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

struct Collect(Mutex<mpsc::Sender<JobEvent>>);

impl EventSink for Collect {
    fn send(&self, event: JobEvent) {
        let _ = self.0.lock().unwrap().send(event);
    }
}

/// Runs the export to `target` and answers the last message of the job.
fn export(
    state: &AppState,
    id: DocumentId,
    opts: PdfExportOptions,
    ack: SaveAck,
    target: &std::path::Path,
) -> Result<JobEvent, sheer_lib::error::AppError> {
    let (sender, receiver) = mpsc::channel();
    let sink: Arc<dyn EventSink> = Arc::new(Collect(Mutex::new(sender)));
    state.start_export_pdf_to(id, &opts, ack, target, sink)?;
    loop {
        match receiver.recv_timeout(Duration::from_secs(60)).unwrap() {
            JobEvent::Progress { .. } => {}
            other => return Ok(other),
        }
    }
}

fn done_warnings(event: JobEvent) -> Vec<Warning> {
    match event {
        JobEvent::Done { warnings, .. } => warnings,
        other => panic!("the export did not finish: {other:?}"),
    }
}

fn opts(annotations: AnnotationsMode, remove_metadata: bool) -> PdfExportOptions {
    PdfExportOptions {
        annotations,
        remove_metadata,
    }
}

fn ack() -> SaveAck {
    SaveAck {
        rewrite_encrypted: true,
        ..SaveAck::default()
    }
}

fn plain() -> Vec<u8> {
    let mut builder = PdfBuilder::new();
    add_pages(&mut builder, &[Page::new(""), Page::new("")]);
    builder.object(90, "<< /Title (Secret title) /Author (Somebody) >>");
    builder.trailer("/Info 90 0 R");
    builder.object(1, "<< /Type /Catalog /Pages 2 0 R >>");
    builder.finish(1)
}

fn open(
    state: &AppState,
    scratch: &Scratch,
    name: &str,
    bytes: &[u8],
    password: Option<&str>,
) -> DocumentInfo {
    let path = scratch.file(name);
    std::fs::write(&path, bytes).unwrap();
    match state.open_outcome(path).unwrap() {
        Opened::Ready(info) => info,
        Opened::Locked { id, .. } => state
            .unlock(id, Zeroizing::new(password.expect("a password").to_owned()))
            .unwrap(),
        Opened::Pending => panic!("pending"),
    }
}

fn note(state: &AppState, id: DocumentId) {
    let command: DocCommand = serde_json::from_value(json!({"type": "createAnnotation", "draft": {
        "pageId": 0, "kind": "note", "color": [255, 235, 0],
        "at": {"x": 10.0, "y": 10.0}, "icon": "comment", "contents": "hello"
    }}))
    .unwrap();
    state.apply_command(id, command).unwrap();
}

/// The annotation subtypes of the first page.
fn subtypes(bytes: &[u8]) -> Vec<String> {
    let doc = load_untrusted(bytes).unwrap();
    let page = *doc.get_pages().values().next().unwrap();
    doc.get_page_annotations(page)
        .unwrap_or_default()
        .iter()
        .filter_map(|annot| {
            annot
                .get(b"Subtype")
                .ok()
                .and_then(|kind| kind.as_name().ok())
                .map(|kind| String::from_utf8_lossy(kind).into_owned())
        })
        .collect()
}

fn secret(text: &str) -> Secret {
    Secret::new(text).unwrap()
}

fn r6(open: Option<&str>, owner: &str, allow: &[Permission]) -> Vec<u8> {
    let pending = PendingProtection::Protect {
        open: open.map(secret),
        owner: secret(owner),
        allow: PermissionSet::from_list(allow),
    };
    crypt::encrypt_bytes(&plain(), &pending).unwrap()
}

#[test]
fn a_clean_document_is_copied_as_a_new_file_and_nothing_else_changes() {
    let Some(state) = state() else { return };
    let _turn = serial();
    let scratch = Scratch::new("clean");
    let bytes = plain();
    let info = open(state, &scratch, "a.pdf", &bytes, None);
    let target = scratch.file("a copy.pdf");
    let event = export(
        state,
        info.id,
        opts(AnnotationsMode::Keep, false),
        SaveAck::default(),
        &target,
    )
    .unwrap();
    assert!(done_warnings(event).is_empty());
    let copy = std::fs::read(&target).unwrap();
    assert_eq!(load_untrusted(&copy).unwrap().get_pages().len(), 2);
    // A whole new file with a new /ID; the open file is as it was and the document is still the open one.
    let id = |bytes: &[u8]| {
        load_untrusted(bytes)
            .unwrap()
            .trailer
            .get(b"ID")
            .ok()
            .cloned()
    };
    assert!(id(&copy).is_some());
    assert_ne!(id(&copy), id(&bytes));
    assert_eq!(std::fs::read(scratch.file("a.pdf")).unwrap(), bytes);
    assert!(!state.has_unsaved_changes(info.id));
}

#[test]
fn each_annotations_mode_applies_to_the_unsaved_state_and_the_file_on_disk_stays() {
    let Some(state) = state() else { return };
    let _turn = serial();
    let scratch = Scratch::new("modes");
    let bytes = plain();
    let info = open(state, &scratch, "b.pdf", &bytes, None);
    note(state, info.id);
    assert!(state.has_unsaved_changes(info.id));

    let keep = scratch.file("keep.pdf");
    done_warnings(
        export(
            state,
            info.id,
            opts(AnnotationsMode::Keep, false),
            SaveAck::default(),
            &keep,
        )
        .unwrap(),
    );
    assert_eq!(subtypes(&std::fs::read(&keep).unwrap()), vec!["Text"]);

    let flatten = scratch.file("flatten.pdf");
    done_warnings(
        export(
            state,
            info.id,
            opts(AnnotationsMode::Flatten, false),
            SaveAck::default(),
            &flatten,
        )
        .unwrap(),
    );
    assert!(subtypes(&std::fs::read(&flatten).unwrap()).is_empty());

    let remove = scratch.file("remove.pdf");
    done_warnings(
        export(
            state,
            info.id,
            opts(AnnotationsMode::Remove, false),
            SaveAck::default(),
            &remove,
        )
        .unwrap(),
    );
    assert!(subtypes(&std::fs::read(&remove).unwrap()).is_empty());

    // The open document is as it was: still unsaved, the file on disk untouched, and no stray file next to it.
    assert!(state.has_unsaved_changes(info.id));
    assert_eq!(std::fs::read(scratch.file("b.pdf")).unwrap(), bytes);
    let mut names: Vec<String> = std::fs::read_dir(&scratch.0)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    assert_eq!(names, ["b.pdf", "flatten.pdf", "keep.pdf", "remove.pdf"]);
}

#[test]
fn metadata_is_removed_only_when_asked() {
    let Some(state) = state() else { return };
    let _turn = serial();
    let scratch = Scratch::new("meta");
    let info = open(state, &scratch, "m.pdf", &plain(), None);
    let with = scratch.file("with.pdf");
    let without = scratch.file("without.pdf");
    done_warnings(
        export(
            state,
            info.id,
            opts(AnnotationsMode::Keep, false),
            SaveAck::default(),
            &with,
        )
        .unwrap(),
    );
    done_warnings(
        export(
            state,
            info.id,
            opts(AnnotationsMode::Keep, true),
            SaveAck::default(),
            &without,
        )
        .unwrap(),
    );
    let text = |path: &PathBuf| String::from_utf8_lossy(&std::fs::read(path).unwrap()).into_owned();
    assert!(text(&with).contains("Secret title"));
    let stripped = text(&without);
    assert!(!stripped.contains("Secret title") && !stripped.contains("Somebody"));
    assert!(load_untrusted(&std::fs::read(&without).unwrap())
        .unwrap()
        .trailer
        .get(b"Info")
        .is_err());
}

#[test]
fn the_open_document_is_never_the_target() {
    let Some(state) = state() else { return };
    let _turn = serial();
    let scratch = Scratch::new("target");
    let bytes = plain();
    let info = open(state, &scratch, "t.pdf", &bytes, None);
    let error = export(
        state,
        info.id,
        opts(AnnotationsMode::Keep, false),
        SaveAck::default(),
        &scratch.file("t.pdf"),
    )
    .unwrap_err();
    assert_eq!(error.code(), ErrorCode::InvalidArgument);
    assert_eq!(std::fs::read(scratch.file("t.pdf")).unwrap(), bytes);
}

#[test]
fn an_encrypted_copy_asks_first_and_opens_with_the_same_password() {
    let Some(state) = state() else { return };
    let _turn = serial();
    let scratch = Scratch::new("encrypted");
    let info = open(
        state,
        &scratch,
        "e.pdf",
        &r6(Some("user-pw"), "owner-pw", &[Permission::Print]),
        Some("user-pw"),
    );
    let target = scratch.file("e copy.pdf");
    let refused = export(
        state,
        info.id,
        opts(AnnotationsMode::Keep, false),
        SaveAck::default(),
        &target,
    )
    .unwrap_err();
    assert_eq!(refused.code(), ErrorCode::NeedsConfirmation);
    assert!(!target.exists());

    done_warnings(
        export(
            state,
            info.id,
            opts(AnnotationsMode::Keep, false),
            ack(),
            &target,
        )
        .unwrap(),
    );
    let copy = std::fs::read(&target).unwrap();
    assert!(crypt::testing::is_encrypted(&copy));
    // Without the password it asks; with it, it opens as the same document.
    let Opened::Locked { id, .. } = state.open_outcome(target.clone()).unwrap() else {
        panic!("the copy must ask for the password");
    };
    let reopened = state
        .unlock(id, Zeroizing::new("user-pw".to_owned()))
        .unwrap();
    assert_eq!(reopened.page_count, 2);
    assert!(reopened.flags.encrypted);
}

#[test]
fn a_restricted_document_is_copied_but_not_changed() {
    let Some(state) = state() else { return };
    let _turn = serial();
    let scratch = Scratch::new("restricted");
    let info = open(
        state,
        &scratch,
        "r.pdf",
        &r6(Some("user-pw"), "owner-pw", &[Permission::Print]),
        Some("user-pw"),
    );
    assert!(info.flags.permissions.is_some());
    let target = scratch.file("r copy.pdf");
    for refused in [
        opts(AnnotationsMode::Flatten, false),
        opts(AnnotationsMode::Remove, false),
        opts(AnnotationsMode::Keep, true),
    ] {
        let error = export(state, info.id, refused, ack(), &target).unwrap_err();
        assert_eq!(error.code(), ErrorCode::ReadOnly);
    }
    assert!(!target.exists());
    // A plain copy needs no edit right.
    done_warnings(
        export(
            state,
            info.id,
            opts(AnnotationsMode::Keep, false),
            ack(),
            &target,
        )
        .unwrap(),
    );
    assert!(target.exists());
}

#[test]
fn a_signed_document_warns_that_its_signatures_go() {
    let Some(state) = state() else { return };
    let _turn = serial();
    let scratch = Scratch::new("signed");
    let info = open(state, &scratch, "s.pdf", &support::fixtures::signed(), None);
    assert!(info.flags.signed);
    let warnings = done_warnings(
        export(
            state,
            info.id,
            opts(AnnotationsMode::Remove, false),
            SaveAck::default(),
            &scratch.file("s copy.pdf"),
        )
        .unwrap(),
    );
    assert!(warnings.contains(&Warning::SignaturesRemoved));
}
