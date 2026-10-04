//! The webview shows the app origin and nothing else (SECURITY T8). The main window is built here, not from the config alone, so it
//! can carry the two guards Tauri only offers on the builder: a top-level navigation to any other URL is refused, and so is every
//! request for a new window (`window.open`, `target=_blank`; WebView2 would open a popup without a handler). External links go
//! through `open_link` (P3), never through the webview.

use tauri::webview::NewWindowResponse;
use tauri::{App, Url, WebviewWindowBuilder};

use crate::error::{AppError, ErrorCode};

/// The Vite dev server (`build.devUrl` in `tauri.conf.json`; a test keeps the two equal). Only a debug build accepts it.
pub const DEV_HOST: &str = "localhost";
pub const DEV_PORT: u16 = 1420;

/// Whether the webview may navigate to `url`. Release: `tauri://localhost` (macOS) or `http(s)://tauri.localhost` (Windows), on the
/// default port. Dev (`dev_server` true): also `http://localhost:1420`. Everything else, `file:`, `data:`, `blob:`, `about:` and
/// every remote host included, is refused.
pub fn allows(url: &Url, dev_server: bool) -> bool {
    if url.username() != "" || url.password().is_some() {
        return false;
    }
    match (url.scheme(), url.host_str(), url.port()) {
        ("tauri", Some("localhost"), None) => true,
        ("http" | "https", Some("tauri.localhost"), None) => true,
        ("http", Some(DEV_HOST), Some(DEV_PORT)) => dev_server,
        _ => false,
    }
}

/// Builds the windows of the config (they are declared with `create: false`) with the navigation and new-window guards.
pub fn create_windows(app: &App) -> Result<(), AppError> {
    let configs = app.config().app.windows.clone();
    for config in &configs {
        WebviewWindowBuilder::from_config(app.handle(), config)
            .map_err(|error| AppError::logged(ErrorCode::Internal, error))?
            .on_navigation(|url| allows(url, cfg!(debug_assertions)))
            .on_new_window(|_, _| NewWindowResponse::Deny)
            .build()
            .map_err(|error| AppError::logged(ErrorCode::Internal, error))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(text: &str) -> Url {
        Url::parse(text).unwrap()
    }

    #[test]
    fn the_app_origin_is_allowed_in_both_spellings() {
        for ok in [
            "tauri://localhost",
            "tauri://localhost/index.html",
            "http://tauri.localhost/",
            "https://tauri.localhost/index.html?x=1#y",
        ] {
            assert!(allows(&url(ok), false), "{ok}");
        }
    }

    #[test]
    fn the_dev_server_is_only_allowed_in_a_dev_build() {
        let dev = url("http://localhost:1420/");
        assert!(allows(&dev, true));
        assert!(!allows(&dev, false));
        assert!(!allows(&url("http://localhost:1421/"), true));
        assert!(!allows(&url("http://localhost/"), true));
        assert!(!allows(&url("https://localhost:1420/"), true));
    }

    #[test]
    fn everything_else_is_refused() {
        for bad in [
            "https://example.com/",
            "http://tauri.localhost.evil.test/",
            "http://evil.test/tauri.localhost",
            "http://user@tauri.localhost/",
            "http://tauri.localhost:8080/",
            "tauri://evil",
            "file:///C:/Windows/win.ini",
            "data:text/html,hi",
            "blob:http://tauri.localhost/1",
            "about:blank",
            "javascript:alert(1)",
            "ipc://localhost/x",
            "ftp://tauri.localhost/",
        ] {
            assert!(!allows(&url(bad), true), "{bad}");
            assert!(!allows(&url(bad), false), "{bad}");
        }
    }
}
