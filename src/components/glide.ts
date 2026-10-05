import { useLayoutEffect, useRef, type RefObject } from 'react';

/** The reduced-motion preference right now (MOTION 1.7). */
export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

/** A duration token (`--motion-base`) in ms; the fallback is for environments without the stylesheet. */
const tokenCache = new Map<string, number>();
export function tokenMs(name: string, fallback: number): number {
  const cached = tokenCache.get(name);
  if (cached !== undefined) return cached;
  if (typeof document === 'undefined') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const ms = value.endsWith('ms')
    ? Number.parseFloat(value)
    : value.endsWith('s')
      ? Number.parseFloat(value) * 1000
      : NaN;
  // Only a read value is cached: a missing stylesheet (tests) must not stick.
  if (!Number.isFinite(ms)) return fallback;
  tokenCache.set(name, ms);
  return ms;
}

/** `--ease-out`, the one curve (MOTION 1.1). */
export const EASE_OUT = 'cubic-bezier(0.2, 0, 0, 1)';

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

const box = (rect: DOMRect): Box => ({ left: rect.left, top: rect.top, width: rect.width, height: rect.height });

/** Calls `onEnd` when the animation finishes; a cancelled one (retarget in mid-glide) is not an end. */
function watchEnd(animation: Animation, onEnd: (() => void) | undefined): void {
  if (onEnd === undefined) return;
  void animation.finished.then(onEnd, () => undefined);
}

/**
 * FLIP for one shared element (MOTION spells 1, 18, 21): the element already sits at its final geometry (set here as
 * left/top/width/height, never animated); the animation is only `transform` from the previous visual box to the identity.
 * The previous box is read from the element as it is drawn, so a retarget in mid-glide starts from where it is.
 */
export function flipTo(
  element: HTMLElement,
  from: Box | null,
  to: Box,
  durationMs: number,
  options: { fade?: boolean; onEnd?: () => void } = {},
): void {
  const { onEnd } = options;
  const running = element.getAnimations?.() ?? [];
  for (const animation of running) animation.cancel();
  element.style.transformOrigin = '0 0';
  element.style.left = '0px';
  element.style.top = '0px';
  element.style.width = `${to.width}px`;
  element.style.height = `${to.height}px`;
  element.style.translate = `${to.left}px ${to.top}px`;
  if (typeof element.animate !== 'function' || from === null || prefersReducedMotion() || durationMs <= 0) {
    onEnd?.();
    return;
  }
  const moved =
    Math.abs(from.left - to.left) > 0.5 ||
    Math.abs(from.top - to.top) > 0.5 ||
    Math.abs(from.width - to.width) > 0.5 ||
    Math.abs(from.height - to.height) > 0.5;
  if (!moved) {
    onEnd?.();
    return;
  }
  const timing = { duration: durationMs, easing: EASE_OUT } as const;
  if (options.fade === true) {
    watchEnd(element.animate([{ opacity: 0 }, { opacity: 1 }], timing), onEnd);
    return;
  }
  const sx = to.width === 0 ? 1 : from.width / to.width;
  const sy = to.height === 0 ? 1 : from.height / to.height;
  watchEnd(
    element.animate(
      [
        { transform: `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${sx}, ${sy})` },
        { transform: 'none' },
      ],
      timing,
    ),
    onEnd,
  );
}

/** The element's drawn box (with a running transform), or null when it is not shown. */
export function drawnBox(element: HTMLElement): Box | null {
  if (element.style.opacity === '0') return null;
  return box(element.getBoundingClientRect());
}

/**
 * A pill that glides to the active item of a container (spells 1 and 21). The pill is an absolutely positioned child
 * of `container` (which is `relative`); it is placed at the target selected by `selector` after every render and
 * glides only when `activeKey` changed. Without a target it is hidden; reduced motion places it at once.
 */
export function useGlidePill(
  container: RefObject<HTMLElement | null>,
  selector: string,
  activeKey: string | null,
  durationToken: '--motion-fast' | '--motion-base',
  /** Called when a glide to a new `activeKey` ends, and at once when it is placed without one (label weight swap). */
  onGlideEnd?: () => void,
): RefObject<HTMLSpanElement | null> {
  const pill = useRef<HTMLSpanElement>(null);
  const last = useRef<string | null>(null);

  useLayoutEffect(() => {
    const host = container.current;
    const element = pill.current;
    if (host === null || element === null) return;
    const target = activeKey === null ? null : host.querySelector<HTMLElement>(selector);
    if (target === null) {
      element.style.opacity = '0';
      last.current = activeKey;
      return;
    }
    const hostRect = host.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const to: Box = {
      left: targetRect.left - hostRect.left - host.clientLeft,
      top: targetRect.top - hostRect.top - host.clientTop,
      width: targetRect.width,
      height: targetRect.height,
    };
    const from = last.current !== activeKey ? drawnBox(element) : null;
    const origin = hostRect;
    const fromLocal: Box | null =
      from === null
        ? null
        : { ...from, left: from.left - origin.left - host.clientLeft, top: from.top - origin.top - host.clientTop };
    element.style.opacity = '1';
    flipTo(element, fromLocal, to, tokenMs(durationToken, durationToken === '--motion-fast' ? 120 : 160), {
      onEnd: last.current !== activeKey ? onGlideEnd : undefined,
    });
    last.current = activeKey;
  });

  return pill;
}
