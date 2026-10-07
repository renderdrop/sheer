//! v1.7 T-SCAN (ADR-135 section 2): self-generated scan fixtures for OCR accuracy checks. Rule 13: no foreign PDFs. Deterministic.
//! Writes to `review/generated/scans/` (git-ignored): s1-letter-de, s2-multi-en, s3-rotated, s4-skew, s5-mixed and `expected.json`.
//!
//! ```text
//! cargo run --release --example make_scan_fixtures     (npm run fixtures:scans)
//! ```
//! A text PDF (Helvetica) is built with lopdf, rendered by the engine to gray at 250 dpi and wrapped as an image-only PDF.

use std::fs::File;
use std::path::PathBuf;

use lopdf::{dictionary, Dictionary, Document, Object, Stream};
use serde_json::json;
use sheer_lib::documents::Registry;
use sheer_lib::engine::{library_path, Engine};
use sheer_lib::export::snapshot::EngineDocRef;
use sheer_lib::pdfwrite::ocr_probe::{image_only_pdf, rotated_copy, ScanPage};
use sheer_lib::pdfwrite::redact::RasterPixels;

type R<T> = Result<T, String>;

const DPI: f32 = 250.0;
const PAGE: [f32; 2] = [595.0, 842.0];
const WRAP: usize = 78;

fn s<E: std::fmt::Debug>(e: E) -> String {
    format!("{e:?}")
}

fn out_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("review")
        .join("generated")
        .join("scans")
}

const LETTER_DE: &str = "Musterfirma GmbH
Beispielweg 12
12345 Musterstadt

Musterstadt, den 3. Mai 2026

Betreff: Bestätigung Ihrer Bestellung Nr. 48213

Sehr geehrte Damen und Herren,

vielen Dank für Ihre Bestellung vom 28. April. Wir bestätigen den Eingang und freuen uns, Ihnen mitteilen zu können, dass die Ware am kommenden Donnerstag versendet wird. Die Lieferung erfolgt innerhalb von drei bis fünf Werktagen an die angegebene Adresse.

Der Rechnungsbetrag von 249,90 Euro ist innerhalb von vierzehn Tagen nach Erhalt der Ware zu überweisen. Bitte geben Sie dabei die Bestellnummer an. Über Größe, Farbe und Zubehör haben wir uns an Ihre Angaben gehalten; falls sich etwas ändern soll, melden Sie sich bitte schnellstmöglich bei uns.

Für Rückfragen stehen wir Ihnen montags bis freitags zwischen 9 und 17 Uhr gerne zur Verfügung.

Mit freundlichen Grüßen

Erika Beispiel
Kundenservice";

const PROSE_EN: [&str; 3] = [
    "The harbour town lay quiet in the early morning, its narrow streets still wet from the night's rain. Fishermen carried crates of ice and nets down to the quay, while gulls circled above the water and waited for the first catch of the day. In the baker's window a tray of warm rolls had already appeared, and the smell of fresh bread drifted across the square.\n\nBy nine o'clock the market was busy. Farmers from the surrounding hills had arrived with baskets of apples, pears and late tomatoes, and customers moved slowly between the stalls, comparing prices and exchanging news about the weather, the ferry timetable and the repairs to the old lighthouse.",
    "The committee met on the second Tuesday of every month to review the accounts and to discuss plans for the coming season. Each member received a short report in advance, and any questions were collected by the secretary so that the meeting could proceed without delay.\n\nIn March the members agreed to replace the roof of the community hall, to extend the opening hours of the library, and to organise a summer festival on the village green. Volunteers were asked to sign up before the end of April, and a budget of four thousand pounds was approved without objection.",
    "Learning a new language takes patience more than talent. Most students find that regular short sessions work better than a single long one, because the memory needs time to settle between lessons. Reading simple stories aloud, listening to slow news broadcasts and writing a few sentences every evening all help to build confidence.\n\nMistakes are not a sign of failure but a necessary part of progress. Every correction teaches something that no textbook rule can, and after a few months even a hesitant beginner will be surprised how much has become familiar.",
];

const MIXED_TEXT: &str = "Quarterly summary

This page contains real, selectable text and needs no recognition. The following page of the same document is a scanned image of a printed page.

Revenue grew steadily over the quarter, while costs remained close to the forecast. The team expects the same pattern to continue through the autumn.";

