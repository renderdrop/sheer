//! The bundled substitute fonts (ADR-125 §3): 12 faces of Arimo, Tinos and Cousine, picked by the original font's flags, weight and
//! name, subset with `subsetter` and written as Type0/Identity-H, one font object per (face, document save), glyphs unioned.

use std::collections::{BTreeSet, HashMap};

use crate::error::AppError;
use crate::model::text_edit::FallbackFace;

/// One of the 12 bundled faces.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Face {
    pub family: FallbackFace,
    pub bold: bool,
    pub italic: bool,
}

/// Picks the face closest to a font with these `/FontDescriptor` flags, weight (`/FontWeight` or 400) and name.
pub fn pick(_flags: u32, _weight: u32, _name: &str) -> Face {
    Face {
        family: FallbackFace::Sans,
        bold: false,
        italic: false,
    }
}

/// A generated subset: the font program (`FontFile2`), the glyph id of every character, widths in 1/1000 em.
#[derive(Debug, Clone, PartialEq)]
pub struct Subset {
    pub program: Vec<u8>,
    pub gids: Vec<(char, u16)>,
    pub widths: Vec<(u16, f32)>,
}

/// The substitute glyphs a document save needs: per face, the union of the characters of every edit. Filled while a page is replayed.
#[derive(Debug, Clone, Default)]
pub struct FallbackStore {
    pub chars: HashMap<Face, BTreeSet<char>>,
}

impl FallbackStore {
    /// Notes that `text` is drawn in `face`.
    pub fn add(&mut self, face: Face, text: &str) {
        self.chars.entry(face).or_default().extend(text.chars());
    }

    /// Builds the subset of `face`, re-parses it with `skrifa` before it is returned. `invalid_argument` for a character the face
    /// does not have.
    pub fn subset(&self, _face: Face) -> Result<Subset, AppError> {
        Err(AppError::not_yet())
    }
}
