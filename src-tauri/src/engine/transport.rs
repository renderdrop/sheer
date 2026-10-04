// trait and in-process half: W0 seam of ADR-053; `ChildTransport` (spawn, handshake, kill, stderr) is package B1's
//! Where the engine's jobs go (ADR-053 §1.6, ARCHITECTURE §11.1).
//!
//! [`Transport`] is the seam between the parent's queue and whatever runs PDFium. [`InProcessTransport`] is the thread worker of
//! ADR-002 (what unit tests and `Engine::with_handler` doubles use); the release build gets `ChildTransport` from package B1.
//!
//! W0 moved the queue and the health mark of the worker thread into [`InProcessTransport`], which `Engine` holds in the place of
//! its former private `Live` struct: nothing else changed. Jobs still travel as in-memory `Job`s through that queue. Its
//! [`Transport::call`] stays a refusal until B1's pump turns `WireRequest`s into jobs for it; nothing calls it before then.

use std::sync::Arc;
use std::time::Instant;

use super::guard::Health;
use super::queue::Queue;
use super::wire::{WireReply, WireRequest};

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
        // Jobs reach this transport as `Job`s on its queue until package B1 maps wire requests onto them.
        Err(TransportError::Protocol("in-process transport takes jobs"))
    }

    fn kill(&mut self) {
        self.queue.close();
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
}
