import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';

import {
  computePlacement,
  computePosition,
  gapOf,
  type Align,
  type FloatingKind,
  type PositionResult,
  type Side,
} from './position';
import { protectedRects } from './protect';
import { overlayOffset, tokenPx } from './tokens';

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
  /**
   * Keeps the element horizontally inside the content box of this element (a scroller's width without its scrollbar), `inset`
   * px from its edges, on top of the window margin. Looked up on every placement, so a slot that appears later is honoured.
   */
  clampTo?: { selector: string; inset: number };
  /**
   * An element the floating box must not cover while it sits below its anchor: it is moved down to clear this element's bottom
   * edge (the tour card below the top bar must not hide the tool row). Ignored when the element is not there or lies above.
   */
  clearOf?: string;
  /**
   * The engine of DESIGN 3.9 Q8: placement order per kind, flip, shift and collision with protected elements (see
   * `protectedRects`). Without a kind the legacy flip-and-clamp placement runs.
   */
  kind?: FloatingKind;
  /**
   * Called when no candidate fits (Q8). A popover turns itself into a dialog here. Without it a tooltip, a tip and a coach mark become
   * invisible until they fit again, and every other kind takes the best geometric placement.
   */
  onNoFit?: () => void;
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
  clampTo,
  clearOf,
  kind,
  onNoFit,
}: Options): void {
  const onNoFitRef = useRef(onNoFit);
  useEffect(() => {
    onNoFitRef.current = onNoFit;
  });
  const clampSelector = clampTo?.selector;
  const clampInset = clampTo?.inset;
  useLayoutEffect(() => {
    const node = source !== null && 'current' in source ? source.current : source;
    // A `display: contents` wrapper (Tooltip) has no box: its first child is the anchor.
    const anchor = node !== null && getComputedStyle(node).display === 'contents' ? node.firstElementChild : node;
    const floating = floatingRef.current;
    if (!active || anchor === null || floating === null) return;

    // Cached for as long as this positioning lasts: a token does not change while a popover is open.
    const gap = overlayOffset();
    const written = { maxHeight: '', left: '', top: '', side: '', visibility: '' };

    const update = () => {
      const viewport = {
        width: document.documentElement.clientWidth || window.innerWidth,
        height: window.innerHeight,
      };
      const anchorBox = anchor.getBoundingClientRect();
      // DESIGN 3.5: max height is the window minus the margin on both sides; the popover scrolls inside. A menu is a list that
      // scrolls (Q7) and never covers its anchor, so it is also held to the room on the roomier side of the anchor.
      let room = viewport.height - 2 * gap;
      if (kind === 'menu') {
        const below = viewport.height - anchorBox.bottom - 2 * gap;
        const above = anchorBox.top - 2 * gap;
        room = Math.min(room, Math.max(below, above));
      }
      const maxHeight = `${Math.max(0, room)}px`;
      if (maxHeight !== written.maxHeight) {
        floating.style.maxHeight = maxHeight;
        written.maxHeight = maxHeight;
      }
      const floatingBox = floating.getBoundingClientRect();
      let placed: PositionResult | null;
      if (kind === undefined) {
        placed = computePosition({
          anchor: anchorBox,
          floating: floatingBox,
          viewport,
          side,
          align,
          offset: offset ?? gap,
          margin: gap,
          crossOffset,
        });
      } else {
        const slotBox = clampSelector === undefined ? null : document.querySelector<HTMLElement>(clampSelector);
        const clearEl = clearOf === undefined ? null : document.querySelector<HTMLElement>(clearOf);
        const clearBottom = clearEl?.getBoundingClientRect().bottom;
        placed = computePlacement({
          // The slot and the row to clear are part of the placement, so a candidate is tested where it ends up.
          minTop: clearBottom === undefined ? undefined : clearBottom + gap,
          xRange:
            slotBox === null
              ? undefined
              : {
                  min: slotBox.getBoundingClientRect().left + slotBox.clientLeft + (clampInset ?? 0),
                  max:
                    slotBox.getBoundingClientRect().left + slotBox.clientLeft + slotBox.clientWidth - (clampInset ?? 0),
                },
          anchor: anchorBox,
          // The content's own height: the max-height above clamps the box, but a popover that is taller does not fit.
          floating: { width: floatingBox.width, height: Math.max(floatingBox.height, floating.scrollHeight) },
          viewport,
          kind,
          side,
          align,
          offset: offset ?? (kind === 'coach' ? tokenPx('--space-3', gapOf(kind)) : gap),
          margin: gap,
          crossOffset,
          protectedRects: protectedRects(kind, anchor, floating),
        });
        if (placed === null) {
          if (onNoFitRef.current !== undefined) {
            onNoFitRef.current();
            return;
          }
          if (kind === 'tooltip' || kind === 'tip' || kind === 'coach') {
            // Not shown (Q8): the surface keeps its box but is invisible, and is tried again on every layout change.
            if (written.visibility !== 'hidden') {
              floating.style.visibility = 'hidden';
              written.visibility = 'hidden';
            }
            return;
          }
          placed = computePosition({
            anchor: anchorBox,
            floating: floatingBox,
            viewport,
            side,
            align,
            offset: offset ?? gap,
            margin: gap,
            crossOffset,
          });
        }
        if (written.visibility !== '') {
          floating.style.visibility = '';
          written.visibility = '';
        }
      }
      let x = placed.x;
      const slot = clampSelector === undefined ? null : document.querySelector<HTMLElement>(clampSelector);
      if (slot !== null) {
        const box = slot.getBoundingClientRect();
        const low = box.left + slot.clientLeft + (clampInset ?? 0);
        const high =
          box.left + slot.clientLeft + slot.clientWidth - (clampInset ?? 0) - floating.getBoundingClientRect().width;
        x = Math.max(low, Math.min(x, Math.max(low, high)));
      }
      let y = placed.y;
      const avoid =
        clearOf === undefined || placed.side !== 'bottom' ? null : document.querySelector<HTMLElement>(clearOf);
      if (avoid !== null) {
        const below = avoid.getBoundingClientRect().bottom + gap;
        const own = floating.getBoundingClientRect().height;
        if (below > y && below + own <= viewport.height - gap) y = below;
      }
      const left = `${x}px`;
      const top = `${y}px`;
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
    // A notice (Q8) may not cover any button: a banner that mounts or finishes its reveal after the first placement moves the
    // protected rects without any resize, so the DOM and the end of a transition or animation place it again.
    const notice = kind === 'coach' || kind === 'tip';
    const mutations = notice ? new MutationObserver(() => schedule()) : null;
    mutations?.observe(document.body, { childList: true, subtree: true });
    if (notice) {
      document.addEventListener('transitionend', schedule, true);
      document.addEventListener('animationend', schedule, true);
    }
    return () => {
      mutations?.disconnect();
      document.removeEventListener('transitionend', schedule, true);
      document.removeEventListener('animationend', schedule, true);
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, true);
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [source, floatingRef, active, side, align, offset, crossOffset, clampSelector, clampInset, clearOf, kind]);
}
