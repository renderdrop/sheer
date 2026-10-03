//! A save that cannot write puts the document back as it was (ADR-004 §1 step 9, ADR-036 §5), against the real PDFium: the engine's copy
//! is released with a snapshot before the file is replaced, and a replace that fails must restore the snapshot (the pages added in the
//! session exist only there). Skips when the PDFium library is not fetched.

#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde_json::json;
use sheer_lib::commands::save::SaveAck;
use sheer_lib::commands::AppState;
use sheer_lib::documents::PageId;
use sheer_lib::engine::{self, Engine};
use sheer_lib::model::command::DocCommand;
use support::fixtures::{add_pages, Page};
use support::PdfBuilder;

struct Scratch(PathBuf);

impl Scratch {
    fn new(name: &str) -> Self {
        let path =
            std::env::temp_dir().join(format!("sheer-restore-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        // A folder or file left read-only would stay behind.
        allow_writes(&self.0, &self.0.join("a.pdf"));
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

fn three_pages() -> Vec<u8> {
    let mut builder = PdfBuilder::new();
    add_pages(&mut builder, &[Page::new(""), Page::new(""), Page::new("")]);
    builder.object(1, "<< /Type /Catalog /Pages 2 0 R >>");
    builder.finish(1)
}

fn cmd(value: serde_json::Value) -> DocCommand {
    serde_json::from_value(value).unwrap()
}

/// Makes replacing `file` fail: on Windows a read-only file cannot be renamed over, elsewhere a read-only folder takes no temp file.
fn block_writes(folder: &Path, file: &Path) {
    if cfg!(windows) {
        let _ = folder;
        let mut permissions = std::fs::metadata(file).unwrap().permissions();
        permissions.set_readonly(true);
        std::fs::set_permissions(file, permissions).unwrap();
    } else {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(folder, std::fs::Permissions::from_mode(0o555)).unwrap();
        }
    }
}

#[allow(clippy::permissions_set_readonly_false)]
fn allow_writes(folder: &Path, file: &Path) {
    if cfg!(windows) {
        let _ = folder;
        if let Ok(metadata) = std::fs::metadata(file) {
            let mut permissions = metadata.permissions();
            permissions.set_readonly(false);
            let _ = std::fs::set_permissions(file, permissions);
        }
    } else {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(folder, std::fs::Permissions::from_mode(0o755));
        }
    }
}

#[test]
fn a_save_that_cannot_write_restores_the_pages_of_the_session() {
    let Some(state) = state() else { return };
    let scratch = Scratch::new("write");
    let path = scratch.0.join("a.pdf");
    let original = three_pages();
    std::fs::write(&path, &original).unwrap();
    let id = state.open_path(path.clone()).unwrap().expect("loaded").id;

    // The session adds a page (it exists in the engine's copy only) and turns page 0.
    state
        .apply_command(id, cmd(json!({"type": "insertBlankPage", "at": 3})))
        .unwrap();
    state
        .apply_command(
            id,
            cmd(json!({"type": "rotatePages", "pages": [0], "quarterTurns": 1})),
        )
        .unwrap();
    let blank = PageId::new(3);
    assert!(state.page_links(id, blank).is_ok());

    block_writes(&scratch.0, &path);
    // Running as a user that may write anyway (root): nothing to test.
    let probe = scratch.0.join("probe.tmp");
    if std::fs::write(&probe, b"x").is_ok() && !cfg!(windows) {
        let _ = std::fs::remove_file(&probe);
        return;
    }
    let failed = state.save_in_place(id, SaveAck::default());
    assert!(failed.is_err(), "the replace was blocked");

    // The file is as it was, and the document still has every page of the session, in the engine as well as the model.
    assert_eq!(std::fs::read(&path).unwrap(), original);
    assert_eq!(state.pages(id).unwrap().len(), 4);
    assert!(
        state.page_links(id, blank).is_ok(),
        "the engine's copy has the added page again"
    );
    assert!(state.page_links(id, PageId::new(0)).is_ok());

    // Nothing was lost: with the file writable again the same save goes through, with all four pages.
    allow_writes(&scratch.0, &path);
    let saved = state.save_in_place(id, SaveAck::default()).unwrap();
    assert_eq!(saved.document.page_count, 4);
    assert!(std::fs::read(&path).unwrap().len() > original.len());
}
