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

// --- Annotations (ADR-003, ARCHITECTURE §5 annotations) -----------------------------------------------------------

/// Annotations one document may hold in the model (imported and created), and on one page. A command that would go past either is
/// refused with `limit_exceeded`.
pub const MAX_ANNOTATIONS_PER_DOC: usize = 20_000;
pub const MAX_ANNOTATIONS_PER_PAGE: usize = 2_000;
/// Annotations of a page that are looked at when the page is imported from PDFium.
pub const MAX_IMPORT_PER_PAGE: usize = 2_000;
/// Rectangles (quads) of one highlight, underline or strikeout.
pub const MAX_ANNOT_QUADS: usize = 512;
/// Entries of the `/Annots` array of one page that a save works on; a longer array is damaged or hostile (ADR-004).
pub const MAX_ANNOTS_ARRAY: usize = 100_000;
/// A save (read, rewrite, write, reopen) gives up waiting after this long (ADR-004 §1).
pub const SAVE_TIMEOUT: Duration = Duration::from_secs(60);
/// Stack of the thread that builds the update: lopdf recurses into the file's structures (ADR-004 §1).
pub const SAVE_STACK_BYTES: usize = 64 * 1024 * 1024;
/// Backups of originals are kept this long, and up to this many bytes in all (ADR-004 §3).
pub const BACKUP_KEEP: Duration = Duration::from_secs(30 * 24 * 60 * 60);
pub const BACKUP_MAX_BYTES: u64 = 2 * 1024 * 1024 * 1024;
/// Strokes of one ink annotation, points of one stroke, and points of one annotation in all (path and outline together).
pub const MAX_INK_STROKES: usize = 256;
pub const MAX_INK_POINTS_PER_STROKE: usize = 10_000;
pub const MAX_INK_POINTS_TOTAL: usize = 50_000;
/// Lines of a free text annotation and characters of one line.
pub const MAX_FREE_TEXT_LINES: usize = 500;
pub const MAX_FREE_TEXT_LINE_CHARS: usize = 1_000;
/// Characters of the contents (a note's text) and of the author's name.
pub const MAX_ANNOT_CONTENTS_CHARS: usize = 32_768;
pub const MAX_ANNOT_AUTHOR_CHARS: usize = 256;
/// Characters of a modification date as read from a file or stamped (`D:...` or ISO 8601).
pub const MAX_ANNOT_DATE_CHARS: usize = 64;
/// Widest stroke and the font size range, in points.
pub const MAX_ANNOT_STROKE_PT: f32 = 144.0;
pub const MIN_FONT_SIZE_PT: f32 = 1.0;
pub const MAX_FONT_SIZE_PT: f32 = 400.0;
/// Commands in one `Batch`, how deep batches may nest (1 = a batch of plain commands), ids in one delete or move, and characters of
/// a history label (a key of the UI catalogs: `[A-Za-z0-9._-]`).
pub const MAX_BATCH_COMMANDS: usize = 5_000;
pub const MAX_BATCH_DEPTH: usize = 2;
pub const MAX_COMMAND_IDS: usize = 5_000;
/// Pages one insert brings (ADR-036 §7).
pub const MAX_INSERT_PAGES: usize = 5_000;
/// Pages the engine's copy of a document may hold, deleted and moved ones included (ADR-036 §3).
pub const MAX_ENGINE_PAGES: u32 = 60_000;
/// Import sources: each, all together, and how many (ADR-036 §4).
pub const MAX_SOURCE_BYTES: u64 = 512 * 1024 * 1024;
pub const MAX_SOURCES_BYTES: u64 = 1024 * 1024 * 1024;
pub const MAX_SOURCES: usize = 32;
/// Sides of a page the user may ask for, in points.
pub const MIN_NEW_PAGE_SIDE_PT: f32 = 1.0;
pub const MAX_LABEL_CHARS: usize = 64;
// --- Forms (ADR-041) ---
/// Nodes of the field tree that are looked at, terminal fields, widgets, and the depth of the tree (a deeper one is damaged).
pub const MAX_FORM_NODES: usize = 100_000;
pub const MAX_FORM_FIELDS: usize = 10_000;
pub const MAX_FORM_WIDGETS: usize = 20_000;
pub const MAX_FORM_DEPTH: usize = 32;
/// Options of a choice field and on-states of a radio group that are read.
pub const MAX_FIELD_OPTIONS: usize = 1_000;
/// Characters of a text value (ADR-041 §2) and of a fully qualified field name, a tooltip and an option label.
pub const MAX_FIELD_TEXT_CHARS: usize = 32_768;
pub const MAX_FIELD_NAME_CHARS: usize = 512;
/// Deadline of reading the field tree.
pub const FORM_READ_TIMEOUT: Duration = Duration::from_secs(30);
/// Entries of one document's undo stack (the redo stack never grows past it either).
pub const MAX_HISTORY_ENTRIES: usize = 500;
/// Bytes of the undo stack (what its steps hold, estimated); the oldest steps are dropped past it.
pub const MAX_HISTORY_BYTES: usize = 16 * 1024 * 1024;
/// Bytes of strings (contents, author, date, name, free text lines) imported from a file: per page and in all. What would go past
/// either is left out.
pub const MAX_IMPORT_BYTES_PER_PAGE: usize = 4 * 1024 * 1024;
pub const MAX_IMPORT_BYTES_PER_DOC: usize = 32 * 1024 * 1024;
/// Updates of one annotation with the same coalesce key that come this close together are one undo step (ADR-003 §7).
pub const COALESCE_WINDOW_MS: u64 = 1_500;
/// Characters of a coalesce key.
pub const MAX_COALESCE_KEY_CHARS: usize = 64;
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

