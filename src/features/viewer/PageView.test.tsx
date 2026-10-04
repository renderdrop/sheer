// @vitest-environment jsdom
import { act, fireEvent, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RenderFrame } from '../../api/frame';
import type { RenderRequest } from '../../api/render';
import { planPage } from '../../engine/buckets';
import { RenderCache, imageKey, MIN_BUDGET_BYTES } from '../../engine/renderCache';
import { RenderScheduler, type RenderBackend } from '../../engine/renderScheduler';
import { setup } from '../../test/render';
import { useUi } from '../../stores/ui';
import { BUCKET_SETTLE_MS, RENDER_RETRIES, RENDER_RETRY_MS, PageView, type PageViewProps } from './PageView';
import { clearRenderFailure } from './renderFailure';
import { publishViewRect } from './scrollBridge';

const MIB = 1024 * 1024;
const frame = (width = 100, height = 100): RenderFrame => ({ data: new Uint8Array([1, 2, 3]), width, height });

interface Pending {
  request: RenderRequest;
  resolve: (frame: RenderFrame) => void;
  reject: (error: unknown) => void;
}

function fixture() {
  const pending: Pending[] = [];
  const backend: RenderBackend = {
    render: (request) =>
      new Promise<RenderFrame>((resolve, reject) => {
        pending.push({ request, resolve, reject });
      }),
    setViewport: () => Promise.resolve(),
  };
  let urls = 0;
  const revoked: string[] = [];
  const cache = new RenderCache({
    budgetBytes: MIN_BUDGET_BYTES,
    createUrl: () => `blob:${(urls += 1)}`,
    revokeUrl: (url) => revoked.push(url),
  });
  const scheduler = new RenderScheduler(cache, backend);
  return { pending, cache, scheduler, revoked };
}

const BOX = { left: 20, top: 340, width: 816, height: 1056 };

function view(scheduler: RenderScheduler, overrides: Partial<PageViewProps> = {}) {
  return (
    <PageView
      docId={1}
      pageIndex={4}
      pageCount={12}
      {...BOX}
      widthPt={612}
      heightPt={792}
      bucket={2}
      priority="visible"
      scheduler={scheduler}
      {...overrides}
    />
  );
}

/** Puts an image of `bytes` bytes for page 4 into the cache, as a render would have. */
function put(cache: RenderCache, bucket: number, tile?: readonly [number, number], bytes = 10) {
  const blob = new Blob([new Uint8Array(Math.min(bytes, 100))]);
  Object.defineProperty(blob, 'size', { value: bytes });
  return cache.put({ docId: 1, page: 4, rev: 0, bucket, tile }, { blob, width: 100, height: 100 });
}

const page = () => screen.getByRole('img', { name: 'Page 5 of 12' });
const images = () => [...page().querySelectorAll('img')];

beforeEach(() => {
  vi.useFakeTimers();
  useUi.setState({ banner: null });
});

afterEach(() => {
  clearRenderFailure();
  vi.useRealTimers();
});

describe('the placeholder', () => {
  it('is a white page of the size and place its box says, named for assistive technology', () => {
    const { scheduler } = fixture();
    setup(view(scheduler));
    const element = page();
    expect(element.style.left).toBe('20px');
    expect(element.style.top).toBe('340px');
    expect(element.style.width).toBe('816px');
    expect(element.style.height).toBe('1056px');
    for (const className of ['absolute', 'bg-page', 'shadow-floating', 'z-canvas-page']) {
      expect(element.className, className).toContain(className);
    }
    expect(element.getAttribute('data-page')).toBe('5');
    expect(images()).toHaveLength(0);
  });

  it('is named in the language of the UI', () => {
    const { scheduler } = fixture();
    setup(view(scheduler, { pageIndex: 0, pageCount: 3 }));
    expect(screen.getByRole('img', { name: 'Page 1 of 3' })).not.toBeNull();
  });
});

