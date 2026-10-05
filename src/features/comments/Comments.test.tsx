// @vitest-environment jsdom
import { act, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AnnotationSummary } from '../../api/annotations';
import { EMPTY_HISTORY, useAnnotations } from '../../stores/annotations';
import { setup } from '../../test/render';
import { useViewer } from '../viewer/useViewer';
import { resetViewer, showDocument } from '../viewer/viewer.testutil';
import { Comments, LOADING_SHOWN_AFTER_MS } from './Comments';
import { NO_FILTER } from './model';
import { useComments } from './store';
import { clearQuotes } from './useQuote';

const listDocumentAnnotations = vi.hoisted(() => vi.fn());
const listAnnotations = vi.hoisted(() => vi.fn());
const getAnnotationQuote = vi.hoisted(() => vi.fn());
vi.mock('../../api/annotations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/annotations')>()),
  listDocumentAnnotations,
  listAnnotations,
  getAnnotationQuote,
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
  getAnnotationQuote.mockReset().mockResolvedValue(null);
  clearQuotes();
  useComments.setState({ byDoc: {}, views: {}, editing: {} });
  useAnnotations.setState({ byDoc: {}, selectedIds: {} });
  resetViewer();
  showDocument({ id: 1, pageCount: 5, displayName: 'Book.pdf' });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
});

const cards = () => screen.queryAllByRole('article');

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
  });

  it('shows an error with a retry', async () => {
    listDocumentAnnotations.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(LIST);
    const { user } = setup(<Comments />);
    expect(await screen.findByRole('alert')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect((await screen.findAllByRole('article')).length).toBeGreaterThan(0);
  });
});

