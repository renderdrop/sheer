//! Sheer backend: Tauri shell, document registry and the PDFium engine worker.
//!
//! All PDF work happens here. The frontend only ever holds document ids, page ids and rendered frames (PNG bytes).

pub mod commands;
pub mod content;
pub mod documents;
pub mod engine;
pub mod error;
pub mod events;
pub mod export;
pub mod limits;
pub mod menu;
pub mod model;
pub mod pdfwrite;
pub mod platform;
pub mod print;
pub mod security;
pub mod signatures;
pub mod sources;
pub mod storage;

use std::sync::Arc;

use tauri::Manager;

use crate::commands::AppState;
use crate::engine::Engine;
use crate::error::{AppError, ErrorCode};
use crate::events::AppEvents;
use crate::menu::MenuBridge;
use crate::platform::TransparencyWatch;
use crate::storage::recents::{self, RecentsStore};
use crate::storage::settings::{self, SettingsStore};

/// Builds and runs the app. Returns when the last window is closed. A startup failure comes back as an [`AppError`]
/// (the Tauri error text, which can contain paths, is only its log detail); the caller logs it with `AppError::log`.
pub fn run() -> Result<(), AppError> {
    let builder = tauri::Builder::default();
    // Windows starts a new process for every file the user opens from the file manager. The first instance keeps the
    // window: the new process hands its command line over and exits (`sources::on_second_instance`). It has to be the first
    // plugin, so a second instance is turned away before anything else is set up. macOS routes the files to the running app
    // itself (`RunEvent::Opened`), so it does not need it.
    #[cfg(windows)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(
        sources::on_second_instance,
    ));
    let app = builder
        // The menu bar is ours (src-tauri/src/menu): macOS gets the layout of src/actions/menu.json, Windows has none.
        .enable_macos_default_menu(false)
        // Registered for Rust-side use only: no capability grants the dialog commands to the webview.
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // PDFium ships as a bundled resource (scripts/fetch-pdfium.sh), never downloaded at runtime.
            let pdfium_root = app.path().resource_dir()?.join("pdfium");
            // What the backend pushes to the UI (drag over the window, files opened by the OS) reaches it on the channel
            // the UI opens with `subscribe_app`; what happens before that waits here.
            app.manage(Arc::new(AppEvents::new()));
            // Settings live in the app data directory; a missing or damaged file means the defaults. A crash in the middle
            // of a write leaves a hidden temp file there: the ones older than an hour are removed (SECURITY D1, D7).
            let data_dir = app.path().app_data_dir()?;
            storage::atomic::sweep_stale_temp_files(&data_dir);
            // The recent files live next to the settings; every document the user opens is noted there (never the welcome one).
            let recents = Arc::new(RecentsStore::load(data_dir.join(recents::FILE_NAME)));
            app.manage(
                AppState::new(Engine::start(engine::library_path(&pdfium_root)))
                    .with_recents(recents)
                    .with_data_dir(data_dir.clone()),
            );
            app.manage(Arc::new(SettingsStore::load(
                data_dir.join(settings::FILE_NAME),
            )));
            // The signature library: encrypted in the app data directory, its key in the OS keychain (SECURITY D2). Nothing is
            // read or written until the UI asks.
            app.manage(commands::library::LibraryState::new(
                storage::signatures::Library::in_data_dir(&data_dir),
            ));
            // The OS "Reduce transparency" flag as the UI first sees it; later changes go to the channel the UI opens with
            // `watch_transparency`.
            app.manage(Arc::new(TransparencyWatch::new(
                platform::reduced_transparency(),
            )));
            // The macOS menu bar, in the language of the settings; its commands reach the UI on the channel the UI opens
            // with `subscribe_menu`. Nothing is installed on Windows.
            app.manage(Arc::new(MenuBridge::new()));
            menu::install(app.handle());
            // A file the app was started with (Windows: the double-clicked file is on the command line) opens now, while
            // the window loads; its result waits for the UI.
            sources::open_startup_arguments(app.handle());
            Ok(())
        })
        .on_menu_event(menu::on_menu_event)
        // Re-reads that flag when the window gains focus (see `platform::on_window_event`), and takes files dropped on the
        // window (see `sources::on_window_event`).
        .on_window_event(|window, event| {
            platform::on_window_event(window, event);
            sources::on_window_event(window, event);
        })
        .invoke_handler(tauri::generate_handler![
            commands::open_document_dialog,
            commands::open_welcome_document,
            commands::unlock_document,
            commands::list_recents,
            commands::remove_recent,
            commands::open_recent,
            commands::recent_actions::restore_recent,
            commands::recent_actions::locate_recent,
            commands::set_menu_state,
            commands::render::render_page,
            commands::render::set_viewport,
            commands::pages::get_pages,
            commands::outline::get_outline,
            commands::text::get_text_layer,
            commands::search::search,
            commands::search::cancel_search,
            commands::links::get_page_links,
            commands::links::open_link,
            commands::annotations::list_annotations,
            commands::annotations::list_document_annotations,
            commands::annotations::import_warnings,
            commands::pages::apply_command,
            commands::forms::get_form_fields,
            commands::content::insert_image_dialog,
            commands::content::get_asset_preview,
            commands::redact::apply_redactions,
            commands::protect::get_protection,
            commands::protect::stage_protection,
            commands::protect::stage_unprotection,
            commands::metadata::get_metadata,
            commands::export_images::export_images,
            commands::export_images::resolve_export_conflicts,
            commands::images_pdf::images_to_pdf,
            commands::images_pdf::release_image_batch,
            commands::images_pdf::pick_images,
            commands::images_pdf::list_image_batch,
            commands::images_pdf::get_image_batch_preview,
            commands::export_pdf::export_pdf,
            commands::print::prepare_print,
            commands::print::get_print_page,
            commands::print::open_print_dialog,
            commands::print::release_print,
            commands::pages::pick_pdf_sources,
            commands::pages::release_source,
            commands::annotations::undo,
            commands::annotations::redo,
            commands::save::save_document,
            commands::save::save_document_as,
            commands::jobs::extract_pages,
            commands::jobs::split_document,
            commands::jobs::merge_documents,
            commands::jobs::compress_document,
            commands::jobs::flatten_document,
            commands::jobs::estimate_compression,
            commands::jobs::cancel_job,
            commands::close_document,
            commands::app::app_ready,
            commands::app::get_settings,
            commands::app::update_settings,
            commands::app::watch_transparency,
            commands::app::subscribe_menu,
            commands::app::subscribe_app,
            commands::library::clear_signature_library,
            commands::library::get_library_signature,
            commands::library::delete_signature,
            commands::library::rename_signature,
            commands::library::save_library_signature,
            commands::library::list_signatures,
            commands::signatures::use_signature,
            commands::signatures::get_signature_preview,
            commands::signatures::discard_signature_draft,
            commands::signatures::save_draft_signature,
            commands::signatures::import_signature_image,
            commands::signatures::create_typed_signature,
            commands::signatures::create_drawn_signature,
        ])
        .build(tauri::generate_context!())
        .map_err(|error| AppError::logged(ErrorCode::Internal, error))?;
    // macOS hands the files it is asked to open to the running app as `RunEvent::Opened`.
    app.run(|app, event| sources::on_run_event(app, &event));
    Ok(())
}
