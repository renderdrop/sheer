import type { Sample } from './ink';

/**
 * Freehand shape (F21.5, ADR-145): a nearly closed stroke is recognised as a circle, an ellipse (any rotation) or a rectangle
 * (axis-aligned or rotated) by its normalised fit error. The clean fitted outline gets the stroke's own wobble back (the normal
 * residual against the fit, low-passed, periodic and scaled down), so it closes without a seam and still looks hand-drawn. A stroke
 * that is no such shape closes with a smooth periodic Catmull-Rom spline. Pure and deterministic; page space (points).
 */

export type ShapeKind = 'circle' | 'ellipse' | 'rectangle';

/** The end closes the loop when it is within this share of the path length (or 3 stroke widths) from the start (F19.26). */
export const CLOSE_SHARE = 0.2;
const CLOSE_MIN_LENGTH_PT = 12;
const CLOSE_MIN_POINTS = 8;
/** The closing point pair is searched in the first and last quarter of the path (overlapping ends are trimmed there). */
const CLOSE_WINDOW_SHARE = 0.25;
/** Points the loop is resampled to (evenly by arc length) for fitting. */
const FIT_SAMPLES = 256;
/** A fit is accepted up to this RMS distance, as a share of the mean radius around the centroid. */
export const SHAPE_ERROR_MAX = 0.07;
/** A circle wins over an ellipse when its error is at most this much higher (a nearly round ellipse becomes a circle). */
export const CIRCLE_MARGIN = 0.015;
/** Below this mean radius the stroke is too small to recognise, in points. */
const MIN_RADIUS_PT = 4;
/** The share of the stroke's own (low-passed) wobble that the clean shape gets back. */
export const WOBBLE_SCALE = 0.35;
const WOBBLE_BINS = 96;
/** Gaussian low-pass of the residual: sigma as a share of the perimeter. */
const WOBBLE_SIGMA_SHARE = 0.02;
/** The wobble never exceeds this share of the mean radius (the whole wobble is scaled down, never clipped). */
const WOBBLE_MAX_SHARE = 0.05;
/** Output point spacing, like smoothed ink (2.5 pt thinning, three spline steps), in points. */
export const SHAPE_SPACING_PT = 1;
const MIN_SHAPE_POINTS = 32;
const MAX_SHAPE_POINTS = 1500;
/** Control point spacing of the fallback spline, in points, and the control points smoothed at each side of its seam. */
const SPLINE_SPACING_PT = 6;
const SEAM_BLEND_POINTS = 3;
/** Corner rounding of a fitted rectangle: a share of the shorter side, at most, so the outline has no hard tangent jumps. */
const CORNER_SHARE = 0.04;
const CORNER_STEPS = 6;
/** Outline points between the seam of a rectangle and its nearest rounded corner, at least. */
const SEAM_CLEARANCE = 4;

interface Pt {
  x: number;
  y: number;
}

/** A point of a fitted outline with its outward unit normal; `corner` marks the rounded corners of a rectangle. */
interface OutlinePoint extends Pt {
  nx: number;
  ny: number;
  corner: boolean;
}

export interface ShapeErrors {
  circle: number;
  ellipse: number;
  rectangle: number;
}

export interface ShapeResult {
  /** The recognised shape, or null when the stroke closed with the fallback spline. */
  kind: ShapeKind | null;
  errors: ShapeErrors;
  /** The closed outline; the last point repeats the first. */
  points: Sample[];
}

const at = <T>(list: readonly T[], i: number): T => list[((i % list.length) + list.length) % list.length] as T;

