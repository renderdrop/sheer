// owned by package B3
//! The only network module (ADR-053 §3, ARCHITECTURE §11.3). W0 seam: the wire types and the plugin hook; everything else is B3's.
//!
//! `update::plugin()` is where B3 registers `tauri-plugin-updater`; until then it is an empty plugin of our own, so `run` already
//! has its final shape and nothing here touches the network.

use serde::Serialize;
use tauri::plugin::{Builder, TauriPlugin};
use tauri::Runtime;

use crate::error::ErrorCode;

pub mod state;

/// What the UI is told about an available update. `notes` is plain text, at most `limits::UPDATE_NOTES_MAX` bytes, with control and
/// bidirectional characters removed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,
    pub date: Option<String>,
    pub notes: String,
}

/// Progress of `download_update`, on its channel.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum UpdateEvent {
    Progress {
        downloaded: u64,
        total: Option<u64>,
    },
    /// Downloaded and signature-checked; installing happens on quit.
    Verified,
    /// A bad signature deletes the download (ADR-054 §4).
    Failed {
        code: ErrorCode,
    },
}

/// The plugin `run` registers. Stub: an empty plugin.
pub fn plugin<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("sheer-update").build()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_wire_shapes_match_architecture() {
        let info = UpdateInfo {
            version: "1.0.1".into(),
            date: None,
            notes: "n".into(),
        };
        assert_eq!(
            serde_json::to_value(info).unwrap(),
            json!({ "version": "1.0.1", "date": null, "notes": "n" })
        );
        assert_eq!(
            serde_json::to_value(UpdateEvent::Progress {
                downloaded: 5,
                total: None
            })
            .unwrap(),
            json!({ "kind": "progress", "downloaded": 5, "total": null })
        );
        assert_eq!(
            serde_json::to_value(UpdateEvent::Verified).unwrap(),
            json!({ "kind": "verified" })
        );
        assert_eq!(
            serde_json::to_value(UpdateEvent::Failed {
                code: ErrorCode::DamagedFile
            })
            .unwrap(),
            json!({ "kind": "failed", "code": "damaged_file" })
        );
    }
}
