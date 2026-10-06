//! The gate of line-wise text editing (ADR-125, v1.5.1): of the characters a user could click on in real documents, how many does the
//! mapping (walker + lines + probe) bring to a line? The corpus is not in the repository (`review/owner/corpus/`, `review/corpus-gen/`,
//! ADR-126), so the test is `#[ignore]`d: `cargo test --test text_edit_hitrate -- --ignored --nocapture`.
//!
//! Per file and page up to 50 characters of PDFium's text layer (not the ones PDFium made up) are probed. Outcomes: *mapped* (a line
//! that can be edited, in its own or the substitute font), *refused* (a line found but refused for its class: scripts, encodings,
//! forms, ...), *unmapped* (no line, a miss), *invisible* (the OCR layer of a scan, left out of the denominator). The gate is the
//! share of probes that found a line, `(mapped + refused) / (all - invisible)`; the share of editable lines is printed beside it.

#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use sheer_lib::commands::AppState;
use sheer_lib::engine::{self, Engine};
use sheer_lib::model::text_edit::{LineEditable, TextEditRefusal};
use sheer_lib::pdfwrite::text_io::PageDoc;
use sheer_lib::pdfwrite::text_lines;

const SAMPLES_PER_PAGE: usize = 50;
const GATE: f64 = 0.90;

#[derive(Default, Clone)]
struct Tally {
    pages: usize,
    mapped: usize,
    unmapped: usize,
    invisible: usize,
    refused: BTreeMap<String, usize>,
}

impl Tally {
    fn refused_total(&self) -> usize {
        self.refused.values().sum()
    }

    fn denominator(&self) -> usize {
        self.mapped + self.unmapped + self.refused_total()
    }

    fn found_rate(&self) -> f64 {
        let d = self.denominator();
        if d == 0 {
            1.0
        } else {
            (self.mapped + self.refused_total()) as f64 / d as f64
        }
    }

    fn editable_rate(&self) -> f64 {
        let d = self.denominator();
        if d == 0 {
            1.0
        } else {
            self.mapped as f64 / d as f64
        }
    }

    fn add(&mut self, other: &Tally) {
        self.pages += other.pages;
        self.mapped += other.mapped;
        self.unmapped += other.unmapped;
        self.invisible += other.invisible;
        for (k, v) in &other.refused {
            *self.refused.entry(k.clone()).or_default() += v;
        }
    }

    fn line(&self) -> String {
        format!(
            "{} pages, {} probes: mapped {}, refused {} {:?}, unmapped {}, invisible {} (excluded) -> found {:.1} %, editable {:.1} %",
            self.pages,
            self.denominator() + self.invisible,
            self.mapped,
            self.refused_total(),
            self.refused,
            self.unmapped,
            self.invisible,
            100.0 * self.found_rate(),
            100.0 * self.editable_rate()
        )
    }
}

fn pdfs_in(dir: &Path) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = std::fs::read_dir(dir)
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .map(|e| e.path())
                .filter(|p| p.extension().is_some_and(|e| e.eq_ignore_ascii_case("pdf")))
                .collect()
        })
        .unwrap_or_default();
    out.sort();
    out
}

fn file_tally(state: &AppState, path: &Path) -> Result<Tally, String> {
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    let doc = PageDoc::load(&bytes).map_err(|e| format!("load: {e:?}"))?;
    let pages = doc.pages();
    let info = loop {
        match state.open_path(path.to_path_buf()) {
            Ok(Some(info)) => break info,
            Ok(None) => std::thread::sleep(Duration::from_millis(10)),
            Err(e) => return Err(format!("open: {e:?}")),
        }
    };
    let mut tally = Tally::default();
    for (index, object) in pages.iter().enumerate().take(info.page_count as usize) {
        let chars = match state
            .engine()
            .page_chars(info.id, u32::try_from(index).unwrap())
        {
            Ok(chars) => chars,
            Err(e) => {
                eprintln!("  page {index}: page_chars: {e:?}");
                continue;
            }
        };
        let real: Vec<_> = chars.iter().filter(|c| !c.generated).collect();
        if real.is_empty() {
            continue;
        }
        tally.pages += 1;
        let step = real.len().div_ceil(SAMPLES_PER_PAGE).max(1);
        let sample: Vec<_> = real.iter().step_by(step).take(SAMPLES_PER_PAGE).collect();
        let mut lines = match doc.lines(*object, &chars) {
            Ok(lines) => lines,
            Err(e) => {
                eprintln!("  page {index}: lines: {e:?}");
                tally.unmapped += sample.len();
                continue;
            }
        };
        if let Err(e) = doc.refuse(&mut lines, None) {
            eprintln!("  page {index}: refuse: {e:?}");
        }
        for c in sample {
            let probe = text_lines::probe(&lines, &chars, c.utf16).unwrap();
            let unmapped = probe.key.line == u32::MAX;
            match probe.editable {
                _ if unmapped => tally.unmapped += 1,
                LineEditable::No {
                    reason: TextEditRefusal::Invisible,
                } => tally.invisible += 1,
                LineEditable::No {
                    reason: TextEditRefusal::Unmapped,
                } => tally.unmapped += 1,
                LineEditable::No { reason } => {
                    // The reason as the UI's wire name (`camelCase`).
                    let name = serde_json::to_value(reason)
                        .ok()
                        .and_then(|v| v.as_str().map(str::to_owned))
                        .unwrap_or_default();
                    *tally.refused.entry(name).or_default() += 1;
                }
                LineEditable::Same | LineEditable::Fallback { .. } => tally.mapped += 1,
            }
        }
    }
    let _ = state.close_document(info.id);
    Ok(tally)
}

#[test]
#[ignore = "needs the untracked corpus in review/ and the PDFium library"]
fn the_mapping_finds_a_line_for_nine_in_ten_clicks() {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let library = engine::library_path(&manifest.join("pdfium"));
    if !library.is_file() {
        eprintln!("skipping: {} not found", library.display());
        return;
    }
    let state = AppState::new(Engine::start(library));
    let mut files: Vec<PathBuf> = Vec::new();
    for dir in ["review/owner/corpus", "review/corpus-gen"] {
        files.extend(pdfs_in(&manifest.join("..").join(dir)));
    }
    // `HITRATE_FILTER=text` limits the run to files whose name contains it.
    if let Ok(filter) = std::env::var("HITRATE_FILTER") {
        files.retain(|p| p.to_string_lossy().contains(&filter));
    }
    if files.is_empty() {
        eprintln!("skipping: no corpus under review/");
        return;
    }
    let mut overall = Tally::default();
    let mut skipped = 0;
    for path in &files {
        let started = Instant::now();
        let name = path.file_name().unwrap().to_string_lossy();
        match file_tally(&state, path) {
            Ok(tally) => {
                println!(
                    "{name}: {} [{:.1} s]",
                    tally.line(),
                    started.elapsed().as_secs_f64()
                );
                overall.add(&tally);
            }
            Err(why) => {
                skipped += 1;
                println!("{name}: skipped ({why})");
            }
        }
    }
    println!(
        "OVERALL ({} files, {skipped} skipped): {}",
        files.len() - skipped,
        overall.line()
    );
    assert!(
        overall.found_rate() >= GATE,
        "overall found rate {:.1} % is below the gate of {:.0} %",
        100.0 * overall.found_rate(),
        100.0 * GATE
    );
}