function pathLength(stroke: readonly Pt[]): number {
  let length = 0;
  for (let i = 1; i < stroke.length; i += 1) {
    const a = at(stroke, i - 1);
    const b = at(stroke, i);
    length += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return length;
}

/**
 * The part of the stroke that forms the loop, or null for an open stroke. The closing pair is the closest pair of points between
 * the first and the last quarter of the path: the ends of a gap, or the crossing of overlapping ends (the overlap is trimmed).
 */
export function findLoop(stroke: readonly Sample[], width: number): Sample[] | null {
  const n = stroke.length;
  if (n < CLOSE_MIN_POINTS) return null;
  const cum = [0];
  for (let i = 1; i < n; i += 1) {
    const a = at(stroke, i - 1);
    const b = at(stroke, i);
    cum.push(at(cum, i - 1) + Math.hypot(b.x - a.x, b.y - a.y));
  }
  const length = at(cum, n - 1);
  if (length < CLOSE_MIN_LENGTH_PT) return null;
  const window = length * CLOSE_WINDOW_SHARE;
  let best = Infinity;
  let bi = 0;
  let bj = n - 1;
  for (let i = 0; i < n && at(cum, i) <= window; i += 1) {
    const a = at(stroke, i);
    for (let j = n - 1; j > i && at(cum, j) >= length - window; j -= 1) {
      const b = at(stroke, j);
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      // Ties keep the longer loop (the outermost pair).
      if (d < best - 1e-9) {
        best = d;
        bi = i;
        bj = j;
      }
    }
  }
  const loopLength = at(cum, bj) - at(cum, bi);
  if (bj - bi + 1 < CLOSE_MIN_POINTS || best > Math.max(loopLength * CLOSE_SHARE, width * 3)) return null;
  return stroke.slice(bi, bj + 1).map((s) => ({ ...s }));
}

/** `count` points evenly spaced by arc length along the closed polygon (the segment from the last point to the first included). */
export function resampleClosed(points: readonly Sample[], count: number): Sample[] {
  const n = points.length;
  if (n === 0) return [];
  const cum = [0];
  for (let i = 1; i <= n; i += 1) {
    const a = at(points, i - 1);
    const b = at(points, i);
    cum.push(at(cum, i - 1) + Math.hypot(b.x - a.x, b.y - a.y));
  }
  const total = at(cum, n);
  if (total === 0) return Array.from({ length: count }, () => ({ ...at(points, 0) }));
  const out: Sample[] = [];
  let seg = 0;
  for (let k = 0; k < count; k += 1) {
    const target = (k * total) / count;
    while (seg < n - 1 && at(cum, seg + 1) < target) seg += 1;
    const a = at(points, seg);
    const b = at(points, seg + 1);
    const len = at(cum, seg + 1) - at(cum, seg);
    const t = len > 0 ? (target - at(cum, seg)) / len : 0;
    out.push({
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
      pressure: a.pressure + (b.pressure - a.pressure) * t,
    });
  }
  return out;
}

function signedArea(points: readonly Pt[]): number {
  let area = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = at(points, i);
    const b = at(points, i + 1);
    area += a.x * b.y - b.x * a.y;
  }
  return area / 2;
}

function rms(values: readonly number[]): number {
  if (values.length === 0) return Infinity;
  let sum = 0;
  for (const v of values) sum += v * v;
  return Math.sqrt(sum / values.length);
}

interface Frame {
  cx: number;
  cy: number;
  /** Mean distance of the samples from the centroid: the scale every error is normalised by. */
  radius: number;
}

interface EllipseFit {
  cx: number;
  cy: number;
  angle: number;
  rx: number;
  ry: number;
}

interface RectFit {
  cx: number;
  cy: number;
  angle: number;
  halfW: number;
  halfH: number;
}

