//! Tests of the lexer and the splice. The walker and the mapper are not needed: a tiny walker over the same lexer (fixed size 10, every
//! glyph 5 points wide) stands in, and the font map is built by hand.

use super::*;
use crate::error::ErrorCode;
use crate::fontprog::fallback::pick;
use crate::model::text_edit::LineKey;

fn font_map_for_tests() -> FontMap {
    let mut to_code = HashMap::new();
    let mut codes = HashSet::new();
    for c in 0x20u32..0x7F {
        let ch = char::from_u32(c).unwrap();
        to_code.insert(ch, c);
        // `Z` has a code but no glyph in the (subset) font program.
        if ch != 'Z' {
            codes.insert(c);
        }
    }
    FontMap {
        kind: FontKind::Simple,
        embedded: Some(crate::fontprog::ProgramKind::TrueType),
        subset: true,
        to_code,
        widths: WidthSource::Widths {
            first_char: 0,
            widths: vec![500.0; 256],
        },
        glyphs: crate::pdfwrite::text_fonts::GlyphSet { codes },
        space_code: Some(32),
    }
}

/// Glyph positions of a content made of `BT`, `Td`, `TL`, `T*`, `Tj`, `TJ`, `'`: 10 pt, 5 pt per glyph.
fn walk(streams: &[Vec<u8>]) -> Vec<GlyphPos> {
    let mut out = Vec::new();
    let (mut lx, mut ly, mut x, mut y, mut tl, mut tw) =
        (0.0f64, 0.0f64, 0.0f64, 0.0f64, 0.0f64, 0.0f64);
    for (si, s) in streams.iter().enumerate() {
        let lexed = lex_full(s).unwrap();
        for (i, tok) in lexed.toks.iter().enumerate() {
            let ops = operands(s, &tok.args).unwrap();
            let num = |o: &Operand| match o {
                Operand::Num { value, .. } => *value,
                _ => 0.0,
            };
            match tok.op.as_slice() {
                b"BT" => (lx, ly, x, y) = (0.0, 0.0, 0.0, 0.0),
                b"Td" => {
                    lx += num(&ops[0]);
                    ly += num(&ops[1]);
                    (x, y) = (lx, ly);
                }
                b"TL" => tl = num(&ops[0]),
                b"Tw" => tw = num(&ops[0]),
                b"T*" => {
                    ly -= tl;
                    (x, y) = (lx, ly);
                }
                b"Tj" | b"TJ" | b"'" => {
                    if tok.op == b"'" {
                        ly -= tl;
                        (x, y) = (lx, ly);
                    }
                    let mut seq: Vec<Result<u8, f64>> = Vec::new();
                    for o in &ops {
                        match o {
                            Operand::Str(b) => seq.extend(b.iter().map(|c| Ok(*c))),
                            Operand::Array(a) => {
                                for e in a {
                                    match e {
                                        Operand::Str(b) => seq.extend(b.iter().map(|c| Ok(*c))),
                                        other => seq.push(Err(num(other))),
                                    }
                                }
                            }
                            _ => {}
                        }
                    }
                    let mut n = 0u32;
                    for e in seq {
                        match e {
                            Ok(code) => {
                                out.push(GlyphPos {
                                    op: OpRef {
                                        stream: si as u32,
                                        index: i as u32,
                                    },
                                    byte: n..n + 1,
                                    code: u32::from(code),
                                    origin: [x, y],
                                    adv: 5.0 + if code == 32 { tw } else { 0.0 },
                                    size_eff: 10.0,
                                    dir: [1.0, 0.0],
                                });
                                n += 1;
                                x += 5.0 + if code == 32 { tw } else { 0.0 };
                            }
                            Err(k) => x -= k / 1000.0 * 10.0,
                        }
                    }
                }
                _ => {}
            }
        }
    }
    out
}

type Ran = (String, Vec<ChangeWarning>, Vec<(Face, BTreeSet<char>)>);

struct Source {
    align: Align,
    justified: bool,
    right_limit: Option<f64>,
}

