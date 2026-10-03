//! Every numeric bound of the backend, in one place (SECURITY P5, I1; ARCHITECTURE §5).
//!
//! Every PDF is hostile input: page sizes, page counts and file sizes come from the file and can be absurd, so the
//! limits are checked before memory is allocated. The checks are pure functions without PDFium, so they are
//! unit-tested directly. Frontend mirrors live in `src/engine/buckets.ts` (buckets, tiles) and must stay in sync; a test there
//! reads this file and fails on drift.

use std::time::Duration;

use crate::error::AppError;

// --- Render requests --------------------------------------------------------------------------------------------

/// Zoom buckets (ADR-002 §4): a render is requested for the bucket `b = ceil(4 * log2(device px per point))` and drawn at
/// `2^(b / 4)` device pixels per point, so the browser scales it by at most 19 % to the exact zoom. Smallest accepted bucket.
pub const MIN_BUCKET: i16 = -17;
/// Largest accepted bucket (64 device pixels per point). What a page really costs at that scale is bounded by the pixel
/// limits below: a page is tiled above a frame, and never larger than `MAX_PAGE_PIXEL_SIDE`.
pub const MAX_BUCKET: i16 = 24;
/// Buckets per doubling of the scale.
pub const BUCKETS_PER_OCTAVE: f64 = 4.0;
/// Longest accepted side of one rendered frame in pixels (ADR-002 §6: a frame is at most 4096 x 4096).
pub const MAX_RENDER_SIDE_PX: u32 = 4096;
/// Pixel budget of one rendered frame (width x height). Bounds the bitmap and the encoded PNG to tens of MiB.
pub const MAX_RENDER_PIXELS: u64 = 4096 * 4096;
/// Side of one tile in pixels (ADR-002 §5): a page that does not fit a frame at its bucket is rendered as a grid of these.
pub const TILE_SIZE_PX: u32 = 1024;
/// Tiles per side of a page (ARCHITECTURE §5: a tile index is at most 63).
pub const MAX_TILES_PER_SIDE: u32 = 64;
/// Longest side of a whole page at its bucket in pixels, tiled or not. A page needing more is refused (`limit_exceeded`).
pub const MAX_PAGE_PIXEL_SIDE: u32 = TILE_SIZE_PX * MAX_TILES_PER_SIDE;
/// Pages the UI may name in one viewport hint, visible and near each (ARCHITECTURE §5).
pub const MAX_VIEWPORT_PAGES: usize = 64;
/// Callers that may join one render that is queued or running (the same frame asked for again), besides the one that started it.
/// The UI asks for a frame once at a time (its cache deduplicates), so a crowd on one frame is not the UI: the callers beyond
/// this are refused (`limit_exceeded`, `requests`) instead of each parking a thread until the frame is done.
pub const MAX_RENDER_WAITERS: usize = 8;
/// `render_page` calls one document may have in flight at once (queued, running or joined), and all documents together. Every
/// call holds a thread of the blocking pool until its frame is done or its deadline passes; a call beyond these is refused
/// (`limit_exceeded`, `requests`) before it takes one. Both are above what the UI can have pending: every distinct frame
/// needs a place in the engine's queue ([`ENGINE_QUEUE_DEPTH`]), and the UI asks for each frame once.
pub const MAX_RENDERS_PER_DOCUMENT: usize = 96;
pub const MAX_RENDERS_IN_FLIGHT: usize = 128;
const _: () = assert!(
    MAX_RENDERS_PER_DOCUMENT > ENGINE_QUEUE_DEPTH && MAX_RENDERS_IN_FLIGHT >= MAX_RENDERS_PER_DOCUMENT,
    "a document may have more renders in flight than the queue holds, and all documents at least as many as one"
);

// --- Page sizes -------------------------------------------------------------------------------------------------

/// Most pages a document may have: the layout holds one size per page and the scroll height grows with the count. A document
/// with more is refused at open (`limit_exceeded`, `pages`).
pub const MAX_PAGES: u32 = 50_000;
/// Largest page side the UI is told, in points (the 200 inch limit of the PDF specification for most readers). A page that
/// claims more is shown at this size; it cannot be rendered anyway (`MAX_PAGE_PIXEL_SIDE`).
pub const MAX_PAGE_SIDE_PT: f32 = 14_400.0;
/// Smallest page side the UI is told, in points.
pub const MIN_PAGE_SIDE_PT: f32 = 1.0;
/// What a page without a usable size is shown as: US Letter.
pub const DEFAULT_PAGE_SIZE_PT: [f32; 2] = [612.0, 792.0];

