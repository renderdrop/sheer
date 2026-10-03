// owned by package C
//! The snapshot seam (ADR-049 §1): the current state of a document, as PDFium can render it, without writing to disk.
//!
//! A clean document is rendered as it is open (`EngineDocRef::Live`). A dirty one is written into memory by the save pipeline
//! (`pdfwrite::save::write_to_memory`) and opened by `Job::OpenSnapshot`; the job that asked closes it again (`Job::CloseSnapshot`).

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;

use crate::commands::AppState;
use crate::documents::DocumentId;
use crate::error::AppError;

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
/// (`limit_exceeded` `snapshot`). Until package C lands, a clean document answers `Live` and a document with unsaved changes is
/// `unsupported_feature` `notYet`.
pub fn current(app: &AppState, doc: DocumentId) -> Result<Snapshot, AppError> {
    if app.has_unsaved_changes(doc) {
        return Err(AppError::not_yet());
    }
    Ok(Snapshot {
        bytes: None,
        engine: EngineDocRef::Live(doc),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_ids_are_never_reused() {
        let (a, b) = (SnapshotId::fresh(), SnapshotId::fresh());
        assert_ne!(a, b);
    }
}
