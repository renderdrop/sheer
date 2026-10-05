import { describe, expect, it } from 'vitest';

import { sealBox } from './summary';

describe('sealBox', () => {
  it('flips a file rectangle (origin bottom left) to page space (origin top left)', () => {
    // A seal near the top of a 612 x 792 page: lly 700, height 60 -> 32 pt from the top.
    expect(sealBox({ x: 72, y: 700, w: 200, h: 60 }, 792)).toEqual({ x: 72, y: 32, w: 200, h: 60 });
  });

  it('puts a seal at the bottom edge at the bottom of the page', () => {
    expect(sealBox({ x: 0, y: 0, w: 10, h: 20 }, 792).y).toBe(772);
  });
});
