//! The headers and footers a document already has (F19.12, ARCHITECTURE §16.2).
//!
//! | Command | Arguments | Returns |
//! |---|---|---|
//! | `detect_header_footer` | `docId: number` | `{ items, sampled, pageCount }`: `items` (at most 12) are the text pieces that lie in the top or bottom band of the sampled pages and come back on at least half of them (at least two when more than one page was read), or that are a page number: `{ edge: 'header' \| 'footer', slot: 'left' \| 'center' \| 'right', kind: 'text' \| 'pageNumber', text (<= 80 chars), rect: { x, y, w, h } /* page points, top left of the unrotated page, y down; the union over the pages */, pages /* on how many sampled pages */ }` |
//!
//! Read only: up to [`SAMPLE_PAGES`] pages spread over the document are read through the engine (`smart_text`, bounded characters and
//! time per page, `Background` priority); the document and the model are not changed. Pages that still show a layer of ours from the
//! file are not read (the next save replaces that layer). The analysis ([`detect`]) is pure and bounded: [`LINES_MAX`] lines and
//! [`RUNS_MAX`] runs per line are looked at, texts are cut to [`TEXT_CHARS_MAX`] characters.

use std::time::Instant;

use serde::Serialize;
use tauri::State;

use super::{blocking, AppState};
use crate::documents::{sanitize_text, DocumentId};
use crate::error::{AppError, ErrorCode, UiError};
use crate::model::annotation::Rgb;
use crate::model::header_footer::{box_rect, HfWrite, BACKGROUND_PAD};
use crate::model::page::PageSource;
use crate::model::page_ops::PagePlan;
use crate::pdfwrite::redact::{RasterPage, RasterPixels};
use crate::smartlinks::model::{PageText, PtRect};

/// Pages read at most.
pub const SAMPLE_PAGES: usize = 8;
/// Lines of a page that are looked at.
const LINES_MAX: usize = 400;
/// Runs of a line that are looked at.
const RUNS_MAX: usize = 64;
/// Characters of a text that are kept.
const TEXT_CHARS_MAX: usize = 80;
/// Pieces answered.
const ITEMS_MAX: usize = 12;
/// Pieces kept per edge while counting (hostile pages cannot grow the table).
const KEYS_MAX: usize = 64;
/// Time for the whole sample.
const BUDGET: std::time::Duration = std::time::Duration::from_secs(8);

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DetectedEdge {
    Header,
    Footer,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DetectedSlot {
    Left,
    Center,
    Right,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DetectedKind {
    Text,
    PageNumber,
}

/// One text piece of a margin band.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DetectedItem {
    pub edge: DetectedEdge,
    pub slot: DetectedSlot,
    pub kind: DetectedKind,
    pub text: String,
    pub rect: PtRect,
    pub pages: u32,
}

/// The answer of `detect_header_footer`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeaderFooterDetected {
    pub items: Vec<DetectedItem>,
    pub sampled: u32,
    pub page_count: u32,
}

/// The height of the band at each edge: 12 % of the page, 36 to 96 points.
fn band(height: f32) -> f32 {
    (height * 0.12).clamp(36.0, 96.0)
}

/// `text` lower case with every run of digits as one `#` and white space collapsed: the same piece on different pages has one key.
pub fn normalize(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut digits = false;
    for c in text.chars() {
        if c.is_ascii_digit() {
            if !digits {
                out.push('#');
            }
            digits = true;
            continue;
        }
        digits = false;
        if c.is_whitespace() {
            if !out.ends_with(' ') && !out.is_empty() {
                out.push(' ');
            }
        } else {
            out.extend(c.to_lowercase());
        }
    }
    out.trim().to_owned()
}

/// Whether a normalized piece is a page number: `#`, `page #`, `seite # von #`, `# / #`, `- # -`.
pub fn is_page_number(normalized: &str) -> bool {
    let mut digits = false;
    for word in normalized.split_whitespace() {
        if matches!(
            word,
            "page" | "seite" | "p." | "s." | "of" | "von" | "/" | "-" | "\u{2013}" | "\u{2014}"
        ) {
            continue;
        }
        if !word
            .chars()
            .all(|c| matches!(c, '#' | '/' | '-' | '\u{2013}' | '.'))
        {
            return false;
        }
        digits |= word.contains('#');
    }
    digits
}