describe('asking for the exact image', () => {
  it('asks at once, for the page at its bucket, when there is nothing to show yet', () => {
    const { scheduler, pending } = fixture();
    setup(view(scheduler, { bucket: 6 }));
    expect(pending).toHaveLength(1);
    expect(pending[0]?.request).toMatchObject({ docId: 1, pageId: 4, bucket: 6, tile: null, priority: 'visible' });
  });

  it('asks with the priority the canvas gave it', () => {
    const { scheduler, pending } = fixture();
    setup(view(scheduler, { priority: 'near' }));
    expect(pending[0]?.request.priority).toBe('near');
  });

  it('shows the image when it arrives, scaled by the browser to the page, and the cache holds it', async () => {
    const { scheduler, pending, cache } = fixture();
    setup(view(scheduler));
    await act(async () => {
      pending[0]?.resolve(frame(865, 1120));
      await Promise.resolve();
    });
    const [img] = images();
    expect(img?.getAttribute('src')).toBe('blob:1');
    expect(img?.getAttribute('alt')).toBe('');
    expect(img?.draggable).toBe(false);
    expect(img?.style.width).toBe('100%');
    expect(img?.style.height).toBe('100%');
    expect(cache.has(imageKey({ docId: 1, page: 4, rev: 0, bucket: 2 }))).toBe(true);
  });

  it('does not ask again for what the cache has', () => {
    const { scheduler, pending, cache } = fixture();
    put(cache, 2);
    setup(view(scheduler));
    vi.advanceTimersByTime(1000);
    expect(pending).toHaveLength(0);
    expect(images()).toHaveLength(1);
  });

  it('asks once while the image is in flight, however often it renders', () => {
    const { scheduler, pending } = fixture();
    const { rerender } = setup(view(scheduler));
    rerender(view(scheduler, { top: 400 }));
    rerender(view(scheduler, { priority: 'near' }));
    expect(pending).toHaveLength(1);
  });
});

