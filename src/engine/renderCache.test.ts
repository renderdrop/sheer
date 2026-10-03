import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_BUDGET_BYTES,
  MAX_BUDGET_BYTES,
  MAX_DROPPED_REMEMBERED,
  MIN_BUDGET_BYTES,
  RenderCache,
  clampBudget,
  imageKey,
  type ImageId,
  type RenderedImage,
} from './renderCache';

const MIB = 1024 * 1024;

/** A cache with a small budget and URLs that can be counted, over blobs that only claim a size. */
function makeCache(budgetBytes = MIN_BUDGET_BYTES) {
  let urls = 0;
  const created: string[] = [];
  const revoked: string[] = [];
  const cache = new RenderCache({
    budgetBytes,
    createUrl: () => {
      urls += 1;
      created.push(`blob:${urls}`);
      return `blob:${urls}`;
    },
    revokeUrl: (url) => revoked.push(url),
  });
  return { cache, created, revoked };
}

/** An image of `bytes` bytes. A Blob of that size is real memory, so a test that needs megabytes fakes the size. */
function image(bytes = 10, width = 100, height = 100): RenderedImage {
  const blob = new Blob([new Uint8Array(Math.min(bytes, 1024))]);
  Object.defineProperty(blob, 'size', { value: bytes });
  return { blob, width, height };
}

const id = (page: number, bucket = 2, docId = 1, tile?: readonly [number, number]): ImageId => ({
  docId,
  page,
  rev: 0,
  bucket,
  tile,
});

describe('keys', () => {
  it('are doc:page:rev:bucket, and add the tile as column,row', () => {
    expect(imageKey(id(3, 2, 7))).toBe('7:3:0:2');
    expect(imageKey({ docId: 7, page: 3, rev: 1, bucket: -4 })).toBe('7:3:1:-4');
    expect(imageKey(id(3, 14, 7, [2, 5]))).toBe('7:3:0:14:2,5');
    expect(imageKey({ ...id(3), tile: null })).toBe(imageKey(id(3)));
  });

  it('keep the annotation revision and the slot revision apart: 1 + 2 is not 2 + 1', () => {
    const a = imageKey({ docId: 1, page: 1, rev: 1, slotRev: 2, bucket: 0 });
    const b = imageKey({ docId: 1, page: 1, rev: 2, slotRev: 1, bucket: 0 });
    expect(a).not.toBe(b);
    expect(imageKey({ docId: 1, page: 1, rev: 1, slotRev: 0, bucket: 0 })).toBe(
      imageKey({ docId: 1, page: 1, rev: 1, bucket: 0 }),
    );
  });

  it('tell every part apart: another document, page, revision, bucket or tile is another image', () => {
    const keys = new Set([
      imageKey(id(0)),
      imageKey(id(1)),
      imageKey(id(0, 3)),
      imageKey(id(0, 2, 2)),
      imageKey({ ...id(0), rev: 1 }),
      imageKey(id(0, 2, 1, [0, 0])),
      imageKey(id(0, 2, 1, [1, 0])),
      imageKey(id(0, 2, 1, [0, 1])),
    ]);
    expect(keys.size).toBe(8);
  });

  it('has no collision between "page 1, bucket 12" and "page 11, bucket 2" and the like', () => {
    expect(imageKey(id(1, 12))).not.toBe(imageKey(id(11, 2)));
    expect(imageKey(id(1, 2, 12))).not.toBe(imageKey(id(1, 12, 2)));
  });
});

