//! The pump: the parent's thread that feeds the engine child (ADR-053 §1.6, §1.7). It replaces `sheer-pdfium` in the main process: it pops a
//! [`Request`] from the queue (which is unchanged: priorities, dedupe, cancellation), turns the job into a `WireRequest`, calls the
//! [`Transport`], checks what the child answered (the child is hostile input) and answers the waiters. One job is in flight at a time.
//!
//! The pump also keeps what a restart needs. Every open document has its intake handle in the [`FileTable`], its password in memory (never
//! in argv or the environment), and a [`Ledger`] of what the child holds beyond the file. When the child dies, hangs past the deadline
//! or breaks the protocol, the pump kills it, starts a new one and replays every open document into it, then tells the app which
//! documents were lost. A document that was in flight at two deaths within [`limits::ENGINE_RESTART_WINDOW`] is shut out
//! (`engine_crashed` until it is closed), and after [`limits::ENGINE_RESTART_BUDGET`] restarts in a window the engine is
//! `engine_unavailable` until the app restarts.

use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::time::{Duration, Instant};

use zeroize::Zeroizing;

use super::files::{FileTable, FileToken};
use super::ledger::Ledger;
use super::outline::OutlineItem;
use super::pages::Appended;
use super::queue::Requests;
use super::sizes::SizeCache;
use super::transport::{Blob, Transport, TransportError};
use super::wire::{WireLoaded, WireReply, WireRequest, WireSecret, WireSource};
use super::{Confirm, Frame, Handle, Job, PageLink, ReopenSource, Request};
use crate::documents::DocumentId;
use crate::error::{AppError, ErrorCode};
use crate::export::snapshot::{EngineDocRef, SnapshotId};
use crate::limits;
use crate::pdfwrite::redact::{RasterPage, RasterPixels};

/// Told after every restart which documents could not be brought back.
pub(super) type OnRestart = Arc<dyn Fn(Vec<DocumentId>) + Send + Sync>;

/// Starts an engine (child): called for the first one and for every restart.
pub(super) type Spawn = Box<dyn FnMut() -> Result<Box<dyn Transport>, TransportError> + Send>;

pub(super) struct Config {
    pub spawn: Spawn,
    pub sizes: Arc<SizeCache>,
    pub files: Arc<FileTable>,
    pub on_restart: Option<OnRestart>,
}

/// Runs until every `Engine` handle is gone.
pub(super) fn run(mut requests: Requests, config: Config) {
    let mut pump = Pump::new(config);
    pump.start();
    while let Some(request) = requests.next() {
        if request.expired() {
            requests.fail(
                request,
                &AppError::logged(ErrorCode::EngineTimeout, "job expired in the queue"),
            );
            continue;
        }
        pump.serve(&requests, request);
    }
    pump.shutdown();
}

#[derive(Debug, Clone)]
enum Source {
    File(FileToken),
    Bytes(Arc<[u8]>),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Health {
    Healthy,
    /// Shut out (two strikes) or lost in a restart: `engine_crashed` until closed or reopened.
    Shut,
}

struct Doc {
    /// `None` while the file is released (the child holds no copy then).
    source: Option<Source>,
    password: Option<Zeroizing<String>>,
    ledger: Ledger,
    strikes: Vec<Instant>,
    health: Health,
}

impl Doc {
    fn new(source: Source, password: Option<Zeroizing<String>>) -> Self {
        Self {
            source: Some(source),
            password,
            ledger: Ledger::default(),
            strikes: Vec::new(),
            health: Health::Healthy,
        }
    }

    /// What the child reopens the document from, with the bytes that go beside it.
    fn wire_source(&self) -> Option<(WireSource, Blob)> {
        Some(match self.source.as_ref()? {
            Source::File(token) => match &self.password {
                Some(password) => (
                    WireSource::FileWithPassword(*token, WireSecret::new(password.clone())),
                    Blob::None,
                ),
                None => (WireSource::File(*token), Blob::None),
            },
            Source::Bytes(bytes) => (WireSource::Bytes, Blob::Shared(Arc::clone(bytes))),
        })
    }
}

/// Why a document could not be put back into a new child.
enum ReplayFailure {
    /// The child died or broke the protocol again.
    Transport,
    /// The child answered, but the document is not what it was (an error, or other page sizes).
    Lost,
}

struct Pump {
    spawn: Spawn,
    sizes: Arc<SizeCache>,
    files: Arc<FileTable>,
    on_restart: Option<OnRestart>,
    transport: Option<Box<dyn Transport>>,
    docs: HashMap<DocumentId, Doc>,
    /// The snapshots of output jobs that are open, with the bytes they were opened from (to open them again).
    snapshots: Vec<(SnapshotId, Arc<[u8]>)>,
    restarts: VecDeque<Instant>,
    unavailable: bool,
}

impl Pump {
    fn new(config: Config) -> Self {
        Self {
            spawn: config.spawn,
            sizes: config.sizes,
            files: config.files,
            on_restart: config.on_restart,
            transport: None,
            docs: HashMap::new(),
            snapshots: Vec::new(),
            restarts: VecDeque::new(),
            unavailable: false,
        }
    }

    /// The first child, before the first job needs it. Not counted against the restart budget; a failure is retried (and counted)
    /// by the first job. Confirmed (M7): the unbudgeted spawn is one extra start at most, a wedge or crash after it is counted.
    fn start(&mut self) {
        match (self.spawn)() {
            Ok(transport) => self.transport = Some(transport),
            Err(error) => eprintln!("sheer: the engine process did not start: {error:?}"),
        }
    }

