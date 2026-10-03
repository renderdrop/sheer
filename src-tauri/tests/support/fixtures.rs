//! The test PDFs. Each function returns the bytes of one file; `all` lists the ones that are committed under `tests/fixtures/`.
//!
//! Layout of every fixture: object 1 is the catalog, 2 the page tree, 3 the font (Helvetica, WinAnsiEncoding), 4 a second font whose
//! code 65 (`A`) is the emoji U+1F600, then the pages from object 10 on (page `i` is object `10 + 2 * i`, its content stream
//! `11 + 2 * i`). A page is US Letter, 612 x 792 pt, unless said otherwise, and the origin of PDF user space is its bottom left
//! corner, so a line at `y = 700` is 92 pt from the top of the page.

use super::{text_line, text_string, PdfBuilder};

/// The font of the text of every fixture.
const FONT: &str =
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
/// A font whose code 65 (`A`) is U+1F600, a character outside the Basic Multilingual Plane (two UTF-16 code units), which the font's
/// `/ToUnicode` map says as the surrogate pair `D83D DE00`.
const EMOJI_FONT: &str =
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding /ToUnicode 5 0 R >>";

/// The `/ToUnicode` map of the emoji font.
const EMOJI_TO_UNICODE: &str = "/CIDInit /ProcSet findresource begin 12 dict begin begincmap\n\
    /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n\
    /CMapName /Adobe-Identity-UCS def /CMapType 2 def\n\
    1 begincodespacerange <00> <FF> endcodespacerange\n\
    1 beginbfchar <41> <D83DDE00> endbfchar\n\
    endcmap CMapName currentdict /CMap defineresource pop end end";

pub fn page_id(index: u32) -> u32 {
    10 + 2 * index
}

/// One page: the entries added to its dictionary (`/CropBox`, `/Rotate`, `/Annots`) and its content stream.
pub struct Page {
    pub extra: String,
    pub content: String,
}

impl Page {
    pub fn new(content: &str) -> Self {
        Self {
            extra: String::new(),
            content: content.to_owned(),
        }
    }

    pub fn with(mut self, extra: &str) -> Self {
        self.extra = extra.to_owned();
        self
    }
}

/// The fonts and the page tree and the pages; the catalog is up to the caller (object 1).
pub fn add_pages(builder: &mut PdfBuilder, pages: &[Page]) {
    builder
        .object(3, FONT)
        .object(4, EMOJI_FONT)
        .stream(5, "", EMOJI_TO_UNICODE.as_bytes());
    let kids: Vec<String> = (0..pages.len() as u32)
        .map(|index| format!("{} 0 R", page_id(index)))
        .collect();
    builder.object(
        2,
        &format!(
            "<< /Type /Pages /Kids [{}] /Count {} >>",
            kids.join(" "),
            pages.len()
        ),
    );
    for (index, page) in (0..).zip(pages) {
        builder.object(
            page_id(index),
            &format!(
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] {} /Contents {} 0 R \
                 /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> >>",
                page.extra,
                page_id(index) + 1
            ),
        );
        builder.stream(page_id(index) + 1, "", page.content.as_bytes());
    }
}

/// `count` pages that say which they are.
fn plain_pages(count: u32) -> Vec<Page> {
    (1..=count)
        .map(|number| Page::new(&text_line(24, 72, 700, &format!("Page {number}"))))
        .collect()
}

// --- the outline ----------------------------------------------------------------------------------------------------

/// A bookmark to write: `title` is a PDF string token (`(Chapter 1)` or `<FEFF...>`), `entries` the rest of its dictionary
/// (`/Dest [...]`, `/A << ... >>`).
pub struct Item {
    pub title: String,
    pub entries: String,
    pub children: Vec<Item>,
}

impl Item {
    pub fn new(title: &str, entries: &str) -> Self {
        Self {
            title: format!("({title})"),
            entries: entries.to_owned(),
            children: Vec::new(),
        }
    }

