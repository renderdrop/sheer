// @vitest-environment jsdom
import { act, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RenderFrame } from '../../api/frame';
import type { RenderRequest } from '../../api/render';
import { bucketFor } from '../../engine/buckets';
import { MIN_BUDGET_BYTES, RenderCache } from '../../engine/renderCache';
import { RenderScheduler, type RenderBackend } from '../../engine/renderScheduler';
import { CSS_PX_PER_PT } from '../../lib/zoom';
import { useUi } from '../../stores/ui';
import { useView } from '../../stores/view';
import { setup } from '../../test/render';
import { resetViewer, showDocument } from '../viewer/viewer.testutil';
import { THUMBNAIL_ASK_DELAY_MS, ThumbnailItem, type ThumbnailItemProps } from './ThumbnailItem';

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
  const cache = new RenderCache({ budgetBytes: MIN_BUDGET_BYTES, createUrl: () => `blob:${(urls += 1)}` });
  const scheduler = new RenderScheduler(cache, backend);
  return { pending, cache, scheduler };
}

/** A US Letter page shown 160 px wide: its bucket is the one `bucketFor` gives for that zoom. */
const WIDTH = 160;
const BUCKET = bucketFor(WIDTH / (612 * CSS_PX_PER_PT), 1);

function item(scheduler: RenderScheduler, overrides: Partial<ThumbnailItemProps> = {}) {
  return (
    <ThumbnailItem
      docId={1}
      index={2}
      pageCount={12}
      top={100}
      height={235}
      thumbWidth={WIDTH}
      thumbHeight={207}
      widthPt={612}
      pixelRatio={1}
      active
      focusStop={null}
      onActivate={() => undefined}
      scheduler={scheduler}
      {...overrides}
    />
  );
}

/** Puts an image of `bytes` bytes for page 2 into the cache, as a render would have. */
function put(cache: RenderCache, bucket: number, bytes = 10, page = 2) {
  const blob = new Blob([new Uint8Array(Math.min(bytes, 100))]);
  Object.defineProperty(blob, 'size', { value: bytes });
  return cache.put({ docId: 1, page, rev: 0, bucket }, { blob, width: 100, height: 100 });
}

const option = () => screen.getByRole('option', { name: 'Page 3' });
const images = () => [...option().querySelectorAll('img')];

beforeEach(() => {
  vi.useFakeTimers();
  resetViewer();
  showDocument({ id: 1, pageCount: 12, displayName: 'a.pdf' });
  useUi.setState({ banner: null });
});

afterEach(() => {
  vi.useRealTimers();
  resetViewer();
});

describe('the cell', () => {
  it('is an option named for its page, in a set of all the pages, with the page number under the thumbnail', () => {
    const { scheduler } = fixture();
    setup(item(scheduler));
    const cell = option();
    expect(cell.getAttribute('aria-posinset')).toBe('3');
    expect(cell.getAttribute('aria-setsize')).toBe('12');
    expect(cell.textContent).toBe('3');
    expect(cell.style.top).toBe('100px');
    expect(cell.style.height).toBe('235px');
  });

  it('has a placeholder of the size of the page before any image is there', () => {
    const { scheduler } = fixture();
    setup(item(scheduler, { thumbWidth: 120, thumbHeight: 90 }));
    const thumbnail = option().firstElementChild as HTMLElement;
    expect(thumbnail.style.width).toBe('120px');
    expect(thumbnail.style.height).toBe('90px');
    expect(images()).toHaveLength(0);
  });

  it('is named in the language of the interface', async () => {
    const { useLocaleStore } = await import('../../i18n/store');
    useLocaleStore.setState({ locale: 'de' });
    const { scheduler } = fixture();
    setup(item(scheduler));
    expect(screen.getByRole('option', { name: 'Seite 3' })).not.toBeNull();
  });

  it('goes to its page when it is clicked', () => {
    const { scheduler } = fixture();
    const onActivate = vi.fn();
    setup(item(scheduler, { onActivate }));
    fireEvent.click(option());
    expect(onActivate).toHaveBeenCalledExactlyOnceWith(2);
  });
});

