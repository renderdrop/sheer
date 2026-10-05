//! Synthetic one-page files for the spike. The text of an output is read back with the same walk (`scan`), which decodes through
//! the fonts the file declares, so a test sees what a reader would extract.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use super::scan::{Kind, Scanner, Target};
use super::*;

/// A PDF from object bodies: object 1 is the catalog, 2 the pages, 3 the page; the rest is up to the test.
fn pdf(objects: &[String]) -> Vec<u8> {
    let mut out = b"%PDF-1.7\n".to_vec();
    let mut offsets = Vec::new();
    for (i, body) in objects.iter().enumerate() {
        offsets.push(out.len());
        out.extend_from_slice(format!("{} 0 obj\n{body}\nendobj\n", i + 1).as_bytes());
    }
    let xref = out.len();
    out.extend_from_slice(
        format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1).as_bytes(),
    );
    for offset in offsets {
        out.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
    }
    out.extend_from_slice(
        format!(
            "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n",
            objects.len() + 1
        )
        .as_bytes(),
    );
    out
}

fn stream(dict: &str, data: &str) -> String {
    format!(
        "<< {dict} /Length {} >>\nstream\n{data}\nendstream",
        data.len()
    )
}

/// Page with `content` and `fonts` (`/F1 5 0 R` style) plus `extra` resources and objects 5.. from `more`.
fn page_pdf(content: &str, resources: &str, more: &[String]) -> Vec<u8> {
    let mut objects = vec![
        "<< /Type /Catalog /Pages 2 0 R >>".to_owned(),
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_owned(),
        format!(
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << {resources} >> >>"
        ),
        stream("", content),
    ];
    objects.extend_from_slice(more);
    pdf(&objects)
}

const HELVETICA: &str =
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";

/// A TrueType font that claims an embedded program and only has widths for the characters of "Helo wrd".
fn subset_fonts() -> Vec<String> {
    let widths: Vec<String> = (32u8..127)
        .map(|c| {
            if "Helo wrd".contains(c as char) {
                "500"
            } else {
                "0"
            }
            .to_owned()
        })
        .collect();
    vec![
        format!(
            "<< /Type /Font /Subtype /TrueType /BaseFont /ABCDEF+Body /Encoding /WinAnsiEncoding /FirstChar 32 /LastChar 126 \
             /Widths [{}] /FontDescriptor 6 0 R >>",
            widths.join(" ")
        ),
        "<< /Type /FontDescriptor /FontName /ABCDEF+Body /FontFile2 7 0 R >>".to_owned(),
        stream("", "not a font program"),
    ]
}