    pub fn titled(mut self, title_token: String) -> Self {
        self.title = title_token;
        self
    }

    pub fn with(mut self, children: Vec<Item>) -> Self {
        self.children = children;
        self
    }
}

/// Writes the bookmarks as linked objects (`/Parent`, `/Prev`, `/Next`, `/First`, `/Last`) from object `*next_id` on, and returns
/// the ids of the first and the last of this level.
fn write_level(
    builder: &mut PdfBuilder,
    items: &[Item],
    parent: u32,
    next_id: &mut u32,
) -> (u32, u32) {
    let ids: Vec<u32> = items
        .iter()
        .map(|_| {
            let id = *next_id;
            *next_id += 1;
            id
        })
        .collect();
    for (position, item) in items.iter().enumerate() {
        let mut dict = format!(
            "/Title {} /Parent {parent} 0 R {}",
            item.title, item.entries
        );
        if position > 0 {
            dict.push_str(&format!(" /Prev {} 0 R", ids[position - 1]));
        }
        if let Some(next) = ids.get(position + 1) {
            dict.push_str(&format!(" /Next {next} 0 R"));
        }
        if !item.children.is_empty() {
            let (first, last) = write_level(builder, &item.children, ids[position], next_id);
            dict.push_str(&format!(
                " /First {first} 0 R /Last {last} 0 R /Count {}",
                item.children.len()
            ));
        }
        builder.object(ids[position], &format!("<< {dict} >>"));
    }
    (ids[0], ids[items.len() - 1])
}

/// A document with `pages` pages and the outline `items`. The outline root is object 20 (or the first object after the pages, if
/// there are more than four), its bookmarks follow it.
pub fn with_outline(pages: &[Page], items: &[Item]) -> Vec<u8> {
    let mut builder = PdfBuilder::new();
    add_pages(&mut builder, pages);
    let root = (page_id(pages.len() as u32) + 1).max(20);
    let mut next_id = root + 1;
    let (first, last) = write_level(&mut builder, items, root, &mut next_id);
    builder
        .object(
            root,
            &format!(
                "<< /Type /Outlines /First {first} 0 R /Last {last} 0 R /Count {} >>",
                items.len()
            ),
        )
        .object(
            1,
            &format!("<< /Type /Catalog /Pages 2 0 R /Outlines {root} 0 R >>"),
        );
    builder.finish(1)
}

fn dest(page: u32, view: &str) -> String {
    format!("/Dest [{} 0 R {view}]", page_id(page))
}

/// An outline of every shape the UI has to handle. Pages 1 and 2 are plain; page 3 has a crop box that starts at (36, 36) and ends at
/// (576, 756), so its top is 756 and a point at user-space y = 600 is 156 pt from the top of the page.
///
/// ```text
/// Chapter 1                  page 1, XYZ y = 700            -> y = 92
///   Section 1.1              page 2, FitH 500               -> y = 292
///   Section 1.2              page 3, XYZ y = 600 (cropped)  -> y = 156
/// Übersicht – Größe          an action (GoTo), not a /Dest: page 2, XYZ y = 400 -> y = 392
/// Website                    a URI action                   -> no target
/// Other file                 a GoToR action (page 0 of another file) -> no target
/// Not a page                 a /Dest whose "page" is the font -> no target
/// Line<LF>break<RLO>         a title with a line break and a direction override -> "Line break"
/// AAAA...                    a title of 600 characters      -> cut to 512
/// No destination             nothing at all                 -> no target
/// Fit                        page 3, /Fit (no y)            -> y = 0
/// ```
pub fn outline() -> Vec<u8> {
    let pages = vec![
        Page::new(&text_line(24, 72, 700, "Page 1")),
        Page::new(&text_line(24, 72, 700, "Page 2")),
        Page::new(&text_line(24, 72, 700, "Page 3")).with("/CropBox [36 36 576 756]"),
    ];
    let items = vec![
        Item::new("Chapter 1", &dest(0, "/XYZ 72 700 0")).with(vec![
            Item::new("Section 1.1", &dest(1, "/FitH 500")),
            Item::new("Section 1.2", &dest(2, "/XYZ 100 600 0")),
        ]),
        Item::new(
            "",
            &format!("/A << /S /GoTo /D [{} 0 R /XYZ 72 400 null] >>", page_id(1)),
        )
        .titled(text_string("\u{dc}bersicht \u{2013} Gr\u{f6}\u{df}e")),
        Item::new("Website", "/A << /S /URI /URI (https://example.com/) >>"),
        Item::new(
            "Other file",
            "/A << /S /GoToR /F (other.pdf) /D [0 /Fit] >>",
        ),
        Item::new("Not a page", "/Dest [3 0 R /Fit]"),
        Item::new("", "").titled(text_string("Line\nbreak\u{202e}")),
        Item::new(&"A".repeat(600), ""),
        Item::new("No destination", ""),
        Item::new("Fit", &dest(2, "/Fit")),
    ];
    with_outline(&pages, &items)
}

