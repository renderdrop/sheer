//! Local persistence in the app data directory. Everything is written atomically (`atomic`), and nothing stored here
//! is trusted when read back (the files are user-writable).

pub mod atomic;
pub mod settings;