fn text_of(bytes: &[u8]) -> String {
    let doc = prescan::load_untrusted(bytes).unwrap();
    let page = *doc.get_pages().get(&1).unwrap();
    let content = scan::page_content(&doc, page).ok().unwrap();
    let mut scanner = Scanner::new(&doc);
    assert!(scanner
        .scan(
            Target::Page(page),
            &content,
            scan::page_resources(&doc, page),
            [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
            0
        )
        .is_ok());
    scanner
        .units
        .iter()
        .flat_map(|u| u.glyphs.iter())
        .map(|g| match g.kind {
            Kind::Char => g.ch,
            _ => ' ',
        })
        .collect()
}

fn run(bytes: &[u8], old: &str, new: &str) -> SpikeOutcome {
    replace_word(bytes, 0, old, new).unwrap()
}

#[test]
fn std14_font_works_and_reports_width_delta() {
    let file = page_pdf(
        "BT /F1 10 Tf 20 100 Td (Hello world) Tj ET",
        "/Font << /F1 5 0 R >>",
        &[HELVETICA.to_owned()],
    );
    let out = run(&file, "world", "there!");
    assert_eq!(out.outcome, Outcome::Works);
    assert_eq!(text_of(&out.bytes), "Hello there!");
    // Helvetica: "there!" = 278+556+556+333+556+278 = 2557, "world" = 722+556+333+222+556 = 2389 (1/1000 em at 10 pt).
    assert!((out.width_delta - 1.68).abs() < 1e-3, "{}", out.width_delta);
    // The original bytes are a prefix: an incremental update.
    assert!(out.bytes.starts_with(&file));
}

#[test]
fn word_split_over_tj_elements_and_operators() {
    let file = page_pdf(
        "BT /F1 10 Tf 14 TL 20 100 Td [(Hel) -20 (l) 15 (o) -400 (wor)] TJ (ld) Tj ET",
        "/Font << /F1 5 0 R >>",
        &[HELVETICA.to_owned()],
    );
    assert_eq!(run(&file, "Hello", "Howdy").outcome, Outcome::Works);
    let out = run(&file, "world", "earth");
    assert_eq!(out.outcome, Outcome::Works);
    assert_eq!(text_of(&out.bytes), "Hello earth");
}

#[test]
fn missing_glyph_in_subset_falls_back_to_helvetica() {
    let file = page_pdf(
        "BT /F1 12 Tf 20 100 Td (Hello world) Tj ET",
        "/Font << /F1 5 0 R >>",
        &subset_fonts(),
    );
    let same = run(&file, "world", "dlrow");
    assert_eq!(same.outcome, Outcome::Works, "{:?}", same.outcome);
    assert_eq!(text_of(&same.bytes), "Hello dlrow");
    let out = run(&file, "Hello", "Qüß");
    let Outcome::Fallback { reason } = &out.outcome else {
        panic!("{:?}", out.outcome);
    };
    assert!(reason.contains('Q'), "{reason}");
    assert_eq!(text_of(&out.bytes), "Qüß world");
    let doc = prescan::load_untrusted(&out.bytes).unwrap();
    let page = *doc.get_pages().get(&1).unwrap();
    let fonts = doc.get_page_fonts(page).unwrap();
    assert!(fonts.contains_key(&b"SheerHelv"[..]));
    assert!(fonts.contains_key(&b"F1"[..]));
}

#[test]
fn not_embedded_font_that_is_not_standard_falls_back() {
    let file = page_pdf(
        "BT /F1 12 Tf 20 100 Td (Hello) Tj ET",
        "/Font << /F1 5 0 R >>",
        &[
            "<< /Type /Font /Subtype /TrueType /BaseFont /Fancy /Encoding /WinAnsiEncoding >>"
                .to_owned(),
        ],
    );
    let out = run(&file, "Hello", "Howdy");
    assert!(matches!(out.outcome, Outcome::Fallback { .. }));
    assert_eq!(text_of(&out.bytes), "Howdy");
}

#[test]
fn tick_and_double_tick_operators_fall_back_in_place() {
    let file = page_pdf(
        "BT /F1 12 Tf 14 TL 20 100 Td (one) Tj (Hello ' Qx) ' 1 2 (second Hello) \" ET",
        "/Font << /F1 5 0 R >>",
        &subset_fonts(),
    );
    let out = run(&file, "second", "Qq");
    assert!(
        matches!(out.outcome, Outcome::Fallback { .. }),
        "{:?}",
        out.outcome
    );
    assert!(text_of(&out.bytes).contains("Qq Hello"));
}

#[test]
fn composite_identity_h_with_to_unicode() {
    let cmap =
        "/CIDInit begincmap 3 beginbfchar <0001> <0048> <0002> <0069> <0003> <0020> endbfchar \
                1 beginbfrange <0004> <0005> <0061> endbfrange endcmap";
    let more = vec![
        "<< /Type /Font /Subtype /Type0 /BaseFont /ABCDEF+Cid /Encoding /Identity-H /DescendantFonts [6 0 R] /ToUnicode 8 0 R >>".to_owned(),
        "<< /Type /Font /Subtype /CIDFontType2 /BaseFont /ABCDEF+Cid /DW 600 /FontDescriptor 7 0 R /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> >>".to_owned(),
        "<< /Type /FontDescriptor /FontName /ABCDEF+Cid /FontFile2 9 0 R >>".to_owned(),
        stream("", cmap),
        stream("", "not a font program"),
    ];
    let file = page_pdf(
        "BT /F1 10 Tf 20 100 Td <000100020003000400050004> Tj ET",
        "/Font << /F1 5 0 R >>",
        &more,
    );
    assert_eq!(text_of(&file), "Hi aba");
    let works = run(&file, "aba", "bab");
    assert_eq!(works.outcome, Outcome::Works, "{:?}", works.outcome);
    assert_eq!(text_of(&works.bytes), "Hi bab");
    let out = run(&file, "aba", "xyz");
    assert!(matches!(out.outcome, Outcome::Fallback { .. }));
    assert_eq!(text_of(&out.bytes), "Hi xyz");
}

#[test]
fn word_in_a_form_xobject_is_replaced_in_the_form() {
    let more = vec![
        HELVETICA.to_owned(),
        stream(
            "/Type /XObject /Subtype /Form /BBox [0 0 300 200] /Resources << /Font << /F1 5 0 R >> >>",
            "BT /F1 10 Tf 20 100 Td (Inside the form) Tj ET",
        ),
    ];
    let file = page_pdf(
        "q 1 0 0 1 0 0 cm /X1 Do Q",
        "/XObject << /X1 6 0 R >>",
        &more,
    );
    let out = run(&file, "form", "frame");
    assert_eq!(out.outcome, Outcome::Works);
    let doc = prescan::load_untrusted(&out.bytes).unwrap();
    let Ok(Object::Stream(form)) = doc.get_object((6, 0)) else {
        panic!("form");
    };
    let data = form.decompressed_content().unwrap();
    assert!(String::from_utf8_lossy(&data).contains("frame"));
}

#[test]
fn impossible_cases() {
    let std = [HELVETICA.to_owned()];
    let res = "/Font << /F1 5 0 R >>";
    let invisible = page_pdf("BT /F1 10 Tf 3 Tr 20 100 Td (Hello) Tj ET", res, &std);
    assert!(matches!(
        run(&invisible, "Hello", "Howdy").outcome,
        Outcome::Impossible { .. }
    ));
    let plain = page_pdf("BT /F1 10 Tf 20 100 Td (Hello) Tj ET", res, &std);
    assert!(matches!(
        run(&plain, "Nope", "x").outcome,
        Outcome::Impossible { .. }
    ));
    let type3 = page_pdf(
        "BT /F1 10 Tf 20 100 Td (Hello) Tj ET",
        res,
        &["<< /Type /Font /Subtype /Type3 /FontBBox [0 0 1 1] /FontMatrix [1 0 0 1 0 0] /CharProcs << >> /Encoding << /Type /Encoding /Differences [72 /H] >> >>".to_owned()],
    );
    let out = run(&type3, "Hello", "Howdy");
    let Outcome::Impossible { reason } = &out.outcome else {
        panic!("{:?}", out.outcome);
    };
    assert!(reason.contains("Type3"), "{reason}");
    assert!(out.bytes.is_empty());
}

#[test]
fn character_without_helvetica_glyph_is_impossible() {
    let file = page_pdf(
        "BT /F1 10 Tf 20 100 Td (Hello) Tj ET",
        "/Font << /F1 5 0 R >>",
        &subset_fonts(),
    );
    assert!(matches!(
        run(&file, "Hello", "\u{4e2d}").outcome,
        Outcome::Impossible { .. }
    ));
}

#[test]
fn hostile_inputs_do_not_panic() {
    // A form that draws itself.
    let more = vec![
        HELVETICA.to_owned(),
        stream(
            "/Type /XObject /Subtype /Form /BBox [0 0 1 1] /Resources << /XObject << /X1 6 0 R >> >>",
            "/X1 Do",
        ),
    ];
    let file = page_pdf("/X1 Do", "/XObject << /X1 6 0 R >>", &more);
    assert!(matches!(
        run(&file, "a", "b").outcome,
        Outcome::Impossible { .. }
    ));
    // Garbage and bad arguments.
    assert!(replace_word(b"not a pdf", 0, "a", "b").is_err());
    let plain = page_pdf("BT (x) Tj", "", &[]);
    assert!(replace_word(&plain, 7, "a", "b").is_err());
    assert!(replace_word(&plain, 0, "", "b").is_err());
    assert!(replace_word(&plain, 0, "a", "b\u{0}").is_err());
    // Unbalanced state operators and a missing font.
    let odd = page_pdf("Q Q BT /Nope 9 Tf (abc) Tj ET q q q", "", &[]);
    assert!(matches!(
        run(&odd, "abc", "x").outcome,
        Outcome::Impossible { .. }
    ));
}

fn content_of(bytes: &[u8]) -> String {
    let doc = prescan::load_untrusted(bytes).unwrap();
    let page = *doc.get_pages().get(&1).unwrap();
    String::from_utf8_lossy(&scan::page_content(&doc, page).ok().unwrap()).into_owned()
}

#[test]
fn relative_td_after_the_word_moves_with_it_and_the_next_line_stays() {
    // "Hello" -> "Hi": the line gets shorter; the continuation set by Td moves, the next line (also a Td) does not.
    let file = page_pdf(
        "BT /F1 10 Tf 14 TL 20 100 Td (Hello world) Tj 80 0 Td (more) Tj -80 -14 Td (next) Tj ET",
        "/Font << /F1 5 0 R >>",
        &[HELVETICA.to_owned()],
    );
    let out = run(&file, "Hello", "Hi");
    assert_eq!(out.outcome, Outcome::Works);
    assert!(out.width_delta < 0.0);
    let text = content_of(&out.bytes);
    // Hello = 722+556+222+222+556 = 2278, Hi = 722+222 = 944: delta -13.34 at 10 pt.
    assert!(text.contains("66.6"), "{text}");
    assert!(text.contains("-66.6") || text.contains("-66.7"), "{text}");
    assert!(out.notes.iter().any(|n| n.contains("moved")));
}

#[test]
fn absolute_tm_runs_on_the_line_move_with_the_word() {
    let file = page_pdf(
        "BT /F1 10 Tf 1 0 0 1 20 100 Tm (Hello) Tj 1 0 0 1 80 100 Tm (world) Tj ET",
        "/Font << /F1 5 0 R >>",
        &[HELVETICA.to_owned()],
    );
    let out = run(&file, "Hello", "Hi");
    assert!(
        content_of(&out.bytes).contains("66.6"),
        "{}",
        content_of(&out.bytes)
    );
}

#[test]
fn kerns_inside_the_old_word_are_dropped() {
    let file = page_pdf(
        "BT /F1 10 Tf 20 100 Td [(H) 40 (e) 50 (llo) -250 (world)] TJ ET",
        "/Font << /F1 5 0 R >>",
        &[HELVETICA.to_owned()],
    );
    let out = run(&file, "Hello", "Hi");
    let text = content_of(&out.bytes);
    assert!(text.contains("[(Hi)()() -250(world)] TJ"), "{text}");
}

#[test]
fn bold_original_gets_helvetica_bold() {
    let more = vec![
        "<< /Type /Font /Subtype /TrueType /BaseFont /Fancy-Bold /Encoding /WinAnsiEncoding >>"
            .to_owned(),
    ];
    let file = page_pdf(
        "BT /F1 12 Tf 20 100 Td (Hello) Tj ET",
        "/Font << /F1 5 0 R >>",
        &more,
    );
    let out = run(&file, "Hello", "Howdy");
    let doc = prescan::load_untrusted(&out.bytes).unwrap();
    let page = *doc.get_pages().get(&1).unwrap();
    let fonts = doc.get_page_fonts(page).unwrap();
    let bold = fonts.get(&b"SheerHelvB"[..]).unwrap();
    assert_eq!(
        bold.get(b"BaseFont").unwrap().as_name().unwrap(),
        b"Helvetica-Bold"
    );
}

#[test]
fn a_longer_word_before_a_close_run_is_squeezed() {
    let file = page_pdf(
        "BT /F1 10 Tf 1 0 0 1 20 100 Tm (Hi) Tj ET BT /F1 10 Tf 1 0 0 1 130 100 Tm (next) Tj ET",
        "/Font << /F1 5 0 R >>",
        &[HELVETICA.to_owned()],
    );
    let out = run(&file, "Hi", "Hooooooooooooooooooooooooo");
    assert!(
        out.notes
            .iter()
            .any(|n| n.contains("Tz") || n.contains("overflow")),
        "{:?}",
        out.notes
    );
    assert!(content_of(&out.bytes).contains("Tz"));
}

#[test]
fn oversized_string_stops_at_the_glyph_cap() {
    // 5 000 strings of 1 000 codes: more than the cap of 3 000 000 glyphs.
    let body = "a".repeat(1000);
    let mut content = String::from("BT /F1 1 Tf ");
    for _ in 0..3100 {
        content.push_str(&format!("({body}) Tj "));
    }
    content.push_str("ET");
    let file = page_pdf(&content, "/Font << /F1 5 0 R >>", &[HELVETICA.to_owned()]);
    let out = run(&file, "zzz", "b");
    let Outcome::Impossible { reason } = &out.outcome else {
        panic!("{:?}", out.outcome);
    };
    assert!(reason.contains("glyphs"), "{reason}");
}
