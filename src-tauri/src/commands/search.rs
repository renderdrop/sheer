//! `search` and `cancel_search`: finding text in a document, page by page, while it is shown (ARCHITECTURE §5, ADR-002 §2, §3).
//!
//! | Command | Arguments | Returns |
//! |---|---|---|
//! | `search` | `docId: number`, `query: { text, matchCase, wholeWord, maxHits }`, `onEvent: Channel<SearchEvent>` | the id of the search, at once; the channel then carries `hits` (per page), `progress` and `done`, see [`SearchEvent`] |
//! | `cancel_search` | `searchId: number` | nothing; an id that is unknown or finished is not an error |
//!
//! **One page at a time.** A search is a loop on a thread of the blocking pool that asks the engine for one page after the other, each
//! as a job of the lowest priority. The engine takes the most urgent job first, so a page that is on screen is drawn before the next
//! page is searched, and a scroll never waits for more than one page of searching. A search that cannot get a page searched because
//! the engine is busy (the queue is full of more urgent jobs, or they went on for the whole deadline) asks again a few times
//! ([`limits::SEARCH_PAGE_ATTEMPTS`]) before it gives up with `failed`.
//!
//! **Cancelled** by `cancel_search`, by a new search of the same document, and by closing the document: a flag that the loop reads
//! between two pages. A cancelled search sends nothing more. A page that is being searched when the flag is set is finished (PDFium
//! cannot be interrupted); its hits are not sent.
//!
//! **Bounds.** The text is 1 to 512 characters, `maxHits` 1 to 50 000 (`invalid_argument` or `limit_exceeded`, `query` or `hits`); at
//! most `limits::MAX_ACTIVE_SEARCHES` searches run at once (`limit_exceeded`, `searches`); a search sends at most `maxHits` hits.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::thread;
use std::time::Instant;

use tauri::ipc::Channel;
use tauri::State;

use super::{blocking, AppState};
use crate::documents::{DocumentId, Registry};
use crate::engine::{Engine, SearchSpec};
use crate::error::{AppError, ErrorCode, UiError};
use crate::limits;
use crate::model::geometry::Quad;
use crate::model::reading::{SearchEvent, SearchQuery};

/// The searches that run, by id. Managed through [`AppState`].
#[derive(Debug, Default)]
pub struct SearchRegistry {
    state: Mutex<SearchState>,
}

#[derive(Debug, Default)]
struct SearchState {
    /// The next id: ids are not reused in a session.
    next_id: u32,
    active: HashMap<u32, Active>,
}

#[derive(Debug)]
struct Active {
    document: DocumentId,
    cancel: Arc<AtomicBool>,
}

/// A search that is running: its id, and the flag that says it was cancelled. Dropping it ends the search's place in the registry.
#[derive(Debug)]
pub struct SearchTicket {
    id: u32,
    cancel: Arc<AtomicBool>,
    registry: Arc<SearchRegistry>,
}

impl SearchTicket {
    pub fn id(&self) -> u32 {
        self.id
    }

    /// Whether the search was cancelled, and so must not do any more work or send any more messages.
    pub fn is_cancelled(&self) -> bool {
        self.cancel.load(Ordering::SeqCst)
    }
}

impl Drop for SearchTicket {
    fn drop(&mut self) {
        self.registry.lock().active.remove(&self.id);
    }
}

impl SearchRegistry {
    fn lock(&self) -> MutexGuard<'_, SearchState> {
        // A poisoned lock only means a holder panicked; the map and the counter stay consistent.
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Starts a search of `document`: the document's earlier search is cancelled (one search per document at a time), and the new
    /// one gets the next id. `limit_exceeded` (`searches`) while `limits::MAX_ACTIVE_SEARCHES` are running, which cancelled searches
    /// that have not noticed yet are among.
    pub fn begin(self: &Arc<Self>, document: DocumentId) -> Result<SearchTicket, AppError> {
        let mut state = self.lock();
        for active in state.active.values().filter(|a| a.document == document) {
            active.cancel.store(true, Ordering::SeqCst);
        }
        if state.active.len() >= limits::MAX_ACTIVE_SEARCHES {
            return Err(AppError::limit(
                "searches",
                limits::MAX_ACTIVE_SEARCHES as u64,
            ));
        }
        let id = state.next_id;
        state.next_id = id
            .checked_add(1)
            .ok_or_else(|| AppError::new(ErrorCode::Internal))?;
        let cancel = Arc::new(AtomicBool::new(false));
        state.active.insert(
            id,
            Active {
                document,
                cancel: Arc::clone(&cancel),
            },
        );
        Ok(SearchTicket {
            id,
            cancel,
            registry: Arc::clone(self),
        })
    }