describe('the best image meanwhile', () => {
  it('shows a lower resolution one at once while it waits to ask for the sharp one', () => {
    const { scheduler, pending, cache } = fixture();
    put(cache, 0);
    setup(view(scheduler, { bucket: 4 }));
    expect(images()).toHaveLength(1);
    expect(images()[0]?.getAttribute('src')).toBe('blob:1');
    // A zoom passes through several buckets: only the one it stops at is asked for, after the settle time.
    expect(pending).toHaveLength(0);
    vi.advanceTimersByTime(BUCKET_SETTLE_MS - 1);
    expect(pending).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.request.bucket).toBe(4);
  });

  it('asks only for the last bucket of a quick series of zoom steps', () => {
    const { scheduler, pending, cache } = fixture();
    put(cache, 0);
    const { rerender } = setup(view(scheduler, { bucket: 1 }));
    for (const bucket of [2, 3, 4, 5]) {
      vi.advanceTimersByTime(BUCKET_SETTLE_MS / 4);
      rerender(view(scheduler, { bucket }));
    }
    expect(pending).toHaveLength(0);
    vi.advanceTimersByTime(BUCKET_SETTLE_MS);
    expect(pending.map((entry) => entry.request.bucket)).toEqual([5]);
  });

  it('prefers a sharper image to a softer one when it has both', () => {
    const { scheduler, cache } = fixture();
    put(cache, 0);
    put(cache, 8);
    setup(view(scheduler, { bucket: 4 }));
    expect(images()).toHaveLength(1);
    // Bucket 8 is the one that is scaled down; blob:1 is the first URL made, for the one that is shown.
    const shown = cache.peek(imageKey({ docId: 1, page: 4, rev: 0, bucket: 8 }));
    expect(shown && cache.urlOf(shown)).toBe(images()[0]?.getAttribute('src'));
  });

  it('puts the sharp image over the stand-in and drops the stand-in once the browser has decoded it', async () => {
    const { scheduler, pending, cache } = fixture();
    put(cache, 0);
    setup(view(scheduler, { bucket: 4 }));
    vi.advanceTimersByTime(BUCKET_SETTLE_MS);
    await act(async () => {
      pending[0]?.resolve(frame());
      await Promise.resolve();
    });
    // Both are there until the sharp one has loaded: the page is never blank in between.
    expect(images()).toHaveLength(2);
    const [, sharp] = images();
    fireEvent.load(sharp as HTMLImageElement);
    // The sharp image fades in over the stand-in (fast); the stand-in goes when that is done.
    expect(images()).toHaveLength(2);
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(images()).toHaveLength(1);
    expect(images()[0]).toBe(sharp);
  });

  it('fades the first image in over the placeholder once it is decoded, and shows a cached one at once', async () => {
    const { scheduler, pending, cache } = fixture();
    setup(view(scheduler, { pageIndex: 5 }));
    await act(async () => {
      pending[0]?.resolve(frame());
      await Promise.resolve();
    });
    const arrived = screen.getByRole('img', { name: 'Page 6 of 12' }).querySelector('img') as HTMLImageElement;
    expect(arrived.style.opacity).toBe('0');
    expect(arrived.style.transition).toContain('opacity');
    fireEvent.load(arrived);
    expect(arrived.style.opacity).toBe('1');
    // A frame that was in the cache when the page mounted needs no fade.
    put(cache, 2);
    setup(view(scheduler));
    expect(images()[0]?.style.opacity).toBe('1');
    expect(images()[0]?.style.transition).toBe('');
  });

  it('keeps the image it has when the zoom moves on, and asks for the new bucket', async () => {
    const { scheduler, pending } = fixture();
    const { rerender } = setup(view(scheduler, { bucket: 2 }));
    await act(async () => {
      pending[0]?.resolve(frame());
      await Promise.resolve();
    });
    rerender(view(scheduler, { bucket: 6 }));
    expect(images()).toHaveLength(1);
    vi.advanceTimersByTime(BUCKET_SETTLE_MS);
    expect(pending.map((entry) => entry.request.bucket)).toEqual([2, 6]);
  });
});

describe('the cache', () => {
  it('does not evict what a page shows while it is mounted, and may when it is gone', () => {
    const { scheduler, cache } = fixture();
    const mine = put(cache, 2, undefined, 60 * MIB);
    const { unmount } = setup(view(scheduler));
    // Flush the effects that pin.
    act(() => undefined);
    for (let n = 0; n < 4; n += 1) {
      cache.put(
        { docId: 2, page: n, rev: 0, bucket: 2 },
        { blob: Object.defineProperty(new Blob(['x']), 'size', { value: 60 * MIB }), width: 1, height: 1 },
      );
    }
    expect(mine && cache.has(mine.key)).toBe(true);
    unmount();
    cache.put(
      { docId: 2, page: 9, rev: 0, bucket: 2 },
      { blob: Object.defineProperty(new Blob(['x']), 'size', { value: 60 * MIB }), width: 1, height: 1 },
    );
    expect(mine && cache.has(mine.key)).toBe(false);
  });

  it('makes the object URL when the image is first shown, and revokes it when the entry goes', () => {
    const { scheduler, cache, revoked } = fixture();
    put(cache, 2, undefined, 10 * MIB);
    expect(revoked).toEqual([]);
    setup(view(scheduler));
    expect(images()[0]?.getAttribute('src')).toBe('blob:1');
    cache.clear();
    expect(revoked).toEqual(['blob:1']);
  });

  it('shows an image that arrives later from somewhere else (another page asked for it)', () => {
    const { scheduler, cache } = fixture();
    setup(view(scheduler));
    expect(images()).toHaveLength(0);
    act(() => {
      put(cache, 2);
    });
    expect(images()).toHaveLength(1);
  });

  it('stops following the cache when it is unmounted', () => {
    const { scheduler, cache } = fixture();
    const { unmount } = setup(view(scheduler));
    unmount();
    expect(() => put(cache, 2)).not.toThrow();
  });
});

