//! The glyphless font of the OCR layer (ADR-134 item 6): a TrueType program generated here (unitsPerEm 1000, advance 500, ascent 800,
//! descent -200), embedded as a Type0 `/Identity-H` font over a `CIDFontType2` whose `CIDToGIDMap` sends every CID to glyph 1, with a
//! `ToUnicode` that maps every code to itself. The text is drawn with `3 Tr`, so no glyph is ever painted; the box of a character is
//! what the font's metrics say, which is what makes a selection match the recognized word.

use lopdf::{dictionary, Dictionary, Document, Object, ObjectId, Stream};

use crate::error::{AppError, ErrorCode};

/// Units per em, advance and vertical metrics of the font (per 1000 em).
pub const UNITS_PER_EM: i16 = 1000;
pub const ADVANCE: i16 = 500;
pub const ASCENT: i16 = 800;
pub const DESCENT: i16 = -200;

fn u16be(out: &mut Vec<u8>, v: u16) {
    out.extend_from_slice(&v.to_be_bytes());
}
fn i16be(out: &mut Vec<u8>, v: i16) {
    out.extend_from_slice(&v.to_be_bytes());
}
fn u32be(out: &mut Vec<u8>, v: u32) {
    out.extend_from_slice(&v.to_be_bytes());
}

fn checksum(data: &[u8]) -> u32 {
    let mut sum = 0u32;
    for chunk in data.chunks(4) {
        let mut word = [0u8; 4];
        word[..chunk.len()].copy_from_slice(chunk);
        sum = sum.wrapping_add(u32::from_be_bytes(word));
    }
    sum
}

