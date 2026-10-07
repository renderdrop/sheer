//! The OCR job (ADR-134, ARCHITECTURE section 15): a registry of the running job and a minimal sequential pipeline (render a page, ask
//! the recognizer, scale the words to points), then one `DocCommand::ApplyOcr` for everything that worked. A later package replaces the
//! inside of [`run_job`]; its signature, the events it sends and the registry are the seam.

use std::collections::{BTreeSet, HashMap};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError};

use super::backend::{self, Capabilities, ChildClient};
use super::{limits, OcrJobId, OcrPageLayer, PageOcrClass};
use crate::commands::AppState;
use crate::documents::{DocumentId, PageId};
use crate::error::{AppError, ErrorCode};
use crate::events::{AppEvent, AppEvents};
use crate::export::snapshot::{EngineDocRef, SnapshotGuard};
use crate::model::command::DocCommand;
use crate::pdfwrite::ocr_probe::ProbeDoc;
use crate::pdfwrite::pagetree::on_big_stack;
use crate::pdfwrite::redact::RasterPixels;

/// The most OCR jobs that run at once (the recognizer child is one process, pages go one after the other).
pub const MAX_JOBS: usize = 1;
/// The resolution pages are rendered at for recognition.
const TARGET_DPI: f32 = 300.0;
/// A page whose images cover at least this share of its box is a scan (phase 2 replaces this with the engine's probe).
const SCAN_COVER: f32 = 0.5;

/// The language the job uses: `requested` when the recognizer has it, else another available one with `true` (a fallback). `None` when
/// no language is available.
pub fn plan_language(caps: &Capabilities, requested: &str) -> Option<(&'static str, bool)> {
    if let Some(tag) = limits::LANGUAGES
        .iter()
        .find(|tag| **tag == requested && caps.has(tag))
    {
        return Some((tag, false));
    }
    limits::LANGUAGES
        .iter()
        .find(|tag| caps.has(tag))
        .map(|tag| (*tag, true))
}

// --- Registry ------------------------------------------------------------------------------------------------------

static NEXT: AtomicU32 = AtomicU32::new(1);

fn registry() -> MutexGuard<'static, HashMap<u32, Arc<AtomicBool>>> {
    static JOBS: OnceLock<Mutex<HashMap<u32, Arc<AtomicBool>>>> = OnceLock::new();
    JOBS.get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
}

/// A registered job. Dropping it takes the job out of the registry, whatever way the job ended.
pub struct JobHandle {
    pub id: OcrJobId,
    pub cancel: Arc<AtomicBool>,
}

impl Drop for JobHandle {
    fn drop(&mut self) {
        registry().remove(&self.id.get());
    }
}

/// Registers a new job. `limit_exceeded` (`ocrJobs`) while [`MAX_JOBS`] run.
pub fn begin() -> Result<JobHandle, AppError> {
    let mut jobs = registry();
    if jobs.len() >= MAX_JOBS {
        return Err(AppError::limit("ocrJobs", MAX_JOBS as u64));
    }
    let id = OcrJobId::new(NEXT.fetch_add(1, Ordering::Relaxed));
    let cancel = Arc::new(AtomicBool::new(false));
    jobs.insert(id.get(), Arc::clone(&cancel));
    Ok(JobHandle { id, cancel })
}

/// Asks job `id` to stop after the page it is on; pages that are done stay applied. An unknown or finished job is not an error.
pub fn cancel(id: OcrJobId) {
    if let Some(flag) = registry().get(&id.get()) {
        flag.store(true, Ordering::Release);
    }
}

// --- Classification --------------------------------------------------------------------------------------------------

/// The class of the pages at `indices` of the PDF `bytes` (index in that file); a page in `layered` (a layer of this session) is a
/// `SheerLayer`. Phase 0 heuristic: images over half the page are a `Scan`, anything else is `Text`; the engine's probe replaces it.
pub fn classify(
    bytes: &[u8],
    pages: &[(PageId, u32)],
    layered: &BTreeSet<u32>,
) -> Result<Vec<(PageId, PageOcrClass)>, AppError> {
    let doc = ProbeDoc::load(bytes)?;
    Ok(pages
        .iter()
        .map(|(page, index)| {
            let class = if layered.contains(&page.get()) {
                PageOcrClass::SheerLayer
            } else if *index < doc.page_count() && doc.cover(*index).fraction >= SCAN_COVER {
                PageOcrClass::Scan
            } else {
                PageOcrClass::Text
            };
            (*page, class)
        })
        .collect())
}

/// What `run_job` does with a page of `class`: scans always, a page with a layer of the session only for a redo.
pub fn wants(class: PageOcrClass, redo: bool) -> bool {
    matches!(class, PageOcrClass::Scan) || (redo && matches!(class, PageOcrClass::SheerLayer))
}

