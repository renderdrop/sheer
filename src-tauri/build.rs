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
        "restore_recent",
        "locate_recent",
        "get_recent_thumbnail",
        "set_menu_state",
        "render_page",
        "set_viewport",
        "get_pages",
        "get_outline",
        "get_text_layer",
        "search",
        "cancel_search",
        "get_page_links",
        "open_link",
        "list_annotations",
        "list_document_annotations",
        "get_annotation_quote",
        "import_warnings",
        "apply_command",
        "get_form_fields",
        "pick_pdf_sources",
        "release_source",
        "undo",
        "redo",
        "save_document",
        "save_document_as",
        "extract_pages",
        "split_document",
        "merge_documents",
        "compress_document",
        "flatten_document",
        "estimate_compression",
        "cancel_job",
        "close_document",
        "app_ready",
        "get_settings",
        "update_settings",
        "watch_transparency",
        "subscribe_menu",
        "subscribe_app",
        "clear_signature_library",
        "get_library_signature",
        "delete_signature",
        "rename_signature",
        "save_library_signature",
        "list_signatures",
        "use_signature",
        "get_signature_preview",
        "discard_signature_draft",
        "save_draft_signature",
        "import_signature_image",
        "create_typed_signature",
        "create_drawn_signature",
        "insert_image_dialog",
        "get_asset_preview",
        "apply_redactions",
        "get_protection",
        "stage_protection",
        "stage_unprotection",
        "get_metadata",
        "export_images",
        "resolve_export_conflicts",
        "images_to_pdf",
        "release_image_batch",
        "pick_images",
        "list_image_batch",
        "get_image_batch_preview",
        "export_pdf",
        "prepare_print",
        "get_print_page",
        "open_print_dialog",
        "release_print",
        "list_recoveries",
        "restore_recovery",
        "discard_recovery",
        "discard_all_recoveries",
        "check_for_update",
        "download_update",
        "install_update_on_quit",
        "skip_update_version",
        "open_default_apps_settings",
    ]);
    if let Err(error) =
        tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest))
    {
        panic!("tauri-build failed: {error:#}");
    }
}
