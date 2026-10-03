//! New-file jobs (ADR-036 §6, ARCHITECTURE §5 "Pages"): extract, split, merge and compress.
//!
//! | Command | Arguments | Returns |
//! |---|---|---|
//! | `extract_pages` | `docId`, `pages: PageId[]`, `onEvent` | `JobId`, or `null` if the Save As dialog was cancelled |
//! | `split_document` | `docId`, `plan: { type: everyN, n } \| { type: before, pages } \| { type: ranges, text }`, `onEvent` | `JobId`, or `null` (folder dialog cancelled) |
//! | `merge_documents` | `inputs: ({ type: document, docId } \| { type: source, sourceId })[]`, `onEvent` | `JobId`, or `null` |
//! | `compress_document` | `docId`, `preset`, `saveAs?` (accepted, not needed: the original is never replaced), `onEvent` | `JobId`, or `null` |
//! | `estimate_compression` | `docId` | `{ current, presets: { lossless, print, ebook, screen } }` in bytes, from a sample |
//! | `cancel_job` | `jobId` | nothing; an unknown or finished job is not an error |
//!
//! Paths come from native dialogs in Rust, go through `intake::admit_target` and never reach the webview. A job runs on a thread of its
//! own (big stack, `catch_unwind`, at most two at once, ten minutes) and reports on the channel the UI passes: `progress`, then exactly
//! one of `done`, `cancelled` or `failed`. The inputs are the model as it is now (annotations that are not saved yet included, through
//! the save builder), the output is a new file that never replaces an open document. Nothing is written for a cancelled or failed job
//! (split removes the files it already made). Extract, merge and compress open their result as a document; compress that does not make
//! the file smaller opens nothing and writes nothing (`done` with `outputs: 0`).

use std::collections::HashSet;
use std::fs::OpenOptions;
use std::io::Write;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, OnceLock, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

use super::save::{fingerprint_changed, plan_with_origins, read_all};
use super::{blocking, AppState};
use crate::documents::intake;
use crate::documents::sources::SourceBytes;
use crate::documents::{DocumentId, DocumentInfo, PageId};
use crate::error::{AppError, ErrorCode, UiError};
use crate::limits;
use crate::model::annotation::PdfOrigin;
use crate::model::page::{PageSource, SourceId};
use crate::pdfwrite::compress::{self, Preset};
use crate::pdfwrite::flatten::{self, FlattenOptions};
use crate::pdfwrite::forms;
use crate::pdfwrite::produce::{self, Control, PageKind, PageSel, Parsed, Part, Phase, Warning};
use crate::pdfwrite::{append_annotations, Plan};
use crate::storage::atomic;

// --- Wire types ---------------------------------------------------------------------------------------------------

/// A job, by the number the backend gave. Serialized as a plain number.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct JobId(u32);

impl JobId {
    pub const fn get(self) -> u32 {
        self.0
    }
}

/// One message of a job. `failed` carries the flat error (`code`, `key`, `retryable`, `params`) next to `type`.
#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum JobEvent {
    Progress {
        phase: Phase,
        done: u32,
        total: u32,
    },
    Done {
        /// Files written (compress: 0 when the result was not smaller and nothing was written).
        outputs: u32,
        bytes_before: u64,
        bytes_after: u64,
        warnings: Vec<Warning>,
        opened: Option<DocumentInfo>,
    },
    Cancelled,
    Failed(UiError),
}

/// Where a job sends its messages: the channel of the webview, or a collector in a test.
pub trait EventSink: Send + Sync {
    fn send(&self, event: JobEvent);
}

impl EventSink for Channel<JobEvent> {
    fn send(&self, event: JobEvent) {
        // The window may be gone; the job goes on and ends quietly.
        let _ = Channel::send(self, event);
    }
}

/// How to cut a document into files.
#[derive(Debug, Clone, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum SplitPlan {
    /// Runs of `n` pages (1 to 10 000); the last may be shorter.
    EveryN {
        n: u32,
        #[serde(default)]
        pattern: Option<String>,
    },
    /// A new file starts at each of these pages.
    Before {
        pages: Vec<PageId>,
        #[serde(default)]
        pattern: Option<String>,
    },
    /// One file per range of "1-3, 5, 8-".
    Ranges {
        text: String,
        #[serde(default)]
        pattern: Option<String>,
    },
}

/// An input of a merge.
#[derive(Debug, Clone, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum MergeInput {
    Document { doc_id: DocumentId },
    Source { source_id: SourceId },
}

/// Sizes in bytes: the file now and as each preset would make it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompressEstimate {
    pub current: u64,
    pub presets: PresetSizes,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PresetSizes {
    pub lossless: u64,
    pub print: u64,
    pub ebook: u64,
    pub screen: u64,
}

// --- Running jobs -------------------------------------------------------------------------------------------------

/// What a finished job reports.
#[derive(Debug)]
pub struct JobDone {
    pub outputs: u32,
    pub bytes_before: u64,
    pub bytes_after: u64,
    pub warnings: Vec<Warning>,
    pub opened: Option<DocumentInfo>,
}

/// The running jobs of the app.
#[derive(Debug, Default)]
pub struct JobRegistry {
    next: AtomicU32,
    active: Mutex<std::collections::BTreeMap<u32, Arc<AtomicBool>>>,
}

/// Holds the job's place until dropped.
struct Slot {
    registry: Arc<JobRegistry>,
    id: u32,
}

impl Drop for Slot {
    fn drop(&mut self) {
        self.registry
            .active
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&self.id);
    }
}

/// What a job is told and tells: cancelled? past the deadline? progress, no more often than every 100 ms (the end of a phase always).
pub struct JobCtx {
    cancel: Arc<AtomicBool>,
    deadline: Instant,
    sink: Arc<dyn EventSink>,
    last: std::cell::Cell<Option<(Phase, Instant)>>,
}

impl JobCtx {
    fn new(cancel: Arc<AtomicBool>, deadline: Instant, sink: Arc<dyn EventSink>) -> Self {
        Self {
            cancel,
            deadline,
            sink,
            last: std::cell::Cell::new(None),
        }
    }
}

impl Control for JobCtx {
    fn check(&self) -> Result<(), AppError> {
        if self.cancel.load(Ordering::Relaxed) {
            return Err(AppError::new(ErrorCode::Cancelled));
        }
        if Instant::now() >= self.deadline {
            return Err(AppError::logged(
                ErrorCode::EngineTimeout,
                "a job took too long",
            ));
        }
        Ok(())
    }

    fn progress(&self, phase: Phase, done: u32, total: u32) {
        let now = Instant::now();
        let quiet = matches!(self.last.get(), Some((last_phase, at))
            if last_phase == phase && now.duration_since(at) < limits::JOB_PROGRESS_INTERVAL);
        if quiet && done < total {
            return;
        }
        self.last.set(Some((phase, now)));
        self.sink.send(JobEvent::Progress { phase, done, total });
    }
}

/// A control that forwards the stop signal but not the progress (a split reports files, not the pages inside one).
struct Quiet<'a>(&'a JobCtx);

impl Control for Quiet<'_> {
    fn check(&self) -> Result<(), AppError> {
        self.0.check()
    }
    fn progress(&self, _phase: Phase, _done: u32, _total: u32) {}
}

