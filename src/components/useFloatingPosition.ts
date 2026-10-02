import { useLayoutEffect, type RefObject } from 'react';

import { computePosition, type Align, type Side } from './position';
import { overlayOffset } from './tokens';

/** The element to stay next to: the element itself (kept in state) or a ref to it. A `display: contents` element stands for its first child. */
export type AnchorSource = HTMLElement | null | RefObject<HTMLElement | null>;

interface Options {
  anchor: AnchorSource;
  floatingRef: RefObject<HTMLElement | null>;
  /** Positioning runs while the floating element is mounted and `true`. */
  active: boolean;
  side: Side;
  align: Align;
}

/**
 * Places a `position: fixed` element next to its anchor (see `computePosition`) before the browser paints, and keeps it
 * there on resize, scroll and when its own size changes. The position is written to the element's style directly, so
 * the animation wrapper inside it can use `transform` freely. `data-side` reports the side after flipping.
 */
export function useFloatingPosition({ anchor: source, floatingRef, active, side, align }: Options): void {
  useLayoutEffect(() => {
    const node = source !== null && 'current' in source ? source.current : source;
    // A `display: contents` wrapper (Tooltip) has no box: its first child is the anchor.
    const anchor = node !== null && getComputedStyle(node).display === 'contents' ? node.firstElementChild : node;
    const floating = floatingRef.current;
    if (!active || anchor === null || floating === null) return;

    const update = () => {
      const gap = overlayOffset();
      const viewport = {
        width: document.documentElement.clientWidth || window.innerWidth,
        height: window.innerHeight,
      };
      // DESIGN 3.5: max height is the window minus the margin on both sides; the popover scrolls inside.
      floating.style.maxHeight = `${Math.max(0, viewport.height - 2 * gap)}px`;
      const placed = computePosition({
        anchor: anchor.getBoundingClientRect(),
        floating: floating.getBoundingClientRect(),
        viewport,
        side,
        align,
        offset: gap,
        margin: gap,
      });
      floating.style.left = `${placed.x}px`;
      floating.style.top = `${placed.y}px`;
      floating.dataset.side = placed.side;
    };

    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    const observer = new ResizeObserver(update);
    observer.observe(floating);
    observer.observe(anchor);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
      observer.disconnect();
    };
  }, [source, floatingRef, active, side, align]);
}
