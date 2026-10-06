//! The refusal classifier of text editing (ADR-125 §6, DESIGN §3.10 E5): which lines must never be edited, and why.
//!
//! Document level: [`document_refusal`] (any signed signature field, from `sigread::scan_fields`). Line level: [`classify_line`] from what
//! the walker saw of the line's runs (render mode, clip/`ActualText` span, form XObject, direction) and what `text_fonts` knows of its
//! fonts (Type3, a CMap other than Identity-H, no Unicode map), plus the script of its text. [`apply`] stamps the result into a
//! [`PageLines`] as `editable: no { reason }`; a line `text_lines` already refused keeps its own reason.
//!
//! Tooltip keys (DESIGN E5): `invisible` `editText.refuse.ocr`, `type3` `editText.refuse.type3`, `vertical` `editText.refuse.rotated`,
//! `cmap` `editText.refuse.encoding`, `signed` `cert.locked.tool`, `permission` `tool.readOnly`; `clip`, `inForm`, `actualText`,
//! `script`, `notFileSource`, `unmapped`, `tooComplex` have no DESIGN key yet.

use std::collections::HashMap;

use lopdf::Document;

use super::ops_walk::FontKey;
use super::sigread;
use super::text_fonts::{font_map, FontKind, FontMap};
use super::text_lines::{Line, PageLines};
use crate::error::AppError;
use crate::limits;
use crate::model::text_edit::{LineEditable, TextEditRefusal};

/// A line of more runs than this is `tooComplex` (a table row or a justified line cut into pieces).
pub const MAX_RUNS_PER_LINE: usize = 64;
/// A line set in more fonts than this is `tooComplex`.
pub const MAX_FONTS_PER_LINE: usize = 3;
/// A line whose direction is further than this (in radians) from the x axis is rotated: 0.5 degrees, tighter than the grouping of lines.
const DIRECTION_TOLERANCE: f64 = 0.0087;

/// `Some(Signed)` when the file has any signature field with a value or a certification (DocMDP): every edit of its pages would break
/// it (ADR-125 §6, whatever the lock says).
pub fn document_refusal(doc: &Document) -> Result<Option<TextEditRefusal>, AppError> {
    let scan = sigread::scan_fields(doc)?;
    Ok(
        (scan.doc_mdp.is_some() || scan.fields.iter().any(|field| field.signed))
            .then_some(TextEditRefusal::Signed),
    )
}

/// Latin, Greek and Cyrillic letters (with their extensions and presentation forms of Latin). Everything that is not a letter (digits,
/// punctuation, symbols, spaces) passes: it is written with the same codes in any script.
pub fn script_allowed(c: char) -> bool {
    if !c.is_alphabetic() {
        return true;
    }
    matches!(
        u32::from(c),
        0x0041..=0x005A | 0x0061..=0x007A | 0x00AA | 0x00BA | 0x00C0..=0x024F | 0x0250..=0x02AF
            | 0x1D00..=0x1DBF | 0x1E00..=0x1EFF | 0x2C60..=0x2C7F | 0xA720..=0xA7FF
            | 0xFB00..=0xFB06            // Greek and Coptic, Greek Extended.
            | 0x0370..=0x03FF | 0x1F00..=0x1FFF
            // Cyrillic and its supplements.
            | 0x0400..=0x052F | 0x1C80..=0x1C8F | 0x2DE0..=0x2DFF | 0xA640..=0xA69F
    )
}

