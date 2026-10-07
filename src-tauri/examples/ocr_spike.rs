//! v1.7 OCR phase-1 spike (ADR-134, "Phase 1"). Corpus files are named by ID only (rule 16): the example resolves IDs through the
//! untracked `review/owner/INDEX.md` and prints and writes IDs, never names. Output goes to `review/v170/` (git-ignored).
//!
//! ```text
//! cargo run --release --example ocr_spike -- probe                 # classify every listed file, write probe.json
//! cargo run --release --example ocr_spike -- run [pages] [ids...]  # probe, render, OCR, layer, save, verify; metrics.json
//! cargo run --release --example ocr_spike -- robust [id]           # kill the child mid-page, malformed header
//! ```

use std::collections::{BTreeMap, HashSet};
use std::fs::File;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use sheer_lib::documents::{DocumentId, Registry};
use sheer_lib::engine::SearchSpec;
use sheer_lib::engine::{library_path, Engine};
use sheer_lib::export::snapshot::EngineDocRef;
use sheer_lib::ocr::backend::ChildClient;
use sheer_lib::ocr::{limits, OcrLine, OcrPageLayer, OcrWord, PageOcrClass};
use sheer_lib::pdfwrite::ocr_layer::{apply_ocr_layers, PageGeom};
use sheer_lib::pdfwrite::ocr_probe::{
    image_only_pdf, rotated_copy, ImageCover, ProbeDoc, ScanPage,
};
use sheer_lib::pdfwrite::redact::RasterPixels;

type R<T> = Result<T, String>;

fn s<E: std::fmt::Debug>(e: E) -> String {
    format!("{e:?}")
}

fn repo() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..")
}

fn out_dir() -> PathBuf {
    let dir = repo().join("review").join("v170");
    let _ = std::fs::create_dir_all(dir.join("tmp"));
    dir
}

// --- corpus (same parsing as tests/support/corpus.rs) ------------------------------------------------------------------

fn index_rows() -> Vec<(String, String)> {
    let text = std::fs::read_to_string(repo().join("review/owner/INDEX.md")).unwrap_or_default();
    text.lines()
        .filter(|l| l.starts_with('|'))
        .filter_map(|l| {
            let cells: Vec<&str> = l.trim_matches('|').split('|').map(str::trim).collect();
            match cells.as_slice() {
                [a, b, ..] if !a.starts_with("---") && *a != "ID" && *a != "Key" => {
                    Some(((*a).to_owned(), (*b).to_owned()))
                }
                _ => None,
            }
        })
        .collect()
}

fn corpus_ids() -> Vec<String> {
    index_rows()
        .into_iter()
        .map(|(k, _)| k)
        .filter(|k| (k.starts_with("owner-pdf-") || k.starts_with("corpus-")) && !k.contains('/'))
        .collect()
}

fn corpus_file(id: &str) -> Option<PathBuf> {
    if id.starts_with("synth-") {
        let p = out_dir().join("tmp").join(format!("{id}.pdf"));
        return p.is_file().then_some(p);
    }
    let name = index_rows().into_iter().find(|(k, _)| k == id)?.1;
    let base = if id.starts_with("owner-scan-") {
        "review/owner"
    } else {
        "review/owner/corpus"
    };
    let path = repo().join(base).join(name);
    path.is_file().then_some(path)
}

// --- engine helpers ---------------------------------------------------------------------------------------------------

struct Ctx {
    engine: Engine,
    registry: Registry,
}

impl Ctx {
    fn new() -> R<Self> {
        let library = library_path(&PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("pdfium"));
        if !library.is_file() {
            return Err("pdfium library missing (npm run fetch-pdfium)".into());
        }
        Ok(Self {
            engine: Engine::start(library),
            registry: Registry::new(),
        })
    }

