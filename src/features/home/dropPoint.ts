/** Cursor position of a file drag over the window, in logical px from its top-left, as the backend reports it (`dropHover {x, y}`). */
type Listener = (x: number, y: number) => void;

const listeners = new Set<Listener>();

export function noteDropPoint(x: number, y: number): void {
  for (const listener of listeners) listener(x, y);
}

/** Follows the reported positions; returns the unsubscribe. */
export function onDropPoint(listener: Listener): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}
