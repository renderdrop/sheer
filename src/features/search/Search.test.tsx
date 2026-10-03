// @vitest-environment jsdom
import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SearchEvent, SearchQuery } from '../../api/search';
import type { Quad } from '../../api/wire';
import { useView } from '../../stores/view';
import { setup } from '../../test/render';
import { clearTextCache } from '../textlayer/cache';
import { resetViewer, showDocument } from '../viewer/viewer.testutil';
import { SearchPanel } from './Search';
import { SEARCH_DEBOUNCE_MS, useSearch } from './store';

const api = vi.hoisted(() => ({ search: vi.fn(), cancelSearch: vi.fn() }));
const textApi = vi.hoisted(() => ({ getTextLayer: vi.fn() }));
vi.mock('../../api/search', () => api);
vi.mock('../../api/text', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/text')>()),
  getTextLayer: textApi.getTextLayer,
}));

class FakeResizeObserver {
  constructor(readonly callback: ResizeObserverCallback) {}
  observe(): void {
    this.callback([], this as unknown as ResizeObserver);
  }
  unobserve(): void {}
  disconnect(): void {}
}

const BOOK = { id: 1, pageCount: 20, displayName: 'Book.pdf' };
let emit: (event: SearchEvent) => void = () => undefined;
let queries: SearchQuery[] = [];

const LINE = 'the quick brown fox';
/** A page whose only line is `LINE`: 6 pt characters at x = 10 + 6 i, y = 20. */
function layer() {
  const boxes: number[] = [];
  for (let i = 0; i < LINE.length; i += 1) boxes.push(10 + 6 * i, 20, 6, 12);
  return { text: LINE, boxes, truncated: false };
}
const quad = (from: number, to: number): Quad => [
  { x: 10 + 6 * from, y: 20 },
  { x: 10 + 6 * to, y: 20 },
  { x: 10 + 6 * from, y: 32 },
  { x: 10 + 6 * to, y: 32 },
];
const hits = (pageId: number, count: number): SearchEvent => ({
  type: 'hits',
  pageId,
  hits: Array.from({ length: count }, () => [quad(4, 9)]),
});

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 320 });
  queries = [];
  api.search
    .mockReset()
    .mockImplementation((_doc: number, query: SearchQuery, onEvent: (event: SearchEvent) => void) => {
      queries.push(query);
      emit = onEvent;
      return Promise.resolve(queries.length);
    });
  api.cancelSearch.mockReset().mockResolvedValue(undefined);
  textApi.getTextLayer.mockReset().mockImplementation(() => Promise.resolve(layer()));
  clearTextCache();
  resetViewer();
  showDocument(BOOK);
  useSearch.setState({ byDoc: {}, focusRequest: 0 });
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (HTMLElement.prototype as unknown as { clientHeight?: number }).clientHeight;
  for (const id of Object.keys(useSearch.getState().byDoc)) useSearch.getState().drop(Number(id));
  resetViewer();
});

const field = () => screen.getByRole('searchbox', { name: 'Search' }) as HTMLInputElement;

/** Types a query, presses Enter, and delivers the hits of two pages. */
async function searchFor(user: ReturnType<typeof setup>['user'], text = 'quick') {
  await user.type(field(), `${text}{Enter}`);
  await act(async () => {
    emit(hits(2, 2));
    emit(hits(5, 1));
    emit({ type: 'done', truncated: false });
  });
}