/** Ellipse about the centroid: least squares of `A u² + B uv + C v² = 1`; null when that is no ellipse. */
function fitEllipse(samples: readonly Pt[], frame: Frame): EllipseFit | null {
  // Normal equations of the 3×3 linear least squares, in units of the radius for conditioning.
  const s = frame.radius;
  const m = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  const r = [0, 0, 0];
  for (const p of samples) {
    const u = (p.x - frame.cx) / s;
    const v = (p.y - frame.cy) / s;
    const f = [u * u, u * v, v * v];
    for (let i = 0; i < 3; i += 1) {
      r[i] = at(r, i) + at(f, i);
      for (let j = 0; j < 3; j += 1) m[i * 3 + j] = at(m, i * 3 + j) + at(f, i) * at(f, j);
    }
  }
  const sol = solve3(m, r);
  if (sol === null) return null;
  const [A, B, C] = sol;
  if (A <= 0 || C <= 0 || 4 * A * C - B * B <= 0) return null;
  const angle = 0.5 * Math.atan2(B, A - C);
  const q = (t: number) => A * Math.cos(t) ** 2 + B * Math.cos(t) * Math.sin(t) + C * Math.sin(t) ** 2;
  const qa = q(angle);
  const qb = q(angle + Math.PI / 2);
  if (qa <= 0 || qb <= 0) return null;
  return { cx: frame.cx, cy: frame.cy, angle, rx: s / Math.sqrt(qa), ry: s / Math.sqrt(qb) };
}

/** Cramer's rule for a 3×3 system (row-major); null when singular. */
function solve3(m: readonly number[], r: readonly number[]): [number, number, number] | null {
  const det = (a: readonly number[]) =>
    at(a, 0) * (at(a, 4) * at(a, 8) - at(a, 5) * at(a, 7)) -
    at(a, 1) * (at(a, 3) * at(a, 8) - at(a, 5) * at(a, 6)) +
    at(a, 2) * (at(a, 3) * at(a, 7) - at(a, 4) * at(a, 6));
  const d = det(m);
  if (!Number.isFinite(d) || Math.abs(d) < 1e-12) return null;
  const column = (c: number) => m.map((v, i) => (i % 3 === c ? at(r, Math.floor(i / 3)) : v));
  return [det(column(0)) / d, det(column(1)) / d, det(column(2)) / d];
}

function ellipseError(samples: readonly Pt[], e: EllipseFit, scale: number): number {
  const cos = Math.cos(e.angle);
  const sin = Math.sin(e.angle);
  const residuals = samples.map((p) => {
    const dx = p.x - e.cx;
    const dy = p.y - e.cy;
    const u = dx * cos + dy * sin;
    const v = -dx * sin + dy * cos;
    const r = Math.hypot(u, v);
    if (r === 0) return Math.min(e.rx, e.ry);
    const ca = u / r;
    const sa = v / r;
    return r - 1 / Math.sqrt((ca * ca) / (e.rx * e.rx) + (sa * sa) / (e.ry * e.ry));
  });
  return rms(residuals) / scale;
}

/** Distance from a point in box coordinates to the outline of the box. */
function boxDistance(u: number, v: number, hw: number, hh: number): number {
  const dx = Math.abs(u) - hw;
  const dy = Math.abs(v) - hh;
  if (dx > 0 || dy > 0) return Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  return Math.min(-dx, -dy);
}

/**
 * Oriented rectangle: the orientation is the length-weighted mean of the edge directions modulo 90° (so a square works too), the
 * sides are the mean positions of the samples nearest to each of them (refined a few times).
 */
