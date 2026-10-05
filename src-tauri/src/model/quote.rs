//! Citations as the model has them (ADR-119): the cite record of a Highlight, and the shapes of `create_citations` and `list_citations`.
//!
//! Seam of package W0; package C1 moves `quote_of` here (with a cap parameter) and fills in the behaviour.

use serde::{Deserialize, Serialize};

use super::annotation::Rgb;
use super::geometry::Quad;
use super::ids::AnnotId;
use crate::documents::PageId;

/// What makes a Highlight a citation: its quote (`/SHR_Cite /Q`, 1..=`limits::CITE_QUOTE_MAX` characters) and the group a selection across
/// pages shares (`/G`, 8 hex characters).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Cite {
    pub quote: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
}

/// One citation to create, on one page (`create_citations`: at most `limits::CITE_DRAFTS_MAX`, one per page).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CitationDraft {
    pub page_id: PageId,
    /// 1..=512 rectangles of the selection.
    pub quads: Vec<Quad>,
    pub color: Rgb,
    #[serde(default)]
    pub contents: String,
    #[serde(default)]
    pub tags: Vec<String>,
}

/// A citation as `list_citations` reports it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CitationInfo {
    pub id: AnnotId,
    pub page_id: PageId,
    /// The page label, or the position + 1 (resolved when listed).
    pub locator: String,
    pub quote: String,
    pub contents: String,
    pub tags: Vec<String>,
    pub group: Option<String>,
    pub color: Rgb,
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::model::annotation::{Annotation, AnnotationBody};

    #[test]
    fn an_annotation_without_cite_and_tags_still_deserializes() {
        let annotation = Annotation {
            id: AnnotId::new(1),
            page_id: PageId::new(0),
            rect: crate::model::geometry::Rect {
                x: 0.0,
                y: 0.0,
                w: 1.0,
                h: 1.0,
            },
            color: Rgb([1, 2, 3]),
            opacity: 1.0,
            contents: String::new(),
            author: None,
            modified: None,
            in_reply_to: None,
            state: None,
            locked: false,
            sync: crate::model::annotation::Sync::Clean,
            cite: None,
            tags: Vec::new(),
            body: AnnotationBody::Highlight { quads: Vec::new() },
        };
        let value = serde_json::to_value(&annotation).unwrap();
        assert!(value.get("cite").is_none() && value.get("tags").is_none());
        let back: Annotation = serde_json::from_value(value).unwrap();
        assert_eq!(back, annotation);
        let mut cited = annotation;
        cited.cite = Some(Cite {
            quote: "q".to_owned(),
            group: Some("0a1b2c3d".to_owned()),
        });
        cited.tags = vec!["x".to_owned()];
        let value = serde_json::to_value(&cited).unwrap();
        assert_eq!(value["cite"], json!({"quote": "q", "group": "0a1b2c3d"}));
        assert_eq!(serde_json::from_value::<Annotation>(value).unwrap(), cited);
    }
}