impl JobRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Starts `work` on a thread of its own and returns its id; the outcome is the last message to `sink`. At most two jobs run at once
    /// (`limit_exceeded`, `jobs`).
    pub fn start<F>(self: &Arc<Self>, sink: Arc<dyn EventSink>, work: F) -> Result<JobId, AppError>
    where
        F: FnOnce(&JobCtx) -> Result<JobDone, AppError> + Send + 'static,
    {
        self.start_with(sink, limits::JOB_TIMEOUT, work)
    }

    fn start_with<F>(
        self: &Arc<Self>,
        sink: Arc<dyn EventSink>,
        timeout: Duration,
        work: F,
    ) -> Result<JobId, AppError>
    where
        F: FnOnce(&JobCtx) -> Result<JobDone, AppError> + Send + 'static,
    {
        let cancel = Arc::new(AtomicBool::new(false));
        let id = {
            let mut active = self.active.lock().unwrap_or_else(PoisonError::into_inner);
            if active.len() >= limits::MAX_JOBS {
                return Err(AppError::limit("jobs", limits::MAX_JOBS as u64));
            }
            let id = self.next.fetch_add(1, Ordering::Relaxed).wrapping_add(1);
            active.insert(id, cancel.clone());
            id
        };
        let slot = Slot {
            registry: self.clone(),
            id,
        };
        let spawned = thread::Builder::new()
            .name("sheer-job".into())
            .stack_size(limits::JOB_STACK_BYTES)
            .spawn(move || {
                let ctx = JobCtx::new(cancel, Instant::now() + timeout, sink.clone());
                let result = catch_unwind(AssertUnwindSafe(|| work(&ctx))).unwrap_or_else(|_| {
                    Err(AppError::logged(ErrorCode::Internal, "a job panicked"))
                });
                let event = match result {
                    Ok(done) => JobEvent::Done {
                        outputs: done.outputs,
                        bytes_before: done.bytes_before,
                        bytes_after: done.bytes_after,
                        warnings: done.warnings,
                        opened: done.opened,
                    },
                    Err(error) if error.code() == ErrorCode::Cancelled => JobEvent::Cancelled,
                    Err(error) => JobEvent::Failed(UiError::from(error)),
                };
                // The place is free before the UI hears that the job is over, so it may start the next one at once.
                drop(slot);
                sink.send(event);
            });
        match spawned {
            Ok(_) => Ok(JobId(id)),
            Err(error) => {
                self.active
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .remove(&id);
                Err(AppError::logged(ErrorCode::Internal, error))
            }
        }
    }

    /// Asks job `id` to stop. An unknown or finished job is not an error.
    pub fn cancel(&self, id: JobId) {
        if let Some(flag) = self
            .active
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(&id.0)
        {
            flag.store(true, Ordering::Relaxed);
        }
    }

    /// Jobs that are running now.
    pub fn running(&self) -> usize {
        self.active
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .len()
    }
}

/// The jobs of the app.
pub fn jobs() -> &'static Arc<JobRegistry> {
    static JOBS: OnceLock<Arc<JobRegistry>> = OnceLock::new();
    JOBS.get_or_init(|| Arc::new(JobRegistry::new()))
}

// --- Inputs -------------------------------------------------------------------------------------------------------

/// A document as a job needs it, taken from the model when the job is asked for.
#[derive(Clone)]
struct DocInput {
    id: DocumentId,
    name: String,
    source: PathBuf,
    plan: Plan,
    /// The annotations of the pages that are not pages of the file (blank and imported ones), by position in `order`. They are written
    /// into the produced file once its pages are made (`marked`).
    foreign: Plan,
    /// The pages in the order of the model.
    order: Vec<(PageId, PageSel)>,
    /// The files the imported pages come from (`PageKind::Imported { source }` is an index into this).
    sources: Vec<Arc<SourceBytes>>,
    /// The pages differ from the file (see `PagePlan::changed`).
    pages_changed: bool,
    /// The form fields whose value is not the file's, and whether the form is a hybrid one (`forms::write_values`); only a flatten uses them.
    form: Vec<crate::model::form::FormField>,
    strip_xfa: bool,
}

impl DocInput {
    /// `output` with the annotations of the blank and imported pages written into it. `positions` are the positions in the document of
    /// the pages `output` holds, in its order.
    fn marked(
        &self,
        output: produce::Output,
        positions: &[u32],
    ) -> Result<produce::Output, AppError> {
        let plan = produce::plan_for_output(&self.foreign, positions, 0);
        let produce::Output {
            bytes,
            pages,
            warnings,
        } = output;
        Ok(produce::Output {
            bytes: produce::annotate(bytes, &plan, pages)?,
            pages,
            warnings,
        })
    }
}

/// A part of a merge.
struct MergeBytes {
    bytes: Arc<[u8]>,
    name: String,
    order: Vec<PageSel>,
    sources: Vec<Arc<SourceBytes>>,
    /// The annotations of its blank and imported pages (`DocInput::foreign`); empty for a source.
    foreign: Plan,
}

/// Reads the files imported pages come from.
fn load_sources(sources: &[Arc<SourceBytes>]) -> Result<Vec<Parsed>, AppError> {
    sources
        .iter()
        .map(|source| produce::load(&source.bytes))
        .collect()
}

/// One output from `pages` of `parsed` (and of the `sources` it imported from).
fn build_pages(
    parsed: &Parsed,
    sources: &[Parsed],
    pages: &[PageSel],
    control: &dyn Control,
) -> Result<produce::Output, AppError> {
    let part = Part {
        parsed,
        sources: sources.iter().collect(),
        pages: pages.to_vec(),
        title: "",
    };
    produce::build(&[part], false, control)
}

fn write_error(error: std::io::Error) -> AppError {
    let error = AppError::from(error);
    match error.code() {
        ErrorCode::IoInUse
        | ErrorCode::IoPermissionDenied
        | ErrorCode::IoNotFound
        | ErrorCode::IoDiskFull => error,
        _ => AppError::logged(ErrorCode::SaveFailed, error),
    }
}

/// The name part of a file made from a document called `display`: no extension, nothing a file system refuses, not empty.
pub fn file_stem(display: &str) -> String {
    let base = display
        .strip_suffix(".pdf")
        .or_else(|| display.strip_suffix(".PDF"))
        .unwrap_or(display);
    let cleaned: String = base
        .chars()
        .map(|c| {
            if c.is_control() || "<>:\"/\\|?*".contains(c) {
                '_'
            } else {
                c
            }
        })
        .take(limits::MAX_SPLIT_STEM_CHARS)
        .collect();
    let cleaned = cleaned.trim_matches(|c: char| c == '.' || c.is_whitespace());
    if cleaned.is_empty() {
        "document".to_owned()
    } else if is_reserved_device_name(cleaned) {
        format!("_{cleaned}")
    } else {
        cleaned.to_owned()
    }
}

