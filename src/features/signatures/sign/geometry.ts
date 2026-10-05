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
