// owned by package D
//! The pre-rendered pages of one print job (ADR-049 §4): at most `limits::MAX_PRINT_SETS` held, each at most
//! `limits::MAX_PRINT_PAGES` pages and `limits::MAX_PRINT_SET_BYTES`, dropped after `limits::PRINT_SET_TTL`.

use std::sync::Arc;
use std::time::Instant;

use crate::documents::DocumentId;

/// The JPEG frames of a print job, in page order.
#[derive(Debug, Clone)]
pub struct PrintSet {
    pub id: u32,
    pub doc: DocumentId,
    pub frames: Vec<Arc<[u8]>>,
    pub bytes: usize,
    pub created: Instant,
}