    fn shutdown(&mut self) {
        if let Some(mut transport) = self.transport.take() {
            transport.kill();
        }
        for doc in self.docs.values() {
            if let Some(Source::File(token)) = doc.source {
                self.files.release(token);
            }
        }
    }

    // --- Death and restart ---------------------------------------------------------------------------------------------

    fn kill_transport(&mut self) {
        if let Some(mut transport) = self.transport.take() {
            transport.kill();
        }
    }

    /// One more death with `id` in flight; two within the window shut the document out.
    fn strike(&mut self, id: DocumentId) {
        let now = Instant::now();
        let Some(doc) = self.docs.get_mut(&id) else {
            return;
        };
        doc.strikes
            .retain(|at| now.duration_since(*at) < limits::ENGINE_RESTART_WINDOW);
        doc.strikes.push(now);
        if doc.strikes.len() >= limits::ENGINE_STRIKES as usize {
            doc.health = Health::Shut;
        }
    }

    fn is_shut(&self, id: DocumentId) -> bool {
        self.docs
            .get(&id)
            .is_some_and(|doc| doc.health == Health::Shut)
    }

    /// A restart is allowed if fewer than the budget happened in the window; this one is counted.
    fn budget(&mut self) -> bool {
        let now = Instant::now();
        while self
            .restarts
            .front()
            .is_some_and(|at| now.duration_since(*at) >= limits::ENGINE_RESTART_WINDOW)
        {
            self.restarts.pop_front();
        }
        if self.restarts.len() >= limits::ENGINE_RESTART_BUDGET as usize {
            return false;
        }
        self.restarts.push_back(now);
        true
    }

    /// The child failed during a call: kill it, start another one with the documents in it, and say what the caller gets.
    fn transport_failed(&mut self, doc: Option<DocumentId>, error: TransportError) -> AppError {
        eprintln!("sheer: the engine process failed: {error:?}");
        self.kill_transport();
        let mut lost = Vec::new();
        if let Some(id) = doc {
            self.strike(id);
            if self.is_shut(id) {
                lost.push(id);
            }
        }
        self.restart(lost);
        match error {
            TransportError::Timeout => AppError::logged(
                ErrorCode::EngineTimeout,
                "the engine process did not answer in time; it was restarted",
            ),
            _ => AppError::logged(
                ErrorCode::EngineCrashed,
                "the engine process failed; it was restarted",
            ),
        }
    }

    /// A reply that is not what the request asked for, or that the checks refuse: the child is not trusted any more.
    fn reject(&mut self, doc: Option<DocumentId>, word: &'static str) -> AppError {
        self.transport_failed(doc, TransportError::Protocol(word))
    }

    /// Starts a new child and puts every open document back; `lost` are the ones already known to be gone. Tells the app.
    fn restart(&mut self, mut lost: Vec<DocumentId>) {
        self.kill_transport();
        'spawn: loop {
            if !self.budget() {
                self.unavailable = true;
                for (id, doc) in &mut self.docs {
                    if doc.health == Health::Healthy && doc.source.is_some() {
                        doc.health = Health::Shut;
                        lost.push(*id);
                    }
                }
                break;
            }
            match (self.spawn)() {
                Ok(transport) => self.transport = Some(transport),
                Err(error) => {
                    eprintln!("sheer: the engine process did not restart: {error:?}");
                    // No sleep: each retry burns one of the budget's ENGINE_RESTART_BUDGET starts, so the loop is bounded and
                    // a failing spawn ends in engine_unavailable within moments rather than spinning.
                    continue 'spawn;
                }
            }
            let ids: Vec<DocumentId> = self
                .docs
                .iter()
                .filter(|(_, doc)| doc.health == Health::Healthy && doc.source.is_some())
                .map(|(id, _)| *id)
                .collect();
            for id in ids {
                match self.replay(id) {
                    Ok(()) => {}
                    Err(ReplayFailure::Lost) => {
                        if let Some(doc) = self.docs.get_mut(&id) {
                            doc.health = Health::Shut;
                        }
                        lost.push(id);
                    }
                    Err(ReplayFailure::Transport) => {
                        self.kill_transport();
                        self.strike(id);
                        if self.is_shut(id) {
                            lost.push(id);
                        }
                        continue 'spawn;
                    }
                }
            }
            for (id, bytes) in self.snapshots.clone() {
                let request = WireRequest::OpenSnapshot { id };
                match self.raw_call(request, Blob::Shared(bytes), limits::OPEN_TIMEOUT) {
                    Ok(WireReply::SnapshotOpened(opened)) if opened == id => {}
                    Ok(_) => self.snapshots.retain(|(open, _)| *open != id),
                    Err(()) => {
                        self.kill_transport();
                        continue 'spawn;
                    }
                }
            }
            break;
        }
        lost.sort_by_key(|id| id.get());
        lost.dedup();
        if let Some(on_restart) = &self.on_restart {
            on_restart(lost);
        }
    }

    /// One call during a restart. `Err` is a failure of the transport (the caller kills and retries); a `Failed` reply is `Ok` with
    /// that reply.
    fn raw_call(
        &mut self,
        request: WireRequest,
        blob: Blob,
        timeout: Duration,
    ) -> Result<WireReply, ()> {
        let transport = self.transport.as_mut().ok_or(())?;
        transport
            .call(request, blob, Instant::now() + timeout)
            .map(|(reply, _)| reply)
            .map_err(drop)
    }

