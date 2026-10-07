//! v1.7 T-SCAN (ADR-135 section 2): self-generated scan fixtures for OCR accuracy checks. Rule 13: no foreign PDFs. Deterministic.
//! Writes to `review/generated/scans/` (git-ignored): s1-letter-de, s2-multi-en, s3-rotated, s4-skew, s5-mixed and `expected.json`.
//!
//! ```text
//! cargo run --release --example make_scan_fixtures     (npm run fixtures:scans)
//! ```
//! `--owner` (npm run fixtures:owner-scans): image-only PDFs of the owner scans `owner-scan-S1`..`S6` (IDs from the untracked
//! `review/owner/INDEX.md`, table "Scans") into `review/generated/owner-scans/<ID>.pdf`; prints IDs only (ADR-133).
//!
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
    if std::env::args().any(|a| a == "--owner") {
        return run_owner();
    }
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

// --- Owner scans (ADR-137, ADR-133: IDs only, never file names) -------------------------------------------------------------

const OWNER_IDS: [&str; 6] = [
    "owner-scan-S1",
    "owner-scan-S2",
    "owner-scan-S3",
    "owner-scan-S4",
    "owner-scan-S5",
    "owner-scan-S6",
];
/// Most pixels one owner image may have (a huge PNG is skipped, not decoded).
const OWNER_MAX_PIXELS: u64 = 80_000_000;

fn owner_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("review")
        .join("owner")
}

/// The `(ID, relative path)` rows of the "Scans" table of the index text. Pure.
fn parse_scan_table(index: &str) -> Vec<(String, String)> {
    let mut rows = Vec::new();
    let mut in_scans = false;
    for line in index.lines() {
        if let Some(heading) = line.strip_prefix("## ") {
            in_scans = heading.trim_start().starts_with("Scans");
            continue;
        }
        if !in_scans {
            continue;
        }
        let cells: Vec<&str> = line
            .trim()
            .trim_matches('|')
            .split('|')
            .map(str::trim)
            .collect();
        if let [id, path] = cells[..] {
            if OWNER_IDS.contains(&id) && !path.is_empty() {
                rows.push((id.to_owned(), path.to_owned()));
            }
        }
    }
    rows
}

/// A relative path that stays below `review/owner/`.
fn safe_relative(path: &str) -> bool {
    let p = std::path::Path::new(path);
    p.is_relative()
        && p.components()
            .all(|c| matches!(c, std::path::Component::Normal(_)))
}

/// Decodes a PNG to 8-bit gray (alpha dropped, colour by luma).
fn decode_png_gray(path: &std::path::Path) -> R<(u32, u32, Vec<u8>)> {
    let file = File::open(path).map_err(s)?;
    let mut decoder = png::Decoder::new(std::io::BufReader::new(file));
    decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let mut reader = decoder.read_info().map_err(s)?;
    let (w, h) = (reader.info().width, reader.info().height);
    if u64::from(w) * u64::from(h) > OWNER_MAX_PIXELS || w == 0 || h == 0 {
        return Err("image size".into());
    }
    let mut buf = vec![0; reader.output_buffer_size().ok_or("image size")?];
    let frame = reader.next_frame(&mut buf).map_err(s)?;
    let data = &buf[..frame.buffer_size()];
    let luma = |p: &[u8]| {
        ((299 * u32::from(p[0]) + 587 * u32::from(p[1]) + 114 * u32::from(p[2])) / 1000) as u8
    };
    let gray: Vec<u8> = match frame.color_type {
        png::ColorType::Grayscale => data.to_vec(),
        png::ColorType::GrayscaleAlpha => data.as_chunks::<2>().0.iter().map(|p| p[0]).collect(),
        png::ColorType::Rgb => data.as_chunks::<3>().0.iter().map(|p| luma(p)).collect(),
        png::ColorType::Rgba => data.as_chunks::<4>().0.iter().map(|p| luma(p)).collect(),
        png::ColorType::Indexed => return Err("indexed".into()),
    };
    if gray.len() as u64 != u64::from(w) * u64::from(h) {
        return Err("image size".into());
    }
    Ok((w, h, gray))
}

/// `--owner`: one image-only PDF per owner scan ID, below `review/generated/owner-scans/`. Missing index or file: skipped, exit 0.
fn run_owner() -> R<()> {
    let root = owner_dir();
    let Ok(index) = std::fs::read_to_string(root.join("INDEX.md")) else {
        println!("owner scans: no review/owner/INDEX.md, skipped");
        return Ok(());
    };
    let rows = parse_scan_table(&index);
    let out = out_dir().join("..").join("owner-scans");
    std::fs::create_dir_all(&out).map_err(s)?;
    for id in OWNER_IDS {
        let Some((_, rel)) = rows.iter().find(|(row, _)| row == id) else {
            println!("{id}: not in the index, skipped");
            continue;
        };
        if !safe_relative(rel) {
            println!("{id}: path not allowed, skipped");
            continue;
        }
        let source = root.join(rel);
        if !source.is_file() {
            println!("{id}: file missing, skipped");
            continue;
        }
        let made = decode_png_gray(&source).and_then(|(w, h, gray)| {
            // A4 width; the height follows the picture so nothing is cropped or stretched.
            let height = (PAGE[0] * h as f32 / w as f32).clamp(100.0, 5000.0);
            let page = ScanPage {
                size_pt: [PAGE[0], height],
                px: [w, h],
                gray,
            };
            image_only_pdf(&[page]).map_err(s)
        });
        match made {
            Ok(bytes) => {
                std::fs::write(out.join(format!("{id}.pdf")), bytes).map_err(s)?;
                println!("{id}: written");
            }
            Err(_) => println!("{id}: not readable, skipped"),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_scans_table_is_read_by_id_and_other_tables_are_ignored() {
        let index = "## Other\n\n| owner-scan-S1 | no.png |\n\n## Scans (x)\n\n| ID | File |\n| --- | --- |\n| owner-scan-S1 | a/b.png |\n| owner-scan-S2 | c.png |\n| other-id | d.png |\n\n## Next\n\n| owner-scan-S3 | e.png |\n";
        assert_eq!(
            parse_scan_table(index),
            vec![
                ("owner-scan-S1".to_owned(), "a/b.png".to_owned()),
                ("owner-scan-S2".to_owned(), "c.png".to_owned())
            ]
        );
    }

    #[test]
    fn only_paths_below_the_owner_folder_are_used() {
        assert!(safe_relative("a/b.png"));
        assert!(!safe_relative("../x.png"));
        assert!(!safe_relative("a/../../x.png"));
        assert!(!safe_relative(if cfg!(windows) {
            r"C:\x.png"
        } else {
            "/x.png"
        }));
    }
}
