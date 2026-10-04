import { describe, expect, it } from 'vitest';

import type { Annotation } from '../../../api/annotations';
import {
  angleOf,
  angleToward,
  arrowStep,
  canMove,
  canRotate,
  clampMove,
  handlesOf,
  hitsAnnotation,
  isTextMarkup,
  normalizeAngle,
  patchOf,
  readingOrder,
  resizeRect,
  resized,
  rotateHandleAt,
  rotatedBounds,
  translated,
  turnedTo,
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

  it('keeps a signature and a mark at their aspect, with four corner handles, whatever the modifier', () => {
    const box = { x: 10, y: 20, w: 90, h: 30 };
    const signature = {
      ...base,
      rect: box,
      kind: 'signature',
      box,
      role: 'signature',
      art: { type: 'asset', assetId: 1, aspect: 3 },
    } as Annotation;
    expect(handlesOf(signature)).toEqual(['nw', 'ne', 'se', 'sw', 'rotate']);
    expect(handlesOf({ ...signature, kind: 'mark', glyph: 'check' } as unknown as Annotation)).toHaveLength(5);
    const r = resized(signature, 'se', 30, 1, false, PAGE) as Extract<Annotation, { kind: 'signature' }>;
    expect(r.box.w / r.box.h).toBeCloseTo(3);
    expect(patchOf(r)).toEqual({ box: r.box });
    expect((translated(signature, 5, 5) as Extract<Annotation, { kind: 'signature' }>).box.x).toBe(15);
    expect(resized(signature, 'n', 0, 5, false, PAGE)).toBeNull();
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

describe('turning a signature or a mark (ADR-105)', () => {
  const signature = (angle?: number, locked = false) =>
    ({
      ...base,
      locked,
      kind: 'signature',
      rect: { x: 100, y: 100, w: 80, h: 20 },
      box: { x: 100, y: 100, w: 80, h: 20 },
      role: 'signature',
      art: { type: 'asset', assetId: 1, aspect: 4 },
      ...(angle === undefined ? {} : { angle }),
    }) as Annotation;

  it('normalises an angle into (-180, 180] and a quarter turn swaps the bounds', () => {
    expect(normalizeAngle(450)).toBe(90);
    expect(normalizeAngle(-180)).toBe(180);
    expect(normalizeAngle(-0.001)).toBe(0);
    expect(normalizeAngle(Number.NaN)).toBe(0);
    const bounds = rotatedBounds({ x: 100, y: 100, w: 80, h: 20 }, 90);
    expect(bounds.w).toBeCloseTo(20);
    expect(bounds.h).toBeCloseTo(80);
    expect(bounds.x + bounds.w / 2).toBeCloseTo(140);
    expect(bounds.y + bounds.h / 2).toBeCloseTo(110);
  });

  it('the angle follows the pointer about the centre, up is 0, clockwise is positive, Shift snaps to 15', () => {
    const box = { x: 100, y: 100, w: 80, h: 20 };
    expect(angleToward(box, { x: 140, y: 0 }, false)).toBe(0);
    expect(angleToward(box, { x: 300, y: 110 }, false)).toBe(90);
    expect(angleToward(box, { x: 140, y: 300 }, false)).toBe(180);
    expect(angleToward(box, { x: 0, y: 110 }, false)).toBe(-90);
    // 100 px right and 90 px up of the centre is about 48 degrees; snapped it is 45.
    const free = angleToward(box, { x: 240, y: 20 }, false);
    expect(free).toBeGreaterThan(47);
    expect(free).toBeLessThan(50);
    expect(angleToward(box, { x: 240, y: 20 }, true)).toBe(45);
  });

  it('the rotate handle sits above the turned box; a turned one has only that handle and cannot be resized', () => {
    expect(handlesOf(signature(0))).toContain('rotate');
    expect(handlesOf(signature(30))).toEqual(['rotate']);
    expect(handlesOf(signature(0, true))).toEqual([]);
    expect(resized(signature(0), 'rotate', 5, 5, false, PAGE)).toBeNull();
    const up = rotateHandleAt({ x: 100, y: 100, w: 80, h: 20 }, 0);
    expect(up.x).toBeCloseTo(140);
    expect(up.y).toBeLessThan(100);
    const right = rotateHandleAt({ x: 100, y: 100, w: 80, h: 20 }, 90);
    expect(right.x).toBeGreaterThan(140);
    expect(right.y).toBeCloseTo(110);
    expect(canRotate(signature(0))).toBe(true);
    expect(canRotate({ ...base, kind: 'rect' } as unknown as Annotation)).toBe(false);
    expect(angleOf(signature())).toBe(0);
  });

  it('turnedTo keeps the box and gives the turned bounds', () => {
    const t = turnedTo(signature(0), 90) as Extract<Annotation, { kind: 'signature' }>;
    expect(t.angle).toBe(90);
    expect(t.box).toEqual({ x: 100, y: 100, w: 80, h: 20 });
    expect(t.rect.w).toBeCloseTo(20);
    expect(turnedTo({ ...base, kind: 'rect' } as unknown as Annotation, 90)).toMatchObject({ kind: 'rect' });
  });
});

describe('hitsAnnotation', () => {
  const slop = 3;
  it('hits a filled shape inside, an unfilled one only at its outline, text by its box and a turned signature by its turned box', () => {
    const rect = (fill: [number, number, number] | null) =>
      ({
        ...base,
        kind: 'rect',
        rect: { x: 10, y: 10, w: 100, h: 60 },
        box: { x: 10, y: 10, w: 100, h: 60 },
        width: 1,
        fill,
        dashed: false,
      }) as Annotation;
    expect(hitsAnnotation(rect([1, 2, 3]), { x: 60, y: 40 }, slop)).toBe(true);
    expect(hitsAnnotation(rect(null), { x: 60, y: 40 }, slop)).toBe(false);
    expect(hitsAnnotation(rect(null), { x: 11, y: 40 }, slop)).toBe(true);
    expect(hitsAnnotation(rect(null), { x: 200, y: 40 }, slop)).toBe(false);
    const text = { ...base, kind: 'freeText', rect: { x: 0, y: 0, w: 50, h: 20 }, box: { x: 0, y: 0, w: 50, h: 20 } };
    expect(hitsAnnotation(text as unknown as Annotation, { x: 25, y: 10 }, slop)).toBe(true);
    expect(hitsAnnotation(text as unknown as Annotation, { x: 25, y: 40 }, slop)).toBe(false);
    const turned = {
      ...base,
      kind: 'signature',
      angle: 90,
      rect: { x: 130, y: 70, w: 20, h: 80 },
      box: { x: 100, y: 100, w: 80, h: 20 },
    } as unknown as Annotation;
    expect(hitsAnnotation(turned, { x: 140, y: 80 }, slop)).toBe(true);
    expect(hitsAnnotation(turned, { x: 105, y: 110 }, slop)).toBe(false);
  });

  it('hits a thin stroke and a line within the slop, and never text markup', () => {
    const ink = {
      ...base,
      kind: 'ink',
      width: 1,
      rect: { x: 0, y: 0, w: 100, h: 10 },
      strokes: [
        {
          points: [
            { x: 0, y: 5 },
            { x: 100, y: 5 },
          ],
          outline: [],
        },
      ],
    } as unknown as Annotation;
    expect(hitsAnnotation(ink, { x: 50, y: 7 }, 3)).toBe(true);
    expect(hitsAnnotation(ink, { x: 50, y: 20 }, 3)).toBe(false);
    const line = {
      ...base,
      kind: 'line',
      width: 1,
      from: { x: 0, y: 0 },
      to: { x: 100, y: 0 },
    } as unknown as Annotation;
    expect(hitsAnnotation(line, { x: 50, y: 2 }, 3)).toBe(true);
    const mark = { ...base, kind: 'highlight', quads: [], rect: { x: 0, y: 0, w: 99, h: 99 } } as unknown as Annotation;
    expect(hitsAnnotation(mark, { x: 5, y: 5 }, 3)).toBe(false);
    expect(isTextMarkup(mark)).toBe(true);
  });
});
