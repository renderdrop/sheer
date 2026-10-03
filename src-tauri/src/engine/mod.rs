//! PDF engine: one dedicated worker thread owns PDFium and every open document (ADR-002).
//!
//! PDFium is not thread-safe, so no other thread ever touches it. Callers talk to the worker through a priority queue
//! ([`queue`]): what the user looks at is drawn before what they may look at next, and `set_viewport` cancels queued renders
//! for pages that scrolled out of view. Each job carries its own reply channel and a deadline (see [`crate::limits`]). The
//! worker runs each job inside `catch_unwind`, so a panic becomes `engine_crashed` instead of taking the app down, and it
//! skips jobs whose caller has already given up (a close excepted: it still releases its document). A caller that times
//! out gets `engine_timeout`; while the stuck job is still running, new jobs fail fast with `engine_unavailable`
//! ([`guard::Health`]) instead of piling up behind it. The size of every page of a document is read once when it is
//! loaded and answered from a table afterwards ([`sizes`], which also keeps the document's flags), not by a job per question.
//!
//! Besides frames the worker reads what the document says: its outline ([`outline`]), the text of a page ([`text`]), the links of
//! a page ([`links`]) and one page of a search ([`search`]). The first three are `Interactive` jobs, a search page is
//! `Background`, so a search never keeps a visible page waiting for more than the one page it is on. [`space`] puts what PDFium says
//! about positions into the page space of the UI.
//!
//! The PDFium library is bundled as a Tauri resource (`scripts/fetch-pdfium.sh`) and bound dynamically at runtime.
//! If it cannot be loaded, the worker stays alive and answers every job with `engine_unavailable`.

pub mod encode;
mod guard;
mod import;
mod links;
mod outline;
mod pages;
pub mod queue;
mod search;
mod sizes;
mod space;
mod text;
mod worker;

use std::collections::HashSet;
use std::fs::File;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError, SyncSender};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

use zeroize::Zeroizing;

use crate::documents::sources::SourceBytes;
use crate::documents::{DocFlags, DocumentId};
use crate::error::{AppError, ErrorCode};
use crate::limits;
use crate::model::annotation::Imported;
use crate::model::geometry::Quad;

use self::guard::Health;
pub use self::links::{LinkTarget, PageLink};
pub use self::outline::OutlineItem;
pub use self::pages::Appended;
pub use self::queue::{Priority, Rank, RenderKey};
use self::queue::{Queue, Refused, Requests};
pub use self::search::SearchSpec;
pub use self::sizes::PageSizes;
use self::sizes::SizeCache;
pub use self::space::PageSpot;
pub use self::text::TextPage;

/// Directory name of the bundled PDFium build for this target, as created by `scripts/fetch-pdfium.sh`.
pub const PLATFORM_DIR: &str = if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
    "win-x64"
} else if cfg!(all(target_os = "windows", target_arch = "aarch64")) {
    "win-arm64"
} else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
    "mac-x64"
} else if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
    "mac-arm64"
} else {
    "unsupported"
};

/// File name of the PDFium dynamic library on this target.
pub const LIBRARY_FILE: &str = if cfg!(target_os = "windows") {
    "pdfium.dll"
} else if cfg!(target_os = "macos") {
    "libpdfium.dylib"
} else {
    "libpdfium.so"
};

/// Location of the PDFium library below a `pdfium/` root (the bundled resource directory or `src-tauri/pdfium`).
pub fn library_path(pdfium_root: &Path) -> PathBuf {
    pdfium_root.join(PLATFORM_DIR).join(LIBRARY_FILE)
}

type Reply<T> = SyncSender<Result<T, AppError>>;

/// An encoded frame (see [`encode`]), shared: the callers that asked for the same frame while it was queued or running all get
/// the one `Arc`, so the worker, which is the bottleneck, never copies a multi-megabyte image once per caller. A caller that
/// needs the bytes by value (the IPC response) takes them with `Arc::try_unwrap`, which copies only when others still hold it.
pub type Frame = Arc<Vec<u8>>;

/// One unit of work for the worker, with the point in time at which its caller stops waiting.
pub(crate) struct Request {
    deadline: Instant,
    job: Job,
}

impl Request {
    /// The caller has already given up (the worker was busy with an earlier job), so starting would be wasted work. Never true
    /// for a close: it releases what a document holds, so it runs although nobody waits for its answer any more, or a close that
    /// timed out would leave the document in the worker for good.
    fn expired(&self) -> bool {
        !matches!(self.job, Job::Close { .. }) && Instant::now() >= self.deadline
    }

    /// The point in time after which a worker still busy with this request counts as stuck (`Health`): the caller's deadline,
    /// except for a close that runs late, which is given the time a close is allowed.
    fn run_deadline(&self) -> Instant {
        match self.job {
            Job::Close { .. } => self.deadline.max(Instant::now() + limits::CONTROL_TIMEOUT),
            _ => self.deadline,
        }
    }

    /// What the request draws, if it is a render.
    fn render_key(&self) -> Option<RenderKey> {
        match &self.job {
            Job::Render { key, .. } => Some(*key),
            _ => None,
        }
    }
}

/// Asked by the worker once it has loaded a document, with the page count: "does anybody still want it?". It answers `true`
/// if so (and by then has recorded the document, see `Registry::set_page_count`) and `false` if the caller gave up in the
/// meantime, and then the worker drops the document instead of keeping one nobody can ever close.
pub(crate) type Confirm = Box<dyn FnOnce(u32) -> bool + Send>;

/// What a document is loaded again from.
pub(crate) enum ReopenSource {
    File(File),
    Bytes(Vec<u8>),
}

pub(crate) enum Job {
    Open {
        id: DocumentId,
        /// The file as intake judged it (`documents::intake`): PDFium reads this very handle, and no path is opened again.
        file: File,
        /// The password the user typed for an encrypted file (`Engine::open_with_password`); wiped when the job is dropped.
        password: Option<Zeroizing<String>>,
        confirm: Confirm,
        reply: Reply<u32>,
    },
    /// One frame of one page. Callers that ask for the same frame meanwhile are not jobs of their own: they wait for this
    /// one's answer (`queue`).
    Render { key: RenderKey, reply: Reply<Frame> },
    /// The outline of the document (`outline`).
    Outline {
        id: DocumentId,
        reply: Reply<Vec<OutlineItem>>,
    },
    /// The text of one page with the box of every character (`text`).
    TextLayer {
        id: DocumentId,
        page_index: u32,
        reply: Reply<TextPage>,
    },
    /// The links of one page (`links`).
    PageLinks {
        id: DocumentId,
        page_index: u32,
        reply: Reply<Vec<PageLink>>,
    },
    /// The annotations of one page as the file has them (`import`).
    ImportAnnotations {
        id: DocumentId,
        page_index: u32,
        reply: Reply<Vec<Imported>>,
    },
    /// Hides or shows annotations of PDFium's in-memory copy, by `(page index, position in the page's annotations)`, so that the page
    /// render stops drawing an original the model has changed or deleted, and draws it again on undo (`import::set_hidden`).
    SetAnnotationsHidden {
        id: DocumentId,
        hide: Vec<(u32, u32)>,
        show: Vec<(u32, u32)>,
        reply: Reply<()>,
    },
    /// A search of one page: its first `limit` hits (`search`).
    SearchPage {
        id: DocumentId,
        page_index: u32,
        spec: Arc<SearchSpec>,
        limit: usize,
        reply: Reply<Vec<Vec<Quad>>>,
    },
    /// Sets the `/Rotate` of pages of PDFium's copy, by `(engine index, degrees)` (`pages`).
    SetPageRotations {
        id: DocumentId,
        items: Vec<(u32, u16)>,
        reply: Reply<()>,
    },
    /// Adds an empty page of `size` points to the end of PDFium's copy (`pages`).
    AppendBlankPage {
        id: DocumentId,
        size: [f32; 2],
        reply: Reply<Appended>,
    },
    /// Takes the pages from `keep` on off the end of PDFium's copy again, if it still has `total` pages (`pages::truncate`): the undo of an
    /// append whose insert the model refused.
    TruncatePages {
        id: DocumentId,
        keep: u32,
        total: u32,
        reply: Reply<()>,
    },
    /// Copies pages of an import source to the end of PDFium's copy (`pages`).
    AppendPages {
        id: DocumentId,
        source: Arc<SourceBytes>,
        pages: Vec<u32>,
        reply: Reply<Vec<Appended>>,
    },
    /// Lets go of PDFium's copy of the document but keeps what the UI knows of it (its page sizes), so that the file can be replaced
    /// (ADR-002 §7, ADR-004 §1 step 8). Followed by a `Reopen`.
    Release {
        id: DocumentId,
        /// Answer with the copy as it is (pages added, rotations set), to put back if the file cannot be replaced.
        snapshot: bool,
        reply: Reply<Option<Vec<u8>>>,
    },
    /// Loads the document again from `file`, which replaced the one that was released, under the same id; the page sizes and flags are
    /// read afresh. A document that had crashed is healthy again.
    Reopen {
        id: DocumentId,
        source: ReopenSource,
        reply: Reply<u32>,
    },
    /// Releases the document, and the sizes of its pages. Not skipped when its caller gave up (`Request::expired`).
    Close { id: DocumentId, reply: Reply<()> },
    /// Makes the worker panic inside the job guard, to test panic containment. `id` is the document it "works on".
    #[cfg(test)]
    Crash {
        id: Option<DocumentId>,
        reply: Reply<()>,
    },
    /// Keeps the worker busy until `gate` receives (or its sender is dropped), to test what happens to jobs that wait.
    #[cfg(test)]
    Hold {
        gate: mpsc::Receiver<()>,
        reply: Reply<()>,
    },
}