// --- Reading: outline, text, search, links -----------------------------------------------------------------------

/// Most nodes of the outline the UI is sent (ARCHITECTURE §5). The tree is read depth first, in document order, and reading
/// stops here: a document with more has the rest left out.
pub const MAX_OUTLINE_NODES: usize = 10_000;
/// Deepest level of the outline the UI is sent, the top level being 1. A bookmark below it is left out with its children.
pub const MAX_OUTLINE_DEPTH: usize = 32;
/// Longest outline title in characters, after sanitizing (the same filter as a display name).
pub const MAX_OUTLINE_TITLE_CHARS: usize = 512;
/// Most characters of one page's text layer (UTF-16 code units, which is what JavaScript counts). A page with more is cut there and
/// the layer says so (`truncated`).
pub const MAX_TEXT_CHARS: usize = 200_000;
/// Most characters of one page that a search looks at (twice what a text layer may hold, which is already more than a page of text has):
/// the rest of a page with more is not searched.
pub const MAX_SEARCH_PAGE_CHARS: usize = 1_000_000;
/// Longest search text in characters (ARCHITECTURE §5).
pub const MAX_SEARCH_QUERY_CHARS: usize = 512;
/// Most hits one search reports (ARCHITECTURE §5). The search then ends with `truncated`.
pub const MAX_SEARCH_HITS: u32 = 50_000;
/// Most rectangles of one hit: a hit that spans lines has one per line, and no hit of a query of 512 characters spans more.
pub const MAX_QUADS_PER_HIT: usize = 512;
/// Most links of one page the UI is sent (ARCHITECTURE §5). The first ones in the page's order; the rest cannot be opened.
pub const MAX_PAGE_LINKS: usize = 1_000;
/// Longest URL a link may carry to the UI, and the longest one that is ever opened (bytes: a URL is ASCII, see `security::links`).
pub const MAX_URL_LEN: usize = 2048;
/// Deadline for reading the text of a page, its links, a search of one page and the outline (ADR-002 §8: text 10 s).
pub const TEXT_TIMEOUT: Duration = Duration::from_secs(10);
/// How often one page of a search is tried when the engine is too busy for it (a full queue, or other work that was more urgent for
/// the whole deadline): a search runs at the lowest priority, so a scroll that keeps the worker busy may starve a page for a while.
pub const SEARCH_PAGE_ATTEMPTS: u32 = 10;
/// Pause between two attempts at one page of a search.
pub const SEARCH_RETRY_PAUSE: Duration = Duration::from_millis(250);
/// Searches that may run at once (each holds a thread of the blocking pool): one per document, and the ones that were cancelled and
/// have not noticed yet. A search beyond it is `limit_exceeded` (`searches`).
pub const MAX_ACTIVE_SEARCHES: usize = 2 * MAX_OPEN_DOCUMENTS;
/// Least time between two `progress` messages of a search (the last page always reports).
pub const SEARCH_PROGRESS_INTERVAL: Duration = Duration::from_millis(100);

// --- Documents --------------------------------------------------------------------------------------------------

/// Upper bound for simultaneously open documents (bounds memory held by the engine).
pub const MAX_OPEN_DOCUMENTS: usize = 32;
/// Longest file name (in characters) that is reported to the frontend for display; longer ones are cut.
pub const MAX_DISPLAY_NAME_CHARS: usize = 255;
/// Largest PDF file the app opens (ARCHITECTURE §4: 2 GiB).
pub const MAX_PDF_FILE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
/// How far into a file the `%PDF-` signature may start (ARCHITECTURE §4; PDF readers, PDFium among them, accept this much
/// leading junk). Only this many bytes are read to decide whether a file is a PDF at all.
pub const PDF_SNIFF_BYTES: usize = 1024;
/// The signature every PDF has within its first `PDF_SNIFF_BYTES` bytes.
pub const PDF_SIGNATURE: &[u8] = b"%PDF-";
/// Most files taken from one source at a time (the open dialog's selection, one drop, the command line of one launch). The
/// rest are refused with one `limit_exceeded` (`documents`), so a drop of thousands of files cannot queue thousands of opens.
pub const MAX_OPEN_BATCH: usize = MAX_OPEN_DOCUMENTS;
/// Open-failed notifications that wait for the UI to subscribe (a file the app was started with is opened before the window
/// can listen). A failure beyond this many is dropped: it is only a banner. The `opened` notifications are never dropped,
/// there are at most `MAX_OPEN_DOCUMENTS` of them.
pub const MAX_PENDING_FAILURES: usize = MAX_OPEN_DOCUMENTS;

