//! The pages of a document as the model has them (ADR-036 §1): a stable id for each page, and the order they are in.
//!
//! A page id is a number from a per-document counter that never gives a number out twice: page *i* of the file has id *i* when the
//! document is opened, pages added later get the next numbers. The order of the pages is a list of [`PageSlot`]s in the state; an
//! annotation names its page by id, so it follows a page that is moved, rotated or (with undo) deleted and brought back. Where a page
//! is in the engine's copy of the document (`engine_index`) is separate from where it is in the order, and never changes.

use serde::{Deserialize, Serialize};

use crate::documents::PageId;

/// An import source: a PDF the user chose to take pages from, held in memory by `documents::sources`. Serialized as a plain number.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct SourceId(u32);

impl SourceId {
    pub const fn new(value: u32) -> Self {
        Self(value)
    }

    pub const fn get(self) -> u32 {
        self.0
    }
}

/// Where the content of a page comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PageSource {
    /// Page `index` of the file the document was opened from (or last saved to).
    File { index: u32 },
    /// A page added empty in this session.
    Blank,
    /// Page `index` of an import source.
    Imported { source: SourceId, index: u32 },
}

impl PageSource {
    /// The word the UI is told: `file`, `blank` or `imported`.
    pub const fn origin(self) -> &'static str {
        match self {
            Self::File { .. } => "file",
            Self::Blank => "blank",
            Self::Imported { .. } => "imported",
        }
    }
}

/// One page in the order of the document.
#[derive(Debug, Clone, PartialEq)]
pub struct PageSlot {
    pub id: PageId,
    pub source: PageSource,
    /// The page's position in the engine's copy, which only grows (deleted and moved pages leave the others where they are).
    pub engine_index: u32,
    /// Degrees clockwise (0, 90, 180, 270): the page's `/Rotate` as it is now in the session.
    pub rotation: u16,
    /// The rotation the file has for this page (what a save would not need to write).
    pub saved_rotation: u16,
    /// Counts the changes that alter how the page looks; part of the UI's cache keys.
    pub rev: u32,
    /// Width and height in points, before the rotation.
    pub size: [f32; 2],
}

/// What the UI is told about a page (`PageSlotInfo` of ARCHITECTURE §5).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageSlotInfo {
    pub id: PageId,
    pub width: f32,
    pub height: f32,
    pub rotation: u16,
    pub rev: u32,
    pub label: Option<String>,
    pub origin: &'static str,
}

impl PageSlot {
    pub fn info(&self) -> PageSlotInfo {
        PageSlotInfo {
            id: self.id,
            width: self.size[0],
            height: self.size[1],
            rotation: self.rotation,
            rev: self.rev,
            label: None,
            origin: self.source.origin(),
        }
    }
}

/// A page that was added to the engine's copy and now joins the model.
#[derive(Debug, Clone, PartialEq)]
pub struct NewPage {
    pub source: PageSource,
    pub engine_index: u32,
    pub rotation: u16,
    pub size: [f32; 2],
    /// The annotations a page of an import source came with, as the engine read them from its copy. `None`: not read (a blank page
    /// has none; for an imported page the model reads them later like those of any page).
    pub annotations: Option<Vec<super::annotation::Imported>>,
}

/// A size for a page that has no neighbour to take one from: A4 in points.
pub const A4_PT: [f32; 2] = [595.28, 841.89];

/// A drawn size (rotation applied) as the size before the rotation.
pub fn unrotated(drawn: [f32; 2], rotation: u16) -> [f32; 2] {
    if rotation % 180 == 90 {
        [drawn[1], drawn[0]]
    } else {
        drawn
    }
}

/// `degrees` as one of 0, 90, 180, 270 (anything else, which a file can hold, is rounded down to a quarter turn).
pub fn normalize_rotation(degrees: i64) -> u16 {
    let quarter = degrees.div_euclid(90).rem_euclid(4);
    u16::try_from(quarter * 90).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rotations_are_quarter_turns() {
        assert_eq!(normalize_rotation(-90), 270);
        assert_eq!(normalize_rotation(450), 90);
        assert_eq!(normalize_rotation(0), 0);
        assert_eq!(normalize_rotation(100), 90);
    }

    #[test]
    fn a_drawn_size_turns_back_into_the_unrotated_one() {
        assert_eq!(unrotated([200.0, 100.0], 90), [100.0, 200.0]);
        assert_eq!(unrotated([200.0, 100.0], 180), [200.0, 100.0]);
    }

    #[test]
    fn page_info_serializes_camel_case_with_the_origin() {
        let slot = PageSlot {
            id: PageId::new(3),
            source: PageSource::Blank,
            engine_index: 9,
            rotation: 90,
            saved_rotation: 0,
            rev: 2,
            size: [10.0, 20.0],
        };
        let value = serde_json::to_value(slot.info()).unwrap();
        assert_eq!(value["id"], 3);
        assert_eq!(value["origin"], "blank");
        assert_eq!(value["rotation"], 90);
        assert!(value["label"].is_null());
    }
}