// --- The job -----------------------------------------------------------------------------------------------------------

/// What one job is asked to do.
#[derive(Debug, Clone)]
pub struct JobSpec {
    pub doc: DocumentId,
    pub job: OcrJobId,
    pub pages: Vec<PageId>,
    pub lang: String,
    pub redo: bool,
}

/// How a job ended, as `ocrFinished` reports it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Outcome {
    pub applied: u32,
    pub skipped: u32,
    pub failed: u32,
}

struct PageFacts {
    id: PageId,
    position: u32,
    engine_index: u32,
    /// Size in points as displayed (after the rotation).
    shown: [f32; 2],
}

fn count(n: usize) -> u32 {
    u32::try_from(n).unwrap_or(u32::MAX)
}

/// Runs the job on the calling thread (blocking; give it a thread of its own): classifies the pages, recognizes the wanted ones in turn
/// (`ocrProgress` after each), applies the layers that worked as one undo step and sends `ocrFinished`. A set `cancel` ends it after the
/// page in hand. A page that fails counts as failed and does not stop the job; a job that cannot start counts all its pages as failed.
pub fn run_job(app: &AppState, events: &AppEvents, spec: &JobSpec, cancel: &AtomicBool) -> Outcome {
    let total = count(spec.pages.len());
    let mut outcome = Outcome::default();
    let layers = match recognize_all(app, events, spec, cancel, &mut outcome) {
        Ok(layers) => layers,
        Err(_) => {
            outcome.failed = total.saturating_sub(outcome.skipped);
            Vec::new()
        }
    };
    if !layers.is_empty() {
        let n = count(layers.len());
        match app.apply_command(spec.doc, DocCommand::ApplyOcr { layers }) {
            Ok(_) => outcome.applied = n,
            Err(_) => outcome.failed += n,
        }
    }
    events.publish(AppEvent::OcrFinished {
        doc: spec.doc,
        job: spec.job,
        applied: outcome.applied,
        skipped: outcome.skipped,
        failed: outcome.failed,
    });
    outcome
}

fn recognize_all(
    app: &AppState,
    events: &AppEvents,
    spec: &JobSpec,
    cancel: &AtomicBool,
    outcome: &mut Outcome,
) -> Result<Vec<(PageId, Arc<OcrPageLayer>)>, AppError> {
    let wanted: Vec<PageId> = spec.pages.clone();
    let (facts, layered) = app.model(spec.doc, |state| {
        let facts = wanted
            .iter()
            .filter_map(|id| {
                let slot = state.slot(*id)?;
                let [w, h] = slot.size;
                let shown = if slot.rotation % 180 == 90 {
                    [h, w]
                } else {
                    [w, h]
                };
                Some(PageFacts {
                    id: *id,
                    position: state.position(*id)?,
                    engine_index: slot.engine_index,
                    shown,
                })
            })
            .collect::<Vec<_>>();
        Ok((
            facts,
            state.ocr_layers.keys().copied().collect::<BTreeSet<u32>>(),
        ))
    })?;
    let bytes = app.snapshot_bytes(spec.doc)?;
    let probe: Vec<(PageId, u32)> = facts.iter().map(|f| (f.id, f.position)).collect();
    let classes = on_big_stack(move || classify(&bytes, &probe, &layered))?;
    let take: Vec<&PageFacts> = facts
        .iter()
        .filter(|f| {
            classes
                .iter()
                .any(|(id, class)| *id == f.id && wants(*class, spec.redo))
        })
        .collect();
    outcome.skipped = count(spec.pages.len() - take.len());
    let total = count(take.len());
    let snapshot = SnapshotGuard::current(app, spec.doc)?;
    let mut client = ChildClient::new(
        std::env::current_exe().map_err(|e| AppError::logged(ErrorCode::Internal, e))?,
    );
    let mut layers = Vec::new();
    let mut failed = 0u32;
    for (done, page) in take.iter().enumerate() {
        if cancel.load(Ordering::Acquire) {
            break;
        }
        match recognize_page(
            app,
            snapshot.snapshot().engine,
            page,
            &spec.lang,
            &mut client,
        ) {
            Ok(layer) => layers.push((page.id, Arc::new(layer))),
            Err(_) => failed += 1,
        }
        events.publish(AppEvent::OcrProgress {
            doc: spec.doc,
            job: spec.job,
            done: count(done + 1),
            total,
            failed,
        });
    }
    outcome.failed = failed;
    Ok(layers)
}

