//! The smart-link index of the open documents (ADR-132 §5, DESIGN §3.11 L10): per document and revision the pages read so far, the contents
//! and page-number analysis, and the finished links of each page. Pages are read in the background (the requested page and its
//! neighbours first, then the rest, within the limits of `limits.rs`); a request for a document whose index is not ready yet gets
//! nothing but `ready: false`. A new revision drops everything of the old one. Nothing here talks to PDFium or the model: the build takes the
//! page reader as a closure, so it is tested without an engine.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use super::footnotes;
use super::literature;
use super::model::{DocText, Kind, PageText, PtRect, SmartLink};
use super::pages::{self, PageMap};
use super::references;
use super::toc::{self, Norms};
use crate::documents::DocumentId;
use crate::limits;

/// Most runs the index keeps in all (a hostile file with a run per character stays small).
const MAX_INDEX_RUNS: usize = 600_000;
/// A failed build is tried again after this long.
const RETRY_AFTER: Duration = Duration::from_secs(5);

/// What the whole document says, computed once the pages are read.
#[derive(Debug, Clone, Default)]
pub struct Analysis {
    pub map: PageMap,
    /// Contents links by the page of the contents line.
    pub toc: HashMap<u32, Vec<SmartLink>>,
}

/// The pages read of a document and what was learned from them.
#[derive(Debug, Clone)]
pub struct Ready {
    pub doc: DocText,
    pub analysis: Analysis,
}

/// Runs the document-wide part of detection: contents entries, the page map and the contents links.
pub fn analyze(doc: &DocText) -> Analysis {
    let mut entries = Vec::new();
    for page in &doc.pages {
        entries.extend(toc::detect_entries(page));
    }
    let mut norms = Norms::new(doc);
    let map = pages::learn(doc, &entries, &mut norms);
    let toc = toc::links(doc, &entries, &map, &mut norms);
    Analysis { map, toc }
}

fn centre_y(l: &SmartLink) -> f32 {
    l.rects.first().map_or(0.0, |r| r.y)
}

fn centre_x(l: &SmartLink) -> f32 {
    l.rects.first().map_or(0.0, |r| r.x)
}

/// Whether two boxes overlap in an area (touching edges do not count).
pub fn overlaps(a: &PtRect, b: &PtRect) -> bool {
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

fn kind_rank(kind: Kind) -> u8 {
    match kind {
        Kind::Contents => 0,
        Kind::Footnote => 1,
        Kind::NoteBack => 2,
        Kind::Literature => 3,
        Kind::Reference => 4,
    }
}

fn sound(link: &SmartLink, page_count: u32) -> bool {
    let finite = |r: &PtRect| [r.x, r.y, r.w, r.h].iter().all(|n| n.is_finite());
    !link.rects.is_empty()
        && link.rects.iter().all(finite)
        && link.target.page < page_count
        && link.target.rect.as_ref().is_none_or(finite)
        && link.preview.chars().count() <= 280
        && link.score.is_finite()
}

/// The links of position `page` from all four detectors: each target is a page of the document, no two links overlap (the one with the
/// higher score stays; on a tie the kind order contents, footnote, note back, source, reference), in reading order.
pub fn page_links(doc: &DocText, analysis: &Analysis, page: u32) -> Vec<SmartLink> {
    if !doc.pages.iter().any(|p| p.page == page) {
        return Vec::new();
    }
    let mut all: Vec<SmartLink> = analysis.toc.get(&page).cloned().unwrap_or_default();
    all.extend(footnotes::detect(doc, page));
    all.extend(references::detect(doc, page, &|printed| {
        analysis.map.resolve(printed)
    }));
    all.extend(literature::detect(doc, page));
    all.retain(|l| l.page == page && sound(l, doc.page_count));
    all.sort_by(|a, b| {
        b.score
            .total_cmp(&a.score)
            .then(kind_rank(a.kind).cmp(&kind_rank(b.kind)))
    });
    let mut kept: Vec<SmartLink> = Vec::new();
    for l in all {
        if !kept.iter().any(|k| {
            k.rects
                .iter()
                .any(|a| l.rects.iter().any(|b| overlaps(a, b)))
        }) {
            kept.push(l);
        }
    }
    kept.sort_by(|a, b| {
        centre_y(a)
            .total_cmp(&centre_y(b))
            .then(centre_x(a).total_cmp(&centre_x(b)))
    });
    kept.truncate(limits::MAX_SMART_LINKS_PER_PAGE);
    kept
}

/// Drops the links whose boxes overlap one of `obstacles` (real links, form widgets, annotations: DESIGN §3.11 L3).
pub fn drop_conflicts(links: Vec<SmartLink>, obstacles: &[PtRect]) -> Vec<SmartLink> {
    links
        .into_iter()
        .filter(|l| {
            !l.rects
                .iter()
                .any(|r| obstacles.iter().any(|o| overlaps(r, o)))
        })
        .collect()
}

/// The order pages are read in: the requested position and its neighbours first, then the rest ascending, up to the page limit.
pub fn read_order(count: u32, first: u32) -> Vec<u32> {
    let limit = count.min(limits::MAX_SMART_INDEX_PAGES);
    let mut order: Vec<u32> = Vec::new();
    for p in [first.checked_sub(1), Some(first), first.checked_add(1)]
        .into_iter()
        .flatten()
    {
        if p < limit && !order.contains(&p) {
            order.push(p);
        }
    }
    let rest: Vec<u32> = (0..limit).filter(|p| !order.contains(p)).collect();
    order.extend(rest);
    order
}

/// Why a page could not be read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReadFail {
    /// This page is unreadable; the index goes on without its text.
    Page,
    /// The document is gone or the engine is down; the build ends.
    Abort,
}

