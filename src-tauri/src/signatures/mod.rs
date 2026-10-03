//! Signature art (ADR-041 §5, §6, §8): what a signature, initials or a mark looks like before it is a PDF, and where it is kept
//! while the app runs.
//!
//! * [`Art`] is vector (filled polygons, nonzero, y down, 1 000 units high) or raster (a PNG of RGBA8, metadata-free).
//! * [`vector`] normalizes drawn outlines, [`typed`] lays a name out with the bundled font, [`raster`] imports a picture. All three
//!   treat their input as hostile: counts, sizes and numbers are bounded here.
//! * [`DraftStore`] holds the art of the last signatures made (app level, in memory); [`AssetStore`] holds the art a document uses
//!   (`DocState`), dropped with the document.
//!
//! The PDF side is `pdfwrite::{appearance, annots}`; the commands are `commands::signatures`.

pub mod convert;
pub mod marks;
pub mod raster;
pub mod typed;
pub mod vector;

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::sync::{Arc, Mutex, PoisonError};

use serde::{Deserialize, Serialize};

use crate::error::AppError;
use crate::model::annotation::SignatureRole;
use crate::model::geometry::Point;
use crate::model::ids::AssetId;

/// Drafts kept at once; the oldest is dropped (ADR-041 §6).
pub const MAX_DRAFTS: usize = 16;
/// Assets per document, and their bytes in all (ADR-041 §8).
pub const MAX_ASSETS: usize = 64;
pub const MAX_ASSET_BYTES: usize = 32 * 1024 * 1024;

/// The id of a draft: a number that is never reused in a session.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct DraftId(pub u32);

/// The picture of a signature.
#[derive(Debug, Clone, PartialEq)]
pub enum Art {
    /// Filled polygons (nonzero rule), y down, in a box `w` by `h` units; `h` is [`vector::UNIT_HEIGHT`].
    Vector {
        w: f32,
        h: f32,
        paths: Vec<Vec<Point>>,
    },
    /// A PNG, RGBA8, without metadata, `w` by `h` pixels.
    Raster { w: u32, h: u32, png: Vec<u8> },
}

/// What the UI is told about art (the pixels of raster art come through `get_signature_preview`).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum SignatureArt {
    Vector {
        w: f32,
        h: f32,
        paths: Vec<Vec<Point>>,
    },
    Raster {
        w: u32,
        h: u32,
    },
}

impl Art {
    /// Width over height.
    #[allow(clippy::cast_precision_loss)]
    pub fn aspect(&self) -> f32 {
        match self {
            Self::Vector { w, h, .. } => w / h,
            Self::Raster { w, h, .. } => *w as f32 / *h as f32,
        }
    }

    /// About how much memory the art holds.
    pub fn byte_size(&self) -> usize {
        match self {
            Self::Vector { paths, .. } => paths.iter().map(|path| path.len() * 8 + 24).sum(),
            Self::Raster { png, .. } => png.len(),
        }
    }

    pub fn wire(&self) -> SignatureArt {
        match self {
            Self::Vector { w, h, paths } => SignatureArt::Vector {
                w: *w,
                h: *h,
                paths: paths.clone(),
            },
            Self::Raster { w, h, .. } => SignatureArt::Raster { w: *w, h: *h },
        }
    }
}

/// A signature that was made and not placed or saved yet.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignatureDraft {
    pub id: DraftId,
    pub role: SignatureRole,
    pub art: SignatureArt,
}

struct Drafts {
    next: u32,
    items: VecDeque<(DraftId, SignatureRole, Arc<Art>)>,
}

/// The last [`MAX_DRAFTS`] signatures made, in memory only.
pub struct DraftStore {
    inner: Mutex<Drafts>,
}

impl Default for DraftStore {
    fn default() -> Self {
        Self {
            inner: Mutex::new(Drafts {
                next: 1,
                items: VecDeque::new(),
            }),
        }
    }
}

impl DraftStore {
    pub fn add(&self, role: SignatureRole, art: Art) -> SignatureDraft {
        let mut inner = self.inner.lock().unwrap_or_else(PoisonError::into_inner);
        let id = DraftId(inner.next);
        inner.next = inner.next.wrapping_add(1).max(1);
        let wire = art.wire();
        inner.items.push_back((id, role, Arc::new(art)));
        while inner.items.len() > MAX_DRAFTS {
            inner.items.pop_front();
        }
        SignatureDraft {
            id,
            role,
            art: wire,
        }
    }

