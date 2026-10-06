//! Font programs for text editing (v1.5, ADR-125, ARCHITECTURE §13.3): glyph tables read with `skrifa`, the Type1 scan, the `ToUnicode`
//! parser and the bundled substitute fonts. Engine-free and lopdf-free: bytes in, plain data out. Every input is hostile and bounded
//! by the `limits::FONT_*` and `limits::TOUNICODE_*` constants.
//!
//! W0 seam: signatures only, every body is `not_yet`.

pub mod cmap;
pub mod fallback;
pub mod glyphs;
pub mod type1;

/// The kind of an embedded font program (`FontFile`, `FontFile2`, `FontFile3` with `/Subtype`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ProgramKind {
    TrueType,
    Cff,
    OpenTypeCff,
    Type1,
}