/// Reads the pages of a document of `count` pages in [`read_order`] with `read` (which answers the text of the page at a position),
/// within the page, character, run and time limits, and analyses what was read. `labels` are the real page labels by position (empty
/// when the file has none). `None` when the build was aborted or cancelled. Pages after the first one not read (a limit was reached)
/// are left out, and so is everything after them: the index is a prefix of the document.
pub fn build(
    count: u32,
    labels: Vec<Option<String>>,
    first: u32,
    deadline: Instant,
    mut read: impl FnMut(u32) -> Result<PageText, ReadFail>,
    cancelled: impl Fn() -> bool,
) -> Option<Ready> {
    let mut got: HashMap<u32, PageText> = HashMap::new();
    let (mut chars, mut runs) = (0usize, 0usize);
    for pos in read_order(count, first) {
        if cancelled() {
            return None;
        }
        if Instant::now() >= deadline
            || chars > limits::MAX_SMART_INDEX_CHARS
            || runs > MAX_INDEX_RUNS
        {
            break;
        }
        let mut page = match read(pos) {
            Ok(p) => p,
            Err(ReadFail::Abort) => return None,
            Err(ReadFail::Page) => PageText {
                page: pos,
                width: 0.0,
                height: 0.0,
                lines: Vec::new(),
                body_size: 0.0,
            },
        };
        page.page = pos;
        for line in &page.lines {
            runs += line.runs.len();
            chars += line
                .runs
                .iter()
                .map(|r| r.text.chars().count())
                .sum::<usize>();
        }
        got.insert(pos, page);
    }
    let mut pages_prefix: Vec<PageText> = Vec::new();
    for pos in 0..count {
        match got.remove(&pos) {
            Some(p) => pages_prefix.push(p),
            None => break,
        }
    }
    let doc = DocText {
        pages: pages_prefix,
        page_count: count,
        labels,
    };
    let analysis = analyze(&doc);
    Some(Ready { doc, analysis })
}

#[derive(Debug, Clone)]
enum Phase {
    Idle,
    Building,
    Ready(Arc<Ready>),
    Failed(Instant),
}

struct Slot {
    rev: u64,
    generation: u64,
    phase: Phase,
    cache: HashMap<u32, Arc<Vec<SmartLink>>>,
    used: u64,
}

