import { invoke } from '@tauri-apps/api/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MAX_QUADS_PER_HIT, MAX_SEARCH_HITS, cancelSearch, parseSearchEvent, search, type SearchEvent } from './search';

/** A `Channel` that keeps its handler, so a test can play the backend by calling `onmessage`. */
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  Channel: class {
    constructor(readonly onmessage: (message: unknown) => void) {}
  },
}));

const invokeMock = vi.mocked(invoke);

beforeEach(() => {
  invokeMock.mockReset();
});

const point = (x: number, y: number) => ({ x, y });
const QUAD = [point(1, 2), point(3, 2), point(1, 4), point(3, 4)];

/** The channel that the last `search` call handed to the backend. */
function channelOf(): { onmessage: (message: unknown) => void } {
  const [, args] = invokeMock.mock.calls.at(-1) ?? [];
  return (args as { onEvent: { onmessage: (message: unknown) => void } }).onEvent;
}

describe('search', () => {
  it('starts the search with every field of the query, the defaults filled in, and a channel; and resolves to its id', async () => {
    invokeMock.mockResolvedValueOnce(5);
    const id = await search(2, { text: 'M\u00fcnchen' }, vi.fn());
    expect(id).toBe(5);
    const [name, args] = invokeMock.mock.calls[0] ?? [];
    expect(name).toBe('search');
    expect(args).toMatchObject({
      docId: 2,
      query: { text: 'M\u00fcnchen', matchCase: false, wholeWord: false, maxHits: MAX_SEARCH_HITS },
    });
    expect(Object.keys(args as object).sort()).toEqual(['docId', 'onEvent', 'query']);
  });

  it('passes what the query says', async () => {
    invokeMock.mockResolvedValueOnce(1);
    await search(0, { text: 'a', matchCase: true, wholeWord: true, maxHits: 10 }, vi.fn());
    const [, args] = invokeMock.mock.calls[0] ?? [];
    expect(args).toMatchObject({ query: { text: 'a', matchCase: true, wholeWord: true, maxHits: 10 } });
  });

  it('hands the messages to the caller in order, as validated events', async () => {
    invokeMock.mockResolvedValueOnce(1);
    const events: SearchEvent[] = [];
    await search(0, { text: 'needle' }, (event) => events.push(event));
    const channel = channelOf();
    channel.onmessage({ type: 'hits', pageId: 2, hits: [[QUAD], [QUAD, QUAD]] });
    channel.onmessage({ type: 'progress', done: 3, total: 10 });
    channel.onmessage({ type: 'done', truncated: true });
    expect(events).toStrictEqual([
      { type: 'hits', pageId: 2, hits: [[QUAD], [QUAD, QUAD]] },
      { type: 'progress', done: 3, total: 10 },
      { type: 'done', truncated: true },
    ]);
  });

  it('delivers messages that arrive before the id does', async () => {
    let resolve: (id: number) => void = () => undefined;
    invokeMock.mockReturnValueOnce(new Promise<number>((done) => (resolve = done)));
    const events: SearchEvent[] = [];
    const started = search(0, { text: 'a' }, (event) => events.push(event));
    channelOf().onmessage({ type: 'progress', done: 1, total: 2 });
    resolve(8);
    await expect(started).resolves.toBe(8);
    expect(events).toHaveLength(1);
  });

  it('turns a failure into an error the UI can show, and sends nothing after it or after done', async () => {
    invokeMock.mockResolvedValueOnce(1);
    const events: SearchEvent[] = [];
    await search(0, { text: 'a' }, (event) => events.push(event));
    const channel = channelOf();
    channel.onmessage({
      type: 'failed',
      code: 'engine_crashed',
      key: 'error.engine_crashed',
      retryable: false,
      path: 'C:\\secret.pdf',
    });
    channel.onmessage({ type: 'progress', done: 1, total: 2 });
    channel.onmessage({ type: 'done', truncated: false });
    expect(events).toStrictEqual([
      { type: 'failed', error: { code: 'engine_crashed', key: 'error.engine_crashed', retryable: false } },
    ]);
  });

  it('ignores messages that are not messages of a search', async () => {
    invokeMock.mockResolvedValueOnce(1);
    const onEvent = vi.fn();
    await search(0, { text: 'a' }, onEvent);
    const channel = channelOf();
    for (const bad of [
      null,
      'done',
      7,
      [],
      {},
      { type: 'other' },
      { type: 'hits', pageId: -1, hits: [] },
      { type: 'hits', pageId: 1, hits: [[[point(1, 2)]]] },
      { type: 'progress', done: 5, total: 3 },
      { type: 'done', truncated: 'yes' },
    ]) {
      channel.onmessage(bad);
    }
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('rejects with the backend error and with the generic one for an id that is not a number', async () => {
    invokeMock.mockRejectedValueOnce({
      code: 'invalid_argument',
      key: 'error.invalid_argument',
      retryable: false,
      params: { what: 'query' },
    });
    await expect(search(0, { text: '' }, vi.fn())).rejects.toMatchObject({
      code: 'invalid_argument',
      params: { what: 'query' },
    });
    invokeMock.mockResolvedValueOnce('7');
    await expect(search(0, { text: 'a' }, vi.fn())).rejects.toMatchObject({ code: 'internal' });
  });
});

describe('cancelSearch', () => {
  it('calls cancel_search with the id', async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    await cancelSearch(4);
    expect(invokeMock).toHaveBeenCalledWith('cancel_search', { searchId: 4 });
  });

  it('closes the search at once: what was in flight is not delivered', async () => {
    invokeMock.mockResolvedValueOnce(9);
    const onEvent = vi.fn();
    await search(0, { text: 'a' }, onEvent);
    const channel = channelOf();
    channel.onmessage({ type: 'progress', done: 1, total: 3 });
    invokeMock.mockResolvedValueOnce(undefined);
    await cancelSearch(9);
    channel.onmessage({ type: 'progress', done: 2, total: 3 });
    channel.onmessage({ type: 'done', truncated: false });
    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  it('is not an error for a search that is unknown or over', async () => {
    invokeMock.mockResolvedValue(undefined);
    await expect(cancelSearch(12_345)).resolves.toBeUndefined();
  });
});

describe('parseSearchEvent', () => {
  it('takes the quads of a hit up to the limit and no more', () => {
    const hit = (quads: number) => Array.from({ length: quads }, () => QUAD);
    expect(parseSearchEvent({ type: 'hits', pageId: 0, hits: [hit(MAX_QUADS_PER_HIT)] })).not.toBeNull();
    expect(parseSearchEvent({ type: 'hits', pageId: 0, hits: [hit(MAX_QUADS_PER_HIT + 1)] })).toBeNull();
    // A hit without a quad shows nothing: the backend does not send one.
    expect(parseSearchEvent({ type: 'hits', pageId: 0, hits: [[]] })).toBeNull();
  });

  it('takes 50 000 hits in a message and not one more', () => {
    const hits = (count: number) => Array.from({ length: count }, () => [QUAD]);
    expect(parseSearchEvent({ type: 'hits', pageId: 0, hits: hits(MAX_SEARCH_HITS) })).not.toBeNull();
    expect(parseSearchEvent({ type: 'hits', pageId: 0, hits: hits(MAX_SEARCH_HITS + 1) })).toBeNull();
  });

  it('keeps the error params the backend whitelists and drops anything else', () => {
    expect(
      parseSearchEvent({
        type: 'failed',
        code: 'limit_exceeded',
        key: 'error.limit_exceeded',
        retryable: false,
        params: { what: 'searches', limit: 64 },
      }),
    ).toStrictEqual({
      type: 'failed',
      error: {
        code: 'limit_exceeded',
        key: 'error.limit_exceeded',
        retryable: false,
        params: { what: 'searches', limit: 64 },
      },
    });
  });
});
