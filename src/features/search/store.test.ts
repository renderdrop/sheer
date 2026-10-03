// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SearchEvent, SearchQuery } from '../../api/search';
import type { Quad } from '../../api/wire';
import { useDocuments } from '../../stores/documents';
import { SEARCH_DEBOUNCE_MS, SEARCH_MAX_CHARS, SEARCH_MAX_HITS, useSearch } from './store';

const api = vi.hoisted(() => ({
  search: vi.fn(),
  cancelSearch: vi.fn(),
}));
vi.mock('../../api/search', () => api);

interface Started {
  docId: number;
  query: SearchQuery;
  emit: (event: SearchEvent) => void;
}

let started: Started[] = [];
let nextId = 1;

const quad = (x: number, y: number): Quad => [
  { x, y },
  { x: x + 10, y },
  { x, y: y + 10 },
  { x: x + 10, y: y + 10 },
];
const hits = (pageId: number, count: number): SearchEvent => ({
  type: 'hits',
  pageId,
  hits: Array.from({ length: count }, (_, i) => [quad(10 * i, 20)]),
});

const DOC = 1;
const entry = (docId = DOC) => useSearch.getState().byDoc[docId];
const last = () => started[started.length - 1] as Started;

beforeEach(() => {
  vi.useFakeTimers();
  started = [];
  nextId = 1;
  api.search.mockReset().mockImplementation((docId: number, query: SearchQuery, emit: (event: SearchEvent) => void) => {
    started.push({ docId, query, emit });
    return Promise.resolve(nextId++);
  });
  api.cancelSearch.mockReset().mockResolvedValue(undefined);
  useSearch.setState({ byDoc: {}, focusRequest: 0 });
});

afterEach(() => {
  for (const id of Object.keys(useSearch.getState().byDoc)) useSearch.getState().drop(Number(id));
  vi.useRealTimers();
});

describe('typing', () => {
  it('searches 250 ms after the last key, from two characters, with the options and the hit limit', async () => {
    const { setText } = useSearch.getState();
    setText(DOC, 'a');
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS * 2);
    expect(started).toHaveLength(0);
    setText(DOC, 'ab');
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS - 1);
    setText(DOC, 'abc');
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS - 1);
    expect(started).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(started).toHaveLength(1);
    expect(last().query).toEqual({ text: 'abc', matchCase: false, wholeWord: false, maxHits: SEARCH_MAX_HITS });
    expect(entry()).toMatchObject({ status: 'running', ran: 'abc' });
  });

  it('Enter searches one character at once, and a query that was searched steps instead', async () => {
    useSearch.getState().setText(DOC, 'a');
    expect(useSearch.getState().submit(DOC)).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(last().query.text).toBe('a');
    last().emit(hits(0, 2));
    last().emit({ type: 'done', truncated: false });
    expect(useSearch.getState().submit(DOC)).toBe(false);
    expect(started).toHaveLength(1);
  });

  it('cuts the query to the length of the field and treats white space as empty', () => {
    useSearch.getState().setText(DOC, 'x'.repeat(SEARCH_MAX_CHARS + 50));
    expect(entry()?.text).toHaveLength(SEARCH_MAX_CHARS);
    useSearch.getState().setText(DOC, '   ');
    expect(entry()).toMatchObject({ text: '   ', hits: [], status: 'idle' });
    expect(useSearch.getState().submit(DOC)).toBe(true);
    expect(started).toHaveLength(0);
  });

  it('an empty field removes the results and cancels what runs', async () => {
    useSearch.getState().setText(DOC, 'abc');
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    last().emit(hits(0, 3));
    useSearch.getState().setText(DOC, '');
    expect(entry()).toMatchObject({ text: '', hits: [], pageHits: {}, active: -1, status: 'idle' });
    expect(api.cancelSearch).toHaveBeenCalledWith(1);
    // Messages in flight are not delivered.
    last().emit(hits(1, 1));
    expect(entry()?.hits).toEqual([]);
  });
});