describe('the budget', () => {
  it('is 256 MiB by default and may be set between 128 and 1024 MiB', () => {
    expect(DEFAULT_BUDGET_BYTES).toBe(256 * MIB);
    expect(MIN_BUDGET_BYTES).toBe(128 * MIB);
    expect(MAX_BUDGET_BYTES).toBe(1024 * MIB);
    expect(new RenderCache().budgetBytes).toBe(256 * MIB);
    expect(clampBudget(1)).toBe(MIN_BUDGET_BYTES);
    expect(clampBudget(1e12)).toBe(MAX_BUDGET_BYTES);
    expect(clampBudget(512 * MIB)).toBe(512 * MIB);
    expect(clampBudget(Number.NaN)).toBe(DEFAULT_BUDGET_BYTES);
  });

  it('counts the PNG of every entry and gives it back when an entry goes', () => {
    const { cache } = makeCache();
    cache.put(id(0), image(40 * MIB));
    cache.put(id(1), image(30 * MIB));
    expect(cache.bytes).toBe(70 * MIB);
    expect(cache.size).toBe(2);
    cache.put(id(0), image(10 * MIB));
    expect(cache.bytes).toBe(40 * MIB);
    expect(cache.size).toBe(2);
    cache.dropDocument(1);
    expect(cache.bytes).toBe(0);
    expect(cache.size).toBe(0);
  });

  it('evicts the least recently used entries, oldest first, until it fits', () => {
    const { cache } = makeCache(); // 128 MiB
    for (let page = 0; page < 4; page += 1) cache.put(id(page), image(40 * MIB));
    // 160 MiB was put in: page 0 had to go, 120 MiB is left.
    expect(cache.has(imageKey(id(0)))).toBe(false);
    expect([1, 2, 3].every((page) => cache.has(imageKey(id(page))))).toBe(true);
    expect(cache.bytes).toBe(120 * MIB);
    // A use makes an entry young again: page 1 is touched, so page 2 is the oldest now.
    expect(cache.get(imageKey(id(1)))).toBeDefined();
    cache.put(id(4), image(40 * MIB));
    expect(cache.has(imageKey(id(2)))).toBe(false);
    expect([1, 3, 4].every((page) => cache.has(imageKey(id(page))))).toBe(true);
  });

  it('may evict several entries for one large one, but never the one just added', () => {
    const { cache } = makeCache();
    for (let page = 0; page < 3; page += 1) cache.put(id(page), image(40 * MIB));
    cache.put(id(9), image(120 * MIB));
    expect(cache.size).toBe(1);
    expect(cache.has(imageKey(id(9)))).toBe(true);
    // An entry larger than the whole budget stays alone, rather than being evicted the moment it arrives.
    cache.put(id(10), image(200 * MIB));
    expect(cache.has(imageKey(id(10)))).toBe(true);
    expect(cache.size).toBe(1);
  });

  it('is applied again when the budget is lowered', () => {
    const { cache } = makeCache(512 * MIB);
    for (let page = 0; page < 6; page += 1) cache.put(id(page), image(50 * MIB));
    expect(cache.size).toBe(6);
    cache.setBudget(1);
    expect(cache.budgetBytes).toBe(MIN_BUDGET_BYTES);
    expect(cache.bytes).toBeLessThanOrEqual(MIN_BUDGET_BYTES);
    expect(cache.size).toBe(2);
    // The two youngest stayed.
    expect(cache.has(imageKey(id(5))) && cache.has(imageKey(id(4)))).toBe(true);
  });

  it('peek and has are not uses: they do not save an entry from eviction', () => {
    const { cache } = makeCache();
    cache.put(id(0), image(60 * MIB));
    cache.put(id(1), image(60 * MIB));
    cache.peek(imageKey(id(0)));
    cache.has(imageKey(id(0)));
    cache.put(id(2), image(60 * MIB));
    expect(cache.has(imageKey(id(0)))).toBe(false);
  });
});

describe('pinned entries (the pages that are mounted)', () => {
  it('are not evicted, whatever the budget says', () => {
    const { cache } = makeCache();
    const page = {};
    cache.put(id(0), image(60 * MIB));
    cache.pin(page, [imageKey(id(0))]);
    for (let n = 1; n < 6; n += 1) cache.put(id(n), image(60 * MIB));
    expect(cache.has(imageKey(id(0)))).toBe(true);
    // The others went in turn, down to what fits beside the pinned one.
    expect(cache.bytes).toBeLessThanOrEqual(MIN_BUDGET_BYTES);
    expect(cache.size).toBe(2);
  });

  it('may keep the cache over its budget when everything is pinned, and release it later', () => {
    const { cache } = makeCache();
    const owners = [{}, {}, {}];
    owners.forEach((owner, n) => {
      cache.put(id(n), image(60 * MIB));
      cache.pin(owner, [imageKey(id(n))]);
    });
    expect(cache.bytes).toBe(180 * MIB);
    expect(cache.size).toBe(3);
    // Unpinning evicts down to the budget, oldest first.
    cache.unpin(owners[0] ?? {});
    expect(cache.has(imageKey(id(0)))).toBe(false);
    expect(cache.bytes).toBe(120 * MIB);
  });

  it('are held per owner: an entry two pages show stays until both let go', () => {
    const { cache } = makeCache();
    const [a, b] = [{}, {}];
    cache.put(id(0), image(60 * MIB));
    cache.pin(a, [imageKey(id(0))]);
    cache.pin(b, [imageKey(id(0))]);
    cache.unpin(a);
    cache.put(id(1), image(60 * MIB));
    cache.put(id(2), image(60 * MIB));
    expect(cache.has(imageKey(id(0)))).toBe(true);
    cache.unpin(b);
    // Nothing is over the budget yet, so it stays; it is the oldest, and the first to go when something needs the room.
    expect(cache.has(imageKey(id(0)))).toBe(true);
    cache.put(id(3), image(60 * MIB));
    expect(cache.has(imageKey(id(0)))).toBe(false);
  });

  it('are replaced as a whole by the next pin of the same owner', () => {
    const { cache } = makeCache();
    const page = {};
    cache.put(id(0), image(60 * MIB));
    cache.put(id(1), image(60 * MIB));
    cache.pin(page, [imageKey(id(0))]);
    cache.pin(page, [imageKey(id(1))]);
    cache.put(id(2), image(60 * MIB));
    expect(cache.has(imageKey(id(0)))).toBe(false);
    expect(cache.has(imageKey(id(1)))).toBe(true);
  });
});