fn recognize_page(
    app: &AppState,
    doc: EngineDocRef,
    page: &PageFacts,
    lang: &str,
    client: &mut ChildClient,
) -> Result<OcrPageLayer, AppError> {
    let [w, h] = page.shown;
    let side = w.max(h).max(1.0);
    let by_side = limits::MAX_SIDE_PX as f32 * 72.0 / side;
    let by_pixels = (limits::MAX_PIXELS as f32 / (w.max(1.0) * h.max(1.0))).sqrt() * 72.0;
    let dpi = TARGET_DPI.min(by_side * 0.98).min(by_pixels * 0.98);
    let engine_index = match doc {
        EngineDocRef::Live(_) => page.engine_index,
        EngineDocRef::Snapshot(_) => page.position,
    };
    let raster = app
        .engine()
        .render_export(doc, engine_index, dpi, false, 0)?;
    let gray = match raster.pixels {
        RasterPixels::Gray8(gray) => gray,
        RasterPixels::Rgb8(rgb) => rgb
            .as_chunks::<3>()
            .0
            .iter()
            .map(|p| {
                ((u32::from(p[0]) * 77 + u32::from(p[1]) * 150 + u32::from(p[2]) * 29) >> 8) as u8
            })
            .collect(),
    };
    let mut layer = client
        .recognize(
            &gray,
            raster.width,
            raster.height,
            lang,
            backend::page_timeout(),
        )
        .map_err(|e| AppError::logged(ErrorCode::Internal, e))?;
    // Pixels to points of the displayed page.
    let (sx, sy) = (
        w / raster.width.max(1) as f32,
        h / raster.height.max(1) as f32,
    );
    for word in layer
        .lines
        .iter_mut()
        .flat_map(|line| line.words.iter_mut())
    {
        let [x0, y0, x1, y1] = word.rect;
        word.rect = [x0 * sx, y0 * sy, x1 * sx, y1 * sy];
    }
    layer.dpi = dpi;
    Ok(layer)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ocr::backend::{BackendKind, OcrLanguage};
    use crate::pdfwrite::ocr_probe::{image_only_pdf, ScanPage};

    fn caps(de: bool, en: bool) -> Capabilities {
        Capabilities {
            backend: BackendKind::Windows,
            languages: vec![
                OcrLanguage {
                    tag: "de-DE",
                    available: de,
                },
                OcrLanguage {
                    tag: "en-US",
                    available: en,
                },
            ],
            max_image_dimension: Some(8000),
        }
    }

    #[test]
    fn the_requested_language_wins_then_the_other_then_none() {
        assert_eq!(
            plan_language(&caps(true, true), "en-US"),
            Some(("en-US", false))
        );
        assert_eq!(
            plan_language(&caps(true, false), "en-US"),
            Some(("de-DE", true))
        );
        assert_eq!(
            plan_language(&caps(false, true), "fr-FR"),
            Some(("en-US", true))
        );
        assert_eq!(plan_language(&caps(false, false), "de-DE"), None);
        assert_eq!(plan_language(&Capabilities::none(), "de-DE"), None);
    }

    #[test]
    fn one_job_runs_at_a_time_and_a_cancel_reaches_it() {
        // One test body: the registry is global.
        let first = begin().unwrap();
        assert_eq!(
            begin().err().map(|e| e.code()),
            Some(ErrorCode::LimitExceeded)
        );
        assert!(!first.cancel.load(Ordering::Acquire));
        cancel(first.id);
        assert!(first.cancel.load(Ordering::Acquire));
        cancel(OcrJobId::new(u32::MAX));
        let id = first.id;
        drop(first);
        cancel(id);
        assert!(begin().is_ok());
    }

    #[test]
    fn a_scan_is_a_scan_and_a_layered_page_is_not() {
        let page = ScanPage {
            size_pt: [72.0, 96.0],
            px: [300, 400],
            gray: vec![255; 300 * 400],
        };
        let bytes = image_only_pdf(&[page]).unwrap();
        let (a, b) = (PageId::new(0), PageId::new(1));
        let mut layered = BTreeSet::new();
        let got = classify(&bytes, &[(a, 0), (b, 5)], &layered).unwrap();
        assert_eq!(got, vec![(a, PageOcrClass::Scan), (b, PageOcrClass::Text)]);
        layered.insert(0);
        let got = classify(&bytes, &[(a, 0)], &layered).unwrap();
        assert_eq!(got, vec![(a, PageOcrClass::SheerLayer)]);
        assert!(wants(PageOcrClass::Scan, false));
        assert!(!wants(PageOcrClass::SheerLayer, false));
        assert!(wants(PageOcrClass::SheerLayer, true));
        assert!(!wants(PageOcrClass::Text, true));
    }
}
