//! "Save as text PDF" (F19.22, ADR-143, ARCHITECTURE section 15.6).
//!
//! | Command | Arguments | Returns |
//! |---|---|---|
//! | `export_text_pdf` | `docId`, `opts: TextPdfOptions` (`font: 'inter' \| 'tinos'`, `keepImages: boolean`, `lang: 'en' \| 'de'`), `onEvent: Channel<JobEvent>` | `JobId`, or `null` (the save dialog was cancelled) |
//!
//! The recognized text of every page (the OCR layer of this session where a page has one, else the text the file has, which is the
//! saved layer of an earlier run) is set as a new A4 document of flowing text: headings and paragraphs by the recognized size, the
//! chosen face embedded as a subset with a `ToUnicode` map. With `keepImages` each page's text is followed by the page itself as a
//! picture. Rust asks for the target in its own save dialog and writes it atomically; the frontend never gets a path. Phases: `read`
//! (pages), `render` (kept pictures) and `write`; `done.outputs` is 1, or 0 with the warning `nothingToExport`; `glyphsReplaced` when the
//! face lacks a character. A document that forbids copying is `read_only` (`permission`).

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use serde::Deserialize;
use tauri::ipc::Channel;
use tauri::{Manager, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

use super::jobs::{channel_sink, file_stem, jobs, EventSink, JobDone, JobEvent, JobId};
use super::{blocking, AppState};
use crate::automation::dialogs::DialogSeam;
use crate::documents::DocumentId;
use crate::error::{AppError, ErrorCode, UiError};
use crate::export::citations::admit_target_ext;
use crate::export::images::{encode, fit, ImageFormat};
use crate::export::snapshot::{EngineDocRef, SnapshotGuard};
use crate::export::text_flow::{self, SourceLine, SourcePage};
use crate::limits;
use crate::model::protection::Permission;
use crate::ocr::textlayer::{self, Shape};
use crate::ocr::OcrPageLayer;
use crate::pdfwrite::produce::{Control, Phase, Warning};
use crate::pdfwrite::redact::RasterPixels;
use crate::pdfwrite::text_pdf::{self, PageImage, Section, TextPdfFont, TextPdfInput};
use crate::smartlinks::model::PageText;
use crate::storage::atomic;

/// What `export_text_pdf` takes.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TextPdfOptions {
    pub font: TextPdfFont,
    pub keep_images: bool,
    /// `en` or `de`: the suggested file name.
    pub lang: String,
}

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
            return Err(AppError::limit("textPdf", 1));
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

/// A page of the document as the export reads it.
#[derive(Debug, Clone)]
struct PagePlan {
    /// 1-based place in the document.
    position: u32,
    engine_index: u32,
    shape: Shape,
    layer: Option<Arc<OcrPageLayer>>,
}

/// A checked request.
struct Plan {
    font: TextPdfFont,
    keep_images: bool,
    pages: Vec<PagePlan>,
    name: String,
}

/// The lines of an OCR layer of the session, in the page as it is shown (after `/Rotate`): one line per recognized line, its size the
/// height of the line's box.
fn lines_of_layer(layer: &OcrPageLayer, shape: Shape) -> SourcePage {
    let shown = textlayer::displayed(layer, shape);
    let lines = shown
        .lines
        .iter()
        .take(limits::MAX_SMART_LINES_PER_PAGE)
        .filter_map(|line| {
            let words: Vec<_> = line
                .words
                .iter()
                .filter(|w| w.rect.iter().all(|v| v.is_finite()))
                .collect();
            let first = words.first()?;
            let mut rect = [
                first.rect[0].min(first.rect[2]),
                first.rect[1].min(first.rect[3]),
                first.rect[0].max(first.rect[2]),
                first.rect[1].max(first.rect[3]),
            ];
            for w in &words[1..] {
                rect = [
                    rect[0].min(w.rect[0].min(w.rect[2])),
                    rect[1].min(w.rect[1].min(w.rect[3])),
                    rect[2].max(w.rect[0].max(w.rect[2])),
                    rect[3].max(w.rect[1].max(w.rect[3])),
                ];
            }
            let text = words
                .iter()
                .map(|w| w.text.as_str())
                .collect::<Vec<_>>()
                .join(" ");
            Some(SourceLine {
                text,
                size: (rect[3] - rect[1]).max(1.0),
                rect,
                bold: false,
            })
        })
        .collect();
    SourcePage { lines }
}

