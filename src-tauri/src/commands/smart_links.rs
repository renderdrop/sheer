//! `smart_links`: the links detected in the text of a page (footnotes, contents, references, sources), ADR-132 and DESIGN §3.11.
//!
//! | Command | Arguments | Returns |
//! |---|---|---|
//! | `smart_links` | `docId: number`, `pageId: number` | `{ rev, ready, partial, links }`: `partial` is true when the index hit its time or size limit (pages after the last one read are missing); `rev` is the document revision the answer is for; `ready: false` means the document index is still being built in the background (ask again later, `links` is empty); `links` are `{ kind, rects, marker, target: { pageId, rect? }, preview, choices? }` (`choices` only on a range run: `[{ number, preview <= 120, target }]`, >= 2, ascending), at most 400, in reading order |
//!
//! `kind` is `footnote`, `noteBack`, `contents`, `reference` or `literature`. `rects` are in page points (origin top left, y down, before
//! `/Rotate`, the text layer's space); a contents link has two: the page number (where the cue is drawn) and the whole line (the hit area).
//! `marker` is the marker text, the label or the contents title; `preview` is the note, entry, caption or heading text, cut to 280
//! characters (empty for a bare page target). The target `pageId` is a page of the document and `rect` the box of the target lines.
//!
//! Nothing is written to the document and the model is not changed. The pages' text is read in the engine at `Background` priority:
//! the first call for a revision starts a build thread that reads the document within the limits of `limits.rs` and answers `ready:
//! false` until it is done; every later call answers from a cache of the revision. A new revision (a change, undo or redo) drops the
//! cache. Candidates that overlap a real link, a form widget or an annotation of the page are dropped (L3), and a page with a text edit of
//! the session has no links (its file text is not what is shown). Off is the frontend not calling it: no work happens without a call.
//! `invalid_argument` (`page`) for a page the document does not have, `not_found` for a document that is not open.

use serde::Serialize;
use tauri::State;

use super::{blocking, AppState};
use crate::documents::{sanitize_text, DocumentId, PageId};
use crate::error::{AppError, ErrorCode, UiError};
use crate::limits;
use crate::model::geometry::Rect;
use crate::smartlinks::index::{self, ReadFail, Status};
use crate::smartlinks::model::{Kind, PtRect, SmartLink, Target};
use crate::smartlinks::pages::has_real_labels;

/// Longest marker sent, in characters.
const MARKER_MAX: usize = 120;
/// Longest entry preview of a range choice, in characters.
const CHOICE_PREVIEW_MAX: usize = 120;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SmartTarget {
    pub page_id: PageId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rect: Option<Rect>,
    /// The page number as printed at the source link (contents line, page reference), when it names one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SmartLinkWire {
    pub kind: Kind,
    pub rects: Vec<Rect>,
    pub marker: String,
    pub target: SmartTarget,
    pub preview: String,
    /// Only on a range run (>= 2 entries, ascending by number).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub choices: Vec<SmartChoice>,
}

/// One resolved number of a range run: `{ number, preview (<= 120 characters), target }`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SmartChoice {
    pub number: u32,
    pub preview: String,
    pub target: SmartTarget,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SmartLinksInfo {
    pub rev: u64,
    pub ready: bool,
    /// The index hit its time or size limit: links to or from the missing pages are not found (the frontend may ignore it).
    pub partial: bool,
    pub links: Vec<SmartLinkWire>,
}

fn rect(r: PtRect) -> Rect {
    Rect {
        x: r.x,
        y: r.y,
        w: r.w.max(0.0),
        h: r.h.max(0.0),
    }
}

fn pt(r: Rect) -> PtRect {
    PtRect {
        x: r.x,
        y: r.y,
        w: r.w,
        h: r.h,
    }
}

fn wire_target(t: &Target, order: &[(PageId, u32)]) -> Option<SmartTarget> {
    let page_id = order.get(usize::try_from(t.page).ok()?)?.0;
    Some(SmartTarget {
        page_id,
        rect: t.rect.map(rect),
        label: t
            .label
            .as_deref()
            .map(|l| sanitize_text(l, 32))
            .filter(|l| !l.is_empty()),
    })
}