#[derive(Debug, Clone)]
struct Key {
    edge: DetectedEdge,
    slot: DetectedSlot,
    normalized: String,
}

struct Tally {
    key: Key,
    text: String,
    rect: PtRect,
    pages: u32,
    last_page: usize,
}

fn union(a: PtRect, b: PtRect) -> PtRect {
    let (x0, y0) = (a.x.min(b.x), a.y.min(b.y));
    let (x1, y1) = ((a.x + a.w).max(b.x + b.w), (a.y + a.h).max(b.y + b.h));
    PtRect {
        x: x0,
        y: y0,
        w: x1 - x0,
        h: y1 - y0,
    }
}

fn finite(r: &PtRect) -> bool {
    [r.x, r.y, r.w, r.h].iter().all(|v| v.is_finite()) && r.w >= 0.0 && r.h >= 0.0
}

/// The text pieces of the margin bands that recur on the given pages (see the module documentation). Pure.
pub fn detect(pages: &[PageText]) -> Vec<DetectedItem> {
    let mut tallies: Vec<Tally> = Vec::new();
    let mut read = 0usize;
    for (page_at, page) in pages.iter().enumerate() {
        if !(page.width.is_finite() && page.height.is_finite())
            || page.width <= 0.0
            || page.height <= 0.0
        {
            continue;
        }
        read += 1;
        let band = band(page.height);
        for line in page.lines.iter().take(LINES_MAX) {
            if !finite(&line.rect) {
                continue;
            }
            let edge = if line.rect.y + line.rect.h <= band {
                DetectedEdge::Header
            } else if line.rect.y >= page.height - band {
                DetectedEdge::Footer
            } else {
                continue;
            };
            // Runs left to right, a gap of more than two sizes starts a new piece (left, centre and right of one line).
            let mut runs: Vec<_> = line
                .runs
                .iter()
                .take(RUNS_MAX)
                .filter(|r| finite(&r.rect))
                .collect();
            runs.sort_by(|a, b| a.rect.x.total_cmp(&b.rect.x));
            let mut pieces: Vec<(String, PtRect)> = Vec::new();
            let mut previous_end = f32::NEG_INFINITY;
            for run in runs {
                let gap = run.rect.x - previous_end;
                let size = if run.size.is_finite() {
                    run.size.max(1.0)
                } else {
                    10.0
                };
                previous_end = run.rect.x + run.rect.w;
                match pieces.last_mut() {
                    Some((text, rect)) if gap <= 2.0 * size => {
                        if gap > 0.15 * size && !text.ends_with(' ') {
                            text.push(' ');
                        }
                        text.push_str(&run.text);
                        *rect = union(*rect, run.rect);
                    }
                    _ => pieces.push((run.text.clone(), run.rect)),
                }
            }
            for (text, rect) in pieces {
                let text = sanitize_text(text.trim(), TEXT_CHARS_MAX);
                if !text.chars().any(char::is_alphanumeric) {
                    continue;
                }
                let centre = rect.x + rect.w / 2.0;
                let slot = if centre < page.width / 3.0 {
                    DetectedSlot::Left
                } else if centre > page.width * 2.0 / 3.0 {
                    DetectedSlot::Right
                } else {
                    DetectedSlot::Center
                };
                let key = Key {
                    edge,
                    slot,
                    normalized: normalize(&text),
                };
                let found = tallies.iter().position(|t| {
                    t.key.edge == key.edge
                        && t.key.slot == key.slot
                        && t.key.normalized == key.normalized
                });
                let known = tallies.len();
                match found.and_then(|at| tallies.get_mut(at)) {
                    Some(t) => {
                        t.rect = union(t.rect, rect);
                        if t.last_page != page_at {
                            t.pages += 1;
                            t.last_page = page_at;
                        }
                    }
                    None if known < KEYS_MAX => tallies.push(Tally {
                        key,
                        text,
                        rect,
                        pages: 1,
                        last_page: page_at,
                    }),
                    None => {}
                }
            }
        }
    }
    let needed = if read > 1 {
        u32::try_from(read.div_ceil(2)).unwrap_or(u32::MAX).max(2)
    } else {
        1
    };
    let mut items: Vec<DetectedItem> = tallies
        .into_iter()
        .filter(|t| t.pages >= needed)
        .map(|t| DetectedItem {
            edge: t.key.edge,
            slot: t.key.slot,
            kind: if is_page_number(&t.key.normalized) {
                DetectedKind::PageNumber
            } else {
                DetectedKind::Text
            },
            text: t.text,
            rect: t.rect,
            pages: t.pages,
        })
        .collect();
    items.sort_by_key(|i| (i.edge, i.slot));
    items.truncate(ITEMS_MAX);
    items
}

