import { MAX_INK_POINTS_PER_STROKE } from '../../../api/annotations';
import type { Point } from '../../../api/wire';

/**
 * Freehand ink (DESIGN 3.22, ADR-029): from raw pointer samples to the points the user drew (smoothed, thinned, capped) and to the
 * polygon that is filled (pressure changes the width). Pure functions; page space (points).
 */

export interface Sample extends Point {
  /** 0 to 1; a mouse reports 0.5 while a button is down. */
  pressure: number;
}

/** Strokes that start at most this many ms after the last one ended join the same annotation. */
export const INK_JOIN_MS = 1000;
/** Points of one stroke, and of all strokes of one annotation, the layer keeps (the outline adds to them; the model allows 50 000 in all). */
export const MAX_STROKE_POINTS = Math.min(MAX_INK_POINTS_PER_STROKE, 3000);
export const MAX_ANNOTATION_POINTS = 8000;
/** A sample closer than this to the one before is dropped, in points. */
export const MIN_SAMPLE_DISTANCE_PT = 0.5;
const NEUTRAL_PRESSURE = 0.5;

/** Whether a stroke that starts at `startMs` joins the group whose last stroke ended at `lastEndMs`. */
export function joinsGroup(lastEndMs: number | null, startMs: number): boolean {
  return lastEndMs !== null && startMs >= lastEndMs && startMs - lastEndMs <= INK_JOIN_MS;
}

/** The samples with `next` appended, unless it is too close to the last one or not finite. */
export function appendSample(samples: readonly Sample[], next: Sample): readonly Sample[] {
  if (!Number.isFinite(next.x) || !Number.isFinite(next.y)) return samples;
  const last = samples[samples.length - 1];
  if (last !== undefined && Math.hypot(next.x - last.x, next.y - last.y) < MIN_SAMPLE_DISTANCE_PT) return samples;
  return [...samples, next];
}

/** A moving average over up to `2 * radius + 1` samples; the first and last stay where they are, so the stroke ends where it was drawn. */
export function movingAverage(samples: readonly Sample[], radius = 1): Sample[] {
  const n = samples.length;
  if (n < 3 || radius < 1) return samples.map((s) => ({ ...s }));
  return samples.map((sample, i) => {
    if (i === 0 || i === n - 1) return { ...sample };
    const r = Math.min(radius, i, n - 1 - i);
    let x = 0;
    let y = 0;
    let p = 0;
    for (let j = i - r; j <= i + r; j += 1) {
      const s = samples[j];
      if (s === undefined) continue;
      x += s.x;
      y += s.y;
      p += s.pressure;
    }
    const count = 2 * r + 1;
    return { x: x / count, y: y / count, pressure: p / count };
  });
}

/** Catmull-Rom spline through the samples, `steps` points per segment (the samples themselves included). */
export function catmullRom(samples: readonly Sample[], steps = 2): Sample[] {
  const n = samples.length;
  if (n < 3 || steps < 2) return samples.map((s) => ({ ...s }));
  const out: Sample[] = [];
  for (let i = 0; i < n - 1; i += 1) {
    const p1 = samples[i];
    const p2 = samples[i + 1];
    const p0 = samples[Math.max(0, i - 1)];
    const p3 = samples[Math.min(n - 1, i + 2)];
    if (p0 === undefined || p1 === undefined || p2 === undefined || p3 === undefined) continue;
    for (let k = 0; k < steps; k += 1) {
      const t = k / steps;
      const t2 = t * t;
      const t3 = t2 * t;
      const f = (a: number, b: number, c: number, d: number) =>
        0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push({
        x: f(p0.x, p1.x, p2.x, p3.x),
        y: f(p0.y, p1.y, p2.y, p3.y),
        pressure: p1.pressure + (p2.pressure - p1.pressure) * t,
      });
    }
  }
  const last = samples[n - 1];
  if (last !== undefined) out.push({ ...last });
  return out;
}

/** At most `max` samples, evenly picked by index; the first and last are always kept. */
export function capSamples(samples: readonly Sample[], max: number): Sample[] {
  const limit = Math.max(2, Math.floor(max));
  if (samples.length <= limit) return samples.map((s) => ({ ...s }));
  const out: Sample[] = [];
  for (let i = 0; i < limit; i += 1) {
    const s = samples[Math.round((i * (samples.length - 1)) / (limit - 1))];
    if (s !== undefined) out.push({ ...s });
  }
  return out;
}

/**
 * Freehand smoothing parameters (F20.4). Pipeline: thin by distance, moving average (two passes), Catmull-Rom, cap.
 * - SMOOTH_MIN_DISTANCE_PT: samples closer than this to the last kept one are dropped (about 3 screen px at 100 % zoom); the last
 *   sample is always kept, so the stroke ends where it was drawn and the arrowhead follows the end of the stroke.
 * - SMOOTH_RADIUS / SMOOTH_PASSES: the average spans 2 * 3 + 1 samples and runs twice (a binomial-like kernel), which removes tremor.
 * - SMOOTH_STEPS: spline points per segment after thinning.
 */
export const SMOOTH_MIN_DISTANCE_PT = 2.5;
export const SMOOTH_RADIUS = 3;
export const SMOOTH_PASSES = 2;
export const SMOOTH_STEPS = 3;

