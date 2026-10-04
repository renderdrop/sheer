/**
 * Signature ink (DESIGN 3.33, ADR-051): pointer samples to a closed outline made of cubic Béziers. One pure function serves the live
 * preview and the saved art, so what is drawn is what is saved. Pipeline: centripetal Catmull-Rom centreline (alpha 0.5), width from
 * velocity (fast thin, slow thick, eased, clamped to 0.45 to 1.5 times nominal and never under MIN_STROKE_PX) and pressure when the pen
 * reports it, offset curves on both sides, round caps. The samples first pass a One Euro filter (ADR-111) against hand jitter.
 */

import type { PathCmd } from '../../../api/pathcmd';

/** Path commands of the art contract (src/api/pathcmd.ts): absolute, y down. */
export type { PathCmd };

export interface InkSample {
  x: number;
  y: number;
  /** Milliseconds, any origin (`PointerEvent.timeStamp`). */
  t: number;
  /** 0 to 1; 0.5 is neutral (a mouse), a pen reports its own. */
  pressure: number;
}

export const MIN_WIDTH_FACTOR = 0.45;
export const MAX_WIDTH_FACTOR = 1.5;
/** Speeds (px per ms) at and below which the pen is "slow" (thickest) and at and above which it is "fast" (thinnest). */
const SLOW_SPEED = 0.2;
const FAST_SPEED = 2.5;
/** No stroke is ever thinner than this (px), whatever the speed or pressure. */
export const MIN_STROKE_PX = 1.4;

/**
 * One Euro filter parameters (Casiez et al., CHI 2012; ADR-111). `minCutoff` (Hz) is the smoothing at rest: lower is smoother but laggier.
 * `beta` raises the cutoff with speed (px/s) so fast strokes follow the pointer. `dCutoff` smooths the speed estimate.
 * A mouse is jittery (integer pixel steps): stronger smoothing. A pen (any non-neutral pressure) is already smooth.
 */
export interface OneEuroParams {
  minCutoff: number;
  beta: number;
  dCutoff: number;
}
export const MOUSE_FILTER: OneEuroParams = { minCutoff: 1.2, beta: 0.012, dCutoff: 1 };
export const PEN_FILTER: OneEuroParams = { minCutoff: 2.4, beta: 0.025, dCutoff: 1 };

/** Samples closer than this (px) to the one before are dropped. */
const MIN_DISTANCE = 0.3;
/** Outline points are about this far apart (px) along the centreline. */
const STEP_PX = 3;
const MAX_STEPS = 8;

type Vec = readonly [number, number];

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const r2 = (v: number): number => Math.round(v * 100) / 100;

/** Width factor from speed (eased) and pressure, clamped. */
export function widthFactor(speed: number, pressure: number): number {
  const k = clamp((speed - SLOW_SPEED) / (FAST_SPEED - SLOW_SPEED), 0, 1);
  const eased = k * k * (3 - 2 * k);
  const byVelocity = MAX_WIDTH_FACTOR - (MAX_WIDTH_FACTOR - MIN_WIDTH_FACTOR) * eased;
  const byPressure = 0.4 + 1.2 * clamp(Number.isFinite(pressure) ? pressure : 0.5, 0, 1);
  return clamp(byVelocity * byPressure, MIN_WIDTH_FACTOR, MAX_WIDTH_FACTOR);
}

const smoothingFactor = (dt: number, cutoff: number): number => 1 / (1 + 1 / (2 * Math.PI * cutoff * dt));

/** One Euro filter over the sample positions (time from `t`, ms). Timestamps and pressure are kept; the first sample is exact. */
export function oneEuro(samples: readonly InkSample[], params: OneEuroParams): InkSample[] {
  const out: InkSample[] = [];
  let dx = 0;
  let dy = 0;
  samples.forEach((s, i) => {
    const prev = out[i - 1];
    const prevRaw = samples[i - 1];
    if (prev === undefined || prevRaw === undefined) {
      out.push({ ...s });
      return;
    }
    const dt = Math.max(1, s.t - prevRaw.t) / 1000;
    const ad = smoothingFactor(dt, params.dCutoff);
    dx += ad * ((s.x - prevRaw.x) / dt - dx);
    dy += ad * ((s.y - prevRaw.y) / dt - dy);
    const a = smoothingFactor(dt, params.minCutoff + params.beta * Math.hypot(dx, dy));
    out.push({ ...s, x: prev.x + a * (s.x - prev.x), y: prev.y + a * (s.y - prev.y) });
  });
  return out;
}

interface Node {
  p: Vec;
  /** Half width in px. */
  h: number;
}

