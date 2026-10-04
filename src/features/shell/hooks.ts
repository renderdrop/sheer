import { useCallback, useEffect, useLayoutEffect, useState, useSyncExternalStore } from 'react';

import { isWindowFullscreen, isWindowMaximized } from '../../api/window';
import type { Chrome } from '../../lib/platform';
import { useDocuments } from '../../stores/documents';
import { useUi } from '../../stores/ui';

function subscribeToFocus(notify: () => void): () => void {
  window.addEventListener('focus', notify);
  window.addEventListener('blur', notify);
  return () => {
    window.removeEventListener('focus', notify);
    window.removeEventListener('blur', notify);
  };
}

/** Whether the window has focus: an inactive window dims its title (DESIGN 2.2). */
export function useWindowFocused(): boolean {
  return useSyncExternalStore(
    subscribeToFocus,
    () => document.hasFocus(),
    () => true,
  );
}

export interface WindowState {
  maximized: boolean;
  fullscreen: boolean;
}

const NORMAL: WindowState = { maximized: false, fullscreen: false };

/**
 * A resize is over when no further `resize` event has come for this long. Dragging a window edge fires one per frame, and
 * each question to the window API is an IPC round trip, so the state is read once when the drag has settled.
 */
export const RESIZE_SETTLE_MS = 150;

/**
 * Whether the native window is maximized (the maximize or restore icon, Windows) or in full screen (the traffic-light
 * inset, macOS). Read from the window API at the start, once a resize has settled (`RESIZE_SETTLE_MS`, not per frame of a
 * drag) and on `refresh`, which a caption button calls after it has acted. It uses the DOM's `resize` event, not the window
 * API's own (that one needs the event permission, SECURITY T3). Only what the platform's chrome needs is asked for; a
 * failed read counts as "no".
 */
export function useWindowState(chrome: Chrome): WindowState & { refresh: () => void } {
  const [state, setState] = useState(NORMAL);
  const { caption, trafficLights } = chrome;

  const refresh = useCallback(() => {
    void Promise.all([
      caption ? isWindowMaximized().catch(() => false) : false,
      trafficLights ? isWindowFullscreen().catch(() => false) : false,
    ]).then(([maximized, fullscreen]) =>
      setState((previous) =>
        previous.maximized === maximized && previous.fullscreen === fullscreen ? previous : { maximized, fullscreen },
      ),
    );
  }, [caption, trafficLights]);

  useEffect(() => {
    if (!caption && !trafficLights) return;
    refresh();
    let timer: number | undefined;
    const onResize = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(refresh, RESIZE_SETTLE_MS);
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('resize', onResize);
    };
  }, [caption, trafficLights, refresh]);

  return { ...state, refresh };
}

/**
 * `value`, but only once it has stopped changing for `delayMs`. The status bar announces the page number this way, so a
 * screen reader hears "Page 3 of 120" after scrolling settles and not every page that went by (DESIGN 3.10).
 */
export function useSettledValue<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return settled;
}

/**
 * The view when the shell mounts (DESIGN v2 3): a document that is already active shows the editor, none shows Home. Later changes
 * follow the documents in the ui store itself.
 */
export function useViewSync(): void {
  useLayoutEffect(() => {
    useUi.getState().setView(useDocuments.getState().activeId === null ? 'home' : 'editor');
  }, []);
}
