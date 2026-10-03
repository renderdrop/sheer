//! `get_outline`: the bookmarks of a document (ARCHITECTURE §5).
//!
//! | Command | Arguments | Returns |
//! |---|---|---|
//! | `get_outline` | `docId: number` | `OutlineNode[]`: `{ title, target: { pageId, y } | null, children }`, at most 10 000 nodes down to 32 levels, a title of at most 512 characters |
//!
//! The engine reads the outline with its limits and a guard against cycles (`engine::outline`). The bounds are applied again here, on
//! what is sent, so the UI is promised them whatever the engine hands over; and the engine's page positions become page ids.

use tauri::State;

use super::{blocking, AppState};
use crate::documents::{sanitize_text, DocumentId};
use crate::engine::OutlineItem;
use crate::error::{AppError, UiError};
use crate::limits;
use crate::model::reading::{OutlineNode, PageTarget};

impl AppState {
    /// The outline of an open document, in document order. Empty if it has none. `not_found` for a document that is not open.
    pub fn outline(&self, id: DocumentId) -> Result<Vec<OutlineNode>, AppError> {
        // Unknown, not yet loaded and closing documents are `not_found` before the engine is asked.
        self.registry.page_count(id)?;
        let items = self.engine.outline(id)?;
        let mut budget = limits::MAX_OUTLINE_NODES;
        Ok(self.outline_level(id, &items, 1, &mut budget))
    }

    /// The nodes of one level and their children, as far as `budget` nodes and `MAX_OUTLINE_DEPTH` levels allow.
    fn outline_level(
        &self,
        id: DocumentId,
        items: &[OutlineItem],
        depth: usize,
        budget: &mut usize,
    ) -> Vec<OutlineNode> {
        let mut nodes = Vec::new();
        for item in items {
            if *budget == 0 {
                break;
            }
            *budget -= 1;
            let target = item.target.and_then(|spot| {
                let page_id = self.registry.page_id(id, spot.page_index).ok()?;
                Some(PageTarget { page_id, y: spot.y })
            });
            let children = if depth < limits::MAX_OUTLINE_DEPTH {
                self.outline_level(id, &item.children, depth + 1, budget)
            } else {
                Vec::new()
            };
            nodes.push(OutlineNode {
                title: sanitize_text(&item.title, limits::MAX_OUTLINE_TITLE_CHARS),
                target,
                children,
            });
        }
        nodes
    }
}