function prepare(samples: readonly InkSample[], width: number): Node[] {
  const dedup: InkSample[] = [];
  for (const s of samples) {
    if (!Number.isFinite(s.x) || !Number.isFinite(s.y)) continue;
    const last = dedup[dedup.length - 1];
    if (last !== undefined && Math.hypot(s.x - last.x, s.y - last.y) < MIN_DISTANCE) continue;
    dedup.push(s);
  }
  const isPen = dedup.some((s) => Math.abs(s.pressure - 0.5) > 1e-6);
  const kept = oneEuro(dedup, isPen ? PEN_FILTER : MOUSE_FILTER);
  const seg: number[] = [];
  for (let i = 0; i + 1 < kept.length; i += 1) {
    const a = kept[i];
    const b = kept[i + 1];
    if (a === undefined || b === undefined) continue;
    seg.push(Math.hypot(b.x - a.x, b.y - a.y) / Math.max(1, b.t - a.t));
  }
  let speed = kept.map((_, i) => {
    const before = seg[i - 1];
    const after = seg[i];
    return ((before ?? after ?? 0) + (after ?? before ?? 0)) / 2;
  });
  for (let pass = 0; pass < 2; pass += 1) {
    const prev = speed;
    speed = prev.map((v, i) => ((prev[i - 1] ?? v) + 2 * v + (prev[i + 1] ?? v)) / 4);
  }
  return kept.map((s, i) => ({
    p: [s.x, s.y],
    h: Math.max(MIN_STROKE_PX, width * widthFactor(speed[i] ?? 0, s.pressure)) / 2,
  }));
}

/** Cubic Bézier control points of the centripetal Catmull-Rom segment p1 to p2 (alpha 0.5). */
function segmentControls(p0: Vec, p1: Vec, p2: Vec, p3: Vec): [Vec, Vec] {
  const d1 = Math.sqrt(Math.hypot(p1[0] - p0[0], p1[1] - p0[1]));
  const d2 = Math.sqrt(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]));
  const d3 = Math.sqrt(Math.hypot(p3[0] - p2[0], p3[1] - p2[1]));
  if (d1 < 1e-6 || d2 < 1e-6 || d3 < 1e-6) {
    return [
      [p1[0] + (p2[0] - p1[0]) / 3, p1[1] + (p2[1] - p1[1]) / 3],
      [p2[0] - (p2[0] - p1[0]) / 3, p2[1] - (p2[1] - p1[1]) / 3],
    ];
  }
  const a1 = 2 * d1 * d1 + 3 * d1 * d2 + d2 * d2;
  const a2 = 2 * d3 * d3 + 3 * d3 * d2 + d2 * d2;
  const k1 = 3 * d1 * (d1 + d2);
  const k2 = 3 * d3 * (d3 + d2);
  return [
    [(d1 * d1 * p2[0] - d2 * d2 * p0[0] + a1 * p1[0]) / k1, (d1 * d1 * p2[1] - d2 * d2 * p0[1] + a1 * p1[1]) / k1],
    [(d3 * d3 * p1[0] - d2 * d2 * p3[0] + a2 * p2[0]) / k2, (d3 * d3 * p1[1] - d2 * d2 * p3[1] + a2 * p2[1]) / k2],
  ];
}

function cubicAt(a: Vec, b: Vec, c: Vec, d: Vec, s: number): Vec {
  const u = 1 - s;
  const w0 = u * u * u;
  const w1 = 3 * u * u * s;
  const w2 = 3 * u * s * s;
  const w3 = s * s * s;
  return [w0 * a[0] + w1 * b[0] + w2 * c[0] + w3 * d[0], w0 * a[1] + w1 * b[1] + w2 * c[1] + w3 * d[1]];
}

/** The centreline as dense nodes: the Catmull-Rom curve through the samples, width interpolated linearly. */
function centreline(nodes: readonly Node[]): Node[] {
  const out: Node[] = [];
  const last = nodes.length - 1;
  /** The point `i`, or for an index past either end the neighbour mirrored, so the curve leaves the end naturally. */
  const at = (i: number): Vec => {
    const here = nodes[clamp(i, 0, last)]?.p ?? [0, 0];
    if (i >= 0 && i <= last) return here;
    const near = nodes[i < 0 ? 1 : last - 1]?.p ?? here;
    return [2 * here[0] - near[0], 2 * here[1] - near[1]];
  };
  for (let i = 0; i < last; i += 1) {
    const a = nodes[i];
    const b = nodes[i + 1];
    if (a === undefined || b === undefined) continue;
    const [c1, c2] = segmentControls(at(i - 1), a.p, b.p, at(i + 2));
    const steps = clamp(Math.ceil(Math.hypot(b.p[0] - a.p[0], b.p[1] - a.p[1]) / STEP_PX), 1, MAX_STEPS);
    for (let k = 0; k < steps; k += 1) {
      const s = k / steps;
      out.push({ p: cubicAt(a.p, c1, c2, b.p, s), h: a.h + (b.h - a.h) * s });
    }
  }
  const end = nodes[last];
  if (end !== undefined) out.push(end);
  return out;
}

