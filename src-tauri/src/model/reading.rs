//! What the UI is told about the content of a document: its outline, the text of a page, the hits of a search and the links of a
//! page (ARCHITECTURE §5). Everything is in page space (`geometry`) and by page id, serialized in camelCase.
//!
//! Strings that came from the file (outline titles, link URLs) have been through the rules of `documents::sanitize_text` and
//! `security::links` before they get here, and the UI shows them as text only (SECURITY P7).

use serde::{Deserialize, Serialize};

use super::geometry::{Quad, Rect};
use crate::documents::PageId;
use crate::error::UiError;

/// A place on a page: the page and how far down it, in points from the top of the page's box.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageTarget {
    pub page_id: PageId,
    pub y: f32,
}

/// One entry of the outline. `target` is where it goes if that is a page of this document, `None` for an entry that opens something
/// else, or only groups its children.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlineNode {
    pub title: String,
    pub target: Option<PageTarget>,
    pub children: Vec<OutlineNode>,
    /// Derived from the headings of the text, not a bookmark of the file (ADR-113).
    pub derived: bool,
}

/// The text of a page and the box of each character: `boxes` holds four numbers (x, y, width, height, in page space) for every UTF-16
/// code unit of `text`, so `text[i]` is in `boxes[4 * i..4 * i + 4]` as JavaScript counts. `truncated`: the page has more text than
/// `limits::MAX_TEXT_CHARS`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextLayer {
    pub text: String,
    pub boxes: Vec<f32>,
    pub truncated: bool,
    /// The page's own `/Rotate` in degrees (0, 90, 180 or 270): the boxes are in page space, before it.
    pub rotation: u16,
}

/// Where a link goes. On the wire an object with a `type`: `page` (with `pageId`, `y`), `url` (with the `url`, plain `http`, `https`
/// or `mailto`, see `security::links`) or `blocked` (a link that does something the app does not do: a jump to another file, a program
/// to launch, JavaScript, any other URL).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum LinkTarget {
    Page { page_id: PageId, y: f32 },
    Url { url: String },
    Blocked,
}

/// A link of a page: its place in the page's list (`open_link` names it by that), where it can be clicked and where it goes.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkInfo {
    pub index: u32,
    pub rect: Rect,
    pub target: LinkTarget,
}

/// What to search for (`search`'s argument). On the wire an object in camelCase; a missing or unknown field is an error.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SearchQuery {
    /// 1 to `limits::MAX_SEARCH_QUERY_CHARS` characters.
    pub text: String,
    /// Upper and lower case are different letters.
    pub match_case: bool,
    /// A hit is a whole word.
    pub whole_word: bool,
    /// The search stops at this many hits (1 to `limits::MAX_SEARCH_HITS`).
    pub max_hits: u32,
}

