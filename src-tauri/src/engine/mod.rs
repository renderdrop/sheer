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

pub(crate) enum Job {
    Open {
        id: DocumentId,
        path: PathBuf,
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

    /// Loads the document at `path` under `id` and returns its page count.
    pub fn open(&self, id: DocumentId, path: PathBuf) -> Result<u32, AppError> {
        self.call(limits::OPEN_TIMEOUT, |reply| Job::Open { id, path, reply })
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

    /// Ids must be unique across tests because they all use the same engine.
    fn new_id() -> DocumentId {
        static REGISTRY: OnceLock<Registry> = OnceLock::new();
        REGISTRY
            .get_or_init(Registry::new)
            .register(fixture())
            .unwrap()
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
        assert_eq!(engine.open(id, fixture()).unwrap(), 2);

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
        engine.open(id, fixture()).unwrap();

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
        assert_eq!(engine.open(other, fixture()).unwrap(), 2);
        assert!(engine.render(other, 0, 0.5).is_ok());
        engine.close(other).unwrap();
    }

    #[test]
    fn refuses_frames_over_the_render_limits_before_allocating() {
        let Some(engine) = shared_engine() else {
            return;
        };
        let id = new_id();
        engine.open(id, fixture()).unwrap();

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

        // Cargo.toml is plain text, so PDFium must refuse it.
        let not_a_pdf = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml");
        assert_eq!(
            engine.open(id, not_a_pdf).unwrap_err().code(),
            ErrorCode::NotAPdf
        );
        let missing = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("does-not-exist.pdf");
        assert_eq!(
            engine.open(id, missing).unwrap_err().code(),
            ErrorCode::IoNotFound
        );
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
        assert_eq!(engine.open(id, fixture()).unwrap(), 2);
        assert!(engine.render(id, 0, 0.5).is_ok());
        engine.close(id).unwrap();
    }

    #[test]
    fn a_crash_quarantines_only_the_affected_document() {
        let Some(engine) = shared_engine() else {
            return;
        };
        let (hit, spared) = (new_id(), new_id());
        engine.open(hit, fixture()).unwrap();
        engine.open(spared, fixture()).unwrap();

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
        engine.open(id, fixture()).unwrap();

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
            engine.open(id, fixture()).unwrap_err().code(),
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
