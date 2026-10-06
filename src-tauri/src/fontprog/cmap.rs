//! The `ToUnicode` CMap parser (`bfchar`, `bfrange`), bounded by `limits::TOUNICODE_*`.

use std::collections::HashMap;

use crate::error::AppError;

/// Character code to the text it stands for (at most `limits::TOUNICODE_DEST_UNITS` UTF-16 units each).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ToUnicode {
    pub map: HashMap<u32, String>,
}

impl ToUnicode {
    /// The reverse lookup for one character: every code that maps to exactly `c`, ascending.
    pub fn codes_for(&self, _c: char) -> Vec<u32> {
        Vec::new()
    }
}

/// Parses the decoded stream. `limit_exceeded` over the limits, `invalid_argument` for a stream that is not a CMap.
pub fn parse(_data: &[u8]) -> Result<ToUnicode, AppError> {
    Err(AppError::not_yet())
}
