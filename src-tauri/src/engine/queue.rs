//! The engine's job queue (ADR-002 §2, §3): a priority queue in front of the one PDFium worker, with cancellation.
//!
//! Jobs are taken in this order: priority ([`Priority`]), then the newest viewport generation, then first come first served.
//! So whatever the user is looking at is drawn before what they might look at next, and among two pages that are both on
//! screen the one asked for in the most recent scroll comes first. A render is identified by what it draws ([`RenderKey`]);
//! asking again for something that is queued or already running joins that job instead of drawing the page twice. At most
//! `limits::MAX_RENDER_WAITERS` callers join one job (more is a flood, not a UI: they are refused), and the frame the job
//! produces is one `Arc` that every one of them holds, not a copy for each.
//!
//! **Cancellation.** `set_viewport` ([`Queue::set_viewport`]) is how the UI says which pages it shows now: queued renders for
//! other pages fail with `cancelled` before they start, and the ones for pages that stay are re-ranked (visible or near).
//! A render that has started is never interrupted (PDFium cannot be), the pixel limits bound how long it takes. Closing a
//! document cancels everything queued for it ([`Queue::cancel_document`]).
//!
//! **Back-pressure.** The queue holds at most `depth` jobs. A full queue refuses a new job unless it outranks the lowest queued
//! one, which is cancelled to make room, so a burst of thumbnails can never keep a visible page out.
//!
//! The queue is a `BinaryHeap` behind a `Mutex` and a `Condvar` (the worker sleeps on it), shared by every `Engine` handle
//! (producers) and the one worker ([`Requests`], the consumer).

use std::cmp::Ordering;
use std::collections::{BinaryHeap, HashMap, HashSet};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};

use super::{Frame, Job, Reply, Request};
use crate::documents::DocumentId;
use crate::error::{AppError, ErrorCode};
use crate::limits;

/// How urgent a job is, lowest first: the derived order is the order of the queue (ADR-002 §2).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Priority {
    /// Search, other imports, export.
    Background,
    /// Thumbnails of the left panel.
    Thumbnail,
    /// Pages just outside the viewport, rendered ahead of the scroll.
    Near,
    /// Text layer, links and annotation import of the visible pages.
    Interactive,
    /// Pages on screen.
    Visible,
    /// Open, close, page sizes: they change what exists, and are quick.
    Control,
}

/// Where a job stands in the queue: its priority, then the viewport generation it was asked for (the UI counts up with
/// every change of what it shows; a higher one is more recent). Derived `Ord` compares the fields in this order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct Rank {
    pub priority: Priority,
    pub generation: u32,
}

impl Rank {
    /// The rank of everything that is not a render: no generation, so first come first served.
    pub const CONTROL: Rank = Rank {
        priority: Priority::Control,
        generation: 0,
    };
}

/// What a render draws. Two requests with the same key produce the same frame, so they share one job.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct RenderKey {
    pub id: DocumentId,
    pub page_index: u32,
    /// Zoom bucket (`limits::bucket_scale`).
    pub bucket: i16,
    /// `(column, row)` of a 1024 px tile, `None` for the whole page.
    pub tile: Option<(u16, u16)>,
}

/// Why [`Queue::push`] did not take a job.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Refused {
    /// The queue is full of jobs that are at least as urgent.
    Full,
    /// The render asked for is queued or running already, and `limits::MAX_RENDER_WAITERS` callers have joined it.
    TooManyWaiters,
    /// The worker is gone.
    Disconnected,
}

/// A queued job and the position it holds.
struct Queued {
    rank: Rank,
    /// Arrival order, the tie-break: a smaller one is older and goes first.
    seq: u64,
    request: Request,
}

impl PartialEq for Queued {
    fn eq(&self, other: &Self) -> bool {
        self.rank == other.rank && self.seq == other.seq
    }
}

impl Eq for Queued {}

