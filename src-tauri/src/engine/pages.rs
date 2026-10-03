//! Keeping PDFium's copy of a document in step with the page commands (ADR-036 §3). Only the worker calls this.
//!
//! The copy is append-only: a rotation is set on the page, a blank page or pages of an import source are added at the end, and nothing is
//! deleted or moved, so the engine index of a page never changes and the caches keyed by it stay valid. The model decides what the document
//! is; the engine only has to be able to draw it.

use std::sync::Arc;

use pdfium_render::prelude::*;

use super::import::read_annotations;
use crate::error::{AppError, ErrorCode};
use crate::limits;
use crate::model::annotation::Imported;
use crate::model::page::unrotated;

/// A page the engine's copy gained: where it is, its size before rotation and the rotation it came with.
#[derive(Debug, Clone, PartialEq)]
pub struct Appended {
    pub engine_index: u32,
    pub size: [f32; 2],
    pub rotation: u16,
    /// The annotations the page came with, read from the engine's copy (as `import::read_annotations` does for a page of the file).
    /// `None`: not read (a blank page, or the read failed or went over the budget), so the model reads the page later like any other.
    pub annotations: Option<Vec<Imported>>,
}

fn internal(error: PdfiumError) -> AppError {
    AppError::logged(ErrorCode::Internal, format!("{error:?}"))
}

fn degrees(page: &PdfPage<'_>) -> u16 {
    match page.rotation() {
        Ok(PdfPageRenderRotation::Degrees90) => 90,
        Ok(PdfPageRenderRotation::Degrees180) => 180,
        Ok(PdfPageRenderRotation::Degrees270) => 270,
        _ => 0,
    }
}

fn render_rotation(degrees: u16) -> PdfPageRenderRotation {
    match degrees % 360 {
        90 => PdfPageRenderRotation::Degrees90,
        180 => PdfPageRenderRotation::Degrees180,
        270 => PdfPageRenderRotation::Degrees270,
        _ => PdfPageRenderRotation::None,
    }
}

/// The `/Rotate` of every page, read when the document is loaded. A page PDFium cannot load counts as 0.
pub(super) fn read_rotations(document: &PdfDocument<'_>) -> Arc<[u16]> {
    let pages = document.pages();
    (0..pages.len())
        .map(|index| pages.get(index).map_or(0, |page| degrees(&page)))
        .collect()
}

/// Sets the rotation of the given engine pages (`(engine index, degrees)`); nothing is set if one of them does not exist.
pub(super) fn set_rotations(
    document: &PdfDocument<'_>,
    items: &[(u32, u16)],
) -> Result<(), AppError> {
    let pages = document.pages();
    if items
        .iter()
        .any(|(index, _)| *index >= u32::try_from(pages.len()).unwrap_or(0))
    {
        return Err(AppError::invalid("page"));
    }
    for (index, turn) in items {
        let index = i32::try_from(*index).map_err(|_| AppError::invalid("page"))?;
        let mut page = pages.get(index).map_err(internal)?;
        page.set_rotation(render_rotation(*turn));
    }
    Ok(())
}

/// How many pages the copy holds, deleted and moved ones included.
fn engine_pages(document: &PdfDocument<'_>) -> u32 {
    u32::try_from(document.pages().len()).unwrap_or(0)
}

fn room(document: &PdfDocument<'_>, more: usize) -> Result<(), AppError> {
    let after = u64::from(engine_pages(document)) + more as u64;
    if after > u64::from(limits::MAX_ENGINE_PAGES) {
        return Err(AppError::limit(
            "pages",
            u64::from(limits::MAX_ENGINE_PAGES),
        ));
    }
    Ok(())
}

/// The page just added at `index`, as the model needs to know it.
fn appended(document: &PdfDocument<'_>, index: u32) -> Result<Appended, AppError> {
    let index16 = i32::try_from(index).map_err(|_| AppError::invalid("pages"))?;
    let page = document.pages().get(index16).map_err(internal)?;
    let rotation = degrees(&page);
    let drawn = limits::sanitize_page_size(page.width().value, page.height().value);
    Ok(Appended {
        engine_index: index,
        size: unrotated(drawn, rotation),
        rotation,
        annotations: None,
    })
}

