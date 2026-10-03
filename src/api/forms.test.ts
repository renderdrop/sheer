import { describe, expect, it } from 'vitest';

import {
  MAX_FIELD_NAME_CHARS,
  MAX_FIELD_OPTIONS,
  MAX_FIELD_TEXT_CHARS,
  MAX_FORM_FIELDS,
  MAX_FORM_WIDGETS,
  parseFieldKind,
  parseFieldStates,
  parseFieldValue,
  parseFormField,
  parseFormInfo,
  setFieldValueCommand,
} from './forms';
import { rustConstants } from './limits.testutil';

const WIDGET = {
  pageId: 0,
  rect: { x: 10, y: 20, w: 100, h: 18 },
  tabOrder: 0,
  state: null,
  fill: null,
  border: [0, 0, 0],
  textColor: [0, 0, 0],
};

const TEXT_KIND = {
  type: 'text',
  multiline: false,
  maxLen: null,
  comb: false,
  password: false,
  align: 'left',
  fontSize: 0,
};

function field(extra: Record<string, unknown> = {}) {
  return {
    id: 1,
    name: 'person.name',
    tooltip: null,
    kind: TEXT_KIND,
    readOnly: false,
    required: false,
    value: { type: 'text', text: 'Ada' },
    defaultValue: { type: 'text', text: '' },
    widgets: [WIDGET],
    sync: 'clean',
    ...extra,
  };
}

function info(extra: Record<string, unknown> = {}) {
  return { fields: [field()], hasScripts: false, xfa: 'none', needAppearances: false, ...extra };
}

describe('the bounds mirror the backend (src-tauri/src/limits.rs)', () => {
  it('has the same values', () => {
    const rust = rustConstants();
    expect(rust.get('MAX_FORM_FIELDS')).toBe(MAX_FORM_FIELDS);
    expect(rust.get('MAX_FORM_WIDGETS')).toBe(MAX_FORM_WIDGETS);
    expect(rust.get('MAX_FIELD_OPTIONS')).toBe(MAX_FIELD_OPTIONS);
    expect(rust.get('MAX_FIELD_TEXT_CHARS')).toBe(MAX_FIELD_TEXT_CHARS);
    expect(rust.get('MAX_FIELD_NAME_CHARS')).toBe(MAX_FIELD_NAME_CHARS);
  });
});

describe('parseFieldValue', () => {
  it.each([
    { type: 'text', text: 'x' },
    { type: 'checked', on: true },
    { type: 'radio', selected: null },
    { type: 'radio', selected: 2 },
    { type: 'choice', selected: ['a', 'b'], custom: null },
    { type: 'choice', selected: [], custom: 'free' },
  ])('reads %j', (value) => {
    expect(parseFieldValue(value)).toStrictEqual(value);
  });

  it.each([
    ['a text that is a number', { type: 'text', text: 1 }],
    ['an unknown type', { type: 'date', text: 'x' }],
    ['a checked that is a string', { type: 'checked', on: 'yes' }],
    ['a radio index that is negative', { type: 'radio', selected: -1 }],
    ['a choice whose selection holds a number', { type: 'choice', selected: [1], custom: null }],
    ['a choice without a custom', { type: 'choice', selected: [] }],
    ['a text over the limit', { type: 'text', text: 'x'.repeat(2 * MAX_FIELD_TEXT_CHARS + 1) }],
    ['nothing', null],
  ])('rejects %s', (_name, value) => {
    expect(parseFieldValue(value)).toBeNull();
  });
});

