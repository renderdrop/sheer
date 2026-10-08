import { describe, expect, it } from 'vitest';

import { MAX_ANNOT_QUADS } from '../../../api/annotations';
import { defaultStyle, freeTextDraft, inkDraft, markupDraft, noteDraft, shapeDraft, shapeEnd } from './drafts';
import { boxFromPoints, boxInPage, clampToPage, constrainSquare, isDrag, snapAngle } from './geometry';
import {
  INK_JOIN_MS,
  MAX_RAW_SAMPLES,
  appendSample,
  pushSample,
  capSamples,
  catmullRom,
  joinsGroup,
  movingAverage,
  smoothStroke,
  strokeOutline,
  type Sample,
} from './ink';
import {
  buildTextIndex,
  charIndexAt,
  charIndexAtIndexed,
  quadsForDrag,
  quadsForDragIndexed,
  quadsForOffsets,
  quadsForRange,
} from './markup';

const s = (x: number, y: number, pressure = 0.5): Sample => ({ x, y, pressure });
const PAGE = [600, 800] as const;

describe('geometry', () => {
  it('orders the corners of a box', () => {
    expect(boxFromPoints({ x: 10, y: 20 }, { x: 4, y: 30 })).toEqual({ x: 4, y: 20, w: 6, h: 10 });
  });
  it('makes a square with the longer side, keeping the direction', () => {
    expect(constrainSquare({ x: 0, y: 0 }, { x: -30, y: 10 })).toEqual({ x: -30, y: 30 });
    expect(constrainSquare({ x: 5, y: 5 }, { x: 8, y: -20 })).toEqual({ x: 30, y: -20 });
  });
  it('snaps to 45 degrees and keeps the length', () => {
    const p = snapAngle({ x: 0, y: 0 }, { x: 100, y: 10 });
    expect(p.y).toBeCloseTo(0);
    expect(p.x).toBeCloseTo(Math.hypot(100, 10));
    const q = snapAngle({ x: 0, y: 0 }, { x: 50, y: 60 });
    expect(q.x).toBeCloseTo(q.y);
  });
  it('clamps and detects drags', () => {
    expect(clampToPage({ x: -5, y: 900 }, 600, 800)).toEqual({ x: 0, y: 800 });
    expect(isDrag({ x: 0, y: 0 }, { x: 1, y: 1 })).toBe(false);
    expect(isDrag({ x: 0, y: 0 }, { x: 5, y: 0 })).toBe(true);
    expect(boxInPage({ x: 590, y: 790 }, 160, 36, 600, 800)).toEqual({ x: 440, y: 764, w: 160, h: 36 });
  });
});

describe('ink', () => {
  it('joins strokes at most 1000 ms apart', () => {
    expect(joinsGroup(null, 5)).toBe(false);
    expect(joinsGroup(1000, 1000 + INK_JOIN_MS)).toBe(true);
    expect(joinsGroup(1000, 1000 + INK_JOIN_MS + 1)).toBe(false);
  });
  it('drops samples that are too close or not finite', () => {
    const base = [s(0, 0)];
    expect(appendSample(base, s(0.1, 0))).toBe(base);
    expect(appendSample(base, s(Number.NaN, 0))).toBe(base);
    expect(appendSample(base, s(5, 0))).toHaveLength(2);
  });
  it('smooths but keeps the ends', () => {
    const raw = [s(0, 0), s(10, 10), s(20, 0), s(30, 10), s(40, 0)];
    const out = movingAverage(raw);
    expect(out[0]).toEqual(raw[0]);
    expect(out[4]).toEqual(raw[4]);
    expect(out[1]?.y).toBeLessThan(10);
  });
  it('splines through the samples', () => {
    const out = catmullRom([s(0, 0), s(10, 0), s(20, 0)], 2);
    expect(out).toHaveLength(5);
    expect(out[2]?.x).toBeCloseTo(10);
    expect(out.every((p) => Math.abs(p.y) < 1e-9)).toBe(true);
  });
  it('caps the points and keeps the first and last', () => {
    const raw = Array.from({ length: 100 }, (_, i) => s(i, i));
    const out = capSamples(raw, 10);
    expect(out).toHaveLength(10);
    expect(out[0]).toEqual(raw[0]);
    expect(out[9]).toEqual(raw[99]);
    expect(smoothStroke(raw, 20).length).toBeLessThanOrEqual(20);
  });
  it('outlines a dot, a stroke, and widens with pressure', () => {
    expect(strokeOutline([], 2)).toEqual([]);
    expect(strokeOutline([s(0, 0)], 2)).toHaveLength(8);
    const light = strokeOutline([s(0, 0, 0.2), s(10, 0, 0.2)], 4);
    const hard = strokeOutline([s(0, 0, 1), s(10, 0, 1)], 4);
    const height = (pts: { y: number }[]) => Math.max(...pts.map((p) => p.y)) - Math.min(...pts.map((p) => p.y));
    expect(height(hard)).toBeGreaterThan(height(light));
    expect(light.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true);
  });
});