    fn open(&self, path: &Path) -> R<(DocumentId, u32)> {
        let id = self.registry.register(path.to_path_buf()).map_err(s)?;
        let pages = self
            .engine
            .open(id, File::open(path).map_err(s)?, |_| true)
            .map_err(s)?;
        Ok((id, pages))
    }
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

fn raw_of(pixels: &RasterPixels) -> &[u8] {
    match pixels {
        RasterPixels::Gray8(g) => g,
        RasterPixels::Rgb8(r) => r,
    }
}

struct PageInfo {
    class: PageOcrClass,
    cover: ImageCover,
    rotate: u16,
}

/// ADR-134 item 5, phase-1 subset: `Scan` = fewer than 16 non-blank characters and images over at least 60 % of the box.
fn classify(ctx: &Ctx, id: DocumentId, lop: &ProbeDoc, index: u32) -> R<PageInfo> {
    let chars = ctx
        .engine
        .text_layer(id, index)
        .map_err(s)?
        .text
        .chars()
        .filter(|c| !c.is_whitespace())
        .count();
    let geom = lop.geom(index).ok_or("page")?;
    if chars >= 16 {
        return Ok(PageInfo {
            class: PageOcrClass::Text,
            cover: ImageCover {
                fraction: 0.0,
                eff_dpi: 0.0,
            },
            rotate: geom.rotate,
        });
    }
    let cover = lop.cover(index);
    let class = if cover.fraction >= 0.6 {
        PageOcrClass::Scan
    } else if chars == 0 {
        PageOcrClass::Empty
    } else {
        PageOcrClass::Text
    };
    Ok(PageInfo {
        class,
        cover,
        rotate: geom.rotate,
    })
}

fn probe_file(ctx: &Ctx, path: &Path) -> R<(Vec<PageInfo>, Value)> {
    let bytes = std::fs::read(path).map_err(s)?;
    let lop = ProbeDoc::load(&bytes).map_err(s)?;
    let (id, count) = ctx.open(path)?;
    let mut infos = Vec::new();
    for i in 0..count {
        infos.push(classify(ctx, id, &lop, i)?);
    }
    let _ = ctx.engine.close(id);
    let n = |c: PageOcrClass| infos.iter().filter(|p| p.class == c).count();
    let summary = json!({
        "pages": count, "scan": n(PageOcrClass::Scan), "text": n(PageOcrClass::Text), "empty": n(PageOcrClass::Empty),
        "rotated": infos.iter().filter(|p| p.rotate != 0).count(),
        "scan_eff_dpi_median": median(infos.iter().filter(|p| p.class == PageOcrClass::Scan).map(|p| p.cover.eff_dpi as f64).collect()),
    });
    Ok((infos, summary))
}

fn median(mut v: Vec<f64>) -> f64 {
    if v.is_empty() {
        return 0.0;
    }
    v.sort_by(|a, b| a.total_cmp(b));
    v[v.len() / 2]
}

fn percentile(v: &[f64], p: f64) -> f64 {
    if v.is_empty() {
        return 0.0;
    }
    let mut v = v.to_vec();
    v.sort_by(|a, b| a.total_cmp(b));
    v[(((v.len() - 1) as f64) * p).round() as usize]
}

fn stats(v: &[f64]) -> Value {
    let mean = if v.is_empty() {
        0.0
    } else {
        v.iter().sum::<f64>() / v.len() as f64
    };
    json!({ "n": v.len(), "mean": r2(mean), "p50": r2(percentile(v, 0.5)), "p95": r2(percentile(v, 0.95)), "max": r2(percentile(v, 1.0)) })
}

fn r2(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}

fn cmd_probe(ctx: &Ctx) -> R<()> {
    let mut all = serde_json::Map::new();
    for id in corpus_ids() {
        let Some(path) = corpus_file(&id) else {
            all.insert(id, json!({ "error": "missing" }));
            continue;
        };
        let started = Instant::now();
        match probe_file(ctx, &path) {
            Ok((_, summary)) => {
                eprintln!("{id}: {summary} ({} ms)", started.elapsed().as_millis());
                all.insert(id, summary);
            }
            Err(e) => {
                eprintln!("{id}: probe failed");
                all.insert(
                    id,
                    json!({ "error": e.chars().take(60).collect::<String>() }),
                );
            }
        }
    }
    std::fs::write(
        out_dir().join("probe.json"),
        serde_json::to_string_pretty(&all).map_err(s)?,
    )
    .map_err(s)
}

// --- rendering and OCR ----------------------------------------------------------------------------------------------

struct Rendered {
    gray: Vec<u8>,
    w: u32,
    h: u32,
    dpi: f32,
}

fn render_for_ocr(
    ctx: &Ctx,
    doc: DocumentId,
    index: u32,
    geom: &PageGeom,
    eff_dpi: f32,
) -> R<Rendered> {
    let mut dpi = if eff_dpi > 0.0 && eff_dpi < 300.0 {
        eff_dpi.max(200.0)
    } else {
        300.0
    };
    let (dw, dh) = geom.display_size();
    let long_px = dw.max(dh) * dpi / 72.0;
    if long_px > limits::MAX_SIDE_PX as f32 {
        dpi = limits::MAX_SIDE_PX as f32 * 72.0 / dw.max(dh);
    }
    if dpi < 150.0 {
        return Err("page_too_large".into());
    }
    let page = ctx
        .engine
        .render_export(EngineDocRef::Live(doc), index, dpi, false, 0)
        .map_err(s)?;
    Ok(Rendered {
        w: page.width,
        h: page.height,
        gray: gray_of(page.pixels),
        dpi,
    })
}

/// The pixel boxes of a reply scaled to displayed points.
fn to_points(layer: &OcrPageLayer, geom: &PageGeom, r: &Rendered) -> OcrPageLayer {
    let (dw, dh) = geom.display_size();
    let (sx, sy) = (dw / r.w as f32, dh / r.h as f32);
    OcrPageLayer {
        lang: layer.lang.clone(),
        angle_deg: layer.angle_deg,
        dpi: r.dpi,
        lines: layer
            .lines
            .iter()
            .map(|l| OcrLine {
                words: l
                    .words
                    .iter()
                    .map(|w| OcrWord {
                        text: w.text.clone(),
                        rect: [
                            w.rect[0] * sx,
                            w.rect[1] * sy,
                            w.rect[2] * sx,
                            w.rect[3] * sy,
                        ],
                    })
                    .collect(),
            })
            .collect(),
    }
}

fn working_set_kb(pid: u32) -> Option<u64> {
    let out = std::process::Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
        .output()
        .ok()?;
    let line = String::from_utf8_lossy(&out.stdout).into_owned();
    let field = line
        .trim()
        .rsplit("\",\"")
        .next()?
        .trim_end_matches('"')
        .to_owned();
    field
        .chars()
        .filter(char::is_ascii_digit)
        .collect::<String>()
        .parse()
        .ok()
}

fn norm(t: &str) -> String {
    t.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn utf16(t: &str) -> Vec<u16> {
    t.encode_utf16().collect()
}

fn find_from(hay: &[u16], needle: &[u16], from: usize) -> Option<usize> {
    if needle.is_empty() || from >= hay.len() {
        return None;
    }
    (from..=hay.len().saturating_sub(needle.len())).find(|&i| hay[i..i + needle.len()] == *needle)
}

/// OCR of `pages` of the file at `path`, written and verified; `label` names the run in the metrics.
fn process(
    ctx: &Ctx,
    client: &mut ChildClient,
    label: &str,
    path: &Path,
    pages: &[u32],
    samples: bool,
) -> R<Value> {
    let original = std::fs::read(path).map_err(s)?;
    let lop = ProbeDoc::load(&original).map_err(s)?;
    let (doc, count) = ctx.open(path)?;
    let mut infos = BTreeMap::new();
    for &i in pages {
        infos.insert(i, classify(ctx, doc, &lop, i)?);
    }
    let classified_scan = infos
        .values()
        .filter(|p| p.class == PageOcrClass::Scan)
        .count();

    // render + OCR
    let mut layers: BTreeMap<u32, OcrPageLayer> = BTreeMap::new();
    let mut renders: BTreeMap<u32, Rendered> = BTreeMap::new();
    let (mut t_render, mut t_ocr, mut t_total) = (Vec::new(), Vec::new(), Vec::new());
    let mut rss_kb = 0u64;
    let mut failed = Vec::new();
    for &i in pages {
        let started = Instant::now();
        let geom = lop.geom(i).ok_or("page")?;
        let t0 = Instant::now();
        let rendered = match render_for_ocr(ctx, doc, i, &geom, infos[&i].cover.eff_dpi) {
            Ok(r) => r,
            Err(e) => {
                failed.push(json!({ "page": i, "error": e }));
                continue;
            }
        };
        t_render.push(t0.elapsed().as_secs_f64() * 1000.0);
        let t1 = Instant::now();
        match client.recognize(
            &rendered.gray,
            rendered.w,
            rendered.h,
            "de-DE",
            limits::PAGE_TIMEOUT,
        ) {
            Ok(layer) => {
                t_ocr.push(t1.elapsed().as_secs_f64() * 1000.0);
                if let Some(pid) = client.child_id() {
                    rss_kb = rss_kb.max(working_set_kb(pid).unwrap_or(0));
                }
                layers.insert(i, to_points(&layer, &geom, &rendered));
                renders.insert(i, rendered);
            }
            Err(e) => failed.push(json!({ "page": i, "error": e.to_string() })),
        }
        t_total.push(started.elapsed().as_secs_f64() * 1000.0);
    }

    // layer + incremental save
    let t_layer = Instant::now();
    let saved = apply_ocr_layers(
        original.clone(),
        &layers,
        std::env::var_os("SHEER_EMPTY_GLYPH").is_none(),
    )
    .map_err(s)?;
    let layer_ms = t_layer.elapsed().as_secs_f64() * 1000.0;
    let saved_path = out_dir().join("tmp").join(format!("{label}-ocr.pdf"));
    std::fs::write(&saved_path, &saved).map_err(s)?;
    let prefix_ok = saved.len() > original.len() && saved[..original.len()] == original[..];

    // re-open with PDFium
    let (sid, scount) = ctx.open(&saved_path)?;
    let mut words_total = 0usize;
    let mut probes: Vec<(u32, String)> = Vec::new();
    let mut seen = HashSet::new();
    let mut all_tokens: Vec<(u32, String)> = Vec::new();
    for (&i, layer) in &layers {
        for w in layer.lines.iter().flat_map(|l| &l.words) {
            words_total += 1;
            let token: String = w
                .text
                .trim_matches(|c: char| !c.is_alphanumeric())
                .to_owned();
            if token.chars().count() >= 4
                && token.chars().all(char::is_alphabetic)
                && seen.insert(token.to_lowercase())
            {
                all_tokens.push((i, token));
            }
        }
    }
    let step = (all_tokens.len() as f64 / 20.0).max(1.0);
    for k in 0..20.min(all_tokens.len()) {
        probes.push(all_tokens[((k as f64) * step) as usize].clone());
    }
    let (mut search_hit, mut extract_hit) = (0usize, 0usize);
    for (i, token) in &probes {
        let spec = Arc::new(SearchSpec {
            text: token.clone(),
            match_case: false,
            whole_word: false,
        });
        if ctx
            .engine
            .search_page(sid, *i, spec, 5)
            .map(|h| !h.is_empty())
            .unwrap_or(false)
        {
            search_hit += 1;
        }
        if let Ok(t) = ctx.engine.text_layer(sid, *i) {
            if t.text.to_lowercase().contains(&token.to_lowercase()) {
                extract_hit += 1;
            }
        }
    }

    // lines, doubled spaces, selection boxes
    let (mut lines_total, mut lines_equal, mut doubled_pages) = (0usize, 0usize, 0usize);
    let (mut lines_split, mut lines_spacing, mut lines_other, mut lines_hyphen) =
        (0usize, 0usize, 0usize, 0usize);
    let (mut words_boxed, mut words_found) = (0usize, 0usize);
    let mut dev: [Vec<f64>; 4] = Default::default();
    let mut worst = Vec::new();
    for (&i, layer) in &layers {
        let geom = lop.geom(i).ok_or("page")?;
        let tp = ctx.engine.text_layer(sid, i).map_err(s)?;
        if tp.text.contains("  ") {
            doubled_pages += 1;
        }
        let actual: HashSet<String> = tp.text.lines().map(norm).collect();
        for line in &layer.lines {
            lines_total += 1;
            let expected = norm(
                &line
                    .words
                    .iter()
                    .map(|w| w.text.as_str())
                    .collect::<Vec<_>>()
                    .join(" "),
            );
            if actual.contains(&expected) {
                lines_equal += 1;
            } else if expected.ends_with('-')
                && actual
                    .iter()
                    .any(|a| a.contains(&expected[..expected.len() - 1]))
            {
                lines_hyphen += 1;
            } else {
                let flat = norm(&tp.text);
                let squash = |t: &str| t.chars().filter(|c| !c.is_whitespace()).collect::<String>();
                if flat.contains(&expected) {
                    lines_split += 1;
                    if std::env::var_os("SHEER_DEBUG").is_some() {
                        let near = actual
                            .iter()
                            .find(|a| a.contains(&expected))
                            .cloned()
                            .unwrap_or_default();
                        if lines_split % 15 == 1 {
                            eprintln!(
                                "split: expected={expected:?}
       actual  ={near:?}"
                            );
                        }
                    }
                } else if squash(&tp.text).contains(&squash(&expected)) {
                    lines_spacing += 1;
                } else {
                    lines_other += 1;
                    if std::env::var_os("SHEER_DEBUG").is_some() && lines_other % 9 == 1 {
                        let first = line
                            .words
                            .first()
                            .map(|w| w.text.clone())
                            .unwrap_or_default();
                        let near = actual
                            .iter()
                            .find(|a| a.contains(&first))
                            .cloned()
                            .unwrap_or_default();
                        eprintln!(
                            "other: expected={expected:?}
       actual  ={near:?}"
                        );
                    }
                }
            }
        }
        let units = utf16(&tp.text);
        // Each OCR word is matched to the occurrence of its text in PDFium's text whose box is nearest to the OCR box (PDFium may order
        // lines differently from the layer, so a sequential match would cascade).
        let union_box = |at: usize, len: usize| {
            let (mut x0, mut y0, mut x1, mut y1) = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
            for u in at..at + len {
                let b = &tp.boxes[4 * u..4 * u + 4];
                x0 = x0.min(b[0]);
                y0 = y0.min(b[1]);
                x1 = x1.max(b[0] + b[2]);
                y1 = y1.max(b[1] + b[3]);
            }
            [x0, y0, x1, y1]
        };
        for w in layer.lines.iter().flat_map(|l| &l.words) {
            words_boxed += 1;
            let hyphen_end = w.text.chars().count() > 1 && w.text.ends_with('-');
            let needle = utf16(if hyphen_end {
                &w.text[..w.text.len() - 1]
            } else {
                &w.text
            });
            let a = geom.display_to_page(w.rect[0], w.rect[1]);
            let b = geom.display_to_page(w.rect[2], w.rect[3]);
            let e = [a.0.min(b.0), a.1.min(b.1), a.0.max(b.0), a.1.max(b.1)];
            let mut best: Option<([f32; 4], f32)> = None;
            let mut from = 0usize;
            while let Some(at) = find_from(&units, &needle, from) {
                from = at + 1;
                let u = union_box(at, needle.len());
                let dist =
                    ((u[0] + u[2]) - (e[0] + e[2])).abs() + ((u[1] + u[3]) - (e[1] + e[3])).abs();
                if best.is_none_or(|(_, d)| dist < d) {
                    best = Some((u, dist));
                }
            }
            let Some((u, _)) = best else {
                if std::env::var_os("SHEER_DEBUG").is_some() && words_boxed % 5 == 0 {
                    eprintln!(
                        "nomatch: {:?} {:?}",
                        w.text,
                        w.text.chars().map(|c| c as u32).collect::<Vec<_>>()
                    );
                }
                continue;
            };
            words_found += 1;
            let mut d = [
                (u[0] - e[0]).abs(),
                (u[1] - e[1]).abs(),
                (u[2] - e[2]).abs(),
                (u[3] - e[3]).abs(),
            ];
            if hyphen_end {
                d[2] = 0.0; // PDFium drops a line-end hyphen from the text, so the right edge cannot be read back
            }
            let m = d.iter().cloned().fold(0.0f32, f32::max) as f64;
            for k in 0..4 {
                dev[k].push(f64::from(d[k]));
            }
            worst.push(m);
        }
    }
    let within = worst.iter().filter(|&&m| m <= 1.5).count();

    // invisibility: 150 dpi render pixel diff, original vs saved
    let mut diff_pages = 0usize;
    let mut diff_pixels = 0usize;
    for &i in layers.keys() {
        let a = ctx
            .engine
            .render_export(EngineDocRef::Live(doc), i, 150.0, false, 0)
            .map_err(s)?;
        let b = ctx
            .engine
            .render_export(EngineDocRef::Live(sid), i, 150.0, false, 0)
            .map_err(s)?;
        let (ra, rb) = (raw_of(&a.pixels), raw_of(&b.pixels));
        let n = if a.width != b.width || a.height != b.height || ra.len() != rb.len() {
            usize::MAX
        } else {
            ra.iter().zip(rb).filter(|(x, y)| x != y).count()
        };
        if n > 0 {
            diff_pages += 1;
            diff_pixels = diff_pixels.saturating_add(n);
        }
    }

    let sample_note = if samples {
        write_samples(label, &layers, &renders)?
    } else {
        Value::Null
    };
    let _ = ctx.engine.close(doc);
    let _ = ctx.engine.close(sid);
    let frac = |a: usize, b: usize| {
        if b == 0 {
            0.0
        } else {
            r2(100.0 * a as f64 / b as f64)
        }
    };
    let words_ok = frac(within, words_boxed);
    Ok(json!({
        "label": label,
        "pages_list": layers.keys().collect::<Vec<_>>(), "pages_total": count, "pages_saved": scount, "pages_requested": pages.len(), "pages_ocr_ok": layers.len(),
        "classified_scan": classified_scan, "failed": failed,
        "dpi": renders.values().map(|r| r.dpi as f64).collect::<Vec<_>>().first().copied().unwrap_or(0.0),
        "ms_render": stats(&t_render), "ms_ocr": stats(&t_ocr), "ms_page_total": stats(&t_total), "ms_layer_all_pages": r2(layer_ms),
        "child_working_set_mb_after_page": rss_kb / 1024,
        "words": words_total, "line_count": lines_total,
        "search": { "probes": probes.len(), "found_by_search_page": search_hit, "found_in_extracted_text": extract_hit },
        "lines_copy_equal_pct": frac(lines_equal, lines_total), "lines_copy_equal_incl_hyphen_join_pct": frac(lines_equal + lines_hyphen, lines_total), "lines": { "total": lines_total, "equal": lines_equal, "hyphen_joined_by_pdfium": lines_hyphen, "split_by_pdfium": lines_split, "spacing_only": lines_spacing, "other": lines_other },
        "pages_with_doubled_spaces": doubled_pages,
        "selection": {
            "words": words_boxed, "found_in_text": words_found, "within_1_5pt_pct": words_ok,
            "edge_dev_left": stats(&dev[0]), "edge_dev_top": stats(&dev[1]), "edge_dev_right": stats(&dev[2]), "edge_dev_bottom": stats(&dev[3]),
        },
        "prefix_ok": prefix_ok,
        "render150": { "pages_compared": layers.len(), "pages_differing": diff_pages, "pixels_differing": diff_pixels },
        "samples": sample_note,
    }))
}

// --- accuracy samples (hand-check material) -----------------------------------------------------------------------------

fn write_png(path: &Path, gray: &[u8], w: u32, h: u32) -> R<()> {
    let file = File::create(path).map_err(s)?;
    let mut enc = png::Encoder::new(std::io::BufWriter::new(file), w, h);
    enc.set_color(png::ColorType::Grayscale);
    enc.set_depth(png::BitDepth::Eight);
    enc.write_header()
        .map_err(s)?
        .write_image_data(gray)
        .map_err(s)
}

/// Three crops (first, middle, last OCR page) of about 70-100 words each, and the OCR text of exactly the lines inside each crop.
fn write_samples(
    label: &str,
    layers: &BTreeMap<u32, OcrPageLayer>,
    renders: &BTreeMap<u32, Rendered>,
) -> R<Value> {
    let keys: Vec<u32> = layers.keys().copied().collect();
    if keys.is_empty() {
        return Ok(Value::Null);
    }
    let picks: Vec<u32> = [0, keys.len() / 2, keys.len() - 1]
        .iter()
        .map(|&k| keys[k])
        .collect();
    let mut txt = String::new();
    let mut total_words = 0usize;
    for (n, page) in picks.iter().enumerate() {
        let (layer, r) = (&layers[page], &renders[page]);
        // lines with at least 3 words, in order; start a third of the way down, take lines until about 80 words
        let usable: Vec<usize> = (0..layer.lines.len())
            .filter(|&k| layer.lines[k].words.len() >= 3)
            .collect();
        if usable.is_empty() {
            continue;
        }
        let start = usable[usable.len() / 3];
        let (mut first, mut last, mut words) = (start, start, 0usize);
        while last < layer.lines.len() && words < 80 {
            words += layer.lines[last].words.len();
            last += 1;
        }
        let last = last.saturating_sub(1).max(first);
        first = first.min(last);
        let (sx, sy) = (
            r.w as f32
                / layer
                    .lines
                    .iter()
                    .flat_map(|l| &l.words)
                    .map(|w| w.rect[2])
                    .fold(1.0, f32::max)
                    .max(1.0),
            1.0,
        );
        let _ = (sx, sy);
        // pixel scale: points to pixels
        let scale = r.dpi / 72.0;
        let chosen = &layer.lines[first..=last];
        let ys: Vec<f32> = chosen
            .iter()
            .flat_map(|l| l.words.iter().flat_map(|w| [w.rect[1], w.rect[3]]))
            .collect();
        let xs: Vec<f32> = chosen
            .iter()
            .flat_map(|l| l.words.iter().flat_map(|w| [w.rect[0], w.rect[2]]))
            .collect();
        let pad = 6.0;
        let min = |v: &[f32]| v.iter().cloned().fold(f32::MAX, f32::min);
        let max = |v: &[f32]| v.iter().cloned().fold(f32::MIN, f32::max);
        let cx0 = ((min(&xs) - pad) * scale).max(0.0) as u32;
        let cx1 = (((max(&xs) + pad) * scale) as u32).min(r.w);
        let cy0 = ((min(&ys) - pad) * scale).max(0.0) as u32;
        let cy1 = (((max(&ys) + pad) * scale) as u32).min(r.h);
        let (cw, ch) = (
            cx1.saturating_sub(cx0).max(1),
            cy1.saturating_sub(cy0).max(1),
        );
        let mut crop = Vec::with_capacity((cw * ch) as usize);
        for y in cy0..cy0 + ch {
            let row = (y * r.w + cx0) as usize;
            crop.extend_from_slice(&r.gray[row..row + cw as usize]);
        }
        write_png(
            &out_dir().join(format!("{label}-sample{}.png", n + 1)),
            &crop,
            cw,
            ch,
        )?;
        txt.push_str(&format!("=== region {} (page index {page}) ===\n", n + 1));
        let mut count = 0;
        for line in &layer.lines {
            let cy = line
                .words
                .iter()
                .map(|w| (w.rect[1] + w.rect[3]) / 2.0)
                .sum::<f32>()
                / line.words.len().max(1) as f32
                * scale;
            let cxm = line
                .words
                .iter()
                .map(|w| (w.rect[0] + w.rect[2]) / 2.0)
                .sum::<f32>()
                / line.words.len().max(1) as f32
                * scale;
            if cy >= cy0 as f32 && cy <= cy1 as f32 && cxm >= cx0 as f32 && cxm <= cx1 as f32 {
                txt.push_str(
                    &line
                        .words
                        .iter()
                        .map(|w| w.text.as_str())
                        .collect::<Vec<_>>()
                        .join(" "),
                );
                txt.push('\n');
                count += line.words.len();
            }
        }
        total_words += count;
        txt.push('\n');
    }
    std::fs::write(out_dir().join(format!("{label}-samples.txt")), txt).map_err(s)?;
    Ok(json!({ "regions": picks.len(), "words_in_regions": total_words }))
}

// --- run ----------------------------------------------------------------------------------------------------------------

fn sample_evenly(items: &[u32], n: usize) -> Vec<u32> {
    if items.len() <= n {
        return items.to_vec();
    }
    (0..n).map(|k| items[k * items.len() / n]).collect()
}

fn cmd_run(ctx: &Ctx, args: &[String]) -> R<()> {
    let per_file: usize = args.first().and_then(|a| a.parse().ok()).unwrap_or(8);
    let mut ids: Vec<String> = args.iter().skip(1).cloned().collect();
    let dir = out_dir();
    if ids.is_empty() {
        let probe: Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join("probe.json")).map_err(s)?)
                .map_err(s)?;
        let mut ranked: Vec<(String, u64)> = probe
            .as_object()
            .ok_or("probe")?
            .iter()
            .filter_map(|(k, v)| Some((k.clone(), v.get("scan")?.as_u64()?)))
            .filter(|(_, n)| *n > 0)
            .collect();
        ranked.sort_by_key(|(_, n)| std::cmp::Reverse(*n));
        ids = ranked.into_iter().take(5).map(|(k, _)| k).collect();
    }
    let exe = std::env::current_exe().map_err(s)?;
    let mut client = ChildClient::new(exe);
    let mut report = serde_json::Map::new();
    for id in &ids {
        let path = corpus_file(id).ok_or_else(|| format!("{id}: not found"))?;
        let (infos, summary) = probe_file(ctx, &path)?;
        let scans: Vec<u32> = infos
            .iter()
            .enumerate()
            .filter(|(_, p)| p.class == PageOcrClass::Scan)
            .map(|(i, _)| i as u32)
            .collect();
        let chosen = sample_evenly(&scans, per_file);
        eprintln!("{id}: {} scan pages, running {}", scans.len(), chosen.len());
        let mut entry = process(ctx, &mut client, id, &path, &chosen, true)?;
        entry["probe"] = summary;
        eprintln!("{id}: done");
        // the rotated copy of the first upright scan page of the first file only
        if report.is_empty() {
            if let Some(&index) = scans.iter().find(|&&i| infos[i as usize].rotate == 0) {
                let bytes = rotated_copy(&std::fs::read(&path).map_err(s)?, index).map_err(s)?;
                let rot = dir.join("tmp").join("rot90-source.pdf");
                std::fs::write(&rot, bytes).map_err(s)?;
                let mut r = process(
                    ctx,
                    &mut client,
                    &format!("{id}-rot90"),
                    &rot,
                    &[index],
                    false,
                )?;
                r["note"] = json!("synthetic /Rotate 90 copy of one upright scan page");
                entry["rot90_synthetic"] = r;
                eprintln!("{id}: rot90 done");
            }
        }
        report.insert(id.clone(), entry);
        std::fs::write(
            dir.join("metrics.json"),
            serde_json::to_string_pretty(&report).map_err(s)?,
        )
        .map_err(s)?;
    }
    println!("spawned children: {}", client.spawned);
    Ok(())
}

