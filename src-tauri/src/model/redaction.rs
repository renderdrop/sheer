//! Redaction marks as the model has them (ADR-047 §3). owned by package C.
//!
//! A mark is an annotation of kind `redactMark` that lives in the model only: undoable, never written to the file, never imported,
//! never in the comments list. Applying them is a job (`engine::redact`) that swaps the marked pages for raster pages.

use serde::{Deserialize, Serialize};

use super::annotation::{AnnotationBody, RedactSource};
use super::command::DocCommand;
use super::doc_state::{Delta, DocState};
use super::geometry::Quad;
use crate::documents::PageId;
use crate::error::AppError;

/// The marks of one page in a [`DocCommand::MarkRedactions`] (search hits become these).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkSpec {
    pub page_id: PageId,
    pub quads: Vec<Quad>,
    pub source: RedactSource,
}

/// The arguments of `apply_redactions`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RedactOptions {
    /// `None`: every page with marks.
    pub pages: Option<Vec<PageId>>,
    pub remove_metadata: bool,
}

/// Checks the geometry of a new mark (called from `AnnotationBody::check`): quads in range, at most 512, not empty. Package C adds the
/// per-document budget.
pub(crate) fn check_mark(body: &AnnotationBody) -> Result<(), AppError> {
    let _ = body;
    Ok(())
}

/// Runs [`DocCommand::MarkRedactions`]: adds the marks as one step and returns its inverse. Package C.
pub(crate) fn mark(
    _state: &mut DocState,
    _marks: &[MarkSpec],
    _delta: &mut Delta,
) -> Result<DocCommand, AppError> {
    Err(AppError::not_yet())
}
