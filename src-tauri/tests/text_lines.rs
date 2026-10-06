//! The walker and the line builder of text editing (ADR-125, ARCHITECTURE §13.1 and §13.2) on documents generated here: glyph positions
//! from the text state, forms read-only, budgets, lines by geometry whatever the order of the content stream, paragraphs, and the
//! probe that maps a UTF-16 unit of the text layer to a line. No PDFium needed: the characters PDFium would report are made from the
//! walker's own glyphs.

#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use sheer_lib::error::{AppError, ErrorCode};
use sheer_lib::model::text_edit::{CharGeom, LineEditable, TextEditRefusal};
use sheer_lib::pdfwrite::ops_walk::{Budget, Run, WalkSink};
use sheer_lib::pdfwrite::text_io::{PageDoc, PageRef};
use sheer_lib::pdfwrite::text_lines::{self, Align};
use support::PdfBuilder;

#[derive(Default)]
struct Collect {
    runs: Vec<Run>,
    objects: Vec<[f64; 4]>,
}

impl WalkSink for Collect {
    fn run(&mut self, run: Run) -> Result<(), AppError> {
        self.runs.push(run);
        Ok(())
    }

    fn object(&mut self, bbox: [f64; 4]) {
        self.objects.push(bbox);
    }
}

/// A one-page document: Helvetica as `/F1`, `content` as the page's stream, and `forms` as `/Fm1`, `/Fm2`, ... (each may draw the others).
fn build(content: &str, forms: &[&str]) -> (PageDoc, PageRef) {
    let mut b = PdfBuilder::new();
    b.object(1, "<< /Type /Catalog /Pages 2 0 R >>")
        .object(2, "<< /Type /Pages /Kids [4 0 R] /Count 1 >>")
        .object(
            3,
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
        );
    let mut xobjects = String::new();
    for (n, body) in forms.iter().enumerate() {
        let id = 10 + n as u32;
        xobjects.push_str(&format!("/Fm{} {} 0 R ", n + 1, id));
        b.stream(
            id,
            "/Type /XObject /Subtype /Form /BBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> /XObject << /Fm1 10 0 R /Fm2 11 0 R >> >>",
            body.as_bytes(),
        );
    }
    b.object(
        4,
        &format!(
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 5 0 R \
             /Resources << /Font << /F1 3 0 R >> /XObject << {xobjects}>> >> >>"
        ),
    );
    b.stream(5, "", content.as_bytes());
    let doc = PageDoc::load(&b.finish(1)).unwrap();
    let page = doc.pages()[0];
    (doc, page)
}

fn runs_of(content: &str) -> Vec<Run> {
    let (doc, page) = build(content, &[]);
    let mut sink = Collect::default();
    doc.walk(page, &mut Budget::new(), &mut sink).unwrap();
    sink.runs
}

fn near(a: f64, b: f64) -> bool {
    (a - b).abs() < 0.01
}

/// The characters PDFium would report for the glyphs of `doc`'s page, in the order of the walk, with a generated space after each run
/// when `spaces` says so.
fn chars_of(doc: &PageDoc, page: PageRef, spaces: bool) -> Vec<CharGeom> {
    let mut sink = Collect::default();
    doc.walk(page, &mut Budget::new(), &mut sink).unwrap();
    let mut out = Vec::new();
    let mut unit = 0u32;
    for run in &sink.runs {
        for g in &run.glyphs {
            out.push(CharGeom {
                utf16: unit,
                unicode: g.code,
                origin: [g.origin[0] as f32, g.origin[1] as f32],
                size: g.size_eff as f32,
                generated: false,
            });
            unit += 1;
        }
        if spaces {
            let last = run.glyphs.last().unwrap();
            out.push(CharGeom {
                utf16: unit,
                unicode: 0x20,
                origin: [(last.origin[0] + last.adv) as f32, last.origin[1] as f32],
                size: last.size_eff as f32,
                generated: true,
            });
            unit += 1;
        }
    }
    out
}