    /// Cancels search `id`. An id that is unknown or whose search is over is nothing to cancel.
    pub fn cancel(&self, id: u32) {
        if let Some(active) = self.lock().active.get(&id) {
            active.cancel.store(true, Ordering::SeqCst);
        }
    }

    /// Cancels the search of `document`, if there is one (the document is being closed).
    pub fn cancel_document(&self, document: DocumentId) {
        for active in self
            .lock()
            .active
            .values()
            .filter(|a| a.document == document)
        {
            active.cancel.store(true, Ordering::SeqCst);
        }
    }

    /// How many searches have not ended.
    pub fn running(&self) -> usize {
        self.lock().active.len()
    }
}

/// How a page that could not be searched is dealt with.
enum PageFailure {
    /// The page is damaged or odd; the search goes on with the next one.
    Skip,
    /// The document is gone, or the search was cancelled: nothing more to do, and nothing to tell.
    Stop,
    /// The engine cannot do it: the search ends and the UI is told.
    Fail(AppError),
}

/// One search: what it looks for, in which document, and what it may find.
pub(super) struct SearchRun<'a> {
    pub engine: &'a Engine,
    pub registry: &'a Registry,
    pub id: DocumentId,
    pub spec: &'a Arc<SearchSpec>,
    pub max_hits: u32,
    pub ticket: &'a SearchTicket,
}

impl SearchRun<'_> {
    /// Searches page `index`, asking again if the engine was too busy for it. At most `limit` hits.
    fn page(&self, index: u32, limit: usize) -> Result<Vec<Vec<Quad>>, PageFailure> {
        let mut attempt = 1;
        loop {
            if self.ticket.is_cancelled() {
                return Err(PageFailure::Stop);
            }
            match self
                .engine
                .search_page(self.id, index, Arc::clone(self.spec), limit)
            {
                Ok(hits) => return Ok(hits),
                // Too busy for a job of the lowest priority: a full queue, or more urgent work for the whole deadline.
                Err(error)
                    if matches!(
                        error.code(),
                        ErrorCode::EngineTimeout | ErrorCode::Cancelled
                    ) && attempt < limits::SEARCH_PAGE_ATTEMPTS =>
                {
                    attempt += 1;
                    thread::sleep(limits::SEARCH_RETRY_PAUSE);
                }
                Err(error) => {
                    return Err(match error.code() {
                        ErrorCode::NotFound => PageFailure::Stop,
                        ErrorCode::DamagedFile
                        | ErrorCode::InvalidArgument
                        | ErrorCode::Internal => {
                            error.log();
                            PageFailure::Skip
                        }
                        _ => PageFailure::Fail(error),
                    })
                }
            }
        }
    }

    /// The loop: every page of the document in order, until the search is over, cancelled or has found `max_hits`. `send` hands a
    /// message to the UI and says whether it could be sent (it cannot once the webview is gone, which ends the search).
    pub fn run(&self, mut send: impl FnMut(SearchEvent) -> bool) {
        let mut sent_hits = 0u32;
        let mut last_progress: Option<Instant> = None;
        // The order the pages have now (a snapshot: a page moved or deleted meanwhile does not change this search).
        let Ok(order) = self.registry.page_order(self.id) else {
            return;
        };
        let total = u32::try_from(order.len()).unwrap_or(u32::MAX);
        for (position, (page_id, index)) in order.into_iter().enumerate() {
            if self.ticket.is_cancelled() {
                return;
            }
            // One more than may still be sent: whether it is there tells that the search stopped with more to find.
            let remaining = (self.max_hits - sent_hits) as usize;
            let hits = match self.page(index, remaining + 1) {
                Ok(hits) => hits,
                Err(PageFailure::Skip) => Vec::new(),
                Err(PageFailure::Stop) => return,
                Err(PageFailure::Fail(error)) => {
                    if !self.ticket.is_cancelled() {
                        send(SearchEvent::Failed {
                            error: UiError::from(error),
                        });
                    }
                    return;
                }
            };
            // A page that was being searched when the search was cancelled is finished, and its hits are not sent.
            if self.ticket.is_cancelled() {
                return;
            }
            let truncated = hits.len() > remaining;
            let hits: Vec<_> = hits.into_iter().take(remaining).collect();
            if !hits.is_empty() {
                sent_hits += hits.len() as u32;
                if !send(SearchEvent::Hits { page_id, hits }) {
                    return;
                }
            }
            // The hits were sent, and the user may have cancelled in the meantime: nothing more is sent then.
            if self.ticket.is_cancelled() {
                return;
            }
            let done = u32::try_from(position)
                .unwrap_or(u32::MAX)
                .saturating_add(1);
            let progress_due = done == total
                || last_progress.is_none_or(|at| at.elapsed() >= limits::SEARCH_PROGRESS_INTERVAL);
            if truncated || progress_due {
                last_progress = Some(Instant::now());
                if !send(SearchEvent::Progress { done, total }) {
                    return;
                }
            }
            if truncated {
                send(SearchEvent::Done { truncated: true });
                return;
            }
        }
        if !self.ticket.is_cancelled() {
            send(SearchEvent::Done { truncated: false });
        }
    }
}