impl Job {
    /// Answers the job with an error without doing any work.
    fn fail(self, error: AppError) {
        // The caller may have timed out and dropped its receiver; there is nobody to tell then.
        match self {
            Job::Open { reply, .. } => {
                let _ = reply.send(Err(error));
            }
            Job::Render { reply, .. } => {
                let _ = reply.send(Err(error));
            }
            Job::Outline { reply, .. } => {
                let _ = reply.send(Err(error));
            }
            Job::TextLayer { reply, .. } => {
                let _ = reply.send(Err(error));
            }
            Job::PageLinks { reply, .. } => {
                let _ = reply.send(Err(error));
            }
            Job::ImportAnnotations { reply, .. } => {
                let _ = reply.send(Err(error));
            }
            Job::SetAnnotationsHidden { reply, .. } => {
                let _ = reply.send(Err(error));
            }
            Job::SearchPage { reply, .. } => {
                let _ = reply.send(Err(error));
            }
            Job::SetPageRotations { reply, .. } => {
                let _ = reply.send(Err(error));
            }
            Job::AppendBlankPage { reply, .. } => {
                let _ = reply.send(Err(error));
            }
            Job::AppendPages { reply, .. } => {
                let _ = reply.send(Err(error));
            }
            Job::TruncatePages { reply, .. } => {
                let _ = reply.send(Err(error));
            }
            Job::Release { reply, .. } => {
                let _ = reply.send(Err(error));
            }
            Job::Reopen { reply, .. } => {
                let _ = reply.send(Err(error));
            }
            Job::Close { reply, .. } => {
                let _ = reply.send(Err(error));
            }
            #[cfg(test)]
            Job::Crash { reply, .. } => {
                let _ = reply.send(Err(error));
            }
            #[cfg(test)]
            Job::Hold { reply, .. } => {
                let _ = reply.send(Err(error));
            }
        }
    }
}

/// A frame to render: what it draws and how urgent it is (ADR-002 §2, §3).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RenderSpec {
    pub key: RenderKey,
    /// `Visible`, `Near` or `Thumbnail` for a request from the UI.
    pub priority: Priority,
    /// The viewport generation the UI asked at: of two equally urgent frames the more recent one goes first, and a
    /// `set_viewport` hint cancels only renders asked for at its generation or before.
    pub generation: u32,
}

/// The worker thread's side of an engine as the engine knows it: replaced as a whole by [`Engine::recover`].
struct Live {
    queue: Arc<Queue>,
    health: Arc<Health>,
}

/// Most times per process that a stuck worker is replaced (`Engine::recover`, ADR-028).
pub const MAX_RESPAWNS: usize = 3;

/// What a worker thread runs: its queue, its health mark, the shared sizes, and the documents of an earlier worker that are gone.
type Runner = dyn Fn(Requests, Arc<Health>, Arc<SizeCache>, HashSet<DocumentId>) + Send + Sync;

/// Shared by every clone of an [`Engine`]. When the last one is dropped the queue is closed and the worker ends.
struct Inner {
    live: Mutex<Live>,
    /// The sizes of the pages of every loaded document: written by the worker, read by every handle (see [`sizes`]). They outlive
    /// a respawned worker, which is how the documents it does not hold are found (`Engine::recover`).
    sizes: Arc<SizeCache>,
    queue_depth: usize,
    /// How to start a worker again once one is stuck past its deadline; `None` for the test doubles.
    runner: Option<Arc<Runner>>,
    /// How many times a stuck worker was replaced; at most [`MAX_RESPAWNS`] (each leaves a thread and its PDFium state behind).
    respawns: std::sync::atomic::AtomicUsize,
}

impl Inner {
    fn live(&self) -> MutexGuard<'_, Live> {
        // A poisoned lock only means a holder panicked; two `Arc`s cannot be left inconsistent.
        self.live.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn queue(&self) -> Arc<Queue> {
        Arc::clone(&self.live().queue)
    }

    #[cfg(test)]
    fn health(&self) -> Arc<Health> {
        Arc::clone(&self.live().health)
    }
}

impl Drop for Inner {
    fn drop(&mut self) {
        self.live().queue.close();
    }
}

/// Starts a worker thread on a new queue. A thread that cannot be started leaves the queue without a consumer, so every job
/// fails fast with `engine_unavailable`.
fn launch(queue_depth: usize, run: impl FnOnce(Requests, Arc<Health>) + Send + 'static) -> Live {
    let queue = Queue::new(queue_depth);
    let health = Arc::new(Health::default());
    let requests = Requests::new(Arc::clone(&queue));
    let worker_health = Arc::clone(&health);
    let spawned = thread::Builder::new()
        .name("sheer-pdfium".into())
        .stack_size(limits::ENGINE_STACK_BYTES)
        .spawn(move || run(requests, worker_health));
    if let Err(error) = spawned {
        // `requests` was dropped with the closure.
        AppError::logged(
            ErrorCode::EngineUnavailable,
            format!("could not start the PDFium worker thread: {error}"),
        )
        .log();
    }
    Live { queue, health }
}

/// Handle to the worker thread. Cheap to clone; every method blocks until the worker answers or the job's deadline
/// passes, so call it from a blocking thread (`spawn_blocking`), never from an async task directly.
#[derive(Clone)]
pub struct Engine {
    inner: Arc<Inner>,
}

impl Engine {
    /// Starts the worker thread. Binding PDFium happens on that thread; a failure there is logged and surfaces as
    /// `engine_unavailable` on every later job. A worker that gets stuck past a deadline is replaced (`Engine::recover`).
    pub fn start(library: PathBuf) -> Self {
        let runner: Arc<Runner> = Arc::new(move |requests, health, sizes, stale| {
            worker::run(&library, requests, &health, &sizes, stale);
        });
        let sizes = Arc::new(SizeCache::default());
        let live = {
            let (runner, sizes) = (Arc::clone(&runner), Arc::clone(&sizes));
            launch(limits::ENGINE_QUEUE_DEPTH, move |requests, health| {
                runner(requests, health, sizes, HashSet::new());
            })
        };
        Self::assemble(live, sizes, limits::ENGINE_QUEUE_DEPTH, Some(runner))
    }

    #[cfg(test)]
    fn spawn(
        queue_depth: usize,
        run: impl FnOnce(Requests, Arc<Health>, Arc<SizeCache>) + Send + 'static,
    ) -> Self {
        let sizes = Arc::new(SizeCache::default());
        let worker_sizes = Arc::clone(&sizes);
        let live = launch(queue_depth, move |requests, health| {
            run(requests, health, worker_sizes);
        });
        Self::assemble(live, sizes, queue_depth, None)
    }

    fn assemble(
        live: Live,
        sizes: Arc<SizeCache>,
        queue_depth: usize,
        runner: Option<Arc<Runner>>,
    ) -> Self {
        Self {
            inner: Arc::new(Inner {
                live: Mutex::new(live),
                sizes,
                queue_depth,
                runner,
                respawns: std::sync::atomic::AtomicUsize::new(0),
            }),
        }
    }

    /// Replaces a worker that is stuck past its deadline (`wedged`, as seen by the caller) with a new one, so that the app works
    /// again without a restart. A PDFium call cannot be interrupted: the old thread is left to finish, or not (a retired
    /// worker serves nothing more and leaks its PDFium state rather than tear down the library under its successor). The
    /// documents it held are gone: they answer `engine_crashed` until closed, and the UI has to open them again. Until the
    /// engine process of M7 (SECURITY P6) this is the best an in-process engine can do. Several callers may see the same stuck
    /// worker; only the first replaces it.
    fn recover(&self, wedged: &Arc<Health>) {
        let Some(runner) = &self.inner.runner else {
            return;
        };
        let mut live = self.inner.live();
        if !Arc::ptr_eq(&live.health, wedged) {
            return;
        }
        // Each respawn leaks a thread and its PDFium state: after the cap the engine stays `engine_unavailable` (until the stuck job
        // returns, if it ever does) and only a restart helps.
        if self
            .inner
            .respawns
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
            >= MAX_RESPAWNS
        {
            return;
        }
        let stale: HashSet<DocumentId> = self.inner.sizes.ids().into_iter().collect();
        live.health.retire();
        live.queue.close();
        let (runner, sizes) = (Arc::clone(runner), Arc::clone(&self.inner.sizes));
        *live = launch(self.inner.queue_depth, move |requests, health| {
            runner(requests, health, sizes, stale);
        });
        AppError::logged(
            ErrorCode::EngineUnavailable,
            "a PDF job ran past its deadline: the worker was replaced and open documents must be reopened",
        )
        .log();
    }

    /// Test double for other modules: a worker that hands every job to `handler`, which must answer it. Needs no PDFium. It
    /// reads no page sizes: a test that needs them has the double "load" them with [`Engine::seed_page_sizes`].
    #[cfg(test)]
    pub(crate) fn with_handler(mut handler: impl FnMut(Job) + Send + 'static) -> Self {
        Self::spawn(
            limits::ENGINE_QUEUE_DEPTH,
            move |mut requests, health, _| {
                while let Some(request) = requests.next() {
                    let _busy = health.begin(request.run_deadline());
                    // A render's answer also goes to the callers that asked for the same frame meanwhile, as the real worker does
                    // it: the handler answers through a channel of its own, and what it says is passed on.
                    match request.job {
                        Job::Render { key, reply } => {
                            let (own, answer) = mpsc::sync_channel(1);
                            handler(Job::Render { key, reply: own });
                            let waiters = requests.finish_render(&key);
                            if let Ok(result) = answer.try_recv() {
                                for waiter in waiters {
                                    let _ = waiter.send(result.clone());
                                }
                                let _ = reply.send(result);
                            }
                        }
                        job => handler(job),
                    }
                }
            },
        )
    }

    /// Sends one job and waits for its answer for at most `timeout`.
    fn call<T>(
        &self,
        timeout: Duration,
        rank: Rank,
        build: impl FnOnce(Reply<T>) -> Job,
    ) -> Result<T, AppError> {
        let (queue, health) = {
            let live = self.inner.live();
            (Arc::clone(&live.queue), Arc::clone(&live.health))
        };
        if health.is_wedged() {
            // The stuck job cannot be interrupted: start another worker for what comes next, and tell this caller now.
            self.recover(&health);
            return Err(AppError::logged(
                ErrorCode::EngineUnavailable,
                "a PDF job is still running past its deadline",
            ));
        }
        let (reply_tx, reply_rx) = mpsc::sync_channel(1);
        let request = Request {
            deadline: Instant::now() + timeout,
            job: build(reply_tx),
        };
        match queue.push(request, rank) {
            Ok(()) => {}
            // Back-pressure: never block the caller on a full queue.
            Err(Refused::Full) => {
                return Err(AppError::logged(
                    ErrorCode::EngineTimeout,
                    "the PDF job queue is full",
                ))
            }
            // The same frame is being drawn for as many callers as may wait for it: this one is not told to wait too.
            Err(Refused::TooManyWaiters) => {
                return Err(AppError::limit(
                    "requests",
                    limits::MAX_RENDER_WAITERS as u64,
                ))
            }
            Err(Refused::Disconnected) => return Err(AppError::new(ErrorCode::EngineUnavailable)),
        }
        match reply_rx.recv_timeout(timeout) {
            Ok(result) => result,
            Err(RecvTimeoutError::Timeout) => Err(AppError::logged(
                ErrorCode::EngineTimeout,
                format!("no answer within {} ms", timeout.as_millis()),
            )),
            // The worker dropped the job without answering.
            Err(RecvTimeoutError::Disconnected) => Err(AppError::new(ErrorCode::EngineUnavailable)),
        }
    }

