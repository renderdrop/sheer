import type { Point, Rect } from '../../../api/wire';

/**
 * Shape recognition for a freehand stroke (DESIGN 3.5 B11, ADR-114): a roughly drawn circle, ellipse, rectangle, line or arrow that
 * the pen then holds still on. Pure geometry in page space (points). Every error is normalised by the size of the shape, so a small
 * and a large drawing are judged alike; when the stroke fits more than one shape about equally well, or none, the answer is `null`
 * and the stroke stays ink ("reject when unsure").
 *
 * Decisions (F17.5, ADR-124): the input is one pen stroke, so an arrow is a shaft with a head hook (arms out and back) at either end.
 * A rectangle is axis aligned and may be drawn turned by up to 12 degrees (the turn is dropped: the pen holds a straight box).
 * Circle and ellipse are told apart at 12 % (axes within 12 % of each other = circle). Undo: the stroke is committed as ink first and
 * the shape replaces it in one batch command, so one undo restores the raw stroke (see CreationLayer.commitSnap).
 */

export type Recognised =
  | { kind: 'line'; from: Point; to: Point }
  /** A line with a hook at one end; `to` is the tip. */
  | { kind: 'arrow'; from: Point; to: Point }
  | { kind: 'rect'; box: Rect }
  /** `circle`: the two axes are about equal, so the box is made square. */
  | { kind: 'ellipse'; box: Rect; circle: boolean };

/** The thresholds; all but the sizes are shares of the shape's own size. Exported for the tests. */
export const RECOGNISE = {
  /** The stroke is resampled to this many equally spaced points. */
  samples: 64,
  /** Fewest raw points, shortest stroke and smallest side of a shape, in points. */
  minPoints: 8,
  minLengthPt: 20,
  minSidePt: 12,
  /** A line: no point farther from the chord than this share of the chord, and a chord that is this share of the path. */
  lineDeviation: 0.07,
  lineStraight: 0.88,
  /** Closed: the ends are at most this share of the path apart. */
  closedGap: 0.2,
  /** A closed stroke runs round at least this share of a full turn. */
  winding: 0.85,
  /** A rectangle or ellipse fits when its rms distance is at most this share of the box diagonal. */
  fit: 0.04,
  /** When both fit, the better one must be this share of the other's error or less; else unsure. */
  winRatio: 0.7,
  /** Every corner of a rectangle has a point within this share of the diagonal. */
  corner: 0.12,
  /** A rectangle may be turned by this much (degrees) and still be taken as axis aligned; the step of the search. */
  tiltDeg: 12,
  tiltStepDeg: 3,
  /** Ellipse axes that differ by less than this share are a circle. */
  circle: 0.12,
  /** The hook of an arrow reaches out from the tip by at least and at most this share of the shaft. */
  hookMin: 0.08,
  hookMax: 0.35,
  /** The hook stays behind the tip, by at most this share of the shaft beyond it. */
  hookAhead: 0.05,
  /** The stroke has come to the tip when it is within this share of the shaft from it. */
  tipReach: 0.04,
  /** The path of the hook is at most this many times how far it reaches. */
  hookPath: 4.5,
} as const;

const dist = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);

function pathLength(points: readonly Point[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    if (a !== undefined && b !== undefined) total += dist(a, b);
  }
  return total;
}

/** `n` points at equal distances along the path (the first and the last are the path's own). */
export function resample(points: readonly Point[], n: number = RECOGNISE.samples): Point[] {
  const first = points[0];
  if (first === undefined) return [];
  const total = pathLength(points);
  if (total === 0 || points.length < 2) return Array.from({ length: n }, () => ({ ...first }));
  const step = total / (n - 1);
  const out: Point[] = [{ ...first }];
  let carried = 0;
  for (let i = 1; i < points.length && out.length < n; i += 1) {
    let a = points[i - 1];
    const b = points[i];
    if (a === undefined || b === undefined) continue;
    let segment = dist(a, b);
    while (segment > 0 && carried + segment >= step && out.length < n) {
      const t = (step - carried) / segment;
      a = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      out.push(a);
      segment = dist(a, b);
      carried = 0;
    }
    carried += segment;
  }
  const last = points[points.length - 1];
  while (out.length < n && last !== undefined) out.push({ ...last });
  return out;
}

