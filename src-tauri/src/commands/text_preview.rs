//! `text_edit_preview`: the line being edited, drawn from a draft text while the user types (ADR-129 section 1, ARCHITECTURE §13.5).
//!
//! | Command | Arguments | Returns |
//! |---|---|---|
//! | `text_edit_preview` | `docId`, `pageId`, `key: LineKey`, `text`, `fit`, `scope`, `generation: number`, `scale: number` (pixels per point, 0.5 to 8) | binary: `u32` LE length of the metadata, the metadata as JSON (`generation`, `rect`, `pxPerPt`, `overflowPt`, `fallback`), then the PNG of the region |
//!
//! The page's stored edits and the draft are replayed over the file's page (`text_save::preview_page_with`), the page is cut to the line's
//! region (the line box widened to the free room after it, for scope `paragraph` the paragraph's box and one more line), and PDFium draws
//! that one-page snapshot. Nothing of `DocState` or of the engine's document changes and there is no undo step: a snapshot is opened and
//! closed for each frame. `rect` is the region in page space (points from the top left of the page's visible box, before the page's
//! rotation) and the picture is not rotated either. `overflowPt` is how far the new text reaches past the free room (0 if it fits),
//! `fallback` says in which substitute face (and for which characters of the draft) the text is drawn, or is `null`.
//!
//! Work for a page is dropped (`cancelled`, which the UI ignores) when a newer `generation` for the same document and page has been seen,
//! checked on arrival and again before the picture is drawn. Errors as of `edit_text_line`: `read_only`, `unsupported_feature` (`textEdit`,
//! `params.reason`), `invalid_argument` (`lineKey`, `scale`), `limit_exceeded` (`text`, `pixels`), `engine_timeout`.

use std::collections::HashMap;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::{mpsc, Arc, Mutex, PoisonError};
use std::thread;
use std::time::Duration;

use serde::Serialize;
use tauri::ipc::Response;
use tauri::State;

use super::text_edit::Basis;
use super::{blocking, AppState};
use crate::documents::{DocumentId, PageId};
use crate::error::{AppError, ErrorCode, UiError};
use crate::export::images::{encode, ImageFormat};
use crate::export::snapshot::{open_bytes, SnapshotGuard};
use crate::limits;
use crate::model::geometry::Rect;
use crate::model::text_edit::{
    FallbackFace, LineEditable, LineKey, TextEdit, TextEditRefusal, TextFit, TextScope,
};
use crate::pdfwrite::text_io::PageDoc;
use crate::pdfwrite::text_lines::{Line, PageLines};
use crate::pdfwrite::text_refuse;
use crate::pdfwrite::text_save::{self, FallbackUse, PreviewPage};

/// What the UI asks of one preview.
#[derive(Debug, Clone)]
pub struct PreviewRequest {
    pub key: LineKey,
    pub text: String,
    pub fit: TextFit,
    pub scope: TextScope,
    pub generation: u32,
    pub scale: f32,
}

/// The substitute face the draft is drawn in and the characters of the draft that need it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewFallback {
    pub face: FallbackFace,
    pub chars: Vec<String>,
}

/// What a preview says besides its picture.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextPreviewMeta {
    pub generation: u32,
    /// The region of the picture, in page space.
    pub rect: Rect,
    /// The scale of the picture (it may be lower than asked for).
    pub px_per_pt: f32,
    pub overflow_pt: f32,
    pub fallback: Option<PreviewFallback>,
}

/// A preview: the metadata and the PNG of the region.
#[derive(Debug, Clone)]
pub struct TextPreview {
    pub meta: TextPreviewMeta,
    pub png: Vec<u8>,
}

impl TextPreview {
    /// The wire form: `u32` LE length of the JSON, the JSON, the PNG.
    pub fn into_wire(self) -> Result<Vec<u8>, AppError> {
        let json = serde_json::to_vec(&self.meta)
            .map_err(|error| AppError::logged(ErrorCode::Internal, error))?;
        let length = u32::try_from(json.len())
            .map_err(|_| AppError::logged(ErrorCode::Internal, "preview metadata too long"))?;
        let mut out = Vec::with_capacity(4 + json.len() + self.png.len());
        out.extend_from_slice(&length.to_le_bytes());
        out.extend_from_slice(&json);
        out.extend_from_slice(&self.png);
        Ok(out)
    }
}

/// The newest generation seen per page, so that work for an older one is dropped. When full, the page used longest ago is forgotten.
#[derive(Debug, Default)]
struct Latest {
    seen: Mutex<Seen>,
}

