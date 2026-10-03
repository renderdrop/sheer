import { describe, expect, it } from 'vitest';

import { MAX_REDACT_QUADS_PER_MARK } from '../../api/redaction';
import type { Quad } from '../../api/wire';
import { boxToQuad, chunkQuads, cornersToBox, formatPages, moveBox, quadsForRange, resizeBox } from './geometry';
import { excerptOf } from './excerpt';

const PAGE = [200, 100] as const;

/** A layer of `text` with 10 x 10 boxes in one line starting at (x0, y). */
function line(text: string, x0 = 10, y = 20) {
  const boxes = new Float32Array(text.length * 4);
  for (let i = 0; i < text.length; i += 1) boxes.set([x0 + i * 10, y, 10, 10], i * 4);
  return { text, boxes };
}

describe('boxes and quads', () => {
  it('makes a quad in the order of the backend and a box from any two corners, clamped to the page', () => {
    expect(boxToQuad({ x: 1, y: 2, w: 3, h: 4 })).toEqual([
      { x: 1, y: 2 },
      { x: 4, y: 2 },
      { x: 1, y: 6 },
      { x: 4, y: 6 },
    ]);
    expect(cornersToBox({ x: 50, y: 40 }, { x: -10, y: 500 }, PAGE)).toEqual({ x: 0, y: 40, w: 50, h: 60 });
  });

  it('moves and resizes inside the page, never below 4 pt', () => {
    const box = { x: 10, y: 10, w: 20, h: 20 };
    expect(moveBox(box, { x: -50, y: 500 }, PAGE)).toEqual({ x: 0, y: 80, w: 20, h: 20 });
    expect(resizeBox(box, { dx: 1, dy: 1 }, { x: 5, y: -100 }, PAGE)).toEqual({ x: 10, y: 10, w: 25, h: 4 });
    expect(resizeBox(box, { dx: -1, dy: 0 }, { x: 100, y: 0 }, PAGE)).toEqual({ x: 26, y: 10, w: 4, h: 20 });
  });
});

describe('quadsForRange', () => {
  it('covers the characters of the range as one quad per line fragment', () => {
    const quads = quadsForRange(line('abcdef'), 1, 4);
    expect(quads).toEqual([boxToQuad({ x: 20, y: 20, w: 30, h: 10 })]);
  });

  it('leaves out white space at the ends and ranges without area', () => {
    expect(quadsForRange(line('ab cd'), 2, 5)).toEqual([boxToQuad({ x: 40, y: 20, w: 20, h: 10 })]);
    expect(quadsForRange(line('abc'), 2, 2)).toEqual([]);
  });

  it('chunks long lists to what a mark may hold', () => {
    const quad: Quad = boxToQuad({ x: 0, y: 0, w: 1, h: 1 });
    const chunks = chunkQuads(Array.from({ length: MAX_REDACT_QUADS_PER_MARK + 1 }, () => quad));
    expect(chunks.map((c) => c.length)).toEqual([MAX_REDACT_QUADS_PER_MARK, 1]);
  });
});

describe('excerptOf', () => {
  it('reads the text under the quads of a mark', () => {
    const layer = line('hello world');
    const mark = { quads: quadsForRange(layer, 6, 11) };
    expect(excerptOf(layer, mark)).toBe('world');
  });
});

describe('formatPages', () => {
  it('joins consecutive numbers', () => {
    expect(formatPages([5, 1, 2, 3, 9, 3])).toBe('1-3, 5, 9');
    expect(formatPages([1, 2])).toBe('1, 2');
    expect(formatPages([])).toBe('');
  });
});