/// An outline that is a cycle in three ways, which a reader that follows `/Next` and `/First` without keeping track never finishes:
///
/// ```text
/// A (page 1)       /First -> A.1                     /Next -> B
/// B (page 2)                                          /Next -> C
/// C (page 1)                                          /Next -> A   (a sibling that is an earlier sibling)
/// A.1 (page 2)     /First -> A  (a child that is its own parent)   /Next -> A.1 (a sibling that is itself)
/// ```
///
/// The four bookmarks are all there is to read, whatever order they are in.
pub fn outline_cycle() -> Vec<u8> {
    let mut builder = PdfBuilder::new();
    add_pages(&mut builder, &plain_pages(2));
    builder
        .object(
            20,
            "<< /Type /Outlines /First 21 0 R /Last 23 0 R /Count 3 >>",
        )
        .object(
            21,
            &format!(
                "<< /Title (A) /Parent 20 0 R /First 24 0 R /Last 24 0 R /Next 22 0 R {} >>",
                dest(0, "/Fit")
            ),
        )
        .object(
            22,
            &format!(
                "<< /Title (B) /Parent 20 0 R /Prev 21 0 R /Next 23 0 R {} >>",
                dest(1, "/Fit")
            ),
        )
        .object(
            23,
            &format!(
                "<< /Title (C) /Parent 20 0 R /Prev 22 0 R /Next 21 0 R {} >>",
                dest(0, "/Fit")
            ),
        )
        .object(
            24,
            &format!(
                "<< /Title (A.1) /Parent 21 0 R /First 21 0 R /Next 24 0 R {} >>",
                dest(1, "/Fit")
            ),
        )
        .object(1, "<< /Type /Catalog /Pages 2 0 R /Outlines 20 0 R >>");
    builder.finish(1)
}

/// An outline `levels` deep, one bookmark per level, each a child of the one before (a ladder): "Level 1" at the top, "Level N" at
/// the bottom.
pub fn deep_outline(levels: u32) -> Vec<u8> {
    let mut ladder: Option<Item> = None;
    for level in (1..=levels).rev() {
        let node = Item::new(&format!("Level {level}"), &dest(0, "/Fit"));
        ladder = Some(match ladder {
            Some(below) => node.with(vec![below]),
            None => node,
        });
    }
    let top = ladder.expect("at least one level");
    with_outline(&plain_pages(1), &[top])
}

/// An outline of `count` bookmarks on one level.
pub fn wide_outline(count: u32) -> Vec<u8> {
    let items: Vec<Item> = (1..=count)
        .map(|number| Item::new(&format!("Item {number}"), &dest(0, "/Fit")))
        .collect();
    with_outline(&plain_pages(1), &items)
}

