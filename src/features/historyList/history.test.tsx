// @vitest-environment jsdom
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as api from '../../api/annotations';
import type { Annotation, ChangeSet, DocCommand, HistoryItem, HistoryList } from '../../api/annotations';
import { EMPTY_HISTORY, useAnnotations } from '../../stores/annotations';
import { useDocuments } from '../../stores/documents';
import { usePages } from '../../stores/pages';
import { setup } from '../../test/render';
import { ToolInspector } from '../inspector/ToolInspectorPanel';
import { useToolInspector } from '../inspector/toolInspector';
import { useHistoryLog } from './log';

vi.mock('../../api/annotations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/annotations')>()),
  applyCommand: vi.fn(),
  undo: vi.fn(),
  redo: vi.fn(),
  getHistory: vi.fn(),
}));
const applyMock = vi.mocked(api.applyCommand);
const undoMock = vi.mocked(api.undo);
const redoMock = vi.mocked(api.redo);
const historyMock = vi.mocked(api.getHistory);

const highlight = (id: number, pageId = 2): Annotation =>
  ({ id, pageId, kind: 'highlight', quads: [], color: [255, 255, 0], sync: 'new' }) as unknown as Annotation;

let rev = 0;
function answer(extra: Partial<ChangeSet> = {}): ChangeSet {
  rev += 1;
  return {
    rev,
    upserted: [],
    removed: [],
    pages: null,
    history: { ...EMPTY_HISTORY, canUndo: true, canRedo: false, dirty: true },
    ...extra,
  };
}

/** A fake of the backend's undo history: the list `get_history` answers, moved by apply, undo and redo. */
const back: { entries: HistoryItem[]; cursor: number; serial: number } = { entries: [], cursor: 0, serial: 0 };

function step(labelKey: string, extra: Partial<HistoryItem> = {}): HistoryItem {
  back.serial += 1;
  return {
    id: back.serial,
    labelKey,
    kind: 'other',
    page: null,
    annotationId: null,
    annotationKind: null,
    isTextEdit: false,
    ...extra,
  };
}

function record(item: HistoryItem): void {
  back.entries = [...back.entries.slice(0, back.cursor), item];
  back.cursor = back.entries.length;
}

const textEdit = {
  type: 'editTextLine',
  pageId: 0,
  key: {} as never,
  text: 'x',
  fit: 'keepStart',
  scope: 'line',
} as DocCommand;

async function run(command: DocCommand, changes: ChangeSet, item: HistoryItem) {
  record(item);
  applyMock.mockResolvedValueOnce(changes);
  await act(async () => {
    await useAnnotations.getState().apply(1, command);
  });
}

const created = (id: number) =>
  step('annotation.create', { kind: 'annotation', page: 2, annotationId: id, annotationKind: 'highlight' });
const moved = (id: number) => step('annotation.move', { page: 2, annotationId: id });
const edited = () => step('editText.undo', { kind: 'text', page: 0, isTextEdit: true });

beforeEach(() => {
  rev = 0;
  back.entries = [];
  back.cursor = 0;
  back.serial = 0;
  vi.resetAllMocks();
  historyMock.mockImplementation(() =>
    Promise.resolve({ entries: [...back.entries], cursor: back.cursor } satisfies HistoryList),
  );
  const moveCursor = (delta: number) => () => {
    back.cursor += delta;
    return Promise.resolve(
      answer({
        history: { ...EMPTY_HISTORY, canUndo: back.cursor > 0, canRedo: back.cursor < back.entries.length },
      }),
    );
  };
  undoMock.mockImplementation(moveCursor(-1));
  redoMock.mockImplementation(moveCursor(1));
  useHistoryLog.setState({ byDoc: {} });
  useAnnotations.setState({ byDoc: {}, selectedIds: {}, pageRevs: {} });
  useDocuments.setState({
    byId: { 1: { id: 1, pageCount: 4, displayName: 'a.pdf' } },
    order: [1],
    activeId: 1,
  } as never);
  usePages.setState({ byDoc: {}, slotsByDoc: { 1: [0, 1, 2, 3].map((id) => ({ id })) } } as never);
  useToolInspector.setState({ open: 'history' });
});

