//! `text_edit_probe` and `text_edit_lines`: the lines of existing page text the user may edit (ADR-125, ARCHITECTURE §13.5). The edit itself
//! is `apply_command` with `DocCommand::EditTextLine` ([`AppState::edit_text_line`]).
//!
//! | Command | Arguments | Returns |
//! |---|---|---|
//! | `text_edit_probe` | `docId: number`, `pageId: number`, `unit: number` (UTF-16 index into `TextLayer.text`) | `TextLineInfo`: the line at that character, its box, font and whether (and in which font) it can be edited |
//! | `text_edit_lines` | `docId: number`, `pageId: number` | `{ lines: TextLineInfo[] }`: at most 5 000 lines in reading order, for keyboard navigation |
//!
//! Both take a document id and a page id, never a path. They run on the blocking pool, contained (own big-stack thread, `catch_unwind`,
//! deadline: 5 s for a probe, 30 s for a replay). A line that cannot be edited is `editable: { type: "no", reason }` in the answer (the
//! document-level reasons `signed`, `permission` and `notFileSource` apply to every line); applying an edit to a line that cannot be
//! edited is `unsupported_feature` with `what: "textEdit"` and `params.reason` (a signed or read-only document keeps the `read_only` of the
//! other commands). `invalid_argument` (`page`, `unit`, `lineKey`) for input that does not fit.

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{mpsc, Arc};
use std::thread;
use std::time::{Duration, Instant};

use tauri::State;

use super::annotations::Revert;
use super::{blocking, AppState};
use crate::documents::sources::SourceBytes;
use crate::documents::{DocumentId, PageId};
use crate::error::{AppError, ErrorCode, UiError};
use crate::limits;
use crate::model::doc_state::ChangeSet;
use crate::model::page::PageSource;
use crate::model::protection::Permission;
use crate::model::text_edit::{
    self, ChangeWarning, CharGeom, LineEditable, PageEdits, PageTextLines, Preview, TextEdit,
    TextEditRefusal, TextLineInfo,
};
use crate::pdfsig::types::SignatureLock;
use crate::pdfwrite::ops_walk;
use crate::pdfwrite::text_io::PageDoc;
use crate::pdfwrite::text_lines::{self, Line, PageLines};
use crate::pdfwrite::{text_refuse, text_save};

/// Runs `work` on a thread of its own with the stack lopdf wants: a panic is `internal`, a run past `timeout` is `engine_timeout` (the
/// thread is left to finish by itself, its answer is dropped).
/// Threads of contained runs that have not ended (a run past its deadline keeps its thread until it finishes).
static RUNNING: AtomicUsize = AtomicUsize::new(0);
/// New work is refused while this many are running, so stuck runs cannot pile up threads.
const MAX_RUNNING: usize = 24;

struct Slot;

impl Slot {
    fn take() -> Result<Self, AppError> {
        if RUNNING.fetch_add(1, Ordering::AcqRel) >= MAX_RUNNING {
            RUNNING.fetch_sub(1, Ordering::AcqRel);
            return Err(AppError::limit("textEdits", MAX_RUNNING as u64));
        }
        Ok(Self)
    }
}

impl Drop for Slot {
    fn drop(&mut self) {
        RUNNING.fetch_sub(1, Ordering::AcqRel);
    }
}

fn contained<T: Send + 'static>(
    timeout: Duration,
    work: impl FnOnce() -> Result<T, AppError> + Send + 'static,
) -> Result<T, AppError> {
    let slot = Slot::take()?;
    let (sender, receiver) = mpsc::channel();
    thread::Builder::new()
        .name("sheer-textedit".into())
        .stack_size(limits::SAVE_STACK_BYTES)
        .spawn(move || {
            let _slot = slot;
            // Cooperative cancel: the content walks of this thread stop once the caller has given up.
            ops_walk::set_deadline(Some(Instant::now() + timeout));
            let result = catch_unwind(AssertUnwindSafe(work)).unwrap_or_else(|_| {
                Err(AppError::logged(
                    ErrorCode::Internal,
                    "text editing panicked",
                ))
            });
            let _ = sender.send(result);
        })
        .map_err(|error| AppError::logged(ErrorCode::Internal, error))?;
    receiver
        .recv_timeout(timeout)
        .map_err(|_| AppError::logged(ErrorCode::EngineTimeout, "text editing took too long"))?
}

