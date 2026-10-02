//! The worker thread. The only code that touches PDFium.

use std::collections::HashMap;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::Path;
use std::sync::mpsc::Receiver;

use pdfium_render::prelude::*;

use super::{encode, limits, Request};
use crate::documents::DocumentId;
use crate::error::{AppError, ErrorCode};

type Documents<'a> = HashMap<DocumentId, PdfDocument<'a>>;

/// Worker entry point: binds PDFium, then serves requests until every `Engine` handle is gone.
pub(super) fn run(library: &Path, requests: Receiver<Request>) {
    let bindings = match Pdfium::bind_to_library(library) {
        Ok(bindings) => bindings,
        Err(error) => {
            eprintln!("sheer: could not load the PDFium library: {error}");
            for request in requests {
                request.fail(AppError::new(ErrorCode::EngineUnavailable));
            }
            return;
        }
    };
    // `documents` borrows `pdfium`, so it must be declared after it (drop order: documents first).
    let pdfium = Pdfium::new(bindings);
    let mut documents: Documents<'_> = HashMap::new();

    for request in requests {
        match request {
            Request::Open { id, path, reply } => {
                let result = guarded(|| open(&pdfium, &mut documents, id, &path));
                // The caller may have timed out and dropped its receiver.
                let _ = reply.send(result);
            }
            Request::Render {
                id,
                page_index,
                scale,
                reply,
            } => {
                let result = guarded(|| match documents.get(&id) {
                    Some(document) => render(document, page_index, scale),
                    None => Err(ErrorCode::UnknownDocument.into()),
                });
                let _ = reply.send(result);
            }
            Request::Close { id, reply } => {
                documents.remove(&id);
                let _ = reply.send(Ok(()));
            }
        }
    }
}

/// Runs one request body and turns a panic into an error so the worker survives it.
fn guarded<T>(body: impl FnOnce() -> Result<T, AppError>) -> Result<T, AppError> {
    catch_unwind(AssertUnwindSafe(body))
        .unwrap_or_else(|_| Err(AppError::logged(ErrorCode::Internal, "panic in PDF engine")))
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
        .map_err(|_| AppError::logged(ErrorCode::InvalidPdf, "negative page count"))?;
    documents.insert(id, document);
    Ok(page_count)
}

fn map_load_error(error: PdfiumError) -> AppError {
    use PdfiumInternalError as Internal;
    match error {
        PdfiumError::PdfiumLibraryInternalError(Internal::FormatError) => {
            AppError::new(ErrorCode::InvalidPdf)
        }
        PdfiumError::PdfiumLibraryInternalError(Internal::PasswordError) => {
            AppError::new(ErrorCode::PasswordRequired)
        }
        PdfiumError::PdfiumLibraryInternalError(Internal::SecurityError) => {
            AppError::new(ErrorCode::Unsupported)
        }
        PdfiumError::PdfiumLibraryInternalError(Internal::FileError) | PdfiumError::IoError(_) => {
            AppError::logged(ErrorCode::FileUnreadable, format!("{error:?}"))
        }
        other => AppError::logged(ErrorCode::Internal, format!("{other:?}")),
    }
}

/// Renders one page to PNG. Validates against the real page size before allocating the bitmap.
fn render(document: &PdfDocument<'_>, page_index: u32, scale: f32) -> Result<Vec<u8>, AppError> {
    let scale = limits::validate_scale(scale)?;
    let page_count = u32::try_from(document.pages().len())
        .map_err(|_| AppError::logged(ErrorCode::InvalidPdf, "negative page count"))?;
    let index = limits::validate_page_index(page_index, page_count)?;
    let page = document
        .pages()
        .get(to_i32(index)?)
        .map_err(|error| AppError::logged(ErrorCode::InvalidPdf, format!("{error:?}")))?;

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
    encode::encode_rgb(width, height, stride, &raw)
}

fn to_i32(value: u32) -> Result<i32, AppError> {
    i32::try_from(value).map_err(|_| AppError::new(ErrorCode::RenderTooLarge))
}
