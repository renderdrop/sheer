//! `get_outline`: the bookmarks of a document (ARCHITECTURE §5).
//!
//! | Command | Arguments | Returns |
//! |---|---|---|
//! | `get_outline` | `docId: number` | `OutlineNode[]`: `{ title, target: { pageId, y } | null, children, derived }` (`derived`: made from the headings of a document without bookmarks, ADR-113), at most 10 000 nodes down to 32 levels, a title of at most 512 characters |
//!
//! The engine reads the outline with its limits and a guard against cycles (`engine::outline`). The bounds are applied again here, on
//! what is sent, so the UI is promised them whatever the engine hands over; and the engine's page positions become page ids.

use tauri::State;

use super::{blocking, AppState};
use std::collections::HashSet;

use crate::documents::{sanitize_text, DocumentId, PageId};
use crate::engine::OutlineItem;
use crate::error::{AppError, UiError};
use crate::limits;
use crate::model::reading::{OutlineNode, PageTarget};
use crate::smartlinks::index::Status;
use crate::smartlinks::outline as smart_outline;

impl AppState {
    /// The outline of an open document, in document order. Empty if it has none. `not_found` for a document that is not open.
    pub fn outline(&self, id: DocumentId) -> Result<Vec<OutlineNode>, AppError> {
        // Unknown, not yet loaded and closing documents are `not_found` before the engine is asked.
        self.registry.page_count(id)?;
        let items = self.engine.outline(id)?;
        let mut budget = limits::MAX_OUTLINE_NODES;
        let nodes = self.outline_level(id, &items, 1, &mut budget);
        Ok(self.merge_smart_outline(id, nodes))
    }

    /// The outline merged with what the text analysis found (F19.20): the bookmarks of the file stay first and unchanged; the table of
    /// contents entries they lack follow. A file without bookmarks gets the contents entries and detected headings in document order,
    /// as a tree. Uses the smart-link index when it is built (a file without bookmarks starts its build); until then, or when the
    /// analysis finds nothing, `nodes` is returned as it is.
    fn merge_smart_outline(&self, id: DocumentId, nodes: Vec<OutlineNode>) -> Vec<OutlineNode> {
        let bookmarks = nodes.first().is_some_and(|node| !node.derived);
        let Ok(rev) = self.model(id, |state| Ok(state.rev())) else {
            return nodes;
        };
        let Ok(order) = self.registry.page_order(id) else {
            return nodes;
        };
        let ready = if bookmarks {
            self.smart.peek(id, rev)
        } else {
            match self.smart.status(id, rev) {
                Status::Ready(ready) => Some(ready),
                Status::Start(generation) => {
                    self.start_smart_build(id, generation, order.clone(), 0);
                    None
                }
                Status::Building => None,
            }
        };
        let Some(ready) = ready else {
            return nodes;
        };
        let page_id = |position: u32| {
            usize::try_from(position)
                .ok()
                .and_then(|p| order.get(p))
                .map(|&(page, _)| page)
        };
        if bookmarks {
            let mut have = HashSet::new();
            collect_bookmarks(&nodes, &order, &mut have);
            let extra = smart_outline::without(smart_outline::toc_entries(&ready.analysis), &have);
            let mut nodes = nodes;
            let mut budget = limits::MAX_OUTLINE_NODES.saturating_sub(count_nodes(&nodes));
            for entry in extra {
                if budget == 0 {
                    break;
                }
                budget -= 1;
                if let Some(page) = page_id(entry.page) {
                    nodes.push(entry_node(&entry, page, Vec::new()));
                }
            }
            return nodes;
        }
        let entries = ready.analysis.outline.clone();
        if entries.is_empty() {
            return nodes;
        }
        let tree = entry_tree(&entries, &page_id);
        if tree.is_empty() {
            nodes
        } else {
            tree
        }
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
                derived: item.derived,
            });
        }
        nodes
    }
}

fn count_nodes(nodes: &[OutlineNode]) -> usize {
    nodes.iter().map(|n| 1 + count_nodes(&n.children)).sum()
}