impl Default for Source {
    fn default() -> Self {
        Self {
            align: Align::Left,
            justified: false,
            right_limit: None,
        }
    }
}

impl LineSource for Source {
    fn line(
        &mut self,
        streams: &[Vec<u8>],
        _fallback: &[(Face, BTreeSet<char>)],
        key: LineKey,
    ) -> Result<OwnedLine, AppError> {
        let mut rows: BTreeMap<i64, Vec<GlyphPos>> = BTreeMap::new();
        for g in walk(streams) {
            rows.entry(-(g.origin[1] * 1000.0) as i64)
                .or_default()
                .push(g);
        }
        let mut row = rows
            .into_values()
            .nth(key.line as usize)
            .ok_or(AppError::invalid("lineKey"))?;
        row.sort_by(|a, b| a.origin[0].total_cmp(&b.origin[0]));
        let text = row
            .iter()
            .map(|g| char::from_u32(g.code).unwrap())
            .collect();
        Ok(OwnedLine {
            glyphs: row,
            text,
            font: font_map_for_tests(),
            face: pick(0, 400, "Helvetica"),
            align: self.align,
            justified: self.justified,
            right_limit: self.right_limit,
        })
    }
}

fn edit(rev: u32, line: u32, text: &str, fit: TextFit) -> TextEdit {
    TextEdit {
        key: LineKey { rev, line },
        text: text.to_owned(),
        fit,
        scope: TextScope::Line,
    }
}

fn run(content: &str, edits: &[TextEdit], mut source: Source) -> Result<Ran, AppError> {
    let r = replay_core(
        vec![content.as_bytes().to_vec()],
        edits,
        &mut source,
        &|_, _| Some(600.0),
        None,
    )?;
    Ok((
        String::from_utf8(r.streams.into_iter().next().unwrap()).unwrap(),
        r.warnings,
        r.fallback,
    ))
}

const TWO_LINES: &str =
    "BT /F1 10 Tf 72 700 Td [(Hello w) -20 (orld)] TJ 0 -14 Td (second line) Tj ET";

#[test]
fn the_lexer_gives_offsets_and_skips_an_inline_image_with_a_fake_ei_in_its_data() {
    let s =
        b"q 1 0 0 1 5 5 cm BI /W 2 /H 2 /BPC 8 /CS /G ID A EI EI Q % note\nBT /F1 10 Tf (a) Tj ET";
    let toks = lex(s).unwrap();
    let ops: Vec<&[u8]> = toks.iter().map(|t| t.op.as_slice()).collect();
    assert_eq!(
        ops,
        [&b"q"[..], b"cm", b"BI", b"Q", b"BT", b"Tf", b"Tj", b"ET"]
    );
    let tj = &toks[6];
    assert_eq!(&s[tj.args.start as usize..tj.args.end as usize], b"(a)");
    let q = &toks[0];
    assert_eq!(q.args.start, q.args.end);
}

#[test]
fn the_lexer_refuses_what_it_cannot_be_sure_of() {
    for bad in [
        &b"BT ) ET"[..],
        b"BT (open Tj",
        b"1 2 3",
        b"BI /W 1 /H 1 /BPC 8 /CS /G ID",
        b"BI /W 1 /H 1 /BPC 8 /CS /G ID AB ET",
        b"[(a) Tj",
        b"12ab Tj",
        b"<zz> Tj",
    ] {
        assert!(lex(bad).is_err(), "{}", String::from_utf8_lossy(bad));
    }
}

#[test]
fn strings_are_decoded_in_both_forms() {
    let s = b"[(a\\(b\\051\\n) <4 1 4> -20.5] TJ";
    let ops = operands(s, &(0..s.len() as u32 - 3)).unwrap();
    let Operand::Array(items) = &ops[0] else {
        panic!("array");
    };
    assert!(matches!(&items[0], Operand::Str(b) if b == b"a(b)\n"));
    assert!(matches!(&items[1], Operand::Str(b) if b == &[0x41, 0x40]));
    assert!(matches!(&items[2], Operand::Num { value, .. } if *value == -20.5));
}

