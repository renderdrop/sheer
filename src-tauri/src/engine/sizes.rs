//! What is read once about each loaded document: the size of every page, and its flags.
//!
//! The worker reads them when it loads a document (`worker::open`, before it asks whether anybody still wants the document)
//! and keeps them here until the document is released. `get_page_sizes` and the flags of `DocumentInfo` are answered from this
//! table by any thread, without a place in the job queue and without waking the worker: however often the UI asks, and however
//! many ask at once, PDFium is asked once per document. There is nothing to compute on a call, so there is nothing to
//! deduplicate either.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use crate::documents::{DocFlags, DocumentId};

/// The size in points of every page of a document, in page order, shared by everyone who asks.
pub type PageSizes = Arc<[[f32; 2]]>;

/// What is known about a loaded document.
#[derive(Debug, Clone)]
struct Loaded {
    sizes: PageSizes,
    /// The `/Rotate` of each page when the document was loaded; empty where it was not read (a test double).
    rotations: Arc<[u16]>,
    flags: DocFlags,
}

/// The sizes and flags of the loaded documents. Written by the worker, read by every `Engine` handle.
#[derive(Debug, Default)]
pub(super) struct SizeCache {
    by_document: Mutex<HashMap<DocumentId, Loaded>>,
}

impl SizeCache {
    fn lock(&self) -> MutexGuard<'_, HashMap<DocumentId, Loaded>> {
        // A poisoned lock only means a holder panicked; the map stays consistent.
        self.by_document
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    /// The sizes of a loaded document; `None` for one the engine does not hold (unknown, released, or still loading).
    pub(super) fn get(&self, id: DocumentId) -> Option<PageSizes> {
        self.lock().get(&id).map(|loaded| Arc::clone(&loaded.sizes))
    }

    /// The flags of a loaded document; `None` for one the engine does not hold.
    pub(super) fn flags(&self, id: DocumentId) -> Option<DocFlags> {
        self.lock().get(&id).map(|loaded| loaded.flags)
    }

    /// Records the sizes and flags of a document that was just loaded and is wanted.
    pub(super) fn insert(&self, id: DocumentId, sizes: PageSizes, flags: DocFlags) {
        self.lock().insert(
            id,
            Loaded {
                sizes,
                rotations: Arc::from(Vec::new()),
                flags,
            },
        );
    }

    /// Records the rotations of a document that has sizes here.
    pub(super) fn set_rotations(&self, id: DocumentId, rotations: Arc<[u16]>) {
        if let Some(loaded) = self.lock().get_mut(&id) {
            loaded.rotations = rotations;
        }
    }

    /// The rotations of a loaded document; `None` for one the engine does not hold. Empty where none were read.
    pub(super) fn rotations(&self, id: DocumentId) -> Option<Arc<[u16]>> {
        self.lock()
            .get(&id)
            .map(|loaded| Arc::clone(&loaded.rotations))
    }

    /// Forgets a document that was released.
    pub(super) fn remove(&self, id: DocumentId) {
        self.lock().remove(&id);
    }

    /// The documents that are loaded (the ones a respawned worker no longer holds, `Engine::recover`).
    pub(super) fn ids(&self) -> Vec<DocumentId> {
        self.lock().keys().copied().collect()
    }

    /// How many documents have sizes here.
    #[cfg(test)]
    pub(super) fn len(&self) -> usize {
        self.lock().len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::documents::Registry;

    fn ids(count: usize) -> Vec<DocumentId> {
        let registry = Registry::new();
        (0..count)
            .map(|i| {
                registry
                    .register(std::path::PathBuf::from(format!("doc-{i}.pdf")))
                    .unwrap()
            })
            .collect()
    }

    #[test]
    fn the_sizes_of_a_document_are_shared_not_copied_and_go_with_the_document() {
        let cache = SizeCache::default();
        let [a, b] = ids(2)[..] else {
            panic!("two ids")
        };
        assert!(
            cache.get(a).is_none(),
            "nothing before the document is loaded"
        );
        assert!(cache.flags(a).is_none());

        let sizes: PageSizes = Arc::from(vec![[612.0, 792.0], [200.0, 100.0]]);
        let flags = DocFlags {
            encrypted: true,
            ..DocFlags::default()
        };
        cache.insert(a, Arc::clone(&sizes), flags);
        let first = cache.get(a).unwrap();
        let second = cache.get(a).unwrap();
        assert!(
            Arc::ptr_eq(&first, &second),
            "every caller gets the one list"
        );
        assert_eq!(&*first, &[[612.0, 792.0], [200.0, 100.0]]);
        assert_eq!(cache.flags(a), Some(flags));
        assert!(cache.get(b).is_none(), "another document is not affected");

        cache.remove(a);
        assert!(cache.get(a).is_none());
        assert!(cache.flags(a).is_none());
        assert_eq!(cache.len(), 0);
        // Releasing a document that has no sizes is nothing.
        cache.remove(b);
    }
}
