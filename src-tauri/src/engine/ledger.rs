//! What the engine child holds of a document that its file does not (ADR-053 §1.7): pages appended, pages truncated again, rotations,
//! crop boxes and hidden annotations. When the child dies a new one reopens the file and the parent replays this ledger, so the
//! document looks to the UI as it did. Parent only; the ledger holds no password and no path.
//!
//! Appends and truncations are kept in order (an index handed out earlier must come out the same). Rotations, crop boxes and the hidden
//! set are kept as their net effect: the last value per page, the set that is hidden now.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use super::transport::Blob;
use super::wire::WireRequest;
use crate::documents::sources::SourceBytes;
use crate::documents::DocumentId;

/// One change of the page list of the engine's copy.
#[derive(Debug, Clone)]
enum PageOp {
    AppendBlank {
        size: [f32; 2],
    },
    AppendPages {
        source: Arc<SourceBytes>,
        pages: Vec<u32>,
    },
    Truncate {
        keep: u32,
        total: u32,
    },
}

#[derive(Debug, Clone, Default)]
pub(super) struct Ledger {
    ops: Vec<PageOp>,
    rotations: BTreeMap<u32, u16>,
    crops: BTreeMap<u32, [f32; 4]>,
    hidden: BTreeSet<(u32, u32)>,
}

impl Ledger {
    /// The copy was loaded afresh (a reopen): nothing of the old one is left to replay.
    pub(super) fn clear(&mut self) {
        *self = Self::default();
    }

    #[cfg(test)]
    pub(super) fn is_empty(&self) -> bool {
        self.ops.is_empty()
            && self.rotations.is_empty()
            && self.crops.is_empty()
            && self.hidden.is_empty()
    }

    pub(super) fn append_blank(&mut self, size: [f32; 2]) {
        self.ops.push(PageOp::AppendBlank { size });
    }

    pub(super) fn append_pages(&mut self, source: Arc<SourceBytes>, pages: Vec<u32>) {
        self.ops.push(PageOp::AppendPages { source, pages });
    }

    pub(super) fn truncate(&mut self, keep: u32, total: u32) {
        self.ops.push(PageOp::Truncate { keep, total });
    }

    pub(super) fn rotate(&mut self, items: &[(u32, u16)]) {
        for &(index, degrees) in items {
            self.rotations.insert(index, degrees);
        }
    }

    pub(super) fn crop(&mut self, engine_index: u32, crop: [f32; 4]) {
        self.crops.insert(engine_index, crop);
    }

    pub(super) fn set_hidden(&mut self, hide: &[(u32, u32)], show: &[(u32, u32)]) {
        for spot in show {
            self.hidden.remove(spot);
        }
        for &spot in hide {
            self.hidden.insert(spot);
        }
    }

    /// The requests that bring a freshly reopened copy of document `id` to where this ledger says it was, in order.
    pub(super) fn replay(&self, id: DocumentId) -> Vec<(WireRequest, Blob)> {
        let mut out = Vec::new();
        for op in &self.ops {
            out.push(match op {
                PageOp::AppendBlank { size } => {
                    (WireRequest::AppendBlankPage { id, size: *size }, Blob::None)
                }
                PageOp::AppendPages { source, pages } => (
                    WireRequest::AppendPages {
                        id,
                        pages: pages.clone(),
                    },
                    Blob::Shared(Arc::clone(&source.bytes)),
                ),
                PageOp::Truncate { keep, total } => (
                    WireRequest::TruncatePages {
                        id,
                        keep: *keep,
                        total: *total,
                    },
                    Blob::None,
                ),
            });
        }
        if !self.rotations.is_empty() {
            out.push((
                WireRequest::SetPageRotations {
                    id,
                    items: self.rotations.iter().map(|(&i, &d)| (i, d)).collect(),
                },
                Blob::None,
            ));
        }
        for (&engine_index, &crop) in &self.crops {
            out.push((
                WireRequest::SetCropBox {
                    id,
                    engine_index,
                    crop,
                },
                Blob::None,
            ));
        }
        if !self.hidden.is_empty() {
            out.push((
                WireRequest::SetAnnotationsHidden {
                    id,
                    hide: self.hidden.iter().copied().collect(),
                    show: Vec::new(),
                },
                Blob::None,
            ));
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc() -> DocumentId {
        serde_json::from_value(serde_json::json!(7)).unwrap()
    }

    fn source() -> Arc<SourceBytes> {
        Arc::new(SourceBytes {
            bytes: Arc::from(vec![1u8, 2, 3]),
            page_count: 2,
            display_name: String::new(),
        })
    }

    #[test]
    fn pages_replay_in_order_then_the_net_state() {
        let mut ledger = Ledger::default();
        assert!(ledger.is_empty());
        ledger.append_blank([100.0, 200.0]);
        ledger.append_pages(source(), vec![1, 0]);
        ledger.truncate(3, 5);
        ledger.rotate(&[(0, 90), (1, 180)]);
        ledger.rotate(&[(0, 270)]);
        ledger.crop(2, [0.0, 0.0, 10.0, 10.0]);
        ledger.crop(2, [1.0, 1.0, 9.0, 9.0]);
        ledger.set_hidden(&[(0, 1), (0, 2)], &[]);
        ledger.set_hidden(&[], &[(0, 1)]);
        let replay = ledger.replay(doc());
        let kinds: Vec<&str> = replay
            .iter()
            .map(|(request, _)| match request {
                WireRequest::AppendBlankPage { .. } => "blank",
                WireRequest::AppendPages { .. } => "pages",
                WireRequest::TruncatePages { .. } => "truncate",
                WireRequest::SetPageRotations { .. } => "rotations",
                WireRequest::SetCropBox { .. } => "crop",
                WireRequest::SetAnnotationsHidden { .. } => "hidden",
                _ => "other",
            })
            .collect();
        assert_eq!(
            kinds,
            ["blank", "pages", "truncate", "rotations", "crop", "hidden"]
        );
        assert_eq!(replay[1].1.as_slice(), &[1, 2, 3]);
        assert_eq!(
            replay[3].0,
            WireRequest::SetPageRotations {
                id: doc(),
                items: vec![(0, 270), (1, 180)]
            }
        );
        assert_eq!(
            replay[4].0,
            WireRequest::SetCropBox {
                id: doc(),
                engine_index: 2,
                crop: [1.0, 1.0, 9.0, 9.0]
            }
        );
        assert_eq!(
            replay[5].0,
            WireRequest::SetAnnotationsHidden {
                id: doc(),
                hide: vec![(0, 2)],
                show: vec![]
            }
        );
    }

    #[test]
    fn a_cleared_ledger_replays_nothing() {
        let mut ledger = Ledger::default();
        ledger.append_blank([1.0, 1.0]);
        ledger.rotate(&[(0, 90)]);
        ledger.clear();
        assert!(ledger.is_empty());
        assert!(ledger.replay(doc()).is_empty());
    }
}
