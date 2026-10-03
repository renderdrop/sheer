//! Password protection against the real PDFium (ADR-047 §4): a file lopdf wrote as AES-256 R6 opens with each password and the
//! permissions read back; R2, R3, R4 and R6 files are saved again with the same password; a staged protection and its removal are
//! written by a save; no password is in any error. Skips when the PDFium library is not fetched.

#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use std::path::PathBuf;
use std::sync::OnceLock;

use serde_json::json;
use sheer_lib::commands::save::{SaveAck, SaveMode};
use sheer_lib::commands::{AppState, Opened};
use sheer_lib::documents::{DocumentId, PageId};
use sheer_lib::engine::{self, Engine};
use sheer_lib::error::ErrorCode;
use sheer_lib::model::command::DocCommand;
use sheer_lib::model::protection::{
    PendingKind, Permission, PermissionSet, ProtectOptions, ProtectionMethod,
};
use sheer_lib::pdfwrite::crypt;
use sheer_lib::security::secret::{PendingProtection, Secret};
use support::fixtures::{add_pages, Page};
use support::PdfBuilder;
use zeroize::Zeroizing;

struct Scratch(PathBuf);

impl Scratch {
    fn new(name: &str) -> Self {
        let path =
            std::env::temp_dir().join(format!("sheer-protect-{}-{name}", std::process::id()));
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

fn plain() -> Vec<u8> {
    let mut builder = PdfBuilder::new();
    add_pages(&mut builder, &[Page::new(""), Page::new("")]);
    builder.object(1, "<< /Type /Catalog /Pages 2 0 R >>");
    builder.finish(1)
}

fn secret(text: &str) -> Secret {
    Secret::new(text).unwrap()
}

/// The file as R6 with `open` and `owner`, permissions `allow`.
fn r6(open: Option<&str>, owner: &str, allow: &[Permission]) -> Vec<u8> {
    let pending = PendingProtection::Protect {
        open: open.map(secret),
        owner: secret(owner),
        allow: PermissionSet::from_list(allow),
    };
    crypt::encrypt_bytes(&plain(), &pending).unwrap()
}

/// Opens `bytes` (as file `name`) with `password`.
fn open_info(
    state: &AppState,
    scratch: &Scratch,
    name: &str,
    bytes: &[u8],
    password: Option<&str>,
) -> sheer_lib::documents::DocumentInfo {
    let path = scratch.file(name);
    std::fs::write(&path, bytes).unwrap();
    match state.open_outcome(path).unwrap() {
        Opened::Ready(info) => {
            assert!(password.is_none() || info.flags.encrypted);
            info
        }
        Opened::Locked { id, .. } => state
            .unlock(id, Zeroizing::new(password.expect("a password").to_owned()))
            .unwrap(),
        Opened::Pending => panic!("pending"),
    }
}

fn cmd(value: serde_json::Value) -> DocCommand {
    serde_json::from_value(value).unwrap()
}

fn note(state: &AppState, id: DocumentId) {
    state
        .apply_command(
            id,
            cmd(json!({"type": "createAnnotation", "draft": {
                "pageId": 0, "kind": "note", "color": [255, 235, 0],
                "at": {"x": 10.0, "y": 10.0}, "icon": "comment", "contents": "hello"
            }})),
        )
        .unwrap();
}

fn ack() -> SaveAck {
    SaveAck {
        rewrite_encrypted: true,
        ..SaveAck::default()
    }
}

#[test]
fn lopdf_written_r6_opens_with_each_password_and_the_permissions_read_back() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("gate");
    let bytes = r6(Some("user-pw"), "owner-pw", &[Permission::Print]);
    // Not R2 to R4: the file says V5, R6, AES-256.
    let text = String::from_utf8_lossy(&bytes).into_owned();
    assert!(text.contains("/R 6") && text.contains("AESV3"), "{text:.0}");

    // Without a password, and with a wrong one, it stays locked.
    let path = scratch.file("a.pdf");
    std::fs::write(&path, &bytes).unwrap();
    let Opened::Locked { id, .. } = state.open_outcome(path).unwrap() else {
        panic!("an R6 file with an open password must ask");
    };
    let wrong = state.unlock(id, Zeroizing::new("nope".to_owned()));
    assert_eq!(wrong.unwrap_err().code(), ErrorCode::PasswordRequired);

    // The open password: opens, restricted to what the file allows.
    let info = state
        .unlock(id, Zeroizing::new("user-pw".to_owned()))
        .unwrap();
    assert!(info.flags.encrypted, "an R6 file is encrypted");
    assert_eq!(info.page_count, 2);
    assert_eq!(
        info.flags.permissions.map(PermissionSet::to_list),
        Some(vec![Permission::Print])
    );
    let protection = state.get_protection(id).unwrap();
    assert_eq!(protection.method, ProtectionMethod::Aes256);
    assert!(!protection.owner_rights);
    assert_eq!(protection.allow, vec![Permission::Print]);
    // The permissions are enforced: no edit.
    let refused = state.apply_command(
        id,
        cmd(json!({"type": "rotatePages", "pages": [0], "quarterTurns": 1})),
    );
    assert_eq!(refused.unwrap_err().code(), ErrorCode::ReadOnly);

    // The owner password: opens with every right.
    let owner_info = open_info(state, &scratch, "b.pdf", &bytes, Some("owner-pw"));
    let owner = owner_info.id;
    let info = owner_info;
    assert!(info.flags.encrypted && info.flags.permissions.is_none());
    assert!(state.get_protection(owner).unwrap().owner_rights);
}

#[test]
fn encrypted_files_of_every_revision_are_saved_again_with_the_same_password() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("resave");
    let cases: Vec<(&str, Vec<u8>, &str)> = vec![
        ("r2.pdf", support::fixtures::encrypted(), ""),
        (
            "r3.pdf",
            crypt::testing::encrypt_legacy(&plain(), 3, "u3", "o3").unwrap(),
            "u3",
        ),
        (
            "r4.pdf",
            crypt::testing::encrypt_legacy(&plain(), 4, "u4", "o4").unwrap(),
            "u4",
        ),
        (
            "r6.pdf",
            r6(
                Some("u6"),
                "o6",
                &[Permission::Print, Permission::Copy, Permission::Edit],
            ),
            "u6",
        ),
    ];
    for (name, bytes, password) in cases {
        let id = open(
            state,
            &scratch,
            name,
            &bytes,
            (!password.is_empty()).then_some(password),
        );
        note(state, id);
        // Asked first: the rewrite of a protected file is the user's say.
        let asked = state.save_in_place(id, SaveAck::default());
        assert_eq!(
            asked.unwrap_err().code(),
            ErrorCode::NeedsConfirmation,
            "{name}"
        );
        let saved = state.save_in_place(id, ack()).unwrap();
        assert_eq!(saved.mode, SaveMode::Full, "{name}");
        // The file on disk is still encrypted, and the same password opens it.
        let written = std::fs::read(scratch.file(name)).unwrap();
        assert!(
            crypt::testing::is_encrypted(&written),
            "{name}: still encrypted"
        );
        let read = crypt::read_protection(
            &written,
            (!password.is_empty()).then(|| secret(password)).as_ref(),
        )
        .unwrap();
        assert!(read.encrypted, "{name}");
        // PDFium reopened it after the save and shows the annotation we added.
        assert_eq!(
            state.list_annotations(id, PageId::new(0)).unwrap().len(),
            1,
            "{name}"
        );
        // A wrong password does not open the saved file.
        if !password.is_empty() {
            assert!(crypt::read_protection(&written, Some(&secret("wrong"))).is_err());
        }
        // The same password opens it in a new session, and the annotation is in the file.
        let again = open(
            state,
            &scratch,
            &format!("again-{name}"),
            &written,
            (!password.is_empty()).then_some(password),
        );
        assert_eq!(
            state.list_annotations(again, PageId::new(0)).unwrap().len(),
            1,
            "{name}"
        );
    }
}

