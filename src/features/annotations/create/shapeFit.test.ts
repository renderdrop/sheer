import { describe, expect, it } from 'vitest';

import { applyDrawVariant } from './drawVariants';
import { smoothStroke, type Sample } from './ink';
import { fitFreehandShape, findLoop, SHAPE_SPACING_PT } from './shapeFit';
import { FREEHAND_STROKES, rawStroke } from './shapeFit.strokes';

/** The turn (radians) between the last and the first segment of a closed outline. */
function seamTurn(points: readonly Sample[]): number {
  const n = points.length;
  const a = points[n - 2];
  const b = points[n - 1];
  const c = points[1];
  if (a === undefined || b === undefined || c === undefined) return Infinity;
  const t1 = Math.atan2(b.y - a.y, b.x - a.x);
  const t2 = Math.atan2(c.y - b.y, c.x - b.x);
  return Math.abs(Math.atan2(Math.sin(t2 - t1), Math.cos(t2 - t1)));
}

/** The largest turn between two neighbouring segments anywhere along the outline (seam included). */
function maxTurn(points: readonly Sample[]): number {
  let max = 0;
  for (let i = 1; i < points.length - 1; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    const c = points[i + 1];
    if (a === undefined || b === undefined || c === undefined) continue;
    const t1 = Math.atan2(b.y - a.y, b.x - a.x);
    const t2 = Math.atan2(c.y - b.y, c.x - b.x);
    max = Math.max(max, Math.abs(Math.atan2(Math.sin(t2 - t1), Math.cos(t2 - t1))));
  }
  return max;
}

const SEAM_LIMIT = (8 * Math.PI) / 180;
const shape = (name: keyof typeof FREEHAND_STROKES) => fitFreehandShape(smoothStroke(rawStroke(name)), 2);

describe('freehand shape fit (F21.5)', () => {
  it.each([
    ['circle', 'circle'],
    ['ellipse', 'ellipse'],
    ['rectangle', 'rectangle'],
    ['square', 'rectangle'],
    ['overlap', 'circle'],
    ['gap', 'circle'],
    ['triangle', null],
    ['blob', null],
  ] as const)('classifies the %s stroke as %s', (name, kind) => {
    const result = shape(name);
    expect(result, name).not.toBeNull();
    expect(result?.kind, JSON.stringify(result?.errors)).toBe(kind);
  });

  it.each(['circle', 'ellipse', 'rectangle', 'square', 'overlap', 'gap', 'triangle', 'blob'] as const)(
    'closes the %s stroke without a seam',
    (name) => {
      const points = shape(name)?.points ?? [];
      expect(points.length).toBeGreaterThan(32);
      expect(points[points.length - 1]).toEqual(points[0]);
      expect(seamTurn(points)).toBeLessThan(SEAM_LIMIT);
    },
  );

  it('fits a clean round outline that keeps only a slight wobble', () => {
    const points = shape('circle')?.points ?? [];
    const cx = points.reduce((a, p) => a + p.x, 0) / points.length;
    const cy = points.reduce((a, p) => a + p.y, 0) / points.length;
    const radii = points.map((p) => Math.hypot(p.x - cx, p.y - cy));
    const mean = radii.reduce((a, b) => a + b, 0) / radii.length;
    const spread = Math.max(...radii) - Math.min(...radii);
    expect(mean).toBeGreaterThan(55);
    expect(mean).toBeLessThan(65);
    // Still hand-drawn (not a perfect circle), but well inside the drawn wobble.
    expect(spread).toBeGreaterThan(0.2);
    expect(spread / mean).toBeLessThan(0.06);
    expect(maxTurn(points)).toBeLessThan(SEAM_LIMIT);
  });

  it('puts the points about as dense as smoothed ink', () => {
    for (const name of ['circle', 'rectangle', 'triangle'] as const) {
      const points = shape(name)?.points ?? [];
      let length = 0;
      for (let i = 1; i < points.length; i += 1) {
        const a = points[i - 1];
        const b = points[i];
        if (a !== undefined && b !== undefined) length += Math.hypot(b.x - a.x, b.y - a.y);
      }
      const spacing = length / (points.length - 1);
      expect(spacing, name).toBeGreaterThan(SHAPE_SPACING_PT * 0.5);
      expect(spacing, name).toBeLessThan(SHAPE_SPACING_PT * 2.5);
    }
  });

  it('keeps the rectangle corners and orientation', () => {
    const points = shape('rectangle')?.points ?? [];
    // The drawn rectangle is 160 × 90, turned by 20 degrees about (200, 150).
    const angle = (20 * Math.PI) / 180;
    const local = points.map((p) => ({
      u: (p.x - 200) * Math.cos(angle) + (p.y - 150) * Math.sin(angle),
      v: -(p.x - 200) * Math.sin(angle) + (p.y - 150) * Math.cos(angle),
    }));
    expect(Math.max(...local.map((p) => p.u)) - Math.min(...local.map((p) => p.u))).toBeCloseTo(160, -1);
    expect(Math.max(...local.map((p) => p.v)) - Math.min(...local.map((p) => p.v))).toBeCloseTo(90, -1);
    // Corners are corners: a point lies near each of them.
    for (const [cu, cv] of [
      [80, 45],
      [-80, 45],
      [-80, -45],
      [80, -45],
    ] as const) {
      expect(Math.min(...local.map((p) => Math.hypot(p.u - cu, p.v - cv)))).toBeLessThan(5);
    }
  });

  it('trims overlapping ends instead of drawing them twice', () => {
    const points = shape('overlap')?.points ?? [];
    let length = 0;
    for (let i = 1; i < points.length; i += 1) {
      const a = points[i - 1];
      const b = points[i];
      if (a !== undefined && b !== undefined) length += Math.hypot(b.x - a.x, b.y - a.y);
    }
    expect(length).toBeLessThan(2 * Math.PI * 60 * 1.08);
  });

  it('leaves an open stroke open', () => {
    const open = smoothStroke(rawStroke('arc'));
    expect(findLoop(open, 2)).toBeNull();
    expect(fitFreehandShape(open, 2)).toBeNull();
    expect(applyDrawVariant('shape', open, 2)).toEqual([open]);
  });

  it('is deterministic', () => {
    for (const name of Object.keys(FREEHAND_STROKES) as (keyof typeof FREEHAND_STROKES)[]) {
      expect(shape(name)).toEqual(shape(name));
    }
  });

  it('stays an ink stroke for the shape variant and leaves pen and arrow alone', () => {
    const stroke = smoothStroke(rawStroke('circle'));
    const [closed, ...rest] = applyDrawVariant('shape', stroke, 2);
    expect(rest).toEqual([]);
    expect(closed?.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.pressure))).toBe(
      true,
    );
    expect(applyDrawVariant('free', stroke, 2)).toEqual([stroke]);
    expect(applyDrawVariant('arrow', stroke, 2)[0]).toEqual(stroke);
  });
});
