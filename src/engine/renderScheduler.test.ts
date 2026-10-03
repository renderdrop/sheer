import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RenderFrame } from '../api/frame';
import type { RenderRequest, ViewportHint } from '../api/render';
import { RenderCache, imageKey, type ImageId } from './renderCache';
import { RenderScheduler, VIEWPORT_SETTLE_MS, type RenderBackend } from './renderScheduler';

const frame = (width = 100, height = 100): RenderFrame => ({ data: new Uint8Array([1, 2, 3]), width, height });

interface Pending {
  request: RenderRequest;
  resolve: (frame: RenderFrame) => void;
  reject: (error: unknown) => void;
}

/** A backend whose renders stay open until the test answers them, and which records every call. */
function makeBackend() {
  const pending: Pending[] = [];
  const hints: { docId: number; hint: ViewportHint }[] = [];
  const backend: RenderBackend = {
    render: (request) =>
      new Promise<RenderFrame>((resolve, reject) => {
        pending.push({ request, resolve, reject });
      }),
    setViewport: (docId, hint) => {
      hints.push({ docId, hint });
      return Promise.resolve();
    },
  };
  return { backend, pending, hints };
}

const id = (page: number, bucket = 2, docId = 1, tile?: readonly [number, number]): ImageId => ({
  docId,
  page,
  rev: 0,
  bucket,
  tile,
});

