import { describe, expect, it } from 'vitest';

import {
  arrowTarget,
  cellOrigin,
  cellsInRect,
  clampThumb,
  contentHeight,
  gridMetrics,
  insertionAt,
  isNoopMove,
  keyboardMove,
  markerRect,
  revealTop,
  selectByClick,
  toIndexFor,
  visibleRange,
  type GridSpacing,
} from './grid';

const SPACING: GridSpacing = { padding: 24, gap: 24, cellPad: 4, labelGap: 8, labelHeight: 20 };
// thumb 160: a cell is 168 x 196, steps are 192 x 220. A width of 2 * 24 + 4 * 192 - 24 = 792 fits four columns.
const m = gridMetrics(792, 160, SPACING);

describe('clampThumb', () => {
  it('snaps to the step and stays in range', () => {
    expect(clampThumb(100)).toBe(96);
    expect(clampThumb(150)).toBe(160);
    expect(clampThumb(1000)).toBe(256);
    expect(clampThumb(0)).toBe(96);
    expect(clampThumb(Number.NaN)).toBe(160);
  });
});

describe('gridMetrics', () => {
  it('fits columns into the width and always has one', () => {
    expect(m.cols).toBe(4);
    expect(m.cellWidth).toBe(168);
    expect(m.cellHeight).toBe(196);
    expect(gridMetrics(10, 256, SPACING).cols).toBe(1);
  });

  it('centres the columns in a wider grid', () => {
    const wide = gridMetrics(792 + 100, 160, SPACING);
    expect(wide.cols).toBe(4);
    expect(wide.left).toBe(24 + 50);
  });

  it('lays cells out row by row', () => {
    expect(cellOrigin(m, 0)).toEqual({ left: 24, top: 24 });
    expect(cellOrigin(m, 5)).toEqual({ left: 24 + 192, top: 24 + 220 });
    expect(contentHeight(m, 0)).toBe(0);
    expect(contentHeight(m, 5)).toBe(2 * 24 + 2 * 196 + 24);
  });
});

describe('visibleRange', () => {
  it('returns the rows in view with an overscan, clamped to the pages', () => {
    expect(visibleRange(m, 100, 0, 300, 0)).toEqual({ first: 0, last: 7 });
    expect(visibleRange(m, 10, 0, 300, 5)).toEqual({ first: 0, last: 9 });
    expect(visibleRange(m, 0, 0, 300)).toBeNull();
    expect(visibleRange(m, 100, 0, 0)).toBeNull();
  });

  it('reveals a row that is out of view', () => {
    expect(revealTop(m, 0, 0, 400)).toBeNull();
    expect(revealTop(m, 12, 0, 400)).toBeGreaterThan(0);
    expect(revealTop(m, 0, 1000, 400)).toBe(0);
  });
});

describe('insertionAt', () => {
  it('finds the nearest gap', () => {
    // The gap before the first cell of the first row.
    expect(insertionAt(m, 10, 10, 50)).toMatchObject({ index: 0, row: 0, col: 0 });
    // Between the first and second cells.
    expect(insertionAt(m, 10, 24 + 168 + 12, 50)).toMatchObject({ index: 1, col: 1 });
    // Past the last cell of a full row stays in that row.
    expect(insertionAt(m, 10, 800, 50)).toMatchObject({ index: 4, row: 0, col: 4 });
  });

  it('stops at the end of a short last row and below the grid', () => {
    expect(insertionAt(m, 10, 800, 2000)).toMatchObject({ index: 10, row: 2, col: 2 });
    expect(insertionAt(m, 0, 5, 5)).toEqual({ index: 0, row: 0, col: 0 });
  });

  it('puts the marker in the gap, as tall as a cell', () => {
    const marker = markerRect(m, { index: 1, row: 0, col: 1 }, 2);
    expect(marker.height).toBe(196);
    expect(marker.top).toBe(24);
    expect(marker.left).toBe(24 + 192 - 12 - 1);
  });
});

describe('moves', () => {
  it('counts the destination in the list without the moved pages', () => {
    expect(toIndexFor([0, 1], 5)).toBe(3);
    expect(toIndexFor([6], 2)).toBe(2);
    expect(toIndexFor([2], 3)).toBe(2);
  });

  it('knows a move that changes nothing', () => {
    expect(isNoopMove([2, 3], 2)).toBe(true);
    expect(isNoopMove([2, 4], 2)).toBe(false);
    expect(isNoopMove([2], 3)).toBe(false);
    expect(isNoopMove([], 0)).toBe(true);
  });

  it('moves by keys, stopping at the ends', () => {
    expect(keyboardMove([3], 10, 1)).toEqual({ toIndex: 4 });
    expect(keyboardMove([3, 4], 10, -1)).toEqual({ toIndex: 2 });
    expect(keyboardMove([0], 10, -1)).toBeNull();
    expect(keyboardMove([9], 10, 1)).toBeNull();
    expect(keyboardMove([6, 7], 10, 4)).toEqual({ toIndex: 8 });
    expect(keyboardMove([8, 9], 10, 1)).toBeNull();
  });
});

describe('selectByClick', () => {
  const order = [10, 11, 12, 13, 14];
  it('selects one, toggles with primary, ranges with Shift', () => {
    expect(selectByClick(order, [11], 11, 13, { toggle: false, range: false })).toEqual({ selected: [13], anchor: 13 });
    expect(selectByClick(order, [11], 11, 13, { toggle: true, range: false })).toEqual({
      selected: [11, 13],
      anchor: 13,
    });
    expect(selectByClick(order, [11, 13], 13, 13, { toggle: true, range: false })).toEqual({
      selected: [11],
      anchor: 13,
    });
    expect(selectByClick(order, [11], 11, 13, { toggle: false, range: true })).toEqual({
      selected: [11, 12, 13],
      anchor: 11,
    });
    expect(selectByClick(order, [14], 14, 12, { toggle: false, range: true }).selected).toEqual([12, 13, 14]);
  });

  it('starts a range from the clicked page when there is no anchor', () => {
    expect(selectByClick(order, [], null, 12, { toggle: false, range: true })).toEqual({ selected: [12], anchor: 12 });
  });
});

describe('arrowTarget and marquee', () => {
  it('moves by cell and by row', () => {
    expect(arrowTarget(m, 10, 0, 'ArrowRight')).toBe(1);
    expect(arrowTarget(m, 10, 0, 'ArrowLeft')).toBeNull();
    expect(arrowTarget(m, 10, 1, 'ArrowDown')).toBe(5);
    expect(arrowTarget(m, 10, 7, 'ArrowDown')).toBe(9);
    expect(arrowTarget(m, 10, 9, 'ArrowDown')).toBeNull();
    expect(arrowTarget(m, 10, 5, 'ArrowUp')).toBe(1);
    expect(arrowTarget(m, 10, 5, 'End')).toBe(9);
    expect(arrowTarget(m, 10, 5, 'x')).toBeNull();
  });

  it('selects the cells a rectangle touches', () => {
    expect(cellsInRect(m, 10, { left: 0, top: 0, right: 30, bottom: 30 })).toEqual([0]);
    expect(cellsInRect(m, 10, { left: 0, top: 0, right: 420, bottom: 30 })).toEqual([0, 1, 2]);
    expect(cellsInRect(m, 10, { left: 0, top: 0, right: 1000, bottom: 1000 })).toHaveLength(10);
    expect(cellsInRect(m, 10, { left: 600, top: 300, right: 700, bottom: 400 })).toEqual([7]);
    expect(cellsInRect(m, 10, { left: 600, top: 470, right: 700, bottom: 600 })).toEqual([]);
  });
});
