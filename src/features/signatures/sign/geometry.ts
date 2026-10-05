import type { Point, Rect } from '../../../api/wire';
import { SEAL_DEFAULT, SEAL_INSET_PT, SEAL_MIN } from './run';

type Page = readonly [number, number];

/** Moves a box so that it lies inside the page, keeping `inset` points from the edge where the page is big enough. */
export function keepInside(rect: Rect, page: Page, inset = 0): Rect {
  const fit = (pos: number, size: number, side: number) => {
    const lo = Math.min(inset, Math.max(0, (side - size) / 2));
    return Math.min(Math.max(pos, lo), Math.max(lo, side - size - lo));
  };
  return { x: fit(rect.x, rect.w, page[0]), y: fit(rect.y, rect.h, page[1]), w: rect.w, h: rect.h };
}

/** A click: the default box centred on the point, clamped inside the page with the 12 pt inset (S3). */
export function boxAtClick(at: Point, page: Page): Rect {
  const w = Math.min(SEAL_DEFAULT.w, page[0]);
  const h = Math.min(SEAL_DEFAULT.h, page[1]);
  return keepInside({ x: at.x - w / 2, y: at.y - h / 2, w, h }, page, SEAL_INSET_PT);
}

/** A drag: the box between two corners, at least the minimum size (it grows away from the start) and inside the page. */
export function boxFromDrag(from: Point, to: Point, page: Page): Rect {
  const w = Math.min(Math.max(Math.abs(to.x - from.x), SEAL_MIN.w), page[0]);
  const h = Math.min(Math.max(Math.abs(to.y - from.y), SEAL_MIN.h), page[1]);
  const x = to.x < from.x ? from.x - w : from.x;
  const y = to.y < from.y ? from.y - h : from.y;
  return keepInside({ x, y, w, h }, page);
}

/** Moves a box by `dx`, `dy` points (arrow keys: 1, Shift: 10), inside the page. */
export function nudge(rect: Rect, dx: number, dy: number, page: Page): Rect {
  return keepInside({ ...rect, x: rect.x + dx, y: rect.y + dy }, page);
}

/** The 8 resize handles of the placeholder: -1 is the left / top edge, 1 the right / bottom edge, 0 the middle (page space, y down). */
export const SEAL_HANDLES: readonly { hx: -1 | 0 | 1; hy: -1 | 0 | 1 }[] = [
  { hx: -1, hy: -1 },
  { hx: 0, hy: -1 },
  { hx: 1, hy: -1 },
  { hx: 1, hy: 0 },
  { hx: 1, hy: 1 },
  { hx: 0, hy: 1 },
  { hx: -1, hy: 1 },
  { hx: -1, hy: 0 },
];

/**
 * Drags the edges named by handle (`hx`, `hy`) to the point `to`. The box never gets smaller than the minimum and never leaves the
 * page's 12 pt inset (DESIGN 3.8 L6); the edges that are not dragged stay.
 */
export function resizeTo(rect: Rect, hx: -1 | 0 | 1, hy: -1 | 0 | 1, to: Point, page: Page): Rect {
  const edge = (pos: number, size: number, h: -1 | 0 | 1, target: number, min: number, side: number) => {
    if (h === 0) return { pos, size };
    const inset = side >= min + 2 * SEAL_INSET_PT ? SEAL_INSET_PT : 0;
    const end = pos + size;
    if (h === -1) {
      const lo = Math.min(Math.max(target, inset), end - min);
      return { pos: lo, size: end - lo };
    }
    const hi = Math.max(Math.min(target, side - inset), pos + min);
    return { pos, size: hi - pos };
  };
  const x = edge(rect.x, rect.w, hx, to.x, SEAL_MIN.w, page[0]);
  const y = edge(rect.y, rect.h, hy, to.y, SEAL_MIN.h, page[1]);
  return { x: x.pos, y: y.pos, w: x.size, h: y.size };
}

/**
 * Keyboard resize: the corner at (`sx`, `sy`) (the signs of the view's bottom-right corner in page space) moves by `dx`, `dy` points.
 */
export function resizeBy(rect: Rect, sx: -1 | 1, sy: -1 | 1, dx: number, dy: number, page: Page): Rect {
  const corner = { x: sx > 0 ? rect.x + rect.w : rect.x, y: sy > 0 ? rect.y + rect.h : rect.y };
  return resizeTo(rect, sx, sy, { x: corner.x + dx, y: corner.y + dy }, page);
}
