import { getCurrentWindow } from '@tauri-apps/api/window';

import { toAppError } from './errors';

/**
 * The window controls of the custom title bar (DESIGN 2.2): minimize, maximize or restore, close, and two reads of the
 * window state. Each one is exactly one of the `core:window:allow-*` permissions of `capabilities/default.json`
 * (SECURITY T3, ADR-014); this is the only module that imports the window API, so a new call here means a new permission
 * there. They go through `getCurrentWindow()`, the window the webview lives in; none of them takes a label or a path.
 *
 * Like every wrapper in src/api they reject with an `AppError`, also outside Tauri (a plain browser, a test), where there
 * is no window to ask. The callers treat a failure as "nothing happened".
 *
 * The resize and focus *events* of the window API are deliberately not used: they would need the event permission
 * (SECURITY T3). The shell reads the state again on the DOM's `resize` event instead.
 */
async function run<T>(operation: (window: ReturnType<typeof getCurrentWindow>) => Promise<T>): Promise<T> {
  try {
    return await operation(getCurrentWindow());
  } catch (error) {
    throw toAppError(error);
  }
}

/** `core:window:allow-minimize`. */
export function minimizeWindow(): Promise<void> {
  return run((window) => window.minimize());
}

/** `core:window:allow-toggle-maximize`: maximizes, or restores a maximized window. */
export function toggleMaximizeWindow(): Promise<void> {
  return run((window) => window.toggleMaximize());
}

/** `core:window:allow-close`. This is a close *request*: the window may still veto it (unsaved changes, later). */
export function closeWindow(): Promise<void> {
  return run((window) => window.close());
}

/** `core:window:allow-is-maximized`: for the maximize or restore icon. */
export function isWindowMaximized(): Promise<boolean> {
  return run((window) => window.isMaximized());
}

/** `core:window:allow-is-fullscreen`: macOS hides the traffic lights in full screen, so the toolbar inset shrinks. */
export function isWindowFullscreen(): Promise<boolean> {
  return run((window) => window.isFullscreen());
}