// --- robustness -------------------------------------------------------------------------------------------------------

fn raw_child() -> R<std::process::Child> {
    std::process::Command::new(std::env::current_exe().map_err(s)?)
        .arg(sheer_lib::ocr::CHILD_FLAG)
        .env(sheer_lib::ocr::CHILD_ENV, "1")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(s)
}

fn malformed(bytes: &[u8]) -> R<Value> {
    use std::io::Write;
    let mut child = raw_child()?;
    let mut stdin = child.stdin.take().ok_or("stdin")?;
    let mut stdout = child.stdout.take().ok_or("stdout")?;
    stdin.write_all(bytes).map_err(s)?;
    drop(stdin);
    let reply = sheer_lib::ocr::wire::read_reply(&mut stdout).ok();
    let t = Instant::now();
    let code = loop {
        if let Some(status) = child.try_wait().map_err(s)? {
            break status.code();
        }
        if t.elapsed() > Duration::from_secs(5) {
            let _ = child.kill();
            break None;
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    Ok(
        json!({ "refused": reply.as_ref().is_some_and(|r| !r.ok), "error": reply.and_then(|r| r.error), "exit_code": code }),
    )
}

fn cmd_robust(ctx: &Ctx, args: &[String]) -> R<()> {
    let id = args.first().cloned().or_else(|| {
        let p: Value =
            serde_json::from_str(&std::fs::read_to_string(out_dir().join("probe.json")).ok()?)
                .ok()?;
        p.as_object()?
            .iter()
            .find(|(_, v)| v.get("scan").and_then(Value::as_u64).unwrap_or(0) > 0)
            .map(|(k, _)| k.clone())
    });
    let id = id.ok_or("no scanned file")?;
    let path = corpus_file(&id).ok_or("file")?;
    let bytes = std::fs::read(&path).map_err(s)?;
    let lop = ProbeDoc::load(&bytes).map_err(s)?;
    let (doc, count) = ctx.open(&path)?;
    let mut page_index = 0;
    for i in 0..count {
        if classify(ctx, doc, &lop, i)?.class == PageOcrClass::Scan {
            page_index = i;
            break;
        }
    }
    let geom = lop.geom(page_index).ok_or("page")?;
    let r = render_for_ocr(ctx, doc, page_index, &geom, 300.0)?;
    let exe = std::env::current_exe().map_err(s)?;
    let mut client = ChildClient::new(exe);
    let mut steps = serde_json::Map::new();
    let t = Instant::now();
    let first = client.recognize(&r.gray, r.w, r.h, "de-DE", limits::PAGE_TIMEOUT);
    steps.insert("baseline".into(), json!({ "ok": first.as_ref().map(|l| l.lines.len()).unwrap_or(0) > 0, "ms": t.elapsed().as_millis() as u64 }));
    // 1. an outside kill in the middle of the page
    let pid = client.child_id().ok_or("child")?;
    let killer = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(40));
        let _ = std::process::Command::new("taskkill")
            .args(["/F", "/PID", &pid.to_string()])
            .output();
    });
    let t = Instant::now();
    let big = r.gray.repeat(2);
    let killed = client.recognize(&big, r.w, r.h * 2, "de-DE", limits::PAGE_TIMEOUT);
    let _ = killer.join();
    steps.insert("killed_mid_page".into(), json!({ "error": killed.as_ref().err().map(ToString::to_string), "ms": t.elapsed().as_millis() as u64 }));
    let after = client.recognize(&r.gray, r.w, r.h, "de-DE", limits::PAGE_TIMEOUT);
    steps.insert("next_page_after_kill".into(), json!({ "ok": after.is_ok(), "words": after.as_ref().map(|l| l.lines.len()).unwrap_or(0), "children_started": client.spawned }));
    // 2. the page timeout kills the child and the next page restarts one
    let timed = client.recognize(&r.gray, r.w, r.h, "de-DE", Duration::from_millis(30));
    let again = client.recognize(&r.gray, r.w, r.h, "de-DE", limits::PAGE_TIMEOUT);
    steps.insert("timeout_then_restart".into(), json!({ "timeout_error": timed.err().map(|e| e.to_string()), "next_ok": again.is_ok(), "children_started": client.spawned }));
    // 3. malformed headers, straight at a child
    steps.insert(
        "header_length_u32_max".into(),
        malformed(&u32::MAX.to_le_bytes())?,
    );
    let mut bad = 7u32.to_le_bytes().to_vec();
    bad.extend_from_slice(b"{\"v\":1}");
    steps.insert("header_wrong_shape".into(), malformed(&bad)?);
    let mut big = Vec::new();
    sheer_lib::ocr::wire::write_message(
        &mut big,
        &json!({ "v": 1, "id": 1, "w": 9000, "h": 9000, "stride": 9000, "format": "gray8", "lang": ["de-DE"] }),
        &[],
    )
    .map_err(s)?;
    steps.insert("bitmap_over_limits".into(), malformed(&big)?);
    let _ = ctx.engine.close(doc);
    let value = Value::Object(steps);
    println!("{}", serde_json::to_string_pretty(&value).map_err(s)?);
    std::fs::write(
        out_dir().join("robust.json"),
        serde_json::to_string_pretty(&value).map_err(s)?,
    )
    .map_err(s)
}

