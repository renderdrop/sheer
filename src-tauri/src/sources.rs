//! Where a file path enters the backend besides the open dialog (SECURITY I3). Every source ends in
//! `documents::intake`; none of them lets the path out again.
//!
//! - **Drop.** The window is created with `dragDropEnabled: true`, so Tauri takes the OS drop itself and hands the paths only
//!   to [`on_window_event`], never to the page (SECURITY T9). The page is told `dropHover {active}` so it can show its
//!   overlay, and afterwards `opened` or `openFailed`.
//! - **File association.** The bundle declares `.pdf` (`tauri.conf.json`, `bundle.fileAssociations`). macOS delivers the file
//!   as `RunEvent::Opened` ([`on_run_event`]); Windows starts the app with the path on its command line
//!   ([`open_startup_arguments`]).
//! - **Second instance (Windows).** Opening another PDF from the file manager starts another process. The single-instance
//!   plugin hands its command line to the running app and the new process exits ([`on_second_instance`]).
//!
//! A file that arrives while the window is still loading (the app was started by double-clicking it) is opened at once and
//! its result waits in [`AppEvents`] until the UI subscribes, so the document is there as soon as the window is.
//!
//! Opening takes time (the engine loads the file), so none of this runs on the thread that received the event: that is the
//! main thread, which must not block. The work goes to the blocking pool and the results are published as each file is done.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use tauri::{AppHandle, DragDropEvent, Manager, RunEvent, Runtime, Window, WindowEvent};

use crate::commands::AppState;
use crate::documents::intake;
use crate::error::{AppError, ErrorCode};
use crate::events::{AppEvent, AppEvents};

/// What the app does about a drag-and-drop event.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Drag {
    /// Show or hide the drop overlay.
    Hover(bool),
    /// Hide the overlay and open these files.
    Drop(Vec<PathBuf>),
    /// Nothing: the pointer only moves while files are over the window.
    Ignore,
}

fn classify(event: &DragDropEvent) -> Drag {
    match event {
        DragDropEvent::Enter { paths, .. } if !paths.is_empty() => Drag::Hover(true),
        DragDropEvent::Leave => Drag::Hover(false),
        DragDropEvent::Drop { paths, .. } => Drag::Drop(paths.clone()),
        _ => Drag::Ignore,
    }
}

/// Window event hook (`Builder::on_window_event`): files dragged over the main window and dropped on it.
pub fn on_window_event<R: Runtime>(window: &Window<R>, event: &WindowEvent) {
    let WindowEvent::DragDrop(drag) = event else {
        return;
    };
    if window.label() != "main" {
        return;
    }
    let app = window.app_handle();
    match classify(drag) {
        Drag::Hover(active) => publish(app, AppEvent::DropHover { active }),
        Drag::Drop(paths) => {
            publish(app, AppEvent::DropHover { active: false });
            open_in_background(app, paths);
        }
        Drag::Ignore => {}
    }
}

/// `RunEvent` hook: macOS asks the app to open files (a double click in Finder, "Open With", `open file.pdf`, a file dropped
/// on the Dock icon), also while the app is running. Nothing on the other platforms.
pub fn on_run_event<R: Runtime>(app: &AppHandle<R>, event: &RunEvent) {
    #[cfg(target_os = "macos")]
    if let RunEvent::Opened { urls } = event {
        open_in_background(app, intake::paths_from_urls(urls));
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, event);
}

/// Opens the files the app was started with: its command line, where Windows puts the file that was double-clicked. Call it
/// once at startup; nothing happens when there are none. (macOS passes files as `RunEvent::Opened`, not as arguments.)
pub fn open_startup_arguments<R: Runtime>(app: &AppHandle<R>) {
    open_in_background(
        app,
        intake::paths_from_args(std::env::args_os().skip(1), None),
    );
}

/// The callback of the single-instance plugin: another process was started while this one runs. `args` is its command line
/// (the program first) and `cwd` its working directory, which relative paths are resolved against. The running window is
/// brought forward, and the files named are opened here.
pub fn on_second_instance<R: Runtime>(app: &AppHandle<R>, args: Vec<String>, cwd: String) {
    focus_main_window(app);
    let cwd = (!cwd.is_empty()).then(|| Path::new(&cwd));
    let paths = intake::paths_from_args(args.into_iter().skip(1).map(OsString::from), cwd);
    open_in_background(app, paths);
}

/// Brings the main window to the front: restored if it was minimized, and focused. Failures are only logged: the files are
/// opened anyway.
fn focus_main_window<R: Runtime>(app: &AppHandle<R>) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    for result in [window.unminimize(), window.show(), window.set_focus()] {
        if let Err(error) = result {
            AppError::logged(ErrorCode::Internal, format!("focus the window: {error}")).log();
        }
    }
}

/// Tells the UI, if the app state exists yet.
fn publish<R: Runtime>(app: &AppHandle<R>, event: AppEvent) {
    if let Some(events) = app.try_state::<Arc<AppEvents>>() {
        events.publish(event);
    }
}