#[derive(Debug, Default)]
struct Seen {
    /// Per page: the newest generation and when the page was last used.
    pages: HashMap<(u32, u32), (u32, u64)>,
    tick: u64,
}

impl Latest {
    /// Notes `generation` for the page; `false` if a newer one was seen before.
    fn admit(&self, key: (u32, u32), generation: u32) -> bool {
        let mut guard = self.seen.lock().unwrap_or_else(PoisonError::into_inner);
        let seen = &mut *guard;
        seen.tick += 1;
        if seen.pages.len() >= limits::TEXT_PREVIEW_GENERATIONS && !seen.pages.contains_key(&key) {
            let oldest = seen
                .pages
                .iter()
                .min_by_key(|(_, (_, used))| *used)
                .map(|(page, _)| *page);
            if let Some(oldest) = oldest {
                seen.pages.remove(&oldest);
            }
        }
        let entry = seen.pages.entry(key).or_insert((generation, 0));
        entry.1 = seen.tick;
        if entry.0 > generation {
            return false;
        }
        entry.0 = generation;
        true
    }

    /// Whether no newer generation than `generation` was seen for the page.
    fn is_current(&self, key: (u32, u32), generation: u32) -> bool {
        let seen = self.seen.lock().unwrap_or_else(PoisonError::into_inner);
        seen.pages
            .get(&key)
            .is_none_or(|(newest, _)| *newest <= generation)
    }
}

fn latest() -> &'static Latest {
    static LATEST: std::sync::OnceLock<Latest> = std::sync::OnceLock::new();
    LATEST.get_or_init(Latest::default)
}

fn cancelled() -> AppError {
    AppError::new(ErrorCode::Cancelled)
}

/// Previews that have not ended, in all and per document (a run past its deadline keeps its thread until it finishes).
static RUNNING: Mutex<Running> = Mutex::new(Running {
    total: 0,
    per_doc: Vec::new(),
});

struct Running {
    total: usize,
    per_doc: Vec<(u32, usize)>,
}

#[derive(Debug)]
struct Slot(u32);

impl Slot {
    fn take(doc: u32) -> Result<Self, AppError> {
        let mut running = RUNNING.lock().unwrap_or_else(PoisonError::into_inner);
        let held = running
            .per_doc
            .iter()
            .find(|(id, _)| *id == doc)
            .map_or(0, |(_, count)| *count);
        if running.total >= limits::TEXT_PREVIEW_MAX_RUNNING {
            return Err(AppError::limit(
                "textPreviews",
                limits::TEXT_PREVIEW_MAX_RUNNING as u64,
            ));
        }
        if held >= limits::TEXT_PREVIEW_MAX_PER_DOC {
            return Err(AppError::limit(
                "textPreviews",
                limits::TEXT_PREVIEW_MAX_PER_DOC as u64,
            ));
        }
        running.total += 1;
        match running.per_doc.iter_mut().find(|(id, _)| *id == doc) {
            Some((_, count)) => *count += 1,
            None => running.per_doc.push((doc, 1)),
        }
        Ok(Self(doc))
    }
}

impl Drop for Slot {
    fn drop(&mut self) {
        let mut running = RUNNING.lock().unwrap_or_else(PoisonError::into_inner);
        running.total = running.total.saturating_sub(1);
        if let Some(at) = running.per_doc.iter().position(|(id, _)| *id == self.0) {
            running.per_doc[at].1 = running.per_doc[at].1.saturating_sub(1);
            if running.per_doc[at].1 == 0 {
                running.per_doc.swap_remove(at);
            }
        }
    }
}

/// Runs `work` on a thread of its own with the stack lopdf wants: a panic is `internal`, a run past `timeout` is `engine_timeout`.
fn contained<T: Send + 'static>(
    doc: u32,
    timeout: Duration,
    work: impl FnOnce() -> Result<T, AppError> + Send + 'static,
) -> Result<T, AppError> {
    let slot = Slot::take(doc)?;
    let (sender, receiver) = mpsc::channel();
    thread::Builder::new()
        .name("sheer-textpreview".into())
        .stack_size(limits::SAVE_STACK_BYTES)
        .spawn(move || {
            let _slot = slot;
            let result = catch_unwind(AssertUnwindSafe(work)).unwrap_or_else(|_| {
                Err(AppError::logged(
                    ErrorCode::Internal,
                    "text preview panicked",
                ))
            });
            let _ = sender.send(result);
        })
        .map_err(|error| AppError::logged(ErrorCode::Internal, error))?;
    receiver
        .recv_timeout(timeout)
        .map_err(|_| AppError::logged(ErrorCode::EngineTimeout, "text preview took too long"))?
}