/// Adds an empty page of `size` points at the end.
pub(super) fn append_blank(
    document: &mut PdfDocument<'_>,
    size: [f32; 2],
) -> Result<Appended, AppError> {
    room(document, 1)?;
    let index = engine_pages(document);
    let page = document
        .pages_mut()
        .create_page_at_end(PdfPagePaperSize::Custom(
            PdfPoints::new(size[0]),
            PdfPoints::new(size[1]),
        ))
        .map_err(internal)?;
    drop(page);
    appended(document, index)
}

/// Takes the pages from `keep` to the end off the copy again (an insert the model refused). Only if the copy still has `total` pages: pages
/// added after the ones to take back are not this call's to remove, and then nothing is done.
pub(super) fn truncate(
    document: &mut PdfDocument<'_>,
    keep: u32,
    total: u32,
) -> Result<(), AppError> {
    if engine_pages(document) != total || keep >= total {
        return Ok(());
    }
    for index in (keep..total).rev() {
        let index = i32::try_from(index).map_err(|_| AppError::invalid("pages"))?;
        document
            .pages()
            .get(index)
            .and_then(PdfPage::delete)
            .map_err(|error| {
                // Half of the pages are gone: the copy matches nothing the model knows. The worker drops the document for
                // `engine_crashed` and the UI opens it again.
                AppError::logged(
                    ErrorCode::EngineCrashed,
                    format!("taking pages back failed: {error}"),
                )
            })?;
    }
    Ok(())
}

/// Copies pages `indices` of the PDF in `source` to the end, in that order. An encrypted source, one that does not load, or an index that
/// the source does not have fails before anything is added.
pub(super) fn append_pages(
    pdfium: &Pdfium,
    document: &mut PdfDocument<'_>,
    source: &[u8],
    indices: &[u32],
) -> Result<Vec<Appended>, AppError> {
    room(document, indices.len())?;
    let from = pdfium
        .load_pdf_from_byte_slice(source, None)
        .map_err(|error| match error {
            PdfiumError::PdfiumLibraryInternalError(
                PdfiumInternalError::PasswordError | PdfiumInternalError::SecurityError,
            ) => AppError::new(ErrorCode::UnsupportedFeature),
            PdfiumError::PdfiumLibraryInternalError(PdfiumInternalError::FormatError) => {
                AppError::new(ErrorCode::NotAPdf)
            }
            other => internal(other),
        })?;
    let available = u32::try_from(from.pages().len()).unwrap_or(0);
    if indices.iter().any(|index| *index >= available) {
        return Err(AppError::invalid("pages"));
    }
    let start = engine_pages(document);
    let result = copy_pages(document, &from, indices);
    if result.is_err() {
        // A copy that failed half way leaves no pages behind: the model never heard of them.
        let total = engine_pages(document);
        if let Err(error) = truncate(document, start, total) {
            error.log();
            return Err(error);
        }
    }
    result
}

/// The loop of [`append_pages`]: copies `indices` of `from` to the end of the copy.
fn copy_pages(
    document: &mut PdfDocument<'_>,
    from: &PdfDocument<'_>,
    indices: &[u32],
) -> Result<Vec<Appended>, AppError> {
    let mut added = Vec::with_capacity(indices.len());
    let mut read_total = 0usize;
    for index in indices {
        let at = engine_pages(document);
        let source_index = i32::try_from(*index).map_err(|_| AppError::invalid("pages"))?;
        let destination = i32::try_from(at).map_err(|_| AppError::invalid("pages"))?;
        document
            .pages_mut()
            .copy_page_from_document(from, source_index, destination)
            .map_err(internal)?;
        let mut page = appended(document, at)?;
        // Read here, in the worker, from the copy just made: the positions are those the hide/show commands use later. A read that
        // fails leaves the page for a later read; so does a document that already brought as many as the model will take.
        if read_total < limits::MAX_ANNOTATIONS_PER_DOC {
            page.annotations = read_annotations(document, at).ok();
            read_total += page.annotations.as_ref().map_or(0, Vec::len);
        }
        added.push(page);
    }
    Ok(added)
}

/// Sets the CropBox of engine page `engine_index` (`crop` in user space `[x0, y0, x1, y1]`) in PDFium's copy, so that renders, the text
/// layer and the page size follow (ADR-047 §2). Package B.
pub(super) fn set_crop_box(
    _document: &PdfDocument<'_>,
    _engine_index: u32,
    _crop: [f32; 4],
) -> Result<(), AppError> {
    Err(AppError::not_yet())
}
