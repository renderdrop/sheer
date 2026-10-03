import { describe, expect, it } from 'vitest';

import type { Annotation } from '../../api/annotations';
import { PALETTE, paletteEntry, recentColours } from './palette';
import {
  commandFor,
  sectionsOfKind,
  sectionsOfSelection,
  sectionsOfTool,
  shared,
  valuesOfSelection,
} from './properties';
import { DEFAULT_STYLES, styleFor } from './style';

function make(id: number, extra: Record<string, unknown>): Annotation {
  return {
    id,
    pageId: 0,
    rect: { x: 0, y: 0, w: 10, h: 10 },
    color: [240, 228, 66],
    opacity: 1,
    contents: '',
    author: null,
    modified: null,
    inReplyTo: null,
    locked: false,
    sync: 'new',
    kind: 'note',
    at: { x: 0, y: 0 },
    icon: 'note',
    ...extra,
  } as Annotation;
}

const ink = (id: number, extra: Record<string, unknown> = {}) =>
  make(id, { kind: 'ink', strokes: [{ points: [], outline: [] }], width: 2, ...extra });
const text = (id: number, extra: Record<string, unknown> = {}) =>
  make(id, {
    kind: 'freeText',
    box: { x: 0, y: 0, w: 1, h: 1 },
    lines: [],
    fontSize: 12,
    fill: null,
    borderWidth: 0,
    ...extra,
  });
const line = (id: number, extra: Record<string, unknown> = {}) =>
  make(id, { kind: 'line', from: { x: 0, y: 0 }, to: { x: 1, y: 1 }, width: 2, head: 'none', tail: 'none', ...extra });

describe('the palette', () => {
  it('has the eight Okabe-Ito colours, all distinct', () => {
    expect(PALETTE).toHaveLength(8);
    expect(new Set(PALETTE.map((c) => c.rgb.join(','))).size).toBe(8);
    expect(paletteEntry([0, 114, 178])?.id).toBe('blue');
    expect(paletteEntry([1, 2, 3])).toBeUndefined();
  });

  it('Recent lists the newest colours of the file that are not in the palette, without repeats, at most four', () => {
    const odd = (id: number, c: [number, number, number]) => ink(id, { color: c });
    const recent = recentColours([
      odd(1, [1, 1, 1]),
      odd(2, [2, 2, 2]),
      ink(3), // yellow, a palette colour
      odd(4, [2, 2, 2]),
      odd(5, [5, 5, 5]),
      odd(6, [6, 6, 6]),
      odd(7, [7, 7, 7]),
    ]);
    expect(recent).toEqual([
      [7, 7, 7],
      [6, 6, 6],
      [5, 5, 5],
      [2, 2, 2],
    ]);
    expect(recentColours([ink(1)])).toEqual([]);
  });
});

describe('sections', () => {
  it('follow the kind', () => {
    expect(sectionsOfKind('highlight')).toEqual(['colour', 'opacity']);
    expect(sectionsOfKind('ink')).toEqual(['colour', 'opacity', 'stroke']);
    expect(sectionsOfKind('freeText')).toEqual(['colour', 'opacity', 'fontSize']);
    expect(sectionsOfKind('line')).toEqual(['colour', 'opacity', 'stroke', 'lineEnd']);
    expect(sectionsOfKind('opaque')).toEqual([]);
    expect(sectionsOfKind('mark')).toEqual(['colour']);
    expect(sectionsOfKind('signature')).toEqual(['colour']);
  });

  it('of a multi-selection are those every kind has', () => {
    expect(sectionsOfSelection([ink(1), text(2)])).toEqual(['colour', 'opacity']);
    expect(sectionsOfSelection([ink(1), line(2)])).toEqual(['colour', 'opacity', 'stroke']);
    expect(sectionsOfSelection([])).toEqual([]);
  });

  it('of a tool: the arrow has a line end, the line has none', () => {
    expect(sectionsOfTool('arrow')).toContain('lineEnd');
    expect(sectionsOfTool('line')).not.toContain('lineEnd');
    expect(sectionsOfTool('freeText')).toContain('fontSize');
  });
});

describe('shared values', () => {
  it('are the value or mixed', () => {
    expect(shared([1, 1])).toEqual({ value: 1, mixed: false });
    expect(shared([1, 2])).toEqual({ value: null, mixed: true });
    expect(shared([])).toEqual({ value: null, mixed: false });
    const values = valuesOfSelection([ink(1, { width: 2 }), ink(2, { width: 4, color: [0, 0, 0] })]);
    expect(values.width.mixed).toBe(true);
    expect(values.color.mixed).toBe(true);
    expect(values.opacity).toEqual({ value: 1, mixed: false });
  });
});

describe('commandFor', () => {
  it('is one update for one annotation', () => {
    expect(commandFor([ink(3)], { width: 8 })).toEqual({ type: 'updateAnnotation', id: 3, patch: { width: 8 } });
  });

  it('is one batch, so one undo step, for several', () => {
    const command = commandFor([ink(1), text(2)], { color: [0, 0, 0], width: 4 });
    expect(command).toEqual({
      type: 'batch',
      label: 'annotation.update',
      commands: [
        { type: 'updateAnnotation', id: 1, patch: { color: [0, 0, 0], width: 4 } },
        { type: 'updateAnnotation', id: 2, patch: { color: [0, 0, 0] } },
      ],
    });
  });

  it('leaves out fields the kind does not have and answers null when nothing applies', () => {
    expect(commandFor([make(1, {})], { width: 4 })).toBeNull();
    expect(commandFor([], { color: [0, 0, 0] })).toBeNull();
    expect(commandFor([make(1, { kind: 'opaque', subtype: 'Stamp' })], { color: [0, 0, 0] })).toBeNull();
  });

  it('clamps the font size to 6 to 144', () => {
    expect(commandFor([text(1)], { fontSize: 500 })).toMatchObject({ patch: { fontSize: 144 } });
    expect(commandFor([text(1)], { fontSize: 1 })).toMatchObject({ patch: { fontSize: 6 } });
  });
});

describe('default styles', () => {
  it('follow DESIGN 3.24', () => {
    expect(DEFAULT_STYLES.highlight.color).toEqual([240, 228, 66]);
    expect(DEFAULT_STYLES.underline.color).toEqual([213, 94, 0]);
    expect(DEFAULT_STYLES.freeText.color).toEqual([0, 0, 0]);
    expect(DEFAULT_STYLES.ink.color).toEqual([0, 114, 178]);
    expect(DEFAULT_STYLES.arrow.head).toBe('openArrow');
    expect(styleFor('rect', { rect: { width: 8 } }).width).toBe(8);
  });
});
