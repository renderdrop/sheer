//! The FIFO queue of dialog answers (feature `automation` only). The state is process-global like the print sets: a dialog is
//! answered on a blocking thread that holds no handle to anything else.

use std::collections::VecDeque;
use std::path::Path;
use std::sync::{Mutex, MutexGuard, OnceLock};

use serde::{Deserialize, Serialize};

use crate::error::AppError;

/// More entries than a script ever queues; a runaway client cannot grow the queue without bound.
pub const MAX_QUEUE: usize = 64;
/// More paths than one entry of `openMany` can carry.
pub const MAX_PATHS: usize = 256;

/// The kind of dialog an entry answers. A dialog of another kind finds the entry and fails: the script and the app disagree.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DialogKind {
    Open,
    OpenMany,
    Folder,
    Save,
    Message,
    Print,
}

/// One answer. `paths`: absolute paths (exactly one for open, folder and save; one or more for openMany). `button`: for a message,
/// `"cancel"` declines, anything else (or none) confirms. `cancel`: the user dismisses the dialog.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DialogEntry {
    pub kind: DialogKind,
    #[serde(default)]
    pub paths: Vec<String>,
    #[serde(default)]
    pub button: Option<String>,
    #[serde(default)]
    pub cancel: bool,
}

impl DialogEntry {
    /// Refuses an entry that could never answer its dialog.
    pub fn validate(&self) -> Result<(), AppError> {
        if self.paths.len() > MAX_PATHS {
            return Err(AppError::limit("paths", MAX_PATHS as u64));
        }
        if self.paths.iter().any(|path| !Path::new(path).is_absolute()) {
            return Err(AppError::invalid("paths"));
        }
        if self.cancel {
            return Ok(());
        }
        let wanted = match self.kind {
            DialogKind::Open | DialogKind::Folder | DialogKind::Save => self.paths.len() == 1,
            DialogKind::OpenMany => !self.paths.is_empty(),
            DialogKind::Message | DialogKind::Print => self.paths.is_empty(),
        };
        if wanted {
            Ok(())
        } else {
            Err(AppError::invalid("paths"))
        }
    }

    /// For a message: whether the answer is the confirming button.
    pub fn confirms(&self) -> bool {
        !self.cancel
            && !self
                .button
                .as_deref()
                .is_some_and(|button| button.eq_ignore_ascii_case("cancel"))
    }
}

/// The print set the last print dialog would have printed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LastPrint {
    pub print_id: u32,
    pub pages: usize,
    pub cancelled: bool,
}

/// What dialog failed to find its answer: `expected` is the kind that asked, `found` the kind at the head of the queue (none: empty).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LastError {
    pub expected: DialogKind,
    pub found: Option<DialogKind>,
}

/// The result of `automation_state`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationState {
    pub queue_length: usize,
    pub last_print: Option<LastPrint>,
    pub last_error: Option<LastError>,
}

#[derive(Debug, Default)]
pub struct Queue {
    entries: VecDeque<DialogEntry>,
    last_print: Option<LastPrint>,
    last_error: Option<LastError>,
}

impl Queue {
    pub fn push(&mut self, entry: DialogEntry) -> Result<(), AppError> {
        entry.validate()?;
        if self.entries.len() >= MAX_QUEUE {
            return Err(AppError::limit("dialogQueue", MAX_QUEUE as u64));
        }
        self.entries.push_back(entry);
        Ok(())
    }

    /// The next answer, which must be of `kind`. A mismatch leaves the entry in place and is remembered as the last error.
    pub fn take(&mut self, kind: DialogKind) -> Result<DialogEntry, AppError> {
        let found = self.entries.front().map(|entry| entry.kind);
        if found == Some(kind) {
            if let Some(entry) = self.entries.pop_front() {
                return Ok(entry);
            }
        }
        self.last_error = Some(LastError {
            expected: kind,
            found,
        });
        Err(AppError::automation_no_answer())
    }

    /// A print: the set is recorded and never printed. A `print` entry at the head is consumed (its `cancel` is recorded); without one
    /// the print is recorded all the same, so a script need not queue what changes nothing.
    pub fn record_print(&mut self, print_id: u32, pages: usize) {
        let cancelled = match self.entries.front() {
            Some(entry) if entry.kind == DialogKind::Print => {
                self.entries.pop_front().is_some_and(|entry| entry.cancel)
            }
            _ => false,
        };
        self.last_print = Some(LastPrint {
            print_id,
            pages,
            cancelled,
        });
    }

    pub fn state(&self) -> AutomationState {
        AutomationState {
            queue_length: self.entries.len(),
            last_print: self.last_print,
            last_error: self.last_error,
        }
    }
}

/// The queue of the process, behind a lock; a handle that locks per call.
pub struct Global;

pub fn global() -> Global {
    Global
}

