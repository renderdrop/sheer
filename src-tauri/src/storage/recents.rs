//! Recent files: a small JSON file in the app data directory, mirrored in memory (ARCHITECTURE section 4, DESIGN 3.11).
//!
//! Stored shape: `{ "version": 1, "files": [{ "path": "...", "lastOpened": 1700000000 }] }`, newest first, at most
//! `limits::MAX_RECENTS` entries. The paths are the only place where the app keeps the location of a file the user opened; they
//! never leave Rust. The UI sees a [`RecentEntry`] (`id`, `displayName`, `lastOpened`, `missing`) and names an entry by its `id`,
//! a number that is handed out when the entry is read or added and is only good for this run.
//!
//! - **Reading** never fails: a missing, oversized, damaged or hand-edited file means an empty list, entry by entry (the file is
//!   user-writable, so nothing in it is trusted: a path must be absolute, without NUL and within `MAX_RECENT_PATH_CHARS`;
//!   duplicates and the entries beyond the cap are dropped). Only a regular file is read, judged on the opened handle, and
//!   never more than `limits::MAX_RECENTS_FILE_BYTES` of it.
//! - **Writing** is atomic (`storage::atomic`). A write that fails is logged and the list in memory stays as it is: recents are a
//!   convenience, never a reason to refuse opening a file.
//! - **Missing files.** A listed file that is gone is reported as `missing` (the UI offers to remove it); the entry is not deleted
//!   behind the user's back, because the file may be on a drive that is not connected right now.
//! - The welcome document and anything else that is not a file of the user is never recorded; that is the caller's rule
//!   (`AppState`), this module records what it is told.

use std::fs::File;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::Value;

use crate::documents::display_name;
use crate::error::AppError;
use crate::limits;
use crate::storage::atomic::write_atomic;
use crate::storage::open_without_blocking;

/// File name inside the app data directory.
pub const FILE_NAME: &str = "recents.json";

/// What the UI is told about a recent file: no path, no folder. `last_opened` is in seconds since 1970 (0 = unknown).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentEntry {
    pub id: u32,
    pub display_name: String,
    pub last_opened: u64,
    pub missing: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Recent {
    id: u32,
    path: PathBuf,
    last_opened: u64,
}

#[derive(Debug, Default)]
struct State {
    /// Newest first.
    items: Vec<Recent>,
    next_id: u32,
}

impl State {
    fn fresh_id(&mut self) -> u32 {
        let id = self.next_id;
        // Ids are never reused within a run; 2^32 additions are not going to happen, and wrapping would only repeat one.
        self.next_id = self.next_id.wrapping_add(1);
        id
    }
}

/// The recent files of the running app: in memory, backed by one file. Managed state (`Arc<RecentsStore>`).
#[derive(Debug)]
pub struct RecentsStore {
    path: PathBuf,
    state: Mutex<State>,
    /// Serialises the writes, so the file is in the order of memory. Held across the fsync; `state` never is.
    writer: Mutex<()>,
}