// --- links ----------------------------------------------------------------------------------------------------------

/// Annotation `id` as a link in the rectangle `[72, y, 272, y + 20]` with `entries` as its action or destination.
fn link(builder: &mut PdfBuilder, id: u32, slot: u32, entries: &str) {
    builder.object(
        id,
        &format!(
            "<< /Type /Annot /Subtype /Link /Border [0 0 0] /Rect [72 {} 272 {}] {entries} >>",
            700 - 30 * slot,
            720 - 30 * slot
        ),
    );
}

/// A page of links of every kind, in this order (the index of a link is its position among the links, so the text annotation in the
/// middle does not count). Page 1 is 612 x 792; page 3 has a crop box that starts at (50, 100) and ends at (562, 700).
///
/// ```text
///  0  URI https://example.com/docs                       -> url
///  1  URI mailto:team@example.com?subject=Hello          -> url
///  2  URI file:///C:/Windows/System32/calc.exe           -> blocked
///     (a text annotation: not a link)
///  3  URI javascript:alert(1)                            -> blocked
///  4  action JavaScript                                  -> blocked
///  5  action Launch (calc.exe)                           -> blocked
///  6  action GoToR (other.pdf)                           -> blocked
///  7  action GoTo page 3, XYZ y = 600                    -> page 3 (index 2), y = 100 (top 700)
///  8  /Dest page 2, /Fit                                 -> page 2 (index 1), y = 0
///  9  action GoTo the name "chapter2" (page 2, FitH 300) -> page 2 (index 1), y = 492
/// 10  URI "https://example.com/a b" (a space)            -> blocked
/// 11  URI HTTP://EXAMPLE.COM/UP                          -> url
/// 12  /Dest whose "page" is the font                     -> blocked
/// 13  URI https://paypal.com@evil.example/               -> blocked
/// ```
pub fn links() -> Vec<u8> {
    let mut builder = PdfBuilder::new();
    let annots: Vec<String> = (100..=114).map(|id| format!("{id} 0 R")).collect();
    let pages = vec![
        Page::new(&text_line(24, 72, 740, "Links"))
            .with(&format!("/Annots [{}]", annots.join(" "))),
        Page::new(&text_line(24, 72, 700, "Page 2")),
        Page::new(&text_line(24, 72, 700, "Page 3")).with("/CropBox [50 100 562 700]"),
    ];
    add_pages(&mut builder, &pages);
    let uri = |target: &str| format!("/A << /S /URI /URI ({target}) >>");
    link(&mut builder, 100, 0, &uri("https://example.com/docs"));
    link(
        &mut builder,
        101,
        1,
        &uri("mailto:team@example.com?subject=Hello"),
    );
    link(
        &mut builder,
        102,
        2,
        &uri("file:///C:/Windows/System32/calc.exe"),
    );
    builder.object(
        103,
        "<< /Type /Annot /Subtype /Text /Rect [400 700 420 720] /Contents (A note) >>",
    );
    link(&mut builder, 104, 3, &uri("javascript:alert(1)"));
    link(
        &mut builder,
        105,
        4,
        "/A << /S /JavaScript /JS (app.alert\\(1\\)) >>",
    );
    link(
        &mut builder,
        106,
        5,
        "/A << /S /Launch /F (C:\\\\Windows\\\\System32\\\\calc.exe) >>",
    );
    link(
        &mut builder,
        107,
        6,
        "/A << /S /GoToR /F (other.pdf) /D [0 /Fit] >>",
    );
    link(
        &mut builder,
        108,
        7,
        &format!("/A << /S /GoTo /D [{} 0 R /XYZ 72 600 0] >>", page_id(2)),
    );
    link(&mut builder, 109, 8, &dest(1, "/Fit"));
    link(&mut builder, 110, 9, "/A << /S /GoTo /D (chapter2) >>");
    link(&mut builder, 111, 10, &uri("https://example.com/a b"));
    link(&mut builder, 112, 11, &uri("HTTP://EXAMPLE.COM/UP"));
    link(&mut builder, 113, 12, "/Dest [3 0 R /Fit]");
    link(
        &mut builder,
        114,
        13,
        &uri("https://paypal.com@evil.example/"),
    );
    builder.object(
        30,
        &format!("<< /Names [(chapter2) [{} 0 R /FitH 300]] >>", page_id(1)),
    );
    builder.object(
        1,
        "<< /Type /Catalog /Pages 2 0 R /Names << /Dests 30 0 R >> >>",
    );
    builder.finish(1)
}