#[test]
fn glyphs_are_placed_by_the_text_state_and_carry_their_byte_ranges() {
    // Helvetica 10 pt: A and B are 667 wide, C is 722, a is 556.
    let runs = runs_of("BT /F1 10 Tf 100 700 Td (AB) Tj 0 -12 Td [(C) -500 (a)] TJ ET");
    assert_eq!(runs.len(), 2);
    let g = &runs[0].glyphs;
    assert!(near(g[0].origin[0], 100.0) && near(g[0].origin[1], 700.0));
    assert!(near(g[1].origin[0], 106.67) && near(g[0].adv, 6.67));
    assert_eq!((g[0].byte.clone(), g[1].byte.clone()), (0..1, 1..2));
    assert_eq!((g[0].code, g[1].code), (65, 66));
    // The kerning number of the TJ moves `a` by 5 pt; it stays one run, and its bytes continue across the strings of the array.
    let g = &runs[1].glyphs;
    assert_eq!(g.len(), 2);
    assert!(near(g[0].origin[1], 688.0) && near(g[1].origin[0], 100.0 + 7.22 + 5.0));
    assert_eq!(g[1].byte, 1..2);
    assert!(runs[0].ops.start.index < runs[1].ops.start.index);
}

#[test]
fn scaling_rise_spacing_cm_and_the_quote_operators() {
    let runs = runs_of("BT /F1 10 Tf 50 Tz 3 Ts 100 600 Td (A) Tj ET");
    let g = &runs[0].glyphs[0];
    assert!(near(g.adv, 3.335), "Tz halves the advance: {}", g.adv);
    assert!(near(g.origin[1], 603.0), "the rise lifts the origin");
    assert!(near(runs[0].rise, 3.0) && near(runs[0].rise_page, 3.0));
    // `'` moves down by the leading, `"` also sets word and character spacing.
    let runs = runs_of("BT /F1 10 Tf 12 TL 100 500 Td (A) Tj (B) ' 1 2 (A B) \" ET");
    assert_eq!(runs.len(), 3);
    assert!(near(runs[1].glyphs[0].origin[1], 488.0));
    let third = &runs[2].glyphs;
    assert!(near(third[0].origin[1], 476.0));
    // Character spacing 2 and word spacing 1 (on the space only): A advances 6.67 + 2.
    assert!(near(third[1].origin[0] - third[0].origin[0], 8.67));
    assert!(near(
        third[2].origin[0] - third[1].origin[0],
        2.78 + 2.0 + 1.0
    ));
    // A CTM scales both the position and the size.
    let runs = runs_of("q 2 0 0 2 10 10 cm BT /F1 10 Tf 5 5 Td (A) Tj ET Q");
    let g = &runs[0].glyphs[0];
    assert!(near(g.origin[0], 20.0) && near(g.origin[1], 20.0));
    assert!(near(g.size_eff, 20.0) && near(g.adv, 13.34));
    // A rotated text matrix gives the direction.
    let runs = runs_of("BT /F1 10 Tf 0 1 -1 0 300 300 Tm (AB) Tj ET");
    let g = &runs[0].glyphs;
    assert!(near(g[0].dir[0], 0.0) && near(g[0].dir[1], 1.0));
    assert!(near(g[1].origin[0], 300.0) && near(g[1].origin[1], 306.67));
}

#[test]
fn a_big_gap_or_a_state_change_ends_a_run() {
    let runs = runs_of("BT /F1 10 Tf 100 700 Td [(A) -5000 (B)] TJ ET");
    assert_eq!(runs.len(), 2, "a 50 pt gap is two runs");
    let runs = runs_of("BT /F1 10 Tf 100 700 Td (A) Tj 1 Tc (B) Tj ET");
    assert_eq!(runs.len(), 2, "Tc is a state change");
    let runs = runs_of("BT /F1 10 Tf 100 700 Td (A) Tj (B) Tj ET");
    assert_eq!(runs.len(), 1, "two show operators in a row are one run");
    assert_eq!(runs[0].glyphs[1].op.index, runs[0].ops.end.index - 1);
}

#[test]
fn render_mode_clips_and_actual_text_are_reported() {
    let runs = runs_of("BT /F1 10 Tf 3 Tr 100 700 Td (OCR) Tj ET");
    assert_eq!(runs[0].render_mode, 3);
    // A page-wide clip does not cut the text; a small one that does not contain it does.
    let runs = runs_of("0 0 612 792 re W n BT /F1 10 Tf 100 700 Td (in) Tj ET");
    assert!(!runs[0].clipped);
    let runs = runs_of("0 0 50 50 re W n BT /F1 10 Tf 100 700 Td (out) Tj ET");
    assert!(runs[0].clipped);
    let runs = runs_of("q 90 690 60 30 re W n BT /F1 10 Tf 100 700 Td (in) Tj ET Q BT /F1 10 Tf 100 600 Td (free) Tj ET");
    assert!(!runs[0].clipped, "a clip around the text is no cut");
    assert!(!runs[1].clipped, "Q ends the clip");
    let runs = runs_of(
        "/Span << /ActualText (x) >> BDC BT /F1 10 Tf 100 700 Td (a) Tj ET EMC BT /F1 10 Tf 100 600 Td (b) Tj ET",
    );
    assert!(runs[0].clipped && !runs[1].clipped);
}

