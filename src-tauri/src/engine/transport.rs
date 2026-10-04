//! Where the engine's jobs go (ADR-053 §1.6, ARCHITECTURE §11.1).
//!
//! [`Transport`] is the seam between the parent's queue and whatever runs PDFium. [`InProcessTransport`] is the thread worker of
//! ADR-002 (what unit tests and `Engine::with_handler` doubles use); [`ChildTransport`] is the release build's engine: the same
//! executable started in child mode, spoken to over stdin and stdout with the frames of [`super::wire`].
//!
//! W0 moved the queue and the health mark of the worker thread into [`InProcessTransport`], which `Engine` holds in the place of
//! its former private `Live` struct. Jobs still travel as in-memory `Job`s through that queue. Its [`Transport::call`] stays a
//! refusal: the pump (`pump.rs`) turns jobs into `WireRequest`s for a [`ChildTransport`], and the in-process worker takes jobs.

use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex, PoisonError};
use std::thread;
use std::time::Instant;

use super::files::FileTable;
use super::guard::Health;
use super::queue::Queue;
use super::wire::{
    self, Frame, FrameCaps, FrameKind, Hello, Ready, WireRead, WireReply, WireRequest,
};
use crate::limits;

/// Why a call to the engine did not come back with an answer. All three end in a restart of the engine.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransportError {
    /// No answer by the deadline.
    Timeout,
    /// The engine is gone: end of stream, a read error, or an exit.
    Died,
    /// The engine broke the protocol (a fixed word for the log, never data from it).
    Protocol(&'static str),
}

/// The bytes that travel beside a request or a reply (frames, rasters, snapshots, sources).
#[derive(Debug, Clone, Default)]
pub enum Blob {
    #[default]
    None,
    /// Held by several jobs at once (a snapshot, a source): not copied until it is written to the pipe.
    Shared(Arc<[u8]>),
    Owned(Vec<u8>),
}

impl Blob {
    pub fn as_slice(&self) -> &[u8] {
        match self {
            Self::None => &[],
            Self::Shared(bytes) => bytes,
            Self::Owned(bytes) => bytes,
        }
    }

    pub fn len(&self) -> usize {
        self.as_slice().len()
    }

    pub fn is_empty(&self) -> bool {
        self.as_slice().is_empty()
    }

    /// The bytes by value: moved out of an owned blob, copied from a shared one.
    pub fn into_vec(self) -> Vec<u8> {
        match self {
            Self::None => Vec::new(),
            Self::Shared(bytes) => bytes.to_vec(),
            Self::Owned(bytes) => bytes,
        }
    }
}

/// One engine behind the queue: sends a request, waits for its reply, and can be killed.
pub trait Transport: Send {
    fn call(
        &mut self,
        request: WireRequest,
        blob: Blob,
        deadline: Instant,
    ) -> Result<(WireReply, Blob), TransportError>;

    /// Ends the engine now; a later `call` is `Died`.
    fn kill(&mut self);
}

/// The worker thread of ADR-002 as the engine knows it: the queue that feeds it and its health mark. Replaced as a whole by
/// `Engine::recover`.
pub(super) struct InProcessTransport {
    pub(super) queue: Arc<Queue>,
    pub(super) health: Arc<Health>,
}

impl Transport for InProcessTransport {
    fn call(
        &mut self,
        _request: WireRequest,
        _blob: Blob,
        _deadline: Instant,
    ) -> Result<(WireReply, Blob), TransportError> {
        // Jobs reach this transport as `Job`s on its queue.
        Err(TransportError::Protocol("in-process transport takes jobs"))
    }

    fn kill(&mut self) {
        self.queue.close();
    }
}

// --- The engine child --------------------------------------------------------------------------------------------------

/// How to start an engine child.
#[derive(Debug, Clone)]
pub struct ChildSpec {
    /// The executable to start in child mode: the app itself.
    pub exe: PathBuf,
    /// The PDFium library the child binds.
    pub library: PathBuf,
    /// The handles the child reads through; the reader thread answers its `ReadAt`s from here.
    pub files: Arc<FileTable>,
}

