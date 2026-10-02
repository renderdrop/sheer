//! The worker thread. The only code that touches PDFium.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::mpsc::Receiver;

use pdfium_render::prelude::*;

use super::guard::{guarded, Health};
use super::{encode, Job, Reply, Request};
use crate::documents::DocumentId;
use crate::error::{AppError, ErrorCode};
use crate::limits;

type Documents<'a> = HashMap<DocumentId, PdfDocument<'a>>;

/// Worker entry point: binds PDFium, then serves jobs until every `Engine` handle is gone.
pub(super) fn run(library: &Path, requests: Receiver<Request>, health: &Health) {
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
            for request in requests {
                request
                    .job
                    .fail(AppError::new(ErrorCode::EngineUnavailable));
            }
            return;
        }
    };
    // `documents` borrows `pdfium`, so it must be declared after it (drop order: documents first).
    let pdfium = Pdfium::new(bindings);
    let mut documents: Documents<'_> = HashMap::new();
    // Documents whose job panicked. They are dropped from `documents` and refuse further work until closed.
    let mut crashed: HashSet<DocumentId> = HashSet::new();

    for request in requests {
        // The caller already gave up (an earlier job ran long): skip the stale work.
        if request.expired() {
            request.job.fail(AppError::logged(
                ErrorCode::EngineTimeout,
                "job expired in the queue",
            ));
            continue;
        }
        let _busy = health.begin(request.deadline);
        serve(&pdfium, &mut documents, &mut crashed, request.job);
    }
}

/// Runs one job inside the panic guard and sends the answer.
fn serve<'a>(
    pdfium: &'a Pdfium,
    documents: &mut Documents<'a>,
    crashed: &mut HashSet<DocumentId>,
    job: Job,
) {
    match job {
        Job::Open { id, path, reply } => {
            let result = guarded(|| open(pdfium, documents, id, &path));
            answer(reply, result, None, documents, crashed);
        }
        Job::Render {
            id,
            page_index,
            scale,
            reply,
        } => {
            let result = if crashed.contains(&id) {
                Err(AppError::new(ErrorCode::EngineCrashed))
            } else {
                guarded(|| match documents.get(&id) {
                    Some(document) => render(document, page_index, scale),
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
            answer(reply, result, Some(id), documents, crashed);
        }
        #[cfg(test)]
        Job::Crash { id, reply } => {
            let result: Result<(), AppError> = guarded(|| panic!("test panic in a PDF job"));
            answer(reply, result, id, documents, crashed);
        }
    }
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

fn open<'a>(
    pdfium: &'a Pdfium,
    documents: &mut Documents<'a>,
    id: DocumentId,
    path: &Path,
) -> Result<u32, AppError> {
    let document = pdfium
        .load_pdf_from_file(path, None)
        .map_err(map_load_error)?;
    let page_count = u32::try_from(document.pages().len())
        .map_err(|_| AppError::logged(ErrorCode::DamagedFile, "negative page count"))?;
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

/// Renders one page to a frame. Validates against the real page size before allocating the bitmap.
fn render(document: &PdfDocument<'_>, page_index: u32, scale: f32) -> Result<Vec<u8>, AppError> {
    let scale = limits::validate_scale(scale)?;
    let page_count = u32::try_from(document.pages().len())
        .map_err(|_| AppError::logged(ErrorCode::DamagedFile, "negative page count"))?;
    let index = limits::validate_page_index(page_index, page_count)?;
    let page = document
        .pages()
        .get(to_i32(index)?)
        .map_err(|error| AppError::logged(ErrorCode::DamagedFile, format!("{error:?}")))?;

    let (width, height) = limits::pixel_size(page.width().value, page.height().value, scale)?;
    // BGR with PDFium's reverse-byte-order flag yields RGB rows, which PNG takes as they are.
    let config = PdfRenderConfig::new()
        .set_target_size(to_i32(width)?, to_i32(height)?)
        .set_format(PdfBitmapFormat::BGR)
        .set_reverse_byte_order(true);
    let bitmap = page
        .render_with_config(&config)
        .map_err(|error| AppError::logged(ErrorCode::Internal, format!("{error:?}")))?;

    let (rendered_w, rendered_h) = (bitmap.width(), bitmap.height());
    if (rendered_w, rendered_h) != (to_i32(width)?, to_i32(height)?) {
        return Err(AppError::logged(
            ErrorCode::Internal,
            format!("bitmap is {rendered_w}x{rendered_h}, expected {width}x{height}"),
        ));
    }
    let raw = bitmap.as_raw_bytes();
    drop(bitmap);
    drop(page);

    let stride = raw.len() / height as usize;
    encode::encode_frame(width, height, stride, &raw)
}

fn to_i32(value: u32) -> Result<i32, AppError> {
    // Sizes are bounded by `limits` long before this; only a corrupt page count could get here.
    i32::try_from(value)
        .map_err(|_| AppError::logged(ErrorCode::Internal, "value does not fit a PDFium int"))
}
