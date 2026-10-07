//! The engine child's side (ADR-053 §1): what runs when the executable is started with `--sheer-engine`.
//!
//! The child reads frames from stdin, turns each [`WireRequest`] into the [`Job`] the PDFium worker already serves (`worker::run`,
//! unchanged, on a thread of its own with its own queue), and writes the answer to stdout. It opens no file: a document is read
//! through a [`RemoteFile`], whose `ReadAt` frames the parent answers while the job runs; that is why stdin is read by the main
//! thread alone and the jobs run on another. The only file the child touches is the PDFium library the worker binds.
//!
//! Nothing here may print to stdout: it is the protocol. Log lines go to stderr, which the parent copies into its log.

use std::collections::{HashMap, HashSet};
use std::io;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::{self, SyncSender};
use std::sync::{Arc, Mutex, PoisonError};
use std::thread;
use std::time::{Duration, Instant};

use zeroize::Zeroizing;

use super::files::FileToken;
use super::guard::Health;
use super::queue::{Queue, Rank, Requests};
use super::remote_file::{ReadSource, RemoteFile};
use super::sizes::SizeCache;
use super::transport::{Blob, InProcessTransport};
use super::wire::{
    self, FrameKind, Hello, Ready, WireError, WireLink, WireLoaded, WireRead, WireReply,
    WireRequest, WireSource,
};
use super::{launch, worker, Handle, Job, ReopenSource, Reply, Request};
use crate::documents::sources::SourceBytes;
use crate::documents::DocumentId;
use crate::error::{AppError, ErrorCode};
use crate::export::snapshot::{EngineDocRef, SnapshotId};
use crate::limits;
use crate::pdfwrite::redact::{RasterPage, RasterPixels};

/// Exit codes of a child that could not serve (the parent only sees "died").
const EXIT_HELLO: i32 = 2;
const EXIT_PROTOCOL: i32 = 3;

/// The child's stdout, shared by the job thread (replies) and the worker thread (`ReadAt`s).
type Out = Arc<Mutex<io::Stdout>>;

fn write_out(
    out: &Out,
    kind: FrameKind,
    seq: u32,
    header: &[u8],
    blob: &[u8],
) -> Result<(), wire::FrameError> {
    let mut stdout = out.lock().unwrap_or_else(PoisonError::into_inner);
    wire::write_frame(&mut *stdout, kind, seq, header, blob)
}

/// The child's way to ask the parent for bytes of a file (`ReadAt`) and to hear the answer: the main thread delivers what it reads.
struct Link {
    out: Out,
    seq: AtomicU32,
    pending: Mutex<HashMap<u32, SyncSender<Option<Vec<u8>>>>>,
}

impl Link {
    fn new(out: Out) -> Self {
        Self {
            out,
            seq: AtomicU32::new(0),
            pending: Mutex::new(HashMap::new()),
        }
    }

    fn pending(&self) -> std::sync::MutexGuard<'_, HashMap<u32, SyncSender<Option<Vec<u8>>>>> {
        self.pending.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn ask(&self, read: WireRead) -> io::Result<Vec<u8>> {
        let seq = self.seq.fetch_add(1, Ordering::Relaxed).wrapping_add(1);
        let (tx, rx) = mpsc::sync_channel(1);
        self.pending().insert(seq, tx);
        let header = serde_json::to_vec(&read).map_err(io::Error::other)?;
        if write_out(&self.out, FrameKind::ReadAt, seq, &header, &[]).is_err() {
            self.pending().remove(&seq);
            return Err(io::Error::from(io::ErrorKind::BrokenPipe));
        }
        match rx.recv() {
            Ok(Some(bytes)) => Ok(bytes),
            Ok(None) => Err(io::Error::other("the parent could not read the file")),
            Err(_) => Err(io::Error::from(io::ErrorKind::UnexpectedEof)),
        }
    }

    /// The main thread read the answer to read `seq`.
    fn deliver(&self, seq: u32, answer: Option<Vec<u8>>) {
        if let Some(tx) = self.pending().remove(&seq) {
            let _ = tx.send(answer);
        }
    }