// --- Settings ---------------------------------------------------------------------------------------------------

/// Largest settings file that is read. A real one is well under 1 KiB; anything bigger is damaged or foreign and the
/// defaults are used instead (the file is user-writable, so its size is not trusted).
pub const MAX_SETTINGS_FILE_BYTES: u64 = 64 * 1024;

/// Longest password that `unlock_document` takes, in bytes (ARCHITECTURE section 5). PDF passwords are far shorter; the bound keeps
/// a hostile caller from handing the engine a megabyte to hash.
pub const MAX_PASSWORD_BYTES: usize = 1024;

/// Wrong passwords for one document after which each further attempt waits [`PASSWORD_RETRY_DELAY`] (ADR-026). Enforced in Rust,
/// so a script in the webview cannot skip it.
pub const FREE_PASSWORD_ATTEMPTS: u32 = 3;

/// How long an attempt after the free ones waits since the last wrong one.
pub const PASSWORD_RETRY_DELAY: Duration = Duration::from_secs(1);

/// Most recent files kept and listed (ARCHITECTURE section 5, `list_recents`).
pub const MAX_RECENTS: usize = 50;

/// Longest path, in characters, that is kept as a recent file; a longer one in the stored file is dropped when it is read.
pub const MAX_RECENT_PATH_CHARS: usize = 4096;

/// Largest recents file that is read: 50 paths of at most 4096 characters in UTF-8 with escapes fit with room to spare. Anything
/// bigger is damaged or foreign and the list starts empty.
pub const MAX_RECENTS_FILE_BYTES: u64 = 1024 * 1024;

/// Range and default of the left panel's width in px (DESIGN 2, 3.8: 192 to 400, default 248). The frontend mirrors them as
/// `LEFT_PANEL_WIDTH` in `src/api/app.ts` and `PANEL` in `src/components/tokens.ts`; a test there fails on drift.
pub const LEFT_PANEL_MIN_WIDTH: u16 = 192;
pub const LEFT_PANEL_MAX_WIDTH: u16 = 400;
pub const LEFT_PANEL_DEFAULT_WIDTH: u16 = 248;
const _: () = assert!(
    LEFT_PANEL_MIN_WIDTH < LEFT_PANEL_DEFAULT_WIDTH
        && LEFT_PANEL_DEFAULT_WIDTH < LEFT_PANEL_MAX_WIDTH,
    "the left panel range must be ordered: minimum, default, maximum"
);

// --- Menu bar ---------------------------------------------------------------------------------------------------

/// Longest language tag taken from the UI for the menu bar's language (`subscribe_menu`'s `system_language`, the browser's
/// `navigator.language`). BCP 47 tags are far shorter; a longer string is not one, and counts as unknown (English).
pub const MAX_LANGUAGE_TAG_LEN: usize = 35;

// --- Engine worker ----------------------------------------------------------------------------------------------

/// Deadline for loading a document (ADR-002 §8).
pub const OPEN_TIMEOUT: Duration = Duration::from_secs(20);
/// Deadline for rendering one page (ADR-002 §8).
pub const RENDER_TIMEOUT: Duration = Duration::from_secs(10);
/// Deadline for control jobs that only release resources (close).
pub const CONTROL_TIMEOUT: Duration = Duration::from_secs(5);
/// Pending jobs before a new one is refused with `engine_timeout` unless it outranks the lowest queued one, which is then
/// cancelled in its place (back-pressure; callers never block on a full queue).
pub const ENGINE_QUEUE_DEPTH: usize = 64;
/// PDFium recurses on nested structures; give the worker more stack than the 2 MiB default (ADR-002 §1).
pub const ENGINE_STACK_BYTES: usize = 16 * 1024 * 1024;

