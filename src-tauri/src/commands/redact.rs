//! True redaction (ARCHITECTURE §5 "Edit and protect", ADR-047 §3, made surgical by ADR-055). owned by package C.
//!
//! | Command | Arguments | Returns |
//! |---|---|---|
//! | `apply_redactions` | `docId`, `opts: { pages: PageId[] or null, removeMetadata }`, `onEvent: Channel<JobEvent>` | `JobId`. No dialog. `progress` has `phase: "redact"`; `done.changes` is the `ChangeSet` of the one undo step (`redact.apply`); `done.warnings` may hold `unsavedEditsDropped` and `hiddenDataKept` (without `removeMetadata`); a cancel changes nothing |
//!
//! The marks are made with `apply_command` (`markRedactions`, or `createAnnotation` of kind `redactMark`).

use std::collections::HashMap;
use std::sync::Arc;

use tauri::ipc::Channel;
use tauri::State;

use super::annotations::Revert;
use super::jobs::{channel_sink, jobs, EventSink, JobDone, JobEvent, JobId, JobRegistry};
use super::{blocking, AppState};
use crate::documents::intake;
use crate::documents::sources::SourceBytes;
use crate::documents::DocumentId;
use crate::error::{AppError, ErrorCode, UiError};
use crate::model::page::{PageSource, SourceId};
use crate::model::redaction::{self, PageWork, Raster, RedactOptions};
use crate::pdfwrite::produce::{Control, Phase, Warning};
use crate::pdfwrite::redact::{redact_blank, PdfSource};
use crate::pdfwrite::{crypt, pagetree};

/// Most bytes of redacted pages one job holds before the step is made.
const MAX_REDACTED_BYTES: u64 = 512 * 1024 * 1024;

/// The files the pages of one job come from, each parsed once.
#[derive(Default)]
struct Parsed {
    file: Option<PdfSource>,
    imported: HashMap<SourceId, PdfSource>,
}

impl AppState {
    /// The one-page PDF of `page` without what lies under its marks (ADR-055).
    fn redact_one(
        &self,
        id: DocumentId,
        parsed: &mut Parsed,
        page: &PageWork,
    ) -> Result<Vec<u8>, AppError> {
        let burn = page.burn.clone();
        let source = match &page.source {
            PageSource::Blank => return redact_blank(page.size, page.rotation, burn),
            PageSource::Redacted { bytes } | PageSource::TextEdited { bytes } => {
                PdfSource::parse(bytes.to_vec())?
            }
            PageSource::File { .. } => match &parsed.file {
                Some(source) => source.clone(),
                None => {
                    let source = PdfSource::parse(self.plain_original(id)?)?;
                    parsed.file = Some(source.clone());
                    source
                }
            },
            PageSource::Imported { source, .. } => match parsed.imported.get(source) {
                Some(parsed_source) => parsed_source.clone(),
                None => {
                    let bytes: Arc<SourceBytes> =
                        self.sources.pinned(id, *source).ok_or_else(|| {
                            AppError::logged(ErrorCode::SaveFailed, "an import source is gone")
                        })?;
                    let parsed_source = PdfSource::parse(bytes.bytes.to_vec())?;
                    parsed.imported.insert(*source, parsed_source.clone());
                    parsed_source
                }
            },
        };
        let index = match &page.source {
            PageSource::File { index } | PageSource::Imported { index, .. } => *index,
            _ => 0,
        };
        source.redact_page(index, page.shown, page.rotation, burn)
    }

    /// The file the document was opened from as it is on disk, as a plain file (a protected one is decrypted with the session's
    /// password). A file that changed since it was opened is `needs_confirmation`: its pages are not the ones the engine shows.
    pub(super) fn plain_original(&self, id: DocumentId) -> Result<Vec<u8>, AppError> {
        let info = self.info(id).ok_or(AppError::not_found("document"))?;
        let path = self
            .registry
            .path(id)
            .ok_or(AppError::not_found("document"))?;
        let (bytes, fingerprint) = super::save::read_all(intake::admit(&path)?)?;
        if super::save::fingerprint_changed(self.registry.fingerprint(id), fingerprint) {
            return Err(AppError::needs_confirmation("fileChangedOnDisk"));
        }
        if info.flags.encrypted {
            let session = self.session_password(id);
            let (plain, _) = pagetree::on_big_stack(move || {
                crypt::decrypt_for_rewrite(&bytes, session.as_ref().map(|secret| secret.as_str()))
            })?;
            return Ok(plain);
        }
        Ok(bytes)
    }
}

impl AppState {
    /// Starts the redaction job of document `id` (see the module documentation): per marked page its content is read from the file
    /// and written again without what lies under the marks (ADR-055), as a one-page PDF that is added to the engine's copy; then one
    /// model step swaps the slots. Nothing is changed before every page is made, so a cancel or a failure leaves the document as it was.
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
            let mut parsed = Parsed::default();
            for (position, page) in work.iter().enumerate() {
                ctx.check()?;
                ctx.progress(Phase::Redact, u32::try_from(position).unwrap_or(0), total);
                let bytes = state.redact_one(id, &mut parsed, page)?;
                held += bytes.len() as u64;
                if held > MAX_REDACTED_BYTES {
                    return Err(AppError::limit("redaction", MAX_REDACTED_BYTES));
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
                warnings: {
                    let mut warnings = Vec::new();
                    if dropped {
                        warnings.push(Warning::UnsavedEditsDropped);
                    }
                    // Bookmarks, named destinations and the like stay unless the metadata goes too (the save strips them with it).
                    if !remove_metadata {
                        warnings.push(Warning::HiddenDataKept);
                    }
                    warnings
                },
                opened: None,
                changes: Some(changes),
                skipped: 0,
                print: None,
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
