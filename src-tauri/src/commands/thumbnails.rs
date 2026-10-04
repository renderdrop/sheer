//! The first-page previews of the recent files (DESIGN 3.48, ADR-054 (3)). Made when a document is closed and after it is saved, kept in
//! the app cache directory (`storage::thumbs`), and fetched by the recents `id`; no path comes from or goes to the webview.
//!
//! | Command | Arguments | Returns |
//! |---|---|---|
//! | `get_recent_thumbnail` | `recentId: number` | an `SHR1` frame (PNG, at most 64 x 80 px); `not_found` for an id that is not listed or has no preview |
//!
//! A document with a password gets none (a decrypted page must not land on disk) and loses an older one; neither does the welcome
//! document, a recovered snapshot, or a document with unsaved changes. Every failure is logged and otherwise ignored: a preview is a
//! convenience, never a reason to fail a close or a save.

use tauri::ipc::Response;
use tauri::State;

use super::{blocking, AppState};
use crate::documents::{DocKind, DocumentId};
use crate::engine::{Priority, RenderKey, RenderSpec};
use crate::error::{AppError, UiError};
use crate::storage::thumbs::{make_frame, RENDER_BUCKET};

impl AppState {
    /// Makes the preview of the first page of document `id` and stores it for its file, if the document is one that gets one (see the
    /// module documentation). Best effort. Call it from the blocking pool: it waits for the engine.
    pub fn cache_thumbnail(&self, id: DocumentId) {
        let Some(thumbs) = &self.thumbs else { return };
        let Some(recents) = &self.recents else { return };
        let Some(path) = self.registry.path(id) else {
            return;
        };
        if self.registry.kind(id) != Some(DocKind::User) || !recents.contains(&path) {
            return;
        }
        // Not knowing whether the file is encrypted counts as encrypted.
        let Some(info) = self.info(id) else {
            thumbs.evict(&path);
            return;
        };
        if info.flags.encrypted || info.page_count == 0 {
            thumbs.evict(&path);
            return;
        }
        let rendered = self
            .engine
            .render(RenderSpec {
                key: RenderKey {
                    id,
                    page_index: 0,
                    bucket: RENDER_BUCKET,
                    tile: None,
                },
                priority: Priority::Thumbnail,
                generation: 0,
            })
            .and_then(|frame| make_frame(&frame));
        match rendered {
            Ok(frame) => {
                if let Err(error) = thumbs.store(&path, &frame) {
                    AppError::from(error).log();
                }
            }
            Err(error) => error.log(),
        }
    }

    /// Removes the previews of every file that is not listed as a recent one any more.
    pub fn sweep_thumbnails(&self) {
        if let (Some(thumbs), Some(recents)) = (&self.thumbs, &self.recents) {
            thumbs.retain(&recents.paths());
        }
    }

    /// The preview frame of recent file `id`; `not_found` when the id is not listed or there is no (valid) preview.
    pub fn recent_thumbnail(&self, id: u32) -> Result<Vec<u8>, AppError> {
        let path = self
            .recents
            .as_ref()
            .and_then(|recents| recents.path_of(id))
            .ok_or(AppError::not_found("recent"))?;
        self.thumbs
            .as_ref()
            .and_then(|thumbs| thumbs.load(&path))
            .ok_or(AppError::not_found("thumbnail"))
    }
}