/** Two lines of text, "ab" and "cd", 10 wide and 12 high, a line break between them. */
function layer() {
  const text = 'ab\r\ncd';
  const boxes = new Float32Array(4 * text.length);
  const put = (i: number, x: number, y: number, w = 10, h = 12) => boxes.set([x, y, w, h], 4 * i);
  put(0, 0, 0);
  put(1, 10, 0);
  put(2, 20, 0, 0, 0);
  put(3, 20, 0, 0, 0);
  put(4, 0, 20);
  put(5, 10, 20);
  return { text, boxes };
}

describe('markup quads', () => {
  it('finds the character under a point, or the nearest', () => {
    const l = layer();
    expect(charIndexAt(l, { x: 12, y: 5 }, true)).toBe(1);
    expect(charIndexAt(l, { x: 100, y: 100 }, true)).toBeNull();
    expect(charIndexAt(l, { x: 100, y: 100 }, false)).toBe(5);
  });
  it('makes one quad per line, corners top left, top right, bottom left, bottom right', () => {
    const quads = quadsForRange(layer(), 0, 5);
    expect(quads).toHaveLength(2);
    expect(quads[0]).toEqual([
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 0, y: 12 },
      { x: 20, y: 12 },
    ]);
    expect(quads[1]?.[3]).toEqual({ x: 20, y: 32 });
  });
  it('follows a drag over text, in either direction, and falls back to a rectangle', () => {
    const l = layer();
    expect(quadsForDrag(l, { x: 2, y: 2 }, { x: 15, y: 25 })).toHaveLength(2);
    expect(quadsForDrag(l, { x: 15, y: 25 }, { x: 2, y: 2 })).toHaveLength(2);
    // Starts in empty space: what the rectangle meets.
    expect(quadsForDrag(l, { x: 40, y: 40 }, { x: 5, y: 15 })).toHaveLength(1);
    expect(quadsForDrag(l, { x: 400, y: 400 }, { x: 300, y: 300 })).toEqual([]);
  });
  it('maps UTF-16 offsets (end exclusive)', () => {
    expect(quadsForOffsets(layer(), 0, 1)[0]?.[1]).toEqual({ x: 10, y: 0 });
    expect(quadsForOffsets(layer(), 3, 3)).toEqual([]);
  });
  it('never exceeds the model limit', () => {
    const n = (MAX_ANNOT_QUADS + 10) * 2;
    const text = 'x'.repeat(n);
    const boxes = new Float32Array(4 * n);
    for (let i = 0; i < n; i += 1) boxes.set([0, i * 20, 5, 10], 4 * i);
    expect(quadsForRange({ text, boxes }, 0, n - 1)).toHaveLength(MAX_ANNOT_QUADS);
  });
});

