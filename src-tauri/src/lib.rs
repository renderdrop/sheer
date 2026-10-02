//! Sheer backend: Tauri shell, document registry and the PDFium engine worker.
//!
//! All PDF work happens here. The frontend only ever holds document ids, page ids and rendered frames (PNG bytes).

pub mod commands;
pub mod documents;
pub mod engine;
pub mod error;
pub mod limits;
pub mod platform;
pub mod storage;

use std::sync::Arc;

use tauri::Manager;

use crate::commands::AppState;
use crate::engine::Engine;
use crate::error::{AppError, ErrorCode};
use crate::platform::TransparencyWatch;
use crate::storage::settings::{self, SettingsStore};

/// Builds and runs the app. Returns when the last window is closed. A startup failure comes back as an [`AppError`]
/// (the Tauri error text, which can contain paths, is only its log detail); the caller logs it with `AppError::log`.
pub fn run() -> Result<(), AppError> {
    tauri::Builder::default()
        // Registered for Rust-side use only: no capability grants the dialog commands to the webview.
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // PDFium ships as a bundled resource (scripts/fetch-pdfium.sh), never downloaded at runtime.
            let pdfium_root = app.path().resource_dir()?.join("pdfium");
            app.manage(AppState::new(Engine::start(engine::library_path(
                &pdfium_root,
            ))));
            // Settings live in the app data directory; a missing or damaged file means the defaults.
            let settings_path = app.path().app_data_dir()?.join(settings::FILE_NAME);
            app.manage(Arc::new(SettingsStore::load(settings_path)));
            // The OS "Reduce transparency" flag as the UI first sees it; later changes go to the channel the UI opens with
            // `watch_transparency`.
            app.manage(Arc::new(TransparencyWatch::new(
                platform::reduced_transparency(),
            )));
            Ok(())
        })
        // Re-reads that flag when the window gains focus (see `platform::on_window_event`).
        .on_window_event(platform::on_window_event)
        .invoke_handler(tauri::generate_handler![
            commands::open_document_dialog,
            commands::render_page,
            commands::close_document,
            commands::app::app_ready,
            commands::app::get_settings,
            commands::app::update_settings,
            commands::app::watch_transparency,
        ])
        .run(tauri::generate_context!())
        .map_err(|error| AppError::logged(ErrorCode::Internal, error))
}