/// The region of a line (page space, `[x0, y0, x1, y1]`, the right edge open to the page's edge when nothing follows) and the room it
/// has after it.
struct Region {
    clip: [f64; 4],
    room: Option<f64>,
}

/// What the replay thread found.
struct Made {
    page: PreviewPage,
    overflow: f64,
    unchanged: bool,
}

impl AppState {
    /// The preview of line `request.key` of `page` with the draft `request.text` (see the module documentation). Changes nothing.
    pub fn text_edit_preview(
        &self,
        id: DocumentId,
        page: PageId,
        request: PreviewRequest,
    ) -> Result<TextPreview, AppError> {
        let scale = limits::validate_preview_scale(request.scale)?;
        if request.text.chars().count() > limits::TEXT_EDIT_LINE_CHARS {
            return Err(AppError::limit("text", limits::TEXT_EDIT_LINE_CHARS as u64));
        }
        if !request.text.chars().all(text_refuse::script_allowed) {
            return Err(TextEditRefusal::Script.error());
        }
        let page_key = (id.get(), page.get());
        let generation = request.generation;
        // Permission, signature and source come first: a refused document is not a stale frame.
        let basis = self.text_basis(id, page)?;
        // A redacted page carries a refusal of its own in the probe; a preview has nothing to show for it.
        if let Some(refusal) = basis.refusal {
            return Err(refusal.error());
        }
        if !latest().admit(page_key, generation) {
            return Err(cancelled());
        }
        if request.key.rev != basis.rev {
            return Err(AppError::invalid("lineKey"));
        }
        let chars = self.engine.page_chars(id, basis.engine_index)?;
        if !latest().is_current(page_key, generation) {
            return Err(cancelled());
        }
        let original = if basis.from_file {
            None
        } else {
            Some(self.plain_original(id)?)
        };
        let Basis {
            current,
            current_page,
            file_index,
            edits,
            ..
        } = basis;
        let (key, text) = (request.key, request.text.clone());
        let draft = TextEdit {
            key,
            text: request.text.clone(),
            fit: request.fit,
            scope: request.scope,
        };
        let made = contained(id.get(), limits::TEXT_PREVIEW_TIMEOUT, move || {
            replay(
                &current,
                current_page,
                original.as_deref(),
                file_index,
                edits,
                draft,
                &chars,
            )
        })?;
        // The picture is the expensive part: a newer keystroke makes it pointless.
        if !latest().is_current(page_key, generation) {
            return Err(cancelled());
        }
        let clipped = made.page.clipped.ok_or(AppError::invalid("region"))?;
        let (width_pt, height_pt) = (clipped[2] - clipped[0], clipped[3] - clipped[1]);
        let effective = frame_scale(width_pt, height_pt, f64::from(scale))?;
        let quarter = u8::try_from((4 - made.page.rotate / 90) % 4).unwrap_or(0);
        let raster = {
            let _permit = self.renders.acquire(id)?;
            let snapshot = open_bytes(self, Arc::from(made.page.bytes.as_slice()))?;
            let guard = SnapshotGuard::hold(self, snapshot);
            #[allow(clippy::cast_possible_truncation)] // 36 to 576
            let dpi = (effective * 72.0) as f32;
            self.engine
                .render_export(guard.engine(), 0, dpi, false, quarter)?
        };
        if !latest().is_current(page_key, generation) {
            return Err(cancelled());
        }
        let png = encode(&raster, ImageFormat::Png, 100)?;
        #[allow(clippy::cast_possible_truncation)] // page coordinates are far below f32's range
        let meta = TextPreviewMeta {
            generation,
            rect: Rect {
                x: clipped[0] as f32,
                y: clipped[1] as f32,
                w: width_pt as f32,
                h: height_pt as f32,
            },
            px_per_pt: (f64::from(raster.width) / width_pt) as f32,
            overflow_pt: made.overflow as f32,
            fallback: if made.unchanged {
                None
            } else {
                draft_fallback(&made.page.fallback, &text)
            },
        };
        Ok(TextPreview { meta, png })
    }
}