describe('the current page', () => {
  it('is selected, with a non-color cue, only while it is the page the view is on', () => {
    const { scheduler } = fixture();
    setup(item(scheduler));
    expect(option().getAttribute('aria-selected')).toBe('false');
    expect(option().hasAttribute('aria-current')).toBe(false);
    expect(option().firstElementChild?.className).not.toContain('outline-accent');
    act(() => useView.getState().setPage(1, 2));
    expect(option().getAttribute('aria-selected')).toBe('true');
    expect(option().getAttribute('aria-current')).toBe('page');
    // The ring around the thumbnail is the cue that does not depend on the color of the fill.
    expect(option().firstElementChild?.className).toContain('outline-accent');
    act(() => useView.getState().setPage(1, 5));
    expect(option().getAttribute('aria-selected')).toBe('false');
  });

  it('is the tab stop while focus is outside the list; inside it the cell the user moved to is', () => {
    const { scheduler } = fixture();
    const { rerender } = setup(item(scheduler));
    expect(option().tabIndex).toBe(-1);
    act(() => useView.getState().setPage(1, 2));
    expect(option().tabIndex).toBe(0);
    rerender(item(scheduler, { focusStop: false }));
    expect(option().tabIndex).toBe(-1);
    rerender(item(scheduler, { focusStop: true }));
    expect(option().tabIndex).toBe(0);
    act(() => useView.getState().setPage(1, 5));
    expect(option().tabIndex).toBe(0);
  });
});

describe('asking for its image', () => {
  it('asks the scheduler at the thumbnail priority, at the bucket that fits its width, once it has been in view for a moment', () => {
    const { scheduler, pending } = fixture();
    setup(item(scheduler));
    expect(pending).toHaveLength(0);
    act(() => void vi.advanceTimersByTime(THUMBNAIL_ASK_DELAY_MS - 1));
    expect(pending).toHaveLength(0);
    act(() => void vi.advanceTimersByTime(1));
    expect(pending).toHaveLength(1);
    expect(pending[0]?.request).toMatchObject({
      docId: 1,
      pageId: 2,
      bucket: BUCKET,
      priority: 'thumbnail',
      tile: null,
    });
    // A thumbnail is a small bucket: far below the 100 % of the canvas (bucket 2).
    expect(BUCKET).toBeLessThan(0);
  });

  it('asks for nothing when it was scrolled past before the moment was over', () => {
    const { scheduler, pending } = fixture();
    const { unmount } = setup(item(scheduler));
    act(() => void vi.advanceTimersByTime(THUMBNAIL_ASK_DELAY_MS - 10));
    unmount();
    act(() => void vi.advanceTimersByTime(1000));
    expect(pending).toHaveLength(0);
  });

  it('asks for nothing while it is not in view (it is only mounted to hold the focus)', () => {
    const { scheduler, pending } = fixture();
    setup(item(scheduler, { active: false }));
    act(() => void vi.advanceTimersByTime(1000));
    expect(pending).toHaveLength(0);
  });

  it('asks for nothing when the cache has the image already, whoever rendered it', () => {
    const { scheduler, cache, pending } = fixture();
    put(cache, BUCKET);
    setup(item(scheduler));
    act(() => void vi.advanceTimersByTime(1000));
    expect(pending).toHaveLength(0);
    expect(images()).toHaveLength(1);
  });

  it('asks again for the bucket it settles at after a change of width, not for the ones it passed through', () => {
    const { scheduler, pending } = fixture();
    const { rerender } = setup(item(scheduler));
    act(() => void vi.advanceTimersByTime(THUMBNAIL_ASK_DELAY_MS));
    expect(pending).toHaveLength(1);
    // A drag of the splitter: three widths in a moment, the last of them another bucket.
    rerender(item(scheduler, { thumbWidth: 200 }));
    act(() => void vi.advanceTimersByTime(THUMBNAIL_ASK_DELAY_MS / 2));
    rerender(item(scheduler, { thumbWidth: 280 }));
    act(() => void vi.advanceTimersByTime(THUMBNAIL_ASK_DELAY_MS / 2));
    rerender(item(scheduler, { thumbWidth: 340 }));
    act(() => void vi.advanceTimersByTime(THUMBNAIL_ASK_DELAY_MS));
    expect(pending).toHaveLength(2);
    expect(pending[1]?.request.bucket).toBe(bucketFor(340 / (612 * CSS_PX_PER_PT), 1));
  });

  it('asks for a sharper bucket on a display with a higher pixel ratio', () => {
    const { scheduler, pending } = fixture();
    setup(item(scheduler, { pixelRatio: 2 }));
    act(() => void vi.advanceTimersByTime(THUMBNAIL_ASK_DELAY_MS));
    expect(pending[0]?.request.bucket).toBe(BUCKET + 4);
  });

  it('shows the image when it arrives, and shows it from the cache the next time', async () => {
    const { scheduler, cache, pending } = fixture();
    const { unmount } = setup(item(scheduler));
    act(() => void vi.advanceTimersByTime(THUMBNAIL_ASK_DELAY_MS));
    expect(images()).toHaveLength(0);
    await act(async () => pending[0]?.resolve(frame()));
    expect(images()).toHaveLength(1);
    expect(images()[0]?.getAttribute('src')).toBe('blob:1');
    expect(images()[0]?.getAttribute('alt')).toBe('');
    expect(cache.has(`1:2:0:${BUCKET}`)).toBe(true);
    unmount();
    setup(item(scheduler));
    expect(images()).toHaveLength(1);
    act(() => void vi.advanceTimersByTime(1000));
    expect(pending).toHaveLength(1);
  });

  it('shows an image of another size meanwhile: the one the canvas rendered for the page', () => {
    const { scheduler, cache, pending } = fixture();
    put(cache, 2);
    setup(item(scheduler));
    expect(images()).toHaveLength(1);
    act(() => void vi.advanceTimersByTime(THUMBNAIL_ASK_DELAY_MS));
    // The right size is still asked for, and replaces it when it comes.
    expect(pending).toHaveLength(1);
  });

  it('shares what is in flight: the canvas asking for the same image meanwhile does not render it twice', async () => {
    const { scheduler, pending } = fixture();
    setup(item(scheduler));
    act(() => void vi.advanceTimersByTime(THUMBNAIL_ASK_DELAY_MS));
    void scheduler.request({ docId: 1, page: 2, rev: 0, bucket: BUCKET }, 'visible');
    expect(pending).toHaveLength(1);
    await act(async () => pending[0]?.resolve(frame()));
  });

  it('says nothing about a render that failed: the thumbnail stays a blank page and no banner appears', async () => {
    const { scheduler, pending } = fixture();
    setup(item(scheduler));
    act(() => void vi.advanceTimersByTime(THUMBNAIL_ASK_DELAY_MS));
    await act(async () => pending[0]?.reject({ code: 'limit_exceeded' }));
    expect(useUi.getState().banner).toBeNull();
    expect(images()).toHaveLength(0);
  });
});

