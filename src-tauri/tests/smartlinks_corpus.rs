//! Smart links on the owner's real documents (v1.6, ADR-132): how many links each detector finds, a sample of each kind and anything that
//! looks wrong. The corpus is not in the repository (`review/owner/corpus/`, ADR-126), so the test is `#[ignore]`d:
//! `cargo test --test smartlinks_corpus -- --ignored --nocapture`. `SMARTLINKS_FILES="a.pdf;b.pdf"` limits the files. Nothing is asserted
//! about counts: the output is read by a person; only "no crash, no error, no timeout" is.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use sheer_lib::commands::smart_links::SmartLinksInfo;
use sheer_lib::commands::AppState;
use sheer_lib::documents::PageId;
use sheer_lib::engine::{self, Engine};

/// Pages looked at per file at most (evenly spread when the file has more).
const MAX_PAGES: u32 = 400;

fn files() -> Vec<String> {
    if let Ok(list) = std::env::var("SMARTLINKS_FILES") {
        return list.split(';').map(str::to_owned).collect();
    }
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../review/owner/corpus");
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .map(|rd| {
            rd.filter_map(Result::ok)
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .filter(|n| n.to_lowercase().ends_with(".pdf"))
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    names
}

fn cut(s: &str, n: usize) -> String {
    let flat: String = s
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    if flat.chars().count() <= n {
        flat
    } else {
        format!("{}...", flat.chars().take(n).collect::<String>())
    }
}

#[test]
#[ignore = "needs review/owner/corpus (ADR-126) and PDFium"]
fn smart_links_on_the_corpus() {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let library = engine::library_path(&manifest.join("pdfium"));
    if !library.is_file() {
        eprintln!("skipping: PDFium not found");
        return;
    }
    let samples_max: usize = std::env::var("SMARTLINKS_SAMPLES")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(4);
    let engine = Engine::start(library);
    let state = AppState::new(engine.clone());
    let dump: Option<u32> = std::env::var("SMARTLINKS_DUMP")
        .ok()
        .and_then(|s| s.parse().ok());
    let mut summary: Vec<(String, u32, BTreeMap<String, usize>, usize)> = Vec::new();
    for name in files() {
        let path = manifest.join("../review/owner/corpus").join(&name);
        if !path.is_file() {
            eprintln!("== {name}: not found");
            continue;
        }
        let started = Instant::now();
        let info = match loop {
            match state.open_path(path.clone()) {
                Ok(Some(info)) => break Ok(info),
                Ok(None) => std::thread::sleep(Duration::from_millis(10)),
                Err(e) => break Err(e),
            }
        } {
            Ok(info) => info,
            Err(e) => {
                eprintln!("== {name}: open failed {:?}", e.code());
                continue;
            }
        };
        let count = info.page_count;
        if let Some(p) = dump {
            let page = engine.smart_text(info.id, p).unwrap();
            println!(
                "-- page {p}: body {} size, {} lines",
                page.body_size,
                page.lines.len()
            );
            for l in page.lines.iter().take(60) {
                let runs: Vec<String> = l
                    .runs
                    .iter()
                    .map(|r| {
                        format!(
                            "[{:.1}/{:.1}{}] {}",
                            r.size,
                            r.baseline,
                            if r.bold { "b" } else { "" },
                            cut(&r.text, 60)
                        )
                    })
                    .collect();
                println!("   y{:.0} {}", l.rect.y, runs.join(" | "));
            }
        }
        // Ready: the first call starts the build; ask until the index is there.
        let first = PageId::new(0);
        let mut ready_after = None;
        let deadline = Instant::now() + Duration::from_secs(120);
        while Instant::now() < deadline {
            let r = state.smart_links(info.id, first).unwrap();
            if r.ready {
                ready_after = Some(started.elapsed());
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let Some(ready_after) = ready_after else {
            eprintln!("== {name}: {count} pages, index NOT ready after 120 s");
            continue;
        };
        let step = (count / MAX_PAGES).max(1);
        let mut per_kind: BTreeMap<String, usize> = BTreeMap::new();
        let mut samples: BTreeMap<String, Vec<String>> = BTreeMap::new();
        let mut wrong: Vec<String> = Vec::new();
        let mut slowest = Duration::ZERO;
        let mut looked = 0u32;
        let mut page = 0;
        while page < count {
            let t = Instant::now();
            let r: SmartLinksInfo = state.smart_links(info.id, PageId::new(page)).unwrap();
            slowest = slowest.max(t.elapsed());
            looked += 1;
            for l in &r.links {
                let kind = serde_json::to_value(l.kind)
                    .unwrap()
                    .as_str()
                    .unwrap()
                    .to_owned();
                *per_kind.entry(kind.clone()).or_insert(0) += 1;
                let target = l.target.page_id.get();
                let line = format!(
                    "p{} {:?} -> p{} {:?}",
                    page + 1,
                    cut(&l.marker, 40),
                    target + 1,
                    cut(&l.preview, 90)
                );
                let sample = samples.entry(kind.clone()).or_default();
                if sample.len() < samples_max {
                    sample.push(line.clone());
                }
                // Heuristics for "obviously wrong".
                let footnote_far = kind == "footnote" && target != page && target != page + 1;
                let contents_blank = kind == "contents" && l.preview.is_empty();
                let long_marker = kind == "footnote" && l.marker.chars().count() > 3;
                let own_page_ref = kind == "reference" && target == page && l.preview.is_empty();
                if (footnote_far || contents_blank || long_marker || own_page_ref)
                    && wrong.len() < 8
                {
                    wrong.push(line);
                }
            }
            page += step;
        }
        let total: usize = per_kind.values().sum();
        println!(
            "== {name}: {count} pages, {looked} looked at, ready after {:.1}s, slowest page {:?}, {total} links {per_kind:?}",
            ready_after.as_secs_f32(),
            slowest
        );
        for (kind, lines) in &samples {
            for line in lines {
                println!("   {kind:<10} {line}");
            }
        }
        for line in &wrong {
            println!("   SUSPECT    {line}");
        }
        summary.push((name, count, per_kind, wrong.len()));
        let _ = state.close_document(info.id);
    }
    println!("\n-- summary (footnote + contents first) --");
    summary.sort_by_key(|(_, _, k, _)| {
        std::cmp::Reverse(
            k.get("footnote").copied().unwrap_or(0).min(50)
                + k.get("contents").copied().unwrap_or(0).min(50),
        )
    });
    for (name, count, kinds, suspects) in &summary {
        println!("{name}: {count} pages {kinds:?} suspects {suspects}");
    }
}