impl AppState {
    /// Validates the query and starts searching `doc_id`: the document's earlier search is cancelled, and a thread of the blocking
    /// pool takes the new one page by page, handing each message to `send` (see [`run_search`]). Returns the id of the search at once.
    pub fn start_search(
        &self,
        doc_id: DocumentId,
        query: SearchQuery,
        send: impl FnMut(SearchEvent) -> bool + Send + 'static,
    ) -> Result<u32, AppError> {
        limits::validate_search_text(&query.text)?;
        let max_hits = limits::validate_search_hits(query.max_hits)?;
        self.registry.page_count(doc_id)?;
        let ticket = self.searches.begin(doc_id)?;
        let id = ticket.id();
        let spec = Arc::new(SearchSpec {
            text: query.text,
            match_case: query.match_case,
            whole_word: query.whole_word,
        });
        let (engine, registry) = (self.engine.clone(), Arc::clone(&self.registry));
        // Fire and forget: the search ends itself (over, cancelled, or the webview gone), and its ticket with it.
        drop(tauri::async_runtime::spawn_blocking(move || {
            SearchRun {
                engine: &engine,
                registry: &registry,
                id: doc_id,
                spec: &spec,
                max_hits,
                ticket: &ticket,
            }
            .run(send);
        }));
        Ok(id)
    }

    /// Cancels search `search_id`; one that does not exist or has ended is nothing to cancel.
    pub fn cancel_search(&self, search_id: u32) {
        self.searches.cancel(search_id);
    }
}

/// Starts a search of a document and returns its id; the hits, the progress and the end arrive on `on_event` (see [`SearchEvent`]).
#[tauri::command]
pub async fn search(
    state: State<'_, AppState>,
    doc_id: DocumentId,
    query: SearchQuery,
    on_event: Channel<SearchEvent>,
) -> Result<u32, UiError> {
    let state = state.inner().clone();
    blocking(move || state.start_search(doc_id, query, move |event| on_event.send(event).is_ok()))
        .await
}

/// Stops a search. The UI does it when it starts another or its panel is closed; a search that is over is not an error.
#[tauri::command]
pub async fn cancel_search(state: State<'_, AppState>, search_id: u32) -> Result<(), UiError> {
    state.cancel_search(search_id);
    Ok(())
}
#[cfg(test)]
mod tests {
    use std::sync::mpsc;
    use std::time::Duration;

    use super::*;
    use crate::commands::testutil::state_with_pages;
    use crate::documents::PageId;
    use crate::engine::Job;
    use crate::model::geometry::Point;

    type Answer = Result<Vec<Vec<Quad>>, AppError>;
    /// What the engine double says to a search of one page: given the page and the limit it was asked with.
    type Script = Box<dyn FnMut(u32, usize) -> Answer + Send>;

    fn quad() -> Quad {
        let at = |x, y| Point { x, y };
        [at(1.0, 2.0), at(3.0, 2.0), at(1.0, 4.0), at(3.0, 4.0)]
    }

    /// `count` hits, each of one quad.
    fn hits(count: usize) -> Vec<Vec<Quad>> {
        (0..count).map(|_| vec![quad()]).collect()
    }