/// Greedy word wrap of paragraphs (blank lines kept) to `WRAP` characters.
fn wrap(text: &str) -> Vec<String> {
    let mut lines = Vec::new();
    for para in text.split('\n') {
        let mut line = String::new();
        for word in para.split_whitespace() {
            if !line.is_empty() && line.chars().count() + 1 + word.chars().count() > WRAP {
                lines.push(std::mem::take(&mut line));
            }
            if !line.is_empty() {
                line.push(' ');
            }
            line.push_str(word);
        }
        lines.push(line);
    }
    lines
}

/// WinAnsi bytes (Latin-1 range only, which covers the umlauts used here).
fn winansi(t: &str) -> Vec<u8> {
    t.chars()
        .map(|c| if (c as u32) < 256 { c as u8 } else { b'?' })
        .collect()
}

fn text_content(lines: &[String]) -> Vec<u8> {
    let mut out = b"BT /F1 12 Tf 15 TL 58 780 Td\n".to_vec();
    for l in lines {
        out.push(b'(');
        for b in winansi(l) {
            if matches!(b, b'(' | b')' | b'\\') {
                out.push(b'\\');
            }
            out.push(b);
        }
        out.extend_from_slice(b") Tj T*\n");
    }
    out.extend_from_slice(b"ET\n");
    out
}

enum Page {
    Text(Vec<String>),
    Scan(ScanPage),
}

fn build(pages: &[Page]) -> R<Vec<u8>> {
    use std::io::Write;
    let mut doc = Document::with_version("1.7");
    let tree = doc.new_object_id();
    let font = doc.add_object(dictionary! {
        "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica", "Encoding" => "WinAnsiEncoding",
    });
    let mut kids = Vec::new();
    for p in pages {
        let (content, resources) = match p {
            Page::Text(lines) => (
                text_content(lines),
                dictionary! { "Font" => dictionary! { "F1" => font } },
            ),
            Page::Scan(sp) => {
                let mut z =
                    flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
                z.write_all(&sp.gray).map_err(s)?;
                let image = doc.add_object(Stream::new(
                    dictionary! {
                        "Type" => "XObject", "Subtype" => "Image", "Width" => i64::from(sp.px[0]), "Height" => i64::from(sp.px[1]),
                        "ColorSpace" => "DeviceGray", "BitsPerComponent" => 8, "Filter" => "FlateDecode",
                    },
                    z.finish().map_err(s)?,
                ));
                (
                    format!(
                        "q {} 0 0 {} 0 0 cm /Im0 Do Q\n",
                        sp.size_pt[0], sp.size_pt[1]
                    )
                    .into_bytes(),
                    dictionary! { "XObject" => dictionary! { "Im0" => image } },
                )
            }
        };
        let content = doc.add_object(Stream::new(Dictionary::new(), content));
        let page = doc.add_object(dictionary! {
            "Type" => "Page", "Parent" => tree,
            "MediaBox" => vec![0.into(), 0.into(), Object::Real(PAGE[0]), Object::Real(PAGE[1])],
            "Resources" => resources, "Contents" => content,
        });
        kids.push(Object::Reference(page));
    }
    let n = kids.len() as i64;
    doc.set_object(
        tree,
        dictionary! { "Type" => "Pages", "Kids" => kids, "Count" => n },
    );
    let catalog = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => tree });
    doc.trailer.set("Root", catalog);
    let mut bytes = Vec::new();
    doc.save_to(&mut bytes).map_err(s)?;
    Ok(bytes)
}

fn gray_of(pixels: RasterPixels) -> Vec<u8> {
    match pixels {
        RasterPixels::Gray8(g) => g,
        RasterPixels::Rgb8(rgb) => rgb
            .as_chunks::<3>()
            .0
            .iter()
            .map(|p| {
                ((299 * u32::from(p[0]) + 587 * u32::from(p[1]) + 114 * u32::from(p[2])) / 1000)
                    as u8
            })
            .collect(),
    }
}

/// Bilinear rotation about the centre by `deg`, white background, same size.
fn skew(sp: &ScanPage, deg: f32) -> ScanPage {
    let (w, h) = (sp.px[0] as usize, sp.px[1] as usize);
    let (sin, cos) = deg.to_radians().sin_cos();
    let (cx, cy) = (w as f32 / 2.0, h as f32 / 2.0);
    let mut gray = vec![255u8; w * h];
    for y in 0..h {
        for x in 0..w {
            let (dx, dy) = (x as f32 - cx, y as f32 - cy);
            let (sx, sy) = (cos * dx + sin * dy + cx, -sin * dx + cos * dy + cy);
            if sx < 0.0 || sy < 0.0 || sx >= (w - 1) as f32 || sy >= (h - 1) as f32 {
                continue;
            }
            let (x0, y0) = (sx as usize, sy as usize);
            let (fx, fy) = (sx - x0 as f32, sy - y0 as f32);
            let at = |xx: usize, yy: usize| f32::from(sp.gray[yy * w + xx]);
            let v = at(x0, y0) * (1.0 - fx) * (1.0 - fy)
                + at(x0 + 1, y0) * fx * (1.0 - fy)
                + at(x0, y0 + 1) * (1.0 - fx) * fy
                + at(x0 + 1, y0 + 1) * fx * fy;
            gray[y * w + x] = v.round() as u8;
        }
    }
    ScanPage {
        size_pt: sp.size_pt,
        px: sp.px,
        gray,
    }
}