describe('Comments cards', () => {
  async function shown(list: AnnotationSummary[] = LIST) {
    listDocumentAnnotations.mockResolvedValue(list);
    const view = setup(<Comments />);
    await vi.waitFor(() => expect(cards().length).toBeGreaterThan(0), { timeout: 8000 });
    return view;
  }

  it('shows a card per thread with type, text as text, author and the reply', async () => {
    await shown();
    expect(cards()).toHaveLength(2);
    const first = cards()[0] as HTMLElement;
    expect(first.textContent).toContain('Note');
    expect(first.textContent).toContain('First <b>bold</b>');
    expect(first.querySelector('b')).toBeNull();
    expect(first.textContent).toContain('A reply');
    expect(first.textContent).toContain('p. 1');
    expect(cards()[1]?.textContent).toContain('Highlight');
  });

  it('shows the quote of a text markup, from the backend', async () => {
    getAnnotationQuote.mockResolvedValue('quoted words');
    await shown([summary(3, { kind: 'highlight', contents: '' })]);
    expect(await screen.findByText('“quoted words”')).toBeTruthy();
  });

  it('labels marks, signatures and comments by their type', async () => {
    await shown([
      summary(1, { kind: 'mark', detail: 'cross', contents: '' }),
      summary(2, { kind: 'signature', detail: 'initials', contents: '', pageId: 1 }),
      summary(3, { kind: 'highlight', contents: 'hi', pageId: 2 }),
    ]);
    const text = cards().map((c) => c.textContent);
    expect(text[0]).toContain('Cross');
    expect(text[1]).toContain('Initials');
    expect(text[2]).toContain('Comment');
  });

  it('collapses a resolved thread to a status pill and filters by status', async () => {
    const { user } = await shown([
      summary(1),
      summary(2, { inReplyTo: 1, state: 'completed', contents: '' }),
      summary(3, { pageId: 1 }),
    ]);
    expect(cards()).toHaveLength(2);
    expect(cards()[0]?.textContent).toContain('Resolved');
    // Collapsed to the header: the first line (the text) shows, the actions do not.
    expect(within(cards()[0] as HTMLElement).queryByRole('button', { name: 'Reply' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Filter' }));
    await user.click(screen.getByRole('radio', { name: 'Open' }));
    expect(cards()).toHaveLength(1);
    expect(cards()[0]?.textContent).toContain('Text 3');
  });

  it('expands a done card from its excerpt line and back', async () => {
    const { user } = await shown([summary(1), summary(2, { inReplyTo: 1, state: 'completed', contents: '' })]);
    const card = cards()[0] as HTMLElement;
    expect(card.className).toContain('opacity-60');
    expect(within(card).queryByRole('button', { name: 'Reply' })).toBeNull();
    await user.click(within(card).getByRole('button', { name: 'Show comment' }));
    expect(within(card).getByRole('button', { name: 'Reply' })).toBeTruthy();
    expect(card.textContent).toContain('Text 1');
    await user.click(within(card).getByRole('button', { name: 'Hide comment' }));
    expect(within(card).queryByRole('button', { name: 'Reply' })).toBeNull();
  });

  it('jumps, selects and keeps the focus on the card on Enter and click', async () => {
    const goToPage = vi.fn();
    useViewer.setState({ goToPage });
    const { user } = await shown();
    const first = cards()[0] as HTMLElement;
    first.focus();
    await user.keyboard('{Enter}');
    await vi.waitFor(() => expect(useAnnotations.getState().selectedIds[1]).toEqual([1]));
    expect(goToPage).toHaveBeenCalledWith(0);
    expect(document.activeElement).toBe(first);
    await user.click(cards()[1] as HTMLElement);
    expect(goToPage).toHaveBeenLastCalledWith(2);
    await vi.waitFor(() => expect(useAnnotations.getState().selectedIds[1]).toEqual([3]));
  });

  it('walks the cards with the arrow keys', async () => {
    const { user } = await shown();
    (cards()[0] as HTMLElement).focus();
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(cards()[1]);
    await user.keyboard('{Home}');
    expect(document.activeElement).toBe(cards()[0]);
    await user.keyboard('{End}');
    expect(document.activeElement).toBe(cards()[1]);
  });

  it('writes a review reply on Resolve', async () => {
    const apply = vi.fn().mockResolvedValue({ upserted: [] });
    useAnnotations.setState({
      apply,
      byDoc: {
        1: {
          rev: 0,
          byId: {
            1: {
              id: 1,
              pageId: 0,
              rect: { x: 5, y: 6, w: 10, h: 10 },
              color: [255, 235, 0],
              opacity: 1,
              contents: 'First',
              author: 'Ann',
              modified: null,
              inReplyTo: null,
              locked: false,
              sync: 'clean',
              kind: 'note',
              at: { x: 5, y: 6 },
              icon: 'note',
            },
          },
          loaded: { 0: true },
          removed: {},
          history: EMPTY_HISTORY,
        },
      },
    } as never);
    const { user } = await shown();
    await user.click(cards()[0] as HTMLElement);
    await user.click(within(cards()[0] as HTMLElement).getByRole('button', { name: 'Resolve' }));
    await vi.waitFor(() => expect(apply).toHaveBeenCalled());
    const command = apply.mock.calls[0]?.[1];
    expect(command.draft).toMatchObject({ kind: 'note', inReplyTo: 1, state: 'completed', pageId: 0 });
  });

  describe('the reply field', () => {
    const seed = () => {
      const apply = vi.fn().mockResolvedValue({ upserted: [] });
      useAnnotations.setState({
        apply,
        byDoc: {
          1: {
            rev: 0,
            byId: {
              1: {
                id: 1,
                pageId: 0,
                rect: { x: 5, y: 6, w: 10, h: 10 },
                color: [255, 235, 0],
                opacity: 1,
                contents: 'First',
                author: 'Ann',
                modified: null,
                inReplyTo: null,
                locked: false,
                sync: 'clean',
                kind: 'note',
                at: { x: 5, y: 6 },
                icon: 'note',
              },
            },
            loaded: { 0: true },
            removed: {},
            history: EMPTY_HISTORY,
          },
        },
      } as never);
      return apply;
    };
    const field = async () => {
      const { user } = await shown();
      await user.click(cards()[0] as HTMLElement);
      return { user, box: (await screen.findByRole('textbox', { name: 'Write a reply' })) as HTMLTextAreaElement };
    };

    it('Enter sends the reply and clears the field', async () => {
      const apply = seed();
      const { user, box } = await field();
      await user.type(box, 'Thanks{Enter}');
      await vi.waitFor(() => expect(apply).toHaveBeenCalled());
      expect(apply.mock.calls[0]?.[1].draft).toMatchObject({ inReplyTo: 1, contents: 'Thanks' });
      expect(box.value).toBe('');
    });

    it('Shift+Enter is a new line and sends nothing', async () => {
      const apply = seed();
      const { user, box } = await field();
      await user.type(box, 'a{Shift>}{Enter}{/Shift}b');
      expect(box.value).toBe('a\nb');
      expect(apply).not.toHaveBeenCalled();
    });

    it('Enter on a blank field sends nothing', async () => {
      const apply = seed();
      const { user, box } = await field();
      await user.type(box, '   {Enter}');
      expect(apply).not.toHaveBeenCalled();
    });

    it('is a full-width textarea', async () => {
      seed();
      const { box } = await field();
      expect(box.className).toMatch(/\bw-full\b/);
    });
  });

  it('delete removes the thread with its replies', async () => {
    const apply = vi.fn().mockResolvedValue(undefined);
    useAnnotations.setState({ apply } as never);
    const { user } = await shown();
    (cards()[0] as HTMLElement).focus();
    await user.keyboard('{Delete}');
    expect(apply).toHaveBeenCalledWith(1, { type: 'deleteAnnotations', ids: [1, 2] });
  });

  it('deletes from the ⋯ menu of the card (no Delete button in the action row)', async () => {
    const apply = vi.fn().mockResolvedValue(undefined);
    useAnnotations.setState({ apply } as never);
    const { user } = await shown();
    const card = cards()[0] as HTMLElement;
    expect(within(card).queryByRole('button', { name: 'Delete' })).toBeNull();
    await user.click(within(card).getByRole('button', { name: 'Comment options' }));
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
    expect(apply).toHaveBeenCalledWith(1, { type: 'deleteAnnotations', ids: [1, 2] });
  });

  it('never deletes an opaque annotation', async () => {
    const apply = vi.fn();
    useAnnotations.setState({ apply } as never);
    const { user } = await shown([summary(1, { kind: 'opaque', contents: '' })]);
    (cards()[0] as HTMLElement).focus();
    await user.keyboard('{Delete}');
    expect(apply).not.toHaveBeenCalled();
  });

  it('sorts by author and date from the sort menu and remembers the order', async () => {
    const { user } = await shown();
    await user.click(screen.getByRole('button', { name: 'Sort comments' }));
    await user.click(screen.getByRole('menuitemcheckbox', { name: 'Date, newest first' }));
    expect(useComments.getState().views[1]?.order).toBe('newest');
    await user.click(screen.getByRole('button', { name: 'Sort comments' }));
    await user.click(screen.getByRole('menuitemcheckbox', { name: 'Author A–Z' }));
    expect(useComments.getState().views[1]?.order).toBe('author');
    expect(window.localStorage.getItem('comments.sort')).toBe('author');
  });

  it('filters by author in the popover, counts it, and resets', async () => {
    const { user } = await shown([
      summary(1),
      summary(2, { author: 'Bob', pageId: 1 }),
      summary(3, { author: null, pageId: 2 }),
    ]);
    await user.click(screen.getByRole('button', { name: 'Filter' }));
    await user.click(screen.getByRole('checkbox', { name: 'No author' }));
    expect(cards()).toHaveLength(1);
    expect(screen.getByText('1 of 3')).toBeTruthy();
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Reset' }));
    expect(cards()).toHaveLength(3);
  });

  it('filters by type group and by page range', async () => {
    const { user } = await shown([
      summary(1, { kind: 'ink', contents: 'a', pageId: 0 }),
      summary(2, { kind: 'note', pageId: 1 }),
      summary(3, { kind: 'rect', contents: 'c', pageId: 2 }),
    ]);
    await user.click(screen.getByRole('button', { name: 'Filter' }));
    await user.click(screen.getByRole('checkbox', { name: 'Shape' }));
    expect(cards()).toHaveLength(1);
    await user.click(screen.getByRole('checkbox', { name: 'Shape' }));
    expect(cards()).toHaveLength(3);
    act(() => useComments.getState().setFilter(1, { ...NO_FILTER, pages: { from: 2, to: 3 } }));
    expect(cards()).toHaveLength(2);
  });

  it('has a compact filter button whose label is not cut', async () => {
    await shown();
    const button = screen.getByRole('button', { name: 'Filter' });
    expect(button.textContent).toContain('Filter');
    expect(button.querySelector('.truncate')).toBeNull();
  });

  it('says nothing matches, with a reset', async () => {
    const { user } = await shown();
    act(() => useComments.getState().setFilter(1, { ...NO_FILTER, kinds: ['ink'] }));
    expect(screen.getByText('No comments match these filters.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Reset filter' }));
    expect(cards()).toHaveLength(2);
  });

  it('puts the focus in the reply field when Reply is clicked', async () => {
    const { user } = await shown();
    const card = cards()[0] as HTMLElement;
    await user.click(within(card).getByRole('button', { name: 'Reply' }));
    expect(document.activeElement).toBe(within(card).getByRole('textbox', { name: 'Write a reply' }));
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

  it('puts a new comment in editing: Post is disabled while empty, Cancel takes it back', async () => {
    const undo = vi.fn().mockResolvedValue(undefined);
    useAnnotations.setState({
      undo,
      byDoc: {
        1: {
          rev: 0,
          byId: { 3: { id: 3 } },
          loaded: {},
          removed: {},
          history: { ...EMPTY_HISTORY, canUndo: true, undoLabel: 'annotation.create' },
        },
      },
    } as never);
    const { user } = await shown();
    act(() => useComments.getState().startEdit(1, 3, true));
    const post = await screen.findByRole('button', { name: 'Comment' });
    expect(post.getAttribute('aria-disabled')).toBe('true');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(undo).toHaveBeenCalledWith(1);
    expect(useComments.getState().editing[1]).toBeNull();
  });

  it('compose: Enter posts, Shift+Enter is a line break', async () => {
    const apply = vi.fn().mockResolvedValue({ upserted: [] });
    useAnnotations.setState({
      apply,
      byDoc: {
        1: {
          rev: 0,
          byId: { 3: { id: 3, contents: '', locked: false } },
          loaded: {},
          removed: {},
          history: EMPTY_HISTORY,
        },
      },
    } as never);
    const { user } = await shown();
    act(() => useComments.getState().startEdit(1, 3, true));
    const box = (await screen.findByRole('textbox', { name: 'Note text' })) as HTMLTextAreaElement;
    await user.type(box, 'a{Shift>}{Enter}{/Shift}b');
    expect(box.value).toBe('a\nb');
    expect(apply).not.toHaveBeenCalled();
    await user.keyboard('{Enter}');
    await vi.waitFor(() => expect(apply).toHaveBeenCalled());
    expect(useComments.getState().editing[1]).toBeNull();
  });

  it('keeps the rows when a refresh brings the same list', async () => {
    await shown();
    const before = useComments.getState().byDoc[1];
    if (before?.status !== 'ready') throw new Error('not ready');
    listDocumentAnnotations.mockResolvedValue(LIST.map((item) => ({ ...item, color: [...item.color] })));
    act(() => useComments.getState().load(1));
    await vi.waitFor(() => expect(listDocumentAnnotations).toHaveBeenCalledTimes(2));
    await act(async () => {});
    const same = useComments.getState().byDoc[1];
    if (same?.status !== 'ready') throw new Error('not ready');
    expect(same.threads).toBe(before.threads);
  });

  it('virtualizes a long list', async () => {
    await shown(Array.from({ length: 500 }, (_, i) => summary(i + 1, { pageId: i % 5 })));
    expect(cards().length).toBeLessThan(40);
  });
});