/// A page with `count` links to `https://example.com/N`, and a link annotation list that is that long.
pub fn many_links(count: u32) -> Vec<u8> {
    let mut builder = PdfBuilder::new();
    let annots: Vec<String> = (0..count).map(|n| format!("{} 0 R", 100 + n)).collect();
    add_pages(
        &mut builder,
        &[Page::new("").with(&format!("/Annots [{}]", annots.join(" ")))],
    );
    for n in 0..count {
        builder.object(
            100 + n,
            &format!(
                "<< /Type /Annot /Subtype /Link /Rect [72 700 272 720] /A << /S /URI /URI (https://example.com/{n}) >> >>"
            ),
        );
    }
    builder.object(1, "<< /Type /Catalog /Pages 2 0 R >>");
    builder.finish(1)
}

/// One page with a link whose URL is `url` (as it is written in the file, so the caller escapes what a PDF string needs).
pub fn one_link(url: &str) -> Vec<u8> {
    let mut builder = PdfBuilder::new();
    add_pages(&mut builder, &[Page::new("").with("/Annots [100 0 R]")]);
    link(
        &mut builder,
        100,
        0,
        &format!("/A << /S /URI /URI ({url}) >>"),
    );
    builder.object(1, "<< /Type /Catalog /Pages 2 0 R >>");
    builder.finish(1)
}

// --- text and search ------------------------------------------------------------------------------------------------

/// Three pages of text.
///
/// Page 1 (US Letter), the lines at y = 700, 670, ...:
///
/// ```text
/// Grüße aus München
/// Café Crème – naïve façade € 5
/// The quick brown fox jumps over the lazy dog.
/// A word that is hyphen-            <- the line ends in a hyphen ...
/// ated across two lines.            <- ... and the word goes on
/// Repeat repeat REPEAT Repeated.
/// The straße ends here.
/// ```
///
/// Page 2 is rotated by 90 degrees and says "Turned page" at (72, 700); below it a line in the second font, `A` = U+1F600.
/// Page 3 has ten lines of "needle needle needle" (30 hits for "needle") from y = 700 down in steps of 20.
pub fn text() -> Vec<u8> {
    let mut page1 = String::new();
    for (line, text) in [
        "Gr\u{fc}\u{df}e aus M\u{fc}nchen",
        "Caf\u{e9} Cr\u{e8}me \u{2013} na\u{ef}ve fa\u{e7}ade \u{20ac} 5",
        "The quick brown fox jumps over the lazy dog.",
        "A word that is hyphen-",
        "ated across two lines.",
        "Repeat repeat REPEAT Repeated.",
        "The stra\u{df}e ends here.",
    ]
    .iter()
    .enumerate()
    {
        page1.push_str(&text_line(14, 72, 700 - 30 * line as u32, text));
    }
    let mut page2 = text_line(14, 72, 700, "Turned page");
    page2.push_str("BT /F2 14 Tf 72 670 Td (A) Tj ET\n");
    let mut page3 = String::new();
    for line in 0..10 {
        page3.push_str(&text_line(12, 72, 700 - 20 * line, "needle needle needle"));
    }
    let mut builder = PdfBuilder::new();
    add_pages(
        &mut builder,
        &[
            Page::new(&page1),
            Page::new(&page2).with("/Rotate 90"),
            Page::new(&page3),
        ],
    );
    builder.object(1, "<< /Type /Catalog /Pages 2 0 R >>");
    builder.finish(1)
}

