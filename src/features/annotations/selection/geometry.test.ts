import { describe, expect, it } from 'vitest';

import type { Annotation } from '../../../api/annotations';
import {
  arrowStep,
  canMove,
  clampMove,
  handlesOf,
  patchOf,
  readingOrder,
  resizeRect,
  resized,
  translated,
  unionOf,
} from './geometry';

const base = {
  id: 1,
  pageId: 0,
  color: [0, 0, 0],
  opacity: 1,
  contents: '',
  author: null,
  modified: null,
  inReplyTo: null,
  locked: false,
  sync: 'new',
} as const;

const rect = (box = { x: 10, y: 20, w: 40, h: 30 }): Annotation =>
  ({ ...base, rect: box, kind: 'rect', box, width: 1, fill: null, dashed: false }) as Annotation;
const line = (): Annotation =>
  ({
    ...base,
    rect: { x: 9, y: 9, w: 32, h: 12 },
    kind: 'line',
    from: { x: 10, y: 10 },
    to: { x: 40, y: 20 },
    width: 2,
    head: 'none',
    tail: 'none',
  }) as Annotation;
const ink = (): Annotation =>
  ({
    ...base,
    rect: { x: 0, y: 0, w: 10, h: 10 },
    kind: 'ink',
    width: 1,
    strokes: [
      {
        points: [{ x: 5, y: 5 }],
        outline: [
          { x: 0, y: 0 },
          { x: 10, y: 10 },
        ],
      },
    ],
  }) as Annotation;
const note = (): Annotation =>
  ({ ...base, rect: { x: 5, y: 5, w: 20, h: 20 }, kind: 'note', at: { x: 5, y: 5 }, icon: 'note' }) as Annotation;

const PAGE: [number, number] = [100, 200];

describe('handles', () => {
  it('a box has eight, a line its two ends, ink its corners, the rest and locked ones none', () => {
    expect(handlesOf(rect())).toHaveLength(8);
    expect(handlesOf(line())).toEqual(['from', 'to']);
    expect(handlesOf(ink())).toHaveLength(4);
    expect(handlesOf(note())).toEqual([]);
    expect(handlesOf({ ...rect(), locked: true })).toEqual([]);
  });

  it('only unlocked, editable annotations move', () => {
    expect(canMove(rect())).toBe(true);
    expect(canMove({ ...rect(), locked: true })).toBe(false);
    expect(canMove({ ...base, rect: { x: 0, y: 0, w: 1, h: 1 }, kind: 'opaque', subtype: 'Stamp' } as Annotation)).toBe(
      false,
    );
  });
});

describe('translated', () => {
  it('moves the body and the box together', () => {
    const moved = translated(rect(), 5, -5);
    expect(moved).toMatchObject({ box: { x: 15, y: 15 }, rect: { x: 15, y: 15 } });
    const l = translated(line(), 1, 2) as Extract<Annotation, { kind: 'line' }>;
    expect(l.from).toEqual({ x: 11, y: 12 });
    expect(l.rect).toMatchObject({ x: 10, y: 11 });
  });

  it('is the same object for no move', () => {
    const a = rect();
    expect(translated(a, 0, 0)).toBe(a);
  });

  it('moves every point of ink', () => {
    const moved = translated(ink(), 1, 1) as Extract<Annotation, { kind: 'ink' }>;
    expect(moved.strokes[0]?.outline[1]).toEqual({ x: 11, y: 11 });
  });
});

describe('clampMove', () => {
  it('keeps the union on the page', () => {
    expect(clampMove([{ x: 10, y: 10, w: 20, h: 20 }], -50, 500, PAGE)).toEqual({ x: -10, y: 170 });
  });

  it('leaves a move alone without a page', () => {
    expect(clampMove([{ x: 10, y: 10, w: 20, h: 20 }], -50, 5, null)).toEqual({ x: -50, y: 5 });
  });

  it('unions rectangles', () => {
    expect(
      unionOf([
        { x: 0, y: 0, w: 5, h: 5 },
        { x: 10, y: 10, w: 5, h: 5 },
      ]),
    ).toEqual({ x: 0, y: 0, w: 15, h: 15 });
    expect(unionOf([])).toBeNull();
  });
});

describe('resizeRect', () => {
  const frame = { x: 10, y: 10, w: 40, h: 20 };
  it('moves the edges of the handle and keeps the opposite ones', () => {
    expect(resizeRect(frame, 'se', 10, 5, false, PAGE)).toEqual({ x: 10, y: 10, w: 50, h: 25 });
    expect(resizeRect(frame, 'w', -5, 0, false, PAGE)).toEqual({ x: 5, y: 10, w: 45, h: 20 });
  });

  it('does not collapse below the minimum or leave the page', () => {
    expect(resizeRect(frame, 'e', -100, 0, false, PAGE).w).toBeGreaterThan(0);
    expect(resizeRect(frame, 'se', 500, 500, false, PAGE)).toMatchObject({ w: 90, h: 190 });
  });

  it('keeps the aspect of a corner', () => {
    const r = resizeRect(frame, 'se', 40, 0, true, PAGE);
    expect(r.w / r.h).toBeCloseTo(2);
  });
});

describe('resized', () => {
  it('resizes the box and keeps the margin of the bounding box', () => {
    const a = { ...rect(), rect: { x: 9, y: 19, w: 42, h: 32 } } as Annotation;
    const r = resized(a, 'se', 10, 10, false, PAGE) as Extract<Annotation, { kind: 'rect' | 'ellipse' }>;
    expect(r.box).toEqual({ x: 10, y: 20, w: 50, h: 40 });
    expect(r.rect).toEqual({ x: 9, y: 19, w: 52, h: 42 });
    expect(patchOf(r)).toEqual({ box: r.box });
  });

  it('moves one end of a line', () => {
    const r = resized(line(), 'to', 5, 0, false, PAGE) as Extract<Annotation, { kind: 'line' }>;
    expect(r.to).toEqual({ x: 45, y: 20 });
    expect(r.from).toEqual({ x: 10, y: 10 });
    expect(patchOf(r)).toEqual({ from: r.from, to: r.to });
  });

  it('scales ink about the opposite corner', () => {
    const r = resized(ink(), 'se', 10, 10, false, PAGE) as Extract<Annotation, { kind: 'ink' }>;
    expect(r.rect).toMatchObject({ w: 20, h: 20 });
    expect(r.strokes[0]?.outline[1]).toEqual({ x: 20, y: 20 });
  });

  it('refuses a handle the annotation does not have', () => {
    expect(resized(note(), 'se', 1, 1, false, PAGE)).toBeNull();
    expect(resized(line(), 'se', 1, 1, false, PAGE)).toBeNull();
  });
});

describe('keys and order', () => {
  it('arrows map to unit steps', () => {
    expect(arrowStep('ArrowLeft')).toEqual({ x: -1, y: 0 });
    expect(arrowStep('ArrowDown')).toEqual({ x: 0, y: 1 });
    expect(arrowStep('a')).toBeNull();
  });

  it('reading order is top to bottom, then left to right', () => {
    const a = { id: 1, rect: { x: 50, y: 0, w: 1, h: 1 } };
    const b = { id: 2, rect: { x: 0, y: 0, w: 1, h: 1 } };
    const c = { id: 3, rect: { x: 0, y: 10, w: 1, h: 1 } };
    expect(readingOrder([c, a, b]).map((x) => x.id)).toEqual([2, 1, 3]);
  });
});
