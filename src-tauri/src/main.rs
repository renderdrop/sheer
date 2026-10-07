// Hides the console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use sheer_lib::engine::wire;

fn main() {
    // The PDF engine runs as this same executable in child mode (ADR-053 §1.1): both the flag and the environment variable are
    // required, so a file path from an association can never start it. Not a child: carry on with the app.
    let child = wire::child_mode_requested(
        std::env::args_os(),
        std::env::var_os(wire::CHILD_ENV).as_deref(),
    );
    // The OCR child (ADR-134) is the same executable with its own flag and variable.
    if sheer_lib::ocr::child_mode_requested(
        std::env::args_os(),
        std::env::var_os(sheer_lib::ocr::CHILD_ENV).as_deref(),
    ) {
        if let Some(code) = sheer_lib::ocr_child_main() {
            std::process::exit(code);
        }
    }
    if child {
        if let Some(code) = sheer_lib::engine_child_main() {
            std::process::exit(code);
        }
    }
    if let Err(error) = sheer_lib::run() {
        // Through the AppError log: the code always, the detail (which can hold paths) only when opted into.
        error.log();
        std::process::exit(1);
    }
}