/// Whether Windows treats a file called `name` (with any extension) as a device: CON, PRN, AUX, NUL, COM1-9 and LPT1-9, in any case,
/// judged on the part before the first dot. Such a name is refused on every platform so that a split made on a Mac opens on Windows.
fn is_reserved_device_name(name: &str) -> bool {
    let base = name.split('.').next().unwrap_or_default().trim_end();
    let upper = base.to_ascii_uppercase();
    matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ["COM", "LPT"].iter().any(|prefix| {
            upper
                .strip_prefix(prefix)
                .is_some_and(|digit| matches!(digit.as_bytes(), [b'1'..=b'9']))
        })
}

/// "3-5" or "7" for the page positions (0-based, ascending) of a file of a split.
fn page_label(positions: &[u32]) -> String {
    match (positions.first(), positions.last()) {
        (Some(first), Some(last)) if first != last => format!("{}-{}", first + 1, last + 1),
        (Some(first), _) => (first + 1).to_string(),
        _ => String::new(),
    }
}

/// The file names (without `.pdf`) of a split into `labels.len()` files: `pattern` (default `{name}-{n}`) with `{name}` the document's
/// stem, `{n}` the number of the file (at least two digits) and `{pages}` its pages. The result is a safe file name part: nothing a
/// file system refuses, no directory. A pattern of more than 128 characters is `invalid_argument` (`pattern`).
pub fn split_names(
    pattern: Option<&str>,
    stem: &str,
    labels: &[String],
) -> Result<Vec<String>, AppError> {
    let pattern = pattern
        .filter(|p| !p.trim().is_empty())
        .unwrap_or("{name}-{n}");
    if pattern.chars().count() > 128 {
        return Err(AppError::invalid("pattern"));
    }
    let width = labels.len().to_string().len().max(2);
    Ok(labels
        .iter()
        .enumerate()
        .map(|(at, pages)| {
            let number = format!("{:0width$}", at + 1);
            file_stem(
                &pattern
                    .replace("{name}", stem)
                    .replace("{n}", &number)
                    .replace("{pages}", pages),
            )
        })
        .collect())
}

/// Creates `<stem>.pdf` in `folder`, or `<stem> (2).pdf`, `<stem> (3).pdf` ... if the name is taken: a file is never overwritten, the
/// name is claimed with `create_new`. Returns the open file and its path.
pub fn create_unique(folder: &Path, stem: &str) -> Result<(std::fs::File, PathBuf), AppError> {
    for attempt in 1..=limits::MAX_NAME_ATTEMPTS {
        let name = if attempt == 1 {
            format!("{stem}.pdf")
        } else {
            format!("{stem} ({attempt}).pdf")
        };
        let path = folder.join(name);
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => return Ok((file, path)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(write_error(error)),
        }
    }
    Err(AppError::logged(
        ErrorCode::SaveFailed,
        "no free file name in the folder",
    ))
}

fn write_new(folder: &Path, stem: &str, bytes: &[u8]) -> Result<PathBuf, AppError> {
    let (mut file, path) = create_unique(folder, stem)?;
    let written = file.write_all(bytes).and_then(|()| file.flush());
    drop(file);
    if let Err(error) = written {
        let _ = std::fs::remove_file(&path);
        return Err(write_error(error));
    }
    Ok(path)
}

impl AppState {
    /// The document as a job reads it. Encrypted documents are refused (`unsupported_feature`).
    fn job_input(&self, id: DocumentId) -> Result<DocInput, AppError> {
        let info = self.info(id).ok_or(AppError::not_found("document"))?;
        if info.flags.encrypted {
            return Err(AppError::new(ErrorCode::UnsupportedFeature));
        }
        let source = self
            .registry
            .path(id)
            .ok_or(AppError::not_found("document"))?;
        let count = self.registry.page_count(id)?;
        let (plan, foreign, order, imported, pages_changed, form, strip_xfa) =
            self.annotations.with(id, count, |state| {
                // The annotations of pages of the file are written into the file's bytes first; those of the other pages cannot be (the
                // file has no such page) and are kept apart.
                let layout = state.page_plan();
                let of_file = |page: PageId| {
                    state
                        .slot(page)
                        .filter(|slot| matches!(slot.source, PageSource::File { .. }))
                };
                let plan = plan_with_origins(
                    state,
                    |annotation| of_file(annotation.page_id).map(|slot| slot.engine_index),
                    |origin| {
                        layout
                            .file_position(origin.page_index)
                            .map(|_| origin.clone())
                    },
                );
                let foreign = plan_with_origins(
                    state,
                    |annotation| {
                        state
                            .slot(annotation.page_id)
                            .filter(|slot| !matches!(slot.source, PageSource::File { .. }))
                            .and_then(|_| state.position(annotation.page_id))
                    },
                    |origin| {
                        layout
                            .brought_position(origin.page_index)
                            .filter(|_| origin.name.is_some())
                            .map(|page_index| PdfOrigin {
                                page_index,
                                ..origin.clone()
                            })
                    },
                );
                let mut imported: Vec<SourceId> = Vec::new();
                let mut order = Vec::with_capacity(state.pages().len());
                for slot in state.pages() {
                    let kind = match slot.source {
                        PageSource::File { index } => PageKind::File { index },
                        PageSource::Blank => PageKind::Blank {
                            width: slot.size[0],
                            height: slot.size[1],
                        },
                        PageSource::Imported { source, index } => {
                            let at = imported
                                .iter()
                                .position(|known| *known == source)
                                .unwrap_or_else(|| {
                                    imported.push(source);
                                    imported.len() - 1
                                });
                            PageKind::Imported { source: at, index }
                        }
                    };
                    order.push((
                        slot.id,
                        PageSel {
                            kind,
                            rotation: Some(slot.rotation),
                        },
                    ));
                }
                let pages_changed = state.page_plan().changed();
                // The form values that are not the file's: written into the bytes of a flatten (ADR-041 §4).
                let form: Vec<crate::model::form::FormField> = state
                    .form()
                    .map(|form| form.changed().into_iter().cloned().collect())
                    .unwrap_or_default();
                let strip_xfa = state
                    .form()
                    .is_some_and(|form| form.xfa() == crate::model::form::Xfa::Hybrid);
                Ok((
                    plan,
                    foreign,
                    order,
                    imported,
                    pages_changed,
                    form,
                    strip_xfa,
                ))
            })?;
        // The bytes of the sources pages were taken from: pinned by the document, or still held by the registry.
        let sources = imported
            .iter()
            .map(|&source| {
                self.sources
                    .pinned(id, source)
                    .or_else(|| self.sources.get(source))
                    .ok_or(AppError::not_found("source"))
            })
            .collect::<Result<Vec<_>, _>>()?;
        Ok(DocInput {
            id,
            name: info.display_name,
            source,
            plan,
            foreign,
            order,
            sources,
            pages_changed,
            form,
            strip_xfa,
        })
    }

    /// The bytes of the document as the model has them now: the file as it is on disk, with the annotations that are not saved appended.
    /// A file that changed on disk since it was opened is `needs_confirmation` (the annotations' positions in it are no longer known).
    fn job_bytes(&self, input: &DocInput) -> Result<Vec<u8>, AppError> {
        self.job_bytes_with(input, false)
    }

