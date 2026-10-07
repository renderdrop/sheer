//! The parent side of the OCR child (ADR-134 items 1, 9): starts our own executable in child mode, sends a bitmap, waits at most
//! [`limits::PAGE_TIMEOUT`] for the answer, and kills the child when it is late or broken. The next page starts a new child.

use std::io::BufWriter;
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::time::Duration;

use super::limits;
use super::wire::{self, OcrReply, OcrRequest, WireError};
use super::OcrPageLayer;

/// Why a page failed; that page only.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OcrError {
    Spawn,
    /// The child ended or the pipe broke before it answered.
    ChildDied,
    Timeout,
    /// The reply broke the protocol or the bounds.
    BadReply(String),
    /// The child answered with a failure code.
    Failed(String),
}

impl std::fmt::Display for OcrError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            OcrError::Spawn => write!(f, "spawn"),
            OcrError::ChildDied => write!(f, "child_died"),
            OcrError::Timeout => write!(f, "timeout"),
            OcrError::BadReply(why) => write!(f, "bad_reply: {why}"),
            OcrError::Failed(code) => write!(f, "failed: {code}"),
        }
    }
}

impl std::error::Error for OcrError {}

struct Live {
    child: Child,
    stdin: BufWriter<ChildStdin>,
    replies: Receiver<Result<OcrReply, WireError>>,
}

/// One OCR child at a time, started on demand and restarted after a failure.
pub struct ChildClient {
    exe: PathBuf,
    live: Option<Live>,
    next_id: u64,
    /// How many children were started (the restart budget of the app counts these).
    pub spawned: u32,
}

impl ChildClient {
    pub fn new(exe: PathBuf) -> Self {
        Self {
            exe,
            live: None,
            next_id: 1,
            spawned: 0,
        }
    }

    fn spawn(&mut self) -> Result<(), OcrError> {
        let mut child = Command::new(&self.exe)
            .arg(super::CHILD_FLAG)
            .env(super::CHILD_ENV, "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| OcrError::Spawn)?;
        let (Some(stdin), Some(mut stdout)) = (child.stdin.take(), child.stdout.take()) else {
            let _ = child.kill();
            return Err(OcrError::Spawn);
        };
        let (tx, replies) = mpsc::channel();
        // One reader thread per child: a blocking read cannot be given a timeout, a channel can.
        std::thread::spawn(move || loop {
            let reply = wire::read_reply(&mut stdout);
            let stop = reply.is_err();
            if tx.send(reply).is_err() || stop {
                return;
            }
        });
        self.spawned += 1;
        self.live = Some(Live {
            child,
            stdin: BufWriter::new(stdin),
            replies,
        });
        Ok(())
    }

    /// Kills the child (if any); the next request starts a new one.
    pub fn kill(&mut self) {
        if let Some(mut live) = self.live.take() {
            let _ = live.child.kill();
            let _ = live.child.wait();
        }
    }

    /// The process id of the running child, for a test that kills it from outside.
    pub fn child_id(&self) -> Option<u32> {
        self.live.as_ref().map(|l| l.child.id())
    }

    /// Recognizes a gray8 bitmap. Any failure kills the child, so the next call starts a fresh one.
    pub fn recognize(
        &mut self,
        pixels: &[u8],
        w: u32,
        h: u32,
        lang: &str,
        timeout: Duration,
    ) -> Result<OcrPageLayer, OcrError> {
        let id = self.next_id;
        self.next_id += 1;
        let request = OcrRequest {
            v: 1,
            id,
            w,
            h,
            stride: w,
            format: "gray8".into(),
            lang: vec![lang.to_owned()],
        };
        wire::validate_request(&request).map_err(|e| OcrError::BadReply(e.to_string()))?;
        if pixels.len() != w as usize * h as usize {
            return Err(OcrError::BadReply("bitmap size".into()));
        }
        // A child that ended between two pages (killed from outside, crashed idle) is replaced before the page is sent.
        if self
            .live
            .as_mut()
            .is_some_and(|l| l.child.try_wait().map_or(true, |s| s.is_some()))
        {
            self.kill();
        }
        if self.live.is_none() {
            self.spawn()?;
        }
        let result = self.exchange(&request, pixels, timeout);
        match &result {
            Ok(_) => {}
            // A refusal in the child (language missing) leaves it healthy.
            Err(OcrError::Failed(_)) => {}
            Err(_) => self.kill(),
        }
        let mut layer = result?;
        layer.lang = lang.to_owned();
        Ok(layer)
    }

    fn exchange(
        &mut self,
        request: &OcrRequest,
        pixels: &[u8],
        timeout: Duration,
    ) -> Result<OcrPageLayer, OcrError> {
        let live = self.live.as_mut().ok_or(OcrError::ChildDied)?;
        wire::write_message(&mut live.stdin, request, pixels).map_err(|_| OcrError::ChildDied)?;
        let reply = match live.replies.recv_timeout(timeout) {
            Ok(Ok(reply)) => reply,
            Ok(Err(WireError::Truncated)) | Err(RecvTimeoutError::Disconnected) => {
                return Err(OcrError::ChildDied)
            }
            Ok(Err(other)) => return Err(OcrError::BadReply(other.to_string())),
            Err(RecvTimeoutError::Timeout) => return Err(OcrError::Timeout),
        };
        if reply.id != request.id && reply.id != 0 {
            return Err(OcrError::BadReply("id".into()));
        }
        if !reply.ok {
            return Err(OcrError::Failed(
                reply.error.unwrap_or_else(|| "unknown".into()),
            ));
        }
        wire::sanitize(&reply, request.w, request.h).map_err(|e| OcrError::BadReply(e.to_string()))
    }
}

impl Drop for ChildClient {
    fn drop(&mut self) {
        self.kill();
    }
}

/// The page timeout of the app.
pub const fn page_timeout() -> Duration {
    limits::PAGE_TIMEOUT
}
