//! Typed signatures (ADR-041 §6, ADR-051 §3, ADR-058/059): a name laid out with one of three bundled SIL OFL 1.1 fonts (Dancing Script,
//! Great Vibes, Alex Brush; files and `OFL-*.txt` in `resources/fonts/`) and turned into path commands with `skrifa`: quadratic segments are raised
//! exactly to cubic, cubic ones kept, nothing is flattened. This is the only module that uses `skrifa`.
//! The font is compiled in: no path to read at run time, no system fonts, no font in the PDF.

use skrifa::instance::{LocationRef, Size};
use skrifa::outline::{DrawSettings, OutlinePen};
use skrifa::{FontRef, MetadataProvider};

use super::vector::DrawCmd;
use super::{vector, Art};
use crate::error::{AppError, ErrorCode};

use serde::Deserialize;

/// The fonts a typed signature can use (DESIGN 3.60): SIL OFL 1.1, unmodified, compiled in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TypedFont {
    DancingScript,
    GreatVibes,
    AlexBrush,
}

impl TypedFont {
    pub const ALL: [TypedFont; 3] = [Self::DancingScript, Self::GreatVibes, Self::AlexBrush];

    fn bytes(self) -> &'static [u8] {
        match self {
            Self::DancingScript => include_bytes!("../../resources/fonts/DancingScript.ttf"),
            Self::GreatVibes => include_bytes!("../../resources/fonts/GreatVibes-Regular.ttf"),
            Self::AlexBrush => include_bytes!("../../resources/fonts/AlexBrush-Regular.ttf"),
        }
    }
}
/// Characters of a typed signature.
pub const MAX_CHARS: usize = 64;

/// Collects the contours of the glyphs as path commands, moved right by `dx` and turned to y down. One path per glyph.
struct Contours {
    done: Vec<Vec<DrawCmd>>,
    current: Vec<DrawCmd>,
    last: (f32, f32),
    open: bool,
    dx: f32,
}

impl Contours {
    fn at(&self, x: f32, y: f32) -> (f32, f32) {
        (x + self.dx, -y)
    }

    /// Closes a contour the font left open.
    fn seal(&mut self) {
        if self.open {
            self.current.push(DrawCmd::Z);
            self.open = false;
        }
    }

    /// Ends the glyph: its commands become one path.
    fn finish(&mut self) {
        self.seal();
        if self.current.len() > 1 {
            self.done.push(std::mem::take(&mut self.current));
        } else {
            self.current.clear();
        }
    }
}

impl OutlinePen for Contours {
    fn move_to(&mut self, x: f32, y: f32) {
        self.seal();
        let (x, y) = self.at(x, y);
        self.current.push(DrawCmd::M(x, y));
        self.last = (x, y);
        self.open = true;
    }

    fn line_to(&mut self, x: f32, y: f32) {
        let (x, y) = self.at(x, y);
        self.current.push(DrawCmd::L(x, y));
        self.last = (x, y);
    }

    fn quad_to(&mut self, cx0: f32, cy0: f32, x: f32, y: f32) {
        // A quadratic with control point c is the cubic with controls p0 + 2/3 (c - p0) and p1 + 2/3 (c - p1): the same curve.
        let (p0, c, p1) = (self.last, self.at(cx0, cy0), self.at(x, y));
        let third = 2.0 / 3.0;
        self.current.push(DrawCmd::C(
            p0.0 + third * (c.0 - p0.0),
            p0.1 + third * (c.1 - p0.1),
            p1.0 + third * (c.0 - p1.0),
            p1.1 + third * (c.1 - p1.1),
            p1.0,
            p1.1,
        ));
        self.last = p1;
    }

    fn curve_to(&mut self, cx0: f32, cy0: f32, cx1: f32, cy1: f32, x: f32, y: f32) {
        let (c0, c1, p1) = (self.at(cx0, cy0), self.at(cx1, cy1), self.at(x, y));
        self.current
            .push(DrawCmd::C(c0.0, c0.1, c1.0, c1.1, p1.0, p1.1));
        self.last = p1;
    }

    fn close(&mut self) {
        self.seal();
    }
}

fn font_failed(detail: impl std::fmt::Display) -> AppError {
    AppError::logged(ErrorCode::Internal, format!("signature font: {detail}"))
}

