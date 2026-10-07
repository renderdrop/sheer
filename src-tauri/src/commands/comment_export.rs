//! Comment export (ADR-139 section 3 (3), ARCHITECTURE section 16.3, DESIGN 3.16).
//!
//! | Command | Arguments | Returns |
//! |---|---|---|
//! | `export_comments` | `docId`, `opts: CommentExportOptions`, `onEvent: Channel<JobEvent>` | `JobId`, or `null` (the save dialog was cancelled) |
//!
//! The UI sends the filter (types, pages, authors, tags, status), the format, the language and the formatted citation lines; Rust gathers
//! the annotations, reads the quotes from the page text and writes the file the user chose in its own save dialog, atomically. The
//! frontend never gets a path. Phases: `read` (pages) and `write`; `done.outputs` is 1, or 0 with the warning `nothingToExport`; further
//! warnings are `quotesOmitted` (the file forbids copying text) and `glyphsReplaced` (a character the bundled font lacks became `?`).

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use serde::Deserialize;
use tauri::ipc::Channel;
use tauri::{Manager, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

use super::jobs::{channel_sink, file_stem, jobs, EventSink, JobDone, JobEvent, JobId};
use super::{blocking, AppState};
use crate::automation::dialogs::DialogSeam;
use crate::documents::{DocumentId, PageId};
use crate::error::{AppError, ErrorCode, UiError};
use crate::export::citations::admit_target_ext;
use crate::export::comments::{
    self, apply_citation_lines, Filter, Gathered, Head, IncludeKind, Labels, PageInput,
    StatusFilter,
};
use crate::limits;
use crate::model::geometry::Quad;
use crate::model::ids::AnnotId;
use crate::model::protection::Permission;
use crate::model::ranges::{parse_ranges, PageSelection};
use crate::pdfwrite::metadata::PdfDate;
use crate::pdfwrite::produce::{Control, Phase, Warning};
use crate::pdfwrite::summary;
use crate::storage::atomic;

/// The file format of the export.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CommentExportFormat {
    Pdf,
    Markdown,
}

impl CommentExportFormat {
    const fn extension(self) -> &'static str {
        match self {
            Self::Pdf => "pdf",
            Self::Markdown => "md",
        }
    }

    const fn filter_label(self) -> &'static str {
        match self {
            Self::Pdf => "PDF",
            Self::Markdown => "Markdown",
        }
    }
}

/// The citation line the UI formatted (DESIGN 3.17) for the citation `id` (any annotation of a citation group).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CitationLine {
    pub id: AnnotId,
    pub text: String,
}

/// What `export_comments` takes.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommentExportOptions {
    pub format: CommentExportFormat,
    /// At least one.
    pub include: Vec<IncludeKind>,
    pub pages: PageSelection,
    /// `en` or `de`.
    pub lang: String,
    /// Authors to take (`""` = no author); absent = all.
    #[serde(default)]
    pub authors: Option<Vec<String>>,
    /// Tags to take, ignoring case (`""` = untagged); absent = all.
    #[serde(default)]
    pub tags: Option<Vec<String>>,
    #[serde(default)]
    pub status: StatusFilter,
    #[serde(default)]
    pub citation_lines: Vec<CitationLine>,
}

/// Longest author or tag name the filter takes, and most names.
const FILTER_NAME_MAX: usize = 400;
const FILTER_NAMES_MAX: usize = 1_000;

/// The documents with an export under way (one at a time per document).
fn running() -> &'static Mutex<HashSet<DocumentId>> {
    static RUNNING: OnceLock<Mutex<HashSet<DocumentId>>> = OnceLock::new();
    RUNNING.get_or_init(|| Mutex::new(HashSet::new()))
}

/// Holds the place of a document's export until dropped.
struct Running(DocumentId);

impl Running {
    fn take(id: DocumentId) -> Result<Self, AppError> {
        let mut set = running()
            .lock()
            .map_err(|_| AppError::new(ErrorCode::Internal))?;
        if !set.insert(id) {
            return Err(AppError::limit("commentExport", 1));
        }
        Ok(Self(id))
    }
}

impl Drop for Running {
    fn drop(&mut self) {
        if let Ok(mut set) = running().lock() {
            set.remove(&self.0);
        }
    }
}

