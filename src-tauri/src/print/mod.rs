//! Print through the OS dialog (ADR-049 §4): pre-rendered page frames held in memory, shown by the webview's print-only surface.
//!
//! `prepare` renders the selection into a [`set::PrintSet`] (JPEG frames, SHR1 format 3), `page` hands a frame to the UI, `open_dialog`
//! opens the dialog, `release` drops the set (also when its document closes and ten minutes after it was made). Nothing is written to
//! disk. The pure steps (selection, rotation, JPEG frame, building a set from a renderer) are free functions so they are tested
//! without PDFium or a window.

pub mod dialog;
pub mod set;

use std::sync::{Arc, OnceLock};

use image::codecs::jpeg::JpegEncoder;
use image::ExtendedColorType;
use serde::{Deserialize, Serialize};
use tauri::WebviewWindow;

use crate::commands::jobs::{EventSink, JobDone, JobId, PrintDone};
use crate::commands::AppState;
use crate::documents::{DocumentId, PageId};
use crate::engine::encode::{FRAME_HEADER_BYTES, FRAME_MAGIC};
use crate::error::{AppError, ErrorCode};
use crate::export::snapshot::{EngineDocRef, SnapshotGuard};
use crate::limits;
use crate::model::protection::{Permission, PermissionSet};
use crate::model::ranges::{parse_ranges, PageSelection};
use crate::pdfwrite::produce::{Control, Phase};
use crate::pdfwrite::redact::{RasterPage, RasterPixels};
use set::{PrintSetBuilder, PrintSets};

/// SHR1 format byte of a JPEG payload (`src/api/print.ts`).
pub const FORMAT_JPEG: u8 = 3;

/// Render quality: 150 or 300 dpi.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PrintQuality {
    Standard,
    High,
}

impl PrintQuality {
    pub const fn dpi(self) -> f32 {
        match self {
            Self::Standard => limits::PRINT_DPI_STANDARD,
            Self::High => limits::PRINT_DPI_HIGH,
        }
    }

    /// Most pages of a set at this quality.
    pub const fn max_pages(self) -> usize {
        match self {
            Self::Standard => limits::MAX_PRINT_PAGES,
            Self::High => limits::MAX_PRINT_PAGES_HIGH,
        }
    }
}

/// The paper orientation landscape pages are turned to when `auto_rotate` is on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PrintOrientation {
    Portrait,
    Landscape,
}

/// What `prepare_print` takes.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrintOptions {
    pub pages: PageSelection,
    pub annotations: bool,
    pub quality: PrintQuality,
    pub auto_rotate: bool,
    pub paper: PrintOrientation,
}

/// Which route opened the print dialog.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PrintRoute {
    /// The OS print dialog.
    System,
    /// The webview's own print preview (still local).
    Webview,
}

/// The sets held by the app.
pub fn sets() -> &'static Arc<PrintSets> {
    static SETS: OnceLock<Arc<PrintSets>> = OnceLock::new();
    SETS.get_or_init(|| Arc::new(PrintSets::new()))
}

// --- Pure steps ---------------------------------------------------------------------------------------------------

/// The positions (0-based, in the current order, without repeats) a selection names over `order`; `invalid_argument` `pageSelection`
/// for an unknown page, bad range text or an empty result, `limit_exceeded` `printJob` past `max_pages`.
pub fn resolve_pages(
    selection: &PageSelection,
    order: &[(PageId, u32)],
    max_pages: usize,
) -> Result<Vec<usize>, AppError> {
    let invalid = || AppError::invalid("pageSelection");
    let too_many = || AppError::limit("printJob", max_pages as u64);
    let position = |page: PageId| order.iter().position(|(id, _)| *id == page);
    let mut positions: Vec<usize> = match selection {
        PageSelection::All => (0..order.len()).collect(),
        PageSelection::Current { page_id } => vec![position(*page_id).ok_or_else(invalid)?],
        PageSelection::Pages { pages } => {
            if pages.len() > limits::MAX_EXPORT_PAGES {
                return Err(too_many());
            }
            let mut found = Vec::with_capacity(pages.len());
            for page in pages {
                found.push(position(*page).ok_or_else(invalid)?);
            }
            found.sort_unstable();
            found
        }
        PageSelection::Ranges { text } => {
            let count = u32::try_from(order.len()).map_err(|_| invalid())?;
            let ranges = parse_ranges(text, count).map_err(|_| invalid())?;
            let mut found = Vec::new();
            for (start, end) in ranges {
                found.extend((start as usize - 1)..(end as usize));
                if found.len() > limits::MAX_EXPORT_PAGES {
                    return Err(too_many());
                }
            }
            found
        }
    };
    // Ranges may come in any order and overlap: print each page once, in document order.
    positions.sort_unstable();
    positions.dedup();
    if positions.is_empty() {
        return Err(invalid());
    }
    if positions.len() > max_pages {
        return Err(too_many());
    }
    Ok(positions)
}

/// `read_only` `permission` when a restricted document (`Some(allowed)`) does not allow printing; `None` is unrestricted.
pub fn check_print_permission(allowed: Option<PermissionSet>) -> Result<(), AppError> {
    match allowed {
        Some(set) if !set.contains(Permission::Print) => Err(AppError::read_only("permission")),
        _ => Ok(()),
    }
}