// --- Validation -------------------------------------------------------------------------------------------------

/// Device pixels per PDF point of `bucket`: `2^(bucket / 4)`. Fails with `invalid_argument` (`bucket`) outside
/// `MIN_BUCKET..=MAX_BUCKET`.
pub fn bucket_scale(bucket: i16) -> Result<f64, AppError> {
    if (MIN_BUCKET..=MAX_BUCKET).contains(&bucket) {
        Ok(2f64.powf(f64::from(bucket) / BUCKETS_PER_OCTAVE))
    } else {
        Err(AppError::invalid("bucket"))
    }
}

/// Checks that `page_index < page_count`.
pub fn validate_page_index(page_index: u32, page_count: u32) -> Result<u32, AppError> {
    if page_index < page_count {
        Ok(page_index)
    } else {
        Err(AppError::invalid("page"))
    }
}

/// Checks that a PDF file of `len` bytes may be opened.
pub fn validate_file_size(len: u64) -> Result<u64, AppError> {
    if len <= MAX_PDF_FILE_BYTES {
        Ok(len)
    } else {
        Err(AppError::too_large("file_size", MAX_PDF_FILE_BYTES))
    }
}

/// Checks that a document of `page_count` pages may be opened.
pub fn validate_page_count(page_count: u32) -> Result<u32, AppError> {
    if page_count <= MAX_PAGES {
        Ok(page_count)
    } else {
        Err(AppError::limit("pages", u64::from(MAX_PAGES)))
    }
}

/// The size the UI is told for a page of `width_pt` x `height_pt` points: a side that is not a positive number (the size comes
/// from the file) makes the page US Letter, one outside `MIN_PAGE_SIDE_PT..=MAX_PAGE_SIDE_PT` is brought into it.
pub fn sanitize_page_size(width_pt: f32, height_pt: f32) -> [f32; 2] {
    if !width_pt.is_finite() || !height_pt.is_finite() || width_pt <= 0.0 || height_pt <= 0.0 {
        return DEFAULT_PAGE_SIZE_PT;
    }
    [
        width_pt.clamp(MIN_PAGE_SIDE_PT, MAX_PAGE_SIDE_PT),
        height_pt.clamp(MIN_PAGE_SIDE_PT, MAX_PAGE_SIDE_PT),
    ]
}

/// Checks the pages of a viewport hint: at most `MAX_VIEWPORT_PAGES` of them.
pub fn validate_viewport_pages(count: usize) -> Result<usize, AppError> {
    if count <= MAX_VIEWPORT_PAGES {
        Ok(count)
    } else {
        Err(AppError::limit("pages", MAX_VIEWPORT_PAGES as u64))
    }
}

/// Checks the text of a search: 1 to `MAX_SEARCH_QUERY_CHARS` characters, not only white space (that is nothing to look for) and
/// without U+0000 (a string that is NUL terminated somewhere on the way would silently be a shorter search). Empty, white space only
/// and NUL are `invalid_argument` (`query`), a longer text is `limit_exceeded` (`query`).
pub fn validate_search_text(text: &str) -> Result<&str, AppError> {
    if text.trim().is_empty() || text.contains('\0') {
        return Err(AppError::invalid("query"));
    }
    // Bytes first: a text of more than 4 bytes per allowed character is too long whatever its characters, and it is not counted.
    if text.len() > MAX_SEARCH_QUERY_CHARS * 4 || text.chars().count() > MAX_SEARCH_QUERY_CHARS {
        return Err(AppError::limit("query", MAX_SEARCH_QUERY_CHARS as u64));
    }
    Ok(text)
}

/// Checks the number of hits a search may report: 1 to `MAX_SEARCH_HITS`. Zero is `invalid_argument` (`hits`), more is
/// `limit_exceeded` (`hits`).
pub fn validate_search_hits(max_hits: u32) -> Result<u32, AppError> {
    if max_hits == 0 {
        Err(AppError::invalid("hits"))
    } else if max_hits > MAX_SEARCH_HITS {
        Err(AppError::limit("hits", u64::from(MAX_SEARCH_HITS)))
    } else {
        Ok(max_hits)
    }
}

