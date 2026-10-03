import { describe, expect, it } from 'vitest';

import type { PageCrop } from '../../api/pages';
import { boxToView, pageToView, viewToPage, type Rotation } from '../viewer/transform';
import {
  HANDLES,
  MIN_CROP_PT,
  MOVE,
  NO_MARGINS,
  boxOf,
  clampMargins,
  cursorOf,
  deltaToPage,
  dragMargins,
  drawMargins,
  handleOfSide,
  isValid,
  marginsOfBox,
  pageSideOf,
  viewHandle,
  type CropFrame,
  type Side,
} from './geometry';
import { formatMargin, parseMargin, ptToUnit, unitFor, unitToPt } from './units';

const ROTATIONS: Rotation[] = [0, 90, 180, 270];
const SIDES: Side[] = ['top', 'bottom', 'left', 'right'];
const PAGE: [number, number] = [600, 800];
const frame: CropFrame = { media: { width: 600, height: 800 }, bounds: NO_MARGINS };

const MIDDLE: Record<Side, { x: number; y: number }> = {
  top: { x: 0.5, y: 0 },
  bottom: { x: 0.5, y: 1 },
  left: { x: 0, y: 0.5 },
  right: { x: 1, y: 0.5 },
};

/** The side of the page whose middle is at the given side of the rotated page, found with the viewer's own transform. */
function sideAt(viewSide: Side, total: Rotation): Side {
  const want = MIDDLE[viewSide];
  const found = SIDES.find((side) => {
    const at = pageToView(MIDDLE[side], [1, 1], total);
    return Math.abs(at.x - want.x) < 1e-9 && Math.abs(at.y - want.y) < 1e-9;
  });
  if (found === undefined) throw new Error('no side');
  return found;
}

describe('view and page space', () => {
  it.each(ROTATIONS)('pageSideOf agrees with pageToView at %i', (total) => {
    for (const side of SIDES) expect(pageSideOf(side, total)).toBe(sideAt(side, total));
  });

  it.each(ROTATIONS)('deltaToPage is the difference of viewToPage at %i', (total) => {
    const a = viewToPage({ x: 10, y: 20 }, PAGE, total);
    const b = viewToPage({ x: 17, y: 31 }, PAGE, total);
    const d = deltaToPage(7, 11, total);
    expect(d.x).toBeCloseTo(b.x - a.x);
    expect(d.y).toBeCloseTo(b.y - a.y);
  });

  it('a handle points where it is seen: the left page edge at 90 degrees is on top', () => {
    expect(viewHandle({ x: -1, y: 0 }, 90)).toEqual({ x: 0, y: -1 });
    expect(cursorOf(viewHandle({ x: -1, y: 0 }, 90))).toBe('ns-resize');
    expect(cursorOf(viewHandle({ x: -1, y: -1 }, 0))).toBe('nwse-resize');
    expect(cursorOf(viewHandle({ x: -1, y: -1 }, 90))).toBe('nesw-resize');
    expect(cursorOf(MOVE)).toBe('move');
  });

  it.each(ROTATIONS)('dragging the right edge on screen by 10 moves it by 10 on screen at %i', (total) => {
    const start: PageCrop = { top: 100, right: 100, bottom: 100, left: 100 };
    const before = boxToView(boxOf(start, frame), PAGE, total);
    // What the layer does: the view movement becomes a page movement, the edge on screen becomes a page side.
    const d = deltaToPage(10, 0, total);
    const next = dragMargins(start, handleOfSide(pageSideOf('right', total)), d.x, d.y, frame);
    const after = boxToView(boxOf(next, frame), PAGE, total);
    expect(after.x + after.w - (before.x + before.w)).toBeCloseTo(10);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.h).toBeCloseTo(before.h);
  });

  it.each(ROTATIONS)('moving the rectangle by (10, 20) on screen moves it so at %i', (total) => {
    const start: PageCrop = { top: 100, right: 100, bottom: 100, left: 100 };
    const before = boxToView(boxOf(start, frame), PAGE, total);
    const d = deltaToPage(10, 20, total);
    const after = boxToView(boxOf(dragMargins(start, MOVE, d.x, d.y, frame), frame), PAGE, total);
    expect(after.x - before.x).toBeCloseTo(10);
    expect(after.y - before.y).toBeCloseTo(20);
  });
});