function fitRectangle(samples: readonly Pt[]): RectFit | null {
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const a = at(samples, i);
    const b = at(samples, i + 1);
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const phi = Math.atan2(b.y - a.y, b.x - a.x);
    sx += len * Math.cos(4 * phi);
    sy += len * Math.sin(4 * phi);
  }
  if (sx === 0 && sy === 0) return null;
  const angle = Math.atan2(sy, sx) / 4;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const local = samples.map((p) => ({ u: p.x * cos + p.y * sin, v: -p.x * sin + p.y * cos }));
  let left = Math.min(...local.map((p) => p.u));
  let right = Math.max(...local.map((p) => p.u));
  let bottom = Math.min(...local.map((p) => p.v));
  let top = Math.max(...local.map((p) => p.v));
  for (let pass = 0; pass < 4; pass += 1) {
    const sums = [0, 0, 0, 0];
    const counts = [0, 0, 0, 0];
    for (const p of local) {
      const d = [Math.abs(p.u - left), Math.abs(p.u - right), Math.abs(p.v - bottom), Math.abs(p.v - top)];
      let k = 0;
      for (let i = 1; i < 4; i += 1) if (at(d, i) < at(d, k)) k = i;
      sums[k] = at(sums, k) + (k < 2 ? p.u : p.v);
      counts[k] = at(counts, k) + 1;
    }
    if (counts.some((c) => c < 3)) return null;
    [left, right, bottom, top] = sums.map((s, i) => s / at(counts, i)) as [number, number, number, number];
  }
  const halfW = (right - left) / 2;
  const halfH = (top - bottom) / 2;
  if (halfW <= 0 || halfH <= 0) return null;
  const cu = (left + right) / 2;
  const cv = (bottom + top) / 2;
  return { cx: cu * cos - cv * sin, cy: cu * sin + cv * cos, angle, halfW, halfH };
}

function rectangleError(samples: readonly Pt[], r: RectFit, scale: number): number {
  const cos = Math.cos(r.angle);
  const sin = Math.sin(r.angle);
  const residuals = samples.map((p) => {
    const dx = p.x - r.cx;
    const dy = p.y - r.cy;
    return boxDistance(dx * cos + dy * sin, -dx * sin + dy * cos, r.halfW, r.halfH);
  });
  return rms(residuals) / scale;
}

/** The dense outline of an ellipse, counter-clockwise in the arithmetic sense. */
function ellipseOutline(e: EllipseFit, steps: number): OutlinePoint[] {
  const cos = Math.cos(e.angle);
  const sin = Math.sin(e.angle);
  return Array.from({ length: steps }, (_, i) => {
    const t = (i * 2 * Math.PI) / steps;
    const u = e.rx * Math.cos(t);
    const v = e.ry * Math.sin(t);
    return { x: e.cx + u * cos - v * sin, y: e.cy + u * sin + v * cos, nx: 0, ny: 0, corner: false };
  });
}

/** The dense outline of a rectangle with slightly rounded corners, counter-clockwise. */
function rectangleOutline(r: RectFit, width: number): OutlinePoint[] {
  const cos = Math.cos(r.angle);
  const sin = Math.sin(r.angle);
  const radius = Math.min(Math.max(width, 0.5), CORNER_SHARE * 2 * Math.min(r.halfW, r.halfH));
  const out: OutlinePoint[] = [];
  const put = (u: number, v: number, corner: boolean) =>
    out.push({ x: r.cx + u * cos - v * sin, y: r.cy + u * sin + v * cos, nx: 0, ny: 0, corner });
  const hw = r.halfW - radius;
  const hh = r.halfH - radius;
  // Corner centres counter-clockwise from bottom right, each followed by the side to the next corner.
  const corners: [number, number, number][] = [
    [hw, -hh, -Math.PI / 2],
    [hw, hh, 0],
    [-hw, hh, Math.PI / 2],
    [-hw, -hh, Math.PI],
  ];
  const sideSteps = 64;
  for (let c = 0; c < 4; c += 1) {
    const [u, v, start] = at(corners, c);
    for (let k = 0; k <= CORNER_STEPS; k += 1) {
      const a = start + (k * Math.PI) / 2 / CORNER_STEPS;
      put(u + radius * Math.cos(a), v + radius * Math.sin(a), k > 0 && k < CORNER_STEPS);
    }
    const [nu, nv] = at(corners, c + 1);
    const end = start + Math.PI / 2;
    const fromU = u + radius * Math.cos(end);
    const fromV = v + radius * Math.sin(end);
    const toU = nu + radius * Math.cos(end);
    const toV = nv + radius * Math.sin(end);
    for (let k = 1; k < sideSteps; k += 1) {
      const t = k / sideSteps;
      put(fromU + (toU - fromU) * t, fromV + (toV - fromV) * t, false);
    }
  }
  return out;
}

