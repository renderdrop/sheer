//! `save_citation_list` without the dialog: the core that writes the file, on a temp directory.

// Test code: panicking on a broken fixture is the point.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

use sheer_lib::error::ErrorCode;
use sheer_lib::export::citations::{
    admit_target, default_file_name, write_list, CitationFileFormat, CitationStyle, Run,
    StyledBlock,
};
use sheer_lib::limits;
use sheer_lib::model::bibliography::{BibKind, BibRecord, Person};

struct TempDir(PathBuf);

impl TempDir {
    fn new() -> Self {
        static NEXT: AtomicU32 = AtomicU32::new(0);
        let path = std::env::temp_dir().join(format!(
            "sheer-citation-it-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }

    fn names(&self) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(&self.0)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn block(runs: &[(&str, bool)]) -> StyledBlock {
    StyledBlock {
        runs: runs
            .iter()
            .map(|(text, italic)| Run {
                text: (*text).to_owned(),
                italic: *italic,
                note: None,
            })
            .collect(),
        kind: None,
        note: None,
    }
}

fn record() -> BibRecord {
    BibRecord {
        kind: BibKind::Article,
        authors: vec![Person {
            family: "Doe".to_owned(),
            given: "Jane".to_owned(),
        }],
        title: Some("On <things> & {stuff}".to_owned()),
        year: Some("2020".to_owned()),
        container_title: Some("Journal".to_owned()),
        pages: Some("1-9".to_owned()),
        ..BibRecord::default()
    }
}

#[test]
fn each_blocks_format_is_written_escaped_and_atomically() {
    let dir = TempDir::new();
    let blocks = [block(&[
        ("Doe, J. (2020). ", false),
        ("<b>Title</b> & more", true),
    ])];
    for (name, format, expected) in [
        (
            "a.txt",
            CitationFileFormat::Txt,
            "Doe, J. (2020). <b>Title</b> & more\n",
        ),
        (
            "a.md",
            CitationFileFormat::Md,
            "Doe, J. \\(2020\\). *\\<b\\>Title\\</b\\> \\& more*\n",
        ),
    ] {
        let written = write_list(&dir.path().join(name), format, &blocks, None).unwrap();
        assert_eq!(fs::read_to_string(written).unwrap(), expected);
    }
    let html = write_list(
        &dir.path().join("a.html"),
        CitationFileFormat::Html,
        &blocks,
        None,
    )
    .unwrap();
    let html = fs::read_to_string(html).unwrap();
    assert!(html.contains("<p>Doe, J. (2020). <i>&lt;b&gt;Title&lt;/b&gt; &amp; more</i></p>"));
    // Only the three files: no temp file is left.
    assert_eq!(dir.names(), ["a.html", "a.md", "a.txt"]);
}

#[test]
fn ris_and_bib_come_from_the_record_only() {
    let dir = TempDir::new();
    let ris = write_list(
        &dir.path().join("r.ris"),
        CitationFileFormat::Ris,
        &[],
        Some(&record()),
    )
    .unwrap();
    let ris = fs::read_to_string(ris).unwrap();
    assert!(ris.starts_with("TY  - JOUR\r\nAU  - Doe, Jane\r\n"));
    assert!(ris.ends_with("ER  - \r\n"));
    let bib = write_list(
        &dir.path().join("r.bib"),
        CitationFileFormat::Bib,
        &[],
        Some(&record()),
    )
    .unwrap();
    let bib = fs::read_to_string(bib).unwrap();
    assert!(bib.contains("title = {On <things> \\& {stuff}},"));
    // Blocks next to a record, or no record at all: refused, nothing written.
    let blocks = [block(&[("x", false)])];
    let error = write_list(
        &dir.path().join("x.ris"),
        CitationFileFormat::Ris,
        &blocks,
        Some(&record()),
    )
    .unwrap_err();
    assert_eq!(error.code(), ErrorCode::InvalidArgument);
    let error = write_list(
        &dir.path().join("x.bib"),
        CitationFileFormat::Bib,
        &[],
        None,
    )
    .unwrap_err();
    assert_eq!(error.code(), ErrorCode::InvalidArgument);
    assert_eq!(dir.names(), ["r.bib", "r.ris"]);
}

#[test]
fn the_caps_are_checked_before_anything_is_written() {
    let dir = TempDir::new();
    let target = dir.path().join("x.txt");
    let line = block(&[("a", false)]);
    let too_many = vec![line; limits::CITATION_EXPORT_BLOCKS_MAX + 1];
    let error = write_list(&target, CitationFileFormat::Txt, &too_many, None).unwrap_err();
    assert_eq!(error.code(), ErrorCode::LimitExceeded);
    let long = block(&[(&"a".repeat(limits::STYLED_RUN_CHARS_MAX), false)]);
    let too_big = vec![long; 1100];
    let error = write_list(&target, CitationFileFormat::Txt, &too_big, None).unwrap_err();
    assert_eq!(error.code(), ErrorCode::TooLarge);
    let error = write_list(&target, CitationFileFormat::Txt, &[], None).unwrap_err();
    assert_eq!(error.code(), ErrorCode::InvalidArgument);
    assert!(dir.names().is_empty());
}

#[test]
fn the_target_is_judged_like_a_save_as_target() {
    let dir = TempDir::new();
    // The extension of the format is added when the dialog left it out.
    let target = admit_target(&dir.path().join("list"), CitationFileFormat::Md).unwrap();
    assert_eq!(target.file_name().unwrap(), "list.md");
    // A folder in the place of the file, a missing folder, an existing file (replaced).
    fs::create_dir(dir.path().join("folder.txt")).unwrap();
    assert!(admit_target(&dir.path().join("folder.txt"), CitationFileFormat::Txt).is_err());
    assert!(admit_target(
        &dir.path().join("missing").join("a.txt"),
        CitationFileFormat::Txt
    )
    .is_err());
    fs::write(dir.path().join("old.txt"), "old").unwrap();
    let blocks = [block(&[("new", false)])];
    write_list(
        &dir.path().join("old.txt"),
        CitationFileFormat::Txt,
        &blocks,
        None,
    )
    .unwrap();
    assert_eq!(
        fs::read_to_string(dir.path().join("old.txt")).unwrap(),
        "new\n"
    );
}

#[test]
fn default_names_follow_the_style_and_the_format() {
    assert_eq!(
        default_file_name(
            "Paper",
            CitationFileFormat::Html,
            CitationStyle::Chicago17AuthorDate
        ),
        "Paper - citations (Chicago 17).html"
    );
    assert_eq!(
        default_file_name("Paper", CitationFileFormat::Ris, CitationStyle::Mla9),
        "Paper - reference.ris"
    );
}
