// @vitest-environment jsdom
import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AnnotationSummary } from '../../api/annotations';
import { EMPTY_HISTORY, useAnnotations } from '../../stores/annotations';
import { setup } from '../../test/render';
import { useViewer } from '../viewer/useViewer';
import { resetViewer, showDocument } from '../viewer/viewer.testutil';
import { Comments, CommentsActions, LOADING_SHOWN_AFTER_MS } from './Comments';
import { useComments } from './store';

const listDocumentAnnotations = vi.hoisted(() => vi.fn());
const listAnnotations = vi.hoisted(() => vi.fn());
vi.mock('../../api/annotations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/annotations')>()),
  listDocumentAnnotations,
  listAnnotations,
}));

const summary = (id: number, over: Partial<AnnotationSummary> = {}): AnnotationSummary => ({
  id,
  pageId: 0,
  kind: 'note',
  color: [255, 235, 0],
  contents: `Text ${id}`,
  author: 'Ann',
  modified: '2024-01-01T00:00:00Z',
  inReplyTo: null,
  ...over,
});

class FakeResizeObserver {
  constructor(readonly callback: ResizeObserverCallback) {}
  observe(): void {
    this.callback([], this as unknown as ResizeObserver);
  }
  unobserve(): void {}
  disconnect(): void {}
}

const LIST = [
  summary(1, { pageId: 0, contents: 'First <b>bold</b>' }),
  summary(2, { pageId: 0, author: 'Bob', inReplyTo: 1, contents: 'A reply' }),
  summary(3, { pageId: 2, author: null, kind: 'highlight', contents: '' }),
];

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 400 });
  listDocumentAnnotations.mockReset();
  listAnnotations.mockReset().mockResolvedValue([]);
  useComments.setState({ byDoc: {}, views: {} });
  useAnnotations.setState({ byDoc: {}, selectedIds: {} });
  resetViewer();
  showDocument({ id: 1, pageCount: 5, displayName: 'Book.pdf' });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
});

const items = () => screen.queryAllByRole('treeitem');