    /// A state whose engine answers each search of a page with what `script` says.
    fn state_with_script(pages: u32, mut script: Script) -> (AppState, DocumentId) {
        state_with_pages(pages, move |job| match job {
            Job::SearchPage {
                page_index,
                limit,
                reply,
                ..
            } => {
                let _ = reply.send(script(page_index, limit));
            }
            Job::Close { reply, .. } => {
                let _ = reply.send(Ok(()));
            }
            _ => {}
        })
    }

    /// A script that has `per_page` hits on every page (as many as the limit allows), and writes down what it was asked.
    fn script_of(per_page: Vec<usize>, asked: Arc<Mutex<Vec<(u32, usize)>>>) -> Script {
        Box::new(move |page, limit| {
            asked.lock().unwrap().push((page, limit));
            Ok(hits(per_page[page as usize].min(limit)))
        })
    }

    fn spec() -> Arc<SearchSpec> {
        Arc::new(SearchSpec {
            text: "needle".to_owned(),
            match_case: false,
            whole_word: false,
        })
    }

    /// Runs a search of the whole document and returns what it sent. `on_event` sees each message first and says whether the
    /// receiver is still there.
    fn run(
        state: &AppState,
        id: DocumentId,
        _pages: u32,
        max_hits: u32,
        mut on_event: impl FnMut(&SearchTicket, &SearchEvent) -> bool,
    ) -> Vec<SearchEvent> {
        let ticket = state.searches.begin(id).unwrap();
        let spec = spec();
        let mut events = Vec::new();
        SearchRun {
            engine: &state.engine,
            registry: &state.registry,
            id,
            spec: &spec,
            max_hits,
            ticket: &ticket,
        }
        .run(|event| {
            let keep_going = on_event(&ticket, &event);
            events.push(event);
            keep_going
        });
        events
    }

    fn hit_counts(events: &[SearchEvent]) -> Vec<(u32, usize)> {
        events
            .iter()
            .filter_map(|event| match event {
                SearchEvent::Hits { page_id, hits } => Some((
                    serde_json::to_value(page_id).unwrap().as_u64().unwrap() as u32,
                    hits.len(),
                )),
                _ => None,
            })
            .collect()
    }

    // --- the loop ---

    #[test]
    fn hits_arrive_page_by_page_in_order_and_the_search_ends_with_done() {
        let asked = Arc::default();
        let (state, id) = state_with_script(3, script_of(vec![2, 0, 1], Arc::clone(&asked)));
        let events = run(&state, id, 3, 100, |_, _| true);

        assert_eq!(hit_counts(&events), [(0, 2), (2, 1)]);
        // Progress is not sent after every page, but the end is: the last two messages are the full progress and `done`.
        assert_eq!(
            events[events.len() - 2..],
            [
                SearchEvent::Progress { done: 3, total: 3 },
                SearchEvent::Done { truncated: false }
            ]
        );
        let progress: Vec<u32> = events
            .iter()
            .filter_map(|event| match event {
                SearchEvent::Progress { done, .. } => Some(*done),
                _ => None,
            })
            .collect();
        assert!(
            progress.windows(2).all(|pair| pair[0] < pair[1]),
            "{progress:?}"
        );
        // Every page was asked for, once, in order.
        let pages: Vec<u32> = asked
            .lock()
            .unwrap()
            .iter()
            .map(|(page, _)| *page)
            .collect();
        assert_eq!(pages, [0, 1, 2]);
        assert_eq!(
            state.searches.running(),
            0,
            "the ticket is gone with the search"
        );
    }

    #[test]
    fn a_search_that_reaches_max_hits_stops_there_and_says_truncated() {
        let asked = Arc::default();
        let (state, id) = state_with_script(3, script_of(vec![2, 2, 2], Arc::clone(&asked)));
        let events = run(&state, id, 3, 3, |_, _| true);

        // Two on the first page, the third on the second; the rest of the second page and the third page are not wanted.
        assert_eq!(hit_counts(&events), [(0, 2), (1, 1)]);
        assert_eq!(events.last(), Some(&SearchEvent::Done { truncated: true }));
        // The engine is asked for one more than may still be sent, which is how a further hit is known to exist.
        assert_eq!(*asked.lock().unwrap(), [(0, 4), (1, 2)]);
    }

