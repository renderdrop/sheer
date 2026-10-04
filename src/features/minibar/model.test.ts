import { describe, expect, it } from 'vitest';

import type { Annotation } from '../../api/annotations';
import { changeCommand, controlsOf, creationKindOf, kindCommand, valuesOf, type MiniObject } from './model';

function make(id: number, extra: Record<string, unknown>): MiniObject {
  return {
    id,
    pageId: 0,
    rect: { x: 0, y: 0, w: 10, h: 10 },
    color: [15, 15, 15],
    opacity: 1,
    contents: '',
    author: null,
    modified: null,
    inReplyTo: null,
    locked: false,
    sync: 'new',
    ...extra,
  } as unknown as Annotation;
}
const ink = (id: number, extra: Record<string, unknown> = {}) =>
  make(id, { kind: 'ink', strokes: [], width: 2, ...extra });
const rect = (id: number) =>
  make(id, { kind: 'rect', box: { x: 0, y: 0, w: 5, h: 5 }, width: 2, fill: null, dashed: false });
const highlight = (id: number, extra: Record<string, unknown> = {}) =>
  make(id, { kind: 'highlight', quads: [], ...extra });

const arrow = (id: number, extra: Record<string, unknown> = {}) =>
  make(id, {
    kind: 'line',
    from: { x: 0, y: 0 },
    to: { x: 5, y: 5 },
    width: 2,
    head: 'openArrow',
    tail: 'none',
    ...extra,
  });

describe('an arrow in the mini bar (DESIGN 3.5 B11)', () => {
  it('has the Ends control, a plain line has not', () => {
    expect(controlsOf([arrow(1)])).toEqual(['colourStroke', 'strokeWidth', 'opacity', 'arrowEnds']);
    expect(controlsOf([arrow(1, { head: 'none', tail: 'none' })])).toEqual(['colourStroke', 'strokeWidth', 'opacity']);
    // Together with ink only the shared controls stay.
    expect(controlsOf([arrow(1), ink(2)])).toEqual(['colourStroke', 'strokeWidth', 'opacity']);
  });

  it('shows End or Both, and mixed when arrows differ', () => {
    expect(valuesOf([arrow(1)]).ends.value).toBe('end');
    expect(valuesOf([arrow(1, { tail: 'openArrow' })]).ends.value).toBe('both');
    expect(valuesOf([arrow(1), arrow(2, { tail: 'openArrow' })]).ends.mixed).toBe(true);
  });

  it('Both puts the head on the start as well, End takes it off again, one update per arrow', () => {
    expect(changeCommand([arrow(1)], { ends: 'both' })).toEqual({
      type: 'updateAnnotation',
      id: 1,
      patch: { head: 'openArrow', tail: 'openArrow' },
    });
    expect(changeCommand([arrow(1, { tail: 'openArrow' })], { ends: 'end' })).toEqual({
      type: 'updateAnnotation',
      id: 1,
      patch: { head: 'openArrow', tail: 'none' },
    });
    // An arrow a file has only at its start keeps its kind of head, now at the end.
    expect(changeCommand([arrow(1, { head: 'none', tail: 'closedArrow' })], { ends: 'end' })).toEqual({
      type: 'updateAnnotation',
      id: 1,
      patch: { head: 'closedArrow', tail: 'none' },
    });
    // Ink has no heads.
    expect(changeCommand([ink(1)], { ends: 'both' })).toBeNull();
  });

  it('is the arrow kind for its defaults', () => {
    expect(creationKindOf(arrow(1))).toBe('arrow');
  });
});

describe('controlsOf (DESIGN v2 3.3 table)', () => {
  it('has the controls of each kind, in order', () => {
    expect(controlsOf([highlight(1)])).toEqual(['colourHighlight', 'kindMarkup', 'comment']);
    expect(controlsOf([make(1, { kind: 'note', at: { x: 0, y: 0 }, icon: 'note' })])).toEqual([
      'colourHighlight',
      'comment',
    ]);
    expect(
      controlsOf([make(1, { kind: 'freeText', box: {}, lines: [], fontSize: 12, fill: null, borderWidth: 0 })]),
    ).toEqual(['colourStroke', 'fontSize', 'align', 'textBorder', 'textFill']);
    expect(controlsOf([ink(1)])).toEqual(['colourStroke', 'strokeWidth', 'opacity']);
    expect(controlsOf([rect(1)])).toEqual(['colourStroke', 'strokeWidth', 'opacity', 'fill']);
    expect(controlsOf([make(1, { kind: 'mark', box: {}, glyph: 'check' })])).toEqual(['kindMark']);
    expect(controlsOf([make(1, { kind: 'signature', box: {} })])).toEqual([]);
    expect(controlsOf([make(1, { kind: 'redactMark', quads: [], source: 'area' })])).toEqual([]);
  });

  it('keeps only what several objects share', () => {
    expect(controlsOf([ink(1), rect(2)])).toEqual(['colourStroke', 'strokeWidth', 'opacity']);
    expect(controlsOf([ink(1), highlight(2)])).toEqual([]);
    // The comment belongs to one object.
    expect(controlsOf([highlight(1), highlight(2)])).toEqual(['colourHighlight', 'kindMarkup']);
  });
});

describe('valuesOf', () => {
  it('shows a shared value and marks a differing one as mixed', () => {
    const v = valuesOf([ink(1, { width: 2 }), ink(2, { width: 4, color: [225, 92, 134] })]);
    expect(v.color.mixed).toBe(true);
    expect(v.width).toEqual({ value: null, mixed: true });
    expect(valuesOf([ink(1), ink(2)]).width).toEqual({ value: 2, mixed: false });
  });
});

describe('changeCommand', () => {
  it('is one update for one object and one batch (one undo step) for several', () => {
    expect(changeCommand([ink(1)], { width: 4 })).toEqual({ type: 'updateAnnotation', id: 1, patch: { width: 4 } });
    expect(changeCommand([ink(1), rect(2)], { opacity: 0.5 })).toEqual({
      type: 'batch',
      label: 'annotation.update',
      commands: [
        { type: 'updateAnnotation', id: 1, patch: { opacity: 0.5 } },
        { type: 'updateAnnotation', id: 2, patch: { opacity: 0.5 } },
      ],
    });
  });

  it('leaves locked objects and fields of other kinds alone', () => {
    expect(changeCommand([ink(1, { locked: true })], { width: 4 })).toBeNull();
    expect(changeCommand([highlight(1)], { width: 4 })).toBeNull();
    expect(changeCommand([rect(1)], { fill: [255, 248, 77] })).toEqual({
      type: 'updateAnnotation',
      id: 1,
      patch: { fill: [255, 248, 77] },
    });
  });
});

describe('kindCommand and creationKindOf', () => {
  it('replaces a markup in one batch with its new kind', () => {
    const command = kindCommand([highlight(1, { quads: [[0, 0, 1, 1]], contents: 'x' })], 'underline');
    expect(command).toMatchObject({
      type: 'batch',
      commands: [
        { type: 'deleteAnnotations', ids: [1] },
        { type: 'createAnnotation', draft: { kind: 'underline', opacity: 1, contents: 'x' } },
      ],
    });
    expect(kindCommand([highlight(1)], 'highlight')).toBeNull();
  });

  it('maps an arrow to its own default', () => {
    expect(creationKindOf(make(1, { kind: 'line', head: 'openArrow' }))).toBe('arrow');
    expect(creationKindOf(make(1, { kind: 'line', head: 'none' }))).toBe('line');
    expect(creationKindOf(make(1, { kind: 'signature' }))).toBeNull();
  });
});
