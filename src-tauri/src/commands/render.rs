//! The commands of the viewer's render pipeline (ADR-002): `render_page`, `set_viewport` and `get_page_sizes`.
//!
//! The UI lays a document out from the size of every page (`get_page_sizes`), mounts only the pages near the viewport, and for
//! each asks `render_page` for the frame at the page's zoom bucket, the whole page or one 1024 px tile of it. Requests wait in
//! the engine's priority queue; `set_viewport` says which pages are on screen (`visible`) and which are close (`near`), and
//! queued renders for any other page are cancelled with `cancelled`, which the UI ignores. `generation` counts the UI's
//! viewport changes: of two equally urgent renders the more recent goes first, and a hint never cancels a render that was
//! asked for after it was made.
//!
//! **Bounds.** A call that names a tile no page has (a column or row of 64 or more) is refused at the command, a viewport hint
//! is refused while it is being read once a list has more than 64 pages ([`PageList`]), and the number of `render_page` calls in
//! flight is capped per document and in all ([`RenderGate`]): every call holds a thread of the blocking pool until its frame is
//! done, and a flood must not be able to park them all. `get_page_sizes` is a lookup (the sizes were read when the document
//! was loaded), so it costs nothing however often it is asked.

use std::collections::HashMap;
use std::fmt;
use std::sync::{Arc, Mutex, PoisonError};

use serde::de::{self, Deserializer, SeqAccess, Visitor};
use serde::Deserialize;
use tauri::ipc::Response;
use tauri::State;

use super::{blocking, AppState};
use crate::documents::{DocumentId, PageId};
use crate::engine::{Frame, PageSizes, Priority, RenderKey, RenderSpec};
use crate::error::{AppError, UiError};
use crate::limits;

/// How urgent a render from the UI is. The other priorities of the queue belong to the backend's own work.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RenderPriority {
    /// The page is on screen.
    Visible,
    /// The page is just outside the viewport.
    Near,
    /// A thumbnail of the left panel.
    Thumbnail,
}

impl From<RenderPriority> for Priority {
    fn from(priority: RenderPriority) -> Self {
        match priority {
            RenderPriority::Visible => Priority::Visible,
            RenderPriority::Near => Priority::Near,
            RenderPriority::Thumbnail => Priority::Thumbnail,
        }
    }
}

/// One frame to render (`render_page`'s argument). On the wire an object in camelCase; an unknown field is an error.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RenderRequest {
    pub doc_id: DocumentId,
    pub page_id: PageId,
    /// Zoom bucket: the page is drawn at `2^(bucket / 4)` device pixels per point (`limits::MIN_BUCKET..=MAX_BUCKET`).
    pub bucket: i16,
    /// `[column, row]` of a 1024 px tile of the page at that scale. Without it the whole page, which has to fit a frame
    /// (4096 px a side, 16 Mpx): `limit_exceeded` tells the UI to ask for tiles.
    #[serde(default)]
    pub tile: Option<(u16, u16)>,
    pub priority: RenderPriority,
    pub generation: u32,
}

/// The pages of one list of a viewport hint: at most `limits::MAX_VIEWPORT_PAGES`. The bound is the type's: a list read from the
/// wire is refused as soon as it has one page too many (the rest is not read, let alone kept), and [`PageList::new`] refuses a
/// longer one, so a `PageList` that exists is within the limit.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct PageList(Vec<PageId>);

impl PageList {
    /// `limit_exceeded` (`pages`) for more than `limits::MAX_VIEWPORT_PAGES`.
    pub fn new(pages: Vec<PageId>) -> Result<Self, AppError> {
        limits::validate_viewport_pages(pages.len())?;
        Ok(Self(pages))
    }

    pub fn as_slice(&self) -> &[PageId] {
        &self.0
    }
}

impl<'de> Deserialize<'de> for PageList {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Bounded;

        impl<'de> Visitor<'de> for Bounded {
            type Value = PageList;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                write!(
                    formatter,
                    "a list of at most {} page ids",
                    limits::MAX_VIEWPORT_PAGES
                )
            }

            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<PageList, A::Error> {
                // The announced length is the sender's word: it only sizes the first allocation, within the limit.
                let announced = seq.size_hint().unwrap_or(0);
                let mut pages = Vec::with_capacity(announced.min(limits::MAX_VIEWPORT_PAGES));
                while let Some(page) = seq.next_element::<PageId>()? {
                    if pages.len() == limits::MAX_VIEWPORT_PAGES {
                        return Err(de::Error::invalid_length(pages.len() + 1, &self));
                    }
                    pages.push(page);
                }
                Ok(PageList(pages))
            }
        }

        deserializer.deserialize_seq(Bounded)
    }
}

