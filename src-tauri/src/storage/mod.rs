//! Local persistence in the app data directory. Everything is written atomically (`atomic`), and nothing stored here
//! is trusted when read back (the files are user-writable).

pub mod atomic;
mod open;
pub mod settings;

pub(crate) use open::open_without_blocking;