/// The lines of a page the engine read (the file's text): a line's size is that of the run with the most characters.
fn lines_of_text(page: &PageText) -> SourcePage {
    let lines = page
        .lines
        .iter()
        .take(limits::MAX_SMART_LINES_PER_PAGE)
        .filter_map(|line| {
            let main = line
                .runs
                .iter()
                .max_by_key(|run| run.text.chars().count())?;
            let text: String = line.runs.iter().map(|run| run.text.as_str()).collect();
            let r = line.rect;
            Some(SourceLine {
                text,
                size: main.size,
                rect: [r.x, r.y, r.x + r.w, r.y + r.h],
                bold: line.runs.iter().all(|run| run.bold),
            })
        })
        .collect();
    SourcePage { lines }
}

fn file_name(stem: &str, lang: &str) -> String {
    if lang == "de" {
        format!("{stem} – Text.pdf")
    } else {
        format!("{stem} – text.pdf")
    }
}

impl AppState {
    /// Checks the options against document `id`. Nothing is asked of the user before this passes.
    fn plan_text_pdf(&self, id: DocumentId, opts: &TextPdfOptions) -> Result<Plan, AppError> {
        let info = self.info(id).ok_or(AppError::not_found("document"))?;
        if opts.lang != "en" && opts.lang != "de" {
            return Err(AppError::invalid("lang"));
        }
        if info
            .flags
            .permissions
            .is_some_and(|allowed| !allowed.contains(Permission::Copy))
        {
            return Err(AppError::read_only("permission"));
        }
        let pages = self.model(id, |state| {
            Ok(state
                .pages()
                .iter()
                .zip(1u32..)
                .map(|(slot, position)| PagePlan {
                    position,
                    engine_index: slot.engine_index,
                    shape: Shape {
                        size: slot.size,
                        rotation: slot.rotation,
                    },
                    layer: state.ocr_layers.get(&slot.id.get()).cloned(),
                })
                .collect::<Vec<_>>())
        })?;
        if pages.is_empty() || pages.len() > limits::MAX_EXPORT_PAGES {
            return Err(AppError::limit("pages", limits::MAX_EXPORT_PAGES as u64));
        }
        Ok(Plan {
            font: opts.font,
            keep_images: opts.keep_images,
            pages,
            name: file_name(&file_stem(&info.display_name), &opts.lang),
        })
    }

    /// Asks for the target and starts the export of document `id`. `None` when the dialog was cancelled.
    pub fn start_export_text_pdf(
        &self,
        window: &WebviewWindow,
        id: DocumentId,
        opts: &TextPdfOptions,
        sink: Arc<dyn EventSink>,
    ) -> Result<Option<JobId>, AppError> {
        let plan = self.plan_text_pdf(id, opts)?;
        let guard = Running::take(id)?;
        let mut dialog = window
            .dialog()
            .file()
            .set_parent(window)
            .add_filter("PDF", &["pdf"])
            .set_file_name(&plan.name);
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
        let target = self.admit_text_pdf_target(id, &path)?;
        let state = self.clone();
        jobs()
            .start(sink, move |ctx| {
                let _guard = guard;
                state.run_text_pdf(id, &plan, &target, &producer, ctx)
            })
            .map(Some)
    }

    /// The chosen target, judged like a Save As target: never the document itself or another open one.
    fn admit_text_pdf_target(&self, id: DocumentId, target: &Path) -> Result<PathBuf, AppError> {
        let target = admit_target_ext(target, "pdf")?;
        let source = self
            .registry
            .path(id)
            .ok_or(AppError::not_found("document"))?;
        let same =
            std::fs::canonicalize(&source).map_or(source == target, |source| source == target);
        if same || self.registry.is_open_path(&target) {
            return Err(AppError::invalid("exportTarget"));
        }
        Ok(target)
    }