/// The wire form of `link` with the target given as a page id; `None` when the target is not a page of the document now.
/// A choice whose page is gone is dropped; a range left with fewer than two is no link.
fn wire(link: &SmartLink, order: &[(PageId, u32)]) -> Option<SmartLinkWire> {
    let choices: Vec<SmartChoice> = link
        .choices
        .iter()
        .filter_map(|c| {
            Some(SmartChoice {
                number: c.number,
                preview: sanitize_text(&c.preview, CHOICE_PREVIEW_MAX),
                target: wire_target(&c.target, order)?,
            })
        })
        .collect();
    if !link.choices.is_empty() && choices.len() < 2 {
        return None;
    }
    Some(SmartLinkWire {
        kind: link.kind,
        rects: link.rects.iter().copied().map(rect).collect(),
        marker: sanitize_text(&link.marker, MARKER_MAX),
        target: wire_target(&link.target, order)?,
        preview: sanitize_text(&link.preview, 280),
        choices,
    })
}

impl AppState {
    /// The smart links of a page of an open document (see the module documentation).
    pub fn smart_links(&self, id: DocumentId, page: PageId) -> Result<SmartLinksInfo, AppError> {
        self.registry.page_index(id, page)?;
        let order = self.registry.page_order(id)?;
        let pos = order
            .iter()
            .position(|&(p, _)| p == page)
            .and_then(|p| u32::try_from(p).ok())
            .ok_or_else(|| AppError::invalid("page"))?;
        let (rev, edited) = self.model(id, |state| {
            Ok((state.rev(), state.text_edits(page).is_some()))
        })?;
        let empty = |ready| SmartLinksInfo {
            rev,
            ready,
            partial: false,
            links: Vec::new(),
        };
        let index = match self.smart.status(id, rev) {
            Status::Start(generation) => {
                self.start_smart_build(id, generation, order, pos);
                return Ok(empty(false));
            }
            Status::Building => return Ok(empty(false)),
            Status::Ready(index) => index,
        };
        if edited {
            return Ok(SmartLinksInfo {
                partial: index.partial,
                ..empty(true)
            });
        }
        let links = match self.smart.cached(id, rev, pos) {
            Some(links) => links,
            None => {
                let found = index::page_links(&index.doc, &index.analysis, pos);
                let kept = if found.is_empty() {
                    found
                } else {
                    index::drop_conflicts(found, &self.smart_obstacles(id, page)?)
                };
                self.smart.put(id, rev, pos, kept)
            }
        };
        Ok(SmartLinksInfo {
            rev,
            ready: true,
            partial: index.partial,
            links: links.iter().filter_map(|l| wire(l, &order)).collect(),
        })
    }

    /// The boxes of what is interactive on the page already: real links, annotations and form widgets (DESIGN §3.11 L3).
    fn smart_obstacles(&self, id: DocumentId, page: PageId) -> Result<Vec<PtRect>, AppError> {
        let mut out: Vec<PtRect> = Vec::new();
        out.extend(self.page_links(id, page)?.into_iter().map(|l| pt(l.rect)));
        out.extend(
            self.list_annotations(id, page)?
                .into_iter()
                .map(|a| pt(a.rect)),
        );
        let forms = self
            .info(id)
            .is_some_and(|info| info.flags.has_forms && !info.flags.encrypted);
        if forms {
            // A form that cannot be read (XFA, a damaged one) has no widgets to protect.
            if let Ok(form) = self.get_form_fields(id) {
                for field in &form.fields {
                    out.extend(
                        field
                            .widgets
                            .iter()
                            .filter(|w| w.page_id == page)
                            .map(|w| pt(w.rect)),
                    );
                }
            }
        }
        Ok(out)
    }

    /// Starts the background build of the index of `id` for `generation`, around position `first`.
    fn start_smart_build(
        &self,
        id: DocumentId,
        generation: u64,
        order: Vec<(PageId, u32)>,
        first: u32,
    ) {
        let state = self.clone();
        let spawned = std::thread::Builder::new()
            .name("smart-links".into())
            .spawn(move || {
                let ready = state.build_smart_index(id, generation, &order, first);
                state.smart.finish(id, generation, ready);
            });
        if spawned.is_err() {
            self.smart.finish(id, generation, None);
        }
    }

