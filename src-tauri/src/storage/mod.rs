//! Local persistence in the app data directory. Everything is written atomically (`atomic`), and nothing stored here
//! is trusted when read back (the files are user-writable).

pub mod atomic;
pub mod autosave;
pub mod backup;
pub mod keychain;
mod open;
pub mod recents;
pub mod settings;
pub mod signatures;

pub(crate) use open::open_without_blocking;
