import { useSyncExternalStore } from 'react';

/**
 * The Iris success pulse (MOTION 4.7): it replaces confirmation dialogs. `pulse(target, message)` makes one ring pulse on the
 * target (a `pulse-target` element, whose radius is `--pulse-radius`) and hands `message` to the status bar's polite live
 * region (`usePulseMessage`). One call, one pulse, never a loop; a second call on the same target restarts it. Focus never
 * moves. Reduced motion and forced colors are handled by tokens.css.
 */

const ATTRIBUTE = 'data-pulse';

/** How long the announcement stays in the live region, ms. */
const MESSAGE_MS = 1200;

let message = '';
let clearTimer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

function setMessage(next: string): void {
  message = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The text for the polite live region of the status bar; empty when nothing is being announced. */
export function usePulseMessage(): string {
  return useSyncExternalStore(subscribe, () => message);
}

/** Pulses `target` once and announces `message`. The ring is removed when its animation ends. */
export function pulse(target: HTMLElement, text: string): void {
  // Restart: take the attribute off, force a style flush so the animation can start over, put it back.
  target.removeAttribute(ATTRIBUTE);
  void target.offsetWidth;
  target.setAttribute(ATTRIBUTE, '');
  const done = (event: AnimationEvent) => {
    // The target's own ring only, not an animation of a descendant that bubbles up.
    if (event.target !== target || event.pseudoElement !== '::after') return;
    target.removeEventListener('animationend', done);
    target.removeAttribute(ATTRIBUTE);
  };
  target.addEventListener('animationend', done);

  // An empty text sets the same value twice, which is no change; the timer restarts for every call.
  setMessage(text);
  clearTimeout(clearTimer);
  clearTimer = setTimeout(() => setMessage(''), MESSAGE_MS);
}