/// What the UI shows (`set_viewport`'s argument): at most `limits::MAX_VIEWPORT_PAGES` pages each.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ViewportHint {
    pub generation: u32,
    pub visible: PageList,
    pub near: PageList,
}

/// Counts the `render_page` calls that are in flight, per document and in all, and refuses one past the limit
/// (`limit_exceeded`, `requests`). A call holds a thread of the blocking pool from the moment it starts until its frame is
/// done, its deadline passes or it is cancelled; without a limit a webview that asks for a thousand frames parks a thousand
/// threads. The limits (`limits::MAX_RENDERS_PER_DOCUMENT`, `MAX_RENDERS_IN_FLIGHT`) are above what the UI can have pending,
/// so only a flood meets them.
#[derive(Debug)]
pub struct RenderGate {
    per_document: usize,
    in_all: usize,
    state: Mutex<GateState>,
}

#[derive(Debug, Default)]
struct GateState {
    total: usize,
    by_document: HashMap<DocumentId, usize>,
}

impl Default for RenderGate {
    fn default() -> Self {
        Self::with_limits(
            limits::MAX_RENDERS_PER_DOCUMENT,
            limits::MAX_RENDERS_IN_FLIGHT,
        )
    }
}

impl RenderGate {
    pub fn with_limits(per_document: usize, in_all: usize) -> Self {
        Self {
            per_document,
            in_all,
            state: Mutex::new(GateState::default()),
        }
    }

    /// Takes a place for a render of document `id`, which is given back when the permit is dropped.
    pub fn acquire(self: &Arc<Self>, id: DocumentId) -> Result<RenderPermit, AppError> {
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        if state.total >= self.in_all {
            return Err(AppError::limit("requests", self.in_all as u64));
        }
        let held = state.by_document.get(&id).copied().unwrap_or(0);
        if held >= self.per_document {
            return Err(AppError::limit("requests", self.per_document as u64));
        }
        state.by_document.insert(id, held + 1);
        state.total += 1;
        Ok(RenderPermit {
            gate: Arc::clone(self),
            id,
        })
    }

    fn release(&self, id: DocumentId) {
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        state.total = state.total.saturating_sub(1);
        if let Some(held) = state.by_document.get_mut(&id) {
            *held = held.saturating_sub(1);
            if *held == 0 {
                state.by_document.remove(&id);
            }
        }
    }

    /// How many calls are in flight (all documents).
    #[cfg(test)]
    fn in_flight(&self) -> usize {
        self.state
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .total
    }

    /// How many documents have a call in flight.
    #[cfg(test)]
    fn documents(&self) -> usize {
        self.state
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .by_document
            .len()
    }
}

/// A place in a [`RenderGate`], held for the duration of one render call.
#[derive(Debug)]
pub struct RenderPermit {
    gate: Arc<RenderGate>,
    id: DocumentId,
}

impl Drop for RenderPermit {
    fn drop(&mut self) {
        self.gate.release(self.id);
    }
}

/// The bytes of a frame, for the IPC response, which takes them by value. The only holder gets them as they are; a frame that
/// other callers share (they asked for the same one while it was drawn, see `engine::queue`) is copied once for this caller, here
/// on its own thread and not on the engine's worker.
fn into_bytes(frame: Frame) -> Vec<u8> {
    Arc::try_unwrap(frame).unwrap_or_else(|shared| shared.as_ref().clone())
}

impl AppState {
    /// Validates the request (the bucket, the tile, and the page against the registered page count), takes a place among the
    /// renders in flight, then renders. Returns a frame, or `cancelled` if the request was withdrawn while it waited, or
    /// `limit_exceeded` (`requests`) if too many renders of the document, or in all, are in flight already.
    pub fn render_page(&self, request: RenderRequest) -> Result<Frame, AppError> {
        limits::bucket_scale(request.bucket)?;
        limits::validate_tile(request.tile)?;
        let page_index = self.registry.page_index(request.doc_id, request.page_id)?;
        let _permit = self.renders.acquire(request.doc_id)?;
        self.engine.render(RenderSpec {
            key: RenderKey {
                id: request.doc_id,
                page_index,
                bucket: request.bucket,
                tile: request.tile,
            },
            priority: request.priority.into(),
            generation: request.generation,
        })
    }