/// The pages the selection names, in document order, each once. `invalid_argument` (`pageSelection`) for none or an unknown one.
fn select_pages(
    all: &[(PageId, u32)],
    selection: &PageSelection,
) -> Result<Vec<(u32, PageId, u32)>, AppError> {
    let invalid = || AppError::invalid("pageSelection");
    let position_of = |page: &PageId| all.iter().position(|(known, _)| known == page);
    let mut positions: Vec<usize> = match selection {
        PageSelection::All => (0..all.len()).collect(),
        PageSelection::Current { page_id } => vec![position_of(page_id).ok_or_else(invalid)?],
        PageSelection::Pages { pages } => {
            if pages.len() > limits::MAX_EXPORT_PAGES {
                return Err(AppError::limit("pages", limits::MAX_EXPORT_PAGES as u64));
            }
            pages
                .iter()
                .map(|page| position_of(page).ok_or_else(invalid))
                .collect::<Result<_, _>>()?
        }
        PageSelection::Ranges { text } => {
            let count = u32::try_from(all.len()).map_err(|_| invalid())?;
            let ranges = parse_ranges(text, count).map_err(|error| {
                if error.code() == ErrorCode::InvalidArgument {
                    invalid()
                } else {
                    error
                }
            })?;
            ranges
                .into_iter()
                .flat_map(|(start, end)| (start - 1..end).map(|page| page as usize))
                .collect()
        }
    };
    positions.sort_unstable();
    positions.dedup();
    if positions.is_empty() {
        return Err(invalid());
    }
    Ok(positions
        .into_iter()
        .map(|at| {
            (
                u32::try_from(at).unwrap_or(u32::MAX) + 1,
                all[at].0,
                all[at].1,
            )
        })
        .collect())
}

/// What a request comes to once it is checked: the filter, the pages (position, id, engine index) and the labels.
struct Plan {
    filter: Filter,
    pages: Vec<(u32, PageId, u32)>,
    labels: Labels,
    lines: Vec<(AnnotId, String)>,
    format: CommentExportFormat,
}

impl AppState {
    /// Checks the options against document `id`. Nothing is asked of the user before this passes.
    fn plan_comment_export(
        &self,
        id: DocumentId,
        opts: &CommentExportOptions,
    ) -> Result<Plan, AppError> {
        let info = self.info(id).ok_or(AppError::not_found("document"))?;
        if opts.include.is_empty() || opts.include.len() > IncludeKind::ALL.len() {
            return Err(AppError::invalid("include"));
        }
        if opts.lang != "en" && opts.lang != "de" {
            return Err(AppError::invalid("lang"));
        }
        for names in [&opts.authors, &opts.tags].into_iter().flatten() {
            if names.len() > FILTER_NAMES_MAX {
                return Err(AppError::limit("commentExport", FILTER_NAMES_MAX as u64));
            }
            if names.iter().any(|n| n.chars().count() > FILTER_NAME_MAX) {
                return Err(AppError::too_large("commentExport", FILTER_NAME_MAX as u64));
            }
        }
        if opts.citation_lines.len() > limits::CITATIONS_MAX
            || opts
                .citation_lines
                .iter()
                .any(|l| l.text.len() > limits::COMMENT_EXPORT_TEXT_MAX * 4)
        {
            return Err(AppError::too_large(
                "commentExport",
                limits::COMMENT_EXPORT_TEXT_MAX as u64,
            ));
        }
        let order = self.registry.page_order(id)?;
        let pages = select_pages(&order, &opts.pages)?;
        let allow_quotes = info
            .flags
            .permissions
            .is_none_or(|allowed| allowed.contains(Permission::Copy));
        let mut include = opts.include.clone();
        include.sort_by_key(|kind| IncludeKind::ALL.iter().position(|k| k == kind));
        include.dedup();
        Ok(Plan {
            filter: Filter {
                include,
                authors: opts.authors.clone(),
                tags: opts.tags.clone(),
                status: opts.status,
                allow_quotes,
            },
            pages,
            labels: Labels::new(&opts.lang),
            lines: opts
                .citation_lines
                .iter()
                .map(|line| (line.id, line.text.clone()))
                .collect(),
            format: opts.format,
        })
    }

