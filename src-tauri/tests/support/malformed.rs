//! The hostile corpus: small PDFs that are wrong in one way each (cut short, a loop in the structure, a number that is far too big,
//! a stream that grows a thousandfold, a font that is noise, a link that asks for a program). `tests/fuzz_corpus.rs` opens every one
//! of them and asks for everything the viewer asks for; the answer may be a document, or a typed error, but never a panic or a
//! hang (SECURITY P5, ORCHESTRATOR 13.3). The files under `tests/fixtures/malformed/` are these, written out.
//!
//! Most are a good file with one thing broken, built with [`PdfBuilder`] (whose cross-reference table is right, so the damage is in the
//! object, not in the file layout); the ones about the layout (a missing trailer, offsets that point nowhere) are cut or patched from
//! the good file's bytes.

use super::fixtures::{add_pages, Page};
use super::{text_line, PdfBuilder};

/// A one-page document whose page has `page_extra` in its dictionary and `content` as its content stream. `more` adds objects
/// (ids 20 and up are free for them); the catalog gets `catalog_extra`.
fn build(
    page_extra: &str,
    content: &str,
    catalog_extra: &str,
    more: impl FnOnce(&mut PdfBuilder),
) -> Vec<u8> {
    let mut builder = PdfBuilder::new();
    add_pages(&mut builder, &[Page::new(content).with(page_extra)]);
    builder.object(
        1,
        &format!("<< /Type /Catalog /Pages 2 0 R {catalog_extra} >>"),
    );
    more(&mut builder);
    builder.finish(1)
}

/// The start of every hand-made document: a catalog, a page tree of one page (object 10) whose content stream is object 11, with
/// the page's `/Resources` as given. The caller adds objects 11 and up and finishes.
fn skeleton(resources: &str) -> PdfBuilder {
    let mut builder = PdfBuilder::new();
    builder.object(1, "<< /Type /Catalog /Pages 2 0 R >>");
    builder.object(2, "<< /Type /Pages /Kids [10 0 R] /Count 1 >>");
    builder.object(
        10,
        &format!(
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 11 0 R /Resources << {resources} >> >>"
        ),
    );
    builder
}

/// The length of the content stream of [`good`], which a few files patch.
fn good_content() -> String {
    text_line(18, 72, 700, "Hello")
}

/// A good document with a line of text on it.
fn good() -> Vec<u8> {
    build("", &good_content(), "", |_| {})
}

/// A page whose content stream is `content` as it is, with nothing else wrong.
fn with_content(content: &str) -> Vec<u8> {
    build("", content, "", |_| {})
}

/// A deflate stream (inside a zlib wrapper) that says one byte and then repeats it `repeats` times 258 bytes at a time: a few
/// kilobytes that expand to hundreds of times as much. The block is a single "fixed Huffman" one, written by hand, because a test
/// is no place for a compression crate.
fn flate_bomb(repeats: usize) -> Vec<u8> {
    let mut bits = BitWriter::default();
    // BFINAL = 1, BTYPE = 01 (fixed codes).
    bits.push(1, 1);
    bits.push(1, 2);
    // The literal 'A' (0x41): codes 0..=143 are 8 bits, 0x30 + value, most significant bit first.
    bits.push_msb(0x30 + 0x41, 8);
    for _ in 0..repeats {
        // Length 258 is symbol 285 (8 bits, 11000101), distance 1 is code 0 (5 bits).
        bits.push_msb(0b1100_0101, 8);
        bits.push_msb(0, 5);
    }
    // End of block, symbol 256: seven zero bits.
    bits.push_msb(0, 7);
    let mut out = vec![0x78, 0x9C];
    out.extend(bits.finish());
    // A wrong Adler-32 on purpose: a reader that insists on it stops, a reader that does not goes on.
    out.extend_from_slice(&[0, 0, 0, 1]);
    out
}

#[derive(Default)]
struct BitWriter {
    bytes: Vec<u8>,
    used: u8,
}

impl BitWriter {
    /// `count` bits of `value`, least significant first (how deflate packs numbers).
    fn push(&mut self, value: u32, count: u8) {
        for bit in 0..count {
            self.bit((value >> bit) & 1 == 1);
        }
    }

