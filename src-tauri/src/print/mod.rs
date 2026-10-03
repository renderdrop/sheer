// owned by package D
//! Print through the OS dialog (ADR-049 §4): pre-rendered page frames held in memory, shown by the webview's print-only surface.

pub mod dialog;
pub mod set;

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::WebviewWindow;

use crate::commands::jobs::{EventSink, JobId};
use crate::commands::AppState;
use crate::documents::DocumentId;
use crate::error::AppError;
use crate::model::ranges::PageSelection;

/// Render quality: 150 or 300 dpi.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PrintQuality {
    Standard,
    High,
}

/// The paper orientation landscape pages are turned to when `auto_rotate` is on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PrintOrientation {
    Portrait,
    Landscape,
}

/// What `prepare_print` takes.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrintOptions {
    pub pages: PageSelection,
    pub annotations: bool,
    pub quality: PrintQuality,
    pub auto_rotate: bool,
    pub paper: PrintOrientation,
}

/// Which route opened the print dialog.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PrintRoute {
    /// The OS print dialog.
    System,
    /// The webview's own print preview (still local).
    Webview,
}

/// Renders the pages into a print set and reports it in `done.print`. Stub (package D): `not_yet`.
pub fn prepare(
    _state: &AppState,
    _doc: DocumentId,
    _opts: &PrintOptions,
    _sink: Arc<dyn EventSink>,
) -> Result<JobId, AppError> {
    Err(AppError::not_yet())
}

/// One frame (SHR1, JPEG) of a finished set. Stub (package D): `not_yet`.
pub fn page(_state: &AppState, _print_id: u32, _index: u32) -> Result<Vec<u8>, AppError> {
    Err(AppError::not_yet())
}

/// Opens the print dialog for a complete set. Stub (package D): `not_yet`.
pub fn open_dialog(
    _state: &AppState,
    _window: &WebviewWindow,
    _print_id: u32,
) -> Result<PrintRoute, AppError> {
    Err(AppError::not_yet())
}

/// Drops a set; an unknown id is not an error. Stub (package D): `not_yet`.
pub fn release(_state: &AppState, _print_id: u32) -> Result<(), AppError> {
    Err(AppError::not_yet())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn options_parse_and_the_route_serializes_in_lower_case() {
        let opts: PrintOptions = serde_json::from_str(
            r#"{"pages":{"type":"all"},"annotations":true,"quality":"high","autoRotate":true,"paper":"landscape"}"#,
        )
        .unwrap();
        assert_eq!(opts.quality, PrintQuality::High);
        assert_eq!(opts.paper, PrintOrientation::Landscape);
        assert_eq!(
            serde_json::to_value(PrintRoute::Webview).unwrap(),
            serde_json::json!("webview")
        );
        assert_eq!(
            serde_json::to_value(PrintRoute::System).unwrap(),
            serde_json::json!("system")
        );
    }
}
