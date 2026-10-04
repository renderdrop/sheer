import { describe, expect, it } from 'vitest';

import {
  MARGIN_FALLBACK,
  anchorOf,
  bubbleDate,
  columnLeft,
  initialOf,
  marginSlot,
  placeBubbles,
  visibleBubbles,
} from './layout';

describe('marginSlot', () => {
  it('is off when the margin is off', () => {
    expect(marginSlot(1000, false)).toEqual({ mode: 'off', reserve: 0, column: 0 });
  });

  it('reserves 256 (16 gap + 240) while the page keeps 360 or more', () => {
    expect(marginSlot(616, true, MARGIN_FALLBACK)).toEqual({ mode: 'full', reserve: 256, column: 240 });
    expect(marginSlot(1200, true, MARGIN_FALLBACK).reserve).toBe(256);
  });

  it('collapses to 32 px markers (48 with the gap) below 360 px of free page width', () => {
    expect(marginSlot(615, true, MARGIN_FALLBACK)).toEqual({ mode: 'compact', reserve: 48, column: 32 });
  });

  it('makes the fit width 256 smaller than the canvas', () => {
    const canvas = 900;
    expect(canvas - marginSlot(canvas, true, MARGIN_FALLBACK).reserve).toBe(644);
  });
});

describe('placeBubbles', () => {
  const item = (anchor: number, height = 100) => ({ anchor, height });

  it('puts each bubble at its anchor when there is room', () => {
    expect(placeBubbles([item(0), item(200), item(500)], 8)).toEqual([0, 200, 500]);
  });

  it('stacks close anchors 8 px apart', () => {
    expect(placeBubbles([item(0), item(20), item(30)], 8)).toEqual([0, 108, 216]);
  });

  it('keeps the pinned bubble at its anchor and restacks the others around it', () => {
    const tops = placeBubbles([item(0), item(20), item(30)], 8, 1);
    expect(tops[1]).toBe(20);
    expect(tops[2]).toBe(128);
    // The one above moves up so that it ends 8 above the pinned one.
    expect(tops[0]).toBe(-88);
  });

  it('handles no bubbles and an out of range pin', () => {
    expect(placeBubbles([], 8)).toEqual([]);
    expect(placeBubbles([item(5)], 8, 3)).toEqual([5]);
  });
});

describe('visibleBubbles and columnLeft', () => {
  it('mounts only the bubbles that meet the range', () => {
    expect(visibleBubbles([0, 500, 1000, 5000], [100, 100, 100, 100], 450, 1050)).toEqual([1, 2]);
  });

  it('puts the column 16 px right of the widest page, centred with it', () => {
    expect(columnLeft(644, 600, 16)).toBe(638);
  });
});

describe('anchorOf', () => {
  it('follows the annotation top at any zoom and turns with the view', () => {
    const box = { left: 100, top: 1000 };
    expect(anchorOf(box, 2, { x: 10, y: 20, w: 30, h: 5 }, [600, 800], 0)).toEqual({ top: 1040, right: 180 });
    expect(anchorOf(box, 1, { x: 10, y: 20, w: 30, h: 5 }, [600, 800], 90)).toEqual({ top: 1010, right: 880 });
    expect(anchorOf(box, 1, null, [600, 800], 0)).toEqual({ top: 1000, right: 100 });
  });
});

describe('bubble header', () => {
  it('shows the initial, empty for no name', () => {
    expect(initialOf(' anna')).toBe('A');
    expect(initialOf(null)).toBe('');
  });

  it('says Today with the time for today, else the short date', () => {
    const now = new Date(2024, 4, 10, 15, 0).getTime();
    expect(bubbleDate(new Date(2024, 4, 10, 14, 5).getTime(), 'en', now)).toMatch(/^Today 2:05/);
    expect(bubbleDate(new Date(2024, 4, 10, 14, 5).getTime(), 'de', now)).toMatch(/^Heute 14:05/);
    expect(bubbleDate(new Date(2024, 3, 1).getTime(), 'en', now)).toBe('4/1/24');
    expect(bubbleDate(null, 'en', now)).toBe('');
  });
});