impl PartialOrd for Queued {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for Queued {
    /// "Greater" goes first: the higher rank, and for equal ranks the older job.
    fn cmp(&self, other: &Self) -> Ordering {
        self.rank
            .cmp(&other.rank)
            .then_with(|| other.seq.cmp(&self.seq))
    }
}

/// A render that is queued or running, and the callers that asked for the same frame while it was (at most
/// `limits::MAX_RENDER_WAITERS`). The frame is shared with all of them (`Frame` is an `Arc`), never copied for each.
#[derive(Default)]
struct Slot {
    running: bool,
    waiters: Vec<Reply<Frame>>,
}

#[derive(Default)]
struct State {
    heap: BinaryHeap<Queued>,
    next_seq: u64,
    renders: HashMap<RenderKey, Slot>,
    /// The newest viewport generation seen per document: an older hint (they can overtake each other) is ignored.
    viewports: HashMap<DocumentId, u32>,
    /// Every `Engine` handle is gone: the worker finishes what is queued, then stops.
    closed: bool,
    /// The worker is gone: nothing would ever answer a job.
    consumer_gone: bool,
}

/// What to do with one queued job while the queue is rebuilt.
enum Verdict {
    Keep,
    Cancel,
}

/// A job taken out of the queue unanswered, with the callers that joined it.
struct Removed {
    request: Request,
    waiters: Vec<Reply<Frame>>,
}

impl Removed {
    /// Answers the job and everyone who joined it with `error`. A caller that has given up is not told.
    fn fail(self, error: &AppError) {
        for waiter in self.waiters {
            let _ = waiter.send(Err(error.clone()));
        }
        self.request.job.fail(error.clone());
    }
}

impl State {
    /// Looks at every queued job and keeps or cancels it; `decide` may change the rank of one it keeps. Returns the cancelled
    /// ones, to be answered after the lock is released.
    fn rebuild(&mut self, mut decide: impl FnMut(&mut Queued) -> Verdict) -> Vec<Removed> {
        let entries = std::mem::take(&mut self.heap).into_vec();
        let mut kept = Vec::with_capacity(entries.len());
        let mut removed = Vec::new();
        for mut entry in entries {
            match decide(&mut entry) {
                Verdict::Keep => kept.push(entry),
                Verdict::Cancel => removed.push(self.release(entry)),
            }
        }
        self.heap = BinaryHeap::from(kept);
        removed
    }

