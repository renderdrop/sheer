//! Source-detection hit rate (F19.21, ADR-143). Corpus files are named by ID only (rule 16): IDs resolve through the untracked
//! `review/owner/INDEX.md`; the untracked `review/owner/sources-truth.json` holds the hand-checked truth:
//! `{"<ID>": {"title": "...", "authors": ["Family", ...], "year": "2019", "edition": "3", "publisher": "...", "place": "...",
//! "isbn": "978...", "doi": "10....", "kind": "book|article|report|thesis"}}`; a field that is absent from the document is absent here.
//!
//! ```text
//! npm run cargo -- run --example sources_hitrate -- [ids...]   # default: every ID with a truth entry; SH_DUMP=1 prints the hints
//! ```
//!
//! Measures what the page heuristic finds (`Engine::first_page_hints`; metadata is ranked above it in the app). Per field it prints
//! `truth` (documents that have it), `found` (the tool says something), `correct` (matches the truth), `wrong` (found, differs or not
//! in the document).

use std::collections::BTreeMap;
use std::fs::File;
use std::path::PathBuf;

use serde_json::Value;
use sheer_lib::documents::Registry;
use sheer_lib::engine::{library_path, Engine};

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

fn norm(text: &str) -> String {
    text.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

/// Per field: (truth, found, correct, wrong).
#[derive(Default, Clone, Copy)]
struct Tally(u32, u32, u32, u32);

fn main() {
    let library = library_path(&PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("pdfium"));
    let engine = Engine::start(library);
    let registry = Registry::new();
    let truth: BTreeMap<String, Value> =
        std::fs::read_to_string(repo().join("review/owner/sources-truth.json"))
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default();
    let mut ids: Vec<String> = std::env::args().skip(1).collect();
    if ids.is_empty() {
        ids = truth.keys().cloned().collect();
    }
    let dump = std::env::var("SH_DUMP").is_ok();
    let fields = [
        "title",
        "authors",
        "year",
        "edition",
        "publisher",
        "place",
        "isbn",
        "doi",
        "kind",
    ];
    let mut tally: BTreeMap<&str, Tally> = fields.iter().map(|f| (*f, Tally::default())).collect();
    for id in &ids {
        let Some(name) = index_rows().into_iter().find(|(k, _)| k == id).map(|r| r.1) else {
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
        if let Ok(limit) = std::env::var("SH_TEXT") {
            // Dev aid for writing the truth by hand: the first characters of the first pages and the last two.
            let take: usize = limit.parse().unwrap_or(500);
            let (from, to) = std::env::var("SH_RANGE")
                .ok()
                .and_then(|r| {
                    r.split_once('-')
                        .map(|(a, b)| (a.parse().unwrap_or(0), b.parse().unwrap_or(3)))
                })
                .unwrap_or((0, 3));
            let pages = (from..to.min(count)).chain(count.saturating_sub(2).max(to)..count);
            for page in pages {
                if let Ok(text) = engine.text_layer(did, page) {
                    let flat: String = text.text.split_whitespace().collect::<Vec<_>>().join(" ");
                    println!(
                        "{id} p{page}: {}",
                        flat.chars().take(take).collect::<String>()
                    );
                }
            }
            continue;
        }
        let Ok(hints) = engine.first_page_hints(did, 0) else {
            println!("{id} | hints failed");
            continue;
        };
        let json = serde_json::to_value(&hints).unwrap_or(Value::Null);
        if dump {
            println!("{id} | {json}");
        }
        let Some(expected) = truth.get(id) else {
            continue;
        };
        for field in fields {
            let t = tally.entry(field).or_default();
            let want = expected.get(field).filter(|v| !v.is_null());
            let key = match field {
                "container_title" => "containerTitle",
                other => other,
            };
            let got = json.get(key).filter(|v| !v.is_null());
            let got_present = got.is_some_and(|v| !v.as_array().is_some_and(Vec::is_empty));
            if want.is_some() {
                t.0 += 1;
            }
            if got_present {
                t.1 += 1;
            }
            let ok = match (field, want, got) {
                ("authors", Some(w), Some(g)) => {
                    let found: Vec<String> = g
                        .as_array()
                        .map(|a| {
                            a.iter()
                                .filter_map(|p| p.get("family").and_then(Value::as_str))
                                .map(norm)
                                .collect()
                        })
                        .unwrap_or_default();
                    let wanted: Vec<String> = w
                        .as_array()
                        .map(|a| a.iter().filter_map(Value::as_str).map(norm).collect())
                        .unwrap_or_default();
                    !wanted.is_empty()
                        && wanted
                            .iter()
                            .all(|w| found.iter().any(|f| f.contains(w.as_str())))
                }
                (_, Some(w), Some(g)) => {
                    let (w, g) = (
                        norm(w.as_str().unwrap_or("")),
                        norm(g.as_str().unwrap_or("")),
                    );
                    !w.is_empty()
                        && (g == w
                            || (field == "title" && g.contains(&w))
                            || (field == "publisher" && (w.contains(&g) || g.contains(&w))))
                }
                _ => false,
            };
            if dump && !ok && (want.is_some() || got_present) {
                println!("  miss {id} {field}: want {want:?} got {got:?}");
            }
            if ok {
                t.2 += 1;
            } else if got_present {
                t.3 += 1;
            }
        }
    }
    println!("field | truth | found | correct | wrong");
    for (field, t) in tally {
        println!("{field} | {} | {} | {} | {}", t.0, t.1, t.2, t.3);
    }
}
