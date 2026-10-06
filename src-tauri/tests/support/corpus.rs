//! The owner's private test corpus (`review/owner/`, git-ignored; ADR-133). Tests name files by ID (`owner-pdf-E4`, `corpus-07`) and
//! probe text that is personal data by key (`corpus-05/address-line`); the only mapping is the untracked `review/owner/INDEX.md`
//! (tables: `| ID | file |` and `| key | text |`). Every function returns `None` and prints why when the index or the file is missing,
//! so a test can skip with a clear message.

use std::path::PathBuf;

fn owner_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../review/owner")
}

/// The table rows of `INDEX.md` as `(first column, second column)`; header and separator rows are dropped.
fn rows() -> Option<Vec<(String, String)>> {
    let text = match std::fs::read_to_string(owner_dir().join("INDEX.md")) {
        Ok(t) => t,
        Err(_) => {
            eprintln!("skipping: review/owner/INDEX.md is missing (ADR-133)");
            return None;
        }
    };
    Some(
        text.lines()
            .filter(|l| l.starts_with('|'))
            .filter_map(|l| {
                let cells: Vec<&str> = l.trim_matches('|').split('|').map(str::trim).collect();
                match cells.as_slice() {
                    [a, b, ..] if !a.starts_with("---") && *a != "ID" && *a != "Key" => {
                        Some(((*a).to_owned(), (*b).to_owned()))
                    }
                    _ => None,
                }
            })
            .collect(),
    )
}

/// The path of the corpus file with this ID, when it is listed and present.
pub fn file(id: &str) -> Option<PathBuf> {
    let name = rows()?
        .into_iter()
        .find(|(k, _)| k == id)
        .map(|(_, v)| v)
        .or_else(|| {
            eprintln!("skipping: {id} is not listed in review/owner/INDEX.md");
            None
        })?;
    let path = owner_dir().join("corpus").join(name);
    if path.is_file() {
        Some(path)
    } else {
        eprintln!("skipping: the file of {id} is not in review/owner/corpus");
        None
    }
}

/// Probe text (personal data kept out of the repository) by key, e.g. `corpus-05/address-line`.
pub fn probe(key: &str) -> Option<String> {
    let found = rows()?.into_iter().find(|(k, _)| k == key).map(|(_, v)| v);
    if found.is_none() {
        eprintln!("skipping: probe {key} is not listed in review/owner/INDEX.md");
    }
    found
}

/// Every listed file ID that is present, in index order.
pub fn all_ids() -> Vec<String> {
    rows()
        .unwrap_or_default()
        .into_iter()
        .filter(|(k, _)| {
            (k.starts_with("owner-pdf-") || k.starts_with("corpus-")) && !k.contains('/')
        })
        .map(|(k, _)| k)
        .collect()
}

/// The ID of a corpus file path (so its name is never printed), `None` when it is not listed.
pub fn id_of(path: &std::path::Path) -> Option<String> {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned());
    rows()
        .and_then(|r| r.into_iter().find(|(_, v)| Some(v) == name.as_ref()))
        .map(|(k, _)| k)
}
