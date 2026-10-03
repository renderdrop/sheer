//! The worker thread. The only code that touches PDFium.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::Arc;

use pdfium_render::prelude::*;

use super::guard::{guarded, Health};
use super::queue::{RenderKey, Requests};
use super::sizes::{PageSizes, SizeCache};
use super::space::page_count;
use super::{
    encode, import, links, outline, pages, redact, search, text, Confirm, Job, ReopenSource, Reply,
};
use crate::documents::{DocFlags, DocumentId};
use crate::error::{AppError, ErrorCode};
use crate::limits;

type Documents<'a> = HashMap<DocumentId, PdfDocument<'a>>;

/// Worker entry point: binds PDFium, then serves jobs until every `Engine` handle is gone.
///
/// `stale` are documents of an earlier worker that was given up on (`Engine::recover`): they are not loaded here and answer
/// `engine_crashed` until closed, so the UI learns that they must be reopened.
pub(super) fn run(
    library: &Path,
    mut requests: Requests,
    health: &Health,
    sizes: &SizeCache,
    stale: HashSet<DocumentId>,
) {
    let bound = guarded(|| {
        Pdfium::bind_to_library(library).map_err(|error| {
            AppError::logged(
                ErrorCode::EngineUnavailable,
                format!("could not load the PDFium library: {error}"),
            )
        })
    });
    let bindings = match bound {
        Ok(bindings) => bindings,
        Err(error) => {
            error.log();
            while let Some(request) = requests.next() {
                requests.fail(request, &AppError::new(ErrorCode::EngineUnavailable));
            }
            return;
        }
    };
    // `documents` borrows `pdfium`, so it must be declared after it (drop order: documents first).
    let pdfium = Pdfium::new(bindings);
    let mut documents: Documents<'_> = HashMap::new();
    // Documents whose job panicked. They are dropped from `documents` and refuse further work until closed.
    let mut crashed: HashSet<DocumentId> = stale;

    while let Some(request) = requests.next() {
        // Replaced while it was stuck: another worker owns PDFium now, so nothing more is served from here.
        if health.is_retired() {
            requests.fail(request, &AppError::new(ErrorCode::EngineUnavailable));
            continue;
        }
        // The caller already gave up (an earlier job ran long): skip the stale work.
        if request.expired() {
            requests.fail(
                request,
                &AppError::logged(ErrorCode::EngineTimeout, "job expired in the queue"),
            );
            continue;
        }
        let _busy = health.begin(request.run_deadline());
        serve(
            &pdfium,
            &requests,
            &mut documents,
            &mut crashed,
            sizes,
            request.job,
        );
    }
    if health.is_retired() {
        // Dropping the documents and `pdfium` would call `FPDF_DestroyLibrary` under the worker that replaced this one.
        std::mem::forget(documents);
        std::mem::forget(pdfium);
    }
}

