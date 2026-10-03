//! What can be done with a recent file besides opening it: take the removal back (`restore_recent`) and find a file that moved
//! (`locate_recent`). Both name the entry by its `recentId`; no path comes from or goes to the webview (ARCHITECTURE section 5).
//!
//! | Command | Arguments | Returns |
//! |---|---|---|
//! | `restore_recent` | `recentId: number` | `boolean`: the entry was put back where it was (false: not removed in this run, or listed again) |
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

    /// Points recent file `id` at `path`, the file the user chose. `not_found` for an id that is not listed.
    pub fn relocate_recent(&self, id: u32, path: &std::path::Path) -> Result<bool, AppError> {
        let recents = self.recents.as_ref().ok_or(AppError::not_found("recent"))?;
        if recents.path_of(id).is_none() {
            return Err(AppError::not_found("recent"));
        }
        // The chosen file is judged like any file that is opened (spelling, regular file, PDF signature); its canonical path is kept.
        let admitted = crate::documents::intake::admit(path)?;
        Ok(recents.relocate(id, &admitted.path))
    }
}

/// Takes the last removal of a recent file back.
#[tauri::command]
pub async fn restore_recent(state: State<'_, AppState>, recent_id: u32) -> Result<bool, UiError> {
    let state = state.inner().clone();
    blocking(move || Ok(state.restore_recent(recent_id))).await
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
    fn without_a_store_there_is_nothing_to_restore_or_locate() {
        let (state, _) = state_with_pages(1, |_| {});
        assert!(!state.restore_recent(0));
        assert_eq!(
            state.relocate_recent(0, &abs("a.pdf")).unwrap_err().code(),
            ErrorCode::NotFound
        );
    }
}