/// Checks the tile a render names: a column and a row below `MAX_TILES_PER_SIDE`, the grid of the largest page there is. Whether
/// the tile is inside the grid of the page at hand is judged against the page's real size (`render_region`); this is the check that
/// needs no PDFium, so a request for a tile no page has is refused before it takes a place in the queue.
pub fn validate_tile(tile: Option<(u16, u16)>) -> Result<Option<(u16, u16)>, AppError> {
    match tile {
        Some((column, row))
            if u32::from(column) >= MAX_TILES_PER_SIDE || u32::from(row) >= MAX_TILES_PER_SIDE =>
        {
            Err(AppError::invalid("tile"))
        }
        _ => Ok(tile),
    }
}

/// Size in pixels of a whole page rendered at `scale` (pixels per point), rounded up so no content is clipped. This is the
/// grid that tiles are cut from, so it may be far larger than a frame: only a side above `MAX_PAGE_PIXEL_SIDE` fails
/// (`limit_exceeded`). A page that has no usable size fails the same way. Page sizes come from the file, so this runs on the
/// real size before any bitmap is allocated.
pub fn page_pixel_size(width_pt: f32, height_pt: f32, scale: f64) -> Result<(u32, u32), AppError> {
    pixel_size_within(width_pt, height_pt, scale, MAX_PAGE_PIXEL_SIDE, u64::MAX)
}

/// Pixel size of a page rendered as one frame at `scale`: [`page_pixel_size`] within the limits of a frame, a side of at most
/// `MAX_RENDER_SIDE_PX` and an area of at most `MAX_RENDER_PIXELS`, else `limit_exceeded`.
pub fn pixel_size(width_pt: f32, height_pt: f32, scale: f64) -> Result<(u32, u32), AppError> {
    pixel_size_within(
        width_pt,
        height_pt,
        scale,
        MAX_RENDER_SIDE_PX,
        MAX_RENDER_PIXELS,
    )
}

fn pixel_size_within(
    width_pt: f32,
    height_pt: f32,
    scale: f64,
    max_side: u32,
    max_pixels: u64,
) -> Result<(u32, u32), AppError> {
    if !scale.is_finite() || scale <= 0.0 {
        return Err(AppError::invalid("scale"));
    }
    let side = |points: f32| -> Result<u32, AppError> {
        if !points.is_finite() || points <= 0.0 {
            return Err(AppError::limit("dimension", u64::from(max_side)));
        }
        let pixels = (f64::from(points) * scale).ceil().max(1.0);
        if pixels > f64::from(max_side) {
            return Err(AppError::limit("dimension", u64::from(max_side)));
        }
        // `pixels` is in 1..=max_side here, so the cast is lossless.
        Ok(pixels as u32)
    };
    let (width, height) = (side(width_pt)?, side(height_pt)?);
    if u64::from(width) * u64::from(height) > max_pixels {
        return Err(AppError::limit("pixels", max_pixels));
    }
    Ok((width, height))
}

/// The part of a page that one render covers, in pixels of the whole page at its bucket (origin top left).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Region {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