/// Longest "Author name" setting in characters (ADR-029).
pub const MAX_AUTHOR_NAME_CHARS: usize = 128;

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
/// One export or print page render (bigger bitmaps than the viewer's, drawn at `Background` priority).
pub const EXPORT_RENDER_TIMEOUT: Duration = Duration::from_secs(60);
/// Deadline for control jobs that only release resources (close).
pub const CONTROL_TIMEOUT: Duration = Duration::from_secs(5);
/// Pending jobs before a new one is refused with `engine_timeout` unless it outranks the lowest queued one, which is then
/// cancelled in its place (back-pressure; callers never block on a full queue).
pub const ENGINE_QUEUE_DEPTH: usize = 64;
/// PDFium recurses on nested structures; give the worker more stack than the 2 MiB default (ADR-002 §1).
pub const ENGINE_STACK_BYTES: usize = 16 * 1024 * 1024;

// --- New-file jobs (ADR-036 §6: extract, split, merge, compress) -------------------------------------------------

/// Jobs that run at once (each holds a thread with a big stack); another is `limit_exceeded` (`jobs`).
pub const MAX_JOBS: usize = 2;
/// A job gives up after this long (checked between objects, pages and images).
pub const JOB_TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// Stack of a job's thread: lopdf recurses into the file's structures.
pub const JOB_STACK_BYTES: usize = 64 * 1024 * 1024;
/// Least time between two `progress` messages of a job (the last one of a phase always goes out).
pub const JOB_PROGRESS_INTERVAL: Duration = Duration::from_millis(100);
/// Outputs of one split, inputs of one merge.
pub const MAX_SPLIT_OUTPUTS: usize = 1_000;
pub const MAX_MERGE_INPUTS: usize = 64;
/// Largest `n` of "every n pages".
pub const MAX_SPLIT_EVERY_N: u32 = 10_000;
/// Input bytes of one merge in all.
pub const MAX_MERGE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
/// Objects one deep copy of pages may bring over (a hostile file can make the closure of a page the whole file).
pub const MAX_COPY_OBJECTS: usize = 1_000_000;
/// Nesting of arrays and dictionaries that a copy follows; deeper is cut (`null`).
pub const MAX_COPY_NESTING: usize = 64;
/// Kids of a flat page tree, and of a node in a two-level tree.
pub const FLAT_KIDS_MAX: usize = 512;
pub const TREE_KIDS_PER_NODE: usize = 256;
/// Longest chain of `/Parent` links followed when inherited page attributes are collected.
pub const MAX_PARENT_CHAIN: usize = 64;
/// Output of one decoded Flate stream (bomb guard), and the limits of a decoded JPEG (`image::Limits`).
pub const MAX_FLATE_OUTPUT_BYTES: usize = 256 * 1024 * 1024;
/// Decoded bytes of all object streams of one file that lopdf may be asked to load (`pdfwrite::prescan`).
pub const MAX_LOAD_DECODED_BYTES: usize = 256 * 1024 * 1024;
pub const MAX_IMAGE_SIDE_PX: u32 = 10_000;
pub const MAX_IMAGE_PIXELS: u64 = 50_000_000;
pub const MAX_IMAGE_ALLOC_BYTES: u64 = 256 * 1024 * 1024;
/// Images the estimate recodes, and the time it may take.
pub const ESTIMATE_SAMPLE_IMAGES: usize = 6;
pub const ESTIMATE_BUDGET: Duration = Duration::from_millis(1_500);
/// Longest name part (characters) a split takes from the document's name.
pub const MAX_SPLIT_STEM_CHARS: usize = 100;
/// Tries at a free name ("name (2).pdf" ...) before a split gives up.
pub const MAX_NAME_ATTEMPTS: u32 = 1_000;

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