    /// Takes a job out of the books: its render slot goes, and the callers that joined it come with it.
    fn release(&mut self, entry: Queued) -> Removed {
        let waiters = match &entry.request.job {
            Job::Render { key, .. } => self
                .renders
                .remove(key)
                .map(|slot| slot.waiters)
                .unwrap_or_default(),
            _ => Vec::new(),
        };
        Removed {
            request: entry.request,
            waiters,
        }
    }
}

/// The queue. Shared by the `Engine` handles (which push) and the worker (which pops through [`Requests`]).
pub(super) struct Queue {
    state: Mutex<State>,
    wake: Condvar,
    depth: usize,
}

impl Queue {
    pub(super) fn new(depth: usize) -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(State::default()),
            wake: Condvar::new(),
            depth,
        })
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        // A poisoned lock only means a holder panicked; the state is plain collections that stay consistent.
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Queues `request` at `rank`. A render for a frame that is queued or running already joins that job (and raises it to
    /// this rank if it is queued and lower). A full queue takes the job only by cancelling the lowest one it outranks.
    pub(super) fn push(&self, request: Request, rank: Rank) -> Result<(), Refused> {
        let mut evicted = Vec::new();
        let outcome = {
            let mut state = self.lock();
            if state.consumer_gone {
                return Err(Refused::Disconnected);
            }
            self.insert(&mut state, request, rank, &mut evicted)
        };
        if !evicted.is_empty() {
            let error = AppError::logged(ErrorCode::Cancelled, "made room for a more urgent job");
            for removed in evicted {
                removed.fail(&error);
            }
        }
        if outcome.is_ok() {
            self.wake.notify_one();
        }
        outcome
    }

    fn insert(
        &self,
        state: &mut State,
        request: Request,
        rank: Rank,
        evicted: &mut Vec<Removed>,
    ) -> Result<(), Refused> {
        let request = match request {
            Request {
                deadline,
                job: Job::Render { key, reply },
            } => {
                if let Some(slot) = state.renders.get_mut(&key) {
                    // Every joined caller holds a thread until the frame is done: a crowd on one frame is turned away.
                    if slot.waiters.len() >= limits::MAX_RENDER_WAITERS {
                        return Err(Refused::TooManyWaiters);
                    }
                    slot.waiters.push(reply);
                    if !slot.running {
                        state.rebuild(|entry| {
                            if entry.request.render_key() == Some(key) && rank > entry.rank {
                                entry.rank = rank;
                            }
                            Verdict::Keep
                        });
                    }
                    return Ok(());
                }
                Request {
                    deadline,
                    job: Job::Render { key, reply },
                }
            }
            other => other,
        };

        if state.heap.len() >= self.depth {
            // Jobs whose callers have given up only take room.
            let expired = state.rebuild(|entry| {
                if entry.request.expired() {
                    Verdict::Cancel
                } else {
                    Verdict::Keep
                }
            });
            let timeout = AppError::logged(ErrorCode::EngineTimeout, "job expired in the queue");
            for removed in expired {
                removed.fail(&timeout);
            }
        }
        if state.heap.len() >= self.depth {
            let lowest = state.heap.iter().min().map(|entry| (entry.rank, entry.seq));
            match lowest {
                Some((lowest_rank, seq)) if rank > lowest_rank => {
                    evicted.extend(state.rebuild(|entry| {
                        if entry.seq == seq {
                            Verdict::Cancel
                        } else {
                            Verdict::Keep
                        }
                    }));
                }
                _ => return Err(Refused::Full),
            }
        }

        if let Some(key) = request.render_key() {
            state.renders.insert(key, Slot::default());
        }
        let seq = state.next_seq;
        state.next_seq += 1;
        state.heap.push(Queued { rank, seq, request });
        Ok(())
    }

    /// Takes the most urgent job, waiting for one. `None` once every `Engine` handle is gone and the queue is empty.
    fn pop(&self) -> Option<Request> {
        let mut state = self.lock();
        loop {
            if let Some(entry) = state.heap.pop() {
                if let Some(slot) = entry
                    .request
                    .render_key()
                    .and_then(|key| state.renders.get_mut(&key))
                {
                    slot.running = true;
                }
                return Some(entry.request);
            }
            if state.closed {
                return None;
            }
            state = self
                .wake
                .wait(state)
                .unwrap_or_else(PoisonError::into_inner);
        }
    }

    /// The worker has answered the render of `key`: the callers that joined it meanwhile are handed over, to get the same
    /// answer. Atomic with [`Queue::push`], so a request either joined before this or starts a new job after it.
    pub(super) fn finish_render(&self, key: &RenderKey) -> Vec<Reply<Frame>> {
        self.lock()
            .renders
            .remove(key)
            .map(|slot| slot.waiters)
            .unwrap_or_default()
    }

    /// The UI shows `visible` pages and, around them, `near` ones (ADR-002 §3). Queued renders of the document that were asked
    /// for at this generation or earlier and are for neither set fail with `cancelled`; the ones that are kept are re-ranked,
    /// visible or near, at this generation. Thumbnails and everything else are left alone, and so are renders asked for after
    /// this hint was made (a newer generation). A hint older than one that was already applied is ignored.
    pub(super) fn set_viewport(
        &self,
        id: DocumentId,
        generation: u32,
        visible: &[u32],
        near: &[u32],
    ) {
        let visible: HashSet<u32> = visible.iter().copied().collect();
        let near: HashSet<u32> = near.iter().copied().collect();
        let cancelled = {
            let mut state = self.lock();
            if state
                .viewports
                .get(&id)
                .is_some_and(|&latest| generation < latest)
            {
                return;
            }
            state.viewports.insert(id, generation);
            state.rebuild(|entry| {
                let Job::Render { key, .. } = &entry.request.job else {
                    return Verdict::Keep;
                };
                let page = key.page_index;
                let in_viewport = matches!(entry.rank.priority, Priority::Visible | Priority::Near)
                    && key.id == id
                    && entry.rank.generation <= generation;
                if !in_viewport {
                    return Verdict::Keep;
                }
                if visible.contains(&page) {
                    entry.rank = Rank {
                        priority: Priority::Visible,
                        generation,
                    };
                    Verdict::Keep
                } else if near.contains(&page) {
                    entry.rank = Rank {
                        priority: Priority::Near,
                        generation,
                    };
                    Verdict::Keep
                } else {
                    Verdict::Cancel
                }
            })
        };
        let error = AppError::logged(ErrorCode::Cancelled, "the page left the viewport");
        for removed in cancelled {
            removed.fail(&error);
        }
    }

    /// Cancels every queued render of the document, and forgets its viewport (it is closed).
    pub(super) fn cancel_document(&self, id: DocumentId) {
        let cancelled = {
            let mut state = self.lock();
            state.viewports.remove(&id);
            state.rebuild(|entry| match entry.request.render_key() {
                Some(key) if key.id == id => Verdict::Cancel,
                _ => Verdict::Keep,
            })
        };
        let error = AppError::logged(ErrorCode::Cancelled, "the document was closed");
        for removed in cancelled {
            removed.fail(&error);
        }
    }

    /// Every `Engine` handle is gone: the worker drains the queue and stops.
    pub(super) fn close(&self) {
        self.lock().closed = true;
        self.wake.notify_all();
    }

    /// The worker is gone. What is queued is dropped, which tells its callers (their reply channels close), and new jobs
    /// are refused.
    fn consumer_dropped(&self) {
        let mut state = self.lock();
        state.consumer_gone = true;
        state.heap.clear();
        state.renders.clear();
    }

    #[cfg(test)]
    pub(super) fn len(&self) -> usize {
        self.lock().heap.len()
    }

    /// How many callers joined the render of `key` (queued or running), `None` if there is no such render.
    #[cfg(test)]
    pub(super) fn waiters(&self, key: &RenderKey) -> Option<usize> {
        self.lock().renders.get(key).map(|slot| slot.waiters.len())
    }
}