    #[test]
    fn exactly_max_hits_in_the_document_is_not_truncated() {
        let asked = Arc::default();
        let (state, id) = state_with_script(2, script_of(vec![2, 2], Arc::clone(&asked)));
        let events = run(&state, id, 2, 4, |_, _| true);
        assert_eq!(hit_counts(&events), [(0, 2), (1, 2)]);
        assert_eq!(events.last(), Some(&SearchEvent::Done { truncated: false }));
        assert_eq!(*asked.lock().unwrap(), [(0, 5), (1, 3)]);
    }

    #[test]
    fn a_cancelled_search_sends_nothing_more() {
        let asked = Arc::default();
        let (state, id) = state_with_script(5, script_of(vec![1; 5], Arc::clone(&asked)));
        let events = run(&state, id, 5, 100, |ticket, event| {
            if matches!(event, SearchEvent::Hits { .. }) {
                state.cancel_search(ticket.id());
            }
            true
        });
        // The hit that was being sent is the last message: no progress, no `done`, no further page.
        assert_eq!(hit_counts(&events), [(0, 1)]);
        assert_eq!(events.len(), 1);
        assert_eq!(asked.lock().unwrap().len(), 1);
    }

    #[test]
    fn a_page_that_finishes_after_the_cancel_is_not_sent() {
        let asked: Arc<Mutex<Vec<(u32, usize)>>> = Arc::default();
        let log = Arc::clone(&asked);
        let (state, id) = state_with_script(
            3,
            Box::new(move |page, _| {
                log.lock().unwrap().push((page, 0));
                Ok(hits(1))
            }),
        );
        let ticket = state.searches.begin(id).unwrap();
        // Cancelled before the first page comes back.
        state.cancel_search(ticket.id());
        let spec = spec();
        let mut events = Vec::new();
        SearchRun {
            engine: &state.engine,
            registry: &state.registry,
            id,
            spec: &spec,
            max_hits: 10,
            ticket: &ticket,
        }
        .run(|event| {
            events.push(event);
            true
        });
        assert!(events.is_empty());
        assert!(
            asked.lock().unwrap().is_empty(),
            "no page is searched for a cancelled search"
        );
    }

    #[test]
    fn a_new_search_of_a_document_cancels_the_one_before_it_and_leaves_other_documents_alone() {
        let registry = Arc::new(SearchRegistry::default());
        let (first, second): (DocumentId, DocumentId) = (
            serde_json::from_str("1").unwrap(),
            serde_json::from_str("2").unwrap(),
        );
        let old = registry.begin(first).unwrap();
        let other = registry.begin(second).unwrap();
        let new = registry.begin(first).unwrap();
        assert!(old.is_cancelled());
        assert!(!other.is_cancelled());
        assert!(!new.is_cancelled());
        assert_ne!(old.id(), new.id(), "ids are not reused");

        registry.cancel_document(second);
        assert!(other.is_cancelled());
        assert!(!new.is_cancelled());
        // Cancelling what is unknown, or over, is nothing.
        registry.cancel(9_999);
        let finished = new.id();
        drop(new);
        registry.cancel(finished);
        assert_eq!(
            registry.running(),
            2,
            "the two that were cancelled have not dropped their tickets"
        );
    }

    #[test]
    fn closing_a_document_cancels_its_search() {
        let (state, id) = state_with_script(1, script_of(vec![0], Arc::default()));
        let ticket = state.searches.begin(id).unwrap();
        state.close_document(id).unwrap();
        assert!(ticket.is_cancelled());
    }

    #[test]
    fn a_damaged_page_is_skipped_and_the_search_goes_on() {
        let (state, id) = state_with_script(
            3,
            Box::new(|page, _| match page {
                1 => Err(AppError::new(ErrorCode::DamagedFile)),
                _ => Ok(hits(1)),
            }),
        );
        let events = run(&state, id, 3, 100, |_, _| true);
        assert_eq!(hit_counts(&events), [(0, 1), (2, 1)]);
        assert_eq!(events.last(), Some(&SearchEvent::Done { truncated: false }));
    }

    #[test]
    fn an_engine_that_cannot_search_ends_the_search_with_failed_and_no_done() {
        let (state, id) = state_with_script(
            3,
            Box::new(|page, _| match page {
                1 => Err(AppError::new(ErrorCode::EngineCrashed)),
                _ => Ok(hits(1)),
            }),
        );
        let events = run(&state, id, 3, 100, |_, _| true);
        assert_eq!(hit_counts(&events), [(0, 1)]);
        let Some(SearchEvent::Failed { error }) = events.last() else {
            panic!("expected failed, got {events:?}");
        };
        assert_eq!(error.code(), ErrorCode::EngineCrashed);
        assert!(!events
            .iter()
            .any(|event| matches!(event, SearchEvent::Done { .. })));
    }

