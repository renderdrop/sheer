//! The bundled substitute fonts (ADR-125 §3): 12 faces of Arimo, Tinos and Cousine, picked by the original font's flags, weight and
//! name, subset with `subsetter` and written as Type0/Identity-H, one font object per (face, document save), glyphs unioned.
//!
//! The faces are the ChromeOS core fonts 1.31.0 (Apache-2.0, `resources/fonts/`, `docs/LICENSES.md`). System fonts are never read.

use std::collections::{BTreeSet, HashMap};

use skrifa::instance::{LocationRef, Size};
use skrifa::outline::{DrawSettings, OutlinePen};
use skrifa::raw::TableProvider;
use skrifa::{FontRef, GlyphId, MetadataProvider};
use subsetter::GlyphRemapper;

use crate::error::AppError;
use crate::limits::FONT_GLYPHS_MAX;
use crate::model::text_edit::FallbackFace;

/// One of the 12 bundled faces.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Face {
    pub family: FallbackFace,
    pub bold: bool,
    pub italic: bool,
}

/// `/FontDescriptor` flag bits: FixedPitch, Serif, Italic, ForceBold.
const FLAG_FIXED: u32 = 1;
const FLAG_SERIF: u32 = 1 << 1;
const FLAG_ITALIC: u32 = 1 << 6;
const FLAG_FORCE_BOLD: u32 = 1 << 18;

/// Picks the face closest to a font with these `/FontDescriptor` flags, weight (`/FontWeight` or 400) and name.
pub fn pick(flags: u32, weight: u32, name: &str) -> Face {
    let name = name.to_ascii_lowercase();
    let has = |words: &[&str]| words.iter().any(|w| name.contains(w));
    let family = if has(&[
        "courier",
        "mono",
        "consolas",
        "cousine",
        "typewriter",
        "menlo",
        "lucida console",
    ]) || (flags & FLAG_FIXED != 0 && !has(&["sans", "arial", "helvetica"]))
    {
        FallbackFace::Mono
    } else if has(&[
        "sans",
        "arial",
        "helvetica",
        "arimo",
        "calibri",
        "verdana",
        "tahoma",
        "segoe",
        "gothic",
    ]) {
        FallbackFace::Sans
    } else if has(&[
        "times",
        "serif",
        "tinos",
        "georgia",
        "garamond",
        "palatino",
        "minion",
        "cambria",
        "bookman",
        "century",
        "roman",
        "caslon",
        "baskerville",
    ]) || flags & FLAG_SERIF != 0
    {
        FallbackFace::Serif
    } else {
        FallbackFace::Sans
    };
    let bold = weight >= 700
        || flags & FLAG_FORCE_BOLD != 0
        || has(&["bold", "black", "heavy", "semibold", "demi"]);
    let italic = flags & FLAG_ITALIC != 0 || has(&["italic", "oblique"]);
    Face {
        family,
        bold,
        italic,
    }
}

