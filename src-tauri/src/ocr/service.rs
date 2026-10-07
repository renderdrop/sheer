//! The OCR job (ADR-134, ARCHITECTURE section 15): a registry of the running job, the page classifier and the pipeline. The engine renders
//! page n+1 while the recognizer works on page n (at most two bitmaps in flight); a page that fails is counted and does not stop the
//! job; everything that worked is applied as one `DocCommand::ApplyOcr` (also after a cancel), then `ocrFinished` goes out.

use std::collections::{BTreeSet, HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError};
use std::time::Instant;

use super::backend::{Capabilities, ChildClient, Recognizer};
use super::{limits, OcrJobId, OcrPageLayer, PageOcrClass};
use crate::commands::AppState;
use crate::documents::{DocumentId, PageId};
use crate::error::{AppError, ErrorCode};
use crate::events::{AppEvent, AppEvents};
use crate::export::snapshot::{EngineDocRef, SnapshotGuard};
use crate::model::command::DocCommand;
use crate::pdfwrite::ocr_probe::{ProbeDoc, TextFacts};
use crate::pdfwrite::pagetree::on_big_stack;
use crate::pdfwrite::redact::RasterPixels;

/// The most OCR jobs that run at once (the recognizer child is one process, pages go one after the other).
pub const MAX_JOBS: usize = 1;

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

/// The class of a page (ADR-134 item 5). `layered`: the page has a layer of this session.
pub fn class_of(facts: TextFacts, cover_fraction: f32, layered: bool) -> PageOcrClass {
    if layered || facts.sheer_key {
        PageOcrClass::SheerLayer
    } else if facts.visible >= limits::SCAN_MAX_CHARS {
        PageOcrClass::Text
    } else if facts.invisible > 0 {
        PageOcrClass::HasTextLayer
    } else if cover_fraction >= limits::SCAN_COVER {
        PageOcrClass::Scan
    } else if facts.visible > 0 {
        PageOcrClass::Text
    } else {
        PageOcrClass::Empty
    }
}

/// A page's class and the effective resolution of its main image (0 when unknown).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PageProbe {
    pub page: PageId,
    pub class: PageOcrClass,
    pub image_dpi: f32,
}

/// Probes the pages at `pages` (page id, index in the file of `bytes`); a page in `layered` (a layer of this session, by page id) is a
/// `SheerLayer`.
pub fn probe(
    bytes: &[u8],
    pages: &[(PageId, u32)],
    layered: &BTreeSet<u32>,
) -> Result<Vec<PageProbe>, AppError> {
    let doc = ProbeDoc::load(bytes)?;
    Ok(pages
        .iter()
        .map(|(page, index)| {
            let in_session = layered.contains(&page.get());
            let Some(facts) = doc.text_facts(*index) else {
                let class = if in_session {
                    PageOcrClass::SheerLayer
                } else {
                    PageOcrClass::Empty
                };
                return PageProbe {
                    page: *page,
                    class,
                    image_dpi: 0.0,
                };
            };
            let cover = doc.cover(*index);
            PageProbe {
                page: *page,
                class: class_of(facts, cover.fraction, in_session),
                image_dpi: cover.eff_dpi,
            }
        })
        .collect())
}

/// [`probe`] without the resolutions.
pub fn classify(
    bytes: &[u8],
    pages: &[(PageId, u32)],
    layered: &BTreeSet<u32>,
) -> Result<Vec<(PageId, PageOcrClass)>, AppError> {
    Ok(probe(bytes, pages, layered)?
        .into_iter()
        .map(|p| (p.page, p.class))
        .collect())
}

/// What `run_job` does with a page of `class`: scans always, a page with a layer of ours only for a redo. A page with somebody else's
/// text layer or with real text is never touched.
pub fn wants(class: PageOcrClass, redo: bool) -> bool {
    matches!(class, PageOcrClass::Scan) || (redo && matches!(class, PageOcrClass::SheerLayer))
}

// --- The pipeline ----------------------------------------------------------------------------------------------------------

/// One page to recognize.
#[derive(Debug, Clone)]
pub struct Task {
    pub id: PageId,
    /// Position in the current order (the index in a snapshot).
    pub position: u32,
    /// Index in the engine's live copy.
    pub engine_index: u32,
    /// Size in points as displayed (after the rotation).
    pub shown: [f32; 2],
    /// The resolution to ask for.
    pub dpi: f32,
}

