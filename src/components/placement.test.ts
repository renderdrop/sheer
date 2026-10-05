import { describe, expect, it } from 'vitest';

import { candidatesFor, computePlacement, type PlacementInput } from './position';

const base: PlacementInput = {
  anchor: { left: 400, top: 300, width: 40, height: 30 },
  floating: { width: 100, height: 60 },
  viewport: { width: 1000, height: 700 },
  kind: 'popover',
  side: 'bottom',
  align: 'start',
  offset: 8,
  margin: 8,
  protectedRects: [],
};

describe('placement order', () => {
  it('follows the spec per kind', () => {
    expect(candidatesFor('tooltip', 'top', 'center').map((c) => c.side)).toEqual(['top', 'bottom', 'right', 'left']);
    expect(candidatesFor('popover', 'bottom', 'start').map((c) => `${c.side}-${c.align}`)).toEqual([
      'bottom-start',
      'bottom-end',
      'top-start',
      'top-end',
      'right-start',
      'left-start',
    ]);
    expect(candidatesFor('coach', 'right', 'center').map((c) => c.side)).toEqual(['right', 'left', 'top', 'bottom']);
  });
});

describe('computePlacement', () => {
  it('takes the first candidate when it fits', () => {
    expect(computePlacement(base)).toEqual({ x: 400, y: 338, side: 'bottom' });
  });

  it('flips to the opposite side when the preferred one overflows', () => {
    const placed = computePlacement({ ...base, anchor: { left: 400, top: 650, width: 40, height: 30 } });
    expect(placed?.side).toBe('top');
    expect(placed?.y).toBe(650 - 8 - 60);
  });

  it('shifts along the edge to stay inside the inset', () => {
    const placed = computePlacement({ ...base, anchor: { left: 960, top: 300, width: 30, height: 30 } });
    expect(placed).toEqual({ x: 1000 - 8 - 100, y: 338, side: 'bottom' });
  });

  it('avoids a protected rect by taking the next candidate', () => {
    const blocker = { left: 380, top: 335, width: 300, height: 80 };
    const placed = computePlacement({ ...base, protectedRects: [blocker] });
    expect(placed?.side).toBe('top');
  });

  it('returns null when every candidate collides', () => {
    const everything = { left: 0, top: 0, width: 1000, height: 700 };
    const anchor = { left: 400, top: 300, width: 40, height: 30 };
    // The anchor is part of the protected set and lies inside; the surface cannot avoid a rect covering the window.
    expect(computePlacement({ ...base, anchor, protectedRects: [everything] })).toBeNull();
  });

  it('dialog threshold: fits at the viewport minus the inset, not beyond', () => {
    const anchor = { left: 20, top: 8, width: 40, height: 20 };
    const side = { ...base, anchor, side: 'right' as const };
    // 640 - 2 * 8 = 624 is the tallest surface that fits.
    expect(
      computePlacement({ ...side, viewport: { width: 960, height: 640 }, floating: { width: 300, height: 624 } }),
    ).not.toBeNull();
    expect(
      computePlacement({ ...side, viewport: { width: 960, height: 640 }, floating: { width: 300, height: 625 } }),
    ).toBeNull();
  });

  it('returns null when it fits beside no side of the anchor', () => {
    expect(
      computePlacement({
        ...base,
        viewport: { width: 400, height: 300 },
        anchor: { left: 150, top: 100, width: 100, height: 100 },
        floating: { width: 380, height: 280 },
      }),
    ).toBeNull();
  });
});

describe('coach mark placement', () => {
  const coach: PlacementInput = { ...base, kind: 'coach', anchor: { left: 400, top: 40, width: 40, height: 30 } };
  it('starts below the row it must clear and tests the box there', () => {
    const row = { left: 0, top: 80, width: 1000, height: 30 };
    const placed = computePlacement({ ...coach, minTop: 120, protectedRects: [row] });
    expect(placed).toMatchObject({ side: 'bottom', y: 120 });
  });
  it('slides along the edge past a control it would cover', () => {
    const button = { left: 430, top: 100, width: 60, height: 30 };
    const placed = computePlacement({ ...coach, protectedRects: [button] });
    expect(placed).not.toBeNull();
    expect(placed?.x === 330 || placed?.x === 490).toBe(true);
  });
  it('waits (null) when nothing is free', () => {
    const wall = { left: 0, top: 0, width: 1000, height: 700 };
    expect(computePlacement({ ...coach, protectedRects: [wall] })).toBeNull();
  });
  it('does not slide a popover', () => {
    const button = { left: 430, top: 340, width: 60, height: 30 };
    const placed = computePlacement({ ...base, protectedRects: [button] });
    expect(placed?.side).not.toBe('bottom');
  });
});