    /// The lines of each page: the session's OCR layer, else the engine's reading of the file page. A page the engine cannot read
    /// counts as one without text. Also the recognizer's language, if a layer says one.
    fn text_pdf_pages(
        &self,
        id: DocumentId,
        plan: &Plan,
        ctx: &dyn Control,
    ) -> Result<(Vec<SourcePage>, Option<String>), AppError> {
        let total = u32::try_from(plan.pages.len()).unwrap_or(u32::MAX);
        let mut out = Vec::with_capacity(plan.pages.len());
        let mut lang = None;
        for (done, page) in plan.pages.iter().enumerate() {
            ctx.check()?;
            ctx.progress(Phase::Read, u32::try_from(done).unwrap_or(u32::MAX), total);
            let source = match &page.layer {
                Some(layer) => {
                    if lang.is_none() && !layer.lang.is_empty() {
                        lang = Some(layer.lang.clone());
                    }
                    lines_of_layer(layer, page.shape)
                }
                None => match self.engine.smart_text(id, page.engine_index) {
                    Ok(text) => lines_of_text(&text),
                    Err(error)
                        if matches!(
                            error.code(),
                            ErrorCode::InvalidArgument
                                | ErrorCode::DamagedFile
                                | ErrorCode::EngineTimeout
                        ) =>
                    {
                        SourcePage::default()
                    }
                    Err(error) => return Err(error),
                },
            };
            out.push(source);
        }
        ctx.progress(Phase::Read, total, total);
        Ok((out, lang))
    }

    /// The pages as pictures for "keep original image", rendered from the document as it is now (a snapshot when unsaved).
    fn text_pdf_images(
        &self,
        id: DocumentId,
        plan: &Plan,
        ctx: &dyn Control,
    ) -> Result<Vec<Option<PageImage>>, AppError> {
        let guard = SnapshotGuard::current(self, id)?;
        let doc = guard.engine();
        let total = u32::try_from(plan.pages.len()).unwrap_or(u32::MAX);
        let mut out = Vec::with_capacity(plan.pages.len());
        for (done, page) in plan.pages.iter().enumerate() {
            ctx.check()?;
            let drawn = if page.shape.rotation % 180 == 90 {
                [page.shape.size[1], page.shape.size[0]]
            } else {
                page.shape.size
            };
            let Some(fitted) = fit(drawn[0], drawn[1], limits::TEXT_PDF_IMAGE_DPI) else {
                out.push(None);
                continue;
            };
            // A snapshot is written in the current order; the live document has its pages where the model says.
            let engine_index = match doc {
                EngineDocRef::Live(_) => page.engine_index,
                EngineDocRef::Snapshot(_) => page.position - 1,
            };
            let raster = self
                .engine()
                .render_export(doc, engine_index, fitted.dpi, false, 0)?;
            let grey = matches!(raster.pixels, RasterPixels::Gray8(_));
            let jpeg = encode(&raster, ImageFormat::Jpeg, limits::TEXT_PDF_IMAGE_QUALITY)?;
            out.push(Some(PageImage {
                jpeg,
                width_px: raster.width,
                height_px: raster.height,
                grey,
                size_pt: drawn,
            }));
            ctx.progress(
                Phase::Render,
                u32::try_from(done + 1).unwrap_or(total),
                total,
            );
        }
        drop(guard);
        Ok(out)
    }

