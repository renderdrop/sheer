// @vitest-environment jsdom
import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Annotation, ChangeSet } from '../../api/annotations';
import { EMPTY_HISTORY, useAnnotations } from '../../stores/annotations';
import { useUi } from '../../stores/ui';
import { setup } from '../../test/render';
import { AnnotationLayer } from '../annotations/layer/AnnotationLayer';
import { cancelJumpWait } from '../viewer/scrollBridge';
import { resetViewer, showDocument } from '../viewer/viewer.testutil';
import { Comments } from './Comments';
import { useComments } from './store';
import { clearQuotes } from './useQuote';

/** A fake backend that cascades deletes to replies and undoes them, behind the real stores and components. */
const backend = vi.hoisted(() => ({
  live: [] as Record<string, unknown>[],
  trash: [] as Record<string, unknown>[],
}));
const api = vi.hoisted(() => ({
  listDocumentAnnotations: vi.fn(),
  listAnnotations: vi.fn(),
  getAnnotationQuote: vi.fn(),
  applyCommand: vi.fn(),
  undo: vi.fn(),
}));
vi.mock('../../api/annotations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/annotations')>()),
  ...api,
}));

let rev = 0;
const history = (canUndo: boolean) => ({ ...EMPTY_HISTORY, canUndo, undoLabel: canUndo ? 'annotation.delete' : null });

const highlight = (id: number, pageId: number, over: Record<string, unknown> = {}) => ({
  id,
  pageId,
  kind: 'highlight',
  color: [255, 235, 0],
  opacity: 1,
  contents: '',
  author: 'Ann',
  modified: '2024-01-01T00:00:00Z',
  inReplyTo: null,
  locked: false,
  sync: 'new',
  rect: { x: 10, y: 10, w: 40, h: 10 },
  quads: [
    [
      { x: 10, y: 10 },
      { x: 50, y: 10 },
      { x: 10, y: 20 },
      { x: 50, y: 20 },
    ],
  ],
  ...over,
});

beforeEach(() => {
  rev = 0;
  backend.live = [
    highlight(1, 0, { contents: 'first' }),
    highlight(2, 0),
    highlight(3, 0, { contents: 'a reply', kind: 'note', inReplyTo: 2, at: { x: 10, y: 10 }, icon: 'note' }),
    highlight(4, 1),
  ];
  backend.trash = [];
  api.listDocumentAnnotations.mockReset().mockImplementation(async () => structuredClone(backend.live));
  api.listAnnotations
    .mockReset()
    .mockImplementation(async (_doc: number, page: number) =>
      structuredClone(backend.live.filter((a) => a.pageId === page)),
    );
  api.getAnnotationQuote.mockReset().mockResolvedValue(null);
  api.applyCommand.mockReset().mockImplementation(async (_doc: number, command: { ids: number[] }) => {
    const doomed = new Set(command.ids);
    for (const a of backend.live) if (doomed.has(a.inReplyTo as number)) doomed.add(a.id as number);
    backend.trash = backend.live.filter((a) => doomed.has(a.id as number));
    backend.live = backend.live.filter((a) => !doomed.has(a.id as number));
    rev += 1;
    return { rev, upserted: [], removed: [...doomed], pages: null, history: history(true) } satisfies ChangeSet;
  });
  api.undo.mockReset().mockImplementation(async () => {
    backend.live = [...backend.live, ...backend.trash].sort((a, b) => (a.id as number) - (b.id as number));
    const upserted = backend.trash as unknown as Annotation[];
    backend.trash = [];
    rev += 1;
    return { rev, upserted, removed: [], pages: null, history: history(false) } satisfies ChangeSet;
  });
  clearQuotes();
  useComments.setState({ byDoc: {}, views: {}, editing: {} });
  useAnnotations.setState({ byDoc: {}, selectedIds: {} });
  useUi.setState({ toast: null, banner: null });
  resetViewer();
  showDocument({ id: 1, pageCount: 3, displayName: 'Book.pdf' });
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(readonly cb: ResizeObserverCallback) {}
      observe() {
        this.cb([], this as unknown as ResizeObserver);
      }
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 600 });
  // Every row is 100 px tall, whatever it holds.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    () =>
      ({ height: 100, width: 200, top: 0, left: 0, right: 200, bottom: 100, x: 0, y: 0, toJSON: () => '' }) as DOMRect,
  );
});

