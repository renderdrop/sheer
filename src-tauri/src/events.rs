//! Pushes from the backend to the UI (ARCHITECTURE §6): what is not the answer to a command the UI sent.
//!
//! The webview has no event permission (SECURITY T3, ADR-013): it can neither listen to events nor emit them. A push reaches
//! it on a `tauri::ipc::Channel` that it handed over itself as the argument of a command (`subscribe_app`), like
//! `watch_transparency` and `subscribe_menu`. The messages are typed [`AppEvent`]s and carry no path: a file dropped on the
//! window or opened by the OS is opened by the backend, and the UI hears of it only as `opened` with the document's id, page
//! count and display name, or as `openFailed` with an error code.
//!
//! The same two shapes (`opened`, `openFailed`) are the elements of the answer of `open_document_dialog`, so the UI has one
//! parser for every way a document can arrive.

use std::collections::VecDeque;
use std::sync::{Mutex, MutexGuard, PoisonError};

use serde::Serialize;
use tauri::ipc::Channel;

use crate::documents::{DocumentId, DocumentInfo};
use crate::error::{AppError, UiError};
use crate::limits;

/// One message to the UI. On the wire an object with a `type` and the fields of that type, in camelCase:
///
/// | `type` | other fields | when |
/// |---|---|---|
/// | `dropHover` | `active: boolean` | a drag with files entered (`true`) or left, was cancelled or ended in a drop (`false`) |
/// | `opened` | `document: { id, pageCount, displayName, flags }` | a document was opened, or an open one was asked for again |
/// | `needsPassword` | `id`, `displayName` | the file is encrypted and needs its user password (ADR-026): it waits under `id` for `unlock_document`, or for `close_document` when the user cancels; never the path |
/// | `closeRequested` | none | the window or the app is asked to close while a document is open: the UI asks about unsaved changes, closes the documents and closes the window itself (ADR-029 §7) |
/// | `imagesDropped` | `batch`, `count`, `skipped`: numbers | PNG or JPEG files were dropped (ADR-049 §3): they wait under `batch` for `images_to_pdf` (or `release_image_batch`); `skipped` counts dropped files that were neither PDF nor image; never a path, and not kept for a UI that is not listening |
/// | `openFailed` | `code`, `key`, `retryable`, `params?` of the error model (ARCHITECTURE §7) | a file could not be opened |
///
/// `openFailed` flattens the error: it is exactly what a rejected command carries, so the UI turns it into the same
/// `AppError` and the same banner text. It names no file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum AppEvent {
    DropHover {
        active: bool,
    },
    Opened {
        document: DocumentInfo,
    },
    NeedsPassword {
        id: DocumentId,
        display_name: String,
    },
    OpenFailed {
        #[serde(flatten)]
        error: UiError,
    },
    CloseRequested,
    ImagesDropped {
        batch: u32,
        count: u32,
        skipped: u32,
    },
}

impl AppEvent {
    /// The outcome of opening one file that worked.
    pub fn opened(document: DocumentInfo) -> Self {
        Self::Opened { document }
    }

    /// The outcome of opening one file that is encrypted: the UI asks for its password.
    pub fn needs_password(id: DocumentId, display_name: String) -> Self {
        Self::NeedsPassword { id, display_name }
    }

    /// The outcome of opening one file that did not. Logs the full error locally (`UiError::from`), the UI gets code and
    /// whitelisted params only.
    pub fn open_failed(error: AppError) -> Self {
        Self::OpenFailed {
            error: UiError::from(error),
        }
    }

    /// A batch of dropped images is waiting under `batch` (ADR-049 §3).
    pub const fn images_dropped(batch: u32, count: u32, skipped: u32) -> Self {
        Self::ImagesDropped {
            batch,
            count,
            skipped,
        }
    }

