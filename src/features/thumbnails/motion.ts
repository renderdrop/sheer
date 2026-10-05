import { useLayoutEffect, useRef, useState, type RefObject } from 'react';

/** Motion helpers of the R5-C spells (MOTION v2): duration tokens in ms, the reduced-motion query, entrance and exit hooks. */

/** A duration token (`--motion-fast` is `120ms`) in ms, from the document; the spec's value when there is no stylesheet (tests). */
export function tokenMs(name: string, fallback: number): number {
  if (typeof document === 'undefined') return fallback;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) && raw.endsWith('ms') && value >= 0 ? value : fallback;
}

/** Whether the user asked for reduced motion (MOTION 1.7). Read at the moment of use, so a change applies to the next action. */
export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

/**
 * `false` for the first frame of an element and `true` from the second: the element is styled in its start state, the style is
 * flushed, and the change to the end state is then a transition (never an animation that reduced motion would cancel: the global
 * reduced-motion rule keeps the opacity transition and drops the rest).
 */
export function useSettled(ref: RefObject<Element | null>, enabled = true): boolean {
  const [settled, setSettled] = useState(false);
  const done = useRef(false);
  useLayoutEffect(() => {
    if (!enabled || done.current) return;
    done.current = true;
    // Reading the geometry flushes the start state's style, so that the next change is a transition.
    ref.current?.getBoundingClientRect();
    setSettled(true);
  }, [ref, enabled]);
  return settled;
}
