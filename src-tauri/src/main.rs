// Hides the console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if let Err(error) = sheer_lib::run() {
        eprintln!("sheer: {error}");
        std::process::exit(1);
    }
}
