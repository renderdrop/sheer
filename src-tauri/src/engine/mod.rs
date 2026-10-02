//! PDF engine: one dedicated worker thread owns PDFium and every open document (ADR-002).
//!
//! PDFium is not thread-safe, so no other thread ever touches it. Callers talk to the worker through a bounded
//! queue; each job carries its own reply channel and a deadline (see [`crate::limits`]). The worker runs each job
//! inside `catch_unwind`, so a panic becomes `engine_crashed` instead of taking the app down, and it skips jobs whose
//! caller has already given up. A caller that times out gets `engine_timeout`; while the stuck job is still running,
//! new jobs fail fast with `engine_unavailable` ([`guard::Health`]) instead of piling up behind it.
//!
//! The PDFium library is bundled as a Tauri resource (`scripts/fetch-pdfium.sh`) and bound dynamically at runtime.
//! If it cannot be loaded, the worker stays alive and answers every job with `engine_unavailable`.

pub mod encode;
mod guard;
mod worker;

use std::fs::File;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender, TrySendError};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use crate::documents::DocumentId;
use crate::error::{AppError, ErrorCode};
use crate::limits;

use self::guard::Health;

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

/// One unit of work for the worker, with the point in time at which its caller stops waiting.
pub(crate) struct Request {
    deadline: Instant,
    job: Job,
}

impl Request {
    /// The caller has already given up (the worker was busy with an earlier job), so starting would be wasted work.
    fn expired(&self) -> bool {
        Instant::now() >= self.deadline
    }
}

/// Asked by the worker once it has loaded a document, with the page count: "does anybody still want it?". It answers `true`
/// if so (and by then has recorded the document, see `Registry::set_page_count`) and `false` if the caller gave up in the
/// meantime, and then the worker drops the document instead of keeping one nobody can ever close.
pub(crate) type Confirm = Box<dyn FnOnce(u32) -> bool + Send>;

pub(crate) enum Job {
    Open {
        id: DocumentId,
        /// The file as intake judged it (`documents::intake`): PDFium reads this very handle, and no path is opened again.
        file: File,
        confirm: Confirm,
        reply: Reply<u32>,
    },
    Render {
        id: DocumentId,
        page_index: u32,
        scale: f32,
        reply: Reply<Vec<u8>>,
    },
    Close {
        id: DocumentId,
        reply: Reply<()>,
    },
    /// Makes the worker panic inside the job guard, to test panic containment. `id` is the document it "works on".
    #[cfg(test)]
    Crash {
        id: Option<DocumentId>,
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
            Job::Close { reply, .. } => {
                let _ = reply.send(Err(error));
            }
            #[cfg(test)]
            Job::Crash { reply, .. } => {
                let _ = reply.send(Err(error));
            }
        }
    }
}

/// Handle to the worker thread. Cheap to clone; every method blocks until the worker answers or the job's deadline
/// passes, so call it from a blocking thread (`spawn_blocking`), never from an async task directly.
#[derive(Clone)]
pub struct Engine {
    tx: SyncSender<Request>,
    health: Arc<Health>,
}

impl Engine {
    /// Starts the worker thread. Binding PDFium happens on that thread; a failure there is logged and surfaces as
    /// `engine_unavailable` on every later job.
    pub fn start(library: PathBuf) -> Self {
        Self::spawn(limits::ENGINE_QUEUE_DEPTH, move |requests, health| {
            worker::run(&library, requests, &health);
        })
    }

    fn spawn(
        queue_depth: usize,
        run: impl FnOnce(Receiver<Request>, Arc<Health>) + Send + 'static,
    ) -> Self {
        let (tx, rx) = mpsc::sync_channel(queue_depth);
        let health = Arc::new(Health::default());
        let worker_health = Arc::clone(&health);
        let spawned = thread::Builder::new()
            .name("sheer-pdfium".into())
            .stack_size(limits::ENGINE_STACK_BYTES)
            .spawn(move || run(rx, worker_health));
        if let Err(error) = spawned {
            // `rx` was dropped with the closure, so every job fails fast with `engine_unavailable`.
            AppError::logged(
                ErrorCode::EngineUnavailable,
                format!("could not start the PDFium worker thread: {error}"),
            )
            .log();
        }
        Self { tx, health }
    }

    /// Test double for other modules: a worker that hands every job to `handler`, which must answer it. Needs no PDFium.
    #[cfg(test)]
    pub(crate) fn with_handler(mut handler: impl FnMut(Job) + Send + 'static) -> Self {
        Self::spawn(limits::ENGINE_QUEUE_DEPTH, move |requests, health| {
            for request in requests {
                let _busy = health.begin(request.deadline);
                handler(request.job);
            }
        })
    }