    /// Reopens document `id` in the new child and replays its ledger. The sizes have to be what they were.
    fn replay(&mut self, id: DocumentId) -> Result<(), ReplayFailure> {
        let Some(doc) = self.docs.get(&id) else {
            return Ok(());
        };
        let Some((source, blob)) = doc.wire_source() else {
            return Ok(());
        };
        let steps = doc.ledger.replay(id);
        let reopened = self
            .raw_call(
                WireRequest::Reopen { id, source },
                blob,
                limits::OPEN_TIMEOUT,
            )
            .map_err(|()| ReplayFailure::Transport)?;
        let WireReply::Reopened(loaded) = reopened else {
            return Err(ReplayFailure::Lost);
        };
        let Some(known) = self.sizes.get(id) else {
            return Err(ReplayFailure::Lost);
        };
        let same = check_loaded(&loaded).is_some_and(|checked| {
            checked.sizes.len() == known.len()
                && checked.sizes.iter().zip(known.iter()).all(|(a, b)| a == b)
        });
        if !same {
            return Err(ReplayFailure::Lost);
        }
        for (request, blob) in steps {
            let reply = self
                .raw_call(request, blob, limits::OPEN_TIMEOUT)
                .map_err(|()| ReplayFailure::Transport)?;
            if matches!(reply, WireReply::Failed(_)) {
                return Err(ReplayFailure::Lost);
            }
        }
        Ok(())
    }

    // --- One call ------------------------------------------------------------------------------------------------------

    /// A running child, starting one (counted) if there is none.
    fn ensure(&mut self) -> Result<(), AppError> {
        if self.transport.is_none() && !self.unavailable {
            self.restart(Vec::new());
        }
        if self.transport.is_some() {
            Ok(())
        } else {
            Err(AppError::logged(
                ErrorCode::EngineUnavailable,
                "no engine process",
            ))
        }
    }

    /// Sends one request and waits for its reply by `deadline`. A death, a hang or a broken protocol restarts the engine
    /// (`transport_failed`); `doc` is the document that was in flight (it gets the strike). An error the child reports comes back as
    /// an `AppError` of that code.
    fn exchange(
        &mut self,
        doc: Option<DocumentId>,
        request: WireRequest,
        blob: Blob,
        deadline: Instant,
    ) -> Result<(WireReply, Blob), AppError> {
        self.ensure()?;
        let Some(transport) = self.transport.as_mut() else {
            return Err(AppError::new(ErrorCode::EngineUnavailable));
        };
        match transport.call(request, blob, deadline) {
            Ok((WireReply::Failed(error), _)) => {
                if error.code == ErrorCode::EngineCrashed {
                    // The child contained a panic; the document is quarantined in it, and counts against the document here.
                    if let Some(id) = doc {
                        self.strike(id);
                    }
                }
                Err(error.into_app())
            }
            Ok(answer) => Ok(answer),
            Err(error) => Err(self.transport_failed(doc, error)),
        }
    }

    /// The document must be one the child holds a copy of.
    fn live(&self, id: DocumentId) -> Result<(), AppError> {
        match self.docs.get(&id) {
            None => Err(AppError::not_found("document")),
            Some(doc) if doc.health == Health::Shut => Err(AppError::new(ErrorCode::EngineCrashed)),
            Some(doc) if doc.source.is_none() => Err(AppError::not_found("document")),
            Some(_) => Ok(()),
        }
    }

    /// A job on document `id`: `take` reads the reply, `None` for one of the wrong kind.
    fn on_doc<T>(
        &mut self,
        id: DocumentId,
        request: WireRequest,
        blob: Blob,
        deadline: Instant,
        take: impl FnOnce(WireReply, Blob) -> Option<T>,
    ) -> Result<T, AppError> {
        self.live(id)?;
        let (reply, blob) = self.exchange(Some(id), request, blob, deadline)?;
        take(reply, blob).ok_or_else(|| self.reject(Some(id), "unexpected reply"))
    }