#[test]
fn a_same_font_edit_changes_only_the_show_operator_and_keeps_the_kerning() {
    let (out, warnings, fallback) = run(
        TWO_LINES,
        &[edit(0, 0, "Hello warld", TextFit::KeepStart)],
        Source::default(),
    )
    .unwrap();
    assert_eq!(
        out,
        "BT /F1 10 Tf 72 700 Td [<48656C6C6F2077> -20 <61726C64>] TJ 0 -14 Td (second line) Tj ET"
    );
    assert!(warnings.is_empty() && fallback.is_empty());
    // Every byte before and after the operator is the original's.
    let (a, b) = (
        TWO_LINES.find("[(Hello").unwrap(),
        TWO_LINES.find("] TJ").unwrap() + 4,
    );
    assert!(out.starts_with(&TWO_LINES[..a]));
    assert!(out.ends_with(&TWO_LINES[b..]));
}

#[test]
fn an_unchanged_text_changes_no_byte() {
    let (out, ..) = run(
        TWO_LINES,
        &[edit(0, 1, "second line", TextFit::KeepStart)],
        Source::default(),
    )
    .unwrap();
    assert_eq!(out, TWO_LINES);
}

#[test]
fn replaying_one_edit_less_is_the_state_before_it() {
    let e1 = edit(0, 0, "Hello warld", TextFit::KeepStart);
    let e2 = edit(1, 1, "second lime", TextFit::KeepStart);
    let (none, ..) = run(TWO_LINES, &[], Source::default()).unwrap();
    let (one, ..) = run(TWO_LINES, std::slice::from_ref(&e1), Source::default()).unwrap();
    let (two, ..) = run(TWO_LINES, &[e1.clone(), e2], Source::default()).unwrap();
    let (again, ..) = run(TWO_LINES, &[e1], Source::default()).unwrap();
    assert_eq!(none, TWO_LINES);
    assert_eq!(one, again, "a replay is deterministic");
    assert_ne!(one, two);
    // Edit 2 only changed its own operator: the first edit's bytes are all still there.
    assert!(two.starts_with(&one[..one.find("0 -14").unwrap()]));
    assert!(two.contains("<7365636F6E64206C696D65>"));
}

#[test]
fn a_key_from_before_an_edit_is_refused() {
    let err = run(
        TWO_LINES,
        &[
            edit(0, 0, "Hello warld", TextFit::KeepStart),
            edit(0, 1, "x", TextFit::KeepStart),
        ],
        Source::default(),
    )
    .unwrap_err();
    assert_eq!(err.code(), ErrorCode::InvalidArgument);
}

#[test]
fn an_edit_over_a_stream_the_lexer_doubts_is_too_complex() {
    let good = vec![b"BT /F1 10 Tf (a) Tj ET".to_vec()];
    let glyphs = walk(&good);
    let font = font_map_for_tests();
    let input = LineInput {
        glyphs: glyphs.iter().collect(),
        text: "a",
        font: &font,
        face: pick(0, 400, "Helvetica"),
        align: Align::Left,
        justified: false,
        right_limit: None,
    };
    let mut bad = vec![b"BT /F1 10 Tf (a) Tj ) ET".to_vec()];
    let before = bad.clone();
    let err = edit_line(&mut bad, &input, "b", TextFit::KeepStart, &|_, _| {
        Some(600.0)
    })
    .unwrap_err();
    assert_eq!(err.code(), ErrorCode::UnsupportedFeature);
    assert_eq!(bad, before, "nothing is re-encoded");
}

