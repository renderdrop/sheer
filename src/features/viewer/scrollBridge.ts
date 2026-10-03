import type { ScrollPosition } from './layout';

/**
 * How the viewer's actions (a zoom step from the keyboard, a jump to a page) learn where the canvas is scrolled to. The actions
 * live in a store and know no DOM; the canvas registers a function that reads its scroll region while it is mounted. Where there is
 * no canvas (a test, the empty state) the position is the origin.
 */
let source: (() => ScrollPosition) | null = null;

/** Registers the canvas's scroll position. Returns the function that unregisters it (only if it is still the registered one). */
export function registerScrollSource(read: () => ScrollPosition): () => void {
  source = read;
  return () => {
    if (source === read) source = null;
  };
}

/** Where the canvas is scrolled to now. */
export function readScroll(): ScrollPosition {
  return source?.() ?? { left: 0, top: 0 };
}

/** The part of the content the viewport shows, in content px (the scroll position and the viewport's size). */
export interface ViewRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const NOTHING: ViewRect = { left: 0, top: 0, right: 0, bottom: 0 };
let view: ViewRect = NOTHING;
const listeners = new Set<() => void>();

/**
 * Publishes what the viewport shows now. A page that is rendered in tiles (only the ones in view) follows it, and nothing else
 * does: the pages that fit one frame never look at it, so a scroll does not render them.
 */
export function publishViewRect(next: ViewRect): void {
  if (next.left === view.left && next.top === view.top && next.right === view.right && next.bottom === view.bottom)
    return;
  view = next;
  for (const listener of [...listeners]) listener();
}

export function readViewRect(): ViewRect {
  return view;
}

export function subscribeViewRect(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
