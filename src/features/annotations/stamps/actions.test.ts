import { describe, expect, it } from 'vitest';

import { replacedBox } from './actions';
import type { StampFace } from './model';

const face: StampFace = { stamp: 'custom', text: 'A LONG STAMP TEXT HERE', date: null };

describe('replacedBox (Change…)', () => {
  const old = { x: 500, y: 760, w: 96, h: 40 };

  it('keeps the centre and height when there is room', () => {
    const box = replacedBox({ x: 100, y: 100, w: 96, h: 40 }, face, [612, 792]);
    expect(box.h).toBe(40);
    expect(box.x + box.w / 2).toBeCloseTo(148, 5);
    expect(box.y).toBe(100);
  });

  it('is clamped to the page when the new text is wider or the stamp sits at an edge', () => {
    const box = replacedBox(old, face, [612, 792]);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.w).toBeLessThanOrEqual(612);
    expect(box.y + box.h).toBeLessThanOrEqual(792);
  });

  it('is not clamped without a page', () => {
    const box = replacedBox({ x: 600, y: 100, w: 96, h: 40 }, face, null);
    expect(box.x + box.w).toBeGreaterThan(612);
  });
});