/// The art of `text` in `font`. `invalid_argument`: `text` (empty, over [`MAX_CHARS`] characters, a control character, or
/// nothing visible in it) or `glyph` (the font has no glyph for a character).
pub fn outlines(text: &str, font: TypedFont) -> Result<Art, AppError> {
    let count = text.chars().count();
    if count == 0 || count > MAX_CHARS || text.chars().any(char::is_control) {
        return Err(AppError::invalid("text"));
    }
    let font = FontRef::new(font.bytes()).map_err(font_failed)?;
    let charmap = font.charmap();
    let glyphs = font.outline_glyphs();
    let metrics = font.glyph_metrics(Size::unscaled(), LocationRef::new(&[]));
    let mut pen = Contours {
        done: Vec::new(),
        current: Vec::new(),
        last: (0.0, 0.0),
        open: false,
        dx: 0.0,
    };
    for c in text.chars() {
        let id = charmap.map(c).ok_or_else(|| AppError::invalid("glyph"))?;
        if let Some(outline) = glyphs.get(id) {
            let settings = DrawSettings::unhinted(Size::unscaled(), LocationRef::new(&[]));
            outline.draw(settings, &mut pen).map_err(font_failed)?;
            pen.finish();
        }
        pen.dx += metrics.advance_width(id).unwrap_or(0.0);
    }
    if pen.done.is_empty() {
        return Err(AppError::invalid("text"));
    }
    vector::normalize_trusted(&pen.done)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn code<T>(result: Result<T, AppError>) -> ErrorCode {
        result
            .err()
            .map(|e| e.code())
            .unwrap_or(ErrorCode::Internal)
    }

    const D: TypedFont = TypedFont::DancingScript;

    #[test]
    fn every_font_has_outlines_with_curves() {
        for font in TypedFont::ALL {
            let Art::Vector { paths, .. } = outlines("Ada Lovelace", font).unwrap() else {
                panic!("not vector")
            };
            assert!(!paths.is_empty(), "{font:?}");
            assert!(
                paths.iter().flatten().any(|c| matches!(c, DrawCmd::C(..))),
                "{font:?} has curves"
            );
        }
    }

    #[test]
    fn a_name_has_outlines() {
        let Art::Vector { w, h, paths } =
            outlines("Ada Lovelace", TypedFont::DancingScript).unwrap()
        else {
            panic!("not vector")
        };
        assert_eq!(h, vector::UNIT_HEIGHT);
        assert!(w > h, "a name is wider than tall: {w}");
        assert!(paths.len() >= 5);
        let commands: Vec<&DrawCmd> = paths.iter().flatten().collect();
        let curves = commands
            .iter()
            .filter(|c| matches!(c, DrawCmd::C(..)))
            .count();
        let lines = commands
            .iter()
            .filter(|c| matches!(c, DrawCmd::L(..)))
            .count();
        assert!(
            curves > lines,
            "glyphs are curves, not polylines: {curves} curves, {lines} lines"
        );
        assert!(paths
            .iter()
            .all(|p| matches!(p.first(), Some(DrawCmd::M(..))) && p.last() == Some(&DrawCmd::Z)));
        assert!(commands
            .iter()
            .flat_map(|c| c.points())
            .all(|(x, y)| (-vector::MARGIN..=w + vector::MARGIN).contains(&x)
                && (-vector::MARGIN..=h + vector::MARGIN).contains(&y)));
    }

    #[test]
    fn bad_text_is_refused() {
        assert_eq!(code(outlines("", D)), ErrorCode::InvalidArgument);
        assert_eq!(code(outlines("   ", D)), ErrorCode::InvalidArgument);
        assert_eq!(code(outlines("a\nb", D)), ErrorCode::InvalidArgument);
        assert_eq!(
            code(outlines(&"a".repeat(MAX_CHARS + 1), D)),
            ErrorCode::InvalidArgument
        );
        assert!(outlines(&"Hy".repeat(MAX_CHARS / 2), D).is_ok());
        // No glyph for a character outside the font's coverage.
        assert_eq!(code(outlines("\u{4E2D}", D)), ErrorCode::InvalidArgument);
    }
}