/// One message of a search, on the channel the UI passed to `search`. On the wire an object with a `type`:
///
/// | `type` | other fields | when |
/// |---|---|---|
/// | `hits` | `pageId`, `hits`: for each hit the quads of the text it covers | a page that has hits was searched; pages in page order, hits in reading order |
/// | `progress` | `done`, `total`: pages | some pages were searched (not after every page: at most every 100 ms, and once at the end) |
/// | `done` | `truncated` | the search is over; `truncated`: it stopped at `maxHits`, so there may be more |
/// | `failed` | `code`, `key`, `retryable`, `params?` of the error model | the search could not go on (the engine is not working); no `done` follows |
///
/// A search that was cancelled (by `cancel_search`, a new search of the document or the closing of the document) sends nothing more.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SearchEvent {
    Hits {
        page_id: PageId,
        hits: Vec<Vec<Quad>>,
    },
    Progress {
        done: u32,
        total: u32,
    },
    Done {
        truncated: bool,
    },
    Failed {
        #[serde(flatten)]
        error: UiError,
    },
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::error::{AppError, ErrorCode};
    use crate::model::geometry::Point;

    fn wire<T: Serialize>(value: &T) -> serde_json::Value {
        serde_json::to_value(value).unwrap()
    }

    #[test]
    fn an_outline_node_has_the_wire_shape_the_frontend_parses() {
        let node = OutlineNode {
            title: "Chapter 1".to_owned(),
            target: Some(PageTarget {
                page_id: PageId::new(2),
                y: 100.5,
            }),
            children: vec![OutlineNode {
                title: "Web".to_owned(),
                target: None,
                children: Vec::new(),
                derived: false,
            }],
            derived: true,
        };
        assert_eq!(
            wire(&node),
            json!({
                "title": "Chapter 1",
                "target": { "pageId": 2, "y": 100.5 },
                "children": [{ "title": "Web", "target": null, "children": [], "derived": false }],
                "derived": true
            })
        );
    }

    #[test]
    fn a_text_layer_and_a_link_have_the_wire_shape_the_frontend_parses() {
        let layer = TextLayer {
            text: "ab".to_owned(),
            boxes: vec![1.0, 2.0, 3.0, 4.0, 5.0, 2.0, 3.0, 4.0],
            truncated: false,
            rotation: 90,
        };
        assert_eq!(
            wire(&layer),
            json!({ "text": "ab", "boxes": [1.0, 2.0, 3.0, 4.0, 5.0, 2.0, 3.0, 4.0], "truncated": false, "rotation": 90 })
        );
        let rect = Rect {
            x: 1.0,
            y: 2.0,
            w: 3.0,
            h: 4.0,
        };
        let link = |target| LinkInfo {
            index: 7,
            rect,
            target,
        };
        assert_eq!(
            wire(&link(LinkTarget::Page {
                page_id: PageId::new(1),
                y: 5.0
            })),
            json!({ "index": 7, "rect": { "x": 1.0, "y": 2.0, "w": 3.0, "h": 4.0 },
                    "target": { "type": "page", "pageId": 1, "y": 5.0 } })
        );
        assert_eq!(
            wire(&link(LinkTarget::Url {
                url: "https://example.com/".to_owned()
            }))["target"],
            json!({ "type": "url", "url": "https://example.com/" })
        );
        assert_eq!(
            wire(&link(LinkTarget::Blocked))["target"],
            json!({ "type": "blocked" })
        );
    }

    #[test]
    fn search_events_have_the_wire_shape_the_frontend_parses() {
        let point = |x, y| Point { x, y };
        let quad = [
            point(1.0, 2.0),
            point(3.0, 2.0),
            point(1.0, 4.0),
            point(3.0, 4.0),
        ];
        assert_eq!(
            wire(&SearchEvent::Hits {
                page_id: PageId::new(3),
                hits: vec![vec![quad]]
            }),
            json!({ "type": "hits", "pageId": 3, "hits": [[[
                { "x": 1.0, "y": 2.0 }, { "x": 3.0, "y": 2.0 }, { "x": 1.0, "y": 4.0 }, { "x": 3.0, "y": 4.0 }
            ]]] })
        );
        assert_eq!(
            wire(&SearchEvent::Progress { done: 4, total: 9 }),
            json!({ "type": "progress", "done": 4, "total": 9 })
        );
        assert_eq!(
            wire(&SearchEvent::Done { truncated: true }),
            json!({ "type": "done", "truncated": true })
        );
        let failed = SearchEvent::Failed {
            error: UiError::from(AppError::new(ErrorCode::EngineCrashed)),
        };
        assert_eq!(
            wire(&failed),
            json!({ "type": "failed", "code": "engine_crashed", "key": "error.engine_crashed", "retryable": false })
        );
    }

    #[test]
    fn a_search_query_is_read_from_camel_case_and_refuses_what_it_does_not_know() {
        let query: SearchQuery = serde_json::from_value(
            json!({ "text": "über", "matchCase": true, "wholeWord": false, "maxHits": 100 }),
        )
        .unwrap();
        assert_eq!(
            query,
            SearchQuery {
                text: "über".to_owned(),
                match_case: true,
                whole_word: false,
                max_hits: 100
            }
        );
        for bad in [
            json!({ "text": "a", "matchCase": true, "wholeWord": false, "maxHits": 1, "path": "x" }),
            json!({ "text": "a", "matchCase": true, "wholeWord": false }),
            json!({ "text": "a", "match_case": true, "whole_word": false, "max_hits": 1 }),
            json!({ "text": 1, "matchCase": true, "wholeWord": false, "maxHits": 1 }),
            json!({ "text": "a", "matchCase": true, "wholeWord": false, "maxHits": -1 }),
            json!({ "text": "a", "matchCase": true, "wholeWord": false, "maxHits": 1.5 }),
        ] {
            assert!(
                serde_json::from_value::<SearchQuery>(bad.clone()).is_err(),
                "{bad}"
            );
        }
    }
}
