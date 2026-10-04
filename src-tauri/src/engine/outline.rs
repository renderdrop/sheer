//! The outline (bookmarks) of a document, read on the worker (ARCHITECTURE §5, `get_outline`).
//!
//! The outline is a linked structure of the file (`/First`, `/Next`) that a hostile file can make a cycle, a ladder a million levels
//! deep or a list of a million siblings. It is read depth first with a set of the bookmarks already read: a chain that comes
//! back to one of them ends there, so a cycle (a `/Next` that points to an earlier sibling, a `/First` that points to an
//! ancestor) cannot make the read go on. At most `limits::MAX_OUTLINE_NODES` bookmarks are read, down to
//! `limits::MAX_OUTLINE_DEPTH` levels; what is beyond is left out, and so are the children of a bookmark on the last level.

use std::collections::HashSet;

use pdfium_render::prelude::*;

use super::space::{PageSpot, Spots};
use crate::documents::sanitize_text;
use crate::limits;

/// A bookmark: its title as the UI may show it (`documents::sanitize_text`, at most `limits::MAX_OUTLINE_TITLE_CHARS` characters),
/// the place it goes to if it goes to a page of this document, and its children.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct OutlineItem {
    pub title: String,
    pub target: Option<PageSpot>,
    pub children: Vec<OutlineItem>,
    /// Derived from the look of the text (`derived_outline`), not a bookmark of the file.
    #[serde(default)]
    pub derived: bool,
}

/// The title of a bookmark as the UI may show it: line breaks and tabs become spaces (a title is one line), then the filter that
/// every string of a document gets, then at most `MAX_OUTLINE_TITLE_CHARS` characters.
fn title_for_ui(raw: &str) -> String {
    let one_line = raw.replace(['\r', '\n', '\t'], " ");
    sanitize_text(one_line.trim(), limits::MAX_OUTLINE_TITLE_CHARS)
        .trim()
        .to_owned()
}

struct Walk<'d, 'a> {
    document: &'d PdfDocument<'a>,
    page_count: u32,
    spots: Spots,
    /// The bookmarks read so far (by identity: two handles of one bookmark are equal), which is what ends a cycle.
    read: HashSet<PdfBookmark<'d>>,
}

impl<'d> Walk<'d, '_> {
    /// Reads the bookmark `first` and the ones that follow it on its level, with their children. `depth` is 1 for the top level.
    fn level(&mut self, first: Option<PdfBookmark<'d>>, depth: usize) -> Vec<OutlineItem> {
        let mut items = Vec::new();
        let mut next = first;
        while let Some(bookmark) = next {
            if self.read.len() >= limits::MAX_OUTLINE_NODES || !self.read.insert(bookmark.clone()) {
                break;
            }
            let children = if depth < limits::MAX_OUTLINE_DEPTH {
                self.level(bookmark.first_child(), depth + 1)
            } else {
                Vec::new()
            };
            items.push(OutlineItem {
                title: bookmark
                    .title()
                    .map(|raw| title_for_ui(&raw))
                    .unwrap_or_default(),
                target: self.target(&bookmark),
                children,
                derived: false,
            });
            next = bookmark.next_sibling();
        }
        items
    }

    /// The page a bookmark goes to. A bookmark that does something else (opens a URL, a file, another document) has no target, and
    /// one whose action is a jump to another document is not mistaken for a jump in this one: PDFium reads the destination of such
    /// an action too, and its page number is a page of the other file.
    fn target(&mut self, bookmark: &PdfBookmark<'d>) -> Option<PageSpot> {
        if bookmark.action().is_some_and(|action| {
            action.action_type() != PdfActionType::GoToDestinationInSameDocument
        }) {
            return None;
        }
        let destination = bookmark.destination()?;
        self.spots
            .resolve(self.document, self.page_count, &destination)
    }
}

/// The outline of `document` (`page_count` pages): the top level bookmarks, in order; for a document without bookmarks the one
/// derived from its headings (`derived_outline`). Empty if there is none.
pub(super) fn read_outline(document: &PdfDocument<'_>, page_count: u32) -> Vec<OutlineItem> {
    let mut walk = Walk {
        document,
        page_count,
        spots: Spots::default(),
        read: HashSet::new(),
    };
    let real = walk.level(document.bookmarks().root(), 1);
    // The bookmarks of the file always win; the heuristic runs only for a document that has none.
    if real.is_empty() {
        super::derived_outline::derive_outline(document, page_count)
    } else {
        real
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_title_is_one_line_without_characters_that_reorder_or_hide_text_and_is_cut_at_the_limit() {
        assert_eq!(title_for_ui("Chapter 1"), "Chapter 1");
        assert_eq!(title_for_ui("  Chapter\r\n1\t "), "Chapter  1");
        assert_eq!(title_for_ui("gpj\u{202e}fdp.exe"), "gpjfdp.exe");
        assert_eq!(title_for_ui("\u{200b}\u{7}"), "");
        let long = "x".repeat(limits::MAX_OUTLINE_TITLE_CHARS + 100);
        assert_eq!(
            title_for_ui(&long).chars().count(),
            limits::MAX_OUTLINE_TITLE_CHARS
        );
    }
}
