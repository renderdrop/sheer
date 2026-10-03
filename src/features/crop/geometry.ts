import type { PageCrop, PageMedia } from '../../api/pages';
import { pageToView, type Rotation } from '../viewer/transform';

/** The smallest crop side, in points (ARCHITECTURE section 5, "Edit and protect"). */
export const MIN_CROP_PT = 72;

/** How close, in px on screen, an edge must come to the page's edge to snap to it. */
export const SNAP_PX = 6;

export type Side = keyof PageCrop;
export const SIDES: readonly Side[] = ['top', 'bottom', 'left', 'right'];

export const NO_MARGINS: PageCrop = { top: 0, right: 0, bottom: 0, left: 0 };

/**
 * The frame a page is cropped in: the MediaBox (the margins are measured from it) and the crop it has now (`bounds`, the margins of the
 * part that is shown). The rectangle stays inside `bounds`: what is not shown cannot be pointed at.
 */
export interface CropFrame {
  media: PageMedia;
  bounds: PageCrop;
}

/** A handle of the rectangle in page space: -1 is the left or top edge, 1 the right or bottom edge, 0 neither (both 0: the whole rectangle moves). */
export interface Handle {
  x: -1 | 0 | 1;
  y: -1 | 0 | 1;
}

export const HANDLES: readonly Handle[] = [
  { x: -1, y: -1 },
  { x: 0, y: -1 },
  { x: 1, y: -1 },
  { x: -1, y: 0 },
  { x: 1, y: 0 },
  { x: -1, y: 1 },
  { x: 0, y: 1 },
  { x: 1, y: 1 },
];

export const MOVE: Handle = { x: 0, y: 0 };

/** The page side that a view side (top, right, bottom, left of what is on screen) is, under the page's total rotation. */
export function pageSideOf(viewSide: Side, total: Rotation): Side {
  const table: Record<Rotation, Record<Side, Side>> = {
    0: { top: 'top', right: 'right', bottom: 'bottom', left: 'left' },
    90: { top: 'left', right: 'top', bottom: 'right', left: 'bottom' },
    180: { top: 'bottom', right: 'left', bottom: 'top', left: 'right' },
    270: { top: 'right', right: 'bottom', bottom: 'left', left: 'top' },
  };
  return table[total][viewSide];
}

/** A movement on screen (y down) as the movement in page space (`page` is the unrotated size). */
export function deltaToPage(dx: number, dy: number, total: Rotation): { x: number; y: number } {
  // A vector turns by the same quarter turns as a point, without the offset.
  switch (total) {
    case 90:
      return { x: dy, y: -dx };
    case 180:
      return { x: -dx, y: -dy };
    case 270:
      return { x: -dy, y: dx };
    default:
      return { x: dx, y: dy };
  }
}

/** The direction a page-space handle points on screen, for its cursor. */
export function viewHandle(handle: Handle, total: Rotation): Handle {
  const at = pageToView({ x: (handle.x + 1) / 2, y: (handle.y + 1) / 2 }, [1, 1], total);
  const sign = (n: number): -1 | 0 | 1 => (Math.abs(n) < 1e-9 ? 0 : n > 0 ? 1 : -1);
  return { x: sign(at.x - 0.5), y: sign(at.y - 0.5) };
}

/** The CSS cursor for a handle as it is seen on screen. */
export function cursorOf(view: Handle): string {
  if (view.x === 0 && view.y === 0) return 'move';
  if (view.x === 0) return 'ns-resize';
  if (view.y === 0) return 'ew-resize';
  return view.x === view.y ? 'nwse-resize' : 'nesw-resize';
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The rectangle of margins as a box in the coordinates of the shown part of the page, in points, y down. */
export function boxOf(margins: PageCrop, frame: CropFrame): Box {
  return {
    x: margins.left - frame.bounds.left,
    y: margins.top - frame.bounds.top,
    w: frame.media.width - margins.left - margins.right,
    h: frame.media.height - margins.top - margins.bottom,
  };
}

/** The margins that make `box` in the shown part (the inverse of `boxOf`). */
export function marginsOfBox(box: Box, frame: CropFrame): PageCrop {
  const left = box.x + frame.bounds.left;
  const top = box.y + frame.bounds.top;
  return { left, top, right: frame.media.width - left - box.w, bottom: frame.media.height - top - box.h };
}

/** Whether margins leave a rectangle of at least the minimum, inside the shown part. */
export function isValid(margins: PageCrop, frame: CropFrame): boolean {
  const box = boxOf(margins, frame);
  return (
    SIDES.every((side) => Number.isFinite(margins[side]) && margins[side] >= frame.bounds[side] - 1e-6) &&
    box.w >= MIN_CROP_PT - 1e-6 &&
    box.h >= MIN_CROP_PT - 1e-6
  );
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), Math.max(low, high));
}