/// The TrueType program. Glyph 0 is empty; glyph 1 is empty, or (`boxed`) a rectangle over the whole em box, which gives a renderer
/// that takes character boxes from outlines the same box (it is never painted under `3 Tr`).
pub fn truetype(boxed: bool) -> Vec<u8> {
    let (x_max, y_min, y_max) = (ADVANCE, DESCENT, ASCENT);
    // glyf: one rectangle contour for glyph 1, nothing for glyph 0.
    let mut glyf = Vec::new();
    if boxed {
        i16be(&mut glyf, 1);
        for v in [0, y_min, x_max, y_max] {
            i16be(&mut glyf, v);
        }
        u16be(&mut glyf, 3); // endPtsOfContours
        u16be(&mut glyf, 0); // instructionLength
        glyf.extend_from_slice(&[1, 1, 1, 1]); // on-curve points, 16-bit deltas
        for dx in [0, 0, x_max, 0] {
            i16be(&mut glyf, dx);
        }
        for dy in [y_min, y_max - y_min, 0, y_min - y_max] {
            i16be(&mut glyf, dy);
        }
        while glyf.len() % 4 != 0 {
            glyf.push(0);
        }
    }
    let glyph_len = glyf.len() as u16;
    let mut loca = Vec::new();
    for offset in [0, 0, glyph_len] {
        u16be(&mut loca, offset / 2); // short format: half the offset
    }

    let mut head = Vec::new();
    u32be(&mut head, 0x0001_0000);
    u32be(&mut head, 0x0001_0000);
    u32be(&mut head, 0); // checkSumAdjustment, patched below
    u32be(&mut head, 0x5F0F_3CF5);
    u16be(&mut head, 3);
    u16be(&mut head, UNITS_PER_EM as u16);
    head.extend_from_slice(&[0; 16]); // created, modified
    for v in [0, y_min, x_max, y_max] {
        i16be(&mut head, if boxed { v } else { 0 });
    }
    u16be(&mut head, 0); // macStyle
    u16be(&mut head, 8); // lowestRecPPEM
    i16be(&mut head, 2); // fontDirectionHint
    i16be(&mut head, 0); // short loca
    i16be(&mut head, 0); // glyphDataFormat

    let mut hhea = Vec::new();
    u32be(&mut hhea, 0x0001_0000);
    i16be(&mut hhea, ASCENT);
    i16be(&mut hhea, DESCENT);
    i16be(&mut hhea, 0);
    u16be(&mut hhea, ADVANCE as u16);
    i16be(&mut hhea, 0);
    i16be(&mut hhea, 0);
    i16be(&mut hhea, ADVANCE);
    i16be(&mut hhea, 1);
    i16be(&mut hhea, 0);
    i16be(&mut hhea, 0);
    hhea.extend_from_slice(&[0; 8]);
    i16be(&mut hhea, 0);
    u16be(&mut hhea, 2);

    let mut maxp = Vec::new();
    u32be(&mut maxp, 0x0001_0000);
    u16be(&mut maxp, 2);
    for v in [4, 1, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0] {
        u16be(&mut maxp, v);
    }

    let mut hmtx = Vec::new();
    for _ in 0..2 {
        u16be(&mut hmtx, ADVANCE as u16);
        i16be(&mut hmtx, 0);
    }

    // cmap: one format 4 subtable with the single closing segment; the PDF maps codes itself (CIDToGIDMap).
    let mut cmap = Vec::new();
    u16be(&mut cmap, 0);
    u16be(&mut cmap, 1);
    u16be(&mut cmap, 3);
    u16be(&mut cmap, 1);
    u32be(&mut cmap, 12);
    for v in [4u16, 24, 0, 2, 2, 0, 0xFFFF, 0, 0xFFFF, 1, 0] {
        u16be(&mut cmap, v);
    }

    let mut post = Vec::new();
    u32be(&mut post, 0x0003_0000);
    post.extend_from_slice(&[0; 28]);

    let mut tables: Vec<(&[u8; 4], Vec<u8>)> = vec![
        (b"cmap", cmap),
        (b"glyf", glyf),
        (b"head", head),
        (b"hhea", hhea),
        (b"hmtx", hmtx),
        (b"loca", loca),
        (b"maxp", maxp),
        (b"post", post),
    ];
    let count = tables.len() as u16;
    let mut out = Vec::new();
    u32be(&mut out, 0x0001_0000);
    u16be(&mut out, count);
    u16be(&mut out, 128); // searchRange: 8 tables
    u16be(&mut out, 3);
    u16be(&mut out, count * 16 - 128);
    let mut offset = 12 + 16 * tables.len();
    let mut head_at = 0;
    for (tag, data) in &mut tables {
        out.extend_from_slice(*tag);
        u32be(&mut out, checksum(data));
        u32be(&mut out, offset as u32);
        u32be(&mut out, data.len() as u32);
        if *tag == b"head" {
            head_at = offset;
        }
        while data.len() % 4 != 0 {
            data.push(0);
        }
        offset += data.len();
    }
    for (_, data) in &tables {
        out.extend_from_slice(data);
    }
    let adjustment = 0xB1B0_AFBAu32.wrapping_sub(checksum(&out));
    out[head_at + 8..head_at + 12].copy_from_slice(&adjustment.to_be_bytes());
    out
}

fn deflate(data: &[u8]) -> Result<Vec<u8>, AppError> {
    use std::io::Write;
    let mut encoder = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
    encoder
        .write_all(data)
        .and_then(|()| encoder.finish())
        .map_err(|e| AppError::logged(ErrorCode::Internal, format!("deflate: {e}")))
}

/// `CIDToGIDMap`: 65536 entries of two bytes, each glyph 1.
pub fn cid_to_gid_map() -> Vec<u8> {
    [0u8, 1u8].repeat(65536)
}

/// The `ToUnicode` CMap: every two-byte code is its own Unicode value.
pub const TO_UNICODE: &str = "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n1 beginbfrange\n<0000> <FFFF> <0000>\nendbfrange\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n";

fn flate_stream(mut dict: Dictionary, data: &[u8]) -> Result<Stream, AppError> {
    dict.set("Filter", "FlateDecode");
    Ok(Stream::new(dict, deflate(data)?))
}

