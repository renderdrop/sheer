//! Acceptance automation (ADR-131, ARCHITECTURE "Acceptance automation").
//!
//! [`dialogs`] is the one seam every native dialog of the app goes through (open, open many, pick folder, save, message, print). Without
//! the cargo feature `automation` (never a default, never in a release build) it calls the native dialog exactly as the call site did
//! before. With it, the answer comes from a queue a script fills through `automation_queue_dialog`; an empty queue or an entry of
//! another kind is an error, never a native dialog.

pub mod dialogs;

#[cfg(feature = "automation")]
pub mod commands;
#[cfg(feature = "automation")]
pub mod queue;
