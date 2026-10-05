import { describe, expect, it } from 'vitest';

import {
  inkOutline,
  inkPaths,
  MIN_STROKE_PX,
  MOUSE_FILTER,
  oneEuro,
  PEN_FILTER,
  pathToD,
  widthFactor,
  type InkSample,
  type PathCmd,
} from '.';
import { strokesToOutlines } from '../create/model';

const line = (n: number, dx: number, dt: number, pressure = 0.5): InkSample[] =>
  Array.from({ length: n }, (_, i) => ({ x: i * dx, y: 0, t: i * dt, pressure }));

/** Every coordinate of the path, flattened to points (control points included, they bound the curve). */
function points(path: readonly PathCmd[]): [number, number][] {
  const out: [number, number][] = [];
  for (const cmd of path) {
    for (let i = 1; i + 1 < cmd.length; i += 2) out.push([Number(cmd[i]), Number(cmd[i + 1])]);
  }
  return out;
}
const maxAbsY = (path: readonly PathCmd[]) => Math.max(...points(path).map(([, y]) => Math.abs(y)));

describe('inkOutline', () => {
  it('a straight line is a closed outline of cubics with round caps', () => {
    const path = inkOutline(line(21, 10, 10), 4);
    expect(path[0]?.[0]).toBe('M');
    expect(path[path.length - 1]).toEqual(['Z']);
    expect(path.filter((c) => c[0] === 'L')).toHaveLength(0);
    expect(path.filter((c) => c[0] === 'C').length).toBeGreaterThan(8);
    const xs = points(path).map(([x]) => x);
    // The One Euro filter lags the end by a bounded distance (about 10 px at 1000 px/s); the start is exact.
    expect(Math.min(...xs)).toBeLessThan(-0.3);
    expect(Math.max(...xs)).toBeGreaterThan(170);
    expect(Math.max(...xs)).toBeLessThan(202);
    expect(maxAbsY(path)).toBeLessThan(4);
  });

  it('is thicker when slow than when fast, within the clamp', () => {
    const slow = maxAbsY(inkOutline(line(21, 0.5, 20), 10));
    const fast = maxAbsY(inkOutline(line(21, 50, 10), 10));
    expect(slow).toBeGreaterThan(fast * 1.5);
    expect(slow).toBeLessThanOrEqual(10 * 1.5 * 0.5 + 0.5);
    expect(fast).toBeGreaterThanOrEqual(10 * 0.45 * 0.5 - 0.1);
  });

  it('a single sample is a dot of four arcs', () => {
    const path = inkOutline([{ x: 10, y: 20, t: 0, pressure: 0.5 }], 6);
    expect(path.map((c) => c[0]).join('')).toBe('MCCCCZ');
    const xs = points(path).map(([x]) => x);
    expect(Math.min(...xs)).toBeCloseTo(10 - 4.5, 0);
    expect(Math.max(...xs)).toBeCloseTo(10 + 4.5, 0);
  });

  it('a harder press is wider', () => {
    const light = maxAbsY(inkOutline(line(15, 10, 10, 0.1), 6));
    const hard = maxAbsY(inkOutline(line(15, 10, 10, 1), 6));
    expect(hard).toBeGreaterThan(light * 1.5);
  });

  it('skips empty strokes and non-finite samples', () => {
    expect(inkOutline([], 4)).toEqual([]);
    expect(inkPaths([[], line(3, 10, 10)], 4)).toHaveLength(1);
    expect(inkOutline([{ x: Number.NaN, y: 0, t: 0, pressure: 0.5 }], 4)).toEqual([]);
  });

  it('keeps every coordinate finite for a repeated point and a reversal', () => {
    const samples: InkSample[] = [
      { x: 0, y: 0, t: 0, pressure: 0.5 },
      { x: 0, y: 0, t: 5, pressure: 0.5 },
      { x: 20, y: 0, t: 10, pressure: 0.5 },
      { x: 0, y: 1, t: 15, pressure: 0.5 },
    ];
    for (const [x, y] of points(inkOutline(samples, 4))) {
      expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true);
    }
  });
});