fn lock() -> MutexGuard<'static, Queue> {
    static QUEUE: OnceLock<Mutex<Queue>> = OnceLock::new();
    QUEUE
        .get_or_init(|| Mutex::new(Queue::default()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl Global {
    pub fn push(&self, entry: DialogEntry) -> Result<(), AppError> {
        lock().push(entry)
    }

    pub fn take(&self, kind: DialogKind) -> Result<DialogEntry, AppError> {
        lock().take(kind)
    }

    pub fn record_print(&self, print_id: u32, pages: usize) {
        lock().record_print(print_id, pages);
    }

    pub fn state(&self) -> AutomationState {
        lock().state()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn abs(name: &str) -> String {
        std::env::temp_dir()
            .join(name)
            .to_string_lossy()
            .into_owned()
    }

    fn entry(kind: DialogKind, paths: &[String]) -> DialogEntry {
        DialogEntry {
            kind,
            paths: paths.to_vec(),
            button: None,
            cancel: false,
        }
    }

    #[test]
    fn entries_answer_in_fifo_order_and_only_for_their_kind() {
        let mut queue = Queue::default();
        queue
            .push(entry(DialogKind::Open, &[abs("a.pdf")]))
            .unwrap();
        queue
            .push(entry(DialogKind::Save, &[abs("b.pdf")]))
            .unwrap();
        // The head is `open`: a save dialog does not take it.
        assert!(queue.take(DialogKind::Save).is_err());
        assert_eq!(queue.state().queue_length, 2);
        assert_eq!(queue.take(DialogKind::Open).unwrap().paths, [abs("a.pdf")]);
        assert_eq!(queue.take(DialogKind::Save).unwrap().paths, [abs("b.pdf")]);
        assert_eq!(queue.state().queue_length, 0);
    }

    #[test]
    fn an_empty_queue_and_a_mismatch_are_errors_that_are_remembered() {
        let mut queue = Queue::default();
        assert!(queue.take(DialogKind::Folder).is_err());
        assert_eq!(
            queue.state().last_error,
            Some(LastError {
                expected: DialogKind::Folder,
                found: None
            })
        );
        queue
            .push(entry(DialogKind::Open, &[abs("a.pdf")]))
            .unwrap();
        assert!(queue.take(DialogKind::OpenMany).is_err());
        assert_eq!(
            queue.state().last_error,
            Some(LastError {
                expected: DialogKind::OpenMany,
                found: Some(DialogKind::Open)
            })
        );
    }

    #[test]
    fn the_error_is_internal_with_the_automation_word() {
        let error = Queue::default().take(DialogKind::Open).unwrap_err();
        assert_eq!(error.code(), crate::error::ErrorCode::Internal);
        let ui = serde_json::to_value(crate::error::UiError::from(error)).unwrap();
        assert_eq!(ui["params"]["what"], "automationNoAnswer");
    }

    #[test]
    fn a_cancel_entry_is_taken_like_any_other_and_needs_no_path() {
        let mut queue = Queue::default();
        let mut cancel = entry(DialogKind::Save, &[]);
        cancel.cancel = true;
        queue.push(cancel).unwrap();
        assert!(queue.take(DialogKind::Save).unwrap().cancel);
    }

    #[test]
    fn invalid_entries_are_refused_when_queued() {
        let mut queue = Queue::default();
        assert!(queue.push(entry(DialogKind::Open, &[])).is_err());
        assert!(queue
            .push(entry(DialogKind::Open, &[abs("a.pdf"), abs("b.pdf")]))
            .is_err());
        assert!(queue.push(entry(DialogKind::OpenMany, &[])).is_err());
        assert!(queue
            .push(entry(DialogKind::Open, &["relative.pdf".to_owned()]))
            .is_err());
        assert!(queue.push(entry(DialogKind::Message, &[abs("a")])).is_err());
        assert_eq!(queue.state().queue_length, 0);
        for _ in 0..MAX_QUEUE {
            queue.push(entry(DialogKind::Message, &[])).unwrap();
        }
        assert!(queue.push(entry(DialogKind::Message, &[])).is_err());
    }

    #[test]
    fn a_message_confirms_unless_cancelled_or_declined() {
        let mut message = entry(DialogKind::Message, &[]);
        assert!(message.confirms());
        message.button = Some("Cancel".to_owned());
        assert!(!message.confirms());
        message.button = Some("Open".to_owned());
        assert!(message.confirms());
        message.cancel = true;
        assert!(!message.confirms());
    }

    #[test]
    fn a_print_is_recorded_with_or_without_an_entry() {
        let mut queue = Queue::default();
        queue.record_print(7, 3);
        assert_eq!(
            queue.state().last_print,
            Some(LastPrint {
                print_id: 7,
                pages: 3,
                cancelled: false
            })
        );
        let mut cancel = entry(DialogKind::Print, &[]);
        cancel.cancel = true;
        queue.push(cancel).unwrap();
        queue.record_print(8, 5);
        let state = queue.state();
        assert_eq!(state.queue_length, 0);
        assert_eq!(
            state.last_print.map(|print| (print.pages, print.cancelled)),
            Some((5, true))
        );
        // Another kind at the head stays where it is.
        queue
            .push(entry(DialogKind::Open, &[abs("a.pdf")]))
            .unwrap();
        queue.record_print(9, 1);
        assert_eq!(queue.state().queue_length, 1);
    }

    #[test]
    fn the_wire_shape_is_camel_case() {
        let json = serde_json::json!({"kind": "openMany", "paths": [abs("a.pdf")]});
        let parsed: DialogEntry = serde_json::from_value(json).unwrap();
        assert_eq!(parsed.kind, DialogKind::OpenMany);
        assert!(serde_json::from_str::<DialogEntry>(r#"{"kind":"open","extra":1}"#).is_err());
        let state = serde_json::to_value(Queue::default().state()).unwrap();
        assert_eq!(
            state,
            serde_json::json!({"queueLength":0,"lastPrint":null,"lastError":null})
        );
    }
}
