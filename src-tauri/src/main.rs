// Hides the console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if let Err(error) = sheer_lib::run() {
        // Through the AppError log: the code always, the detail (which can hold paths) only when opted into.
        error.log();
        std::process::exit(1);
    }
}
