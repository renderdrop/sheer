//! Writing the rewritten page as an incremental update (ARCHITECTURE §13.4): one new content stream per page (the same object id when
//! only this page uses it), new font objects, page `/Resources` materialised when inherited or shared. Never a Full save because of text.
//!
//! W0 seam: signature only, [`write`] is `not_yet`.

use lopdf::{IncrementalDocument, ObjectId};

use super::text_splice::Rewritten;
use crate::error::AppError;

pub fn write(
    _doc: &mut IncrementalDocument,
    _page: ObjectId,
    _rewritten: &Rewritten,
) -> Result<(), AppError> {
    Err(AppError::not_yet())
}