describe('object URLs', () => {
  it('are made when an entry is first shown, once, and are the same afterwards', () => {
    const { cache, created } = makeCache();
    const entry = cache.put(id(0), image());
    expect(created).toEqual([]);
    expect(entry && cache.urlOf(entry)).toBe('blob:1');
    expect(entry && cache.urlOf(entry)).toBe('blob:1');
    expect(created).toEqual(['blob:1']);
  });

  it('are revoked when the entry is evicted', () => {
    const { cache, revoked } = makeCache();
    const first = cache.put(id(0), image(70 * MIB));
    const url = first === null ? '' : cache.urlOf(first);
    cache.put(id(1), image(70 * MIB));
    expect(revoked).toEqual([url]);
  });

  it('are revoked when the entry is replaced, when its document is dropped and when the cache is cleared', () => {
    const { cache, revoked } = makeCache();
    const urlOfPage = (page: number, docId = 1) => {
      const entry = cache.peek(imageKey(id(page, 2, docId)));
      return entry === undefined ? '' : cache.urlOf(entry);
    };
    cache.put(id(0), image());
    const replaced = urlOfPage(0);
    cache.put(id(0), image());
    expect(revoked).toEqual([replaced]);

    cache.put(id(1), image());
    cache.put(id(2, 2, 2), image());
    const dropped = urlOfPage(1);
    const kept = urlOfPage(2, 2);
    revoked.length = 0;
    cache.dropDocument(1);
    expect(revoked).toContain(dropped);
    expect(revoked).not.toContain(kept);
    cache.clear();
    expect(revoked).toContain(kept);
    expect(cache.size).toBe(0);
  });

  it('are never made for an entry nobody showed, so nothing needs revoking for it', () => {
    const { cache, revoked } = makeCache();
    cache.put(id(0), image(70 * MIB));
    cache.put(id(1), image(70 * MIB));
    expect(revoked).toEqual([]);
  });
});