    /// Loads the document in `file` (an open handle that passed intake) under `id` and returns its page count.
    ///
    /// `confirm` is called on the worker once the document is loaded, with the page count; see [`Confirm`]. That is what keeps
    /// an open that finishes after this call has timed out from leaving a document behind: the caller that gave up takes its
    /// registry entry away, `confirm` finds it gone and says no, and the worker releases the document. The handle is closed
    /// with it, and also when the job never starts (a full queue, a stuck worker, an engine without PDFium).
    pub fn open(
        &self,
        id: DocumentId,
        file: File,
        confirm: impl FnOnce(u32) -> bool + Send + 'static,
    ) -> Result<u32, AppError> {
        self.open_with_password(id, file, None, confirm)
    }

    /// [`Engine::open`] for an encrypted file with the password the user typed. A file that needs a password and gets none, or a
    /// wrong one, is `password_required`. The password stays in a [`Zeroizing`] string all the way and is never logged.
    pub fn open_with_password(
        &self,
        id: DocumentId,
        file: File,
        password: Option<Zeroizing<String>>,
        confirm: impl FnOnce(u32) -> bool + Send + 'static,
    ) -> Result<u32, AppError> {
        self.call(limits::OPEN_TIMEOUT, Rank::CONTROL, |reply| Job::Open {
            id,
            file,
            password,
            confirm: Box::new(confirm),
            reply,
        })
    }

    /// Renders one frame and returns it (see [`encode`]): the whole page or one tile of it, at the scale of the bucket. It
    /// waits in the queue behind everything more urgent; `Err(cancelled)` means a viewport hint or the closing of the document
    /// withdrew it before it started, which is nothing to report. A frame that is asked for while it is queued or running is not
    /// drawn again: the caller shares the answer, up to `limits::MAX_RENDER_WAITERS` callers, then `limit_exceeded`.
    pub fn render(&self, spec: RenderSpec) -> Result<Frame, AppError> {
        let rank = Rank {
            priority: spec.priority,
            generation: spec.generation,
        };
        self.call(limits::RENDER_TIMEOUT, rank, |reply| Job::Render {
            key: spec.key,
            reply,
        })
    }

    /// Tells the engine which pages of document `id` the UI shows now (`visible`) and which it may show next (`near`), as of
    /// `generation`: queued renders for other pages are cancelled, the rest re-ranked (see [`queue::Queue::set_viewport`]).
    /// Never waits for the worker: it only reorders the queue, so it works while a render is running.
    pub fn set_viewport(&self, id: DocumentId, generation: u32, visible: &[u32], near: &[u32]) {
        self.inner
            .queue()
            .set_viewport(id, generation, visible, near);
    }

    /// The size in points of every page of the document, in page order (`limits::sanitize_page_size`: always usable). The sizes
    /// were read once when the document was loaded, so this is a lookup: it takes no place in the queue, never waits for the
    /// worker, and costs the same however often it is asked. `not_found` for a document the engine does not hold.
    pub fn page_sizes(&self, id: DocumentId) -> Result<PageSizes, AppError> {
        self.inner
            .sizes
            .get(id)
            .ok_or_else(|| AppError::not_found("document"))
    }

    /// What PDFium said about the document when it was loaded (`DocFlags`). A lookup like [`Engine::page_sizes`]: it takes no
    /// place in the queue and never waits for the worker. `not_found` for a document the engine does not hold.
    pub fn doc_flags(&self, id: DocumentId) -> Result<DocFlags, AppError> {
        self.inner
            .sizes
            .flags(id)
            .ok_or_else(|| AppError::not_found("document"))
    }

    /// The outline of the document: its top level bookmarks with their children, at most `limits::MAX_OUTLINE_NODES` of them down
    /// to `limits::MAX_OUTLINE_DEPTH` levels, however the file's outline is shaped (a cycle ends where it comes back).
    pub fn outline(&self, id: DocumentId) -> Result<Vec<OutlineItem>, AppError> {
        self.call(limits::TEXT_TIMEOUT, Rank::INTERACTIVE, |reply| {
            Job::Outline { id, reply }
        })
    }

    /// The text of page `page_index` and the box of every character, in page space; see [`TextPage`]. `invalid_argument` for a
    /// page the document does not have.
    pub fn text_layer(&self, id: DocumentId, page_index: u32) -> Result<TextPage, AppError> {
        self.call(limits::TEXT_TIMEOUT, Rank::INTERACTIVE, |reply| {
            Job::TextLayer {
                id,
                page_index,
                reply,
            }
        })
    }

    /// The links of page `page_index`, at most `limits::MAX_PAGE_LINKS`, in the order that gives each its index (`open_link`
    /// names a link by it). Nothing is followed: a link that goes anywhere the app does not go is `LinkTarget::Blocked`.
    pub fn page_links(&self, id: DocumentId, page_index: u32) -> Result<Vec<PageLink>, AppError> {
        self.call(limits::TEXT_TIMEOUT, Rank::INTERACTIVE, |reply| {
            Job::PageLinks {
                id,
                page_index,
                reply,
            }
        })
    }

    /// The annotations of page `page_index` as the file has them, at most `limits::MAX_IMPORT_PER_PAGE` scanned, in the order of the page's
    /// `/Annots` (see `import`). Links, widgets and popups are not annotations of the model and are left out; kinds the model does not
    /// edit come as [`crate::model::annotation::AnnotationBody::Opaque`]. `invalid_argument` for a page the document does not have.
    pub fn import_annotations(
        &self,
        id: DocumentId,
        page_index: u32,
    ) -> Result<Vec<Imported>, AppError> {
        self.call(limits::TEXT_TIMEOUT, Rank::INTERACTIVE, |reply| {
            Job::ImportAnnotations {
                id,
                page_index,
                reply,
            }
        })
    }

    /// Hides the annotations `hide` and shows the annotations `show` (each `(page index, position)` as in `PdfOrigin`) in PDFium's copy
    /// of the document, which is never saved (ADR-002 §7): only what the render draws changes. A position that is not there is skipped.
    pub fn set_annotations_hidden(
        &self,
        id: DocumentId,
        hide: Vec<(u32, u32)>,
        show: Vec<(u32, u32)>,
    ) -> Result<(), AppError> {
        self.call(limits::TEXT_TIMEOUT, Rank::INTERACTIVE, |reply| {
            Job::SetAnnotationsHidden {
                id,
                hide,
                show,
                reply,
            }
        })
    }

    /// [`Engine::import_annotations`] at `Background` priority, for a read of every page of a document (the comments list): a render
    /// or a read the user is waiting for goes first.
    pub fn import_annotations_background(
        &self,
        id: DocumentId,
        page_index: u32,
    ) -> Result<Vec<Imported>, AppError> {
        self.call(limits::TEXT_TIMEOUT, Rank::BACKGROUND, |reply| {
            Job::ImportAnnotations {
                id,
                page_index,
                reply,
            }
        })
    }

    /// Searches page `page_index` for `spec` and returns its first `limit` hits as the quads of the text each covers, in page
    /// space. It runs at the lowest priority: a render that is queued goes first, and a caller that searches a whole document asks
    /// for one page at a time, so renders are never held up for longer than one page takes. `engine_timeout` (`cancelled` if the
    /// queue was full of more urgent work) says the page was not searched because the engine was busy, which is worth another try.
    pub fn search_page(
        &self,
        id: DocumentId,
        page_index: u32,
        spec: Arc<SearchSpec>,
        limit: usize,
    ) -> Result<Vec<Vec<Quad>>, AppError> {
        self.call(limits::TEXT_TIMEOUT, Rank::BACKGROUND, |reply| {
            Job::SearchPage {
                id,
                page_index,
                spec,
                limit,
                reply,
            }
        })
    }

    /// The `/Rotate` of every page as the file had it when the document was loaded, by engine index. A lookup like
    /// [`Engine::page_sizes`]; `not_found` for a document the engine does not hold, or a double that read none.
    pub fn page_rotations(&self, id: DocumentId) -> Result<Arc<[u16]>, AppError> {
        self.inner
            .sizes
            .rotations(id)
            .ok_or_else(|| AppError::not_found("document"))
    }

    /// Sets the rotation of pages in PDFium's copy: `(engine index, degrees)` (ADR-036 §3, `Control` priority).
    pub fn set_page_rotations(
        &self,
        id: DocumentId,
        items: Vec<(u32, u16)>,
    ) -> Result<(), AppError> {
        self.call(limits::CONTROL_TIMEOUT, Rank::CONTROL, |reply| {
            Job::SetPageRotations { id, items, reply }
        })
    }

    /// Adds an empty page of `size` points at the end of PDFium's copy; its engine index and size come back.
    pub fn append_blank_page(&self, id: DocumentId, size: [f32; 2]) -> Result<Appended, AppError> {
        self.call(limits::CONTROL_TIMEOUT, Rank::CONTROL, |reply| {
            Job::AppendBlankPage { id, size, reply }
        })
    }

    /// Takes the pages appended at `keep..total` off the end of PDFium's copy again (a page insert the model refused). Nothing is removed
    /// if the copy has grown past `total` meanwhile.
    pub fn truncate_pages(&self, id: DocumentId, keep: u32, total: u32) -> Result<(), AppError> {
        self.call(limits::CONTROL_TIMEOUT, Rank::CONTROL, |reply| {
            Job::TruncatePages {
                id,
                keep,
                total,
                reply,
            }
        })
    }

    /// Copies pages `pages` (indices in the source) of an import source to the end of PDFium's copy, in that order.
    pub fn append_pages(
        &self,
        id: DocumentId,
        source: Arc<SourceBytes>,
        pages: Vec<u32>,
    ) -> Result<Vec<Appended>, AppError> {
        self.call(limits::OPEN_TIMEOUT, Rank::CONTROL, |reply| {
            Job::AppendPages {
                id,
                source,
                pages,
                reply,
            }
        })
    }

    /// Records page sizes for a document of a test double, as the worker does when it loads one.
    #[cfg(test)]
    pub(crate) fn seed_page_sizes(&self, id: DocumentId, sizes: Vec<[f32; 2]>) {
        self.inner
            .sizes
            .insert(id, Arc::from(sizes), DocFlags::default());
    }