    /// Whether the UI has to hear of it: an open result is never dropped while nobody listens, a hover is stale at once.
    fn is_open_result(&self) -> bool {
        !matches!(
            self,
            Self::DropHover { .. } | Self::CloseRequested | Self::ImagesDropped { .. }
        )
    }
}

/// The receiver of the pushes, and the open results that came before there was one. Managed state (`Arc<AppEvents>`).
///
/// There is one window, so one receiver: a new one replaces the old. A file the app was started with (file association,
/// command line) is opened while the window is still loading, so its result waits here and is sent, in order, when the UI
/// subscribes: it can neither get lost nor arrive twice.
pub struct AppEvents(Mutex<State>);

#[derive(Default)]
struct State {
    receiver: Option<Channel<AppEvent>>,
    /// `opened` and `openFailed`, oldest first, that nobody could be told about yet.
    pending: VecDeque<AppEvent>,
}

impl AppEvents {
    pub fn new() -> Self {
        Self(Mutex::new(State::default()))
    }

    /// Makes `channel` the receiver, replacing an earlier one, and sends it what is waiting.
    pub fn subscribe(&self, channel: Channel<AppEvent>) {
        let mut state = self.lock();
        let waiting = std::mem::take(&mut state.pending);
        state.receiver = Some(channel);
        for event in waiting {
            state.deliver(event);
        }
    }

    /// Tells the UI. With a receiver it is sent at once (the send only queues a script for the webview and never waits). An
    /// open result that cannot be sent, because there is no receiver yet or the webview behind it is gone, waits for the next
    /// `subscribe`; a hover does not.
    pub fn publish(&self, event: AppEvent) {
        self.lock().deliver(event);
    }

    /// Asks the UI to take care of a close. `true` if a live receiver got it (the caller then holds the close back); `false`
    /// if nobody listens, so a window whose page is gone can still be closed.
    pub fn request_close(&self) -> bool {
        self.lock()
            .receiver
            .as_ref()
            .is_some_and(|channel| channel.send(AppEvent::CloseRequested).is_ok())
    }

    /// How many open results wait for a receiver.
    #[cfg(test)]
    fn waiting(&self) -> usize {
        self.lock().pending.len()
    }

    /// The state is a handle and a queue; a panic elsewhere cannot leave it half-updated, so a poisoned lock is safe to use.
    fn lock(&self) -> MutexGuard<'_, State> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

impl Default for AppEvents {
    fn default() -> Self {
        Self::new()
    }
}

impl State {
    fn deliver(&mut self, event: AppEvent) {
        let sent = self
            .receiver
            .as_ref()
            .is_some_and(|channel| channel.send(event.clone()).is_ok());
        if !sent && event.is_open_result() {
            self.keep(event);
        }
    }

