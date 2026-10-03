import { useSyncExternalStore } from 'react';

function currentRatio(): number {
  const ratio = window.devicePixelRatio;
  return Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
}

/**
 * Calls `notify` whenever the display's pixel ratio changes: the window is moved to another monitor, the page is zoomed by the
 * browser, the OS scale is changed. A media query for the current ratio stops matching when it does, which is the event; the
 * query is made again for the new ratio each time.
 */
function subscribe(notify: () => void): () => void {
  let query: MediaQueryList | null = null;
  const onChange = () => {
    notify();
    watch();
  };
  const watch = () => {
    query?.removeEventListener('change', onChange);
    query = window.matchMedia(`(resolution: ${currentRatio()}dppx)`);
    query.addEventListener('change', onChange);
  };
  watch();
  return () => query?.removeEventListener('change', onChange);
}

/**
 * The display's device pixel ratio, kept up to date: 1 on an ordinary screen, 2 on a retina one. A page is rendered for the
 * zoom times this (the zoom bucket), so a change of it renders the pages again at the sharpness the new display can show.
 */
export function useDevicePixelRatio(): number {
  return useSyncExternalStore(subscribe, currentRatio, () => 1);
}
