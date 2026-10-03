import type { Annotation, AnnotationPatch, Stroke } from '../../../api/annotations';
import type { PageSize } from '../../../api/render';
import type { Point, Rect } from '../../../api/wire';

/**
 * The geometry of selecting, moving and resizing annotations (DESIGN 3.23), all in page space (points, y down, before any
 * rotation). Pure functions: the layer feeds them pointer and key deltas and draws what they return; the backend computes the real
 * bounding box when the command arrives, so everything here is only the preview.
 */

/** Handles: the eight of a box, the two ends of a line (`from`, `to`). Ink uses the four corners. */
export type HandleId = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw' | 'from' | 'to';

/** The smallest a resized annotation gets, in points. */
export const MIN_SIZE_PT = 4;

const BOX_HANDLES: readonly HandleId[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const CORNER_HANDLES: readonly HandleId[] = ['nw', 'ne', 'se', 'sw'];

/** The handles an annotation shows when it is the only one selected; none for what cannot be resized or is locked. */
export function handlesOf(a: Annotation): readonly HandleId[] {
  if (a.locked) return [];
  switch (a.kind) {
    case 'rect':
    case 'ellipse':
    case 'freeText':
      return BOX_HANDLES;
    case 'line':
      return ['from', 'to'];
    case 'ink':
      return CORNER_HANDLES;
    default:
      return [];
  }
}

/** Whether the annotation can be moved: not locked, and not one the app never changes. */
export function canMove(a: Annotation): boolean {
  return !a.locked && a.kind !== 'opaque';
}

/** Where a handle sits on a frame. */
export function handlePoint(frame: Rect, a: Annotation, handle: HandleId): Point {
  if (a.kind === 'line') return handle === 'from' ? a.from : a.to;
  const left = frame.x;
  const right = frame.x + frame.w;
  const top = frame.y;
  const bottom = frame.y + frame.h;
  const midX = frame.x + frame.w / 2;
  const midY = frame.y + frame.h / 2;
  const x = handle.includes('w') ? left : handle.includes('e') ? right : midX;
  const y = handle.includes('n') ? top : handle.includes('s') ? bottom : midY;
  return { x, y };
}

/** The cursor of a handle (CSS names). */
export function handleCursor(handle: HandleId): string {
  switch (handle) {
    case 'n':
    case 's':
      return 'ns-resize';
    case 'e':
    case 'w':
      return 'ew-resize';
    case 'ne':
    case 'sw':
      return 'nesw-resize';
    case 'from':
    case 'to':
      return 'crosshair';
    default:
      return 'nwse-resize';
  }
}

const shiftPoint = (p: Point, dx: number, dy: number): Point => ({ x: p.x + dx, y: p.y + dy });
const shiftRect = (r: Rect, dx: number, dy: number): Rect => ({ x: r.x + dx, y: r.y + dy, w: r.w, h: r.h });
const shiftStroke = (s: Stroke, dx: number, dy: number): Stroke => ({
  points: s.points.map((p) => shiftPoint(p, dx, dy)),
  outline: s.outline.map((p) => shiftPoint(p, dx, dy)),
});

/** The annotation moved by (`dx`, `dy`). */
export function translated(a: Annotation, dx: number, dy: number): Annotation {
  if (dx === 0 && dy === 0) return a;
  const rect = shiftRect(a.rect, dx, dy);
  switch (a.kind) {
    case 'highlight':
    case 'underline':
    case 'strikeout':
      return {
        ...a,
        rect,
        quads: a.quads.map((q) => [
          shiftPoint(q[0], dx, dy),
          shiftPoint(q[1], dx, dy),
          shiftPoint(q[2], dx, dy),
          shiftPoint(q[3], dx, dy),
        ]),
      };
    case 'note':
      return { ...a, rect, at: shiftPoint(a.at, dx, dy) };
    case 'freeText':
    case 'rect':
    case 'ellipse':
      return { ...a, rect, box: shiftRect(a.box, dx, dy) };
    case 'ink':
      return { ...a, rect, strokes: a.strokes.map((s) => shiftStroke(s, dx, dy)) };
    case 'line':
      return { ...a, rect, from: shiftPoint(a.from, dx, dy), to: shiftPoint(a.to, dx, dy) };
    default:
      return { ...a, rect };
  }
}

const clamp = (value: number, low: number, high: number): number => Math.min(Math.max(value, low), high);

/** The union of rectangles; `null` for none. */
export function unionOf(rects: readonly Rect[]): Rect | null {
  let x0 = Number.POSITIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  for (const r of rects) {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w);
    y1 = Math.max(y1, r.y + r.h);
  }
  return Number.isFinite(x0) ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

/** A move limited so that the union of `rects` stays on the page. Without a page size the move is as it is. */
export function clampMove(rects: readonly Rect[], dx: number, dy: number, page: PageSize | null): Point {
  const box = unionOf(rects);
  if (box === null || page === null) return { x: dx, y: dy };
  const x = box.w >= page[0] ? 0 : clamp(dx, -box.x, page[0] - box.x - box.w);
  const y = box.h >= page[1] ? 0 : clamp(dy, -box.y, page[1] - box.y - box.h);
  return { x, y };
}

/**
 * A rectangle with one handle dragged by (`dx`, `dy`): the opposite edges stay, the result stays on the page and at least
 * `MIN_SIZE_PT` in each direction. `keepAspect` scales a corner proportionally.
 */
export function resizeRect(
  frame: Rect,
  handle: HandleId,
  dx: number,
  dy: number,
  keepAspect: boolean,
  page: PageSize | null,
): Rect {
  let x0 = frame.x;
  let y0 = frame.y;
  let x1 = frame.x + frame.w;
  let y1 = frame.y + frame.h;
  if (handle.includes('w')) x0 += dx;
  if (handle.includes('e')) x1 += dx;
  if (handle.includes('n')) y0 += dy;
  if (handle.includes('s')) y1 += dy;
  if (page !== null) {
    x0 = clamp(x0, 0, page[0]);
    x1 = clamp(x1, 0, page[0]);
    y0 = clamp(y0, 0, page[1]);
    y1 = clamp(y1, 0, page[1]);
  }
  const minW = Math.min(MIN_SIZE_PT, frame.w);
  const minH = Math.min(MIN_SIZE_PT, frame.h);
  if (handle.includes('w')) x0 = Math.min(x0, x1 - minW);
  else if (handle.includes('e')) x1 = Math.max(x1, x0 + minW);
  if (handle.includes('n')) y0 = Math.min(y0, y1 - minH);
  else if (handle.includes('s')) y1 = Math.max(y1, y0 + minH);
  if (keepAspect && handle.length === 2 && frame.w > 0 && frame.h > 0) {
    const scale = Math.max((x1 - x0) / frame.w, (y1 - y0) / frame.h);
    const w = frame.w * scale;
    const h = frame.h * scale;
    if (handle.includes('w')) x0 = x1 - w;
    else x1 = x0 + w;
    if (handle.includes('n')) y0 = y1 - h;
    else y1 = y0 + h;
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** The map from one rectangle onto another, applied to points. */
function mapPoint(p: Point, from: Rect, to: Rect): Point {
  const sx = from.w > 0 ? to.w / from.w : 1;
  const sy = from.h > 0 ? to.h / from.h : 1;
  return { x: to.x + (p.x - from.x) * sx, y: to.y + (p.y - from.y) * sy };
}

/**
 * The annotation with a handle dragged by (`dx`, `dy`), or `null` when it has no such handle. The frame the handles sit on is the
 * box for Rectangle, Ellipse and Text, the bounding box for Ink; a line moves one end.
 */
export function resized(
  a: Annotation,
  handle: HandleId,
  dx: number,
  dy: number,
  keepAspect: boolean,
  page: PageSize | null,
): Annotation | null {
  if (!handlesOf(a).includes(handle)) return null;
  switch (a.kind) {
    case 'line': {
      const moved = (p: Point): Point => ({
        x: page === null ? p.x + dx : clamp(p.x + dx, 0, page[0]),
        y: page === null ? p.y + dy : clamp(p.y + dy, 0, page[1]),
      });
      const from = handle === 'from' ? moved(a.from) : a.from;
      const to = handle === 'to' ? moved(a.to) : a.to;
      const margin = a.width / 2;
      const x0 = Math.min(from.x, to.x) - margin;
      const y0 = Math.min(from.y, to.y) - margin;
      return {
        ...a,
        from,
        to,
        rect: { x: x0, y: y0, w: Math.max(from.x, to.x) + margin - x0, h: Math.max(from.y, to.y) + margin - y0 },
      };
    }
    case 'rect':
    case 'ellipse':
    case 'freeText': {
      const box = resizeRect(a.box, handle, dx, dy, keepAspect, page);
      // The bounding box keeps its margin around the box (the stroke, the backend's padding).
      const rect = {
        x: box.x - (a.box.x - a.rect.x),
        y: box.y - (a.box.y - a.rect.y),
        w: box.w + (a.rect.w - a.box.w),
        h: box.h + (a.rect.h - a.box.h),
      };
      return { ...a, box, rect };
    }
    case 'ink': {
      const rect = resizeRect(a.rect, handle, dx, dy, keepAspect, page);
      const map = (p: Point) => mapPoint(p, a.rect, rect);
      return {
        ...a,
        rect,
        strokes: a.strokes.map((s) => ({ points: s.points.map(map), outline: s.outline.map(map) })),
      };
    }
    default:
      return null;
  }
}

/** The patch that makes the stored annotation what its resized preview shows (what `updateAnnotation` carries). */
export function patchOf(draft: Annotation): AnnotationPatch {
  switch (draft.kind) {
    case 'rect':
    case 'ellipse':
    case 'freeText':
      return { box: draft.box };
    case 'line':
      return { from: draft.from, to: draft.to };
    case 'ink':
      return { strokes: draft.strokes };
    default:
      return {};
  }
}

/** A key that nudges or resizes: the unit step in x and y. */
export function arrowStep(key: string): Point | null {
  switch (key) {
    case 'ArrowLeft':
      return { x: -1, y: 0 };
    case 'ArrowRight':
      return { x: 1, y: 0 };
    case 'ArrowUp':
      return { x: 0, y: -1 };
    case 'ArrowDown':
      return { x: 0, y: 1 };
    default:
      return null;
  }
}

/** Annotations in reading order: top to bottom, then left to right (the order of the tab stops, DESIGN 3.23). */
export function readingOrder<T extends { rect: Rect; id: number }>(list: readonly T[]): T[] {
  return [...list].sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x || a.id - b.id);
}