impl Face {
    /// The `BaseFont` name without a subset tag.
    pub fn base_font(self) -> &'static str {
        match (self.family, self.bold, self.italic) {
            (FallbackFace::Sans, false, false) => "Arimo-Regular",
            (FallbackFace::Sans, true, false) => "Arimo-Bold",
            (FallbackFace::Sans, false, true) => "Arimo-Italic",
            (FallbackFace::Sans, true, true) => "Arimo-BoldItalic",
            (FallbackFace::Serif, false, false) => "Tinos-Regular",
            (FallbackFace::Serif, true, false) => "Tinos-Bold",
            (FallbackFace::Serif, false, true) => "Tinos-Italic",
            (FallbackFace::Serif, true, true) => "Tinos-BoldItalic",
            (FallbackFace::Mono, false, false) => "Cousine-Regular",
            (FallbackFace::Mono, true, false) => "Cousine-Bold",
            (FallbackFace::Mono, false, true) => "Cousine-Italic",
            (FallbackFace::Mono, true, true) => "Cousine-BoldItalic",
        }
    }

    /// The bundled TrueType file of this face.
    pub fn data(self) -> &'static [u8] {
        match (self.family, self.bold, self.italic) {
            (FallbackFace::Sans, false, false) => {
                include_bytes!("../../resources/fonts/Arimo-Regular.ttf")
            }
            (FallbackFace::Sans, true, false) => {
                include_bytes!("../../resources/fonts/Arimo-Bold.ttf")
            }
            (FallbackFace::Sans, false, true) => {
                include_bytes!("../../resources/fonts/Arimo-Italic.ttf")
            }
            (FallbackFace::Sans, true, true) => {
                include_bytes!("../../resources/fonts/Arimo-BoldItalic.ttf")
            }
            (FallbackFace::Serif, false, false) => {
                include_bytes!("../../resources/fonts/Tinos-Regular.ttf")
            }
            (FallbackFace::Serif, true, false) => {
                include_bytes!("../../resources/fonts/Tinos-Bold.ttf")
            }
            (FallbackFace::Serif, false, true) => {
                include_bytes!("../../resources/fonts/Tinos-Italic.ttf")
            }
            (FallbackFace::Serif, true, true) => {
                include_bytes!("../../resources/fonts/Tinos-BoldItalic.ttf")
            }
            (FallbackFace::Mono, false, false) => {
                include_bytes!("../../resources/fonts/Cousine-Regular.ttf")
            }
            (FallbackFace::Mono, true, false) => {
                include_bytes!("../../resources/fonts/Cousine-Bold.ttf")
            }
            (FallbackFace::Mono, false, true) => {
                include_bytes!("../../resources/fonts/Cousine-Italic.ttf")
            }
            (FallbackFace::Mono, true, true) => {
                include_bytes!("../../resources/fonts/Cousine-BoldItalic.ttf")
            }
        }
    }

    /// All 12 faces.
    pub fn all() -> impl Iterator<Item = Face> {
        [FallbackFace::Sans, FallbackFace::Serif, FallbackFace::Mono]
            .into_iter()
            .flat_map(|family| {
                [(false, false), (true, false), (false, true), (true, true)]
                    .into_iter()
                    .map(move |(bold, italic)| Face {
                        family,
                        bold,
                        italic,
                    })
            })
    }

    /// Whether the face has a glyph for `c` (cmap, gid ≠ 0; a blank character such as a space needs no outline).
    pub fn has_char(self, c: char) -> bool {
        FontRef::new(self.data())
            .ok()
            .and_then(|f| f.charmap().map(c))
            .is_some_and(|g| g.to_u32() != 0)
    }

    /// The advance width of `c` in 1/1000 em.
    pub fn advance(self, c: char) -> Option<f32> {
        let font = FontRef::new(self.data()).ok()?;
        let gid = font.charmap().map(c)?;
        let upem = f32::from(font.head().ok()?.units_per_em());
        let w = font
            .glyph_metrics(Size::unscaled(), LocationRef::default())
            .advance_width(gid)?;
        Some(w * 1000.0 / upem)
    }

    /// Descriptor numbers in 1/1000 em: `[xmin, ymin, xmax, ymax]`, ascent, descent, cap height, italic angle.
    pub fn descriptor(self) -> Option<Descriptor> {
        let font = FontRef::new(self.data()).ok()?;
        let m = font.metrics(Size::unscaled(), LocationRef::default());
        let k = 1000.0 / f32::from(m.units_per_em.max(1));
        let b = m.bounds?;
        Some(Descriptor {
            bbox: [b.x_min * k, b.y_min * k, b.x_max * k, b.y_max * k],
            ascent: m.ascent * k,
            descent: m.descent * k,
            cap_height: m.cap_height.map_or(m.ascent * k * 0.7, |c| c * k),
            italic_angle: m.italic_angle,
        })
    }
}

