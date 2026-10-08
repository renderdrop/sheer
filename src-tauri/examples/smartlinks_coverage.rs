//! Smart-links coverage gate (F19.20, ADR-143). Corpus files are named by ID only (rule 16): IDs resolve through the untracked
//! `review/owner/INDEX.md`; the untracked `review/owner/footnotes-truth.json` (`{"<ID>": <true marker count>}`) is the hand-counted truth.
//!
//! ```text
//! npm run cargo -- run --example smartlinks_coverage -- [ids...]   # default: every ID with a truth entry
//! ```
//!
//! Prints per ID: footnote links (linked), true markers, coverage, headings found, merged outline entries, partial flag.

use std::collections::BTreeMap;
use std::fs::File;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use sheer_lib::documents::Registry;
use sheer_lib::engine::{library_path, Engine};
use sheer_lib::smartlinks::index;
use sheer_lib::smartlinks::model::Kind;
use sheer_lib::smartlinks::outline;

fn repo() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..")
}

fn index_rows() -> Vec<(String, String)> {
    let text = std::fs::read_to_string(repo().join("review/owner/INDEX.md")).unwrap_or_default();
    text.lines()
        .filter(|l| l.starts_with('|'))
        .filter_map(|l| {
            let cells: Vec<&str> = l.trim_matches('|').split('|').map(str::trim).collect();
            match cells.as_slice() {
                [a, b, ..] if !a.starts_with("---") && *a != "ID" => {
                    Some(((*a).to_owned(), (*b).to_owned()))
                }
                _ => None,
            }
        })
        .collect()
}

fn main() {
    let library = library_path(&PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("pdfium"));
    let engine = Engine::start(library);
    let registry = Registry::new();
    let truth: BTreeMap<String, u64> =
        std::fs::read_to_string(repo().join("review/owner/footnotes-truth.json"))
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default();
    let mut ids: Vec<String> = std::env::args().skip(1).collect();
    if ids.is_empty() {
        ids = if truth.is_empty() {
            index_rows()
                .into_iter()
                .map(|r| r.0)
                .filter(|k| k.starts_with("owner-pdf-") || k.starts_with("corpus-"))
                .collect()
        } else {
            truth.keys().cloned().collect()
        };
    }
    let mode = std::env::var("SL_MODE").unwrap_or_default();
    println!("id | pages | partial | fn_links | fn_true | coverage | headings | outline | secs");
    for id in ids {
        let Some(name) = index_rows()
            .into_iter()
            .find(|(k, _)| *k == id)
            .map(|r| r.1)
        else {
            println!("{id} | unknown id");
            continue;
        };
        let base = if id.starts_with("owner-pdf-") || id.starts_with("corpus-") {
            "review/owner/corpus"
        } else {
            "review/owner"
        };
        let path = repo().join(base).join(name);
        let Ok(did) = registry.register(path.clone()) else {
            println!("{id} | register failed");
            continue;
        };
        let Ok(file) = File::open(&path) else {
            continue;
        };
        let Ok(count) = engine.open(did, file, |_| true) else {
            println!("{id} | open failed");
            continue;
        };
        if mode == "raw" {
            raw(
                &engine,
                did,
                std::env::var("SL_FROM")
                    .ok()
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(0),
            );
            continue;
        }
        if mode == "notes" {
            let n = notes(&engine, did, count);
            let total: usize = n.iter().map(|x| x.1.len()).sum();
            println!("{id} note starts: {total}");
            if std::env::var("SL_V").is_ok() {
                for (p, k) in n {
                    println!("p{p}: {}", k.join(","));
                }
            }
            continue;
        }
        if mode == "heads" {
            if let Some(r) = &ready_for_heads(&engine, did, count) {
                heads(&outline::outline(&r.doc, &r.analysis));
            }
            continue;
        }
        if mode == "scan" {
            println!("{id} sup/bracket/symbol: {:?}", scan(&engine, did, count));
            continue;
        }
        if mode == "dump" {
            let a: u32 = std::env::var("SL_FROM")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(0);
            let b: u32 = std::env::var("SL_TO")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(1);
            dump(&engine, did, a, b.min(count));
            continue;
        }
        let t0 = Instant::now();
        let ready = index::build(
            count,
            Vec::new(),
            0,
            Instant::now() + Duration::from_secs(600),
            |pos| {
                engine
                    .smart_text(did, pos)
                    .map_err(|_| index::ReadFail::Page)
            },
            || false,
        );
        let Some(ready) = ready else {
            println!("{id} | build failed");
            continue;
        };
        let mut linked = 0usize;
        let list = mode == "list";
        for p in 0..count {
            let pl = index::page_links(&ready.doc, &ready.analysis, p);
            if list {
                let k: Vec<String> = pl
                    .iter()
                    .filter(|l| l.kind == Kind::Footnote)
                    .map(|l| l.marker.clone())
                    .collect();
                if !k.is_empty() {
                    println!("p{p}: {}", k.join(","));
                }
            }
            linked += pl.iter().filter(|l| l.kind == Kind::Footnote).count();
        }
        let heads = outline::headings(&ready.doc);
        let merged = outline::outline(&ready.doc, &ready.analysis);
        let tr = truth.get(&id).copied();
        let cov = tr.map_or(String::from("-"), |t| {
            if t == 0 {
                "-".into()
            } else {
                format!("{:.1}%", 100.0 * linked as f64 / t as f64)
            }
        });
        println!(
            "{id} | {count} | {} | {linked} | {} | {cov} | {} | {} | {:.1}",
            ready.partial,
            tr.map_or("-".into(), |t| t.to_string()),
            heads.len(),
            merged.len(),
            t0.elapsed().as_secs_f32()
        );
    }
}