    fn serve(&mut self, requests: &Requests, request: Request) {
        let deadline = request.run_deadline();
        match request.job {
            Job::Open {
                id,
                file,
                password,
                confirm,
                reply,
            } => {
                let result = self.open(id, file, password, confirm, deadline);
                let _ = reply.send(result);
            }
            Job::Render { key, reply } => {
                let result = self.on_doc(
                    key.id,
                    WireRequest::Render { key },
                    Blob::None,
                    deadline,
                    |reply, blob| {
                        matches!(reply, WireReply::Frame)
                            .then(|| -> Frame { Arc::new(blob.into_vec()) })
                    },
                );
                // Callers that asked for this very frame while it was queued or running get the same answer.
                for waiter in requests.finish_render(&key) {
                    let _ = waiter.send(result.clone());
                }
                let _ = reply.send(result);
            }
            Job::Outline { id, reply } => {
                let result = self.on_doc(
                    id,
                    WireRequest::Outline { id },
                    Blob::None,
                    deadline,
                    |reply, _| match reply {
                        WireReply::Outline(items) if outline_ok(&items) => Some(items),
                        _ => None,
                    },
                );
                let _ = reply.send(result);
            }
            Job::TextLayer {
                id,
                page_index,
                reply,
            } => {
                let result = self.on_doc(
                    id,
                    WireRequest::TextLayer { id, page_index },
                    Blob::None,
                    deadline,
                    |reply, _| match reply {
                        WireReply::TextLayer(text) => Some(text),
                        _ => None,
                    },
                );
                let _ = reply.send(result);
            }
            Job::PageLinks {
                id,
                page_index,
                reply,
            } => {
                let result = self.on_doc(
                    id,
                    WireRequest::PageLinks { id, page_index },
                    Blob::None,
                    deadline,
                    |reply, _| match reply {
                        WireReply::PageLinks(links) => Some(
                            links
                                .into_iter()
                                .take(limits::MAX_PAGE_LINKS)
                                .map(super::wire::WireLink::into_link)
                                .collect::<Vec<PageLink>>(),
                        ),
                        _ => None,
                    },
                );
                let _ = reply.send(result);
            }
            Job::PageLabels { id, reply } => {
                let result = self.on_doc(
                    id,
                    WireRequest::PageLabels { id },
                    Blob::None,
                    deadline,
                    |reply, _| match reply {
                        WireReply::PageLabels(labels)
                            if labels.len() <= limits::PAGE_LABELS_PAGES_MAX as usize
                                && labels.iter().flatten().all(|label| {
                                    label.chars().count() <= limits::PAGE_LABEL_MAX
                                }) =>
                        {
                            Some(labels)
                        }
                        _ => None,
                    },
                );
                let _ = reply.send(result);
            }
            Job::PageChars { reply, .. } => {
                // W0 seam (v1.5.1): the engine package adds the wire request.
                let _ = reply.send(Err(AppError::not_yet()));
            }
            Job::FirstPageHints {
                id,
                engine_index,
                reply,
            } => {
                let result = self.on_doc(
                    id,
                    WireRequest::FirstPageHints { id, engine_index },
                    Blob::None,
                    deadline,
                    |reply, _| match reply {
                        // The reply of a child is checked, not trusted: over its caps it is refused.
                        WireReply::FirstPageHints(hints)
                            if hints.title.as_deref().is_none_or(|t| {
                                t.chars().count() <= limits::BIB_HEURISTIC_TITLE_MAX
                            }) && hints
                                .year
                                .as_deref()
                                .is_none_or(|y| y.chars().count() <= limits::BIB_YEAR_MAX)
                                && hints
                                    .doi
                                    .as_deref()
                                    .is_none_or(|d| d.chars().count() <= limits::BIB_DOI_MAX) =>
                        {
                            Some(hints)
                        }
                        _ => None,
                    },
                );
                let _ = reply.send(result);
            }
            Job::ImportAnnotations {
                id,
                page_index,
                reply,
            } => {
                let result = self.on_doc(
                    id,
                    WireRequest::ImportAnnotations { id, page_index },
                    Blob::None,
                    deadline,
                    |reply, _| match reply {
                        WireReply::Annotations(mut found) => {
                            found.truncate(limits::MAX_IMPORT_PER_PAGE);
                            Some(found)
                        }
                        _ => None,
                    },
                );
                let _ = reply.send(result);
            }
            Job::SetAnnotationsHidden {
                id,
                hide,
                show,
                reply,
            } => {
                let wire = WireRequest::SetAnnotationsHidden {
                    id,
                    hide: hide.clone(),
                    show: show.clone(),
                };
                let result = self.on_doc(id, wire, Blob::None, deadline, done);
                if result.is_ok() {
                    if let Some(doc) = self.docs.get_mut(&id) {
                        doc.ledger.set_hidden(&hide, &show);
                    }
                }
                let _ = reply.send(result);
            }
            Job::SearchPage {
                id,
                page_index,
                spec,
                limit,
                reply,
            } => {
                let wire = WireRequest::SearchPage {
                    id,
                    page_index,
                    spec: (*spec).clone(),
                    limit: u32::try_from(limit).unwrap_or(u32::MAX),
                };
                let result = self.on_doc(id, wire, Blob::None, deadline, |reply, _| match reply {
                    WireReply::Search(mut hits) => {
                        hits.truncate(limit);
                        Some(hits)
                    }
                    _ => None,
                });
                let _ = reply.send(result);
            }
            Job::SetPageRotations { id, items, reply } => {
                let wire = WireRequest::SetPageRotations {
                    id,
                    items: items.clone(),
                };
                let result = self.on_doc(id, wire, Blob::None, deadline, done);
                if result.is_ok() {
                    if let Some(doc) = self.docs.get_mut(&id) {
                        doc.ledger.rotate(&items);
                    }
                }
                let _ = reply.send(result);
            }
            Job::SetCropBox {
                id,
                engine_index,
                crop,
                reply,
            } => {
                let wire = WireRequest::SetCropBox {
                    id,
                    engine_index,
                    crop,
                };
                let result = self.on_doc(id, wire, Blob::None, deadline, done);
                if result.is_ok() {
                    if let Some(doc) = self.docs.get_mut(&id) {
                        doc.ledger.crop(engine_index, crop);
                    }
                }
                let _ = reply.send(result);
            }
            Job::RenderForRedaction {
                id,
                engine_index,
                dpi,
                burn,
                reply,
            } => {
                let wire = WireRequest::RenderForRedaction {
                    id,
                    engine_index,
                    dpi,
                    burn,
                };
                let result = self.on_doc(id, wire, Blob::None, deadline, raster);
                let _ = reply.send(result);
            }
            Job::OpenSnapshot { bytes, reply } => {
                let result = self.open_snapshot(bytes, deadline);
                let _ = reply.send(result);
            }
            Job::CloseSnapshot { id, reply } => {
                // Gone from the books first: a child that dies on the way takes it along, and a new one is not given it.
                self.snapshots.retain(|(open, _)| *open != id);
                let _ = self.exchange(
                    None,
                    WireRequest::CloseSnapshot { id },
                    Blob::None,
                    deadline,
                );
                let _ = reply.send(Ok(()));
            }
            Job::RenderExport {
                doc,
                engine_index,
                dpi,
                annotations,
                rotate_quarter,
                reply,
            } => {
                let result = self.render_export(
                    doc,
                    WireRequest::RenderExport {
                        doc,
                        engine_index,
                        dpi,
                        annotations,
                        rotate_quarter,
                    },
                    deadline,
                );
                let _ = reply.send(result);
            }
            Job::AppendBlankPage { id, size, reply } => {
                let wire = WireRequest::AppendBlankPage { id, size };
                let result = self.on_doc(id, wire, Blob::None, deadline, |reply, _| match reply {
                    WireReply::Appended(mut pages) if pages.len() == 1 => {
                        let mut page = pages.remove(0);
                        sanitize_appended(&mut page);
                        Some(page)
                    }
                    _ => None,
                });
                if result.is_ok() {
                    if let Some(doc) = self.docs.get_mut(&id) {
                        doc.ledger.append_blank(size);
                    }
                }
                let _ = reply.send(result);
            }
            Job::TruncatePages {
                id,
                keep,
                total,
                reply,
            } => {
                let wire = WireRequest::TruncatePages { id, keep, total };
                let result = self.on_doc(id, wire, Blob::None, deadline, done);
                if result.is_ok() {
                    if let Some(doc) = self.docs.get_mut(&id) {
                        doc.ledger.truncate(keep, total);
                    }
                }
                let _ = reply.send(result);
            }
            Job::AppendPages {
                id,
                source,
                pages,
                reply,
            } => {
                let wire = WireRequest::AppendPages {
                    id,
                    pages: pages.clone(),
                };
                let blob = Blob::Shared(Arc::clone(&source.bytes));
                let wanted = pages.len();
                let result = self.on_doc(id, wire, blob, deadline, |reply, _| match reply {
                    WireReply::Appended(mut appended) if appended.len() == wanted => {
                        appended.iter_mut().for_each(sanitize_appended);
                        Some(appended)
                    }
                    _ => None,
                });
                if result.is_ok() {
                    if let Some(doc) = self.docs.get_mut(&id) {
                        doc.ledger.append_pages(Arc::clone(&source), pages);
                    }
                }
                let _ = reply.send(result);
            }
            Job::Release {
                id,
                snapshot,
                reply,
            } => {
                let result = self.release(id, snapshot, deadline);
                let _ = reply.send(result);
            }
            Job::Reopen { id, source, reply } => {
                let result = self.reopen(id, source, deadline);
                let _ = reply.send(result);
            }
            Job::Close { id, reply } => {
                self.close(id, deadline);
                // Nothing queued for a closed document is worth drawing: its callers hear `cancelled`.
                requests.cancel_document(id);
                let _ = reply.send(Ok(()));
            }
            #[cfg(test)]
            job @ (Job::Crash { .. } | Job::Hold { .. }) => {
                job.fail(AppError::new(ErrorCode::Internal));
            }
        }
    }

