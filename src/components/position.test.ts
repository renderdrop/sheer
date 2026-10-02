import { describe, expect, it } from 'vitest';

import { computePosition, type PositionInput } from './position';

const base: PositionInput = {
  anchor: { left: 100, top: 100, width: 40, height: 32 },
  floating: { width: 200, height: 100 },
  viewport: { width: 1000, height: 800 },
  side: 'bottom',
  align: 'start',
  offset: 8,
  margin: 8,
};

describe('computePosition', () => {
  it('puts the element below the anchor, aligned to its start, with the offset between them', () => {
    expect(computePosition(base)).toEqual({ x: 100, y: 140, side: 'bottom' });
  });

  it('centers on the anchor', () => {
    expect(computePosition({ ...base, align: 'center' }).x).toBe(20);
  });

  it('aligns the end edges', () => {
    expect(computePosition({ ...base, align: 'end', anchor: { left: 400, top: 100, width: 40, height: 32 } }).x).toBe(
      240,
    );
  });

  it('flips above when there is no room below', () => {
    const result = computePosition({ ...base, anchor: { left: 100, top: 740, width: 40, height: 32 } });
    expect(result.side).toBe('top');
    expect(result.y).toBe(740 - 8 - 100);
  });

  it('stays on the preferred side when the opposite side has less room', () => {
    const result = computePosition({
      ...base,
      anchor: { left: 100, top: 20, width: 40, height: 32 },
      viewport: { width: 1000, height: 120 },
    });
    expect(result.side).toBe('bottom');
  });

  it('shifts along the cross axis to stay a margin inside the window', () => {
    expect(computePosition({ ...base, anchor: { left: 950, top: 100, width: 40, height: 32 } }).x).toBe(1000 - 8 - 200);
    expect(computePosition({ ...base, align: 'end', anchor: { left: 2, top: 100, width: 40, height: 32 } }).x).toBe(8);
  });

  it('places tooltips to the right of panel anchors, vertically centered', () => {
    const result = computePosition({
      ...base,
      side: 'right',
      align: 'center',
      floating: { width: 80, height: 24 },
      anchor: { left: 20, top: 300, width: 32, height: 32 },
    });
    expect(result).toEqual({ x: 20 + 32 + 8, y: 300 + 16 - 12, side: 'right' });
  });

  it('flips to the left when the right side is too narrow', () => {
    const result = computePosition({
      ...base,
      side: 'right',
      floating: { width: 200, height: 24 },
      anchor: { left: 900, top: 300, width: 32, height: 32 },
    });
    expect(result.side).toBe('left');
    expect(result.x).toBe(900 - 8 - 200);
  });

  it('never covers the anchor while a side has room', () => {
    const result = computePosition({ ...base, anchor: { left: 400, top: 300, width: 40, height: 32 } });
    expect(result.y).toBeGreaterThanOrEqual(300 + 32);
  });

  it('starts at the margin when the element is larger than the window', () => {
    const result = computePosition({ ...base, floating: { width: 2000, height: 2000 } });
    expect(result.x).toBe(8);
    expect(result.y).toBe(8);
  });
});