#[test]
fn a_word_that_grows_into_the_next_segment_warns_and_one_that_just_fits_does_not() {
    let content = "BT /F1 10 Tf 72 700 Td (Hello) Tj 30 0 Td (World) Tj ET";
    let (out, warnings, _) = run(
        content,
        &[edit(0, 0, "HelloXXXXXWorld", TextFit::KeepStart)],
        Source::default(),
    )
    .unwrap();
    assert_eq!(warnings, vec![ChangeWarning::TextOverflow]);
    // The later segment keeps its bytes and so its place.
    assert!(out.ends_with("30 0 Td (World) Tj ET"));
    let (_, warnings, _) = run(
        content,
        &[edit(0, 0, "HelloXWorld", TextFit::KeepStart)],
        Source::default(),
    )
    .unwrap();
    assert!(warnings.is_empty());
}

#[test]
fn growing_past_the_right_edge_of_the_paragraph_warns() {
    let content = "BT /F1 10 Tf 72 700 Td (Hello) Tj ET";
    let source = Source {
        right_limit: Some(100.0),
        ..Source::default()
    };
    let (_, warnings, _) = run(
        content,
        &[edit(0, 0, "Hello world", TextFit::KeepStart)],
        source,
    )
    .unwrap();
    assert_eq!(warnings, vec![ChangeWarning::TextOverflow]);
}

#[test]
fn a_character_the_font_lacks_moves_only_its_words_to_the_fallback_font() {
    let content = "BT /F1 10 Tf 72 700 Td (foo bar baz) Tj ET";
    let (out, warnings, fallback) = run(
        content,
        &[edit(0, 0, "foo bZr baz", TextFit::KeepStart)],
        Source::default(),
    )
    .unwrap();
    let name = resource_name(pick(0, 400, "Helvetica"));
    assert_eq!(
        out,
        format!(
            "BT /F1 10 Tf 72 700 Td [<666F6F20>] TJ /{name} 10 Tf [<0062005A0072>] TJ /F1 10 Tf [<2062617A>] TJ ET"
        )
    );
    assert_eq!(warnings, vec![ChangeWarning::FontFallback]);
    assert_eq!(fallback.len(), 1);
    assert_eq!(fallback[0].1.iter().collect::<String>(), "Zbr");
}

#[test]
fn the_fallback_characters_are_read_back_from_the_rewritten_content() {
    let face = pick(0, 400, "Helvetica");
    let name = resource_name(face);
    let r = Rewritten {
        content: format!("BT /F1 10 Tf [<666F>] TJ /{name} 10 Tf [<0062005A>] TJ /F1 10 Tf ET")
            .into_bytes(),
        fonts: vec![NewFont { face, name }],
        warnings: Vec::new(),
    };
    let chars = fallback_chars(&r).unwrap();
    assert_eq!(chars.len(), 1);
    assert_eq!(chars[0].1.iter().collect::<String>(), "Zb");
}

#[test]
fn a_right_aligned_line_keeps_its_right_edge() {
    let content = "BT /F1 10 Tf 100 700 Td (Hello) Tj ET";
    let source = Source {
        align: Align::Right,
        ..Source::default()
    };
    let (out, warnings, _) = run(
        content,
        &[edit(0, 0, "Hello!!", TextFit::KeepStart)],
        source,
    )
    .unwrap();
    // Two glyphs (10 pt) wider: the start moves left by 10 pt = 1000 thousandths of the 10 pt size.
    assert_eq!(out, "BT /F1 10 Tf 100 700 Td [1000 <48656C6C6F2121>] TJ ET");
    assert!(warnings.is_empty());
}

#[test]
fn a_justified_line_spreads_the_change_over_its_word_gaps() {
    let content = "BT /F1 10 Tf 72 700 Td [(ab cd) -20 (ef gh)] TJ ET";
    let source = Source {
        justified: true,
        ..Source::default()
    };
    let (out, warnings, _) = run(
        content,
        &[edit(0, 0, "ab cdXef gh", TextFit::KeepStart)],
        source,
    )
    .unwrap();
    // +5 pt over two gaps: 2.5 pt each = 250 thousandths.
    assert_eq!(
        out,
        "BT /F1 10 Tf 72 700 Td [<616220> 250 <636458> -20 <656620> 250 <6768>] TJ ET"
    );
    assert!(warnings.is_empty());
}