function make() {
  const cache = new RenderCache({ createUrl: () => 'blob:x', revokeUrl: () => undefined });
  const fake = makeBackend();
  const scheduler = new RenderScheduler(cache, fake.backend);
  return { cache, scheduler, ...fake };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('requesting an image', () => {
  it('asks the backend once, with the bucket, tile, priority and generation, and puts the answer in the cache', async () => {
    const { scheduler, cache, pending } = make();
    scheduler.updateViewport(1, [3], []);
    const result = scheduler.request(id(3, 14, 1, [2, 1]), 'visible');
    expect(pending).toHaveLength(1);
    expect(pending[0]?.request).toEqual({
      docId: 1,
      pageId: 3,
      bucket: 14,
      tile: [2, 1],
      priority: 'visible',
      generation: 1,
    });
    pending[0]?.resolve(frame(1024, 512));
    const entry = await result;
    expect(entry).toMatchObject({ key: '1:3:0:14:2,1', width: 1024, height: 512, bytes: 3 });
    expect(cache.has(imageKey(id(3, 14, 1, [2, 1])))).toBe(true);
    expect(entry?.blob.type).toBe('image/png');
  });

  it('answers from the cache without asking the backend', async () => {
    const { scheduler, pending } = make();
    const first = scheduler.request(id(0), 'visible');
    pending[0]?.resolve(frame());
    await first;
    const again = await scheduler.request(id(0), 'near');
    expect(again).toBeDefined();
    expect(pending).toHaveLength(1);
  });

  it('asks once for an image that two pages want at the same time (the cache deduplicates what is in flight)', async () => {
    const { scheduler, pending } = make();
    const a = scheduler.request(id(0), 'visible');
    const b = scheduler.request(id(0), 'visible');
    expect(pending).toHaveLength(1);
    pending[0]?.resolve(frame());
    expect(await a).toBe(await b);
    // Another bucket of the same page is another image.
    void scheduler.request(id(0, 6), 'visible');
    expect(pending).toHaveLength(2);
  });

  it('is generation 0 before the viewport has ever been set', () => {
    const { scheduler, pending } = make();
    void scheduler.request(id(0), 'visible');
    expect(pending[0]?.request.generation).toBe(0);
    expect(scheduler.generationOf(1)).toBe(0);
  });

  it('rejects with the backend error when a render fails', async () => {
    const { scheduler, pending } = make();
    const result = scheduler.request(id(0), 'visible');
    pending[0]?.reject({ code: 'engine_timeout', key: 'error.engine_timeout', retryable: true });
    await expect(result).rejects.toMatchObject({ code: 'engine_timeout' });
    // The failed request is not remembered as in flight: it can be asked again.
    void scheduler.request(id(0), 'visible');
    expect(pending).toHaveLength(2);
  });

  it('normalizes what is not a backend error', async () => {
    const { scheduler, pending } = make();
    const result = scheduler.request(id(0), 'visible');
    pending[0]?.reject('C:\\Users\\user\\secret.pdf');
    await expect(result).rejects.toEqual({ code: 'internal', key: 'error.internal', retryable: false });
  });
});

describe('priorities and coalescing', () => {
  it('passes the priority of the page to the backend unchanged: visible, near and thumbnail', () => {
    const { scheduler, pending } = make();
    void scheduler.request(id(0), 'thumbnail');
    void scheduler.request(id(1), 'near');
    void scheduler.request(id(2), 'visible');
    expect(pending.map((entry) => entry.request.priority)).toEqual(['thumbnail', 'near', 'visible']);
  });

  it('asks once for a frame that is wanted at two priorities: the one in flight is the one that is waited for', async () => {
    const { scheduler, pending } = make();
    const near = scheduler.request(id(0), 'near');
    const visible = scheduler.request(id(0), 'visible');
    const thumbnail = scheduler.request(id(0), 'thumbnail');
    // One request reached the backend (which raises it when the viewport says the page is on screen).
    expect(pending).toHaveLength(1);
    expect(pending[0]?.request.priority).toBe('near');
    pending[0]?.resolve(frame());
    const entries = await Promise.all([near, visible, thumbnail]);
    expect(entries[0]).not.toBeNull();
    expect(entries[1]).toBe(entries[0]);
    expect(entries[2]).toBe(entries[0]);
  });

  it('keeps tiles apart: the same tile is one request, another tile of the same page and bucket is another', () => {
    const { scheduler, pending } = make();
    void scheduler.request(id(0, 12, 1, [0, 0]), 'visible');
    void scheduler.request(id(0, 12, 1, [0, 0]), 'visible');
    expect(pending).toHaveLength(1);
    void scheduler.request(id(0, 12, 1, [1, 0]), 'visible');
    void scheduler.request(id(0, 12, 1, [0, 1]), 'visible');
    void scheduler.request(id(0, 12), 'visible');
    void scheduler.request(id(0, 11, 1, [0, 0]), 'visible');
    expect(pending.map((entry) => [entry.request.bucket, entry.request.tile])).toEqual([
      [12, [0, 0]],
      [12, [1, 0]],
      [12, [0, 1]],
      [12, null],
      [11, [0, 0]],
    ]);
  });

  it('keeps documents apart: the same page and bucket of two documents are two requests', () => {
    const { scheduler, pending } = make();
    void scheduler.request(id(0, 2, 1), 'visible');
    void scheduler.request(id(0, 2, 2), 'visible');
    expect(pending.map((entry) => entry.request.docId)).toEqual([1, 2]);
  });

  it('asks again for a frame whose request was cancelled, and what was cancelled is never delivered or cached', async () => {
    const { scheduler, cache, pending } = make();
    scheduler.updateViewport(1, [0], []);
    const stale = scheduler.request(id(0), 'visible');
    // The backend withdrew it: the page scrolled away before it was drawn.
    pending[0]?.reject({ code: 'cancelled', key: 'error.cancelled', retryable: false });
    expect(await stale).toBeNull();
    expect(cache.has(imageKey(id(0)))).toBe(false);
    expect(cache.inflightCount).toBe(0);
    // The page is back on screen, in a newer generation: a new request, stamped with it.
    scheduler.updateViewport(1, [5], [0]);
    const again = scheduler.request(id(0), 'near');
    expect(pending).toHaveLength(2);
    expect(pending[1]?.request.generation).toBe(2);
    pending[1]?.resolve(frame());
    expect(await again).not.toBeNull();
  });

  it('delivers a frame that arrives after its generation was replaced: it is a valid image of its bucket', async () => {
    const { scheduler, cache, pending } = make();
    scheduler.updateViewport(1, [0], []);
    const late = scheduler.request(id(0), 'visible');
    scheduler.updateViewport(1, [9], []);
    pending[0]?.resolve(frame());
    // Cancelling is the backend's job (`set_viewport`); a frame it did draw is kept and shown.
    expect(await late).not.toBeNull();
    expect(cache.has(imageKey(id(0)))).toBe(true);
  });
});

describe('a render that fails', () => {
  it('leaves the images that are cached, and the scheduler keeps serving them and asking for the rest', async () => {
    const { scheduler, cache, pending } = make();
    const first = scheduler.request(id(0), 'visible');
    pending[0]?.resolve(frame());
    await first;
    const bytes = cache.bytes;

    const failed = scheduler.request(id(1), 'visible');
    pending[1]?.reject({ code: 'engine_unavailable', key: 'error.engine_unavailable', retryable: true });
    await expect(failed).rejects.toMatchObject({ code: 'engine_unavailable' });

    expect(cache.bytes).toBe(bytes);
    expect(cache.has(imageKey(id(0)))).toBe(true);
    // The cached one is answered without the backend, the failed one is asked for again.
    expect(await scheduler.request(id(0), 'visible')).not.toBeNull();
    void scheduler.request(id(1), 'visible');
    expect(pending).toHaveLength(3);
  });

  it('is not left "busy" by a failure of any kind', async () => {
    const { scheduler, pending } = make();
    const results = [0, 1, 2].map((page) => scheduler.request(id(page), 'visible'));
    expect(scheduler.busy).toBe(true);
    pending[0]?.reject({ code: 'engine_timeout', key: 'error.engine_timeout', retryable: true });
    pending[1]?.reject('not an AppError');
    pending[2]?.reject({ code: 'cancelled' });
    await Promise.allSettled(results);
    expect(scheduler.busy).toBe(false);
  });

  it('does not fail the other renders that are in flight', async () => {
    const { scheduler, pending } = make();
    const ok = scheduler.request(id(0), 'visible');
    const bad = scheduler.request(id(1), 'visible');
    pending[1]?.reject({ code: 'engine_timeout', key: 'error.engine_timeout', retryable: true });
    await expect(bad).rejects.toMatchObject({ code: 'engine_timeout' });
    pending[0]?.resolve(frame());
    expect(await ok).not.toBeNull();
  });
});

describe('failures that are not worth showing resolve to null', () => {
  it('a request the backend cancelled', async () => {
    const { scheduler, pending } = make();
    const result = scheduler.request(id(0), 'near');
    pending[0]?.reject({ code: 'cancelled', key: 'error.cancelled', retryable: false });
    expect(await result).toBeNull();
  });

  it('a tile that is not in the backend\u2019s grid, but not any other bad argument', async () => {
    const { scheduler, pending } = make();
    const tile = scheduler.request(id(0, 12, 1, [5, 0]), 'visible');
    pending[0]?.reject({ code: 'invalid_argument', key: 'error.invalid_argument', params: { what: 'tile' } });
    expect(await tile).toBeNull();
    const page = scheduler.request(id(1), 'visible');
    pending[1]?.reject({ code: 'invalid_argument', key: 'error.invalid_argument', params: { what: 'page' } });
    await expect(page).rejects.toMatchObject({ code: 'invalid_argument' });
  });

  it('anything for a document that was closed meanwhile, whatever the error, and the image that arrives is not kept', async () => {
    const { scheduler, cache, pending } = make();
    const failing = scheduler.request(id(0), 'visible');
    const arriving = scheduler.request(id(1), 'visible');
    scheduler.dropDocument(1);
    pending[0]?.reject({ code: 'not_found', key: 'error.not_found', params: { what: 'document' } });
    pending[1]?.resolve(frame());
    expect(await failing).toBeNull();
    expect(await arriving).toBeNull();
    expect(cache.size).toBe(0);
    // And nothing new is asked for it.
    expect(await scheduler.request(id(2), 'visible')).toBeNull();
    expect(pending).toHaveLength(2);
  });
});

describe('the viewport and its generations', () => {
  it('counts up for every different set of pages and not for the same one', () => {
    const { scheduler } = make();
    expect(scheduler.updateViewport(1, [0, 1], [2])).toBe(1);
    expect(scheduler.updateViewport(1, [0, 1], [2])).toBe(1);
    expect(scheduler.updateViewport(1, [1, 2], [0, 3])).toBe(2);
    expect(scheduler.updateViewport(1, [1, 2], [3, 0])).toBe(3);
    expect(scheduler.generationOf(1)).toBe(3);
    // Another document counts on its own.
    expect(scheduler.updateViewport(2, [0], [])).toBe(1);
    expect(scheduler.generationOf(1)).toBe(3);
  });

  it('stamps a render with the generation of its document at the time it is asked', () => {
    const { scheduler, pending } = make();
    scheduler.updateViewport(1, [0], []);
    void scheduler.request(id(0), 'visible');
    scheduler.updateViewport(1, [4], [5]);
    void scheduler.request(id(4), 'visible');
    scheduler.updateViewport(2, [0], []);
    void scheduler.request(id(0, 2, 2), 'visible');
    expect(pending.map((entry) => entry.request.generation)).toEqual([1, 2, 1]);
  });

  it('is told to the backend 150 ms after the viewport last changed, and only the last one', () => {
    const { scheduler, hints } = make();
    scheduler.updateViewport(1, [0], [1]);
    vi.advanceTimersByTime(100);
    scheduler.updateViewport(1, [1], [0, 2]);
    vi.advanceTimersByTime(100);
    scheduler.updateViewport(1, [2], [1, 3]);
    expect(hints).toHaveLength(0);
    vi.advanceTimersByTime(VIEWPORT_SETTLE_MS - 1);
    expect(hints).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(hints).toEqual([{ docId: 1, hint: { generation: 3, visible: [2], near: [1, 3] } }]);
    // Nothing more is sent while nothing changes.
    vi.advanceTimersByTime(1000);
    scheduler.updateViewport(1, [2], [1, 3]);
    vi.advanceTimersByTime(1000);
    expect(hints).toHaveLength(1);
  });

  it('waits for each document on its own', () => {
    const { scheduler, hints } = make();
    scheduler.updateViewport(1, [0], []);
    vi.advanceTimersByTime(100);
    scheduler.updateViewport(2, [5], []);
    vi.advanceTimersByTime(60);
    expect(hints.map((entry) => entry.docId)).toEqual([1]);
    vi.advanceTimersByTime(100);
    expect(hints.map((entry) => entry.docId)).toEqual([1, 2]);
  });

  it('sends at most 64 pages of each kind, the backend\u2019s limit', () => {
    const { scheduler, hints } = make();
    const many = Array.from({ length: 100 }, (_, page) => page);
    scheduler.updateViewport(1, many, many);
    vi.advanceTimersByTime(VIEWPORT_SETTLE_MS);
    expect(hints[0]?.hint.visible).toHaveLength(64);
    expect(hints[0]?.hint.near).toHaveLength(64);
  });

  it('survives a hint that fails: it is only an optimization', async () => {
    const cache = new RenderCache({ createUrl: () => 'blob:x', revokeUrl: () => undefined });
    const setViewport = vi.fn(() => Promise.reject(new Error('gone')));
    const scheduler = new RenderScheduler(cache, { render: () => new Promise(() => undefined), setViewport });
    scheduler.updateViewport(1, [0], []);
    vi.advanceTimersByTime(VIEWPORT_SETTLE_MS);
    await Promise.resolve();
    expect(setViewport).toHaveBeenCalledTimes(1);
  });

  it('is forgotten with the document: a hint that is still waiting is not sent', () => {
    const { scheduler, hints } = make();
    scheduler.updateViewport(1, [0], []);
    scheduler.dropDocument(1);
    vi.advanceTimersByTime(1000);
    expect(hints).toEqual([]);
    expect(scheduler.generationOf(1)).toBe(0);
  });
});

describe('being busy', () => {
  it('goes from idle to busy with the first render in flight and back with the last', async () => {
    const { scheduler, pending } = make();
    const states: boolean[] = [];
    const stop = scheduler.onBusy((busy) => states.push(busy));
    expect(scheduler.busy).toBe(false);
    const a = scheduler.request(id(0), 'visible');
    const b = scheduler.request(id(1), 'visible');
    expect(scheduler.busy).toBe(true);
    pending[0]?.resolve(frame());
    await a;
    expect(scheduler.busy).toBe(true);
    pending[1]?.reject({ code: 'cancelled' });
    await b;
    expect(scheduler.busy).toBe(false);
    expect(states).toEqual([true, false]);
    stop();
    void scheduler.request(id(2), 'visible');
    expect(states).toEqual([true, false]);
  });

  it('is not busy for an image the cache has', async () => {
    const { scheduler, pending } = make();
    const states: boolean[] = [];
    const first = scheduler.request(id(0), 'visible');
    pending[0]?.resolve(frame());
    await first;
    scheduler.onBusy((busy) => states.push(busy));
    await scheduler.request(id(0), 'visible');
    expect(states).toEqual([]);
  });
});