afterEach(async () => {
  vi.restoreAllMocks();
  cancelJumpWait();
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  vi.unstubAllGlobals();
  delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
});

const cards = () => screen.queryAllByRole('article');
const rowsInDom = () => [...document.querySelectorAll<HTMLElement>('[data-row-key]')];
const settled = () => act(() => new Promise<void>((done) => setTimeout(done, 400)));

/** The list is consistent: one slot per row, tops are the sum of the heights above, the list is as tall as its rows. */
function expectConsistent(cardCount: number, pages: number) {
  expect(cards()).toHaveLength(cardCount);
  const rows = rowsInDom();
  expect(rows).toHaveLength(cardCount + pages);
  let top = 0;
  for (const row of rows) {
    expect(Number.parseFloat(row.style.top)).toBe(top);
    top += 100;
  }
  const list = screen.getByRole('list', { name: 'Comments' }) as HTMLElement;
  expect(Number.parseFloat(list.style.height)).toBe(top);
  // No orphan: every card belongs to a slot, every slot to the list.
  for (const card of cards()) expect(card.closest('[data-row-key]')).not.toBeNull();
}

async function shown() {
  const view = setup(
    <>
      <Comments />
      <AnnotationLayer
        docId={1}
        pageIndex={0}
        boxWidth={200}
        boxHeight={400}
        widthPt={100}
        heightPt={200}
        rotation={0}
        visible
        ready
      />
    </>,
  );
  await vi.waitFor(() => expect(cards()).toHaveLength(3));
  return view;
}

describe('deleting a highlight', () => {
  it('by the Delete key on the canvas selection', async () => {
    await shown();
    expectConsistent(3, 2);
    await act(async () => void useAnnotations.getState().select(1, [2]));
    const frame = document.querySelector<HTMLElement>('[data-annot-frame="2"]') as HTMLElement;
    act(() => frame.focus());
    fireEvent.keyDown(frame, { key: 'Delete' });
    await act(async () => undefined);
    await settled();
    // The highlight takes its reply with it.
    expect(cards()).toHaveLength(2);
    expect(document.querySelector('[data-key="a2"]')).toBeNull();
    expect(document.querySelector('[data-key="a3"]')).toBeNull();
    expect(document.querySelector('[data-row-key="a2"]')).toBeNull();
    expectConsistent(2, 2);
    expect(useAnnotations.getState().selectedIds[1] ?? []).toEqual([]);
    // Undo brings the card back.
    await act(async () => void (await useAnnotations.getState().undo(1)));
    await settled();
    expectConsistent(3, 2);
    expect(document.querySelector('[data-key="a2"]')).not.toBeNull();
  });

  it('by the card menu', async () => {
    const { user } = await shown();
    const card = document.querySelector<HTMLElement>('[data-key="a2"]') as HTMLElement;
    await user.click(within(card).getByRole('button', { name: 'Comment options' }));
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
    await settled();
    expect(document.querySelector('[data-key="a2"]')).toBeNull();
    expectConsistent(2, 2);
    await act(async () => void (await useAnnotations.getState().undo(1)));
    await settled();
    expectConsistent(3, 2);
  });

  it('by the Delete key on the focused card', async () => {
    const { user } = await shown();
    (document.querySelector('[data-key="a2"]') as HTMLElement).focus();
    await user.keyboard('{Delete}');
    await settled();
    expect(document.querySelector('[data-key="a2"]')).toBeNull();
    expectConsistent(2, 2);
    await act(async () => void (await useAnnotations.getState().undo(1)));
    await settled();
    expectConsistent(3, 2);
  });
});