#[test]
fn squeeze_sets_tz_around_the_line_down_to_85_percent() {
    let content = "BT /F1 10 Tf 72 700 Td (Hello) Tj ET";
    let (out, ..) = run(
        content,
        &[edit(0, 0, "Hello wor", TextFit::Squeeze)],
        Source::default(),
    )
    .unwrap();
    assert_eq!(
        out,
        "BT /F1 10 Tf 72 700 Td 85 Tz [<48656C6C6F20776F72>] TJ 100 Tz ET"
    );
}

#[test]
fn deleting_across_operators_empties_the_later_ones() {
    let content = "BT /F1 10 Tf 72 700 Td (ab) Tj (cd) Tj (ef) Tj ET";
    let (out, ..) = run(
        content,
        &[edit(0, 0, "abef", TextFit::KeepStart)],
        Source::default(),
    )
    .unwrap();
    assert_eq!(out, "BT /F1 10 Tf 72 700 Td (ab) Tj [] TJ (ef) Tj ET");
    let (out, ..) = run(
        content,
        &[edit(0, 0, "abXf", TextFit::KeepStart)],
        Source::default(),
    )
    .unwrap();
    assert_eq!(out, "BT /F1 10 Tf 72 700 Td (ab) Tj [<58>] TJ [<66>] TJ ET");
}

#[test]
fn an_empty_text_removes_the_line() {
    let (out, ..) = run(
        TWO_LINES,
        &[edit(0, 1, "", TextFit::KeepStart)],
        Source::default(),
    )
    .unwrap();
    assert!(out.ends_with("0 -14 Td [] TJ ET"));
}

#[test]
fn a_quote_operator_keeps_its_line_advance() {
    let content = "BT /F1 10 Tf 12 TL 72 700 Td (ab) Tj (cd) ' ET";
    let (out, ..) = run(
        content,
        &[edit(0, 1, "cX", TextFit::KeepStart)],
        Source::default(),
    )
    .unwrap();
    assert_eq!(
        out,
        "BT /F1 10 Tf 12 TL 72 700 Td (ab) Tj T* [<6358>] TJ ET"
    );
}

#[test]
fn only_the_stream_with_the_line_changes() {
    let mut source = Source::default();
    let streams = vec![
        b"BT /F1 10 Tf 72 700 Td (one) Tj ET".to_vec(),
        b"BT /F1 10 Tf 72 650 Td (two) Tj ET".to_vec(),
    ];
    let r = replay_core(
        streams.clone(),
        &[edit(0, 1, "twp", TextFit::KeepStart)],
        &mut source,
        &|_, _| Some(600.0),
        None,
    )
    .unwrap();
    assert_eq!(r.streams[0], streams[0]);
    assert_eq!(r.streams[1], b"BT /F1 10 Tf 72 650 Td [<747770>] TJ ET");
}

#[test]
fn a_centred_line_keeps_its_centre() {
    let content = "BT /F1 10 Tf 100 700 Td (Hello) Tj ET";
    let source = Source {
        align: Align::Center,
        ..Source::default()
    };
    let (out, warnings, _) = run(
        content,
        &[edit(0, 0, "Hello!!", TextFit::KeepStart)],
        source,
    )
    .unwrap();
    // Two glyphs (10 pt) wider: the start moves left by 5 pt = 500 thousandths of the 10 pt size.
    assert_eq!(out, "BT /F1 10 Tf 100 700 Td [500 <48656C6C6F2121>] TJ ET");
    assert!(warnings.is_empty());
}