/// The pixels per point a region of `width_pt` x `height_pt` can be drawn at when `scale` is asked for: lowered to stay within the
/// preview's pixel budget. `limit_exceeded` (`pixels`) when that is below the smallest scale.
fn frame_scale(width_pt: f64, height_pt: f64, scale: f64) -> Result<f64, AppError> {
    if !(width_pt >= 1.0 && height_pt >= 1.0) {
        return Err(AppError::invalid("region"));
    }
    #[allow(clippy::cast_precision_loss)] // 8 million is exact in an f64
    let area = limits::TEXT_PREVIEW_MAX_PIXELS as f64;
    let side = f64::from(limits::TEXT_PREVIEW_MAX_SIDE_PX);
    let effective = scale
        .min((area / (width_pt * height_pt)).sqrt())
        .min(side / width_pt.max(height_pt));
    if effective < f64::from(limits::TEXT_PREVIEW_MIN_SCALE) {
        return Err(AppError::limit("pixels", limits::TEXT_PREVIEW_MAX_PIXELS));
    }
    Ok(effective)
}

/// The face of the page's substitute fonts that draws characters of `text`, and which ones.
fn draft_fallback(used: &FallbackUse, text: &str) -> Option<PreviewFallback> {
    used.iter().find_map(|(face, set)| {
        let mut chars: Vec<char> = text
            .chars()
            .filter(|c| !c.is_whitespace() && set.contains(c))
            .collect();
        chars.sort_unstable();
        chars.dedup();
        (!chars.is_empty()).then(|| PreviewFallback {
            face: face.family,
            chars: chars.into_iter().map(String::from).collect(),
        })
    })
}

/// The region of `line` (see [`Region`]) in page space.
fn region_of(lines: &PageLines, line: &Line, scope: TextScope) -> Region {
    let room = lines.room_after(line.index);
    let b = line.bounds;
    let (mut x0, mut y0) = (f64::from(b.x), f64::from(b.y));
    let (mut x1, mut y1) = (f64::from(b.x + b.w), f64::from(b.y + b.h));
    // Nothing follows: the region runs to the page's edge (the preview cuts it to the page).
    x1 += room.unwrap_or(1.0e6);
    // Right-aligned and centred lines grow to the left: the region runs back to the neighbour before, or the page's edge.
    let before = lines.room_before(line.index);
    x0 -= before.unwrap_or(1.0e6);
    if scope == TextScope::Paragraph {
        if let Some(paragraph) = lines.paragraphs.get(line.paragraph as usize) {
            for other in lines
                .lines
                .iter()
                .filter(|other| paragraph.lines.contains(&other.index))
            {
                let o = other.bounds;
                x0 = x0.min(f64::from(o.x));
                y0 = y0.min(f64::from(o.y));
                x1 = x1.max(f64::from(o.x + o.w));
                y1 = y1.max(f64::from(o.y + o.h));
            }
            // The re-break may need one line more.
            y1 += f64::from(b.h);
        }
    }
    let pad = (0.2 * f64::from(b.h)).max(2.0);
    Region {
        // A neighbour before the line is not cut into: its glyph edge would read as ink of this line.
        clip: [
            (x0 - if before.is_some() { 0.0 } else { 2.0 }).max(0.0),
            (y0 - pad).max(0.0),
            x1 + 2.0,
            y1 + pad,
        ],
        room,
    }
}

fn dot(a: [f64; 2], b: [f64; 2]) -> f64 {
    a[0] * b[0] + a[1] * b[1]
}

fn same_direction(a: [f64; 2], b: [f64; 2]) -> bool {
    dot(a, b) > 0.0 && (a[0] * b[1] - a[1] * b[0]).abs() < 0.02
}

/// How far the edited line ends past the room it had: the end of the line in the replayed page that sits where the old one started,
/// against the end of the old line and the room after it. Page space is not needed: both are read in the page's user space.
fn overflow_of(old: &Line, room: Option<f64>, page_width: f64, replayed: &PageLines) -> f64 {
    let Some(was) = old.span() else { return 0.0 };
    let now = replayed
        .lines
        .iter()
        .filter(|line| same_direction(line.dir, old.dir))
        .filter_map(|line| line.span())
        .filter(|span| {
            (span.baseline - was.baseline).abs() <= 0.2 * old.size
                && (span.start - was.start).abs() <= old.size.max(1.0)
        })
        .min_by(|a, b| {
            (a.start - was.start)
                .abs()
                .total_cmp(&(b.start - was.start).abs())
        });
    let Some(now) = now else { return 0.0 };
    let allowed =
        room.unwrap_or_else(|| (page_width - f64::from(old.bounds.x + old.bounds.w)).max(0.0));
    ((now.end - was.end) - allowed).max(0.0)
}