/// What [`Store::status`] says to a request.
#[derive(Debug, Clone)]
pub enum Status {
    /// The index is built.
    Ready(Arc<Ready>),
    /// A build is running.
    Building,
    /// Nothing is built or running: the caller starts a build for this generation and reports it with [`Store::finish`].
    Start(u64),
}

/// The indexes of the open documents, at most `limits::MAX_SMART_DOCS` (the least recently asked goes first).
#[derive(Default)]
pub struct Store {
    slots: Mutex<HashMap<DocumentId, Slot>>,
    clock: AtomicU64,
    generations: AtomicU64,
}

impl Store {
    fn lock(&self) -> MutexGuard<'_, HashMap<DocumentId, Slot>> {
        self.slots.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The state of the index of `id` at revision `rev`; a slot of another revision is dropped and starts again.
    pub fn status(&self, id: DocumentId, rev: u64) -> Status {
        let used = self.clock.fetch_add(1, Ordering::Relaxed);
        let mut slots = self.lock();
        if !slots.contains_key(&id) && slots.len() >= limits::MAX_SMART_DOCS {
            if let Some(oldest) = slots.iter().min_by_key(|(_, s)| s.used).map(|(&k, _)| k) {
                slots.remove(&oldest);
            }
        }
        let fresh = || Slot {
            rev,
            generation: self.generations.fetch_add(1, Ordering::Relaxed) + 1,
            phase: Phase::Idle,
            cache: HashMap::new(),
            used,
        };
        let slot = slots.entry(id).or_insert_with(fresh);
        if slot.rev != rev {
            *slot = fresh();
        }
        slot.used = used;
        match &slot.phase {
            Phase::Ready(r) => Status::Ready(Arc::clone(r)),
            Phase::Building => Status::Building,
            Phase::Failed(at) if at.elapsed() < RETRY_AFTER => Status::Building,
            Phase::Idle | Phase::Failed(_) => {
                slot.phase = Phase::Building;
                Status::Start(slot.generation)
            }
        }
    }

    /// Whether the build started for `generation` of `id` is still wanted (the revision did not change, the slot was not evicted).
    pub fn wanted(&self, id: DocumentId, generation: u64) -> bool {
        self.lock()
            .get(&id)
            .is_some_and(|s| s.generation == generation)
    }

    /// Records the end of the build of `generation`: `None` is a failure (tried again later). A build of an older generation is ignored.
    pub fn finish(&self, id: DocumentId, generation: u64, ready: Option<Ready>) {
        if let Some(slot) = self.lock().get_mut(&id) {
            if slot.generation == generation {
                slot.phase = match ready {
                    Some(r) => Phase::Ready(Arc::new(r)),
                    None => Phase::Failed(Instant::now()),
                };
            }
        }
    }

    /// The finished links of position `page` at revision `rev`, if they were put.
    pub fn cached(&self, id: DocumentId, rev: u64, page: u32) -> Option<Arc<Vec<SmartLink>>> {
        self.lock()
            .get(&id)
            .filter(|s| s.rev == rev)
            .and_then(|s| s.cache.get(&page).cloned())
    }

    /// Keeps the finished links of position `page` at revision `rev`.
    pub fn put(
        &self,
        id: DocumentId,
        rev: u64,
        page: u32,
        links: Vec<SmartLink>,
    ) -> Arc<Vec<SmartLink>> {
        let links = Arc::new(links);
        if let Some(slot) = self.lock().get_mut(&id).filter(|s| s.rev == rev) {
            slot.cache.insert(page, Arc::clone(&links));
        }
        links
    }

