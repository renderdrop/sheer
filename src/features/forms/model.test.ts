import { describe, expect, it } from 'vitest';

import type { FieldValue, FormField, Widget } from '../../api/forms';
import {
  choiceText,
  fieldLabel,
  firstEmptyStop,
  fontSizePt,
  isEmptyValue,
  listIsInline,
  neighbourStop,
  tabStops,
  widgetsOn,
} from './model';

const widget = (pageId: number, tabOrder: number, state: number | null = null): Widget => ({
  pageId,
  rect: { x: 0, y: tabOrder * 20, w: 100, h: 16 },
  tabOrder,
  state,
  fill: null,
  border: null,
  textColor: [0, 0, 0],
});

function field(id: number, widgets: Widget[], extra: Partial<FormField> = {}): FormField {
  return {
    id,
    name: `f${id}`,
    tooltip: null,
    kind: { type: 'text', multiline: false, maxLen: null, comb: false, password: false, align: 'left', fontSize: 0 },
    readOnly: false,
    required: false,
    value: { type: 'text', text: '' },
    defaultValue: null,
    widgets,
    sync: 'clean',
    ...extra,
  };
}

const identity = (pageId: number) => pageId;

describe('labels and emptiness', () => {
  it('names a field by its tooltip, else its name', () => {
    expect(fieldLabel({ tooltip: ' Your name ', name: 'a.b' })).toBe('Your name');
    expect(fieldLabel({ tooltip: '  ', name: 'a.b' })).toBe('a.b');
    expect(fieldLabel({ tooltip: null, name: 'a.b' })).toBe('a.b');
  });

  it('knows an empty value of each kind', () => {
    const empty: FieldValue[] = [
      { type: 'text', text: '' },
      { type: 'checked', on: false },
      { type: 'radio', selected: null },
      { type: 'choice', selected: [], custom: null },
    ];
    const filled: FieldValue[] = [
      { type: 'text', text: 'x' },
      { type: 'checked', on: true },
      { type: 'radio', selected: 0 },
      { type: 'choice', selected: ['a'], custom: null },
      { type: 'choice', selected: [], custom: 'typed' },
    ];
    expect(empty.every(isEmptyValue)).toBe(true);
    expect(filled.some(isEmptyValue)).toBe(false);
  });
});

describe('tab order', () => {
  const a = field(1, [widget(1, 1)]);
  const b = field(2, [widget(0, 2)]);
  const c = field(3, [widget(0, 1)]);
  const radio = field(4, [widget(1, 0, 0), widget(1, 5, 1)], {
    kind: { type: 'radio', states: ['A', 'B'], noToggleOff: false },
    value: { type: 'radio', selected: 1 },
  });
  const readOnly = field(5, [widget(0, 0)], { readOnly: true });
  const signature = field(6, [widget(0, 3)], { kind: { type: 'signature' } });

  it('goes by page, then by the page tab order, and skips read-only and unfillable fields', () => {
    const stops = tabStops([a, b, c, radio, readOnly, signature], identity);
    expect(stops.map((stop) => stop.field.id)).toEqual([3, 2, 1, 4]);
  });

  it('a radio group is one stop, at its selected button', () => {
    const stops = tabStops([radio], identity);
    expect(stops).toHaveLength(1);
    expect(stops[0]?.key).toBe('4:1');
  });

  it('follows the document order of the pages, not their ids', () => {
    const position = (pageId: number) => (pageId === 0 ? 1 : 0);
    expect(tabStops([a, b], position).map((stop) => stop.field.id)).toEqual([1, 2]);
  });

  it('leaves out a field on a page that is gone', () => {
    expect(tabStops([a, b], (pageId) => (pageId === 1 ? null : pageId)).map((stop) => stop.field.id)).toEqual([2]);
  });

  it('finds the neighbour, and none at the ends', () => {
    const stops = tabStops([a, b, c], identity);
    expect(neighbourStop(stops, 3, 1)?.field.id).toBe(2);
    expect(neighbourStop(stops, 3, -1)).toBeNull();
    expect(neighbourStop(stops, 1, 1)).toBeNull();
    expect(neighbourStop(stops, 99, 1)).toBeNull();
  });

  it('finds the first empty field', () => {
    const filled = field(3, [widget(0, 1)], { value: { type: 'text', text: 'done' } });
    expect(firstEmptyStop(tabStops([a, b, filled], identity))?.field.id).toBe(2);
    expect(firstEmptyStop(tabStops([filled], identity))).toBeNull();
  });
});

describe('widgets of a page', () => {
  it('are in tab order and only those of the page', () => {
    const f = field(1, [widget(0, 2), widget(1, 1), widget(0, 1)]);
    expect(widgetsOn([f], 0).map((placed) => placed.key)).toEqual(['1:2', '1:0']);
    expect(widgetsOn([f], 1).map((placed) => placed.key)).toEqual(['1:1']);
  });
});

describe('sizes and text', () => {
  it('uses the field font, else fits the height (12 pt for a multi-line field)', () => {
    expect(fontSizePt(10, 30, false)).toBe(10);
    expect(fontSizePt(0, 20, false)).toBeCloseTo(14.4);
    expect(fontSizePt(0, 2, false)).toBe(4);
    expect(fontSizePt(0, 100, true)).toBe(12);
  });

  it('shows a list inline only when its rows reach 24 px', () => {
    expect(listIsInline(12, 1)).toBe(false);
    expect(listIsInline(12, 2)).toBe(true);
  });

  it('shows the labels of the selected options, or what was typed', () => {
    const options = [
      { export: 'a', label: 'Alpha' },
      { export: 'b', label: 'Beta' },
    ];
    expect(choiceText(options, { type: 'choice', selected: ['a', 'b'], custom: null })).toBe('Alpha, Beta');
    expect(choiceText(options, { type: 'choice', selected: ['z'], custom: null })).toBe('z');
    expect(choiceText(options, { type: 'choice', selected: [], custom: 'mine' })).toBe('mine');
  });
});