describe('drafts', () => {
  const style = defaultStyle('rect');
  it('makes no markup without quads', () => {
    expect(markupDraft('highlight', 0, [], style)).toBeNull();
    expect(markupDraft('highlight', 0, quadsForRange(layer(), 0, 1), defaultStyle('highlight'))?.kind).toBe(
      'highlight',
    );
  });
  it('shapes: Shift makes a square, an arrow has a head at the end', () => {
    const end = shapeEnd('rect', { x: 0, y: 0 }, { x: 50, y: 20 }, true);
    expect(end).toEqual({ x: 50, y: 50 });
    const draft = shapeDraft('rect', 3, { x: 0, y: 0 }, end, PAGE, style);
    expect(draft).toMatchObject({ kind: 'rect', pageId: 3, box: { x: 0, y: 0, w: 50, h: 50 } });
    const arrow = shapeDraft('arrow', 0, { x: 0, y: 0 }, { x: 40, y: 0 }, PAGE, style);
    expect(arrow).toMatchObject({ kind: 'line', head: 'openArrow', tail: 'none' });
    expect(shapeDraft('line', 0, { x: 0, y: 0 }, { x: 40, y: 0 }, PAGE, style)).toMatchObject({ head: 'none' });
  });
  it('an arrow has its open head at both ends when the style says so', () => {
    const both = { ...style, bothEnds: true };
    expect(shapeDraft('arrow', 0, { x: 0, y: 0 }, { x: 40, y: 0 }, PAGE, both)).toMatchObject({
      head: 'openArrow',
      tail: 'openArrow',
    });
    // A line never gets a head from the arrow's style.
    expect(shapeDraft('line', 0, { x: 0, y: 0 }, { x: 40, y: 0 }, PAGE, both)).toMatchObject({
      head: 'none',
      tail: 'none',
    });
  });
  it('places a note on the page and a free text box with empty text', () => {
    expect(noteDraft(0, { x: -4, y: 900 }, PAGE, style)).toMatchObject({ kind: 'note', at: { x: 0, y: 800 } });
    const click = freeTextDraft(0, { x: 100, y: 100 }, null, PAGE, defaultStyle('freeText'));
    // A click puts the top-left at the click: 24 pt wide, one 12 pt line high plus the padding (DESIGN 3.5 B4).
    expect(click).toMatchObject({ kind: 'freeText', lines: [], box: { x: 100, y: 100, w: 24, h: 22.4 } });
    // Less than 96 pt to the right of the click: the box moves left to get it, 12 pt short of the page edge.
    const near = freeTextDraft(0, { x: 590, y: 100 }, null, PAGE, defaultStyle('freeText'));
    expect(near).toMatchObject({ box: { x: PAGE[0] - 12 - 96 } });
    const dragged = freeTextDraft(0, { x: 100, y: 100 }, { x: 300, y: 160 }, PAGE, defaultStyle('freeText'));
    expect(dragged).toMatchObject({ box: { w: 200, h: 60 } });
  });
  it('makes one ink annotation of several strokes', () => {
    const draft = inkDraft(1, [[s(0, 0), s(10, 10)], [s(5, 5)], []], defaultStyle('ink'));
    expect(draft?.kind === 'ink' && draft.strokes).toHaveLength(2);
    expect(inkDraft(1, [], defaultStyle('ink'))).toBeNull();
  });
});

describe('performance helpers', () => {
  it('pushes samples into a buffer in place, dropping near ones and capping', () => {
    const buffer: Sample[] = [];
    expect(pushSample(buffer, s(0, 0))).toBe(true);
    expect(pushSample(buffer, s(0.1, 0))).toBe(false);
    expect(pushSample(buffer, s(5, 5))).toBe(true);
    expect(buffer).toHaveLength(2);
    for (let i = 0; i < MAX_RAW_SAMPLES + 10; i += 1) pushSample(buffer, s(10 + i, 0));
    expect(buffer).toHaveLength(MAX_RAW_SAMPLES);
  });
  it('finds the same quads through the line index as without it', () => {
    const l = layer();
    const index = buildTextIndex(l);
    for (const [a, b] of [
      [
        { x: 2, y: 2 },
        { x: 15, y: 25 },
      ],
      [
        { x: 15, y: 25 },
        { x: 2, y: 2 },
      ],
      [
        { x: 40, y: 40 },
        { x: 5, y: 15 },
      ],
      [
        { x: 400, y: 400 },
        { x: 300, y: 300 },
      ],
    ] as const) {
      expect(quadsForDragIndexed(index, a, b)).toEqual(quadsForDrag(l, a, b));
    }
    expect(charIndexAtIndexed(index, { x: 12, y: 5 }, true)).toBe(1);
    expect(charIndexAtIndexed(index, { x: 100, y: 100 }, true)).toBeNull();
    expect(charIndexAtIndexed(index, { x: 100, y: 100 }, false)).toBe(5);
  });
  it('keeps a square square at the edge of the page', () => {
    const end = shapeEnd('rect', { x: 500, y: 100 }, { x: 590, y: 300 }, true, PAGE);
    expect(end.x - 500).toBeCloseTo(end.y - 100);
    expect(end.x).toBeLessThanOrEqual(600);
    const edge = shapeEnd('rect', { x: 580, y: 100 }, { x: 700, y: 300 }, true, PAGE);
    expect(edge.x).toBeLessThanOrEqual(600);
    expect(edge.x - 580).toBeCloseTo(edge.y - 100);
  });
});