    /// `count` bits of `value`, most significant first (how deflate packs Huffman codes).
    fn push_msb(&mut self, value: u32, count: u8) {
        for bit in (0..count).rev() {
            self.bit((value >> bit) & 1 == 1);
        }
    }

    fn bit(&mut self, set: bool) {
        if self.used == 0 {
            self.bytes.push(0);
        }
        if set {
            if let Some(last) = self.bytes.last_mut() {
                *last |= 1 << self.used;
            }
        }
        self.used = (self.used + 1) % 8;
    }

    fn finish(self) -> Vec<u8> {
        self.bytes
    }
}

/// Replaces the first `from` in `bytes` with `to` (which may be shorter or longer).
fn replace(bytes: &[u8], from: &str, to: &str) -> Vec<u8> {
    let from = from.as_bytes();
    let Some(at) = bytes.windows(from.len()).position(|window| window == from) else {
        panic!("{} is not in the file", String::from_utf8_lossy(from));
    };
    let mut out = bytes[..at].to_vec();
    out.extend_from_slice(to.as_bytes());
    out.extend_from_slice(&bytes[at + from.len()..]);
    out
}

/// Where `needle` first occurs in `bytes`.
fn find(bytes: &[u8], needle: &str) -> usize {
    bytes
        .windows(needle.len())
        .position(|window| window == needle.as_bytes())
        .unwrap_or(0)
}

/// A page with link annotations, one per `(rect, action)`.
fn with_links(annots: &[(&str, &str)]) -> Vec<u8> {
    let refs: Vec<String> = (0..annots.len())
        .map(|index| format!("{} 0 R", 30 + index))
        .collect();
    build(
        &format!("/Annots [{}]", refs.join(" ")),
        &text_line(18, 72, 700, "links"),
        "",
        |builder| {
            for (index, (rect, action)) in (0u32..).zip(annots) {
                builder.object(
                    30 + index,
                    &format!(
                        "<< /Type /Annot /Subtype /Link /Rect {rect} /Border [0 0 0] /A {action} >>"
                    ),
                );
            }
        },
    )
}

/// An image that is drawn on the page: `dict` is the entries of its dictionary, `data` its bytes.
fn with_image(dict: &str, data: &[u8]) -> Vec<u8> {
    let mut builder = skeleton("/XObject << /Im0 20 0 R >>");
    builder.stream(11, "", b"q 300 0 0 300 50 400 cm /Im0 Do Q\n");
    builder.stream(20, dict, data);
    builder.finish(1)
}

/// A catalog with an AcroForm whose entries are `acroform`.
fn with_form(acroform: &str, more: impl FnOnce(&mut PdfBuilder)) -> Vec<u8> {
    build(
        "",
        &text_line(18, 72, 700, "form"),
        &format!("/AcroForm << {acroform} >>"),
        more,
    )
}

/// A page whose font (object 20) is `font`; the text it shows is `text`.
fn with_font(font: &str, text: &str, more: impl FnOnce(&mut PdfBuilder)) -> Vec<u8> {
    let mut builder = skeleton("/Font << /F1 20 0 R >>");
    builder.stream(
        11,
        "",
        format!("BT /F1 24 Tf 72 700 Td {text} Tj ET").as_bytes(),
    );
    builder.object(20, font);
    more(&mut builder);
    builder.finish(1)
}

/// A page whose content stream (object 11) is `data` with `dict` as its dictionary.
fn with_stream(dict: &str, data: &[u8]) -> Vec<u8> {
    let mut builder = skeleton("");
    builder.stream(11, dict, data);
    builder.finish(1)
}