/// The preview of a recent file as an `SHR1` frame. `not_found` is the normal answer for a file that was never closed or saved by this
/// app, that has a password, or whose preview was removed: the UI shows its placeholder.
#[tauri::command]
pub async fn get_recent_thumbnail(
    state: State<'_, AppState>,
    recent_id: u32,
) -> Result<Response, UiError> {
    let state = state.inner().clone();
    blocking(move || state.recent_thumbnail(recent_id))
        .await
        .map(Response::new)
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::Arc;

    use super::*;
    use crate::documents::DocFlags;
    use crate::engine::encode::{encode_frame, split_frame};
    use crate::engine::{Engine, Job};
    use crate::error::ErrorCode;
    use crate::storage::atomic::testutil::TempDir;
    use crate::storage::recents::RecentsStore;
    use crate::storage::thumbs::ThumbCache;

    struct Fixture {
        dir: TempDir,
        state: AppState,
        thumbs: Arc<ThumbCache>,
        recents: Arc<RecentsStore>,
    }

    fn fixture() -> Fixture {
        let dir = TempDir::new();
        let engine = Engine::with_handler(|job| match job {
            Job::Render { reply, .. } => {
                let data = vec![255u8; 300 * 400 * 3];
                let _ = reply.send(Ok(Arc::new(encode_frame(300, 400, 900, &data).unwrap())));
            }
            Job::Close { reply, .. } => {
                let _ = reply.send(Ok(()));
            }
            _ => {}
        });
        let recents = Arc::new(RecentsStore::load(dir.path().join("recents.json")));
        let thumbs = Arc::new(ThumbCache::new(dir.path().join("cache")));
        let state = AppState::new(engine)
            .with_recents(Arc::clone(&recents))
            .with_thumbnails(Arc::clone(&thumbs));
        Fixture {
            dir,
            state,
            thumbs,
            recents,
        }
    }

    /// A listed file that is open as document `id` with one page.
    fn open(fixture: &Fixture, name: &str) -> (DocumentId, PathBuf, u32) {
        let path = fixture.dir.path().join(name);
        fixture.recents.record(&path);
        let id = fixture.state.registry.register(path.clone()).unwrap();
        fixture.state.registry.set_page_count(id, 1).unwrap();
        let recent = fixture
            .state
            .list_recents()
            .into_iter()
            .find(|entry| entry.display_name == name)
            .unwrap()
            .id;
        (id, path, recent)
    }

    #[test]
    fn closing_a_document_writes_its_preview_and_the_command_returns_the_frame() {
        let fixture = fixture();
        let (id, path, recent) = open(&fixture, "a.pdf");
        assert_eq!(
            fixture.state.recent_thumbnail(recent).unwrap_err().code(),
            ErrorCode::NotFound
        );
        fixture.state.close_document(id).unwrap();
        assert!(fixture.thumbs.has(&path));
        let frame = fixture.state.recent_thumbnail(recent).unwrap();
        let (width, height, _) = split_frame(&frame);
        assert_eq!((width, height), (60, 80));
    }

    #[test]
    fn a_document_with_a_password_gets_no_preview_and_loses_an_older_one() {
        let fixture = fixture();
        let (id, path, _) = open(&fixture, "secret.pdf");
        fixture.state.cache_thumbnail(id);
        assert!(fixture.thumbs.has(&path));
        fixture
            .state
            .registry
            .set_flags(
                id,
                DocFlags {
                    encrypted: true,
                    ..DocFlags::default()
                },
            )
            .unwrap();
        fixture.state.close_document(id).unwrap();
        assert!(!fixture.thumbs.has(&path));
    }

    #[test]
    fn only_listed_documents_get_one() {
        let fixture = fixture();
        // Not a recent file: anything unlisted.
        let other = fixture.dir.path().join("b.pdf");
        let id = fixture.state.registry.register(other.clone()).unwrap();
        fixture.state.registry.set_page_count(id, 1).unwrap();
        fixture.state.close_document(id).unwrap();
        assert!(!fixture.thumbs.has(&other));
    }

    #[test]
    fn removing_an_entry_deletes_its_preview_and_clearing_deletes_all() {
        let fixture = fixture();
        let mut made = Vec::new();
        for name in ["a.pdf", "b.pdf", "c.pdf"] {
            let (id, path, recent) = open(&fixture, name);
            fixture.state.cache_thumbnail(id);
            assert!(fixture.thumbs.has(&path));
            made.push((path, recent));
        }
        fixture.state.remove_recent(made[0].1);
        assert!(!fixture.thumbs.has(&made[0].0));
        assert!(fixture.thumbs.has(&made[1].0));
        // "Clear" removes every entry, one after the other.
        for (_, recent) in &made {
            fixture.state.remove_recent(*recent);
        }
        assert!(made.iter().all(|(path, _)| !fixture.thumbs.has(path)));
        assert_eq!(
            fixture
                .state
                .recent_thumbnail(made[1].1)
                .unwrap_err()
                .code(),
            ErrorCode::NotFound
        );
    }

    #[test]
    fn a_preview_without_an_entry_is_swept_and_unknown_ids_are_not_found() {
        let fixture = fixture();
        let (id, path, _) = open(&fixture, "a.pdf");
        fixture.state.cache_thumbnail(id);
        let stray = fixture.dir.path().join("stray.pdf");
        let frame = fixture.thumbs.load(&path).unwrap();
        fixture.thumbs.store(&stray, &frame).unwrap();
        fixture.state.sweep_thumbnails();
        assert!(fixture.thumbs.has(&path) && !fixture.thumbs.has(&stray));
        for bad in [9999, u32::MAX] {
            assert_eq!(
                fixture.state.recent_thumbnail(bad).unwrap_err().code(),
                ErrorCode::NotFound
            );
        }
    }

    #[test]
    fn without_a_cache_there_is_nothing_to_make_or_read() {
        let (state, id) = crate::commands::testutil::state_with_pages(1, |_| {});
        state.cache_thumbnail(id);
        assert_eq!(
            state.recent_thumbnail(0).unwrap_err().code(),
            ErrorCode::NotFound
        );
    }
}
