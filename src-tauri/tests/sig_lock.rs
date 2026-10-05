//! The lock of a signed document and the unsigned copy (ADR-121 section 1), against the real PDFium. The signed files are generated here
//! (a signature dictionary with a ByteRange, no real CMS: the lock reads what the file claims). Skips when PDFium is not fetched.
//!
//! SECURITY I21: `the_lock_follows_the_file`, `each_lock_refuses_what_it_does_not_allow`, `a_signed_document_saves_incrementally_only`,
//! `the_unsigned_copy_has_no_signature_opens_editable_and_leaves_the_original_alone`.

#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use std::path::PathBuf;
use std::sync::OnceLock;

use serde_json::json;
use sheer_lib::commands::save::{SaveAck, SaveAsOptions, SaveMode};
use sheer_lib::commands::AppState;
use sheer_lib::documents::DocumentId;
use sheer_lib::engine::{self, Engine};
use sheer_lib::error::ErrorCode;
use sheer_lib::events::AppEvent;
use sheer_lib::model::command::DocCommand;
use sheer_lib::pdfsig::types::SignatureLock;
use support::fixtures::{add_pages, page_id, Page};
use support::PdfBuilder;

struct Scratch(PathBuf);

impl Scratch {
    fn new(name: &str) -> Self {
        let path =
            std::env::temp_dir().join(format!("sheer-siglock-{}-{name}", std::process::id()));
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

/// How a generated file is signed.
#[derive(Clone, Copy)]
enum Signing {
    /// A signature field without a value.
    Unsigned,
    /// A signed field, no certification (an approval signature).
    Approval,
    /// A certification signature with DocMDP `P`, named in the catalog's `/Perms`.
    Certified(u8),
}

/// One page, a text field `name` and a signature field.
fn pdf(signing: Signing) -> Vec<u8> {
    let mut builder = PdfBuilder::new();
    add_pages(
        &mut builder,
        &[Page::new("").with("/Annots [100 0 R 101 0 R]")],
    );
    let page = page_id(0);
    builder.object(
        100,
        &format!(
            "<< /Type /Annot /Subtype /Widget /FT /Tx /T (name) /V (Ada) /Rect [72 700 272 720] /P {page} 0 R >>"
        ),
    );
    let value = match signing {
        Signing::Unsigned => "",
        _ => "/V 102 0 R",
    };
    builder.object(
        101,
        &format!(
            "<< /Type /Annot /Subtype /Widget /FT /Sig /T (Signature1) {value} /Rect [72 600 272 660] /P {page} 0 R >>"
        ),
    );
    let mut perms = String::new();
    match signing {
        Signing::Unsigned => {}
        Signing::Approval => {
            builder.object(
                102,
                "<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /ETSI.CAdES.detached /ByteRange [0 10 30 5] \
                 /Contents <00000000> /M (D:20261005101500Z) /Name (Test) >>",
            );
        }
        Signing::Certified(p) => {
            builder.object(
                102,
                &format!(
                    "<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /ETSI.CAdES.detached /ByteRange [0 10 30 5] \
                     /Contents <00000000> /M (D:20261005101500Z) /Name (Test) \
                     /Reference [<< /Type /SigRef /TransformMethod /DocMDP \
                     /TransformParams << /Type /TransformParams /P {p} /V /1.2 >> >>] >>"
                ),
            );
            perms = "/Perms << /DocMDP 102 0 R >>".to_owned();
        }
    }
    builder.object(
        1,
        &format!(
            "<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [100 0 R 101 0 R] /SigFlags 3 >> {perms} >>"
        ),
    );
    builder.finish(1)
}

fn open(
    state: &AppState,
    scratch: &Scratch,
    name: &str,
    bytes: &[u8],
) -> (DocumentId, SignatureLock) {
    let path = scratch.file(name);
    std::fs::write(&path, bytes).unwrap();
    let info = state.open_path(path).unwrap().expect("loaded");
    (info.id, info.signature_lock)
}

fn cmd(value: serde_json::Value) -> DocCommand {
    serde_json::from_value(value).unwrap()
}

fn rotate() -> DocCommand {
    cmd(json!({"type": "rotatePages", "pages": [0], "quarterTurns": 1}))
}

fn annotate() -> DocCommand {
    cmd(json!({"type": "createAnnotation", "draft": {
        "pageId": 0, "kind": "textBox", "color": [20, 40, 160], "opacity": 1.0,
        "box": {"x": 72.0, "y": 100.0, "w": 150.0, "h": 0.0},
        "text": "note", "font": "serif", "fontSize": 14.0, "align": "left"
    }}))
}

fn fill(state: &AppState, id: DocumentId, text: &str) -> DocCommand {
    let info = state.get_form_fields(id).unwrap();
    let field = info
        .fields
        .iter()
        .find(|f| f.name == "name")
        .expect("field");
    cmd(
        json!({"type": "setFieldValue", "field": field.id.get(), "value": {"type": "text", "text": text}}),
    )
}

const LOCKS: [(Signing, SignatureLock); 5] = [
    (Signing::Unsigned, SignatureLock::None),
    (Signing::Approval, SignatureLock::FillAndSign),
    (Signing::Certified(1), SignatureLock::Locked),
    (Signing::Certified(2), SignatureLock::FillAndSign),
    (Signing::Certified(3), SignatureLock::AnnotateFillAndSign),
];

#[test]
fn the_lock_follows_the_file() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("follows");
    for (index, (signing, expected)) in LOCKS.iter().enumerate() {
        let (_, lock) = open(state, &scratch, &format!("f{index}.pdf"), &pdf(*signing));
        assert_eq!(lock, *expected, "file {index}");
    }
}

#[test]
fn each_lock_refuses_what_it_does_not_allow() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("matrix");
    // (form fill, annotation, page change) allowed per lock.
    let allowed = |lock: SignatureLock| match lock {
        SignatureLock::None => [true, true, true],
        SignatureLock::FillAndSign => [true, false, false],
        SignatureLock::AnnotateFillAndSign => [true, true, false],
        SignatureLock::Locked => [false, false, false],
    };
    for (index, (signing, lock)) in LOCKS.iter().enumerate() {
        let (id, _) = open(state, &scratch, &format!("m{index}.pdf"), &pdf(*signing));
        let [may_fill, may_annotate, may_rotate] = allowed(*lock);
        for (name, command, may) in [
            ("fill", fill(state, id, "Grace"), may_fill),
            ("annotate", annotate(), may_annotate),
            ("rotate", rotate(), may_rotate),
        ] {
            let result = state.apply_command(id, command);
            if may {
                result.unwrap_or_else(|e| panic!("{lock:?} {name}: {e:?}"));
            } else {
                assert_eq!(
                    result.unwrap_err().code(),
                    ErrorCode::ReadOnly,
                    "{lock:?} {name}"
                );
            }
        }
    }
}