/** Distance of `p` from the infinite line through `a` and `b`. */
function lineDistance(p: Point, a: Point, b: Point): number {
  const length = dist(a, b);
  if (length === 0) return dist(p, a);
  return Math.abs((b.x - a.x) * (a.y - p.y) - (a.x - p.x) * (b.y - a.y)) / length;
}

function lineFit(s: readonly Point[]): { from: Point; to: Point } | null {
  const a = s[0];
  const b = s[s.length - 1];
  if (a === undefined || b === undefined) return null;
  const chord = dist(a, b);
  if (chord < RECOGNISE.minLengthPt) return null;
  if (chord < RECOGNISE.lineStraight * pathLength(s)) return null;
  const worst = Math.max(...s.map((p) => lineDistance(p, a, b)));
  return worst <= RECOGNISE.lineDeviation * chord ? { from: a, to: b } : null;
}

/** A shaft with a hook at its end: the stroke's farthest point from its start is the tip. */
function arrowFit(s: readonly Point[]): { from: Point; to: Point } | null {
  const from = s[0];
  if (from === undefined) return null;
  let tipAt = 0;
  let far = 0;
  s.forEach((p, i) => {
    const d = dist(p, from);
    if (d > far) {
      far = d;
      tipAt = i;
    }
  });
  const tip = s[tipAt];
  if (tip === undefined || far < RECOGNISE.minLengthPt) return null;
  // The shaft runs to where the stroke first comes to the tip; what follows (arms drawn out and back) is the hook.
  const arrived = s.findIndex((p) => dist(p, tip) <= RECOGNISE.tipReach * far);
  const shaft = s.slice(0, (arrived < 0 ? tipAt : arrived) + 1);
  if (Math.max(...shaft.map((p) => lineDistance(p, from, tip))) > RECOGNISE.lineDeviation * far) return null;
  const hook = s.slice((arrived < 0 ? tipAt : arrived) + 1);
  if (hook.length < 2) return null;
  const ux = (tip.x - from.x) / far;
  const uy = (tip.y - from.y) / far;
  let reach = 0;
  for (const p of hook) {
    reach = Math.max(reach, dist(p, tip));
    // How far past the tip (along the shaft) the point is.
    if ((p.x - tip.x) * ux + (p.y - tip.y) * uy > RECOGNISE.hookAhead * far) return null;
  }
  if (reach < RECOGNISE.hookMin * far || reach > RECOGNISE.hookMax * far) return null;
  if (pathLength([tip, ...hook]) > RECOGNISE.hookPath * reach) return null;
  return { from, to: tip };
}

interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function boundsOf(points: readonly Point[]): Bounds {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
}

/** How much of a full turn the path makes around `c` (1 is once round), whichever way it goes. */
function turns(points: readonly Point[], c: Point): number {
  let sum = 0;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    if (a === undefined || b === undefined) continue;
    let delta = Math.atan2(b.y - c.y, b.x - c.x) - Math.atan2(a.y - c.y, a.x - c.x);
    while (delta > Math.PI) delta -= 2 * Math.PI;
    while (delta < -Math.PI) delta += 2 * Math.PI;
    sum += delta;
  }
  return Math.abs(sum) / (2 * Math.PI);
}

const rms = (values: readonly number[]): number =>
  Math.sqrt(values.reduce((sum, v) => sum + v * v, 0) / Math.max(1, values.length));

interface RectFit {
  error: number;
  box: Rect;
  cornersOk: boolean;
}