/// What the lines of a page are read from: the original page, or the preview of the page's edits.
pub(super) struct Basis {
    /// The PDF the lines come from and the index of the page in it.
    pub(super) current: Vec<u8>,
    pub(super) current_page: u32,
    /// The page's index in the file the document was opened from, and whether `current` is that file (no edit yet).
    pub(super) file_index: u32,
    pub(super) from_file: bool,
    /// The page's edits so far; the next edit has `LineKey.rev` of their count.
    pub(super) edits: Vec<TextEdit>,
    pub(super) rev: u32,
    pub(super) engine_index: u32,
    /// A reason that applies to the whole document (`permission`, `signed`, `notFileSource`).
    pub(super) refusal: Option<TextEditRefusal>,
}

impl Basis {
    /// The lines of the page with the refusals stamped in, then `then` on them (all on the contained thread). `chars` are PDFium's
    /// characters of the page.
    fn read<T: Send + 'static>(
        &self,
        chars: Vec<CharGeom>,
        then: impl FnOnce(PageLines, Vec<CharGeom>) -> Result<T, AppError> + Send + 'static,
    ) -> Result<T, AppError> {
        let current = self.current.clone();
        let page = self.current_page;
        let refusal = self.refusal;
        contained(limits::TEXT_EDIT_PROBE_TIMEOUT, move || {
            let doc = PageDoc::load(&current)?;
            // A signed file refuses like the other commands do: `read_only` `signed`, the same at probe and apply.
            if doc.is_signed()? {
                return Err(AppError::read_only("signed"));
            }
            let mut lines = doc.lines(doc.page(page)?, &chars)?;
            doc.refuse(&mut lines, refusal)?;
            then(lines, chars)
        })
    }
}

impl AppState {
    pub(super) fn text_basis(&self, id: DocumentId, page: PageId) -> Result<Basis, AppError> {
        let info = self.info(id).ok_or(AppError::not_found("document"))?;
        let engine_index = self.registry.page_index(id, page)?;
        // Document level refusals are errors at probe and apply alike (ADR-125 §6): `read_only` with `what` `permission` or `signed`.
        if matches!(info.flags.permissions, Some(allowed) if !allowed.contains(Permission::Edit)) {
            return Err(AppError::read_only("permission"));
        }
        if info.signature_lock != SignatureLock::None {
            return Err(AppError::read_only("signed"));
        }
        let (source, kept): (PageSource, Option<PageEdits>) = self.model(id, |state| {
            let slot = state.slot(page).ok_or(AppError::invalid("page"))?;
            Ok((slot.source.clone(), state.text_edits(page).cloned()))
        })?;
        let mut refusal = None;
        let edits = kept
            .as_ref()
            .map(|kept| kept.edits.clone())
            .unwrap_or_default();
        let rev = u32::try_from(edits.len()).unwrap_or(u32::MAX);
        let (current, current_page, file_index, from_file) = match source {
            PageSource::File { index } => (self.plain_original(id)?, index, index, true),
            PageSource::TextEdited { bytes } => {
                let file_index = kept.map(|kept| kept.file_index).ok_or_else(|| {
                    AppError::logged(ErrorCode::Internal, "an edited page has no edits")
                })?;
                (bytes.to_vec(), 0, file_index, false)
            }
            PageSource::Redacted { bytes } => {
                refusal.get_or_insert(TextEditRefusal::NotFileSource);
                (bytes.to_vec(), 0, 0, false)
            }
            PageSource::Blank | PageSource::Imported { .. } => {
                return Err(TextEditRefusal::NotFileSource.error())
            }
        };
        Ok(Basis {
            current,
            current_page,
            file_index,
            from_file,
            edits,
            rev,
            engine_index,
            refusal,
        })
    }