describe('the search panel', () => {
  it('says what the tab is for before anything is typed, and with no document', () => {
    const { unmount } = setup(<SearchPanel />);
    expect(screen.getByText('Search this document')).not.toBeNull();
    expect(screen.getByText('Results appear here, grouped by page.')).not.toBeNull();
    expect(
      (screen.getByRole('button', { name: 'Previous result' }) as HTMLButtonElement).getAttribute('aria-disabled'),
    ).toBe('true');
    unmount();
    resetViewer();
    setup(<SearchPanel />);
    expect(screen.getByText('Search results appear here.')).not.toBeNull();
  });

  it('searches on Enter and lists the hits under their page, the match in bold, as text', async () => {
    const { user } = setup(<SearchPanel />);
    await searchFor(user);
    expect(queries).toEqual([{ text: 'quick', matchCase: false, wholeWord: false, maxHits: 10_000 }]);
    const list = screen.getByRole('listbox');
    expect(within(list).getAllByRole('option')).toHaveLength(3);
    expect(within(list).getByText('Page 3')).not.toBeNull();
    expect(within(list).getByText('Page 6')).not.toBeNull();
    const first = within(list).getAllByRole('option')[0] as HTMLElement;
    expect(first.getAttribute('aria-selected')).toBe('true');
    expect(first.getAttribute('aria-label')).toBe('Page 3, the quick brown fox');
    expect(first.querySelector('span span')?.textContent).toBe('quick');
    expect(screen.getAllByText('3 results on 2 pages').length).toBeGreaterThan(0);
  });

  it('announces the count once and then the position as the hits are stepped', async () => {
    const { user } = setup(<SearchPanel />);
    await searchFor(user);
    const live = () => screen.getAllByRole('status').map((node) => node.textContent);
    expect(live()).toContain('3 results on 2 pages');
    await user.keyboard('{Enter}');
    expect(live()).toContain('Result 2 of 3, page 3');
    await user.keyboard('{Shift>}{Enter}{/Shift}');
    expect(live()).toContain('Result 1 of 3, page 3');
    await user.keyboard('{Shift>}{Enter}{/Shift}');
    expect(live()).toContain('Result 3 of 3, page 6');
  });

  it('jumps to the hit: the page of the hit becomes the current page', async () => {
    const { user } = setup(<SearchPanel />);
    await searchFor(user);
    await user.keyboard('{Enter}{Enter}');
    expect(useView.getState().byDoc[BOOK.id]?.pageIndex).toBe(5);
    await user.click(screen.getAllByRole('option')[0] as HTMLElement);
    expect(useView.getState().byDoc[BOOK.id]?.pageIndex).toBe(2);
    expect(screen.getAllByRole('option')[0]?.getAttribute('aria-selected')).toBe('true');
  });

  it('moves through the list with the arrows, keeps one tab stop, and Enter makes the hit active', async () => {
    const { user } = setup(<SearchPanel />);
    await searchFor(user);
    await user.keyboard('{ArrowDown}');
    const options = screen.getAllByRole('option');
    expect(document.activeElement).toBe(options[0]);
    expect(options.filter((option) => option.tabIndex === 0)).toHaveLength(1);
    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(document.activeElement).toBe(screen.getAllByRole('option')[2]);
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(screen.getAllByRole('option')[2]);
    await user.keyboard('{Enter}');
    expect(screen.getAllByRole('option')[2]?.getAttribute('aria-selected')).toBe('true');
    // Focus stays on the row.
    expect(document.activeElement).toBe(screen.getAllByRole('option')[2]);
    await user.keyboard('{Home}');
    expect(document.activeElement).toBe(screen.getAllByRole('option')[0]);
    await user.keyboard('{ArrowUp}');
    expect(document.activeElement).toBe(field());
  });

  it('Esc clears a field that has text, and the results with it', async () => {
    const { user } = setup(<SearchPanel />);
    await searchFor(user);
    await user.keyboard('{Escape}');
    expect(field().value).toBe('');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.getByText('Search this document')).not.toBeNull();
  });

  it('the options are toggles that search again', async () => {
    const { user } = setup(<SearchPanel />);
    await searchFor(user);
    const matchCase = screen.getByRole('button', { name: 'Match case' });
    expect(matchCase.getAttribute('aria-pressed')).toBe('false');
    await user.click(matchCase);
    expect(matchCase.getAttribute('aria-pressed')).toBe('true');
    await user.click(screen.getByRole('button', { name: 'Whole words' }));
    expect(queries.map((query) => [query.matchCase, query.wholeWord])).toEqual([
      [false, false],
      [true, false],
      [true, true],
    ]);
  });

  it('says so when nothing matches, with the query as text', async () => {
    const { user } = setup(<SearchPanel />);
    await user.type(field(), '<b>x{Enter}');
    await act(async () => emit({ type: 'done', truncated: false }));
    expect(screen.getByText('No results for "<b>x"')).not.toBeNull();
    expect(screen.getByText('Check the spelling or turn off the options.')).not.toBeNull();
  });

  it('says the document has no text when the pages it looked at have none', async () => {
    textApi.getTextLayer.mockImplementation(() => Promise.resolve({ text: '', boxes: [], truncated: false }));
    const { user } = setup(<SearchPanel />);
    await user.type(field(), 'zz{Enter}');
    await act(async () => emit({ type: 'done', truncated: false }));
    expect(await screen.findByText('This document has no searchable text.')).not.toBeNull();
  });

  it('shows a failure as an alert with a retry that searches again', async () => {
    const { user } = setup(<SearchPanel />);
    await user.type(field(), 'quick{Enter}');
    await act(async () =>
      emit({ type: 'failed', error: { code: 'internal', key: 'error.internal', retryable: true } as never }),
    );
    expect(screen.getByRole('alert').textContent).toContain('Search failed.');
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(queries).toHaveLength(2);
  });

  it('shows progress while it runs, and no transition on the bar', async () => {
    const { user, container } = setup(<SearchPanel />);
    await user.type(field(), 'quick{Enter}');
    await act(async () => emit({ type: 'progress', done: 4, total: 20 }));
    expect(screen.getByText('Searching… page 4 of 20')).not.toBeNull();
    const bar = container.querySelector<HTMLElement>('.bg-accent');
    expect(bar?.style.width).toBe('20%');
    expect(bar?.className).not.toContain('transition');
  });

  it('the clear button empties the field, searches nothing and takes no tab stop', async () => {
    const { user } = setup(<SearchPanel />);
    await searchFor(user);
    const clear = screen.getByRole('button', { name: 'Clear search' });
    expect(clear.tabIndex).toBe(-1);
    await user.click(clear);
    expect(field().value).toBe('');
    expect(document.activeElement).toBe(field());
  });

  it('takes the focus, and selects its text, when Find asks for it', async () => {
    setup(<SearchPanel />);
    act(() => useSearch.getState().setText(BOOK.id, 'quick'));
    act(() => useSearch.getState().requestFocus());
    expect(document.activeElement).toBe(field());
    expect(field().selectionStart).toBe(0);
    expect(field().selectionEnd).toBe(5);
  });

  it('searches by itself 250 ms after typing, from two characters', async () => {
    vi.useFakeTimers();
    try {
      setup(<SearchPanel />);
      fireEvent.change(field(), { target: { value: 'qu' } });
      await act(async () => vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS));
      expect(queries).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