    /// Validates the hint against the registered page count (its lists are within the limit already, see [`PageList`]), then
    /// hands it to the engine's queue.
    pub fn set_viewport(&self, id: DocumentId, hint: &ViewportHint) -> Result<(), AppError> {
        let indices = |pages: &PageList| -> Result<Vec<u32>, AppError> {
            pages
                .as_slice()
                .iter()
                .map(|&page| self.registry.page_index(id, page))
                .collect()
        };
        let (visible, near) = (indices(&hint.visible)?, indices(&hint.near)?);
        self.engine
            .set_viewport(id, hint.generation, &visible, &near);
        Ok(())
    }

    /// The size in points of every page of an open document, in page order. The sizes were read once when the document was
    /// loaded and are shared (`engine::sizes`): this is a lookup, so it takes no place in the engine's queue and costs the same
    /// however often, or however many at once, it is asked.
    pub fn page_sizes(&self, id: DocumentId) -> Result<PageSizes, AppError> {
        // Unknown, not yet loaded and closing documents are `not_found` before the engine is asked.
        self.registry.page_count(id)?;
        self.engine.page_sizes(id)
    }
}

/// Renders one frame of a page. Returned as raw bytes, not JSON, to avoid inflating large images.
#[tauri::command]
pub async fn render_page(
    state: State<'_, AppState>,
    req: RenderRequest,
) -> Result<Response, UiError> {
    let state = state.inner().clone();
    blocking(move || state.render_page(req))
        .await
        .map(|frame| Response::new(into_bytes(frame)))
}

/// Tells the engine which pages are on screen and which are close, so it can drop the renders nobody waits for.
#[tauri::command]
pub async fn set_viewport(
    state: State<'_, AppState>,
    doc_id: DocumentId,
    hint: ViewportHint,
) -> Result<(), UiError> {
    let state = state.inner().clone();
    blocking(move || state.set_viewport(doc_id, &hint)).await
}

