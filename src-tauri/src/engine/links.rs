//! The links of a page, read on the worker (ARCHITECTURE §5, `get_page_links`, `open_link`). Nothing is ever followed here: a link
//! is read as data, and what a PDF can ask for is sorted by what the app is willing to do about it (SECURITY P2, P3).
//!
//! A link goes to a page of this document, to a URL that `security::links` lets through, or nowhere that the app will go: a jump
//! to another file (`GoToR`, `GoToE`), a program to launch, JavaScript, anything PDFium does not know, a URL that is not plain
//! `http`, `https` or `mailto`, a destination that names no page. That last kind is [`LinkTarget::Blocked`], and the UI shows the
//! link as one that does nothing.
//!
//! Links are the page's link annotations, in the order of its `/Annots`, and a link's index is its position among them, so the
//! same page read twice gives the same indices (`open_link` relies on it). The first `limits::MAX_PAGE_LINKS` are read, out of the
//! first `10 * MAX_PAGE_LINKS` annotations of the page.

use pdfium_render::prelude::*;

use super::space::{load_page, page_box, PageSpot, Spots};
use crate::error::AppError;
use crate::limits;
use crate::model::geometry::Rect;
use crate::security::links::{classify, SafeUrl};

/// Where a link goes.
#[derive(Debug, Clone, PartialEq)]
pub enum LinkTarget {
    Page(PageSpot),
    Url(SafeUrl),
    Blocked,
}

/// A link of a page.
#[derive(Debug, Clone, PartialEq)]
pub struct PageLink {
    pub rect: Rect,
    pub target: LinkTarget,
}

/// Annotations looked at per link that may be found: most annotations of a page are not links, but a page with more than this many
/// before the thousandth link is not one to read to the end.
const ANNOTATIONS_PER_LINK: usize = 10;

/// Where `link` goes.
fn target_of(
    link: &PdfLink<'_>,
    document: &PdfDocument<'_>,
    page_count: u32,
    spots: &mut Spots,
) -> LinkTarget {
    match link.action() {
        // A jump in this document.
        Some(action) if action.action_type() == PdfActionType::GoToDestinationInSameDocument => {
            link.destination()
                .and_then(|destination| spots.resolve(document, page_count, &destination))
                .map_or(LinkTarget::Blocked, LinkTarget::Page)
        }
        // A web or mail address, if it is one the app opens.
        Some(PdfAction::Uri(action)) => action
            .uri()
            .ok()
            .and_then(|uri| classify(&uri))
            .map_or(LinkTarget::Blocked, LinkTarget::Url),
        // Launch, a jump to another file, JavaScript and everything else.
        Some(_) => LinkTarget::Blocked,
        // No action: the link has a destination of its own (`/Dest`), or nothing.
        None => link
            .destination()
            .and_then(|destination| spots.resolve(document, page_count, &destination))
            .map_or(LinkTarget::Blocked, LinkTarget::Page),
    }
}

/// Reads the links of page `index` (below `page_count`, the caller checked).
pub(super) fn read_links(
    document: &PdfDocument<'_>,
    page_count: u32,
    index: u32,
) -> Result<Vec<PageLink>, AppError> {
    let page = load_page(document, index)?;
    let page_box = page_box(&page)?;
    let annotations = page.annotations();
    let scanned = annotations
        .len()
        .min(limits::MAX_PAGE_LINKS * ANNOTATIONS_PER_LINK);

    let mut spots = Spots::default();
    let mut links = Vec::new();
    for position in 0..scanned {
        if links.len() >= limits::MAX_PAGE_LINKS {
            break;
        }
        let Ok(annotation) = annotations.get(position) else {
            continue;
        };
        let Some(link_annotation) = annotation.as_link_annotation() else {
            continue;
        };
        let Ok(link) = link_annotation.link() else {
            continue;
        };
        // A link without an area cannot be clicked.
        let Some(rect) = link.rect().ok().and_then(|bounds| {
            page_box.rect(
                bounds.left().value,
                bounds.bottom().value,
                bounds.right().value,
                bounds.top().value,
            )
        }) else {
            continue;
        };
        links.push(PageLink {
            rect,
            target: target_of(&link, document, page_count, &mut spots),
        });
    }
    Ok(links)
}