/// The worker's end of the queue: an iterator over jobs in order that ends when every `Engine` handle is gone. Dropping it
/// (the worker ended, or never started) makes every later `push` fail with `Disconnected`.
pub(crate) struct Requests {
    queue: Arc<Queue>,
}

impl Requests {
    pub(super) fn new(queue: Arc<Queue>) -> Self {
        Self { queue }
    }

    /// The worker answered the render of `key`; see [`Queue::finish_render`].
    pub(super) fn finish_render(&self, key: &RenderKey) -> Vec<Reply<Frame>> {
        self.queue.finish_render(key)
    }

    /// Cancels what is queued for a document that was closed.
    pub(super) fn cancel_document(&self, id: DocumentId) {
        self.queue.cancel_document(id);
    }

    /// Answers a job that is not going to run, and everyone who joined it, with `error`.
    pub(super) fn fail(&self, request: Request, error: &AppError) {
        let waiters = request
            .render_key()
            .map(|key| self.queue.finish_render(&key))
            .unwrap_or_default();
        Removed { request, waiters }.fail(error);
    }
}

impl Iterator for Requests {
    type Item = Request;

    fn next(&mut self) -> Option<Request> {
        self.queue.pop()
    }
}

impl Drop for Requests {
    fn drop(&mut self) {
        self.queue.consumer_dropped();
    }
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc;
    use std::thread;
    use std::time::{Duration, Instant};

    use super::*;

    type Answer = mpsc::Receiver<Result<Frame, AppError>>;

    fn doc(n: u32) -> DocumentId {
        // Ids come from the registry; tests make as many as they need.
        let registry = crate::documents::Registry::new();
        let mut id = None;
        for i in 0..=n {
            id = Some(
                registry
                    .register(std::path::PathBuf::from(format!("doc-{i}.pdf")))
                    .unwrap(),
            );
        }
        id.unwrap()
    }

    fn key(id: DocumentId, page: u32) -> RenderKey {
        RenderKey {
            id,
            page_index: page,
            bucket: 4,
            tile: None,
        }
    }

    fn render_request(key: RenderKey) -> (Request, Answer) {
        let (reply, answer) = mpsc::sync_channel(1);
        let request = Request {
            deadline: Instant::now() + Duration::from_secs(60),
            job: Job::Render { key, reply },
        };
        (request, answer)
    }

    fn rank(priority: Priority, generation: u32) -> Rank {
        Rank {
            priority,
            generation,
        }
    }

    /// Takes everything that is queued, in the order the worker would.
    fn drain(queue: &Arc<Queue>) -> Vec<RenderKey> {
        let mut order = Vec::new();
        while queue.len() > 0 {
            let request = queue.pop().unwrap();
            if let Some(key) = request.render_key() {
                queue.finish_render(&key);
                order.push(key);
            }
        }
        order
    }

    fn push(queue: &Arc<Queue>, key: RenderKey, rank: Rank) -> Answer {
        let (request, answer) = render_request(key);
        queue.push(request, rank).unwrap();
        answer
    }

    fn code(answer: &Answer) -> ErrorCode {
        answer
            .recv_timeout(Duration::from_secs(2))
            .unwrap()
            .unwrap_err()
            .code()
    }

    #[test]
    fn priorities_are_ordered_as_in_adr_002() {
        use Priority::*;
        let ascending = [Background, Thumbnail, Near, Interactive, Visible, Control];
        assert!(ascending.windows(2).all(|pair| pair[0] < pair[1]));
    }