/// What the reader thread tells the call that waits.
enum Event {
    Frame(Frame),
    Died,
    Protocol(&'static str),
}

/// The engine as a child process: requests go to its stdin, a reader thread takes its stdout apart. The reader answers `ReadAt`
/// frames itself (never behind the queue) and hands everything else to [`Transport::call`].
pub struct ChildTransport {
    child: Child,
    stdin: Arc<Mutex<ChildStdin>>,
    events: mpsc::Receiver<Event>,
    expect: mpsc::Sender<FrameCaps>,
    seq: u32,
    dead: bool,
    /// Whether the child bound PDFium (`Ready`).
    pdfium: bool,
}

impl ChildTransport {
    /// Starts the child, sends `Hello` and waits for `Ready` for at most [`limits::ENGINE_HANDSHAKE_TIMEOUT`].
    pub fn spawn(spec: &ChildSpec) -> Result<Self, TransportError> {
        let mut command = Command::new(&spec.exe);
        command
            .arg(wire::CHILD_FLAG)
            .env(wire::CHILD_ENV, "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            // CREATE_NO_WINDOW: a child of a windowed app must not open a console.
            std::os::windows::process::CommandExt::creation_flags(&mut command, 0x0800_0000);
        }
        let mut child = command.spawn().map_err(|error| {
            eprintln!(
                "sheer: could not start the engine process: {}",
                error.kind()
            );
            TransportError::Died
        })?;
        let (Some(stdin), Some(stdout), Some(stderr)) =
            (child.stdin.take(), child.stdout.take(), child.stderr.take())
        else {
            let _ = child.kill();
            let _ = child.wait();
            return Err(TransportError::Died);
        };
        let stdin = Arc::new(Mutex::new(stdin));
        let (events_tx, events) = mpsc::channel();
        let (expect, expected) = mpsc::channel();
        let reader = Reader {
            stdout,
            stdin: Arc::clone(&stdin),
            files: Arc::clone(&spec.files),
            expected,
            events: events_tx,
        };
        let threads = thread::Builder::new()
            .name("sheer-engine-log".into())
            .spawn(move || forward_log(stderr))
            .and_then(|_| {
                thread::Builder::new()
                    .name("sheer-engine-reader".into())
                    .spawn(move || reader.run())
            });
        if threads.is_err() {
            let _ = child.kill();
            let _ = child.wait();
            return Err(TransportError::Died);
        }
        let mut transport = Self {
            child,
            stdin,
            events,
            expect,
            seq: 0,
            dead: false,
            pdfium: false,
        };
        match transport.handshake(spec) {
            Ok(()) => Ok(transport),
            Err(error) => {
                transport.kill();
                Err(error)
            }
        }
    }

    fn handshake(&mut self, spec: &ChildSpec) -> Result<(), TransportError> {
        let deadline = Instant::now() + limits::ENGINE_HANDSHAKE_TIMEOUT;
        let hello = Hello {
            protocol: wire::PROTOCOL,
            library: spec.library.clone(),
            version: env!("CARGO_PKG_VERSION").to_owned(),
        };
        let header = serde_json::to_vec(&hello)
            .map_err(|_| TransportError::Protocol("unencodable hello"))?;
        self.expect
            .send(wire::control_caps())
            .map_err(|_| TransportError::Died)?;
        self.send(FrameKind::Hello, 0, &header, &[])?;
        let frame = self.wait(deadline)?;
        if frame.kind != FrameKind::Ready {
            return Err(TransportError::Protocol("expected Ready"));
        }
        let ready: Ready = serde_json::from_slice(&frame.header)
            .map_err(|_| TransportError::Protocol("malformed header"))?;
        self.pdfium = ready.pdfium;
        Ok(())
    }

    /// Whether the child bound PDFium.
    pub fn pdfium(&self) -> bool {
        self.pdfium
    }

    /// The operating system's id of the child (for the log, and for tests that kill it from outside).
    pub fn id(&self) -> u32 {
        self.child.id()
    }

    fn send(
        &self,
        kind: FrameKind,
        seq: u32,
        header: &[u8],
        blob: &[u8],
    ) -> Result<(), TransportError> {
        let mut stdin = self.stdin.lock().unwrap_or_else(PoisonError::into_inner);
        wire::write_frame(&mut *stdin, kind, seq, header, blob).map_err(|_| TransportError::Died)
    }