    /// The job: read, flow, render the kept pictures, build, write.
    fn run_text_pdf(
        &self,
        id: DocumentId,
        plan: &Plan,
        target: &Path,
        producer: &str,
        ctx: &dyn Control,
    ) -> Result<JobDone, AppError> {
        ctx.check()?;
        let info = self.info(id).ok_or(AppError::not_found("document"))?;
        let (pages, lang) = self.text_pdf_pages(id, plan, ctx)?;
        let flowed = text_flow::flow(&pages, !plan.keep_images);
        drop(pages);
        if flowed.pages.iter().all(Vec::is_empty) {
            return Ok(JobDone {
                warnings: vec![Warning::NothingToExport],
                ..JobDone::default()
            });
        }
        let images = if plan.keep_images {
            self.text_pdf_images(id, plan, ctx)?
        } else {
            Vec::new()
        };
        let sections: Vec<Section> = flowed
            .pages
            .into_iter()
            .enumerate()
            .map(|(at, blocks)| Section {
                blocks,
                image: images.get(at).cloned().flatten(),
            })
            .collect();
        drop(images);
        ctx.check()?;
        let title = file_stem(&info.display_name);
        let total = sections.len();
        let built = text_pdf::build(
            &TextPdfInput {
                sections: &sections,
                font: plan.font,
                keep_images: plan.keep_images,
                title: &title,
                lang: lang.as_deref(),
                producer,
            },
            &mut |done, _| {
                ctx.check()?;
                ctx.progress(
                    Phase::Write,
                    u32::try_from(done).unwrap_or(u32::MAX),
                    u32::try_from(total).unwrap_or(u32::MAX).saturating_add(1),
                );
                Ok(())
            },
        )?;
        let mut warnings = Vec::new();
        if built.glyphs_replaced {
            warnings.push(Warning::GlyphsReplaced);
        }
        ctx.check()?;
        atomic::write_atomic(target, &built.bytes).map_err(write_error)?;
        ctx.progress(Phase::Write, 1, 1);
        Ok(JobDone {
            outputs: 1,
            bytes_after: built.bytes.len() as u64,
            warnings,
            ..JobDone::default()
        })
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

/// Writes the recognized text of the document as a new text PDF to a target chosen in Rust's save dialog.
#[tauri::command]
pub async fn export_text_pdf(
    window: WebviewWindow,
    state: State<'_, AppState>,
    doc_id: DocumentId,
    opts: TextPdfOptions,
    on_event: Channel<JobEvent>,
) -> Result<Option<JobId>, UiError> {
    let state = state.inner().clone();
    blocking(move || state.start_export_text_pdf(&window, doc_id, &opts, channel_sink(on_event)))
        .await
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::commands::testutil::state_with_pages;
    use crate::documents::DocFlags;
    use crate::documents::PageId;
    use crate::engine::Job;
    use crate::model::command::DocCommand;
    use crate::model::protection::PermissionSet;
    use crate::ocr::{OcrLine, OcrWord};
    use crate::pdfwrite::produce::Unattended;
    use crate::smartlinks::model::{Line, PtRect, Run};
    use crate::storage::atomic::testutil::TempDir;

    /// Page 2 of the file has text of its own (a saved layer): a body line. Every other page has none.
    fn state() -> (AppState, DocumentId) {
        state_with_pages(3, move |job| match job {
            Job::SmartText {
                engine_index,
                reply,
                ..
            } => {
                let rect = PtRect {
                    x: 40.0,
                    y: 100.0,
                    w: 400.0,
                    h: 11.0,
                };
                let lines = if engine_index == 2 {
                    vec![Line {
                        runs: vec![Run {
                            text: "Saved layer text of the third page.".into(),
                            rect,
                            size: 11.0,
                            baseline: 109.0,
                            bold: false,
                        }],
                        rect,
                    }]
                } else {
                    Vec::new()
                };
                let _ = reply.send(Ok(PageText {
                    page: engine_index,
                    width: 595.0,
                    height: 842.0,
                    lines,
                    body_size: 11.0,
                }));
            }
            Job::Close { reply, .. } => {
                let _ = reply.send(Ok(()));
            }
            _ => {}
        })
    }

    fn word(text: &str, x: f32, y: f32, w: f32, h: f32) -> OcrWord {
        OcrWord {
            text: text.into(),
            rect: [x, y, x + w, y + h],
        }
    }

    /// A pending OCR layer on page 1: a 24 pt title and two 11 pt body lines.
    fn recognize(state: &AppState, id: DocumentId) {
        let layer = Arc::new(OcrPageLayer {
            lang: "de-DE".into(),
            angle_deg: 0.0,
            dpi: 300.0,
            lines: vec![
                OcrLine {
                    words: vec![word("Gutachten", 40.0, 40.0, 200.0, 24.0)],
                },
                OcrLine {
                    words: vec![
                        word("Erster", 40.0, 100.0, 60.0, 11.0),
                        word("Absatz", 104.0, 100.0, 60.0, 11.0),
                        word("geht", 168.0, 100.0, 40.0, 11.0),
                    ],
                },
                OcrLine {
                    words: vec![word("weiter.", 40.0, 114.0, 60.0, 11.0)],
                },
            ],
        });
        state
            .apply_command(
                id,
                DocCommand::ApplyOcr {
                    layers: vec![(PageId::new(0), layer)],
                },
            )
            .unwrap();
    }

    fn opts(font: &str, keep: bool) -> TextPdfOptions {
        serde_json::from_value(json!({ "font": font, "keepImages": keep, "lang": "de" })).unwrap()
    }

    #[test]
    fn the_recognized_text_becomes_a_text_pdf_with_headings_and_both_sources() {
        let (state, id) = state();
        recognize(&state, id);
        let dir = TempDir::new();
        let target = dir.path().join("out.pdf");
        let plan = state.plan_text_pdf(id, &opts("inter", false)).unwrap();
        assert_eq!(plan.name, "doc – Text.pdf");
        let done = state
            .run_text_pdf(id, &plan, &target, "Sheer", &Unattended)
            .unwrap();
        assert_eq!(done.outputs, 1);
        assert!(done.warnings.is_empty());
        let bytes = std::fs::read(&target).unwrap();
        let doc = crate::pdfwrite::load_untrusted(&bytes).unwrap();
        let text = doc.extract_text(&[1]).unwrap();
        assert!(text.contains("Gutachten"), "{text}");
        assert!(text.contains("Erster Absatz geht weiter."), "{text}");
        assert!(
            text.contains("Saved layer text of the third page."),
            "{text}"
        );
        assert_eq!(
            doc.catalog()
                .unwrap()
                .get(b"Lang")
                .unwrap()
                .as_str()
                .unwrap(),
            b"de-DE"
        );
        // The title is set larger than the body, in Inter Bold.
        let page = doc.get_pages()[&1];
        let content = doc.get_and_decode_page_content(page).unwrap();
        let sizes: Vec<f32> = content
            .operations
            .iter()
            .filter(|op| op.operator == "Tf")
            .map(|op| op.operands[1].as_float().unwrap())
            .collect();
        assert!(sizes[0] > sizes[1], "{sizes:?}");
        let fonts = doc.get_page_fonts(page).unwrap();
        assert!(fonts.values().any(|f| String::from_utf8_lossy(
            f.get(b"BaseFont").unwrap().as_name().unwrap()
        )
        .ends_with("+Inter-Bold")));
    }

    #[test]
    fn a_document_without_text_writes_nothing() {
        let (state, id) = state();
        // Only page 3 has text; take it away by making every page come from a layer without words.
        let empty = Arc::new(OcrPageLayer::default());
        state
            .apply_command(
                id,
                DocCommand::ApplyOcr {
                    layers: (0..3)
                        .map(|n| (PageId::new(n), Arc::clone(&empty)))
                        .collect(),
                },
            )
            .unwrap();
        let dir = TempDir::new();
        let target = dir.path().join("out.pdf");
        let plan = state.plan_text_pdf(id, &opts("tinos", false)).unwrap();
        let done = state
            .run_text_pdf(id, &plan, &target, "Sheer", &Unattended)
            .unwrap();
        assert_eq!(done.outputs, 0);
        assert_eq!(done.warnings, [Warning::NothingToExport]);
        assert!(!target.exists());
    }

    #[test]
    fn bad_options_and_a_no_copy_document_are_refused_before_anything_is_asked() {
        let (state, id) = state();
        assert!(serde_json::from_value::<TextPdfOptions>(
            json!({ "font": "comic", "keepImages": false, "lang": "en" })
        )
        .is_err());
        assert!(serde_json::from_value::<TextPdfOptions>(
            json!({ "font": "inter", "keepImages": false, "lang": "en", "path": "x" })
        )
        .is_err());
        let mut bad = opts("inter", false);
        bad.lang = "fr".into();
        assert_eq!(
            state.plan_text_pdf(id, &bad).err().unwrap().code(),
            ErrorCode::InvalidArgument
        );
        state
            .registry
            .set_flags(
                id,
                DocFlags {
                    permissions: Some(PermissionSet::from_list(&[Permission::Print])),
                    ..DocFlags::default()
                },
            )
            .unwrap();
        assert_eq!(
            state
                .plan_text_pdf(id, &opts("inter", true))
                .err()
                .unwrap()
                .code(),
            ErrorCode::ReadOnly
        );
    }

    #[test]
    fn only_one_export_per_document_runs_at_a_time() {
        let id: DocumentId = serde_json::from_value(json!(987_654)).unwrap();
        let first = Running::take(id).unwrap();
        assert_eq!(
            Running::take(id).err().unwrap().code(),
            ErrorCode::LimitExceeded
        );
        drop(first);
        assert!(Running::take(id).is_ok());
    }

    #[test]
    fn layer_lines_join_their_words_and_measure_the_line_box() {
        let layer = OcrPageLayer {
            lines: vec![OcrLine {
                words: vec![
                    word("a", 10.0, 10.0, 5.0, 8.0),
                    word("b", 20.0, 10.0, 5.0, 8.0),
                ],
            }],
            ..OcrPageLayer::default()
        };
        let page = lines_of_layer(
            &layer,
            Shape {
                size: [100.0, 200.0],
                rotation: 0,
            },
        );
        assert_eq!(page.lines.len(), 1);
        assert_eq!(page.lines[0].text, "a b");
        assert_eq!(page.lines[0].rect, [10.0, 10.0, 25.0, 18.0]);
        assert_eq!(page.lines[0].size, 8.0);
    }
}