/// The size of every page in points (width, height), for the layout of the scrolling canvas. A lookup of what was read when the
/// document was loaded, so it returns at once however often it is asked and never waits for the worker.
#[tauri::command]
pub async fn get_page_sizes(
    state: State<'_, AppState>,
    doc_id: DocumentId,
) -> Result<Vec<[f32; 2]>, UiError> {
    let state = state.inner().clone();
    blocking(move || state.page_sizes(doc_id).map(|sizes| sizes.to_vec())).await
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::{Arc, Mutex};

    use super::*;
    use crate::engine::{Engine, Job};
    use crate::error::ErrorCode;

    fn manifest() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml")
    }

    /// A state whose engine has no library: enough to test everything that is decided before PDFium is involved.
    fn state_without_engine() -> AppState {
        AppState::new(Engine::start(
            PathBuf::from("no-such-dir").join("pdfium.dll"),
        ))
    }

    fn request(doc_id: DocumentId, page: u32, bucket: i16) -> RenderRequest {
        RenderRequest {
            doc_id,
            page_id: PageId::new(page),
            bucket,
            tile: None,
            priority: RenderPriority::Visible,
            generation: 1,
        }
    }

    #[test]
    fn requests_deserialize_from_the_wire_shape_and_reject_unknown_fields() {
        let parsed: RenderRequest = serde_json::from_str(
            r#"{"docId":3,"pageId":7,"bucket":-2,"tile":[1,2],"priority":"near","generation":9}"#,
        )
        .unwrap();
        assert_eq!(parsed.page_id, PageId::new(7));
        assert_eq!(parsed.bucket, -2);
        assert_eq!(parsed.tile, Some((1, 2)));
        assert_eq!(parsed.priority, RenderPriority::Near);
        assert_eq!(parsed.generation, 9);
        // The tile is optional.
        let whole: RenderRequest = serde_json::from_str(
            r#"{"docId":3,"pageId":0,"bucket":0,"priority":"visible","generation":0}"#,
        )
        .unwrap();
        assert_eq!(whole.tile, None);
        for bad in [
            r#"{"docId":3,"pageId":0,"bucket":0,"priority":"visible","generation":0,"scale":1}"#,
            r#"{"docId":3,"pageId":0,"bucket":0,"priority":"control","generation":0}"#,
            r#"{"docId":3,"pageId":0,"bucket":0,"priority":"visible","generation":-1}"#,
            r#"{"docId":3,"pageId":0,"bucket":99999,"priority":"visible","generation":0}"#,
            r#"{"docId":3,"pageId":0,"bucket":0,"tile":[1,70000],"priority":"visible","generation":0}"#,
            r#"{"docId":3,"pageId":0,"bucket":0,"priority":"visible"}"#,
        ] {
            assert!(serde_json::from_str::<RenderRequest>(bad).is_err(), "{bad}");
        }
        let hint: ViewportHint =
            serde_json::from_str(r#"{"generation":4,"visible":[1,2],"near":[3]}"#).unwrap();
        assert_eq!(hint.visible.as_slice(), [PageId::new(1), PageId::new(2)]);
        assert_eq!(hint.near.as_slice(), [PageId::new(3)]);
        assert!(serde_json::from_str::<ViewportHint>(r#"{"generation":4,"visible":[1]}"#).is_err());
    }

    /// `[0, 1, ..., count - 1]` as JSON.
    fn page_list_json(count: usize) -> String {
        let pages: Vec<String> = (0..count).map(|page| page.to_string()).collect();
        format!("[{}]", pages.join(","))
    }

    #[test]
    fn a_viewport_hint_with_too_many_pages_is_refused_while_it_is_read() {
        let hint = |visible: usize, near: usize| {
            serde_json::from_str::<ViewportHint>(&format!(
                r#"{{"generation":1,"visible":{},"near":{}}}"#,
                page_list_json(visible),
                page_list_json(near)
            ))
        };
        // At the limit, in both lists, and empty.
        let at_the_limit = hint(limits::MAX_VIEWPORT_PAGES, limits::MAX_VIEWPORT_PAGES).unwrap();
        assert_eq!(
            at_the_limit.visible.as_slice().len(),
            limits::MAX_VIEWPORT_PAGES
        );
        assert_eq!(
            at_the_limit.near.as_slice().len(),
            limits::MAX_VIEWPORT_PAGES
        );
        assert!(hint(0, 0).is_ok());
        // One too many in either list, and a list that is absurdly long: an error, whose text says what the limit is.
        for (visible, near) in [
            (limits::MAX_VIEWPORT_PAGES + 1, 0),
            (0, limits::MAX_VIEWPORT_PAGES + 1),
            (200_000, 0),
        ] {
            let error = hint(visible, near).unwrap_err().to_string();
            assert!(
                error.contains("at most 64 page ids"),
                "{visible} {near}: {error}"
            );
        }
        // The elements are still checked for what they are.
        assert!(serde_json::from_str::<PageList>("[1,-2]").is_err());
        assert!(serde_json::from_str::<PageList>(r#"[1,"2"]"#).is_err());
        assert!(serde_json::from_str::<PageList>("7").is_err());
    }

    #[test]
    fn a_page_list_is_built_only_within_the_limit() {
        let pages = |count: u32| (0..count).map(PageId::new).collect::<Vec<_>>();
        assert!(PageList::new(pages(limits::MAX_VIEWPORT_PAGES as u32)).is_ok());
        assert_eq!(
            PageList::new(pages(limits::MAX_VIEWPORT_PAGES as u32 + 1))
                .unwrap_err()
                .code(),
            ErrorCode::LimitExceeded
        );
        assert!(PageList::default().as_slice().is_empty());
    }

    #[test]
    fn the_ui_can_ask_for_three_priorities_and_no_other() {
        assert_eq!(Priority::from(RenderPriority::Visible), Priority::Visible);
        assert_eq!(Priority::from(RenderPriority::Near), Priority::Near);
        assert_eq!(
            Priority::from(RenderPriority::Thumbnail),
            Priority::Thumbnail
        );
    }

    #[test]
    fn render_rejects_unknown_documents_and_bad_buckets_before_the_engine() {
        let state = state_without_engine();
        // A registered but never loaded document is indistinguishable from an unknown one.
        let id = state.registry.register(manifest()).unwrap();
        let code = |result: Result<Frame, AppError>| result.unwrap_err().code();
        assert_eq!(
            code(state.render_page(request(id, 0, 0))),
            ErrorCode::NotFound
        );
        for bad_bucket in [limits::MIN_BUCKET - 1, limits::MAX_BUCKET + 1, i16::MAX] {
            assert_eq!(
                code(state.render_page(request(id, 0, bad_bucket))),
                ErrorCode::InvalidArgument,
                "{bad_bucket}"
            );
        }
    }

    #[test]
    fn render_rejects_a_tile_that_no_page_has_at_the_command_not_in_the_queue() {
        // An engine that records what reaches it: nothing may, for these requests.
        let seen: Arc<Mutex<Vec<RenderKey>>> = Arc::default();
        let log = Arc::clone(&seen);
        let engine = Engine::with_handler(move |job| {
            if let Job::Render { key, reply } = job {
                log.lock().unwrap().push(key);
                let _ = reply.send(Ok(Arc::new(vec![1])));
            }
        });
        let state = AppState::new(engine);
        let id = state.registry.register(manifest()).unwrap();
        state.registry.set_page_count(id, 3).unwrap();
        let last = (limits::MAX_TILES_PER_SIDE - 1) as u16;
        for tile in [
            (last + 1, 0),
            (0, last + 1),
            (u16::MAX, u16::MAX),
            (u16::MAX, 0),
        ] {
            let mut ask = request(id, 0, 0);
            ask.tile = Some(tile);
            let error = state.render_page(ask).unwrap_err();
            assert_eq!(error.code(), ErrorCode::InvalidArgument, "{tile:?}");
        }
        assert!(seen.lock().unwrap().is_empty(), "the engine was asked");
        // The last tile of the largest grid is a tile; whether this page has it is for the engine to say.
        let mut ask = request(id, 0, 0);
        ask.tile = Some((last, last));
        assert!(state.render_page(ask).is_ok());
        assert_eq!(seen.lock().unwrap().len(), 1);
        // No place was kept by the refused calls.
        assert_eq!(state.renders.in_flight(), 0);
    }

    #[test]
    fn render_checks_the_page_id_against_the_registry() {
        let state = state_without_engine();
        let id = state.registry.register(manifest()).unwrap();
        state.registry.set_page_count(id, 3).unwrap();
        // Pages 3 and up are out of range; this is rejected before the (unavailable) engine is asked.
        for page in [3, 4, u32::MAX] {
            assert_eq!(
                state.render_page(request(id, page, 0)).unwrap_err().code(),
                ErrorCode::InvalidArgument,
                "page {page}"
            );
        }
        // A valid request reaches the engine, which here has no library.
        assert_eq!(
            state.render_page(request(id, 2, 0)).unwrap_err().code(),
            ErrorCode::EngineUnavailable
        );
    }

    #[test]
    fn a_render_reaches_the_engine_with_the_page_index_bucket_and_tile() {
        let seen: Arc<Mutex<Vec<RenderKey>>> = Arc::default();
        let log = Arc::clone(&seen);
        let engine = Engine::with_handler(move |job| {
            if let Job::Render { key, reply } = job {
                log.lock().unwrap().push(key);
                let _ = reply.send(Ok(Arc::new(vec![1, 2, 3])));
            }
        });
        let state = AppState::new(engine);
        let id = state.registry.register(manifest()).unwrap();
        state.registry.set_page_count(id, 5).unwrap();

        let mut ask = request(id, 4, 6);
        ask.tile = Some((2, 3));
        assert_eq!(*state.render_page(ask).unwrap(), vec![1, 2, 3]);
        let log = seen.lock().unwrap();
        let key = log[0];
        assert_eq!(key.id, id);
        assert_eq!(key.page_index, 4);
        assert_eq!(key.bucket, 6);
        assert_eq!(key.tile, Some((2, 3)));
    }

    // --- the renders in flight ---

    fn documents(count: usize) -> Vec<DocumentId> {
        let registry = crate::documents::Registry::new();
        (0..count)
            .map(|i| {
                registry
                    .register(PathBuf::from(format!("{i}.pdf")))
                    .unwrap()
            })
            .collect()
    }

    #[test]
    fn a_document_may_have_only_so_many_renders_in_flight_and_a_place_is_given_back() {
        let gate = Arc::new(RenderGate::with_limits(3, 100));
        let ids = documents(2);
        let (a, b) = (ids[0], ids[1]);
        let mut held: Vec<RenderPermit> = (0..3).map(|_| gate.acquire(a).unwrap()).collect();
        let error = gate.acquire(a).unwrap_err();
        assert_eq!(error.code(), ErrorCode::LimitExceeded);
        // Another document is not held up by it.
        let other = gate.acquire(b).unwrap();
        assert_eq!(gate.in_flight(), 4);

        // A place that is given back is there again for the same document.
        drop(held.pop());
        assert!(gate.acquire(a).is_ok());
        drop(held);
        drop(other);
        assert_eq!(gate.in_flight(), 0);
        assert_eq!(
            gate.documents(),
            0,
            "nothing is remembered about idle documents"
        );
    }

    #[test]
    fn all_documents_together_may_have_only_so_many_renders_in_flight() {
        let gate = Arc::new(RenderGate::with_limits(10, 4));
        let ids = documents(3);
        let held: Vec<RenderPermit> = (0..4).map(|i| gate.acquire(ids[i % 3]).unwrap()).collect();
        for id in &ids {
            assert_eq!(
                gate.acquire(*id).unwrap_err().code(),
                ErrorCode::LimitExceeded
            );
        }
        drop(held);
        assert!(gate.acquire(ids[2]).is_ok());
    }

    #[test]
    fn the_limits_of_the_gate_are_the_documented_ones() {
        let gate = Arc::new(RenderGate::default());
        let id = documents(1)[0];
        let held: Vec<RenderPermit> = (0..limits::MAX_RENDERS_PER_DOCUMENT)
            .map(|_| gate.acquire(id).unwrap())
            .collect();
        assert_eq!(
            gate.acquire(id).unwrap_err().code(),
            ErrorCode::LimitExceeded
        );
        drop(held);
        assert_eq!(gate.in_flight(), 0);
    }

    #[test]
    fn a_flood_of_renders_is_refused_before_it_takes_threads_and_the_places_come_back() {
        // An engine that holds every render until the test lets go, as a slow page would.
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
        let release_rx = Mutex::new(release_rx);
        let engine = Engine::with_handler(move |job| {
            if let Job::Render { reply, .. } = job {
                started_tx.send(()).unwrap();
                let _ = release_rx.lock().unwrap().recv();
                let _ = reply.send(Ok(Arc::new(vec![0])));
            }
        });
        // Small limits, so that the test does not need hundreds of threads: five calls per document, eight in all.
        let mut state = AppState::new(engine);
        state.renders = Arc::new(RenderGate::with_limits(5, 8));
        let id = state.registry.register(manifest()).unwrap();
        state.registry.set_page_count(id, 1000).unwrap();

        // Calls for as many distinct frames as the document may have in flight; the first is in the worker, the rest wait.
        let callers: Vec<_> = (0..5)
            .map(|page| {
                let state = state.clone();
                std::thread::spawn(move || state.render_page(request(id, page, 0)))
            })
            .collect();
        started_rx.recv().unwrap();
        let until = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while state.renders.in_flight() < 5 {
            assert!(std::time::Instant::now() < until, "the calls never started");
            std::thread::sleep(std::time::Duration::from_millis(2));
        }

        // One more is refused at once, with the limit and not with a timeout, and the others are not disturbed.
        let started = std::time::Instant::now();
        let error = state.render_page(request(id, 999, 0)).unwrap_err();
        assert_eq!(error.code(), ErrorCode::LimitExceeded);
        assert!(started.elapsed() < std::time::Duration::from_secs(1));
        assert_eq!(state.renders.in_flight(), 5);

        // Let them all go (the worker holds one frame at a time); every place is given back.
        for _ in 0..5 {
            let _ = release_tx.send(());
        }
        for caller in callers {
            assert!(caller.join().unwrap().is_ok());
        }
        assert_eq!(state.renders.in_flight(), 0);
        assert_eq!(state.renders.documents(), 0);
        // And the document can have its renders again.
        let again = {
            let state = state.clone();
            std::thread::spawn(move || state.render_page(request(id, 7, 0)))
        };
        let _ = release_tx.send(());
        assert!(again.join().unwrap().is_ok());
    }

    #[test]
    fn a_frame_is_moved_into_the_response_without_a_copy_unless_others_share_it() {
        let alone: Frame = Arc::new(vec![1, 2, 3]);
        let address = alone.as_ptr();
        let bytes = into_bytes(alone);
        assert_eq!(bytes, [1, 2, 3]);
        assert_eq!(
            bytes.as_ptr(),
            address,
            "the only holder gets the very bytes"
        );

        let shared: Frame = Arc::new(vec![4, 5, 6]);
        let other = Arc::clone(&shared);
        let copy = into_bytes(shared);
        assert_eq!(copy, [4, 5, 6]);
        assert_eq!(*other, [4, 5, 6], "the other holder is not disturbed");
        assert_ne!(copy.as_ptr(), other.as_ptr());
    }

    #[test]
    fn a_viewport_hint_is_checked_against_the_page_count() {
        let state = state_without_engine();
        let id = state.registry.register(manifest()).unwrap();
        // Not loaded yet: the same `not_found` as everywhere.
        let hint = |visible: Vec<u32>, near: Vec<u32>| ViewportHint {
            generation: 1,
            visible: PageList::new(visible.into_iter().map(PageId::new).collect()).unwrap(),
            near: PageList::new(near.into_iter().map(PageId::new).collect()).unwrap(),
        };
        assert_eq!(
            state
                .set_viewport(id, &hint(vec![0], vec![]))
                .unwrap_err()
                .code(),
            ErrorCode::NotFound
        );
        state.registry.set_page_count(id, 10).unwrap();
        assert!(state
            .set_viewport(id, &hint(vec![0, 1], vec![2, 9]))
            .is_ok());
        // A page that does not exist, in either list.
        for bad in [hint(vec![10], vec![]), hint(vec![], vec![u32::MAX])] {
            assert_eq!(
                state.set_viewport(id, &bad).unwrap_err().code(),
                ErrorCode::InvalidArgument
            );
        }
        // Lists at the limit are fine (longer ones cannot be made, see `a_page_list_is_built_only_within_the_limit`).
        state.registry.set_page_count(id, 1000).unwrap();
        let at_the_limit: Vec<u32> = (0..limits::MAX_VIEWPORT_PAGES as u32).collect();
        assert!(state
            .set_viewport(id, &hint(at_the_limit.clone(), at_the_limit))
            .is_ok());
    }

    #[test]
    fn page_sizes_of_an_unknown_document_are_not_found_before_the_engine_is_asked() {
        let state = state_without_engine();
        let id = state.registry.register(manifest()).unwrap();
        assert_eq!(
            state.page_sizes(id).unwrap_err().code(),
            ErrorCode::NotFound
        );
        state.registry.set_page_count(id, 2).unwrap();
        // Loaded, but the engine holds no sizes for it (it has no library): it does not know the document either.
        assert_eq!(
            state.page_sizes(id).unwrap_err().code(),
            ErrorCode::NotFound
        );
    }

    #[test]
    fn page_sizes_come_from_what_the_engine_read_at_load_and_cost_it_nothing_per_call() {
        let asked = Arc::new(Mutex::new(0));
        let counted = Arc::clone(&asked);
        let engine = Engine::with_handler(move |_job| {
            *counted.lock().unwrap() += 1;
        });
        let state = AppState::new(engine.clone());
        let id = state.registry.register(manifest()).unwrap();
        state.registry.set_page_count(id, 2).unwrap();
        engine.seed_page_sizes(id, vec![[612.0, 792.0], [200.0, 100.0]]);

        let sizes = state.page_sizes(id).unwrap();
        assert_eq!(&*sizes, &[[612.0, 792.0], [200.0, 100.0]]);
        // Again and again: the same list, and the worker never hears of it.
        for _ in 0..100 {
            assert!(Arc::ptr_eq(&sizes, &state.page_sizes(id).unwrap()));
        }
        assert_eq!(*asked.lock().unwrap(), 0);
        // On the wire: an array of `[width, height]`, nothing else.
        assert_eq!(
            serde_json::to_string(&sizes.to_vec()).unwrap(),
            "[[612.0,792.0],[200.0,100.0]]"
        );
        // A document that is being closed has none to give.
        assert!(state.registry.begin_close(id));
        assert_eq!(
            state.page_sizes(id).unwrap_err().code(),
            ErrorCode::NotFound
        );
    }
}