#[test]
fn forms_are_read_only_runs_and_cycles_end() {
    let (doc, page) = build(
        "BT /F1 10 Tf 10 10 Td (page) Tj ET q 1 0 0 1 100 200 cm /Fm1 Do Q",
        &[
            "BT /F1 10 Tf 5 5 Td (form) Tj ET /Fm2 Do",
            "BT /F1 10 Tf 0 0 Td (deep) Tj ET /Fm1 Do",
        ],
    );
    let mut sink = Collect::default();
    doc.walk(page, &mut Budget::new(), &mut sink).unwrap();
    assert_eq!(sink.runs.len(), 3, "page, form 1, form 2; the cycle is cut");
    assert!(!sink.runs[0].in_form);
    let form = &sink.runs[1];
    assert!(form.in_form && form.ops.start.stream == u32::MAX);
    assert!(near(form.glyphs[0].origin[0], 105.0) && near(form.glyphs[0].origin[1], 205.0));
    assert!(sink.runs[2].in_form);
}

#[test]
fn images_and_paths_are_objects() {
    let (doc, page) = build(
        "q 50 0 0 40 10 20 cm BI /W 1 /H 1 /BPC 8 /CS /G ID x EI Q 10 10 20 20 re f",
        &[],
    );
    let mut sink = Collect::default();
    doc.walk(page, &mut Budget::new(), &mut sink).unwrap();
    assert!(sink
        .objects
        .iter()
        .any(|b| near(b[2], 30.0) && near(b[3], 30.0)));
}

#[test]
fn the_budgets_and_the_state_depth_are_limits() {
    let (doc, page) = build("BT /F1 10 Tf 0 0 Td (abcdef) Tj ET", &[]);
    let mut sink = Collect::default();
    let error = doc
        .walk(
            page,
            &mut Budget {
                ops: 5,
                bytes: 1 << 20,
            },
            &mut sink,
        )
        .unwrap_err();
    assert_eq!(error.code(), ErrorCode::LimitExceeded);
    let error = doc
        .walk(
            page,
            &mut Budget {
                ops: 1000,
                bytes: 4,
            },
            &mut sink,
        )
        .unwrap_err();
    assert_eq!(error.code(), ErrorCode::LimitExceeded);
    let deep = "q ".repeat(600);
    let (doc, page) = build(&deep, &[]);
    let error = doc
        .walk(page, &mut Budget::new(), &mut Collect::default())
        .unwrap_err();
    assert_eq!(error.code(), ErrorCode::LimitExceeded);
    let (doc, page) = build(&"q ".repeat(512), &[]);
    doc.walk(page, &mut Budget::new(), &mut Collect::default())
        .unwrap();
}

#[test]
fn content_that_does_not_parse_is_invalid() {
    let (doc, page) = build("BT /F1 10 Tf (unterminated Tj", &[]);
    let error = doc
        .walk(page, &mut Budget::new(), &mut Collect::default())
        .unwrap_err();
    assert_eq!(error.code(), ErrorCode::InvalidArgument);
}

#[test]
fn lines_follow_the_geometry_not_the_order_of_the_stream() {
    // The footer is drawn first, right to left; a line of two pieces is drawn right piece first.
    let content = "BT /F1 10 Tf 300 50 Td (Page 2) Tj ET \
                   BT /F1 10 Tf 72 50 Td (Form 08) Tj ET \
                   BT /F1 10 Tf 97 600 Td (world) Tj ET \
                   BT /F1 10 Tf 72 600 Td (Hello) Tj ET \
                   BT /F1 10 Tf 72 700 Td (Title) Tj ET";
    let (doc, page) = build(content, &[]);
    let page_lines = doc.lines(page, &[]).unwrap();
    let texts: Vec<&str> = page_lines.lines.iter().map(|l| l.text.as_str()).collect();
    assert_eq!(texts, ["Title", "Hello world", "Form 08", "Page 2"]);
    assert_eq!(page_lines.lines[1].runs.len(), 2);
    assert_eq!(page_lines.lines[1].index, 1);
    // The footer pieces are far apart: two lines, and the room after the first is what lies between them by geometry.
    let room = page_lines.room_after(2).unwrap();
    assert!((room - (300.0 - 72.0 - 37.23)).abs() < 0.1, "{room}");
    assert!(page_lines.room_after(3).is_none());
    assert!(page_lines.room_after(0).is_none());
}