/// `count` pages; page `n` says `Page n of count`, and the word `needle` is on every page whose number is a multiple of `every`.
pub fn numbered_pages(count: u32, every: u32) -> Vec<u8> {
    let pages: Vec<Page> = (1..=count)
        .map(|number| {
            let mut content = text_line(24, 72, 700, &format!("Page {number} of {count}"));
            if number % every == 0 {
                content.push_str(&text_line(12, 72, 650, "a needle in the page"));
            }
            Page::new(&content)
        })
        .collect();
    let mut builder = PdfBuilder::new();
    add_pages(&mut builder, &pages);
    builder.object(1, "<< /Type /Catalog /Pages 2 0 R >>");
    builder.finish(1)
}

/// One page of `lines` lines of `words` words each, in a 1 pt font 1.5 pt apart (a line needs 3 pt of its own at most, or PDFium
/// takes the text for a repeat of itself): far more text than a page layer may hold.
pub fn heavy_text_page(lines: u32, words: u32) -> Vec<u8> {
    let mut content = String::new();
    let line = vec!["word"; words as usize].join(" ");
    for n in 0..lines {
        let y = 780.0 - f64::from(n) * 1.5;
        content.push_str(&format!("BT /F1 1 Tf 10 {y:.1} Td ({line}) Tj ET\n"));
    }
    let mut builder = PdfBuilder::new();
    add_pages(&mut builder, &[Page::new(&content)]);
    builder.object(1, "<< /Type /Catalog /Pages 2 0 R >>");
    builder.finish(1)
}

// --- flags ----------------------------------------------------------------------------------------------------------

/// A document with an AcroForm and one text field.
pub fn form() -> Vec<u8> {
    let mut builder = PdfBuilder::new();
    add_pages(
        &mut builder,
        &[Page::new(&text_line(24, 72, 740, "Form")).with("/Annots [100 0 R]")],
    );
    builder
        .object(
            100,
            &format!(
                "<< /Type /Annot /Subtype /Widget /FT /Tx /T (name) /V (Ada) /Rect [72 700 272 720] /P {} 0 R >>",
                page_id(0)
            ),
        )
        .object(
            1,
            "<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [100 0 R] >> >>",
        );
    builder.finish(1)
}

/// A document whose form is an XFA form (the AcroForm has an `/XFA` entry).
pub fn xfa() -> Vec<u8> {
    let mut builder = PdfBuilder::new();
    add_pages(&mut builder, &plain_pages(1));
    builder
        .stream(
            100,
            "",
            b"<xdp:xdp xmlns:xdp=\"http://ns.adobe.com/xdp/\"></xdp:xdp>",
        )
        .object(
            1,
            "<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [] /XFA [(template) 100 0 R] >> >>",
        );
    builder.finish(1)
}

/// A document with a signed signature field. The signature itself is a stub: PDFium counts signed fields, it does not check them.
pub fn signed() -> Vec<u8> {
    let mut builder = PdfBuilder::new();
    add_pages(
        &mut builder,
        &[Page::new(&text_line(24, 72, 740, "Signed")).with("/Annots [100 0 R]")],
    );
    builder
        .object(
            100,
            &format!(
                "<< /Type /Annot /Subtype /Widget /FT /Sig /T (Signature1) /V 101 0 R /Rect [72 700 272 760] /P {} 0 R >>",
                page_id(0)
            ),
        )
        .object(
            101,
            "<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /adbe.pkcs7.detached /ByteRange [0 0 0 0] \
             /Contents <00> /M (D:20260101000000Z) /Name (Test) >>",
        )
        .object(
            1,
            "<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [100 0 R] /SigFlags 3 >> >>",
        );
    builder.finish(1)
}