    /// Releases the document, its page sizes, and cancels what is still queued for it. Unknown ids are ignored. If the answer
    /// does not come in time the job still runs when the worker gets to it (`Request::expired`), so an `engine_timeout` here
    /// does not mean the document stays; `engine_unavailable` and a full queue mean the job was not queued at all, and the
    /// caller has to try again (`AppState::close_document` does).
    pub fn close(&self, id: DocumentId) -> Result<(), AppError> {
        self.call(limits::CONTROL_TIMEOUT, Rank::CONTROL, |reply| Job::Close {
            id,
            reply,
        })
    }

    /// Lets go of the engine's copy of document `id`, so that its file can be replaced; see [`Engine::reopen`]. Its page sizes stay.
    pub fn release(&self, id: DocumentId) -> Result<(), AppError> {
        self.call(limits::CONTROL_TIMEOUT, Rank::CONTROL, |reply| {
            Job::Release {
                id,
                snapshot: false,
                reply,
            }
        })
        .map(|_| ())
    }

    /// [`Engine::release`], answering with the copy as it is now: pages added in this session and rotations set are in it. A save that
    /// fails puts it back with [`Engine::restore`], so the model's page list still matches the engine's indices.
    pub fn release_with_snapshot(&self, id: DocumentId) -> Result<Vec<u8>, AppError> {
        self.call(limits::OPEN_TIMEOUT, Rank::CONTROL, |reply| Job::Release {
            id,
            snapshot: true,
            reply,
        })?
        .ok_or_else(|| AppError::logged(ErrorCode::Internal, "no snapshot of the document"))
    }

    /// Loads document `id` again from a snapshot of [`Engine::release_with_snapshot`].
    pub fn restore(&self, id: DocumentId, snapshot: Vec<u8>) -> Result<u32, AppError> {
        self.call(limits::OPEN_TIMEOUT, Rank::CONTROL, |reply| Job::Reopen {
            id,
            source: ReopenSource::Bytes(snapshot),
            reply,
        })
    }

    /// Loads document `id` again from `file` (an open handle that passed intake), after [`Engine::release`]: the page count of the
    /// file as it is now. The page sizes and the flags are read afresh; a failure leaves the document without a copy in the engine.
    pub fn reopen(&self, id: DocumentId, file: File) -> Result<u32, AppError> {
        self.call(limits::OPEN_TIMEOUT, Rank::CONTROL, |reply| Job::Reopen {
            id,
            source: ReopenSource::File(file),
            reply,
        })
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::OnceLock;

    use super::*;
    use crate::documents::Registry;

    /// Path of the test PDF (two pages: 612x792 pt with a red square, then 200x100 pt).
    fn fixture() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("tests")
            .join("fixtures")
            .join("minimal.pdf")
    }