/** The best axis-aligned rectangle for the points when they are turned by up to the tilt: its error, its box and whether all four corners are touched. */
function rectFit(s: readonly Point[]): RectFit | null {
  let best: RectFit | null = null;
  const steps = Math.round(RECOGNISE.tiltDeg / RECOGNISE.tiltStepDeg);
  for (let k = -steps; k <= steps; k += 1) {
    const angle = (k * RECOGNISE.tiltStepDeg * Math.PI) / 180;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    // The points turned by -angle (so that a rectangle turned by +angle becomes axis aligned).
    const turned = s.map((p) => ({ x: p.x * cos + p.y * sin, y: -p.x * sin + p.y * cos }));
    const b = boundsOf(turned);
    const w = b.maxX - b.minX;
    const h = b.maxY - b.minY;
    const diagonal = Math.hypot(w, h);
    if (diagonal === 0) continue;
    const error = rms(turned.map((p) => Math.min(p.x - b.minX, b.maxX - p.x, p.y - b.minY, b.maxY - p.y))) / diagonal;
    if (best !== null && error >= best.error) continue;
    const corners: Point[] = [
      { x: b.minX, y: b.minY },
      { x: b.maxX, y: b.minY },
      { x: b.minX, y: b.maxY },
      { x: b.maxX, y: b.maxY },
    ];
    const cornersOk = corners.every((corner) => turned.some((p) => dist(p, corner) <= RECOGNISE.corner * diagonal));
    // The centre goes back to the page by the opposite turn.
    const cx = (b.minX + b.maxX) / 2;
    const cy = (b.minY + b.maxY) / 2;
    const centre = { x: cx * cos - cy * sin, y: cx * sin + cy * cos };
    best = { error, cornersOk, box: { x: centre.x - w / 2, y: centre.y - h / 2, w, h } };
  }
  return best;
}

/** The error of an axis-aligned ellipse through the stroke's bounding box, as a share of the box diagonal. */
function ellipseError(s: readonly Point[], b: Bounds): number {
  const rx = (b.maxX - b.minX) / 2;
  const ry = (b.maxY - b.minY) / 2;
  if (rx === 0 || ry === 0) return Infinity;
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  const scale = (rx + ry) / 2;
  return rms(s.map((p) => (Math.hypot((p.x - cx) / rx, (p.y - cy) / ry) - 1) * scale)) / Math.hypot(2 * rx, 2 * ry);
}

function closedFit(s: readonly Point[]): Recognised | null {
  const b = boundsOf(s);
  const w = b.maxX - b.minX;
  const h = b.maxY - b.minY;
  if (Math.min(w, h) < RECOGNISE.minSidePt) return null;
  const centre = { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
  if (turns(s, centre) < RECOGNISE.winding) return null;
  const rect = rectFit(s);
  const rectOk = rect !== null && rect.error <= RECOGNISE.fit && rect.cornersOk;
  const ellipse = ellipseError(s, b);
  const ellipseOk = ellipse <= RECOGNISE.fit;
  if (rectOk && ellipseOk && rect !== null) {
    // Both fit: only a clear winner counts.
    if (rect.error > RECOGNISE.winRatio * ellipse && ellipse > RECOGNISE.winRatio * rect.error) return null;
    if (ellipse < rect.error) return ellipseShape(b);
    return { kind: 'rect', box: rect.box };
  }
  if (rectOk && rect !== null) {
    // A rectangle is only taken when the ellipse is clearly worse (a circle fits a box about as well as a loose rectangle).
    return rect.error <= RECOGNISE.winRatio * ellipse ? { kind: 'rect', box: rect.box } : null;
  }
  if (ellipseOk) {
    return rect === null || ellipse <= RECOGNISE.winRatio * rect.error ? ellipseShape(b) : null;
  }
  return null;
}

function ellipseShape(b: Bounds): Recognised {
  const w = b.maxX - b.minX;
  const h = b.maxY - b.minY;
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  if (Math.abs(w - h) <= RECOGNISE.circle * Math.max(w, h)) {
    const side = (w + h) / 2;
    return { kind: 'ellipse', box: { x: cx - side / 2, y: cy - side / 2, w: side, h: side }, circle: true };
  }
  return { kind: 'ellipse', box: { x: b.minX, y: b.minY, w, h }, circle: false };
}

/**
 * What a stroke is, or `null` when it is none of the shapes (or not clearly one). `points` are the stroke's samples in order.
 * Open strokes are a line, or an arrow (a line with a short hook at either end); closed ones a circle, an ellipse or a rectangle.
 */
export function recognise(points: readonly Point[]): Recognised | null {
  if (points.length < RECOGNISE.minPoints || points.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))) {
    return null;
  }
  const length = pathLength(points);
  if (length < RECOGNISE.minLengthPt) return null;
  const s = resample(points);
  const first = s[0];
  const last = s[s.length - 1];
  if (first === undefined || last === undefined) return null;
  if (dist(first, last) <= RECOGNISE.closedGap * length) return closedFit(s);
  const line = lineFit(s);
  if (line !== null) return { kind: 'line', ...line };
  const arrow = arrowFit(s) ?? arrowFit([...s].reverse());
  return arrow === null ? null : { kind: 'arrow', ...arrow };
}