describe('box and margins', () => {
  it('are inverse', () => {
    const margins: PageCrop = { top: 10, right: 20, bottom: 30, left: 40 };
    const cropped: CropFrame = { media: frame.media, bounds: { top: 5, right: 5, bottom: 5, left: 5 } };
    const box = boxOf(margins, cropped);
    expect(box).toEqual({ x: 35, y: 5, w: 540, h: 760 });
    expect(marginsOfBox(box, cropped)).toEqual(margins);
  });

  it('isValid enforces the minimum and the shown part', () => {
    expect(isValid(NO_MARGINS, frame)).toBe(true);
    expect(isValid({ top: 0, right: 0, bottom: 0, left: 600 - MIN_CROP_PT + 1 }, frame)).toBe(false);
    expect(isValid({ top: 0, right: 0, bottom: 0, left: 600 - MIN_CROP_PT }, frame)).toBe(true);
    const cropped: CropFrame = { media: frame.media, bounds: { top: 10, right: 0, bottom: 0, left: 0 } };
    expect(isValid({ top: 5, right: 0, bottom: 0, left: 0 }, cropped)).toBe(false);
    expect(isValid({ top: Number.NaN, right: 0, bottom: 0, left: 0 }, frame)).toBe(false);
  });
});

describe('dragMargins', () => {
  const start: PageCrop = { top: 100, right: 100, bottom: 100, left: 100 };

  it('moves the rectangle and keeps it inside', () => {
    expect(dragMargins(start, MOVE, 30, -20, frame)).toEqual({ top: 80, right: 70, bottom: 120, left: 130 });
    const far = dragMargins(start, MOVE, 1000, 1000, frame);
    expect(far.right).toBe(0);
    expect(far.bottom).toBe(0);
    expect(far.left).toBe(200);
  });

  it('resizes by the handle and never under the minimum', () => {
    expect(dragMargins(start, { x: -1, y: -1 }, 20, 10, frame)).toEqual({ ...start, left: 120, top: 110 });
    const tiny = dragMargins(start, { x: 1, y: 0 }, -1000, 0, frame);
    expect(600 - tiny.left - tiny.right).toBe(MIN_CROP_PT);
  });

  it('never leaves the shown part', () => {
    const cropped: CropFrame = { media: frame.media, bounds: { top: 50, right: 50, bottom: 50, left: 50 } };
    const next = dragMargins(cropped.bounds, { x: -1, y: -1 }, -500, -500, cropped);
    expect(next.left).toBe(50);
    expect(next.top).toBe(50);
  });

  it('snaps an edge to the page edge near it', () => {
    expect(dragMargins(start, { x: -1, y: 0 }, -97, 0, frame, { snap: 4 }).left).toBe(0);
    expect(dragMargins(start, { x: -1, y: 0 }, -90, 0, frame, { snap: 4 }).left).toBe(10);
    expect(dragMargins(start, MOVE, -98, 0, frame, { snap: 4 })).toMatchObject({ left: 0, right: 200 });
  });

  it('keeps the aspect on a corner with Shift', () => {
    const next = dragMargins(start, { x: 1, y: 1 }, -50, 0, frame, { keepAspect: true });
    const w = 600 - next.left - next.right;
    const h = 800 - next.top - next.bottom;
    expect(w / h).toBeCloseTo(400 / 600, 1);
  });

  it('every handle gives a valid rectangle at any drag', () => {
    for (const handle of HANDLES) {
      for (const [dx, dy] of [
        [-900, -900],
        [900, 900],
        [5, -5],
      ] as const) {
        expect(isValid(dragMargins(start, handle, dx, dy, frame), frame)).toBe(true);
      }
    }
  });
});

describe('drawMargins and clampMargins', () => {
  it('draws from one corner to the other, either way', () => {
    const a = drawMargins({ x: 50, y: 60 }, { x: 350, y: 460 }, frame);
    expect(a).toEqual({ left: 50, top: 60, right: 250, bottom: 340 });
    expect(drawMargins({ x: 350, y: 460 }, { x: 50, y: 60 }, frame)).toEqual(a);
  });

  it('clamps to the minimum size', () => {
    const next = clampMargins({ top: 0, bottom: 0, left: 590, right: 590 }, frame);
    expect(600 - next.left - next.right).toBeGreaterThanOrEqual(MIN_CROP_PT);
  });
});

describe('units', () => {
  it('converts between points and the unit', () => {
    expect(ptToUnit(72, 'in')).toBe(1);
    expect(ptToUnit(72, 'mm')).toBeCloseTo(25.4);
    expect(unitToPt(25.4, 'mm')).toBeCloseTo(72);
    expect(unitFor('de')).toBe('mm');
    expect(unitFor('en')).toBe('in');
  });

  it('formats and parses with a point or a comma', () => {
    expect(formatMargin(36, 'in', 'en')).toBe('0.5');
    expect(formatMargin(72, 'mm', 'de')).toBe('25,4');
    expect(parseMargin('25,4', 'mm')).toBeCloseTo(72);
    expect(parseMargin('0.5', 'in')).toBe(36);
    expect(parseMargin('', 'in')).toBeNull();
    expect(parseMargin('-1', 'in')).toBeNull();
    expect(parseMargin('abc', 'mm')).toBeNull();
  });
});
