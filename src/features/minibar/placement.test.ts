import { describe, expect, it } from 'vitest';

import { placeBar, unionOf, type Box } from './placement';

const bounds: Box = { left: 0, top: 100, right: 1000, bottom: 700 };
const bar = { width: 300, height: 40 };
const box = (left: number, top: number, right: number, bottom: number): Box => ({ left, top, right, bottom });

describe('placeBar', () => {
  it('centres the bar above the selection, 8 away', () => {
    expect(placeBar(box(400, 300, 600, 400), bar, bounds)).toEqual({ mode: 'above', left: 350, top: 252 });
  });

  it('flips below when there is no room above (8 inset from the canvas edge)', () => {
    // 100 + 8 inset + 40 bar + 8 gap = 156: a selection at 150 does not leave room.
    expect(placeBar(box(400, 150, 600, 250), bar, bounds)).toEqual({ mode: 'below', left: 350, top: 258 });
  });

  it('keeps the bar above while it just fits', () => {
    expect(placeBar(box(400, 156, 600, 250), bar, bounds)).toEqual({ mode: 'above', left: 350, top: 108 });
  });

  it('docks when neither side has room, so it never covers the selection', () => {
    expect(placeBar(box(400, 120, 600, 690), bar, bounds)).toEqual({ mode: 'dock' });
  });

  it('clamps into the canvas with an 8 inset', () => {
    expect(placeBar(box(0, 300, 40, 400), bar, bounds)).toMatchObject({ left: 8 });
    expect(placeBar(box(960, 300, 1000, 400), bar, bounds)).toMatchObject({ left: 1000 - 8 - 300 });
  });

  it('keeps the right edge inside a 960 wide canvas, docks when the bar cannot fit', () => {
    const narrow = box(0, 100, 960, 700);
    const wide = { width: 420, height: 40 };
    const placed = placeBar(box(900, 300, 950, 400), wide, narrow);
    expect(placed).toMatchObject({ mode: 'above' });
    if (placed.mode !== 'dock') expect(placed.left + wide.width).toBeLessThanOrEqual(960 - 8);
    expect(placeBar(box(900, 300, 950, 400), { width: 950, height: 40 }, narrow)).toEqual({ mode: 'dock' });
  });

  it('docks when the canvas is narrower than the bar (no clipped bar, F19.17)', () => {
    expect(placeBar(box(10, 300, 50, 400), bar, box(0, 100, 200, 700))).toEqual({ mode: 'dock' });
  });
});

describe('unionOf', () => {
  it('is the box around all, null for none', () => {
    expect(unionOf([box(10, 20, 30, 40), box(0, 30, 50, 35)])).toEqual(box(0, 20, 50, 40));
    expect(unionOf([])).toBeNull();
  });
});
