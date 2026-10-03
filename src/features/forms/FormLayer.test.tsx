// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChangeSet } from '../../api/annotations';
import type { FormField, Widget } from '../../api/forms';
import { EMPTY_HISTORY, useAnnotations } from '../../stores/annotations';
import { useDocuments } from '../../stores/documents';
import { resetDocuments } from '../../stores/documents.testutil';
import { useUi } from '../../stores/ui';
import { FormLayer } from './FormLayer';
import { useForms } from './store';

const api = vi.hoisted(() => ({ applyCommand: vi.fn() }));
vi.mock('../../api/annotations', async (importOriginal) => ({ ...(await importOriginal<object>()), ...api }));
const goToPage = vi.hoisted(() => vi.fn());
vi.mock('../viewer/useViewer', () => ({ useViewer: { getState: () => ({ goToPage }) }, adoptOpenOutcomes: vi.fn() }));

const widget = (pageId: number, tabOrder: number, y = 0, state: number | null = null): Widget => ({
  pageId,
  rect: { x: 10, y, w: 120, h: 20 },
  tabOrder,
  state,
  fill: null,
  border: null,
  textColor: [0, 0, 0],
});

function field(id: number, widgets: Widget[], extra: Partial<FormField> = {}): FormField {
  return {
    id,
    name: `field${id}`,
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

const result = (fields: ChangeSet['fields']): ChangeSet => ({
  rev: 1,
  upserted: [],
  removed: [],
  pages: null,
  fields,
  history: EMPTY_HISTORY,
});

// 200 x 400 pt shown at 1 px per pt.
const props = {
  docId: 1,
  pageIndex: 0,
  boxWidth: 200,
  boxHeight: 400,
  widthPt: 200,
  heightPt: 400,
  rotation: 0,
  ready: true,
};

function seed(fields: FormField[]) {
  useForms.setState({
    byDoc: { 1: { status: 'ready', fields, hasScripts: false } },
    highlight: true,
    focusRequest: null,
  });
}

const text = (extra: object = {}) =>
  ({
    type: 'text',
    multiline: false,
    maxLen: null,
    comb: false,
    password: false,
    align: 'left',
    fontSize: 0,
    ...extra,
  }) as const;

beforeEach(() => {
  resetDocuments();
  useDocuments.getState().add({ id: 1, pageCount: 2, displayName: 'a.pdf' });
  useAnnotations.setState({ byDoc: {}, selectedIds: {}, pageRevs: {} });
  useUi.setState({ activeTool: 'select', toolLocked: false, banner: null });
  api.applyCommand.mockReset().mockResolvedValue(result([]));
  goToPage.mockReset();
});

afterEach(() => useForms.setState({ byDoc: {} }));

describe('the form layer', () => {
  it('shows a labelled control for each field, named by its tooltip or name', () => {
    seed([field(1, [widget(0, 0)], { tooltip: 'Full name' }), field(2, [widget(0, 1, 30)])]);
    render(<FormLayer {...props} />);
    expect(screen.getByRole('textbox', { name: 'Full name' })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'field2' })).toBeTruthy();
  });

  it('shows nothing on a page without fields, and for a page that is not ready', () => {
    seed([field(1, [widget(1, 0)])]);
    const { container, rerender } = render(<FormLayer {...props} />);
    expect(container.querySelector('[data-form-layer]')).toBeNull();
    seed([field(1, [widget(0, 0)])]);
    rerender(<FormLayer {...props} ready={false} />);
    expect(container.querySelector('[data-form-layer]')).toBeNull();
  });

  it('commits typed text on blur as one setFieldValue command', async () => {
    seed([field(1, [widget(0, 0)])]);
    render(<FormLayer {...props} />);
    const input = screen.getByRole('textbox', { name: 'field1' });
    fireEvent.change(input, { target: { value: 'Ada' } });
    expect((input as HTMLInputElement).value).toBe('Ada');
    expect(api.applyCommand).not.toHaveBeenCalled();
    fireEvent.blur(input);
    await waitFor(() => expect(api.applyCommand).toHaveBeenCalledTimes(1));
    expect(api.applyCommand).toHaveBeenCalledWith(1, {
      type: 'setFieldValue',
      field: 1,
      value: { type: 'text', text: 'Ada' },
      coalesce: 'field:1',
    });
    // The value shows at once, from the replica.
    expect((screen.getByRole('textbox', { name: 'field1' }) as HTMLInputElement).value).toBe('Ada');
  });

  it('commits a single-line field on Enter and puts a draft back on Escape', async () => {
    seed([field(1, [widget(0, 0)], { value: { type: 'text', text: 'old' } })]);
    render(<FormLayer {...props} />);
    const input = screen.getByRole('textbox', { name: 'field1' }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'nope' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input.value).toBe('old');
    fireEvent.change(input, { target: { value: 'new' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(api.applyCommand).toHaveBeenCalledTimes(1));
  });

  it('limits the length and says so, and marks a required field', () => {
    seed([field(1, [widget(0, 0)], { kind: text({ maxLen: 5 }), required: true })]);
    render(<FormLayer {...props} />);
    const input = screen.getByRole('textbox', { name: 'field1' });
    expect(input.getAttribute('maxlength')).toBe('5');
    expect(input.getAttribute('aria-description')).toBe('Maximum 5 characters');
    expect(input.getAttribute('aria-required')).toBe('true');
    expect(input.closest('[data-form-widget]')?.getAttribute('data-required')).toBe('true');
  });

  it('a multi-line field is a textarea and a password field hides its text', () => {
    seed([
      field(1, [widget(0, 0)], { kind: text({ multiline: true }) }),
      field(2, [widget(0, 1, 40)], { kind: text({ password: true }) }),
    ]);
    const { container } = render(<FormLayer {...props} />);
    expect(container.querySelector('textarea')).not.toBeNull();
    expect(container.querySelector('input[type="password"]')).not.toBeNull();
  });

  it('toggles a checkbox at once', async () => {
    seed([field(1, [widget(0, 0)], { kind: { type: 'checkbox' }, value: { type: 'checked', on: false } })]);
    render(<FormLayer {...props} />);
    const box = screen.getByRole('checkbox', { name: 'field1' });
    expect(box.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(box);
    expect(screen.getByRole('checkbox', { name: 'field1' }).getAttribute('aria-checked')).toBe('true');
    await waitFor(() =>
      expect(api.applyCommand).toHaveBeenCalledWith(1, {
        type: 'setFieldValue',
        field: 1,
        value: { type: 'checked', on: true },
      }),
    );
  });

  it('puts the old value back and shows the error when the backend refuses', async () => {
    api.applyCommand.mockRejectedValue({ code: 'invalid_argument' });
    seed([field(1, [widget(0, 0)], { kind: { type: 'checkbox' }, value: { type: 'checked', on: false } })]);
    render(<FormLayer {...props} />);
    fireEvent.click(screen.getByRole('checkbox'));
    await waitFor(() => expect(useUi.getState().banner).not.toBeNull());
    expect(screen.getByRole('checkbox').getAttribute('aria-checked')).toBe('false');
  });

  it('a radio group is one radiogroup; arrows move and select', async () => {
    seed([
      field(1, [widget(0, 0, 0, 0), widget(0, 1, 30, 1)], {
        kind: { type: 'radio', states: ['A', 'B'], noToggleOff: false },
        value: { type: 'radio', selected: null },
        tooltip: 'Pick one',
      }),
    ]);
    render(<FormLayer {...props} />);
    expect(screen.getByRole('radiogroup', { name: 'Pick one' })).toBeTruthy();
    const radios = screen.getAllByRole('radio');
    expect(radios.map((radio) => radio.getAttribute('tabindex'))).toEqual(['0', '-1']);
    radios[0]?.focus();
    fireEvent.keyDown(radios[0] as HTMLElement, { key: 'ArrowDown' });
    await waitFor(() =>
      expect(api.applyCommand).toHaveBeenCalledWith(1, {
        type: 'setFieldValue',
        field: 1,
        value: { type: 'radio', selected: 1 },
      }),
    );
    expect(screen.getAllByRole('radio')[1]?.getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(screen.getAllByRole('radio')[1]);
  });

  it('a read-only field is a text node with aria-readonly, not an input', () => {
    seed([field(1, [widget(0, 0)], { readOnly: true, value: { type: 'text', text: 'fixed' } })]);
    const { container } = render(<FormLayer {...props} />);
    const node = screen.getByRole('textbox', { name: 'field1' });
    expect(node.getAttribute('aria-readonly')).toBe('true');
    expect(node.textContent).toBe('fixed');
    expect(container.querySelector('input')).toBeNull();
  });

  it('opens a choice field as a menu with the current option checked', async () => {
    seed([
      field(1, [widget(0, 0)], {
        kind: {
          type: 'choice',
          combo: true,
          editable: false,
          multiSelect: false,
          options: [
            { export: 'a', label: 'Alpha' },
            { export: 'b', label: 'Beta' },
          ],
        },
        value: { type: 'choice', selected: ['a'], custom: null },
      }),
    ]);
    render(<FormLayer {...props} />);
    const trigger = screen.getByRole('combobox', { name: 'field1' });
    expect(trigger.textContent).toBe('Alpha');
    fireEvent.click(trigger);
    const items = await screen.findAllByRole('menuitemcheckbox');
    expect(items.map((item) => item.getAttribute('aria-checked'))).toEqual(['true', 'false']);
    fireEvent.click(items[1] as HTMLElement);
    await waitFor(() =>
      expect(api.applyCommand).toHaveBeenCalledWith(1, {
        type: 'setFieldValue',
        field: 1,
        value: { type: 'choice', selected: ['b'], custom: null },
      }),
    );
  });

  it('shows a list box inline when its rows are tall enough', () => {
    const kind = {
      type: 'choice' as const,
      combo: false,
      editable: false,
      multiSelect: false,
      options: [
        { export: 'a', label: 'Alpha' },
        { export: 'b', label: 'Beta' },
      ],
    };
    seed([
      field(1, [{ ...widget(0, 0), rect: { x: 0, y: 0, w: 100, h: 60 } }], {
        kind,
        value: { type: 'choice', selected: [], custom: null },
      }),
    ]);
    // 2 px per pt: 12 pt * 1.25 * 2 = 30 px rows.
    render(<FormLayer {...props} boxWidth={400} boxHeight={800} />);
    expect(screen.getByRole('listbox', { name: 'field1' })).toBeTruthy();
    fireEvent.click(screen.getByRole('option', { name: 'Beta' }));
    expect(screen.getByRole('option', { name: 'Beta' }).getAttribute('aria-selected')).toBe('true');
  });

  it('is inert under a tool other than Select and Form', () => {
    seed([field(1, [widget(0, 0)])]);
    useUi.setState({ activeTool: 'note' });
    const { container } = render(<FormLayer {...props} />);
    expect(container.querySelector('[data-form-layer]')?.hasAttribute('inert')).toBe(true);
    act(() => useUi.setState({ activeTool: 'form' }));
    expect(container.querySelector('[data-form-layer]')?.hasAttribute('inert')).toBe(false);
  });

  it('turns the highlight off with the setting', () => {
    seed([field(1, [widget(0, 0)])]);
    const { container } = render(<FormLayer {...props} />);
    expect(container.querySelector('[data-form-widget]')?.getAttribute('data-highlight')).toBe('on');
    act(() => useForms.getState().setHighlight(false));
    expect(container.querySelector('[data-form-widget]')?.getAttribute('data-highlight')).toBe('off');
    act(() => useForms.getState().setHighlight(true));
  });

  it.each([90, 180, 270])('turns the layer with the view rotation of %i degrees and keeps the scale', (rotation) => {
    seed([field(1, [widget(0, 0)])]);
    // A quarter turn shows the page 400 wide and 200 high; a half turn keeps 200 x 400.
    const quarter = rotation !== 180;
    render(<FormLayer {...props} rotation={rotation} boxWidth={quarter ? 400 : 200} boxHeight={quarter ? 200 : 400} />);
    const group = screen.getByRole('group');
    expect(group.style.transform).toBe(`rotate(${rotation}deg) scale(1)`);
    expect(group.style.width).toBe('200px');
    expect(group.style.height).toBe('400px');
    expect(group.style.left).toBe(quarter ? '100px' : '0px');
    expect(group.style.top).toBe(quarter ? '-100px' : '0px');
    expect(group.style.getPropertyValue('--page-scale')).toBe('1');
    expect(screen.getByRole('textbox')).toBeTruthy();
  });

  it('follows the field states of a change set (undo) on the page', () => {
    seed([field(1, [widget(0, 0)], { value: { type: 'text', text: 'one' } })]);
    render(<FormLayer {...props} />);
    act(() =>
      useAnnotations
        .getState()
        .applyChanges(1, result([{ id: 1, value: { type: 'text', text: 'two' }, sync: 'modified' }])),
    );
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('two');
  });

  it('Tab goes to the next field in the tab order and Shift+Tab back; past the last it is left alone', () => {
    seed([field(1, [widget(0, 0)]), field(2, [widget(0, 1, 30)])]);
    render(<FormLayer {...props} />);
    const [one, two] = screen.getAllByRole('textbox');
    (one as HTMLElement).focus();
    // fireEvent returns false when the default was prevented.
    expect(fireEvent.keyDown(one as HTMLElement, { key: 'Tab' })).toBe(false);
    expect(document.activeElement).toBe(two);
    expect(fireEvent.keyDown(two as HTMLElement, { key: 'Tab' })).toBe(true);
    expect(fireEvent.keyDown(two as HTMLElement, { key: 'Tab', shiftKey: true })).toBe(false);
    expect(document.activeElement).toBe(one);
  });

  it('Tab to a field on a page that is not mounted scrolls there and focuses it when it mounts', () => {
    seed([field(1, [widget(0, 0)]), field(2, [widget(1, 0)])]);
    render(<FormLayer {...props} />);
    const one = screen.getByRole('textbox');
    one.focus();
    fireEvent.keyDown(one, { key: 'Tab' });
    expect(goToPage).toHaveBeenCalledWith(1);
    expect(useForms.getState().focusRequest?.key).toBe('2:0');
    // The page arrives.
    render(<FormLayer {...props} pageIndex={1} />);
    expect((document.activeElement as HTMLElement).getAttribute('aria-label')).toBe('field2');
    expect(useForms.getState().focusRequest).toBeNull();
  });
});