/// Runs one job inside the panic guard and sends the answer.
fn serve<'a>(
    pdfium: &'a Pdfium,
    requests: &Requests,
    documents: &mut Documents<'a>,
    crashed: &mut HashSet<DocumentId>,
    sizes: &SizeCache,
    job: Job,
) {
    match job {
        Job::Open {
            id,
            file,
            password,
            confirm,
            reply,
        } => {
            let result = guarded(|| {
                open(
                    pdfium,
                    documents,
                    sizes,
                    id,
                    file,
                    password.as_deref().map(String::as_str),
                    confirm,
                )
            });
            answer(reply, result, None, documents, crashed);
        }
        Job::Render { key, reply } => {
            let result = if crashed.contains(&key.id) {
                Err(AppError::new(ErrorCode::EngineCrashed))
            } else {
                guarded(|| match documents.get(&key.id) {
                    Some(document) => render(document, key),
                    None => Err(AppError::not_found("document")),
                })
            }
            .map(Arc::new);
            // Callers that asked for this very frame while it was queued or running get the same answer.
            for waiter in requests.finish_render(&key) {
                let _ = waiter.send(result.clone());
            }
            answer(reply, result, Some(key.id), documents, crashed);
        }
        Job::Outline { id, reply } => {
            let result = read_job(documents, crashed, id, |document| {
                Ok(outline::read_outline(document, page_count(document)?))
            });
            answer(reply, result, Some(id), documents, crashed);
        }
        Job::TextLayer {
            id,
            page_index,
            reply,
        } => {
            let result = read_job(documents, crashed, id, |document| {
                let page_index = limits::validate_page_index(page_index, page_count(document)?)?;
                text::read_text(document, page_index)
            });
            answer(reply, result, Some(id), documents, crashed);
        }
        Job::PageLinks {
            id,
            page_index,
            reply,
        } => {
            let result = read_job(documents, crashed, id, |document| {
                let count = page_count(document)?;
                let page_index = limits::validate_page_index(page_index, count)?;
                links::read_links(document, count, page_index)
            });
            answer(reply, result, Some(id), documents, crashed);
        }
        Job::ImportAnnotations {
            id,
            page_index,
            reply,
        } => {
            let result = read_job(documents, crashed, id, |document| {
                let page_index = limits::validate_page_index(page_index, page_count(document)?)?;
                import::read_annotations(document, page_index)
            });
            answer(reply, result, Some(id), documents, crashed);
        }
        Job::SetAnnotationsHidden {
            id,
            hide,
            show,
            reply,
        } => {
            let result = read_job(documents, crashed, id, |document| {
                import::set_hidden(document, &hide, &show)
            });
            answer(reply, result, Some(id), documents, crashed);
        }
        Job::SearchPage {
            id,
            page_index,
            spec,
            limit,
            reply,
        } => {
            let result = read_job(documents, crashed, id, |document| {
                let page_index = limits::validate_page_index(page_index, page_count(document)?)?;
                search::search_page(document, page_index, &spec, limit)
            });
            answer(reply, result, Some(id), documents, crashed);
        }
        Job::SetPageRotations { id, items, reply } => {
            let result = read_job(documents, crashed, id, |document| {
                pages::set_rotations(document, &items)
            });
            answer(reply, result, Some(id), documents, crashed);
        }
        Job::SetCropBox {
            id,
            engine_index,
            crop,
            reply,
        } => {
            let result = read_job(documents, crashed, id, |document| {
                pages::set_crop_box(document, engine_index, crop)
            });
            answer(reply, result, Some(id), documents, crashed);
        }
        Job::RenderForRedaction {
            id,
            engine_index,
            dpi,
            burn,
            reply,
        } => {
            let result = read_job(documents, crashed, id, |document| {
                redact::render_for_redaction(document, engine_index, dpi, &burn)
            });
            answer(reply, result, Some(id), documents, crashed);
        }
        Job::AppendBlankPage { id, size, reply } => {
            let result = if crashed.contains(&id) {
                Err(AppError::new(ErrorCode::EngineCrashed))
            } else {
                guarded(|| match documents.get_mut(&id) {
                    Some(document) => pages::append_blank(document, size),
                    None => Err(AppError::not_found("document")),
                })
            };
            answer(reply, result, Some(id), documents, crashed);
        }
        Job::TruncatePages {
            id,
            keep,
            total,
            reply,
        } => {
            let result = if crashed.contains(&id) {
                Err(AppError::new(ErrorCode::EngineCrashed))
            } else {
                guarded(|| match documents.get_mut(&id) {
                    Some(document) => pages::truncate(document, keep, total),
                    None => Err(AppError::not_found("document")),
                })
            };
            answer(reply, result, Some(id), documents, crashed);
        }
        Job::AppendPages {
            id,
            source,
            pages: indices,
            reply,
        } => {
            let result = if crashed.contains(&id) {
                Err(AppError::new(ErrorCode::EngineCrashed))
            } else {
                guarded(|| match documents.get_mut(&id) {
                    Some(document) => {
                        pages::append_pages(pdfium, document, &source.bytes, &indices)
                    }
                    None => Err(AppError::not_found("document")),
                })
            };
            answer(reply, result, Some(id), documents, crashed);
        }
        Job::Close { id, reply } => {
            let result = guarded(|| {
                crashed.remove(&id);
                documents.remove(&id);
                Ok(())
            });
            // Whatever became of the document, its sizes go: nobody can ask for a document that was closed.
            sizes.remove(id);
            // Nothing queued for a closed document is worth drawing: its callers hear `cancelled`.
            requests.cancel_document(id);
            answer(reply, result, Some(id), documents, crashed);
        }
        Job::Release {
            id,
            snapshot,
            reply,
        } => {
            // The sizes stay: the UI keeps laying the document out while its file is replaced.
            let result = guarded(|| {
                // The copy with the session's pages and rotations, for a save that fails and has to put it back.
                let bytes = match documents.get(&id) {
                    Some(document) if snapshot => {
                        Some(document.save_to_bytes().map_err(|error| {
                            AppError::logged(ErrorCode::Internal, format!("{error:?}"))
                        })?)
                    }
                    _ => None,
                };
                documents.remove(&id);
                Ok(bytes)
            });
            answer(reply, result, None, documents, crashed);
        }
        Job::Reopen { id, source, reply } => {
            let result = guarded(|| match source {
                ReopenSource::File(file) => {
                    open(pdfium, documents, sizes, id, file, None, Box::new(|_| true))
                }
                ReopenSource::FileWithPassword(file, password) => open(
                    pdfium,
                    documents,
                    sizes,
                    id,
                    file,
                    Some(password.as_str()),
                    Box::new(|_| true),
                ),
                ReopenSource::Bytes(bytes) => open(
                    pdfium,
                    documents,
                    sizes,
                    id,
                    std::io::Cursor::new(bytes),
                    None,
                    Box::new(|_| true),
                ),
            });
            if result.is_ok() {
                crashed.remove(&id);
            }
            answer(reply, result, None, documents, crashed);
        }
        #[cfg(test)]
        Job::Crash { id, reply } => {
            let result: Result<(), AppError> = guarded(|| panic!("test panic in a PDF job"));
            answer(reply, result, id, documents, crashed);
        }
        #[cfg(test)]
        Job::Hold { gate, reply } => {
            let _ = gate.recv();
            answer(reply, Ok(()), None, documents, crashed);
        }
    }
}

