//! Typed signatures (ADR-041 §6, ADR-042): a name laid out with the bundled Homemade Apple font (Apache-2.0, Font Diner; the file and
//! its license are in `resources/fonts/`) and turned into polygons with `skrifa`. This is the only module that uses `skrifa`.
//! The font is compiled in: no path to read at run time, no system fonts, no font in the PDF.

use skrifa::instance::{LocationRef, Size};
use skrifa::outline::{DrawSettings, OutlinePen};
use skrifa::{FontRef, MetadataProvider};

use super::{vector, Art};
use crate::error::{AppError, ErrorCode};
use crate::model::geometry::Point;

const FONT: &[u8] = include_bytes!("../../resources/fonts/HomemadeApple-Regular.ttf");
/// Characters of a typed signature.
pub const MAX_CHARS: usize = 64;
/// Straight segments per curve: at the size the art is normalized to, a curve of a glyph is flat to well under a unit.
const CURVE_STEPS: u32 = 12;

/// Collects the contours of a glyph as polygons, moved right by `dx` and turned to y down.
struct Contours {
    done: Vec<Vec<Point>>,
    current: Vec<Point>,
    last: Point,
    dx: f32,
}

impl Contours {
    fn at(&self, x: f32, y: f32) -> Point {
        Point {
            x: x + self.dx,
            y: -y,
        }
    }

    fn finish(&mut self) {
        if self.current.len() >= 3 {
            self.done.push(std::mem::take(&mut self.current));
        } else {
            self.current.clear();
        }
    }

    fn push(&mut self, point: Point) {
        self.current.push(point);
        self.last = point;
    }
}

fn lerp(a: f32, b: f32, t: f32) -> f32 {
    a + (b - a) * t
}

impl OutlinePen for Contours {
    fn move_to(&mut self, x: f32, y: f32) {
        self.finish();
        let point = self.at(x, y);
        self.push(point);
    }

    fn line_to(&mut self, x: f32, y: f32) {
        let point = self.at(x, y);
        self.push(point);
    }

    fn quad_to(&mut self, cx0: f32, cy0: f32, x: f32, y: f32) {
        let (p0, c, p1) = (self.last, self.at(cx0, cy0), self.at(x, y));
        for step in 1..=CURVE_STEPS {
            let t = step as f32 / CURVE_STEPS as f32;
            let (ax, ay) = (lerp(p0.x, c.x, t), lerp(p0.y, c.y, t));
            let (bx, by) = (lerp(c.x, p1.x, t), lerp(c.y, p1.y, t));
            self.push(Point {
                x: lerp(ax, bx, t),
                y: lerp(ay, by, t),
            });
        }
    }

    fn curve_to(&mut self, cx0: f32, cy0: f32, cx1: f32, cy1: f32, x: f32, y: f32) {
        let (p0, c0, c1, p1) = (
            self.last,
            self.at(cx0, cy0),
            self.at(cx1, cy1),
            self.at(x, y),
        );
        for step in 1..=CURVE_STEPS {
            let t = step as f32 / CURVE_STEPS as f32;
            let mid = |a: Point, b: Point| (lerp(a.x, b.x, t), lerp(a.y, b.y, t));
            let (ax, ay) = mid(p0, c0);
            let (bx, by) = mid(c0, c1);
            let (cx, cy) = mid(c1, p1);
            let (dx, dy) = (lerp(ax, bx, t), lerp(ay, by, t));
            let (ex, ey) = (lerp(bx, cx, t), lerp(by, cy, t));
            self.push(Point {
                x: lerp(dx, ex, t),
                y: lerp(dy, ey, t),
            });
        }
    }

    fn close(&mut self) {
        self.finish();
    }
}

fn font_failed(detail: impl std::fmt::Display) -> AppError {
    AppError::logged(ErrorCode::Internal, format!("signature font: {detail}"))
}

/// The art of `text` in Homemade Apple. `invalid_argument`: `text` (empty, over [`MAX_CHARS`] characters, a control character, or
/// nothing visible in it) or `glyph` (the font has no glyph for a character).
pub fn outlines(text: &str) -> Result<Art, AppError> {
    let count = text.chars().count();
    if count == 0 || count > MAX_CHARS || text.chars().any(char::is_control) {
        return Err(AppError::invalid("text"));
    }
    let font = FontRef::new(FONT).map_err(font_failed)?;
    let charmap = font.charmap();
    let glyphs = font.outline_glyphs();
    let metrics = font.glyph_metrics(Size::unscaled(), LocationRef::new(&[]));
    let mut pen = Contours {
        done: Vec::new(),
        current: Vec::new(),
        last: Point { x: 0.0, y: 0.0 },
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

    #[test]
    fn a_name_has_outlines() {
        let Art::Vector { w, h, paths } = outlines("Ada Lovelace").unwrap() else {
            panic!("not vector")
        };
        assert_eq!(h, vector::UNIT_HEIGHT);
        assert!(w > h, "a name is wider than tall: {w}");
        assert!(paths.len() >= 5);
        assert!(paths
            .iter()
            .flatten()
            .all(|p| p.x >= 0.0 && p.x <= w && p.y >= 0.0 && p.y <= h));
    }

    #[test]
    fn bad_text_is_refused() {
        assert_eq!(code(outlines("")), ErrorCode::InvalidArgument);
        assert_eq!(code(outlines("   ")), ErrorCode::InvalidArgument);
        assert_eq!(code(outlines("a\nb")), ErrorCode::InvalidArgument);
        assert_eq!(
            code(outlines(&"a".repeat(MAX_CHARS + 1))),
            ErrorCode::InvalidArgument
        );
        assert!(outlines(&"Hy".repeat(MAX_CHARS / 2)).is_ok());
        // No glyph for a character outside the font's coverage.
        assert_eq!(code(outlines("\u{4E2D}")), ErrorCode::InvalidArgument);
    }
}