/// The thread's work: find the line, make the region and the replayed page, measure the overflow.
fn replay(
    current: &[u8],
    current_page: u32,
    original: Option<&[u8]>,
    file_index: u32,
    stored: Vec<TextEdit>,
    draft: TextEdit,
    chars: &[crate::model::text_edit::CharGeom],
) -> Result<Made, AppError> {
    let doc = PageDoc::load(current)?;
    if doc.is_signed()? {
        return Err(AppError::read_only("signed"));
    }
    let mut lines = doc.lines(doc.page(current_page)?, chars)?;
    doc.refuse(&mut lines, None)?;
    let line = lines
        .lines
        .get(draft.key.line as usize)
        .ok_or(AppError::invalid("lineKey"))?;
    if let LineEditable::No { reason } = line.editable {
        return Err(reason.error());
    }
    let unchanged = line.text == draft.text;
    let region = region_of(&lines, line, draft.scope);
    let mut all = stored;
    if !unchanged {
        all.push(draft);
    }
    let page = text_save::preview_page_with(
        original.unwrap_or(current),
        file_index,
        &all,
        Some(region.clip),
    )?;
    let overflow = if unchanged {
        0.0
    } else {
        let replayed_doc = PageDoc::load(&page.bytes)?;
        let replayed = replayed_doc.lines(replayed_doc.page(0)?, &[])?;
        overflow_of(line, region.room, page.page_size[0], &replayed)
    };
    Ok(Made {
        page,
        overflow,
        unchanged,
    })
}