#[test]
fn a_footer_drawn_first_does_not_disturb_paragraphs_probe_or_order() {
    // Form footer and page number come first in the stream, then the body bottom-up, one line drawn right to left.
    let footer_first = "BT /F1 8 Tf 500 40 Td (Page 1) Tj ET BT /F1 8 Tf 72 40 Td (Form 08/2020) Tj ET \
                        BT /F1 10 Tf 12 TL 72 600 Td (first line) Tj T* (second line) Tj T* (third line) Tj ET \
                        BT /F1 16 Tf 72 700 Td (Heading) Tj ET";
    let natural = "BT /F1 16 Tf 72 700 Td (Heading) Tj ET \
                   BT /F1 10 Tf 12 TL 72 600 Td (first line) Tj T* (second line) Tj T* (third line) Tj ET \
                   BT /F1 8 Tf 72 40 Td (Form 08/2020) Tj ET BT /F1 8 Tf 500 40 Td (Page 1) Tj ET";
    let (doc, page) = build(footer_first, &[]);
    let chars = chars_of(&doc, page, true);
    let a = doc.lines(page, &chars).unwrap();
    let (doc2, page2) = build(natural, &[]);
    let b = doc2.lines(page2, &chars_of(&doc2, page2, true)).unwrap();
    let texts = |p: &text_lines::PageLines| -> Vec<String> {
        p.lines.iter().map(|l| l.text.clone()).collect()
    };
    assert_eq!(
        texts(&a),
        [
            "Heading",
            "first line",
            "second line",
            "third line",
            "Form 08/2020",
            "Page 1"
        ]
    );
    assert_eq!(texts(&a), texts(&b));
    let paragraph_of =
        |p: &text_lines::PageLines| -> Vec<u32> { p.lines.iter().map(|l| l.paragraph).collect() };
    assert_eq!(paragraph_of(&a), paragraph_of(&b));
    assert_eq!(a.paragraphs.len(), 4);
    assert_eq!(a.paragraphs[1].lines, 1..4);
    // A click in the footer reaches the footer line, not a body line.
    let footer_unit = chars
        .iter()
        .find(|c| c.origin[1] < 60.0 && c.origin[0] < 100.0)
        .map(|c| c.utf16)
        .unwrap();
    let info = text_lines::probe(&a, &chars, footer_unit).unwrap();
    assert_eq!(info.key.line, 4);
}

#[test]
fn a_superscript_stays_on_its_line_and_text_in_other_sizes_does_not_merge_away() {
    let content = "BT /F1 10 Tf 72 700 Td (E=mc) Tj /F1 6 Tf 4 Ts (2) Tj ET";
    let (doc, page) = build(content, &[]);
    let page_lines = doc.lines(page, &[]).unwrap();
    assert_eq!(page_lines.lines.len(), 1);
    assert_eq!(page_lines.lines[0].runs.len(), 2);
}

