//! Citation commands (ADR-119, ARCHITECTURE section 5 "Citations (v1.3)").
//!
//! | Command | Arguments | Returns |
//! |---|---|---|
//! | `create_citations` | `docId: number`, `drafts: CitationDraft[]` (1 to 64, one page each) | the `ChangeSet` of one `Batch` (`citation.create`); a selection across pages is one draft per page and the citations share a group id. `invalid_argument` (`citation`) when a page has no text under the selection, `read_only` (`permission`) when the document may not be edited |
//! | `list_citations` | `docId: number` | `CitationInfo[]` (at most 20 000), page order then position, the locator (page label, else position + 1) resolved now |
//!
//! The quote is taken in Rust from the page's text layer when the citation is made (at most 2 000 characters); the frontend never sends it.

use std::collections::HashSet;

use tauri::State;

use super::{blocking, AppState};
use crate::documents::DocumentId;
use crate::error::AppError;
use crate::error::UiError;
use crate::limits;
use crate::model::annotation::{AnnotationBody, AnnotationDraft};
use crate::model::command::DocCommand;
use crate::model::doc_state::ChangeSet;
use crate::model::quote::{self, quote_of, CitationDraft, CitationInfo, Cite};

/// The label of the undo step of `create_citations` (a key of the UI catalogs).
pub const LABEL_CREATE: &str = "citation.create";

/// Most rectangles of one draft.
const MAX_QUADS: usize = 512;

impl AppState {
    /// Makes one citation (a Highlight with its quote, tags and comment) of each draft, as one undo step. The drafts are on different
    /// pages; the quote of each is the text of its page under its quads; with more than one draft the citations share a group id.
    pub fn create_citations(
        &self,
        id: DocumentId,
        drafts: Vec<CitationDraft>,
    ) -> Result<ChangeSet, AppError> {
        self.check_may_edit(id)?;
        if drafts.is_empty() {
            return Err(AppError::invalid("drafts"));
        }
        if drafts.len() > limits::CITE_DRAFTS_MAX {
            return Err(AppError::limit("drafts", limits::CITE_DRAFTS_MAX as u64));
        }
        let mut seen = HashSet::new();
        for draft in &drafts {
            if !seen.insert(draft.page_id.get()) {
                return Err(AppError::invalid("drafts"));
            }
            if draft.quads.is_empty() || draft.quads.len() > MAX_QUADS {
                return Err(AppError::invalid("quads"));
            }
        }
        let group = (drafts.len() > 1).then(quote::new_group_id);
        let mut commands = Vec::with_capacity(drafts.len());
        for draft in drafts {
            let layer = self.text_layer(id, draft.page_id)?;
            let text = quote_of(
                &layer.text,
                &layer.boxes,
                &draft.quads,
                limits::CITE_QUOTE_MAX,
            );
            if text.is_empty() {
                return Err(AppError::invalid("citation"));
            }
            commands.push(DocCommand::CreateAnnotation {
                draft: AnnotationDraft {
                    page_id: draft.page_id,
                    color: draft.color,
                    opacity: 1.0,
                    contents: draft.contents,
                    author: None,
                    in_reply_to: None,
                    state: None,
                    locked: false,
                    tags: draft.tags,
                    cite: Some(Cite {
                        quote: text,
                        group: group.clone(),
                    }),
                    body: AnnotationBody::Highlight { quads: draft.quads },
                },
            });
        }
        self.apply_command(
            id,
            DocCommand::Batch {
                label: LABEL_CREATE.to_owned(),
                commands,
            },
        )
    }

    /// The page labels by file page index: from the model if they were read, else asked of the engine once. A failed job is cached as
    /// no labels (every locator falls back to the position) until the next save, so a list does not retry it.
    fn page_labels(&self, id: DocumentId) -> Result<Vec<Option<String>>, AppError> {
        if let Some(labels) = self.model(id, |state| Ok(state.page_labels.clone()))? {
            return Ok(labels);
        }
        let labels = self.engine.page_labels(id).unwrap_or_default();
        self.model(id, |state| {
            state.page_labels = Some(labels.clone());
            Ok(())
        })?;
        Ok(labels)
    }