fn main() {
    if sheer_lib::ocr::child_mode_requested(
        std::env::args_os(),
        std::env::var_os(sheer_lib::ocr::CHILD_ENV).as_deref(),
    ) {
        if let Some(code) = sheer_lib::ocr_child_main() {
            std::process::exit(code);
        }
    }
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = Ctx::new().and_then(|ctx| match args.first().map(String::as_str) {
        Some("probe") => cmd_probe(&ctx),
        Some("run") => cmd_run(&ctx, &args[1..]),
        Some("robust") => cmd_robust(&ctx, &args[1..]),
        Some("scan") => cmd_scan(&ctx, &args[1..]),
        Some("dump") => cmd_dump(&ctx, &args[1..]),
        Some("synth") => args[1..].iter().try_for_each(|id| make_synth(&ctx, id, 8)),
        _ => Err("usage: ocr_spike probe | run [pages] [ids...] | robust [id]".into()),
    });
    if let Err(e) = result {
        eprintln!("error: {}", e.chars().take(200).collect::<String>());
        std::process::exit(1);
    }
}

// --- self-generated scans -----------------------------------------------------------------------------------------------

/// `synth-<ID>`: an image-only PDF made from dense text pages of corpus file `<ID>` (300 dpi, gray, no text layer), for the files
/// of the corpus that are not scans. Written to `review/v170/tmp/` and resolved by `corpus_file` through its ID.
fn make_synth(ctx: &Ctx, id: &str, pages_wanted: usize) -> R<()> {
    let path = corpus_file(id).ok_or("source file")?;
    let bytes = std::fs::read(&path).map_err(s)?;
    let lop = ProbeDoc::load(&bytes).map_err(s)?;
    let (doc, count) = ctx.open(&path)?;
    let mut dense = Vec::new();
    for i in 0..count {
        let chars = ctx
            .engine
            .text_layer(doc, i)
            .map_err(s)?
            .text
            .chars()
            .filter(|c| !c.is_whitespace())
            .count();
        let geom = lop.geom(i).ok_or("page")?;
        if chars >= 800 && geom.rotate == 0 {
            dense.push(i);
        }
    }
    let chosen = sample_evenly(&dense, pages_wanted);
    let mut scans = Vec::new();
    for &i in &chosen {
        let geom = lop.geom(i).ok_or("page")?;
        let r = render_for_ocr(ctx, doc, i, &geom, 300.0)?;
        let (dw, dh) = geom.display_size();
        scans.push(ScanPage {
            size_pt: [dw, dh],
            px: [r.w, r.h],
            gray: r.gray,
        });
    }
    let target = out_dir().join("tmp").join(format!("synth-{id}.pdf"));
    std::fs::write(&target, image_only_pdf(&scans).map_err(s)?).map_err(s)?;
    let _ = ctx.engine.close(doc);
    eprintln!("synth-{id}: {} pages", chosen.len());
    Ok(())
}

