import type { Annotation, AnnotationPatch, Stroke } from '../../../api/annotations';
import type { PageSize } from '../../../api/render';
import type { Point, Rect } from '../../../api/wire';

/**
 * The geometry of selecting, moving and resizing annotations (DESIGN 3.23), all in page space (points, y down, before any
 * rotation). Pure functions: the layer feeds them pointer and key deltas and draws what they return; the backend computes the real
 * bounding box when the command arrives, so everything here is only the preview.
 */

/** Handles: the eight of a box, the two ends of a line (`from`, `to`). Ink uses the four corners. */
export type HandleId = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw' | 'from' | 'to' | 'rotate';

/** The smallest a resized annotation gets, in points. */
export const MIN_SIZE_PT = 4;
/** The smallest a stamp gets (the backend refuses less, `model/stamp.rs`). */
export const STAMP_MIN_W_PT = 24;
export const STAMP_MIN_H_PT = 12;
/** How far above the top edge of a signature the rotate handle sits, in points (ADR-105); `--annot-rotate-offset` in tokens.css (test). */
export const ROTATE_OFFSET_PT = 18;
/** Shift snaps the rotation to multiples of this, in degrees. */
export const ROTATE_SNAP_DEG = 15;

const BOX_HANDLES: readonly HandleId[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const CORNER_HANDLES: readonly HandleId[] = ['nw', 'ne', 'se', 'sw'];

/** The turn of a signature or a mark in degrees, clockwise on the page; 0 for every other kind. */
export function angleOf(a: Annotation): number {
  return (a.kind === 'signature' || a.kind === 'mark' ? a.angle : undefined) ?? 0;
}

/** An angle in degrees in (-180, 180], rounded to a hundredth (what the backend keeps). */
export function normalizeAngle(angle: number): number {
  if (!Number.isFinite(angle)) return 0;
  let turned = ((angle % 360) + 360) % 360;
  if (turned > 180) turned -= 360;
  const rounded = Math.round(turned * 100) / 100;
  return rounded === 0 ? 0 : rounded;
}

/** The bounds of `box` turned `angle` degrees about its centre. */
export function rotatedBounds(box: Rect, angle: number): Rect {
  const rad = (angle * Math.PI) / 180;
  const sin = Math.abs(Math.sin(rad));
  const cos = Math.abs(Math.cos(rad));
  const w = box.w * cos + box.h * sin;
  const h = box.w * sin + box.h * cos;
  return { x: box.x + box.w / 2 - w / 2, y: box.y + box.h / 2 - h / 2, w, h };
}

/** The signature or mark turned to `angle` (its bounding box follows; the backend computes the same). */
export function turnedTo(a: Annotation, angle: number): Annotation {
  if (a.kind !== 'signature' && a.kind !== 'mark') return a;
  return { ...a, angle, rect: rotatedBounds(a.box, angle) };
}

/** The angle at which the rotate handle (above the top edge) is dragged to `point`, about the centre of `box`. */
export function angleToward(box: Rect, point: Point, snap: boolean): number {
  const dx = point.x - (box.x + box.w / 2);
  const dy = point.y - (box.y + box.h / 2);
  if (dx === 0 && dy === 0) return 0;
  // Straight up is 0; clockwise on the page (y down) is positive.
  const degrees = (Math.atan2(dy, dx) * 180) / Math.PI + 90;
  return normalizeAngle(snap ? Math.round(degrees / ROTATE_SNAP_DEG) * ROTATE_SNAP_DEG : degrees);
}

/** Where the rotate handle of a signature box turned by `angle` sits, in page space. */
export function rotateHandleAt(box: Rect, angle: number): Point {
  const rad = (angle * Math.PI) / 180;
  const reach = box.h / 2 + ROTATE_OFFSET_PT;
  return {
    x: box.x + box.w / 2 + Math.sin(rad) * reach,
    y: box.y + box.h / 2 - Math.cos(rad) * reach,
  };
}

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
    // A stamp keeps its proportions (DESIGN 3.14 ST5): only its corners show, like ink.
    case 'ink':
    case 'stamp':
      return CORNER_HANDLES;
    // A turned one cannot be resized (its corners would have to follow the turn): turn it back first.
    case 'signature':
    case 'mark':
      return angleOf(a) === 0 ? [...CORNER_HANDLES, 'rotate'] : ['rotate'];
    default:
      return [];
  }
}

/** Text markup stays on the text it marks: it is never moved (ADR-105). */
export const isTextMarkup = (a: Annotation): boolean =>
  a.kind === 'highlight' || a.kind === 'underline' || a.kind === 'strikeout';

/** Whether the annotation can be turned (a signature, initials or mark that is not locked). */
export function canRotate(a: Annotation): boolean {
  return !a.locked && (a.kind === 'signature' || a.kind === 'mark');
}