    /// The citations of the document, by page and position (top to bottom, then left to right, then creation), at most
    /// `limits::CITATIONS_MAX`. Pages not read yet are read at `Background` priority.
    pub fn list_citations(&self, id: DocumentId) -> Result<Vec<CitationInfo>, AppError> {
        let order = self.registry.page_order(id)?;
        let labels = self.page_labels(id)?;
        let unread = self.unread_pages(id, &order)?;
        let keys = self.prefetch_keys(id, &unread)?;
        let mut out: Vec<CitationInfo> = Vec::new();
        for (position, (page, index)) in order.into_iter().enumerate() {
            if !self.model(id, |state| Ok(state.is_imported(page)))? {
                let items = self.engine.import_annotations_background(id, index)?;
                self.import_read_prefetched(id, page, index, items, &keys)?;
            }
            let mut found: Vec<_> = self
                .model(id, |state| Ok(state.list(page)))?
                .into_iter()
                .filter(|a| a.cite.is_some())
                .collect();
            found.sort_by(|a, b| {
                a.rect
                    .y
                    .total_cmp(&b.rect.y)
                    .then(a.rect.x.total_cmp(&b.rect.x))
                    .then(a.id.cmp(&b.id))
            });
            // The PDF label is the label of a page of the file; a blank, imported or redacted page has none (ADR-119 section 2).
            let from_file = self.model(id, |state| Ok(state.is_file_page(page)))?;
            let locator = usize::try_from(index)
                .ok()
                .filter(|_| from_file)
                .and_then(|i| labels.get(i))
                .and_then(|label| label.clone())
                .filter(|label| !label.trim().is_empty())
                .unwrap_or_else(|| (position + 1).to_string());
            for annotation in found {
                if out.len() >= limits::CITATIONS_MAX {
                    return Ok(out);
                }
                let Some(cite) = annotation.cite else {
                    continue;
                };
                out.push(CitationInfo {
                    id: annotation.id,
                    page_id: page,
                    locator: locator.clone(),
                    quote: cite.quote,
                    contents: annotation.contents,
                    tags: annotation.tags,
                    group: cite.group,
                    color: annotation.color,
                });
            }
        }
        Ok(out)
    }
}

/// Makes one citation of each draft, as one undo step.
#[tauri::command]
pub async fn create_citations(
    state: State<'_, AppState>,
    doc_id: DocumentId,
    drafts: Vec<CitationDraft>,
) -> Result<ChangeSet, UiError> {
    let state = state.inner().clone();
    blocking(move || state.create_citations(doc_id, drafts)).await
}