/// Whether a `width` x `height` page has to be turned a quarter to lie the way `paper` does. A square page is never turned.
pub fn needs_turn(width: u32, height: u32, paper: PrintOrientation) -> bool {
    match paper {
        PrintOrientation::Portrait => width > height,
        PrintOrientation::Landscape => height > width,
    }
}

/// `src` (`width` x `height`, `channels` per pixel) turned a quarter turn clockwise: `height` wide and `width` tall.
fn turn(src: &[u8], width: usize, height: usize, channels: usize) -> Vec<u8> {
    let mut out = vec![0_u8; src.len()];
    // Row `y` of the new picture is column `y` of the source, read from the bottom up.
    for y in 0..width {
        for x in 0..height {
            let from = ((height - 1 - x) * width + y) * channels;
            let to = (y * height + x) * channels;
            out[to..to + channels].copy_from_slice(&src[from..from + channels]);
        }
    }
    out
}

/// `page` turned a quarter turn clockwise. A buffer that does not match its size is returned as it is (the encoder refuses it).
pub fn rotate_quarter(page: RasterPage) -> RasterPage {
    let (width, height) = (page.width as usize, page.height as usize);
    let pixels = match &page.pixels {
        RasterPixels::Rgb8(data) if data.len() == width * height * 3 => {
            RasterPixels::Rgb8(turn(data, width, height, 3))
        }
        RasterPixels::Gray8(data) if data.len() == width * height => {
            RasterPixels::Gray8(turn(data, width, height, 1))
        }
        _ => return page,
    };
    RasterPage {
        pixels,
        width: page.height,
        height: page.width,
    }
}

/// One finished frame: the page turned if `auto_rotate` asks for it, as JPEG (quality `limits::PRINT_JPEG_QUALITY`) behind an SHR1
/// header of format 3.
pub fn encode_page(
    page: RasterPage,
    paper: PrintOrientation,
    auto_rotate: bool,
) -> Result<Vec<u8>, AppError> {
    let page = if auto_rotate && needs_turn(page.width, page.height, paper) {
        rotate_quarter(page)
    } else {
        page
    };
    let (width, height) = (page.width, page.height);
    let (data, color, channels) = match &page.pixels {
        RasterPixels::Rgb8(data) => (data, ExtendedColorType::Rgb8, 3),
        RasterPixels::Gray8(data) => (data, ExtendedColorType::L8, 1),
    };
    // The encoder panics on a buffer of the wrong size; the engine never makes one, but a bad one must not take the job down.
    let expected = (width as usize)
        .checked_mul(height as usize)
        .and_then(|pixels| pixels.checked_mul(channels));
    if width == 0 || height == 0 || expected != Some(data.len()) {
        return Err(AppError::logged(
            ErrorCode::Internal,
            "print page buffer does not match its size",
        ));
    }
    let mut out = Vec::with_capacity(FRAME_HEADER_BYTES + data.len() / 8);
    out.extend_from_slice(&FRAME_MAGIC);
    out.push(FORMAT_JPEG);
    out.extend_from_slice(&[0, 0, 0]);
    out.extend_from_slice(&width.to_le_bytes());
    out.extend_from_slice(&height.to_le_bytes());
    JpegEncoder::new_with_quality(&mut out, limits::PRINT_JPEG_QUALITY)
        .encode(data, width, height, color)
        .map_err(|error| AppError::logged(ErrorCode::Internal, error))?;
    Ok(out)
}

/// Renders each of `engine_indices` with `render`, encodes it and collects the frames. Stops at the first error or when `control`
/// says so; reports `render` progress per page.
pub fn build_set(
    engine_indices: &[u32],
    max_pages: usize,
    opts: &PrintOptions,
    control: &dyn Control,
    mut render: impl FnMut(u32) -> Result<RasterPage, AppError>,
) -> Result<PrintSetBuilder, AppError> {
    let total = u32::try_from(engine_indices.len()).unwrap_or(u32::MAX);
    let mut builder = PrintSetBuilder::new();
    for (done, &index) in engine_indices.iter().enumerate() {
        control.check()?;
        let raster = render(index)?;
        control.check()?;
        let frame = encode_page(raster, opts.paper, opts.auto_rotate)?;
        builder.push(frame, max_pages)?;
        control.progress(
            Phase::Render,
            u32::try_from(done + 1).unwrap_or(total),
            total,
        );
    }
    Ok(builder)
}

// --- The commands' work -------------------------------------------------------------------------------------------