impl RecentsStore {
    /// Loads the list at `path`. Never fails; see the module documentation.
    pub fn load(path: PathBuf) -> Self {
        let mut state = State::default();
        match read_bounded(&path) {
            Ok(bytes) => {
                for (path, last_opened) in parse(&bytes) {
                    let id = state.fresh_id();
                    state.items.push(Recent {
                        id,
                        path,
                        last_opened,
                    });
                }
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => AppError::from(error).log(),
        }
        Self {
            path,
            state: Mutex::new(state),
            writer: Mutex::new(()),
        }
    }

    /// The list for the UI, newest first, with `missing` set for the files that are not there now. The check touches the file
    /// system (a file on a network drive can be slow): call it from the blocking pool, never from an async worker.
    pub fn list(&self) -> Vec<RecentEntry> {
        let items = self.lock().items.clone();
        items
            .into_iter()
            .map(|item| RecentEntry {
                id: item.id,
                display_name: display_name(&item.path),
                last_opened: item.last_opened,
                // A file that cannot be examined (permissions) is not reported gone: opening it says what is wrong.
                missing: matches!(item.path.try_exists(), Ok(false)),
            })
            .collect()
    }

    /// The path of entry `id`, for the backend to open. `None` for an id that is not (or no longer) in the list.
    pub fn path_of(&self, id: u32) -> Option<PathBuf> {
        self.lock()
            .items
            .iter()
            .find(|item| item.id == id)
            .map(|item| item.path.clone())
    }

    /// Notes that the file at `path` (absolute, canonical) was opened now: it goes to the front, keeping its id if it was listed,
    /// and the list is cut at the cap. A path that is not UTF-8 cannot be stored and is skipped.
    pub fn record(&self, path: &Path) {
        self.record_at(path, now());
    }

    fn record_at(&self, path: &Path, opened: u64) {
        if !storable(path) {
            return;
        }
        self.change(|state| {
            let id = match state.items.iter().position(|item| item.path == path) {
                Some(index) => state.items.remove(index).id,
                None => state.fresh_id(),
            };
            state.items.insert(
                0,
                Recent {
                    id,
                    path: path.to_path_buf(),
                    last_opened: opened,
                },
            );
            state.items.truncate(limits::MAX_RECENTS);
            true
        });
    }

    /// Removes entry `id`; `false` if there was none. The file itself is not touched.
    pub fn remove(&self, id: u32) -> bool {
        self.change(|state| {
            let before = state.items.len();
            state.items.retain(|item| item.id != id);
            state.items.len() != before
        })
    }

    /// Applies `edit` to the list and persists the result if `edit` says it changed something. Returns that answer.
    fn change(&self, edit: impl FnOnce(&mut State) -> bool) -> bool {
        // The lock guards no data (`()`), so a poisoned one is safe to keep using.
        let _writer = self.writer.lock().unwrap_or_else(PoisonError::into_inner);
        let snapshot = {
            let mut state = self.lock();
            if !edit(&mut state) {
                return false;
            }
            state.items.clone()
        };
        self.persist(&snapshot);
        true
    }

    fn persist(&self, items: &[Recent]) {
        let files: Vec<Value> = items
            .iter()
            .filter_map(|item| {
                let path = item.path.to_str()?;
                Some(serde_json::json!({ "path": path, "lastOpened": item.last_opened }))
            })
            .collect();
        let document = serde_json::json!({ "version": 1, "files": files });
        let written = serde_json::to_vec_pretty(&document)
            .map_err(io::Error::other)
            .and_then(|mut bytes| {
                bytes.push(b'\n');
                write_atomic(&self.path, &bytes)
            });
        if let Err(error) = written {
            AppError::from(error).log();
        }
    }

    /// A panic elsewhere cannot leave the list half-updated (each edit is one step under the lock), so a poisoned lock is safe.
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs())
}

/// Whether a path may be kept: absolute, UTF-8 (the file is JSON), without NUL, within the length bound.
fn storable(path: &Path) -> bool {
    let Some(text) = path.to_str() else {
        return false;
    };
    path.is_absolute()
        && !text.contains('\0')
        && !text.is_empty()
        && text.chars().count() <= limits::MAX_RECENT_PATH_CHARS
}

/// The entries of a stored file, newest first, each valid and unique, at most `MAX_RECENTS`. Anything else in it is ignored.
fn parse(bytes: &[u8]) -> Vec<(PathBuf, u64)> {
    let Ok(Value::Object(map)) = serde_json::from_slice::<Value>(bytes) else {
        return Vec::new();
    };
    let Some(Value::Array(files)) = map.get("files") else {
        return Vec::new();
    };
    let mut found: Vec<(PathBuf, u64)> = Vec::new();
    for file in files {
        let Some(path) = file.get("path").and_then(Value::as_str).map(PathBuf::from) else {
            continue;
        };
        if !storable(&path) || found.iter().any(|(known, _)| *known == path) {
            continue;
        }
        let opened = file.get("lastOpened").and_then(Value::as_u64).unwrap_or(0);
        found.push((path, opened));
        if found.len() == limits::MAX_RECENTS {
            break;
        }
    }
    found
}

