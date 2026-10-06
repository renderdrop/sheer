//! Justified paragraphs in real documents (ADR-130). The corpus is not in the repository (`review/owner/corpus/`, ADR-126), so the
//! tests are `#[ignore]`d: `cargo test --test text_edit_justify_corpus -- --ignored --nocapture`.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::path::PathBuf;
use std::time::Duration;

use sheer_lib::commands::AppState;
use sheer_lib::documents::PageId;
use sheer_lib::engine::{self, Engine};
use sheer_lib::model::text_edit::TextLineInfo;

/// The text lines of page 1 of a corpus file, or `None` when the corpus or PDFium is missing.
fn page_lines(file: &str) -> Option<Vec<TextLineInfo>> {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let library = engine::library_path(&manifest.join("pdfium"));
    let path = manifest.join("..").join("review/owner/corpus").join(file);
    if !library.is_file() || !path.is_file() {
        eprintln!("skipping: PDFium or {file} not found");
        return None;
    }
    let state = AppState::new(Engine::start(library));
    let info = loop {
        match state.open_path(path.clone()) {
            Ok(Some(info)) => break info,
            Ok(None) => std::thread::sleep(Duration::from_millis(10)),
            Err(e) => panic!("open: {e:?}"),
        }
    };
    Some(
        state
            .text_edit_lines(info.id, PageId::new(0))
            .unwrap()
            .lines,
    )
}

#[test]
#[ignore = "needs the untracked corpus in review/ and the PDFium library"]
fn e4_justified_paragraph_is_not_split_at_the_stretched_line() {
    let Some(lines) = page_lines("E4_Vorgartensatzung Stadt Erfurt.pdf") else {
        return;
    };
    let stretched = lines
        .iter()
        .find(|l| l.text.contains("Ende") && l.text.contains("des"))
        .expect("the stretched line is one line");
    let first = lines
        .iter()
        .find(|l| l.text.starts_with("Vorgärten prägen"))
        .expect("first line");
    let last = lines
        .iter()
        .find(|l| l.text.trim() == "Straßenbildes.")
        .expect("last line");
    assert!(stretched.justified, "the paragraph is justified");
    assert_eq!(stretched.paragraph, first.paragraph, "unsplit before");
    assert_eq!(stretched.paragraph, last.paragraph, "unsplit after");
}

#[test]
#[ignore = "needs the untracked corpus in review/ and the PDFium library"]
fn a_lengthened_justified_line_reflows_and_every_line_but_the_last_ends_at_the_right_edge() {
    use sheer_lib::model::text_edit::{TextEdit, TextFit, TextScope};

    let file = "E4_Vorgartensatzung Stadt Erfurt.pdf";
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let library = engine::library_path(&manifest.join("pdfium"));
    let path = manifest.join("..").join("review/owner/corpus").join(file);
    if !library.is_file() || !path.is_file() {
        eprintln!("skipping: PDFium or {file} not found");
        return;
    }
    let state = AppState::new(Engine::start(library));
    let info = loop {
        match state.open_path(path.clone()) {
            Ok(Some(info)) => break info,
            Ok(None) => std::thread::sleep(Duration::from_millis(10)),
            Err(e) => panic!("open: {e:?}"),
        }
    };
    let page = PageId::new(0);
    let before = state.text_edit_lines(info.id, page).unwrap().lines;
    // The justified paragraphs of three lines or more, by their first line; a paragraph with a line in two fonts is refused by the
    // re-break (tooComplex), so the first one the splice accepts is the subject.
    let mut seen: Vec<u32> = Vec::new();
    let mut tried = 0;
    for first in before.iter().filter(|l| l.justified) {
        if seen.contains(&first.paragraph) {
            continue;
        }
        seen.push(first.paragraph);
        let para: Vec<&TextLineInfo> = before
            .iter()
            .filter(|l| l.paragraph == first.paragraph)
            .collect();
        if para.len() < 3 || para[0].key != first.key {
            continue;
        }
        for l in &para {
            println!("before {:>8.2} {:?}", l.bounds.x + l.bounds.w, l.text);
        }
        // The paragraph's right edge: where most of its lines but the last end.
        let mut ends: Vec<f32> = para[..para.len() - 1]
            .iter()
            .map(|l| l.bounds.x + l.bounds.w)
            .collect();
        ends.sort_by(f32::total_cmp);
        let right = ends[ends.len() / 2];
        let new_first = format!(
            "{} und weitere besonders lange Wörter",
            first.text.trim_end()
        );
        let mut expected: Vec<String> = new_first.split_whitespace().map(str::to_owned).collect();
        for l in &para[1..] {
            expected.extend(l.text.split_whitespace().map(str::to_owned));
        }
        let applied = state.edit_text_line(
            info.id,
            page,
            TextEdit {
                key: first.key,
                text: new_first.clone(),
                fit: TextFit::KeepStart,
                scope: TextScope::Paragraph,
            },
        );
        tried += 1;
        if let Err(e) = applied {
            println!("paragraph of {:?} refused: {e:?}", first.text);
            continue;
        }
        let head: String = first.text.chars().take(20).collect();
        let after = state.text_edit_lines(info.id, page).unwrap().lines;
        let edited = after
            .iter()
            .find(|l| l.text.starts_with(&head))
            .expect("edited line");
        let now: Vec<&TextLineInfo> = after
            .iter()
            .filter(|l| l.paragraph == edited.paragraph)
            .collect();
        for l in &now {
            println!("{:>8.2} {:?}", l.bounds.x + l.bounds.w, l.text);
        }
        let got: Vec<String> = now
            .iter()
            .flat_map(|l| l.text.split_whitespace().map(str::to_owned))
            .collect();
        assert_eq!(got, expected, "the words are the new ones, in order");
        assert!(now.len() >= para.len(), "a word wrapped");
        // Every line but the last ends at the edge, unless the gaps would have to grow by more than four spaces (ADR-130 limit).
        let mut at_edge = 0;
        for l in &now {
            assert!(
                l.bounds.x + l.bounds.w <= right + 0.5,
                "beyond the edge: {:?}",
                l.text
            );
        }
        for l in &now[..now.len() - 1] {
            let end = l.bounds.x + l.bounds.w;
            if (end - right).abs() <= 0.5 {
                at_edge += 1;
                continue;
            }
            let gaps = l.text.split_whitespace().count().saturating_sub(1).max(1) as f32;
            assert!(
                end < right && (right - end) / gaps > 7.5,
                "right edge {end} != {right} on {:?}",
                l.text
            );
        }
        assert!(at_edge >= 4, "only {at_edge} lines reach the edge");
        return;
    }
    panic!("no justified paragraph accepted the re-break ({tried} tried)");
}

