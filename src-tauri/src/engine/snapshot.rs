// owned by package C
//! Engine-only documents opened from memory for one output job (ADR-049 §1). Only the worker calls this.

use std::collections::HashMap;

use pdfium_render::prelude::*;

use crate::error::AppError;
use crate::export::snapshot::SnapshotId;

/// The snapshots the worker holds. Not in the registry, no page sizes; gone with the worker.
pub(crate) type Snapshots<'a> = HashMap<SnapshotId, PdfDocument<'a>>;

/// Loads `bytes` as snapshot `id`. Stub (package C): `not_yet`.
pub(super) fn open<'a>(
    _pdfium: &'a Pdfium,
    _snapshots: &mut Snapshots<'a>,
    _id: SnapshotId,
    _bytes: &[u8],
) -> Result<(), AppError> {
    Err(AppError::not_yet())
}

/// Drops snapshot `id`; an unknown one is not an error.
pub(super) fn close(snapshots: &mut Snapshots<'_>, id: SnapshotId) {
    snapshots.remove(&id);
}
