import { useEffect, useRef } from 'react';

import { drawnBox, flipTo, tokenMs } from './glide';
import { isFocusVisible } from './hooks';

/** Further than this between two targets the ring fades instead of gliding (MOTION spell 18). */
export const GLIDE_MAX_PX = 400;

/** Targets that never show a ring, as in the native rule of tokens.css (programmatic focus, canvas items). */
const NO_RING = '[tabindex="-1"], [data-annot-frame], [data-crop-rect], [data-form-control]';
/** What counts as one container: moving between two of them is a jump. */
const CONTAINER = '[role="toolbar"], [role="tablist"], [role="listbox"], [role="menu"], [role="dialog"], [data-region]';

const containerOf = (element: Element): Element => element.closest(CONTAINER) ?? document.body;

/**
 * The focus ring overlay (MOTION spell 18, DESIGN 2.1): one fixed box with `--ring-focus` that glides from the previous
 * keyboard-focus target to the next (FLIP with `transform`, final size laid out at once so the border is never left
 * stretched), takes the target's radius, and fades instead of gliding for jumps over 400 px or into another container.
 * Pointer focus shows no ring (`:focus-visible`). While it is mounted the native per-element ring is off
 * (`html[data-focus-glide]`, tokens.css R5-A). Mount once, in the shell.
 */
export function FocusRing() {
  const ring = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = ring.current;
    if (element === null) return;
    const root = document.documentElement;
    root.setAttribute('data-focus-glide', '');
    let target: HTMLElement | null = null;
    let frame = 0;
    let settle = 0;

    // The native ring steps aside only for the element the overlay draws (tokens.css R5-A): any other focus keeps it.
    let owned: HTMLElement | null = null;
    const own = (next: HTMLElement | null) => {
      if (owned === next) return;
      owned?.removeAttribute('data-focus-owned');
      next?.setAttribute('data-focus-owned', '');
      owned = next;
    };

    const hide = () => {
      own(null);
      target = null;
      element.style.opacity = '0';
    };

    const place = (animate: boolean, previous: HTMLElement | null) => {
      if (target === null || !target.isConnected) {
        hide();
        return;
      }
      const rect = target.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) {
        hide();
        return;
      }
      const to = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
      own(target);
      element.style.borderRadius = getComputedStyle(target).borderRadius;
      const from = animate ? drawnBox(element) : null;
      element.style.opacity = '1';
      const far =
        from !== null &&
        (previous === null ||
          containerOf(previous) !== containerOf(target) ||
          Math.hypot(
            from.left + from.width / 2 - (to.left + to.width / 2),
            from.top + from.height / 2 - (to.top + to.height / 2),
          ) > GLIDE_MAX_PX);
      flipTo(element, from, to, tokenMs('--motion-base', 160), { fade: far });
    };

    const focusTo = (next: HTMLElement | null) => {
      window.clearTimeout(settle);
      cancelAnimationFrame(frame);
      if (next === null || next === document.body || !isFocusVisible(next)) {
        hide();
        return;
      }
      // After the render that follows the focus (roving items get their tab stop then).
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (document.activeElement !== next || next.matches(NO_RING)) {
          hide();
          return;
        }
        const previous = target;
        target = next;
        place(true, previous);
      });
    };

    const onFocusIn = (event: FocusEvent) => focusTo(event.target instanceof HTMLElement ? event.target : null);

    // A pointer press hides the ring while focus stays put; the next navigation key brings it back (keyboard modality returns).
    const onKeyDown = (event: KeyboardEvent) => {
      if (target !== null || event.ctrlKey || event.metaKey || event.altKey) return;
      if (!/^(Tab|Arrow[A-Za-z]+|Home|End|PageUp|PageDown)$/.test(event.key)) return;
      const active = document.activeElement;
      if (active instanceof HTMLElement && active !== document.body) focusTo(active);
    };

    const onFocusOut = (event: FocusEvent) => {
      // Moving focus: the next focusin follows at once. Leaving the window or the document: no ring.
      if (event.relatedTarget === null) settle = window.setTimeout(hide, 0);
    };

    // The pointer ends keyboard modality: a click on the focused control must not keep the ring.
    const onPointerDown = () => hide();

    const reposition = () => {
      if (target === null || frame !== 0) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        place(false, target);
      });
    };

    document.addEventListener('focusin', onFocusIn, true);
    document.addEventListener('focusout', onFocusOut, true);
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('scroll', reposition, { capture: true, passive: true });
    window.addEventListener('resize', reposition);
    return () => {
      document.removeEventListener('focusin', onFocusIn, true);
      document.removeEventListener('focusout', onFocusOut, true);
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
      window.clearTimeout(settle);
      cancelAnimationFrame(frame);
      own(null);
      root.removeAttribute('data-focus-glide');
    };
  }, []);

  return (
    <div
      ref={ring}
      aria-hidden="true"
      data-focus-ring=""
      className="pointer-events-none fixed start-0 top-0 z-tooltip shadow-(--ring-focus) outline outline-transparent"
      style={{ opacity: 0 }}
    />
  );
}