    // --- Jobs with state -----------------------------------------------------------------------------------------------

    /// Loads a document (`Open` or `Reopen`) and records what the child read of it in the size cache.
    fn load(
        &mut self,
        doc: Option<DocumentId>,
        id: DocumentId,
        request: WireRequest,
        blob: Blob,
        deadline: Instant,
    ) -> Result<u32, AppError> {
        let (reply, _) = self.exchange(doc, request, blob, deadline)?;
        let (WireReply::Opened(loaded) | WireReply::Reopened(loaded)) = reply else {
            return Err(self.reject(doc, "unexpected reply"));
        };
        let Some(checked) = check_loaded(&loaded) else {
            return Err(self.reject(doc, "inconsistent document"));
        };
        self.sizes
            .insert(id, Arc::from(checked.sizes), loaded.flags);
        self.sizes.set_rotations(id, Arc::from(loaded.rotations));
        self.sizes.set_boxes(id, Arc::from(loaded.boxes));
        Ok(loaded.pages)
    }

    fn open(
        &mut self,
        id: DocumentId,
        file: Handle,
        password: Option<Zeroizing<String>>,
        confirm: Confirm,
        deadline: Instant,
    ) -> Result<u32, AppError> {
        let Handle::Local(file) = file else {
            return Err(AppError::logged(
                ErrorCode::Internal,
                "a remote handle in the parent",
            ));
        };
        let token = self.files.insert(file);
        let wire = WireRequest::Open {
            id,
            file: token,
            password: password.as_ref().map(|p| WireSecret::new(p.clone())),
        };
        let pages = match self.load(None, id, wire, Blob::None, deadline) {
            Ok(pages) => pages,
            Err(error) => {
                self.files.release(token);
                return Err(error);
            }
        };
        // The caller may have stopped waiting while the document loaded; nobody could close a document without an entry.
        if !confirm(pages) {
            self.sizes.remove(id);
            self.files.release(token);
            let _ = self.exchange(None, WireRequest::Close { id }, Blob::None, deadline);
            return Err(AppError::logged(
                ErrorCode::EngineTimeout,
                "the document finished loading after its caller gave up; released",
            ));
        }
        self.replace_doc(id, Doc::new(Source::File(token), password));
        Ok(pages)
    }

    /// Puts `doc` in the books under `id`, letting go of the file of one it replaces.
    fn replace_doc(&mut self, id: DocumentId, doc: Doc) {
        if let Some(Doc {
            source: Some(Source::File(old)),
            ..
        }) = self.docs.insert(id, doc)
        {
            self.files.release(old);
        }
    }