/** The outline resampled evenly by arc length, `spacing` apart, with outward normals. */
function evenOutline(dense: readonly OutlinePoint[], spacing: number): OutlinePoint[] {
  const n = dense.length;
  const cum = [0];
  for (let i = 1; i <= n; i += 1) {
    const a = at(dense, i - 1);
    const b = at(dense, i);
    cum.push(at(cum, i - 1) + Math.hypot(b.x - a.x, b.y - a.y));
  }
  const total = at(cum, n);
  const count = Math.min(MAX_SHAPE_POINTS, Math.max(MIN_SHAPE_POINTS, Math.round(total / spacing)));
  const out: OutlinePoint[] = [];
  let seg = 0;
  for (let k = 0; k < count; k += 1) {
    const target = (k * total) / count;
    while (seg < n - 1 && at(cum, seg + 1) < target) seg += 1;
    const a = at(dense, seg);
    const b = at(dense, seg + 1);
    const len = at(cum, seg + 1) - at(cum, seg);
    const t = len > 0 ? (target - at(cum, seg)) / len : 0;
    out.push({
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
      nx: 0,
      ny: 0,
      corner: t < 0.5 ? a.corner : b.corner,
    });
  }
  const sign = signedArea(out) >= 0 ? 1 : -1;
  for (let i = 0; i < count; i += 1) {
    const a = at(out, i - 1);
    const b = at(out, i + 1);
    const tx = b.x - a.x;
    const ty = b.y - a.y;
    const len = Math.hypot(tx, ty) || 1;
    const p = at(out, i);
    p.nx = (sign * ty) / len;
    p.ny = (-sign * tx) / len;
  }
  return out;
}

/** Periodic Gaussian blur of `values` with a sigma of `sigma` entries. */
function blurPeriodic(values: readonly number[], sigma: number): number[] {
  const n = values.length;
  const reach = Math.min(Math.floor(n / 2), Math.ceil(sigma * 3));
  const weights = Array.from({ length: 2 * reach + 1 }, (_, k) => Math.exp(-((k - reach) ** 2) / (2 * sigma * sigma)));
  const total = weights.reduce((a, b) => a + b, 0);
  return values.map((_, i) => {
    let sum = 0;
    for (let k = -reach; k <= reach; k += 1) sum += at(weights, k + reach) * at(values, i + k);
    return sum / total;
  });
}

/** Periodic Catmull-Rom interpolation of evenly spaced `values` at the position `s` in [0, 1). */
function periodicCubic(values: readonly number[], s: number): number {
  const n = values.length;
  const x = (((s % 1) + 1) % 1) * n;
  const i = Math.floor(x);
  const t = x - i;
  const p0 = at(values, i - 1);
  const p1 = at(values, i);
  const p2 = at(values, i + 1);
  const p3 = at(values, i + 2);
  return (
    0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t)
  );
}

/** Fills empty bins (NaN) by linear interpolation between their filled neighbours, periodically. */
function fillBins(values: number[]): number[] {
  const filled = values.map((v, i) => (Number.isNaN(v) ? -1 : i)).filter((i) => i >= 0);
  if (filled.length === 0) return values.map(() => 0);
  return values.map((v, i) => {
    if (!Number.isNaN(v)) return v;
    let before = i;
    while (Number.isNaN(at(values, before))) before -= 1;
    let after = i;
    while (Number.isNaN(at(values, after))) after += 1;
    const t = (i - before) / (after - before);
    return at(values, before) + (at(values, after) - at(values, before)) * t;
  });
}

/**
 * The clean outline with the stroke's wobble: each sample's signed normal distance from the outline (by nearest outline point) is
 * binned along the perimeter, blurred periodically, centred, scaled down and added back along the normals. The output starts at
 * the outline point nearest the stroke's start (off a rectangle's rounded corner), runs in the drawing direction and closes.
 */
