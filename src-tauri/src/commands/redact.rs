//! True redaction (ARCHITECTURE §5 "Edit and protect", ADR-047 §3). owned by package C.
//!
//! | Command | Arguments | Returns |
//! |---|---|---|
//! | `apply_redactions` | `docId`, `opts: { pages: PageId[] or null, removeMetadata }`, `onEvent: Channel<JobEvent>` | `JobId`. No dialog. `progress` has `phase: "redact"`; `done.changes` is the `ChangeSet` of the one undo step (`redact.apply`); `done.warnings` may hold `unsavedEditsDropped`; a cancel changes nothing |
//!
//! The marks are made with `apply_command` (`markRedactions`, or `createAnnotation` of kind `redactMark`).

use std::sync::Arc;

use tauri::ipc::Channel;
use tauri::State;

use super::annotations::Revert;
use super::jobs::{channel_sink, jobs, EventSink, JobDone, JobEvent, JobId, JobRegistry};
use super::{blocking, AppState};
use crate::documents::sources::SourceBytes;
use crate::documents::DocumentId;
use crate::error::{AppError, UiError};
use crate::limits;
use crate::model::redaction::{self, Raster, RedactOptions};
use crate::pdfwrite::produce::{Control, Phase, Warning};
use crate::pdfwrite::redact::raster_page;

/// Most bytes of raster pages one job holds before the step is made (a page is up to a few megabytes as a JPEG).
const MAX_RASTER_BYTES: u64 = 512 * 1024 * 1024;

impl AppState {
    /// Starts the redaction job of document `id` (see the module documentation): per marked page PDFium draws it, the marks are filled
    /// black in the bitmap, and a one-page PDF of the bitmap is added to the engine's copy; then one model step swaps the slots. Nothing
    /// is changed before every page is drawn, so a cancel or a failure leaves the document as it was.
    pub fn start_redaction(
        &self,
        jobs: &Arc<JobRegistry>,
        id: DocumentId,
        opts: &RedactOptions,
        sink: Arc<dyn EventSink>,
    ) -> Result<JobId, AppError> {
        self.info(id).ok_or(AppError::not_found("document"))?;
        self.check_may_edit(id)?;
        let work = self.model(id, |state| {
            redaction::snapshot(state, opts.pages.as_deref())
        })?;
        let remove_metadata = opts.remove_metadata;
        let state = self.clone();
        jobs.start(sink, move |ctx| {
            let total = u32::try_from(work.len()).unwrap_or(u32::MAX);
            let mut made: Vec<(usize, Vec<u8>)> = Vec::with_capacity(work.len());
            let mut held = 0u64;
            for (position, page) in work.iter().enumerate() {
                ctx.check()?;
                ctx.progress(Phase::Redact, u32::try_from(position).unwrap_or(0), total);
                let bitmap = state.engine.render_for_redaction(
                    id,
                    page.engine_index,
                    limits::REDACT_DPI,
                    page.burn.clone(),
                )?;
                let bytes = raster_page(bitmap, page.size, page.rotation)?;
                held += bytes.len() as u64;
                if held > MAX_RASTER_BYTES {
                    return Err(AppError::limit("redaction", MAX_RASTER_BYTES));
                }
                made.push((position, bytes));
            }
            ctx.check()?;
            // From here on the job changes things: the pages go into the engine's copy, then the model takes them.
            let mut rasters = Vec::with_capacity(made.len());
            let mut first: Option<u32> = None;
            let mut end = 0u32;
            let mut after = 0u64;
            let mut appended = Ok(());
            for (position, bytes) in made {
                let page = &work[position];
                let source = Arc::new(SourceBytes {
                    bytes: Arc::from(bytes),
                    page_count: 1,
                    display_name: String::new(),
                });
                after += source.bytes.len() as u64;
                match state.engine.append_pages(id, source.clone(), vec![0]) {
                    Ok(pages) => {
                        let Some(added) = pages.first() else {
                            appended = Err(AppError::invalid("redaction"));
                            break;
                        };
                        first.get_or_insert(added.engine_index);
                        end = added.engine_index.saturating_add(1);
                        rasters.push(Raster {
                            page_id: page.page_id,
                            rev: page.rev,
                            engine_index: added.engine_index,
                            bytes: source.bytes.clone(),
                        });
                    }
                    Err(error) => {
                        appended = Err(error);
                        break;
                    }
                }
            }
            let take_back = |state: &AppState| {
                if let Some(first) = first {
                    let _ = state.engine.truncate_pages(id, first, end);
                }
            };
            if let Err(error) = appended {
                take_back(&state);
                return Err(error);
            }
            let mut dropped = false;
            let stepped = state.change_and_sync(id, Revert::Undo, |model, stamp| {
                let (command, lost) = redaction::plan(model, &rasters, remove_metadata)?;
                let changes = model.execute(command, stamp)?;
                dropped = lost;
                Ok(changes)
            });
            let changes = match stepped {
                Ok(changes) => changes,
                Err(error) => {
                    take_back(&state);
                    return Err(error);
                }
            };
            Ok(JobDone {
                outputs: 0,
                bytes_before: 0,
                bytes_after: after,
                warnings: if dropped {
                    vec![Warning::UnsavedEditsDropped]
                } else {
                    Vec::new()
                },
                opened: None,
                changes: Some(changes),
            })
        })
    }
}

/// Burns the marked areas into raster pages (a job).
#[tauri::command]
pub async fn apply_redactions(
    state: State<'_, AppState>,
    doc_id: DocumentId,
    opts: RedactOptions,
    on_event: Channel<JobEvent>,
) -> Result<JobId, UiError> {
    let state = state.inner().clone();
    blocking(move || state.start_redaction(jobs(), doc_id, &opts, channel_sink(on_event))).await
}