#[test]
fn a_refused_command_changes_nothing() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("nothing");
    let (id, _) = open(state, &scratch, "n.pdf", &pdf(Signing::Certified(1)));
    let before = state.pages(id).unwrap().len();
    assert!(state.apply_command(id, rotate()).is_err());
    assert_eq!(state.pages(id).unwrap().len(), before);
    assert!(state
        .apply_command(
            id,
            cmd(json!({"type": "batch", "label": "x", "commands": [
                {"type": "rotatePages", "pages": [0], "quarterTurns": 1}
            ]}))
        )
        .is_err());
}

#[test]
fn a_signed_document_saves_incrementally_only() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("incremental");
    let original = pdf(Signing::Certified(3));
    let (id, _) = open(state, &scratch, "s.pdf", &original);
    state.apply_command(id, annotate()).unwrap();
    // A clean copy is a full rewrite: refused, nothing written.
    let error = state
        .save_as_with(
            id,
            &scratch.file("clean.pdf"),
            SaveAck::default(),
            SaveAsOptions { clean_copy: true },
        )
        .unwrap_err();
    assert_eq!(error.code(), ErrorCode::ReadOnly);
    assert!(!scratch.file("clean.pdf").exists());
    // A plain save appends: the signed bytes stay as they were, and the lock is still there afterwards.
    let saved = state.save_in_place(id, SaveAck::default()).unwrap();
    assert_eq!(saved.mode, SaveMode::Incremental);
    assert_eq!(
        saved.document.signature_lock,
        SignatureLock::AnnotateFillAndSign
    );
    let after = std::fs::read(scratch.file("s.pdf")).unwrap();
    assert!(after.len() > original.len());
    assert_eq!(&after[..original.len()], &original[..]);
}

#[test]
fn the_unsigned_copy_has_no_signature_opens_editable_and_leaves_the_original_alone() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("copy");
    let original = pdf(Signing::Certified(2));
    let (id, lock) = open(state, &scratch, "s.pdf", &original);
    assert_eq!(lock, SignatureLock::FillAndSign);
    // What the session changed (within the lock) is in the copy.
    state.apply_command(id, fill(state, id, "Grace")).unwrap();

    // Never the document's own file.
    assert_eq!(
        state
            .save_unsigned_copy_to(id, &scratch.file("s.pdf"))
            .unwrap_err()
            .code(),
        ErrorCode::InvalidArgument
    );
    let event = state
        .save_unsigned_copy_to(id, &scratch.file("copy.pdf"))
        .unwrap();
    let AppEvent::Opened { document } = event else {
        panic!("expected an opened document");
    };
    assert_ne!(document.id, id);
    assert_eq!(document.signature_lock, SignatureLock::None);

    let copy = std::fs::read(scratch.file("copy.pdf")).unwrap();
    for token in [
        &b"/ByteRange"[..],
        b"/Perms",
        b"/DocMDP",
        b"Signature1",
        b"/SigFlags",
    ] {
        assert!(
            !copy.windows(token.len()).any(|w| w == token),
            "{}",
            String::from_utf8_lossy(token)
        );
    }
    // The copy is editable: pages can change, and the form value is kept.
    state.apply_command(document.id, rotate()).unwrap();
    let fields = state.get_form_fields(document.id).unwrap();
    let name = fields
        .fields
        .iter()
        .find(|f| f.name == "name")
        .expect("field");
    assert!(format!("{:?}", name.value).contains("Grace"));
    // The original is untouched, open, and still locked.
    assert_eq!(std::fs::read(scratch.file("s.pdf")).unwrap(), original);
    assert_eq!(
        state.apply_command(id, rotate()).unwrap_err().code(),
        ErrorCode::ReadOnly
    );
}

#[test]
fn an_unsigned_copy_of_a_certified_p1_document_works_too() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("copy-p1");
    let (id, lock) = open(state, &scratch, "s.pdf", &pdf(Signing::Certified(1)));
    assert_eq!(lock, SignatureLock::Locked);
    let AppEvent::Opened { document } = state
        .save_unsigned_copy_to(id, &scratch.file("c.pdf"))
        .unwrap()
    else {
        panic!("expected an opened document");
    };
    assert_eq!(document.signature_lock, SignatureLock::None);
    state.apply_command(document.id, annotate()).unwrap();
}