/** Rounds to a quarter of a point: finer than any field shows, so a drag does not make the numbers jitter. */
function tidy(value: number): number {
  return Math.round(value * 4) / 4;
}

function tidyAll(m: PageCrop): PageCrop {
  return { left: tidy(m.left), top: tidy(m.top), right: tidy(m.right), bottom: tidy(m.bottom) };
}

function snapTo(value: number, target: number, tolerance: number): number {
  return Math.abs(value - target) <= tolerance ? target : value;
}

/** Brings margins into the allowed area: not outside the shown part, at least the minimum size. */
export function clampMargins(margins: PageCrop, frame: CropFrame): PageCrop {
  const { media, bounds } = frame;
  const left = clamp(margins.left, bounds.left, media.width - bounds.right - MIN_CROP_PT);
  const top = clamp(margins.top, bounds.top, media.height - bounds.bottom - MIN_CROP_PT);
  return {
    left,
    top,
    right: clamp(margins.right, bounds.right, media.width - left - MIN_CROP_PT),
    bottom: clamp(margins.bottom, bounds.bottom, media.height - top - MIN_CROP_PT),
  };
}

/**
 * The margins after `handle` was dragged by `dx, dy` points in page space from `start`. A handle moves its own edges, the centre
 * handle (`MOVE`) the whole rectangle (kept inside). `keepAspect` (Shift) keeps the ratio of the start rectangle on a corner. Edges snap to the
 * shown part's edges within `snap` points. The result is always valid.
 */
export function dragMargins(
  start: PageCrop,
  handle: Handle,
  dx: number,
  dy: number,
  frame: CropFrame,
  options: { keepAspect?: boolean; snap?: number } = {},
): PageCrop {
  const { media, bounds } = frame;
  const snap = options.snap ?? 0;
  if (handle.x === 0 && handle.y === 0) {
    let mx = clamp(dx, bounds.left - start.left, start.right - bounds.right);
    let my = clamp(dy, bounds.top - start.top, start.bottom - bounds.bottom);
    if (Math.abs(start.left + mx - bounds.left) <= snap) mx = bounds.left - start.left;
    else if (Math.abs(start.right - mx - bounds.right) <= snap) mx = start.right - bounds.right;
    if (Math.abs(start.top + my - bounds.top) <= snap) my = bounds.top - start.top;
    else if (Math.abs(start.bottom - my - bounds.bottom) <= snap) my = start.bottom - bounds.bottom;
    return tidyAll({ left: start.left + mx, right: start.right - mx, top: start.top + my, bottom: start.bottom - my });
  }
  let ddx = dx;
  let ddy = dy;
  if (options.keepAspect === true && handle.x !== 0 && handle.y !== 0) {
    const w = media.width - start.left - start.right;
    const h = media.height - start.top - start.bottom;
    const aspect = h > 0 ? w / h : 1;
    const nextW = w + handle.x * ddx;
    const nextH = h + handle.y * ddy;
    // The larger relative change decides; the other side follows.
    if (Math.abs(nextW - w) / Math.max(w, 1) >= Math.abs(nextH - h) / Math.max(h, 1)) {
      ddy = handle.y * (nextW / aspect - h);
    } else {
      ddx = handle.x * (nextH * aspect - w);
    }
  }
  const next = { ...start };
  if (handle.x === -1) next.left = snapTo(start.left + ddx, bounds.left, snap);
  if (handle.x === 1) next.right = snapTo(start.right - ddx, bounds.right, snap);
  if (handle.y === -1) next.top = snapTo(start.top + ddy, bounds.top, snap);
  if (handle.y === 1) next.bottom = snapTo(start.bottom - ddy, bounds.bottom, snap);
  return tidyAll(clampMargins(next, frame));
}

/** The handle that owns a page side (the keyboard resizes an edge with it). */
export function handleOfSide(side: Side): Handle {
  switch (side) {
    case 'left':
      return { x: -1, y: 0 };
    case 'right':
      return { x: 1, y: 0 };
    case 'top':
      return { x: 0, y: -1 };
    default:
      return { x: 0, y: 1 };
  }
}

/** The margins of a rectangle drawn from the point `a` to the point `b` (coordinates of the shown part), clamped and snapped. */
export function drawMargins(
  a: { x: number; y: number },
  b: { x: number; y: number },
  frame: CropFrame,
  snap = 0,
): PageCrop {
  const x0 = Math.min(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const raw = marginsOfBox({ x: x0, y: y0, w: Math.max(a.x, b.x) - x0, h: Math.max(a.y, b.y) - y0 }, frame);
  const { bounds } = frame;
  return tidyAll(
    clampMargins(
      {
        left: snapTo(raw.left, bounds.left, snap),
        top: snapTo(raw.top, bounds.top, snap),
        right: snapTo(raw.right, bounds.right, snap),
        bottom: snapTo(raw.bottom, bounds.bottom, snap),
      },
      frame,
    ),
  );
}