    #[test]
    fn jobs_run_by_priority_then_newest_generation_then_arrival() {
        let queue = Queue::new(64);
        let d = doc(0);
        // Pushed in a deliberately wrong order.
        let _a = push(&queue, key(d, 0), rank(Priority::Thumbnail, 9));
        let _b = push(&queue, key(d, 1), rank(Priority::Near, 1));
        let _c = push(&queue, key(d, 2), rank(Priority::Visible, 1));
        let _d = push(&queue, key(d, 3), rank(Priority::Visible, 3));
        let _e = push(&queue, key(d, 4), rank(Priority::Visible, 3));
        let _f = push(&queue, key(d, 5), rank(Priority::Interactive, 0));
        let _g = push(&queue, key(d, 6), rank(Priority::Background, 99));
        let pages: Vec<u32> = drain(&queue).iter().map(|k| k.page_index).collect();
        // Visible: generation 3 before 1, and of the two at 3 the one that came first (3 before 4). Then interactive,
        // near, thumbnail, background.
        assert_eq!(pages, [3, 4, 2, 5, 1, 0, 6]);
    }

    #[test]
    fn control_jobs_go_before_every_render_and_keep_their_own_order() {
        let queue = Queue::new(64);
        let d = doc(0);
        let _render = push(&queue, key(d, 0), rank(Priority::Visible, u32::MAX));
        let (tx1, _rx1) = mpsc::sync_channel(1);
        let (tx2, _rx2) = mpsc::sync_channel(1);
        queue
            .push(
                Request {
                    deadline: Instant::now() + Duration::from_secs(60),
                    job: Job::Close { id: d, reply: tx1 },
                },
                Rank::CONTROL,
            )
            .unwrap();
        queue
            .push(
                Request {
                    deadline: Instant::now() + Duration::from_secs(60),
                    job: Job::Close { id: d, reply: tx2 },
                },
                Rank::CONTROL,
            )
            .unwrap();
        let first = queue.pop().unwrap();
        let second = queue.pop().unwrap();
        let third = queue.pop().unwrap();
        assert!(matches!(first.job, Job::Close { .. }));
        assert!(matches!(second.job, Job::Close { .. }));
        assert!(matches!(third.job, Job::Render { .. }));
    }

    #[test]
    fn a_viewport_hint_cancels_queued_renders_of_other_pages() {
        let queue = Queue::new(64);
        let d = doc(0);
        let gone = push(&queue, key(d, 7), rank(Priority::Visible, 1));
        let stays = push(&queue, key(d, 8), rank(Priority::Visible, 1));
        let ahead = push(&queue, key(d, 9), rank(Priority::Near, 1));
        queue.set_viewport(d, 2, &[8], &[9]);

        assert_eq!(code(&gone), ErrorCode::Cancelled);
        assert_eq!(queue.len(), 2);
        assert!(
            stays.try_recv().is_err(),
            "the page that stays was not answered"
        );
        assert!(ahead.try_recv().is_err());
        let pages: Vec<u32> = drain(&queue).iter().map(|k| k.page_index).collect();
        assert_eq!(pages, [8, 9]);
    }

    #[test]
    fn a_hint_reranks_the_renders_it_keeps() {
        let queue = Queue::new(64);
        let d = doc(0);
        // Page 1 was asked for as "near" long ago, page 2 as "visible".
        let _near = push(&queue, key(d, 1), rank(Priority::Near, 1));
        let _visible = push(&queue, key(d, 2), rank(Priority::Visible, 1));
        // Now page 1 is on screen and page 2 only close by.
        queue.set_viewport(d, 5, &[1], &[2]);
        let pages: Vec<u32> = drain(&queue).iter().map(|k| k.page_index).collect();
        assert_eq!(pages, [1, 2]);
    }

    #[test]
    fn a_hint_leaves_thumbnails_other_documents_and_newer_requests_alone() {
        let queue = Queue::new(64);
        let (d, other) = (doc(0), doc(1));
        let thumbnail = push(&queue, key(d, 40), rank(Priority::Thumbnail, 1));
        let elsewhere = push(&queue, key(other, 0), rank(Priority::Visible, 1));
        let newer = push(&queue, key(d, 50), rank(Priority::Visible, 9));
        let older = push(&queue, key(d, 51), rank(Priority::Visible, 4));
        queue.set_viewport(d, 5, &[], &[]);

        // Only the render that was asked for at generation 5 or earlier and is not wanted any more went.
        assert_eq!(code(&older), ErrorCode::Cancelled);
        assert!(thumbnail.try_recv().is_err());
        assert!(elsewhere.try_recv().is_err());
        assert!(newer.try_recv().is_err());
        assert_eq!(queue.len(), 3);
    }

