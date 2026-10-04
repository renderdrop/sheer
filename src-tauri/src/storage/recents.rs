//! Recent files: a small JSON file in the app data directory, mirrored in memory (ARCHITECTURE section 4, DESIGN 3.11).
//!
//! Stored shape: `{ "version": 1, "files": [{ "path": "...", "lastOpened": 1700000000 }] }`, newest first, at most
//! `limits::MAX_RECENTS` entries. The paths are the only place where the app keeps the location of a file the user opened; they
//! never leave Rust. The UI sees a [`RecentEntry`] (`id`, `displayName`, `folder`, `lastOpened`, `missing`) and names an entry by its `id`,
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

/// Most entries per `list` whose file is looked at (the UI shows 8): a slow or dead drive cannot hold a call for 50 timeouts.
const MAX_EXISTENCE_CHECKS: usize = 16;

/// File name inside the app data directory.
pub const FILE_NAME: &str = "recents.json";

/// What the UI is told about a recent file: no path; only the display name of the parent folder (its last segment). `last_opened` is in seconds since 1970 (0 = unknown).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentEntry {
    pub id: u32,
    pub display_name: String,
    pub folder: String,
    pub last_opened: u64,
    pub missing: bool,
    /// Marked by the user ("Markiert"): never pushed off the list by the cap.
    pub starred: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Recent {
    id: u32,
    path: PathBuf,
    last_opened: u64,
    starred: bool,
}

