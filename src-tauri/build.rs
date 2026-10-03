//! Build script. Declares the app's IPC commands so each one needs an explicit permission (least privilege, granted in
//! `capabilities/default.json`) and checks that the bundled PDFium has been fetched.

use std::path::Path;

fn main() {
    println!("cargo:rerun-if-changed=pdfium");
    if !Path::new("pdfium").is_dir() {
        panic!(
            "PDFium is not fetched yet. Run `npm run fetch-pdfium` (scripts/fetch-pdfium.sh) from the repository root."
        );
    }

    let manifest = tauri_build::AppManifest::new().commands(&[
        "open_document_dialog",
        "open_welcome_document",
        "unlock_document",
        "list_recents",
        "remove_recent",
        "open_recent",
        "set_menu_state",
        "render_page",
        "set_viewport",
        "get_page_sizes",
        "get_outline",
        "get_text_layer",
        "search",
        "cancel_search",
        "get_page_links",
        "open_link",
        "close_document",
        "app_ready",
        "get_settings",
        "update_settings",
        "watch_transparency",
        "subscribe_menu",
        "subscribe_app",
    ]);
    if let Err(error) =
        tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest))
    {
        panic!("tauri-build failed: {error:#}");
    }
}
