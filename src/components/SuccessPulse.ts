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
let nonce = false;
const pending = new WeakMap<HTMLElement, () => void>();
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
  pending.get(target)?.();
  const detach = () => {
    target.removeEventListener('animationend', done);
    clearTimeout(fallback);
    pending.delete(target);
  };
  const cleanup = () => {
    detach();
    target.removeAttribute(ATTRIBUTE);
  };
  const done = (event: AnimationEvent) => {
    // The target's own ring only, not an animation of a descendant that bubbles up.
    if (event.target !== target || event.pseudoElement !== '::after') return;
    cleanup();
  };
  target.addEventListener('animationend', done);
  // A hidden or unmounted target never fires animationend: the timer cleans up anyway.
  const fallback = setTimeout(cleanup, MESSAGE_MS);
  pending.set(target, detach);

  announce(text);
}

/**
 * Hands `text` to the status bar's polite live region without a ring (a message that has no target: the welcome tour's step
 * announcements and its "skipped"). The same text again is announced again.
 */
export function announce(text: string): void {
  // Clear first, then alternate a zero-width mark so the region's text changes.
  nonce = !nonce;
  setMessage('');
  setMessage(nonce ? text : text + '​');
  clearTimeout(clearTimer);
  clearTimer = setTimeout(() => setMessage(''), MESSAGE_MS);
}