#[test]
fn the_text_of_a_line_is_what_pdfium_says_and_the_probe_maps_by_geometry() {
    let content = "BT /F1 10 Tf 72 700 Td (Hello) Tj ET BT /F1 10 Tf 72 600 Td (World) Tj ET";
    let (doc, page) = build(content, &[]);
    let chars = chars_of(&doc, page, true);
    let page_lines = doc.lines(page, &chars).unwrap();
    assert_eq!(page_lines.lines.len(), 2);
    assert_eq!(page_lines.lines[0].text, "Hello");
    assert_eq!(page_lines.lines[1].text, "World");
    assert_eq!(page_lines.lines[0].font_name, "Helvetica");
    assert!(!page_lines.lines[0].embedded);
    assert!((page_lines.lines[0].size - 10.0).abs() < 0.01);
    // The box is in the UI's page space: top-left, y down, so a line at y = 700 of 792 is near the top.
    let b = page_lines.lines[0].bounds;
    assert!((b.x - 72.0).abs() < 0.1 && b.y > 80.0 && b.y < 95.0 && b.w > 20.0);
    // Unit 1 is the `e` of Hello, unit 8 the `o` of World (Hello, a generated space, then World).
    assert_eq!(
        text_lines::probe(&page_lines, &chars, 1).unwrap().key.line,
        0
    );
    assert_eq!(
        text_lines::probe(&page_lines, &chars, 8).unwrap().key.line,
        1
    );
    // The generated space belongs to the character before it.
    let info = text_lines::probe(&page_lines, &chars, 5).unwrap();
    assert_eq!((info.key.line, info.text.as_str()), (0, "Hello"));
    // A character that no glyph is near is unmapped, and so is a unit past the text.
    let mut far = chars.clone();
    far[2].origin = [400.0, 400.0];
    let info = text_lines::probe(&page_lines, &far, 2).unwrap();
    assert_eq!(
        info.editable,
        LineEditable::No {
            reason: TextEditRefusal::Unmapped
        }
    );
}

#[test]
fn a_line_that_no_character_reaches_is_unmapped() {
    let content = "BT /F1 10 Tf 72 700 Td (Hello) Tj ET BT /F1 10 Tf 72 600 Td (Ghost) Tj ET";
    let (doc, page) = build(content, &[]);
    let all = chars_of(&doc, page, false);
    let chars: Vec<CharGeom> = all.into_iter().filter(|c| c.origin[1] > 650.0).collect();
    let page_lines = doc.lines(page, &chars).unwrap();
    assert_eq!(
        page_lines.lines[1].editable,
        LineEditable::No {
            reason: TextEditRefusal::Unmapped
        }
    );
    assert_ne!(
        page_lines.lines[0].editable,
        LineEditable::No {
            reason: TextEditRefusal::Unmapped
        }
    );
}

#[test]
fn glyphs_closer_than_the_match_radius_keep_their_order() {
    // Bold by overprint: the same position drawn twice with different letters is not a case anyone writes, but two glyphs closer than
    // the match radius are: `i` and `l` at 10 pt are 2.2 pt apart.
    let content = "BT /F1 10 Tf 72 700 Td (il) Tj ET";
    let (doc, page) = build(content, &[]);
    let chars = chars_of(&doc, page, false);
    let page_lines = doc.lines(page, &chars).unwrap();
    assert_eq!(page_lines.lines[0].text, "il");
}

#[test]
fn paragraphs_group_lines_by_font_step_and_edge_and_detect_justification() {
    // Four lines of 12 pt steps; the first three have their right edge at the same place with different word gaps.
    let content = "BT /F1 10 Tf 12 TL 100 700 Td 0 Tw (aaa bbb ddd) Tj T* 2.78 Tw (aaaaa bbbb) Tj T* (aaaaaaaa b) Tj T* 0 Tw (aa) Tj ET \
                   BT /F1 10 Tf 100 600 Td (Another paragraph far below) Tj ET \
                   BT /F1 18 Tf 100 570 Td (Heading) Tj ET";
    let (doc, page) = build(content, &[]);
    let page_lines = doc.lines(page, &chars_of(&doc, page, false)).unwrap();
    assert_eq!(page_lines.lines.len(), 6);
    assert_eq!(page_lines.paragraphs.len(), 3);
    let first = &page_lines.paragraphs[0];
    assert_eq!(first.lines, 0..4);
    assert_eq!(first.align, Align::Left);
    assert!(first.justified);
    assert!(!page_lines.paragraphs[1].justified);
    assert_eq!(page_lines.lines[4].paragraph, 1);
    assert_eq!(page_lines.lines[5].paragraph, 2);
}

#[test]
fn right_aligned_lines_are_one_paragraph() {
    let content = "BT /F1 10 Tf 12 TL 200 700 Td (a) Tj ET \
                   BT /F1 10 Tf 194.44 688 Td (aa) Tj ET \
                   BT /F1 10 Tf 188.88 676 Td (aaa) Tj ET";
    let (doc, page) = build(content, &[]);
    let page_lines = doc.lines(page, &[]).unwrap();
    assert_eq!(page_lines.paragraphs.len(), 1);
    assert_eq!(page_lines.paragraphs[0].align, Align::Right);
}