/// Reads at most `MAX_RECENTS_FILE_BYTES` of a regular file, judged on the opened handle (see `settings::read_bounded`).
fn read_bounded(path: &Path) -> io::Result<Vec<u8>> {
    let file: File = open_without_blocking(path)?;
    if !file.metadata()?.is_file() {
        return Err(io::Error::from(io::ErrorKind::InvalidData));
    }
    let mut bytes = Vec::new();
    file.take(limits::MAX_RECENTS_FILE_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limits::MAX_RECENTS_FILE_BYTES {
        return Err(io::Error::from(io::ErrorKind::InvalidData));
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;
    use crate::storage::atomic::testutil::TempDir;

    /// An absolute path on every platform, for entries that need not exist.
    fn abs(name: &str) -> PathBuf {
        std::env::temp_dir().join("sheer-recents-test").join(name)
    }

    fn store(dir: &TempDir) -> RecentsStore {
        RecentsStore::load(dir.path().join(FILE_NAME))
    }

    fn names(store: &RecentsStore) -> Vec<String> {
        store.list().into_iter().map(|e| e.display_name).collect()
    }

    #[test]
    fn a_new_store_is_empty_and_a_recorded_file_is_listed_newest_first() {
        let dir = TempDir::new();
        let store = store(&dir);
        assert!(store.list().is_empty());
        store.record_at(&abs("a.pdf"), 10);
        store.record_at(&abs("b.pdf"), 20);
        assert_eq!(names(&store), ["b.pdf", "a.pdf"]);
        assert_eq!(store.list()[0].last_opened, 20);
    }

    #[test]
    fn opening_a_listed_file_again_moves_it_to_the_front_and_keeps_its_id() {
        let dir = TempDir::new();
        let store = store(&dir);
        store.record_at(&abs("a.pdf"), 1);
        store.record_at(&abs("b.pdf"), 2);
        let a = store.list()[1].id;
        store.record_at(&abs("a.pdf"), 3);
        let list = store.list();
        assert_eq!(names(&store), ["a.pdf", "b.pdf"]);
        assert_eq!(list[0].id, a);
        assert_eq!(list[0].last_opened, 3);
    }

    #[test]
    fn the_list_is_capped_and_the_oldest_falls_off() {
        let dir = TempDir::new();
        let store = store(&dir);
        for i in 0..limits::MAX_RECENTS + 5 {
            store.record_at(&abs(&format!("{i}.pdf")), i as u64);
        }
        let list = store.list();
        assert_eq!(list.len(), limits::MAX_RECENTS);
        assert_eq!(
            list[0].display_name,
            format!("{}.pdf", limits::MAX_RECENTS + 4)
        );
        assert_eq!(list[limits::MAX_RECENTS - 1].display_name, "5.pdf");
    }

    #[test]
    fn removing_an_entry_forgets_it_and_an_unknown_id_is_nothing() {
        let dir = TempDir::new();
        let store = store(&dir);
        store.record_at(&abs("a.pdf"), 1);
        store.record_at(&abs("b.pdf"), 2);
        let b = store.list()[0].id;
        assert!(store.remove(b));
        assert!(!store.remove(b));
        assert!(!store.remove(9999));
        assert_eq!(names(&store), ["a.pdf"]);
        assert_eq!(store.path_of(b), None);
    }

    #[test]
    fn the_list_survives_a_restart_and_ids_are_per_run() {
        let dir = TempDir::new();
        {
            let store = store(&dir);
            store.record_at(&abs("a.pdf"), 1);
            store.record_at(&abs("b.pdf"), 2);
        }
        let again = store(&dir);
        assert_eq!(names(&again), ["b.pdf", "a.pdf"]);
        let list = again.list();
        assert_eq!(again.path_of(list[0].id), Some(abs("b.pdf")));
        assert_eq!(list[0].last_opened, 2);
    }

    #[test]
    fn a_file_that_is_gone_is_marked_missing_and_stays_listed() {
        let dir = TempDir::new();
        let present = dir.path().join("here.pdf");
        fs::write(&present, b"%PDF-1.4\n").unwrap();
        let store = store(&dir);
        store.record_at(&present, 1);
        store.record_at(&dir.path().join("gone.pdf"), 2);
        let list = store.list();
        assert_eq!(list[0].display_name, "gone.pdf");
        assert!(list[0].missing);
        assert!(!list[1].missing);
    }

    #[test]
    fn the_ui_gets_ids_and_names_and_no_path() {
        let dir = TempDir::new();
        let store = store(&dir);
        store.record_at(&abs("report.pdf"), 7);
        let json = serde_json::to_string(&store.list()).unwrap();
        assert_eq!(
            json,
            r#"[{"id":0,"displayName":"report.pdf","lastOpened":7,"missing":true}]"#
        );
        assert!(!json.contains("sheer-recents-test"));
    }

    #[test]
    fn a_damaged_or_hostile_file_gives_an_empty_or_cleaned_list() {
        let dir = TempDir::new();
        let file = dir.path().join(FILE_NAME);
        for junk in [
            &b""[..],
            b"not json",
            b"[]",
            b"{\"files\": 5}",
            b"{\"files\": [1, null, {\"path\": 3}, {\"path\": \"relative.pdf\"}, {\"path\": \"\"}]}",
        ] {
            fs::write(&file, junk).unwrap();
            assert!(RecentsStore::load(file.clone()).list().is_empty());
        }
        // Valid entries survive their bad neighbours; duplicates, NUL and overlong paths do not.
        let good = abs("good.pdf");
        let long = abs(&"x".repeat(limits::MAX_RECENT_PATH_CHARS));
        let text = serde_json::json!({ "files": [
            { "path": good.to_str().unwrap() },
            { "path": good.to_str().unwrap(), "lastOpened": 5 },
            { "path": format!("{}\u{0}", good.to_str().unwrap()) },
            { "path": long.to_str().unwrap() },
            { "path": abs("late.pdf").to_str().unwrap(), "lastOpened": -1 },
        ]});
        fs::write(&file, text.to_string()).unwrap();
        let store = RecentsStore::load(file);
        assert_eq!(names(&store), ["good.pdf", "late.pdf"]);
        assert_eq!(store.list()[1].last_opened, 0);
    }

    #[test]
    fn a_stored_list_longer_than_the_cap_is_cut() {
        let dir = TempDir::new();
        let files: Vec<Value> = (0..limits::MAX_RECENTS + 10)
            .map(|i| serde_json::json!({ "path": abs(&format!("{i}.pdf")).to_str().unwrap() }))
            .collect();
        fs::write(
            dir.path().join(FILE_NAME),
            serde_json::json!({ "files": files }).to_string(),
        )
        .unwrap();
        assert_eq!(store(&dir).list().len(), limits::MAX_RECENTS);
    }

    #[test]
    fn an_oversized_file_or_a_directory_at_the_path_is_an_empty_list() {
        let dir = TempDir::new();
        let file = dir.path().join(FILE_NAME);
        let mut big = String::from("{\"files\":[],\"pad\":\"");
        big.push_str(&"x".repeat(limits::MAX_RECENTS_FILE_BYTES as usize));
        big.push_str("\"}");
        fs::write(&file, big).unwrap();
        assert!(RecentsStore::load(file.clone()).list().is_empty());
        fs::remove_file(&file).unwrap();
        fs::create_dir(&file).unwrap();
        assert!(RecentsStore::load(file).list().is_empty());
    }

    #[test]
    fn paths_that_cannot_be_kept_are_not_recorded() {
        let dir = TempDir::new();
        let store = store(&dir);
        store.record_at(Path::new("relative.pdf"), 1);
        store.record_at(Path::new(""), 1);
        assert!(store.list().is_empty());
        assert!(!dir.path().join(FILE_NAME).exists(), "nothing to write");
    }

    #[test]
    fn a_failed_write_keeps_the_list_in_memory() {
        let dir = TempDir::new();
        // A directory where the file should be makes the atomic rename fail.
        fs::create_dir(dir.path().join(FILE_NAME)).unwrap();
        let store = store(&dir);
        store.record_at(&abs("a.pdf"), 1);
        assert_eq!(names(&store), ["a.pdf"]);
    }
}
