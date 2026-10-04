import { describe, expect, it } from 'vitest';

import { inkOutline, inkPaths, pathToD, widthFactor, type InkSample, type PathCmd } from '.';

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
    // The caps reach past both ends by about the half width.
    expect(Math.min(...xs)).toBeLessThan(-0.3);
    expect(Math.max(...xs)).toBeGreaterThan(200.3);
    expect(maxAbsY(path)).toBeLessThan(4);
  });

  it('is thicker when slow than when fast, within the clamp', () => {
    const slow = maxAbsY(inkOutline(line(21, 0.5, 20), 10));
    const fast = maxAbsY(inkOutline(line(21, 50, 10), 10));
    expect(slow).toBeGreaterThan(fast * 2);
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
