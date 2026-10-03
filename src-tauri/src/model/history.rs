//! The undo and redo stacks of one document (ADR-003 §7).
//!
//! An entry holds the command that undoes (or redoes) one step: the exact inverse that `DocCommand::apply` returned. Undoing applies
//! it, which returns the inverse of the inverse, and that is what goes on the other stack; no step is ever re-derived from its
//! forward command, so ids and snapshots come back exactly. Every entry has a serial number that travels with it between the stacks;
//! the *clean marker* is the serial of the top of the undo stack at the last save, so the document is dirty exactly when the top is
//! another one.

use std::collections::VecDeque;

use serde::Serialize;

use super::command::DocCommand;
use super::ids::AnnotId;
use crate::limits;

/// What the UI needs to draw its Undo and Redo commands.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryState {
    pub can_undo: bool,
    pub can_redo: bool,
    /// The label (a key of the UI catalogs) of the step Undo would take back.
    pub undo_label: Option<String>,
    pub redo_label: Option<String>,
    /// There are changes that are not saved.
    pub dirty: bool,
}

/// One step of the history.
#[derive(Debug, Clone)]
pub(crate) struct HistoryEntry {
    pub label: String,
    /// The command that takes the step back (on the undo stack) or does it again (on the redo stack).
    pub command: DocCommand,
    coalesce: Option<(AnnotId, String)>,
    last_ms: u64,
    serial: u64,
    /// What the step holds, estimated (see [`command_bytes`]).
    bytes: usize,
}

/// A `Write` that only counts.
struct Counter(usize);

impl std::io::Write for Counter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0 = self.0.saturating_add(buf.len());
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// A fixed cost for what a step is besides the annotations in it.
const STEP_OVERHEAD_BYTES: usize = 128;

/// The bytes a step holds, estimated as the length of the annotations in its slots as JSON.
fn command_bytes(command: &DocCommand) -> usize {
    match command {
        DocCommand::Restore { slots } => {
            slots.iter().fold(STEP_OVERHEAD_BYTES, |total, (_, slot)| {
                let mut counter = Counter(STEP_OVERHEAD_BYTES);
                if let Some(entry) = slot {
                    // A failure to serialize cannot happen for these types; the count so far is then the estimate.
                    let _ = serde_json::to_writer(&mut counter, &entry.annotation);
                }
                total.saturating_add(counter.0)
            })
        }
        DocCommand::RestorePages {
            slots, annotations, ..
        } => annotations.iter().fold(
            STEP_OVERHEAD_BYTES + slots.len().saturating_mul(64),
            |total, (_, slot)| {
                let mut counter = Counter(0);
                if let Some(entry) = slot {
                    let _ = serde_json::to_writer(&mut counter, &entry.annotation);
                }
                total.saturating_add(counter.0.saturating_add(STEP_OVERHEAD_BYTES))
            },
        ),
        // The raster pages a redaction holds (megabytes each) and the annotations it took away.
        DocCommand::RestoreRedaction { slots, entries, .. } => {
            let pages = slots.iter().fold(STEP_OVERHEAD_BYTES, |total, slot| {
                let raster = match &slot.source {
                    crate::model::page::PageSource::Redacted { bytes } => bytes.len(),
                    _ => 0,
                };
                total.saturating_add(raster)
            });
            entries.iter().fold(pages, |total, (_, slot)| {
                let mut counter = Counter(0);
                if let Some(entry) = slot {
                    let _ = serde_json::to_writer(&mut counter, &entry.annotation);
                }
                total.saturating_add(counter.0.saturating_add(STEP_OVERHEAD_BYTES))
            })
        }
        DocCommand::ReorderPages { order } => {
            STEP_OVERHEAD_BYTES.saturating_add(order.len().saturating_mul(4))
        }
        DocCommand::Batch { commands, .. } => {
            commands.iter().fold(STEP_OVERHEAD_BYTES, |total, inner| {
                total.saturating_add(command_bytes(inner))
            })
        }
        _ => STEP_OVERHEAD_BYTES,
    }
}

#[derive(Debug)]
pub(crate) struct History {
    undo: VecDeque<HistoryEntry>,
    redo: Vec<HistoryEntry>,
    next_serial: u64,
    /// The serial of the top of the undo stack when the document was last clean (0: nothing on it); `None` once that state cannot be
    /// reached any more (its entry fell off the end of the stack).
    clean: Option<u64>,
}

impl History {
    pub fn new() -> Self {
        Self {
            undo: VecDeque::new(),
            redo: Vec::new(),
            next_serial: 1,
            clean: Some(0),
        }
    }

    fn top_serial(&self) -> u64 {
        self.undo.back().map_or(0, |entry| entry.serial)
    }