describe('widthFactor and pathToD', () => {
  it('clamps to 0.45 to 1.5 and eases between', () => {
    expect(widthFactor(0, 0.5)).toBeCloseTo(1.5);
    expect(widthFactor(100, 0.5)).toBeCloseTo(0.45);
    expect(widthFactor(0, 1)).toBe(1.5);
    expect(widthFactor(100, 0)).toBe(0.45);
  });
  it('writes SVG path data', () => {
    expect(
      pathToD([
        [['M', 1, 2], ['L', 3, 4], ['C', 1, 2, 3, 4, 5, 6], ['Z']],
        [['M', 0, 0], ['Z']],
      ]),
    ).toBe('M1 2L3 4C1 2 3 4 5 6ZM0 0Z');
  });
});

/** A tiny deterministic generator for jitter. */
function jittered(n: number, amp: number): { raw: InkSample[]; clean: InkSample[] } {
  let seed = 7;
  const rnd = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647 - 0.5;
  };
  const clean = Array.from({ length: n }, (_, i) => ({ x: i * 4, y: 20, t: i * 8, pressure: 0.5 }));
  const raw = clean.map((s) => ({ ...s, x: s.x + rnd() * 2 * amp, y: s.y + rnd() * 2 * amp }));
  return { raw, clean };
}

describe('oneEuro', () => {
  const rms = (a: readonly InkSample[], b: readonly InkSample[]) =>
    Math.sqrt(a.reduce((sum, s, i) => sum + (s.y - (b[i]?.y ?? 0)) ** 2, 0) / a.length);

  it('reduces jitter for mouse and pen settings', () => {
    const { raw, clean } = jittered(120, 1.5);
    for (const params of [MOUSE_FILTER, PEN_FILTER]) {
      const out = oneEuro(raw, params);
      expect(rms(out.slice(10), clean.slice(10))).toBeLessThan(rms(raw.slice(10), clean.slice(10)) * 0.6);
    }
    expect(MOUSE_FILTER.minCutoff).toBeLessThan(PEN_FILTER.minCutoff);
  });

  it('lags by about 10 px at 1000 px/s (ADR-111)', () => {
    const steady = Array.from({ length: 60 }, (_, i) => ({ x: i * 8, y: 0, t: i * 8, pressure: 0.5 }));
    const out = oneEuro(steady, MOUSE_FILTER);
    const lag = steady[steady.length - 1]!.x - (out[out.length - 1]?.x ?? 0);
    expect(lag).toBeGreaterThan(0);
    expect(lag).toBeLessThan(15);
  });

  it('keeps the first sample exact and the lag of a fast stroke bounded', () => {
    const fast = Array.from({ length: 60 }, (_, i) => ({ x: i * 16, y: 0, t: i * 8, pressure: 0.5 }));
    const out = oneEuro(fast, MOUSE_FILTER);
    expect(out[0]).toEqual(fast[0]);
    const last = out[out.length - 1]?.x ?? 0;
    // 2000 px/s: the filtered point trails by less than 40 px (20 ms).
    expect(fast[fast.length - 1]!.x - last).toBeLessThan(40);
    expect(fast[fast.length - 1]!.x - last).toBeGreaterThanOrEqual(0);
  });
});

describe('stroke width bounds and preview equals file', () => {
  it('never goes under the minimum stroke width, at any speed or pressure', () => {
    const hairline = line(30, 80, 5, 0.01);
    const path = inkOutline(hairline, 1);
    expect(maxAbsY(path)).toBeGreaterThanOrEqual(MIN_STROKE_PX / 2 - 0.05);
    const slowest = inkOutline(line(30, 0.5, 30, 1), 3);
    expect(maxAbsY(slowest)).toBeLessThanOrEqual((3 * 1.5) / 2 + 0.5);
  });

  it('the pad preview and the saved art are the same function of the same samples', () => {
    const { raw } = jittered(40, 1);
    const preview = pathToD([inkOutline(raw, 3)]);
    const saved = pathToD(strokesToOutlines([raw]));
    expect(saved).toBe(preview);
    expect(pathToD([inkOutline(raw, 3)])).toBe(preview);
    expect(strokesToOutlines([raw])[0]?.every((c) => c[0] === 'M' || c[0] === 'C' || c[0] === 'Z')).toBe(true);
  });
});