    fn build_smart_index(
        &self,
        id: DocumentId,
        generation: u64,
        order: &[(PageId, u32)],
        first: u32,
    ) -> Option<index::Ready> {
        let count = u32::try_from(order.len()).ok()?;
        // The labels are used only when the file really has some; by position in the page order, not the file's.
        let file_labels = self.page_labels(id).unwrap_or_default();
        let labels = if has_real_labels(&file_labels) {
            order
                .iter()
                .map(|&(_, engine)| {
                    usize::try_from(engine)
                        .ok()
                        .and_then(|e| file_labels.get(e).cloned().flatten())
                })
                .collect()
        } else {
            Vec::new()
        };
        index::build(
            count,
            labels,
            first,
            std::time::Instant::now() + limits::SMART_INDEX_BUDGET,
            |pos| {
                let engine = order
                    .get(usize::try_from(pos).map_err(|_| ReadFail::Abort)?)
                    .ok_or(ReadFail::Abort)?
                    .1;
                match self.engine.smart_text(id, engine) {
                    Ok(page) => Ok(page),
                    Err(e) => Err(match e.code() {
                        ErrorCode::InvalidArgument
                        | ErrorCode::DamagedFile
                        | ErrorCode::EngineTimeout => ReadFail::Page,
                        _ => ReadFail::Abort,
                    }),
                }
            },
            || !self.smart.wanted(id, generation),
        )
    }
}