/// A document with the standard security handler (RC4, 40 bit, revision 2) and an empty user password, which opens without asking.
pub fn encrypted() -> Vec<u8> {
    let id0: [u8; 16] = *b"sheer-fixture-id";
    let permissions: i32 = -4;
    let owner = crypt::owner_entry(b"owner");
    let key = crypt::file_key(&owner, permissions, &id0);
    let user = crypt::rc4(&key, &crypt::PADDING);

    let mut builder = PdfBuilder::new();
    let content = text_line(24, 72, 700, "Secret page");
    // The same layout as `add_pages`, but the content stream is encrypted with the key of its own object.
    builder.object(3, FONT);
    builder.object(2, "<< /Type /Pages /Kids [10 0 R] /Count 1 >>");
    builder.object(
        10,
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 11 0 R \
         /Resources << /Font << /F1 3 0 R >> >> >>",
    );
    let object_key = crypt::object_key(&key, 11, 0);
    builder.stream(11, "", &crypt::rc4(&object_key, content.as_bytes()));
    builder.object(
        50,
        &format!(
            "<< /Filter /Standard /V 1 /R 2 /O <{}> /U <{}> /P {permissions} >>",
            crypt::hex(&owner),
            crypt::hex(&user)
        ),
    );
    builder.object(1, "<< /Type /Catalog /Pages 2 0 R >>");
    builder.trailer(&format!(
        "/Encrypt 50 0 R /ID [<{0}> <{0}>]",
        crypt::hex(&id0)
    ));
    builder.finish(1)
}

/// The committed fixtures: file name and bytes.
pub fn all() -> Vec<(&'static str, Vec<u8>)> {
    vec![
        ("outline.pdf", outline()),
        ("outline-cycle.pdf", outline_cycle()),
        ("links.pdf", links()),
        ("text.pdf", text()),
        ("form.pdf", form()),
        ("xfa.pdf", xfa()),
        ("signed.pdf", signed()),
        ("encrypted.pdf", encrypted()),
    ]
}

/// The pieces of the standard security handler, revision 2 (ISO 32000-1, 7.6.3): MD5 and RC4, written out because the fixture is
/// the only thing that needs them and a test is no place for a dependency.
pub mod crypt {
    /// The padding string of the specification, which stands for an empty password.
    pub const PADDING: [u8; 32] = [
        0x28, 0xBF, 0x4E, 0x5E, 0x4E, 0x75, 0x8A, 0x41, 0x64, 0x00, 0x4E, 0x56, 0xFF, 0xFA, 0x01,
        0x08, 0x2E, 0x2E, 0x00, 0xB6, 0xD0, 0x68, 0x3E, 0x80, 0x2F, 0x0C, 0xA9, 0xFE, 0x64, 0x53,
        0x69, 0x7A,
    ];

    pub fn md5(data: &[u8]) -> [u8; 16] {
        const SHIFTS: [u32; 64] = [
            7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20,
            5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
            6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
        ];
        let table: Vec<u32> = (0..64)
            .map(|i| ((f64::from(i + 1)).sin().abs() * 4_294_967_296.0) as u32)
            .collect();
        let mut state: [u32; 4] = [0x6745_2301, 0xefcd_ab89, 0x98ba_dcfe, 0x1032_5476];
        let mut message = data.to_vec();
        message.push(0x80);
        while message.len() % 64 != 56 {
            message.push(0);
        }
        message.extend_from_slice(&((data.len() as u64) * 8).to_le_bytes());
        for block in message.chunks(64) {
            let words: Vec<u32> = block
                .chunks(4)
                .map(|word| u32::from_le_bytes([word[0], word[1], word[2], word[3]]))
                .collect();
            let [mut a, mut b, mut c, mut d] = state;
            for i in 0..64 {
                let (f, g) = match i / 16 {
                    0 => ((b & c) | (!b & d), i),
                    1 => ((d & b) | (!d & c), (5 * i + 1) % 16),
                    2 => (b ^ c ^ d, (3 * i + 5) % 16),
                    _ => (c ^ (b | !d), (7 * i) % 16),
                };
                let rotated = a
                    .wrapping_add(f)
                    .wrapping_add(table[i])
                    .wrapping_add(words[g])
                    .rotate_left(SHIFTS[i]);
                a = d;
                d = c;
                c = b;
                b = b.wrapping_add(rotated);
            }
            state = [
                state[0].wrapping_add(a),
                state[1].wrapping_add(b),
                state[2].wrapping_add(c),
                state[3].wrapping_add(d),
            ];
        }
        let mut digest = [0u8; 16];
        for (chunk, word) in digest.chunks_mut(4).zip(state) {
            chunk.copy_from_slice(&word.to_le_bytes());
        }
        digest
    }