/// The positions (0-based) of up to [`SAMPLE_PAGES`] of `count` pages, spread evenly, first and last included.
pub fn sample_positions(count: usize) -> Vec<usize> {
    let k = count.min(SAMPLE_PAGES);
    match k {
        0 => Vec::new(),
        1 => vec![0],
        _ => (0..k).map(|i| i * (count - 1) / (k - 1)).collect(),
    }
}

impl AppState {
    /// See the module documentation.
    pub fn detect_header_footer(&self, id: DocumentId) -> Result<HeaderFooterDetected, AppError> {
        let order = self.registry.page_order(id)?;
        let layers = self.model(id, |state| Ok(state.header_footer.layer_pages.clone()))?;
        let readable: Vec<u32> = order
            .iter()
            .map(|&(_, engine)| engine)
            .filter(|engine| !layers.contains(engine))
            .collect();
        let started = Instant::now();
        let mut pages = Vec::new();
        for at in sample_positions(readable.len()) {
            let Some(left) = BUDGET
                .checked_sub(started.elapsed())
                .filter(|d| !d.is_zero())
            else {
                break;
            };
            let Some(&engine) = readable.get(at) else {
                continue;
            };
            match self.engine.smart_text_within(id, engine, left) {
                Ok(page) => pages.push(page),
                Err(e) => match e.code() {
                    ErrorCode::InvalidArgument
                    | ErrorCode::DamagedFile
                    | ErrorCode::EngineTimeout => {}
                    _ => return Err(e),
                },
            }
        }
        Ok(HeaderFooterDetected {
            items: detect(&pages),
            sampled: u32::try_from(pages.len()).unwrap_or(u32::MAX),
            page_count: u32::try_from(order.len()).unwrap_or(u32::MAX),
        })
    }
}

/// Pages larger than this (square points) stay white: the raster would be big.
const FILL_AREA_MAX: f32 = 4_000_000.0;
/// Pixels looked at per box.
const FILL_PIXELS_MAX: usize = 4096;
/// Time for the whole sampling; past it the rest stays white.
const FILL_BUDGET: std::time::Duration = std::time::Duration::from_secs(6);

/// The page colour in `rect` (`[x0, y0, x1, y1]` in page space of a crop `crop_w` x `crop_h` points): the median of each channel of
/// the raster pixels under it (text pixels are the minority), near white snapped to white. `None` when the box lies outside.
pub fn sample_fill(raster: &RasterPage, crop_w: f32, crop_h: f32, rect: [f32; 4]) -> Option<Rgb> {
    if !(crop_w > 0.0 && crop_h > 0.0)
        || raster.width == 0
        || raster.height == 0
        || !rect.iter().all(|v| v.is_finite())
        || rect[2] < 0.0
        || rect[3] < 0.0
        || rect[0] > crop_w
        || rect[1] > crop_h
    {
        return None;
    }
    let (sx, sy) = (raster.width as f32 / crop_w, raster.height as f32 / crop_h);
    let clamp = |v: f32, max: u32| (v.max(0.0) as u32).min(max);
    let (x0, x1) = (
        clamp(rect[0] * sx, raster.width - 1),
        clamp((rect[2] * sx).ceil(), raster.width - 1),
    );
    let (y0, y1) = (
        clamp(rect[1] * sy, raster.height - 1),
        clamp((rect[3] * sy).ceil(), raster.height - 1),
    );
    let (w, h) = ((x1 - x0 + 1) as usize, (y1.max(y0) - y0 + 1) as usize);
    let step = (w * h).div_ceil(FILL_PIXELS_MAX).max(1);
    let mut channels: [Vec<u8>; 3] = [Vec::new(), Vec::new(), Vec::new()];
    for n in (0..w * h).step_by(step) {
        let (x, y) = (x0 as usize + n % w, y0 as usize + n / w);
        let at = y * raster.width as usize + x;
        let px = match &raster.pixels {
            RasterPixels::Rgb8(rgb) => rgb.get(at * 3..at * 3 + 3).map(|p| [p[0], p[1], p[2]]),
            RasterPixels::Gray8(gray) => gray.get(at).map(|g| [*g, *g, *g]),
        }?;
        for (c, v) in channels.iter_mut().zip(px) {
            c.push(v);
        }
    }
    let mut out = [0u8; 3];
    for (o, c) in out.iter_mut().zip(channels.iter_mut()) {
        c.sort_unstable();
        *o = *c.get(c.len() / 2)?;
    }
    if out.iter().all(|v| *v >= 245) {
        out = [255; 3];
    }
    Some(Rgb(out))
}