/// `dump <id> <from> <to>`: lines of pages with raised or small runs shown as `⟦..⟧` (for the hand count of the truth file).
/// `scan`: a loose, detector-independent count of marker-like runs per ID.
pub fn dump(engine: &Engine, did: sheer_lib::documents::DocumentId, from: u32, to: u32) {
    for p in from..to {
        let Ok(page) = engine.smart_text(did, p) else {
            continue;
        };
        println!("=== page {p} body {:.1}", page.body_size);
        for line in &page.lines {
            let base = line
                .runs
                .iter()
                .map(|r| r.baseline)
                .fold(f32::MIN, f32::max);
            let mut s = String::new();
            for r in &line.runs {
                let small = r.text.trim().chars().count() <= 4
                    && (r.size < 0.85 * page.body_size || base - r.baseline > 0.2 * page.body_size);
                if small {
                    s.push_str(&format!("⟦{}⟧", r.text));
                } else {
                    s.push_str(&r.text);
                }
            }
            if s.contains("⟦") {
                println!("{s}");
            }
        }
    }
}

pub fn scan(
    engine: &Engine,
    did: sheer_lib::documents::DocumentId,
    count: u32,
) -> (usize, usize, usize) {
    let (mut sup, mut brk, mut sym) = (0, 0, 0);
    for p in 0..count {
        let Ok(page) = engine.smart_text(did, p) else {
            continue;
        };
        for line in &page.lines {
            let base = line
                .runs
                .iter()
                .map(|r| r.baseline)
                .fold(f32::MIN, f32::max);
            for (i, r) in line.runs.iter().enumerate() {
                let t = r.text.trim();
                let small = r.text.trim().chars().count() <= 4
                    && (r.size < 0.85 * page.body_size || base - r.baseline > 0.2 * page.body_size);
                if i > 0
                    && small
                    && !t.is_empty()
                    && t.chars()
                        .all(|c| c.is_ascii_digit() || "⁰¹²³⁴⁵⁶⁷⁸⁹".contains(c))
                {
                    sup += 1;
                }
                if i > 0 && (t == "*" || t == "**" || t == "†" || t == "‡") {
                    sym += 1;
                }
                let b = t.as_bytes();
                for w in 0..b.len() {
                    if b[w] == b'['
                        && t[w + 1..].find(']').is_some_and(|e| {
                            (1..=3).contains(&e)
                                && t[w + 1..w + 1 + e].bytes().all(|c| c.is_ascii_digit())
                        })
                    {
                        brk += 1;
                    }
                }
            }
        }
    }
    (sup, brk, sym)
}

/// `raw`: every line of a page with run sizes and baselines (hand diagnosis of a miss).
pub fn raw(engine: &Engine, did: sheer_lib::documents::DocumentId, p: u32) {
    let Ok(page) = engine.smart_text(did, p) else {
        return;
    };
    println!(
        "=== page {p} {}x{} body {:.1}",
        page.width, page.height, page.body_size
    );
    for line in &page.lines {
        let s: Vec<String> = line
            .runs
            .iter()
            .map(|r| {
                format!(
                    "[{:.1}@{:.1} y{:.0} {}]",
                    r.size,
                    r.baseline,
                    r.rect.y,
                    r.text.chars().take(40).collect::<String>()
                )
            })
            .collect();
        println!("{}", s.join(""));
    }
}

/// `notes`: an independent count of note starts (small leading number in the lower part of a page) per page, for the hand-checked truth.
pub fn notes(
    engine: &Engine,
    did: sheer_lib::documents::DocumentId,
    count: u32,
) -> Vec<(u32, Vec<String>)> {
    let mut out = Vec::new();
    for p in 0..count {
        let Ok(page) = engine.smart_text(did, p) else {
            continue;
        };
        let mut keys = Vec::new();
        for line in &page.lines {
            if line.rect.y < 0.6 * page.height {
                continue;
            }
            let Some(first) = line.runs.first() else {
                continue;
            };
            let t = first.text.trim();
            let num = !t.is_empty()
                && t.len() <= 3
                && t.chars()
                    .all(|c| c.is_ascii_digit() || "⁰¹²³⁴⁵⁶⁷⁸⁹*†‡".contains(c));
            if num && first.size < 0.9 * page.body_size.max(first.size) {
                keys.push(t.to_string());
            }
        }
        if !keys.is_empty() {
            out.push((p, keys));
        }
    }
    out
}

/// `heads`: the outline entries found, as `level page title` (title cut), for a look at the quality.
pub fn heads(e: &[sheer_lib::smartlinks::outline::Entry]) {
    for x in e.iter().take(60) {
        println!(
            "{} p{} {}",
            x.level,
            x.page,
            x.title.chars().take(70).collect::<String>()
        );
    }
}

fn ready_for_heads(
    engine: &Engine,
    did: sheer_lib::documents::DocumentId,
    count: u32,
) -> Option<index::Ready> {
    index::build(
        count,
        Vec::new(),
        0,
        Instant::now() + Duration::from_secs(600),
        |pos| {
            engine
                .smart_text(did, pos)
                .map_err(|_| index::ReadFail::Page)
        },
        || false,
    )
}