    #[test]
    fn an_older_hint_that_arrives_late_is_ignored() {
        let queue = Queue::new(64);
        let d = doc(0);
        queue.set_viewport(d, 7, &[1], &[]);
        let page = push(&queue, key(d, 2), rank(Priority::Visible, 6));
        // A hint from before the last one: it must neither cancel nor re-rank anything.
        queue.set_viewport(d, 3, &[], &[]);
        assert!(page.try_recv().is_err());
        assert_eq!(queue.len(), 1);
    }

    #[test]
    fn closing_a_document_cancels_everything_queued_for_it() {
        let queue = Queue::new(64);
        let (d, other) = (doc(0), doc(1));
        let a = push(&queue, key(d, 0), rank(Priority::Visible, 1));
        let b = push(&queue, key(d, 1), rank(Priority::Thumbnail, 1));
        let c = push(&queue, key(other, 0), rank(Priority::Visible, 1));
        queue.cancel_document(d);
        assert_eq!(code(&a), ErrorCode::Cancelled);
        assert_eq!(code(&b), ErrorCode::Cancelled);
        assert!(c.try_recv().is_err());
        assert_eq!(queue.len(), 1);
    }

    #[test]
    fn a_frame_asked_for_twice_is_one_job_with_two_waiters() {
        let queue = Queue::new(64);
        let d = doc(0);
        let first = push(&queue, key(d, 0), rank(Priority::Near, 1));
        let second = push(&queue, key(d, 0), rank(Priority::Visible, 2));
        assert_eq!(queue.len(), 1, "the second request joined the first");

        let request = queue.pop().unwrap();
        // A third asks while the job runs: it joins the running job.
        let third = push(&queue, key(d, 0), rank(Priority::Visible, 3));
        assert_eq!(queue.len(), 0);
        let Job::Render {
            key: running,
            reply,
        } = request.job
        else {
            panic!("not a render");
        };
        let waiters = queue.finish_render(&running);
        assert_eq!(waiters.len(), 2);
        // One frame, handed to everybody: each caller gets a handle on the same bytes, not a copy of them.
        let frame: Frame = Arc::new(vec![7]);
        for waiter in waiters {
            waiter.send(Ok(Arc::clone(&frame))).unwrap();
        }
        reply.send(Ok(Arc::clone(&frame))).unwrap();
        for answer in [first, second, third] {
            let got = answer.recv().unwrap().unwrap();
            assert_eq!(*got, vec![7]);
            assert!(Arc::ptr_eq(&got, &frame));
        }
        // Once answered, the same frame is a new job.
        let _again = push(&queue, key(d, 0), rank(Priority::Visible, 4));
        assert_eq!(queue.len(), 1);
    }

    #[test]
    fn the_callers_that_join_one_frame_are_capped_and_the_rest_are_turned_away() {
        let queue = Queue::new(64);
        let d = doc(0);
        let k = key(d, 0);
        let _starter = push(&queue, k, rank(Priority::Visible, 1));
        let joined: Vec<Answer> = (0..limits::MAX_RENDER_WAITERS)
            .map(|_| push(&queue, k, rank(Priority::Visible, 1)))
            .collect();
        assert_eq!(queue.waiters(&k), Some(limits::MAX_RENDER_WAITERS));

        // One more is refused, and costs nothing: it is neither queued nor counted, and a refusal does not disturb the others.
        let (request, refused) = render_request(k);
        assert_eq!(
            queue.push(request, rank(Priority::Visible, 9)),
            Err(Refused::TooManyWaiters)
        );
        assert_eq!(queue.waiters(&k), Some(limits::MAX_RENDER_WAITERS));
        assert_eq!(queue.len(), 1);
        assert!(refused.recv().is_err(), "its reply channel was dropped");

        // The limit holds while the job runs, too ...
        let running = queue.pop().unwrap();
        let (request, _answer) = render_request(k);
        assert_eq!(
            queue.push(request, rank(Priority::Visible, 9)),
            Err(Refused::TooManyWaiters)
        );
        // ... and the callers that got in are all answered.
        let frame: Frame = Arc::new(vec![1, 2, 3]);
        let waiters = queue.finish_render(&k);
        assert_eq!(waiters.len(), limits::MAX_RENDER_WAITERS);
        for waiter in waiters {
            waiter.send(Ok(Arc::clone(&frame))).unwrap();
        }
        for answer in joined {
            assert!(Arc::ptr_eq(&answer.recv().unwrap().unwrap(), &frame));
        }
        // Once the frame is done a caller starts a new job: the limit is per job, not per frame forever.
        drop(running);
        let _again = push(&queue, k, rank(Priority::Visible, 10));
        assert_eq!(queue.len(), 1);
    }

