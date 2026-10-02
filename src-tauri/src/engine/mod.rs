//! PDF engine: one dedicated worker thread owns PDFium and every open document.
//!
//! PDFium is not thread-safe, so no other thread ever touches it. Callers talk to the worker through a bounded
//! channel; each request carries its own reply channel and is answered within [`REQUEST_TIMEOUT`]. The worker runs
//! each request inside `catch_unwind`, so a panic becomes an error instead of taking the app down.
//!
//! The PDFium library is bundled as a Tauri resource (`scripts/fetch-pdfium.sh`) and bound dynamically at runtime.
//! If it cannot be loaded, the worker stays alive and answers every request with `EngineUnavailable`.

pub mod encode;
pub mod limits;
mod worker;

use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, RecvTimeoutError, SyncSender};
use std::thread;
use std::time::Duration;

use crate::documents::DocumentId;
use crate::error::{AppError, ErrorCode};

/// How long a caller waits for the worker before giving up with `EngineTimeout`.
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
/// Pending requests before callers block on `send` (back-pressure).
const QUEUE_DEPTH: usize = 64;
/// PDFium recurses on nested structures; give the worker more stack than the 2 MiB default.
const WORKER_STACK_BYTES: usize = 16 * 1024 * 1024;

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

pub(crate) enum Request {
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
}

impl Request {
    /// Answers the request with an error without doing any work.
    pub(crate) fn fail(self, error: AppError) {
        // The caller may have timed out and dropped its receiver; there is nobody to tell then.
        match self {
            Request::Open { reply, .. } => {
                let _ = reply.send(Err(error));
            }
            Request::Render { reply, .. } => {
                let _ = reply.send(Err(error));
            }
            Request::Close { reply, .. } => {
                let _ = reply.send(Err(error));
            }
        }
    }
}

/// Handle to the worker thread. Cheap to share by reference; all methods block until the worker answers.
pub struct Engine {
    tx: SyncSender<Request>,
}

impl Engine {
    /// Starts the worker thread. Binding PDFium happens on that thread; a failure there is logged and surfaces as
    /// `EngineUnavailable` on every later request.
    pub fn start(library: PathBuf) -> Self {
        let (tx, rx) = mpsc::sync_channel(QUEUE_DEPTH);
        let spawned = thread::Builder::new()
            .name("sheer-pdfium".into())
            .stack_size(WORKER_STACK_BYTES)
            .spawn(move || worker::run(&library, rx));
        if let Err(error) = spawned {
            // `rx` was dropped with the closure, so every request fails fast with `EngineUnavailable`.
            eprintln!("sheer: could not start the PDFium worker thread: {error}");
        }
        Self { tx }
    }

    fn call<T>(&self, build: impl FnOnce(Reply<T>) -> Request) -> Result<T, AppError> {
        let (reply_tx, reply_rx) = mpsc::sync_channel(1);
        self.tx
            .send(build(reply_tx))
            .map_err(|_| AppError::new(ErrorCode::EngineUnavailable))?;
        match reply_rx.recv_timeout(REQUEST_TIMEOUT) {
            Ok(result) => result,
            Err(RecvTimeoutError::Timeout) => Err(AppError::new(ErrorCode::EngineTimeout)),
            // The worker died while handling this request.
            Err(RecvTimeoutError::Disconnected) => Err(AppError::new(ErrorCode::EngineUnavailable)),
        }
    }

    /// Loads the document at `path` under `id` and returns its page count.
    pub fn open(&self, id: DocumentId, path: PathBuf) -> Result<u32, AppError> {
        self.call(|reply| Request::Open { id, path, reply })
    }

    /// Renders one page at `scale` (device pixels per PDF point) and returns it as PNG bytes.
    pub fn render(&self, id: DocumentId, page_index: u32, scale: f32) -> Result<Vec<u8>, AppError> {
        self.call(|reply| Request::Render {
            id,
            page_index,
            scale,
            reply,
        })
    }

    /// Releases the document. Unknown ids are ignored.
    pub fn close(&self, id: DocumentId) -> Result<(), AppError> {
        self.call(|reply| Request::Close { id, reply })
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

    fn decode(png_bytes: &[u8]) -> (png::OutputInfo, Vec<u8>) {
        let mut reader = png::Decoder::new(std::io::Cursor::new(png_bytes))
            .read_info()
            .unwrap();
        let mut buffer = vec![0; reader.output_buffer_size().unwrap()];
        let info = reader.next_frame(&mut buffer).unwrap();
        (info, buffer)
    }

    fn pixel(info: &png::OutputInfo, buffer: &[u8], x: usize, y: usize) -> [u8; 3] {
        let at = y * info.line_size + x * 3;
        [buffer[at], buffer[at + 1], buffer[at + 2]]
    }

    #[test]
    fn renders_the_fixture_page_as_png() {
        let Some(engine) = shared_engine() else {
            return;
        };
        let id = new_id();
        assert_eq!(engine.open(id, fixture()).unwrap(), 2);

        let png = engine.render(id, 0, 1.0).unwrap();
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
        let (info, pixels) = decode(&png);
        assert_eq!((info.width, info.height), (612, 792));
        // Page background is white; the square (PDF x 100..200, y 600..700) is red, with y flipped in the bitmap.
        assert_eq!(pixel(&info, &pixels, 10, 10), [255, 255, 255]);
        assert_eq!(pixel(&info, &pixels, 150, 142), [255, 0, 0]);

        let png = engine.render(id, 1, 2.0).unwrap();
        let (info, _) = decode(&png);
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
        assert_eq!(code(engine.render(id, 2, 1.0)), ErrorCode::PageOutOfRange);
        assert_eq!(code(engine.render(id, 0, 0.05)), ErrorCode::ScaleOutOfRange);
        assert_eq!(code(engine.render(id, 0, 8.5)), ErrorCode::ScaleOutOfRange);
        assert_eq!(
            code(engine.render(id, 0, f32::NAN)),
            ErrorCode::ScaleOutOfRange
        );

        engine.close(id).unwrap();
        assert_eq!(code(engine.render(id, 0, 1.0)), ErrorCode::UnknownDocument);

        // The worker is still healthy after the errors above.
        let other = new_id();
        assert_eq!(engine.open(other, fixture()).unwrap(), 2);
        assert!(engine.render(other, 0, 0.5).is_ok());
        engine.close(other).unwrap();
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
            ErrorCode::InvalidPdf
        );
        let missing = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("does-not-exist.pdf");
        assert_eq!(
            engine.open(id, missing).unwrap_err().code(),
            ErrorCode::FileUnreadable
        );
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
}