/** Drops samples closer than `minDistance` to the last kept one; the first and last sample always stay. */
export function thinSamples(samples: readonly Sample[], minDistance = SMOOTH_MIN_DISTANCE_PT): Sample[] {
  const n = samples.length;
  if (n < 3) return samples.map((s) => ({ ...s }));
  const out: Sample[] = [];
  for (let i = 0; i < n - 1; i += 1) {
    const s = samples[i];
    if (s === undefined) continue;
    const prev = out[out.length - 1];
    if (prev === undefined || Math.hypot(s.x - prev.x, s.y - prev.y) >= minDistance) out.push({ ...s });
  }
  const last = samples[n - 1];
  const kept = out[out.length - 1];
  if (last !== undefined && kept !== undefined) {
    // A last sample too close to the kept one replaces it (but never the first), so the end is exact without a stub.
    if (out.length > 1 && Math.hypot(last.x - kept.x, last.y - kept.y) < minDistance) out[out.length - 1] = { ...last };
    else out.push({ ...last });
  }
  return out;
}

/** The points of a finished stroke: thinned, smoothed, then capped. */
export function smoothStroke(samples: readonly Sample[], max = MAX_STROKE_POINTS): Sample[] {
  if (samples.length < 3) return capSamples(samples, max);
  let line = thinSamples(samples);
  for (let pass = 0; pass < SMOOTH_PASSES; pass += 1) line = movingAverage(line, SMOOTH_RADIUS);
  return capSamples(catmullRom(line, SMOOTH_STEPS), max);
}

function radiusOf(width: number, pressure: number): number {
  const p = Number.isFinite(pressure) ? Math.min(Math.max(pressure, 0), 1) : NEUTRAL_PRESSURE;
  return (width / 2) * (0.4 + 1.2 * p);
}

const CAP_STEPS = 4;

/**
 * The polygon of a stroke of nominal `width`: the left edge forward, a round cap, the right edge back, a round cap. One sample
 * is a dot. The width follows the pressure (0.4 to 1.6 times half the nominal width; 0.5 is nominal).
 */
export function strokeOutline(samples: readonly Sample[], width: number): Point[] {
  const first = samples[0];
  if (first === undefined) return [];
  const circle = (c: Sample): Point[] => {
    const r = radiusOf(width, c.pressure);
    return Array.from({ length: 8 }, (_, i) => ({
      x: c.x + Math.cos((i * Math.PI) / 4) * r,
      y: c.y + Math.sin((i * Math.PI) / 4) * r,
    }));
  };
  const n = samples.length;
  if (n === 1) return circle(first);
  const dirs: Point[] = [];
  for (let i = 0; i < n; i += 1) {
    const a = samples[Math.max(0, i - 1)];
    const b = samples[Math.min(n - 1, i + 1)];
    if (a === undefined || b === undefined) return circle(first);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    dirs.push(len === 0 ? { x: 1, y: 0 } : { x: dx / len, y: dy / len });
  }
  const left: Point[] = [];
  const right: Point[] = [];
  for (let i = 0; i < n; i += 1) {
    const s = samples[i];
    const d = dirs[i];
    if (s === undefined || d === undefined) continue;
    const r = radiusOf(width, s.pressure);
    left.push({ x: s.x - d.y * r, y: s.y + d.x * r });
    right.push({ x: s.x + d.y * r, y: s.y - d.x * r });
  }
  // `left` lies at the direction + 90 degrees; a cap runs from there through the front to direction - 90 degrees.
  const cap = (centre: Sample, d: Point): Point[] => {
    const r = radiusOf(width, centre.pressure);
    const base = Math.atan2(d.y, d.x);
    const out: Point[] = [];
    for (let k = 1; k < CAP_STEPS; k += 1) {
      const angle = base + Math.PI / 2 - (k * Math.PI) / CAP_STEPS;
      out.push({ x: centre.x + Math.cos(angle) * r, y: centre.y + Math.sin(angle) * r });
    }
    return out;
  };
  const last = samples[n - 1];
  const dFirst = dirs[0];
  const dLast = dirs[n - 1];
  if (last === undefined || dFirst === undefined || dLast === undefined) return circle(first);
  const endCap = cap(last, dLast);
  const startCap = cap(first, { x: -dFirst.x, y: -dFirst.y });
  return [...left, ...endCap, ...right.reverse(), ...startCap];
}

/** The points as the model stores them (no pressure). */
export function toPoints(samples: readonly Sample[]): Point[] {
  return samples.map(({ x, y }) => ({ x, y }));
}

/** `appendSample` for a buffer the caller owns (no copy per sample); whether the sample was added. */
export function pushSample(buffer: Sample[], next: Sample): boolean {
  if (!Number.isFinite(next.x) || !Number.isFinite(next.y) || buffer.length >= MAX_RAW_SAMPLES) return false;
  const last = buffer[buffer.length - 1];
  if (last !== undefined && Math.hypot(next.x - last.x, next.y - last.y) < MIN_SAMPLE_DISTANCE_PT) return false;
  buffer.push(next);
  return true;
}

/** Raw samples of one stroke kept before smoothing and capping (a held pen on a long stroke). */
export const MAX_RAW_SAMPLES = 6000;

/** The SVG `points` attribute of a polygon. */
export function polygonPoints(points: readonly Point[]): string {
  return points.map((p) => `${p.x},${p.y}`).join(' ');
}