    fn reopen(
        &mut self,
        id: DocumentId,
        source: ReopenSource,
        deadline: Instant,
    ) -> Result<u32, AppError> {
        let local = |handle: Handle| match handle {
            Handle::Local(file) => Ok(file),
            Handle::Remote(_) => Err(AppError::logged(
                ErrorCode::Internal,
                "a remote handle in the parent",
            )),
        };
        let (wire, blob, new_source, password) = match source {
            ReopenSource::File(handle) => {
                let token = self.files.insert(local(handle)?);
                (
                    WireSource::File(token),
                    Blob::None,
                    Source::File(token),
                    None,
                )
            }
            ReopenSource::FileWithPassword(handle, password) => {
                let token = self.files.insert(local(handle)?);
                (
                    WireSource::FileWithPassword(token, WireSecret::new(password.clone())),
                    Blob::None,
                    Source::File(token),
                    Some(password),
                )
            }
            ReopenSource::Bytes(bytes) => {
                let bytes: Arc<[u8]> = Arc::from(bytes);
                (
                    WireSource::Bytes,
                    Blob::Shared(Arc::clone(&bytes)),
                    Source::Bytes(bytes),
                    None,
                )
            }
        };
        let request = WireRequest::Reopen { id, source: wire };
        match self.load(
            Some(id).filter(|id| self.docs.contains_key(id)),
            id,
            request,
            blob,
            deadline,
        ) {
            Ok(pages) => {
                // A copy loaded afresh has none of the old one's pages, rotations or hidden annotations; a document that had
                // been shut out is healthy again.
                self.replace_doc(id, Doc::new(new_source, password));
                Ok(pages)
            }
            Err(error) => {
                if let Source::File(token) = new_source {
                    self.files.release(token);
                }
                Err(error)
            }
        }
    }

    fn release(
        &mut self,
        id: DocumentId,
        snapshot: bool,
        deadline: Instant,
    ) -> Result<Option<Vec<u8>>, AppError> {
        let loaded = match self.docs.get(&id) {
            None => return Ok(None),
            Some(doc) => doc.health == Health::Healthy && doc.source.is_some(),
        };
        let mut bytes = None;
        if loaded {
            let request = WireRequest::Release { id, snapshot };
            let (reply, blob) = self.exchange(Some(id), request, Blob::None, deadline)?;
            match (reply, snapshot) {
                (WireReply::Done, false) => {}
                (WireReply::Released { snapshot: true }, true) => bytes = Some(blob.into_vec()),
                _ => return Err(self.reject(Some(id), "unexpected reply")),
            }
        } else if snapshot && self.is_shut(id) {
            return Err(AppError::new(ErrorCode::EngineCrashed));
        }
        // The file is let go of here too, so that it can be replaced.
        if let Some(doc) = self.docs.get_mut(&id) {
            if let Some(Source::File(token)) = doc.source.take() {
                self.files.release(token);
            }
            doc.source = None;
            doc.ledger.clear();
        }
        Ok(bytes)
    }

    fn close(&mut self, id: DocumentId, deadline: Instant) {
        let held = self
            .docs
            .get(&id)
            .is_some_and(|doc| doc.health == Health::Healthy && doc.source.is_some());
        if held {
            // A child that dies on the way takes the document along; either way it is gone.
            let _ = self.exchange(None, WireRequest::Close { id }, Blob::None, deadline);
        }
        if let Some(Doc {
            source: Some(Source::File(token)),
            ..
        }) = self.docs.remove(&id)
        {
            self.files.release(token);
        }
        self.sizes.remove(id);
    }

    fn open_snapshot(
        &mut self,
        bytes: Arc<[u8]>,
        deadline: Instant,
    ) -> Result<SnapshotId, AppError> {
        let id = SnapshotId::fresh();
        let (reply, _) = self.exchange(
            None,
            WireRequest::OpenSnapshot { id },
            Blob::Shared(Arc::clone(&bytes)),
            deadline,
        )?;
        match reply {
            WireReply::SnapshotOpened(opened) if opened == id => {
                self.snapshots.push((id, bytes));
                Ok(id)
            }
            _ => Err(self.reject(None, "unexpected reply")),
        }
    }

    fn render_export(
        &mut self,
        doc: EngineDocRef,
        wire: WireRequest,
        deadline: Instant,
    ) -> Result<RasterPage, AppError> {
        let live = match doc {
            EngineDocRef::Live(id) => {
                self.live(id)?;
                Some(id)
            }
            EngineDocRef::Snapshot(id) => {
                if !self.snapshots.iter().any(|(open, _)| *open == id) {
                    return Err(AppError::not_found("snapshot"));
                }
                None
            }
        };
        let (reply, blob) = self.exchange(live, wire, Blob::None, deadline)?;
        raster(reply, blob).ok_or_else(|| self.reject(live, "unexpected reply"))
    }
}

// --- Checking what the child said -----------------------------------------------------------------------------------------

fn done(reply: WireReply, _: Blob) -> Option<()> {
    matches!(reply, WireReply::Done).then_some(())
}

/// A raster reply as a [`RasterPage`]: the blob has the size its header said (`check_blob` of the transport), and the picture is
/// within the pixel budget of an export (the redaction cap is lower, and the reply cap of that request enforces it).
fn raster(reply: WireReply, blob: Blob) -> Option<RasterPage> {
    let WireReply::Raster {
        width,
        height,
        gray,
    } = reply
    else {
        return None;
    };
    if width == 0 || height == 0 || u64::from(width) * u64::from(height) > limits::MAX_EXPORT_PIXELS
    {
        return None;
    }
    let pixels = blob.into_vec();
    Some(RasterPage {
        pixels: if gray {
            RasterPixels::Gray8(pixels)
        } else {
            RasterPixels::Rgb8(pixels)
        },
        width,
        height,
    })
}

/// A page the child appended, with its size made usable (`limits::sanitize_page_size`) and its annotations within the budget.
fn sanitize_appended(page: &mut Appended) {
    page.size = limits::sanitize_page_size(page.size[0], page.size[1]);
    if let Some(found) = &mut page.annotations {
        found.truncate(limits::MAX_IMPORT_PER_PAGE);
    }
}