#[test]
#[ignore = "needs the untracked corpus in review/ and the PDFium library"]
fn e4_edit_on_line_three_wraps_the_edited_line_at_the_paragraph_edge() {
    use sheer_lib::model::text_edit::{TextEdit, TextFit, TextScope};

    let file = "E4_Vorgartensatzung Stadt Erfurt.pdf";
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let library = engine::library_path(&manifest.join("pdfium"));
    let path = manifest.join("..").join("review/owner/corpus").join(file);
    if !library.is_file() || !path.is_file() {
        eprintln!("skipping: PDFium or {file} not found");
        return;
    }
    let state = AppState::new(Engine::start(library));
    let info = loop {
        match state.open_path(path.clone()) {
            Ok(Some(info)) => break info,
            Ok(None) => std::thread::sleep(Duration::from_millis(10)),
            Err(e) => panic!("open: {e:?}"),
        }
    };
    let page = PageId::new(0);
    let before = state.text_edit_lines(info.id, page).unwrap().lines;
    let line = before
        .iter()
        .find(|l| l.text.contains("Kommunalordnung - ThürKO)"))
        .expect("line 3");
    assert!(
        line.text.trim_end().ends_with("14. April 1998"),
        "{:?}",
        line.text
    );
    let para: Vec<&TextLineInfo> = before
        .iter()
        .filter(|l| l.paragraph == line.paragraph)
        .collect();
    let mut ends: Vec<f32> = para[..para.len() - 1]
        .iter()
        .map(|l| l.bounds.x + l.bounds.w)
        .collect();
    ends.sort_by(f32::total_cmp);
    let right = ends[ends.len() / 2];
    state
        .edit_text_line(
            info.id,
            page,
            TextEdit {
                key: line.key,
                text: format!("{} im Freistaat", line.text.trim_end()),
                fit: TextFit::KeepStart,
                scope: TextScope::Paragraph,
            },
        )
        .expect("applied");
    let after = state.text_edit_lines(info.id, page).unwrap().lines;
    let edited = after
        .iter()
        .find(|l| l.text.contains("Kommunalordnung - ThürKO)"))
        .expect("edited line");
    let now: Vec<&TextLineInfo> = after
        .iter()
        .filter(|l| l.paragraph == edited.paragraph)
        .collect();
    for l in &now {
        println!("{:>8.2} {:?}", l.bounds.x + l.bounds.w, l.text);
    }
    let pos = now.iter().position(|l| l.key == edited.key).unwrap();
    // The edited line is filled to the paragraph's edge, never to the room next to the paragraph: it ends at the edge, and whatever
    // does not fit (at least "Freistaat") starts the next line.
    let edited_end = now[pos].bounds.x + now[pos].bounds.w;
    assert!(
        (edited_end - right).abs() <= 0.5,
        "edited line ends at {edited_end}, edge {right}: {:?}",
        now[pos].text
    );
    assert!(
        now[pos + 1].text.starts_with("Freistaat") || now[pos + 1].text.starts_with("im Freistaat"),
        "next line: {:?}",
        now[pos + 1].text
    );
    // No line ends beyond the edge; every line but the last ends at it (the gap limit aside).
    for (i, l) in now.iter().enumerate() {
        let end = l.bounds.x + l.bounds.w;
        assert!(end <= right + 0.5, "{end} beyond {right} on {:?}", l.text);
        if i + 1 < now.len() && (end - right).abs() > 0.5 {
            let gaps = l.text.split_whitespace().count().saturating_sub(1).max(1) as f32;
            assert!(
                (right - end) / gaps > 7.5,
                "{end} != {right} on {:?}",
                l.text
            );
        }
    }
}