    fn wait(&self, deadline: Instant) -> Result<Frame, TransportError> {
        match self
            .events
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
        {
            Ok(Event::Frame(frame)) => Ok(frame),
            Ok(Event::Died) | Err(RecvTimeoutError::Disconnected) => Err(TransportError::Died),
            Ok(Event::Protocol(word)) => Err(TransportError::Protocol(word)),
            Err(RecvTimeoutError::Timeout) => Err(TransportError::Timeout),
        }
    }
}

impl Transport for ChildTransport {
    fn call(
        &mut self,
        request: WireRequest,
        blob: Blob,
        deadline: Instant,
    ) -> Result<(WireReply, Blob), TransportError> {
        if self.dead {
            return Err(TransportError::Died);
        }
        // Not alive any more (killed from outside, crashed between jobs): no point in writing.
        if !matches!(self.child.try_wait(), Ok(None)) {
            return Err(TransportError::Died);
        }
        self.seq = self.seq.wrapping_add(1);
        let seq = self.seq;
        let header = serde_json::to_vec(&request)
            .map_err(|_| TransportError::Protocol("unencodable request"))?;
        // The reader allocates for a frame only up to what this request's answer may be.
        self.expect
            .send(wire::reply_caps(&request))
            .map_err(|_| TransportError::Died)?;
        self.send(FrameKind::Request, seq, &header, blob.as_slice())?;
        let frame = self.wait(deadline)?;
        if frame.kind != FrameKind::Reply || frame.seq != seq {
            return Err(TransportError::Protocol("unexpected frame"));
        }
        let reply: WireReply = serde_json::from_slice(&frame.header)
            .map_err(|_| TransportError::Protocol("malformed header"))?;
        check_blob(&reply, frame.blob.len())?;
        Ok((reply, Blob::Owned(frame.blob)))
    }