#[test]
fn a_centred_line_with_a_trailing_space_of_its_own_moves_every_chain() {
    // The space is shown by an operator of its own (Word-style): both chains take the shift, the new text hangs behind the space.
    let content = "BT /F1 10 Tf 100 700 Td (Hello) Tj ET BT /F1 10 Tf 125 700 Td ( ) Tj ET";
    let source = Source {
        align: Align::Center,
        ..Source::default()
    };
    let (out, warnings, _) = run(
        content,
        &[edit(0, 0, "Hello 12", TextFit::KeepStart)],
        source,
    )
    .unwrap();
    // Two glyphs (10 pt) wider: both chains move left by 5 pt.
    assert_eq!(
        out,
        "BT /F1 10 Tf 100 700 Td [500 <48656C6C6F>] TJ ET BT /F1 10 Tf 125 700 Td [500 <203132>] TJ ET"
    );
    assert!(warnings.is_empty());
}

#[test]
fn a_right_aligned_word_spread_over_chains_is_replaced_and_keeps_its_right_edge() {
    // Every glyph of the last word has an operator of its own and the new text needs the fallback font.
    let content = "BT /F1 10 Tf 100 700 Td (ab ) Tj ET BT /F1 10 Tf 115 700 Td (c) Tj ET BT /F1 10 Tf 120 700 Td (d) Tj ET";
    let source = Source {
        align: Align::Right,
        ..Source::default()
    };
    let (out, ..) = run(
        content,
        &[edit(0, 0, "ab cZZd", TextFit::KeepStart)],
        source,
    )
    .unwrap();
    // The word is 14 pt wider (4 x 6 pt against 10 pt): every chain that stays moves left by 14 pt, the replaced glyphs are gone.
    assert_eq!(
        out,
        "BT /F1 10 Tf 100 700 Td [1400 <616220>] TJ ET BT /F1 10 Tf 115 700 Td [1400] TJ /SheerFnSansR 10 Tf [<0063005A005A0064>] TJ /F1 10 Tf ET BT /F1 10 Tf 120 700 Td [] TJ ET"
    );
}

#[test]
fn placeholders_are_paired_with_the_glyph_at_their_index() {
    let inverse: HashMap<u32, char> = [(10, 'a'), (11, 'b'), (12, 'c')].into();
    // A real character in front: the placeholder at index 1 is glyph 1, not the first placeholder's glyph 0.
    assert_eq!(
        remap_placeholders("x\u{fffd}\u{fffd}", &[10, 11, 12], &inverse),
        "xbc"
    );
    // Another count (an inserted space): untouched.
    assert_eq!(
        remap_placeholders("\u{fffd} \u{fffd}", &[10, 11], &inverse),
        "\u{fffd} \u{fffd}"
    );
}

/// The right edge (page x) of the last glyph of the only row of `out`.
fn right_edge(out: &str) -> f64 {
    walk(&[out.as_bytes().to_vec()])
        .iter()
        .map(|g| g.origin[0] + g.adv)
        .fold(f64::MIN, f64::max)
}

fn justified(limit: f64) -> Source {
    Source {
        justified: true,
        right_limit: Some(limit),
        ..Source::default()
    }
}

#[test]
fn a_changed_justified_line_in_one_tj_ends_at_the_right_edge() {
    let content = "BT /F1 10 Tf 72 700 Td [(ab cd) -20 (ef gh)] TJ ET";
    let (out, warnings, _) = run(
        content,
        &[edit(0, 0, "ab cdXef gh", TextFit::KeepStart)],
        justified(140.0),
    )
    .unwrap();
    assert!((right_edge(&out) - 140.0).abs() < 0.5, "{out}");
    assert!(warnings.is_empty(), "{warnings:?}");
}

#[test]
fn a_changed_justified_line_with_a_chain_per_word_ends_at_the_right_edge() {
    let content = "BT /F1 10 Tf 72 700 Td (ab ) Tj 20 0 Td (cd ) Tj 20 0 Td (ef) Tj ET";
    assert!((right_edge(content) - 122.0).abs() < 0.01);
    let (out, warnings, _) = run(
        content,
        &[edit(0, 0, "ab cdX ef", TextFit::KeepStart)],
        justified(130.0),
    )
    .unwrap();
    assert!((right_edge(&out) - 130.0).abs() < 0.5, "{out}");
    assert!(warnings.is_empty(), "{warnings:?}");
    // The first word stays where it was.
    assert!(
        out.contains("72 700 Td [<616220>] TJ") || out.contains("72 700 Td (ab ) Tj"),
        "{out}"
    );
}

