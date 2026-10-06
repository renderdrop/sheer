//! Editing a centred or right-aligned line in real documents (installed-build blocker, ADR-129 section 2): the preview and Apply must
//! succeed, the line's text must be the new one and its centre (centred) or right edge (right-aligned) must stay. The corpus is not in
//! the repository (`review/owner/corpus/`, ADR-126), so the tests are `#[ignore]`d:
//! `cargo test --test text_edit_align_corpus -- --ignored --nocapture`.

#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use std::path::PathBuf;
use std::time::Duration;

use sheer_lib::commands::text_preview::PreviewRequest;
use sheer_lib::commands::AppState;
use sheer_lib::documents::PageId;
use sheer_lib::engine::{self, Engine};
use sheer_lib::model::text_edit::{LineAlign, TextEdit, TextFit, TextLineInfo, TextScope};

/// `file` is a corpus ID (`review/owner/INDEX.md`).
fn run(file: &str, old: &str, new: &str, align: LineAlign) {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let library = engine::library_path(&manifest.join("pdfium"));
    if !library.is_file() {
        eprintln!("skipping: PDFium not found");
        return;
    }
    let Some(path) = support::corpus::file(file) else {
        return;
    };
    let state = AppState::new(Engine::start(library));
    let info = loop {
        match state.open_path(path.clone()) {
            Ok(Some(info)) => break info,
            Ok(None) => std::thread::sleep(Duration::from_millis(10)),
            Err(e) => panic!("open: {e:?}"),
        }
    };
    let page = PageId::new(0);
    let find = |state: &AppState, text: &str| -> TextLineInfo {
        state
            .text_edit_lines(info.id, page)
            .unwrap()
            .lines
            .into_iter()
            .find(|l| l.text.trim() == text)
            .unwrap_or_else(|| panic!("no line {text:?}"))
    };
    for l in state.text_edit_lines(info.id, page).unwrap().lines {
        if l.text.trim() == old {
            println!("candidate {:?} {:?} {:?}", l.key, l.align, l.bounds);
        }
    }
    let line = find(&state, old);
    println!("wire align of {old:?}: {:?}", line.align);
    assert_eq!(line.align, align);
    let before = line.bounds;
    let preview = state.text_edit_preview(
        info.id,
        page,
        PreviewRequest {
            key: line.key,
            text: new.to_owned(),
            fit: TextFit::KeepStart,
            scope: TextScope::Line,
            generation: 1,
            scale: 2.0,
        },
    );
    if let Err(e) = &preview {
        println!("preview error: {e:?}");
    }
    preview.unwrap();
    let applied = state.edit_text_line(
        info.id,
        page,
        TextEdit {
            key: line.key,
            text: new.to_owned(),
            fit: TextFit::KeepStart,
            scope: TextScope::Line,
        },
    );
    if let Err(e) = &applied {
        println!("apply error: {e:?}");
    }
    applied.unwrap();
    let after = find(&state, new).bounds;
    println!("before {before:?} after {after:?}");
    match align {
        LineAlign::Center => {
            let (a, b) = (before.x + before.w / 2.0, after.x + after.w / 2.0);
            assert!((a - b).abs() <= 0.5, "centre moved {a} -> {b}");
        }
        _ => {
            let (a, b) = (before.x + before.w, after.x + after.w);
            assert!((a - b).abs() <= 0.5, "right edge moved {a} -> {b}");
        }
    }
}

#[test]
#[ignore = "needs the untracked corpus in review/ and the PDFium library"]
fn centred_heading_keeps_its_centre() {
    run(
        "owner-pdf-E4",
        "Präambel",
        "Präambel 2026",
        LineAlign::Center,
    );
}

#[test]
#[ignore = "needs the untracked corpus in review/ and the PDFium library"]
fn right_aligned_line_keeps_its_right_edge() {
    let (Some(old), Some(new)) = (
        support::corpus::probe("corpus-05/address-line"),
        support::corpus::probe("corpus-05/address-line-full"),
    ) else {
        return;
    };
    run("corpus-05", &old, &new, LineAlign::Right);
}