    #[test]
    fn a_job_that_is_not_the_same_frame_does_not_use_up_the_limit_of_another() {
        let queue = Queue::new(64);
        let d = doc(0);
        let _crowded = push(&queue, key(d, 0), rank(Priority::Visible, 1));
        for _ in 0..limits::MAX_RENDER_WAITERS {
            push(&queue, key(d, 0), rank(Priority::Visible, 1));
        }
        // Another page asks for its own job although the first one is crowded.
        let _other = push(&queue, key(d, 1), rank(Priority::Visible, 1));
        assert_eq!(queue.len(), 2);
    }

    #[test]
    fn frames_of_different_tiles_and_of_the_whole_page_do_not_coalesce() {
        let queue = Queue::new(64);
        let d = doc(0);
        let tile = |t: Option<(u16, u16)>| RenderKey {
            tile: t,
            ..key(d, 0)
        };
        let _whole = push(&queue, tile(None), rank(Priority::Visible, 1));
        let _a = push(&queue, tile(Some((0, 0))), rank(Priority::Visible, 1));
        let _b = push(&queue, tile(Some((1, 0))), rank(Priority::Visible, 1));
        let _c = push(&queue, tile(Some((0, 1))), rank(Priority::Visible, 1));
        // Four frames, four jobs, no waiters anywhere.
        assert_eq!(queue.len(), 4);
        for t in [None, Some((0, 0)), Some((1, 0)), Some((0, 1))] {
            assert_eq!(queue.waiters(&tile(t)), Some(0), "{t:?}");
        }
        // The same tile again is the same frame: it joins.
        let _again = push(&queue, tile(Some((1, 0))), rank(Priority::Visible, 1));
        assert_eq!(queue.len(), 4);
        assert_eq!(queue.waiters(&tile(Some((1, 0)))), Some(1));
        // A different bucket of the same page is another frame, too.
        let other_bucket = RenderKey {
            bucket: 5,
            ..tile(None)
        };
        let _scaled = push(&queue, other_bucket, rank(Priority::Visible, 1));
        assert_eq!(queue.len(), 5);
    }

    #[test]
    fn a_visible_render_of_generation_zero_goes_before_a_near_one_of_the_newest_generation() {
        let queue = Queue::new(64);
        let d = doc(0);
        let _near = push(&queue, key(d, 0), rank(Priority::Near, u32::MAX));
        let _visible = push(&queue, key(d, 1), rank(Priority::Visible, 0));
        let _thumbnail = push(&queue, key(d, 2), rank(Priority::Thumbnail, u32::MAX));
        let pages: Vec<u32> = drain(&queue).iter().map(|k| k.page_index).collect();
        // The priority decides first; the generation only orders jobs of one priority.
        assert_eq!(pages, [1, 0, 2]);
    }

    #[test]
    fn joining_a_queued_job_raises_it() {
        let queue = Queue::new(64);
        let d = doc(0);
        let _low = push(&queue, key(d, 0), rank(Priority::Near, 1));
        let _middle = push(&queue, key(d, 1), rank(Priority::Visible, 1));
        // Asked for again as visible and more recently: it now goes before page 1.
        let _high = push(&queue, key(d, 0), rank(Priority::Visible, 2));
        let pages: Vec<u32> = drain(&queue).iter().map(|k| k.page_index).collect();
        assert_eq!(pages, [0, 1]);
    }

    #[test]
    fn a_waiter_of_a_cancelled_job_is_cancelled_with_it() {
        let queue = Queue::new(64);
        let d = doc(0);
        let first = push(&queue, key(d, 3), rank(Priority::Visible, 1));
        let second = push(&queue, key(d, 3), rank(Priority::Visible, 1));
        queue.set_viewport(d, 2, &[], &[]);
        assert_eq!(code(&first), ErrorCode::Cancelled);
        assert_eq!(code(&second), ErrorCode::Cancelled);
        // The slot is gone with it: the page can be asked for again.
        let _again = push(&queue, key(d, 3), rank(Priority::Visible, 3));
        assert_eq!(queue.len(), 1);
    }