    /// stdin ended: nobody will answer; everyone waiting hears it.
    fn close(&self) {
        self.pending().clear();
    }
}

impl ReadSource for Link {
    fn read_at(&self, token: FileToken, offset: u64, len: u32) -> io::Result<Vec<u8>> {
        // `len` 0 would ask for the length of the file.
        if len == 0 {
            return Ok(Vec::new());
        }
        let mut bytes = self.ask(WireRead { token, offset, len })?;
        bytes.truncate(usize::try_from(len).unwrap_or(usize::MAX));
        Ok(bytes)
    }

    fn len(&self, token: FileToken) -> io::Result<u64> {
        let bytes = self.ask(WireRead {
            token,
            offset: 0,
            len: 0,
        })?;
        let array: [u8; 8] = bytes
            .as_slice()
            .try_into()
            .map_err(|_| io::Error::from(io::ErrorKind::InvalidData))?;
        Ok(u64::from_le_bytes(array))
    }
}

/// Runs the child until the parent closes stdin; the process exit code.
pub fn child_main() -> i32 {
    let stdin = io::stdin();
    let mut input = stdin.lock();
    let out: Out = Arc::new(Mutex::new(io::stdout()));

    let hello = match wire::read_frame(&mut input, wire::control_caps()) {
        Ok(Some(frame)) if frame.kind == FrameKind::Hello => frame,
        _ => return EXIT_HELLO,
    };
    let Ok(hello) = serde_json::from_slice::<Hello>(&hello.header) else {
        return EXIT_HELLO;
    };
    if hello.protocol != wire::PROTOCOL {
        return EXIT_PROTOCOL;
    }

    let link = Arc::new(Link::new(Arc::clone(&out)));
    let mut executor = Executor::start(hello.library, Arc::clone(&link));
    let ready = Ready {
        pdfium: executor.pdfium_bound(),
    };
    let Ok(header) = serde_json::to_vec(&ready) else {
        return EXIT_HELLO;
    };
    if write_out(&out, FrameKind::Ready, 0, &header, &[]).is_err() {
        return EXIT_HELLO;
    }

    // Jobs run on a thread of their own: this one has to keep reading stdin, where the answers to `ReadAt` arrive.
    let (jobs, queued) = mpsc::channel::<(u32, WireRequest, Vec<u8>)>();
    let job_out = Arc::clone(&out);
    let spawned = thread::Builder::new()
        .name("sheer-engine-jobs".into())
        .spawn(move || {
            for (seq, request, blob) in queued {
                let (reply, blob) = executor.handle(request, blob);
                let Ok(header) = serde_json::to_vec(&reply) else {
                    return;
                };
                if write_out(&job_out, FrameKind::Reply, seq, &header, blob.as_slice()).is_err() {
                    return;
                }
            }
        });
    if spawned.is_err() {
        return EXIT_HELLO;
    }

    let code = loop {
        match wire::read_frame(&mut input, wire::request_caps()) {
            Ok(Some(frame)) => match frame.kind {
                FrameKind::Request => {
                    let Ok(request) = serde_json::from_slice::<WireRequest>(&frame.header) else {
                        break EXIT_PROTOCOL;
                    };
                    if jobs.send((frame.seq, request, frame.blob)).is_err() {
                        break EXIT_PROTOCOL;
                    }
                }
                FrameKind::ReadData => link.deliver(frame.seq, Some(frame.blob)),
                FrameKind::ReadFailed => link.deliver(frame.seq, None),
                _ => break EXIT_PROTOCOL,
            },
            // The parent closed the pipe: it is gone or done with us.
            Ok(None) => break 0,
            Err(_) => break EXIT_PROTOCOL,
        }
    };
    link.close();
    drop(jobs);
    code
}

/// Turns requests into jobs of the worker thread and its answers into replies.
struct Executor {
    queue: Arc<Queue>,
    sizes: Arc<SizeCache>,
    link: Arc<Link>,
    /// The parent names snapshots; the worker names them itself. Parent id to worker id.
    snapshots: HashMap<SnapshotId, SnapshotId>,
    // Keeps the worker's health mark alive as long as the worker.
    _transport: InProcessTransport,
}