// --- Edit and protect (ADR-047, ARCHITECTURE §5 "Edit and protect") ---------------------------------------------------------

/// Characters of a text box, lines after the layout, and the smallest side of a text box or an image box in points.
pub const MAX_TEXT_BOX_CHARS: usize = 8_192;
pub const MAX_TEXT_BOX_LINES: usize = 500;
pub const MIN_CONTENT_BOX_PT: f32 = 4.0;
/// The font size range of a text box in points.
pub const MIN_TEXT_BOX_FONT_PT: f32 = 4.0;
pub const MAX_TEXT_BOX_FONT_PT: f32 = 144.0;
/// An image the user inserts: the file, the sides read from its header before decoding, its pixels, the decoder's allocation cap, the
/// long side it is stored at, and what one stored image may take.
///
/// Two different caps on the picture's side: the DECODE cap (8 192 px per side, 40 MP, 256 MiB of decoder allocation) is what the
/// decoder is allowed to read from a hostile file, so a phone photo or a scan still opens; the STORED cap (4 096 px on the long side,
/// 24 MiB) is what is kept in the document and written to the PDF after the picture was scaled down. A picture between the two is
/// accepted and stored smaller, never refused.
pub const MAX_IMAGE_FILE_BYTES: u64 = 20 * 1024 * 1024;
pub const MAX_INSERT_IMAGE_SIDE_PX: u32 = 8_192;
pub const MAX_INSERT_IMAGE_PIXELS: u64 = 40_000_000;
pub const MAX_IMAGE_DECODE_ALLOC_BYTES: u64 = 256 * 1024 * 1024;
pub const MAX_IMAGE_STORED_SIDE_PX: u32 = 4_096;
pub const MAX_IMAGE_STORED_BYTES: u64 = 24 * 1024 * 1024;
/// Image assets of one document, and their total size.
pub const MAX_IMAGE_ASSETS: usize = 128;
pub const MAX_IMAGE_ASSET_BYTES_PER_DOC: u64 = 256 * 1024 * 1024;
/// The smallest side a crop leaves, in points.
pub const MIN_CROP_SIDE_PT: f32 = 72.0;
/// Redaction marks in one command and in the document, and quads in one mark.
pub const MAX_REDACT_MARKS_PER_COMMAND: usize = 10_000;
pub const MAX_REDACT_MARKS_PER_DOC: usize = 20_000;
pub const MAX_REDACT_QUADS_PER_MARK: usize = 512;
/// Pages one redaction job rasters, the dpi it starts at, the lowest dpi it accepts, and the bitmap it may make per page.
pub const MAX_REDACT_PAGES: usize = 5_000;
pub const REDACT_DPI: f32 = 200.0;
pub const MIN_REDACT_DPI: f32 = 72.0;
pub const MAX_REDACT_SIDE_PX: u32 = 4_096;
///
/// The redaction raster is its own budget, apart from the image caps above: a page is drawn at `REDACT_DPI`, the dpi is lowered (never
/// below `MIN_REDACT_DPI`) until the bitmap fits both `MAX_REDACT_SIDE_PX` per side and `MAX_REDACT_PIXELS` in total (16 MP, at most
/// 64 MB of RGBA per page), and a page that cannot fit at the lowest dpi fails the job instead of being rastered coarser.
pub const MAX_REDACT_PIXELS: u64 = 16_000_000;
/// Surgical redaction of one page (ADR-055): decoded content of the page and of each form XObject, operators in all, form nesting, the
/// pixels of an image that is decoded to be blacked out, rectangles per page, and the work (rectangle tests) one page may cost.
pub const MAX_REDACT_CONTENT_BYTES: usize = 24 * 1024 * 1024;
pub const MAX_REDACT_OPS: usize = 6_000_000;
pub const MAX_REDACT_FORM_DEPTH: usize = 8;
pub const MAX_REDACT_IMAGE_PIXELS: u64 = 100_000_000;
pub const MAX_REDACT_RECTS_PER_PAGE: usize = 20_000;
pub const MAX_REDACT_WORK: u64 = 2_000_000_000;
/// A password in bytes after SASLprep.
pub const MIN_NEW_PASSWORD_BYTES: usize = 1;
pub const MAX_NEW_PASSWORD_BYTES: usize = 127;
/// A metadata field in characters, the time one read of it may take, and how much of the XMP packet is looked at.
pub const MAX_METADATA_FIELD_CHARS: usize = 1_000;
pub const METADATA_READ_TIMEOUT: Duration = Duration::from_secs(30);
pub const MAX_XMP_BYTES: u64 = 4 * 1024 * 1024;
/// The size range of `get_asset_preview` (pixels on the long side).
pub const MIN_ASSET_PREVIEW_PX: u16 = 16;
pub const MAX_ASSET_PREVIEW_PX: u16 = 2_048;