    /// Asks for the target and starts the export of document `id`. `None` when the dialog was cancelled.
    pub fn start_export_comments(
        &self,
        window: &WebviewWindow,
        id: DocumentId,
        opts: &CommentExportOptions,
        sink: Arc<dyn EventSink>,
    ) -> Result<Option<JobId>, AppError> {
        let plan = self.plan_comment_export(id, opts)?;
        let guard = Running::take(id)?;
        let info = self.info(id).ok_or(AppError::not_found("document"))?;
        let name = plan.labels.fill(
            "commentExport.fileName",
            &[("name", &file_stem(&info.display_name))],
        );
        let mut dialog = window
            .dialog()
            .file()
            .set_parent(window)
            .add_filter(plan.format.filter_label(), &[plan.format.extension()])
            .set_file_name(format!("{name}.{}", plan.format.extension()));
        if let Some(folder) = self.source_dir(id) {
            dialog = dialog.set_directory(folder);
        }
        let Some(chosen) = dialog.seam_save_file()? else {
            return Ok(None);
        };
        let path: PathBuf = chosen
            .into_path()
            .map_err(|error| AppError::logged(ErrorCode::Internal, error))?;
        let producer = crate::menu::app_name(window.app_handle());
        self.start_comment_export_job(id, plan, &path, producer, guard, sink)
            .map(Some)
    }

    /// [`AppState::start_export_comments`] with the target chosen: judged like a Save As target, never a document that is open.
    fn start_comment_export_job(
        &self,
        id: DocumentId,
        plan: Plan,
        target: &Path,
        producer: String,
        guard: Running,
        sink: Arc<dyn EventSink>,
    ) -> Result<JobId, AppError> {
        let target = admit_target_ext(target, plan.format.extension())?;
        let source = self
            .registry
            .path(id)
            .ok_or(AppError::not_found("document"))?;
        let same =
            std::fs::canonicalize(&source).map_or(source == target, |source| source == target);
        if same || self.registry.is_open_path(&target) {
            return Err(AppError::invalid("exportTarget"));
        }
        let state = self.clone();
        jobs().start(sink, move |ctx| {
            let _guard = guard;
            state.run_comment_export(id, &plan, &target, &producer, ctx)
        })
    }

    /// The pages of the plan with their annotations, read from the file where the model has not read them yet.
    fn comment_pages(
        &self,
        id: DocumentId,
        plan: &Plan,
        ctx: &dyn Control,
    ) -> Result<Vec<PageInput>, AppError> {
        let labels = self.page_labels(id)?;
        let wanted: Vec<(PageId, u32)> = plan
            .pages
            .iter()
            .map(|(_, page, index)| (*page, *index))
            .collect();
        let unread = self.unread_pages(id, &wanted)?;
        let keys = self.prefetch_keys(id, &unread)?;
        let total = u32::try_from(plan.pages.len()).unwrap_or(u32::MAX);
        let mut out = Vec::with_capacity(plan.pages.len());
        for (done, (position, page, index)) in plan.pages.iter().enumerate() {
            ctx.check()?;
            ctx.progress(Phase::Read, u32::try_from(done).unwrap_or(u32::MAX), total);
            if !self.model(id, |state| Ok(state.is_imported(*page)))? {
                let items = self.engine.import_annotations_background(id, *index)?;
                self.import_read_prefetched(id, *page, *index, items, &keys)?;
            }
            let annotations = self.model(id, |state| Ok(state.list(*page)))?;
            // The label of a page of the file; a blank, imported or redacted page has none (as `list_citations`).
            let from_file = self.model(id, |state| Ok(state.is_file_page(*page)))?;
            let locator = usize::try_from(*index)
                .ok()
                .filter(|_| from_file)
                .and_then(|i| labels.get(i))
                .and_then(|label| label.clone())
                .filter(|label| !label.trim().is_empty())
                .unwrap_or_else(|| position.to_string());
            out.push(PageInput {
                page_id: *page,
                position: *position,
                locator,
                annotations,
            });
        }
        ctx.progress(Phase::Read, total, total);
        Ok(out)
    }

    /// Gathers the items of the plan (the text under a markup is read page by page).
    fn gather_comments(
        &self,
        id: DocumentId,
        plan: &Plan,
        ctx: &dyn Control,
    ) -> Result<Gathered, AppError> {
        let pages = self.comment_pages(id, plan, ctx)?;
        let mut layers: HashMap<PageId, Option<crate::model::reading::TextLayer>> = HashMap::new();
        let mut quotes = |page: PageId, quads: &[Quad]| {
            if ctx.check().is_err() {
                return None;
            }
            let layer = layers
                .entry(page)
                .or_insert_with(|| self.text_layer(id, page).ok());
            layer.as_ref().map(|layer| {
                crate::model::quote::quote_of(
                    &layer.text,
                    &layer.boxes,
                    quads,
                    limits::CITE_QUOTE_MAX,
                )
            })
        };
        let mut gathered = comments::gather(&pages, &plan.filter, &mut quotes)?;
        ctx.check()?;
        apply_citation_lines(&mut gathered.items, &plan.lines);
        Ok(gathered)
    }