#[test]
fn a_change_that_would_stretch_the_gaps_too_far_leaves_the_line_ragged() {
    let content = "BT /F1 10 Tf 72 700 Td [(ab cd) -20 (ef gh)] TJ ET";
    let text = "ab cdXef gh";
    let (ragged, warnings, _) = run(
        content,
        &[edit(0, 0, text, TextFit::KeepStart)],
        justified(300.0),
    )
    .unwrap();
    let (plain, ..) = run(
        content,
        &[edit(0, 0, text, TextFit::KeepStart)],
        Source::default(),
    )
    .unwrap();
    assert_eq!(ragged, plain);
    // "The warning it had before" (ADR-130) is the keepStart collision warning only: it is raised when the grown line runs into the
    // next object, and nothing follows this line, so there is no warning here. The line stays ragged without a stretch-specific one.
    assert!(warnings.is_empty(), "{warnings:?}");
}

#[test]
fn the_last_line_of_a_justified_paragraph_and_a_one_word_line_keep_their_natural_width() {
    let content = "BT /F1 10 Tf 72 700 Td [(ab cd) -20 (ef gh)] TJ ET";
    let last = Source {
        justified: false,
        right_limit: Some(140.0),
        ..Source::default()
    };
    let (out, ..) = run(
        content,
        &[edit(0, 0, "ab cdXef gh", TextFit::KeepStart)],
        last,
    )
    .unwrap();
    assert!((right_edge(&out) - 127.2).abs() < 0.01, "{out}");
    let one = "BT /F1 10 Tf 72 700 Td (abc) Tj ET";
    let (out, ..) = run(
        one,
        &[edit(0, 0, "abcd", TextFit::KeepStart)],
        justified(140.0),
    )
    .unwrap();
    assert!((right_edge(&out) - 92.0).abs() < 0.01, "{out}");
}

#[test]
fn emptying_a_justified_line_removes_its_glyphs() {
    let content = "BT /F1 10 Tf 72 700 Td [(ab cd) -20 (ef gh)] TJ ET";
    let (out, ..) = run(
        content,
        &[edit(0, 0, "", TextFit::KeepStart)],
        justified(140.0),
    )
    .unwrap();
    assert!(out.contains("[] TJ"), "{out}");
}

#[test]
fn a_changed_justified_line_with_word_spacing_ends_at_the_right_edge() {
    // `Tw` widens each space by 3 pt: "ab cd ef" is 46 pt wide, the edit makes it 51 pt, the edge is 130.
    let content = "BT /F1 10 Tf 3 Tw 72 700 Td (ab cd ef) Tj ET";
    assert!((right_edge(content) - 118.0).abs() < 0.01);
    let (out, warnings, _) = run(
        content,
        &[edit(0, 0, "ab cdX ef", TextFit::KeepStart)],
        justified(130.0),
    )
    .unwrap();
    assert!((right_edge(&out) - 130.0).abs() < 0.5, "{out}");
    assert!(warnings.is_empty(), "{warnings:?}");
}

#[test]
fn a_justified_line_drawn_out_of_reading_order_is_refused() {
    // The second word is drawn first (chains A, B in the stream, B, A on the page): the gap count would be wrong, so the
    // splice must not produce a line that misses the edge silently.
    let content = "BT /F1 10 Tf 112 700 Td (ef gh) Tj -40 0 Td (ab cd) Tj ET";
    let result = run(
        content,
        &[edit(0, 0, "ab cdXef gh", TextFit::KeepStart)],
        justified(150.0),
    );
    assert!(result.is_err(), "{:?}", result.map(|r| r.0));
}