// --- Convert and output (ADR-049) ---------------------------------------------------------------------------------

/// Pages one export or print selection may name (also the longest accepted range text result).
pub const MAX_EXPORT_PAGES: usize = 5_000;
/// Accepted dpi of an image export.
pub const MIN_EXPORT_DPI: f32 = 36.0;
pub const MAX_EXPORT_DPI: f32 = 600.0;
/// Default JPEG quality of an image export.
pub const DEFAULT_JPEG_QUALITY: u8 = 85;
/// One exported bitmap: longest side in pixels and total pixels. A page over it is rendered at the highest dpi that fits.
pub const MAX_EXPORT_SIDE_PX: u32 = 10_000;
pub const MAX_EXPORT_PIXELS: u64 = 64_000_000;
/// Image files one export job writes.
pub const MAX_EXPORT_FILES: usize = 5_000;
/// How long a conflict ticket (folder held after a name clash) lives.
pub const EXPORT_TICKET_TTL: Duration = Duration::from_secs(5 * 60);
/// Names of a conflict answer.
pub const MAX_CONFLICT_NAMES: usize = 5;
/// Images of one images to PDF job and of one dropped batch.
pub const MAX_IMAGES_PER_PDF: usize = 500;
pub const MAX_IMAGE_BATCH: usize = MAX_IMAGES_PER_PDF;
/// Image batches held at once; adding one more lets the oldest go (its handles are closed).
pub const MAX_LIVE_IMAGE_BATCHES: usize = 8;
/// Long side of an image batch thumbnail (`get_image_batch_preview`), in pixels.
pub const MIN_BATCH_PREVIEW_PX: u16 = 16;
pub const MAX_BATCH_PREVIEW_PX: u16 = 512;
/// Cached thumbnails per batch, and the longest file name `list_image_batch` returns (characters).
pub const MAX_BATCH_PREVIEWS: usize = 1_000;
pub const MAX_BATCH_NAME_CHARS: usize = 120;
/// How long a dropped image batch is kept.
pub const IMAGE_BATCH_TTL: Duration = Duration::from_secs(10 * 60);
/// Sum of the stored (re-encoded) images of one images to PDF job.
pub const MAX_IMAGES_PDF_STORED_BYTES: u64 = 1024 * 1024 * 1024;
/// Margin of an images to PDF page, in points.
pub const MIN_IMAGE_MARGIN_PT: f32 = 0.0;
pub const MAX_IMAGE_MARGIN_PT: f32 = 72.0;
/// Page side of an images to PDF page, in points, and the density range an image's own dpi is trusted in.
pub const MIN_IMAGE_PAGE_PT: f32 = 72.0;
pub const MAX_IMAGE_PAGE_PT: f32 = 14_400.0;
pub const MIN_IMAGE_DENSITY_DPI: f32 = 72.0;
pub const MAX_IMAGE_DENSITY_DPI: f32 = 1_200.0;
/// Density assumed when an image states none.
pub const DEFAULT_IMAGE_DENSITY_DPI: f32 = 150.0;
/// Snapshot of a dirty document held in memory.
pub const MAX_SNAPSHOT_BYTES: u64 = 1024 * 1024 * 1024;
/// Print: pages of a set (`high` quality: fewer), bytes of one set, sets held at once, and the life of a set.
pub const MAX_PRINT_PAGES: usize = 2_000;
pub const MAX_PRINT_PAGES_HIGH: usize = 300;
pub const MAX_PRINT_SET_BYTES: usize = 768 * 1024 * 1024;
pub const MAX_PRINT_SETS: usize = 2;
pub const PRINT_SET_TTL: Duration = Duration::from_secs(10 * 60);
/// Print render dpi per quality and the JPEG quality of the frames.
pub const PRINT_DPI_STANDARD: f32 = 150.0;
pub const PRINT_DPI_HIGH: f32 = 300.0;
pub const PRINT_JPEG_QUALITY: u8 = 92;