/// Runs a read of document `id` (`read`) inside the panic guard. A document that is not loaded is `not_found`, one whose earlier job
/// panicked is `engine_crashed` until it is closed, as for a render.
fn read_job<T>(
    documents: &Documents<'_>,
    crashed: &HashSet<DocumentId>,
    id: DocumentId,
    read: impl FnOnce(&PdfDocument<'_>) -> Result<T, AppError>,
) -> Result<T, AppError> {
    if crashed.contains(&id) {
        return Err(AppError::new(ErrorCode::EngineCrashed));
    }
    guarded(|| match documents.get(&id) {
        Some(document) => read(document),
        None => Err(AppError::not_found("document")),
    })
}

/// Sends `result`. If the job panicked while working on document `id`, that document is dropped and quarantined first:
/// PDFium state after a panic is not trusted, but other documents and the worker carry on.
fn answer<T>(
    reply: Reply<T>,
    result: Result<T, AppError>,
    id: Option<DocumentId>,
    documents: &mut Documents<'_>,
    crashed: &mut HashSet<DocumentId>,
) {
    if let (Err(error), Some(id)) = (&result, id) {
        if error.code() == ErrorCode::EngineCrashed && crashed.insert(id) {
            // Dropping a document calls into PDFium, so it is guarded like any other job.
            let _ = guarded(|| {
                documents.remove(&id);
                Ok(())
            });
        }
    }
    // The caller may have timed out and dropped its receiver.
    let _ = reply.send(result);
}

fn open<'a, R: std::io::Read + std::io::Seek + Send + 'static>(
    pdfium: &'a Pdfium,
    documents: &mut Documents<'a>,
    sizes: &SizeCache,
    id: DocumentId,
    file: R,
    password: Option<&str>,
    confirm: Confirm,
) -> Result<u32, AppError> {
    // PDFium reads the handle intake judged; the file is not opened again by path (SECURITY I3). It owns the handle from
    // here on and closes it with the document, or at once if loading fails.
    let document = pdfium
        .load_pdf_from_reader(file, password)
        .map_err(map_load_error)?;
    let page_count = u32::try_from(document.pages().len())
        .map_err(|_| AppError::logged(ErrorCode::DamagedFile, "negative page count"))?;
    // The layout holds a size per page and the scroll height grows with the count: a document beyond the limit is refused
    // here, the one place that sees the count first. The document is dropped with its handle.
    limits::validate_page_count(page_count)?;
    // The sizes are read once, here, and are there before anybody can know the document is: `confirm` makes it known.
    sizes.insert(id, read_page_sizes(&document), read_flags(&document));
    let (rotations, boxes) = pages::read_rotations_and_boxes(&document);
    sizes.set_rotations(id, rotations);
    sizes.set_boxes(id, boxes);
    // The caller may have stopped waiting while the document loaded (the open deadline passed) and taken the registry entry
    // back. Nobody could ever close a document without an entry, so it is released here, with its handle.
    if !confirm(page_count) {
        sizes.remove(id);
        drop(document);
        return Err(AppError::logged(
            ErrorCode::EngineTimeout,
            "the document finished loading after its caller gave up; released",
        ));
    }
    documents.insert(id, document);
    Ok(page_count)
}

fn map_load_error(error: PdfiumError) -> AppError {
    use PdfiumInternalError as Internal;
    match error {
        PdfiumError::PdfiumLibraryInternalError(Internal::FormatError) => {
            AppError::new(ErrorCode::NotAPdf)
        }
        PdfiumError::PdfiumLibraryInternalError(Internal::PasswordError) => {
            AppError::new(ErrorCode::PasswordRequired)
        }
        PdfiumError::PdfiumLibraryInternalError(Internal::SecurityError) => {
            AppError::new(ErrorCode::UnsupportedFeature)
        }
        PdfiumError::PdfiumLibraryInternalError(Internal::FileError) => {
            AppError::logged(ErrorCode::IoNotFound, "PDFium could not open the file")
        }
        PdfiumError::IoError(error) => AppError::from(error),
        other => AppError::logged(ErrorCode::Internal, format!("{other:?}")),
    }
}

/// What PDFium says about the document, as far as it can tell (`DocFlags`: best effort, read once when the document is loaded).
/// An answer PDFium cannot give counts as no. The signatures are only counted for a document that has a form: a signature field is
/// a form field, and counting them goes through the annotations of every page.
fn read_flags(document: &PdfDocument<'_>) -> DocFlags {
    // A revision PDFium-render does not know (5 and 6, AES-256) is an error here, and an encrypted file all the same.
    let encrypted = !matches!(
        document.permissions().security_handler_revision(),
        Ok(PdfSecurityHandlerRevision::Unprotected)
    );
    let form_type = document.form().map(PdfForm::form_type);
    let xfa = matches!(
        form_type,
        Some(PdfFormType::XfaFull | PdfFormType::XfaForeground)
    );
    let has_forms = form_type.is_some_and(|form_type| form_type != PdfFormType::None);
    DocFlags {
        encrypted,
        xfa,
        has_forms,
        signed: has_forms && !document.signatures().is_empty(),
        // The caller sets them after the open (`AppState::refresh_permissions`): PDFium-render cannot read them for R5 and R6.
        permissions: None,
    }
}

/// The size of every page in points, as the pages are drawn (rotation applied), read once when the document is loaded (`open`;
/// the page count is within `limits::MAX_PAGES` by then). `FPDF_GetPageSizeByIndexF` does not load a page, so this is quick even
/// for a long document. A page whose size PDFium cannot read, or reads as nonsense, is shown as US Letter
/// (`limits::sanitize_page_size`): the layout needs a size for every page, and a damaged page does not spoil the others.
fn read_page_sizes(document: &PdfDocument<'_>) -> PageSizes {
    let pages = document.pages();
    (0..pages.len())
        .map(|index| match pages.page_size(index) {
            Ok(rect) => limits::sanitize_page_size(rect.width().value, rect.height().value),
            Err(_) => limits::DEFAULT_PAGE_SIZE_PT,
        })
        .collect()
}

/// Renders one frame: the whole page, or one tile of it, at the scale of the bucket. Validates against the real page size
/// before allocating the bitmap, which is only as large as the frame (a tile is at most 1024 x 1024 pixels however large the
/// page is at this scale).
fn render(document: &PdfDocument<'_>, key: RenderKey) -> Result<Vec<u8>, AppError> {
    let scale = limits::bucket_scale(key.bucket)?;
    let page_count = u32::try_from(document.pages().len())
        .map_err(|_| AppError::logged(ErrorCode::DamagedFile, "negative page count"))?;
    let index = limits::validate_page_index(key.page_index, page_count)?;
    let page = document
        .pages()
        .get(to_i32(index)?)
        .map_err(|error| AppError::logged(ErrorCode::DamagedFile, format!("{error:?}")))?;

    let (page_width, page_height) =
        limits::page_pixel_size(page.width().value, page.height().value, scale)?;
    let region = limits::render_region((page_width, page_height), key.tile)?;

    // The page is laid out at its full size, shifted so that the region's top left corner is the bitmap's; the bitmap is the
    // region and PDFium draws nothing outside it. BGR with PDFium's reverse-byte-order flag yields RGB rows, which PNG takes
    // as they are.
    let config = PdfRenderConfig::new()
        .set_target_size(to_i32(page_width)?, to_i32(page_height)?)
        .set_origin(-to_i32(region.x)?, -to_i32(region.y)?)
        .set_format(PdfBitmapFormat::BGR)
        .set_reverse_byte_order(true);
    let mut bitmap = PdfBitmap::empty(
        to_i32(region.width)?,
        to_i32(region.height)?,
        PdfBitmapFormat::BGR,
    )
    .map_err(|error| AppError::logged(ErrorCode::Internal, format!("{error:?}")))?;
    page.render_into_bitmap_with_config(&mut bitmap, &config)
        .map_err(|error| AppError::logged(ErrorCode::Internal, format!("{error:?}")))?;

    let (rendered_w, rendered_h) = (bitmap.width(), bitmap.height());
    if (rendered_w, rendered_h) != (to_i32(region.width)?, to_i32(region.height)?) {
        return Err(AppError::logged(
            ErrorCode::Internal,
            format!(
                "bitmap is {rendered_w}x{rendered_h}, expected {}x{}",
                region.width, region.height
            ),
        ));
    }
    let raw = bitmap.as_raw_bytes();
    drop(bitmap);
    drop(page);

    let stride = raw.len() / region.height as usize;
    encode::encode_frame(region.width, region.height, stride, &raw)
}

fn to_i32(value: u32) -> Result<i32, AppError> {
    // Sizes are bounded by `limits` long before this; only a corrupt page count could get here.
    i32::try_from(value)
        .map_err(|_| AppError::logged(ErrorCode::Internal, "value does not fit a PDFium int"))
}