/// The live preview of a line being edited (binary answer, see the module documentation).
#[tauri::command]
#[allow(clippy::too_many_arguments)] // the wire's argument list
pub async fn text_edit_preview(
    state: State<'_, AppState>,
    doc_id: DocumentId,
    page_id: PageId,
    key: LineKey,
    text: String,
    fit: TextFit,
    scope: TextScope,
    generation: u32,
    scale: f32,
) -> Result<Response, UiError> {
    let state = state.inner().clone();
    blocking(move || {
        let request = PreviewRequest {
            key,
            text,
            fit,
            scope,
            generation,
            scale,
        };
        state
            .text_edit_preview(doc_id, page_id, request)?
            .into_wire()
    })
    .await
    .map(Response::new)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::testutil::state_with_pages;
    use crate::model::text_edit::LineKey;

    fn request(text: &str, generation: u32, scale: f32) -> PreviewRequest {
        PreviewRequest {
            key: LineKey { rev: 0, line: 0 },
            text: text.to_owned(),
            fit: TextFit::KeepStart,
            scope: TextScope::Line,
            generation,
            scale,
        }
    }

    #[test]
    fn a_generation_older_than_one_seen_is_dropped() {
        let latest = Latest::default();
        assert!(latest.admit((1, 1), 5));
        assert!(latest.is_current((1, 1), 5));
        assert!(!latest.admit((1, 1), 4), "older");
        assert!(latest.admit((1, 1), 5), "the same one again");
        assert!(latest.admit((1, 1), 6));
        assert!(!latest.is_current((1, 1), 5), "a newer one arrived");
        assert!(latest.admit((1, 2), 1), "another page has its own");
        assert!(latest.is_current((9, 9), 0), "an unknown page is current");
    }

    #[test]
    fn the_guard_forgets_when_it_has_too_many_pages() {
        let latest = Latest::default();
        for page in 0..limits::TEXT_PREVIEW_GENERATIONS as u32 + 10 {
            assert!(latest.admit((1, page), 1));
        }
        let held = latest.seen.lock().map(|seen| seen.pages.len()).unwrap_or(0);
        assert!(held <= limits::TEXT_PREVIEW_GENERATIONS);
    }

    #[test]
    fn a_refused_document_does_not_register_its_generation() {
        // The document is checked (permission, signature, source, file) before the frame counts as the page's newest.
        let (state, id) = state_with_pages(1, |_| {});
        let page = state.registry.page_id(id, 0).unwrap();
        let key = (id.get(), page.get());
        let error = state
            .text_edit_preview(id, page, request("x", 100, 2.0))
            .unwrap_err();
        assert_ne!(error.code(), ErrorCode::Cancelled);
        assert!(
            latest().is_current(key, 0),
            "generation 100 was not admitted"
        );
    }

    #[test]
    fn the_input_is_validated_before_anything_is_read() {
        let (state, id) = state_with_pages(1, |_| {});
        let page = state.registry.page_id(id, 0).unwrap();
        let long = "a".repeat(limits::TEXT_EDIT_LINE_CHARS + 1);
        let error = state
            .text_edit_preview(id, page, request(&long, 1, 2.0))
            .unwrap_err();
        assert_eq!(error.code(), ErrorCode::LimitExceeded);
        for scale in [0.0, 0.49, 8.01, f32::NAN, f32::INFINITY, -1.0] {
            let error = state
                .text_edit_preview(id, page, request("x", 1, scale))
                .unwrap_err();
            assert_eq!(error.code(), ErrorCode::InvalidArgument, "{scale}");
        }
        let error = state
            .text_edit_preview(id, page, request("\u{4e2d}", 1, 2.0))
            .unwrap_err();
        assert_eq!(error.code(), ErrorCode::UnsupportedFeature);
    }

    #[test]
    fn the_frame_scale_is_lowered_to_the_pixel_budget_or_refused() {
        assert_eq!(frame_scale(100.0, 20.0, 4.0).unwrap(), 4.0);
        let lowered = frame_scale(2_000.0, 2_000.0, 8.0).unwrap();
        assert!((0.5..2.0).contains(&lowered), "{lowered}");
        let error = frame_scale(20_000.0, 20_000.0, 8.0).unwrap_err();
        assert_eq!(error.code(), ErrorCode::LimitExceeded);
        assert!(frame_scale(0.0, 20.0, 1.0).is_err());
    }

    #[test]
    fn the_fallback_names_the_chars_of_the_draft_the_face_draws() {
        use crate::fontprog::fallback::Face;
        let used: FallbackUse = vec![(
            Face {
                family: FallbackFace::Serif,
                bold: false,
                italic: false,
            },
            ['\u{20ac}', 'z'].into_iter().collect(),
        )];
        let found = draft_fallback(&used, "a \u{20ac}5 \u{20ac}").unwrap();
        assert_eq!(found.face, FallbackFace::Serif);
        assert_eq!(found.chars, vec!["\u{20ac}".to_owned()]);
        assert_eq!(draft_fallback(&used, "plain"), None);
    }

    #[test]
    fn the_wire_form_has_the_length_the_metadata_and_the_picture() {
        let preview = TextPreview {
            meta: TextPreviewMeta {
                generation: 3,
                rect: Rect {
                    x: 1.0,
                    y: 2.0,
                    w: 3.0,
                    h: 4.0,
                },
                px_per_pt: 2.0,
                overflow_pt: 0.0,
                fallback: None,
            },
            png: vec![7, 8, 9],
        };
        let wire = preview.into_wire().unwrap();
        let length = u32::from_le_bytes(wire[..4].try_into().unwrap()) as usize;
        let json: serde_json::Value = serde_json::from_slice(&wire[4..4 + length]).unwrap();
        assert_eq!(json["generation"], 3);
        assert_eq!(json["pxPerPt"], 2.0);
        assert!(json["fallback"].is_null());
        assert_eq!(&wire[4 + length..], &[7, 8, 9]);
    }

    #[test]
    fn a_contained_run_turns_a_panic_into_an_error() {
        let panicked: Result<(), AppError> =
            contained(1, Duration::from_secs(5), || -> Result<(), AppError> {
                panic!("boom")
            });
        assert_eq!(panicked.unwrap_err().code(), ErrorCode::Internal);
    }

    #[test]
    fn the_guard_forgets_the_page_used_longest_ago() {
        let latest = Latest::default();
        for page in 0..limits::TEXT_PREVIEW_GENERATIONS as u32 {
            assert!(latest.admit((1, page), 7));
        }
        assert!(latest.admit((1, 0), 7), "page 0 is used again");
        assert!(latest.admit((2, 0), 1), "a new page evicts one");
        assert!(!latest.admit((1, 0), 6), "page 0 was kept");
        assert!(latest.admit((1, 1), 1), "page 1 was the oldest and is gone");
    }

    #[test]
    fn a_document_has_its_own_cap_under_the_global_one() {
        let doc = 4_000_000_001;
        let mut held = Vec::new();
        for _ in 0..limits::TEXT_PREVIEW_MAX_PER_DOC {
            held.push(Slot::take(doc).unwrap());
        }
        assert_eq!(
            Slot::take(doc).unwrap_err().code(),
            ErrorCode::LimitExceeded
        );
        let other = Slot::take(doc + 1).expect("another document is not held up");
        drop(held);
        drop(other);
        assert!(Slot::take(doc).is_ok(), "the slots are given back");
    }
}