    pub fn rc4(key: &[u8], data: &[u8]) -> Vec<u8> {
        let mut s: Vec<u8> = (0..=255).collect();
        let mut j = 0usize;
        for i in 0..256 {
            j = (j + usize::from(s[i]) + usize::from(key[i % key.len()])) % 256;
            s.swap(i, j);
        }
        let (mut i, mut j) = (0usize, 0usize);
        data.iter()
            .map(|byte| {
                i = (i + 1) % 256;
                j = (j + usize::from(s[i])) % 256;
                s.swap(i, j);
                byte ^ s[(usize::from(s[i]) + usize::from(s[j])) % 256]
            })
            .collect()
    }

    pub fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|byte| format!("{byte:02X}")).collect()
    }

    /// The owner entry `/O` (algorithm 3 for revision 2) for the owner password `owner` and an empty user password.
    pub fn owner_entry(owner: &[u8]) -> Vec<u8> {
        let mut padded = owner.to_vec();
        padded.extend_from_slice(&PADDING);
        padded.truncate(32);
        let key = md5(&padded)[..5].to_vec();
        rc4(&key, &PADDING)
    }

    /// The key of the file (algorithm 2, revision 2, 40 bit) for an empty user password.
    pub fn file_key(owner_entry: &[u8], permissions: i32, id0: &[u8]) -> Vec<u8> {
        let mut input = PADDING.to_vec();
        input.extend_from_slice(owner_entry);
        input.extend_from_slice(&permissions.to_le_bytes());
        input.extend_from_slice(id0);
        md5(&input)[..5].to_vec()
    }

    /// The key of one object (algorithm 1): the file key and the object and generation numbers.
    pub fn object_key(file_key: &[u8], object: u32, generation: u32) -> Vec<u8> {
        let mut input = file_key.to_vec();
        input.extend_from_slice(&object.to_le_bytes()[..3]);
        input.extend_from_slice(&generation.to_le_bytes()[..2]);
        let length = (file_key.len() + 5).min(16);
        md5(&input)[..length].to_vec()
    }
}

#[cfg(test)]
mod tests {
    use super::crypt::{hex, md5, rc4};

    #[test]
    fn the_md5_and_rc4_the_encrypted_fixture_is_made_with_are_the_standard_ones() {
        assert_eq!(hex(&md5(b"")), "D41D8CD98F00B204E9800998ECF8427E");
        assert_eq!(hex(&md5(b"abc")), "900150983CD24FB0D6963F7D28E17F72");
        assert_eq!(
            hex(&md5(b"The quick brown fox jumps over the lazy dog")),
            "9E107D9D372BB6826BD81D3542A419D6"
        );
        // RFC 6229 style check: RC4 with the key "Key" over "Plaintext".
        assert_eq!(hex(&rc4(b"Key", b"Plaintext")), "BBF316E8D940AF0AD3");
        // RC4 is its own inverse.
        assert_eq!(rc4(b"k", &rc4(b"k", b"round trip")), b"round trip");
    }
}