function withWobble(outline: readonly OutlinePoint[], samples: readonly Sample[], scale: number): Sample[] {
  const n = outline.length;
  const bins = Array.from({ length: WOBBLE_BINS }, () => ({ d: 0, p: 0, count: 0 }));
  const nearest = (p: Pt): number => {
    let best = Infinity;
    let k = 0;
    for (let i = 0; i < n; i += 1) {
      const q = at(outline, i);
      const d = (p.x - q.x) ** 2 + (p.y - q.y) ** 2;
      if (d < best) {
        best = d;
        k = i;
      }
    }
    return k;
  };
  for (const p of samples) {
    const k = nearest(p);
    const q = at(outline, k);
    const bin = at(bins, Math.floor((k / n) * WOBBLE_BINS));
    bin.d += (p.x - q.x) * q.nx + (p.y - q.y) * q.ny;
    bin.p += p.pressure;
    bin.count += 1;
  }
  const sigma = Math.max(1, WOBBLE_SIGMA_SHARE * WOBBLE_BINS);
  let wobble = blurPeriodic(fillBins(bins.map((b) => (b.count > 0 ? b.d / b.count : NaN))), sigma);
  const pressure = blurPeriodic(fillBins(bins.map((b) => (b.count > 0 ? b.p / b.count : NaN))), sigma);
  const mean = wobble.reduce((a, b) => a + b, 0) / wobble.length;
  wobble = wobble.map((w) => (w - mean) * WOBBLE_SCALE);
  const peak = Math.max(...wobble.map(Math.abs));
  const limit = WOBBLE_MAX_SHARE * scale;
  if (peak > limit) wobble = wobble.map((w) => (w * limit) / peak);

  const step = Math.sign(signedArea(samples)) === Math.sign(signedArea(outline)) ? 1 : -1;
  // The seam moves forward until no rounded corner is within SEAM_CLEARANCE points of it.
  const nearCorner = (i: number) => {
    for (let k = -SEAM_CLEARANCE; k <= SEAM_CLEARANCE; k += 1) if (at(outline, i + k).corner) return true;
    return false;
  };
  let start = nearest(at(samples, 0));
  for (let guard = 0; guard < n && nearCorner(start); guard += 1) start = (start + step + n) % n;
  const out: Sample[] = [];
  for (let k = 0; k < n; k += 1) {
    const i = (((start + step * k) % n) + n) % n;
    const q = at(outline, i);
    const s = i / n;
    const d = periodicCubic(wobble, s);
    out.push({ x: q.x + q.nx * d, y: q.y + q.ny * d, pressure: periodicCubic(pressure, s) });
  }
  out.push({ ...at(out, 0) });
  return out;
}

/** Fits circle, ellipse and rectangle to a loop; the kind is the best fit within the error limit, or null. */
export function classifyLoop(loop: readonly Sample[]): {
  kind: ShapeKind | null;
  errors: ShapeErrors;
  frame: Frame;
  ellipse: EllipseFit | null;
  rect: RectFit | null;
  samples: Sample[];
} {
  const samples = resampleClosed(loop, FIT_SAMPLES);
  const cx = samples.reduce((a, p) => a + p.x, 0) / samples.length;
  const cy = samples.reduce((a, p) => a + p.y, 0) / samples.length;
  const dists = samples.map((p) => Math.hypot(p.x - cx, p.y - cy));
  const radius = dists.reduce((a, b) => a + b, 0) / dists.length;
  const frame = { cx, cy, radius };
  const errors: ShapeErrors = { circle: Infinity, ellipse: Infinity, rectangle: Infinity };
  if (!(radius >= MIN_RADIUS_PT)) return { kind: null, errors, frame, ellipse: null, rect: null, samples };
  errors.circle = rms(dists.map((d) => d - radius)) / radius;
  const ellipse = fitEllipse(samples, frame);
  if (ellipse !== null) errors.ellipse = ellipseError(samples, ellipse, radius);
  const rect = fitRectangle(samples);
  if (rect !== null) errors.rectangle = rectangleError(samples, rect, radius);
  let kind: ShapeKind | null = null;
  const round = Math.min(errors.circle, errors.ellipse);
  if (errors.rectangle < round && errors.rectangle <= SHAPE_ERROR_MAX) kind = 'rectangle';
  else if (errors.circle <= SHAPE_ERROR_MAX && errors.circle <= errors.ellipse + CIRCLE_MARGIN) kind = 'circle';
  else if (errors.ellipse <= SHAPE_ERROR_MAX) kind = 'ellipse';
  return { kind, errors, frame, ellipse, rect, samples };
}