/** What the renderer needs to morph a stroke into its shape (F17.5): the stroke as 64 equally spaced points, and the shape it becomes. */
export interface Morph {
  from: Point[];
  to: Recognised;
}

export function morphOf(points: readonly Point[], to: Recognised): Morph {
  return { from: resample(points), to };
}

/** The hold time of a snap in ms: `--hold-shape` (500), read from the document, else the spec's value. */
export function holdShapeMs(): number {
  if (typeof document === 'undefined') return 500;
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--hold-shape').trim();
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) && raw.endsWith('ms') && value > 0 ? value : 500;
}

/** How far the pointer may drift while it counts as held still, in px (DESIGN 3.5 B11). */
export const HOLD_STILL_PX = 4;

/**
 * A recognised shape that the pen can still resize (DESIGN 3.5 B11): one point stays (`fixed`), the other (`free`) follows the pointer.
 * For a line or arrow the free point is the end nearer the pointer; for a box it is the corner nearer the pointer.
 */
export interface Snap {
  shape: Recognised;
  fixed: Point;
  free: Point;
  /** Which end of a line or arrow is the free one. */
  end: 'from' | 'to';
}

export function snapFor(shape: Recognised, pointer: Point): Snap {
  if (shape.kind === 'line' || shape.kind === 'arrow') {
    const toFree = dist(shape.to, pointer) <= dist(shape.from, pointer);
    return {
      shape,
      fixed: toFree ? shape.from : shape.to,
      free: toFree ? shape.to : shape.from,
      end: toFree ? 'to' : 'from',
    };
  }
  const { x, y, w, h } = shape.box;
  const corners: Point[] = [
    { x, y },
    { x: x + w, y },
    { x, y: y + h },
    { x: x + w, y: y + h },
  ];
  let nearest = 0;
  corners.forEach((corner, i) => {
    const best = corners[nearest];
    if (best !== undefined && dist(corner, pointer) < dist(best, pointer)) nearest = i;
  });
  const free = corners[nearest] ?? { x, y };
  const fixed = corners[3 - nearest] ?? { x: x + w, y: y + h };
  return { shape, fixed, free, end: 'to' };
}

/** The shape when the pointer, which was at `from` when the snap happened, is now at `to`: the free point moves by as much. */
export function snapTo(snap: Snap, from: Point, to: Point): Recognised {
  const free = { x: snap.free.x + to.x - from.x, y: snap.free.y + to.y - from.y };
  const { shape, fixed } = snap;
  if (shape.kind === 'line' || shape.kind === 'arrow') {
    return snap.end === 'to'
      ? { kind: shape.kind, from: fixed, to: free }
      : { kind: shape.kind, from: free, to: fixed };
  }
  const box = {
    x: Math.min(fixed.x, free.x),
    y: Math.min(fixed.y, free.y),
    w: Math.abs(free.x - fixed.x),
    h: Math.abs(free.y - fixed.y),
  };
  return shape.kind === 'rect' ? { kind: 'rect', box } : { kind: 'ellipse', box, circle: false };
}
