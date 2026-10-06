//! Type1 programs (`FontFile`): a bounded scan of the cleartext part and of the `eexec` part for `/Encoding` and `/CharStrings` names.
//! No charstring is executed.

use crate::error::AppError;

/// What the scan found.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Type1Info {
    /// The built-in encoding: code to glyph name.
    pub encoding: Vec<(u8, String)>,
    /// Names in `/CharStrings`, with the number of charstring bytes (0 = empty outline).
    pub char_strings: Vec<(String, u32)>,
}

pub fn scan(_data: &[u8]) -> Result<Type1Info, AppError> {
    Err(AppError::not_yet())
}