/// The smart links of a page.
#[tauri::command]
pub async fn smart_links(
    state: State<'_, AppState>,
    doc_id: DocumentId,
    page_id: PageId,
) -> Result<SmartLinksInfo, UiError> {
    let state = state.inner().clone();
    blocking(move || state.smart_links(doc_id, page_id)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::testutil::state_with_pages;
    use crate::engine::Job;
    use crate::smartlinks::model::{Line, PageText, Run};
    use std::time::{Duration, Instant};

    fn run(text: &str, x: f32, y: f32, w: f32, size: f32, baseline: f32) -> Run {
        Run {
            text: text.to_owned(),
            rect: PtRect { x, y, w, h: size },
            size,
            baseline,
            bold: false,
        }
    }

    fn line(runs: Vec<Run>) -> Line {
        let rect = runs[0].rect;
        let rect = runs.iter().skip(1).fold(rect, |a, r| PtRect {
            x: a.x.min(r.rect.x),
            y: a.y.min(r.rect.y),
            w: (a.x + a.w).max(r.rect.x + r.rect.w) - a.x.min(r.rect.x),
            h: (a.y + a.h).max(r.rect.y + r.rect.h) - a.y.min(r.rect.y),
        });
        Line { runs, rect }
    }

    /// Page 0: a body line with a raised marker "1" and its note at the bottom; page 1: nothing.
    fn page(index: u32) -> PageText {
        let lines = if index == 0 {
            vec![
                line(vec![
                    run("A claim", 50.0, 100.0, 40.0, 10.0, 110.0),
                    run("1", 90.0, 98.0, 4.0, 6.0, 104.0),
                    run(" goes on.", 94.0, 100.0, 50.0, 10.0, 110.0),
                ]),
                line(vec![
                    run("1", 50.0, 700.0, 4.0, 8.0, 708.0),
                    run("See the source.", 56.0, 700.0, 70.0, 8.0, 708.0),
                ]),
            ]
        } else {
            vec![line(vec![run(
                "Other text here",
                50.0,
                100.0,
                80.0,
                10.0,
                110.0,
            )])]
        };
        PageText {
            page: index,
            width: 600.0,
            height: 800.0,
            lines,
            body_size: 10.0,
        }
    }

    fn state() -> (AppState, DocumentId) {
        state_with_pages(2, |job| match job {
            Job::SmartText {
                engine_index,
                reply,
                ..
            } => {
                let _ = reply.send(Ok(page(engine_index)));
            }
            Job::PageLabels { reply, .. } => {
                let _ = reply.send(Ok(Vec::new()));
            }
            Job::PageLinks { reply, .. } => {
                let _ = reply.send(Ok(Vec::new()));
            }
            Job::ImportAnnotations { reply, .. } => {
                let _ = reply.send(Ok(Vec::new()));
            }
            _ => {}
        })
    }

    fn until_ready(state: &AppState, id: DocumentId, page: u32) -> SmartLinksInfo {
        let end = Instant::now() + Duration::from_secs(10);
        loop {
            let info = state.smart_links(id, PageId::new(page)).unwrap();
            if info.ready || Instant::now() > end {
                return info;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn the_first_call_is_not_ready_and_a_later_one_has_the_links_of_the_page() {
        let (state, id) = state();
        let first = state.smart_links(id, PageId::new(0)).unwrap();
        assert!(!first.ready && first.links.is_empty());
        let info = until_ready(&state, id, 0);
        assert!(info.ready);
        assert_eq!(info.rev, first.rev);
        let kinds: Vec<Kind> = info.links.iter().map(|l| l.kind).collect();
        assert_eq!(kinds, [Kind::Footnote, Kind::NoteBack]);
        let footnote = &info.links[0];
        assert_eq!(footnote.marker, "1");
        assert_eq!(footnote.target.page_id, PageId::new(0));
        assert_eq!(footnote.preview, "See the source.");
        assert!(footnote.target.rect.unwrap().y >= 690.0);
        // The wire is camelCase.
        let json = serde_json::to_value(&info).unwrap();
        assert_eq!(json["links"][0]["kind"], "footnote");
        assert_eq!(json["links"][1]["kind"], "noteBack");
        assert!(json["links"][0]["target"]["pageId"].is_number());
        assert!(json["ready"].as_bool().unwrap());
        assert_eq!(json["partial"], false);
        // Another page has none.
        assert!(until_ready(&state, id, 1).links.is_empty());
    }

    #[test]
    fn a_real_link_over_a_candidate_wins() {
        let (state, id) = {
            let (state, id) = state_with_pages(2, |job| match job {
                Job::SmartText {
                    engine_index,
                    reply,
                    ..
                } => {
                    let _ = reply.send(Ok(page(engine_index)));
                }
                Job::PageLabels { reply, .. } => {
                    let _ = reply.send(Ok(Vec::new()));
                }
                Job::PageLinks { reply, .. } => {
                    let _ = reply.send(Ok(vec![crate::engine::PageLink {
                        rect: Rect {
                            x: 88.0,
                            y: 96.0,
                            w: 10.0,
                            h: 14.0,
                        },
                        target: crate::engine::LinkTarget::Blocked,
                    }]));
                }
                Job::ImportAnnotations { reply, .. } => {
                    let _ = reply.send(Ok(Vec::new()));
                }
                _ => {}
            });
            (state, id)
        };
        let info = until_ready(&state, id, 0);
        assert!(info.ready);
        // The footnote marker is under the link; the note back (the note's own marker) is not.
        let kinds: Vec<Kind> = info.links.iter().map(|l| l.kind).collect();
        assert!(!kinds.contains(&Kind::Footnote), "{kinds:?}");
    }

    #[test]
    fn bad_pages_and_documents_are_refused_without_a_path() {
        let (state, id) = state();
        for bad in [2, 3, u32::MAX] {
            assert_eq!(
                state.smart_links(id, PageId::new(bad)).unwrap_err().code(),
                ErrorCode::InvalidArgument,
                "{bad}"
            );
        }
        let unknown: DocumentId = serde_json::from_str("999").unwrap();
        assert_eq!(
            state
                .smart_links(unknown, PageId::new(0))
                .unwrap_err()
                .code(),
            ErrorCode::NotFound
        );
    }

    #[test]
    fn a_target_that_is_no_page_of_the_document_makes_no_wire_link() {
        let link = SmartLink {
            kind: Kind::Reference,
            page: 0,
            rects: vec![PtRect {
                x: 1.0,
                y: 2.0,
                w: 3.0,
                h: 4.0,
            }],
            marker: "S.\u{202e} 5".into(),
            target: crate::smartlinks::model::Target {
                page: 7,
                rect: None,
                label: None,
            },
            choices: Vec::new(),
            preview: String::new(),
            score: 0.9,
        };
        assert!(wire(&link, &[(PageId::new(0), 0)]).is_none());
        let mut ok = link;
        ok.target.page = 0;
        let w = wire(&ok, &[(PageId::new(9), 0)]).unwrap();
        assert_eq!(w.target.page_id, PageId::new(9));
        assert_eq!(w.target.label, None);
        let mut printed = ok.clone();
        printed.target.label = Some("1\u{202e}".into());
        let w = wire(&printed, &[(PageId::new(9), 0)]).unwrap();
        assert_eq!(w.target.label.as_deref(), Some("1"));
        let json = serde_json::to_value(&w).unwrap();
        assert_eq!(json["target"]["label"], "1");
        assert!(!w.marker.contains('\u{202e}'), "bidi controls are stripped");
    }
}