    #[test]
    fn a_document_that_was_closed_ends_the_search_without_a_word() {
        let (state, id) = state_with_script(
            3,
            Box::new(|page, _| match page {
                1 => Err(AppError::not_found("document")),
                _ => Ok(hits(1)),
            }),
        );
        let events = run(&state, id, 3, 100, |_, _| true);
        assert_eq!(hit_counts(&events), [(0, 1)]);
        assert!(!events
            .iter()
            .any(|event| matches!(event, SearchEvent::Failed { .. } | SearchEvent::Done { .. })));
    }

    #[test]
    fn an_engine_that_is_too_busy_is_asked_again_before_the_search_gives_up() {
        let tries = Arc::new(Mutex::new(0u32));
        let counted = Arc::clone(&tries);
        let (state, id) = state_with_script(
            1,
            Box::new(move |_, _| {
                let mut tries = counted.lock().unwrap();
                *tries += 1;
                if *tries < 3 {
                    Err(AppError::new(if *tries == 1 {
                        ErrorCode::EngineTimeout
                    } else {
                        ErrorCode::Cancelled
                    }))
                } else {
                    Ok(hits(1))
                }
            }),
        );
        let events = run(&state, id, 1, 100, |_, _| true);
        assert_eq!(hit_counts(&events), [(0, 1)]);
        assert_eq!(*tries.lock().unwrap(), 3);
        assert_eq!(events.last(), Some(&SearchEvent::Done { truncated: false }));
    }

    #[test]
    fn an_engine_that_stays_too_busy_ends_the_search_with_a_retryable_failure() {
        let tries = Arc::new(Mutex::new(0u32));
        let counted = Arc::clone(&tries);
        let (state, id) = state_with_script(
            2,
            Box::new(move |_, _| {
                *counted.lock().unwrap() += 1;
                Err(AppError::new(ErrorCode::EngineTimeout))
            }),
        );
        let events = run(&state, id, 2, 100, |_, _| true);
        assert_eq!(*tries.lock().unwrap(), limits::SEARCH_PAGE_ATTEMPTS);
        let Some(SearchEvent::Failed { error }) = events.last() else {
            panic!("expected failed, got {events:?}");
        };
        assert_eq!(error.code(), ErrorCode::EngineTimeout);
    }

    #[test]
    fn a_receiver_that_is_gone_ends_the_search() {
        let asked = Arc::default();
        let (state, id) = state_with_script(5, script_of(vec![1; 5], Arc::clone(&asked)));
        let events = run(&state, id, 5, 100, |_, _| false);
        assert_eq!(events.len(), 1);
        assert_eq!(asked.lock().unwrap().len(), 1);
    }

    // --- starting a search ---

    fn query(text: &str, max_hits: u32) -> SearchQuery {
        SearchQuery {
            text: text.to_owned(),
            match_case: false,
            whole_word: false,
            max_hits,
        }
    }

    /// The `what` and `limit` of the error as the UI gets them.
    fn ui_params(error: AppError) -> (ErrorCode, serde_json::Value) {
        let code = error.code();
        (
            code,
            serde_json::to_value(UiError::from(error)).unwrap()["params"].clone(),
        )
    }