impl AppState {
    /// Fills in `run.fill` of a save's header runs with the page colour under each background box (F19.12). Renders up to
    /// [`SAMPLE_PAGES`] pages small through the engine (`Background`); the other pages take the colours of the sampled page before
    /// them. Any error or running out of time leaves the rest white.
    pub(super) fn sample_header_fills(
        &self,
        id: DocumentId,
        pages: &PagePlan,
        write: &mut HfWrite,
    ) {
        if !write.spec.as_ref().is_some_and(|s| s.background) {
            return;
        }
        let started = Instant::now();
        let sampled = sample_positions(write.pages.len());
        let mut last: Option<usize> = None;
        for at in 0..write.pages.len() {
            if sampled.contains(&at) {
                let Some(left) = FILL_BUDGET
                    .checked_sub(started.elapsed())
                    .filter(|d| !d.is_zero())
                else {
                    return;
                };
                if !self.sample_one(id, pages, write, at, left) {
                    return;
                }
                last = Some(at);
            } else if let Some(from) = last {
                let fills: Vec<Option<Rgb>> = write.pages[from].1.iter().map(|r| r.fill).collect();
                for (run, fill) in write.pages[at].1.iter_mut().zip(fills) {
                    run.fill = fill;
                }
            }
        }
    }

    /// Samples the runs of `write.pages[at]`; false when the page could not be rendered.
    fn sample_one(
        &self,
        id: DocumentId,
        pages: &PagePlan,
        write: &mut HfWrite,
        at: usize,
        left: std::time::Duration,
    ) -> bool {
        let Some((position, runs)) = write.pages.get_mut(at) else {
            return false;
        };
        let Some(page) = usize::try_from(*position)
            .ok()
            .and_then(|p| pages.pages.get(p))
        else {
            return false;
        };
        if !matches!(page.source, PageSource::File { .. }) {
            return true;
        }
        let crop = page.crop.unwrap_or(page.media);
        let (w, h) = ((crop[2] - crop[0]).abs(), (crop[3] - crop[1]).abs());
        if !(w > 0.0 && h > 0.0) || w * h > FILL_AREA_MAX {
            return true;
        }
        let dpi = 72.0; // the engine's minimum: one pixel per point
        let Ok(raster) =
            self.engine
                .render_for_redaction_within(id, page.engine_index, dpi, Vec::new(), left)
        else {
            return false;
        };
        // The render is of the unrotated page; a raster turned against the crop (it should not be) cannot be mapped: stay white.
        if (raster.width > raster.height) != (w > h) && (w - h).abs() > 1.0 {
            return true;
        }
        for run in runs.iter_mut() {
            run.fill = sample_fill(&raster, w, h, box_rect(run, BACKGROUND_PAD));
        }
        true
    }
}

