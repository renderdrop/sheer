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
  /** Gap between anchor and floating element; the overlay offset (8 px) when left out. A submenu overlaps its parent: 0. */
  offset?: number;
  /** Shift along the other axis, see `computePosition`. */
  crossOffset?: number;
}

/**
 * Places a `position: fixed` element next to its anchor (see `computePosition`) before the browser paints, and keeps it
 * there on resize, scroll and when its own size changes. The position is written to the element's style directly, so
 * the animation wrapper inside it can use `transform` freely. `data-side` reports the side after flipping.
 *
 * The first placement runs at once, so the element never shows at the wrong place. Resize and scroll events (the scroll
 * listener is a capture listener on the window, so it hears every scrolling element, and a wheel gesture fires a lot of
 * them) only ask for a placement, and at most one runs per animation frame. The gap and margin (a token read, which is a
 * style lookup) are read once when positioning starts, and a style is only written when its value changed. A scroll
 * inside the floating element itself does not move it and asks for nothing.
 */
export function useFloatingPosition({
  anchor: source,
  floatingRef,
  active,
  side,
  align,
  offset,
  crossOffset,
}: Options): void {
  useLayoutEffect(() => {
    const node = source !== null && 'current' in source ? source.current : source;
    // A `display: contents` wrapper (Tooltip) has no box: its first child is the anchor.
    const anchor = node !== null && getComputedStyle(node).display === 'contents' ? node.firstElementChild : node;
    const floating = floatingRef.current;
    if (!active || anchor === null || floating === null) return;

    // Cached for as long as this positioning lasts: a token does not change while a popover is open.
    const gap = overlayOffset();
    const written = { maxHeight: '', left: '', top: '', side: '' };

    const update = () => {
      const viewport = {
        width: document.documentElement.clientWidth || window.innerWidth,
        height: window.innerHeight,
      };
      // DESIGN 3.5: max height is the window minus the margin on both sides; the popover scrolls inside.
      const maxHeight = `${Math.max(0, viewport.height - 2 * gap)}px`;
      if (maxHeight !== written.maxHeight) {
        floating.style.maxHeight = maxHeight;
        written.maxHeight = maxHeight;
      }
      const placed = computePosition({
        anchor: anchor.getBoundingClientRect(),
        floating: floating.getBoundingClientRect(),
        viewport,
        side,
        align,
        offset: offset ?? gap,
        margin: gap,
        crossOffset,
      });
      const left = `${placed.x}px`;
      const top = `${placed.y}px`;
      if (left !== written.left) {
        floating.style.left = left;
        written.left = left;
      }
      if (top !== written.top) {
        floating.style.top = top;
        written.top = top;
      }
      if (placed.side !== written.side) {
        floating.dataset.side = placed.side;
        written.side = placed.side;
      }
    };

    // At most one placement per frame, however many events came in.
    let frame = 0;
    const schedule = (event?: Event) => {
      if (event?.target instanceof Node && floating.contains(event.target)) return;
      if (frame !== 0) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        update();
      });
    };

    update();
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, true);
    // Size changes arrive once per frame already, before paint: no extra throttle, and the new size is placed at once.
    const observer = new ResizeObserver(update);
    observer.observe(floating);
    observer.observe(anchor);
    return () => {
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, true);
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [source, floatingRef, active, side, align, offset, crossOffset]);
}
