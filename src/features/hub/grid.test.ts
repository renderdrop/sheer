import { describe, expect, it } from 'vitest';

import { gridTarget, type CardRect } from './grid';

/** Four columns, two rows, like the hub at 960 wide. */
const rects: CardRect[] = Array.from({ length: 8 }, (_, index) => ({
  left: (index % 4) * 216,
  top: Math.floor(index / 4) * 160,
  width: 208,
  height: 144,
}));

describe('gridTarget (DESIGN 3.54 keyboard)', () => {
  it('moves left and right by one without wrapping', () => {
    expect(gridTarget('ArrowRight', 0, rects)).toBe(1);
    expect(gridTarget('ArrowRight', 7, rects)).toBeNull();
    expect(gridTarget('ArrowLeft', 0, rects)).toBeNull();
    expect(gridTarget('ArrowLeft', 5, rects)).toBe(4);
  });

  it('moves up and down in the same column', () => {
    expect(gridTarget('ArrowDown', 1, rects)).toBe(5);
    expect(gridTarget('ArrowUp', 6, rects)).toBe(2);
    expect(gridTarget('ArrowDown', 5, rects)).toBeNull();
    expect(gridTarget('ArrowUp', 1, rects)).toBeNull();
  });

  it('follows the layout when the window is narrower (2 columns)', () => {
    const narrow = rects.map((rect, index) => ({ ...rect, left: (index % 2) * 216, top: Math.floor(index / 2) * 160 }));
    expect(gridTarget('ArrowDown', 1, narrow)).toBe(3);
    expect(gridTarget('ArrowDown', 6, narrow)).toBeNull();
  });

  it('Home and End jump, other keys are ignored', () => {
    expect(gridTarget('Home', 5, rects)).toBe(0);
    expect(gridTarget('End', 2, rects)).toBe(7);
    expect(gridTarget('a', 2, rects)).toBeNull();
    expect(gridTarget('ArrowRight', 0, [])).toBeNull();
  });
});
