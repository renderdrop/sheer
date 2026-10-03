import type { Point, Rect } from '../../../api/wire';

/** Pure geometry for dragging out shapes (DESIGN 3.22). All numbers are page space (points). */

/** A drag shorter than this many points is a click. */
export const CLICK_SLOP_PT = 3;

/** The rectangle with the two points as opposite corners (never a negative size). */
export function boxFromPoints(a: Point, b: Point): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
}

/** `to` moved so that the box from `from` is a square (the longer side wins); the direction of the drag is kept. */
export function constrainSquare(from: Point, to: Point): Point {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const side = Math.max(Math.abs(dx), Math.abs(dy));
  return { x: from.x + (dx < 0 ? -side : side), y: from.y + (dy < 0 ? -side : side) };
}

/** `to` turned about `from` to the nearest multiple of 45 degrees, the length kept. */
export function snapAngle(from: Point, to: Point): Point {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return to;
  const step = Math.PI / 4;
  const angle = Math.round(Math.atan2(dy, dx) / step) * step;
  return { x: from.x + Math.cos(angle) * length, y: from.y + Math.sin(angle) * length };
}

/** A point held inside the page. */
export function clampToPage(point: Point, width: number, height: number): Point {
  return { x: Math.min(Math.max(point.x, 0), width), y: Math.min(Math.max(point.y, 0), height) };
}

/** Whether two points are farther apart than a click allows. */
export function isDrag(a: Point, b: Point): boolean {
  return Math.hypot(b.x - a.x, b.y - a.y) > CLICK_SLOP_PT;
}

/** A box of the given size with its top left at `at`, moved so that it lies inside the page. */
export function boxInPage(at: Point, w: number, h: number, pageW: number, pageH: number): Rect {
  const width = Math.min(w, pageW);
  const height = Math.min(h, pageH);
  return {
    x: Math.min(Math.max(at.x, 0), pageW - width),
    y: Math.min(Math.max(at.y, 0), pageH - height),
    w: width,
    h: height,
  };
}