// --- Engine process, autosave, updater (M7, ADR-053) ----------------------------------------------------------------

/// Time the parent waits for a new engine child's `Ready` (ADR-053 §1.2).
pub const ENGINE_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);
/// Child restarts allowed per [`ENGINE_RESTART_WINDOW`]; after that the engine stays `engine_unavailable` until the app restarts.
pub const ENGINE_RESTART_BUDGET: u32 = 5;
/// The window [`ENGINE_RESTART_BUDGET`] counts in.
pub const ENGINE_RESTART_WINDOW: Duration = Duration::from_secs(10 * 60);
/// Crashes a document may cause before it is quarantined (not replayed, `engine_crashed` until closed).
pub const ENGINE_STRIKES: u32 = 2;
/// Longest header (postcard of a `WireRequest` or `WireReply`) in a frame, in either direction.
pub const WIRE_HEADER_MAX: usize = 16 * 1024 * 1024;
/// Largest encoded frame (PNG) a render reply may carry: a full 4096 x 4096 RGBA bitmap, which no PNG of it exceeds by much.
pub const MAX_FRAME_BYTES: usize = 80 * 1024 * 1024;
/// Largest `ReadAt` the child may ask the parent for, and so the largest `ReadData` blob.
pub const READ_AT_MAX: usize = 1024 * 1024;
/// A block of the child's per-document read cache (`RemoteFile`) ...
pub const REMOTE_BLOCK_BYTES: usize = 256 * 1024;
/// ... and how many of them it keeps per document.
pub const REMOTE_BLOCKS: usize = 64;
/// One line of the child's stderr as the parent logs it; longer lines are cut.
pub const ENGINE_LOG_LINE_MAX: usize = 4096;
/// Quiet time after the last change before an autosave (ADR-053 §2).
pub const AUTOSAVE_DEBOUNCE: Duration = Duration::from_secs(30);
/// Longest time between autosaves of a document that is edited continuously.
pub const AUTOSAVE_MAX_INTERVAL: Duration = Duration::from_secs(120);
/// Largest snapshot autosave writes; a bigger document is `offTooLarge`.
pub const AUTOSAVE_DOC_MAX: u64 = 512 * 1024 * 1024;
/// Largest total of the autosave store; the oldest session is purged beyond it.
pub const AUTOSAVE_STORE_MAX: u64 = 2 * 1024 * 1024 * 1024;
/// Age after which a dead session's records are purged at startup.
pub const AUTOSAVE_RETENTION: Duration = Duration::from_secs(14 * 24 * 60 * 60);
/// Time between automatic update checks while the setting is on.
pub const UPDATE_CHECK_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);
/// Largest update package that is downloaded.
pub const UPDATE_PACKAGE_MAX: u64 = 256 * 1024 * 1024;
/// Longest release notes text passed to the UI, in bytes.
pub const UPDATE_NOTES_MAX: usize = 4 * 1024;
/// Longest version string accepted by `skip_update_version` and the `skippedVersion` setting, in characters.
pub const UPDATE_VERSION_MAX_CHARS: usize = 32;

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
    fn the_edit_and_protect_limits_are_the_documented_ones() {
        assert_eq!(MAX_TEXT_BOX_CHARS, 8_192);
        assert_eq!(MAX_TEXT_BOX_LINES, 500);
        assert_eq!(MAX_IMAGE_FILE_BYTES, 20 * 1024 * 1024);
        assert_eq!(MAX_INSERT_IMAGE_SIDE_PX, 8_192);
        assert_eq!(MAX_INSERT_IMAGE_PIXELS, 40_000_000);
        assert_eq!(MAX_IMAGE_ASSETS, 128);
        assert_eq!(MAX_IMAGE_ASSET_BYTES_PER_DOC, 256 * 1024 * 1024);
        assert_eq!(MIN_CROP_SIDE_PT, 72.0);
        assert_eq!(MAX_REDACT_MARKS_PER_COMMAND, 10_000);
        assert_eq!(MAX_REDACT_MARKS_PER_DOC, 20_000);
        assert_eq!(MAX_REDACT_QUADS_PER_MARK, 512);
        assert_eq!(MAX_REDACT_PAGES, 5_000);
        assert_eq!((MIN_NEW_PASSWORD_BYTES, MAX_NEW_PASSWORD_BYTES), (1, 127));
        assert_eq!(MAX_METADATA_FIELD_CHARS, 1_000);
        assert_eq!(MAX_XMP_BYTES, 4 * 1024 * 1024);
        // The redaction raster never goes below the lowest dpi it accepts, and starts above it.
        const _: () = assert!(REDACT_DPI > MIN_REDACT_DPI);
        const _: () =
            assert!(MAX_REDACT_PIXELS <= (MAX_REDACT_SIDE_PX as u64) * (MAX_REDACT_SIDE_PX as u64));
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
    fn the_output_limits_are_the_documented_ones() {
        assert_eq!(MAX_EXPORT_PAGES, 5_000);
        assert_eq!((MIN_EXPORT_DPI, MAX_EXPORT_DPI), (36.0, 600.0));
        assert_eq!(
            (MAX_EXPORT_SIDE_PX, MAX_EXPORT_PIXELS),
            (10_000, 64_000_000)
        );
        assert_eq!(MAX_EXPORT_FILES, 5_000);
        assert_eq!(EXPORT_TICKET_TTL.as_secs(), 300);
        assert_eq!(MAX_IMAGES_PER_PDF, 500);
        assert_eq!(IMAGE_BATCH_TTL.as_secs(), 600);
        assert_eq!((MIN_BATCH_PREVIEW_PX, MAX_BATCH_PREVIEW_PX), (16, 512));
        assert_eq!(MAX_IMAGES_PDF_STORED_BYTES, 1 << 30);
        assert_eq!((MIN_IMAGE_MARGIN_PT, MAX_IMAGE_MARGIN_PT), (0.0, 72.0));
        assert_eq!((MIN_IMAGE_PAGE_PT, MAX_IMAGE_PAGE_PT), (72.0, 14_400.0));
        assert_eq!(MAX_SNAPSHOT_BYTES, 1 << 30);
        assert_eq!((MAX_PRINT_PAGES, MAX_PRINT_PAGES_HIGH), (2_000, 300));
        assert_eq!(MAX_PRINT_SET_BYTES, 768 * 1024 * 1024);
        assert_eq!(MAX_PRINT_SETS, 2);
        const _: () = assert!(MAX_PRINT_PAGES_HIGH <= MAX_PRINT_PAGES);
        const _: () =
            assert!(MAX_EXPORT_SIDE_PX as u64 * MAX_EXPORT_SIDE_PX as u64 >= MAX_EXPORT_PIXELS);
    }

    #[test]
    fn ship_limits_are_pinned_to_adr_053() {
        assert_eq!(ENGINE_HANDSHAKE_TIMEOUT.as_secs(), 5);
        assert_eq!(
            (
                ENGINE_RESTART_BUDGET,
                ENGINE_RESTART_WINDOW.as_secs(),
                ENGINE_STRIKES
            ),
            (5, 600, 2)
        );
        assert_eq!((WIRE_HEADER_MAX, READ_AT_MAX), (16 << 20, 1 << 20));
        assert_eq!((REMOTE_BLOCK_BYTES, REMOTE_BLOCKS), (256 << 10, 64));
        assert_eq!(
            (AUTOSAVE_DEBOUNCE.as_secs(), AUTOSAVE_MAX_INTERVAL.as_secs()),
            (30, 120)
        );
        assert_eq!((AUTOSAVE_DOC_MAX, AUTOSAVE_STORE_MAX), (512 << 20, 2 << 30));
        assert_eq!(AUTOSAVE_RETENTION.as_secs(), 14 * 86_400);
        assert_eq!(UPDATE_CHECK_INTERVAL.as_secs(), 86_400);
        assert_eq!((UPDATE_PACKAGE_MAX, UPDATE_NOTES_MAX), (256 << 20, 4096));
        // A full-size render must fit a frame, and a read block must fit one `ReadAt`.
        const _: () = assert!(MAX_FRAME_BYTES as u64 >= MAX_RENDER_PIXELS * 4);
        const _: () = assert!(REMOTE_BLOCK_BYTES <= READ_AT_MAX);
        const _: () = assert!(AUTOSAVE_DOC_MAX <= AUTOSAVE_STORE_MAX);
    }

    #[test]
    fn deadlines_are_ordered_by_job_weight() {
        const _: () = assert!(CONTROL_TIMEOUT.as_secs() < RENDER_TIMEOUT.as_secs());
        const _: () = assert!(RENDER_TIMEOUT.as_secs() <= OPEN_TIMEOUT.as_secs());
        const _: () = assert!(RENDER_TIMEOUT.as_secs() <= EXPORT_RENDER_TIMEOUT.as_secs());
    }
}