/// Why `line` cannot be edited, from its runs and the fonts of them (`font_of` answers for a [`FontKey`]; `None` is a font that could not
/// be read, which is `cmap`). The first matching reason in the order of ADR-125 §6 wins.
pub fn classify_line<'a>(
    line: &Line,
    font_of: &dyn Fn(&FontKey) -> Option<&'a FontMap>,
) -> Option<TextEditRefusal> {
    use TextEditRefusal as R;
    if line.runs.is_empty() || line.text.trim().is_empty() {
        return Some(R::Unmapped);
    }
    if line.runs.len() > MAX_RUNS_PER_LINE
        || line.text.chars().count() > limits::TEXT_EDIT_LINE_CHARS
    {
        return Some(R::TooComplex);
    }
    let mut fonts: Vec<&FontKey> = Vec::new();
    for run in &line.runs {
        if !fonts.contains(&&run.font) {
            fonts.push(&run.font);
        }
    }
    if fonts.len() > MAX_FONTS_PER_LINE {
        return Some(R::TooComplex);
    }
    // Font kind first: a Type3 font is refused as such even when the run is also clipped.
    for key in &fonts {
        if let Some(map) = font_of(key) {
            if map.kind == FontKind::Type3 {
                return Some(R::Type3);
            }
        }
    }
    for run in &line.runs {
        // Mode 3 is the invisible OCR layer, 7 is invisible and clips.
        if matches!(run.render_mode, 3 | 7) {
            return Some(R::Invisible);
        }
    }
    for run in &line.runs {
        if run.render_mode >= 4 {
            return Some(R::Clip);
        }
    }
    // 0, 90, 180 and 270 degrees are fine (DESIGN E5); any other angle, or glyphs that do not follow the line, are refused.
    let axis =
        |dir: [f64; 2]| dir[0].abs() <= DIRECTION_TOLERANCE || dir[1].abs() <= DIRECTION_TOLERANCE;
    let upright = axis(line.dir)
        && line.runs.iter().flat_map(|run| &run.glyphs).all(|glyph| {
            (glyph.dir[0] - line.dir[0]).abs() <= 0.02
                && (glyph.dir[1] - line.dir[1]).abs() <= 0.02
                && glyph.adv >= 0.0
        });
    if !upright {
        return Some(R::Vertical);
    }
    for key in &fonts {
        match font_of(key) {
            None => return Some(R::Cmap),
            Some(map) => {
                if map.kind == FontKind::Type0Other
                    || (map.kind == FontKind::Type0IdentityH && map.to_code.is_empty())
                    || (map.kind == FontKind::Simple && map.to_code.is_empty())
                {
                    return Some(R::Cmap);
                }
            }
        }
    }
    if line.runs.iter().any(|run| run.in_form) {
        return Some(R::InForm);
    }
    // The walker folds a clip path and an `ActualText` span into `clipped`; the text modes were taken above.
    if line.runs.iter().any(|run| run.clipped) {
        return Some(R::ActualText);
    }
    if !line.text.chars().all(script_allowed) {
        return Some(R::Script);
    }
    None
}