describe('the cache', () => {
  it('keeps the image the cell shows while the cell is there, and lets it go when the cell is', () => {
    const { scheduler, cache } = fixture();
    const shown = put(cache, BUCKET, 5 * MIB);
    expect(shown).not.toBeNull();
    const { unmount } = setup(item(scheduler));
    // Other images overflow the budget: the pinned one stays, the older unpinned ones go.
    const other = put(cache, BUCKET + 1, 5 * MIB, 7);
    put(cache, BUCKET + 2, MIN_BUDGET_BYTES, 8);
    expect(cache.has(shown?.key ?? '')).toBe(true);
    expect(cache.has(other?.key ?? '')).toBe(false);
    unmount();
    put(cache, BUCKET + 3, MIN_BUDGET_BYTES, 9);
    expect(cache.has(shown?.key ?? '')).toBe(false);
  });

  it('withdraws its pin when it is scrolled away with a request in flight, and a late frame holds nothing', async () => {
    const { scheduler, cache, pending } = fixture();
    const shown = put(cache, BUCKET + 1, 5 * MIB);
    const { unmount } = setup(item(scheduler));
    act(() => void vi.advanceTimersByTime(THUMBNAIL_ASK_DELAY_MS));
    expect(pending).toHaveLength(1);
    unmount();
    // Nothing pins the image any more: another one that fills the budget evicts it.
    put(cache, BUCKET + 3, MIN_BUDGET_BYTES, 9);
    expect(cache.has(shown?.key ?? '')).toBe(false);
    await act(async () => pending[0]?.resolve(frame()));
    // The late frame is only a cache entry now; no pin of the gone cell keeps it.
    put(cache, BUCKET + 4, MIN_BUDGET_BYTES, 10);
    expect(cache.has(`1:2:0:${BUCKET}`)).toBe(false);
  });

  it('looks again when the page is rendered by someone else: the version of the page decides', () => {
    const { scheduler, cache } = fixture();
    setup(item(scheduler));
    expect(images()).toHaveLength(0);
    act(() => void put(cache, BUCKET));
    expect(images()).toHaveLength(1);
  });
});

describe('a cell that mounts again (the panel reopened)', () => {
  it('fades in a frame that was never shown, and shows a shown one at once on its first render', () => {
    const { cache, scheduler } = fixture();
    put(cache, BUCKET);
    const first = setup(item(scheduler));
    expect(images()[0]?.className).toContain('opacity-0');
    fireEvent.load(images()[0] as HTMLImageElement);
    expect(images()[0]?.className).not.toContain('opacity-0');
    // Unmounted with the panel, mounted again on reopen: the cached frame is in the first render, with no fade.
    first.unmount();
    setup(item(scheduler));
    expect(images()).toHaveLength(1);
    expect(images()[0]?.className).not.toContain('opacity-0');
    expect(images()[0]?.className).not.toContain('transition-opacity');
  });
});
