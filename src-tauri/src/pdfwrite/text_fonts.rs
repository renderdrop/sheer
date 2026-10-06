//! A font dictionary as a [`FontMap`] (ARCHITECTURE §13.3): which characters have a code, a glyph and a width in it.
//!
//! W0 seam: signatures only, [`font_map`] is `not_yet`.

use std::collections::{HashMap, HashSet};

use lopdf::{Document, ObjectId};

use crate::error::AppError;
pub use crate::fontprog::ProgramKind;

/// A character code as written in a string (one or two bytes).
pub type Code = u32;

/// `Type3` and `Type0Other` are read for mapping only and always refused for editing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FontKind {
    Simple,
    Type0IdentityH,
    Type3,
    Type0Other,
}

/// Where widths come from.
#[derive(Debug, Clone, PartialEq)]
pub enum WidthSource {
    /// `/Widths` from `first_char`, in 1/1000 em.
    Widths { first_char: u32, widths: Vec<f32> },
    /// The standard-14 metrics.
    Std14,
    /// `/DW` and `/W` of a CIDFont.
    Cid {
        default: f32,
        widths: HashMap<u32, f32>,
    },
}

/// Codes that have a glyph (embedded program, or the encoding for a non-embedded font).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GlyphSet {
    pub codes: HashSet<Code>,
}

/// What `text_fonts` knows of one font.
#[derive(Debug, Clone)]
pub struct FontMap {
    pub kind: FontKind,
    pub embedded: Option<ProgramKind>,
    /// The name starts with `ABCDEF+`.
    pub subset: bool,
    /// Unicode to code (for several codes: the one used most on the page).
    pub to_code: HashMap<char, Code>,
    pub widths: WidthSource,
    pub glyphs: GlyphSet,
    pub space_code: Option<Code>,
}

/// How one character fares in a font.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CharStatus {
    Ok,
    Missing,
}

impl FontMap {
    /// `Ok` when the character has a code, a glyph and a width.
    pub fn status(&self, _c: char) -> CharStatus {
        CharStatus::Missing
    }
}

/// Reads the font `font` of `src`; `observed` is the code to Unicode table seen on the page (used without `ToUnicode`).
pub fn font_map(
    _src: &Document,
    _font: ObjectId,
    _observed: &HashMap<Code, char>,
) -> Result<FontMap, AppError> {
    Err(AppError::not_yet())
}