    /// The line at UTF-16 index `unit` of the page's text layer. `invalid_argument` (`page`, `unit`).
    pub fn text_edit_probe(
        &self,
        id: DocumentId,
        page: PageId,
        unit: u32,
    ) -> Result<TextLineInfo, AppError> {
        let _page_index = self.registry.page_index(id, page)?;
        if unit as usize >= limits::MAX_TEXT_CHARS {
            return Err(AppError::invalid("unit"));
        }
        let basis = self.text_basis(id, page)?;
        let chars = self.engine.page_chars(id, basis.engine_index)?;
        let rev = basis.rev;
        basis.read(chars, move |lines, chars| {
            let mut info = text_lines::probe(&lines, &chars, unit)?;
            // Whatever the mapping says, the key is of this revision and a refusal of the line or the document holds.
            info.key.rev = rev;
            if let Some(line) = lines.lines.get(info.key.line as usize) {
                if matches!(line.editable, LineEditable::No { .. }) {
                    info.editable = line.editable;
                }
            }
            Ok(info)
        })
    }

    /// Every line of the page in reading order. `invalid_argument` (`page`).
    pub fn text_edit_lines(&self, id: DocumentId, page: PageId) -> Result<PageTextLines, AppError> {
        let basis = self.text_basis(id, page)?;
        let chars = self.engine.page_chars(id, basis.engine_index)?;
        let rev = basis.rev;
        basis.read(chars, move |lines, _| {
            Ok(PageTextLines {
                lines: lines
                    .lines
                    .iter()
                    .take(limits::TEXT_EDIT_LINES_PER_PAGE)
                    .map(|line| line_info(&lines, line, rev))
                    .collect(),
            })
        })
    }

    /// Replaces the text of one line (`DocCommand::EditTextLine`): replays the page's edits and this one over the file's page, makes the
    /// preview page, hands it to the engine and takes the model step (label `editText.undo`). Text equal to the line's gives no step (the
    /// change set changes nothing). `ChangeSet.warnings` says `fontFallback` and `textOverflow`. `unsupported_feature` (`textEdit`,
    /// `params.reason`) for a line that cannot be edited, `read_only` (`signed`, `permission`) for a document that cannot,
    /// `invalid_argument` (`lineKey`) for a key of another revision.
    pub fn edit_text_line(
        &self,
        id: DocumentId,
        page: PageId,
        edit: TextEdit,
    ) -> Result<ChangeSet, AppError> {
        self.check_permission(id)?;
        let basis = self.text_basis(id, page)?;
        if let Some(reason) = basis.refusal {
            return Err(reason.error());
        }
        if edit.text.chars().count() > limits::TEXT_EDIT_LINE_CHARS {
            return Err(AppError::limit("text", limits::TEXT_EDIT_LINE_CHARS as u64));
        }
        if edit.key.rev != basis.rev {
            return Err(AppError::invalid("lineKey"));
        }
        // The probe cannot know the new text: its script is checked here (the fonts are checked by the replay, which says `fontFallback`).
        if !edit.text.chars().all(text_refuse::script_allowed) {
            return Err(TextEditRefusal::Script.error());
        }
        let chars = self.engine.page_chars(id, basis.engine_index)?;
        // The edits replay over the file's page: with an edited page the file is read again.
        let original = if basis.from_file {
            None
        } else {
            Some(self.plain_original(id)?)
        };
        let file_index = basis.file_index;
        let key = edit.key;
        let text = edit.text.clone();
        let mut all = basis.edits.clone();
        all.push(edit.clone());
        let current = basis.current;
        let current_page = basis.current_page;
        let made = contained(limits::TEXT_EDIT_REPLAY_TIMEOUT, move || {
            let doc = PageDoc::load(&current)?;
            if doc.is_signed()? {
                return Err(AppError::read_only("signed"));
            }
            let mut lines = doc.lines(doc.page(current_page)?, &chars)?;
            doc.refuse(&mut lines, None)?;
            let line = lines
                .lines
                .get(key.line as usize)
                .ok_or(AppError::invalid("lineKey"))?;
            if let LineEditable::No { reason } = line.editable {
                return Err(reason.error());
            }
            if line.text == text {
                return Ok(None);
            }
            let original: &[u8] = original.as_deref().unwrap_or(&current);
            // The replay over the file's page, the one-page PDF and the warnings of it.
            let (preview, mut warnings) = text_save::preview_page(original, file_index, &all)?;
            let mut seen: Vec<ChangeWarning> = Vec::new();
            warnings.retain(|warning| {
                let fresh = !seen.contains(warning);
                seen.push(*warning);
                fresh
            });
            Ok(Some((preview, warnings)))
        })?;
        let Some((preview, warnings)) = made else {
            // Unchanged text is no step.
            return self.model(id, |state| Ok(state.current()));
        };
        let source = Arc::new(SourceBytes {
            bytes: Arc::from(preview),
            page_count: 1,
            display_name: String::new(),
        });
        let appended = self.engine.append_pages(id, source.clone(), vec![0])?;
        let engine_index = appended
            .first()
            .ok_or(AppError::invalid("textEdit"))?
            .engine_index;
        let stepped = self.change_and_sync(id, Revert::Undo, |model, stamp| {
            let command = text_edit::plan(
                model,
                page,
                edit,
                Preview {
                    bytes: source.bytes.clone(),
                    engine_index,
                    file_index,
                },
            )?;
            model.execute(command, stamp)
        });
        match stepped {
            Ok(mut changes) => {
                changes.warnings = warnings;
                Ok(changes)
            }
            Err(error) => {
                let _ =
                    self.engine
                        .truncate_pages(id, engine_index, engine_index.saturating_add(1));
                Err(error)
            }
        }
    }
}