#[test]
fn a_justified_line_with_exactly_one_gap_puts_the_whole_stretch_there() {
    // "ab cd" is 25 pt wide (72..97); the edit makes it 30 pt; the edge is 108: the one gap takes the 6 pt.
    let content = "BT /F1 10 Tf 72 700 Td (ab cd) Tj ET";
    let (out, warnings, _) = run(
        content,
        &[edit(0, 0, "ab cdX", TextFit::KeepStart)],
        justified(108.0),
    )
    .unwrap();
    assert!((right_edge(&out) - 108.0).abs() < 0.5, "{out}");
    assert!(warnings.is_empty(), "{warnings:?}");
}

#[test]
fn a_justified_line_whose_old_kerns_stretch_it_gives_the_stretch_back() {
    // The gap carries a 10 pt kern (line ends at 107); the edit adds 5 pt of text and the edge stays 107, so the kern shrinks.
    let content = "BT /F1 10 Tf 72 700 Td [(ab ) -1000 (cd)] TJ ET";
    assert!((right_edge(content) - 107.0).abs() < 0.01);
    let (out, warnings, _) = run(
        content,
        &[edit(0, 0, "ab cdX", TextFit::KeepStart)],
        justified(107.0),
    )
    .unwrap();
    assert!((right_edge(&out) - 107.0).abs() < 0.5, "{out}");
    assert!(warnings.is_empty(), "{warnings:?}");
}

#[test]
fn a_justified_line_with_a_nan_or_degenerate_limit_stays_natural() {
    let content = "BT /F1 10 Tf 72 700 Td (ab cd) Tj ET";
    let (plain, ..) = run(
        content,
        &[edit(0, 0, "ab cdX", TextFit::KeepStart)],
        Source::default(),
    )
    .unwrap();
    for limit in [f64::NAN, 0.0, -5.0] {
        let result = run(
            content,
            &[edit(0, 0, "ab cdX", TextFit::KeepStart)],
            justified(limit),
        );
        if let Ok((out, ..)) = result {
            assert!(!out.contains("NaN"), "{out}");
            assert!(right_edge(&out).is_finite(), "{out}");
            assert_eq!(out, plain, "limit {limit}");
        }
    }
}

#[test]
fn a_re_broken_line_never_gets_a_gap_below_its_natural_width_when_the_natural_line_fits() {
    // "aa bb cc " carries 4 pt of old stretch per gap (ends at 125); "dd" joins it (natural width 127 pt, the edge is 130). A uniform
    // take-back would squeeze the new gap below the 5 pt of a space: every gap must stay at or above it, and the line ends at the edge.
    let content = "BT /F1 10 Tf 72 700 Td [(aa ) -400 (bb ) -400 (cc )] TJ ET";
    assert!((right_edge(content) - 125.0).abs() < 0.01);
    let (out, warnings, _) = run(
        content,
        &[edit(0, 0, "aa bb cc dd", TextFit::KeepStart)],
        justified(130.0),
    )
    .unwrap();
    assert!((right_edge(&out) - 130.0).abs() < 0.5, "{out}");
    assert!(warnings.is_empty(), "{warnings:?}");
    let glyphs = walk(&[out.as_bytes().to_vec()]);
    let letters: Vec<&GlyphPos> = glyphs.iter().filter(|g| g.code != 32).collect();
    for pair in letters.windows(2) {
        let gap = pair[1].origin[0] - (pair[0].origin[0] + pair[0].adv);
        assert!(
            gap < 0.01 || gap >= 5.0 - 0.01,
            "gap {gap} below a space: {out}"
        );
    }
}

#[test]
fn a_line_that_does_not_fit_naturally_still_shrinks_its_gaps() {
    // Natural width 127 pt against an edge of 125: the gaps give back more than their old stretch (the true shrink case).
    let content = "BT /F1 10 Tf 72 700 Td [(aa ) -400 (bb ) -400 (cc )] TJ ET";
    let (out, ..) = run(
        content,
        &[edit(0, 0, "aa bb cc dd", TextFit::KeepStart)],
        justified(125.0),
    )
    .unwrap();
    assert!((right_edge(&out) - 125.0).abs() < 0.5, "{out}");
}
