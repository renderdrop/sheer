//! The snapshot seam (ADR-049 §1): the current state of a document, as PDFium can render it, without writing to disk.
//!
//! A clean document is rendered as it is open (`EngineDocRef::Live`). A dirty one is written into memory by the save pipeline
//! (`pdfwrite::save::write_to_memory`) and opened by `Job::OpenSnapshot`; the job that asked closes it again (`Job::CloseSnapshot`).

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;

use crate::commands::AppState;
use crate::documents::DocumentId;
use crate::error::AppError;
use crate::limits;

/// A document the engine holds for one output job only: not in the registry, no page sizes pushed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct SnapshotId(u32);

impl SnapshotId {
    /// A number nobody else has (the worker that opens the snapshot calls this).
    pub fn fresh() -> Self {
        static NEXT: AtomicU32 = AtomicU32::new(1);
        Self(NEXT.fetch_add(1, Ordering::Relaxed))
    }

    pub const fn get(self) -> u32 {
        self.0
    }
}

/// The engine document an export renders from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EngineDocRef {
    /// The open document itself (nothing unsaved).
    Live(DocumentId),
    /// The in-memory copy of the unsaved state.
    Snapshot(SnapshotId),
}

/// What [`current`] answers. `bytes` is `None` for a clean document (the live engine document is used, no copy).
#[derive(Debug, Clone)]
pub struct Snapshot {
    pub bytes: Option<Arc<[u8]>>,
    pub engine: EngineDocRef,
}

/// The current state of `doc` for an output job; runs on the blocking pool; at most `limits::MAX_SNAPSHOT_BYTES`
/// (`limit_exceeded` `snapshot`). A clean document answers `Live` (nothing is copied). One with unsaved changes is written into
/// memory by the save pipeline and opened by the engine; whoever called owns the snapshot then and must close it (a
/// [`SnapshotGuard`] does, also on an error or a cancel).
pub fn current(app: &AppState, doc: DocumentId) -> Result<Snapshot, AppError> {
    let Some(bytes) = current_bytes(app, doc)? else {
        return Ok(Snapshot {
            bytes: None,
            engine: EngineDocRef::Live(doc),
        });
    };
    let id = app.engine().open_snapshot(Arc::clone(&bytes))?;
    Ok(Snapshot {
        bytes: Some(bytes),
        engine: EngineDocRef::Snapshot(id),
    })
}

/// The bytes of the snapshot of `doc`, without opening them in the engine (an export of a copy reads them itself): `None` for a clean
/// document. At most `limits::MAX_SNAPSHOT_BYTES`.
pub fn current_bytes(app: &AppState, doc: DocumentId) -> Result<Option<Arc<[u8]>>, AppError> {
    if !app.has_unsaved_changes(doc) {
        return Ok(None);
    }
    let bytes = app.snapshot_bytes(doc)?;
    if u64::try_from(bytes.len()).map_or(true, |len| len > limits::MAX_SNAPSHOT_BYTES) {
        return Err(AppError::limit("snapshot", limits::MAX_SNAPSHOT_BYTES));
    }
    Ok(Some(Arc::from(bytes)))
}

/// A [`Snapshot`] that closes its engine document when dropped: the job that ends, fails or is cancelled leaves nothing behind.
pub struct SnapshotGuard {
    app: AppState,
    snapshot: Snapshot,
}

impl SnapshotGuard {
    /// [`current`], held.
    pub fn current(app: &AppState, doc: DocumentId) -> Result<Self, AppError> {
        Ok(Self::hold(app, current(app, doc)?))
    }

    /// Takes over the closing of `snapshot`.
    pub fn hold(app: &AppState, snapshot: Snapshot) -> Self {
        Self {
            app: app.clone(),
            snapshot,
        }
    }

    pub fn snapshot(&self) -> &Snapshot {
        &self.snapshot
    }

    pub fn engine(&self) -> EngineDocRef {
        self.snapshot.engine
    }
}

impl Drop for SnapshotGuard {
    fn drop(&mut self) {
        if let EngineDocRef::Snapshot(id) = self.snapshot.engine {
            if let Err(error) = self.app.engine().close_snapshot(id) {
                error.log();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;
    use crate::commands::testutil::state_with_pages;
    use crate::engine::Job;

    #[test]
    fn snapshot_ids_are_never_reused() {
        let (a, b) = (SnapshotId::fresh(), SnapshotId::fresh());
        assert_ne!(a, b);
    }

    /// The engine double records which snapshots were closed.
    fn recording_state() -> (AppState, DocumentId, Arc<Mutex<Vec<SnapshotId>>>) {
        let closed = Arc::new(Mutex::new(Vec::new()));
        let seen = Arc::clone(&closed);
        let (state, id) = state_with_pages(1, move |job| {
            if let Job::CloseSnapshot { id, reply } = job {
                if let Ok(mut list) = seen.lock() {
                    list.push(id);
                }
                let _ = reply.send(Ok(()));
            }
        });
        (state, id, closed)
    }

    #[test]
    fn a_guard_closes_its_snapshot_when_the_job_fails() {
        let (state, doc, closed) = recording_state();
        let id = SnapshotId::fresh();
        let job = |state: &AppState| -> Result<(), AppError> {
            let _guard = SnapshotGuard::hold(
                state,
                Snapshot {
                    bytes: None,
                    engine: EngineDocRef::Snapshot(id),
                },
            );
            Err(AppError::new(crate::error::ErrorCode::Cancelled))
        };
        assert!(job(&state).is_err());
        assert_eq!(
            closed.lock().map(|l| l.clone()).unwrap_or_default(),
            vec![id]
        );
        // A live document has nothing to close.
        drop(SnapshotGuard::hold(
            &state,
            Snapshot {
                bytes: None,
                engine: EngineDocRef::Live(doc),
            },
        ));
        assert_eq!(closed.lock().map(|l| l.len()).unwrap_or(0), 1);
    }

    #[test]
    fn a_clean_document_is_its_own_snapshot() {
        let (state, doc, closed) = recording_state();
        let snapshot = current(&state, doc).unwrap();
        assert!(snapshot.bytes.is_none());
        assert_eq!(snapshot.engine, EngineDocRef::Live(doc));
        assert!(closed.lock().map(|l| l.is_empty()).unwrap_or(false));
    }
}
