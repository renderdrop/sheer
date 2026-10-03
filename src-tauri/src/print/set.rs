//! The pre-rendered pages of one print job (ADR-049 §4): at most `limits::MAX_PRINT_SETS` held, each at most `limits::MAX_PRINT_PAGES`
//! pages and `limits::MAX_PRINT_SET_BYTES`, dropped after `limits::PRINT_SET_TTL`. Memory only: no file is ever written.

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Instant;

use crate::documents::DocumentId;
use crate::error::AppError;
use crate::limits;

/// The JPEG frames of a print job, in page order.
#[derive(Debug, Clone)]
pub struct PrintSet {
    pub id: u32,
    pub doc: DocumentId,
    pub frames: Vec<Arc<[u8]>>,
    pub bytes: usize,
    pub created: Instant,
}

/// The frames of a job that is still rendering; refuses a frame that would pass a limit.
#[derive(Debug, Default)]
pub struct PrintSetBuilder {
    frames: Vec<Arc<[u8]>>,
    bytes: usize,
}

impl PrintSetBuilder {
    pub fn new() -> Self {
        Self::default()
    }

    /// Adds the next frame: `limit_exceeded` `printJob` past `max_pages` pages (at most `limits::MAX_PRINT_PAGES`) or
    /// `limits::MAX_PRINT_SET_BYTES` bytes.
    pub fn push(&mut self, frame: Vec<u8>, max_pages: usize) -> Result<(), AppError> {
        let max_pages = max_pages.min(limits::MAX_PRINT_PAGES);
        let bytes = self.bytes.saturating_add(frame.len());
        if self.frames.len() >= max_pages {
            return Err(AppError::limit("printJob", max_pages as u64));
        }
        if bytes > limits::MAX_PRINT_SET_BYTES {
            return Err(AppError::limit(
                "printJob",
                limits::MAX_PRINT_SET_BYTES as u64,
            ));
        }
        self.bytes = bytes;
        self.frames.push(frame.into());
        Ok(())
    }

    pub fn len(&self) -> usize {
        self.frames.len()
    }

    pub fn is_empty(&self) -> bool {
        self.frames.is_empty()
    }
}

/// The sets held now.
#[derive(Debug, Default)]
pub struct PrintSets {
    next: AtomicU32,
    sets: Mutex<Vec<PrintSet>>,
}

impl PrintSets {
    pub fn new() -> Self {
        Self::default()
    }

    fn lock(&self) -> MutexGuard<'_, Vec<PrintSet>> {
        self.sets.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Holds the finished frames of `doc` and answers the set's id. Sets past their life go first; if `MAX_PRINT_SETS` are still held,
    /// the oldest makes room.
    pub fn insert(&self, doc: DocumentId, builder: PrintSetBuilder) -> u32 {
        self.insert_at(doc, builder, Instant::now())
    }

    pub fn insert_at(&self, doc: DocumentId, builder: PrintSetBuilder, now: Instant) -> u32 {
        let id = self.next.fetch_add(1, Ordering::Relaxed).wrapping_add(1);
        let mut sets = self.lock();
        sets.retain(|set| !expired(set, now));
        while sets.len() >= limits::MAX_PRINT_SETS {
            sets.remove(0);
        }
        sets.push(PrintSet {
            id,
            doc,
            frames: builder.frames,
            bytes: builder.bytes,
            created: now,
        });
        id
    }

    /// The pages of set `id`; `not_found` `printSet` if it is unknown, released or expired.
    pub fn pages(&self, id: u32) -> Result<usize, AppError> {
        self.pages_at(id, Instant::now())
    }

    pub fn pages_at(&self, id: u32, now: Instant) -> Result<usize, AppError> {
        self.lock()
            .iter()
            .find(|set| set.id == id && !expired(set, now))
            .map(|set| set.frames.len())
            .ok_or(AppError::not_found("printSet"))
    }

    /// Frame `index` of set `id`; `not_found` for an unknown or expired set, `invalid_argument` `page` past the end.
    pub fn frame(&self, id: u32, index: u32) -> Result<Arc<[u8]>, AppError> {
        self.frame_at(id, index, Instant::now())
    }

    pub fn frame_at(&self, id: u32, index: u32, now: Instant) -> Result<Arc<[u8]>, AppError> {
        let sets = self.lock();
        let set = sets
            .iter()
            .find(|set| set.id == id && !expired(set, now))
            .ok_or(AppError::not_found("printSet"))?;
        set.frames
            .get(index as usize)
            .cloned()
            .ok_or(AppError::invalid("page"))
    }

    /// Drops set `id`; an unknown id is not an error.
    pub fn release(&self, id: u32) {
        self.lock().retain(|set| set.id != id);
    }

    /// Drops the sets of a document that is closing.
    pub fn release_doc(&self, doc: DocumentId) {
        self.lock().retain(|set| set.doc != doc);
    }

    /// Drops the sets past their life; answers how many.
    pub fn sweep(&self, now: Instant) -> usize {
        let mut sets = self.lock();
        let before = sets.len();
        sets.retain(|set| !expired(set, now));
        before - sets.len()
    }

    /// Sets held now.
    pub fn len(&self) -> usize {
        self.lock().len()
    }

    pub fn is_empty(&self) -> bool {
        self.lock().is_empty()
    }
}

fn expired(set: &PrintSet, now: Instant) -> bool {
    now.saturating_duration_since(set.created) >= limits::PRINT_SET_TTL
}