/// The headers and footers the document already has (dialog hint and overlap warning).
#[tauri::command]
pub async fn detect_header_footer(
    state: State<'_, AppState>,
    doc_id: DocumentId,
) -> Result<HeaderFooterDetected, UiError> {
    let state = state.inner().clone();
    blocking(move || state.detect_header_footer(doc_id)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::smartlinks::model::{Line, Run};

    fn rect(x: f32, y: f32, w: f32, h: f32) -> PtRect {
        PtRect { x, y, w, h }
    }

    fn line(runs: &[(&str, f32, f32, f32)], y: f32) -> Line {
        let runs: Vec<Run> = runs
            .iter()
            .map(|&(text, x, w, size)| Run {
                text: text.into(),
                rect: rect(x, y, w, size),
                size,
                baseline: y + size,
                bold: false,
            })
            .collect();
        let x0 = runs.iter().map(|r| r.rect.x).fold(f32::MAX, f32::min);
        let x1 = runs.iter().map(|r| r.rect.x + r.rect.w).fold(0.0, f32::max);
        Line {
            rect: rect(x0, y, x1 - x0, 9.0),
            runs,
        }
    }

    /// A Letter page with a running header, body text and a footer "Page n of N".
    fn page(n: u32, with_header: bool) -> PageText {
        let mut lines = Vec::new();
        if with_header {
            lines.push(line(
                &[
                    ("Annual report", 72.0, 70.0, 9.0),
                    ("ACME Corp", 470.0, 60.0, 9.0),
                ],
                30.0,
            ));
        }
        lines.push(line(
            &[(
                "Body text of the page that goes on and on",
                72.0,
                300.0,
                12.0,
            )],
            300.0,
        ));
        lines.push(line(
            &[(&format!("Page {n} of 9"), 280.0, 50.0, 9.0)],
            750.0,
        ));
        PageText {
            page: n,
            width: 612.0,
            height: 792.0,
            lines,
            body_size: 12.0,
        }
    }

    #[test]
    fn a_running_header_and_page_numbers_are_found_and_the_body_is_not() {
        let pages: Vec<PageText> = (1..=4).map(|n| page(n, true)).collect();
        let items = detect(&pages);
        let texts: Vec<_> = items
            .iter()
            .map(|i| (i.edge, i.slot, i.kind, i.text.as_str()))
            .collect();
        assert_eq!(
            texts,
            [
                (
                    DetectedEdge::Header,
                    DetectedSlot::Left,
                    DetectedKind::Text,
                    "Annual report"
                ),
                (
                    DetectedEdge::Header,
                    DetectedSlot::Right,
                    DetectedKind::Text,
                    "ACME Corp"
                ),
                (
                    DetectedEdge::Footer,
                    DetectedSlot::Center,
                    DetectedKind::PageNumber,
                    "Page 1 of 9"
                ),
            ]
        );
        assert!(items.iter().all(|i| i.pages == 4));
        // the union of the boxes
        assert!((items[0].rect.x - 72.0).abs() < 0.01);
    }

    #[test]
    fn something_on_one_of_many_pages_is_not_a_running_header() {
        let mut pages: Vec<PageText> = (1..=6).map(|n| page(n, false)).collect();
        pages[0] = page(1, true);
        let items = detect(&pages);
        assert!(
            items.iter().all(|i| i.kind == DetectedKind::PageNumber),
            "{items:?}"
        );
        // a single page is taken as it is
        let one = detect(&[page(1, true)]);
        assert_eq!(one.len(), 3);
    }

    #[test]
    fn page_number_patterns() {
        for yes in [
            "Page 3",
            "page 3 of 12",
            "Seite 3 von 12",
            "3",
            "3 / 12",
            "- 3 -",
            "\u{2013} 12 \u{2013}",
        ] {
            assert!(is_page_number(&normalize(yes)), "{yes}");
        }
        for no in ["Annual report", "Chapter 3 Results", "of", "Figure 3"] {
            assert!(!is_page_number(&normalize(no)), "{no}");
        }
    }

    #[test]
    fn hostile_pages_stay_bounded() {
        let mut p = page(1, false);
        p.lines = (0..5_000)
            .map(|i| line(&[(&format!("text{}", i * 7919), 10.0, 20.0, 9.0)], 10.0))
            .collect();
        let items = detect(&[p]);
        assert!(items.len() <= ITEMS_MAX);
        let long = "x".repeat(10_000);
        let mut q = page(1, false);
        q.lines = vec![line(&[(&long, 10.0, 20.0, 9.0)], 10.0)];
        assert!(detect(&[q])[0].text.chars().count() <= TEXT_CHARS_MAX);
        // nan geometry and zero-size pages are skipped
        let mut r = page(1, true);
        r.lines[0].rect.y = f32::NAN;
        r.width = 0.0;
        assert!(detect(&[r]).is_empty());
    }

    #[test]
    fn the_sample_is_spread_over_the_document() {
        assert_eq!(sample_positions(0), Vec::<usize>::new());
        assert_eq!(sample_positions(1), [0]);
        assert_eq!(sample_positions(5), [0, 1, 2, 3, 4]);
        let many = sample_positions(1000);
        assert_eq!(many.len(), SAMPLE_PAGES);
        assert_eq!((many[0], many[SAMPLE_PAGES - 1]), (0, 999));
    }
}