/// The wire shape of `line` in revision `rev`.
fn line_info(lines: &PageLines, line: &Line, rev: u32) -> TextLineInfo {
    text_lines::line_info(lines, line, rev)
}

/// The line of a page at a character of its text layer.
#[tauri::command]
pub async fn text_edit_probe(
    state: State<'_, AppState>,
    doc_id: DocumentId,
    page_id: PageId,
    unit: u32,
) -> Result<TextLineInfo, UiError> {
    let state = state.inner().clone();
    blocking(move || state.text_edit_probe(doc_id, page_id, unit)).await
}

/// All lines of a page, in reading order.
#[tauri::command]
pub async fn text_edit_lines(
    state: State<'_, AppState>,
    doc_id: DocumentId,
    page_id: PageId,
) -> Result<PageTextLines, UiError> {
    let state = state.inner().clone();
    blocking(move || state.text_edit_lines(doc_id, page_id)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::testutil::state_with_pages;

    #[test]
    fn the_input_is_validated_before_anything_is_read() {
        let (state, id) = state_with_pages(2, |_| {});
        let page = state.registry.page_id(id, 0).unwrap();
        let error = state
            .text_edit_probe(id, page, limits::MAX_TEXT_CHARS as u32)
            .unwrap_err();
        assert_eq!(error.code(), ErrorCode::InvalidArgument);
        assert_eq!(
            state
                .text_edit_lines(id, PageId::new(99))
                .unwrap_err()
                .code(),
            ErrorCode::InvalidArgument
        );
    }

    #[test]
    fn a_contained_run_turns_a_panic_and_a_deadline_into_errors() {
        let panicked: Result<(), AppError> =
            contained(Duration::from_secs(5), || -> Result<(), AppError> {
                panic!("boom")
            });
        assert_eq!(panicked.unwrap_err().code(), ErrorCode::Internal);
        let slow: Result<(), AppError> = contained(Duration::from_millis(20), || {
            thread::sleep(Duration::from_millis(500));
            Ok(())
        });
        assert_eq!(slow.unwrap_err().code(), ErrorCode::EngineTimeout);
    }
}