    pub fn state(&self) -> HistoryState {
        HistoryState {
            can_undo: !self.undo.is_empty(),
            can_redo: !self.redo.is_empty(),
            undo_label: self.undo.back().map(|entry| entry.label.clone()),
            redo_label: self.redo.last().map(|entry| entry.label.clone()),
            dirty: self.clean != Some(self.top_serial()),
        }
    }

    /// Records a new step with the command `inverse` that takes it back, and drops the redo stack. An update with the same
    /// `coalesce` key on the same annotation as the step on top, within `COALESCE_WINDOW_MS` of it, extends that step instead:
    /// `inverse` is dropped, as the older step already restores the state from before the first update.
    pub fn record(
        &mut self,
        label: String,
        inverse: DocCommand,
        coalesce: Option<(AnnotId, String)>,
        now_ms: u64,
    ) {
        self.redo.clear();
        let serial = self.next_serial;
        self.next_serial += 1;
        if let (Some(key), Some(top)) = (&coalesce, self.undo.back_mut()) {
            if top.coalesce.as_ref() == Some(key)
                && now_ms.saturating_sub(top.last_ms) <= limits::COALESCE_WINDOW_MS
            {
                top.last_ms = now_ms;
                top.serial = serial;
                return;
            }
        }
        let bytes = command_bytes(&inverse);
        self.undo.push_back(HistoryEntry {
            label,
            command: inverse,
            coalesce,
            last_ms: now_ms,
            serial,
            bytes,
        });
        self.trim(limits::MAX_HISTORY_ENTRIES, limits::MAX_HISTORY_BYTES);
    }

    /// Drops the oldest steps while there are more than `max_entries` or they hold more than `max_bytes` (the newest stays).
    fn trim(&mut self, max_entries: usize, max_bytes: usize) {
        let mut bytes: usize = self.undo.iter().map(|entry| entry.bytes).sum();
        while self.undo.len() > max_entries || (bytes > max_bytes && self.undo.len() > 1) {
            let Some(dropped) = self.undo.pop_front() else {
                break;
            };
            bytes = bytes.saturating_sub(dropped.bytes);
            if self.clean.is_some_and(|clean| clean <= dropped.serial) {
                self.clean = None;
            }
        }
    }

    pub fn pop_undo(&mut self) -> Option<HistoryEntry> {
        self.undo.pop_back()
    }

    pub fn pop_redo(&mut self) -> Option<HistoryEntry> {
        self.redo.pop()
    }

    /// Puts a step that was just undone on the redo stack (`command` redoes it).
    pub fn push_redo(&mut self, mut entry: HistoryEntry, command: DocCommand) {
        entry.bytes = command_bytes(&command);
        entry.command = command;
        entry.coalesce = None;
        self.redo.push(entry);
    }

    /// Puts a step that was just redone back on the undo stack (`command` undoes it).
    pub fn push_undo(&mut self, mut entry: HistoryEntry, command: DocCommand) {
        entry.bytes = command_bytes(&command);
        entry.command = command;
        entry.coalesce = None;
        self.undo.push_back(entry);
    }

    /// Puts a popped entry back unchanged (its command failed).
    pub fn restore_undo(&mut self, entry: HistoryEntry) {
        self.undo.push_back(entry);
    }

    pub fn restore_redo(&mut self, entry: HistoryEntry) {
        self.redo.push(entry);
    }

    /// The tickets of the protection steps the stacks hold (the secrets of every other ticket can go).
    pub fn protection_tickets(&self) -> Vec<crate::security::secret::Ticket> {
        self.undo
            .iter()
            .map(|entry| &entry.command)
            .chain(self.redo.iter().map(|entry| &entry.command))
            .filter_map(|command| match command {
                DocCommand::SetProtection { ticket } => Some(*ticket),
                _ => None,
            })
            .collect()
    }

    /// The document is saved: what is on the stacks now is the clean state.
    pub fn mark_clean(&mut self) {
        self.clean = Some(self.top_serial());
    }