describe('a cache that was emptied under a mounted page (a save loads the file again)', () => {
  it('asks again for the exact image, and a thumbnail that arrives first is only the stand-in', async () => {
    const { scheduler, pending, cache } = fixture();
    put(cache, 2);
    setup(view(scheduler));
    expect(pending).toHaveLength(0);
    await act(async () => {
      cache.dropDocument(1);
      cache.admit(1);
    });
    expect(pending).toHaveLength(1);
    expect(pending[0]?.request).toMatchObject({ pageId: 4, bucket: 2 });
    // The thumbnail of the new file lands first (another bucket of the same page).
    await act(async () => {
      put(cache, -6);
    });
    expect(pending).toHaveLength(1);
    await act(async () => {
      pending[0]?.resolve(frame());
      await Promise.resolve();
    });
    expect(cache.has(imageKey({ docId: 1, page: 4, rev: 0, bucket: 2 }))).toBe(true);
  });
});

describe('a failure', () => {
  it('shows the error in the banner, once for pages that fail alike, and a page that renders afterwards clears it', async () => {
    const { scheduler, pending } = fixture();
    setup(view(scheduler));
    setup(view(scheduler, { pageIndex: 5 }));
    await act(async () => {
      pending[0]?.reject({ code: 'engine_unavailable', key: 'error.engine_unavailable', retryable: false });
      pending[1]?.reject({ code: 'engine_unavailable', key: 'error.engine_unavailable', retryable: false });
      await Promise.resolve();
    });
    const banner = useUi.getState().banner;
    expect(banner).toMatchObject({ code: 'engine_unavailable' });
    setup(view(scheduler, { pageIndex: 6 }));
    await act(async () => {
      pending[2]?.resolve(frame());
      await Promise.resolve();
    });
    expect(useUi.getState().banner).toBeNull();
  });

  it('shows nothing for a request that was cancelled', async () => {
    const { scheduler, pending } = fixture();
    setup(view(scheduler));
    await act(async () => {
      pending[0]?.reject({ code: 'cancelled', key: 'error.cancelled', retryable: false });
      await Promise.resolve();
    });
    expect(useUi.getState().banner).toBeNull();
  });

  it('asks again for an image whose request was withdrawn, so a stand-in of an older revision never stays for good', async () => {
    const { scheduler, pending, cache } = fixture();
    put(cache, 2);
    setup(view(scheduler, { slotRev: 1 }));
    await act(async () => {
      vi.advanceTimersByTime(BUCKET_SETTLE_MS);
    });
    expect(pending).toHaveLength(1);
    await act(async () => {
      pending[0]?.reject({ code: 'cancelled', key: 'error.cancelled', retryable: false });
      await Promise.resolve();
    });
    await act(async () => {
      vi.advanceTimersByTime(RENDER_RETRY_MS);
    });
    expect(pending).toHaveLength(2);
    expect(pending[1]?.request).toMatchObject({ pageId: 4, bucket: 2 });
    await act(async () => {
      pending[1]?.resolve(frame());
      await Promise.resolve();
    });
    expect(cache.has(imageKey({ docId: 1, page: 4, rev: 0, slotRev: 1, bucket: 2 }))).toBe(true);
  });

  it('stops asking after a few withdrawn answers', async () => {
    const { scheduler, pending } = fixture();
    setup(view(scheduler));
    for (let i = 0; i <= RENDER_RETRIES; i += 1) {
      await act(async () => {
        pending[i]?.reject({ code: 'cancelled', key: 'error.cancelled', retryable: false });
        await Promise.resolve();
      });
      await act(async () => {
        vi.advanceTimersByTime(RENDER_RETRY_MS * (i + 1));
      });
    }
    expect(pending).toHaveLength(RENDER_RETRIES + 1);
  });

  it('does not touch an error that has nothing to do with rendering', async () => {
    const { scheduler, pending } = fixture();
    const other = { code: 'not_a_pdf', key: 'error.not_a_pdf', retryable: false } as const;
    useUi.getState().showBanner(other);
    setup(view(scheduler));
    await act(async () => {
      pending[0]?.resolve(frame());
      await Promise.resolve();
    });
    expect(useUi.getState().banner).toBe(other);
  });

  it('does not report a failure of a request it no longer wants', async () => {
    const { scheduler, pending } = fixture();
    const { unmount } = setup(view(scheduler));
    unmount();
    await act(async () => {
      pending[0]?.reject({ code: 'engine_timeout', key: 'error.engine_timeout', retryable: true });
      await Promise.resolve();
    });
    expect(useUi.getState().banner).toBeNull();
  });
});