    /// PDFium can be bound once per process, so all engine tests share one worker. `None` when the library has not
    /// been fetched (`npm run fetch-pdfium`); those tests then skip instead of failing a fresh checkout.
    ///
    /// Each test thread also takes a read lock on the engine for as long as it lives, so a test that counts what is in the
    /// queue ([`exclusive_engine`]) runs while no other test has jobs on the shared worker.
    fn shared_engine() -> Option<&'static Engine> {
        static ENGINE: OnceLock<Option<Engine>> = OnceLock::new();
        ENGINE_USERS.with(|slot| {
            let mut slot = slot.borrow_mut();
            if matches!(*slot, Users::None) {
                *slot = Users::Shared(engine_lock().read().unwrap_or_else(|e| e.into_inner()));
            }
        });
        ENGINE
            .get_or_init(|| {
                let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("pdfium");
                let library = library_path(&root);
                if library.is_file() {
                    Some(Engine::start(library))
                } else {
                    eprintln!("skipping engine test: {} not found", library.display());
                    None
                }
            })
            .as_ref()
    }

    fn engine_lock() -> &'static std::sync::RwLock<()> {
        static LOCK: std::sync::RwLock<()> = std::sync::RwLock::new(());
        &LOCK
    }

    /// What this test thread holds of the shared engine until it ends.
    #[allow(dead_code)] // the guards are held for their drop
    enum Users {
        None,
        Shared(std::sync::RwLockReadGuard<'static, ()>),
        Exclusive(std::sync::RwLockWriteGuard<'static, ()>),
    }

    thread_local! {
        static ENGINE_USERS: std::cell::RefCell<Users> = const { std::cell::RefCell::new(Users::None) };
    }

    /// The shared engine with no other test using it until this one ends. Call it before anything else that touches the
    /// engine, for tests whose outcome depends on the exact contents of the queue.
    fn exclusive_engine() -> Option<&'static Engine> {
        ENGINE_USERS.with(|slot| {
            let mut slot = slot.borrow_mut();
            assert!(matches!(*slot, Users::None), "call exclusive_engine first");
            *slot = Users::Exclusive(engine_lock().write().unwrap_or_else(|e| e.into_inner()));
        });
        shared_engine()
    }

    /// The registry the tests' ids come from. One for all of them, because they all use the same engine and an id must not
    /// be used by two documents there.
    fn shared_registry() -> &'static Registry {
        static REGISTRY: OnceLock<Registry> = OnceLock::new();
        REGISTRY.get_or_init(Registry::new)
    }

    /// A fresh id the engine can use, not in the registry: ids are never reused, and the registry's limit on open
    /// documents would run out over the many tests that never close theirs.
    fn new_id() -> DocumentId {
        let registry = shared_registry();
        let id = registry.register(fixture()).unwrap();
        registry.remove(id);
        id
    }

    /// A fresh id, registered (as intake would have done), for the tests that confirm or abandon it there.
    fn new_registered_id() -> DocumentId {
        shared_registry().register(fixture()).unwrap()
    }

    /// Opens the fixture for `id` the way the intake hands a file over: an open handle, and a caller that still waits.
    fn open_fixture(engine: &Engine, id: DocumentId) -> Result<u32, AppError> {
        engine.open(id, File::open(fixture()).unwrap(), |_| true)
    }

    /// Splits a frame and decodes its PNG, checking that the header and the PNG agree on the size.
    fn decode(frame: &[u8]) -> (png::OutputInfo, Vec<u8>) {
        let (width, height, png_bytes) = encode::split_frame(frame);
        let mut reader = png::Decoder::new(std::io::Cursor::new(png_bytes))
            .read_info()
            .unwrap();
        let mut buffer = vec![0; reader.output_buffer_size().unwrap()];
        let info = reader.next_frame(&mut buffer).unwrap();
        assert_eq!((info.width, info.height), (width, height));
        (info, buffer)
    }

    fn pixel(info: &png::OutputInfo, buffer: &[u8], x: usize, y: usize) -> [u8; 3] {
        let at = y * info.line_size + x * 3;
        [buffer[at], buffer[at + 1], buffer[at + 2]]
    }

    fn spec(id: DocumentId, page_index: u32, bucket: i16, tile: Option<(u16, u16)>) -> RenderSpec {
        RenderSpec {
            key: RenderKey {
                id,
                page_index,
                bucket,
                tile,
            },
            priority: Priority::Visible,
            generation: 1,
        }
    }

    /// The whole page at `bucket` (device pixels per point: 2^(bucket / 4)).
    fn render(
        engine: &Engine,
        id: DocumentId,
        page_index: u32,
        bucket: i16,
    ) -> Result<Frame, AppError> {
        engine.render(spec(id, page_index, bucket, None))
    }

    fn render_tile(
        engine: &Engine,
        id: DocumentId,
        page_index: u32,
        bucket: i16,
        tile: (u16, u16),
    ) -> Result<Frame, AppError> {
        engine.render(spec(id, page_index, bucket, Some(tile)))
    }

    fn crash(engine: &Engine, id: Option<DocumentId>) -> Result<(), AppError> {
        engine.call(limits::CONTROL_TIMEOUT, Rank::CONTROL, |reply| Job::Crash {
            id,
            reply,
        })
    }

    #[test]
    fn renders_the_fixture_page_as_a_frame() {
        let Some(engine) = shared_engine() else {
            return;
        };
        let id = new_id();
        assert_eq!(open_fixture(engine, id).unwrap(), 2);

        let frame = render(engine, id, 0, 0).unwrap();
        let (info, pixels) = decode(&frame);
        assert_eq!((info.width, info.height), (612, 792));
        // Page background is white; the square (PDF x 100..200, y 600..700) is red, with y flipped in the bitmap.
        assert_eq!(pixel(&info, &pixels, 10, 10), [255, 255, 255]);
        assert_eq!(pixel(&info, &pixels, 150, 142), [255, 0, 0]);

        let frame = render(engine, id, 1, 4).unwrap();
        let (info, _) = decode(&frame);
        assert_eq!((info.width, info.height), (400, 200));
        engine.close(id).unwrap();
    }

    #[test]
    fn rejects_bad_requests_without_crashing_the_worker() {
        let Some(engine) = shared_engine() else {
            return;
        };
        let id = new_id();
        open_fixture(engine, id).unwrap();

        let code = |result: Result<Frame, AppError>| result.unwrap_err().code();
        assert_eq!(code(render(engine, id, 2, 0)), ErrorCode::InvalidArgument);
        // Buckets outside the range, and a tile outside the page's grid (page 0 at bucket 0 is 612 x 792 px: one tile).
        for bucket in [limits::MIN_BUCKET - 1, limits::MAX_BUCKET + 1] {
            assert_eq!(
                code(render(engine, id, 0, bucket)),
                ErrorCode::InvalidArgument,
                "{bucket}"
            );
        }
        assert_eq!(
            code(render_tile(engine, id, 0, 0, (1, 0))),
            ErrorCode::InvalidArgument
        );
        assert_eq!(
            code(render_tile(engine, id, 0, 0, (0, 1))),
            ErrorCode::InvalidArgument
        );

        engine.close(id).unwrap();
        assert_eq!(code(render(engine, id, 0, 0)), ErrorCode::NotFound);

        // The worker is still healthy after the errors above.
        let other = new_id();
        assert_eq!(open_fixture(engine, other).unwrap(), 2);
        assert!(render(engine, other, 0, -4).is_ok());
        engine.close(other).unwrap();
    }

    #[test]
    fn refuses_frames_over_the_render_limits_before_allocating() {
        let Some(engine) = shared_engine() else {
            return;
        };
        let id = new_id();
        open_fixture(engine, id).unwrap();

        // Page 0 is 612 x 792 pt; at scale 8 that is 4896 x 6336 px, over the 4096 px side limit.
        let error = render(engine, id, 0, 12).unwrap_err();
        assert_eq!(error.code(), ErrorCode::LimitExceeded);
        // Page 1 is 200 x 100 pt; at scale 8 it is 1600 x 800 px and fine. The worker is unharmed by the refusal.
        let (info, _) = decode(&render(engine, id, 1, 12).unwrap());
        assert_eq!((info.width, info.height), (1600, 800));
        engine.close(id).unwrap();
    }

    #[test]
    fn reports_files_that_are_not_pdfs() {
        let Some(engine) = shared_engine() else {
            return;
        };
        let id = new_id();

        // Cargo.toml is plain text, so PDFium must refuse it. (Intake refuses it long before: this is the engine's own
        // answer for a file that got past the signature check, which a damaged PDF can.)
        let not_a_pdf = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml");
        let error = engine
            .open(id, File::open(not_a_pdf).unwrap(), |_| true)
            .unwrap_err();
        assert_eq!(error.code(), ErrorCode::NotAPdf);
        // Nothing was kept for the id.
        assert_eq!(
            render(engine, id, 0, 0).unwrap_err().code(),
            ErrorCode::NotFound
        );
    }

    #[test]
    fn pdfium_reads_the_handle_it_is_given_not_the_path() {
        let Some(engine) = shared_engine() else {
            return;
        };
        let dir = crate::storage::atomic::testutil::TempDir::new();
        let path = dir.path().join("handle.pdf");
        std::fs::copy(fixture(), &path).unwrap();
        // Intake judges the handle ...
        let admitted = crate::documents::intake::admit(&path).unwrap();
        // ... the path is pointed at something else before the engine gets to it ...
        std::fs::rename(&path, dir.path().join("moved.pdf")).unwrap();
        std::fs::write(&path, b"not a pdf any more").unwrap();
        // ... and the engine still loads the file that was judged.
        let id = new_id();
        assert_eq!(engine.open(id, admitted.file, |_| true).unwrap(), 2);
        assert!(render(engine, id, 0, -4).is_ok());
        engine.close(id).unwrap();
    }

    #[test]
    fn a_document_nobody_waits_for_is_released_not_orphaned() {
        let Some(engine) = shared_engine() else {
            return;
        };
        let id = new_registered_id();

        // The open is in the worker when its caller gives up: the registry entry goes (this is what the caller of a timed-out
        // open does), and only then does the worker's "is it still wanted" question come.
        let (loaded_tx, loaded_rx) = mpsc::channel();
        let (resume_tx, resume_rx) = mpsc::channel::<()>();
        let registry = shared_registry();
        let confirm = move |pages| {
            loaded_tx.send(()).unwrap();
            resume_rx.recv().unwrap();
            registry.set_page_count(id, pages).is_ok()
        };
        let opening = {
            let engine = engine.clone();
            thread::spawn(move || engine.open(id, File::open(fixture()).unwrap(), confirm))
        };
        loaded_rx.recv().unwrap();
        assert_eq!(registry.abandon(id), crate::documents::Abandoned::Removed);
        resume_tx.send(()).unwrap();

        assert!(opening.join().unwrap().is_err());
        // The document did not stay: the engine does not know the id, so there is nothing to close and nothing leaked.
        assert_eq!(
            render(engine, id, 0, 0).unwrap_err().code(),
            ErrorCode::NotFound
        );
        assert_eq!(
            registry.page_count(id).unwrap_err().code(),
            ErrorCode::NotFound
        );
    }

    /// An open whose caller gives up while the worker is loading: the registry entry is taken back (as the caller of an open
    /// that timed out does) and only then does the worker ask whether anybody still wants the document. Returns the open's
    /// answer.
    fn open_then_give_up(engine: &Engine, id: DocumentId, file: File) -> Result<u32, AppError> {
        let (loaded_tx, loaded_rx) = mpsc::channel();
        let (resume_tx, resume_rx) = mpsc::channel::<()>();
        let registry = shared_registry();
        let confirm = move |pages| {
            loaded_tx.send(()).unwrap();
            resume_rx.recv().unwrap();
            registry.set_page_count(id, pages).is_ok()
        };
        let opening = {
            let engine = engine.clone();
            thread::spawn(move || engine.open(id, file, confirm))
        };
        loaded_rx.recv().unwrap();
        assert_eq!(registry.abandon(id), crate::documents::Abandoned::Removed);
        resume_tx.send(()).unwrap();
        opening.join().unwrap()
    }

    #[test]
    fn releasing_orphans_leaves_the_worker_and_the_other_documents_alone() {
        let Some(engine) = shared_engine() else {
            return;
        };
        let (kept, orphan, next_orphan) = (
            new_registered_id(),
            new_registered_id(),
            new_registered_id(),
        );
        open_fixture(engine, kept).unwrap();

        // Two documents in a row that nobody waits for any more; each open answers with an error, not with a page count.
        for id in [orphan, next_orphan] {
            let error = open_then_give_up(engine, id, File::open(fixture()).unwrap()).unwrap_err();
            assert_eq!(error.code(), ErrorCode::EngineTimeout);
            assert_eq!(
                render(engine, id, 0, -4).unwrap_err().code(),
                ErrorCode::NotFound
            );
            // Closing what was released is not an error: an id the worker does not know is ignored.
            assert!(engine.close(id).is_ok());
        }

        // The one that was wanted is untouched, and the worker takes new work.
        assert!(render(engine, kept, 0, -4).is_ok());
        let fresh = new_registered_id();
        assert_eq!(open_fixture(engine, fresh).unwrap(), 2);
        assert!(render(engine, fresh, 1, -4).is_ok());
        engine.close(fresh).unwrap();
        engine.close(kept).unwrap();
    }

    /// The file handle goes with the released document: the file is not held open by a document nobody can close. Windows
    /// refuses to open a file for writing, without sharing, while any other handle to it is open, which makes that visible.
    #[cfg(windows)]
    #[test]
    fn the_file_handle_of_a_released_orphan_is_closed_with_it() {
        use std::os::windows::fs::OpenOptionsExt;

        let Some(engine) = shared_engine() else {
            return;
        };
        let is_free = |path: &Path| {
            std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .share_mode(0)
                .open(path)
                .is_ok()
        };
        let dir = crate::storage::atomic::testutil::TempDir::new();
        let path = dir.path().join("held.pdf");
        std::fs::copy(fixture(), &path).unwrap();

        // The probe works: a document that is open holds its file, and closing it lets the file go.
        let kept = new_registered_id();
        let registry = shared_registry();
        let confirm = move |pages| registry.set_page_count(kept, pages).is_ok();
        engine
            .open(kept, File::open(&path).unwrap(), confirm)
            .unwrap();
        assert!(!is_free(&path), "an open document does not hold its file");
        engine.close(kept).unwrap();
        assert!(is_free(&path), "a closed document still holds its file");

        // The orphan: loaded, then released because its caller gave up. The file is free again as soon as the open answers.
        let orphan = new_registered_id();
        assert!(open_then_give_up(engine, orphan, File::open(&path).unwrap()).is_err());
        assert!(is_free(&path), "a released orphan still holds its file");
    }

    #[test]
    fn a_document_somebody_waits_for_stays() {
        let Some(engine) = shared_engine() else {
            return;
        };
        let id = new_registered_id();
        let registry = shared_registry();
        let confirm = move |pages| registry.set_page_count(id, pages).is_ok();
        assert_eq!(
            engine
                .open(id, File::open(fixture()).unwrap(), confirm)
                .unwrap(),
            2
        );
        assert_eq!(registry.page_count(id).unwrap(), 2);
        assert!(render(engine, id, 0, -4).is_ok());
        engine.close(id).unwrap();
    }

    #[test]
    fn a_panicking_job_becomes_an_error_and_the_worker_survives() {
        let Some(engine) = shared_engine() else {
            return;
        };
        assert_eq!(
            crash(engine, None).unwrap_err().code(),
            ErrorCode::EngineCrashed
        );

        // The very next jobs work as if nothing happened.
        let id = new_id();
        assert_eq!(open_fixture(engine, id).unwrap(), 2);
        assert!(render(engine, id, 0, -4).is_ok());
        engine.close(id).unwrap();
    }

    #[test]
    fn a_crash_quarantines_only_the_affected_document() {
        let Some(engine) = shared_engine() else {
            return;
        };
        let (hit, spared) = (new_id(), new_id());
        open_fixture(engine, hit).unwrap();
        open_fixture(engine, spared).unwrap();

        assert_eq!(
            crash(engine, Some(hit)).unwrap_err().code(),
            ErrorCode::EngineCrashed
        );
        assert_eq!(
            render(engine, hit, 0, -4).unwrap_err().code(),
            ErrorCode::EngineCrashed
        );
        assert!(render(engine, spared, 0, -4).is_ok());

        // Closing releases the quarantine entry; the id is then simply unknown.
        engine.close(hit).unwrap();
        assert_eq!(
            render(engine, hit, 0, -4).unwrap_err().code(),
            ErrorCode::NotFound
        );
        engine.close(spared).unwrap();
    }

    #[test]
    fn jobs_whose_caller_gave_up_are_not_started() {
        let Some(engine) = shared_engine() else {
            return;
        };
        let id = new_id();
        open_fixture(engine, id).unwrap();

        // With a zero timeout the deadline has passed before the worker dequeues the job, so it must not run.
        let late = engine.call(Duration::ZERO, Rank::CONTROL, |reply| Job::Crash {
            id: Some(id),
            reply,
        });
        assert_eq!(late.unwrap_err().code(), ErrorCode::EngineTimeout);
        // Had the crash job run, the document would be quarantined now.
        assert!(render(engine, id, 0, -4).is_ok());
        engine.close(id).unwrap();
    }

    #[test]
    fn a_missing_library_fails_every_request_cleanly() {
        let engine = Engine::start(PathBuf::from("no-such-dir").join(LIBRARY_FILE));
        let id = new_id();
        assert_eq!(
            open_fixture(&engine, id).unwrap_err().code(),
            ErrorCode::EngineUnavailable
        );
        assert_eq!(
            render(&engine, id, 0, 0).unwrap_err().code(),
            ErrorCode::EngineUnavailable
        );
    }

    /// A worker that takes `delay` per job and answers `close` jobs with success. Needs no PDFium.
    fn slow_worker(
        delay: Duration,
    ) -> impl FnOnce(Requests, Arc<Health>, Arc<SizeCache>) + Send + 'static {
        move |requests, health, _sizes| {
            for request in requests {
                let _busy = health.begin(request.deadline);
                thread::sleep(delay);
                if let Job::Close { reply, .. } = request.job {
                    let _ = reply.send(Ok(()));
                }
            }
        }
    }

    /// An engine with a respawnable runner and no PDFium: the first worker sleeps `first_delay` per job, later ones answer at
    /// once. Every job is answered with `Ok` for a close and `engine_crashed` for a document in `stale`, as the real worker does.
    fn respawning_engine(first_delay: Duration) -> (Engine, Arc<std::sync::atomic::AtomicUsize>) {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let starts = Arc::new(AtomicUsize::new(0));
        let counted = Arc::clone(&starts);
        let runner: Arc<Runner> = Arc::new(move |requests, health, _sizes, stale| {
            let delay = if counted.fetch_add(1, Ordering::SeqCst) == 0 {
                first_delay
            } else {
                Duration::ZERO
            };
            for request in requests {
                if health.is_retired() {
                    request
                        .job
                        .fail(AppError::new(ErrorCode::EngineUnavailable));
                    continue;
                }
                let _busy = health.begin(request.run_deadline());
                thread::sleep(delay);
                match request.job {
                    Job::Outline { id, reply } if stale.contains(&id) => {
                        let _ = reply.send(Err(AppError::new(ErrorCode::EngineCrashed)));
                    }
                    Job::Outline { reply, .. } => {
                        let _ = reply.send(Ok(Vec::new()));
                    }
                    job => job.fail(AppError::new(ErrorCode::Internal)),
                }
            }
        });
        let sizes = Arc::new(SizeCache::default());
        let live = {
            let (runner, sizes) = (Arc::clone(&runner), Arc::clone(&sizes));
            launch(8, move |requests, health| {
                runner(requests, health, sizes, HashSet::new());
            })
        };
        (Engine::assemble(live, sizes, 8, Some(runner)), starts)
    }

    #[test]
    fn a_worker_stuck_past_its_deadline_is_replaced_and_its_documents_are_stale() {
        use std::sync::atomic::Ordering;
        let (engine, starts) = respawning_engine(Duration::from_millis(600));
        let registry = Registry::new();
        let id = registry.register(fixture()).unwrap();
        engine.seed_page_sizes(id, vec![[1.0, 1.0]]);
        let outline =
            |timeout| engine.call(timeout, Rank::CONTROL, |reply| Job::Outline { id, reply });

        // The first worker needs 600 ms, its caller waits 50 ms.
        assert_eq!(
            outline(Duration::from_millis(50)).unwrap_err().code(),
            ErrorCode::EngineTimeout
        );
        thread::sleep(Duration::from_millis(80));
        // The next call sees the stuck worker, is refused, and replaces it.
        assert_eq!(
            outline(Duration::from_secs(5)).unwrap_err().code(),
            ErrorCode::EngineUnavailable
        );
        let waited = Instant::now();
        while starts.load(Ordering::SeqCst) < 2 && waited.elapsed() < Duration::from_secs(5) {
            thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(starts.load(Ordering::SeqCst), 2);
        // The new worker answers at once, and knows the old document only as stale.
        assert_eq!(
            outline(Duration::from_secs(5)).unwrap_err().code(),
            ErrorCode::EngineCrashed
        );
        let fresh = registry.register(fixture()).unwrap();
        assert!(engine
            .call(Duration::from_secs(5), Rank::CONTROL, |reply| {
                Job::Outline { id: fresh, reply }
            })
            .is_ok());
        assert_eq!(starts.load(Ordering::SeqCst), 2, "no further respawn");
    }

    #[test]
    fn the_worker_is_replaced_at_most_max_respawns_times() {
        use std::sync::atomic::Ordering;
        let (engine, starts) = respawning_engine(Duration::from_millis(400));
        engine.inner.respawns.store(MAX_RESPAWNS, Ordering::SeqCst);
        let registry = Registry::new();
        let id = registry.register(fixture()).unwrap();
        let outline =
            |timeout| engine.call(timeout, Rank::CONTROL, |reply| Job::Outline { id, reply });
        assert!(outline(Duration::from_millis(30)).is_err());
        thread::sleep(Duration::from_millis(60));
        assert_eq!(
            outline(Duration::from_secs(1)).unwrap_err().code(),
            ErrorCode::EngineUnavailable
        );
        thread::sleep(Duration::from_millis(50));
        assert_eq!(starts.load(Ordering::SeqCst), 1, "no worker after the cap");
    }

    #[test]
    fn a_double_without_a_runner_is_not_respawned() {
        // 2 s: the job must still be running at the second call even on a slow CI runner (300 ms flaked on macOS).
        let engine = Engine::spawn(8, slow_worker(Duration::from_secs(2)));
        let id = Registry::new().register(fixture()).unwrap();
        assert!(close(&engine, id, Duration::from_millis(30)).is_err());
        thread::sleep(Duration::from_millis(50));
        assert!(close(&engine, id, Duration::from_secs(5)).is_err());
        assert!(!engine.inner.health().is_retired());
    }

    fn close(engine: &Engine, id: DocumentId, timeout: Duration) -> Result<(), AppError> {
        engine.call(timeout, Rank::CONTROL, |reply| Job::Close { id, reply })
    }

    #[test]
    fn a_stuck_job_times_out_then_the_engine_fails_fast_and_recovers() {
        let engine = Engine::spawn(8, slow_worker(Duration::from_millis(400)));
        let id = new_id();

        // The job takes 400 ms, its caller waits 50 ms: timeout.
        assert_eq!(
            close(&engine, id, Duration::from_millis(50))
                .unwrap_err()
                .code(),
            ErrorCode::EngineTimeout
        );
        // The slow job is still running past its deadline: new jobs are refused at once instead of queueing behind it.
        let started = Instant::now();
        assert_eq!(
            close(&engine, id, Duration::from_secs(5))
                .unwrap_err()
                .code(),
            ErrorCode::EngineUnavailable
        );
        assert!(started.elapsed() < Duration::from_secs(1));

        // Once the slow job has finished the worker is healthy again.
        thread::sleep(Duration::from_millis(600));
        assert!(close(&engine, id, Duration::from_secs(5)).is_ok());
    }

    #[test]
    fn a_full_queue_is_refused_without_blocking() {
        // A worker that never reads its queue; depth 1 holds exactly one job.
        let engine = Engine::spawn(1, |requests, _health, _sizes| {
            let _held = requests;
            thread::sleep(Duration::from_secs(3));
        });
        let id = new_id();
        // The first job sits in the queue, and its caller keeps waiting for it.
        let first = {
            let engine = engine.clone();
            thread::spawn(move || close(&engine, id, Duration::from_secs(2)))
        };
        wait_for_queued(&engine, 1);
        // So this one finds the queue full, and must not wait for its own timeout.
        let started = Instant::now();
        assert_eq!(
            close(&engine, id, Duration::from_secs(2))
                .unwrap_err()
                .code(),
            ErrorCode::EngineTimeout
        );
        assert!(started.elapsed() < Duration::from_secs(1));
        assert_eq!(
            first.join().unwrap().unwrap_err().code(),
            ErrorCode::EngineTimeout
        );
    }

    #[test]
    fn a_job_whose_caller_gave_up_does_not_keep_the_queue_full() {
        let engine = Engine::spawn(1, |requests, _health, _sizes| {
            let _held = requests;
            thread::sleep(Duration::from_secs(3));
        });
        // Any job but a close: a close is run whoever waits for it (`Request::expired`) and so keeps its place.
        let work = |engine: &Engine, timeout: Duration| {
            engine.call(timeout, Rank::CONTROL, |reply| Job::Crash {
                id: None,
                reply,
            })
        };
        assert_eq!(
            work(&engine, Duration::from_millis(50)).unwrap_err().code(),
            ErrorCode::EngineTimeout
        );
        // That job is still queued but nobody waits for it: this one is taken (it waits its whole timeout, it is not refused).
        let started = Instant::now();
        assert_eq!(
            work(&engine, Duration::from_millis(200))
                .unwrap_err()
                .code(),
            ErrorCode::EngineTimeout
        );
        assert!(started.elapsed() >= Duration::from_millis(150));
        assert_eq!(engine.inner.queue().len(), 1);
    }

    #[test]
    fn a_close_whose_caller_gave_up_keeps_its_place_in_the_queue_because_it_will_run() {
        let engine = Engine::spawn(1, |requests, _health, _sizes| {
            let _held = requests;
            thread::sleep(Duration::from_secs(3));
        });
        let id = new_id();
        assert_eq!(
            close(&engine, id, Duration::from_millis(50))
                .unwrap_err()
                .code(),
            ErrorCode::EngineTimeout
        );
        // The close is not given up on although its caller did: a job that arrives now finds the queue full.
        let started = Instant::now();
        assert_eq!(
            close(&engine, id, Duration::from_secs(2))
                .unwrap_err()
                .code(),
            ErrorCode::EngineTimeout
        );
        assert!(
            started.elapsed() < Duration::from_secs(1),
            "it was refused, not waited for"
        );
        assert_eq!(engine.inner.queue().len(), 1);
    }

    #[test]
    fn a_dead_worker_means_engine_unavailable() {
        let engine = Engine::spawn(1, |_requests, _health, _sizes| {});
        thread::sleep(Duration::from_millis(100));
        assert_eq!(
            close(&engine, new_id(), Duration::from_secs(1))
                .unwrap_err()
                .code(),
            ErrorCode::EngineUnavailable
        );
    }
    // --- tiles, page sizes ---

    /// Rows `y0..y0 + h`, columns `x0..x0 + w` of an RGB image, as one flat vector.
    fn crop(
        info: &png::OutputInfo,
        pixels: &[u8],
        x0: usize,
        y0: usize,
        w: usize,
        h: usize,
    ) -> Vec<u8> {
        let mut out = Vec::with_capacity(w * h * 3);
        for y in y0..y0 + h {
            let from = y * info.line_size + x0 * 3;
            out.extend_from_slice(&pixels[from..from + w * 3]);
        }
        out
    }

    #[test]
    fn a_tile_is_exactly_that_part_of_the_whole_page() {
        let Some(engine) = shared_engine() else {
            return;
        };
        let id = new_id();
        open_fixture(engine, id).unwrap();

        // Bucket 4 is 2 px per point: page 0 is 1224 x 1584 px, a grid of 2 x 2 tiles with short ones at the edge.
        let (whole_info, whole) = decode(&render(engine, id, 0, 4).unwrap());
        assert_eq!((whole_info.width, whole_info.height), (1224, 1584));
        for (tile, x0, y0, w, h) in [
            ((0, 0), 0, 0, 1024, 1024),
            ((1, 0), 1024, 0, 200, 1024),
            ((0, 1), 0, 1024, 1024, 560),
            ((1, 1), 1024, 1024, 200, 560),
        ] {
            let (info, pixels) = decode(&render_tile(engine, id, 0, 4, tile).unwrap());
            assert_eq!(
                (info.width as usize, info.height as usize),
                (w, h),
                "{tile:?}"
            );
            let expected = crop(&whole_info, &whole, x0, y0, w, h);
            let got = crop(&info, &pixels, 0, 0, w, h);
            assert!(
                got == expected,
                "tile {tile:?} differs from the page's pixels"
            );
        }
        // The grid ends there: a third column or row is not a tile of this page.
        for tile in [(2, 0), (0, 2), (u16::MAX, 0)] {
            assert_eq!(
                render_tile(engine, id, 0, 4, tile).unwrap_err().code(),
                ErrorCode::InvalidArgument,
                "{tile:?}"
            );
        }
        engine.close(id).unwrap();
    }

    #[test]
    fn a_page_too_large_for_a_frame_is_rendered_tile_by_tile() {
        let Some(engine) = shared_engine() else {
            return;
        };
        let id = new_id();
        open_fixture(engine, id).unwrap();

        // Bucket 12 is 8 px per point: page 0 is 4896 x 6336 px. One frame is refused, which is what tells the UI to tile ...
        assert_eq!(
            render(engine, id, 0, 12).unwrap_err().code(),
            ErrorCode::LimitExceeded
        );
        // ... and the grid is 5 columns by 7 rows. The red square is x 800..1600, y 736..1536 px.
        let (info, pixels) = decode(&render_tile(engine, id, 0, 12, (0, 0)).unwrap());
        assert_eq!((info.width, info.height), (1024, 1024));
        assert_eq!(pixel(&info, &pixels, 10, 10), [255, 255, 255]);
        assert_eq!(pixel(&info, &pixels, 700, 800), [255, 255, 255]);
        assert_eq!(pixel(&info, &pixels, 900, 800), [255, 0, 0]);
        // The corner tile is cut short at the page edge: 4896 - 4 * 1024 = 800 px wide, 6336 - 6 * 1024 = 192 px high.
        let (info, _) = decode(&render_tile(engine, id, 0, 12, (4, 6)).unwrap());
        assert_eq!((info.width, info.height), (800, 192));
        for tile in [(5, 0), (0, 7)] {
            assert_eq!(
                render_tile(engine, id, 0, 12, tile).unwrap_err().code(),
                ErrorCode::InvalidArgument,
                "{tile:?}"
            );
        }
        // A tile is a tile at every scale: the bitmap never grows beyond 1024 x 1024 however large the page gets.
        let (info, _) = decode(&render_tile(engine, id, 0, 20, (3, 3)).unwrap());
        assert_eq!((info.width, info.height), (1024, 1024));
        engine.close(id).unwrap();
    }

    #[test]
    fn page_sizes_are_in_points_in_page_order() {
        let Some(engine) = shared_engine() else {
            return;
        };
        let id = new_id();
        open_fixture(engine, id).unwrap();
        let sizes = engine.page_sizes(id).unwrap();
        assert_eq!(&*sizes, &[[612.0, 792.0], [200.0, 100.0]]);
        // Read once, when the document was loaded: asking again hands out the same list.
        assert!(Arc::ptr_eq(&sizes, &engine.page_sizes(id).unwrap()));
        engine.close(id).unwrap();
        assert_eq!(
            engine.page_sizes(id).unwrap_err().code(),
            ErrorCode::NotFound
        );
    }

    #[test]
    fn page_sizes_are_a_lookup_that_does_not_wait_for_the_worker_or_take_a_place_in_the_queue() {
        let (started_tx, started_rx) = mpsc::channel();
        let (gate_tx, gate_rx) = mpsc::channel::<()>();
        let gate_rx = std::sync::Mutex::new(gate_rx);
        let engine = Engine::with_handler(move |job| {
            if let Job::Close { reply, .. } = job {
                started_tx.send(()).unwrap();
                gate_rx.lock().unwrap().recv().unwrap();
                let _ = reply.send(Ok(()));
            }
        });
        let id = new_id();
        engine.seed_page_sizes(id, vec![[612.0, 792.0], [200.0, 100.0]]);

        // The worker is busy and the queue has a job in it: neither matters to a size lookup.
        let busy = {
            let engine = engine.clone();
            thread::spawn(move || close(&engine, id, Duration::from_secs(30)))
        };
        started_rx.recv().unwrap();
        let queued = {
            let engine = engine.clone();
            thread::spawn(move || close(&engine, id, Duration::from_secs(30)))
        };
        wait_for_queued(&engine, 1);

        let started = Instant::now();
        for _ in 0..1000 {
            assert_eq!(engine.page_sizes(id).unwrap().len(), 2);
        }
        assert!(started.elapsed() < Duration::from_secs(1));
        assert_eq!(engine.inner.queue().len(), 1, "a lookup is not a job");
        assert_eq!(
            engine.page_sizes(new_id()).unwrap_err().code(),
            ErrorCode::NotFound
        );

        gate_tx.send(()).unwrap();
        started_rx.recv().unwrap();
        gate_tx.send(()).unwrap();
        busy.join().unwrap().unwrap();
        queued.join().unwrap().unwrap();
    }

    #[test]
    fn page_sizes_of_a_document_that_was_loaded_for_nobody_are_not_kept() {
        let Some(engine) = shared_engine() else {
            return;
        };
        let id = new_registered_id();
        let error = open_then_give_up(engine, id, File::open(fixture()).unwrap()).unwrap_err();
        assert_eq!(error.code(), ErrorCode::EngineTimeout);
        assert_eq!(
            engine.page_sizes(id).unwrap_err().code(),
            ErrorCode::NotFound
        );
    }

    #[test]
    fn only_a_close_is_still_run_when_its_caller_has_given_up() {
        let id = new_id();
        let key = RenderKey {
            id,
            page_index: 0,
            bucket: 0,
            tile: None,
        };
        let past = Instant::now();
        thread::sleep(Duration::from_millis(2));

        let (reply, _answer) = mpsc::sync_channel(1);
        let close = Request {
            deadline: past,
            job: Job::Close { id, reply },
        };
        let (reply, _answer) = mpsc::sync_channel(1);
        let render = Request {
            deadline: past,
            job: Job::Render { key, reply },
        };
        assert!(
            !close.expired(),
            "a document must not outlive a close that timed out"
        );
        assert!(render.expired());
        // A close that runs late is not "stuck" at once: it is given the time a close may take.
        assert!(close.run_deadline() > Instant::now() + limits::CONTROL_TIMEOUT / 2);
        assert_eq!(render.run_deadline(), past);
    }

    #[test]
    fn a_snapshot_put_back_keeps_the_pages_added_in_the_session() {
        let Some(engine) = shared_engine() else {
            return;
        };
        let id = new_id();
        let file_pages = open_fixture(engine, id).unwrap();
        // The session adds a page at the end (engine index = the file's page count) and turns page 0.
        let added = engine.append_blank_page(id, [100.0, 50.0]).unwrap();
        assert_eq!(added.engine_index, file_pages);
        engine.set_page_rotations(id, vec![(0, 90)]).unwrap();

        // A save that fails: the copy is released with a snapshot, and put back from it.
        let snapshot = engine.release_with_snapshot(id).unwrap();
        assert_eq!(engine.restore(id, snapshot).unwrap(), file_pages + 1);
        assert!(render(engine, id, added.engine_index, 0).is_ok());
        assert_eq!(
            engine.page_sizes(id).unwrap().len(),
            (file_pages + 1) as usize
        );
        engine.close(id).unwrap();
    }

    #[test]
    fn pages_appended_for_an_insert_the_model_refused_are_taken_off_again() {
        let Some(engine) = shared_engine() else {
            return;
        };
        let id = new_id();
        let file_pages = open_fixture(engine, id).unwrap();
        let first = engine.append_blank_page(id, [100.0, 50.0]).unwrap();
        let second = engine.append_blank_page(id, [100.0, 50.0]).unwrap();
        assert_eq!(
            (first.engine_index, second.engine_index),
            (file_pages, file_pages + 1)
        );
        // A total that is not the copy's (something was added after the pages to take back): nothing is removed.
        engine
            .truncate_pages(id, file_pages, file_pages + 1)
            .unwrap();
        assert!(render(engine, id, second.engine_index, 0).is_ok());
        // The right total: both are gone and the next page gets the first index again.
        engine
            .truncate_pages(id, file_pages, file_pages + 2)
            .unwrap();
        assert!(render(engine, id, second.engine_index, 0).is_err());
        let again = engine.append_blank_page(id, [100.0, 50.0]).unwrap();
        assert_eq!(again.engine_index, file_pages);
        engine.close(id).unwrap();
    }

    #[test]
    fn a_close_whose_caller_gave_up_still_releases_the_document() {
        let Some(engine) = shared_engine() else {
            return;
        };
        let id = new_id();
        open_fixture(engine, id).unwrap();

        // A zero timeout: the deadline has passed before the worker takes the job, which skips any other kind of job. Whether
        // the answer made it in time does not matter, what the worker did does.
        let _ = engine.call(Duration::ZERO, Rank::CONTROL, |reply| Job::Close {
            id,
            reply,
        });
        // The worker runs it all the same: the sizes of the document go with it.
        let until = Instant::now() + Duration::from_secs(5);
        while engine.page_sizes(id).is_ok() {
            assert!(Instant::now() < until, "the close never ran");
            thread::sleep(Duration::from_millis(2));
        }
        assert_eq!(
            render(engine, id, 0, 0).unwrap_err().code(),
            ErrorCode::NotFound
        );
    }

    #[test]
    fn a_crowd_asking_for_one_frame_is_turned_away_beyond_the_limit_and_the_rest_share_the_frame() {
        let (started_tx, started_rx) = mpsc::channel();
        let (gate_tx, gate_rx) = mpsc::channel::<()>();
        let draws = Arc::new(std::sync::atomic::AtomicU32::new(0));
        let counted = Arc::clone(&draws);
        let gate_rx = std::sync::Mutex::new(gate_rx);
        let engine = Engine::with_handler(move |job| {
            if let Job::Render { reply, .. } = job {
                counted.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                started_tx.send(()).unwrap();
                gate_rx.lock().unwrap().recv().unwrap();
                let _ = reply.send(Ok(Arc::new(vec![8; 1024])));
            }
        });
        let id = new_id();
        let frame = spec(id, 0, 0, None);
        let starter = render_on_thread(&engine, frame);
        started_rx.recv().unwrap();
        let joined: Vec<_> = (0..limits::MAX_RENDER_WAITERS)
            .map(|_| render_on_thread(&engine, frame))
            .collect();
        wait_for_waiters(&engine, frame.key, limits::MAX_RENDER_WAITERS);

        // The next one is refused at once, without waiting for the frame.
        let started = Instant::now();
        let error = engine.render(frame).unwrap_err();
        assert_eq!(error.code(), ErrorCode::LimitExceeded);
        assert!(started.elapsed() < Duration::from_secs(1));
        assert_eq!(
            engine.inner.queue().waiters(&frame.key),
            Some(limits::MAX_RENDER_WAITERS)
        );

        gate_tx.send(()).unwrap();
        let first = starter.join().unwrap().unwrap();
        for caller in joined {
            // Every caller holds the one frame the worker made.
            assert!(Arc::ptr_eq(&caller.join().unwrap().unwrap(), &first));
        }
        assert_eq!(draws.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    // --- the queue in front of the worker ---

    /// Waits until `count` jobs are queued (the worker is busy, so they stay there).
    fn wait_for_queued(engine: &Engine, count: usize) {
        let until = Instant::now() + Duration::from_secs(5);
        while engine.inner.queue().len() < count {
            assert!(Instant::now() < until, "the jobs never reached the queue");
            thread::sleep(Duration::from_millis(2));
        }
    }

    /// A render request on a thread of its own, answered when the worker gets to it.
    fn render_on_thread(
        engine: &Engine,
        spec: RenderSpec,
    ) -> thread::JoinHandle<Result<Frame, AppError>> {
        let engine = engine.clone();
        thread::spawn(move || engine.render(spec))
    }

    #[test]
    fn waiting_renders_are_cancelled_by_a_viewport_hint_and_the_running_one_is_not() {
        let (started_tx, started_rx) = mpsc::channel();
        let (gate_tx, gate_rx) = mpsc::channel::<()>();
        let order: Arc<std::sync::Mutex<Vec<u32>>> = Arc::default();
        let log = Arc::clone(&order);
        let gate_rx = std::sync::Mutex::new(gate_rx);
        let engine = Engine::with_handler(move |job| {
            if let Job::Render { key, reply } = job {
                if key.page_index == 0 {
                    started_tx.send(()).unwrap();
                    gate_rx.lock().unwrap().recv().unwrap();
                }
                log.lock().unwrap().push(key.page_index);
                let _ = reply.send(Ok(Arc::new(vec![key.page_index as u8])));
            }
        });
        let id = new_id();
        let ask = |page: u32, priority: Priority, generation: u32| {
            let mut spec = spec(id, page, 0, None);
            spec.priority = priority;
            spec.generation = generation;
            render_on_thread(&engine, spec)
        };

        // Page 0 is on its way through the worker; the rest wait behind it.
        let running = ask(0, Priority::Visible, 1);
        started_rx.recv().unwrap();
        let left = ask(1, Priority::Visible, 1);
        let stays = ask(2, Priority::Visible, 1);
        let ahead = ask(3, Priority::Near, 1);
        let thumbnail = ask(9, Priority::Thumbnail, 1);
        wait_for_queued(&engine, 4);

        // The user scrolled: page 2 is on screen, page 3 is close, page 1 and page 0 are gone from the viewport.
        engine.set_viewport(id, 2, &[2], &[3]);
        assert_eq!(
            left.join().unwrap().unwrap_err().code(),
            ErrorCode::Cancelled
        );

        gate_tx.send(()).unwrap();
        assert_eq!(*running.join().unwrap().unwrap(), vec![0]);
        assert_eq!(*stays.join().unwrap().unwrap(), vec![2]);
        assert_eq!(*ahead.join().unwrap().unwrap(), vec![3]);
        assert_eq!(*thumbnail.join().unwrap().unwrap(), vec![9]);
        // Most urgent first, and page 1 was never drawn.
        assert_eq!(*order.lock().unwrap(), [0, 2, 3, 9]);
    }

    #[test]
    fn the_same_frame_asked_for_twice_is_drawn_once_and_both_callers_get_it() {
        let (started_tx, started_rx) = mpsc::channel();
        let (gate_tx, gate_rx) = mpsc::channel::<()>();
        let draws = Arc::new(std::sync::atomic::AtomicU32::new(0));
        let counted = Arc::clone(&draws);
        let gate_rx = std::sync::Mutex::new(gate_rx);
        let engine = Engine::with_handler(move |job| {
            if let Job::Render { reply, .. } = job {
                counted.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                started_tx.send(()).unwrap();
                gate_rx.lock().unwrap().recv().unwrap();
                let _ = reply.send(Ok(Arc::new(vec![4, 2])));
            }
        });
        let id = new_id();
        let first = render_on_thread(&engine, spec(id, 5, 3, None));
        started_rx.recv().unwrap();
        // The frame is being drawn now; the second caller joins it, and so does a third that comes in while it runs.
        let second = render_on_thread(&engine, spec(id, 5, 3, None));
        let third = render_on_thread(&engine, spec(id, 5, 3, None));
        wait_for_waiters(&engine, spec(id, 5, 3, None).key, 2);
        // A different bucket is a different frame and waits its turn.
        let other = render_on_thread(&engine, spec(id, 5, 4, None));
        wait_for_queued(&engine, 1);
        gate_tx.send(()).unwrap();
        for caller in [first, second, third] {
            assert_eq!(*caller.join().unwrap().unwrap(), vec![4, 2]);
        }
        gate_tx.send(()).unwrap();
        started_rx.recv().unwrap();
        assert_eq!(*other.join().unwrap().unwrap(), vec![4, 2]);
        assert_eq!(draws.load(std::sync::atomic::Ordering::SeqCst), 2);
    }

    #[test]
    fn closing_a_document_cancels_its_waiting_renders() {
        let Some(engine) = exclusive_engine() else {
            return;
        };
        let (kept, closed) = (new_id(), new_id());
        open_fixture(engine, kept).unwrap();
        open_fixture(engine, closed).unwrap();

        // Hold the worker, so that what follows has to wait in the queue.
        let (release_tx, release_rx) = mpsc::channel();
        let holder = {
            let engine = engine.clone();
            thread::spawn(move || {
                engine.call(Duration::from_secs(30), Rank::CONTROL, |reply| Job::Hold {
                    gate: release_rx,
                    reply,
                })
            })
        };
        wait_for_busy(engine);
        let doomed = render_on_thread(engine, spec(closed, 0, 0, None));
        let spared = render_on_thread(engine, spec(kept, 0, 0, None));
        wait_for_queued(engine, 2);
        let closer = {
            let engine = engine.clone();
            thread::spawn(move || engine.close(closed))
        };
        wait_for_queued(engine, 3);

        release_tx.send(()).unwrap();
        holder.join().unwrap().unwrap();
        // The close goes first (it is a control job), and takes the other render of that document with it.
        closer.join().unwrap().unwrap();
        assert_eq!(
            doomed.join().unwrap().unwrap_err().code(),
            ErrorCode::Cancelled
        );
        assert!(spared.join().unwrap().is_ok());
        engine.close(kept).unwrap();
    }

    #[test]
    fn a_page_of_a_search_waits_behind_the_renders_and_the_reads_that_are_more_urgent() {
        let (started_tx, started_rx) = mpsc::channel();
        let (gate_tx, gate_rx) = mpsc::channel::<()>();
        let gate_rx = std::sync::Mutex::new(gate_rx);
        let order: Arc<std::sync::Mutex<Vec<&'static str>>> = Arc::default();
        let log = Arc::clone(&order);
        let engine = Engine::with_handler(move |job| {
            let note = |what| log.lock().unwrap().push(what);
            match job {
                // The job that keeps the worker busy while the others queue up.
                Job::Close { reply, .. } => {
                    started_tx.send(()).unwrap();
                    gate_rx.lock().unwrap().recv().unwrap();
                    let _ = reply.send(Ok(()));
                }
                Job::SearchPage { reply, .. } => {
                    note("search");
                    let _ = reply.send(Ok(Vec::new()));
                }
                Job::Outline { reply, .. } => {
                    note("outline");
                    let _ = reply.send(Ok(Vec::new()));
                }
                Job::TextLayer { reply, .. } => {
                    note("text");
                    let _ = reply.send(Ok(TextPage {
                        text: String::new(),
                        boxes: Vec::new(),
                        truncated: false,
                        rotation: 0,
                    }));
                }
                Job::PageLinks { reply, .. } => {
                    note("links");
                    let _ = reply.send(Ok(Vec::new()));
                }
                Job::Render { reply, .. } => {
                    note("render");
                    let _ = reply.send(Ok(Arc::new(vec![1])));
                }
                _ => {}
            }
        });
        let id = new_id();
        let holder = {
            let engine = engine.clone();
            thread::spawn(move || close(&engine, id, Duration::from_secs(30)))
        };
        started_rx.recv().unwrap();

        // They arrive least urgent first, and each is in the queue before the next one is asked.
        let spec = Arc::new(SearchSpec {
            text: "x".to_owned(),
            match_case: false,
            whole_word: false,
        });
        let mut callers = Vec::new();
        let mut asked = |queued: usize, call: Box<dyn FnOnce() + Send>| {
            callers.push(thread::spawn(call));
            wait_for_queued(&engine, queued);
        };
        let e = engine.clone();
        asked(1, Box::new(move || drop(e.search_page(id, 0, spec, 1))));
        let e = engine.clone();
        asked(2, Box::new(move || drop(e.outline(id))));
        let e = engine.clone();
        asked(3, Box::new(move || drop(e.text_layer(id, 0))));
        let e = engine.clone();
        asked(4, Box::new(move || drop(e.page_links(id, 0))));
        let e = engine.clone();
        asked(5, Box::new(move || drop(e.render(spec_of(id, 0)))));

        gate_tx.send(()).unwrap();
        holder.join().unwrap().unwrap();
        for caller in callers {
            caller.join().unwrap();
        }
        // A render that is on screen, then what the user waits for in the order it was asked, then the search.
        assert_eq!(
            *order.lock().unwrap(),
            ["render", "outline", "text", "links", "search"]
        );
    }

    fn spec_of(id: DocumentId, page_index: u32) -> RenderSpec {
        spec(id, page_index, 0, None)
    }

    /// Waits until `count` callers have joined the render of `key`.
    fn wait_for_waiters(engine: &Engine, key: RenderKey, count: usize) {
        let until = Instant::now() + Duration::from_secs(5);
        while engine.inner.queue().waiters(&key) != Some(count) {
            assert!(Instant::now() < until, "the callers never joined the job");
            thread::sleep(Duration::from_millis(2));
        }
    }

    /// Waits until the worker has taken a job (the queue is empty and the worker is not idle).
    fn wait_for_busy(engine: &Engine) {
        let until = Instant::now() + Duration::from_secs(5);
        while !engine.inner.health().is_busy() {
            assert!(Instant::now() < until, "the worker never started the job");
            thread::sleep(Duration::from_millis(2));
        }
    }
}
