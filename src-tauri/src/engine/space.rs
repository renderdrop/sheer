//! Positions inside a document, as PDFium reports them, in the page space of the UI (ADR-003 §1): pages by position, and where on
//! a page a destination lands.

use std::collections::HashMap;

use pdfium_render::prelude::*;

use crate::error::{AppError, ErrorCode};
use crate::model::geometry::PageBox;

/// A place in a document: the position of a page, and how far down it a destination points, in page space (points from the top of
/// the page's box, 0 when the destination does not say).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PageSpot {
    pub page_index: u32,
    pub y: f32,
}

fn damaged(detail: impl std::fmt::Debug) -> AppError {
    AppError::logged(ErrorCode::DamagedFile, format!("{detail:?}"))
}

/// The number of pages of a loaded document.
pub(super) fn page_count(document: &PdfDocument<'_>) -> Result<u32, AppError> {
    u32::try_from(document.pages().len()).map_err(|_| damaged("negative page count"))
}

/// Loads the page at position `index`, which must be below the document's page count (the caller checked).
pub(super) fn load_page<'a>(
    document: &PdfDocument<'a>,
    index: u32,
) -> Result<PdfPage<'a>, AppError> {
    let index = i32::try_from(index).map_err(|_| AppError::invalid("page"))?;
    document.pages().get(index).map_err(damaged)
}

/// Where the box of `page` is in PDF user space: the crop box inside the media box, which is what the page's size and the render
/// are made from. Fails with `damaged_file` for a page whose box PDFium cannot say.
pub(super) fn page_box(page: &PdfPage<'_>) -> Result<PageBox, AppError> {
    let bounds = page.boundaries().bounding().map_err(damaged)?.bounds;
    PageBox::new(bounds.left().value, bounds.top().value)
        .ok_or_else(|| damaged("the page box is not a number"))
}

/// Resolves destinations to places, loading each page it needs once. A document has up to 50 000 pages and an outline up to 10 000
/// destinations, so the boxes are remembered for the length of one read.
#[derive(Default)]
pub(super) struct Spots {
    boxes: HashMap<u32, Option<PageBox>>,
}

impl Spots {
    /// The box of page `index`, `None` if it cannot be read.
    fn page_box(&mut self, document: &PdfDocument<'_>, index: u32) -> Option<PageBox> {
        *self.boxes.entry(index).or_insert_with(|| {
            load_page(document, index)
                .ok()
                .and_then(|page| page_box(&page).ok())
        })
    }

    /// The place `destination` points to, `None` if it names no page of this document (an index outside it is what a destination
    /// in another file, or a damaged one, looks like).
    pub(super) fn resolve(
        &mut self,
        document: &PdfDocument<'_>,
        page_count: u32,
        destination: &PdfDestination<'_>,
    ) -> Option<PageSpot> {
        let page_index = u32::try_from(destination.page_index().ok()?).ok()?;
        if page_index >= page_count {
            return None;
        }
        // The vertical position, in user space, of the views that have one: a point (XYZ), a height (FitH, FitBH) or a rectangle
        // (FitR, whose top is where it lands). The others show the whole page or its width.
        let user_y = match destination.view_settings() {
            Ok(PdfDestinationViewSettings::SpecificCoordinatesAndZoom(_, y, _))
            | Ok(PdfDestinationViewSettings::FitPageHorizontallyToWindow(y))
            | Ok(PdfDestinationViewSettings::FitBoundsHorizontallyToWindow(y)) => {
                y.map(|y| y.value)
            }
            Ok(PdfDestinationViewSettings::FitPageToRectangle(rect)) => Some(rect.top().value),
            _ => None,
        };
        let y = match user_y {
            None => 0.0,
            Some(user_y) => self
                .page_box(document, page_index)?
                .point(0.0, user_y)?
                .y
                // Above the top of the page is the top.
                .max(0.0),
        };
        Some(PageSpot { page_index, y })
    }
}
