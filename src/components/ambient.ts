/**
 * Ambient glow pause (MOTION spell 11): the drift and the splash breathe loops stop while the document is hidden (visibility only: Tauri focus events do not pause the glow). One
 * attribute on the root (`data-ambient="paused"`) is what the CSS reads, so no glow re-renders. Reference counted: the first
 * glow that mounts installs the listeners, the last one that unmounts removes them.
 */
export function ambientPaused(doc: Document): boolean {
  return doc.hidden;
}

let users = 0;
let stop: (() => void) | null = null;

function install(doc: Document): () => void {
  const root = doc.documentElement;
  const apply = () => {
    if (ambientPaused(doc)) root.setAttribute('data-ambient', 'paused');
    else root.removeAttribute('data-ambient');
  };
  doc.addEventListener('visibilitychange', apply);
  apply();
  return () => {
    doc.removeEventListener('visibilitychange', apply);
    root.removeAttribute('data-ambient');
  };
}

/** Starts following the window; returns the release. */
export function watchAmbient(doc: Document = document): () => void {
  if (users === 0) stop = install(doc);
  users += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    users -= 1;
    if (users === 0) {
      stop?.();
      stop = null;
    }
  };
}
