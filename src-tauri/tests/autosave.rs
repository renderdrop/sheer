//! Crash-safe autosave and recovery (ADR-053 section 2). The storage tests run without PDFium; the ones with documents skip when the
//! PDFium library is not fetched (and fail instead when `CI` is set).

#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

use serde_json::json;
use sheer_lib::commands::save::SaveAck;
use sheer_lib::commands::{AppState, Opened};
use sheer_lib::documents::DocumentId;
use sheer_lib::engine::{self, Engine};
use sheer_lib::error::ErrorCode;
use sheer_lib::model::command::DocCommand;
use sheer_lib::model::protection::{Permission, ProtectOptions};
use sheer_lib::pdfwrite::load_untrusted;
use sheer_lib::security::secret::Secret;
use sheer_lib::storage::autosave::{Autosave, AutosaveStatus, OriginalState, Snapshot};
use support::fixtures::{add_pages, Page};
use support::PdfBuilder;

struct Scratch(PathBuf);

impl Scratch {
    fn new(name: &str) -> Self {
        let path =
            std::env::temp_dir().join(format!("sheer-autosave-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }

    fn file(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }

    fn app_data(&self) -> PathBuf {
        self.0.join("appdata")
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn id(n: u32) -> DocumentId {
    serde_json::from_str(&n.to_string()).unwrap()
}

fn plain() -> Vec<u8> {
    let mut builder = PdfBuilder::new();
    add_pages(&mut builder, &[Page::new(""), Page::new("")]);
    builder.object(1, "<< /Type /Catalog /Pages 2 0 R >>");
    builder.finish(1)
}

fn annotation_count(bytes: &[u8]) -> usize {
    let doc = load_untrusted(bytes).unwrap();
    let page = *doc.get_pages().values().next().unwrap();
    doc.get_page_annotations(page).unwrap_or_default().len()
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
}

// --- storage only ---

fn put_record(session: &Path, n: u32, manifest: &str, pdf: Option<&[u8]>) {
    std::fs::create_dir_all(session).unwrap();
    std::fs::write(session.join("lock"), b"").unwrap();
    std::fs::write(session.join(format!("{n}.json")), manifest).unwrap();
    if let Some(pdf) = pdf {
        std::fs::write(session.join(format!("{n}.pdf")), pdf).unwrap();
    }
}

fn manifest(saved_at: u64, name: &str) -> String {
    json!({"v": 1, "original": null, "displayName": name, "pageCount": 3, "savedAt": saved_at, "appVersion": "0"})
        .to_string()
}

fn sessions(app_data: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(app_data.join("autosave"))
        .map(|entries| {
            // Session directories only: the shown-records ledger (shown.json) sits beside them (F21.2).
            entries
                .flatten()
                .filter(|e| e.path().is_dir())
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    names
}

#[test]
fn a_session_that_is_alive_is_not_recovered_and_a_dead_one_is() {
    let scratch = Scratch::new("live-dead");
    let first = Autosave::start(&scratch.app_data()).unwrap();
    first
        .write(&Snapshot {
            id: id(4),
            rev: 1,
            bytes: b"%PDF-1.4 live",
            display_name: "live.pdf",
            original: None,
            page_count: 1,
        })
        .unwrap();
    let second = Autosave::start(&scratch.app_data()).unwrap();
    assert!(
        second.list().is_empty(),
        "the first session still holds its lock"
    );
    drop(second);
    drop(first);
    let third = Autosave::start(&scratch.app_data()).unwrap();
    let listed = third.list();
    assert_eq!(listed.len(), 1);
    assert_eq!(
        (listed[0].display_name.as_str(), listed[0].page_count),
        ("live.pdf", 1)
    );
}

#[test]
fn the_startup_sweeps_the_stale_temp_files_of_a_dead_session_and_keeps_fresh_ones() {
    let scratch = Scratch::new("temp-sweep");
    let root = scratch.app_data().join("autosave");
    let dead = root.join("dead");
    put_record(
        &dead,
        1,
        &manifest(now_secs() - 60, "a.pdf"),
        Some(b"%PDF-1.4 a"),
    );
    // The names write_atomic gives: a crashed run (other pid) left one old and one fresh temp file.
    let stale = dead.join(".1.pdf.4242.3.tmp");
    let fresh = dead.join(".1.json.4242.4.tmp");
    std::fs::write(&stale, b"half").unwrap();
    std::fs::write(&fresh, b"half").unwrap();
    std::fs::File::options()
        .write(true)
        .open(&stale)
        .unwrap()
        .set_modified(std::time::SystemTime::now() - Duration::from_secs(2 * 60 * 60))
        .unwrap();
    let auto = Autosave::start(&scratch.app_data()).unwrap();
    assert_eq!(auto.list().len(), 1);
    assert!(!stale.exists(), "an old temp file is a leftover");
    assert!(fresh.exists(), "a recent one may belong to a running write");
    assert!(dead.join("1.pdf").is_file() && dead.join("1.json").is_file());
}

#[test]
fn records_older_than_the_retention_are_swept_and_fresh_ones_kept() {
    let scratch = Scratch::new("retention");
    let root = scratch.app_data().join("autosave");
    let day = 24 * 60 * 60;
    put_record(
        &root.join("old"),
        1,
        &manifest(now_secs() - 31 * day, "old.pdf"),
        Some(b"%PDF-1.4 old"),
    );
    put_record(
        &root.join("recent"),
        3,
        &manifest(now_secs() - 29 * day, "recent.pdf"),
        Some(b"%PDF-1.4 recent"),
    );
    put_record(
        &root.join("fresh"),
        2,
        &manifest(now_secs() - 60, "fresh.pdf"),
        Some(b"%PDF-1.4 fresh"),
    );
    let auto = Autosave::start(&scratch.app_data()).unwrap();
    let names: Vec<String> = auto.list().into_iter().map(|v| v.display_name).collect();
    assert_eq!(names, ["fresh.pdf", "recent.pdf"]);
    assert!(!root.join("old").exists(), "an emptied dead session goes");
    assert!(root.join("fresh").join("2.pdf").is_file());
}

#[test]
fn a_corrupt_record_is_quarantined_and_never_stops_the_startup() {
    let scratch = Scratch::new("corrupt");
    let root = scratch.app_data().join("autosave");
    let session = root.join("dead");
    put_record(&session, 1, "{ this is not json", Some(b"%PDF-1.4"));
    put_record(&session, 2, &manifest(now_secs(), "no-pdf.pdf"), None);
    put_record(
        &session,
        3,
        r#"{"v":9,"original":null,"displayName":"x","pageCount":1,"savedAt":1,"appVersion":"0"}"#,
        Some(b"%PDF-1.4"),
    );
    put_record(&session, 4, &" ".repeat(70 * 1024), Some(b"%PDF-1.4"));
    put_record(
        &session,
        5,
        &manifest(now_secs(), "good.pdf"),
        Some(b"%PDF-1.4 g"),
    );
    let auto = Autosave::start(&scratch.app_data()).unwrap();
    let names: Vec<String> = auto.list().into_iter().map(|v| v.display_name).collect();
    assert_eq!(names, ["good.pdf"]);
    let quarantined = std::fs::read_dir(root.join("quarantine")).unwrap().count();
    assert!(
        quarantined >= 4,
        "the broken records are kept apart: {quarantined}"
    );
    assert!(session.join("5.pdf").is_file());
}

#[test]
fn discard_and_discard_all_delete_records_and_an_unknown_id_is_not_found() {
    let scratch = Scratch::new("discard");
    let root = scratch.app_data().join("autosave");
    put_record(
        &root.join("dead"),
        1,
        &manifest(now_secs(), "a.pdf"),
        Some(b"%PDF-1.4 a"),
    );
    put_record(
        &root.join("dead"),
        2,
        &manifest(now_secs() - 5, "b.pdf"),
        Some(b"%PDF-1.4 b"),
    );
    put_record(
        &root.join("dead"),
        3,
        &manifest(now_secs() - 9, "c.pdf"),
        Some(b"%PDF-1.4 c"),
    );
    let auto = Autosave::start(&scratch.app_data()).unwrap();
    let listed = auto.list();
    assert_eq!(
        listed
            .iter()
            .map(|v| v.display_name.as_str())
            .collect::<Vec<_>>(),
        ["a.pdf", "b.pdf", "c.pdf"],
        "newest first"
    );
    auto.discard(listed[0].id).unwrap();
    assert!(!root.join("dead").join("1.pdf").exists());
    assert_eq!(
        auto.discard(listed[0].id).unwrap_err().code(),
        ErrorCode::NotFound
    );
    assert_eq!(auto.discard_all(), 2);
    assert!(auto.list().is_empty());
    assert!(!root.join("dead").join("3.json").exists());
}

#[test]
fn the_original_state_follows_the_file_and_no_path_is_listed() {
    let scratch = Scratch::new("original");
    let original = scratch.file("Taxes").join("report.pdf");
    std::fs::create_dir_all(original.parent().unwrap()).unwrap();
    std::fs::write(&original, b"%PDF-1.4 one").unwrap();
    let first = Autosave::start(&scratch.app_data()).unwrap();
    first
        .write(&Snapshot {
            id: id(1),
            rev: 1,
            bytes: b"%PDF-1.4 snap",
            display_name: "report.pdf",
            original: Some(&original),
            page_count: 2,
        })
        .unwrap();
    drop(first);
    let auto = Autosave::start(&scratch.app_data()).unwrap();
    let entry = auto.list().remove(0);
    assert_eq!(entry.original, OriginalState::Unchanged);
    std::fs::write(&original, b"%PDF-1.4 two, longer").unwrap();
    assert_eq!(auto.list()[0].original, OriginalState::Changed);
    std::fs::remove_file(&original).unwrap();
    assert_eq!(auto.list()[0].original, OriginalState::Missing);
    let shown = format!("{entry:?}");
    assert!(
        !shown.contains(scratch.0.to_string_lossy().as_ref()),
        "no path in what the UI gets: {shown}"
    );
}

// --- with documents ---

static SERIAL: Mutex<()> = Mutex::new(());

fn engine() -> Option<&'static Engine> {
    static ENGINE: OnceLock<Option<Engine>> = OnceLock::new();
    ENGINE
        .get_or_init(|| {
            let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("pdfium");
            let library = engine::library_path(&root);
            if library.is_file() {
                return Some(Engine::start(library));
            }
            assert!(
                std::env::var_os("CI").is_none(),
                "PDFium is missing and CI is set: fetch it before the tests"
            );
            eprintln!(
                "SKIPPED: PDFium is not fetched; the autosave tests with documents did not run"
            );
            None
        })
        .as_ref()
}

/// One app session on the shared engine; tests that use it run one after the other (document ids restart at 0 per state).
struct Session {
    _guard: MutexGuard<'static, ()>,
    state: AppState,
    auto: Arc<Autosave>,
}

impl Session {
    fn start(scratch: &Scratch) -> Option<Self> {
        let guard = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let engine = engine()?;
        let state = AppState::new(engine.clone());
        let auto = Arc::new(Autosave::start(&scratch.app_data()).unwrap());
        assert!(state.attach_autosave(Arc::clone(&auto)));
        Some(Self {
            _guard: guard,
            state,
            auto,
        })
    }

    fn open(&self, path: PathBuf) -> DocumentId {
        match self.state.open_outcome(path).unwrap() {
            Opened::Ready(info) => info.id,
            _ => panic!("the fixture opens without a password"),
        }
    }

    fn note(&self, doc: DocumentId) {
        let command: DocCommand =
            serde_json::from_value(json!({"type": "createAnnotation", "draft": {
                "pageId": 0, "kind": "note", "color": [255, 235, 0],
                "at": {"x": 10.0, "y": 10.0}, "icon": "comment", "contents": "hello"
            }}))
            .unwrap();
        self.state.apply_command(doc, command).unwrap();
    }

    fn record(&self, doc: DocumentId) -> PathBuf {
        self.auto.dir().join(format!("{}.pdf", doc.get()))
    }

    /// Ends the session the way a crash does: the lock is released, nothing is removed.
    fn crash(self) {
        let Self { state, auto, .. } = self;
        drop(state);
        drop(auto);
    }
}

fn write_file(scratch: &Scratch, name: &str, bytes: &[u8]) -> PathBuf {
    let path = scratch.file(name);
    std::fs::write(&path, bytes).unwrap();
    path
}

#[test]
fn a_dirty_document_is_written_after_the_debounce_as_snapshot_bytes_and_a_manifest() {
    let scratch = Scratch::new("cadence");
    let Some(s) = Session::start(&scratch) else {
        return;
    };
    let path = write_file(&scratch, "a.pdf", &plain());
    let doc = s.open(path.clone());
    let t0 = Instant::now();
    assert_eq!(
        s.state.autosave_tick(t0),
        0,
        "a clean document is not written"
    );
    s.note(doc);
    assert_eq!(s.state.autosave_tick(t0), 0, "seen, not due");
    assert_eq!(s.state.autosave_tick(t0 + Duration::from_secs(29)), 0);
    assert_eq!(s.state.autosave_tick(t0 + Duration::from_secs(31)), 1);
    let snapshot = std::fs::read(s.record(doc)).unwrap();
    assert_eq!(
        annotation_count(&snapshot),
        1,
        "the edit is in the snapshot"
    );
    assert_eq!(
        std::fs::read(&path).unwrap(),
        plain(),
        "the original is untouched"
    );
    assert_eq!(s.auto.status_of(doc), AutosaveStatus::On);
    let manifest: serde_json::Value = serde_json::from_slice(
        &std::fs::read(s.auto.dir().join(format!("{}.json", doc.get()))).unwrap(),
    )
    .unwrap();
    assert_eq!(manifest["v"], 1);
    assert_eq!(manifest["displayName"], "a.pdf");
    assert_eq!(manifest["pageCount"], 2);
    assert!(manifest["original"]["path"].is_string());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(s.record(doc))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600);
    }
    // Nothing changed: nothing more is written.
    assert_eq!(s.state.autosave_tick(t0 + Duration::from_secs(200)), 0);
    // Edits that never pause are written at the latest after the max interval.
    s.note(doc);
    let t1 = t0 + Duration::from_secs(300);
    assert_eq!(s.state.autosave_tick(t1), 0);
    s.note(doc);
    assert_eq!(s.state.autosave_tick(t1 + Duration::from_secs(20)), 0);
    s.note(doc);
    assert_eq!(s.state.autosave_tick(t1 + Duration::from_secs(40)), 0);
    s.note(doc);
    assert_eq!(s.state.autosave_tick(t1 + Duration::from_secs(60)), 0);
    s.note(doc);
    assert_eq!(s.state.autosave_tick(t1 + Duration::from_secs(120)), 1);
    // Losing focus writes what is not written yet.
    s.note(doc);
    assert_eq!(s.state.autosave_tick(t1 + Duration::from_secs(125)), 0);
    assert_eq!(s.state.autosave_flush(t1 + Duration::from_secs(126)), 1);
    s.state.close_document(doc).unwrap();
}

#[test]
fn an_encrypted_document_or_one_with_a_staged_protection_is_never_written() {
    let scratch = Scratch::new("encrypted");
    let Some(s) = Session::start(&scratch) else {
        return;
    };
    let t0 = Instant::now();
    let late = t0 + Duration::from_secs(500);

    let locked = s.open(write_file(
        &scratch,
        "locked.pdf",
        &support::fixtures::encrypted(),
    ));
    s.note(locked);
    assert_eq!(s.state.autosave_tick(t0), 0);
    assert_eq!(s.state.autosave_tick(late), 0);
    assert!(!s.record(locked).exists());
    assert_eq!(s.auto.status_of(locked), AutosaveStatus::OffEncrypted);

    let doc = s.open(write_file(&scratch, "b.pdf", &plain()));
    s.note(doc);
    assert_eq!(s.state.autosave_tick(t0), 0);
    assert_eq!(s.state.autosave_tick(t0 + Duration::from_secs(40)), 1);
    assert!(s.record(doc).is_file());
    // Staging a protection makes a snapshot an unprotected copy: the earlier one is deleted and no new one is written.
    let options = ProtectOptions {
        open_password: Some(Secret::new("open-pw").unwrap()),
        permissions_password: Some(Secret::new("owner-pw").unwrap()),
        allow: vec![Permission::Print],
    };
    s.state.stage_protection(doc, options).unwrap();
    assert_eq!(s.state.autosave_tick(late), 0);
    assert!(!s.record(doc).exists());
    assert_eq!(s.auto.status_of(doc), AutosaveStatus::OffEncrypted);
    s.state.close_document(locked).unwrap();
    s.state.close_document(doc).unwrap();
}

#[test]
fn a_save_and_a_close_delete_the_record() {
    let scratch = Scratch::new("cleanup");
    let Some(s) = Session::start(&scratch) else {
        return;
    };
    let doc = s.open(write_file(&scratch, "a.pdf", &plain()));
    let t0 = Instant::now();
    s.note(doc);
    s.state.autosave_tick(t0);
    assert_eq!(s.state.autosave_tick(t0 + Duration::from_secs(31)), 1);
    assert!(s.record(doc).is_file());
    let saved = s.state.save_in_place(doc, SaveAck::default()).unwrap();
    assert_eq!(saved.document.autosave, AutosaveStatus::Clean);
    assert!(!s.record(doc).exists() && !s.auto.dir().join(format!("{}.json", doc.get())).exists());

    s.note(doc);
    let t1 = t0 + Duration::from_secs(100);
    s.state.autosave_tick(t1);
    assert_eq!(s.state.autosave_tick(t1 + Duration::from_secs(31)), 1);
    assert_eq!(
        s.state
            .close_document_checked(doc, false)
            .unwrap_err()
            .code(),
        ErrorCode::UnsavedChanges
    );
    assert!(s.record(doc).is_file(), "a refused close keeps the record");
    s.state.close_document_checked(doc, true).unwrap();
    assert!(!s.record(doc).exists());
}

#[test]
fn a_crashed_session_is_listed_restored_as_a_recovered_document_and_saved_only_as_another_file() {
    let scratch = Scratch::new("restore");
    let original = write_file(&scratch, "report.pdf", &plain());
    let t0 = Instant::now();
    {
        let Some(s) = Session::start(&scratch) else {
            return;
        };
        let doc = s.open(original.clone());
        s.note(doc);
        s.state.autosave_tick(t0);
        assert_eq!(s.state.autosave_tick(t0 + Duration::from_secs(31)), 1);
        s.state.close_document(doc).unwrap_or(());
        // The close above deleted the record on purpose: edit again and crash with the record on disk.
        let doc = s.open(original.clone());
        s.note(doc);
        s.state.autosave_tick(t0 + Duration::from_secs(100));
        assert_eq!(s.state.autosave_tick(t0 + Duration::from_secs(140)), 1);
        s.crash();
    }

    let Some(s) = Session::start(&scratch) else {
        return;
    };
    let listed = s.state.list_recoveries().unwrap();
    assert_eq!(listed.len(), 1);
    let entry = &listed[0];
    assert_eq!(entry.display_name, "report.pdf");
    assert_eq!(entry.page_count, 2);
    assert_eq!(entry.original, OriginalState::Unchanged);
    let wire = serde_json::to_string(entry).unwrap();
    assert!(
        !wire.contains(&*scratch.0.to_string_lossy()),
        "no path: {wire}"
    );

    let event = serde_json::to_value(s.state.restore_recovery(entry.id).unwrap()).unwrap();
    assert_eq!(event["type"], "opened", "{event}");
    assert_eq!(event["document"]["kind"], "recovered");
    assert_eq!(event["document"]["displayName"], "report.pdf");
    let doc: DocumentId = serde_json::from_value(event["document"]["id"].clone()).unwrap();
    assert!(
        s.state.list_recoveries().unwrap().is_empty(),
        "an open record is not offered again"
    );

    // Save acts as Save As: the original is never overwritten.
    assert_eq!(
        s.state
            .save_in_place(doc, SaveAck::default())
            .unwrap_err()
            .code(),
        ErrorCode::ReadOnly
    );
    assert_eq!(std::fs::read(&original).unwrap(), plain());
    // Closing it asks first: the record is the only copy of the work.
    assert_eq!(
        s.state
            .close_document_checked(doc, false)
            .unwrap_err()
            .code(),
        ErrorCode::UnsavedChanges
    );

    let target = scratch.file("recovered.pdf");
    let saved = s.state.save_as(doc, &target, SaveAck::default()).unwrap();
    assert_eq!(saved.document.kind, sheer_lib::documents::DocKind::User);
    assert_eq!(annotation_count(&std::fs::read(&target).unwrap()), 1);
    assert_eq!(std::fs::read(&original).unwrap(), plain());
    // The record it came from is gone, and so is the copy.
    let leftovers: Vec<String> = sessions(&scratch.app_data())
        .into_iter()
        .filter(|name| name != "quarantine")
        .flat_map(|name| {
            std::fs::read_dir(scratch.app_data().join("autosave").join(name))
                .unwrap()
                .flatten()
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect::<Vec<_>>()
        })
        .filter(|name| name.ends_with(".pdf") || name.ends_with(".json"))
        .collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");
    s.state.close_document(doc).unwrap();
}

#[test]
fn restoring_an_unknown_record_is_not_found_and_discarding_works_through_the_state() {
    let scratch = Scratch::new("state-discard");
    let root = scratch.app_data().join("autosave");
    put_record(
        &root.join("dead"),
        1,
        &manifest(now_secs(), "a.pdf"),
        Some(b"%PDF-1.4 a"),
    );
    let Some(s) = Session::start(&scratch) else {
        return;
    };
    assert_eq!(
        s.state.restore_recovery(99).unwrap_err().code(),
        ErrorCode::NotFound
    );
    let listed = s.state.list_recoveries().unwrap();
    assert_eq!(listed.len(), 1);
    s.state.discard_recovery(listed[0].id).unwrap();
    assert_eq!(s.state.discard_all_recoveries().unwrap(), 0);
    assert!(s.state.list_recoveries().unwrap().is_empty());
}

#[test]
fn a_record_the_engine_cannot_open_is_reported_and_quarantined() {
    let scratch = Scratch::new("unopenable");
    let root = scratch.app_data().join("autosave");
    put_record(
        &root.join("dead"),
        1,
        &manifest(now_secs(), "broken.pdf"),
        Some(b"%PDF-1.4\nthis is not a document\n%%EOF\n"),
    );
    let Some(s) = Session::start(&scratch) else {
        return;
    };
    let listed = s.state.list_recoveries().unwrap();
    let event = serde_json::to_value(s.state.restore_recovery(listed[0].id).unwrap()).unwrap();
    assert_eq!(event["type"], "openFailed", "{event}");
    assert!(s.state.list_recoveries().unwrap().is_empty());
}