    /// Queues an open result for the next receiver. Every `opened` is kept: each stands for an entry of the registry, and
    /// there are at most `MAX_OPEN_DOCUMENTS` of those. Failures are only banners, so beyond `MAX_PENDING_FAILURES` the new
    /// one is dropped, and a window that never listens cannot make the queue grow.
    fn keep(&mut self, event: AppEvent) {
        let failures = self
            .pending
            .iter()
            .filter(|kept| matches!(kept, AppEvent::OpenFailed { .. }))
            .count();
        if matches!(event, AppEvent::OpenFailed { .. }) && failures >= limits::MAX_PENDING_FAILURES
        {
            return;
        }
        self.pending.push_back(event);
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use tauri::ipc::InvokeResponseBody;

    use super::*;
    use crate::documents::Registry;
    use crate::error::ErrorCode;

    type Log = Arc<Mutex<Vec<String>>>;

    /// A channel that records what is sent over it, as the JSON text the webview would receive.
    fn recording() -> (Channel<AppEvent>, Log) {
        let log = Log::default();
        let sink = Arc::clone(&log);
        let channel = Channel::new(move |body| {
            let text = match body {
                InvokeResponseBody::Json(json) => json,
                InvokeResponseBody::Raw(bytes) => format!("raw:{}", bytes.len()),
            };
            sink.lock().unwrap().push(text);
            Ok(())
        });
        (channel, log)
    }

    fn seen(log: &Log) -> Vec<String> {
        log.lock().unwrap().clone()
    }

    fn json(event: &AppEvent) -> serde_json::Value {
        serde_json::to_value(event).unwrap()
    }

    fn document(name: &str, pages: u32) -> DocumentInfo {
        let registry = Registry::new();
        let id = registry.register(name.into()).unwrap();
        registry.set_page_count(id, pages).unwrap();
        registry.info(id).unwrap()
    }

    fn failed(code: ErrorCode) -> AppEvent {
        AppEvent::open_failed(AppError::new(code))
    }

    // --- the wire shapes ---

    #[test]
    fn a_close_request_is_a_bare_type_and_is_never_kept_for_later() {
        assert_eq!(
            serde_json::to_string(&AppEvent::CloseRequested).unwrap(),
            r#"{"type":"closeRequested"}"#
        );
        let events = AppEvents::new();
        assert!(
            !events.request_close(),
            "nobody listens: the close goes through"
        );
        assert_eq!(events.waiting(), 0);
        let (channel, log) = recording();
        events.subscribe(channel);
        assert!(events.request_close());
        assert_eq!(log.lock().unwrap().len(), 1);
    }

    #[test]
    fn an_images_drop_is_three_numbers_and_is_never_kept_for_later() {
        assert_eq!(
            json(&AppEvent::images_dropped(2, 3, 1)),
            serde_json::json!({"type": "imagesDropped", "batch": 2, "count": 3, "skipped": 1})
        );
        assert!(!AppEvent::images_dropped(1, 1, 0).is_open_result());
    }

    #[test]
    fn a_hover_is_a_type_and_a_flag() {
        assert_eq!(
            serde_json::to_string(&AppEvent::DropHover { active: true }).unwrap(),
            r#"{"type":"dropHover","active":true}"#
        );
        assert_eq!(
            json(&AppEvent::DropHover { active: false }),
            serde_json::json!({ "type": "dropHover", "active": false })
        );
    }

    #[test]
    fn an_opened_document_carries_its_id_page_count_display_name_kind_and_flags_and_nothing_else() {
        let event = AppEvent::opened(document("a.pdf", 3));
        assert_eq!(
            serde_json::to_string(&event).unwrap(),
            r#"{"type":"opened","document":{"id":0,"pageCount":3,"displayName":"a.pdf","kind":"user","flags":{"encrypted":false,"xfa":false,"hasForms":false,"signed":false,"permissions":null}}}"#
        );
    }

    #[test]
    fn a_failed_open_carries_the_error_of_the_error_model_and_no_file() {
        let event = failed(ErrorCode::NotAPdf);
        assert_eq!(
            serde_json::to_string(&event).unwrap(),
            r#"{"type":"openFailed","code":"not_a_pdf","key":"error.not_a_pdf","retryable":false}"#
        );
        let limit = AppEvent::open_failed(AppError::limit("documents", 32));
        assert_eq!(
            json(&limit),
            serde_json::json!({
                "type": "openFailed", "code": "limit_exceeded", "key": "error.limit_exceeded",
                "retryable": false, "params": { "what": "documents", "limit": 32 }
            })
        );
    }

    #[test]
    fn no_event_can_carry_a_path() {
        // The detail of an error is for the log: a path in it never reaches the message.
        let event = AppEvent::open_failed(AppError::logged(
            ErrorCode::IoNotFound,
            r"C:\Users\user\Documents\secret-plan.pdf",
        ));
        let text = serde_json::to_string(&event).unwrap();
        for forbidden in ["secret", "Users", "\\\\", "C:"] {
            assert!(!text.contains(forbidden), "{forbidden} in {text}");
        }
        // The document's name is the last component only, whatever the path was.
        let opened = AppEvent::opened(document("some/dir/secret.pdf", 1));
        let text = serde_json::to_string(&opened).unwrap();
        assert!(text.contains("secret.pdf") && !text.contains("some") && !text.contains("dir"));
    }

    // --- delivery ---

    #[test]
    fn events_go_to_the_receiver_in_order() {
        let events = AppEvents::new();
        let (channel, log) = recording();
        events.subscribe(channel);
        events.publish(AppEvent::DropHover { active: true });
        events.publish(AppEvent::opened(document("a.pdf", 1)));
        events.publish(AppEvent::DropHover { active: false });
        let types: Vec<String> = seen(&log)
            .iter()
            .map(|text| {
                serde_json::from_str::<serde_json::Value>(text).unwrap()["type"]
                    .as_str()
                    .unwrap()
                    .to_owned()
            })
            .collect();
        assert_eq!(types, ["dropHover", "opened", "dropHover"]);
        assert_eq!(events.waiting(), 0);
    }

    #[test]
    fn open_results_from_before_the_ui_listens_wait_and_arrive_once_in_order() {
        let events = AppEvents::new();
        events.publish(AppEvent::opened(document("first.pdf", 1)));
        events.publish(failed(ErrorCode::NotAPdf));
        events.publish(AppEvent::opened(document("second.pdf", 2)));
        assert_eq!(events.waiting(), 3);

        let (channel, log) = recording();
        events.subscribe(channel);
        let messages = seen(&log);
        assert_eq!(messages.len(), 3);
        assert!(messages[0].contains("first.pdf"));
        assert!(messages[1].contains("not_a_pdf"));
        assert!(messages[2].contains("second.pdf"));
        assert_eq!(events.waiting(), 0);

        // Subscribing again does not repeat them.
        let (again, log) = recording();
        events.subscribe(again);
        assert!(seen(&log).is_empty());
    }

    #[test]
    fn a_hover_is_never_kept_for_later() {
        let events = AppEvents::new();
        events.publish(AppEvent::DropHover { active: true });
        assert_eq!(events.waiting(), 0);
        let (channel, log) = recording();
        events.subscribe(channel);
        assert!(seen(&log).is_empty());
    }

    #[test]
    fn a_new_receiver_replaces_the_old_one() {
        let events = AppEvents::new();
        let (first, first_log) = recording();
        let (second, second_log) = recording();
        events.subscribe(first);
        events.subscribe(second);
        events.publish(AppEvent::DropHover { active: true });
        assert!(seen(&first_log).is_empty());
        assert_eq!(seen(&second_log).len(), 1);
    }

    #[test]
    fn a_receiver_that_cannot_be_reached_does_not_lose_open_results() {
        let events = AppEvents::new();
        events.subscribe(Channel::new(|_| Err(tauri::Error::WebviewNotFound)));
        events.publish(AppEvent::DropHover { active: true });
        events.publish(AppEvent::opened(document("a.pdf", 1)));
        // The hover is gone, the opened document waits for the page that comes back.
        assert_eq!(events.waiting(), 1);
        let (channel, log) = recording();
        events.subscribe(channel);
        assert_eq!(seen(&log).len(), 1);
        assert_eq!(events.waiting(), 0);
    }

    #[test]
    fn a_receiver_that_breaks_in_the_middle_of_the_backlog_gets_each_result_once_and_the_next_gets_the_rest(
    ) {
        let events = AppEvents::new();
        for name in ["one.pdf", "two.pdf", "three.pdf"] {
            events.publish(AppEvent::opened(document(name, 1)));
        }
        // The webview takes the first message and then goes away (a reload in the middle of the delivery).
        let taken = Log::default();
        let sink = Arc::clone(&taken);
        let sent = Arc::new(Mutex::new(0));
        events.subscribe(Channel::new(move |body| {
            let mut sent = sent.lock().unwrap();
            *sent += 1;
            if *sent > 1 {
                return Err(tauri::Error::WebviewNotFound);
            }
            if let InvokeResponseBody::Json(json) = body {
                sink.lock().unwrap().push(json);
            }
            Ok(())
        }));
        assert_eq!(seen(&taken).len(), 1);
        assert!(seen(&taken)[0].contains("one.pdf"));
        // What it did not get is still waiting, in order, and the one it got is not.
        assert_eq!(events.waiting(), 2);

        let (channel, log) = recording();
        events.subscribe(channel);
        let messages = seen(&log);
        assert_eq!(messages.len(), 2);
        assert!(messages[0].contains("two.pdf") && messages[1].contains("three.pdf"));
        assert_eq!(events.waiting(), 0);
        let (again, log) = recording();
        events.subscribe(again);
        assert!(seen(&log).is_empty());
    }

    #[test]
    fn results_published_while_the_ui_subscribes_arrive_exactly_once_and_in_order_per_source() {
        const SOURCES: usize = 4;
        const PER_SOURCE: usize = 50;
        let events = Arc::new(AppEvents::new());
        let (channel, log) = recording();
        let publishers: Vec<_> = (0..SOURCES)
            .map(|source| {
                let events = Arc::clone(&events);
                std::thread::spawn(move || {
                    for n in 0..PER_SOURCE {
                        events.publish(AppEvent::opened(document(&format!("{source}-{n}.pdf"), 1)));
                    }
                })
            })
            .collect();
        // Subscribes somewhere in the middle of the publishing.
        std::thread::yield_now();
        events.subscribe(channel);
        for publisher in publishers {
            publisher.join().unwrap();
        }

        let names: Vec<String> = seen(&log)
            .iter()
            .map(|text| {
                let value: serde_json::Value = serde_json::from_str(text).unwrap();
                value["document"]["displayName"]
                    .as_str()
                    .unwrap()
                    .to_owned()
            })
            .collect();
        assert_eq!(names.len(), SOURCES * PER_SOURCE, "one message per result");
        assert_eq!(events.waiting(), 0);
        let distinct: std::collections::HashSet<&String> = names.iter().collect();
        assert_eq!(distinct.len(), names.len(), "a result arrived twice");
        for source in 0..SOURCES {
            let own: Vec<usize> = names
                .iter()
                .filter_map(|name| name.strip_prefix(&format!("{source}-")))
                .map(|rest| rest.trim_end_matches(".pdf").parse().unwrap())
                .collect();
            assert!(
                own.windows(2).all(|pair| pair[0] < pair[1]),
                "source {source} out of order"
            );
        }
    }

    #[test]
    fn a_failure_that_waited_carries_the_same_payload_as_one_that_was_sent_at_once() {
        let events = AppEvents::new();
        events.publish(AppEvent::open_failed(AppError::limit("documents", 32)));
        let (channel, waited) = recording();
        events.subscribe(channel);
        events.publish(AppEvent::open_failed(AppError::limit("documents", 32)));
        let messages = seen(&waited);
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0], messages[1]);
        assert_eq!(
            messages[0],
            r#"{"type":"openFailed","code":"limit_exceeded","key":"error.limit_exceeded","retryable":false,"params":{"what":"documents","limit":32}}"#
        );
    }

    #[test]
    fn failures_that_nobody_hears_are_capped_but_documents_never_are() {
        let events = AppEvents::new();
        for _ in 0..(limits::MAX_PENDING_FAILURES + 20) {
            events.publish(failed(ErrorCode::NotAPdf));
        }
        assert_eq!(events.waiting(), limits::MAX_PENDING_FAILURES);
        // A document still gets its place: dropping it would leave an open document the UI never learns of.
        events.publish(AppEvent::opened(document("a.pdf", 1)));
        assert_eq!(events.waiting(), limits::MAX_PENDING_FAILURES + 1);
        let (channel, log) = recording();
        events.subscribe(channel);
        assert_eq!(seen(&log).len(), limits::MAX_PENDING_FAILURES + 1);
    }
}