    /// Forgets draft `id`. `false` if there is no such draft (it fell off the end, or was discarded already).
    pub fn discard(&self, id: DraftId) -> bool {
        let mut inner = self.inner.lock().unwrap_or_else(PoisonError::into_inner);
        let before = inner.items.len();
        inner.items.retain(|(draft, ..)| *draft != id);
        inner.items.len() != before
    }

    pub fn get(&self, id: DraftId) -> Option<(SignatureRole, Arc<Art>)> {
        let inner = self.inner.lock().unwrap_or_else(PoisonError::into_inner);
        inner
            .items
            .iter()
            .find(|(draft, ..)| *draft == id)
            .map(|(_, role, art)| (*role, Arc::clone(art)))
    }
}

/// The art a document uses (`DocState.assets`): by [`AssetId`], never reused, dropped with the document.
#[derive(Debug, Default)]
pub struct AssetStore {
    next: u32,
    items: BTreeMap<AssetId, Arc<Art>>,
    bytes: usize,
}

impl AssetStore {
    /// Adds `art` (the same art twice is one asset). `limit_exceeded` (`assets`) at [`MAX_ASSETS`] or [`MAX_ASSET_BYTES`].
    pub fn add(&mut self, art: &Arc<Art>) -> Result<AssetId, AppError> {
        if let Some((id, _)) = self
            .items
            .iter()
            .find(|(_, held)| Arc::ptr_eq(held, art) || **held == *art)
        {
            return Ok(*id);
        }
        if self.items.len() >= MAX_ASSETS {
            return Err(AppError::limit("assets", MAX_ASSETS as u64));
        }
        if self.bytes.saturating_add(art.byte_size()) > MAX_ASSET_BYTES {
            return Err(AppError::limit("assets", MAX_ASSET_BYTES as u64));
        }
        self.next += 1;
        let id = AssetId::new(self.next);
        self.bytes += art.byte_size();
        self.items.insert(id, Arc::clone(art));
        Ok(id)
    }

    pub fn get(&self, id: AssetId) -> Option<&Arc<Art>> {
        self.items.get(&id)
    }

    pub fn contains(&self, id: AssetId) -> bool {
        self.items.contains_key(&id)
    }

    /// Cheap copies of every asset, for a save.
    pub fn snapshot(&self) -> HashMap<AssetId, Arc<Art>> {
        self.items
            .iter()
            .map(|(id, art)| (*id, Arc::clone(art)))
            .collect()
    }
}

/// The frame `get_signature_preview` returns: the `SHR1` header of `engine::encode` and a PNG payload.
pub fn preview_frame(width: u32, height: u32, png: &[u8]) -> Vec<u8> {
    use crate::engine::encode::{FORMAT_PNG_RGB, FRAME_HEADER_BYTES, FRAME_MAGIC};
    let mut out = Vec::with_capacity(FRAME_HEADER_BYTES + png.len());
    out.extend_from_slice(&FRAME_MAGIC);
    out.push(FORMAT_PNG_RGB);
    out.extend_from_slice(&[0, 0, 0]);
    out.extend_from_slice(&width.to_le_bytes());
    out.extend_from_slice(&height.to_le_bytes());
    out.extend_from_slice(png);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn square(size: f32) -> Art {
        let corner = |x, y| Point { x, y };
        Art::Vector {
            w: size,
            h: size,
            paths: vec![vec![
                corner(0.0, 0.0),
                corner(size, 0.0),
                corner(size, size),
            ]],
        }
    }

    #[test]
    fn drafts_are_capped_and_the_oldest_goes() {
        let store = DraftStore::default();
        let first = store.add(SignatureRole::Signature, square(1.0)).id;
        for size in 2..=(MAX_DRAFTS as u32 + 1) {
            store.add(SignatureRole::Initials, square(size as f32));
        }
        assert!(store.get(first).is_none());
        let last = store.add(SignatureRole::Signature, square(99.0));
        assert!(store.get(last.id).is_some());
    }

    #[test]
    fn assets_dedupe_and_are_capped() {
        let mut assets = AssetStore::default();
        let art = Arc::new(square(5.0));
        let a = assets.add(&art).unwrap();
        assert_eq!(assets.add(&Arc::new(square(5.0))).unwrap(), a);
        for size in 0..(MAX_ASSETS - 1) {
            assets.add(&Arc::new(square(10.0 + size as f32))).unwrap();
        }
        assert!(assets.add(&Arc::new(square(500.0))).is_err());
        assert!(assets.contains(a));
        assert_eq!(assets.snapshot().len(), MAX_ASSETS);
    }
}
