// owned by package B2
//! Crash-safe autosave (ADR-053 §2, ARCHITECTURE §11.2). W0 seam: the wire types and the lib.rs hook; everything else is B2's.

use serde::Serialize;

/// Whether a document is covered by autosave right now (`DocumentInfo.autosave`, shown in the status bar).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AutosaveStatus {
    /// Dirty and written on schedule.
    On,
    /// Never written: the file is encrypted, or a protection change is pending (a snapshot would be unencrypted).
    OffEncrypted,
    /// Skipped: the snapshot would exceed `limits::AUTOSAVE_DOC_MAX`.
    OffTooLarge,
    /// Nothing to protect: no unsaved changes.
    Clean,
}

/// The hook `run` calls once the app data directory is known: B2 takes the session lock, manages the `Autosave` state and starts the
/// timer task here. A no-op until then.
pub fn start(_app: &tauri::AppHandle) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn statuses_use_the_wire_names_of_architecture() {
        let names: Vec<String> = [
            AutosaveStatus::On,
            AutosaveStatus::OffEncrypted,
            AutosaveStatus::OffTooLarge,
            AutosaveStatus::Clean,
        ]
        .iter()
        .map(|status| serde_json::to_string(status).unwrap())
        .collect();
        assert_eq!(
            names,
            [
                r#""on""#,
                r#""offEncrypted""#,
                r#""offTooLarge""#,
                r#""clean""#
            ]
        );
    }
}