/// The numbers of a `/FontDescriptor` of a bundled face.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Descriptor {
    pub bbox: [f32; 4],
    pub ascent: f32,
    pub descent: f32,
    pub cap_height: f32,
    pub italic_angle: f32,
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

#[derive(Default)]
struct Strokes(u32);

impl OutlinePen for Strokes {
    fn move_to(&mut self, _x: f32, _y: f32) {}
    fn line_to(&mut self, _x: f32, _y: f32) {
        self.0 += 1;
    }
    fn quad_to(&mut self, _cx0: f32, _cy0: f32, _x: f32, _y: f32) {
        self.0 += 1;
    }
    fn curve_to(&mut self, _cx0: f32, _cy0: f32, _cx1: f32, _cy1: f32, _x: f32, _y: f32) {
        self.0 += 1;
    }
    fn close(&mut self) {}
}

fn is_blank(c: char) -> bool {
    c.is_whitespace() || c == '\u{200B}'
}

impl FallbackStore {
    /// Notes that `text` is drawn in `face`.
    pub fn add(&mut self, face: Face, text: &str) {
        self.chars.entry(face).or_default().extend(text.chars());
    }

    /// Builds the subset of `face`, re-parses it with `skrifa` before it is returned. `invalid_argument` for a character the face
    /// does not have.
    pub fn subset(&self, face: Face) -> Result<Subset, AppError> {
        let data = face.data();
        let font = FontRef::new(data).map_err(|_| AppError::invalid("fontProgram"))?;
        let upem = f32::from(
            font.head()
                .map_err(|_| AppError::invalid("fontProgram"))?
                .units_per_em()
                .max(1),
        );
        let empty = BTreeSet::new();
        let chars = self.chars.get(&face).unwrap_or(&empty);
        if chars.len() >= FONT_GLYPHS_MAX {
            return Err(AppError::limit("fontGlyphs", FONT_GLYPHS_MAX as u64));
        }
        let charmap = font.charmap();
        let metrics = font.glyph_metrics(Size::unscaled(), LocationRef::default());
        let mut remapper = GlyphRemapper::new();
        remapper.remap(0);
        let mut old: Vec<(char, u16)> = Vec::with_capacity(chars.len());
        for &c in chars {
            let gid = charmap
                .map(c)
                .filter(|g| g.to_u32() != 0)
                .and_then(|g| u16::try_from(g.to_u32()).ok())
                .ok_or(AppError::invalid("textEdit"))?;
            old.push((c, gid));
        }
        let mut gids = Vec::with_capacity(old.len());
        let mut widths = Vec::with_capacity(old.len());
        for (c, gid) in &old {
            let new = remapper.remap(*gid);
            gids.push((*c, new));
            let w = metrics
                .advance_width(GlyphId::new(u32::from(*gid)))
                .unwrap_or(0.0)
                * 1000.0
                / upem;
            widths.push((new, w));
        }
        let program =
            subsetter::subset(data, 0, &remapper).map_err(|_| AppError::invalid("fontProgram"))?;
        // The subset is read back before it is written into a PDF: at least the mapped glyphs (composites add components) and one outline per drawn character.
        let check = FontRef::new(&program).map_err(|_| AppError::invalid("fontProgram"))?;
        let count = check
            .maxp()
            .map_err(|_| AppError::invalid("fontProgram"))?
            .num_glyphs();
        if u32::from(count) < u32::from(remapper.num_gids()) {
            return Err(AppError::invalid("fontProgram"));
        }
        let outlines = check.outline_glyphs();
        for (c, new) in &gids {
            if is_blank(*c) {
                continue;
            }
            let mut pen = Strokes::default();
            let ok = outlines
                .get(GlyphId::new(u32::from(*new)))
                .is_some_and(|o| {
                    o.draw(
                        DrawSettings::unhinted(Size::unscaled(), LocationRef::default()),
                        &mut pen,
                    )
                    .is_ok()
                });
            if !ok || pen.0 == 0 {
                return Err(AppError::invalid("fontProgram"));
            }
        }
        Ok(Subset {
            program,
            gids,
            widths,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn face(family: FallbackFace, bold: bool, italic: bool) -> Face {
        Face {
            family,
            bold,
            italic,
        }
    }

    #[test]
    fn pick_by_flags_weight_and_name() {
        assert_eq!(
            pick(32, 400, "ABCDEF+Calibri"),
            face(FallbackFace::Sans, false, false)
        );
        assert_eq!(
            pick(34, 400, "TimesNewRomanPSMT"),
            face(FallbackFace::Serif, false, false)
        );
        assert_eq!(
            pick(1 | 32, 400, "CourierNewPSMT"),
            face(FallbackFace::Mono, false, false)
        );
        assert_eq!(
            pick(32, 700, "Arial-BoldMT"),
            face(FallbackFace::Sans, true, false)
        );
        assert_eq!(
            pick(34 | 64, 400, "Georgia-Italic"),
            face(FallbackFace::Serif, false, true)
        );
        assert_eq!(
            pick(32 | (1 << 18), 400, "X"),
            face(FallbackFace::Sans, true, false)
        );
        assert_eq!(pick(2, 400, "Foo"), face(FallbackFace::Serif, false, false));
        assert_eq!(
            pick(2, 400, "NotoSansSerif-Regular"),
            face(FallbackFace::Sans, false, false)
        );
        assert_eq!(pick(0, 400, ""), face(FallbackFace::Sans, false, false));
        assert_eq!(
            pick(0, 400, "Helvetica-BoldOblique"),
            face(FallbackFace::Sans, true, true)
        );
    }

    #[test]
    fn all_twelve_faces_parse_and_cover_german_text() {
        assert_eq!(Face::all().count(), 12);
        for f in Face::all() {
            let font = FontRef::new(f.data()).unwrap_or_else(|_| panic!("{f:?}"));
            assert!(
                font.charmap().map('ä').is_some_and(|g| g.to_u32() != 0),
                "{f:?}"
            );
            assert!(f.has_char('€'), "{f:?}");
            assert!(!f.has_char('中'), "{f:?}");
            assert!(f.descriptor().is_some(), "{f:?}");
        }
    }

    #[test]
    fn subset_unions_characters_and_reparses() {
        let f = face(FallbackFace::Serif, false, true);
        let mut store = FallbackStore::default();
        store.add(f, "Hallo Welt");
        store.add(f, "Größe €");
        let s = store.subset(f).unwrap();
        let distinct: BTreeSet<char> = "Hallo WeltGröße €".chars().collect();
        assert_eq!(s.gids.len(), distinct.len());
        assert!(
            s.program.len() < 60_000,
            "subset is small: {}",
            s.program.len()
        );
        let sub = FontRef::new(&s.program).unwrap();
        assert!(sub.maxp().unwrap().num_glyphs() as usize > distinct.len());
        // new gids are 1.., widths follow the original advances
        for (c, gid) in &s.gids {
            assert!(*gid >= 1);
            let w = s.widths.iter().find(|(g, _)| g == gid).unwrap().1;
            assert!((w - f.advance(*c).unwrap()).abs() < 0.01, "{c}");
        }
        let space = s.gids.iter().find(|(c, _)| *c == ' ').unwrap().1;
        assert!((s.widths.iter().find(|(g, _)| *g == space).unwrap().1 - 250.0).abs() < 1.0);
    }

    #[test]
    fn a_missing_character_is_invalid_argument() {
        let f = face(FallbackFace::Sans, false, false);
        let mut store = FallbackStore::default();
        store.add(f, "a中");
        assert_eq!(
            store.subset(f).unwrap_err().code(),
            crate::error::ErrorCode::InvalidArgument
        );
    }

    #[test]
    fn empty_store_gives_notdef_only() {
        let f = face(FallbackFace::Mono, true, false);
        let s = FallbackStore::default().subset(f).unwrap();
        assert!(s.gids.is_empty());
    }
}