    /// The job: gather, build the file, write it.
    fn run_comment_export(
        &self,
        id: DocumentId,
        plan: &Plan,
        target: &Path,
        producer: &str,
        ctx: &dyn Control,
    ) -> Result<JobDone, AppError> {
        ctx.check()?;
        let info = self.info(id).ok_or(AppError::not_found("document"))?;
        let gathered = self.gather_comments(id, plan, ctx)?;
        let mut warnings = Vec::new();
        if gathered.quotes_omitted {
            warnings.push(Warning::QuotesOmitted);
        }
        if gathered.items.is_empty() {
            warnings.push(Warning::NothingToExport);
            return Ok(JobDone {
                warnings,
                ..JobDone::default()
            });
        }
        let record_title = self.model(id, |state| {
            Ok(state
                .bibliography
                .record
                .as_ref()
                .and_then(|record| record.title.clone()))
        })?;
        let name = record_title
            .map(|title| comments::clean_line(&title, 300))
            .filter(|title| !title.is_empty())
            .unwrap_or_else(|| file_stem(&info.display_name));
        let head = self.comment_head(name, plan);
        ctx.progress(Phase::Write, 0, 1);
        let bytes = match plan.format {
            CommentExportFormat::Markdown => {
                comments::to_markdown(&gathered.items, &head, plan.labels)?.into_bytes()
            }
            CommentExportFormat::Pdf => {
                let items = gathered.items.len();
                let built = summary::build(
                    &gathered.items,
                    &head,
                    crate::platform::paper_default(),
                    plan.labels,
                    producer,
                    &mut |done, _| {
                        ctx.check()?;
                        ctx.progress(
                            Phase::Write,
                            u32::try_from(done).unwrap_or(u32::MAX),
                            u32::try_from(items).unwrap_or(u32::MAX).saturating_add(1),
                        );
                        Ok(())
                    },
                )?;
                if built.glyphs_replaced {
                    warnings.push(Warning::GlyphsReplaced);
                }
                built.bytes
            }
        };
        ctx.check()?;
        atomic::write_atomic(target, &bytes).map_err(write_error)?;
        ctx.progress(Phase::Write, 1, 1);
        Ok(JobDone {
            outputs: 1,
            bytes_after: bytes.len() as u64,
            warnings,
            ..JobDone::default()
        })
    }

    fn comment_head(&self, name: String, plan: &Plan) -> Head {
        let now = PdfDate::now();
        let iso = format!(
            "{:04}-{:02}-{:02}T{:02}:{:02}",
            now.year, now.month, now.day, now.hour, now.minute
        );
        let exported = comments::format_date(&iso, plan.labels.locale())
            .map(|date| date.split(',').next().unwrap_or("").to_owned())
            .unwrap_or_default();
        let filtered = (plan.filter.include.len() < IncludeKind::ALL.len()).then(|| {
            plan.filter
                .include
                .iter()
                .map(|kind| plan.labels.get(kind.label_key()))
                .collect::<Vec<_>>()
                .join(", ")
        });
        Head {
            name,
            exported,
            filtered,
        }
    }
}

/// A failure to write the file: the specific code if the OS gave one a person can act on, else `save_failed`.
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

