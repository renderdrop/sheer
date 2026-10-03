//! Reading, writing and removing document metadata (ADR-047 §5). owned by package D.

use lopdf::{Document, IncrementalDocument};

use crate::error::AppError;
use crate::model::metadata::MetadataValues;

/// A date for `/ModDate` and the XMP packet: UTC, to the second.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PdfDate {
    pub year: u16,
    pub month: u8,
    pub day: u8,
    pub hour: u8,
    pub minute: u8,
    pub second: u8,
}

/// What `/Info` and the catalog's `/Metadata` hold, decoded and filtered (strings ≤ 1 000 characters, dates as ISO 8601 or `None`).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct MetadataRead {
    pub values: MetadataValues,
    pub created: Option<String>,
    pub modified: Option<String>,
    pub pdf_version: String,
    pub xmp_present: bool,
    pub xmp_bytes: u64,
    pub truncated: bool,
}

/// Reads the trailer `/Info` and the catalog `/Metadata` of `doc`.
pub fn read(_doc: &Document) -> Result<MetadataRead, AppError> {
    Err(AppError::not_yet())
}

/// Appends a new `/Info` (keeping the keys it does not edit, `/ModDate` = `now`) and, if `had_xmp`, a regenerated XMP packet.
pub fn write(
    _doc: &mut IncrementalDocument,
    _m: &MetadataValues,
    _had_xmp: bool,
    _now: PdfDate,
) -> Result<(), AppError> {
    Err(AppError::not_yet())
}

/// Removes `/Info`, every `/Metadata` and every `/PieceInfo`.
pub fn strip(_doc: &mut Document) -> Result<(), AppError> {
    Err(AppError::not_yet())
}