describe('parseFieldKind', () => {
  it('reads every kind and drops extra keys', () => {
    expect(parseFieldKind({ ...TEXT_KIND, extra: 1 })).toStrictEqual(TEXT_KIND);
    expect(parseFieldKind({ type: 'checkbox', x: 1 })).toStrictEqual({ type: 'checkbox' });
    expect(parseFieldKind({ type: 'signature' })).toStrictEqual({ type: 'signature' });
    expect(parseFieldKind({ type: 'radio', states: ['A', 'B'], noToggleOff: true })).toStrictEqual({
      type: 'radio',
      states: ['A', 'B'],
      noToggleOff: true,
    });
    const choice = {
      type: 'choice',
      combo: true,
      editable: false,
      multiSelect: false,
      options: [{ export: 'a', label: 'A' }],
    };
    expect(parseFieldKind(choice)).toStrictEqual(choice);
  });

  it.each([
    ['a text with an unknown alignment', { ...TEXT_KIND, align: 'justify' }],
    ['a text with a negative size', { ...TEXT_KIND, fontSize: -1 }],
    ['a text whose maxLen is a string', { ...TEXT_KIND, maxLen: '5' }],
    ['a radio without states', { type: 'radio', noToggleOff: false }],
    [
      'a choice with an option without a label',
      { type: 'choice', combo: true, editable: false, multiSelect: false, options: [{ export: 'a' }] },
    ],
    ['an unknown kind', { type: 'slider' }],
  ])('rejects %s', (_name, value) => {
    expect(parseFieldKind(value)).toBeNull();
  });

  it('bounds the options', () => {
    const options = Array.from({ length: MAX_FIELD_OPTIONS + 1 }, () => ({ export: 'a', label: 'a' }));
    expect(parseFieldKind({ type: 'choice', combo: false, editable: false, multiSelect: true, options })).toBeNull();
  });
});

describe('parseFormField', () => {
  it('reads a field', () => {
    expect(parseFormField(field())).toStrictEqual(field());
    expect(
      parseFormField(field({ defaultValue: null, kind: { type: 'signature' }, value: { type: 'checked', on: false } })),
    ).not.toBeNull();
  });

  it.each([
    ['a value of the wrong type for the kind', field({ value: { type: 'checked', on: true } })],
    ['a default of the wrong type for the kind', field({ defaultValue: { type: 'radio', selected: null } })],
    ['an id that is not an id', field({ id: 'a' })],
    ['a sync that is unknown', field({ sync: 'dirty' })],
    ['a widget with a bad rectangle', field({ widgets: [{ ...WIDGET, rect: { x: 1 } }] })],
    ['a widget with a colour of two channels', field({ widgets: [{ ...WIDGET, border: [0, 0] }] })],
    ['a widget without a page', field({ widgets: [{ ...WIDGET, pageId: undefined }] })],
    ['a name over the limit', field({ name: 'x'.repeat(2 * MAX_FIELD_NAME_CHARS + 1) })],
    ['a read-only flag that is a string', field({ readOnly: 'no' })],
  ])('rejects %s', (_name, value) => {
    expect(parseFormField(value)).toBeNull();
  });
});

describe('parseFormInfo', () => {
  it('reads a form and an empty one', () => {
    expect(parseFormInfo(info())).toStrictEqual(info());
    expect(parseFormInfo(info({ fields: [], xfa: 'hybrid', hasScripts: true }))).toStrictEqual(
      info({ fields: [], xfa: 'hybrid', hasScripts: true }),
    );
  });

  it.each([
    ['a repeated field id', info({ fields: [field(), field()] })],
    ['an unknown xfa kind', info({ xfa: 'partial' })],
    ['a bad field', info({ fields: [{}] })],
    ['fields that are not a list', info({ fields: null })],
    ['a script flag that is missing', info({ hasScripts: undefined })],
    ['too many fields', info({ fields: Array.from({ length: MAX_FORM_FIELDS + 1 }, (_, id) => field({ id })) })],
    ['nothing', undefined],
  ])('rejects %s', (_name, value) => {
    expect(parseFormInfo(value)).toBeNull();
  });
});

describe('parseFieldStates', () => {
  it('reads the states of a change set, and a missing list is no change', () => {
    const states = [{ id: 1, value: { type: 'text', text: 'x' }, sync: 'modified' }];
    expect(parseFieldStates(states)).toStrictEqual(states);
    expect(parseFieldStates(undefined)).toStrictEqual([]);
  });

  it.each([
    ['a state without a value', [{ id: 1, sync: 'clean' }]],
    ['a state with an unknown sync', [{ id: 1, value: { type: 'checked', on: true }, sync: 'new' }]],
    ['a list that is a record', {}],
    ['null', null],
  ])('rejects %s', (_name, value) => {
    expect(parseFieldStates(value)).toBeNull();
  });
});

describe('setFieldValueCommand', () => {
  it('coalesces the edits of one field by default', () => {
    const value = { type: 'text', text: 'a' } as const;
    expect(setFieldValueCommand(7, value)).toStrictEqual({
      type: 'setFieldValue',
      field: 7,
      value,
      coalesce: 'field:7',
    });
    expect(setFieldValueCommand(7, value, false)).toStrictEqual({ type: 'setFieldValue', field: 7, value });
  });
});