    /// Sends one job and waits for its answer for at most `timeout`.
    fn call<T>(
        &self,
        timeout: Duration,
        build: impl FnOnce(Reply<T>) -> Job,
    ) -> Result<T, AppError> {
        if self.health.is_wedged() {
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
        match self.tx.try_send(request) {
            Ok(()) => {}
            // Back-pressure: never block the caller on a full queue.
            Err(TrySendError::Full(_)) => {
                return Err(AppError::logged(
                    ErrorCode::EngineTimeout,
                    "the PDF job queue is full",
                ))
            }
            Err(TrySendError::Disconnected(_)) => {
                return Err(AppError::new(ErrorCode::EngineUnavailable))
            }
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
        self.call(limits::OPEN_TIMEOUT, |reply| Job::Open {
            id,
            file,
            confirm: Box::new(confirm),
            reply,
        })
    }

    /// Renders one page at `scale` (device pixels per PDF point) and returns it as a frame (see [`encode`]).
    pub fn render(&self, id: DocumentId, page_index: u32, scale: f32) -> Result<Vec<u8>, AppError> {
        self.call(limits::RENDER_TIMEOUT, |reply| Job::Render {
            id,
            page_index,
            scale,
            reply,
        })
    }

    /// Releases the document. Unknown ids are ignored.
    pub fn close(&self, id: DocumentId) -> Result<(), AppError> {
        self.call(limits::CONTROL_TIMEOUT, |reply| Job::Close { id, reply })
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
    fn shared_engine() -> Option<&'static Engine> {
        static ENGINE: OnceLock<Option<Engine>> = OnceLock::new();
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

    /// The registry the tests' ids come from. One for all of them, because they all use the same engine and an id must not
    /// be used by two documents there.
    fn shared_registry() -> &'static Registry {
        static REGISTRY: OnceLock<Registry> = OnceLock::new();
        REGISTRY.get_or_init(Registry::new)
    }

    /// A fresh id, registered (as intake would have done).
    fn new_id() -> DocumentId {
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

    fn crash(engine: &Engine, id: Option<DocumentId>) -> Result<(), AppError> {
        engine.call(limits::CONTROL_TIMEOUT, |reply| Job::Crash { id, reply })
    }

    #[test]
    fn renders_the_fixture_page_as_a_frame() {
        let Some(engine) = shared_engine() else {
            return;
        };
        let id = new_id();
        assert_eq!(open_fixture(engine, id).unwrap(), 2);

        let frame = engine.render(id, 0, 1.0).unwrap();
        let (info, pixels) = decode(&frame);
        assert_eq!((info.width, info.height), (612, 792));
        // Page background is white; the square (PDF x 100..200, y 600..700) is red, with y flipped in the bitmap.
        assert_eq!(pixel(&info, &pixels, 10, 10), [255, 255, 255]);
        assert_eq!(pixel(&info, &pixels, 150, 142), [255, 0, 0]);

        let frame = engine.render(id, 1, 2.0).unwrap();
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

        let code = |result: Result<Vec<u8>, AppError>| result.unwrap_err().code();
        assert_eq!(code(engine.render(id, 2, 1.0)), ErrorCode::InvalidArgument);
        assert_eq!(code(engine.render(id, 0, 0.05)), ErrorCode::InvalidArgument);
        assert_eq!(code(engine.render(id, 0, 8.5)), ErrorCode::InvalidArgument);
        assert_eq!(
            code(engine.render(id, 0, f32::NAN)),
            ErrorCode::InvalidArgument
        );

        engine.close(id).unwrap();
        assert_eq!(code(engine.render(id, 0, 1.0)), ErrorCode::NotFound);

        // The worker is still healthy after the errors above.
        let other = new_id();
        assert_eq!(open_fixture(engine, other).unwrap(), 2);
        assert!(engine.render(other, 0, 0.5).is_ok());
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
        let error = engine.render(id, 0, 8.0).unwrap_err();
        assert_eq!(error.code(), ErrorCode::LimitExceeded);
        // Page 1 is 200 x 100 pt; at scale 8 it is 1600 x 800 px and fine. The worker is unharmed by the refusal.
        let (info, _) = decode(&engine.render(id, 1, 8.0).unwrap());
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
            engine.render(id, 0, 1.0).unwrap_err().code(),
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
        assert!(engine.render(id, 0, 0.5).is_ok());
        engine.close(id).unwrap();
    }

    #[test]
    fn a_document_nobody_waits_for_is_released_not_orphaned() {
        let Some(engine) = shared_engine() else {
            return;
        };
        let id = new_id();

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
            engine.render(id, 0, 1.0).unwrap_err().code(),
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
        let (kept, orphan, next_orphan) = (new_id(), new_id(), new_id());
        open_fixture(engine, kept).unwrap();

        // Two documents in a row that nobody waits for any more; each open answers with an error, not with a page count.
        for id in [orphan, next_orphan] {
            let error = open_then_give_up(engine, id, File::open(fixture()).unwrap()).unwrap_err();
            assert_eq!(error.code(), ErrorCode::EngineTimeout);
            assert_eq!(
                engine.render(id, 0, 0.5).unwrap_err().code(),
                ErrorCode::NotFound
            );
            // Closing what was released is not an error: an id the worker does not know is ignored.
            assert!(engine.close(id).is_ok());
        }

        // The one that was wanted is untouched, and the worker takes new work.
        assert!(engine.render(kept, 0, 0.5).is_ok());
        let fresh = new_id();
        assert_eq!(open_fixture(engine, fresh).unwrap(), 2);
        assert!(engine.render(fresh, 1, 0.5).is_ok());
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
        let kept = new_id();
        let registry = shared_registry();
        let confirm = move |pages| registry.set_page_count(kept, pages).is_ok();
        engine
            .open(kept, File::open(&path).unwrap(), confirm)
            .unwrap();
        assert!(!is_free(&path), "an open document does not hold its file");
        engine.close(kept).unwrap();
        assert!(is_free(&path), "a closed document still holds its file");

        // The orphan: loaded, then released because its caller gave up. The file is free again as soon as the open answers.
        let orphan = new_id();
        assert!(open_then_give_up(engine, orphan, File::open(&path).unwrap()).is_err());
        assert!(is_free(&path), "a released orphan still holds its file");
    }

    #[test]
    fn a_document_somebody_waits_for_stays() {
        let Some(engine) = shared_engine() else {
            return;
        };
        let id = new_id();
        let registry = shared_registry();
        let confirm = move |pages| registry.set_page_count(id, pages).is_ok();
        assert_eq!(
            engine
                .open(id, File::open(fixture()).unwrap(), confirm)
                .unwrap(),
            2
        );
        assert_eq!(registry.page_count(id).unwrap(), 2);
        assert!(engine.render(id, 0, 0.5).is_ok());
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
        assert!(engine.render(id, 0, 0.5).is_ok());
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
            engine.render(hit, 0, 0.5).unwrap_err().code(),
            ErrorCode::EngineCrashed
        );
        assert!(engine.render(spared, 0, 0.5).is_ok());

        // Closing releases the quarantine entry; the id is then simply unknown.
        engine.close(hit).unwrap();
        assert_eq!(
            engine.render(hit, 0, 0.5).unwrap_err().code(),
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
        let late = engine.call(Duration::ZERO, |reply| Job::Crash {
            id: Some(id),
            reply,
        });
        assert_eq!(late.unwrap_err().code(), ErrorCode::EngineTimeout);
        // Had the crash job run, the document would be quarantined now.
        assert!(engine.render(id, 0, 0.5).is_ok());
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
            engine.render(id, 0, 1.0).unwrap_err().code(),
            ErrorCode::EngineUnavailable
        );
    }

    /// A worker that takes `delay` per job and answers `close` jobs with success. Needs no PDFium.
    fn slow_worker(
        delay: Duration,
    ) -> impl FnOnce(Receiver<Request>, Arc<Health>) + Send + 'static {
        move |requests, health| {
            for request in requests {
                let _busy = health.begin(request.deadline);
                thread::sleep(delay);
                if let Job::Close { reply, .. } = request.job {
                    let _ = reply.send(Ok(()));
                }
            }
        }
    }

    fn close(engine: &Engine, id: DocumentId, timeout: Duration) -> Result<(), AppError> {
        engine.call(timeout, |reply| Job::Close { id, reply })
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
        let engine = Engine::spawn(1, |requests, _health| {
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
        // The first job still sits in the queue, so this one finds it full and must not wait for its own timeout.
        let started = Instant::now();
        assert_eq!(
            close(&engine, id, Duration::from_secs(2))
                .unwrap_err()
                .code(),
            ErrorCode::EngineTimeout
        );
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn a_dead_worker_means_engine_unavailable() {
        let engine = Engine::spawn(1, |_requests, _health| {});
        thread::sleep(Duration::from_millis(100));
        assert_eq!(
            close(&engine, new_id(), Duration::from_secs(1))
                .unwrap_err()
                .code(),
            ErrorCode::EngineUnavailable
        );
    }
}