describe('a page that is too large for one frame at its zoom (tiles)', () => {
  // 612 x 792 pt at bucket 12 is 4896 x 6336 px: 5 x 7 tiles. The page is shown 1224 px wide.
  const TILED = { widthPt: 612, heightPt: 792, bucket: 12, left: 0, top: 0, width: 1224, height: 1584 };
  const plan = planPage(612, 792, 12);

  afterEach(() => publishViewRect({ left: 0, top: 0, right: 0, bottom: 0 }));

  it('asks for the low resolution underlay and only the tiles near the viewport', () => {
    const { scheduler, pending } = fixture();
    // The viewport shows the top left 800 x 600 px of the page, which is 3200 x 2400 px of its bucket.
    publishViewRect({ left: 0, top: 0, right: 800, bottom: 600 });
    setup(view(scheduler, TILED));
    const requests = pending.map((entry) => entry.request);
    const underlay = requests.filter((request) => request.tile === null);
    const tiles = requests.filter((request) => request.tile !== null);
    expect(underlay).toHaveLength(1);
    expect(underlay[0]?.bucket).toBe(plan.underlayBucket);
    expect(tiles.length).toBeGreaterThan(0);
    for (const request of tiles) {
      expect(request.bucket).toBe(12);
      const [column, row] = request.tile ?? [-1, -1];
      // 3200 x 2400 px plus half a tile of look-ahead: columns up to 3712 / 1024, rows up to 2912 / 1024.
      expect(column).toBeLessThanOrEqual(3);
      expect(row).toBeLessThanOrEqual(2);
    }
    // Not the whole page: 35 tiles would be a lot to render for a screen's worth.
    expect(tiles.length).toBeLessThan(plan.columns * plan.rows);
  });

  it('shows the underlay over the whole page, and each tile where it belongs, as a share of the page', async () => {
    const { scheduler, pending, cache } = fixture();
    publishViewRect({ left: 0, top: 0, right: 100, bottom: 100 });
    setup(view(scheduler, TILED));
    await act(async () => {
      for (const entry of pending) entry.resolve(frame(1024, 1024));
      await Promise.resolve();
    });
    const shown = images();
    // The underlay first, whole, then the tiles.
    expect(shown[0]?.style.width).toBe('100%');
    const tile = images().find((img) => img.style.left === '0%' && img.style.width !== '100%');
    expect(tile?.style.width).toBe(`${(1024 / plan.width) * 100}%`);
    expect(tile?.style.height).toBe(`${(1024 / plan.height) * 100}%`);
    expect(cache.size).toBe(pending.length);
  });

  it('cuts the last tile of a row short at the page edge', async () => {
    const { scheduler, pending } = fixture();
    // The bottom right corner of the page.
    publishViewRect({ left: 1100, top: 1500, right: 1224, bottom: 1584 });
    setup(view(scheduler, TILED));
    await act(async () => {
      for (const entry of pending) entry.resolve(frame(800, 192));
      await Promise.resolve();
    });
    const last = images().find(
      (img) => img.style.left === `${(4096 / plan.width) * 100}%` && img.style.top === `${(6144 / plan.height) * 100}%`,
    );
    expect(last?.style.width).toBe(`${(800 / plan.width) * 100}%`);
    expect(last?.style.top).toBe(`${(6144 / plan.height) * 100}%`);
    expect(last?.style.height).toBe(`${(192 / plan.height) * 100}%`);
  });

  it('follows the viewport: scrolling to another part of the page asks for the tiles there', () => {
    const { scheduler, pending } = fixture();
    publishViewRect({ left: 0, top: 0, right: 800, bottom: 600 });
    setup(view(scheduler, TILED));
    const first = pending.length;
    act(() => publishViewRect({ left: 400, top: 900, right: 1200, bottom: 1500 }));
    const later = pending.slice(first).map((entry) => entry.request.tile);
    expect(later.length).toBeGreaterThan(0);
    // The bottom right of the page is in view now.
    expect(later.some((tile) => tile !== null && tile !== undefined && tile[1] >= 4)).toBe(true);
  });

  it('is not rendered again for a scroll when it is not tiled: nothing about its own tiles changed', () => {
    const { scheduler, cache } = fixture();
    put(cache, 2);
    setup(view(scheduler));
    // `cache.get` is what a render of the page reads its image with: a render shows up as a call.
    const reads = vi.spyOn(cache, 'get');
    act(() => publishViewRect({ left: 0, top: 100, right: 800, bottom: 700 }));
    act(() => publishViewRect({ left: 0, top: 200, right: 800, bottom: 800 }));
    expect(reads).not.toHaveBeenCalled();
    // The probe sees a render when there is one: a page whose own box moved is rendered again.
    reads.mockClear();
    const { rerender } = setup(view(scheduler));
    rerender(view(scheduler, { top: 500 }));
    expect(reads).toHaveBeenCalled();
  });
});