fn main() {
    if let Err(e) = run() {
        eprintln!("error: {}", e.chars().take(300).collect::<String>());
        std::process::exit(1);
    }
}

fn run() -> R<()> {
    let dir = out_dir();
    let tmp = dir.join("tmp");
    std::fs::create_dir_all(&tmp).map_err(s)?;
    let library = library_path(&PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("pdfium"));
    if !library.is_file() {
        return Err("pdfium library missing (npm run fetch-pdfium)".into());
    }
    let engine = Engine::start(library);
    let registry = Registry::new();

    // Renders every page of a text PDF to gray scan pages.
    let scan_of = |name: &str, texts: &[&str]| -> R<(Vec<ScanPage>, Vec<String>)> {
        let pages: Vec<Page> = texts.iter().map(|t| Page::Text(wrap(t))).collect();
        let path = tmp.join(format!("{name}-source.pdf"));
        std::fs::write(&path, build(&pages)?).map_err(s)?;
        let id = registry.register(path.clone()).map_err(s)?;
        engine
            .open(id, File::open(&path).map_err(s)?, |_| true)
            .map_err(s)?;
        let mut scans = Vec::new();
        for i in 0..texts.len() as u32 {
            let r = engine
                .render_export(EngineDocRef::Live(id), i, DPI, false, 0)
                .map_err(s)?;
            scans.push(ScanPage {
                size_pt: PAGE,
                px: [r.width, r.height],
                gray: gray_of(r.pixels),
            });
        }
        let _ = engine.close(id);
        let expected = texts.iter().map(|t| wrap(t).join("\n")).collect();
        Ok((scans, expected))
    };

    let (s1, e1) = scan_of("s1", &[LETTER_DE])?;
    let (s2, e2) = scan_of("s2", &PROSE_EN)?;
    let (mut s3, e3) = scan_of("s3", &[PROSE_EN[0]])?;
    let (mut s4, e4) = scan_of("s4", &[PROSE_EN[1]])?;
    let (mut s5, _) = scan_of("s5", &[MIXED_TEXT, PROSE_EN[2]])?;

    let write = |name: &str, bytes: Vec<u8>| std::fs::write(dir.join(name), bytes).map_err(s);
    write("s1-letter-de.pdf", image_only_pdf(&s1).map_err(s)?)?;
    write("s2-multi-en.pdf", image_only_pdf(&s2).map_err(s)?)?;
    let upright = image_only_pdf(&[s3.remove(0)]).map_err(s)?;
    write("s3-rotated.pdf", rotated_copy(&upright, 0).map_err(s)?)?;
    write(
        "s4-skew.pdf",
        image_only_pdf(&[skew(&s4.remove(0), 2.0)]).map_err(s)?,
    )?;
    let scan = s5.remove(1);
    write(
        "s5-mixed.pdf",
        build(&[Page::Text(wrap(MIXED_TEXT)), Page::Scan(scan)])?,
    )?;

    let expected = json!({
        "s1-letter-de.pdf": { "lang": "de-DE", "pages": e1 },
        "s2-multi-en.pdf": { "lang": "en-US", "pages": e2 },
        "s3-rotated.pdf": { "lang": "en-US", "rotate": 90, "pages": e3 },
        "s4-skew.pdf": { "lang": "en-US", "skew_deg": 2.0, "pages": e4 },
        "s5-mixed.pdf": { "lang": "en-US", "pages": [wrap(MIXED_TEXT).join("\n"), wrap(PROSE_EN[2]).join("\n")], "scan_pages": [1] },
    });
    std::fs::write(
        dir.join("expected.json"),
        serde_json::to_string_pretty(&expected).map_err(s)?,
    )
    .map_err(s)?;
    let _ = std::fs::remove_dir_all(&tmp);
    for entry in std::fs::read_dir(&dir).map_err(s)?.flatten() {
        println!("{}", entry.path().display());
    }
    Ok(())
}
