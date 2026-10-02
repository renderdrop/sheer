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
        "render_page",
        "close_document",
        "app_ready",
        "get_settings",
        "update_settings",
    ]);
    if let Err(error) =
        tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest))
    {
        panic!("tauri-build failed: {error:#}");
    }
}