describe('memoization', () => {
  /** A parent that renders again on demand, as the canvas does for any change of its own, and hands the page equal values. */
  function Parent({ scheduler, props }: { scheduler: RenderScheduler; props?: Partial<PageViewProps> }) {
    const [, setTick] = useState(0);
    tick = () => setTick((n) => n + 1);
    // New objects and arrays every render, as a layout produces: only the numbers that go to the page are equal.
    const box = { index: 4, ...BOX };
    const size = [612, 792] as const;
    return (
      <PageView
        docId={1}
        pageIndex={4}
        pageCount={12}
        left={box.left}
        top={box.top}
        width={box.width}
        height={box.height}
        widthPt={size[0]}
        heightPt={size[1]}
        bucket={2}
        priority="visible"
        scheduler={scheduler}
        {...props}
      />
    );
  }
  let tick: () => void = () => undefined;

  it('does not render a page again when its parent renders and the page got the same values', () => {
    const { scheduler, cache } = fixture();
    put(cache, 2);
    setup(<Parent scheduler={scheduler} />);
    act(() => undefined);
    // A render of the page reads its image from the cache (`cache.get`), so the calls count the page's renders.
    const reads = vi.spyOn(cache, 'get');
    for (let n = 0; n < 5; n += 1) act(() => tick());
    expect(reads).not.toHaveBeenCalled();
  });

  it('does render the page again when a value it got changed, so the probe above sees renders', () => {
    const { scheduler, cache } = fixture();
    put(cache, 2);
    const { rerender } = setup(<Parent scheduler={scheduler} />);
    const reads = vi.spyOn(cache, 'get');
    const changes: Partial<PageViewProps>[] = [{ top: BOX.top + 1 }, { widthPt: 200 }, { bucket: 4 }, { left: 0 }];
    for (const change of changes) {
      reads.mockClear();
      rerender(<Parent scheduler={scheduler} props={change} />);
      expect(reads, JSON.stringify(change)).toHaveBeenCalled();
    }
  });
});