/** Cubic curve through `pts` (uniform Catmull-Rom), starting at the first point. */
function curveThrough(pts: readonly Vec[]): PathCmd[] {
  const cmds: PathCmd[] = [];
  for (let i = 0; i + 1 < pts.length; i += 1) {
    const p1 = pts[i];
    const p2 = pts[i + 1];
    if (p1 === undefined || p2 === undefined) continue;
    const p0 = pts[i - 1] ?? p1;
    const p3 = pts[i + 2] ?? p2;
    cmds.push([
      'C',
      r2(p1[0] + (p2[0] - p0[0]) / 6),
      r2(p1[1] + (p2[1] - p0[1]) / 6),
      r2(p2[0] - (p3[0] - p1[0]) / 6),
      r2(p2[1] - (p3[1] - p1[1]) / 6),
      r2(p2[0]),
      r2(p2[1]),
    ]);
  }
  return cmds;
}

/** Quarter-turn arcs of radius `r` around `c`, from angle `from`, each turning by `delta` (+-pi/2); cubic Béziers. */
function arcs(c: Vec, r: number, from: number, delta: number, count: number): PathCmd[] {
  const cmds: PathCmd[] = [];
  const k = (4 / 3) * Math.tan(delta / 4) * r;
  for (let i = 0; i < count; i += 1) {
    const a0 = from + i * delta;
    const a1 = a0 + delta;
    const x0 = c[0] + r * Math.cos(a0);
    const y0 = c[1] + r * Math.sin(a0);
    const x3 = c[0] + r * Math.cos(a1);
    const y3 = c[1] + r * Math.sin(a1);
    cmds.push([
      'C',
      r2(x0 - k * Math.sin(a0)),
      r2(y0 + k * Math.cos(a0)),
      r2(x3 + k * Math.sin(a1)),
      r2(y3 - k * Math.cos(a1)),
      r2(x3),
      r2(y3),
    ]);
  }
  return cmds;
}

/**
 * The closed outline of one stroke (one subpath, nonzero) with round caps. `width` is the nominal width in px. An empty list gives an
 * empty path; one sample (or all within a hair of each other) is a dot.
 */
export function inkOutline(samples: readonly InkSample[], width: number): PathCmd[] {
  const nodes = prepare(samples, width);
  const first = nodes[0];
  if (first === undefined) return [];
  if (nodes.length === 1) {
    return [['M', r2(first.p[0] + first.h), r2(first.p[1])], ...arcs(first.p, first.h, 0, Math.PI / 2, 4), ['Z']];
  }
  const line = centreline(nodes);
  const left: Vec[] = [];
  const right: Vec[] = [];
  let lastNormal: Vec = [0, 1];
  let firstNormal: Vec = [0, 1];
  line.forEach((node, i) => {
    const before = line[Math.max(0, i - 1)]?.p ?? node.p;
    const after = line[Math.min(line.length - 1, i + 1)]?.p ?? node.p;
    const dx = after[0] - before[0];
    const dy = after[1] - before[1];
    const len = Math.hypot(dx, dy);
    const normal: Vec = len < 1e-9 ? lastNormal : [-dy / len, dx / len];
    if (i === 0) firstNormal = normal;
    lastNormal = normal;
    left.push([node.p[0] + normal[0] * node.h, node.p[1] + normal[1] * node.h]);
    right.push([node.p[0] - normal[0] * node.h, node.p[1] - normal[1] * node.h]);
  });
  const head = line[0];
  const tail = line[line.length - 1];
  const l0 = left[0];
  if (head === undefined || tail === undefined || l0 === undefined) return [];
  const endAngle = Math.atan2(lastNormal[1], lastNormal[0]);
  const startAngle = Math.atan2(-firstNormal[1], -firstNormal[0]);
  return [
    ['M', r2(l0[0]), r2(l0[1])],
    ...curveThrough(left),
    ...arcs(tail.p, tail.h, endAngle, -Math.PI / 2, 2),
    ...curveThrough([...right].reverse()),
    ...arcs(head.p, head.h, startAngle, -Math.PI / 2, 2),
    ['Z'],
  ];
}

/** The outlines of all strokes as the art contract takes them; empty strokes are skipped. */
export function inkPaths(strokes: readonly (readonly InkSample[])[], width: number): PathCmd[][] {
  return strokes.map((stroke) => inkOutline(stroke, width)).filter((path) => path.length > 0);
}

/** The SVG path data of subpaths: one `d` string, filled with the nonzero rule. */
export function pathToD(paths: readonly (readonly PathCmd[])[]): string {
  return paths
    .map((path) => path.map((cmd) => (cmd.length === 1 ? cmd[0] : `${cmd[0]}${cmd.slice(1).join(' ')}`)).join(''))
    .join('');
}