#[derive(Debug, Default)]
struct State {
    /// Newest first.
    items: Vec<Recent>,
    next_id: u32,
    /// Entries taken off the list in this run with the position they had, newest removal last, for "Undo". At most `MAX_RECENTS`.
    removed: Vec<(usize, Recent)>,
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
                for (path, last_opened, starred) in parse(&bytes) {
                    let id = state.fresh_id();
                    state.items.push(Recent {
                        id,
                        path,
                        last_opened,
                        starred,
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
    /// system (a file on a network drive can be slow): call it from the blocking pool, never from an async worker. At most
    /// `MAX_EXISTENCE_CHECKS` entries (the newest) are asked about per call; the others are reported as present.
    pub fn list(&self) -> Vec<RecentEntry> {
        let items = self.lock().items.clone();
        items
            .into_iter()
            .enumerate()
            .map(|(position, item)| RecentEntry {
                id: item.id,
                display_name: display_name(&item.path),
                folder: item.path.parent().map(display_name).unwrap_or_default(),
                last_opened: item.last_opened,
                // A file that cannot be examined (permissions) is not reported gone: opening it says what is wrong.
                starred: item.starred,
                missing: position < MAX_EXISTENCE_CHECKS
                    && storable(&item.path)
                    && matches!(item.path.try_exists(), Ok(false)),
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

    /// The paths of all listed entries (for the thumbnail cache, which keeps nothing else).
    pub fn paths(&self) -> Vec<PathBuf> {
        self.lock()
            .items
            .iter()
            .map(|item| item.path.clone())
            .collect()
    }

    /// Whether the file at `path` is listed.
    pub fn contains(&self, path: &Path) -> bool {
        self.lock().items.iter().any(|item| item.path == path)
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
            let (id, starred) = match state.items.iter().position(|item| item.path == path) {
                Some(index) => {
                    let old = state.items.remove(index);
                    (old.id, old.starred)
                }
                None => (state.fresh_id(), false),
            };
            state.items.insert(
                0,
                Recent {
                    id,
                    path: path.to_path_buf(),
                    last_opened: opened,
                    starred,
                },
            );
            cut_to_cap(&mut state.items);
            true
        });
    }

    /// Removes entry `id`; `false` if there was none. The file itself is not touched.
    pub fn remove(&self, id: u32) -> bool {
        self.change(|state| {
            let Some(index) = state.items.iter().position(|item| item.id == id) else {
                return false;
            };
            let item = state.items.remove(index);
            state.removed.push((index, item));
            if state.removed.len() > limits::MAX_RECENTS {
                state.removed.remove(0);
            }
            true
        })
    }

    /// Puts a removed entry (by its id) back where it was; `false` if it was not removed in this run, or its file was recorded
    /// again meanwhile.
    pub fn restore(&self, id: u32) -> bool {
        self.change(|state| {
            let Some(at) = state.removed.iter().position(|(_, item)| item.id == id) else {
                return false;
            };
            let (index, item) = state.removed.remove(at);
            if state.items.iter().any(|other| other.path == item.path) {
                return false;
            }
            let index = index.min(state.items.len());
            state.items.insert(index, item);
            cut_to_cap(&mut state.items);
            true
        })
    }

    /// Stars or unstars entry `id`. `false` for an unknown id, or when starring would leave no room for a new entry (at most
    /// `MAX_RECENTS - 1` stars). Setting the state an entry already has is a success that writes nothing.
    pub fn set_starred(&self, id: u32, starred: bool) -> bool {
        let mut accepted = false;
        self.change(|state| {
            let stars = state.items.iter().filter(|item| item.starred).count();
            let Some(item) = state.items.iter_mut().find(|item| item.id == id) else {
                return false;
            };
            if item.starred == starred {
                accepted = true;
                return false;
            }
            if starred && stars >= limits::MAX_RECENTS - 1 {
                return false;
            }
            item.starred = starred;
            accepted = true;
            true
        });
        accepted
    }

    /// Points entry `id` at another file (the user located it): the entry keeps its place and id and gets the new path and
    /// the time it is found. Another entry for the same file is dropped. `false` for an unknown id or a path that cannot be kept.
    pub fn relocate(&self, id: u32, path: &Path) -> bool {
        if !storable(path) {
            return false;
        }
        let opened = now();
        self.change(|state| {
            if !state.items.iter().any(|item| item.id == id) {
                return false;
            }
            state
                .items
                .retain(|item| item.id == id || item.path != path);
            if let Some(item) = state.items.iter_mut().find(|item| item.id == id) {
                item.path = path.to_path_buf();
                item.last_opened = opened;
            }
            true
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
                Some(serde_json::json!({
                    "path": path,
                    "lastOpened": item.last_opened,
                    "starred": item.starred,
                }))
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
pub(crate) fn storable(path: &Path) -> bool {
    let Some(text) = path.to_str() else {
        return false;
    };
    path.is_absolute()
        // A network, device or stream spelling is never kept, so it is never asked about: that would reach out to the network.
        && crate::documents::intake::spelling_is_plain(path)
        && !text.contains('\0')
        && !text.is_empty()
        && text.chars().count() <= limits::MAX_RECENT_PATH_CHARS
}

/// Cuts the list (newest first) to the cap by dropping the oldest entries that are not starred; only a list of stars alone
/// loses its oldest entry.
fn cut_to_cap(items: &mut Vec<Recent>) {
    while items.len() > limits::MAX_RECENTS {
        let victim = items
            .iter()
            .rposition(|item| !item.starred)
            .unwrap_or(items.len() - 1);
        items.remove(victim);
    }
}

/// The entries of a stored file, newest first, each valid and unique, at most `MAX_RECENTS`: path, time, star (absent or not a
/// boolean: no star). Anything else in it is ignored.
fn parse(bytes: &[u8]) -> Vec<(PathBuf, u64, bool)> {
    let Ok(Value::Object(map)) = serde_json::from_slice::<Value>(bytes) else {
        return Vec::new();
    };
    let Some(Value::Array(files)) = map.get("files") else {
        return Vec::new();
    };
    let mut found: Vec<(PathBuf, u64, bool)> = Vec::new();
    for file in files {
        let Some(path) = file.get("path").and_then(Value::as_str).map(PathBuf::from) else {
            continue;
        };
        if !storable(&path) || found.iter().any(|(known, _, _)| *known == path) {
            continue;
        }
        let opened = file.get("lastOpened").and_then(Value::as_u64).unwrap_or(0);
        let starred = file.get("starred").and_then(Value::as_bool) == Some(true);
        found.push((path, opened, starred));
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

    #[cfg(windows)]
    #[test]
    fn network_device_and_stream_paths_are_dropped_on_load_and_never_recorded() {
        let dir = TempDir::new();
        let bad = [
            r"\\host\share\x.pdf",
            r"\\?\UNC\host\share\x.pdf",
            "//host/share/x.pdf",
            r"\\.\NUL",
            r"C:\dir\a.pdf:stream",
        ];
        let mut files =
            vec![serde_json::json!({ "path": abs("ok.pdf").to_str().unwrap(), "lastOpened": 1 })];
        files.extend(
            bad.iter()
                .map(|p| serde_json::json!({ "path": p, "lastOpened": 2 })),
        );
        let text = serde_json::json!({ "version": 1, "files": files }).to_string();
        fs::write(dir.path().join(FILE_NAME), text).unwrap();
        let store = store(&dir);
        assert_eq!(names(&store), ["ok.pdf"]);
        for p in bad {
            store.record_at(Path::new(p), 3);
            assert!(!store.relocate(store.list()[0].id, Path::new(p)), "{p}");
        }
        assert_eq!(names(&store), ["ok.pdf"]);
    }

    #[test]
    fn only_the_newest_entries_are_looked_at() {
        let dir = TempDir::new();
        let store = store(&dir);
        for n in 0..=MAX_EXISTENCE_CHECKS {
            store.record_at(&abs(&format!("gone-{n}.pdf")), n as u64 + 1);
        }
        let list = store.list();
        assert!(list[..MAX_EXISTENCE_CHECKS].iter().all(|e| e.missing));
        assert!(!list[MAX_EXISTENCE_CHECKS].missing);
    }

    #[test]
    fn a_removed_entry_comes_back_in_its_place_once() {
        let dir = TempDir::new();
        let store = store(&dir);
        for (n, name) in ["a.pdf", "b.pdf", "c.pdf"].iter().enumerate() {
            store.record_at(&abs(name), n as u64 + 1);
        }
        let b = store.list()[1].id;
        assert!(store.remove(b));
        assert_eq!(names(&store), ["c.pdf", "a.pdf"]);
        assert!(store.restore(b));
        assert_eq!(names(&store), ["c.pdf", "b.pdf", "a.pdf"]);
        assert_eq!(store.path_of(b), Some(abs("b.pdf")));
        assert!(!store.restore(b), "not removed any more");
        assert!(!store.restore(9999));
        // It was recorded again meanwhile: nothing is doubled.
        assert!(store.remove(b));
        store.record_at(&abs("b.pdf"), 9);
        assert!(!store.restore(b));
        assert_eq!(names(&store), ["b.pdf", "c.pdf", "a.pdf"]);
    }

    #[test]
    fn a_located_file_replaces_the_path_of_its_entry_and_survives_a_restart() {
        let dir = TempDir::new();
        let store = store(&dir);
        store.record_at(&abs("a.pdf"), 1);
        store.record_at(&abs("b.pdf"), 2);
        let a = store.list()[1].id;
        assert!(store.relocate(a, &abs("moved/a2.pdf")));
        assert_eq!(names(&store), ["b.pdf", "a2.pdf"]);
        assert_eq!(store.list()[1].id, a);
        // Another entry for the same file goes; a path that cannot be kept and an unknown id change nothing.
        let b = store.list()[0].id;
        assert!(store.relocate(b, &abs("moved/a2.pdf")));
        assert_eq!(names(&store), ["a2.pdf"]);
        assert!(!store.relocate(9999, &abs("x.pdf")));
        assert!(!store.relocate(a, Path::new("relative.pdf")));
        assert_eq!(names(&store), ["a2.pdf"]);
        assert_eq!(
            RecentsStore::load(dir.path().join(FILE_NAME)).list().len(),
            1
        );
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
            r#"[{"id":0,"displayName":"report.pdf","folder":"sheer-recents-test","lastOpened":7,"missing":true,"starred":false}]"#
        );
        assert!(!json.contains(std::env::temp_dir().to_string_lossy().as_ref()));
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
    fn stars_survive_a_restart_and_a_file_without_them_loads_unstarred() {
        let dir = TempDir::new();
        let store = store(&dir);
        store.record_at(&abs("a.pdf"), 1);
        store.record_at(&abs("b.pdf"), 2);
        let a = store.list()[1].id;
        assert!(store.set_starred(a, true));
        assert!(store.set_starred(a, true), "already starred is fine");
        assert!(!store.set_starred(9999, true));
        assert!(store.list()[1].starred && !store.list()[0].starred);
        // Opening it again keeps the star.
        store.record_at(&abs("a.pdf"), 3);
        assert!(store.list()[0].starred);
        let again = RecentsStore::load(dir.path().join(FILE_NAME));
        let stars: Vec<bool> = again.list().iter().map(|e| e.starred).collect();
        assert_eq!(stars, [true, false]);
        assert!(again.set_starred(again.list()[0].id, false));
        assert!(!RecentsStore::load(dir.path().join(FILE_NAME)).list()[0].starred);
        // Old or tampered files: no star.
        let text = serde_json::json!({ "files": [
            { "path": abs("o.pdf").to_str().unwrap(), "lastOpened": 1 },
            { "path": abs("t.pdf").to_str().unwrap(), "starred": "yes" },
            { "path": abs("u.pdf").to_str().unwrap(), "starred": 1 },
        ]});
        fs::write(dir.path().join(FILE_NAME), text.to_string()).unwrap();
        let loaded = RecentsStore::load(dir.path().join(FILE_NAME)).list();
        assert_eq!(loaded.len(), 3);
        assert!(loaded.iter().all(|e| !e.starred));
    }

    #[test]
    fn starred_entries_are_not_pushed_off_by_the_cap_and_removing_unstars() {
        let dir = TempDir::new();
        let store = store(&dir);
        store.record_at(&abs("keep.pdf"), 1);
        let keep = store.list()[0].id;
        assert!(store.set_starred(keep, true));
        for i in 0..limits::MAX_RECENTS + 5 {
            store.record_at(&abs(&format!("{i}.pdf")), i as u64 + 2);
        }
        let list = store.list();
        assert_eq!(list.len(), limits::MAX_RECENTS);
        assert_eq!(list.last().unwrap().display_name, "keep.pdf");
        assert!(list.last().unwrap().starred);
        assert!(store.remove(keep));
        assert!(RecentsStore::load(dir.path().join(FILE_NAME))
            .list()
            .iter()
            .all(|e| e.display_name != "keep.pdf"));
    }

    #[test]
    fn at_most_one_less_than_the_cap_can_be_starred() {
        let dir = TempDir::new();
        let store = store(&dir);
        for i in 0..limits::MAX_RECENTS {
            store.record_at(&abs(&format!("{i}.pdf")), i as u64);
        }
        let ids: Vec<u32> = store.list().iter().map(|e| e.id).collect();
        for id in &ids[..limits::MAX_RECENTS - 1] {
            assert!(store.set_starred(*id, true));
        }
        assert!(!store.set_starred(ids[limits::MAX_RECENTS - 1], true));
        store.record_at(&abs("new.pdf"), 999);
        let list = store.list();
        assert_eq!(list.len(), limits::MAX_RECENTS);
        assert_eq!(
            list.iter().filter(|e| e.starred).count(),
            limits::MAX_RECENTS - 1
        );
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
