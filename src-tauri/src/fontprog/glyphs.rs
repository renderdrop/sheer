//! Which glyphs a font program has (ARCHITECTURE §13.3): TrueType `cmap` (3,0)/(1,0)/(3,1), CFF charset, `numGlyphs` and non-empty outlines.

use std::collections::{HashMap, HashSet};

use super::ProgramKind;
use crate::error::AppError;

/// What was read from one font program. Outlines are never rasterised; only their presence is noted.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct GlyphTable {
    pub num_glyphs: u32,
    /// Glyph names present (CFF charset, Type1 `/CharStrings`); empty for TrueType without `post` names.
    pub names: HashSet<String>,
    /// Character code (any of the program's `cmap` subtables) to glyph id; gid 0 is never listed.
    pub cmap: HashMap<u32, u32>,
    /// Glyph ids whose outline is non-empty.
    pub drawn: HashSet<u32>,
    /// Advance widths in 1/1000 em by glyph id (empty when the program has none).
    pub advances: HashMap<u32, f32>,
}

/// Reads the glyph table of `data` with `skrifa` (TrueType, CFF, OpenType-CFF) or the Type1 scan. `limit_exceeded` over
/// `limits::FONT_PROGRAM_MAX` or `limits::FONT_GLYPHS_MAX`; `invalid_argument` for a program that does not parse.
pub fn read(_kind: ProgramKind, _data: &[u8]) -> Result<GlyphTable, AppError> {
    Err(AppError::not_yet())
}
