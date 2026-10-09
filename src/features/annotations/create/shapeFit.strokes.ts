import type { Sample } from './ink';

/**
 * Synthetic, seeded freehand strokes for the shape fit (F21.5): its unit tests and `scripts/ui/freehand-compare.mjs` use the same
 * ones. Each is a path with a slow hand wobble and a little jitter, sampled about every 1.5 points like a pointer.
 */

type Path = (t: number) => [number, number];

/** A deterministic pseudo random generator in [-0.5, 0.5). */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296 - 0.5;
  };
}

const TAU = 2 * Math.PI;

const ellipsePath =
  (cx: number, cy: number, rx: number, ry: number, angle: number, from: number, turns: number): Path =>
  (t) => {
    const a = from + t * turns * TAU;
    const u = rx * Math.cos(a);
    const v = ry * Math.sin(a);
    return [cx + u * Math.cos(angle) - v * Math.sin(angle), cy + u * Math.sin(angle) + v * Math.cos(angle)];
  };

/** A closed polygon walked from its first corner, `turns` times round (above 1 overshoots), corners rounded by `round` points. */
function polygonPath(corners: readonly [number, number][], turns: number, round: number, start = 0): Path {
  const n = corners.length;
  const pts: [number, number][] = [];
  for (let i = 0; i < n; i += 1) {
    const [px, py] = corners[(i + n - 1) % n] ?? [0, 0];
    const [x, y] = corners[i] ?? [0, 0];
    const [nx, ny] = corners[(i + 1) % n] ?? [0, 0];
    const lp = Math.hypot(x - px, y - py);
    const ln = Math.hypot(nx - x, ny - y);
    // A quadratic corner from `round` before the corner to `round` after it.
    const a: [number, number] = [x + ((px - x) * round) / lp, y + ((py - y) * round) / lp];
    const b: [number, number] = [x + ((nx - x) * round) / ln, y + ((ny - y) * round) / ln];
    for (let k = 0; k <= 4; k += 1) {
      const s = k / 4;
      pts.push([
        (1 - s) ** 2 * a[0] + 2 * (1 - s) * s * x + s * s * b[0],
        (1 - s) ** 2 * a[1] + 2 * (1 - s) * s * y + s * s * b[1],
      ]);
    }
  }
  const cum = [0];
  for (let i = 1; i <= pts.length; i += 1) {
    const [ax, ay] = pts[i - 1] ?? [0, 0];
    const [bx, by] = pts[i % pts.length] ?? [0, 0];
    cum.push((cum[i - 1] ?? 0) + Math.hypot(bx - ax, by - ay));
  }
  const total = cum[pts.length] ?? 1;
  // Start in the middle of the rounding of the first corner, plus `start` (a share of the perimeter).
  const offset = (cum[2] ?? 0) - (cum[0] ?? 0) + start * total;
  return (t) => {
    const target = (offset + t * turns * total) % total;
    let i = 0;
    while (i < pts.length - 1 && (cum[i + 1] ?? total) < target) i += 1;
    const [ax, ay] = pts[i] ?? [0, 0];
    const [bx, by] = pts[(i + 1) % pts.length] ?? [0, 0];
    const len = (cum[i + 1] ?? total) - (cum[i] ?? 0);
    const s = len > 0 ? (target - (cum[i] ?? 0)) / len : 0;
    return [ax + (bx - ax) * s, ay + (by - ay) * s];
  };
}

function turned(corners: [number, number][], cx: number, cy: number, angle: number): [number, number][] {
  return corners.map(([u, v]) => [
    cx + u * Math.cos(angle) - v * Math.sin(angle),
    cy + u * Math.sin(angle) + v * Math.cos(angle),
  ]);
}

interface StrokeSpec {
  path: Path;
  /** Approximate path length, for the sample count. */
  length: number;
  /** Amplitude of the slow wobble and of the jitter, in points. */
  wobble: number;
  jitter: number;
  seed: number;
}

const DEG = Math.PI / 180;

export const FREEHAND_STROKES = {
  circle: { path: ellipsePath(150, 150, 60, 60, 0, 0.4, 1.02), length: 385, wobble: 2.5, jitter: 0.8, seed: 11 },
  ellipse: {
    path: ellipsePath(200, 150, 90, 40, 30 * DEG, 1.2, 0.97),
    length: 410,
    wobble: 2.5,
    jitter: 0.8,
    seed: 12,
  },
  rectangle: {
    path: polygonPath(
      turned(
        [
          [-80, -45],
          [80, -45],
          [80, 45],
          [-80, 45],
        ],
        200,
        150,
        20 * DEG,
      ),
      1.03,
      5,
    ),
    length: 510,
    wobble: 2,
    jitter: 0.8,
    seed: 13,
  },
  square: {
    path: polygonPath(
      [
        [100, 100],
        [100, 200],
        [200, 200],
        [200, 100],
      ],
      0.98,
      4,
    ),
    length: 400,
    wobble: 2,
    jitter: 0.8,
    seed: 14,
  },
  overlap: { path: ellipsePath(150, 150, 60, 60, 0, 2.0, 1.15), length: 435, wobble: 2.5, jitter: 0.8, seed: 15 },
  gap: { path: ellipsePath(150, 150, 60, 60, 0, 5.0, 0.88), length: 330, wobble: 2.5, jitter: 0.8, seed: 16 },
  triangle: {
    path: polygonPath(
      [
        [150, 60],
        [230, 200],
        [70, 200],
      ],
      0.97,
      4,
      0.15,
    ),
    length: 480,
    wobble: 2,
    jitter: 0.8,
    seed: 17,
  },
  blob: {
    path: (t: number) => {
      const a = 0.7 + t * 0.99 * TAU;
      const r = 60 * (1 + 0.22 * Math.sin(3 * a) + 0.12 * Math.cos(2 * a));
      return [150 + r * Math.cos(a), 150 + r * Math.sin(a)];
    },
    length: 420,
    wobble: 2,
    jitter: 0.8,
    seed: 18,
  },
  arc: { path: ellipsePath(150, 150, 60, 60, 0, 0, 0.6), length: 230, wobble: 2, jitter: 0.8, seed: 19 },
} satisfies Record<string, StrokeSpec>;

export type FreehandStrokeName = keyof typeof FREEHAND_STROKES;

/** The raw pointer samples of a named stroke (deterministic). */
export function rawStroke(name: FreehandStrokeName): Sample[] {
  const spec: StrokeSpec = FREEHAND_STROKES[name];
  const random = rng(spec.seed);
  const count = Math.max(16, Math.round(spec.length / 1.5));
  // The slow wobble: two low harmonics per axis with seeded phases.
  const phases = Array.from({ length: 4 }, () => (random() + 0.5) * TAU);
  const freq = [1.3, 2.7, 1.9, 3.4];
  const slow = (t: number, k: number) =>
    spec.wobble *
    0.5 *
    (Math.sin(TAU * (freq[k] ?? 1) * t + (phases[k] ?? 0)) +
      Math.sin(TAU * (freq[k + 1] ?? 1) * t + (phases[k + 1] ?? 0)));
  return Array.from({ length: count }, (_, i) => {
    const t = i / (count - 1);
    const [x, y] = spec.path(t);
    return {
      x: x + slow(t, 0) + random() * spec.jitter,
      y: y + slow(t, 2) + random() * spec.jitter,
      pressure: 0.5,
    };
  });
}
