//! What can be done with a recent file besides opening it: take the removal back (`restore_recent`), star it (`set_recent_starred`), show it in the file manager (`reveal_recent`) and find a file that moved
//! (`locate_recent`). Both name the entry by its `recentId`; no path comes from or goes to the webview (ARCHITECTURE section 5).
//!
//! | Command | Arguments | Returns |
//! |---|---|---|
//! | `restore_recent` | `recentId: number` | `boolean`: the entry was put back where it was (false: not removed in this run, or listed again) |
//! | `set_recent_starred` | `recentId: number`, `starred: boolean` | nothing; unknown id: `not_found`; star refused (49 cap): `limit_exceeded` |
//! | `reveal_recent` | `recentId: number` | nothing; unknown id or file gone: `not_found` |
//! | `locate_recent` | `recentId: number` | `boolean`: the user chose a file and the entry points to it now (false: cancelled, or unknown id) |

use tauri::{State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

use super::{blocking, AppState};
use crate::error::{AppError, ErrorCode, UiError};

impl AppState {
    /// Puts a removed recent file back in its place.
    pub fn restore_recent(&self, id: u32) -> bool {
        self.recents
            .as_ref()
            .is_some_and(|recents| recents.restore(id))
    }

    /// Stars or unstars recent file `id`; `not_found` for an id that is not listed ; a refused star (stars full, see `RecentsStore::set_starred`) is `limit_exceeded`.
    pub fn set_recent_starred(&self, id: u32, starred: bool) -> Result<(), AppError> {
        let Some(recents) = &self.recents else {
            return Err(AppError::not_found("recent"));
        };
        if recents.set_starred(id, starred) {
            return Ok(());
        }
        // A listed entry whose star was refused: the stars are full (`limit_exceeded`); otherwise the id is unknown.
        if recents.path_of(id).is_some() {
            Err(AppError::limit(
                "recentStars",
                (crate::limits::MAX_RECENTS - 1) as u64,
            ))
        } else {
            Err(AppError::not_found("recent"))
        }
    }

    /// Shows recent file `id` in the OS file manager through `reveal`. The path comes from the store only; an unlisted id, a path
    /// that may not be kept (network, device) or a file that is gone is `not_found`, and `reveal` is not called then.
    pub fn reveal_recent_with(
        &self,
        id: u32,
        reveal: impl FnOnce(&std::path::Path) -> Result<(), String>,
    ) -> Result<(), AppError> {
        let path = self
            .recents
            .as_ref()
            .and_then(|recents| recents.path_of(id))
            .ok_or(AppError::not_found("recent"))?;
        // A regular file only (not a directory or device); `metadata` follows links like opening does.
        let is_file = std::fs::metadata(&path).is_ok_and(|meta| meta.is_file());
        if !crate::storage::recents::storable(&path) || !is_file {
            return Err(AppError::not_found("recent"));
        }
        reveal(&path).map_err(|error| AppError::logged(ErrorCode::Internal, error))
    }

    /// Points recent file `id` at `path`, the file the user chose. `not_found` for an id that is not listed.
    pub fn relocate_recent(&self, id: u32, path: &std::path::Path) -> Result<bool, AppError> {
        let recents = self.recents.as_ref().ok_or(AppError::not_found("recent"))?;
        if recents.path_of(id).is_none() {
            return Err(AppError::not_found("recent"));
        }
        // The chosen file is judged like any file that is opened (spelling, regular file, PDF signature); its canonical path is kept.
        let admitted = crate::documents::intake::admit(path)?;
        let moved = recents.relocate(id, &admitted.path);
        // The preview of the old path has no entry any more.
        self.sweep_thumbnails();
        Ok(moved)
    }
}

/// Takes the last removal of a recent file back.
#[tauri::command]
pub async fn restore_recent(state: State<'_, AppState>, recent_id: u32) -> Result<bool, UiError> {
    let state = state.inner().clone();
    blocking(move || Ok(state.restore_recent(recent_id))).await
}

/// Marks a recent file as a favourite ("Markiert") or takes the mark off. Unknown id → `not_found`.
#[tauri::command]
pub async fn set_recent_starred(
    state: State<'_, AppState>,
    recent_id: u32,
    starred: bool,
) -> Result<(), UiError> {
    let state = state.inner().clone();
    blocking(move || state.set_recent_starred(recent_id, starred)).await
}

/// Shows a recent file in the OS file manager (Explorer / Finder) with the file selected. The path stays in Rust; a file that is gone
/// or an id that is not listed is `not_found`.
#[tauri::command]
pub async fn reveal_recent(state: State<'_, AppState>, recent_id: u32) -> Result<(), UiError> {
    let state = state.inner().clone();
    blocking(move || {
        state.reveal_recent_with(recent_id, |path| {
            tauri_plugin_opener::reveal_item_in_dir(path).map_err(|error| error.to_string())
        })
    })
    .await
}

/// Shows the native "open" dialog for a recent file that is gone and, if the user chooses one, makes the entry point to it. The path
/// stays in Rust. Does not open the file; the UI lists again and the user opens it as any other.
#[tauri::command]
pub async fn locate_recent(
    window: WebviewWindow,
    state: State<'_, AppState>,
    recent_id: u32,
) -> Result<bool, UiError> {
    let state = state.inner().clone();
    blocking(move || {
        // Refused before the dialog if there is nothing to point.
        if state
            .recents
            .as_ref()
            .and_then(|recents| recents.path_of(recent_id))
            .is_none()
        {
            return Err(AppError::not_found("recent"));
        }
        let picked = window
            .dialog()
            .file()
            .set_parent(&window)
            .add_filter("PDF", &["pdf"])
            .blocking_pick_file();
        let Some(picked) = picked else {
            return Ok(false);
        };
        match picked.into_path() {
            Ok(path) => state.relocate_recent(recent_id, &path),
            Err(error) => Err(AppError::logged(ErrorCode::Internal, error)),
        }
    })
    .await
}

#[cfg(test)]
mod tests {
    use std::path::Path;
    use std::sync::Arc;

    use super::*;
    use crate::commands::testutil::state_with_pages;
    use crate::storage::recents::RecentsStore;

    fn abs(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join("sheer-recent-actions").join(name)
    }

    fn state_with_store() -> (AppState, Arc<RecentsStore>, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("sheer-recent-actions-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let store = Arc::new(RecentsStore::load(dir.join("recents.json")));
        let (state, _) = state_with_pages(1, |_| {});
        (state.with_recents(Arc::clone(&store)), store, dir)
    }

    #[test]
    fn removed_recents_are_restored_and_located_ones_repointed() {
        let (state, store, dir) = state_with_store();
        store.record(&abs("a.pdf"));
        let id = state.list_recents()[0].id;
        state.remove_recent(id);
        assert!(state.list_recents().is_empty());
        assert!(state.restore_recent(id));
        assert!(!state.restore_recent(id));

        let b = dir.join("b.pdf");
        std::fs::write(&b, b"%PDF-1.4\n%%EOF\n").unwrap();
        // Not a PDF, a directory, not there, a network spelling: refused, and the entry is as it was.
        let text = dir.join("t.pdf");
        std::fs::write(&text, b"hello").unwrap();
        for bad in [text, dir.clone(), dir.join("none.pdf")] {
            assert!(state.relocate_recent(id, &bad).is_err(), "{bad:?}");
        }
        if cfg!(windows) {
            assert!(state
                .relocate_recent(id, Path::new(r"\\host\share\x.pdf"))
                .is_err());
        }
        assert_eq!(state.list_recents()[0].display_name, "a.pdf");
        assert!(state.relocate_recent(id, &b).unwrap());
        assert_eq!(state.list_recents()[0].display_name, "b.pdf");
        assert_eq!(
            state.relocate_recent(77, &abs("c.pdf")).unwrap_err().code(),
            ErrorCode::NotFound
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn starring_by_id_and_revealing_only_what_exists() {
        let (state, store, _shared) = state_with_store();
        let dir = std::env::temp_dir().join(format!("sheer-recent-reveal-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let there = dir.join("there.pdf");
        std::fs::write(&there, b"%PDF-1.4\n").unwrap();
        store.record(&there);
        store.record(&abs("gone.pdf"));
        // A directory behind a listed path and a network spelling are refused as well.
        let folder = dir.join("folder.pdf");
        std::fs::create_dir_all(&folder).unwrap();
        store.record(&folder);
        let folder_id = state.list_recents()[0].id;
        assert_eq!(
            state
                .reveal_recent_with(folder_id, |_| Ok(()))
                .unwrap_err()
                .code(),
            ErrorCode::NotFound
        );
        store.record(Path::new(r"\\host\share\x.pdf"));
        for entry in state.list_recents() {
            if entry.display_name == "x.pdf" {
                assert!(state.reveal_recent_with(entry.id, |_| Ok(())).is_err());
            }
        }
        let list = state.list_recents();
        let find = |name: &str| list.iter().find(|e| e.display_name == name).unwrap().id;
        let (gone, here) = (find("gone.pdf"), find("there.pdf"));

        assert!(state.set_recent_starred(here, true).is_ok());
        assert!(state
            .list_recents()
            .iter()
            .any(|e| e.id == here && e.starred));
        assert_eq!(
            state.set_recent_starred(777, true).unwrap_err().code(),
            ErrorCode::NotFound
        );

        let mut spawned = 0;
        let missing = state.reveal_recent_with(gone, |_| {
            spawned += 1;
            Ok(())
        });
        assert_eq!(missing.unwrap_err().code(), ErrorCode::NotFound);
        let unknown = state.reveal_recent_with(777, |_| {
            spawned += 1;
            Ok(())
        });
        assert_eq!(unknown.unwrap_err().code(), ErrorCode::NotFound);
        assert_eq!(
            spawned, 0,
            "nothing is spawned for a missing file or unknown id"
        );

        let mut shown = None;
        state
            .reveal_recent_with(here, |path| {
                shown = Some(path.to_path_buf());
                Ok(())
            })
            .unwrap();
        assert_eq!(shown.as_deref(), Some(there.as_path()));
        let failed = state.reveal_recent_with(here, |_| Err("no file manager".into()));
        assert_eq!(failed.unwrap_err().code(), ErrorCode::Internal);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn without_a_store_there_is_nothing_to_restore_or_locate() {
        let (state, _) = state_with_pages(1, |_| {});
        assert!(!state.restore_recent(0));
        assert_eq!(
            state.relocate_recent(0, &abs("a.pdf")).unwrap_err().code(),
            ErrorCode::NotFound
        );
    }
}