/** Closes a loop with a periodic Catmull-Rom spline through evenly spaced control points, blended across the seam. */
export function closeWithSpline(loop: readonly Sample[]): Sample[] {
  const length = pathLength(loop) + Math.hypot(at(loop, -1).x - at(loop, 0).x, at(loop, -1).y - at(loop, 0).y);
  const count = Math.max(8, Math.min(400, Math.round(length / SPLINE_SPACING_PT)));
  let controls = resampleClosed(loop, count);
  // The seam lies between the last and the first control point: a few passes of a local average there remove a kink.
  for (let pass = 0; pass < 2; pass += 1) {
    const next = controls.map((c) => ({ ...c }));
    for (let k = -SEAM_BLEND_POINTS; k < SEAM_BLEND_POINTS; k += 1) {
      const i = (k + count) % count;
      const a = at(controls, i - 1);
      const b = at(controls, i);
      const c = at(controls, i + 1);
      next[i] = {
        x: (a.x + 2 * b.x + c.x) / 4,
        y: (a.y + 2 * b.y + c.y) / 4,
        pressure: (a.pressure + 2 * b.pressure + c.pressure) / 4,
      };
    }
    controls = next;
  }
  const steps = Math.max(2, Math.round(length / count / SHAPE_SPACING_PT));
  const out: Sample[] = [];
  for (let i = 0; i < count; i += 1) {
    const p0 = at(controls, i - 1);
    const p1 = at(controls, i);
    const p2 = at(controls, i + 1);
    const p3 = at(controls, i + 2);
    for (let k = 0; k < steps; k += 1) {
      const t = k / steps;
      const f = (a: number, b: number, c: number, d: number) =>
        0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (-a + 3 * b - 3 * c + d) * t * t * t);
      out.push({
        x: f(p0.x, p1.x, p2.x, p3.x),
        y: f(p0.y, p1.y, p2.y, p3.y),
        pressure: p1.pressure + (p2.pressure - p1.pressure) * t,
      });
    }
  }
  out.push({ ...at(out, 0) });
  return out;
}

/** The freehand shape: a recognised and fitted closed shape with the stroke's wobble, a spline-closed loop, or null when open. */
export function fitFreehandShape(stroke: readonly Sample[], width: number): ShapeResult | null {
  const loop = findLoop(stroke, width);
  if (loop === null) return null;
  const fit = classifyLoop(loop);
  const { kind, errors, frame } = fit;
  let outline: OutlinePoint[] | null = null;
  if (kind === 'circle') {
    outline = ellipseOutline({ cx: frame.cx, cy: frame.cy, angle: 0, rx: frame.radius, ry: frame.radius }, 1024);
  } else if (kind === 'ellipse' && fit.ellipse !== null) {
    outline = ellipseOutline(fit.ellipse, 1024);
  } else if (kind === 'rectangle' && fit.rect !== null) {
    outline = rectangleOutline(fit.rect, width);
  }
  if (outline === null) return { kind: null, errors, points: closeWithSpline(loop) };
  const even = evenOutline(outline, SHAPE_SPACING_PT);
  return { kind, errors, points: withWobble(even, fit.samples, frame.radius) };
}