/// Renders the pages into a print set and reports it in `done.print`. `read_only` `permission` when the document forbids printing,
/// `invalid_argument` `pageSelection`, `limit_exceeded` `printJob`.
pub fn prepare(
    state: &AppState,
    doc: DocumentId,
    opts: &PrintOptions,
    sink: Arc<dyn EventSink>,
) -> Result<JobId, AppError> {
    state.check_may_print(doc)?;
    let order = state.print_page_order(doc)?;
    let max_pages = opts.quality.max_pages();
    resolve_pages(&opts.pages, &order, max_pages)?; // fail fast; the job resolves again against its snapshot
    let opts = opts.clone();
    let state = state.clone();
    crate::commands::jobs::jobs().start(sink, move |ctx| {
        ctx.progress(Phase::Snapshot, 0, 1);
        // The page order and the snapshot must describe the same state: take the order before and after the snapshot and retry
        // when an edit slipped in between.
        let mut attempt = 0;
        let (guard, order, positions) = loop {
            let before = state.print_page_order(doc)?;
            let guard = SnapshotGuard::current(&state, doc)?;
            let after = state.print_page_order(doc)?;
            if before == after {
                let positions = resolve_pages(&opts.pages, &after, max_pages)?;
                break (guard, after, positions);
            }
            attempt += 1;
            if attempt >= 3 {
                return Err(AppError::logged(
                    ErrorCode::Internal,
                    "the document kept changing while the print snapshot was taken",
                ));
            }
        };
        ctx.progress(Phase::Snapshot, 1, 1);
        let snap = guard.snapshot();
        // A live document is addressed by engine index; a snapshot holds the pages in the current order.
        let indices: Vec<u32> = match snap.engine {
            EngineDocRef::Live(_) => positions
                .iter()
                .filter_map(|&p| order.get(p).map(|entry| entry.1))
                .collect(),
            EngineDocRef::Snapshot(_) => positions
                .iter()
                .filter_map(|&p| u32::try_from(p).ok())
                .collect(),
        };
        let engine = state.engine();
        let result = build_set(&indices, max_pages, &opts, ctx, |index| {
            engine.render_export(snap.engine, index, opts.quality.dpi(), opts.annotations, 0)
        });
        drop(guard);
        let builder = result?;
        let pages = u32::try_from(builder.len()).unwrap_or(u32::MAX);
        let print_id = sets().insert(doc, builder);
        expire_later(print_id);
        Ok(JobDone {
            outputs: pages,
            print: Some(PrintDone { print_id, pages }),
            ..JobDone::default()
        })
    })
}

/// Drops set `id` once its life is over, even if nobody asks for it again.
fn expire_later(id: u32) {
    let spawned = std::thread::Builder::new()
        .name("sheer-print-ttl".into())
        .stack_size(64 * 1024)
        .spawn(move || {
            std::thread::sleep(limits::PRINT_SET_TTL);
            sets().release(id);
        });
    if let Err(error) = spawned {
        // The set is still swept by the next insert or lookup past its life.
        AppError::logged(ErrorCode::Internal, error).log();
    }
}

/// One frame (SHR1, JPEG) of a finished set.
pub fn page(_state: &AppState, print_id: u32, index: u32) -> Result<Vec<u8>, AppError> {
    sets().frame(print_id, index).map(|frame| frame.to_vec())
}

/// Opens the print dialog for a complete set; the main window only. The label check is not unit-tested: a `WebviewWindow` needs a
/// running Tauri runtime (no mock-runtime feature is enabled), so only the capability grant is tested (`security_baseline`).
pub fn open_dialog(
    _state: &AppState,
    window: &WebviewWindow,
    print_id: u32,
) -> Result<PrintRoute, AppError> {
    if window.label() != "main" {
        return Err(AppError::invalid("window"));
    }
    let pages = sets().pages(print_id)?;
    dialog::open(window, print_id, pages)
}

/// Drops a set; an unknown id is not an error.
pub fn release(_state: &AppState, print_id: u32) -> Result<(), AppError> {
    sets().release(print_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn options_parse_and_the_route_serializes_in_lower_case() {
        let opts: PrintOptions = serde_json::from_str(
            r#"{"pages":{"type":"all"},"annotations":true,"quality":"high","autoRotate":true,"paper":"landscape"}"#,
        )
        .unwrap();
        assert_eq!(opts.quality, PrintQuality::High);
        assert_eq!(opts.paper, PrintOrientation::Landscape);
        assert_eq!(
            serde_json::to_value(PrintRoute::Webview).unwrap(),
            serde_json::json!("webview")
        );
        assert_eq!(
            serde_json::to_value(PrintRoute::System).unwrap(),
            serde_json::json!("system")
        );
    }

    #[test]
    fn ranges_in_any_order_print_each_page_once_in_document_order() {
        let order: Vec<(PageId, u32)> = (0..10).map(|i| (PageId::new(i), i)).collect();
        let ranges = PageSelection::Ranges {
            text: "5-6, 1-2, 2-3".to_owned(),
        };
        assert_eq!(
            resolve_pages(&ranges, &order, 100).unwrap(),
            vec![0, 1, 2, 4, 5]
        );
    }

    #[test]
    fn a_300_dpi_page_stays_within_the_export_pixel_cap() {
        for (w, h) in [(612.0, 792.0), (2384.0, 3370.0), (14_400.0, 14_400.0)] {
            if let Some(fit) = crate::export::images::fit(w, h, limits::PRINT_DPI_HIGH) {
                assert!(u64::from(fit.width) * u64::from(fit.height) <= limits::MAX_EXPORT_PIXELS);
            }
        }
    }
}