/// Writes the comments of the document as a PDF summary or a Markdown file to a target chosen in Rust's save dialog.
#[tauri::command]
pub async fn export_comments(
    window: WebviewWindow,
    state: State<'_, AppState>,
    doc_id: DocumentId,
    opts: CommentExportOptions,
    on_event: Channel<JobEvent>,
) -> Result<Option<JobId>, UiError> {
    let state = state.inner().clone();
    blocking(move || state.start_export_comments(&window, doc_id, &opts, channel_sink(on_event)))
        .await
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::commands::testutil::state_with_pages;
    use crate::documents::DocFlags;
    use crate::engine::{Job, TextPage};
    use crate::menu::spec::MenuLocale;
    use crate::model::annotation::{AnnotationBody, AnnotationDraft};
    use crate::model::command::DocCommand;
    use crate::model::geometry::Point;
    use crate::model::protection::PermissionSet;
    use crate::pdfwrite::produce::Unattended;
    use crate::storage::atomic::testutil::TempDir;

    /// "alpha beta" with a box of 10 x 10 per character on one line.
    fn text_page() -> TextPage {
        let text = "alpha beta";
        let boxes = (0..text.len())
            .flat_map(|n| [n as f32 * 10.0, 0.0, 10.0, 10.0])
            .collect();
        TextPage {
            text: text.to_owned(),
            boxes,
            truncated: false,
            rotation: 0,
        }
    }

    fn state() -> (AppState, DocumentId) {
        let (state, id) = state_with_pages(3, move |job| match job {
            Job::TextLayer { reply, .. } => {
                let _ = reply.send(Ok(text_page()));
            }
            Job::ImportAnnotations { reply, .. } => {
                let _ = reply.send(Ok(Vec::new()));
            }
            Job::PageLabels { reply, .. } => {
                let _ = reply.send(Ok(vec![Some("iv".into()), None, None]));
            }
            Job::Close { reply, .. } => {
                let _ = reply.send(Ok(()));
            }
            _ => {}
        });
        (state, id)
    }

    /// The file now forbids copying text (set after the annotations were made: they need the edit permission).
    fn forbid_copy(state: &AppState, id: DocumentId) {
        let flags = DocFlags {
            permissions: Some(PermissionSet::from_list(&[Permission::Print])),
            ..DocFlags::default()
        };
        state.registry.set_flags(id, flags).unwrap();
    }

    fn quad(x: f32, w: f32) -> serde_json::Value {
        json!([{"x": x, "y": 0.0}, {"x": x + w, "y": 0.0}, {"x": x, "y": 10.0}, {"x": x + w, "y": 10.0}])
    }

    fn fill(state: &AppState, id: DocumentId) {
        let drafts: Vec<crate::model::quote::CitationDraft> = serde_json::from_value(json!([
            {"pageId": 0, "color": [255, 248, 77], "tags": ["a"], "contents": "see *this*", "quads": [quad(0.0, 50.0)]}
        ]))
        .unwrap();
        state.create_citations(id, drafts).unwrap();
        let draft = |page: u32, body: AnnotationBody, contents: &str| AnnotationDraft {
            page_id: PageId::new(page),
            color: crate::model::annotation::Rgb([255, 248, 77]),
            opacity: 1.0,
            contents: contents.to_owned(),
            author: Some("Ann".to_owned()),
            in_reply_to: None,
            state: None,
            locked: false,
            tags: Vec::new(),
            cite: None,
            body,
        };
        let markup =
            serde_json::from_value(json!({"kind": "underline", "quads": [quad(55.0, 40.0)]}))
                .unwrap();
        for command in [
            DocCommand::CreateAnnotation {
                draft: draft(
                    1,
                    AnnotationBody::Note {
                        at: Point { x: 5.0, y: 5.0 },
                        icon: crate::model::annotation::NoteIcon::Note,
                    },
                    "# a <note>",
                ),
            },
            DocCommand::CreateAnnotation {
                draft: draft(2, markup, "why"),
            },
        ] {
            state.apply_command(id, command).unwrap();
        }
    }

    fn opts(format: &str) -> CommentExportOptions {
        serde_json::from_value(json!({
            "format": format,
            "include": ["comments", "highlights", "citations", "stamps", "shapes", "drawings"],
            "pages": {"type": "all"},
            "lang": "en",
            "citationLines": [{"id": 1, "text": "Mueller: Titel, S. iv."}]
        }))
        .unwrap()
    }

    fn run(
        state: &AppState,
        id: DocumentId,
        opts: &CommentExportOptions,
        target: &Path,
    ) -> Result<JobDone, AppError> {
        let plan = state.plan_comment_export(id, opts)?;
        state.run_comment_export(id, &plan, target, "Sheer", &Unattended)
    }

    #[test]
    fn markdown_has_pages_quotes_notes_and_escaped_text() {
        let (state, id) = state();
        fill(&state, id);
        let dir = TempDir::new();
        let target = dir.path().join("out.md");
        let done = run(&state, id, &opts("markdown"), &target).unwrap();
        assert_eq!(done.outputs, 1);
        assert!(done.warnings.is_empty());
        let md = std::fs::read_to_string(&target).unwrap();
        assert!(md.starts_with("# Comments: doc\n\nExported "), "{md}");
        let at = |needle: &str| {
            md.find(needle)
                .unwrap_or_else(|| panic!("{needle} in {md}"))
        };
        assert!(
            at("## Page iv \\(1\\)") < at("### Citation") && at("### Citation") < at("## Page 2")
        );
        assert!(
            at("> alpha") < at("Mueller: Titel, S. iv.")
                && at("Mueller: Titel, S. iv.") < at("see \\*this\\*")
        );
        assert!(md.contains("\\# a \\<note\\>") && !md.contains("<note>"));
        assert!(
            at("## Page 3") > at("\\# a") && md.contains("> beta"),
            "{md}"
        );
        assert!(md.contains("### Underline \u{00B7} Ann"));
    }

    #[test]
    fn pdf_is_written_and_the_page_selection_and_types_narrow_it() {
        let (state, id) = state();
        fill(&state, id);
        let dir = TempDir::new();
        let target = dir.path().join("out.pdf");
        run(&state, id, &opts("pdf"), &target).unwrap();
        let bytes = std::fs::read(&target).unwrap();
        assert!(bytes.starts_with(b"%PDF-1.7"));
        assert!(crate::pdfwrite::load_untrusted(&bytes).is_ok());
        // Only page 2, only comments: the note.
        let mut narrow = opts("markdown");
        narrow.pages = PageSelection::Pages {
            pages: vec![PageId::new(1)],
        };
        narrow.include = vec![IncludeKind::Comments];
        let md_target = dir.path().join("narrow.md");
        run(&state, id, &narrow, &md_target).unwrap();
        let md = std::fs::read_to_string(&md_target).unwrap();
        assert!(md.contains("### Note") && !md.contains("Citation"), "{md}");
        assert!(md.contains("Filter: Note"));
    }

    #[test]
    fn nothing_selected_writes_no_file() {
        let (state, id) = state();
        let dir = TempDir::new();
        let target = dir.path().join("none.md");
        let done = run(&state, id, &opts("markdown"), &target).unwrap();
        assert_eq!(done.outputs, 0);
        assert_eq!(done.warnings, vec![Warning::NothingToExport]);
        assert!(!target.exists());
    }

    #[test]
    fn without_the_copy_permission_quotes_are_left_out_and_reported() {
        let (state, id) = state();
        fill(&state, id);
        forbid_copy(&state, id);
        let dir = TempDir::new();
        let target = dir.path().join("nocopy.md");
        let done = run(&state, id, &opts("markdown"), &target).unwrap();
        assert_eq!(done.warnings, vec![Warning::QuotesOmitted]);
        let md = std::fs::read_to_string(&target).unwrap();
        assert!(!md.contains("> alpha") && !md.contains("> beta"));
        assert!(
            md.contains("### Citation")
                && md.contains("### Underline")
                && md.contains("see \\*this\\*")
        );
    }

    #[test]
    fn bad_options_are_refused_before_anything_is_asked() {
        let (state, id) = state();
        let mut none = opts("pdf");
        none.include.clear();
        assert_eq!(
            state.plan_comment_export(id, &none).err().unwrap().code(),
            ErrorCode::InvalidArgument
        );
        let mut lang = opts("pdf");
        lang.lang = "fr".into();
        assert!(state.plan_comment_export(id, &lang).is_err());
        let mut pages = opts("pdf");
        pages.pages = PageSelection::Ranges { text: "9".into() };
        assert!(state.plan_comment_export(id, &pages).is_err());
        let mut many = opts("pdf");
        many.authors = Some(vec!["x".into(); FILTER_NAMES_MAX + 1]);
        assert_eq!(
            state.plan_comment_export(id, &many).err().unwrap().code(),
            ErrorCode::LimitExceeded
        );
        let unknown = serde_json::from_value::<DocumentId>(json!(9_999)).unwrap();
        assert_eq!(
            state
                .plan_comment_export(unknown, &opts("pdf"))
                .err()
                .unwrap()
                .code(),
            ErrorCode::NotFound
        );
    }

    #[test]
    fn only_one_export_per_document_runs_at_a_time() {
        let id = serde_json::from_value::<DocumentId>(json!(424_242)).unwrap();
        let first = Running::take(id).unwrap();
        assert_eq!(
            Running::take(id).err().unwrap().code(),
            ErrorCode::LimitExceeded
        );
        drop(first);
        assert!(Running::take(id).is_ok());
    }

    #[test]
    fn the_locale_of_the_labels_follows_the_language() {
        assert_eq!(Labels::new("de").locale(), MenuLocale::De);
        assert_eq!(Labels::new("en").locale(), MenuLocale::En);
    }
}
