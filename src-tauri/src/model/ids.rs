//! Ids of the annotation model (ADR-003 §2). A page id is `documents::PageId`.

use serde::{Deserialize, Serialize};

/// The id of an annotation: a number that is unique within a document for the length of the session (never reused). Serialized
/// as a plain number.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct AnnotId(u32);

impl AnnotId {
    pub const fn new(value: u32) -> Self {
        Self(value)
    }

    pub const fn get(self) -> u32 {
        self.0
    }
}

/// The id of an asset of a document (ADR-041 §5): signature art copied into the document by `use_signature`. Unique within a document
/// for the length of the session (never reused). Serialized as a plain number.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct AssetId(u32);

impl AssetId {
    pub const fn new(value: u32) -> Self {
        Self(value)
    }

    pub const fn get(self) -> u32 {
        self.0
    }
}