/// The (position, normalised title) of every bookmark with a target, to tell which detected entries the file already has.
fn collect_bookmarks(
    nodes: &[OutlineNode],
    order: &[(PageId, u32)],
    out: &mut HashSet<(u32, String)>,
) {
    for node in nodes {
        if let Some(target) = &node.target {
            let position = order
                .iter()
                .position(|&(page, _)| page == target.page_id)
                .and_then(|p| u32::try_from(p).ok());
            if let Some(position) = position {
                out.insert((position, smart_outline::normalize(&node.title)));
            }
        }
        collect_bookmarks(&node.children, order, out);
    }
}

fn entry_node(
    entry: &smart_outline::Entry,
    page: PageId,
    children: Vec<OutlineNode>,
) -> OutlineNode {
    OutlineNode {
        title: sanitize_text(&entry.title, limits::MAX_OUTLINE_TITLE_CHARS),
        target: Some(PageTarget {
            page_id: page,
            y: entry.y,
        }),
        children,
        derived: true,
    }
}

/// The entries (document order, with levels) as a tree: an entry is a child of the nearest earlier entry of a lower level; a jump of
/// more than one level counts as one. Entries whose page is gone are left out.
fn entry_tree(
    entries: &[smart_outline::Entry],
    page_id: &dyn Fn(u32) -> Option<PageId>,
) -> Vec<OutlineNode> {
    // (level, node) stack; finished nodes are attached to their parent when the stack unwinds.
    let mut roots: Vec<OutlineNode> = Vec::new();
    let mut stack: Vec<(u8, OutlineNode)> = Vec::new();
    let attach = |roots: &mut Vec<OutlineNode>,
                  stack: &mut Vec<(u8, OutlineNode)>,
                  node: OutlineNode| match stack.last_mut() {
        Some((_, parent)) => parent.children.push(node),
        None => roots.push(node),
    };
    for entry in entries {
        let Some(page) = page_id(entry.page) else {
            continue;
        };
        let level = entry
            .level
            .clamp(1, u8::try_from(limits::MAX_OUTLINE_DEPTH).unwrap_or(32));
        while let Some(&(top, _)) = stack.last() {
            if top >= level {
                if let Some((_, done)) = stack.pop() {
                    attach(&mut roots, &mut stack, done);
                }
            } else {
                break;
            }
        }
        stack.push((level, entry_node(entry, page, Vec::new())));
    }
    while let Some((_, done)) = stack.pop() {
        attach(&mut roots, &mut stack, done);
    }
    roots
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
            derived: false,
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

    fn entry(page: u32, level: u8, title: &str) -> smart_outline::Entry {
        smart_outline::Entry {
            page,
            y: 10.0,
            title: title.to_owned(),
            level,
        }
    }

    #[test]
    fn detected_entries_become_a_tree_by_level_and_skip_pages_that_are_gone() {
        let entries = vec![
            entry(0, 1, "A"),
            entry(0, 2, "A.1"),
            entry(1, 3, "A.1.a"),
            entry(1, 2, "A.2"),
            entry(2, 1, "B"),
            entry(9, 1, "Gone"),
        ];
        let page = |p: u32| (p < 3).then(|| PageId::new(p));
        let tree = entry_tree(&entries, &page);
        assert_eq!(tree.len(), 2);
        assert_eq!(tree[0].title, "A");
        assert_eq!(tree[0].children.len(), 2);
        assert_eq!(tree[0].children[0].children[0].title, "A.1.a");
        assert_eq!(tree[1].title, "B");
        assert!(tree.iter().all(|n| n.derived));
        assert_eq!(count_nodes(&tree), 5);
    }

    #[test]
    fn a_file_with_bookmarks_keeps_them_and_a_file_with_nothing_built_yet_gets_the_engine_outline()
    {
        // No index is built in the test state: bookmarks come back untouched, and so does an empty outline.
        let (state, id) = state_with_outline(2, vec![item("Chapter 1", Some(0), vec![])]);
        let outline = state.outline(id).unwrap();
        assert_eq!(outline.len(), 1);
        assert!(!outline[0].derived);
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