    /// [`AppState::job_bytes`]; with `values` the unsaved form values are written into the file as well (the appearances of the changed
    /// fields, so that a flatten burns what the user sees).
    fn job_bytes_with(&self, input: &DocInput, values: bool) -> Result<Vec<u8>, AppError> {
        let (original, fingerprint) = read_all(intake::admit(&input.source)?)?;
        if fingerprint_changed(self.registry.fingerprint(input.id), fingerprint) {
            return Err(AppError::needs_confirmation("fileChangedOnDisk"));
        }
        let mut bytes = if input.plan.changes.is_empty() {
            original
        } else {
            append_annotations(original, &input.plan)?.bytes
        };
        if values && !input.form.is_empty() {
            bytes = forms::write_values(bytes, &input.form, input.strip_xfa)?.bytes;
        }
        Ok(bytes)
    }

    /// [`AppState::job_bytes`], and when the pages differ from the file (deleted, moved, rotated, blank or imported ones) the
    /// pages as the model has them, written as a new file.
    fn job_bytes_current(
        &self,
        input: &DocInput,
        control: &dyn Control,
    ) -> Result<Vec<u8>, AppError> {
        self.job_bytes_current_with(input, control, false)
    }

    /// [`AppState::job_bytes_current`] with the unsaved form values (see [`AppState::job_bytes_with`]).
    fn job_bytes_current_with(
        &self,
        input: &DocInput,
        control: &dyn Control,
        values: bool,
    ) -> Result<Vec<u8>, AppError> {
        let bytes = self.job_bytes_with(input, values)?;
        if !input.pages_changed {
            return Ok(bytes);
        }
        let parsed = produce::load(&bytes)?;
        let sources = load_sources(&input.sources)?;
        let all: Vec<PageSel> = input.order.iter().map(|&(_, sel)| sel).collect();
        let everything: Vec<u32> = (0..u32::try_from(all.len()).unwrap_or(0)).collect();
        let output = input.marked(build_pages(&parsed, &sources, &all, control)?, &everything)?;
        Ok(output.bytes)
    }

    /// The page ids as selections in the order of the document. Unique, existing, at least one (`invalid_argument`, `pages`).
    fn select(order: &[(PageId, PageSel)], pages: &[PageId]) -> Result<Vec<PageSel>, AppError> {
        if pages.is_empty() || pages.len() > order.len() {
            return Err(AppError::invalid("pages"));
        }
        let wanted: HashSet<PageId> = pages.iter().copied().collect();
        if wanted.len() != pages.len() {
            return Err(AppError::invalid("pages"));
        }
        let chosen: Vec<PageSel> = order
            .iter()
            .filter(|(id, _)| wanted.contains(id))
            .map(|&(_, selection)| selection)
            .collect();
        if chosen.len() != wanted.len() {
            return Err(AppError::invalid("pages"));
        }
        Ok(chosen)
    }

    /// Whether `target` is the file of an open document.
    fn target_is_open(&self, target: &Path) -> bool {
        self.registry.is_open_path(target)
    }