/// Marks the lines of `lines` that cannot be edited. `document` (a document-level reason such as `signed` or `permission`) applies to
/// every line. Fonts are read from `src` once per object.
pub fn apply(
    src: &Document,
    lines: &mut PageLines,
    document: Option<TextEditRefusal>,
) -> Result<(), AppError> {
    let mut maps: HashMap<lopdf::ObjectId, Option<FontMap>> = HashMap::new();
    for object in lines
        .lines
        .iter()
        .flat_map(|line| &line.runs)
        .filter_map(|run| run.font.object)
    {
        maps.entry(object)
            .or_insert_with(|| font_map(src, object, &HashMap::new()).ok());
    }
    for line in &mut lines.lines {
        if matches!(line.editable, LineEditable::No { .. }) {
            continue;
        }
        let reason = document.or_else(|| {
            classify_line(line, &|key: &FontKey| {
                key.object
                    .and_then(|object| maps.get(&object))
                    .and_then(Option::as_ref)
            })
        });
        if let Some(reason) = reason {
            line.editable = LineEditable::No { reason };
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::geometry::Rect;
    use crate::pdfwrite::ops_walk::{GlyphPos, OpRef, Run};

    fn glyph(dir: [f64; 2]) -> GlyphPos {
        GlyphPos {
            op: OpRef {
                stream: 0,
                index: 1,
            },
            byte: 0..1,
            code: 65,
            origin: [10.0, 10.0],
            adv: 5.0,
            size_eff: 12.0,
            dir,
        }
    }

    fn run(mode: u8, clipped: bool, in_form: bool, dir: [f64; 2]) -> Run {
        Run {
            ops: OpRef {
                stream: 0,
                index: 1,
            }..OpRef {
                stream: 0,
                index: 2,
            },
            font: FontKey {
                name: b"F1".to_vec(),
                object: None,
            },
            in_form,
            render_mode: mode,
            rise: 0.0,
            rise_page: 0.0,
            clipped,
            glyphs: vec![glyph(dir)],
        }
    }

    fn line(runs: Vec<Run>, text: &str) -> Line {
        Line {
            index: 0,
            dir: runs
                .first()
                .and_then(|run| run.glyphs.first())
                .map_or([1.0, 0.0], |glyph| glyph.dir),
            runs,
            text: text.to_owned(),
            bounds: Rect {
                x: 0.0,
                y: 0.0,
                w: 10.0,
                h: 10.0,
            },
            paragraph: 0,
            font_name: "Test".into(),
            size: 12.0,
            embedded: true,
            editable: LineEditable::Same,
        }
    }

    fn map(kind: FontKind, mapped: bool) -> FontMap {
        FontMap {
            kind,
            embedded: None,
            subset: false,
            to_code: if mapped {
                HashMap::from([('A', 65)])
            } else {
                HashMap::new()
            },
            widths: crate::pdfwrite::text_fonts::WidthSource::Std14,
            glyphs: Default::default(),
            space_code: None,
        }
    }

    fn classify(line: &Line, font: &FontMap) -> Option<TextEditRefusal> {
        classify_line(line, &|_| Some(font))
    }

    const FLAT: [f64; 2] = [1.0, 0.0];

    #[test]
    fn every_class_is_found_and_a_plain_line_is_not_refused() {
        let ok = map(FontKind::Simple, true);
        let plain = line(vec![run(0, false, false, FLAT)], "Hello");
        assert_eq!(classify(&plain, &ok), None);
        // Quarter turns are editable.
        for dir in [[0.0, 1.0], [-1.0, 0.0], [0.0, -1.0]] {
            let turned = line(vec![run(0, false, false, dir)], "Hello");
            assert_eq!(classify(&turned, &ok), None, "{dir:?}");
        }
        let cases: Vec<(Line, FontMap, TextEditRefusal)> = vec![
            (
                plain.clone(),
                map(FontKind::Type3, true),
                TextEditRefusal::Type3,
            ),
            (
                line(vec![run(3, false, false, FLAT)], "Hello"),
                ok.clone(),
                TextEditRefusal::Invisible,
            ),
            (
                line(vec![run(7, true, false, FLAT)], "Hello"),
                ok.clone(),
                TextEditRefusal::Invisible,
            ),
            (
                line(vec![run(5, true, false, FLAT)], "Hello"),
                ok.clone(),
                TextEditRefusal::Clip,
            ),
            (
                line(vec![run(0, false, false, [0.6, 0.8])], "Hello"),
                ok.clone(),
                TextEditRefusal::Vertical,
            ),
            (
                line(vec![run(0, false, false, [0.9, 0.1])], "Hello"),
                ok.clone(),
                TextEditRefusal::Vertical,
            ),
            (
                plain.clone(),
                map(FontKind::Type0IdentityH, false),
                TextEditRefusal::Cmap,
            ),
            (
                plain.clone(),
                map(FontKind::Type0Other, true),
                TextEditRefusal::Cmap,
            ),
            (
                line(vec![run(0, false, true, FLAT)], "Hello"),
                ok.clone(),
                TextEditRefusal::InForm,
            ),
            (
                line(vec![run(0, true, false, FLAT)], "Hello"),
                ok.clone(),
                TextEditRefusal::ActualText,
            ),
            (
                line(vec![run(0, false, false, FLAT)], "שלום"),
                ok.clone(),
                TextEditRefusal::Script,
            ),
            (
                line(vec![run(0, false, false, FLAT)], "日本語"),
                ok.clone(),
                TextEditRefusal::Script,
            ),
            (
                line(
                    vec![run(0, false, false, FLAT); MAX_RUNS_PER_LINE + 1],
                    "Hello",
                ),
                ok.clone(),
                TextEditRefusal::TooComplex,
            ),
            (
                line(Vec::new(), "Hello"),
                ok.clone(),
                TextEditRefusal::Unmapped,
            ),
        ];
        for (line, font, expected) in cases {
            assert_eq!(classify(&line, &font), Some(expected), "{expected:?}");
        }
        // A font that could not be read is refused as having no Unicode map.
        assert_eq!(
            classify_line(&plain, &|_| None),
            Some(TextEditRefusal::Cmap)
        );
    }

    #[test]
    fn latin_greek_and_cyrillic_pass_and_other_scripts_do_not() {
        assert!("Grüße Ελλάδα Привет 12,5 %".chars().all(script_allowed));
        assert!(!script_allowed('א'));
        assert!(!script_allowed('م'));
        assert!(!script_allowed('漢'));
        assert!(!script_allowed('ก'));
    }

    #[test]
    fn a_refused_line_keeps_the_reason_text_lines_gave_it() {
        let doc = Document::with_version("1.5");
        let mut lines = PageLines {
            lines: vec![line(vec![run(3, false, false, FLAT)], "Hello")],
            paragraphs: Vec::new(),
        };
        lines.lines[0].editable = LineEditable::No {
            reason: TextEditRefusal::Unmapped,
        };
        apply(&doc, &mut lines, Some(TextEditRefusal::Signed)).unwrap();
        assert_eq!(
            lines.lines[0].editable,
            LineEditable::No {
                reason: TextEditRefusal::Unmapped
            }
        );
        lines.lines[0].editable = LineEditable::Same;
        apply(&doc, &mut lines, Some(TextEditRefusal::Signed)).unwrap();
        assert_eq!(
            lines.lines[0].editable,
            LineEditable::No {
                reason: TextEditRefusal::Signed
            }
        );
    }
}
