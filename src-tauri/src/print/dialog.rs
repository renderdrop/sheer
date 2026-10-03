// owned by package D
//! Opens the print dialog of the webview (ADR-049 §4). Windows: `with_webview` and `ICoreWebView2_16::ShowPrintUI(System)`; if the
//! interface is missing, `Webview::print()`. macOS: `Webview::print()`.

use tauri::WebviewWindow;

use super::PrintRoute;
use crate::error::AppError;

/// Opens the dialog and answers the route taken. Stub (package D): `not_yet`.
pub fn open(_window: &WebviewWindow) -> Result<PrintRoute, AppError> {
    Err(AppError::not_yet())
}
