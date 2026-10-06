//! Which glyphs a font program has (ARCHITECTURE §13.3): TrueType `cmap` (3,0)/(1,0)/(3,1), CFF charset, `numGlyphs` and non-empty outlines.
//!
//! Everything is read by `skrifa`/`read-fonts` (safe, bounds-checked) or by the bounded Type1 scan; no glyph is rasterised or hinted.

use std::collections::{HashMap, HashSet};

use skrifa::instance::{LocationRef, Size};
use skrifa::outline::{DrawSettings, OutlinePen};
use skrifa::raw::ps::cff::CffFontRef;
use skrifa::raw::tables::cmap::PlatformId;
use skrifa::raw::TableProvider;
use skrifa::{FontRef, GlyphId, MetadataProvider};

use super::{type1, ProgramKind};
use crate::error::AppError;
use crate::limits::{FONT_GLYPHS_MAX, FONT_PROGRAM_MAX};

/// Entries read from one `cmap` subtable at most (hostile subtables list millions of ranges).
const CMAP_ENTRIES_MAX: usize = 4 * FONT_GLYPHS_MAX;

/// What was read from one font program. Outlines are never rasterised; only their presence is noted.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct GlyphTable {
    pub num_glyphs: u32,
    /// Glyph names present (CFF charset, Type1 `/CharStrings`); empty for TrueType without `post` names.
    pub names: HashSet<String>,
    /// Character code to glyph id over the program's `cmap` subtables, gid 0 is never listed. The Unicode subtables ((3,1), (3,10),
    /// platform 0) win over (3,0) and (1,0) where a code is in several.
    pub cmap: HashMap<u32, u32>,
    /// The Unicode subtables alone.
    pub cmap_unicode: HashMap<u32, u32>,
    /// The Windows symbol subtable (3,0); its codes are usually `0xF000 + code`.
    pub cmap_symbol: HashMap<u32, u32>,
    /// The Macintosh Roman subtable (1,0).
    pub cmap_mac: HashMap<u32, u32>,
    /// Glyph ids whose outline is non-empty.
    pub drawn: HashSet<u32>,
    /// Advance widths in 1/1000 em by glyph id (empty when the program has none).
    pub advances: HashMap<u32, f32>,
    /// The built-in encoding of a CFF or Type1 program: code to glyph name (empty for StandardEncoding or none).
    pub builtin_encoding: HashMap<u32, String>,
    /// CID-keyed CFF: CID to glyph id by the charset (empty otherwise).
    pub cid_to_gid: HashMap<u32, u32>,
    /// Glyph names by glyph id (CFF, Type1), for `names` lookups that need the gid.
    pub gid_of_name: HashMap<String, u32>,
}

impl GlyphTable {
    /// The glyph has an outline, or is a blank glyph such as a space (`allow_blank`).
    pub fn has_glyph(&self, gid: u32, allow_blank: bool) -> bool {
        gid < self.num_glyphs && (allow_blank || self.drawn.contains(&gid))
    }
}

/// Counts the drawing commands of one glyph.
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

fn bad() -> AppError {
    AppError::invalid("fontProgram")
}

/// Reads the glyph table of `data` with `skrifa` (TrueType, CFF, OpenType-CFF) or the Type1 scan. `limit_exceeded` over
/// `limits::FONT_PROGRAM_MAX` or `limits::FONT_GLYPHS_MAX`; `invalid_argument` for a program that does not parse.
pub fn read(kind: ProgramKind, data: &[u8]) -> Result<GlyphTable, AppError> {
    if data.len() > FONT_PROGRAM_MAX {
        return Err(AppError::limit("fontProgram", FONT_PROGRAM_MAX as u64));
    }
    match kind {
        ProgramKind::TrueType | ProgramKind::OpenTypeCff => read_sfnt(data),
        ProgramKind::Cff => read_cff(data),
        ProgramKind::Type1 => read_type1(data),
    }
}