/** Whether a point of the page is on an annotation: inside its shape, or within `slop` points of its line (a click on a thin stroke). */
export function hitsAnnotation(a: Annotation, p: Point, slop: number): boolean {
  switch (a.kind) {
    case 'ink':
      return a.strokes.some((s) => {
        const reach = Math.max(a.width / 2, slop);
        if (s.points.length === 1) return distanceToSegment(p, s.points[0] ?? p, s.points[0] ?? p) <= reach;
        return s.points.some((q, i) => {
          const next = s.points[i + 1];
          return next !== undefined && distanceToSegment(p, q, next) <= reach;
        });
      });
    case 'line':
      return distanceToSegment(p, a.from, a.to) <= Math.max(a.width / 2, slop);
    case 'rect':
    case 'ellipse': {
      const b = a.box;
      const outer = { x: b.x - slop, y: b.y - slop, w: b.w + 2 * slop, h: b.h + 2 * slop };
      if (!inside(outer, p)) return false;
      // An unfilled shape is its outline only: the inside stays free for text or a signature.
      if (a.fill !== null) return a.kind === 'rect' || insideEllipse(b, p, slop);
      const inner = { x: b.x + slop, y: b.y + slop, w: Math.max(0, b.w - 2 * slop), h: Math.max(0, b.h - 2 * slop) };
      if (a.kind === 'rect') return !inside(inner, p) || inner.w === 0 || inner.h === 0;
      return insideEllipse(b, p, slop) && !insideEllipse(b, p, -slop);
    }
    case 'signature':
    case 'mark': {
      const turn = -angleOf(a);
      const rad = (turn * Math.PI) / 180;
      const cx = a.box.x + a.box.w / 2;
      const cy = a.box.y + a.box.h / 2;
      const dx = p.x - cx;
      const dy = p.y - cy;
      const local = {
        x: cx + dx * Math.cos(rad) - dy * Math.sin(rad),
        y: cy + dx * Math.sin(rad) + dy * Math.cos(rad),
      };
      return inside({ x: a.box.x - slop, y: a.box.y - slop, w: a.box.w + 2 * slop, h: a.box.h + 2 * slop }, local);
    }
    case 'freeText':
    case 'stamp':
      return inside({ x: a.box.x - slop, y: a.box.y - slop, w: a.box.w + 2 * slop, h: a.box.h + 2 * slop }, p);
    case 'note':
      return inside({ x: a.rect.x - slop, y: a.rect.y - slop, w: a.rect.w + 2 * slop, h: a.rect.h + 2 * slop }, p);
    default:
      return false;
  }
}

const inside = (r: Rect, p: Point): boolean => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;

/** Whether a point is inside the ellipse of `box` grown by `grow` points on every side. */
function insideEllipse(box: Rect, p: Point, grow: number): boolean {
  const rx = box.w / 2 + grow;
  const ry = box.h / 2 + grow;
  if (rx <= 0 || ry <= 0) return false;
  const dx = (p.x - (box.x + box.w / 2)) / rx;
  const dy = (p.y - (box.y + box.h / 2)) / ry;
  return dx * dx + dy * dy <= 1;
}

function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length2 = dx * dx + dy * dy;
  const t = length2 === 0 ? 0 : Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Whether the annotation can be moved: not locked, and not one the app never changes. */
export function canMove(a: Annotation): boolean {
  return !a.locked && a.kind !== 'opaque';
}

/** Where a handle sits on a frame. */
export function handlePoint(frame: Rect, a: Annotation, handle: HandleId): Point {
  if (a.kind === 'line') return handle === 'from' ? a.from : a.to;
  // The rotate handle sits above the top edge of the unturned frame (the frame itself is turned by CSS).
  if (handle === 'rotate') return { x: frame.x + frame.w / 2, y: frame.y - ROTATE_OFFSET_PT };
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
    case 'rotate':
      return 'grab';
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
    case 'signature':
    case 'mark':
    case 'stamp':
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
  if (handle === 'rotate' || !handlesOf(a).includes(handle)) return null;
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
    case 'freeText':
    case 'signature':
    case 'mark':
    case 'stamp': {
      // A signature, mark or stamp keeps its proportions whatever the modifier says (DESIGN 3.34, 3.14): only its corners show.
      const lock = keepAspect || a.kind === 'signature' || a.kind === 'mark' || a.kind === 'stamp';
      const box = resizeRect(a.box, handle, dx, dy, lock, page);
      // The backend refuses a stamp smaller than this: the preview stops where the file would.
      if (a.kind === 'stamp' && (box.w < STAMP_MIN_W_PT || box.h < STAMP_MIN_H_PT)) return a;
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
    case 'signature':
    case 'mark':
    case 'stamp':
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
