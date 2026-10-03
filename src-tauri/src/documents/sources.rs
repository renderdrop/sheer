//! Import sources (ADR-036 §4): PDFs the user chose to take pages from, held in memory.
//!
//! A source is read once, through `intake::admit` on the handle the Rust file dialog's path gave, into a byte buffer that the engine and the
//! save then read pages from; the webview only ever sees its id, name and page count. The registry belongs to the app. A document that
//! inserted pages from a source pins the bytes ([`SourceRegistry::pin`]) until it is closed or saved, so releasing the source (the UI is done
//! with it) does not pull the bytes away from a document that still has to write them.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use super::DocumentId;
use crate::error::AppError;
use crate::limits;
use crate::model::page::SourceId;

/// A source PDF: its bytes and what was learnt when it was read.
#[derive(Debug)]
pub struct SourceBytes {
    pub bytes: Vec<u8>,
    pub page_count: u32,
    /// The file's name for the UI (never a directory).
    pub display_name: String,
}

#[derive(Debug, Default)]
struct Inner {
    next_id: u32,
    sources: BTreeMap<SourceId, Arc<SourceBytes>>,
    /// Bytes of the sources in `sources` (not the ones only a document holds).
    held: u64,
    pins: HashMap<DocumentId, BTreeMap<SourceId, Arc<SourceBytes>>>,
}

/// The sources of the app.
#[derive(Debug, Default)]
pub struct SourceRegistry {
    inner: Mutex<Inner>,
}

impl SourceRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Whether a source of `len` bytes may be added now: at most `MAX_SOURCE_BYTES` for one, `MAX_SOURCES_BYTES` and `MAX_SOURCES` in all.
    pub fn check_room(&self, len: u64) -> Result<(), AppError> {
        let inner = self.lock();
        if len > limits::MAX_SOURCE_BYTES {
            return Err(AppError::limit("sourceBytes", limits::MAX_SOURCE_BYTES));
        }
        if inner.sources.len() >= limits::MAX_SOURCES {
            return Err(AppError::limit("sources", limits::MAX_SOURCES as u64));
        }
        if inner.held.saturating_add(len) > limits::MAX_SOURCES_BYTES {
            return Err(AppError::limit("sourcesBytes", limits::MAX_SOURCES_BYTES));
        }
        Ok(())
    }

    /// Adds a source, within the limits. The id is never reused.
    pub fn add(&self, source: SourceBytes) -> Result<(SourceId, Arc<SourceBytes>), AppError> {
        let len = source.bytes.len() as u64;
        let mut inner = self.lock();
        if len > limits::MAX_SOURCE_BYTES {
            return Err(AppError::limit("sourceBytes", limits::MAX_SOURCE_BYTES));
        }
        if inner.sources.len() >= limits::MAX_SOURCES {
            return Err(AppError::limit("sources", limits::MAX_SOURCES as u64));
        }
        if inner.held.saturating_add(len) > limits::MAX_SOURCES_BYTES {
            return Err(AppError::limit("sourcesBytes", limits::MAX_SOURCES_BYTES));
        }
        let id = SourceId::new(inner.next_id);
        inner.next_id = inner
            .next_id
            .checked_add(1)
            .ok_or(AppError::limit("sources", u64::from(u32::MAX)))?;
        let source = Arc::new(source);
        inner.held += len;
        inner.sources.insert(id, Arc::clone(&source));
        Ok((id, source))
    }

    /// The source `id`, if it is held (by the registry or, for a document that pinned it, by that document).
    pub fn get(&self, id: SourceId) -> Option<Arc<SourceBytes>> {
        self.lock().sources.get(&id).cloned()
    }

    /// Lets go of a source. An id that is not held is nothing; documents that pinned the bytes keep them.
    pub fn release(&self, id: SourceId) {
        let mut inner = self.lock();
        if let Some(source) = inner.sources.remove(&id) {
            inner.held = inner.held.saturating_sub(source.bytes.len() as u64);
        }
    }

    /// Makes document `doc` hold source `id` until [`SourceRegistry::unpin_all`]. `None` if the source is neither held by the registry nor
    /// already pinned by the document.
    pub fn pin(&self, doc: DocumentId, id: SourceId) -> Option<Arc<SourceBytes>> {
        let mut inner = self.lock();
        let found = inner.sources.get(&id).cloned().or_else(|| {
            inner
                .pins
                .get(&doc)
                .and_then(|pinned| pinned.get(&id))
                .cloned()
        })?;
        inner
            .pins
            .entry(doc)
            .or_default()
            .insert(id, Arc::clone(&found));
        Some(found)
    }

    /// The source `id` as document `doc` pinned it.
    pub fn pinned(&self, doc: DocumentId, id: SourceId) -> Option<Arc<SourceBytes>> {
        self.lock().pins.get(&doc)?.get(&id).cloned()
    }

    /// Drops what document `doc` pinned (it was closed, or saved: its pages are in the file now).
    pub fn unpin_all(&self, doc: DocumentId) {
        self.lock().pins.remove(&doc);
    }

    /// How many sources the registry holds.
    pub fn len(&self) -> usize {
        self.lock().sources.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorCode;

    fn source(len: usize) -> SourceBytes {
        SourceBytes {
            bytes: vec![0; len],
            page_count: 1,
            display_name: "a.pdf".to_owned(),
        }
    }

    fn doc(n: u32) -> DocumentId {
        serde_json::from_str(&n.to_string()).unwrap()
    }

    #[test]
    fn ids_are_not_reused_and_release_of_an_unknown_id_is_nothing() {
        let sources = SourceRegistry::new();
        let (a, _) = sources.add(source(4)).unwrap();
        sources.release(a);
        sources.release(a);
        let (b, _) = sources.add(source(4)).unwrap();
        assert_ne!(a, b);
        assert!(sources.get(a).is_none());
        assert!(sources.get(b).is_some());
    }

    #[test]
    fn at_most_thirty_two_sources_are_held() {
        let sources = SourceRegistry::new();
        for _ in 0..limits::MAX_SOURCES {
            sources.add(source(1)).unwrap();
        }
        assert_eq!(
            sources.add(source(1)).unwrap_err().code(),
            ErrorCode::LimitExceeded
        );
        assert_eq!(
            sources.check_room(1).unwrap_err().code(),
            ErrorCode::LimitExceeded
        );
    }

    #[test]
    fn a_pin_outlives_the_release_and_goes_with_the_document() {
        let sources = SourceRegistry::new();
        let (id, _) = sources.add(source(8)).unwrap();
        let held = sources.pin(doc(1), id).unwrap();
        sources.release(id);
        assert!(sources.get(id).is_none());
        assert!(Arc::ptr_eq(&held, &sources.pinned(doc(1), id).unwrap()));
        assert!(sources.pin(doc(2), id).is_none(), "released: no new pins");
        sources.unpin_all(doc(1));
        assert!(sources.pinned(doc(1), id).is_none());
    }
}
