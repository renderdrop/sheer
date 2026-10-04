// @vitest-environment jsdom
import { act, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as api from '../../api/annotations';
import type { Annotation, ChangeSet } from '../../api/annotations';
import { useAnnotations, EMPTY_HISTORY } from '../../stores/annotations';
import { useDocuments } from '../../stores/documents';
import { useTools } from '../../stores/tools';
import { useUi } from '../../stores/ui';
import { setup } from '../../test/render';
import { ToolSidebar as Inspector } from '../tools';
import { useStyleStore } from './style';

vi.mock('../../api/annotations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/annotations')>()),
  applyCommand: vi.fn(),
}));
const applyMock = vi.mocked(api.applyCommand);

const uiInitial = useUi.getState();
const annotationsInitial = useAnnotations.getState();
const documentsInitial = useDocuments.getState();

function ink(id: number, extra: Record<string, unknown> = {}): Annotation {
  return {
    id,
    pageId: 0,
    rect: { x: 0, y: 0, w: 10, h: 10 },
    color: [0, 114, 178],
    opacity: 1,
    contents: '',
    author: null,
    modified: null,
    inReplyTo: null,
    locked: false,
    sync: 'new',
    kind: 'ink',
    strokes: [{ points: [{ x: 0, y: 0 }], outline: [{ x: 0, y: 0 }] }],
    width: 2,
    ...extra,
  } as Annotation;
}

function freeText(id: number): Annotation {
  return {
    ...ink(id),
    kind: 'freeText',
    box: { x: 0, y: 0, w: 100, h: 20 },
    lines: ['hi'],
    fontSize: 12,
    fill: null,
    borderWidth: 0,
  } as unknown as Annotation;
}

function load(annotations: Annotation[], selected: number[]) {
  useDocuments.setState({
    ...documentsInitial,
    byId: { 1: { id: 1, pageCount: 1, displayName: 'a.pdf' } },
    order: [1],
    activeId: 1,
  });
  useAnnotations.setState({
    byDoc: {
      1: {
        rev: 1,
        byId: Object.fromEntries(annotations.map((a) => [a.id, a])),
        loaded: { 0: true },
        removed: {},
        history: EMPTY_HISTORY,
      },
    },
    selectedIds: { 1: selected },
  });
}

const changes = (upserted: Annotation[]): ChangeSet => ({
  rev: 2,
  upserted,
  removed: [],
  pages: null,
  history: { ...EMPTY_HISTORY, canUndo: true, undoLabel: 'annotation.update', dirty: true },
});

beforeEach(() => {
  useUi.setState({ ...uiInitial }, true);
  useAnnotations.setState({ ...annotationsInitial }, true);
  useDocuments.setState({ ...documentsInitial }, true);
  useStyleStore.getState().reset();
  applyMock.mockReset();
});

const swatch = (name: string) => screen.getByRole('radio', { name });