/// The citations of a document with their page labels.
#[tauri::command]
pub async fn list_citations(
    state: State<'_, AppState>,
    doc_id: DocumentId,
) -> Result<Vec<CitationInfo>, UiError> {
    let state = state.inner().clone();
    blocking(move || state.list_citations(doc_id)).await
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::commands::testutil::state_with_pages;
    use crate::documents::PageId;
    use crate::engine::{Job, TextPage};
    use crate::error::ErrorCode;

    /// "alpha beta" with a box of 10 x 10 per character on one line.
    fn page() -> TextPage {
        let text = "alpha beta";
        let boxes = (0..text.len())
            .flat_map(|n| [n as f32 * 10.0, 0.0, 10.0, 10.0])
            .collect();
        TextPage {
            text: text.to_owned(),
            boxes,
            truncated: false,
            rotation: 0,
        }
    }

    fn state(labels: Vec<Option<String>>) -> (AppState, DocumentId) {
        state_with_pages(3, move |job| match job {
            Job::TextLayer { reply, .. } => {
                let _ = reply.send(Ok(page()));
            }
            Job::ImportAnnotations { reply, .. } => {
                let _ = reply.send(Ok(Vec::new()));
            }
            Job::PageLabels { reply, .. } => {
                let _ = reply.send(Ok(labels.clone()));
            }
            Job::Close { reply, .. } => {
                let _ = reply.send(Ok(()));
            }
            _ => {}
        })
    }

    fn drafts(value: serde_json::Value) -> Vec<CitationDraft> {
        serde_json::from_value(value).unwrap()
    }

    fn draft(page: u32, x: f32, w: f32) -> serde_json::Value {
        json!({"pageId": page, "color": [255, 248, 77], "tags": ["a"], "contents": "c",
            "quads": [[{"x": x, "y": 0.0}, {"x": x + w, "y": 0.0}, {"x": x, "y": 10.0}, {"x": x + w, "y": 10.0}]]})
    }

    #[test]
    fn citations_are_made_in_one_step_with_a_group_and_listed_in_page_order_with_labels() {
        let (state, id) = state(vec![Some("iv".into()), None, Some(" ".into())]);
        // Page 2 first on purpose: the list follows the pages, not the drafts.
        let changes = state
            .create_citations(
                id,
                drafts(json!([draft(2, 0.0, 50.0), draft(0, 55.0, 40.0)])),
            )
            .unwrap();
        assert_eq!(changes.upserted.len(), 2);
        let listed = state.list_citations(id).unwrap();
        let quotes: Vec<_> = listed.iter().map(|c| c.quote.as_str()).collect();
        assert_eq!(quotes, ["beta", "alpha"]);
        assert_eq!(listed[0].locator, "iv");
        assert_eq!(
            listed[1].locator, "3",
            "a blank label falls back to the position"
        );
        assert!(listed[0].group.is_some() && listed[0].group == listed[1].group);
        assert_eq!(listed[0].tags, ["a"]);
        assert_eq!(listed[0].contents, "c");
        // One undo step takes both back.
        assert_eq!(state.undo(id).unwrap().removed.len(), 2);
        assert!(state.list_citations(id).unwrap().is_empty());
    }

    #[test]
    fn a_single_citation_has_no_group_and_without_labels_the_locator_is_the_position() {
        let (state, id) = state(Vec::new());
        state
            .create_citations(id, drafts(json!([draft(1, 0.0, 50.0)])))
            .unwrap();
        let listed = state.list_citations(id).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].group, None);
        assert_eq!(listed[0].locator, "2");
        assert_eq!(listed[0].page_id, PageId::new(1));
        // The card quote of a citation is the stored one.
        assert_eq!(
            state.annotation_quote(id, listed[0].id).unwrap().as_deref(),
            Some("alpha")
        );
    }

    #[test]
    fn only_a_page_of_the_file_has_its_pdf_label_a_blank_or_imported_one_has_its_position() {
        use crate::model::page::{NewPage, PageSource};
        let (state, id) = state(vec![Some("iv".into()), Some("v".into()), Some("vi".into())]);
        // A blank page first, then an imported page whose engine index would pick the label "v" of file page 1.
        state
            .apply_command(
                id,
                DocCommand::AddPages {
                    label: "pages.insertBlank".to_owned(),
                    at: 0,
                    pages: vec![NewPage {
                        source: PageSource::Blank,
                        engine_index: 0,
                        rotation: 0,
                        size: [100.0, 100.0],
                        media: [0.0, 0.0, 100.0, 100.0],
                        annotations: None,
                    }],
                },
            )
            .unwrap();
        state
            .apply_command(
                id,
                DocCommand::AddPages {
                    label: "pages.insert".to_owned(),
                    at: 2,
                    pages: vec![NewPage {
                        source: PageSource::Imported {
                            source: serde_json::from_value(json!(1)).unwrap(),
                            index: 0,
                        },
                        engine_index: 1,
                        rotation: 0,
                        size: [100.0, 100.0],
                        media: [0.0, 0.0, 100.0, 100.0],
                        annotations: Some(Vec::new()),
                    }],
                },
            )
            .unwrap();
        // Page ids: file pages 0, 1, 2; the blank one is 3 and the imported one 4. Order: 3, 0, 4, 1, 2.
        let order: Vec<u32> = state
            .registry
            .page_order(id)
            .unwrap()
            .iter()
            .map(|(page, _)| page.get())
            .collect();
        assert_eq!(order, [3, 0, 4, 1, 2]);
        state
            .create_citations(id, drafts(json!([draft(3, 0.0, 50.0)])))
            .unwrap();
        state
            .create_citations(id, drafts(json!([draft(4, 0.0, 50.0)])))
            .unwrap();
        state
            .create_citations(id, drafts(json!([draft(0, 0.0, 50.0)])))
            .unwrap();
        state
            .create_citations(id, drafts(json!([draft(1, 0.0, 50.0)])))
            .unwrap();
        let locators: Vec<_> = state
            .list_citations(id)
            .unwrap()
            .into_iter()
            .map(|c| c.locator)
            .collect();
        assert_eq!(locators, ["1", "iv", "3", "v"]);
    }

    #[test]
    fn a_failed_labels_job_is_asked_once_until_the_next_save() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;
        let asked = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&asked);
        let (state, id) = state_with_pages(2, move |job| match job {
            Job::TextLayer { reply, .. } => {
                let _ = reply.send(Ok(page()));
            }
            Job::ImportAnnotations { reply, .. } => {
                let _ = reply.send(Ok(Vec::new()));
            }
            Job::PageLabels { reply, .. } => {
                counter.fetch_add(1, Ordering::SeqCst);
                let _ = reply.send(Err(AppError::new(ErrorCode::EngineTimeout)));
            }
            _ => {}
        });
        state
            .create_citations(id, drafts(json!([draft(1, 0.0, 50.0)])))
            .unwrap();
        for _ in 0..3 {
            assert_eq!(state.list_citations(id).unwrap()[0].locator, "2");
        }
        assert_eq!(asked.load(Ordering::SeqCst), 1);
    }
    #[test]
    fn drafts_that_do_not_fit_are_refused() {
        let (state, id) = state(Vec::new());
        let code = |value| {
            state
                .create_citations(id, drafts(value))
                .unwrap_err()
                .code()
        };
        assert_eq!(code(json!([])), ErrorCode::InvalidArgument);
        assert_eq!(
            code(json!([draft(0, 500.0, 5.0)])),
            ErrorCode::InvalidArgument
        );
        assert_eq!(
            code(json!([draft(0, 0.0, 50.0), draft(0, 0.0, 50.0)])),
            ErrorCode::InvalidArgument
        );
        let many: Vec<_> = (0..65).map(|n| draft(n % 3, 0.0, 50.0)).collect();
        assert_eq!(code(json!(many)), ErrorCode::LimitExceeded);
        let mut bad_tags = draft(0, 0.0, 50.0);
        bad_tags["tags"] = json!([""]);
        assert_eq!(code(json!([bad_tags])), ErrorCode::InvalidArgument);
        assert!(state.list_citations(id).unwrap().is_empty());
        assert!(!state.annotations.is_dirty(id));
    }
}