fn read_type1(data: &[u8]) -> Result<GlyphTable, AppError> {
    let info = type1::scan(data)?;
    let mut table = GlyphTable {
        num_glyphs: u32::try_from(info.char_strings.len()).map_err(|_| bad())?,
        ..GlyphTable::default()
    };
    for (gid, (name, bytes)) in (0u32..).zip(&info.char_strings) {
        table.names.insert(name.clone());
        table.gid_of_name.insert(name.clone(), gid);
        if *bytes > 0 {
            table.drawn.insert(gid);
        }
    }
    for (code, name) in info.encoding {
        table.builtin_encoding.insert(u32::from(code), name);
    }
    Ok(table)
}

/// A Type2 charstring that draws: some move, line, curve or subroutine call (a width and `endchar` alone do not).
fn cff_draws(cs: &[u8]) -> bool {
    let mut i = 0;
    while i < cs.len() {
        match cs[i] {
            // moves, lines, curves, callsubr, callgsubr
            4..=8 | 10 | 21..=27 | 29..=31 => return true,
            // hintmask and cntrmask are followed by mask bytes of a length that needs the stack; such a glyph is not blank
            19 | 20 => return true,
            12 => i += 2,
            28 => i += 3,
            255 => i += 5,
            247..=254 => i += 2,
            _ => i += 1,
        }
    }
    false
}

fn cff_tables(cff: &CffFontRef, table: &mut GlyphTable) {
    let count = cff.charstrings().count();
    let charstrings = cff.charstrings();
    for gid in 0..count {
        if charstrings.get(gid as usize).is_some_and(cff_draws) {
            table.drawn.insert(gid);
        }
    }
    let Some(charset) = cff.charset() else {
        return;
    };
    let cid = cff.is_cid();
    for (gid, sid) in charset.iter().take(FONT_GLYPHS_MAX) {
        let gid = gid.to_u32();
        if cid {
            table.cid_to_gid.insert(u32::from(sid.to_u16()), gid);
        } else if let Some(name) = cff.string(sid) {
            if name.len() <= 128 && name.is_ascii() {
                let name = String::from_utf8_lossy(name).into_owned();
                table.gid_of_name.insert(name.clone(), gid);
                table.names.insert(name);
            }
        }
    }
    if !cid {
        if let Some(encoding) = cff.encoding() {
            for code in 0u32..=255 {
                let Some(gid) = encoding.map(code as u8) else {
                    continue;
                };
                let Some(sid) = charset.string_id(gid) else {
                    continue;
                };
                if let Some(name) = cff.string(sid) {
                    if name != b".notdef" && name.is_ascii() {
                        table
                            .builtin_encoding
                            .insert(code, String::from_utf8_lossy(name).into_owned());
                    }
                }
            }
        }
    }
}

fn read_cff(data: &[u8]) -> Result<GlyphTable, AppError> {
    let cff = CffFontRef::new(data, 0, None).map_err(|_| bad())?;
    let num = cff.num_glyphs();
    if num as usize > FONT_GLYPHS_MAX {
        return Err(AppError::limit("fontGlyphs", FONT_GLYPHS_MAX as u64));
    }
    let mut table = GlyphTable {
        num_glyphs: num,
        ..GlyphTable::default()
    };
    cff_tables(&cff, &mut table);
    Ok(table)
}