pub fn all() -> Vec<(&'static str, Vec<u8>)> {
    let good = good();
    let length = format!("/Length {}", good_content().len());
    let mut files: Vec<(&'static str, Vec<u8>)> = Vec::new();
    let mut add = |name: &'static str, bytes: Vec<u8>| files.push((name, bytes));

    // --- the file as a whole -----------------------------------------------------------------------------------------
    add("empty.pdf", Vec::new());
    add("header-only.pdf", b"%PDF-1.7\n".to_vec());
    add("truncated-half.pdf", good[..good.len() / 2].to_vec());
    add("truncated-tail.pdf", good[..good.len() - 30].to_vec());
    add(
        "truncated-in-xref.pdf",
        good[..find(&good, "xref") + 40].to_vec(),
    );
    add(
        "no-startxref.pdf",
        good[..find(&good, "startxref")].to_vec(),
    );
    add("startxref-past-the-end.pdf", {
        let mut bytes = good[..find(&good, "startxref")].to_vec();
        bytes.extend_from_slice(b"startxref\n99999999\n%%EOF\n");
        bytes
    });
    add(
        "xref-offsets-shifted.pdf",
        replace(&good, "xref\n0 ", "xref\n5 "),
    );
    add("xref-prev-loop.pdf", {
        let tail = String::from_utf8_lossy(&good[find(&good, "startxref")..]).into_owned();
        let xref = tail.lines().nth(1).unwrap_or("0").to_owned();
        replace(&good, "/Root 1 0 R", &format!("/Prev {xref} /Root 1 0 R"))
    });
    add("garbage-after-header.pdf", {
        let mut bytes = b"%PDF-1.7\n".to_vec();
        let mut state = 0x2545_F491_u32;
        for _ in 0..3000 {
            state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            bytes.push((state >> 24) as u8);
        }
        bytes
    });
    add("nul-bytes.pdf", {
        let mut bytes = b"%PDF-1.7\n".to_vec();
        bytes.extend(std::iter::repeat_n(0u8, 4096));
        bytes
    });
    add("junk-before-the-header.pdf", {
        let mut bytes = vec![b'x'; 900];
        bytes.extend_from_slice(&good);
        bytes
    });
    add(
        "root-missing.pdf",
        replace(&good, "/Root 1 0 R", "/Root 77 0 R"),
    );
    add(
        "root-is-a-number.pdf",
        PdfBuilder::new().object(1, "42").finish(1),
    );
    add(
        "dictionary-never-closed.pdf",
        PdfBuilder::new()
            .object(
                1,
                "<< /Type /Catalog /Pages 2 0 R /Deep << /A [ << /B (open",
            )
            .finish(1),
    );
    add(
        "object-is-itself.pdf",
        PdfBuilder::new().object(1, "1 0 R").finish(1),
    );
    add(
        "object-ids-enormous.pdf",
        String::from_utf8_lossy(&good)
            .replace("10 0 obj", "4294967295 0 obj")
            .into_bytes(),
    );

    // --- the page tree -----------------------------------------------------------------------------------------------
    add("page-tree-loop.pdf", {
        let mut builder = PdfBuilder::new();
        builder.object(1, "<< /Type /Catalog /Pages 2 0 R >>");
        builder.object(2, "<< /Type /Pages /Kids [2 0 R 3 0 R] /Count 2 >>");
        builder.object(3, "<< /Type /Pages /Parent 2 0 R /Kids [2 0 R] /Count 1 >>");
        builder.finish(1)
    });
    add("page-tree-deep.pdf", {
        let mut builder = PdfBuilder::new();
        builder.object(1, "<< /Type /Catalog /Pages 2 0 R >>");
        for level in 0..300 {
            builder.object(
                2 + level,
                &format!("<< /Type /Pages /Kids [{} 0 R] /Count 1 >>", 3 + level),
            );
        }
        builder.object(
            302,
            "<< /Type /Page /Parent 301 0 R /MediaBox [0 0 100 100] >>",
        );
        builder.finish(1)
    });
    add(
        "page-count-huge.pdf",
        replace(&good, "/Count 1", "/Count 2147483647"),
    );
    add(
        "page-is-its-own-parent.pdf",
        replace(&good, "/Parent 2 0 R", "/Parent 10 0 R"),
    );
    add("contents-array-loop.pdf", {
        let mut builder = PdfBuilder::new();
        builder.object(1, "<< /Type /Catalog /Pages 2 0 R >>");
        builder.object(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
        builder.object(
            3,
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R >>",
        );
        builder.object(4, "[4 0 R 4 0 R 5 0 R]");
        builder.stream(5, "", b"0 0 100 100 re f");
        builder.finish(1)
    });

    // --- sizes and numbers -------------------------------------------------------------------------------------------
    let boxed = |media: &str| build(&format!("/MediaBox {media}"), "0 0 9 9 re f", "", |_| {});
    add(
        "mediabox-enormous.pdf",
        boxed("[0 0 1000000000 1000000000]"),
    );
    add("mediabox-empty.pdf", boxed("[100 100 100 100]"));
    add("mediabox-negative.pdf", boxed("[0 0 -612 -792]"));
    add("mediabox-not-numbers.pdf", boxed("[(a) /b null <</c 1>>]"));
    add("mediabox-float-limit.pdf", boxed("[0 0 3.4e38 3.4e38]"));
    add(
        "rotate-odd.pdf",
        build("/Rotate 2147483647", "0 0 99 99 re f", "", |_| {}),
    );
    add(
        "content-numbers-overflow.pdf",
        with_content(
            "1e999 0 0 1e999 0 0 cm 99999999999999999999 w 0 0 1e30 1e30 re f\n\
             -1e30 -1e30 m 1e30 1e30 l S 0.0000000001 0 0 0.0000000001 0 0 cm 5 5 5 5 re f\n",
        ),
    );
    add(
        "content-operators-garbage.pdf",
        with_content(
            "Q Q Q ET EMC } ] >> 1 2 3 4 5 6 7 8 9 re re re f* b* W n W n Tj ' \" TJ BT BT BT Do /X Do sh /Y sh\n",
        ),
    );
    add(
        "content-unbalanced-q.pdf",
        with_content(&"q ".repeat(6_000)),
    );
    add(
        "content-inline-image-unterminated.pdf",
        with_content("q 100 0 0 100 0 0 cm BI /W 100000 /H 100000 /BPC 8 /CS /RGB ID abcdef"),
    );
    add(
        "content-string-unterminated.pdf",
        with_content("BT /F1 12 Tf (never closed Tj ET <48656c6c6f"),
    );

    // --- streams -----------------------------------------------------------------------------------------------------
    add(
        "stream-flate-bomb.pdf",
        with_stream("/Filter /FlateDecode", &flate_bomb(3000)),
    );
    add(
        "stream-flate-corrupt.pdf",
        with_stream(
            "/Filter /FlateDecode",
            b"\x78\x9c\xff\xff\xff\xff not deflate",
        ),
    );
    add(
        "stream-filter-chain-long.pdf",
        with_stream(
            &format!("/Filter [{}]", "/FlateDecode ".repeat(60)),
            b"0 0 10 10 re f",
        ),
    );
    add(
        "stream-filter-unknown.pdf",
        with_stream(
            "/Filter [/NoSuchDecode /ASCIIHexDecode /JBIG2Decode /JPXDecode /CCITTFaxDecode]",
            b"0 0 10 10 re f",
        ),
    );
    add(
        "stream-length-too-big.pdf",
        replace(&good, &length, "/Length 999999999"),
    );
    add(
        "stream-length-negative.pdf",
        replace(&good, &length, "/Length -5"),
    );

    // --- images ------------------------------------------------------------------------------------------------------
    add(
        "image-dimensions-enormous.pdf",
        with_image(
            "/Type /XObject /Subtype /Image /Width 2147483647 /Height 2147483647 /ColorSpace /DeviceRGB /BitsPerComponent 8",
            &[0; 12],
        ),
    );
    add(
        "image-dimensions-wide.pdf",
        with_image(
            "/Type /XObject /Subtype /Image /Width 400000 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 1",
            &[0xAA; 64],
        ),
    );
    add(
        "image-bits-impossible.pdf",
        with_image(
            "/Type /XObject /Subtype /Image /Width 8 /Height 8 /ColorSpace /DeviceRGB /BitsPerComponent 99",
            &[0; 64],
        ),
    );
    add(
        "image-data-short.pdf",
        with_image(
            "/Type /XObject /Subtype /Image /Width 1000 /Height 1000 /ColorSpace /DeviceRGB /BitsPerComponent 8",
            &[7; 10],
        ),
    );
    add(
        "image-jpeg-noise.pdf",
        with_image(
            "/Type /XObject /Subtype /Image /Width 64 /Height 64 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode",
            b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00\xff\xdb\x00\x43\x00\xff\xc0\x00\x11\x08\xff\xff\xff\xff\x03",
        ),
    );
    add(
        "image-colorspace-loop.pdf",
        with_image(
            "/Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace [/Indexed 20 0 R 255 20 0 R] /BitsPerComponent 8",
            &[0; 4],
        ),
    );

    // --- fonts and text ----------------------------------------------------------------------------------------------
    add(
        "font-file-noise.pdf",
        with_font(
            "<< /Type /Font /Subtype /TrueType /BaseFont /Noise /FirstChar 32 /LastChar 126 /FontDescriptor 21 0 R >>",
            "(Hello world)",
            |builder| {
                builder.object(
                    21,
                    "<< /Type /FontDescriptor /FontName /Noise /Flags 4 /FontFile2 22 0 R /FontBBox [0 0 1000 1000] >>",
                );
                builder.stream(
                    22,
                    "/Length1 400",
                    b"\x00\x01\x00\x00\x00\x20\x01\x00\x00\x04\x00\x10glyf\xff\xff\xff\xff\xff\xff\xff\xff\xff\xff\xff\xff",
                );
            },
        ),
    );
    add(
        "font-type0-without-descendant.pdf",
        with_font(
            "<< /Type /Font /Subtype /Type0 /BaseFont /X /Encoding /Identity-H /DescendantFonts [20 0 R] >>",
            "<00410042>",
            |_| {},
        ),
    );
    add(
        "font-type3-recursive.pdf",
        with_font(
            "<< /Type /Font /Subtype /Type3 /FontBBox [0 0 1 1] /FontMatrix [1 0 0 1 0 0] /CharProcs << /a 21 0 R >> \
             /Encoding << /Type /Encoding /Differences [97 /a] >> /FirstChar 97 /LastChar 97 /Widths [1] \
             /Resources << /Font << /F1 20 0 R >> >> >>",
            "(aaaa)",
            |builder| {
                builder.stream(
                    21,
                    "",
                    b"1 0 0 0 1 1 d1 BT /F1 1 Tf (aaaa) Tj ET 0 0 1 1 re f",
                );
            },
        ),
    );
    add(
        "font-tounicode-garbage.pdf",
        with_font(
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /ToUnicode 21 0 R >>",
            "(Hello)",
            |builder| {
                builder.stream(
                    21,
                    "",
                    b"begincmap 4294967295 beginbfrange <0000> <FFFFFFFF> <D800> endbfrange 99999999 beginbfchar <41> <D83D> endbfchar usecmap begincmap",
                );
            },
        ),
    );

    // --- resources that refer to themselves, forms -----------------------------------------------------------------
    add("form-xobject-calls-itself.pdf", {
        let mut builder = skeleton("/XObject << /Fm0 20 0 R >>");
        builder.stream(11, "", b"/Fm0 Do");
        builder.stream(
            20,
            "/Type /XObject /Subtype /Form /BBox [0 0 612 792] /Resources << /XObject << /Fm0 20 0 R >> >>",
            b"0 0 50 50 re f /Fm0 Do",
        );
        builder.finish(1)
    });
    add("form-xobjects-nested-deep.pdf", {
        let mut builder = skeleton("/XObject << /Fm0 20 0 R >>");
        builder.stream(11, "", b"/Fm0 Do");
        for level in 0..150 {
            builder.stream(
                20 + level,
                &format!(
                    "/Type /XObject /Subtype /Form /BBox [0 0 612 792] /Resources << /XObject << /Fm0 {} 0 R >> >>",
                    21 + level
                ),
                b"0 0 5 5 re f /Fm0 Do",
            );
        }
        builder.stream(
            170,
            "/Type /XObject /Subtype /Form /BBox [0 0 612 792]",
            b"0 0 5 5 re f",
        );
        builder.finish(1)
    });
    add("pattern-uses-itself.pdf", {
        let mut builder = skeleton("/Pattern << /P0 20 0 R >> /ColorSpace << /Cs0 [/Pattern] >>");
        builder.stream(11, "", b"/Cs0 cs /P0 scn 0 0 500 500 re f");
        builder.stream(
            20,
            "/Type /Pattern /PatternType 1 /PaintType 1 /TilingType 1 /BBox [0 0 10 10] /XStep 2 /YStep 2 \
             /Resources << /Pattern << /P0 20 0 R >> /ColorSpace << /Cs0 [/Pattern] >> >>",
            b"/Cs0 cs /P0 scn 0 0 10 10 re f",
        );
        builder.finish(1)
    });
    add(
        "form-fields-loop.pdf",
        with_form("/Fields [30 0 R]", |builder| {
            builder.object(
                30,
                "<< /FT /Tx /T (a) /Kids [30 0 R 31 0 R] /Parent 31 0 R >>",
            );
            builder.object(31, "<< /FT /Tx /T (b) /Kids [30 0 R] /Parent 30 0 R >>");
        }),
    );
    add(
        "form-xfa-not-an-array.pdf",
        with_form("/Fields [] /XFA 42", |_| {}),
    );
    add(
        "form-xfa-stream-garbage.pdf",
        with_form("/Fields [] /XFA 30 0 R", |builder| {
            builder.stream(
                30,
                "/Filter /FlateDecode",
                b"<xdp:xdp xmlns:xdp=\"x\"><template>",
            );
        }),
    );

    // --- links -------------------------------------------------------------------------------------------------------
    add(
        "links-hostile-actions.pdf",
        with_links(&[
            (
                "[10 10 100 40]",
                "<< /S /URI /URI (file:///C:/Windows/System32/calc.exe) >>",
            ),
            ("[10 50 100 80]", "<< /S /URI /URI (javascript:alert(1)) >>"),
            (
                "[10 90 100 120]",
                "<< /S /Launch /F (cmd.exe) /Win << /F (cmd.exe) /P (/c calc) >> >>",
            ),
            (
                "[10 130 100 160]",
                "<< /S /URI /URI (https://bank.example@evil.example/) >>",
            ),
            (
                "[10 170 100 200]",
                "<< /S /JavaScript /JS (app.alert(1)) >>",
            ),
            (
                "[10 210 100 240]",
                "<< /S /GoToR /F (\\\\\\\\server\\\\share\\\\x.pdf) /D [0 /Fit] >>",
            ),
            ("[10 250 100 280]", "<< /S /URI /URI 12345 >>"),
            (
                "[10 290 100 320]",
                "<< /S /URI /URI (mailto:a@b.example?attach=C:/secret.txt) >>",
            ),
        ]),
    );
    add(
        "links-rect-garbage.pdf",
        with_links(&[
            (
                "[1e30 1e30 -1e30 -1e30]",
                "<< /S /URI /URI (https://example.com/) >>",
            ),
            ("[0 0]", "<< /S /URI /URI (https://example.com/) >>"),
            ("(not a rect)", "<< /S /URI /URI (https://example.com/) >>"),
            ("[0 0 0 0]", "<< /S /GoTo /D 999 0 R >>"),
        ]),
    );
    add("links-url-very-long.pdf", {
        let url = format!("(https://example.com/{})", "a".repeat(9000));
        with_links(&[("[10 10 100 40]", &format!("<< /S /URI /URI {url} >>"))])
    });
    add(
        "links-destination-loop.pdf",
        build(
            "/Annots [30 0 R]",
            "",
            "/Names << /Dests 31 0 R >>",
            |builder| {
                builder.object(
                    30,
                    "<< /Type /Annot /Subtype /Link /Rect [0 0 100 100] /Dest (loop) >>",
                );
                builder.object(31, "<< /Kids [31 0 R] /Names [(loop) 31 0 R] >>");
            },
        ),
    );

    // --- encryption, object streams ----------------------------------------------------------------------------------
    add("encrypt-dictionary-nonsense.pdf", {
        let mut builder = skeleton("");
        builder.stream(11, "", b"0 0 9 9 re f");
        builder.object(
            20,
            "<< /Filter /Standard /V 99 /R 99 /Length 100000 /O (x) /U () /P -1 \
             /CF << /StdCF << /CFM /AESV3 /Length -1 >> >> /StmF /StdCF >>",
        );
        builder.trailer("/Encrypt 20 0 R");
        builder.finish(1)
    });
    add("object-stream-count-huge.pdf", {
        let mut builder = PdfBuilder::new();
        builder.object(1, "<< /Type /Catalog /Pages 2 0 R >>");
        builder.object(2, "<< /Type /Pages /Kids [10 0 R] /Count 1 >>");
        builder.object(
            10,
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>",
        );
        builder.stream(
            20,
            "/Type /ObjStm /N 2147483647 /First 2000000000",
            b"1 0 2 5 << /A 1 >> << /B 2 >>",
        );
        builder.finish(1)
    });

    files
}