impl Executor {
    fn start(library: PathBuf, link: Arc<Link>) -> Self {
        let sizes = Arc::new(SizeCache::default());
        let worker_sizes = Arc::clone(&sizes);
        let transport = launch(
            limits::ENGINE_QUEUE_DEPTH,
            "sheer-pdfium",
            move |requests: Requests, health: Arc<Health>| {
                worker::run(&library, requests, &health, &worker_sizes, HashSet::new());
            },
        );
        Self {
            queue: Arc::clone(&transport.queue),
            sizes,
            link,
            snapshots: HashMap::new(),
            _transport: transport,
        }
    }

    /// Whether the worker bound PDFium: a worker that did not answers every job with `engine_unavailable`, and closing a snapshot
    /// that does not exist is otherwise the cheapest job there is.
    fn pdfium_bound(&self) -> bool {
        let probe = SnapshotId::fresh();
        self.ask(|reply| Job::CloseSnapshot { id: probe, reply })
            .is_ok()
    }

    /// Queues one job and waits for the worker to answer it (the parent keeps the deadline).
    fn ask<T>(&self, build: impl FnOnce(Reply<T>) -> Job) -> Result<T, AppError> {
        let (tx, rx) = mpsc::sync_channel(1);
        let request = Request {
            deadline: Instant::now() + Duration::from_secs(24 * 60 * 60),
            job: build(tx),
        };
        self.queue
            .push(request, Rank::CONTROL)
            .map_err(|_| AppError::new(ErrorCode::EngineUnavailable))?;
        rx.recv()
            .unwrap_or_else(|_| Err(AppError::new(ErrorCode::EngineUnavailable)))
    }

    fn handle(&mut self, request: WireRequest, blob: Vec<u8>) -> (WireReply, Blob) {
        match self.dispatch(request, blob) {
            Ok(answer) => answer,
            Err(error) => {
                // The code goes to the parent; what else there is stays in this log.
                error.log();
                (WireReply::Failed(WireError::from_app(&error)), Blob::None)
            }
        }
    }

    fn remote(&self, token: FileToken) -> Result<Handle, AppError> {
        let source: Arc<dyn ReadSource> = Arc::clone(&self.link) as Arc<dyn ReadSource>;
        RemoteFile::open(source, token)
            .map(Handle::Remote)
            .map_err(AppError::from)
    }

    /// What the worker read of document `id` when it loaded it, for the parent's size cache.
    fn loaded(&self, id: DocumentId, pages: u32) -> Result<WireLoaded, AppError> {
        let missing = || AppError::logged(ErrorCode::Internal, "a loaded document has no sizes");
        Ok(WireLoaded {
            pages,
            sizes: self.sizes.get(id).ok_or_else(missing)?.to_vec(),
            rotations: self.sizes.rotations(id).ok_or_else(missing)?.to_vec(),
            boxes: self.sizes.boxes(id).ok_or_else(missing)?.to_vec(),
            flags: self.sizes.flags(id).ok_or_else(missing)?,
        })
    }

    fn snapshot_ref(&self, doc: EngineDocRef) -> Result<EngineDocRef, AppError> {
        match doc {
            EngineDocRef::Live(id) => Ok(EngineDocRef::Live(id)),
            EngineDocRef::Snapshot(id) => self
                .snapshots
                .get(&id)
                .map(|&own| EngineDocRef::Snapshot(own))
                .ok_or_else(|| AppError::not_found("snapshot")),
        }
    }