describe('Comments states', () => {
  it('shows the placeholder without a document', () => {
    resetViewer();
    setup(<Comments />);
    expect(screen.getByText('Comments appear here.')).toBeTruthy();
  });

  it('shows nothing for a moment, then a status, while loading', () => {
    vi.useFakeTimers();
    listDocumentAnnotations.mockReturnValue(new Promise(() => undefined));
    setup(<Comments />);
    expect(screen.queryByText('Loading comments')).toBeNull();
    act(() => void vi.advanceTimersByTime(LOADING_SHOWN_AFTER_MS));
    expect(screen.getByRole('status').textContent).toContain('Loading comments');
  });

  it('says there are no comments', async () => {
    listDocumentAnnotations.mockResolvedValue([]);
    setup(<Comments />);
    expect(await screen.findByText('No comments yet')).toBeTruthy();
    expect(screen.getByText('Notes, highlights and drawings appear here.')).toBeTruthy();
  });

  it('shows an error with a retry', async () => {
    listDocumentAnnotations.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(LIST);
    const { user } = setup(<Comments />);
    expect(await screen.findByRole('alert')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect((await screen.findAllByRole('treeitem')).length).toBeGreaterThan(0);
  });
});

describe('Comments tree', () => {
  async function shown() {
    listDocumentAnnotations.mockResolvedValue(LIST);
    const view = setup(
      <>
        <CommentsActions />
        <Comments />
      </>,
    );
    await screen.findAllByRole('treeitem');
    return view;
  }

  it('lists roots with a reply count and text only, replies hidden until expanded', async () => {
    await shown();
    expect(items()).toHaveLength(2);
    const first = items()[0] as HTMLElement;
    expect(first.getAttribute('aria-expanded')).toBe('false');
    expect(first.getAttribute('aria-label')).toContain('1 reply');
    expect(first.textContent).toContain('First <b>bold</b>');
    expect(first.querySelector('b')).toBeNull();
    expect(items()[1]?.getAttribute('aria-label')).toBe('Highlight, page 3');
    expect(screen.getByRole('tree', { name: 'Comments' })).toBeTruthy();
  });

  it('expands with the arrow keys and walks the tree', async () => {
    const { user } = await shown();
    (items()[0] as HTMLElement).focus();
    await user.keyboard('{ArrowRight}');
    expect(items()).toHaveLength(3);
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement?.getAttribute('aria-level')).toBe('2');
    await user.keyboard('{ArrowLeft}');
    expect(document.activeElement?.getAttribute('aria-level')).toBe('1');
    await user.keyboard('{ArrowLeft}');
    expect(items()).toHaveLength(2);
    await user.keyboard('{End}');
    expect(document.activeElement?.getAttribute('aria-posinset')).toBe('2');
    await user.keyboard('{Home}');
    expect(document.activeElement?.getAttribute('aria-posinset')).toBe('1');
  });

  it('jumps to the page and selects the annotation on Enter and on click, keeping the focus in the tree', async () => {
    const goToPage = vi.fn();
    useViewer.setState({ goToPage });
    const { user } = await shown();
    const first = items()[0] as HTMLElement;
    first.focus();
    await user.keyboard('{Enter}');
    await vi.waitFor(() => expect(useAnnotations.getState().selectedIds[1]).toEqual([1]));
    expect(goToPage).toHaveBeenCalledWith(0);
    expect(listAnnotations).toHaveBeenCalledWith(1, 0);
    expect(document.activeElement).toBe(first);
    await user.click(items()[1] as HTMLElement);
    expect(goToPage).toHaveBeenLastCalledWith(2);
    await vi.waitFor(() => expect(useAnnotations.getState().selectedIds[1]).toEqual([3]));
    expect(items()[1]?.getAttribute('aria-selected')).toBe('true');
  });

  it('marks the row of a canvas selection and opens the thread of a selected reply', async () => {
    await shown();
    act(() => useAnnotations.getState().select(1, [2]));
    expect(items()).toHaveLength(3);
    expect(items()[1]?.getAttribute('aria-selected')).toBe('true');
  });

  it('sorts, filters and resets', async () => {
    const { user } = await shown();
    await user.click(screen.getByRole('button', { name: 'Sort' }));
    await user.click(screen.getByRole('menuitemcheckbox', { name: 'Newest first' }));
    expect(items()).toHaveLength(2);

    await user.click(screen.getByRole('button', { name: 'Filter' }));
    const dialog = screen.getByRole('dialog', { name: 'Filter' });
    await user.click(within(dialog).getByRole('checkbox', { name: 'Highlight' }));
    expect(items()).toHaveLength(1);
    expect(screen.getByText('1 of 2')).toBeTruthy();
    await user.click(within(dialog).getByRole('checkbox', { name: 'Highlight' }));
    await user.click(within(dialog).getByRole('checkbox', { name: 'Bob' }));
    expect(items()).toHaveLength(1);
    await user.click(within(dialog).getByRole('checkbox', { name: 'No author' }));
    expect(items()).toHaveLength(2);
  });

  it('says nothing matches, with a reset', async () => {
    const { user } = await shown();
    act(() => useComments.getState().setFilter(1, { kinds: ['ink'], authors: [] }));
    expect(screen.getByText('No comments match the filter.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Reset filter' }));
    expect(items()).toHaveLength(2);
  });

  it('reads the list again when the annotations change', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await shown();
    expect(listDocumentAnnotations).toHaveBeenCalledTimes(1);
    act(() => {
      useAnnotations.setState({ byDoc: { 1: { rev: 1, byId: {}, loaded: {}, removed: {}, history: EMPTY_HISTORY } } });
    });
    await act(async () => void vi.advanceTimersByTime(300));
    expect(listDocumentAnnotations).toHaveBeenCalledTimes(2);
  });

  it('shows the contents as the excerpt, and a muted "No text" instead of the kind when there are none', async () => {
    await shown();
    expect(items()[0]?.textContent).toContain('First <b>bold</b>');
    const empty = items()[1] as HTMLElement;
    expect(empty.textContent).toContain('No text');
    expect(empty.textContent).not.toContain('Highlight');
  });

  describe('Delete and Backspace', () => {
    const apply = vi.fn();
    beforeEach(() => {
      apply.mockReset().mockResolvedValue(undefined);
      useAnnotations.setState({ apply } as never);
    });

    it('delete the focused annotation as one undoable change and move the focus to the next row', async () => {
      const { user } = await shown();
      (items()[0] as HTMLElement).focus();
      await user.keyboard('{Delete}');
      expect(apply).toHaveBeenCalledWith(1, { type: 'deleteAnnotations', ids: [1] });
      await vi.waitFor(() => expect(document.activeElement?.getAttribute('aria-posinset')).toBe('2'));
    });

    it('Backspace does the same, and the focus goes to the previous row when it was the last', async () => {
      const { user } = await shown();
      await user.keyboard('{Tab}');
      (items()[1] as HTMLElement).focus();
      await user.keyboard('{Backspace}');
      expect(apply).toHaveBeenCalledWith(1, { type: 'deleteAnnotations', ids: [3] });
      await vi.waitFor(() => expect(document.activeElement?.getAttribute('aria-posinset')).toBe('1'));
    });

    it('never delete an opaque annotation (it is not ours to edit)', async () => {
      listDocumentAnnotations.mockResolvedValue([summary(1, { kind: 'opaque', contents: '' })]);
      const { user } = setup(<Comments />);
      await screen.findAllByRole('treeitem');
      (items()[0] as HTMLElement).focus();
      await user.keyboard('{Delete}{Backspace}');
      expect(apply).not.toHaveBeenCalled();
    });

    it('leave the focus alone when the delete fails', async () => {
      apply.mockRejectedValue(new Error('refused'));
      const { user } = await shown();
      const first = items()[0] as HTMLElement;
      first.focus();
      await user.keyboard('{Delete}');
      await act(async () => {});
      expect(document.activeElement).toBe(first);
    });
  });

  it('keeps the rows when a refresh brings the same list, and replaces only what changed', async () => {
    await shown();
    const before = useComments.getState().byDoc[1];
    if (before?.status !== 'ready') throw new Error('not ready');
    listDocumentAnnotations.mockResolvedValue(LIST.map((item) => ({ ...item, color: [...item.color] })));
    act(() => useComments.getState().load(1));
    await vi.waitFor(() => expect(listDocumentAnnotations).toHaveBeenCalledTimes(2));
    await act(async () => {});
    const same = useComments.getState().byDoc[1];
    if (same?.status !== 'ready') throw new Error('not ready');
    expect(same.summaries).toBe(before.summaries);
    expect(same.threads).toBe(before.threads);
    expect(same.token).not.toBe(before.token);

    listDocumentAnnotations.mockResolvedValue(
      LIST.map((item) => (item.id === 3 ? { ...item, contents: 'Now' } : item)),
    );
    act(() => useComments.getState().load(1));
    await vi.waitFor(() => expect(items()[1]?.textContent).toContain('Now'));
    const changed = useComments.getState().byDoc[1];
    if (changed?.status !== 'ready') throw new Error('not ready');
    expect(changed.summaries[0]).toBe(before.summaries[0]);
    expect(changed.summaries[2]).not.toBe(before.summaries[2]);
  });

  it('uses only the newest of overlapping list calls, whatever order they answer in', async () => {
    await shown();
    let answerOld: (value: AnnotationSummary[]) => void = () => undefined;
    listDocumentAnnotations
      .mockReturnValueOnce(new Promise<AnnotationSummary[]>((resolve) => (answerOld = resolve)))
      .mockResolvedValueOnce([summary(9, { contents: 'Newest' })]);
    act(() => {
      useComments.getState().load(1);
      useComments.getState().load(1);
    });
    await vi.waitFor(() => expect(items()[0]?.textContent).toContain('Newest'));
    await act(async () => answerOld([summary(8, { contents: 'Stale' })]));
    expect(items()).toHaveLength(1);
    expect(items()[0]?.textContent).toContain('Newest');
  });

  it('ignores an answer for a document that was closed meanwhile', async () => {
    listDocumentAnnotations.mockResolvedValue(LIST);
    await shown();
    let answer: (value: AnnotationSummary[]) => void = () => undefined;
    listDocumentAnnotations.mockReturnValueOnce(new Promise<AnnotationSummary[]>((resolve) => (answer = resolve)));
    act(() => useComments.getState().load(1));
    act(() => useComments.getState().drop(1));
    await act(async () => answer(LIST));
    expect(useComments.getState().byDoc[1]).toBeUndefined();
  });

  it('virtualizes a long list', async () => {
    listDocumentAnnotations.mockResolvedValue(Array.from({ length: 500 }, (_, i) => summary(i + 1, { pageId: i % 5 })));
    setup(<Comments />);
    await screen.findAllByRole('treeitem');
    expect(items().length).toBeLessThan(40);
    fireEvent.scroll(screen.getByRole('tree').parentElement as HTMLElement, { target: { scrollTop: 5000 } });
    expect(items().length).toBeLessThan(40);
  });
});
