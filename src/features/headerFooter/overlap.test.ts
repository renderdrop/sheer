import { describe, expect, it } from 'vitest';

import type { DetectedItem, PlacedRun } from '../../api/headerFooter';
import { backgroundRect, findOverlaps, overlappedItems, rectsOverlap, runRect } from './overlap';

const run = (patch: Partial<PlacedRun> = {}): PlacedRun => ({
  text: 'Seite 3',
  origin: { x: 28, y: 765 },
  angle: 0,
  size: 10,
  width: 40,
  ...patch,
});
const item = (x: number, y: number, w = 50, h = 9): DetectedItem => ({
  edge: 'footer',
  slot: 'left',
  kind: 'text',
  text: 'Draft',
  rect: { x, y, w, h },
  pages: 3,
});

describe('header and footer overlap', () => {
  it('boxes a run from the descender to the ascender', () => {
    const box = runRect(run());
    expect(box.x).toBeCloseTo(28);
    expect(box.w).toBeCloseTo(40);
    expect(box.y).toBeCloseTo(765 - 7.2);
    expect(box.h).toBeCloseTo(9.3);
    const padded = runRect(run(), 3);
    expect([padded.x, padded.w]).toEqual([25, 46]);
  });

  it('makes the background box the full glyph box plus padding, around the text box', () => {
    const box = backgroundRect(run());
    expect([box.x, box.w]).toEqual([25, 46]);
    expect(box.y).toBeCloseTo(765 - 9.31 - 3);
    expect(box.h).toBeCloseTo(9.31 + 2.25 + 6);
    const text = runRect(run(), 3);
    expect(box.y).toBeLessThan(text.y);
    expect(box.y + box.h).toBeGreaterThan(text.y + text.h);
  });

  it('turns the box with the page', () => {
    // angle 90: the text runs up the page (y gets smaller), glyph tops point to smaller x
    const box = runRect(run({ angle: 90, origin: { x: 34, y: 272 } }));
    expect(box.w).toBeCloseTo(9.3);
    expect(box.h).toBeCloseTo(40);
    expect(box.x).toBeCloseTo(34 - 7.2);
    expect(box.y).toBeCloseTo(272 - 40);
  });

  it('finds the existing text a new run lands on, per place', () => {
    const left = item(20, 757);
    const far = item(300, 757);
    const above = item(28, 700);
    const found = findOverlaps([run()], [left, far, above], false);
    expect(found.map((o) => o.item)).toEqual([left]);
    expect(overlappedItems(findOverlaps([run(), run({ origin: { x: 30, y: 765 } })], [left], false))).toEqual([left]);
  });

  it('counts the padding of the background box, and touching boxes are no overlap', () => {
    const near = item(70, 757, 30, 9);
    expect(findOverlaps([run()], [near], false)).toEqual([]);
    expect(findOverlaps([run()], [near], true)).toHaveLength(1);
    expect(rectsOverlap({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 10, h: 10 })).toBe(false);
  });
});