    /// Writes `bytes` to `target` (which the user chose; the file there is replaced whole or not at all) and opens it as a document.
    fn publish(&self, target: &Path, bytes: &[u8]) -> Result<Option<DocumentInfo>, AppError> {
        // The name is claimed first: whether this job made the file is the answer of `create_new`, not a look at the path that something
        // else may change before the replace.
        let made = match OpenOptions::new().write(true).create_new(true).open(target) {
            Ok(file) => {
                drop(file);
                true
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => false,
            Err(error) => return Err(write_error(error)),
        };
        if let Err(error) = atomic::replace_atomic(target, bytes) {
            if made {
                let _ = std::fs::remove_file(target);
            }
            return Err(write_error(error));
        }
        match self.open_path(target.to_path_buf()) {
            Ok(opened) => Ok(opened),
            Err(error) => {
                // What was written does not load: a file that this job made is taken away again.
                if made {
                    let _ = std::fs::remove_file(target);
                }
                error.log();
                Err(AppError::logged(
                    ErrorCode::SaveFailed,
                    "the new file did not load",
                ))
            }
        }
    }

    /// Extract: the `pages` of document `id` into a new file at `target`, which is then opened. The target is judged by
    /// [`intake::admit_target`]; a file that is open is `io_in_use`.
    pub fn start_extract(
        &self,
        jobs: &Arc<JobRegistry>,
        id: DocumentId,
        pages: &[PageId],
        target: &Path,
        sink: Arc<dyn EventSink>,
    ) -> Result<JobId, AppError> {
        let input = self.job_input(id)?;
        let selection = Self::select(&input.order, pages)?;
        let chosen: HashSet<PageId> = pages.iter().copied().collect();
        let positions: Vec<u32> = (0u32..)
            .zip(&input.order)
            .filter(|(_, (page, _))| chosen.contains(page))
            .map(|(at, _)| at)
            .collect();
        let target = intake::admit_target(target)?;
        if self.target_is_open(&target) {
            return Err(AppError::new(ErrorCode::IoInUse));
        }
        let state = self.clone();
        jobs.start(sink, move |ctx| {
            let bytes = read_phase(ctx, || state.job_bytes(&input))?;
            let before = bytes.len() as u64;
            let parsed = produce::load(&bytes)?;
            let sources = load_sources(&input.sources)?;
            let output = build_pages(&parsed, &sources, &selection, ctx)?;
            let output = input.marked(output, &positions)?;
            ctx.check()?;
            let after = output.bytes.len() as u64;
            let opened = state.publish(&target, &output.bytes)?;
            Ok(JobDone {
                outputs: 1,
                bytes_before: before,
                bytes_after: after,
                warnings: output.warnings,
                opened,
            })
        })
    }

    /// Split: document `id` into several files in `folder`, which the user chose. Names are `<stem>-NN.pdf`, never overwriting
    /// (`<stem>-NN (2).pdf`). The files are not opened. The folder is judged like a Save As target.
    pub fn start_split(
        &self,
        jobs: &Arc<JobRegistry>,
        id: DocumentId,
        plan: &SplitPlan,
        folder: &Path,
        sink: Arc<dyn EventSink>,
    ) -> Result<JobId, AppError> {
        let input = self.job_input(id)?;
        let count = u32::try_from(input.order.len()).map_err(|_| AppError::invalid("pages"))?;
        let groups = match plan {
            SplitPlan::EveryN { n, .. } => produce::groups_every_n(count, *n)?,
            SplitPlan::Before { pages, .. } => {
                let wanted: HashSet<PageId> = pages.iter().copied().collect();
                let cuts: Vec<u32> = input
                    .order
                    .iter()
                    .enumerate()
                    .filter(|(_, (page, _))| wanted.contains(page))
                    .filter_map(|(at, _)| u32::try_from(at).ok())
                    .collect();
                if cuts.len() != wanted.len() {
                    return Err(AppError::invalid("pages"));
                }
                produce::groups_before(count, &cuts)?
            }
            SplitPlan::Ranges { text, .. } => {
                produce::groups_from_ranges(&produce::parse_ranges(text, count)?)
            }
        };
        let pattern = match plan {
            SplitPlan::EveryN { pattern, .. }
            | SplitPlan::Before { pattern, .. }
            | SplitPlan::Ranges { pattern, .. } => pattern.as_deref(),
        };
        let page_labels: Vec<String> = groups.iter().map(|g| page_label(g)).collect();
        let group_positions: Vec<Vec<u32>> = groups.clone();
        let groups: Vec<Vec<PageSel>> = groups
            .into_iter()
            .map(|group| {
                group
                    .into_iter()
                    .filter_map(|at| input.order.get(at as usize).map(|&(_, sel)| sel))
                    .collect()
            })
            .collect();
        let folder = intake::admit_folder(folder)?;
        let stem = file_stem(&input.name);
        let names = split_names(pattern, &stem, &page_labels)?;
        let state = self.clone();
        jobs.start(sink, move |ctx| {
            let bytes = read_phase(ctx, || state.job_bytes(&input))?;
            let before = bytes.len() as u64;
            let parsed = produce::load(&bytes)?;
            drop(bytes);
            let sources = load_sources(&input.sources)?;
            let total = u32::try_from(groups.len()).unwrap_or(u32::MAX);
            let mut created: Vec<PathBuf> = Vec::new();
            let mut warnings: Vec<Warning> = Vec::new();
            let mut after = 0u64;
            let quiet = Quiet(ctx);
            let run = (|| -> Result<(), AppError> {
                for (n, group) in groups.iter().enumerate() {
                    ctx.check()?;
                    let output = build_pages(&parsed, &sources, group, &quiet)?;
                    let output = match group_positions.get(n) {
                        Some(positions) => input.marked(output, positions)?,
                        None => output,
                    };
                    ctx.check()?;
                    let name = names
                        .get(n)
                        .cloned()
                        .unwrap_or_else(|| format!("{stem}-{}", n + 1));
                    created.push(write_new(&folder, &name, &output.bytes)?);
                    after += output.bytes.len() as u64;
                    for warning in output.warnings {
                        if !warnings.contains(&warning) {
                            warnings.push(warning);
                        }
                    }
                    ctx.progress(Phase::Write, u32::try_from(n + 1).unwrap_or(total), total);
                }
                Ok(())
            })();
            if let Err(error) = run {
                for path in &created {
                    let _ = std::fs::remove_file(path);
                }
                return Err(error);
            }
            Ok(JobDone {
                outputs: total,
                bytes_before: before,
                bytes_after: after,
                warnings,
                opened: None,
            })
        })
    }

    /// The bytes of a source the user chose (`pick_pdf_sources`): a PDF held in memory, with its name.
    fn source_part(&self, source: SourceId) -> Result<(Arc<[u8]>, String), AppError> {
        let held = self
            .sources
            .get(source)
            .ok_or(AppError::not_found("source"))?;
        Ok((Arc::clone(&held.bytes), held.display_name.clone()))
    }

    /// Merge: the inputs, in the order given, into a new file at `target`, which is then opened. 2 to 64 inputs; open documents and
    /// sources; at most 50 000 pages and 2 GiB in all.
    pub fn start_merge(
        &self,
        jobs: &Arc<JobRegistry>,
        inputs: &[MergeInput],
        target: &Path,
        sink: Arc<dyn EventSink>,
    ) -> Result<JobId, AppError> {
        if inputs.len() < 2 || inputs.len() > limits::MAX_MERGE_INPUTS {
            return Err(AppError::limit("inputs", limits::MAX_MERGE_INPUTS as u64));
        }
        let target = intake::admit_target(target)?;
        enum Item {
            Document(Box<DocInput>),
            Source(Arc<[u8]>, String),
        }
        // What the merge holds in memory at once: the sources now, each document as it is read (checked against the same total).
        let mut held = 0u64;
        let mut planned: Vec<Item> = Vec::with_capacity(inputs.len());
        for input in inputs {
            match input {
                MergeInput::Document { doc_id } => {
                    planned.push(Item::Document(Box::new(self.job_input(*doc_id)?)));
                }
                MergeInput::Source { source_id } => {
                    let (bytes, name) = self.source_part(*source_id)?;
                    held += bytes.len() as u64;
                    if held > limits::MAX_MERGE_BYTES {
                        return Err(AppError::too_large("file_size", limits::MAX_MERGE_BYTES));
                    }
                    planned.push(Item::Source(bytes, name));
                }
            }
        }
        if self.target_is_open(&target) {
            return Err(AppError::new(ErrorCode::IoInUse));
        }
        let state = self.clone();
        jobs.start(sink, move |ctx| {
            let inputs_total = u32::try_from(planned.len()).unwrap_or(u32::MAX);
            let mut parts: Vec<MergeBytes> = Vec::with_capacity(planned.len());
            let mut total_bytes = held;
            let mut total_pages = 0usize;
            for (n, item) in planned.into_iter().enumerate() {
                ctx.check()?;
                let part = match item {
                    Item::Document(input) => {
                        let bytes = state.job_bytes(&input)?;
                        total_bytes += bytes.len() as u64;
                        if total_bytes > limits::MAX_MERGE_BYTES {
                            return Err(AppError::too_large("file_size", limits::MAX_MERGE_BYTES));
                        }
                        MergeBytes {
                            bytes: Arc::from(bytes),
                            name: input.name.clone(),
                            order: input.order.iter().map(|&(_, sel)| sel).collect(),
                            sources: input.sources.clone(),
                            foreign: input.foreign.clone(),
                        }
                    }
                    Item::Source(bytes, name) => MergeBytes {
                        bytes,
                        name,
                        order: Vec::new(),
                        sources: Vec::new(),
                        foreign: Plan::default(),
                    },
                };
                total_pages += part.order.len();
                parts.push(part);
                ctx.progress(
                    Phase::Read,
                    u32::try_from(n + 1).unwrap_or(u32::MAX),
                    inputs_total,
                );
            }
            if total_pages > limits::MAX_PAGES as usize {
                return Err(AppError::limit("pages", u64::from(limits::MAX_PAGES)));
            }
            let parsed: Vec<Parsed> = parts
                .iter()
                .map(|part| produce::load(&part.bytes))
                .collect::<Result<_, _>>()?;
            let part_sources: Vec<Vec<Parsed>> = parts
                .iter()
                .map(|part| load_sources(&part.sources))
                .collect::<Result<_, _>>()?;
            let merge_parts: Vec<Part<'_>> = parsed
                .iter()
                .zip(parts.iter().zip(&part_sources))
                .map(|(parsed, (part, sources))| Part {
                    parsed,
                    sources: sources.iter().collect(),
                    pages: if part.order.is_empty() {
                        (0..u32::try_from(parsed.pages.len()).unwrap_or(0))
                            .map(PageSel::plain)
                            .collect()
                    } else {
                        part.order.clone()
                    },
                    title: &part.name,
                })
                .collect();
            let mut output = produce::build(&merge_parts, true, ctx)?;
            // Each document's annotations on its blank and imported pages, at the place its pages have in the output. One file at a
            // time: annotation ids are only unique within a document.
            let mut base = 0u32;
            for (part, merged) in parts.iter().zip(&merge_parts) {
                let count = u32::try_from(merged.pages.len()).unwrap_or(0);
                if !part.foreign.changes.is_empty() {
                    let positions: Vec<u32> = (0..count).collect();
                    let plan = produce::plan_for_output(&part.foreign, &positions, base);
                    output.bytes = produce::annotate(output.bytes, &plan, output.pages)?;
                }
                base = base.saturating_add(count);
            }
            ctx.check()?;
            let after = output.bytes.len() as u64;
            let opened = state.publish(&target, &output.bytes)?;
            Ok(JobDone {
                outputs: 1,
                bytes_before: total_bytes,
                bytes_after: after,
                warnings: output.warnings,
                opened,
            })
        })
    }

    /// Compress: document `id` at `preset` into a new file at `target`, which is then opened. A result that is not smaller is not
    /// written: `done` with `outputs: 0`.
    pub fn start_compress(
        &self,
        jobs: &Arc<JobRegistry>,
        id: DocumentId,
        preset: Preset,
        target: &Path,
        sink: Arc<dyn EventSink>,
    ) -> Result<JobId, AppError> {
        let input = self.job_input(id)?;
        let target = intake::admit_target(target)?;
        if self.target_is_open(&target) {
            return Err(AppError::new(ErrorCode::IoInUse));
        }
        let state = self.clone();
        jobs.start(sink, move |ctx| {
            let bytes = read_phase(ctx, || state.job_bytes_current(&input, ctx))?;
            let before = bytes.len() as u64;
            let result = compress::compress(&bytes, preset, ctx)?;
            ctx.check()?;
            let after = result.bytes.len() as u64;
            if after >= before {
                return Ok(JobDone {
                    outputs: 0,
                    bytes_before: before,
                    bytes_after: after,
                    warnings: Vec::new(),
                    opened: None,
                });
            }
            let opened = state.publish(&target, &result.bytes)?;
            Ok(JobDone {
                outputs: 1,
                bytes_before: before,
                bytes_after: after,
                warnings: result.warnings,
                opened,
            })
        })
    }

    /// Flatten: document `id` as the model has it (pages, annotations) with the widgets burned into the page content, into a new file at
    /// `target`, which is then opened (ADR-041 §4). The original is never replaced.
    pub fn start_flatten(
        &self,
        jobs: &Arc<JobRegistry>,
        id: DocumentId,
        options: FlattenOptions,
        target: &Path,
        sink: Arc<dyn EventSink>,
    ) -> Result<JobId, AppError> {
        let input = self.job_input(id)?;
        let target = intake::admit_target(target)?;
        if self.target_is_open(&target) {
            return Err(AppError::new(ErrorCode::IoInUse));
        }
        let state = self.clone();
        jobs.start(sink, move |ctx| {
            let bytes = read_phase(ctx, || state.job_bytes_current_with(&input, ctx, true))?;
            let before = bytes.len() as u64;
            let output = flatten::flatten(&bytes, options.scope, ctx)?;
            ctx.check()?;
            let after = output.bytes.len() as u64;
            let opened = state.publish(&target, &output.bytes)?;
            Ok(JobDone {
                outputs: 1,
                bytes_before: before,
                bytes_after: after,
                warnings: output.warnings,
                opened,
            })
        })
    }

    /// What compressing document `id` would give, from a sample: quick (a second and a half at most), not a promise.
    pub fn estimate_compression(&self, id: DocumentId) -> Result<CompressEstimate, AppError> {
        let input = self.job_input(id)?;
        let bytes = self.job_bytes_current(&input, &produce::Unattended)?;
        let current = bytes.len() as u64;
        let sizes = compress::estimate(&bytes, &Preset::ALL, &produce::Unattended)?;
        let size = |wanted: Preset| {
            sizes
                .iter()
                .find(|(preset, _)| *preset == wanted)
                .map_or(current, |&(_, size)| size.min(current))
        };
        Ok(CompressEstimate {
            current,
            presets: PresetSizes {
                lossless: size(Preset::Lossless),
                print: size(Preset::Print),
                ebook: size(Preset::Ebook),
                screen: size(Preset::Screen),
            },
        })
    }
}

/// Reads the input as the first phase of a job.
fn read_phase<T>(ctx: &JobCtx, read: impl FnOnce() -> Result<T, AppError>) -> Result<T, AppError> {
    ctx.check()?;
    ctx.progress(Phase::Read, 0, 1);
    let value = read()?;
    ctx.progress(Phase::Read, 1, 1);
    Ok(value)
}

// --- Commands -----------------------------------------------------------------------------------------------------

/// The Save As dialog of Rust, for a file called `name`; `None` if the user cancelled.
fn pick_save_path(window: &WebviewWindow, name: &str) -> Result<Option<PathBuf>, AppError> {
    let dialog = window
        .dialog()
        .file()
        .set_parent(window)
        .add_filter("PDF", &["pdf"])
        .set_file_name(name);
    let Some(chosen) = dialog.blocking_save_file() else {
        return Ok(None);
    };
    chosen
        .into_path()
        .map(Some)
        .map_err(|error| AppError::logged(ErrorCode::Internal, error))
}

fn channel_sink(channel: Channel<JobEvent>) -> Arc<dyn EventSink> {
    Arc::new(channel)
}

/// Extracts pages into a new file chosen in Save As, and opens it.
#[tauri::command]
pub async fn extract_pages(
    window: WebviewWindow,
    state: State<'_, AppState>,
    doc_id: DocumentId,
    pages: Vec<PageId>,
    on_event: Channel<JobEvent>,
) -> Result<Option<JobId>, UiError> {
    let state = state.inner().clone();
    blocking(move || {
        let info = state.info(doc_id).ok_or(AppError::not_found("document"))?;
        // Before the dialog: a request that cannot run does not ask for a file name.
        let input = state.job_input(doc_id)?;
        AppState::select(&input.order, &pages)?;
        let name = format!("{}-extract.pdf", file_stem(&info.display_name));
        let Some(path) = pick_save_path(&window, &name)? else {
            return Ok(None);
        };
        state
            .start_extract(jobs(), doc_id, &pages, &path, channel_sink(on_event))
            .map(Some)
    })
    .await
}

/// Splits a document into files in a folder chosen in Rust's dialog.
#[tauri::command]
pub async fn split_document(
    window: WebviewWindow,
    state: State<'_, AppState>,
    doc_id: DocumentId,
    plan: SplitPlan,
    on_event: Channel<JobEvent>,
) -> Result<Option<JobId>, UiError> {
    let state = state.inner().clone();
    blocking(move || {
        state.job_input(doc_id)?;
        let Some(chosen) = window
            .dialog()
            .file()
            .set_parent(&window)
            .blocking_pick_folder()
        else {
            return Ok(None);
        };
        let folder = chosen
            .into_path()
            .map_err(|error| AppError::logged(ErrorCode::Internal, error))?;
        state
            .start_split(jobs(), doc_id, &plan, &folder, channel_sink(on_event))
            .map(Some)
    })
    .await
}

/// Merges documents and sources into a new file chosen in Save As, and opens it.
#[tauri::command]
pub async fn merge_documents(
    window: WebviewWindow,
    state: State<'_, AppState>,
    inputs: Vec<MergeInput>,
    on_event: Channel<JobEvent>,
) -> Result<Option<JobId>, UiError> {
    let state = state.inner().clone();
    blocking(move || {
        if inputs.len() < 2 || inputs.len() > limits::MAX_MERGE_INPUTS {
            return Err(AppError::limit("inputs", limits::MAX_MERGE_INPUTS as u64));
        }
        let Some(path) = pick_save_path(&window, "merged.pdf")? else {
            return Ok(None);
        };
        state
            .start_merge(jobs(), &inputs, &path, channel_sink(on_event))
            .map(Some)
    })
    .await
}

/// Compresses a document into a new file chosen in Save As, and opens it if it is smaller.
#[tauri::command]
pub async fn compress_document(
    window: WebviewWindow,
    state: State<'_, AppState>,
    doc_id: DocumentId,
    preset: Preset,
    save_as: Option<bool>,
    on_event: Channel<JobEvent>,
) -> Result<Option<JobId>, UiError> {
    // The original is never replaced: the result is always a new file, so there is nothing for `saveAs` to switch.
    let _ = save_as;
    let state = state.inner().clone();
    blocking(move || {
        let info = state.info(doc_id).ok_or(AppError::not_found("document"))?;
        state.job_input(doc_id)?;
        let name = format!("{}-compressed.pdf", file_stem(&info.display_name));
        let Some(path) = pick_save_path(&window, &name)? else {
            return Ok(None);
        };
        state
            .start_compress(jobs(), doc_id, preset, &path, channel_sink(on_event))
            .map(Some)
    })
    .await
}

/// Flattens the form (and optionally the annotations) of a document into a new file chosen in Save As, and opens it.
#[tauri::command]
pub async fn flatten_document(
    window: WebviewWindow,
    state: State<'_, AppState>,
    doc_id: DocumentId,
    opts: FlattenOptions,
    on_event: Channel<JobEvent>,
) -> Result<Option<JobId>, UiError> {
    let state = state.inner().clone();
    blocking(move || {
        let info = state.info(doc_id).ok_or(AppError::not_found("document"))?;
        state.job_input(doc_id)?;
        let name = format!("{}-flattened.pdf", file_stem(&info.display_name));
        let Some(path) = pick_save_path(&window, &name)? else {
            return Ok(None);
        };
        state
            .start_flatten(jobs(), doc_id, opts, &path, channel_sink(on_event))
            .map(Some)
    })
    .await
}

/// Estimates the size of the document under each preset.
#[tauri::command]
pub async fn estimate_compression(
    state: State<'_, AppState>,
    doc_id: DocumentId,
) -> Result<CompressEstimate, UiError> {
    let state = state.inner().clone();
    blocking(move || state.estimate_compression(doc_id)).await
}

/// Stops a job. Nothing happens for a job that is unknown or over.
#[tauri::command]
pub async fn cancel_job(job_id: JobId) -> Result<(), UiError> {
    jobs().cancel(job_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    struct Collect(Mutex<mpsc::Sender<JobEvent>>);

    impl EventSink for Collect {
        fn send(&self, event: JobEvent) {
            let _ = self
                .0
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .send(event);
        }
    }

    fn sink() -> (Arc<dyn EventSink>, mpsc::Receiver<JobEvent>) {
        let (sender, receiver) = mpsc::channel();
        (Arc::new(Collect(Mutex::new(sender))), receiver)
    }

    fn last(receiver: &mpsc::Receiver<JobEvent>) -> JobEvent {
        loop {
            match receiver.recv_timeout(Duration::from_secs(10)) {
                Ok(JobEvent::Progress { .. }) => {}
                Ok(event) => return event,
                Err(error) => panic!("no final event: {error}"),
            }
        }
    }

    fn done() -> JobDone {
        JobDone {
            outputs: 1,
            bytes_before: 3,
            bytes_after: 2,
            warnings: vec![Warning::FormsDropped],
            opened: None,
        }
    }

    #[test]
    fn a_job_ends_with_exactly_one_final_message() {
        let registry = Arc::new(JobRegistry::new());
        let (sink, receiver) = sink();
        registry
            .start(sink, |ctx| {
                ctx.progress(Phase::Write, 1, 2);
                ctx.progress(Phase::Write, 2, 2);
                Ok(done())
            })
            .unwrap();
        let event = last(&receiver);
        assert!(matches!(
            event,
            JobEvent::Done {
                outputs: 1,
                bytes_before: 3,
                bytes_after: 2,
                ..
            }
        ));
        assert!(receiver.recv_timeout(Duration::from_millis(100)).is_err());
    }

    #[test]
    fn events_have_the_wire_shape_the_ui_parses() {
        let value = |event: &JobEvent| serde_json::to_value(event).unwrap();
        assert_eq!(
            value(&JobEvent::Progress {
                phase: Phase::Images,
                done: 1,
                total: 4
            }),
            serde_json::json!({"type": "progress", "phase": "images", "done": 1, "total": 4})
        );
        assert_eq!(
            value(&JobEvent::Done {
                outputs: 2,
                bytes_before: 10,
                bytes_after: 5,
                warnings: vec![
                    Warning::SignaturesRemoved,
                    Warning::FormsDropped,
                    Warning::WidgetsDropped
                ],
                opened: None,
            }),
            serde_json::json!({"type": "done", "outputs": 2, "bytesBefore": 10, "bytesAfter": 5,
                "warnings": ["signaturesRemoved", "formsDropped", "widgetsDropped"], "opened": null})
        );
        assert_eq!(
            value(&JobEvent::Cancelled),
            serde_json::json!({"type": "cancelled"})
        );
        let failed = value(&JobEvent::Failed(UiError::from(AppError::logged(
            ErrorCode::SaveFailed,
            r"C:\Users\user\secret.pdf",
        ))));
        assert_eq!(
            failed,
            serde_json::json!({"type": "failed", "code": "save_failed", "key": "error.save_failed", "retryable": true})
        );
    }

    #[test]
    fn plans_and_inputs_parse_from_the_wire() {
        let plan: SplitPlan = serde_json::from_str(r#"{"type":"everyN","n":5}"#).unwrap();
        assert!(matches!(plan, SplitPlan::EveryN { n: 5, .. }));
        let plan: SplitPlan = serde_json::from_str(r#"{"type":"before","pages":[3,7]}"#).unwrap();
        assert!(matches!(plan, SplitPlan::Before { pages, .. } if pages.len() == 2));
        let plan: SplitPlan = serde_json::from_str(r#"{"type":"ranges","text":"1-3"}"#).unwrap();
        assert!(matches!(plan, SplitPlan::Ranges { .. }));
        assert!(
            serde_json::from_str::<SplitPlan>(r#"{"type":"everyN","n":5,"path":"x"}"#).is_err()
        );
        assert!(serde_json::from_str::<SplitPlan>(r#"{"type":"nope"}"#).is_err());
        let input: MergeInput = serde_json::from_str(r#"{"type":"document","docId":4}"#).unwrap();
        assert!(matches!(input, MergeInput::Document { .. }));
        let input: MergeInput = serde_json::from_str(r#"{"type":"source","sourceId":2}"#).unwrap();
        assert!(matches!(input, MergeInput::Source { .. }));
        assert_eq!(
            serde_json::from_str::<Preset>("\"screen\"").unwrap(),
            Preset::Screen
        );
        assert!(serde_json::from_str::<Preset>("\"extreme\"").is_err());
    }

    #[test]
    fn a_failed_job_says_so_without_a_path() {
        let registry = Arc::new(JobRegistry::new());
        let (sink, receiver) = sink();
        registry
            .start(sink, |_| {
                Err(AppError::logged(ErrorCode::IoDiskFull, r"D:\private\x.pdf"))
            })
            .unwrap();
        let event = last(&receiver);
        let text = serde_json::to_string(&event).unwrap();
        assert!(
            text.contains("io_disk_full") && !text.contains("private"),
            "{text}"
        );
    }

    #[test]
    fn a_panic_is_an_internal_failure_and_frees_the_place() {
        let registry = Arc::new(JobRegistry::new());
        let (sink, receiver) = sink();
        registry
            .start(sink, |_| -> Result<JobDone, AppError> {
                panic!("boom at C:/secret")
            })
            .unwrap();
        match last(&receiver) {
            JobEvent::Failed(error) => assert_eq!(error.code(), ErrorCode::Internal),
            other => panic!("{other:?}"),
        }
        assert_eq!(registry.running(), 0);
    }

    #[test]
    fn cancel_stops_a_job_at_its_next_check_and_it_says_cancelled() {
        let registry = Arc::new(JobRegistry::new());
        let (sink, receiver) = sink();
        let (started, wait_started) = mpsc::channel();
        let id = registry
            .start(sink, move |ctx| {
                let _ = started.send(());
                loop {
                    ctx.check()?;
                    thread::sleep(Duration::from_millis(5));
                }
            })
            .unwrap();
        wait_started.recv_timeout(Duration::from_secs(5)).unwrap();
        registry.cancel(id);
        assert!(matches!(last(&receiver), JobEvent::Cancelled));
        // Cancelling it again, or a job that never was, is fine.
        registry.cancel(id);
        registry.cancel(JobId(999));
    }

    #[test]
    fn a_job_past_its_deadline_fails_with_a_timeout() {
        let registry = Arc::new(JobRegistry::new());
        let (sink, receiver) = sink();
        registry
            .start_with(sink, Duration::from_millis(20), |ctx| loop {
                ctx.check()?;
                thread::sleep(Duration::from_millis(5));
            })
            .unwrap();
        match last(&receiver) {
            JobEvent::Failed(error) => assert_eq!(error.code(), ErrorCode::EngineTimeout),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn at_most_two_jobs_run_at_once() {
        let registry = Arc::new(JobRegistry::new());
        let (gate, hold) = mpsc::channel::<()>();
        let hold = Arc::new(Mutex::new(hold));
        let mut receivers = Vec::new();
        for _ in 0..limits::MAX_JOBS {
            let (sink, receiver) = sink();
            receivers.push(receiver);
            let hold = hold.clone();
            registry
                .start(sink, move |_| {
                    let _ = hold.lock().unwrap_or_else(PoisonError::into_inner).recv();
                    Ok(done())
                })
                .unwrap();
        }
        let (full_sink, _) = sink();
        let refused = registry.start(full_sink, |_| Ok(done())).unwrap_err();
        assert_eq!(refused.code(), ErrorCode::LimitExceeded);
        drop(gate);
        for receiver in &receivers {
            last(receiver);
        }
        assert_eq!(registry.running(), 0);
        let (sink, receiver) = sink();
        registry.start(sink, |_| Ok(done())).unwrap();
        last(&receiver);
    }

    #[test]
    fn progress_is_throttled_but_the_end_of_a_phase_always_goes_out() {
        let registry = Arc::new(JobRegistry::new());
        let (sink, receiver) = sink();
        registry
            .start(sink, |ctx| {
                for n in 1..=1000 {
                    ctx.progress(Phase::Write, n, 1000);
                }
                Ok(done())
            })
            .unwrap();
        let mut progress = Vec::new();
        while let JobEvent::Progress { done, .. } =
            receiver.recv_timeout(Duration::from_secs(10)).unwrap()
        {
            progress.push(done);
        }
        assert!(progress.len() < 20, "{} messages", progress.len());
        assert_eq!(progress.last(), Some(&1000));
    }

    #[test]
    fn file_stems_are_safe_names() {
        assert_eq!(file_stem("Report.pdf"), "Report");
        assert_eq!(file_stem("a/b\\c:d*e?.PDF"), "a_b_c_d_e_");
        assert_eq!(file_stem("..."), "document");
        assert_eq!(file_stem(""), "document");
        assert_eq!(file_stem(" x. "), "x");
        assert_eq!(
            file_stem(&"y".repeat(500)).chars().count(),
            limits::MAX_SPLIT_STEM_CHARS
        );
        assert_eq!(file_stem("tab\there"), "tab_here");
    }

    #[test]
    fn windows_device_names_get_a_prefix_on_every_platform() {
        for name in [
            "CON",
            "con",
            "Prn",
            "AUX",
            "nul",
            "COM1",
            "com9",
            "LPT1",
            "lpt9",
            "NUL.txt",
            "con.tar.pdf",
            "CON .pdf",
        ] {
            let stem = file_stem(name);
            assert!(stem.starts_with('_'), "{name} -> {stem}");
        }
        // Not devices: other digits, longer names, the device name inside a longer one.
        for name in [
            "COM0", "COM10", "LPT", "CONSOLE", "my-con", "COM1x", "Report",
        ] {
            assert_eq!(file_stem(name), name);
        }
        // Through the split pattern too.
        let names = split_names(Some("{name}"), "nul", &["1".to_owned()]).unwrap();
        assert_eq!(names, vec!["_nul".to_owned()]);
    }

    #[test]
    fn a_taken_name_gets_a_number_and_nothing_is_overwritten() {
        let folder = std::env::temp_dir().join(format!("sheer-jobs-names-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&folder);
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("a-01.pdf"), b"mine").unwrap();
        let first = write_new(&folder, "a-01", b"new one").unwrap();
        let second = write_new(&folder, "a-01", b"newer").unwrap();
        assert_eq!(first.file_name().unwrap(), "a-01 (2).pdf");
        assert_eq!(second.file_name().unwrap(), "a-01 (3).pdf");
        assert_eq!(std::fs::read(folder.join("a-01.pdf")).unwrap(), b"mine");
        assert_eq!(std::fs::read(&second).unwrap(), b"newer");
        let _ = std::fs::remove_dir_all(&folder);
    }
}

#[cfg(test)]
mod naming_tests {
    use super::*;

    #[test]
    fn names_follow_the_pattern_and_stay_safe() {
        let labels = vec!["1-3".to_owned(), "5".to_owned()];
        assert_eq!(
            split_names(None, "Doc", &labels).unwrap(),
            ["Doc-01", "Doc-02"]
        );
        assert_eq!(
            split_names(Some("{name}_p{pages}"), "Doc", &labels).unwrap(),
            ["Doc_p1-3", "Doc_p5"]
        );
        // A pattern cannot leave the folder.
        let names = split_names(Some("../x/{n}"), "Doc", &labels).unwrap();
        assert!(names
            .iter()
            .all(|n| !n.contains('/') && !n.contains(char::from(92))));
        assert!(split_names(Some(&"a".repeat(129)), "Doc", &labels).is_err());
        assert_eq!(
            split_names(Some("  "), "Doc", &labels).unwrap()[0],
            "Doc-01"
        );
    }
}