fn read_sfnt(data: &[u8]) -> Result<GlyphTable, AppError> {
    let font = FontRef::new(data).map_err(|_| bad())?;
    let num = font.maxp().map_err(|_| bad())?.num_glyphs();
    let num = u32::from(num);
    if num as usize > FONT_GLYPHS_MAX {
        return Err(AppError::limit("fontGlyphs", FONT_GLYPHS_MAX as u64));
    }
    let mut table = GlyphTable {
        num_glyphs: num,
        ..GlyphTable::default()
    };
    // cmap subtables, one by one
    if let Ok(cmap) = font.cmap() {
        let offset = cmap.offset_data();
        for record in cmap.encoding_records().iter().take(64) {
            let Ok(sub) = record.subtable(offset) else {
                continue;
            };
            let (platform, encoding) = (record.platform_id(), record.encoding_id());
            let target = match (platform, encoding) {
                (PlatformId::Windows, 0) => &mut table.cmap_symbol,
                (PlatformId::Macintosh, 0) => &mut table.cmap_mac,
                (PlatformId::Windows, 1 | 10) | (PlatformId::Unicode, _) => &mut table.cmap_unicode,
                _ => continue,
            };
            for (code, gid) in sub.iter().take(CMAP_ENTRIES_MAX) {
                let gid = gid.to_u32();
                if gid != 0 && gid < num {
                    target.entry(code).or_insert(gid);
                }
            }
        }
    }
    for map in [&table.cmap_mac, &table.cmap_symbol, &table.cmap_unicode] {
        for (code, gid) in map {
            table.cmap.insert(*code, *gid);
        }
    }
    // outlines and advances
    let upem = font
        .head()
        .map(|h| f32::from(h.units_per_em()))
        .ok()
        .filter(|u| *u > 0.0);
    let outlines = font.outline_glyphs();
    let metrics = font.glyph_metrics(Size::unscaled(), LocationRef::default());
    for gid in 0..num {
        let id = GlyphId::new(gid);
        if let Some(outline) = outlines.get(id) {
            let mut pen = Strokes::default();
            let settings = DrawSettings::unhinted(Size::unscaled(), LocationRef::default());
            if outline.draw(settings, &mut pen).is_ok() && pen.0 > 0 {
                table.drawn.insert(gid);
            }
        }
        if let (Some(upem), Some(w)) = (upem, metrics.advance_width(id)) {
            table.advances.insert(gid, w * 1000.0 / upem);
        }
    }
    // OpenType-CFF: charset names and the built-in encoding
    if let Some(cff_data) = font.table_data(skrifa::raw::types::Tag::new(b"CFF ")) {
        if let Ok(cff) = CffFontRef::new(cff_data.as_bytes(), 0, None) {
            let mut named = GlyphTable::default();
            cff_tables(&cff, &mut named);
            table.names = named.names;
            table.gid_of_name = named.gid_of_name;
            table.cid_to_gid = named.cid_to_gid;
            table.builtin_encoding = named.builtin_encoding;
        }
    }
    Ok(table)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorCode;

    const ARIMO: &[u8] = include_bytes!("../../resources/fonts/Arimo-Regular.ttf");

    fn gid_of(c: char) -> u32 {
        FontRef::new(ARIMO)
            .unwrap()
            .charmap()
            .map(c)
            .unwrap()
            .to_u32()
    }

    #[test]
    fn truetype_cmap_outlines_and_advances() {
        let t = read(ProgramKind::TrueType, ARIMO).unwrap();
        assert!(t.num_glyphs > 1000);
        let a = gid_of('A');
        assert_eq!(t.cmap_unicode.get(&0x41), Some(&a));
        assert_eq!(t.cmap.get(&0x41), Some(&a));
        assert!(t.drawn.contains(&a));
        assert!(!t.drawn.contains(&gid_of(' ')), "space has no outline");
        assert!(t.has_glyph(gid_of(' '), true));
        assert!(!t.has_glyph(gid_of(' '), false));
        assert!(!t.cmap.values().any(|g| *g == 0));
        let w = t.advances[&a];
        assert!((w - 667.0).abs() < 1.5, "Arimo A is Helvetica wide: {w}");
    }

    #[test]
    fn a_glyph_the_cmap_lacks_is_absent() {
        let t = read(ProgramKind::TrueType, ARIMO).unwrap();
        assert!(!t.cmap_unicode.contains_key(&0x4E2D), "no CJK in Arimo");
        assert!(!t.cmap_unicode.contains_key(&0x1F600));
    }

    #[test]
    fn garbage_is_invalid_not_a_panic() {
        for kind in [
            ProgramKind::TrueType,
            ProgramKind::Cff,
            ProgramKind::OpenTypeCff,
            ProgramKind::Type1,
        ] {
            assert_eq!(
                read(kind, b"not a font at all").unwrap_err().code(),
                ErrorCode::InvalidArgument,
                "{kind:?}"
            );
            let _ = read(kind, &[]);
        }
    }

    #[test]
    fn oversized_program_is_limited() {
        let big = vec![0u8; FONT_PROGRAM_MAX + 1];
        assert_eq!(
            read(ProgramKind::TrueType, &big).unwrap_err().code(),
            ErrorCode::LimitExceeded
        );
    }

    #[test]
    fn truncated_and_flipped_tables_never_panic() {
        // The first 64 KiB hold the table directory and head, maxp, hhea; cut at many places.
        let head = &ARIMO[..65_536];
        for n in (0..head.len()).step_by(997) {
            let _ = read(ProgramKind::TrueType, &head[..n]);
        }
        // Flip bytes in the directory and the early tables.
        let mut seed = 0x9E37_79B9u32;
        for _ in 0..40 {
            let mut copy = ARIMO[..200_000].to_vec();
            for _ in 0..8 {
                seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                let at = (seed >> 8) as usize % 2048;
                copy[at] ^= 0xFF;
            }
            let _ = read(ProgramKind::TrueType, &copy);
        }
    }

    #[test]
    fn huge_glyph_count_in_maxp_is_survived() {
        let mut copy = ARIMO.to_vec();
        // Find the maxp table record and set numGlyphs to 0xFFFF.
        let num_tables = u16::from_be_bytes([copy[4], copy[5]]) as usize;
        for i in 0..num_tables {
            let rec = 12 + i * 16;
            if &copy[rec..rec + 4] == b"maxp" {
                let off = u32::from_be_bytes([
                    copy[rec + 8],
                    copy[rec + 9],
                    copy[rec + 10],
                    copy[rec + 11],
                ]) as usize;
                copy[off + 4] = 0xFF;
                copy[off + 5] = 0xFF;
            }
        }
        let t = read(ProgramKind::TrueType, &copy).unwrap();
        assert_eq!(t.num_glyphs, 65_535);
    }

    /// Every seed of `tests/fixtures/hostile/` and a few hundred byte flips of each go through the reader of its kind: any outcome
    /// but a panic or a hang is fine.
    #[test]
    fn hostile_seeds_never_panic() {
        use crate::fontprog::{cmap, type1};
        let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../tests/fixtures/hostile");
        let mut seen = 0;
        let mut seed = 0x1234_5678u32;
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            let data = std::fs::read(&path).unwrap();
            let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
            let run = |bytes: &[u8]| match ext {
                "bin" => {
                    for kind in [
                        ProgramKind::TrueType,
                        ProgramKind::OpenTypeCff,
                        ProgramKind::Cff,
                    ] {
                        let _ = read(kind, bytes);
                    }
                }
                "cmap" => {
                    let _ = cmap::parse(bytes);
                }
                _ => {
                    let _ = type1::scan(bytes);
                    let _ = read(ProgramKind::Type1, bytes);
                }
            };
            run(&data);
            for _ in 0..100 {
                let mut copy = data.clone();
                for _ in 0..4 {
                    seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                    let at = (seed >> 8) as usize % copy.len();
                    copy[at] = (seed >> 3) as u8;
                }
                run(&copy);
            }
            seen += 1;
        }
        assert!(seen >= 5, "seeds are committed: {seen}");
    }

    #[test]
    fn type1_table_comes_from_the_scan() {
        let t = read(ProgramKind::Type1, &type1::tests::sample(false)).unwrap();
        assert_eq!(t.num_glyphs, 3);
        assert!(t.names.contains("A"));
        let a = t.gid_of_name["A"];
        assert!(t.drawn.contains(&a));
        assert!(!t.drawn.contains(&t.gid_of_name["space"]));
        assert_eq!(t.builtin_encoding[&65], "A");
    }
}