/// A rendered page on its way to the recognizer.
#[derive(Debug, Clone)]
pub struct Bitmap {
    pub gray: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

/// At most [`limits::RESTART_BUDGET`] child restarts per [`limits::RESTART_WINDOW`]; the next one ends the job.
#[derive(Debug, Default)]
pub struct RestartBudget {
    stamps: VecDeque<Instant>,
}

impl RestartBudget {
    /// Notes a restart at `now`; `false` when that is one too many.
    pub fn note(&mut self, now: Instant) -> bool {
        while self
            .stamps
            .front()
            .is_some_and(|at| now.saturating_duration_since(*at) >= limits::RESTART_WINDOW)
        {
            self.stamps.pop_front();
        }
        self.stamps.push_back(now);
        self.stamps.len() <= limits::RESTART_BUDGET
    }
}

/// What a pipeline run produced.
#[derive(Debug, Default)]
pub struct PipelineResult {
    pub layers: Vec<(PageId, OcrPageLayer)>,
    /// Pages that failed (render, recognizer, or not tried after the restart budget ran out).
    pub failed: u32,
    /// Pages that were tried (done or failed); the rest were cancelled.
    pub handled: u32,
}

fn count(n: usize) -> u32 {
    u32::try_from(n).unwrap_or(u32::MAX)
}

/// Scales the pixel boxes of `layer` to the points of the displayed page and notes the dpi actually used.
fn scale_to_points(layer: &mut OcrPageLayer, shown: [f32; 2], bitmap: &Bitmap) {
    let [w, h] = shown;
    let (sx, sy) = (
        w / bitmap.width.max(1) as f32,
        h / bitmap.height.max(1) as f32,
    );
    for word in layer
        .lines
        .iter_mut()
        .flat_map(|line| line.words.iter_mut())
    {
        let [x0, y0, x1, y1] = word.rect;
        word.rect = [x0 * sx, y0 * sy, x1 * sx, y1 * sy];
    }
    layer.dpi = if w > 0.0 {
        bitmap.width as f32 / w * 72.0
    } else {
        0.0
    };
}

/// Renders (on a thread of its own) page n+1 while `recognizer` works on page n: the hand-over is a rendezvous, so at most two bitmaps
/// exist. `progress(done, total, failed)` goes out after every page. A set `cancel` stops after the page in hand; a recognizer that
/// had to be restarted too often (`budget`) ends the run and the pages not tried count as failed.
pub fn run_pipeline(
    tasks: &[Task],
    render: &(dyn Fn(&Task) -> Result<Bitmap, AppError> + Sync),
    recognizer: &mut dyn Recognizer,
    lang: &str,
    cancel: &AtomicBool,
    budget: &mut RestartBudget,
    mut progress: impl FnMut(u32, u32, u32),
) -> PipelineResult {
    let total = count(tasks.len());
    let mut result = PipelineResult::default();
    let mut exhausted = false;
    std::thread::scope(|scope| {
        let (tx, rx) = mpsc::sync_channel::<(usize, Result<Bitmap, AppError>)>(0);
        scope.spawn(move || {
            for (index, task) in tasks.iter().enumerate() {
                if cancel.load(Ordering::Acquire) {
                    return;
                }
                let rendered = render(task);
                // The consumer is gone (cancel, budget): stop.
                if tx.send((index, rendered)).is_err() {
                    return;
                }
            }
        });
        while let Ok((index, rendered)) = rx.recv() {
            if cancel.load(Ordering::Acquire) {
                break;
            }
            let Some(task) = tasks.get(index) else {
                break;
            };
            let outcome = rendered.and_then(|bitmap| {
                recognizer
                    .recognize_page(&bitmap.gray, bitmap.width, bitmap.height, lang)
                    .map(|layer| (layer, bitmap))
                    .map_err(|error| {
                        if error.restarts_child() && !budget.note(Instant::now()) {
                            exhausted = true;
                        }
                        AppError::logged(ErrorCode::Internal, error)
                    })
            });
            match outcome {
                Ok((mut layer, bitmap)) => {
                    scale_to_points(&mut layer, task.shown, &bitmap);
                    result.layers.push((task.id, layer));
                }
                Err(_) => result.failed += 1,
            }
            result.handled += 1;
            progress(result.handled, total, result.failed);
            if exhausted {
                break;
            }
        }
        // `rx` drops here, before the scope joins: a renderer blocked in `send` ends.
    });
    if exhausted {
        let rest = total.saturating_sub(result.handled);
        result.failed += rest;
        result.handled = total;
    }
    result
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
    /// `Some("readOnly")`: the document became signed or read-only while the job ran; its layers were refused, not failed.
    pub refused: Option<&'static str>,
}

/// Books the result of applying `n` layers: applied, refused (a document that went read-only mid-job; the pages count as skipped)
/// or failed.
fn book_apply(result: Result<(), AppError>, n: u32, outcome: &mut Outcome) {
    match result {
        Ok(()) => outcome.applied = n,
        Err(error) if error.code() == ErrorCode::ReadOnly => {
            outcome.refused = Some("readOnly");
            outcome.skipped += n;
        }
        Err(_) => outcome.failed += n,
    }
}

/// Runs the job on the calling thread (blocking; give it a thread of its own): classifies the pages, recognizes the wanted ones
/// (`ocrProgress` after each), applies the layers that worked as one undo step and sends `ocrFinished`. A page that fails counts as
/// failed and does not stop the job; a job that cannot start counts all its pages as failed; after a cancel the finished pages stay.
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
        let applied = app
            .apply_command(spec.doc, DocCommand::ApplyOcr { layers })
            .map(drop);
        book_apply(applied, n, &mut outcome);
    }
    events.publish(AppEvent::OcrFinished {
        doc: spec.doc,
        job: spec.job,
        applied: outcome.applied,
        skipped: outcome.skipped,
        failed: outcome.failed,
        refused: outcome.refused,
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
    let (facts, layered) = app.model(spec.doc, |state| {
        let facts = spec
            .pages
            .iter()
            .filter_map(|id| {
                let slot = state.slot(*id)?;
                let [w, h] = slot.size;
                let shown = if slot.rotation % 180 == 90 {
                    [h, w]
                } else {
                    [w, h]
                };
                Some(Task {
                    id: *id,
                    position: state.position(*id)?,
                    engine_index: slot.engine_index,
                    shown,
                    dpi: limits::TARGET_DPI,
                })
            })
            .collect::<Vec<_>>();
        Ok((
            facts,
            state.ocr_layers.keys().copied().collect::<BTreeSet<u32>>(),
        ))
    })?;
    let bytes = app.snapshot_bytes(spec.doc)?;
    let asked: Vec<(PageId, u32)> = facts.iter().map(|t| (t.id, t.position)).collect();
    let probes = on_big_stack(move || probe(&bytes, &asked, &layered))?;
    let redo = spec.redo;
    let tasks: Vec<Task> = facts
        .into_iter()
        .filter_map(|mut task| {
            let probed = probes.iter().find(|p| p.page == task.id)?;
            wants(probed.class, redo).then(|| {
                task.dpi = limits::render_dpi(probed.image_dpi);
                task
            })
        })
        .collect();
    outcome.skipped = count(spec.pages.len() - tasks.len());
    let total = count(tasks.len());
    if tasks.is_empty() {
        return Ok(Vec::new());
    }
    let snapshot = SnapshotGuard::current(app, spec.doc)?;
    let doc = snapshot.snapshot().engine;
    let mut client = ChildClient::new(
        crate::ocr::backend::recognizer_exe().ok_or(AppError::unsupported("ocrUnavailable"))?,
    );
    let render = |task: &Task| render_task(app, doc, task);
    let result = run_pipeline(
        &tasks,
        &render,
        &mut client,
        &spec.lang,
        cancel,
        &mut RestartBudget::default(),
        |done, total, failed| {
            events.publish(AppEvent::OcrProgress {
                doc: spec.doc,
                job: spec.job,
                done,
                total,
                failed,
            });
        },
    );
    outcome.failed = result.failed;
    // Pages a cancel kept from being tried are skipped.
    outcome.skipped += total.saturating_sub(result.handled);
    Ok(result
        .layers
        .into_iter()
        .map(|(id, layer)| (id, Arc::new(layer)))
        .collect())
}

/// Renders one page through the engine as gray8.
fn render_task(app: &AppState, doc: EngineDocRef, task: &Task) -> Result<Bitmap, AppError> {
    let engine_index = match doc {
        EngineDocRef::Live(_) => task.engine_index,
        EngineDocRef::Snapshot(_) => task.position,
    };
    let raster = app
        .engine()
        .render_for_ocr(doc, engine_index, task.dpi, limits::MAX_SIDE_PX)?;
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
    Ok(Bitmap {
        gray,
        width: raster.width,
        height: raster.height,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ocr::backend::{BackendKind, OcrError, OcrLanguage};
    use crate::ocr::{OcrLine, OcrWord};
    use crate::pdfwrite::ocr_probe::{image_only_pdf, ScanPage};
    use std::sync::atomic::AtomicUsize;
    use std::time::Duration;

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
        assert_eq!(got, vec![(a, PageOcrClass::Scan), (b, PageOcrClass::Empty)]);
        layered.insert(0);
        let got = classify(&bytes, &[(a, 0)], &layered).unwrap();
        assert_eq!(got, vec![(a, PageOcrClass::SheerLayer)]);
    }

    #[test]
    fn the_class_rules() {
        let f = |visible, invisible, sheer_key| TextFacts {
            visible,
            invisible,
            sheer_key,
        };
        use PageOcrClass::*;
        assert_eq!(class_of(f(0, 0, false), 0.9, false), Scan);
        assert_eq!(class_of(f(5, 0, false), 0.9, false), Scan);
        assert_eq!(class_of(f(0, 0, false), 0.59, false), Empty);
        assert_eq!(class_of(f(3, 0, false), 0.1, false), Text);
        assert_eq!(class_of(f(500, 0, false), 0.9, false), Text);
        assert_eq!(class_of(f(0, 300, false), 0.9, false), HasTextLayer);
        assert_eq!(class_of(f(0, 300, true), 0.9, false), SheerLayer);
        assert_eq!(class_of(f(0, 0, false), 0.9, true), SheerLayer);
        assert_eq!(class_of(f(30, 0, true), 0.0, false), SheerLayer);
    }

    #[test]
    fn redo_replaces_our_layers_and_never_touches_text_or_foreign_layers() {
        use PageOcrClass::*;
        for redo in [false, true] {
            assert!(wants(Scan, redo));
            assert!(!wants(Text, redo));
            assert!(!wants(HasTextLayer, redo));
            assert!(!wants(Empty, redo));
        }
        assert!(!wants(SheerLayer, false));
        assert!(wants(SheerLayer, true));
    }

    #[test]
    fn the_ocr_child_is_always_the_apps_own_exe() {
        // Production code of this module and of the commands: the only program a `ChildClient` gets is `current_exe()`; no path comes
        // from a job spec, an argument or the environment.
        for (name, source) in [
            ("service", include_str!("service.rs")),
            ("commands", include_str!("../commands/ocr.rs")),
        ] {
            let production = source.split("#[cfg(test)]").next().unwrap_or(source);
            for call in production.match_indices("ChildClient::new(") {
                let after = &production[call.0..];
                let args = after.split(");").next().unwrap_or(after);
                let own = args.contains("current_exe()") || args.contains("recognizer_exe()");
                assert!(own, "{name}: {args}");
            }
            assert!(!production.contains("PathBuf::from(\""), "{name}");
        }
        if cfg!(windows) {
            // On Windows the recognizer is the app's own exe in child mode.
            let exe = std::env::current_exe().unwrap();
            assert!(exe.is_absolute());
            if let Some(chosen) = super::super::backend::recognizer_exe() {
                assert_eq!(chosen, exe);
            }
        }
    }

    #[test]
    fn a_document_that_went_read_only_mid_job_is_refused_not_failed() {
        let mut outcome = Outcome::default();
        book_apply(Err(AppError::read_only("signed")), 4, &mut outcome);
        assert_eq!(outcome.refused, Some("readOnly"));
        assert_eq!(
            (outcome.applied, outcome.skipped, outcome.failed),
            (0, 4, 0)
        );
        let mut outcome = Outcome::default();
        book_apply(Err(AppError::new(ErrorCode::Internal)), 4, &mut outcome);
        assert_eq!((outcome.refused, outcome.failed), (None, 4));
        let mut outcome = Outcome::default();
        book_apply(Ok(()), 4, &mut outcome);
        assert_eq!((outcome.refused, outcome.applied), (None, 4));
    }

    #[test]
    fn the_restart_budget_is_five_per_ten_minutes() {
        let mut budget = RestartBudget::default();
        let t0 = Instant::now();
        for i in 0..5 {
            assert!(budget.note(t0 + Duration::from_secs(i)), "restart {i}");
        }
        assert!(!budget.note(t0 + Duration::from_secs(5)));
        // Ten minutes after the first ones, room again.
        let mut budget = RestartBudget::default();
        for i in 0..5 {
            assert!(budget.note(t0 + Duration::from_secs(i)));
        }
        assert!(budget.note(t0 + limits::RESTART_WINDOW + Duration::from_secs(10)));
    }

    // --- pipeline with fakes ---

    fn tasks(n: u32) -> Vec<Task> {
        (0..n)
            .map(|i| Task {
                id: PageId::new(i),
                position: i,
                engine_index: i,
                shown: [100.0, 200.0],
                dpi: 72.0,
            })
            .collect()
    }

    fn one_word() -> OcrPageLayer {
        OcrPageLayer {
            lines: vec![OcrLine {
                words: vec![OcrWord {
                    text: "a".into(),
                    rect: [10.0, 20.0, 30.0, 40.0],
                }],
            }],
            ..OcrPageLayer::default()
        }
    }

    /// Answers per page `i` by script; records the order and the peak of bitmaps in flight.
    struct Fake<'a> {
        script: Vec<Result<OcrPageLayer, OcrError>>,
        seen: Vec<u32>,
        in_flight: &'a AtomicUsize,
        cancel_after: Option<(usize, &'a AtomicBool)>,
        delay: Duration,
    }

    impl Recognizer for Fake<'_> {
        fn recognize_page(
            &mut self,
            pixels: &[u8],
            _w: u32,
            _h: u32,
            _lang: &str,
        ) -> Result<OcrPageLayer, OcrError> {
            std::thread::sleep(self.delay);
            // The bitmap's first byte carries the page number.
            self.seen.push(u32::from(pixels[0]));
            let k = self.seen.len() - 1;
            self.in_flight.fetch_sub(1, Ordering::SeqCst);
            if let Some((n, flag)) = self.cancel_after {
                if k + 1 == n {
                    flag.store(true, Ordering::Release);
                }
            }
            self.script
                .get(k)
                .cloned()
                .unwrap_or_else(|| Ok(one_word()))
        }
    }

    fn fake<'a>(
        in_flight: &'a AtomicUsize,
        _peak: &'a AtomicUsize,
        script: Vec<Result<OcrPageLayer, OcrError>>,
    ) -> Fake<'a> {
        Fake {
            script,
            seen: Vec::new(),
            in_flight,
            cancel_after: None,
            delay: Duration::from_millis(5),
        }
    }

    fn renderer<'a>(
        in_flight: &'a AtomicUsize,
        peak: &'a AtomicUsize,
    ) -> impl Fn(&Task) -> Result<Bitmap, AppError> + Sync + 'a {
        move |task| {
            let now = in_flight.fetch_add(1, Ordering::SeqCst) + 1;
            peak.fetch_max(now, Ordering::SeqCst);
            Ok(Bitmap {
                gray: vec![task.id.get() as u8; 100 * 200],
                width: 100,
                height: 200,
            })
        }
    }

    #[test]
    fn pages_come_in_order_with_at_most_two_bitmaps_in_flight_and_progress_per_page() {
        let (in_flight, peak) = (AtomicUsize::new(0), AtomicUsize::new(0));
        let mut rec = fake(&in_flight, &peak, vec![]);
        let render = renderer(&in_flight, &peak);
        let cancel = AtomicBool::new(false);
        let mut seen_progress = Vec::new();
        let result = run_pipeline(
            &tasks(6),
            &render,
            &mut rec,
            "de-DE",
            &cancel,
            &mut RestartBudget::default(),
            |done, total, failed| seen_progress.push((done, total, failed)),
        );
        assert_eq!(rec.seen, vec![0, 1, 2, 3, 4, 5]);
        assert!(peak.load(Ordering::SeqCst) <= 2, "{peak:?}");
        assert_eq!(result.layers.len(), 6);
        assert_eq!((result.failed, result.handled), (0, 6));
        assert_eq!(
            seen_progress,
            (1..=6).map(|d| (d, 6, 0)).collect::<Vec<_>>()
        );
        // Boxes are scaled from pixels (100 x 200) to points (100 x 200 at 72 dpi): one to one; a half-size page halves them.
        let mut half = tasks(1);
        half[0].shown = [50.0, 100.0];
        let mut rec = fake(&in_flight, &peak, vec![]);
        let result = run_pipeline(
            &half,
            &render,
            &mut rec,
            "de-DE",
            &cancel,
            &mut RestartBudget::default(),
            |_, _, _| {},
        );
        assert_eq!(
            result.layers[0].1.lines[0].words[0].rect,
            [5.0, 10.0, 15.0, 20.0]
        );
        assert!((result.layers[0].1.dpi - 144.0).abs() < 0.01);
    }

    #[test]
    fn a_photo_sized_scan_on_a_non_a4_page_is_found_by_the_pending_layer_search() {
        use crate::engine::SearchSpec;
        use crate::ocr::textlayer::{canonical, search_page, Shape};
        // A 2362 x 3337 px photo shown on a 708 x 1000 pt page (240 dpi); the word sits in the lower right quarter.
        let mut layer = OcrPageLayer {
            lines: vec![OcrLine {
                words: vec![OcrWord {
                    text: "Produktivitaet".into(),
                    rect: [1800.0, 2500.0, 2300.0, 2600.0],
                }],
            }],
            ..OcrPageLayer::default()
        };
        let bitmap = Bitmap {
            gray: Vec::new(),
            width: 2362,
            height: 3337,
        };
        let shown = [708.0, 1000.0];
        scale_to_points(&mut layer, shown, &bitmap);
        let [x0, y0, x1, y1] = layer.lines[0].words[0].rect;
        assert!(x0 > 500.0 && x1 < 708.0 && y0 > 700.0 && y1 < 1000.0);
        assert!((layer.dpi - 240.0).abs() < 1.0);
        let shape = Shape {
            size: shown,
            rotation: 0,
        };
        let spec = SearchSpec {
            text: "produktivit".into(),
            match_case: false,
            whole_word: false,
        };
        let hits = search_page(&canonical(&layer, shape), shape, &spec, 5);
        assert_eq!(hits.len(), 1);
    }

    #[test]
    fn a_failed_page_does_not_stop_the_run() {
        let (in_flight, peak) = (AtomicUsize::new(0), AtomicUsize::new(0));
        let script = vec![
            Ok(one_word()),
            Err(OcrError::Timeout),
            Err(OcrError::Failed("x".into())),
            Ok(one_word()),
        ];
        let mut rec = fake(&in_flight, &peak, script);
        let render = renderer(&in_flight, &peak);
        let result = run_pipeline(
            &tasks(4),
            &render,
            &mut rec,
            "de-DE",
            &AtomicBool::new(false),
            &mut RestartBudget::default(),
            |_, _, _| {},
        );
        assert_eq!(result.failed, 2);
        assert_eq!(result.handled, 4);
        let ids: Vec<u32> = result.layers.iter().map(|(id, _)| id.get()).collect();
        assert_eq!(ids, vec![0, 3]);
    }

    #[test]
    fn a_render_error_fails_that_page_only() {
        let (in_flight, peak) = (AtomicUsize::new(0), AtomicUsize::new(0));
        let mut rec = fake(&in_flight, &peak, vec![]);
        let inner = renderer(&in_flight, &peak);
        let render = move |task: &Task| {
            if task.id.get() == 1 {
                Err(AppError::limit("page_too_large", 8000))
            } else {
                inner(task)
            }
        };
        let result = run_pipeline(
            &tasks(3),
            &render,
            &mut rec,
            "de-DE",
            &AtomicBool::new(false),
            &mut RestartBudget::default(),
            |_, _, _| {},
        );
        assert_eq!(
            (result.failed, result.handled, result.layers.len()),
            (1, 3, 2)
        );
    }

    #[test]
    fn too_many_restarts_end_the_run_and_the_rest_counts_as_failed() {
        let (in_flight, peak) = (AtomicUsize::new(0), AtomicUsize::new(0));
        let script = (0..10).map(|_| Err(OcrError::Timeout)).collect();
        let mut rec = fake(&in_flight, &peak, script);
        let render = renderer(&in_flight, &peak);
        let result = run_pipeline(
            &tasks(10),
            &render,
            &mut rec,
            "de-DE",
            &AtomicBool::new(false),
            &mut RestartBudget::default(),
            |_, _, _| {},
        );
        // Five restarts are allowed, the sixth failure stops the job.
        assert_eq!(rec.seen.len(), 6);
        assert_eq!((result.failed, result.handled), (10, 10));
        assert!(result.layers.is_empty());
    }

    #[test]
    fn a_cancel_keeps_the_finished_pages() {
        let (in_flight, peak) = (AtomicUsize::new(0), AtomicUsize::new(0));
        let cancel = AtomicBool::new(false);
        let mut rec = fake(&in_flight, &peak, vec![]);
        rec.cancel_after = Some((3, &cancel));
        let render = renderer(&in_flight, &peak);
        let result = run_pipeline(
            &tasks(8),
            &render,
            &mut rec,
            "de-DE",
            &cancel,
            &mut RestartBudget::default(),
            |_, _, _| {},
        );
        assert_eq!(result.layers.len(), 3);
        assert_eq!(result.handled, 3);
        assert_eq!(result.failed, 0);
    }
}