    fn dispatch(
        &mut self,
        request: WireRequest,
        blob: Vec<u8>,
    ) -> Result<(WireReply, Blob), AppError> {
        use WireRequest as R;
        let done = || (WireReply::Done, Blob::None);
        Ok(match request {
            R::Open { id, file, password } => {
                let file = self.remote(file)?;
                let password = password.map(|secret| Zeroizing::new(secret.expose().to_owned()));
                let pages = self.ask(|reply| Job::Open {
                    id,
                    file,
                    password,
                    // The parent decides whether anybody still wants the document, and closes it if not.
                    confirm: Box::new(|_| true),
                    reply,
                })?;
                (WireReply::Opened(self.loaded(id, pages)?), Blob::None)
            }
            R::Reopen { id, source } => {
                let source = match source {
                    WireSource::File(token) => ReopenSource::File(self.remote(token)?),
                    WireSource::FileWithPassword(token, secret) => ReopenSource::FileWithPassword(
                        self.remote(token)?,
                        Zeroizing::new(secret.expose().to_owned()),
                    ),
                    WireSource::Bytes => ReopenSource::Bytes(blob),
                };
                let pages = self.ask(|reply| Job::Reopen { id, source, reply })?;
                (WireReply::Reopened(self.loaded(id, pages)?), Blob::None)
            }
            R::Render { key } => {
                let frame = self.ask(|reply| Job::Render { key, reply })?;
                let bytes = Arc::try_unwrap(frame).unwrap_or_else(|shared| (*shared).clone());
                (WireReply::Frame, Blob::Owned(bytes))
            }
            R::Outline { id } => {
                let items = self.ask(|reply| Job::Outline { id, reply })?;
                (WireReply::Outline(items), Blob::None)
            }
            R::PageChars { id, engine_index } => {
                let chars = self.ask(|reply| Job::PageChars {
                    id,
                    engine_index,
                    reply,
                })?;
                (WireReply::PageChars(chars), Blob::None)
            }
            R::TextLayer { id, page_index } => {
                let text = self.ask(|reply| Job::TextLayer {
                    id,
                    page_index,
                    reply,
                })?;
                (WireReply::TextLayer(text), Blob::None)
            }
            R::PageLinks { id, page_index } => {
                let links = self.ask(|reply| Job::PageLinks {
                    id,
                    page_index,
                    reply,
                })?;
                let links = links.iter().map(WireLink::from_link).collect();
                (WireReply::PageLinks(links), Blob::None)
            }
            R::PageLabels { id } => {
                let labels = self.ask(|reply| Job::PageLabels { id, reply })?;
                (WireReply::PageLabels(labels), Blob::None)
            }
            R::SmartText { id, engine_index } => {
                let text = self.ask(|reply| Job::SmartText {
                    id,
                    engine_index,
                    reply,
                })?;
                (WireReply::SmartText(text), Blob::None)
            }
            R::FirstPageHints { id, engine_index } => {
                let hints = self.ask(|reply| Job::FirstPageHints {
                    id,
                    engine_index,
                    reply,
                })?;
                (WireReply::FirstPageHints(hints), Blob::None)
            }
            R::ImportAnnotations { id, page_index } => {
                let found = self.ask(|reply| Job::ImportAnnotations {
                    id,
                    page_index,
                    reply,
                })?;
                (WireReply::Annotations(found), Blob::None)
            }
            R::SetAnnotationsHidden { id, hide, show } => {
                self.ask(|reply| Job::SetAnnotationsHidden {
                    id,
                    hide,
                    show,
                    reply,
                })?;
                done()
            }
            R::SearchPage {
                id,
                page_index,
                spec,
                limit,
            } => {
                let limit = usize::try_from(limit).unwrap_or(usize::MAX);
                let hits = self.ask(|reply| Job::SearchPage {
                    id,
                    page_index,
                    spec: Arc::new(spec),
                    limit,
                    reply,
                })?;
                (WireReply::Search(hits), Blob::None)
            }
            R::SetPageRotations { id, items } => {
                self.ask(|reply| Job::SetPageRotations { id, items, reply })?;
                done()
            }
            R::SetCropBox {
                id,
                engine_index,
                crop,
            } => {
                self.ask(|reply| Job::SetCropBox {
                    id,
                    engine_index,
                    crop,
                    reply,
                })?;
                done()
            }
            R::RenderForRedaction {
                id,
                engine_index,
                dpi,
                burn,
            } => {
                let page = self.ask(|reply| Job::RenderForRedaction {
                    id,
                    engine_index,
                    dpi,
                    burn,
                    reply,
                })?;
                raster(page)
            }
            R::OpenSnapshot { id } => {
                let bytes: Arc<[u8]> = Arc::from(blob);
                let own = self.ask(|reply| Job::OpenSnapshot { bytes, reply })?;
                self.snapshots.insert(id, own);
                (WireReply::SnapshotOpened(id), Blob::None)
            }
            R::CloseSnapshot { id } => {
                if let Some(own) = self.snapshots.remove(&id) {
                    self.ask(|reply| Job::CloseSnapshot { id: own, reply })?;
                }
                done()
            }
            R::RenderExport {
                doc,
                engine_index,
                dpi,
                annotations,
                rotate_quarter,
            } => {
                let doc = self.snapshot_ref(doc)?;
                let page = self.ask(|reply| Job::RenderExport {
                    doc,
                    engine_index,
                    dpi,
                    annotations,
                    rotate_quarter,
                    reply,
                })?;
                raster(page)
            }
            R::RenderForOcr {
                doc,
                engine_index,
                dpi,
                max_side,
            } => {
                let doc = self.snapshot_ref(doc)?;
                let page = self.ask(|reply| Job::RenderForOcr {
                    doc,
                    engine_index,
                    dpi,
                    max_side,
                    reply,
                })?;
                raster(page)
            }
            R::AppendBlankPage { id, size } => {
                let appended = self.ask(|reply| Job::AppendBlankPage { id, size, reply })?;
                (WireReply::Appended(vec![appended]), Blob::None)
            }
            R::TruncatePages { id, keep, total } => {
                self.ask(|reply| Job::TruncatePages {
                    id,
                    keep,
                    total,
                    reply,
                })?;
                done()
            }
            R::AppendPages { id, pages } => {
                let source = Arc::new(SourceBytes {
                    bytes: Arc::from(blob),
                    page_count: 0,
                    display_name: String::new(),
                });
                let appended = self.ask(|reply| Job::AppendPages {
                    id,
                    source,
                    pages,
                    reply,
                })?;
                (WireReply::Appended(appended), Blob::None)
            }
            R::Release { id, snapshot } => {
                let bytes = self.ask(|reply| Job::Release {
                    id,
                    snapshot,
                    reply,
                })?;
                if snapshot {
                    let bytes = bytes.ok_or_else(|| {
                        AppError::logged(ErrorCode::Internal, "no snapshot of the document")
                    })?;
                    (WireReply::Released { snapshot: true }, Blob::Owned(bytes))
                } else {
                    done()
                }
            }
            R::Close { id } => {
                self.ask(|reply| Job::Close { id, reply })?;
                done()
            }
            #[cfg(debug_assertions)]
            R::Crash => {
                if std::env::var_os("SHEER_ENGINE_TEST_HOOKS").is_some_and(|value| value == "1") {
                    std::process::abort();
                }
                return Err(AppError::invalid("crash"));
            }
        })
    }
}

/// A raster as a reply: the pixels travel raw in the blob.
fn raster(page: RasterPage) -> (WireReply, Blob) {
    let (gray, pixels) = match page.pixels {
        RasterPixels::Rgb8(bytes) => (false, bytes),
        RasterPixels::Gray8(bytes) => (true, bytes),
    };
    (
        WireReply::Raster {
            width: page.width,
            height: page.height,
            gray,
        },
        Blob::Owned(pixels),
    )
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_release_profile_keeps_debug_assertions_off_so_the_kill_hook_is_not_compiled() {
        // The `Crash` request and its handler are `cfg(debug_assertions)`; a release profile that switched them on would ship them.
        let manifest = include_str!("../../Cargo.toml");
        let release = manifest.split("[profile.release]").nth(1).unwrap_or("");
        let section = release.split("\n[").next().unwrap_or("");
        assert!(!section.contains("debug-assertions"), "{section}");
    }
}