    fn kill(&mut self) {
        if self.dead {
            return;
        }
        self.dead = true;
        // Already gone is fine; killing closes the pipes, which ends the reader thread.
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for ChildTransport {
    fn drop(&mut self) {
        self.kill();
    }
}

/// The blob of a reply has to be what its header says (the caps only bounded it).
fn check_blob(reply: &WireReply, blob_len: usize) -> Result<(), TransportError> {
    let fits = match reply {
        WireReply::Frame => blob_len > 0,
        WireReply::Raster {
            width,
            height,
            gray,
        } => wire::raster_blob_len(*width, *height, *gray)
            .is_some_and(|expected| expected == blob_len as u64),
        WireReply::Released { snapshot } => *snapshot == (blob_len > 0),
        _ => blob_len == 0,
    };
    if fits {
        Ok(())
    } else {
        Err(TransportError::Protocol("blob does not match its reply"))
    }
}

/// The parent's end of the child's stdout.
struct Reader<R, W> {
    stdout: R,
    stdin: Arc<Mutex<W>>,
    files: Arc<FileTable>,
    expected: mpsc::Receiver<FrameCaps>,
    events: mpsc::Sender<Event>,
}

impl<R: Read, W: Write> Reader<R, W> {
    /// For each call (the transport says what the answer may be, before it sends the request): frames until the answer. A `ReadAt`
    /// on the way is answered here. Ends when the child ends or breaks the protocol.
    fn run(mut self) {
        while let Ok(caps) = self.expected.recv() {
            loop {
                match wire::read_frame(&mut self.stdout, caps) {
                    Ok(Some(frame)) if frame.kind == FrameKind::ReadAt => {
                        if let Err(word) = self.answer_read(&frame) {
                            let _ = self.events.send(Event::Protocol(word));
                            return;
                        }
                    }
                    Ok(Some(frame)) => {
                        if self.events.send(Event::Frame(frame)).is_err() {
                            return;
                        }
                        break;
                    }
                    Ok(None) => {
                        let _ = self.events.send(Event::Died);
                        return;
                    }
                    Err(error) => {
                        let event = match error {
                            wire::FrameError::Truncated | wire::FrameError::Io(_) => Event::Died,
                            other => Event::Protocol(other.word()),
                        };
                        let _ = self.events.send(event);
                        return;
                    }
                }
            }
        }
    }

    /// Answers one `ReadAt` from the file table: `len` 0 asks for the length of the file (8 bytes, little endian).
    fn answer_read(&self, frame: &Frame) -> Result<(), &'static str> {
        if !frame.blob.is_empty() {
            return Err("ReadAt with a blob");
        }
        let read: WireRead =
            serde_json::from_slice(&frame.header).map_err(|_| "malformed header")?;
        let answer = if read.len == 0 {
            self.files
                .get(read.token)
                .and_then(|file| file.metadata().ok())
                .map(|meta| meta.len().to_le_bytes().to_vec())
        } else {
            self.files.read_at(read.token, read.offset, read.len).ok()
        };
        let mut stdin = self.stdin.lock().unwrap_or_else(PoisonError::into_inner);
        // A pipe that cannot be written is a dead child: the transport finds out by its own means.
        let _ = match &answer {
            Some(bytes) => {
                wire::write_frame(&mut *stdin, FrameKind::ReadData, frame.seq, &[], bytes)
            }
            None => wire::write_frame(&mut *stdin, FrameKind::ReadFailed, frame.seq, &[], &[]),
        };
        Ok(())
    }
}

/// Copies the child's stderr into the parent's log, one entry per line, at most [`limits::ENGINE_LOG_LINE_MAX`] bytes of each.
fn forward_log(stderr: std::process::ChildStderr) {
    let mut reader = BufReader::new(stderr);
    loop {
        let mut line = Vec::new();
        let read = (&mut reader)
            .take(limits::ENGINE_LOG_LINE_MAX as u64)
            .read_until(b'\n', &mut line);
        match read {
            Ok(0) | Err(_) => return,
            Ok(_) => {}
        }
        if line.last() != Some(&b'\n') {
            // A line over the cap: the rest of it is dropped.
            let mut rest = Vec::new();
            loop {
                rest.clear();
                match (&mut reader).take(8192).read_until(b'\n', &mut rest) {
                    Ok(0) | Err(_) => break,
                    Ok(_) if rest.last() == Some(&b'\n') => break,
                    Ok(_) => {}
                }
            }
        }
        let text = String::from_utf8_lossy(&line);
        eprintln!("sheer-engine: {}", text.trim_end());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blob_views_every_kind_as_bytes() {
        assert!(Blob::None.is_empty());
        assert_eq!(Blob::Owned(vec![1, 2]).as_slice(), &[1, 2]);
        assert_eq!(Blob::Shared(Arc::from(vec![3u8, 4, 5])).len(), 3);
        assert_eq!(Blob::Shared(Arc::from(vec![3u8])).into_vec(), vec![3]);
    }

    #[test]
    fn killing_the_in_process_transport_closes_its_queue() {
        let queue = Queue::new(4);
        let mut transport = InProcessTransport {
            queue: Arc::clone(&queue),
            health: Arc::new(Health::default()),
        };
        transport.kill();
        let request = WireRequest::Close {
            id: serde_json::from_value(serde_json::json!(1)).unwrap(),
        };
        assert_eq!(
            transport
                .call(request, Blob::None, Instant::now())
                .unwrap_err(),
            TransportError::Protocol("in-process transport takes jobs")
        );
    }

    fn token(n: u64) -> super::super::files::FileToken {
        serde_json::from_value(serde_json::json!(n)).unwrap()
    }

    /// Runs a reader over `child_output` (what the child would write) after one call with `caps`; what it told the call, and what it
    /// wrote to the child.
    fn read_through(
        child_output: Vec<u8>,
        caps: FrameCaps,
        files: Arc<FileTable>,
    ) -> (Vec<Event>, Vec<u8>) {
        let (events_tx, events) = mpsc::channel();
        let (expect, expected) = mpsc::channel();
        let written = Arc::new(Mutex::new(Vec::new()));
        expect.send(caps).unwrap();
        drop(expect);
        Reader {
            stdout: std::io::Cursor::new(child_output),
            stdin: Arc::clone(&written),
            files,
            expected,
            events: events_tx,
        }
        .run();
        let events: Vec<Event> = events.try_iter().collect();
        let written = written.lock().unwrap().clone();
        (events, written)
    }

    fn frame(kind: FrameKind, seq: u32, header: &[u8], blob: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        wire::write_frame(&mut out, kind, seq, header, blob).unwrap();
        out
    }

    #[test]
    fn a_reply_longer_than_its_cap_is_a_protocol_violation() {
        let lying = frame(FrameKind::Reply, 1, b"{}", &[0; 64]);
        let (events, _) = read_through(lying, FrameCaps::new(16, 16), Arc::new(FileTable::new()));
        assert!(matches!(
            events.as_slice(),
            [Event::Protocol("frame over its cap")]
        ));
    }

    #[test]
    fn a_read_is_answered_from_the_file_table_before_the_reply() {
        let path = std::env::temp_dir().join(format!("sheer-reader-{}.bin", std::process::id()));
        std::fs::write(&path, b"0123456789").unwrap();
        let files = Arc::new(FileTable::new());
        let t = files.insert(std::fs::File::open(&path).unwrap());
        let _ = std::fs::remove_file(&path);
        let read = |offset, len| {
            serde_json::to_vec(&WireRead {
                token: t,
                offset,
                len,
            })
            .unwrap()
        };
        let mut output = frame(FrameKind::ReadAt, 7, &read(2, 4), &[]);
        output.extend(frame(FrameKind::ReadAt, 8, &read(0, 0), &[]));
        output.extend(frame(FrameKind::ReadAt, 9, &read(0, u32::MAX), &[]));
        output.extend(frame(FrameKind::Reply, 1, b"\"Done\"", &[]));
        let (events, written) = read_through(output, wire::control_caps(), Arc::clone(&files));
        assert!(matches!(events.as_slice(), [Event::Frame(f)] if f.kind == FrameKind::Reply));
        let mut answers = std::io::Cursor::new(written);
        let caps = FrameCaps::new(64, 64);
        let first = wire::read_frame(&mut answers, caps).unwrap().unwrap();
        assert_eq!(
            (first.kind, first.seq, first.blob),
            (FrameKind::ReadData, 7, b"2345".to_vec())
        );
        let length = wire::read_frame(&mut answers, caps).unwrap().unwrap();
        assert_eq!(length.blob, 10u64.to_le_bytes().to_vec());
        // Over the cap of a read: refused, and the child hears so.
        let refused = wire::read_frame(&mut answers, caps).unwrap().unwrap();
        assert_eq!((refused.kind, refused.seq), (FrameKind::ReadFailed, 9));
        assert!(wire::read_frame(&mut answers, caps).unwrap().is_none());
        // An unknown token is a failed read too.
        let (_, written) = read_through(
            frame(
                FrameKind::ReadAt,
                3,
                &serde_json::to_vec(&WireRead {
                    token: token(99),
                    offset: 0,
                    len: 1,
                })
                .unwrap(),
                &[],
            ),
            wire::control_caps(),
            files,
        );
        assert_eq!(written[4], FrameKind::ReadFailed as u8);
    }

    #[test]
    fn a_stream_that_ends_between_frames_is_a_death() {
        let (events, _) =
            read_through(Vec::new(), wire::control_caps(), Arc::new(FileTable::new()));
        assert!(matches!(events.as_slice(), [Event::Died]));
    }
    #[test]
    fn a_blob_has_to_match_its_reply() {
        assert!(check_blob(&WireReply::Frame, 10).is_ok());
        assert!(check_blob(&WireReply::Frame, 0).is_err());
        assert!(check_blob(&WireReply::Done, 1).is_err());
        let raster = WireReply::Raster {
            width: 2,
            height: 2,
            gray: false,
        };
        assert!(check_blob(&raster, 12).is_ok());
        assert!(check_blob(&raster, 11).is_err());
        assert!(check_blob(&WireReply::Released { snapshot: true }, 5).is_ok());
        assert!(check_blob(&WireReply::Released { snapshot: true }, 0).is_err());
        assert!(check_blob(&WireReply::Released { snapshot: false }, 5).is_err());
    }
}