describe('the best image of a page', () => {
  it('is the smallest bucket that is at least as sharp as wanted, else the sharpest there is', () => {
    const { cache } = makeCache();
    for (const bucket of [0, 4, 8]) cache.put(id(3, bucket), image());
    expect(cache.best(1, 3, 0, 4)?.bucket).toBe(4);
    expect(cache.best(1, 3, 0, 5)?.bucket).toBe(8);
    expect(cache.best(1, 3, 0, 1)?.bucket).toBe(4);
    expect(cache.best(1, 3, 0, -3)?.bucket).toBe(0);
    // Nothing sharper than 8: the sharpest is shown, scaled up.
    expect(cache.best(1, 3, 0, 20)?.bucket).toBe(8);
  });

  it('is nothing for a page without whole-page images, and only from its own document, page and revision', () => {
    const { cache } = makeCache();
    cache.put(id(3, 4), image());
    expect(cache.best(1, 4, 0, 4)).toBeUndefined();
    expect(cache.best(2, 3, 0, 4)).toBeUndefined();
    expect(cache.best(1, 3, 1, 4)).toBeUndefined();
  });

  it('leaves out the image it is told to: the one that is about to replace the stand-in', () => {
    const { cache } = makeCache();
    for (const bucket of [0, 4, 8]) cache.put(id(3, bucket), image());
    expect(cache.best(1, 3, 0, 4, imageKey(id(3, 4)))?.bucket).toBe(8);
    expect(cache.best(1, 3, 0, 8, imageKey(id(3, 8)))?.bucket).toBe(4);
    cache.dropDocument(1);
    cache.admit(1);
    cache.put(id(3, 4), image());
    expect(cache.best(1, 3, 0, 4, imageKey(id(3, 4)))).toBeUndefined();
  });

  it('does not take a tile for the page', () => {
    const { cache } = makeCache();
    cache.put(id(3, 12, 1, [0, 0]), image());
    expect(cache.best(1, 3, 0, 12)).toBeUndefined();
    cache.put(id(3, 4), image());
    expect(cache.best(1, 3, 0, 12)?.bucket).toBe(4);
  });

  it('forgets an entry that was evicted or dropped, and counts a use as a use', () => {
    const { cache } = makeCache();
    cache.put(id(0, 4), image(70 * MIB));
    cache.put(id(1, 4), image(70 * MIB));
    expect(cache.best(1, 0, 0, 4)).toBeUndefined();
    expect(cache.best(1, 1, 0, 4)?.bucket).toBe(4);
    cache.dropDocument(1);
    expect(cache.best(1, 1, 0, 4)).toBeUndefined();
  });
});