/// The outline of a document: titles as text only (they come from the file), where each goes, and its children.
#[tauri::command]
pub async fn get_outline(
    state: State<'_, AppState>,
    doc_id: DocumentId,
) -> Result<Vec<OutlineNode>, UiError> {
    let state = state.inner().clone();
    blocking(move || state.outline(doc_id)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::testutil::state_with_pages;
    use crate::documents::PageId;
    use crate::engine::{Job, PageSpot};
    use crate::error::ErrorCode;

    fn item(title: &str, page: Option<u32>, children: Vec<OutlineItem>) -> OutlineItem {
        OutlineItem {
            title: title.to_owned(),
            target: page.map(|page_index| PageSpot {
                page_index,
                y: 12.5,
            }),
            children,
        }
    }

    /// A state whose engine answers `get_outline` with `items`.
    fn state_with_outline(pages: u32, items: Vec<OutlineItem>) -> (AppState, DocumentId) {
        state_with_pages(pages, move |job| {
            if let Job::Outline { reply, .. } = job {
                let _ = reply.send(Ok(items.clone()));
            }
        })
    }

    fn count(nodes: &[OutlineNode]) -> usize {
        nodes.iter().map(|node| 1 + count(&node.children)).sum()
    }

    fn depth(nodes: &[OutlineNode]) -> usize {
        nodes
            .iter()
            .map(|node| 1 + depth(&node.children))
            .max()
            .unwrap_or(0)
    }

    #[test]
    fn the_engines_places_become_page_ids_and_the_order_and_nesting_are_kept() {
        let (state, id) = state_with_outline(
            3,
            vec![
                item("Chapter 1", Some(0), vec![item("Section", Some(2), vec![])]),
                item("Website", None, vec![]),
            ],
        );
        let outline = state.outline(id).unwrap();
        assert_eq!(outline.len(), 2);
        assert_eq!(outline[0].title, "Chapter 1");
        assert_eq!(
            outline[0].target,
            Some(PageTarget {
                page_id: PageId::new(0),
                y: 12.5
            })
        );
        assert_eq!(outline[0].children[0].title, "Section");
        assert_eq!(
            outline[0].children[0].target.unwrap().page_id,
            PageId::new(2)
        );
        assert_eq!(outline[1].target, None);
    }

    #[test]
    fn a_target_that_is_not_a_page_of_the_document_is_no_target() {
        // The engine named a page the registry does not have: the node stays, without a target.
        let (state, id) = state_with_outline(2, vec![item("Far away", Some(5), vec![])]);
        let outline = state.outline(id).unwrap();
        assert_eq!(outline.len(), 1);
        assert_eq!(outline[0].target, None);
    }

    #[test]
    fn at_most_10_000_nodes_are_sent_whatever_the_engine_hands_over() {
        let flat: Vec<OutlineItem> = (0..limits::MAX_OUTLINE_NODES + 500)
            .map(|n| item(&format!("Item {n}"), Some(0), vec![]))
            .collect();
        let (state, id) = state_with_outline(1, flat);
        let outline = state.outline(id).unwrap();
        assert_eq!(count(&outline), limits::MAX_OUTLINE_NODES);
        assert_eq!(outline[0].title, "Item 0", "the first ones are kept");

        // The children count against the same budget, depth first.
        let nested: Vec<OutlineItem> = (0..200)
            .map(|n| {
                let children = (0..100)
                    .map(|c| item(&format!("{n}.{c}"), None, vec![]))
                    .collect();
                item(&format!("Parent {n}"), None, children)
            })
            .collect();
        let (state, id) = state_with_outline(1, nested);
        assert_eq!(
            count(&state.outline(id).unwrap()),
            limits::MAX_OUTLINE_NODES
        );
    }

    #[test]
    fn nothing_deeper_than_32_levels_is_sent() {
        let mut ladder = item("Level 100", None, vec![]);
        for level in (1..100).rev() {
            ladder = item(&format!("Level {level}"), None, vec![ladder]);
        }
        let (state, id) = state_with_outline(1, vec![ladder]);
        let outline = state.outline(id).unwrap();
        assert_eq!(depth(&outline), limits::MAX_OUTLINE_DEPTH);
    }

    #[test]
    fn a_title_is_cut_to_512_characters_and_has_no_characters_that_reorder_text() {
        let long = "A".repeat(limits::MAX_OUTLINE_TITLE_CHARS + 200);
        let (state, id) = state_with_outline(
            1,
            vec![
                item(&long, None, vec![]),
                item("gpj\u{202e}fdp\u{200b}.exe", None, vec![]),
            ],
        );
        let outline = state.outline(id).unwrap();
        assert_eq!(
            outline[0].title.chars().count(),
            limits::MAX_OUTLINE_TITLE_CHARS
        );
        assert_eq!(outline[1].title, "gpjfdp.exe");
    }

    #[test]
    fn an_unknown_or_loading_document_is_not_found_before_the_engine_is_asked() {
        let asked = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let seen = std::sync::Arc::clone(&asked);
        let (state, _) = state_with_pages(1, move |_| {
            seen.store(true, std::sync::atomic::Ordering::SeqCst);
        });
        let loading = state
            .registry
            .register(std::path::PathBuf::from("loading.pdf"))
            .unwrap();
        let unknown: DocumentId = serde_json::from_str("999").unwrap();
        for id in [loading, unknown] {
            assert_eq!(state.outline(id).unwrap_err().code(), ErrorCode::NotFound);
        }
        assert!(!asked.load(std::sync::atomic::Ordering::SeqCst));
    }
}