/// What a render of a page that is `page_px` pixels at its bucket covers. Without a `tile` the whole page, which has to fit a
/// frame (`limit_exceeded`, so the UI asks for tiles); with one the 1024 px tile at (column, row), cut short at the page's
/// right and bottom edge. A tile outside the page's grid is `invalid_argument` (`tile`).
pub fn render_region(page_px: (u32, u32), tile: Option<(u16, u16)>) -> Result<Region, AppError> {
    let (page_width, page_height) = page_px;
    let Some((column, row)) = tile else {
        if page_width > MAX_RENDER_SIDE_PX || page_height > MAX_RENDER_SIDE_PX {
            return Err(AppError::limit("dimension", u64::from(MAX_RENDER_SIDE_PX)));
        }
        if u64::from(page_width) * u64::from(page_height) > MAX_RENDER_PIXELS {
            return Err(AppError::limit("pixels", MAX_RENDER_PIXELS));
        }
        return Ok(Region {
            x: 0,
            y: 0,
            width: page_width,
            height: page_height,
        });
    };
    let x = u32::from(column) * TILE_SIZE_PX;
    let y = u32::from(row) * TILE_SIZE_PX;
    // The grid has `MAX_TILES_PER_SIDE` columns and rows at most, which `page_pixel_size` already guarantees for the page.
    if x >= page_width || y >= page_height {
        return Err(AppError::invalid("tile"));
    }
    Ok(Region {
        x,
        y,
        width: (page_width - x).min(TILE_SIZE_PX),
        height: (page_height - y).min(TILE_SIZE_PX),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorCode;

    fn code<T: std::fmt::Debug>(result: Result<T, AppError>) -> ErrorCode {
        result.unwrap_err().code()
    }

    #[test]
    fn buckets_are_quarter_octaves_of_the_scale() {
        assert_eq!(bucket_scale(0).unwrap(), 1.0);
        assert_eq!(bucket_scale(4).unwrap(), 2.0);
        assert_eq!(bucket_scale(8).unwrap(), 4.0);
        assert_eq!(bucket_scale(-4).unwrap(), 0.5);
        // One step is a factor of 2^(1/4): the browser scales a bucket by at most 19 % to the exact zoom.
        let step = bucket_scale(1).unwrap() / bucket_scale(0).unwrap();
        assert!((step - 1.189_207).abs() < 1e-5, "{step}");
        assert!((bucket_scale(MAX_BUCKET).unwrap() - 64.0).abs() < 1e-3);
        assert!((bucket_scale(MIN_BUCKET).unwrap() - 0.052_6).abs() < 1e-3);
    }

    #[test]
    fn buckets_outside_the_range_are_invalid() {
        for bad in [MIN_BUCKET - 1, MAX_BUCKET + 1, i16::MIN, i16::MAX] {
            assert_eq!(code(bucket_scale(bad)), ErrorCode::InvalidArgument, "{bad}");
        }
        assert!(bucket_scale(MIN_BUCKET).is_ok() && bucket_scale(MAX_BUCKET).is_ok());
    }

    #[test]
    fn page_index_must_be_below_page_count() {
        assert_eq!(validate_page_index(0, 1).unwrap(), 0);
        assert_eq!(validate_page_index(4, 5).unwrap(), 4);
        assert_eq!(code(validate_page_index(5, 5)), ErrorCode::InvalidArgument);
        assert_eq!(code(validate_page_index(0, 0)), ErrorCode::InvalidArgument);
        assert_eq!(
            code(validate_page_index(u32::MAX, 5)),
            ErrorCode::InvalidArgument
        );
    }

    #[test]
    fn file_size_is_capped() {
        assert_eq!(validate_file_size(0).unwrap(), 0);
        assert_eq!(
            validate_file_size(MAX_PDF_FILE_BYTES).unwrap(),
            MAX_PDF_FILE_BYTES
        );
        assert_eq!(
            code(validate_file_size(MAX_PDF_FILE_BYTES + 1)),
            ErrorCode::TooLarge
        );
        assert_eq!(code(validate_file_size(u64::MAX)), ErrorCode::TooLarge);
    }

    #[test]
    fn the_page_count_is_capped() {
        assert_eq!(validate_page_count(0).unwrap(), 0);
        assert_eq!(validate_page_count(MAX_PAGES).unwrap(), MAX_PAGES);
        assert_eq!(
            code(validate_page_count(MAX_PAGES + 1)),
            ErrorCode::LimitExceeded
        );
        assert_eq!(
            code(validate_page_count(u32::MAX)),
            ErrorCode::LimitExceeded
        );
    }

    #[test]
    fn page_sizes_the_ui_is_told_are_always_usable() {
        assert_eq!(sanitize_page_size(595.0, 842.0), [595.0, 842.0]);
        for (w, h) in [
            (0.0, 100.0),
            (100.0, 0.0),
            (-5.0, 100.0),
            (f32::NAN, 100.0),
            (100.0, f32::INFINITY),
            (f32::NEG_INFINITY, f32::NAN),
        ] {
            assert_eq!(sanitize_page_size(w, h), DEFAULT_PAGE_SIZE_PT, "{w} x {h}");
        }
        // Absurd but finite sizes are brought into range, a side at a time.
        assert_eq!(
            sanitize_page_size(f32::MAX, 0.001),
            [MAX_PAGE_SIDE_PT, MIN_PAGE_SIDE_PT]
        );
        assert_eq!(sanitize_page_size(14_400.0, 1.0), [14_400.0, 1.0]);
    }

    #[test]
    fn a_viewport_hint_names_a_bounded_number_of_pages() {
        assert!(validate_viewport_pages(MAX_VIEWPORT_PAGES).is_ok());
        assert_eq!(
            code(validate_viewport_pages(MAX_VIEWPORT_PAGES + 1)),
            ErrorCode::LimitExceeded
        );
    }

    #[test]
    fn a_tile_has_to_be_in_the_grid_of_the_largest_page() {
        let last = (MAX_TILES_PER_SIDE - 1) as u16;
        assert_eq!(validate_tile(None).unwrap(), None);
        assert_eq!(validate_tile(Some((0, 0))).unwrap(), Some((0, 0)));
        assert_eq!(
            validate_tile(Some((last, last))).unwrap(),
            Some((last, last))
        );
        for bad in [
            (last + 1, 0),
            (0, last + 1),
            (u16::MAX, u16::MAX),
            (u16::MAX, 0),
        ] {
            assert_eq!(
                code(validate_tile(Some(bad))),
                ErrorCode::InvalidArgument,
                "{bad:?}"
            );
        }
    }

    #[test]
    fn pixel_size_rounds_up() {
        assert_eq!(pixel_size(612.0, 792.0, 1.0).unwrap(), (612, 792));
        assert_eq!(pixel_size(200.5, 100.2, 1.0).unwrap(), (201, 101));
        assert_eq!(pixel_size(1.0, 1.0, 0.1).unwrap(), (1, 1));
    }

    #[test]
    fn pixel_size_enforces_the_frame_side_limit() {
        // Exactly 4096 fits; one more point does not.
        assert_eq!(pixel_size(4096.0, 100.0, 1.0).unwrap(), (4096, 100));
        let error = pixel_size(4097.0, 100.0, 1.0).unwrap_err();
        assert_eq!(error.code(), ErrorCode::LimitExceeded);
        // Thin and long: the area is small, but the side exceeds the limit.
        assert_eq!(
            code(pixel_size(10.0, 40_000.0, 1.0)),
            ErrorCode::LimitExceeded
        );
        // A scale that pushes an A4 page over the side limit.
        assert_eq!(
            code(pixel_size(595.0, 842.0, 5.0)),
            ErrorCode::LimitExceeded
        );
    }

    #[test]
    fn pixel_size_enforces_the_pixel_budget() {
        // The largest allowed frame (4096 x 4096) is exactly the budget.
        assert_eq!(pixel_size(4096.0, 4096.0, 1.0).unwrap(), (4096, 4096));
        assert_eq!(
            u64::from(MAX_RENDER_SIDE_PX) * u64::from(MAX_RENDER_SIDE_PX),
            MAX_RENDER_PIXELS
        );
        // With a smaller budget the area check fires although both sides pass: 100 x 100 = 10 000 > 9 999.
        assert_eq!(
            pixel_size_within(100.0, 100.0, 1.0, 200, 10_000).unwrap(),
            (100, 100)
        );
        let error = pixel_size_within(100.0, 100.0, 1.0, 200, 9_999).unwrap_err();
        assert_eq!(error.code(), ErrorCode::LimitExceeded);
    }

    #[test]
    fn pixel_size_rejects_hostile_page_sizes() {
        for (w, h) in [
            (0.0, 100.0),
            (100.0, 0.0),
            (-5.0, 100.0),
            (f32::NAN, 100.0),
            (100.0, f32::INFINITY),
            (f32::MAX, f32::MAX),
        ] {
            assert_eq!(code(pixel_size(w, h, 1.0)), ErrorCode::LimitExceeded);
            assert_eq!(code(page_pixel_size(w, h, 1.0)), ErrorCode::LimitExceeded);
        }
    }

    #[test]
    fn pixel_size_validates_the_scale_first() {
        for bad in [0.0, -1.0, f64::NAN, f64::INFINITY] {
            assert_eq!(
                code(pixel_size(100.0, 100.0, bad)),
                ErrorCode::InvalidArgument,
                "{bad}"
            );
        }
    }

    #[test]
    fn a_whole_page_may_be_far_larger_than_a_frame_but_not_unbounded() {
        // 612 x 792 pt at 8 px per point is 4896 x 6336: too much for one frame, fine as a grid of tiles.
        assert_eq!(page_pixel_size(612.0, 792.0, 8.0).unwrap(), (4896, 6336));
        assert_eq!(
            code(pixel_size(612.0, 792.0, 8.0)),
            ErrorCode::LimitExceeded
        );
        // The grid ends at 64 tiles a side.
        assert_eq!(
            page_pixel_size(MAX_PAGE_PIXEL_SIDE as f32, 1.0, 1.0).unwrap(),
            (MAX_PAGE_PIXEL_SIDE, 1)
        );
        assert_eq!(
            code(page_pixel_size(MAX_PAGE_PIXEL_SIDE as f32 + 1.0, 1.0, 1.0)),
            ErrorCode::LimitExceeded
        );
        assert_eq!(MAX_PAGE_PIXEL_SIDE, 65_536);
    }

    #[test]
    fn without_a_tile_the_region_is_the_page_and_has_to_fit_a_frame() {
        assert_eq!(
            render_region((612, 792), None).unwrap(),
            Region {
                x: 0,
                y: 0,
                width: 612,
                height: 792
            }
        );
        assert!(render_region((4096, 4096), None).is_ok());
        assert_eq!(
            code(render_region((4097, 10), None)),
            ErrorCode::LimitExceeded
        );
        assert_eq!(
            code(render_region((10, 4097), None)),
            ErrorCode::LimitExceeded
        );
    }

    #[test]
    fn tiles_are_1024_px_and_cut_short_at_the_page_edge() {
        let page = (2500, 1100);
        let tile = |c, r| render_region(page, Some((c, r))).unwrap();
        assert_eq!(
            tile(0, 0),
            Region {
                x: 0,
                y: 0,
                width: 1024,
                height: 1024
            }
        );
        assert_eq!(
            tile(1, 0),
            Region {
                x: 1024,
                y: 0,
                width: 1024,
                height: 1024
            }
        );
        // The last column is 2500 - 2048 = 452 px wide, the last row 1100 - 1024 = 76 px high.
        assert_eq!(
            tile(2, 1),
            Region {
                x: 2048,
                y: 1024,
                width: 452,
                height: 76
            }
        );
        // The grid is 3 x 2: anything beyond it is not a tile of this page.
        assert_eq!(
            code(render_region(page, Some((3, 0)))),
            ErrorCode::InvalidArgument
        );
        assert_eq!(
            code(render_region(page, Some((0, 2)))),
            ErrorCode::InvalidArgument
        );
        // A page whose size is an exact multiple has no empty tile after the last one.
        assert_eq!(
            code(render_region((2048, 1024), Some((2, 0)))),
            ErrorCode::InvalidArgument
        );
        assert!(render_region((2048, 1024), Some((1, 0))).is_ok());
    }

    #[test]
    fn a_tile_of_the_largest_page_is_in_range() {
        let page = (MAX_PAGE_PIXEL_SIDE, MAX_PAGE_PIXEL_SIDE);
        let last = (MAX_TILES_PER_SIDE - 1) as u16;
        let region = render_region(page, Some((last, last))).unwrap();
        assert_eq!(region.width, TILE_SIZE_PX);
        assert_eq!(region.x + region.width, MAX_PAGE_PIXEL_SIDE);
        assert_eq!(
            code(render_region(page, Some((last + 1, 0)))),
            ErrorCode::InvalidArgument
        );
    }

    #[test]
    fn the_intake_limits_are_the_documented_ones() {
        assert_eq!(PDF_SNIFF_BYTES, 1024);
        assert_eq!(PDF_SIGNATURE, b"%PDF-");
        const _: () = assert!(PDF_SNIFF_BYTES > PDF_SIGNATURE.len());
        assert_eq!(MAX_OPEN_DOCUMENTS, 32);
        assert_eq!(MAX_OPEN_BATCH, MAX_OPEN_DOCUMENTS);
        assert_eq!(MAX_PDF_FILE_BYTES, 2 * 1024 * 1024 * 1024);
        // A queue of failures that nobody hears is small, and never smaller than a batch's worth.
        const _: () = assert!(MAX_PENDING_FAILURES >= MAX_OPEN_BATCH);
    }

    #[test]
    fn deadlines_are_ordered_by_job_weight() {
        const _: () = assert!(CONTROL_TIMEOUT.as_secs() < RENDER_TIMEOUT.as_secs());
        const _: () = assert!(RENDER_TIMEOUT.as_secs() <= OPEN_TIMEOUT.as_secs());
    }
}