describe('the inspector with a selection', () => {
  it('names a single annotation by its type and checks its colour', () => {
    load([ink(1)], [1]);
    setup(<Inspector />);
    expect(screen.getByRole('heading', { name: 'Drawing' })).not.toBeNull();
    expect(swatch('Blue').getAttribute('aria-checked')).toBe('true');
    expect(swatch('Yellow').getAttribute('aria-checked')).toBe('false');
    // Draw has the line width presets and an opacity slider.
    expect(screen.getAllByRole('radio', { name: /pt$/ })).toHaveLength(4);
    expect(screen.getByRole('slider', { name: 'Opacity' })).not.toBeNull();
  });

  it('applies a colour as one update command', async () => {
    load([ink(1)], [1]);
    applyMock.mockResolvedValue(changes([ink(1, { color: [213, 94, 0] })]));
    const { user } = setup(<Inspector />);
    await user.click(swatch('Vermillion'));
    expect(applyMock).toHaveBeenCalledWith(1, { type: 'updateAnnotation', id: 1, patch: { color: [213, 94, 0] } });
    await waitFor(() => expect(swatch('Vermillion').getAttribute('aria-checked')).toBe('true'));
  });

  it('chooses with the arrow keys like a radio group (wrapping)', async () => {
    load([ink(1)], [1]);
    applyMock.mockResolvedValue(changes([ink(1)]));
    const { user } = setup(<Inspector />);
    swatch('Blue').focus();
    await user.keyboard('{ArrowRight}');
    expect(applyMock).toHaveBeenLastCalledWith(1, {
      type: 'updateAnnotation',
      id: 1,
      patch: { color: [86, 180, 233] },
    });
    await user.keyboard('{Home}');
    expect(applyMock).toHaveBeenLastCalledWith(1, {
      type: 'updateAnnotation',
      id: 1,
      patch: { color: [240, 228, 66] },
    });
    await user.keyboard('{End}');
    expect(applyMock).toHaveBeenLastCalledWith(1, { type: 'updateAnnotation', id: 1, patch: { color: [0, 0, 0] } });
  });

  it('sets the line width of the selection', async () => {
    load([ink(1)], [1]);
    applyMock.mockResolvedValue(changes([ink(1, { width: 8 })]));
    const { user } = setup(<Inspector />);
    await user.click(screen.getByRole('radio', { name: '8 pt' }));
    expect(applyMock).toHaveBeenCalledWith(1, { type: 'updateAnnotation', id: 1, patch: { width: 8 } });
  });

  it('shows Mixed for differing values and applies a change to all as one batch', async () => {
    load([ink(1), ink(2, { color: [0, 0, 0] })], [1, 2]);
    applyMock.mockResolvedValue(changes([ink(1), ink(2)]));
    const { user } = setup(<Inspector />);
    expect(screen.getByRole('heading', { name: '2 items' })).not.toBeNull();
    expect(screen.getByText('Mixed')).not.toBeNull();
    for (const radio of within(screen.getByRole('radiogroup', { name: /Colour/ })).getAllByRole('radio')) {
      expect(radio.getAttribute('aria-checked')).toBe('false');
    }
    await user.click(swatch('Green'));
    const command = applyMock.mock.calls[0]?.[1];
    expect(command).toMatchObject({ type: 'batch', label: 'annotation.update' });
  });

  it('only has the sections every selected type has', () => {
    load([ink(1), freeText(2)], [1, 2]);
    setup(<Inspector />);
    expect(screen.queryByRole('radio', { name: '4 pt' })).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Font size' })).toBeNull();
    expect(screen.getByRole('slider', { name: 'Opacity' })).not.toBeNull();
  });

  it('edits the font size of a free text from the field, clamped to 6 to 144', async () => {
    load([freeText(1)], [1]);
    applyMock.mockResolvedValue(changes([freeText(1)]));
    const { user } = setup(<Inspector />);
    const field = screen.getByRole('textbox', { name: 'Font size' });
    expect((field as HTMLInputElement).value).toBe('12');
    await user.clear(field);
    await user.type(field, '500{Enter}');
    expect(applyMock).toHaveBeenCalledWith(1, { type: 'updateAnnotation', id: 1, patch: { fontSize: 144 } });
  });

  it('lists a colour of the file that is not in the palette under Recent', () => {
    load([ink(1, { color: [1, 2, 3] })], [1]);
    setup(<Inspector />);
    expect(screen.getByText('Recent')).not.toBeNull();
    expect(screen.getByRole('radio', { name: 'Colour 1, 2, 3' }).getAttribute('aria-checked')).toBe('true');
  });

  it('does nothing for a locked annotation', async () => {
    load([ink(1, { locked: true })], [1]);
    const { user } = setup(<Inspector />);
    await user.click(swatch('Green'));
    expect(applyMock).not.toHaveBeenCalled();
  });

  it('shows a rejected command in the banner and leaves the replica as it was', async () => {
    load([ink(1)], [1]);
    applyMock.mockRejectedValue({ code: 'internal', key: 'error.internal', retryable: false });
    const { user } = setup(<Inspector />);
    await user.click(swatch('Green'));
    await waitFor(() => expect(useUi.getState().banner).not.toBeNull());
    expect(useAnnotations.getState().byDoc[1]?.byId[1]).toMatchObject({ color: [0, 114, 178] });
  });
});

describe('the inspector without a selection', () => {
  it('shows the empty state with Select', () => {
    load([ink(1)], []);
    setup(<Inspector />);
    expect(screen.getByText(/Click an annotation/)).not.toBeNull();
  });

  it('edits the style of the active tool, not an annotation', async () => {
    load([ink(1)], []);
    act(() => useUi.getState().selectTool('draw'));
    const { user } = setup(<Inspector />);
    expect(screen.getByRole('heading', { name: 'Tool options: Draw' })).not.toBeNull();
    await user.click(swatch('Green'));
    expect(applyMock).not.toHaveBeenCalled();
    expect(useStyleStore.getState().overrides.ink).toEqual({ color: [0, 158, 115] });
  });

  it('has the line end only for the arrow tool', () => {
    load([], []);
    act(() => {
      useUi.getState().selectTool('shapes');
      useTools.getState().setShapes('arrow');
    });
    setup(<Inspector />);
    expect(screen.getByRole('radio', { name: 'Open arrow' }).getAttribute('aria-checked')).toBe('true');
  });
});