    #[test]
    fn a_query_is_checked_before_anything_is_started() {
        let (state, id) = state_with_script(1, script_of(vec![0], Arc::default()));
        let refuse = |q: SearchQuery| state.start_search(id, q, |_| true).unwrap_err();

        for text in ["", "   ", "\t\r\n", "a\0b", "\0"] {
            let (code, params) = ui_params(refuse(query(text, 10)));
            assert_eq!(code, ErrorCode::InvalidArgument, "{text:?}");
            assert_eq!(params["what"], "query");
        }
        let too_long = "x".repeat(limits::MAX_SEARCH_QUERY_CHARS + 1);
        let (code, params) = ui_params(refuse(query(&too_long, 10)));
        assert_eq!(code, ErrorCode::LimitExceeded);
        assert_eq!(
            (params["what"].as_str(), params["limit"].as_u64()),
            (Some("query"), Some(512))
        );
        // Four-byte characters are counted as characters, not bytes: 512 of them are fine, 513 are not.
        assert!(limits::validate_search_text(&"\u{1f600}".repeat(512)).is_ok());
        assert!(limits::validate_search_text(&"\u{1f600}".repeat(513)).is_err());

        let (code, params) = ui_params(refuse(query("fox", 0)));
        assert_eq!(
            (code, params["what"].as_str()),
            (ErrorCode::InvalidArgument, Some("hits"))
        );
        let (code, params) = ui_params(refuse(query("fox", limits::MAX_SEARCH_HITS + 1)));
        assert_eq!(code, ErrorCode::LimitExceeded);
        assert_eq!(
            (params["what"].as_str(), params["limit"].as_u64()),
            (Some("hits"), Some(50_000))
        );
        let (code, _) = ui_params(refuse(query("fox", u32::MAX)));
        assert_eq!(code, ErrorCode::LimitExceeded);

        let unknown: DocumentId = serde_json::from_str("999").unwrap();
        let error = state
            .start_search(unknown, query("fox", 10), |_| true)
            .unwrap_err();
        assert_eq!(error.code(), ErrorCode::NotFound);

        assert_eq!(
            state.searches.running(),
            0,
            "a refused search is not registered"
        );
    }

    #[test]
    fn the_limits_themselves_are_allowed() {
        assert!(limits::validate_search_text(&"x".repeat(limits::MAX_SEARCH_QUERY_CHARS)).is_ok());
        assert_eq!(limits::validate_search_hits(1).unwrap(), 1);
        assert_eq!(
            limits::validate_search_hits(limits::MAX_SEARCH_HITS).unwrap(),
            50_000
        );
    }

    #[test]
    fn a_search_runs_on_the_blocking_pool_and_reports_through_the_callback() {
        let (state, id) = state_with_script(3, script_of(vec![1, 0, 2], Arc::default()));
        let (sender, receiver) = mpsc::channel();
        let search_id = state
            .start_search(id, query("needle", 100), move |event| {
                sender.send(event).is_ok()
            })
            .unwrap();

        let mut events = Vec::new();
        loop {
            let event = receiver
                .recv_timeout(Duration::from_secs(10))
                .expect("the search ended without a done");
            let done = matches!(event, SearchEvent::Done { .. });
            events.push(event);
            if done {
                break;
            }
        }
        assert_eq!(hit_counts(&events), [(0, 1), (2, 2)]);
        // The ticket is dropped when the task ends, which is just after the last message.
        let until = Instant::now() + Duration::from_secs(5);
        while state.searches.running() > 0 {
            assert!(Instant::now() < until, "the search never ended");
            thread::sleep(Duration::from_millis(5));
        }
        // And its id is not given out again.
        let next = state
            .start_search(id, query("needle", 100), |_| true)
            .unwrap();
        assert!(next > search_id);
    }

    #[test]
    fn at_most_64_searches_run_at_once() {
        let registry = Arc::new(SearchRegistry::default());
        let docs: Vec<DocumentId> = (0..=limits::MAX_ACTIVE_SEARCHES)
            .map(|n| serde_json::from_str(&n.to_string()).unwrap())
            .collect();
        let tickets: Vec<SearchTicket> = docs[..limits::MAX_ACTIVE_SEARCHES]
            .iter()
            .map(|&doc| registry.begin(doc).unwrap())
            .collect();
        let (code, params) = ui_params(
            registry
                .begin(docs[limits::MAX_ACTIVE_SEARCHES])
                .unwrap_err(),
        );
        assert_eq!(code, ErrorCode::LimitExceeded);
        assert_eq!(
            (params["what"].as_str(), params["limit"].as_u64()),
            (Some("searches"), Some(64))
        );
        // A search that ends makes room.
        drop(tickets);
        assert!(registry.begin(docs[0]).is_ok());
    }

    #[test]
    fn a_search_query_has_the_wire_shape_of_the_command_and_a_page_id_is_a_number() {
        // The id of a page in a message is the plain number that the UI passes back to the other commands.
        let message = serde_json::to_value(SearchEvent::Hits {
            page_id: PageId::new(4),
            hits: hits(1),
        })
        .unwrap();
        assert_eq!(message["pageId"], 4);
    }
}