describe('results', () => {
  beforeEach(async () => {
    useSearch.getState().setText(DOC, 'abc');
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
  });

  it('collects hits as the pages finish, per page, and makes the first one active without more', () => {
    last().emit(hits(0, 2));
    last().emit({ type: 'progress', done: 3, total: 10 });
    last().emit(hits(4, 1));
    const e = entry();
    expect(e?.hits.map((hit) => [hit.index, hit.page])).toEqual([
      [0, 0],
      [1, 0],
      [2, 4],
    ]);
    expect(e?.pageHits[0]).toHaveLength(2);
    expect(e?.pageHits[4]?.[0]?.index).toBe(2);
    expect(e).toMatchObject({ active: 0, stepped: false, pageCount: 2, progress: { done: 3, total: 10 } });
    last().emit({ type: 'done', truncated: false });
    expect(entry()).toMatchObject({ status: 'done', progress: null, truncated: false });
  });

  it('replaces only the page that got hits: the other pages keep their array', () => {
    last().emit(hits(0, 1));
    const page0 = entry()?.pageHits[0];
    last().emit(hits(1, 1));
    expect(entry()?.pageHits[0]).toBe(page0);
  });

  it('steps through the hits and wraps in both directions; stepping marks the entry as stepped', () => {
    last().emit(hits(0, 2));
    last().emit(hits(2, 1));
    last().emit({ type: 'done', truncated: false });
    const { step } = useSearch.getState();
    expect(step(DOC, 1)?.index).toBe(1);
    expect(step(DOC, 1)?.index).toBe(2);
    expect(step(DOC, 1)?.index).toBe(0);
    expect(step(DOC, -1)?.index).toBe(2);
    expect(entry()).toMatchObject({ active: 2, stepped: true });
  });

  it('has nothing to step to without hits, and activates a hit by index only if there is one', () => {
    expect(useSearch.getState().step(DOC, 1)).toBeNull();
    expect(useSearch.getState().activate(DOC, 3)).toBeNull();
    last().emit(hits(0, 2));
    expect(useSearch.getState().activate(DOC, 1)?.index).toBe(1);
    expect(entry()?.active).toBe(1);
  });

  it('reports a truncated search, and a failed one with its error and a retry', async () => {
    last().emit(hits(0, 1));
    last().emit({ type: 'done', truncated: true });
    expect(entry()?.truncated).toBe(true);
    useSearch.getState().retry(DOC);
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toHaveLength(2);
    last().emit({ type: 'failed', error: { code: 'internal', key: 'error.internal', retryable: true } as never });
    expect(entry()).toMatchObject({ status: 'failed', progress: null });
    expect(entry()?.error).not.toBeNull();
  });

  it('a new search starts from nothing, and a message of the old one is ignored', async () => {
    const old = last();
    old.emit(hits(0, 2));
    useSearch.getState().setOptions(DOC, { matchCase: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toHaveLength(2);
    expect(last().query).toMatchObject({ text: 'abc', matchCase: true });
    expect(entry()).toMatchObject({ hits: [], active: -1, status: 'running', matchCase: true });
    old.emit(hits(5, 1));
    expect(entry()?.hits).toEqual([]);
    // An option that does not change anything does not search again.
    useSearch.getState().setOptions(DOC, { matchCase: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toHaveLength(2);
  });

  it('is per document, and a closed document is forgotten', async () => {
    useSearch.getState().setText(2, 'zzz');
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    expect(started.map((s) => s.docId)).toEqual([1, 2]);
    last().emit(hits(0, 1));
    expect(entry(1)?.hits).toEqual([]);
    expect(entry(2)?.hits).toHaveLength(1);
    useSearch.getState().drop(2);
    expect(entry(2)).toBeUndefined();
    expect(entry(1)?.text).toBe('abc');
  });

  it('follows the documents store: a document that is closed loses its search', async () => {
    useDocuments.getState().add({ id: DOC, pageCount: 3, displayName: 'a.pdf' });
    useSearch.getState().setOptions(DOC, { wholeWord: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(entry()?.wholeWord).toBe(true);
    useDocuments.getState().remove(DOC);
    expect(entry()).toBeUndefined();
  });

  it('asks for focus', () => {
    useSearch.getState().requestFocus();
    useSearch.getState().requestFocus();
    expect(useSearch.getState().focusRequest).toBe(2);
  });
});