    #[test]
    fn a_full_queue_refuses_a_job_that_does_not_outrank_the_lowest() {
        let queue = Queue::new(2);
        let d = doc(0);
        let _a = push(&queue, key(d, 0), rank(Priority::Visible, 1));
        let _b = push(&queue, key(d, 1), rank(Priority::Near, 1));
        let (request, _answer) = render_request(key(d, 2));
        // Equal to the lowest queued one (an older job wins a tie): refused.
        assert_eq!(
            queue.push(request, rank(Priority::Near, 1)),
            Err(Refused::Full)
        );
        let (request, _answer) = render_request(key(d, 3));
        assert_eq!(
            queue.push(request, rank(Priority::Thumbnail, 9)),
            Err(Refused::Full)
        );
        assert_eq!(queue.len(), 2);
    }

    #[test]
    fn a_full_queue_makes_room_for_a_more_urgent_job_by_cancelling_the_lowest() {
        let queue = Queue::new(2);
        let d = doc(0);
        let near = push(&queue, key(d, 0), rank(Priority::Near, 1));
        let thumbnail = push(&queue, key(d, 1), rank(Priority::Thumbnail, 1));
        let visible = push(&queue, key(d, 2), rank(Priority::Visible, 1));
        assert_eq!(code(&thumbnail), ErrorCode::Cancelled);
        assert!(near.try_recv().is_err() && visible.try_recv().is_err());
        // A newer generation of the same priority also outranks an old one.
        let newer = push(&queue, key(d, 3), rank(Priority::Visible, 5));
        assert_eq!(code(&near), ErrorCode::Cancelled);
        assert!(newer.try_recv().is_err());
        let pages: Vec<u32> = drain(&queue).iter().map(|k| k.page_index).collect();
        assert_eq!(pages, [3, 2]);
    }

    #[test]
    fn jobs_whose_callers_have_given_up_do_not_take_room_from_the_full_queue() {
        let queue = Queue::new(1);
        let d = doc(0);
        let (reply, stale) = mpsc::sync_channel(1);
        queue
            .push(
                Request {
                    deadline: Instant::now(),
                    job: Job::Render {
                        key: key(d, 0),
                        reply,
                    },
                },
                rank(Priority::Visible, 1),
            )
            .unwrap();
        thread::sleep(Duration::from_millis(5));
        // Same rank, so it could not push the old job out; it does not have to, that one is expired.
        let fresh = push(&queue, key(d, 1), rank(Priority::Visible, 1));
        assert_eq!(code(&stale), ErrorCode::EngineTimeout);
        assert!(fresh.try_recv().is_err());
        assert_eq!(queue.len(), 1);
    }

    #[test]
    fn the_worker_waits_for_a_job_and_stops_when_every_handle_is_gone() {
        let queue = Queue::new(8);
        let mut requests = Requests::new(Arc::clone(&queue));
        let worker = thread::spawn(move || {
            let mut seen = 0;
            while requests.next().is_some() {
                seen += 1;
            }
            seen
        });
        thread::sleep(Duration::from_millis(30));
        let (reply, _answer) = mpsc::sync_channel(1);
        queue
            .push(
                Request {
                    deadline: Instant::now() + Duration::from_secs(5),
                    job: Job::Close { id: doc(0), reply },
                },
                Rank::CONTROL,
            )
            .unwrap();
        queue.close();
        assert_eq!(
            worker.join().unwrap(),
            1,
            "the job queued before the close still runs"
        );
    }

    #[test]
    fn a_queue_without_a_worker_refuses_jobs_and_tells_the_ones_it_dropped() {
        let queue = Queue::new(8);
        let d = doc(0);
        let queued = push(&queue, key(d, 0), rank(Priority::Visible, 1));
        drop(Requests::new(Arc::clone(&queue)));
        // The queued job's reply channel closed: its caller sees a disconnect, not silence.
        assert!(queued.recv().is_err());
        let (request, _answer) = render_request(key(d, 1));
        assert_eq!(
            queue.push(request, rank(Priority::Visible, 1)),
            Err(Refused::Disconnected)
        );
    }
}
