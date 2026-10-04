//! `UpdateState` (ARCHITECTURE §11.3): the update that was found, the verified package and the install-on-quit mark. All in memory:
//! a package is never written to disk by us (the Windows installer extracts it to its own temp dir at install time), so "delete the
//! download" means dropping the bytes.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::Instant;

use tauri_plugin_updater::Update;

use crate::limits;
use crate::storage::settings::UpdatesMode;

/// What started a check. `Automatic` needs the setting; `Manual` is the user's click on "Check for updates" (per-click consent).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Trigger {
    Automatic,
    Manual,
}

/// Whether a check started by `trigger` may touch the network at all, given the setting. The one gate every check passes.
pub const fn may_check(trigger: Trigger, updates: UpdatesMode) -> bool {
    match trigger {
        Trigger::Manual => true,
        Trigger::Automatic => matches!(updates, UpdatesMode::On),
    }
}

/// Whether the automatic check is due: the setting is on and the last check was at least `UPDATE_CHECK_INTERVAL` ago (or there was none).
pub fn automatic_due(updates: UpdatesMode, last: Option<Instant>, now: Instant) -> bool {
    may_check(Trigger::Automatic, updates)
        && last
            .is_none_or(|last| now.saturating_duration_since(last) >= limits::UPDATE_CHECK_INTERVAL)
}

/// A downloaded package whose signature was verified.
pub struct Verified {
    pub update: Update,
    pub package: Vec<u8>,
}

#[derive(Default)]
struct Inner {
    /// The update the last check found; `download_update` fetches this one.
    found: Option<Update>,
    verified: Option<Verified>,
    install_on_quit: bool,
    last_check: Option<Instant>,
}

/// Shared by the commands, the automatic check and the quit hook.
#[derive(Default)]
pub struct UpdateState {
    inner: Mutex<Inner>,
    /// The updater plugin was registered (the signing key is real). Without it nothing may call into the plugin.
    ready: AtomicBool,
}

impl UpdateState {
    fn lock(&self) -> MutexGuard<'_, Inner> {
        // Plain data: a panic elsewhere cannot leave it half-updated.
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn set_ready(&self) {
        self.ready.store(true, Ordering::Release);
    }

    pub fn ready(&self) -> bool {
        self.ready.load(Ordering::Acquire)
    }

    pub fn last_check(&self) -> Option<Instant> {
        self.lock().last_check
    }

    pub fn note_check(&self, now: Instant) {
        self.lock().last_check = Some(now);
    }

    /// Remembers the update a check found (and forgets any earlier package: it belongs to another update).
    pub fn set_found(&self, update: Option<Update>) {
        let mut inner = self.lock();
        inner.found = update;
        inner.verified = None;
        inner.install_on_quit = false;
    }

    pub fn found(&self) -> Option<Update> {
        self.lock().found.clone()
    }

    pub fn set_verified(&self, verified: Verified) {
        self.lock().verified = Some(verified);
    }

    /// A bad signature: the update, its package and the install mark are all dropped (ADR-054 section 4: no retry).
    pub fn discard(&self) {
        let mut inner = self.lock();
        inner.found = None;
        inner.verified = None;
        inner.install_on_quit = false;
    }

    pub fn has_package(&self) -> bool {
        self.lock().verified.is_some()
    }

    /// Marks the verified package for installation at exit. `false` when there is none.
    pub fn mark_install_on_quit(&self) -> bool {
        let mut inner = self.lock();
        inner.install_on_quit = inner.verified.is_some();
        inner.install_on_quit
    }

    /// The package to install now, only when it was marked; leaves nothing behind.
    pub fn take_for_install(&self) -> Option<Verified> {
        let mut inner = self.lock();
        if inner.install_on_quit {
            inner.install_on_quit = false;
            inner.verified.take()
        } else {
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn an_automatic_check_needs_the_setting_and_a_click_does_not() {
        assert!(!may_check(Trigger::Automatic, UpdatesMode::Off));
        assert!(may_check(Trigger::Automatic, UpdatesMode::On));
        assert!(may_check(Trigger::Manual, UpdatesMode::Off));
        assert!(may_check(Trigger::Manual, UpdatesMode::On));
    }

    #[test]
    fn the_automatic_check_is_due_once_a_day_and_never_while_off() {
        let start = Instant::now();
        let day = limits::UPDATE_CHECK_INTERVAL;
        assert!(!automatic_due(UpdatesMode::Off, None, start));
        assert!(automatic_due(UpdatesMode::On, None, start));
        assert!(!automatic_due(
            UpdatesMode::On,
            Some(start),
            start + day - Duration::from_secs(1)
        ));
        assert!(automatic_due(UpdatesMode::On, Some(start), start + day));
        assert!(!automatic_due(
            UpdatesMode::Off,
            Some(start),
            start + day * 2
        ));
    }

    #[test]
    fn nothing_is_installed_unless_a_verified_package_was_marked() {
        let state = UpdateState::default();
        assert!(!state.has_package());
        assert!(!state.mark_install_on_quit());
        assert!(state.take_for_install().is_none());
    }
}