describe('fetch', () => {
  it('loads once and returns the cached entry afterwards, without loading again', async () => {
    const { cache } = makeCache();
    const load = vi.fn(() => Promise.resolve(image(5, 612, 792)));
    const entry = await cache.fetch(id(0), load);
    expect(entry).toMatchObject({ key: '1:0:0:2', width: 612, height: 792, bytes: 5 });
    expect(await cache.fetch(id(0), load)).toBe(entry);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('deduplicates requests that are in flight: the same image is loaded once however many ask', async () => {
    const { cache } = makeCache();
    let finish: (loaded: RenderedImage) => void = () => undefined;
    const load = vi.fn(
      () =>
        new Promise<RenderedImage>((resolve) => {
          finish = resolve;
        }),
    );
    const first = cache.fetch(id(0), load);
    const second = cache.fetch(id(0), load);
    expect(second).toBe(first);
    expect(load).toHaveBeenCalledTimes(1);
    expect(cache.isInflight(id(0))).toBe(true);
    expect(cache.inflightCount).toBe(1);
    // Another image is another request.
    const other = cache.fetch(id(1), () => new Promise<RenderedImage>(() => undefined));
    expect(other).not.toBe(first);
    expect(cache.inflightCount).toBe(2);

    finish(image(7));
    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(b);
    expect(cache.isInflight(id(0))).toBe(false);
    expect(cache.inflightCount).toBe(1);
  });

  it('shares a failure with everyone who asked, and asks again the next time', async () => {
    const { cache } = makeCache();
    const error = { code: 'cancelled' };
    const load = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce(image());
    const first = cache.fetch(id(0), load);
    const second = cache.fetch(id(0), load);
    await expect(first).rejects.toBe(error);
    await expect(second).rejects.toBe(error);
    expect(cache.has(imageKey(id(0)))).toBe(false);
    expect(cache.isInflight(id(0))).toBe(false);
    expect(await cache.fetch(id(0), load)).toBeDefined();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('counts a cache hit as a use', async () => {
    const { cache } = makeCache();
    await cache.fetch(id(0), () => Promise.resolve(image(60 * MIB)));
    await cache.fetch(id(1), () => Promise.resolve(image(60 * MIB)));
    await cache.fetch(id(0), () => Promise.reject(new Error('must not load')));
    await cache.fetch(id(2), () => Promise.resolve(image(60 * MIB)));
    expect(cache.has(imageKey(id(0)))).toBe(true);
    expect(cache.has(imageKey(id(1)))).toBe(false);
  });

  it('stores nothing for a document that was dropped while its image was on the way', async () => {
    const { cache } = makeCache();
    let finish: (loaded: RenderedImage) => void = () => undefined;
    const pending = cache.fetch(
      id(0),
      () =>
        new Promise<RenderedImage>((resolve) => {
          finish = resolve;
        }),
    );
    cache.dropDocument(1);
    expect(cache.isDropped(1)).toBe(true);
    finish(image(10));
    expect(await pending).toBeNull();
    expect(cache.size).toBe(0);
    // Until it is admitted again: ids are not reused in the app, but a test's are.
    cache.admit(1);
    expect(cache.isDropped(1)).toBe(false);
    expect(await cache.fetch(id(0), () => Promise.resolve(image()))).not.toBeNull();
  });
});

describe('the default budget of 256 MiB', () => {
  /** A cache with the default budget and URLs that can be counted. */
  function defaultCache() {
    const live = new Set<string>();
    let made = 0;
    const cache = new RenderCache({
      createUrl: () => {
        made += 1;
        live.add(`blob:${made}`);
        return `blob:${made}`;
      },
      revokeUrl: (url) => {
        expect(live.delete(url), `${url} was revoked twice or never made`).toBe(true);
      },
    });
    return { cache, live };
  }

  it('is never exceeded by a stream of unpinned images, and what goes is the least recently used', () => {
    const { cache } = defaultCache();
    expect(cache.budgetBytes).toBe(DEFAULT_BUDGET_BYTES);
    for (let page = 0; page < 300; page += 1) {
      cache.put(id(page), image(10 * MIB));
      expect(cache.bytes, `after page ${page}`).toBeLessThanOrEqual(DEFAULT_BUDGET_BYTES);
    }
    // 25 images of 10 MiB fit in 256 MiB, a 26th does not: the 25 youngest are left, in order.
    expect(cache.size).toBe(25);
    expect(cache.bytes).toBe(250 * MIB);
    expect(cache.has(imageKey(id(274)))).toBe(false);
    expect(cache.has(imageKey(id(275)))).toBe(true);
    expect(cache.has(imageKey(id(299)))).toBe(true);
  });

  it('is exact at the limit: 256 MiB fits, one byte more evicts the oldest', () => {
    const { cache } = defaultCache();
    cache.put(id(0), image(128 * MIB));
    cache.put(id(1), image(128 * MIB));
    expect(cache.bytes).toBe(DEFAULT_BUDGET_BYTES);
    expect(cache.size).toBe(2);
    cache.put(id(2), image(1));
    expect(cache.has(imageKey(id(0)))).toBe(false);
    expect(cache.bytes).toBe(128 * MIB + 1);
  });

  it('revokes the object URL of every image it evicts, once, and keeps those of the ones it holds', () => {
    const { cache, live } = defaultCache();
    for (let page = 0; page < 60; page += 1) {
      const entry = cache.put(id(page), image(10 * MIB));
      // The page shows it (a URL is made on first use) and then scrolls away.
      if (entry !== null) cache.urlOf(entry);
    }
    // A URL is live exactly for the entries that are still in the cache: nothing leaks, nothing is revoked twice.
    expect(live.size).toBe(cache.size);
    for (const entry of [...Array(60).keys()].map((page) => cache.peek(imageKey(id(page))))) {
      if (entry !== undefined) expect(live.has(cache.urlOf(entry))).toBe(true);
    }
    cache.clear();
    expect(live.size).toBe(0);
  });

  it('evicts in the order of use, not of arrival: an image shown again is kept, the unused one goes', () => {
    const { cache } = defaultCache();
    for (let page = 0; page < 25; page += 1) cache.put(id(page), image(10 * MIB));
    // Page 0 is the oldest; showing it again makes page 1 the oldest.
    cache.get(imageKey(id(0)));
    cache.put(id(25), image(10 * MIB));
    expect(cache.has(imageKey(id(0)))).toBe(true);
    expect(cache.has(imageKey(id(1)))).toBe(false);
  });
});

describe('a render that fails', () => {
  it('leaves what is cached as it was: the bytes, the images, and the URLs the pages are showing', async () => {
    const { cache, revoked, created } = makeCache();
    const shown = cache.put(id(0), image(60 * MIB));
    if (shown === null) throw new Error('not stored');
    cache.urlOf(shown);
    cache.put(id(1), image(60 * MIB));
    const [bytes, size] = [cache.bytes, cache.size];

    await expect(cache.fetch(id(2), () => Promise.reject(new Error('engine_timeout')))).rejects.toThrow(
      'engine_timeout',
    );
    await expect(cache.fetch(id(3, 12, 1, [0, 0]), () => Promise.reject({ code: 'limit_exceeded' }))).rejects.toEqual({
      code: 'limit_exceeded',
    });

    expect([cache.bytes, cache.size]).toEqual([bytes, size]);
    expect(cache.has(imageKey(id(0))) && cache.has(imageKey(id(1)))).toBe(true);
    expect(cache.inflightCount).toBe(0);
    expect(revoked).toEqual([]);
    expect(created).toHaveLength(1);
    // The page still has its image to show while the failed one is asked for again.
    expect(cache.best(1, 0, 0, 2)?.key).toBe(imageKey(id(0)));
  });

  it('does not take the failed image for another: the next ask loads it, and only it', async () => {
    const { cache } = makeCache();
    const failing = vi.fn(() => Promise.reject(new Error('boom')));
    await expect(cache.fetch(id(5), failing)).rejects.toThrow('boom');
    await expect(cache.fetch(id(5), failing)).rejects.toThrow('boom');
    // Every ask went to the loader: a failure is not cached, not even for a moment.
    expect(failing).toHaveBeenCalledTimes(2);
    const loaded = vi.fn(() => Promise.resolve(image(5)));
    expect(await cache.fetch(id(5), loaded)).not.toBeNull();
    expect(await cache.fetch(id(5), loaded)).not.toBeNull();
    expect(loaded).toHaveBeenCalledTimes(1);
  });

  it('does not stop a loader that throws before it returns a promise from being asked again', async () => {
    const { cache } = makeCache();
    try {
      await cache.fetch(id(5), () => {
        throw new Error('sync boom');
      });
    } catch {
      // A throw and a rejection are both a failure the page shows; what matters is that nothing stays in flight.
    }
    expect(cache.isInflight(id(5))).toBe(false);
    expect(cache.inflightCount).toBe(0);
    expect(await cache.fetch(id(5), () => Promise.resolve(image(5)))).not.toBeNull();
  });

  it('does not unpin or evict the images that pages show, and the budget still holds afterwards', async () => {
    const { cache } = makeCache();
    const page = {};
    cache.put(id(0), image(100 * MIB));
    cache.pin(page, [imageKey(id(0))]);
    await expect(cache.fetch(id(1), () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(cache.has(imageKey(id(0)))).toBe(true);
    // The cache goes on working: a later image goes in and the budget is applied around the pinned one.
    cache.put(id(2), image(20 * MIB));
    cache.put(id(3), image(20 * MIB));
    expect(cache.has(imageKey(id(0)))).toBe(true);
    expect(cache.has(imageKey(id(2)))).toBe(false);
    expect(cache.bytes).toBe(120 * MIB);
    expect(cache.bytes).toBeLessThanOrEqual(MIN_BUDGET_BYTES);
  });

  it('a failure for one image does not fail the others in flight', async () => {
    const { cache } = makeCache();
    let finish: (loaded: RenderedImage) => void = () => undefined;
    const slow = cache.fetch(
      id(0),
      () =>
        new Promise<RenderedImage>((resolve) => {
          finish = resolve;
        }),
    );
    await expect(cache.fetch(id(1), () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(cache.isInflight(id(0))).toBe(true);
    finish(image(7));
    expect(await slow).not.toBeNull();
  });
});

describe('listening to a page', () => {
  let cache: RenderCache;
  beforeEach(() => {
    cache = makeCache().cache;
  });

  it('calls the listener when an entry of that page is added, replaced or evicted, and no other', () => {
    const listener = vi.fn();
    cache.subscribe(1, 3, listener);
    const before = cache.version(1, 3);
    cache.put(id(3), image());
    expect(listener).toHaveBeenCalledTimes(1);
    cache.put(id(4), image());
    cache.put(id(3, 2, 2), image());
    expect(listener).toHaveBeenCalledTimes(1);
    cache.put(id(3, 6), image());
    expect(listener).toHaveBeenCalledTimes(2);
    expect(cache.version(1, 3)).toBeGreaterThan(before);
    cache.put(id(40), image(200 * MIB));
    // Page 3's entries were evicted for it.
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it('stops when told to, and when the document is dropped the pages hear of it', () => {
    const listener = vi.fn();
    const stop = cache.subscribe(1, 3, listener);
    cache.put(id(3), image());
    stop();
    cache.put(id(3, 6), image());
    expect(listener).toHaveBeenCalledTimes(1);
    const second = vi.fn();
    cache.subscribe(1, 3, second);
    cache.dropDocument(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('has a version that only ever goes up, per page', () => {
    const versions: number[] = [];
    for (let n = 0; n < 3; n += 1) {
      cache.put(id(3, n), image());
      versions.push(cache.version(1, 3));
    }
    expect(versions).toEqual([...versions].sort((a, b) => a - b));
    expect(new Set(versions).size).toBe(3);
    expect(cache.version(1, 99)).toBe(0);
  });

  it('forgets the versions of the pages of a dropped document, except those a page still listens to, until it stops', () => {
    cache.put(id(3), image());
    cache.put(id(4), image());
    cache.put(id(5, 2, 2), image());
    const listening = cache.version(1, 3);
    const elsewhere = cache.version(2, 5);
    expect(listening).toBeGreaterThan(0);
    expect(cache.version(1, 4)).toBeGreaterThan(0);

    const listener = vi.fn();
    const stop = cache.subscribe(1, 3, listener);
    cache.dropDocument(1);
    // Nobody reads the version of page 4 any more: it is gone. Page 3 is mounted still and has to see that it changed.
    expect(cache.version(1, 4)).toBe(0);
    expect(cache.version(1, 3)).toBeGreaterThan(listening);
    expect(listener).toHaveBeenCalledTimes(1);
    // Another document is left alone.
    expect(cache.version(2, 5)).toBe(elsewhere);

    // When the last page that listened lets go, the version of its page goes too.
    stop();
    expect(cache.version(1, 3)).toBe(0);
    expect(cache.version(2, 5)).toBe(elsewhere);
  });

  it('keeps the versions of a document that was admitted again when its pages stop listening', () => {
    cache.put(id(3), image());
    const stop = cache.subscribe(1, 3, vi.fn());
    cache.dropDocument(1);
    cache.admit(1);
    cache.put(id(3), image());
    const version = cache.version(1, 3);
    stop();
    expect(cache.version(1, 3)).toBe(version);
  });
});

describe('dropped documents', () => {
  it('are remembered up to a limit, the oldest forgotten first, so that the memory of them does not grow for ever', () => {
    const { cache } = makeCache();
    for (let doc = 0; doc < MAX_DROPPED_REMEMBERED + 10; doc += 1) cache.dropDocument(doc);
    for (let doc = 0; doc < 10; doc += 1) expect(cache.isDropped(doc), `${doc}`).toBe(false);
    for (let doc = 10; doc < MAX_DROPPED_REMEMBERED + 10; doc += 1) expect(cache.isDropped(doc), `${doc}`).toBe(true);
  });

  it('are remembered as of their latest drop', () => {
    const { cache } = makeCache();
    for (let doc = 0; doc < MAX_DROPPED_REMEMBERED; doc += 1) cache.dropDocument(doc);
    // Document 0 is the oldest; dropping it once more makes it the newest, so the next one to go is document 1.
    cache.dropDocument(0);
    cache.dropDocument(MAX_DROPPED_REMEMBERED);
    expect(cache.isDropped(0)).toBe(true);
    expect(cache.isDropped(1)).toBe(false);
    expect(cache.isDropped(2)).toBe(true);
  });

  it('still refuse an image that arrives late for one of the documents it remembers', async () => {
    const { cache } = makeCache();
    let finish: (loaded: RenderedImage) => void = () => undefined;
    const pending = cache.fetch(
      id(0, 2, 7),
      () =>
        new Promise<RenderedImage>((resolve) => {
          finish = resolve;
        }),
    );
    for (let doc = 0; doc < MAX_DROPPED_REMEMBERED - 1; doc += 1) cache.dropDocument(100 + doc);
    cache.dropDocument(7);
    finish(image());
    expect(await pending).toBeNull();
    expect(cache.size).toBe(0);
  });
});

describe('defaults', () => {
  it('make real object URLs through the platform', () => {
    const create = vi.fn(() => 'blob:real');
    const revoke = vi.fn();
    URL.createObjectURL = create;
    URL.revokeObjectURL = revoke;
    const cache = new RenderCache({ budgetBytes: MIN_BUDGET_BYTES });
    const entry = cache.put(id(0), image(10));
    if (entry === null) throw new Error('not stored');
    expect(cache.urlOf(entry)).toBe('blob:real');
    cache.clear();
    expect(revoke).toHaveBeenCalledWith('blob:real');
  });
});