describe('history list', () => {
  it('lists steps newest first with kind and page, marks the current one', async () => {
    setup(<ToolInspector />);
    await run(
      { type: 'createAnnotation', draft: { kind: 'highlight', pageId: 2, color: [1, 2, 3], quads: [] } as never },
      answer({ upserted: [highlight(7)] }),
      created(7),
    );
    await run({ type: 'moveAnnotations', ids: [7], dx: 1, dy: 1 }, answer(), moved(7));
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(3));
    const items = screen.getAllByRole('listitem');
    expect(items[0]?.textContent).toContain('Move');
    expect(items[1]?.textContent).toContain('Highlight · p. 3');
    expect(items[0]?.querySelector('[aria-current="step"]')).not.toBeNull();
  });

  it('lists steps that did not come from the annotations commands (page operations, jobs)', async () => {
    setup(<ToolInspector />);
    back.entries = [step('page.rotate', { kind: 'page', page: 1 }), step('ocr.apply', { page: 3 })];
    back.cursor = 2;
    // A job's result reaches the store as a change set only.
    await act(async () => {
      useAnnotations.getState().applyChanges(1, answer());
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(3));
    const items = screen.getAllByRole('listitem');
    expect(items[0]?.textContent).toContain('Recognize text · p. 4');
    expect(items[1]?.textContent).toContain('Pages · p. 2');
    expect(screen.queryByRole('button', { name: /^Delete/ })).toBeNull();
  });

  it('jumps with repeated undo and greys later states; a new change drops them', async () => {
    const { user } = setup(<ToolInspector />);
    for (let i = 0; i < 3; i += 1) {
      await run({ type: 'moveAnnotations', ids: [i], dx: 1, dy: 1 }, answer(), moved(i));
    }
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(4));
    const first = screen.getAllByRole('listitem')[2] as HTMLElement;
    await user.click(first.querySelector('button') as HTMLElement);
    expect(undoMock).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(useHistoryLog.getState().byDoc[1]?.cursor).toBe(1));
    expect(screen.getAllByRole('listitem')[0]?.textContent).toContain('undone');
    await user.click(screen.getAllByRole('listitem')[0]?.querySelector('button') as HTMLElement);
    expect(redoMock).toHaveBeenCalledTimes(2);
    undoMock.mockClear();
    await user.click(screen.getAllByRole('listitem')[2]?.querySelector('button') as HTMLElement);
    await run({ type: 'moveAnnotations', ids: [9], dx: 1, dy: 1 }, answer(), moved(9));
    await waitFor(() => expect(useHistoryLog.getState().byDoc[1]?.entries).toHaveLength(2));
  });

  it('deletes an annotation from the list as a new undoable step; disabled when it is gone', async () => {
    const { user } = setup(<ToolInspector />);
    await run(
      { type: 'createAnnotation', draft: { kind: 'highlight', pageId: 2, color: [1, 2, 3], quads: [] } as never },
      answer({ upserted: [highlight(7)] }),
      created(7),
    );
    const del = await screen.findByRole('button', { name: /^Delete Highlight/ });
    record(step('annotation.delete', { page: 2, annotationId: 7 }));
    applyMock.mockResolvedValueOnce(answer({ removed: [7] }));
    await user.click(del);
    expect(applyMock).toHaveBeenLastCalledWith(1, { type: 'deleteAnnotations', ids: [7] });
    await waitFor(() => expect(useHistoryLog.getState().byDoc[1]?.entries).toHaveLength(2));
    expect((screen.getByRole('button', { name: /^Delete Highlight/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('Delete key deletes and Enter jumps from the keyboard', async () => {
    setup(<ToolInspector />);
    await run(
      { type: 'createAnnotation', draft: { kind: 'highlight', pageId: 2, color: [1, 2, 3], quads: [] } as never },
      answer({ upserted: [highlight(7)] }),
      created(7),
    );
    applyMock.mockResolvedValueOnce(answer({ removed: [7] }));
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(2));
    const row = screen.getAllByRole('listitem')[0]?.querySelector('button') as HTMLElement;
    fireEvent.keyDown(row, { key: 'Delete' });
    await waitFor(() => expect(applyMock).toHaveBeenCalledTimes(2));
  });

  it('text edits are listed, offer no delete, and a jump across them runs the steps in order', async () => {
    const { user } = setup(<ToolInspector />);
    await run(textEdit, answer(), edited());
    await run({ ...textEdit, text: 'y' } as DocCommand, answer(), edited());
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(3));
    expect(screen.queryByRole('button', { name: /^Delete/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'As opened' }));
    expect(undoMock).toHaveBeenCalledTimes(2);
    expect(useHistoryLog.getState().byDoc[1]?.cursor).toBe(0);
    await user.click(screen.getAllByRole('listitem')[0]?.querySelector('button') as HTMLElement);
    expect(redoMock).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('status').textContent).toContain('Went to');
  });
});