/// Opens `paths` on the blocking pool and publishes how each went. Nothing for an empty list.
pub fn open_in_background<R: Runtime>(app: &AppHandle<R>, paths: Vec<PathBuf>) {
    if paths.is_empty() {
        return;
    }
    let (Some(state), Some(events)) = (
        app.try_state::<AppState>(),
        app.try_state::<Arc<AppEvents>>(),
    ) else {
        AppError::logged(
            ErrorCode::Internal,
            "files to open arrived before the app state exists",
        )
        .log();
        return;
    };
    let state = state.inner().clone();
    let events = Arc::clone(events.inner());
    // The handle is not needed: the task reports through `events`, and a panic in it is logged by the runtime.
    drop(tauri::async_runtime::spawn_blocking(move || {
        deliver(&state, &events, paths);
    }));
}

/// Opens `paths` and publishes the outcome of each file the moment it is known. Blocks until all are done.
fn deliver(state: &AppState, events: &AppEvents, paths: Vec<PathBuf>) {
    state.open_each(paths, |event| events.publish(event));
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::sync::Mutex;

    use tauri::ipc::{Channel, InvokeResponseBody};
    use tauri::PhysicalPosition;

    use super::*;
    use crate::engine::{Engine, Job};
    use crate::storage::atomic::testutil::TempDir;

    fn at() -> PhysicalPosition<f64> {
        PhysicalPosition::new(10.0, 20.0)
    }

    fn files(names: &[&str]) -> Vec<PathBuf> {
        names.iter().map(PathBuf::from).collect()
    }

    // --- what a drag means ---

    #[test]
    fn files_entering_the_window_show_the_overlay_and_leaving_hides_it() {
        let enter = DragDropEvent::Enter {
            paths: files(&["a.pdf"]),
            position: at(),
        };
        assert_eq!(classify(&enter), Drag::Hover(true));
        assert_eq!(classify(&DragDropEvent::Leave), Drag::Hover(false));
    }

    #[test]
    fn moving_over_the_window_changes_nothing() {
        assert_eq!(
            classify(&DragDropEvent::Over { position: at() }),
            Drag::Ignore
        );
    }

    #[test]
    fn a_drag_that_carries_no_files_shows_no_overlay() {
        // Text or a link dragged from a browser has no paths: nothing to open, so nothing to invite.
        let enter = DragDropEvent::Enter {
            paths: Vec::new(),
            position: at(),
        };
        assert_eq!(classify(&enter), Drag::Ignore);
    }

    #[test]
    fn a_drop_opens_the_files_it_names() {
        let drop = DragDropEvent::Drop {
            paths: files(&["a.pdf", "b.pdf"]),
            position: at(),
        };
        assert_eq!(classify(&drop), Drag::Drop(files(&["a.pdf", "b.pdf"])));
    }

    // --- from a source to the UI ---

    fn recording() -> (Channel<AppEvent>, Arc<Mutex<Vec<serde_json::Value>>>) {
        let log = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&log);
        let channel = Channel::new(move |body| {
            if let InvokeResponseBody::Json(json) = body {
                sink.lock()
                    .unwrap()
                    .push(serde_json::from_str(&json).unwrap());
            }
            Ok(())
        });
        (channel, log)
    }

    /// An engine that loads anything as a 5-page document (the worker's `confirm` handshake included). Needs no PDFium.
    fn state() -> AppState {
        AppState::new(Engine::with_handler(|job| match job {
            Job::Open { confirm, reply, .. } => {
                let _ = confirm(5);
                let _ = reply.send(Ok(5));
            }
            Job::Close { reply, .. } => {
                let _ = reply.send(Ok(()));
            }
            _ => {}
        }))
    }

    fn pdf(dir: &TempDir, name: &str) -> PathBuf {
        let path = dir.path().join(name);
        fs::write(&path, b"%PDF-1.4\n%%EOF\n").unwrap();
        path
    }

    #[test]
    fn a_dropped_file_reaches_a_listening_ui_as_an_opened_document_without_its_path() {
        let dir = TempDir::new();
        let (state, events) = (state(), AppEvents::new());
        let (channel, log) = recording();
        events.subscribe(channel);

        deliver(&state, &events, vec![pdf(&dir, "dropped.pdf")]);

        let log = log.lock().unwrap();
        assert_eq!(log.len(), 1);
        assert_eq!(
            log[0],
            serde_json::json!({
                "type": "opened",
                "document": {
                    "id": 0, "pageCount": 5, "displayName": "dropped.pdf",
                    "flags": { "encrypted": false, "xfa": false, "hasForms": false, "signed": false }
                }
            })
        );
        let text = log[0].to_string();
        assert!(!text.contains(dir.path().to_string_lossy().as_ref()));
    }

    #[test]
    fn a_file_the_app_was_started_with_waits_for_the_ui_and_then_arrives_once() {
        let dir = TempDir::new();
        let (state, events) = (state(), AppEvents::new());
        // Opened while the window is still loading: nobody listens yet.
        deliver(&state, &events, vec![pdf(&dir, "startup.pdf")]);

        let (channel, log) = recording();
        events.subscribe(channel);
        assert_eq!(log.lock().unwrap().len(), 1);
        assert_eq!(
            log.lock().unwrap()[0]["document"]["displayName"],
            "startup.pdf"
        );

        let (again, log) = recording();
        events.subscribe(again);
        assert!(log.lock().unwrap().is_empty());
    }

    #[test]
    fn startup_results_that_waited_come_first_and_once_and_later_ones_follow_without_repeats() {
        let dir = TempDir::new();
        let (state, events) = (state(), AppEvents::new());
        let not_a_pdf = dir.path().join("startup-notes.pdf");
        fs::write(&not_a_pdf, b"plain text").unwrap();
        // Two files on the command line while the window loads: one is refused, one opens.
        deliver(&state, &events, vec![not_a_pdf, pdf(&dir, "startup.pdf")]);

        let (channel, log) = recording();
        events.subscribe(channel);
        // A second instance hands over another file after the UI listens: that one goes out at once, behind the others.
        deliver(&state, &events, vec![pdf(&dir, "second.pdf")]);

        let log = log.lock().unwrap();
        let types: Vec<(&str, &str)> = log
            .iter()
            .map(|m| {
                (
                    m["type"].as_str().unwrap(),
                    m["code"]
                        .as_str()
                        .or_else(|| m["document"]["displayName"].as_str())
                        .unwrap(),
                )
            })
            .collect();
        assert_eq!(
            types,
            [
                ("openFailed", "not_a_pdf"),
                ("opened", "startup.pdf"),
                ("opened", "second.pdf")
            ]
        );
        // Subscribing again repeats nothing of the three.
        let (again, replay) = recording();
        events.subscribe(again);
        assert!(replay.lock().unwrap().is_empty());
        assert!(!log.iter().any(|m| m.to_string().contains("startup-notes")));
    }

    #[test]
    fn a_file_named_twice_at_startup_is_one_document_reported_with_one_id() {
        let dir = TempDir::new();
        let (state, events) = (state(), AppEvents::new());
        let path = pdf(&dir, "twice.pdf");
        let roundabout = {
            fs::create_dir(dir.path().join("sub")).unwrap();
            dir.path().join("sub").join("..").join("twice.pdf")
        };
        deliver(&state, &events, vec![path, roundabout]);

        let (channel, log) = recording();
        events.subscribe(channel);
        let log = log.lock().unwrap();
        // Both are answered (the UI shows the document once and brings it forward), and with the same id.
        assert_eq!(log.len(), 2);
        assert_eq!(log[0]["document"]["id"], log[1]["document"]["id"]);
    }

    #[test]
    fn a_failed_open_is_reported_as_an_error_code_not_as_a_path() {
        let dir = TempDir::new();
        let (state, events) = (state(), AppEvents::new());
        let (channel, log) = recording();
        events.subscribe(channel);

        let not_a_pdf = dir.path().join("notes.pdf");
        fs::write(&not_a_pdf, b"plain text").unwrap();
        deliver(
            &state,
            &events,
            vec![not_a_pdf, dir.path().join("gone.pdf")],
        );

        let log = log.lock().unwrap();
        let codes: Vec<&str> = log.iter().map(|m| m["code"].as_str().unwrap()).collect();
        assert_eq!(codes, ["not_a_pdf", "io_not_found"]);
        assert!(log.iter().all(|m| m["type"] == "openFailed"));
        assert!(log.iter().all(|m| !m.to_string().contains("notes")));
    }

    #[test]
    fn each_file_is_published_as_soon_as_it_is_open_not_after_the_whole_batch() {
        let dir = TempDir::new();
        let (state, events) = (state(), AppEvents::new());
        let (channel, log) = recording();
        events.subscribe(channel);
        let seen_before_the_second = Arc::new(Mutex::new(None));
        let (first, second) = (pdf(&dir, "one.pdf"), pdf(&dir, "two.pdf"));
        let probe = Arc::clone(&seen_before_the_second);
        let probe_log = Arc::clone(&log);
        let mut count = 0;
        state.open_each(vec![first, second], |event| {
            count += 1;
            // When the second result is reported, the first one has been reported already.
            if count == 2 {
                *probe.lock().unwrap() = Some(probe_log.lock().unwrap().len());
            }
            events.publish(event);
        });
        assert_eq!(*seen_before_the_second.lock().unwrap(), Some(1));
        assert_eq!(log.lock().unwrap().len(), 2);
    }

    #[test]
    fn a_second_instance_command_line_names_its_files_relative_to_its_own_directory() {
        let cwd = fs::canonicalize(std::env::temp_dir()).unwrap();
        let args = vec![
            "sheer.exe".to_owned(),
            "--flag".to_owned(),
            "rel.pdf".to_owned(),
        ];
        let paths = intake::paths_from_args(
            args.into_iter().skip(1).map(OsString::from),
            Some(cwd.as_path()),
        );
        assert_eq!(paths, [cwd.join("rel.pdf")]);
    }
}
