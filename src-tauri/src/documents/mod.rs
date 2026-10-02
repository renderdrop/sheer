//! Document registry: opaque document id → file path.
//!
//! Paths only ever enter through the native file dialog (backend) and never leave the backend. The frontend works
//! with [`DocumentId`] values alone.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard, PoisonError};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, ErrorCode};

/// Upper bound for simultaneously open documents (bounds memory held by the engine).
pub const MAX_OPEN_DOCUMENTS: usize = 32;

/// Opaque handle for an open document. Serialized as a plain number.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct DocumentId(u32);

/// What the frontend learns about a document it just opened.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentInfo {
    pub id: DocumentId,
    pub page_count: u32,
}

#[derive(Debug)]
struct Entry {
    path: PathBuf,
    /// `None` until the engine has loaded the document.
    page_count: Option<u32>,
}

#[derive(Debug, Default)]
struct Inner {
    next_id: u32,
    entries: HashMap<DocumentId, Entry>,
}

/// Thread-safe registry. Ids are never reused within a session.
#[derive(Debug, Default)]
pub struct Registry {
    inner: Mutex<Inner>,
}

impl Registry {
    pub fn new() -> Self {
        Self::default()
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        // A poisoned lock only means another thread panicked mid-update; the map itself stays consistent.
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Registers a path and returns its new id.
    pub fn register(&self, path: PathBuf) -> Result<DocumentId, AppError> {
        let mut inner = self.lock();
        if inner.entries.len() >= MAX_OPEN_DOCUMENTS {
            return Err(ErrorCode::TooManyDocuments.into());
        }
        let id = DocumentId(inner.next_id);
        inner.next_id = inner
            .next_id
            .checked_add(1)
            .ok_or(AppError::new(ErrorCode::Internal))?;
        inner.entries.insert(
            id,
            Entry {
                path,
                page_count: None,
            },
        );
        Ok(id)
    }

    /// Records the page count once the engine has loaded the document.
    pub fn set_page_count(&self, id: DocumentId, page_count: u32) -> Result<(), AppError> {
        match self.lock().entries.get_mut(&id) {
            Some(entry) => {
                entry.page_count = Some(page_count);
                Ok(())
            }
            None => Err(ErrorCode::UnknownDocument.into()),
        }
    }

    /// Page count of a loaded document. Unknown or not yet loaded ids are `UnknownDocument`.
    pub fn page_count(&self, id: DocumentId) -> Result<u32, AppError> {
        self.lock()
            .entries
            .get(&id)
            .and_then(|entry| entry.page_count)
            .ok_or(AppError::new(ErrorCode::UnknownDocument))
    }

    /// Path of a registered document (for reload and save in later milestones).
    pub fn path(&self, id: DocumentId) -> Option<PathBuf> {
        self.lock().entries.get(&id).map(|entry| entry.path.clone())
    }

    /// Removes a document. Returns `true` if it was registered.
    pub fn remove(&self, id: DocumentId) -> bool {
        self.lock().entries.remove(&id).is_some()
    }

    pub fn len(&self) -> usize {
        self.lock().entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn path(name: &str) -> PathBuf {
        PathBuf::from(name)
    }

    #[test]
    fn ids_are_unique_and_not_reused_after_removal() {
        let registry = Registry::new();
        let a = registry.register(path("a.pdf")).unwrap();
        let b = registry.register(path("b.pdf")).unwrap();
        assert_ne!(a, b);
        assert!(registry.remove(a));
        let c = registry.register(path("c.pdf")).unwrap();
        assert_ne!(a, c);
        assert_ne!(b, c);
    }

    #[test]
    fn page_count_requires_a_loaded_document() {
        let registry = Registry::new();
        let id = registry.register(path("a.pdf")).unwrap();
        assert_eq!(
            registry.page_count(id).unwrap_err().code(),
            ErrorCode::UnknownDocument
        );
        registry.set_page_count(id, 7).unwrap();
        assert_eq!(registry.page_count(id).unwrap(), 7);
        assert_eq!(registry.path(id), Some(path("a.pdf")));
    }

    #[test]
    fn unknown_ids_are_rejected() {
        let registry = Registry::new();
        let id = registry.register(path("a.pdf")).unwrap();
        assert!(registry.remove(id));
        assert!(!registry.remove(id));
        assert_eq!(
            registry.set_page_count(id, 1).unwrap_err().code(),
            ErrorCode::UnknownDocument
        );
        assert_eq!(registry.path(id), None);
    }

    #[test]
    fn open_documents_are_capped() {
        let registry = Registry::new();
        for i in 0..MAX_OPEN_DOCUMENTS {
            registry.register(path(&format!("{i}.pdf"))).unwrap();
        }
        assert_eq!(
            registry.register(path("extra.pdf")).unwrap_err().code(),
            ErrorCode::TooManyDocuments
        );
        assert_eq!(registry.len(), MAX_OPEN_DOCUMENTS);
    }

    #[test]
    fn document_info_serializes_camel_case() {
        let registry = Registry::new();
        let id = registry.register(path("a.pdf")).unwrap();
        let info = DocumentInfo { id, page_count: 3 };
        assert_eq!(
            serde_json::to_string(&info).unwrap(),
            r#"{"id":0,"pageCount":3}"#
        );
    }
}
