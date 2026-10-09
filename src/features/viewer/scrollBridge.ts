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

/**
 * Whether a track animation of the main grid (the left panel or the inspector sliding, MOTION 3) is running. The grid sets it;
 * the canvas then does not hand its size on for every frame (no layout, no refit per frame) and anchors itself instead, and it
 * commits the final size once when this ends.
 */
let layoutAnimating = false;
const animationListeners = new Set<() => void>();

export function setLayoutAnimating(on: boolean): void {
  if (layoutAnimating === on) return;
  layoutAnimating = on;
  for (const listener of [...animationListeners]) listener();
}

export function isLayoutAnimating(): boolean {
  return layoutAnimating;
}

export function subscribeLayoutAnimating(listener: () => void): () => void {
  animationListeners.add(listener);
  return () => animationListeners.delete(listener);
}

/**
 * A jump to a page (go to page, thumbnail click, outline) is marked here by the action that asks for it, and taken by the canvas
 * when it scrolls there: only a jump may be animated (MOTION 4.8), a zoom or a change of mode puts the scroll position at once.
 */
let jumpMarkedAt = Number.NEGATIVE_INFINITY;
/** A mark that the canvas has not taken by now belonged to a jump that never scrolled. */
const JUMP_MARK_MS = 500;

export function markJump(): void {
  jumpMarkedAt = performance.now();
}

/** Whether the scroll that is about to happen is a jump; clears the mark. */
export function consumeJump(): boolean {
  const was = performance.now() - jumpMarkedAt <= JUMP_MARK_MS;
  jumpMarkedAt = Number.NEGATIVE_INFINITY;
  return was;
}

/**
 * Whoever started a jump (a comment click) waits for the scroll to end before the pulse: the canvas calls `endJump` when an
 * animated jump has finished or an instant one has landed. `waitForJumpEnd` also fires after `fallbackMs`, so a jump that never
 * scrolled (the target was already in view, a user scroll cancelled it) still pulses. One waiter at a time; a newer one replaces it.
 */
let jumpWaiter: (() => void) | null = null;

export function waitForJumpEnd(then: () => void, fallbackMs: number): void {
  let done = false;
  const fire = () => {
    if (done) return;
    done = true;
    if (typeof window !== 'undefined') window.clearTimeout(timer);
    if (jumpWaiter === fire) jumpWaiter = null;
    then();
  };
  const timer = window.setTimeout(fire, fallbackMs);
  jumpWaiter = fire;
}

/** Drops the waiter without firing it (a test ends, the viewer goes away). */
export function cancelJumpWait(): void {
  jumpWaiter = null;
}

export function endJump(): void {
  const waiter = jumpWaiter;
  jumpWaiter = null;
  waiter?.();
}

/**
 * The continuous scroll position of the canvas as page progress (F20.6): the page index plus how far the middle of the viewport is
 * through that page (below 0 or above 1 when it is in the gap), published on every scroll step. The thumbnail list follows it
 * proportionally. Not React state: a scroll must not render anything.
 */
export interface PageProgress {
  docId: number;
  progress: number;
}

let pageProgress: PageProgress | null = null;
const progressListeners = new Set<() => void>();

export function publishPageProgress(next: PageProgress): void {
  if (pageProgress !== null && pageProgress.docId === next.docId && pageProgress.progress === next.progress) return;
  pageProgress = next;
  for (const listener of [...progressListeners]) listener();
}

export function readPageProgress(): PageProgress | null {
  return pageProgress;
}

export function subscribePageProgress(listener: () => void): () => void {
  progressListeners.add(listener);
  return () => progressListeners.delete(listener);
}

/** The canvas shows no continuous scroll (paged mode, or no canvas): the list then follows the page that is reported. */
export function clearPageProgress(): void {
  pageProgress = null;
}
