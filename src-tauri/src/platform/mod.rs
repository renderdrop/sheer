//! Operating-system specifics, behind one small interface so no other module needs `cfg`.

use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{Manager, Runtime, Window, WindowEvent};

#[cfg(target_os = "macos")]
mod macos;

/// The OS the app runs on, as the frontend names it. Only the two shipped platforms plus Linux for developer builds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Platform {
    Macos,
    Windows,
    Linux,
}

/// The platform this binary was built for.
pub const fn current() -> Platform {
    if cfg!(target_os = "macos") {
        Platform::Macos
    } else if cfg!(target_os = "windows") {
        Platform::Windows
    } else {
        Platform::Linux
    }
}

/// The paper the OS region suggests for new documents (ADR-049 §3). The wire name is the lower-case word.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Paper {
    A4,
    #[allow(dead_code)] // package B returns it from `paper_default` (ADR-049 §6)
    Letter,
}

/// Letter in the US and Canada, A4 elsewhere (Windows `GetLocaleInfoEx` with `LOCALE_IPAPERSIZE`, macOS `NSLocale`). Always A4 until
/// package B (ADR-049 §6) reads the OS region; never fails.
pub const fn paper_default() -> Paper {
    Paper::A4
}

/// Whether the OS asks apps to avoid translucent surfaces (macOS: "Reduce transparency").
///
/// WKWebView does not map that setting to `prefers-reduced-transparency`, so the UI gets it from here (DESIGN §1).
/// `false` where the OS has no such flag or it is not read; Chromium-based WebView2 reports its own via CSS.
pub fn reduced_transparency() -> bool {
    #[cfg(target_os = "macos")]
    {
        macos::reduced_transparency()
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

/// Pushes the OS "Reduce transparency" flag to the UI whenever it changes.
///
/// The UI opens a [`Channel<bool>`] with the `watch_transparency` command and every change of the flag after that is a
/// message on it. A channel, not a global event: the webview has no event permission at all (`core:event:allow-listen`
/// and `-unlisten` are not granted, SECURITY T3), so it can neither hear events nor emit them, and the only way for Rust
/// to reach it is a channel it handed over itself. The message is the bare flag, never a path or document data.
///
/// There is one receiver (one window): a new one replaces the old, which is dropped, and Tauri tells its JavaScript side
/// that no more messages come.
pub struct TransparencyWatch(Mutex<WatchState>);

struct WatchState {
    /// The value the UI has: the one `app_ready` gave it (read at startup), then every value sent to it. Only a different one is
    /// a change. It moves only when there is a receiver, so a change that nobody could be told about is still news to the
    /// next receiver.
    last: bool,
    receiver: Option<Channel<bool>>,
}

impl TransparencyWatch {
    /// Starts from the value the UI was given (`app_ready`), with nobody listening yet.
    pub fn new(initial: bool) -> Self {
        Self(Mutex::new(WatchState {
            last: initial,
            receiver: None,
        }))
    }

    /// Makes `channel` the receiver, replacing an earlier one. `current` is the flag as read just now: if it differs from
    /// what the UI has (it changed after startup and no window focus has reported it yet) the receiver is told at once.
    pub fn subscribe(&self, channel: Channel<bool>, current: bool) {
        let mut state = self.lock();
        state.receiver = Some(channel);
        state.observe(current);
    }

    /// Reports `reduced` as the flag's current value: if the UI has another one, it is sent to the receiver. The send
    /// happens under the lock so values reach the UI in the order they were observed; it only queues a script for the
    /// webview and never waits.
    pub fn publish(&self, reduced: bool) {
        self.lock().observe(reduced);
    }

    /// The state is a flag and a handle; a panic elsewhere cannot leave it half-updated, so a poisoned lock is safe to
    /// keep using.
    fn lock(&self) -> MutexGuard<'_, WatchState> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

impl WatchState {
    fn observe(&mut self, reduced: bool) {
        let Some(channel) = &self.receiver else {
            return;
        };
        if self.last == reduced {
            return;
        }
        self.last = reduced;
        // A failed send means the webview is gone; the UI keeps the value it has until it subscribes again.
        let _ = channel.send(reduced);
    }
}

/// Window event hook that keeps the UI in step with the OS flag.
///
/// macOS offers no event for "Reduce transparency" that safe Rust can observe (the `NSWorkspace` notification needs a
/// block observer, which means `unsafe`). The setting is changed in System Settings, another app, so this one has
/// lost focus when it changes and gains it again afterwards. Re-reading the flag whenever the window gains focus
/// therefore catches every change, costs one property read, and needs no timer. Where the flag does not exist
/// (`reduced_transparency` is always `false`) the value never changes and nothing is sent.
pub fn on_window_event<R: Runtime>(window: &Window<R>, event: &WindowEvent) {
    if !matches!(event, WindowEvent::Focused(true)) {
        return;
    }
    let Some(watch) = window.try_state::<Arc<TransparencyWatch>>() else {
        return;
    };
    watch.publish(reduced_transparency());
}

#[cfg(test)]
mod tests {
    use tauri::ipc::InvokeResponseBody;

    use super::*;

    /// A channel that records what is sent over it, as the JSON text the webview would receive.
    fn recording() -> (Channel<bool>, Arc<Mutex<Vec<String>>>) {
        let log = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&log);
        let channel = Channel::new(move |body| {
            let text = match body {
                InvokeResponseBody::Json(json) => json,
                InvokeResponseBody::Raw(bytes) => format!("raw:{}", bytes.len()),
            };
            sink.lock().unwrap().push(text);
            Ok(())
        });
        (channel, log)
    }

    fn seen(log: &Arc<Mutex<Vec<String>>>) -> Vec<String> {
        log.lock().unwrap().clone()
    }

    #[test]
    fn subscribing_with_the_value_the_ui_already_has_sends_nothing() {
        let watch = TransparencyWatch::new(true);
        let (channel, log) = recording();
        watch.subscribe(channel, true);
        watch.publish(true);
        assert!(seen(&log).is_empty());
    }

    #[test]
    fn subscribing_after_the_flag_changed_tells_the_ui() {
        // The UI was given false at startup; by the time it subscribes the flag reads true.
        let watch = TransparencyWatch::new(false);
        let (channel, log) = recording();
        watch.subscribe(channel, true);
        assert_eq!(seen(&log), ["true"]);
        watch.publish(true);
        assert_eq!(seen(&log), ["true"]);
    }

    #[test]
    fn only_real_changes_are_sent() {
        let watch = TransparencyWatch::new(false);
        let (channel, log) = recording();
        watch.subscribe(channel, false);
        watch.publish(false);
        watch.publish(true);
        watch.publish(true);
        watch.publish(false);
        watch.publish(false);
        assert_eq!(seen(&log), ["true", "false"]);
    }

    #[test]
    fn a_change_that_nobody_could_be_told_about_is_not_lost() {
        let watch = TransparencyWatch::new(false);
        watch.publish(true); // no receiver yet: the UI still has false
        watch.publish(true);
        let (channel, log) = recording();
        watch.subscribe(channel, true);
        assert_eq!(seen(&log), ["true"]);
    }

    #[test]
    fn a_new_receiver_replaces_the_old_one() {
        let watch = TransparencyWatch::new(false);
        let (first, first_log) = recording();
        let (second, second_log) = recording();
        watch.subscribe(first, false);
        watch.subscribe(second, false);
        watch.publish(true);
        assert!(seen(&first_log).is_empty());
        assert_eq!(seen(&second_log), ["true"]);
    }

    #[test]
    fn a_receiver_that_cannot_be_reached_never_breaks_the_watch() {
        let watch = TransparencyWatch::new(false);
        let gone = Channel::new(|_| Err(tauri::Error::WebviewNotFound));
        watch.subscribe(gone, false);
        watch.publish(true);
        watch.publish(false);
        // A live receiver still works afterwards.
        let (channel, log) = recording();
        watch.subscribe(channel, false);
        watch.publish(true);
        assert_eq!(seen(&log), ["true"]);
    }

    #[test]
    fn a_message_is_the_bare_flag() {
        // Nothing else rides on the channel: no object, no path, no document data.
        let (channel, log) = recording();
        channel.send(true).unwrap();
        channel.send(false).unwrap();
        assert_eq!(seen(&log), ["true", "false"]);
    }

    #[test]
    fn platform_names_are_the_lowercase_wire_names() {
        for (platform, name) in [
            (Platform::Macos, "macos"),
            (Platform::Windows, "windows"),
            (Platform::Linux, "linux"),
        ] {
            assert_eq!(serde_json::to_value(platform).unwrap(), name);
        }
    }

    #[test]
    fn current_matches_the_build_target() {
        #[cfg(target_os = "windows")]
        assert_eq!(current(), Platform::Windows);
        #[cfg(target_os = "macos")]
        assert_eq!(current(), Platform::Macos);
    }

    #[test]
    #[cfg(not(target_os = "macos"))]
    fn there_is_no_os_flag_off_macos() {
        assert!(!reduced_transparency());
    }
}