    /// Forgets `id` (the document was closed).
    pub fn forget(&self, id: DocumentId) {
        self.lock().remove(&id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::smartlinks::model::Target;
    use crate::smartlinks::toc::tests::{leader_line, line_of, page_of, run};

    fn id(n: u32) -> DocumentId {
        serde_json::from_str(&n.to_string()).unwrap()
    }

    fn body(text: &str) -> crate::smartlinks::model::Line {
        line_of(vec![run(text, 50.0, 100.0, 300.0, 10.0)])
    }

    fn footer(text: &str) -> crate::smartlinks::model::Line {
        line_of(vec![run(text, 280.0, 770.0, 20.0, 10.0)])
    }

    fn link(kind: Kind, x: f32, score: f32) -> SmartLink {
        SmartLink {
            kind,
            page: 0,
            rects: vec![PtRect {
                x,
                y: 100.0,
                w: 20.0,
                h: 10.0,
            }],
            marker: String::new(),
            target: Target {
                page: 0,
                rect: None,
            },
            preview: String::new(),
            score,
        }
    }

    #[test]
    fn the_read_order_starts_at_the_page_and_its_neighbours_and_is_bounded() {
        assert_eq!(read_order(6, 3), [2, 3, 4, 0, 1, 5]);
        assert_eq!(read_order(6, 0), [0, 1, 2, 3, 4, 5]);
        assert_eq!(read_order(3, 2), [1, 2, 0]);
        assert_eq!(read_order(0, 0), Vec::<u32>::new());
        assert_eq!(
            read_order(5_000, 4_000).len(),
            limits::MAX_SMART_INDEX_PAGES as usize
        );
        assert!(!read_order(5_000, 4_000).contains(&4_000));
    }

    #[test]
    fn obstacles_drop_the_links_they_overlap_and_touching_ones_stay() {
        let a = link(Kind::Reference, 10.0, 0.8);
        let b = link(Kind::Literature, 30.0, 0.8);
        assert!(
            !overlaps(&a.rects[0], &b.rects[0]),
            "touching is not overlapping"
        );
        let c = link(Kind::Footnote, 45.0, 0.9);
        assert!(overlaps(&b.rects[0], &c.rects[0]));
        let kept = drop_conflicts(
            vec![a, b, c],
            &[PtRect {
                x: 48.0,
                y: 95.0,
                w: 2.0,
                h: 30.0,
            }],
        );
        assert_eq!(kept.len(), 1, "b and c overlap the obstacle, a does not");
        assert_eq!(kept[0].kind, Kind::Reference);
    }

    fn reader(pages: Vec<PageText>) -> impl FnMut(u32) -> Result<PageText, ReadFail> {
        move |pos| pages.get(pos as usize).cloned().ok_or(ReadFail::Abort)
    }

    /// A small book: cover, contents (three leader lines), three chapters with footers (printed 1..3 on physical 2..4).
    fn book() -> Vec<PageText> {
        vec![
            page_of(0, vec![body("Cover")]),
            page_of(
                1,
                vec![
                    leader_line(100.0, "Alpha one", "1"),
                    leader_line(120.0, "Beta two", "2"),
                    leader_line(140.0, "Gamma three", "3"),
                ],
            ),
            page_of(2, vec![body("Alpha one"), footer("1")]),
            page_of(3, vec![body("Beta two"), footer("2")]),
            page_of(4, vec![body("Gamma three"), footer("3")]),
        ]
    }

    #[test]
    fn the_build_reads_every_page_and_finds_the_contents_links() {
        let mut asked: Vec<u32> = Vec::new();
        let mut inner = reader(book());
        let ready = build(
            5,
            Vec::new(),
            3,
            Instant::now() + Duration::from_secs(5),
            |p| {
                asked.push(p);
                inner(p)
            },
            || false,
        )
        .unwrap();
        assert_eq!(
            &asked[..3],
            [2, 3, 4],
            "the requested page and its neighbours first"
        );
        assert_eq!(ready.doc.pages.len(), 5);
        assert_eq!(ready.analysis.map.offset(), Some(1));
        let links = page_links(&ready.doc, &ready.analysis, 1);
        assert_eq!(links.len(), 3);
        assert!(links.iter().all(|l| l.kind == Kind::Contents));
        assert_eq!(
            links.iter().map(|l| l.target.page).collect::<Vec<_>>(),
            [2, 3, 4]
        );
        assert!(page_links(&ready.doc, &ready.analysis, 0).is_empty());
        assert!(page_links(&ready.doc, &ready.analysis, 99).is_empty());
    }

    #[test]
    fn an_aborted_or_cancelled_build_makes_nothing_and_a_bad_page_is_empty() {
        let none = |_: u32| -> Result<PageText, ReadFail> { Err(ReadFail::Abort) };
        assert!(build(
            3,
            vec![],
            0,
            Instant::now() + Duration::from_secs(1),
            none,
            || false
        )
        .is_none());
        let ok = reader(book());
        assert!(build(
            5,
            vec![],
            0,
            Instant::now() + Duration::from_secs(1),
            ok,
            || true
        )
        .is_none());
        let bad = |_: u32| -> Result<PageText, ReadFail> { Err(ReadFail::Page) };
        let ready = build(
            3,
            vec![],
            0,
            Instant::now() + Duration::from_secs(1),
            bad,
            || false,
        )
        .unwrap();
        assert_eq!(ready.doc.pages.len(), 3);
        assert!(ready.doc.pages.iter().all(|p| p.lines.is_empty()));
    }

    #[test]
    fn a_spent_deadline_keeps_only_the_prefix_that_was_read() {
        let mut inner = reader(book());
        let mut n = 0;
        // Reads 2 and 3 and 4 (the window around 3), then the deadline is long gone: pages 0 and 1 are missing, so no prefix at all.
        let ready = build(
            5,
            vec![],
            3,
            Instant::now() + Duration::from_millis(200),
            |p| {
                n += 1;
                if n == 4 {
                    std::thread::sleep(Duration::from_millis(300));
                }
                inner(p)
            },
            || false,
        )
        .unwrap();
        assert!(ready.doc.pages.len() < 5);
        assert_eq!(ready.doc.page_count, 5);
        assert!(page_links(&ready.doc, &ready.analysis, 3).is_empty());
    }

    #[test]
    fn the_store_starts_one_build_per_revision_and_forgets_the_old_revision() {
        let store = Store::default();
        let Status::Start(g1) = store.status(id(1), 5) else {
            panic!("first call starts");
        };
        assert!(matches!(store.status(id(1), 5), Status::Building));
        assert!(store.wanted(id(1), g1));
        let ready = Ready {
            doc: DocText::default(),
            analysis: Analysis::default(),
        };
        store.finish(id(1), g1, Some(ready.clone()));
        assert!(matches!(store.status(id(1), 5), Status::Ready(_)));
        store.put(id(1), 5, 0, vec![link(Kind::Reference, 1.0, 0.9)]);
        assert_eq!(store.cached(id(1), 5, 0).unwrap().len(), 1);
        assert!(store.cached(id(1), 6, 0).is_none());

        // A new revision starts again; the old build's end is ignored.
        let Status::Start(g2) = store.status(id(1), 6) else {
            panic!("a new revision starts again");
        };
        assert_ne!(g1, g2);
        assert!(!store.wanted(id(1), g1));
        store.finish(id(1), g1, Some(ready));
        assert!(matches!(store.status(id(1), 6), Status::Building));
        assert!(store.cached(id(1), 5, 0).is_none());
        store.put(id(1), 5, 0, vec![]);
        assert!(
            store.cached(id(1), 6, 0).is_none(),
            "a put for an old revision is dropped"
        );

        // A failed build is not tried at once again.
        store.finish(id(1), g2, None);
        assert!(matches!(store.status(id(1), 6), Status::Building));
        store.forget(id(1));
        assert!(matches!(store.status(id(1), 6), Status::Start(_)));
    }

    #[test]
    fn the_store_keeps_at_most_the_limit_of_documents() {
        let store = Store::default();
        for n in 0..(limits::MAX_SMART_DOCS as u32 + 4) {
            let _ = store.status(id(n), 0);
        }
        assert_eq!(store.lock().len(), limits::MAX_SMART_DOCS);
        // The least recently asked ones are gone, the latest is there.
        assert!(store
            .lock()
            .contains_key(&id(limits::MAX_SMART_DOCS as u32 + 3)));
        assert!(!store.lock().contains_key(&id(0)));
    }
}