#[test]
fn a_staged_protection_is_written_by_a_save_and_a_removal_takes_it_off() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("stage");
    let id = open(state, &scratch, "p.pdf", &plain(), None);

    // The options are checked: a restriction needs another permissions password; nothing at all is not a protection.
    let opts = |open: Option<&str>, owner: Option<&str>, allow: &[Permission]| ProtectOptions {
        open_password: open.map(secret),
        permissions_password: owner.map(secret),
        allow: allow.to_vec(),
    };
    let all = [Permission::Print, Permission::Copy, Permission::Edit];
    for (bad, what) in [
        (
            opts(Some("a"), None, &[Permission::Print]),
            ErrorCode::InvalidArgument,
        ),
        (
            opts(Some("same"), Some("same"), &[Permission::Print]),
            ErrorCode::InvalidArgument,
        ),
        (opts(None, None, &all), ErrorCode::InvalidArgument),
    ] {
        let error = state.stage_protection(id, bad).unwrap_err();
        assert_eq!(error.code(), what);
        assert!(!format!("{error:?} {error}").contains("same"));
    }

    let staged = state
        .stage_protection(
            id,
            opts(Some("open-pw"), Some("owner-pw"), &[Permission::Print]),
        )
        .unwrap();
    assert!(staged.history.dirty);
    assert_eq!(
        state.get_protection(id).unwrap().pending,
        PendingKind::Protect
    );
    // One undo step: undo clears it, redo brings it back (the secrets are still in their slot).
    state.undo(id).unwrap();
    assert_eq!(state.get_protection(id).unwrap().pending, PendingKind::None);
    state.redo(id).unwrap();
    assert_eq!(
        state.get_protection(id).unwrap().pending,
        PendingKind::Protect
    );

    let saved = state.save_in_place(id, SaveAck::default()).unwrap();
    assert_eq!(saved.mode, SaveMode::Full);
    let written = std::fs::read(scratch.file("p.pdf")).unwrap();
    assert!(crypt::testing::is_encrypted(&written));
    let read = crypt::read_protection(&written, Some(&secret("open-pw"))).unwrap();
    assert_eq!(
        (read.method, read.owner_rights, read.allow.to_list()),
        (ProtectionMethod::Aes256, false, vec![Permission::Print])
    );
    assert!(
        crypt::read_protection(&written, Some(&secret("owner-pw")))
            .unwrap()
            .owner_rights
    );
    // The staged secrets are gone after the save; the document is now the protected file, opened with its open password.
    assert_eq!(state.get_protection(id).unwrap().pending, PendingKind::None);
    assert!(state.get_protection(id).unwrap().encrypted);

    // Removal: owner rights are needed (a wrong password is password_required, nothing is staged), then a save writes a plain file.
    let no_password = state.stage_unprotection(id, None).unwrap_err();
    assert_eq!(no_password.code(), ErrorCode::PasswordRequired);
    let wrong = state
        .stage_unprotection(id, Some(secret("not-it")))
        .unwrap_err();
    assert_eq!(wrong.code(), ErrorCode::PasswordRequired);
    assert!(!format!("{wrong:?} {wrong}").contains("not-it"));
    state
        .stage_unprotection(id, Some(secret("owner-pw")))
        .unwrap();
    assert_eq!(
        state.get_protection(id).unwrap().pending,
        PendingKind::Remove
    );
    let saved = state.save_in_place(id, SaveAck::default()).unwrap();
    assert_eq!(saved.mode, SaveMode::Full);
    let written = std::fs::read(scratch.file("p.pdf")).unwrap();
    assert!(!crypt::testing::is_encrypted(&written));
    assert!(!state.get_protection(id).unwrap().encrypted);
    assert_eq!(state.list_annotations(id, PageId::new(0)).unwrap().len(), 0);
}

#[test]
fn no_password_is_in_the_file_as_text_or_in_an_error() {
    let bytes = r6(Some("sup3r-s3cret"), "0wner-s3cret", &[Permission::Copy]);
    for needle in ["sup3r-s3cret", "0wner-s3cret"] {
        assert!(!bytes.windows(needle.len()).any(|w| w == needle.as_bytes()));
    }
    let error = crypt::read_protection(&bytes, Some(&secret("sup3r-wrong"))).unwrap_err();
    assert_eq!(error.code(), ErrorCode::PasswordRequired);
    assert!(!format!("{error:?} {error}").contains("sup3r"));
    let none = crypt::read_protection(&bytes, None).unwrap_err();
    assert_eq!(none.code(), ErrorCode::PasswordRequired);
}

fn open(
    state: &AppState,
    scratch: &Scratch,
    name: &str,
    bytes: &[u8],
    password: Option<&str>,
) -> DocumentId {
    open_info(state, scratch, name, bytes, password).id
}
