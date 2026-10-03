// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SearchEvent } from '../../api/search';
import { useDocuments } from '../../stores/documents';
import { SEARCH_DEBOUNCE_MS, SEARCH_MAX_HITS, useSearch } from './store';

const api = vi.hoisted(() => ({ search: vi.fn(), cancelSearch: vi.fn() }));
vi.mock('../../api/search', () => api);

const DOC = 7;
let emitters: ((event: SearchEvent) => void)[] = [];
const hits = (pageId: number, count: number): SearchEvent => ({
  type: 'hits',
  pageId,
  hits: Array.from(
    { length: count },
    () =>
      [
        [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
          { x: 0, y: 1 },
          { x: 1, y: 1 },
        ],
      ] as never,
  ),
});
const entry = () => useSearch.getState().byDoc[DOC];

beforeEach(() => {
  vi.useFakeTimers();
  emitters = [];
  let id = 1;
  api.search.mockReset().mockImplementation((_d: number, _q: unknown, emit: (e: SearchEvent) => void) => {
    emitters.push(emit);
    return Promise.resolve(id++);
  });
  api.cancelSearch.mockReset().mockResolvedValue(undefined);
  useSearch.setState({ byDoc: {}, focusRequest: 0 });
});
afterEach(() => {
  useSearch.getState().drop(DOC);
  vi.useRealTimers();
});

async function start(text: string) {
  useSearch.getState().setText(DOC, text);
  await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
}

describe('search limits and cancelling', () => {
  it('asks for the hit cap and marks a search that reached it as truncated', async () => {
    await start('ab');
    expect(api.search.mock.calls[0]?.[1]).toMatchObject({ maxHits: SEARCH_MAX_HITS });
    emitters[0]?.(hits(0, SEARCH_MAX_HITS));
    emitters[0]?.({ type: 'done', truncated: false });
    expect(entry()?.hits).toHaveLength(SEARCH_MAX_HITS);
    expect(entry()?.truncated).toBe(true);
  });
  it('is not truncated just below the cap', async () => {
    await start('ab');
    emitters[0]?.(hits(0, SEARCH_MAX_HITS - 1));
    emitters[0]?.({ type: 'done', truncated: false });
    expect(entry()?.truncated).toBe(false);
  });
  it('does not search on one character', async () => {
    await start('a');
    expect(api.search).not.toHaveBeenCalled();
  });
  it('retyping cancels the running search and ignores its late hits', async () => {
    await start('ab');
    expect(entry()?.status).toBe('running');
    useSearch.getState().setOptions(DOC, { matchCase: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(api.cancelSearch).toHaveBeenCalledWith(1);
    emitters[0]?.(hits(0, 3));
    expect(entry()?.hits).toHaveLength(0);
  });
  it('closing the document cancels the search and forgets it', async () => {
    await start('ab');
    useDocuments.setState({ byId: {}, order: [], activeId: null });
    useSearch.getState().drop(DOC);
    expect(api.cancelSearch).toHaveBeenCalledWith(1);
    expect(entry()).toBeUndefined();
  });
  it('step wraps from the last hit to the first and back', async () => {
    await start('ab');
    emitters[0]?.(hits(0, 3));
    useSearch.getState().step(DOC, -1);
    expect(entry()?.active).toBe(2);
    useSearch.getState().step(DOC, 1);
    expect(entry()?.active).toBe(0);
  });
});
