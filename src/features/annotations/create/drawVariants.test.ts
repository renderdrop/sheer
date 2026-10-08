import { describe, expect, it } from 'vitest';

import { applyDrawVariant, arrowheadStrokes, closeLoop, endDirection } from './drawVariants';
import type { Sample } from './ink';

const s = (x: number, y: number): Sample => ({ x, y, pressure: 0.5 });

describe('Draw variants (F19.26)', () => {
  it('free hand stays the stroke as drawn', () => {
    const stroke = [s(0, 0), s(10, 2), s(20, 0)];
    expect(applyDrawVariant('free', stroke, 2)).toEqual([stroke]);
  });

  it('takes the direction of a straight stroke', () => {
    const dir = endDirection([s(0, 0), s(50, 0), s(100, 0)]);
    expect(dir?.x).toBeCloseTo(1);
    expect(dir?.y).toBeCloseTo(0);
  });

  it('takes the direction from the end of a curved stroke, not from its start', () => {
    // Up for a long way, then right for the last tenth.
    const stroke = [s(0, 100), s(0, 50), s(0, 10), s(5, 10), s(10, 10)];
    const dir = endDirection(stroke);
    expect(dir?.x).toBeGreaterThan(0.7);
    expect(Math.abs(dir?.y ?? 1)).toBeLessThan(0.7);
  });

  it('puts two wings behind the end, scaled with the width', () => {
    const stroke = [s(0, 0), s(50, 0), s(100, 0)];
    const thin = arrowheadStrokes(stroke, 1);
    const thick = arrowheadStrokes(stroke, 6);
    expect(thin).toHaveLength(2);
    for (const wing of thin) {
      expect(wing[0]).toMatchObject({ x: 100, y: 0 });
      expect(wing[1]?.x).toBeLessThan(100);
    }
    expect(thin[0]?.[1]?.y).toBeCloseTo(-(thin[1]?.[1]?.y ?? 0));
    expect(Math.abs(thick[0]?.[1]?.y ?? 0)).toBeGreaterThan(Math.abs(thin[0]?.[1]?.y ?? 0));
    expect(applyDrawVariant('arrow', stroke, 2)).toHaveLength(3);
  });

  it('makes no head for a dot', () => {
    expect(arrowheadStrokes([s(1, 1)], 2)).toEqual([]);
  });

  it('closes a nearly closed loop softly and leaves an open stroke alone', () => {
    const circle = Array.from({ length: 24 }, (_, i) =>
      s(50 + 40 * Math.cos((i * 2 * Math.PI) / 25), 50 + 40 * Math.sin((i * 2 * Math.PI) / 25)),
    );
    const closed = closeLoop(circle, 2);
    expect(closed.length).toBeGreaterThan(circle.length);
    expect(closed[closed.length - 1]).toMatchObject({ x: circle[0]?.x, y: circle[0]?.y });
    const open = Array.from({ length: 12 }, (_, i) => s(i * 10, 0));
    expect(closeLoop(open, 2)).toEqual(open);
  });
});