/// The nodes of an outline are within the cap the reader holds itself to.
fn outline_ok(items: &[OutlineItem]) -> bool {
    fn count(items: &[OutlineItem], depth: usize, nodes: &mut usize) -> bool {
        if depth > limits::MAX_OUTLINE_DEPTH {
            return false;
        }
        for item in items {
            *nodes += 1;
            if *nodes > limits::MAX_OUTLINE_NODES || !count(&item.children, depth + 1, nodes) {
                return false;
            }
        }
        true
    }
    count(items, 1, &mut 0)
}

/// What a loaded document says, after the checks: the count within the limits, one size, rotation and box per page. Sizes are made
/// usable. `None` for a document that contradicts itself.
struct Checked {
    sizes: Vec<[f32; 2]>,
}

fn check_loaded(loaded: &WireLoaded) -> Option<Checked> {
    let pages = usize::try_from(loaded.pages).ok()?;
    limits::validate_page_count(loaded.pages).ok()?;
    if loaded.sizes.len() != pages || loaded.rotations.len() != pages || loaded.boxes.len() != pages
    {
        return None;
    }
    Some(Checked {
        sizes: loaded
            .sizes
            .iter()
            .map(|size| limits::sanitize_page_size(size[0], size[1]))
            .collect(),
    })
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;

    use super::*;
    use crate::documents::DocFlags;
    use crate::engine::queue::Queue;

    fn doc(n: u32) -> DocumentId {
        serde_json::from_value(serde_json::json!(n)).unwrap()
    }

    fn loaded(pages: u32) -> WireLoaded {
        WireLoaded {
            pages,
            sizes: vec![[612.0, 792.0]; pages as usize],
            rotations: vec![0; pages as usize],
            boxes: vec![None; pages as usize],
            flags: DocFlags::default(),
        }
    }

    #[test]
    fn a_loaded_document_must_agree_with_itself() {
        assert!(check_loaded(&loaded(3)).is_some());
        let mut short = loaded(3);
        short.sizes.pop();
        assert!(check_loaded(&short).is_none());
        let mut many = loaded(1);
        many.pages = limits::MAX_PAGES + 1;
        assert!(check_loaded(&many).is_none());
        let mut nan = loaded(1);
        nan.sizes[0] = [f32::NAN, 5.0];
        assert_eq!(
            check_loaded(&nan).unwrap().sizes[0],
            limits::DEFAULT_PAGE_SIZE_PT
        );
    }

    #[test]
    fn a_raster_must_fit_its_header() {
        let reply = WireReply::Raster {
            width: 2,
            height: 1,
            gray: true,
        };
        let page = raster(reply, Blob::Owned(vec![1, 2])).unwrap();
        assert_eq!(page.pixels, RasterPixels::Gray8(vec![1, 2]));
        let huge = WireReply::Raster {
            width: u32::MAX,
            height: u32::MAX,
            gray: true,
        };
        assert!(raster(huge, Blob::None).is_none());
        assert!(raster(WireReply::Done, Blob::None).is_none());
    }

    /// A scripted engine: answers by a function, can be told to die on a request, and counts its spawns.
    struct Script {
        spawns: Arc<AtomicUsize>,
        log: Arc<Mutex<Vec<String>>>,
    }

    struct Fake {
        number: usize,
        log: Arc<Mutex<Vec<String>>>,
        dead: bool,
        die_on_render: bool,
    }

    impl Transport for Fake {
        fn call(
            &mut self,
            request: WireRequest,
            _blob: Blob,
            _deadline: Instant,
        ) -> Result<(WireReply, Blob), TransportError> {
            if self.dead {
                return Err(TransportError::Died);
            }
            self.log
                .lock()
                .unwrap()
                .push(format!("{}:{}", self.number, name(&request)));
            Ok(match request {
                WireRequest::Open { .. } | WireRequest::Reopen { .. } => {
                    let l = loaded(2);
                    if matches!(request, WireRequest::Open { .. }) {
                        (WireReply::Opened(l), Blob::None)
                    } else {
                        (WireReply::Reopened(l), Blob::None)
                    }
                }
                WireRequest::Render { .. } => {
                    if self.die_on_render {
                        self.dead = true;
                        return Err(TransportError::Died);
                    }
                    (WireReply::Frame, Blob::Owned(vec![9]))
                }
                _ => (WireReply::Done, Blob::None),
            })
        }

        fn kill(&mut self) {
            self.dead = true;
        }
    }

    fn name(request: &WireRequest) -> &'static str {
        match request {
            WireRequest::Open { .. } => "open",
            WireRequest::Reopen { .. } => "reopen",
            WireRequest::Render { .. } => "render",
            WireRequest::SetPageRotations { .. } => "rotations",
            WireRequest::Close { .. } => "close",
            _ => "other",
        }
    }

    fn pump(script: &Script, die_on_render: bool) -> (Pump, Arc<Mutex<Vec<DocumentId>>>) {
        let (spawns, log) = (Arc::clone(&script.spawns), Arc::clone(&script.log));
        let lost = Arc::new(Mutex::new(Vec::new()));
        let lost_sink = Arc::clone(&lost);
        let config = Config {
            spawn: Box::new(move || {
                let number = spawns.fetch_add(1, Ordering::SeqCst) + 1;
                Ok(Box::new(Fake {
                    number,
                    log: Arc::clone(&log),
                    dead: false,
                    // Only the first child is the one that dies.
                    die_on_render: die_on_render && number == 1,
                }) as Box<dyn Transport>)
            }),
            sizes: Arc::new(SizeCache::default()),
            files: Arc::new(FileTable::new()),
            on_restart: Some(Arc::new(move |ids| lost_sink.lock().unwrap().extend(ids))),
        };
        let mut pump = Pump::new(config);
        pump.start();
        (pump, lost)
    }

    fn script() -> Script {
        Script {
            spawns: Arc::new(AtomicUsize::new(0)),
            log: Arc::new(Mutex::new(Vec::new())),
        }
    }

    fn temp_file() -> std::fs::File {
        let path = std::env::temp_dir().join(format!("sheer-pump-{}.bin", std::process::id()));
        std::fs::write(&path, b"%PDF").unwrap();
        std::fs::File::open(path).unwrap()
    }

    fn open(pump: &mut Pump, id: DocumentId) {
        pump.open(
            id,
            Handle::Local(temp_file()),
            None,
            Box::new(|_| true),
            Instant::now() + Duration::from_secs(5),
        )
        .unwrap();
    }

    fn key(id: DocumentId) -> super::super::RenderKey {
        super::super::RenderKey {
            id,
            page_index: 0,
            bucket: 0,
            tile: None,
        }
    }

    #[test]
    fn a_death_restarts_the_engine_replays_the_document_and_reports_it() {
        let script = script();
        let (mut pump, lost) = pump(&script, true);
        let id = doc(1);
        open(&mut pump, id);
        let deadline = Instant::now() + Duration::from_secs(5);
        let requests = Requests::new(Queue::new(4));
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        pump.serve(
            &requests,
            Request {
                deadline,
                job: Job::SetPageRotations {
                    id,
                    items: vec![(0, 90)],
                    reply: tx,
                },
            },
        );
        rx.recv().unwrap().unwrap();
        let error = pump
            .on_doc(
                id,
                WireRequest::Render { key: key(id) },
                Blob::None,
                deadline,
                |_, _| Some(()),
            )
            .unwrap_err();
        assert_eq!(error.code(), ErrorCode::EngineCrashed);
        assert_eq!(script.spawns.load(Ordering::SeqCst), 2);
        // The second child got the document again, then its rotations.
        let log = script.log.lock().unwrap().clone();
        assert_eq!(
            log,
            [
                "1:open",
                "1:rotations",
                "1:render",
                "2:reopen",
                "2:rotations"
            ]
        );
        assert!(lost.lock().unwrap().is_empty());
        // And it serves.
        assert!(pump
            .on_doc(
                id,
                WireRequest::Render { key: key(id) },
                Blob::None,
                deadline,
                |r, _| { matches!(r, WireReply::Frame).then_some(()) }
            )
            .is_ok());
    }

    #[test]
    fn two_deaths_in_a_row_shut_the_document_out() {
        let script = script();
        let (mut pump, lost) = pump(&script, false);
        let id = doc(2);
        open(&mut pump, id);
        let deadline = Instant::now() + Duration::from_secs(5);
        for _ in 0..2 {
            pump.transport_failed(Some(id), TransportError::Died);
        }
        assert!(pump.is_shut(id));
        assert_eq!(*lost.lock().unwrap(), vec![id]);
        let error = pump
            .on_doc(
                id,
                WireRequest::Render { key: key(id) },
                Blob::None,
                deadline,
                |_, _| Some(()),
            )
            .unwrap_err();
        assert_eq!(error.code(), ErrorCode::EngineCrashed);
        // Reopening makes it healthy again, and closing removes it.
        pump.reopen(id, ReopenSource::File(Handle::Local(temp_file())), deadline)
            .unwrap();
        assert!(!pump.is_shut(id));
        pump.close(id, deadline);
        assert!(pump.docs.is_empty());
        assert!(pump.files.is_empty());
    }

    #[test]
    fn the_restart_budget_ends_in_engine_unavailable() {
        let script = script();
        let (mut pump, lost) = pump(&script, false);
        let id = doc(3);
        open(&mut pump, id);
        for _ in 0..limits::ENGINE_RESTART_BUDGET + 1 {
            pump.transport_failed(None, TransportError::Timeout);
        }
        assert!(pump.unavailable);
        assert_eq!(
            pump.ensure().unwrap_err().code(),
            ErrorCode::EngineUnavailable
        );
        assert_eq!(*lost.lock().unwrap(), vec![id]);
    }

    #[test]
    fn a_pump_serves_the_queue_until_it_closes() {
        let script = script();
        let (spawns, log) = (Arc::clone(&script.spawns), Arc::clone(&script.log));
        let queue = Queue::new(8);
        let requests = Requests::new(Arc::clone(&queue));
        let config = Config {
            spawn: Box::new(move || {
                let number = spawns.fetch_add(1, Ordering::SeqCst) + 1;
                Ok(Box::new(Fake {
                    number,
                    log: Arc::clone(&log),
                    dead: false,
                    die_on_render: false,
                }) as Box<dyn Transport>)
            }),
            sizes: Arc::new(SizeCache::default()),
            files: Arc::new(FileTable::new()),
            on_restart: None,
        };
        let thread = std::thread::spawn(move || run(requests, config));
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        let id = doc(4);
        queue
            .push(
                Request {
                    deadline: Instant::now() + Duration::from_secs(5),
                    job: Job::Open {
                        id,
                        file: Handle::Local(temp_file()),
                        password: None,
                        confirm: Box::new(|_| true),
                        reply: tx,
                    },
                },
                crate::engine::Rank::CONTROL,
            )
            .unwrap();
        assert_eq!(rx.recv().unwrap().unwrap(), 2);
        queue.close();
        thread.join().unwrap();
    }
}
