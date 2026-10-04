//! Engine-only documents opened from memory for one output job (ADR-049 §1). Only the worker calls this.

use std::collections::HashMap;
use std::io::Cursor;
use std::sync::Arc;

use pdfium_render::prelude::*;

use crate::error::{AppError, ErrorCode};
use crate::export::snapshot::SnapshotId;
use crate::limits;

/// The snapshots the worker holds. Not in the registry, no page sizes; gone with the worker.
pub(crate) type Snapshots<'a> = HashMap<SnapshotId, PdfDocument<'a>>;

/// Loads `bytes` as snapshot `id`. The bytes were written by us (the save pipeline), so there is no password; a file that does not
/// load is `damaged_file`, and one with more pages than the app opens is refused like any document.
pub(super) fn open<'a>(
    pdfium: &'a Pdfium,
    snapshots: &mut Snapshots<'a>,
    id: SnapshotId,
    bytes: Arc<[u8]>,
) -> Result<(), AppError> {
    let document = pdfium
        .load_pdf_from_reader(Cursor::new(bytes), None)
        .map_err(|error| AppError::logged(ErrorCode::DamagedFile, format!("snapshot: {error}")))?;
    let pages = u32::try_from(document.pages().len())
        .map_err(|_| AppError::logged(ErrorCode::DamagedFile, "negative page count"))?;
    limits::validate_page_count(pages)?;
    snapshots.insert(id, document);
    Ok(())
}

/// Drops snapshot `id`; an unknown one is not an error.
pub(super) fn close(snapshots: &mut Snapshots<'_>, id: SnapshotId) {
    snapshots.remove(&id);
}