/// Debug: the first characters of a page of a file in `review/v170/tmp/` with their boxes.
fn cmd_dump(ctx: &Ctx, args: &[String]) -> R<()> {
    let path = out_dir()
        .join("tmp")
        .join(format!("{}.pdf", args.first().ok_or("label")?));
    let page: u32 = args.get(1).and_then(|a| a.parse().ok()).unwrap_or(0);
    let (doc, _) = ctx.open(&path)?;
    let t = ctx.engine.text_layer(doc, page).map_err(s)?;
    let units = utf16(&t.text);
    println!("rotation {} units {}", t.rotation, units.len());
    let from: usize = args.get(2).and_then(|a| a.parse().ok()).unwrap_or(0);
    for u in from..units.len().min(from + 40) {
        let b = &t.boxes[4 * u..4 * u + 4];
        println!(
            "{:?} {:.1} {:.1} {:.1} {:.1}",
            String::from_utf16_lossy(&units[u..u + 1]),
            b[0],
            b[1],
            b[2],
            b[3]
        );
    }
    Ok(())
}

/// `scan <id>`: the service path (cover, `render_dpi`, `render_for_ocr`, recognizer, layer) on every page; prints counts only.
fn cmd_scan(ctx: &Ctx, args: &[String]) -> R<()> {
    let id = args.first().ok_or("id")?;
    let path = corpus_file(id).ok_or("not found")?;
    let original = std::fs::read(&path).map_err(s)?;
    let lop = ProbeDoc::load(&original).map_err(s)?;
    let (doc, count) = ctx.open(&path)?;
    let mut client = ChildClient::new(std::env::current_exe().map_err(s)?);
    let mut layers: BTreeMap<u32, OcrPageLayer> = BTreeMap::new();
    for i in 0..count {
        let geom = lop.geom(i).ok_or("page")?;
        let cover = lop.cover(i);
        let dpi = limits::render_dpi(cover.eff_dpi);
        let raster = ctx
            .engine
            .render_for_ocr(EngineDocRef::Live(doc), i, dpi, limits::MAX_SIDE_PX)
            .map_err(s)?;
        let gray = gray_of(raster.pixels);
        let n = gray.len().max(1) as f64;
        let mean = gray.iter().map(|&v| f64::from(v)).sum::<f64>() / n;
        let var = gray
            .iter()
            .map(|&v| (f64::from(v) - mean).powi(2))
            .sum::<f64>()
            / n;
        let r = Rendered {
            w: raster.width,
            h: raster.height,
            gray,
            dpi,
        };
        let layer = client
            .recognize(&r.gray, r.w, r.h, "de-DE", limits::PAGE_TIMEOUT)
            .map_err(|e| e.to_string())?;
        let words = layer.lines.iter().map(|l| l.words.len()).sum::<usize>();
        let (dw, dh) = geom.display_size();
        let pts = to_points(&layer, &geom, &r);
        let inside = pts
            .lines
            .iter()
            .flat_map(|l| &l.words)
            .filter(|w| {
                w.rect[0] >= 0.0
                    && w.rect[1] >= 0.0
                    && w.rect[2] <= dw + 1.0
                    && w.rect[3] <= dh + 1.0
            })
            .count();
        println!(
            "p{} cover {:.2} effdpi {:.0} dpi {:.0} px {}x{} gray mean {:.0} sd {:.0} page {:.0}x{:.0}pt rot {} words {} inside {} lines {} angle {:.1}",
            i + 1, cover.fraction, cover.eff_dpi, dpi, r.w, r.h, mean, var.sqrt(), dw, dh, geom.rotate, words, inside, layer.lines.len(), layer.angle_deg
        );
        let shape = sheer_lib::ocr::textlayer::Shape {
            size: [dw, dh],
            rotation: geom.rotate,
        };
        let canon = sheer_lib::ocr::textlayer::canonical(&pts, shape);
        let key = format!("{id}/p{}", i + 1);
        let probes: Vec<String> = index_rows()
            .into_iter()
            .find(|(k, _)| *k == key)
            .map(|(_, v)| v.split(';').map(|w| w.trim().to_owned()).collect())
            .unwrap_or_default();
        let found = probes
            .iter()
            .filter(|w| {
                let spec = SearchSpec {
                    text: (*w).clone(),
                    match_case: false,
                    whole_word: false,
                };
                !sheer_lib::ocr::textlayer::search_page(&canon, shape, &spec, 5).is_empty()
            })
            .count();
        println!("p{} pending-layer search {}/{}", i + 1, found, probes.len());
        layers.insert(i, pts);
    }
    let saved = apply_ocr_layers(original, &layers, true).map_err(s)?;
    let out = out_dir().join("tmp").join("scan-ocr.pdf");
    std::fs::write(&out, &saved).map_err(s)?;
    let (sid, _) = ctx.open(&out)?;
    let mut hits = Vec::new();
    for i in 0..count {
        let key = format!("{id}/p{}", i + 1);
        let words: Vec<String> = index_rows()
            .into_iter()
            .find(|(k, _)| *k == key)
            .map(|(_, v)| v.split(';').map(|w| w.trim().to_owned()).collect())
            .unwrap_or_default();
        let mut k = 0;
        for w in &words {
            let spec = Arc::new(SearchSpec {
                text: w.clone(),
                match_case: false,
                whole_word: false,
            });
            if ctx
                .engine
                .search_page(sid, i, spec, 5)
                .map(|h| !h.is_empty())
                .unwrap_or(false)
            {
                k += 1;
            }
        }
        hits.push(format!("p{} {}/{}", i + 1, k, words.len()));
    }
    println!("search hits: {}", hits.join(", "));
    Ok(())
}
