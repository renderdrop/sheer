//! Corpus run of the v1.5 text-editing spike (not part of `npm run check`: `cargo test --lib textedit::corpus -- --ignored --nocapture`).
//! Reads the PDFs of `SHEER_SPIKE_CORPUS` (default `review/v1.5-spike/corpus`, never committed), replaces one word of page 1 twice
//! (A: the same letters reversed, B: a word with likely missing glyphs), re-opens the result with PDFium and writes before/after PNGs
//! to `review/v1.5-spike/out/` and the table to `review/v1.5-spike/results-raw.md`.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::fmt::Write as _;
use std::path::{Path, PathBuf};

use super::{replace_word, Outcome};
use crate::engine;
use pdfium_render::prelude::*;

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..")
}

fn page_text(pdfium: &Pdfium, bytes: &[u8]) -> Option<String> {
    let doc = pdfium.load_pdf_from_byte_slice(bytes, None).ok()?;
    let page = doc.pages().get(0).ok()?;
    let text = page.text().ok()?.all();
    Some(text)
}

fn render_png(pdfium: &Pdfium, bytes: &[u8], path: &Path) {
    let Ok(doc) = pdfium.load_pdf_from_byte_slice(bytes, None) else {
        return;
    };
    let Ok(page) = doc.pages().get(0) else {
        return;
    };
    let width = 900i32;
    #[allow(clippy::cast_possible_truncation)]
    let height = (f64::from(width) * f64::from(page.height().value) / f64::from(page.width().value))
        .round() as i32;
    let config = PdfRenderConfig::new()
        .set_target_size(width, height)
        .set_format(PdfBitmapFormat::BGR)
        .set_reverse_byte_order(true);
    let Ok(mut bitmap) = PdfBitmap::empty(width, height, PdfBitmapFormat::BGR) else {
        return;
    };
    if page
        .render_into_bitmap_with_config(&mut bitmap, &config)
        .is_err()
    {
        return;
    }
    let raw = bitmap.as_raw_bytes();
    let (w, h) = (width as usize, height as usize);
    let stride = raw.len() / h;
    let mut rgb = Vec::with_capacity(w * h * 3);
    for row in raw.chunks_exact(stride).take(h) {
        rgb.extend_from_slice(&row[..w * 3]);
    }
    let file = std::fs::File::create(path).unwrap();
    let mut encoder = png::Encoder::new(std::io::BufWriter::new(file), width as u32, height as u32);
    encoder.set_color(png::ColorType::Rgb);
    encoder.set_depth(png::BitDepth::Eight);
    encoder
        .write_header()
        .unwrap()
        .write_image_data(&rgb)
        .unwrap();
}

/// Words of at least five letters, in reading order, without duplicates.
fn candidates(text: &str) -> Vec<String> {
    let mut seen = Vec::new();
    for word in text.split(|c: char| !c.is_alphabetic()) {
        if word.chars().count() >= 5 && !seen.iter().any(|w| w == word) {
            seen.push(word.to_owned());
        }
    }
    seen
}

fn count(haystack: &str, needle: &str) -> usize {
    haystack.matches(needle).count()
}

struct Case {
    cell: String,
}

#[allow(clippy::too_many_arguments)]
fn run_case(
    pdfium: &Pdfium,
    stem: &str,
    label: &str,
    out_dir: &Path,
    input: &[u8],
    word: &str,
    new: &str,
    before_text: &str,
) -> Case {
    let result = match replace_word(input, 0, word, new) {
        Ok(r) => r,
        Err(e) => {
            return Case {
                cell: format!("Error: {e}"),
            }
        }
    };
    let (name, reason) = match &result.outcome {
        Outcome::Works => ("Works", String::new()),
        Outcome::Fallback { reason } => ("Fallback", reason.clone()),
        Outcome::Impossible { reason } => ("Impossible", reason.clone()),
    };
    let mut cell = name.to_owned();
    if !reason.is_empty() {
        let _ = write!(cell, " ({reason})");
    }
    if !result.bytes.is_empty() {
        std::fs::write(out_dir.join(format!("{stem}-{label}.pdf")), &result.bytes).ok();
        let after = page_text(pdfium, &result.bytes);
        match after {
            Some(after) => {
                let new_present = after.contains(new);
                let old_before = count(before_text, word);
                let old_after = count(&after, word);
                let ok = new_present && old_after < old_before;
                let _ = write!(
                    cell,
                    "; {} new={} old {}->{}; dw={:+.1}u",
                    if ok { "verified" } else { "NOT VERIFIED" },
                    new_present,
                    old_before,
                    old_after,
                    result.width_delta
                );
            }
            None => cell.push_str("; PDFium cannot open the result"),
        }
        if !result.notes.is_empty() {
            let _ = write!(cell, "; notes: {}", result.notes.join(" / "));
        }
        render_png(
            pdfium,
            &result.bytes,
            &out_dir.join(format!("{stem}-{label}.png")),
        );
    }
    Case { cell }
}

#[test]
#[ignore = "needs the private corpus"]
fn corpus() {
    let corpus = std::env::var("SHEER_SPIKE_CORPUS").map_or_else(
        |_| repo_root().join("review/v1.5-spike/corpus"),
        PathBuf::from,
    );
    let out_dir = repo_root().join("review/v1.5-spike/out");
    std::fs::create_dir_all(&out_dir).unwrap();
    let library = engine::library_path(&PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("pdfium"));
    let pdfium = Pdfium::new(Pdfium::bind_to_library(library).expect("PDFium library"));

    let mut files: Vec<PathBuf> = std::fs::read_dir(&corpus)
        .expect("corpus directory")
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|e| e.eq_ignore_ascii_case("pdf")))
        .collect();
    files.sort();

    let mut table =
        String::from("| File | Word | A: same letters reversed | B: Qüßxyz |\n|---|---|---|---|\n");
    for path in files {
        let stem = path.file_stem().unwrap().to_string_lossy().into_owned();
        let input = std::fs::read(&path).unwrap();
        let Some(before) = page_text(&pdfium, &input) else {
            let _ = writeln!(table, "| {stem} | - | PDFium cannot open | - |");
            continue;
        };
        render_png(&pdfium, &input, &out_dir.join(format!("{stem}-before.png")));
        // The first candidate whose case A is not "not found" (annotations and forms are not page content).
        let mut chosen = None;
        for word in candidates(&before).into_iter().take(15) {
            let reversed: String = word.chars().rev().collect();
            let a = run_case(
                &pdfium, &stem, "A", &out_dir, &input, &word, &reversed, &before,
            );
            let found = !a.cell.contains("text not found");
            chosen = Some((word, reversed, a));
            if found {
                break;
            }
        }
        let Some((word, _, a)) = chosen else {
            let _ = writeln!(table, "| {stem} | (no word) | - | - |");
            continue;
        };
        let b = run_case(
            &pdfium, &stem, "B", &out_dir, &input, &word, "Qüßxyz", &before,
        );
        let _ = writeln!(table, "| {stem} | {word} | {} | {} |", a.cell, b.cell);
    }
    std::io::Write::write_all(&mut std::io::stdout(), table.as_bytes()).unwrap();
    std::fs::write(repo_root().join("review/v1.5-spike/results-raw.md"), &table).unwrap();
}
