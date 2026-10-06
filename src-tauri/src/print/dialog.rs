//! Opens the print dialog of the webview (ADR-049 §4): the one thin function that needs a window, so nothing else in `print` does.
//!
//! The crate forbids `unsafe` (`Cargo.toml` lints, checked by `tests/security_baseline.rs`), and `ICoreWebView2_16::ShowPrintUI(System)`
//! is a COM call that needs it. Both platforms therefore take `Webview::print()` (WebView2 print preview on Windows, `NSPrintPanel`
//! on macOS) and answer the `webview` route. The `system` route stays in the contract for the day `unsafe` is allowed for this one
//! call (see BLOCKERS / ADR-049 §4).

//! `Webview::print()` returns when the dialog is opened, not when printing is done (macOS: a sheet that paints the page after the user
//! confirms). The caller therefore keeps the print surface in the page until `afterprint` (ADR-107); nothing here waits.

use tauri::WebviewWindow;

use super::PrintRoute;
use crate::error::AppError;

/// Opens the dialog and answers the route taken.
pub fn open(window: &WebviewWindow, print_id: u32, pages: usize) -> Result<PrintRoute, AppError> {
    // The seam calls `Webview::print()` (or, in the acceptance build, only records the set).
    crate::automation::dialogs::print(window, print_id, pages)?;
    Ok(PrintRoute::Webview)
}