/// Adds the font's objects to `doc` and returns the Type0 font; call once per document.
pub fn add_font(doc: &mut Document, boxed: bool) -> Result<ObjectId, AppError> {
    let program = truetype(boxed);
    let length1 = program.len() as i64;
    let file = doc.add_object(flate_stream(
        dictionary! { "Length1" => length1 },
        &program,
    )?);
    let descriptor = doc.add_object(dictionary! {
        "Type" => "FontDescriptor",
        "FontName" => "SheerGlyphless",
        "Flags" => 5,
        "FontBBox" => vec![0.into(), i64::from(DESCENT).into(), i64::from(ADVANCE).into(), i64::from(ASCENT).into()],
        "ItalicAngle" => 0,
        "Ascent" => i64::from(ASCENT),
        "Descent" => i64::from(DESCENT),
        "CapHeight" => i64::from(ASCENT),
        "StemV" => 80,
        "FontFile2" => file,
    });
    let map = doc.add_object(flate_stream(Dictionary::new(), &cid_to_gid_map())?);
    let cid = doc.add_object(dictionary! {
        "Type" => "Font",
        "Subtype" => "CIDFontType2",
        "BaseFont" => "SheerGlyphless",
        "CIDSystemInfo" => dictionary! {
            "Registry" => Object::string_literal("Adobe"),
            "Ordering" => Object::string_literal("Identity"),
            "Supplement" => 0,
        },
        "FontDescriptor" => descriptor,
        "DW" => i64::from(ADVANCE),
        "CIDToGIDMap" => map,
    });
    let to_unicode = doc.add_object(flate_stream(Dictionary::new(), TO_UNICODE.as_bytes())?);
    Ok(doc.add_object(dictionary! {
        "Type" => "Font",
        "Subtype" => "Type0",
        "BaseFont" => "SheerGlyphless",
        "Encoding" => "Identity-H",
        "DescendantFonts" => vec![Object::Reference(cid)],
        "ToUnicode" => to_unicode,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use skrifa::raw::TableProvider;
    use skrifa::FontRef;

    #[test]
    fn the_program_parses_with_the_metrics_of_the_adr() {
        for boxed in [false, true] {
            let data = truetype(boxed);
            let font = FontRef::new(&data).expect("font parses");
            assert_eq!(font.head().unwrap().units_per_em(), 1000);
            assert_eq!(font.maxp().unwrap().num_glyphs(), 2);
            let hhea = font.hhea().unwrap();
            assert_eq!(hhea.ascender().to_i16(), 800);
            assert_eq!(hhea.descender().to_i16(), -200);
            assert_eq!(hhea.number_of_h_metrics(), 2);
            let hmtx = font.hmtx().unwrap();
            assert_eq!(hmtx.advance(skrifa::GlyphId::new(1)), Some(500));
            let glyf = font.glyf().unwrap();
            let loca = font.loca(None).unwrap();
            let glyph = loca.get_glyf(skrifa::GlyphId::new(1), &glyf).unwrap();
            assert_eq!(glyph.is_some(), boxed);
        }
    }

    #[test]
    fn the_whole_file_checksum_matches_the_adjustment() {
        let data = truetype(true);
        assert_eq!(checksum(&data), 0xB1B0_AFBA);
    }

    #[test]
    fn every_cid_maps_to_glyph_one() {
        let map = cid_to_gid_map();
        assert_eq!(map.len(), 131_072);
        assert!(map.chunks(2).all(|p| p == [0, 1]));
    }

    #[test]
    fn the_font_objects_are_a_type0_over_a_cid_font_type_2() {
        let mut doc = Document::with_version("1.7");
        let font = add_font(&mut doc, false).unwrap();
        let top = doc.get_dictionary(font).unwrap();
        assert_eq!(top.get(b"Subtype").unwrap().as_name().unwrap(), b"Type0");
        assert_eq!(
            top.get(b"Encoding").unwrap().as_name().unwrap(),
            b"Identity-H"
        );
        let cid = top.get(b"DescendantFonts").unwrap().as_array().unwrap()[0]
            .as_reference()
            .unwrap();
        let cid = doc.get_dictionary(cid).unwrap();
        assert_eq!(
            cid.get(b"Subtype").unwrap().as_name().unwrap(),
            b"CIDFontType2"
        );
        assert_eq!(cid.get(b"DW").unwrap().as_i64().unwrap(), 500);
        let map = cid.get(b"CIDToGIDMap").unwrap().as_reference().unwrap();
        let map = doc.get_object(map).unwrap().as_stream().unwrap();
        assert_eq!(map.decompressed_content().unwrap(), cid_to_gid_map());
    }
}
