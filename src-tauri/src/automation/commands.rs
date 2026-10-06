//! The two IPC commands of the acceptance build. Compiled and registered only with the feature `automation`; the permissions live in
//! the inline capability of `tauri.acceptance.conf.json`, never in `capabilities/`.

use super::queue::{global, AutomationState, DialogEntry};
use crate::error::UiError;

/// Appends one answer to the dialog queue.
#[tauri::command]
pub fn automation_queue_dialog(entry: DialogEntry) -> Result<(), UiError> {
    global().push(entry).map_err(UiError::from)
}

/// The queue length, the last print set and the last dialog that found no answer.
#[tauri::command]
pub fn automation_state() -> AutomationState {
    global().state()
}
