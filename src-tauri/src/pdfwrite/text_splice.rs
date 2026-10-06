//! The offset lexer of a content stream and the splice that rewrites a line (ARCHITECTURE §13.4).
//!
//! W0 seam: signatures only, [`lex`] and [`replay`] are `not_yet`.

use std::ops::Range;

use lopdf::{Document, ObjectId};

use crate::error::AppError;
use crate::fontprog::fallback::{Face, FallbackStore};
use crate::model::text_edit::{ChangeWarning, TextEdit};

/// One operator with the byte range of its operands in the stream.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Tok {
    pub op: Vec<u8>,
    pub args: Range<u32>,
}

/// A font object the rewritten page needs in addition (the substitute of a face).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewFont {
    pub face: Face,
    /// The resource name written in `Tf` (`SheerFn...`).
    pub name: String,
}

/// The page after all its edits: the new content stream bytes (one stream), the new fonts and what the user is told.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rewritten {
    pub content: Vec<u8>,
    pub fonts: Vec<NewFont>,
    pub warnings: Vec<ChangeWarning>,
}

/// Splits `stream` into operators with offsets; inline images are skipped by `BI..ID..EI` with a length check. `invalid_argument` on doubt
/// (the caller then re-encodes the whole stream via lopdf).
pub fn lex(_stream: &[u8]) -> Result<Vec<Tok>, AppError> {
    Err(AppError::not_yet())
}

/// Replays `edits` (each key resolved against the state after the edits before it) over the original content of `page`. The substitute
/// glyphs of `fonts` are the ones the whole save needs.
pub fn replay(
    _src: &Document,
    _page: ObjectId,
    _edits: &[TextEdit],
    _fonts: &FallbackStore,
) -> Result<Rewritten, AppError> {
    Err(AppError::not_yet())
}
