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
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PageSource {
    /// Page `index` of the file the document was opened from (or last saved to).
    File { index: u32 },
    /// A page added empty in this session.
    Blank,
    /// Page `index` of an import source.
    Imported { source: SourceId, index: u32 },
    /// A page that true redaction replaced by a raster (ADR-047 §3): a one-page PDF made by `pdfwrite::redact::raster_page`, held in
    /// memory until the save. The page keeps its id.
    Redacted { bytes: std::sync::Arc<[u8]> },
}

impl PageSource {
    /// The word the UI is told: `file`, `blank` or `imported`.
    pub const fn origin(&self) -> &'static str {
        match self {
            Self::File { .. } => "file",
            Self::Blank => "blank",
            Self::Imported { .. } => "imported",
            Self::Redacted { .. } => "redacted",
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
    /// The MediaBox in user space `[x0, y0, x1, y1]`, read when the document is opened (ADR-047 §2).
    pub media: [f32; 4],
    /// The CropBox in user space when the page has one different from the MediaBox, else `None`.
    pub crop: Option<[f32; 4]>,
    /// The crop the file has (what a save would not need to write).
    pub saved_crop: Option<[f32; 4]>,
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
    /// The MediaBox size, and the margins the CropBox leaves from it (`null` without a crop), in points before the rotation.
    pub media: MediaInfo,
    pub crop: Option<CropInfo>,
}

/// The size of a page's MediaBox.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaInfo {
    pub width: f32,
    pub height: f32,
}

/// How far the CropBox is inside the MediaBox on each side.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CropInfo {
    pub top: f32,
    pub right: f32,
    pub bottom: f32,
    pub left: f32,
}

impl PageSlot {
    /// The box the page shows, in user space: the crop, else the MediaBox.
    pub fn shown_box(&self) -> [f32; 4] {
        self.crop.unwrap_or(self.media)
    }

    pub fn info(&self) -> PageSlotInfo {
        PageSlotInfo {
            id: self.id,
            width: self.size[0],
            height: self.size[1],
            rotation: self.rotation,
            rev: self.rev,
            label: None,
            origin: self.source.origin(),
            media: MediaInfo {
                width: self.media[2] - self.media[0],
                height: self.media[3] - self.media[1],
            },
            crop: self.crop.map(|crop| CropInfo {
                top: self.media[3] - crop[3],
                right: self.media[2] - crop[2],
                bottom: crop[1] - self.media[1],
                left: crop[0] - self.media[0],
            }),
        }
    }
}

/// What PDFium reports about a page's boxes when the document is loaded: the MediaBox and the CropBox if the page has one.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BoxesRead {
    pub media: [f32; 4],
    pub crop: Option<[f32; 4]>,
}

fn usable_box(b: [f32; 4]) -> bool {
    b.iter().all(|v| v.is_finite()) && b[2] > b[0] && b[3] > b[1]
}

impl BoxesRead {
    /// The boxes as the model keeps them: a MediaBox that is not a usable rectangle becomes `fallback`; a CropBox is clipped to the
    /// MediaBox and is `None` when it leaves nothing or is the MediaBox itself.
    pub fn sanitized(self, fallback: [f32; 4]) -> ([f32; 4], Option<[f32; 4]>) {
        let media = if usable_box(self.media) {
            self.media
        } else {
            fallback
        };
        let crop = self.crop.and_then(|c| {
            let clipped = [
                c[0].max(media[0]),
                c[1].max(media[1]),
                c[2].min(media[2]),
                c[3].min(media[3]),
            ];
            (usable_box(c) && usable_box(clipped) && clipped != media).then_some(clipped)
        });
        (media, crop)
    }
}

/// A page that was added to the engine's copy and now joins the model.
#[derive(Debug, Clone, PartialEq)]
pub struct NewPage {
    pub source: PageSource,
    pub engine_index: u32,
    pub rotation: u16,
    pub size: [f32; 2],
    /// The box the page shows in user space `[x0, y0, x1, y1]`: what a crop of the new page is measured from (ADR-047 §2).
    pub media: [f32; 4],
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
            media: [0.0, 0.0, 10.0, 20.0],
            crop: Some([1.0, 2.0, 9.0, 18.0]),
            saved_crop: None,
        };
        let value = serde_json::to_value(slot.info()).unwrap();
        assert_eq!(value["id"], 3);
        assert_eq!(value["origin"], "blank");
        assert_eq!(value["rotation"], 90);
        assert!(value["label"].is_null());
        assert_eq!(value["media"]["width"], 10.0);
        assert_eq!(value["crop"]["left"], 1.0);
        assert_eq!(value["crop"]["top"], 2.0);
        assert_eq!(value["crop"]["right"], 1.0);
        assert_eq!(value["crop"]["bottom"], 2.0);
    }
}