    /// Forgets every step. After a save the snapshots in the steps describe annotations as they were before the file had them (their
    /// `sync` and positions in the file), so a step taken back later would put wrong state; the document is clean with nothing on
    /// the stacks.
    pub fn clear(&mut self) {
        self.undo.clear();
        self.redo.clear();
        self.clean = Some(0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn nothing() -> DocCommand {
        DocCommand::Restore { slots: Vec::new() }
    }

    fn key(id: u32, name: &str) -> Option<(AnnotId, String)> {
        Some((AnnotId::new(id), name.to_owned()))
    }

    #[test]
    fn an_empty_history_is_clean_and_has_nothing_to_undo() {
        let history = History::new();
        let state = history.state();
        assert!(!state.can_undo && !state.can_redo && !state.dirty);
        assert_eq!((state.undo_label, state.redo_label), (None, None));
    }

    #[test]
    fn a_step_makes_it_dirty_and_undoing_it_makes_it_clean_again() {
        let mut history = History::new();
        history.record("a".into(), nothing(), None, 0);
        assert!(history.state().dirty);
        assert_eq!(history.state().undo_label.as_deref(), Some("a"));
        let entry = history.pop_undo().unwrap();
        history.push_redo(entry, nothing());
        let state = history.state();
        assert!(!state.dirty && !state.can_undo && state.can_redo);
        assert_eq!(state.redo_label.as_deref(), Some("a"));
        let entry = history.pop_redo().unwrap();
        history.push_undo(entry, nothing());
        assert!(history.state().dirty);
    }

    #[test]
    fn a_new_step_drops_the_redo_stack() {
        let mut history = History::new();
        history.record("a".into(), nothing(), None, 0);
        let entry = history.pop_undo().unwrap();
        history.push_redo(entry, nothing());
        history.record("b".into(), nothing(), None, 0);
        assert!(!history.state().can_redo);
    }

    #[test]
    fn the_clean_marker_follows_the_saved_state_through_undo_and_redo() {
        let mut history = History::new();
        history.record("a".into(), nothing(), None, 0);
        history.record("b".into(), nothing(), None, 0);
        history.mark_clean();
        assert!(!history.state().dirty);
        let entry = history.pop_undo().unwrap();
        history.push_redo(entry, nothing());
        assert!(history.state().dirty, "back at a state before the save");
        let entry = history.pop_redo().unwrap();
        history.push_undo(entry, nothing());
        assert!(!history.state().dirty, "the saved state again");
        // A different step on top of the saved state is dirty, also when undone to the same depth.
        let entry = history.pop_undo().unwrap();
        history.push_redo(entry, nothing());
        history.record("c".into(), nothing(), None, 0);
        assert!(history.state().dirty);
        let entry = history.pop_undo().unwrap();
        history.push_redo(entry, nothing());
        assert!(history.state().dirty, "a is not b");
    }

    #[test]
    fn updates_with_the_same_key_close_together_are_one_step() {
        let mut history = History::new();
        history.record("u".into(), nothing(), key(1, "drag"), 1_000);
        history.record("u".into(), nothing(), key(1, "drag"), 2_000);
        history.record("u".into(), nothing(), key(1, "drag"), 3_400);
        assert_eq!(
            history.undo.len(),
            1,
            "each is within the window of the one before"
        );
        // Too late, another key, another annotation, or no key: new steps.
        history.record(
            "u".into(),
            nothing(),
            key(1, "drag"),
            3_400 + limits::COALESCE_WINDOW_MS + 1,
        );
        history.record(
            "u".into(),
            nothing(),
            key(1, "color"),
            3_400 + limits::COALESCE_WINDOW_MS + 2,
        );
        history.record(
            "u".into(),
            nothing(),
            key(2, "color"),
            3_400 + limits::COALESCE_WINDOW_MS + 3,
        );
        history.record(
            "u".into(),
            nothing(),
            None,
            3_400 + limits::COALESCE_WINDOW_MS + 4,
        );
        assert_eq!(history.undo.len(), 5);
    }

    #[test]
    fn a_merged_step_is_dirty_when_it_was_saved_before_the_merge() {
        let mut history = History::new();
        history.record("u".into(), nothing(), key(1, "drag"), 0);
        history.mark_clean();
        history.record("u".into(), nothing(), key(1, "drag"), 100);
        assert_eq!(history.undo.len(), 1);
        assert!(history.state().dirty);
    }

    #[test]
    fn the_stack_is_bounded_and_a_clean_state_that_fell_off_is_never_clean_again() {
        let mut history = History::new();
        for _ in 0..limits::MAX_HISTORY_ENTRIES + 3 {
            history.record("a".into(), nothing(), None, 0);
        }
        assert_eq!(history.undo.len(), limits::MAX_HISTORY_ENTRIES);
        while let Some(entry) = history.pop_undo() {
            history.push_redo(entry, nothing());
        }
        assert!(
            history.state().dirty,
            "the empty state at open is out of reach"
        );
    }

    #[test]
    fn the_stack_is_bounded_by_bytes_and_the_oldest_steps_go_first() {
        let mut history = History::new();
        for label in ["a", "b", "c"] {
            history.record(label.into(), nothing(), None, 0);
        }
        history.mark_clean();
        history.trim(10, 2 * STEP_OVERHEAD_BYTES + 1);
        assert_eq!(history.undo.len(), 2);
        assert_eq!(history.undo.front().map(|e| e.label.as_str()), Some("b"));
        // The newest step stays however big it is.
        history.trim(10, 1);
        assert_eq!(history.undo.len(), 1);
        assert_eq!(history.state().undo_label.as_deref(), Some("c"));
        assert!(!history.state().dirty, "the clean step is the newest");
    }
}
