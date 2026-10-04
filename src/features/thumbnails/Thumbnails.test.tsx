// @vitest-environment jsdom
import { act, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RenderFrame } from '../../api/frame';
import type { PageSize, RenderRequest } from '../../api/render';
import { MIN_BUDGET_BYTES, RenderCache } from '../../engine/renderCache';
import { RenderScheduler, type RenderBackend } from '../../engine/renderScheduler';
import { useLocaleStore } from '../../i18n/store';
import { useDocuments } from '../../stores/documents';
import { usePages } from '../../stores/pages';
import { useView } from '../../stores/view';
import { setup } from '../../test/render';
import { useViewer } from '../viewer/useViewer';
import { resetViewer, showDocument, sizes } from '../viewer/viewer.testutil';
import { ThumbnailLayout, thumbnailMetricsFor, type ThumbnailSpacing } from './layout';
import { THUMBNAIL_ASK_DELAY_MS } from './ThumbnailItem';
import { MAX_MOUNTED_THUMBNAILS, ThumbnailList, capRange, Thumbnails, USER_SCROLL_GRACE_MS } from './Thumbnails';

/**
 * How often components render, counted at the one call every cell and the list make on each render: the translator. Each
 * render of a cell or of the list is one call, so a count says how many of them rendered, which is what the tests ask.
 */
const renders = vi.hoisted(() => ({ translator: 0 }));
vi.mock('../../i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../i18n')>();
  return {
    ...actual,
    useT: () => {
      renders.translator += 1;
      return actual.useT();
    },
  };
});

const SPACING: ThumbnailSpacing = { pad: 4, labelGap: 4, labelHeight: 16, gap: 4 };
/** The padding of the scroll region around the cells and of a cell around its thumbnail (`--space-1`). */
const INSET = 4;

const BOOK = { id: 1, pageCount: 500, displayName: 'Book.pdf' };

/** The size the scroll region reports: jsdom has no layout, so the tests say how large it is. */
let region = { width: 232, height: 600 };
const observers = new Set<{ callback: ResizeObserverCallback }>();

class FakeResizeObserver {
  constructor(readonly callback: ResizeObserverCallback) {}
  observe(): void {
    observers.add(this);
    this.callback([], this as unknown as ResizeObserver);
  }
  unobserve(): void {}
  disconnect(): void {
    observers.delete(this);
  }
}

const isRegion = (element: Element) => element.className.includes('overflow-y-auto');

function resizeRegion(next: Partial<typeof region>): void {
  region = { ...region, ...next };
  act(() => {
    for (const observer of observers) observer.callback([], observer as unknown as ResizeObserver);
  });
}

/** The layout of `list` at the width the region above gives it. */
function layoutOf(list: readonly PageSize[], width = region.width) {
  return new ThumbnailLayout(thumbnailMetricsFor(list), width - 2 * INSET - 2 * SPACING.pad, SPACING);
}

interface Pending {
  request: RenderRequest;
  resolve: (frame: RenderFrame) => void;
}

function fixture() {
  const pending: Pending[] = [];
  const backend: RenderBackend = {
    render: (request) =>
      new Promise<RenderFrame>((resolve) => {
        pending.push({ request, resolve });
      }),
    setViewport: () => Promise.resolve(),
  };
  const cache = new RenderCache({ budgetBytes: MIN_BUDGET_BYTES, createUrl: () => 'blob:thumbnail' });
  return { pending, cache, scheduler: new RenderScheduler(cache, backend) };
}

const list = (scheduler: RenderScheduler, pageCount = BOOK.pageCount) => (
  <ThumbnailList docId={1} pageCount={pageCount} scheduler={scheduler} />
);

const listbox = () => screen.getByRole('listbox', { name: 'Page thumbnails' });
const scroller = () => listbox().parentElement as HTMLElement;
const options = () => screen.queryAllByRole('option');
const mounted = () => options().map((element) => Number(element.dataset.index));
const optionOf = (page: number) => screen.getByRole('option', { name: `Page ${page + 1}` });
const tabStops = () => options().filter((element) => element.tabIndex === 0);
const currentPage = () => useView.getState().byDoc[1]?.pageIndex;
const focused = () => (document.activeElement as HTMLElement | null)?.dataset.index;

/** A scroll by the user: the position changes and the event comes, as it does for a wheel, a touch or the scrollbar. */
function userScroll(top: number): void {
  scroller().scrollTop = top;
  fireEvent.scroll(scroller());
}

const press = (key: string, init: KeyboardEventInit = {}) => {
  const target = document.activeElement ?? document.body;
  return fireEvent.keyDown(target, { key, ...init });
};

let clock = 0;

beforeEach(() => {
  region = { width: 232, height: 600 };
  observers.clear();
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return isRegion(this) ? region.width : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return isRegion(this) ? region.height : 0;
    },
  });
  clock = 100_000;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  renders.translator = 0;
  resetViewer();
  showDocument(BOOK);
});

afterEach(() => {
  Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth');
  Reflect.deleteProperty(HTMLElement.prototype, 'clientHeight');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetViewer();
  useLocaleStore.setState({ locale: 'en' });
});

describe('virtualization', () => {
  it('mounts nothing until the region has been measured, and the listbox still stands', () => {
    region = { width: 0, height: 0 };
    const { scheduler } = fixture();
    setup(list(scheduler));
    expect(listbox()).not.toBeNull();
    expect(mounted()).toEqual([]);
  });

  it('mounts only the cells near the viewport of a 500 page document, in a list as tall as all of them', () => {
    const { scheduler } = fixture();
    setup(list(scheduler));
    const layout = layoutOf(sizes(500));
    // The viewport (600 px, from the padding's edge) and half a viewport around it.
    const reach = layout.itemsIn(-INSET - 300, -INSET + 600 + 300);
    expect(reach).not.toBeNull();
    expect(mounted()).toEqual(Array.from({ length: (reach?.last ?? 0) + 1 }, (_, index) => index));
    expect(mounted().length).toBeLessThan(10);
    expect(Number.parseFloat(listbox().style.height)).toBeCloseTo(layout.height + INSET, 3);
  });

  it('mounts the cells around the viewport when the list is scrolled, and lets the ones it left go', () => {
    const { scheduler } = fixture();
    setup(list(scheduler));
    const layout = layoutOf(sizes(500));
    userScroll(layout.top(250) + INSET + 10);
    const now = mounted();
    expect(now).toContain(250);
    expect(now).not.toContain(1);
    expect(now.length).toBeLessThan(10);
    // Page 1, the current page, is the one cell that is mounted away from the viewport: it is the tab stop.
    expect(now.filter((index) => Math.abs(index - 250) > 3)).toEqual([0]);
    userScroll(0);
    expect(mounted()).not.toContain(250);
    expect(mounted()[0]).toBe(0);
  });

  it('mounts at most as many cells as the limit, but never fewer than are in view', () => {
    resizeRegion({ height: 100_000 });
    const { scheduler } = fixture();
    setup(list(scheduler));
    const inView = layoutOf(sizes(500)).itemsIn(0, 100_000);
    expect(inView).not.toBeNull();
    // One DOM query: re-querying per index made this O(n²) and it timed out under a loaded full suite.
    const cells = new Set(mounted());
    expect(cells.size).toBeGreaterThan(MAX_MOUNTED_THUMBNAILS);
    for (let index = inView?.first ?? 0; index <= (inView?.last ?? -1); index += 1) expect(cells.has(index)).toBe(true);
  }, 15_000);

  it('trims the overscan first when over the limit, and keeps every cell in view', () => {
    const cap = MAX_MOUNTED_THUMBNAILS;
    // 40 in view with 40 of overscan on each side: 120 cells, the 40 in view stay and the overscan shares the other 24.
    const trimmed = capRange({ first: 100, last: 219 }, { first: 140, last: 179 });
    expect(trimmed).toEqual({ first: 128, last: 191 });
    // At the start of the list the overscan is all below.
    expect(capRange({ first: 0, last: 119 }, { first: 0, last: 39 })).toEqual({ first: 0, last: cap - 1 });
    // More cells in view than the limit: none of them is cut.
    expect(capRange({ first: 0, last: 199 }, { first: 20, last: 169 })).toEqual({ first: 20, last: 169 });
    // Within the limit nothing changes.
    expect(capRange({ first: 3, last: 20 }, { first: 5, last: 10 })).toEqual({ first: 3, last: 20 });
    expect(capRange(null, null)).toBeNull();
  });

  it('keeps the cells in page order, and puts each where the layout says', () => {
    const { scheduler } = fixture();
    setup(list(scheduler));
    const layout = layoutOf(sizes(500));
    expect(mounted()).toEqual([...mounted()].sort((a, b) => a - b));
    for (const element of options()) {
      const index = Number(element.dataset.index);
      expect(Number.parseFloat(element.style.top)).toBeCloseTo(layout.top(index), 3);
      expect(Number.parseFloat(element.style.height)).toBeCloseTo(layout.cellHeight(index), 3);
    }
  });

  it('has a placeholder of the right shape for every page before any image is there, from the sizes of the pages', () => {
    const mixed: PageSize[] = [
      [612, 792],
      [792, 612],
      [100, 1000],
      [612, 792],
    ];
    showDocument({ id: 1, pageCount: 4, displayName: 'Mixed.pdf' }, { sizes: mixed });
    region = { width: 232, height: 2000 };
    const { scheduler } = fixture();
    setup(list(scheduler, 4));
    const layout = layoutOf(mixed);
    const thumbnail = (page: number) => optionOf(page).firstElementChild as HTMLElement;
    expect(mounted()).toEqual([0, 1, 2, 3]);
    expect(Number.parseFloat(thumbnail(0).style.width)).toBeCloseTo(layout.thumbnailSize(0).width);
    expect(Number.parseFloat(thumbnail(1).style.height)).toBeCloseTo((216 * 612) / 792);
    // The tall page is as tall as the limit allows and narrower than the others.
    expect(Number.parseFloat(thumbnail(2).style.height)).toBeCloseTo(2 * 216);
    expect(Number.parseFloat(thumbnail(2).style.width)).toBeCloseTo(216 / 5);
    expect(thumbnail(3).querySelector('img')).toBeNull();
  });

  it('lays out placeholders of US Letter until the sizes have arrived, and lays out again when they do', () => {
    usePages.getState().remove(1);
    const { scheduler } = fixture();
    setup(list(scheduler, 3));
    const height = (page: number) => Number.parseFloat((optionOf(page).firstElementChild as HTMLElement).style.height);
    expect(height(0)).toBeCloseTo((216 * 792) / 612);
    act(() => usePages.getState().set(1, [[300, 300], ...sizes(2)]));
    expect(height(0)).toBeCloseTo(216);
  });
});

describe('the width of the panel', () => {
  it('is the width of the thumbnails: a wider panel makes them wider and the list longer', () => {
    const { scheduler } = fixture();
    setup(list(scheduler));
    const thumbnailWidth = () => Number.parseFloat((options()[0]?.firstElementChild as HTMLElement).style.width);
    const before = Number.parseFloat(listbox().style.height);
    expect(thumbnailWidth()).toBe(216);
    resizeRegion({ width: 400 });
    expect(thumbnailWidth()).toBe(384);
    expect(Number.parseFloat(listbox().style.height)).toBeGreaterThan(before);
    resizeRegion({ width: 192 });
    expect(thumbnailWidth()).toBe(176);
  });

  it('keeps the cell at the top of the viewport where it is through a change of width', () => {
    const { scheduler } = fixture();
    setup(list(scheduler));
    const narrow = layoutOf(sizes(500));
    userScroll(narrow.top(120) + INSET + 0.5 * narrow.cellHeight(120));
    resizeRegion({ width: 392 });
    const wide = layoutOf(sizes(500), 392);
    const viewTop = scroller().scrollTop - INSET;
    expect(wide.indexAt(viewTop)).toBe(120);
    expect((viewTop - wide.top(120)) / wide.cellHeight(120)).toBeCloseTo(0.5, 1);
  });

  it('does not mistake a change of width for a scroll by the user: the canvas can still move the list', () => {
    const { scheduler } = fixture();
    setup(list(scheduler));
    userScroll(layoutOf(sizes(500)).top(120));
    clock += USER_SCROLL_GRACE_MS + 1;
    resizeRegion({ width: 300 });
    act(() => useView.getState().reportPage(1, 400));
    expect(mounted()).toContain(400);
  });
});

describe('the current page', () => {
  it('is the one selected option, and follows the page of the canvas', () => {
    const { scheduler } = fixture();
    setup(list(scheduler));
    const selected = () => options().filter((element) => element.getAttribute('aria-selected') === 'true');
    expect(selected().map((element) => element.dataset.index)).toEqual(['0']);
    act(() => useView.getState().reportPage(1, 1));
    expect(selected().map((element) => element.dataset.index)).toEqual(['1']);
    expect(optionOf(1).getAttribute('aria-current')).toBe('page');
    act(() => useView.getState().setPage(1, 2));
    expect(selected().map((element) => element.dataset.index)).toEqual(['2']);
  });

  it('is shown when the list opens: a document that was left far down opens with its page in view', () => {
    useView.getState().setPage(1, 300);
    const { scheduler } = fixture();
    setup(list(scheduler));
    const layout = layoutOf(sizes(500));
    expect(mounted()).toContain(300);
    const viewTop = scroller().scrollTop - INSET;
    expect(layout.top(300)).toBeGreaterThanOrEqual(viewTop);
    expect(layout.bottom(300)).toBeLessThanOrEqual(viewTop + region.height);
    expect(tabStops().map((element) => element.dataset.index)).toEqual(['300']);
  });

  it('scrolls into view when the canvas goes to a page that is out of view, and not for one that is in view', () => {
    // 800 px: pages 1 and 2 show whole, page 4 is below.
    region = { width: 232, height: 800 };
    const { scheduler } = fixture();
    setup(list(scheduler));
    const layout = layoutOf(sizes(500));
    act(() => useView.getState().reportPage(1, 1));
    expect(scroller().scrollTop).toBe(0);
    // Page 4 (index 3) is below the viewport: brought in at the bottom edge, as one step of a scroll.
    act(() => useView.getState().reportPage(1, 3));
    const viewTop = scroller().scrollTop - INSET;
    expect(viewTop).toBeGreaterThan(0);
    expect(layout.bottom(3)).toBeLessThanOrEqual(viewTop + region.height + 0.5);
    expect(layout.top(3)).toBeGreaterThanOrEqual(viewTop);
    expect(mounted()).toContain(3);
    // And back: page 1 is above the viewport now.
    act(() => useView.getState().reportPage(1, 0));
    expect(scroller().scrollTop).toBeLessThanOrEqual(INSET);
  });

  it('centers a page that is far away, as a jump to a page does', () => {
    const { scheduler } = fixture();
    setup(list(scheduler));
    const layout = layoutOf(sizes(500));
    act(() => useViewer.getState().goToPage(250));
    const viewTop = scroller().scrollTop - INSET;
    const middle = (layout.top(250) + layout.bottom(250)) / 2;
    expect(viewTop + region.height / 2).toBeCloseTo(middle, 0);
    expect(mounted()).toContain(250);
    expect(tabStops().map((element) => element.dataset.index)).toEqual(['250']);
  });

  it('does not fight the user: while they scroll the list, a page change of the canvas leaves it where it is', () => {
    const { scheduler } = fixture();
    setup(list(scheduler));
    userScroll(5000);
    clock += USER_SCROLL_GRACE_MS - 1;
    act(() => useView.getState().reportPage(1, 100));
    expect(scroller().scrollTop).toBe(5000);
    // Page 101 is mounted to be the tab stop and for nothing else: no neighbours, and the list is where the user left it.
    expect(mounted()).toContain(100);
    expect(mounted()).not.toContain(99);
    expect(mounted()).not.toContain(101);
    // A moment later, the next page change is followed.
    clock += 2;
    act(() => useView.getState().reportPage(1, 101));
    expect(mounted()).toContain(101);
    expect(scroller().scrollTop).not.toBe(5000);
  });

  it('counts only the user scrolling the user does: its own scrolling to follow the canvas does not hold the next one back', () => {
    const { scheduler } = fixture();
    setup(list(scheduler));
    act(() => useView.getState().reportPage(1, 200));
    // The browser reports the scroll the list made itself.
    fireEvent.scroll(scroller());
    const first = scroller().scrollTop;
    expect(mounted()).toContain(200);
    act(() => useView.getState().reportPage(1, 260));
    expect(scroller().scrollTop).not.toBe(first);
    expect(mounted()).toContain(260);
  });

  it('is left alone while the user works in the list with the keyboard', () => {
    const { scheduler } = fixture();
    setup(list(scheduler));
    act(() => optionOf(0).focus());
    press('End');
    const end = scroller().scrollTop;
    act(() => useView.getState().reportPage(1, 50));
    expect(scroller().scrollTop).toBe(end);
  });

  it('does not scroll the list for a click on a thumbnail, which is in view already', () => {
    region = { width: 232, height: 800 };
    const { scheduler } = fixture();
    setup(list(scheduler));
    fireEvent.click(optionOf(1));
    expect(currentPage()).toBe(1);
    expect(scroller().scrollTop).toBe(0);
  });
});

describe('keys', () => {
  it('make the current page the one tab stop while focus is outside the list', () => {
    const { scheduler } = fixture();
    setup(list(scheduler));
    expect(tabStops().map((element) => element.dataset.index)).toEqual(['0']);
    act(() => useView.getState().reportPage(1, 2));
    expect(tabStops().map((element) => element.dataset.index)).toEqual(['2']);
  });

  it('take Tab to the current page, and Tab again out of the list', async () => {
    const { scheduler } = fixture();
    const { user } = setup(
      <>
        <button type="button">before</button>
        {list(scheduler)}
        <button type="button">after</button>
      </>,
    );
    act(() => useView.getState().reportPage(1, 1));
    await user.click(screen.getByRole('button', { name: 'before' }));
    await user.tab();
    expect(document.activeElement).toBe(optionOf(1));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'after' }));
  });

  it('move focus down and up by one cell with the arrows, and stop at the ends', () => {
    const { scheduler } = fixture();
    setup(list(scheduler));
    act(() => optionOf(0).focus());
    expect(press('ArrowUp')).toBe(false);
    expect(focused()).toBe('0');
    expect(press('ArrowDown')).toBe(false);
    expect(focused()).toBe('1');
    press('ArrowDown');
    press('ArrowUp');
    expect(focused()).toBe('1');
    // Moving focus is not going to the page.
    expect(currentPage()).toBe(0);
    for (let step = 0; step < 4; step += 1) press('ArrowUp');
    expect(focused()).toBe('0');
  });

  it('make the cell that has the focus the one tab stop, and give the stop back to the current page when focus leaves', () => {
    const { scheduler } = fixture();
    setup(
      <>
        {list(scheduler)}
        <button type="button">outside</button>
      </>,
    );
    act(() => optionOf(0).focus());
    press('ArrowDown');
    press('ArrowDown');
    expect(tabStops().map((element) => element.dataset.index)).toEqual(['2']);
    act(() => screen.getByRole('button', { name: 'outside' }).focus());
    expect(tabStops().map((element) => element.dataset.index)).toEqual(['0']);
  });

  it('scroll the list to keep the focused cell in view', () => {
    const { scheduler } = fixture();
    setup(list(scheduler));
    const layout = layoutOf(sizes(500));
    act(() => optionOf(0).focus());
    for (let step = 0; step < 6; step += 1) press('ArrowDown');
    expect(focused()).toBe('6');
    const viewTop = scroller().scrollTop - INSET;
    expect(layout.bottom(6)).toBeLessThanOrEqual(viewTop + region.height + 0.5);
    expect(layout.top(6)).toBeGreaterThanOrEqual(viewTop);
    expect(document.activeElement).toBe(optionOf(6));
  });

  it('jump to the first and the last cell with Home and End, also when they are not mounted', () => {
    const { scheduler } = fixture();
    setup(list(scheduler));
    act(() => optionOf(0).focus());
    expect(mounted()).not.toContain(499);
    press('End');
    expect(focused()).toBe('499');
    expect(document.activeElement).toBe(optionOf(499));
    expect(mounted()).toContain(499);
    expect(tabStops().map((element) => element.dataset.index)).toContain('499');
    press('Home');
    expect(focused()).toBe('0');
    expect(scroller().scrollTop).toBeLessThanOrEqual(INSET);
  });

  it('move about a screenful with PageDown and PageUp', () => {
    region = { width: 232, height: 1500 };
    const { scheduler } = fixture();
    setup(list(scheduler));
    const layout = layoutOf(sizes(500));
    act(() => optionOf(0).focus());
    press('PageDown');
    const down = Number(focused());
    expect(down).toBe(layout.pageTarget(0, 1, region.height));
    expect(down).toBeGreaterThan(1);
    press('PageDown');
    expect(Number(focused())).toBeGreaterThan(down);
    press('PageUp');
    expect(focused()).toBe(String(down));
    press('PageUp');
    expect(focused()).toBe('0');
    press('PageUp');
    expect(focused()).toBe('0');
  });

  it('go to the page with Enter and with Space, and with a click; the focus stays in the list', () => {
    const { scheduler } = fixture();
    setup(list(scheduler));
    act(() => optionOf(0).focus());
    press('ArrowDown');
    press('ArrowDown');
    expect(currentPage()).toBe(0);
    expect(press('Enter')).toBe(false);
    expect(currentPage()).toBe(2);
    press('ArrowDown');
    expect(press(' ')).toBe(false);
    expect(currentPage()).toBe(3);
    expect(focused()).toBe('3');
    fireEvent.click(optionOf(1));
    expect(currentPage()).toBe(1);
  });

  it('leave Alt+Up and Alt+Down alone: reserved for moving a thumbnail, they do nothing yet and the browser gets nothing', () => {
    const { scheduler } = fixture();
    setup(list(scheduler));
    act(() => optionOf(0).focus());
    press('ArrowDown');
    expect(press('ArrowDown', { altKey: true })).toBe(false);
    expect(press('ArrowUp', { altKey: true })).toBe(false);
    expect(focused()).toBe('1');
    expect(currentPage()).toBe(0);
    expect(press('Home', { altKey: true })).toBe(true);
    expect(focused()).toBe('1');
  });

  it('leave the shortcuts of the app alone: Ctrl or Cmd with the arrows is the next and previous page, Shift is not ours', () => {
    const { scheduler } = fixture();
    setup(list(scheduler));
    act(() => optionOf(0).focus());
    expect(press('ArrowDown', { ctrlKey: true })).toBe(true);
    expect(press('ArrowDown', { metaKey: true })).toBe(true);
    expect(press('ArrowDown', { shiftKey: true })).toBe(true);
    expect(focused()).toBe('0');
  });

  it('ignore keys that are not theirs', () => {
    const { scheduler } = fixture();
    setup(list(scheduler));
    act(() => optionOf(0).focus());
    expect(press('a')).toBe(true);
    expect(press('Escape')).toBe(true);
    expect(press('Tab')).toBe(true);
    expect(focused()).toBe('0');
  });

  it('keep the tab stop mounted when the list is scrolled far from it, so Tab still finds the list', () => {
    const { scheduler } = fixture();
    setup(list(scheduler));
    act(() => useView.getState().reportPage(1, 2));
    userScroll(layoutOf(sizes(500)).top(300) + INSET);
    expect(mounted()).toContain(2);
    expect(mounted()).toContain(300);
    expect(optionOf(2).tabIndex).toBe(0);
    expect(tabStops()).toHaveLength(1);
  });

  it('keep the cell that has the focus mounted when the list is scrolled away from it', () => {
    const { scheduler } = fixture();
    setup(list(scheduler));
    act(() => optionOf(0).focus());
    press('ArrowDown');
    userScroll(layoutOf(sizes(500)).top(300) + INSET);
    expect(mounted()).toContain(1);
    expect(document.activeElement).toBe(optionOf(1));
  });
});

describe('what renders', () => {
  /** Lets the cells ask for their images and the list settle, so that counting starts from rest. */
  function settle() {
    act(() => void vi.advanceTimersByTime(THUMBNAIL_ASK_DELAY_MS * 2));
  }

  beforeEach(() => {
    vi.useFakeTimers();
    // Tall enough for the first pages to show whole: no page change below needs the list to scroll.
    region = { width: 232, height: 1200 };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('a page change renders the cell that stops being the current page and the one that becomes it, and nothing else', () => {
    const { scheduler, cache } = fixture();
    setup(list(scheduler));
    settle();
    const get = vi.spyOn(cache, 'get');
    const before = renders.translator;
    act(() => useView.getState().reportPage(1, 1));
    // One call of the translator per render: the two cells, and not the list or the cells around.
    expect(renders.translator - before).toBe(2);
    const touched = new Set(get.mock.calls.map(([key]) => key.split(':')[1]));
    expect([...touched].sort()).toEqual(['0', '1']);
    expect(mounted().length).toBeGreaterThan(3);
    // A jump inside what is mounted: the same, for the cells it concerns.
    const again = renders.translator;
    act(() => useView.getState().setPage(1, 3));
    expect(renders.translator - again).toBe(2);
  });

  it('a change of the view that is not a change of page (the position inside a page, a zoom, a fit, a mode) renders nothing', () => {
    const { scheduler } = fixture();
    setup(list(scheduler));
    settle();
    const before = renders.translator;
    act(() => {
      useView.getState().reportPage(1, 0);
      useView.getState().setZoom(1, 2);
      useView.getState().setZoom(1, 1.5);
      useView.getState().setFit(1, 'width', 1.2);
      useView.getState().setScrollMode(1, 'single');
      useView.getState().consumeAnchor(1);
    });
    expect(renders.translator).toBe(before);
  });

  it('a page change that the list does not follow (the user is scrolling it) renders the list for its tab stop and the two cells at most', () => {
    const { scheduler } = fixture();
    setup(list(scheduler));
    settle();
    userScroll(layoutOf(sizes(500)).top(100));
    const before = renders.translator;
    act(() => useView.getState().reportPage(1, 1));
    expect(renders.translator - before).toBeLessThanOrEqual(1 + 2);
    expect(mounted()).toContain(1);
  });

  it('a scroll of the list renders the list and the cells that come into view, and not the ones that stay', () => {
    const { scheduler } = fixture();
    setup(list(scheduler));
    settle();
    const layout = layoutOf(sizes(500));
    // A few pixels: the same cells are mounted, so nothing renders.
    const unchanged = renders.translator;
    userScroll(10);
    userScroll(30);
    expect(renders.translator).toBe(unchanged);
    // About a cell: the cells further down come in. The list renders once, and so does each of them, which is all.
    const before = mounted();
    const count = renders.translator;
    userScroll(layout.top(2) + INSET);
    const added = mounted().filter((index) => !before.includes(index));
    expect(added.length).toBeGreaterThan(0);
    expect(renders.translator - count).toBe(1 + added.length);
  });
});

describe('asking for images', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('asks for the cells in view at the thumbnail priority, and for no others', () => {
    const { scheduler, pending } = fixture();
    setup(list(scheduler));
    act(() => void vi.advanceTimersByTime(THUMBNAIL_ASK_DELAY_MS));
    expect(pending.map(({ request }) => request.pageId).sort((a, b) => a - b)).toEqual(mounted());
    expect(pending.every(({ request }) => request.priority === 'thumbnail')).toBe(true);
    expect(pending.every(({ request }) => request.bucket < 0)).toBe(true);
  });

  it('does not ask for the cells that were scrolled past in a moment', () => {
    const { scheduler, pending } = fixture();
    setup(list(scheduler));
    act(() => void vi.advanceTimersByTime(THUMBNAIL_ASK_DELAY_MS));
    pending.length = 0;
    const layout = layoutOf(sizes(500));
    userScroll(layout.top(100));
    act(() => void vi.advanceTimersByTime(THUMBNAIL_ASK_DELAY_MS / 2));
    userScroll(layout.top(200));
    act(() => void vi.advanceTimersByTime(THUMBNAIL_ASK_DELAY_MS / 2));
    userScroll(layout.top(300));
    act(() => void vi.advanceTimersByTime(THUMBNAIL_ASK_DELAY_MS));
    const asked = pending.map(({ request }) => request.pageId);
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every((page) => page >= 298)).toBe(true);
  });

  it('shows an image that the canvas has rendered in the cache already, without asking for one of its own at that bucket', () => {
    const { scheduler, cache, pending } = fixture();
    setup(list(scheduler));
    act(() => void vi.advanceTimersByTime(THUMBNAIL_ASK_DELAY_MS));
    const asked = pending.find(({ request }) => request.pageId === 1)?.request;
    expect(asked).toBeDefined();
    pending.length = 0;
    act(() => {
      cache.put(
        { docId: 1, page: 1, rev: 0, bucket: asked?.bucket ?? 0 },
        { blob: new Blob([new Uint8Array([1])]), width: 10, height: 10 },
      );
    });
    expect(optionOf(1).querySelector('img')).not.toBeNull();
    act(() => void vi.advanceTimersByTime(THUMBNAIL_ASK_DELAY_MS * 3));
    expect(pending.filter(({ request }) => request.pageId === 1)).toHaveLength(0);
  });
});

describe('the tab', () => {
  it('says what will appear there while no document is open', () => {
    useDocuments.setState({ byId: {}, order: [], activeId: null });
    setup(<Thumbnails />);
    expect(screen.getByText('Page thumbnails appear here.')).not.toBeNull();
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('shows the list of the active document, and another one when the active document changes', () => {
    showDocument({ id: 2, pageCount: 3, displayName: 'Other.pdf' });
    useDocuments.getState().setActive(1);
    setup(<Thumbnails />);
    expect(options().length).toBeGreaterThan(0);
    expect(screen.getByRole('option', { name: 'Page 1' }).getAttribute('aria-setsize')).toBe('500');
    userScroll(5000);
    act(() => useDocuments.getState().setActive(2));
    expect(screen.getByRole('option', { name: 'Page 1' }).getAttribute('aria-setsize')).toBe('3');
    expect(options()).toHaveLength(3);
    expect(scroller().scrollTop).toBe(0);
    // Back to the first: its own page and its own scroll position, from the top of the page it was left at.
    act(() => useDocuments.getState().setActive(1));
    expect(screen.getByRole('option', { name: 'Page 1' }).getAttribute('aria-setsize')).toBe('500');
  });

  it('says what will appear there for a document without pages', () => {
    showDocument({ id: 2, pageCount: 0, displayName: 'Empty.pdf' });
    setup(<Thumbnails />);
    expect(screen.getByText('Page thumbnails appear here.')).not.toBeNull();
  });

  it('labels the list and its options in German', () => {
    useLocaleStore.setState({ locale: 'de' });
    setup(<Thumbnails />);
    expect(screen.getByRole('listbox', { name: 'Seitenminiaturen' })).not.toBeNull();
    expect(screen.getByRole('option', { name: 'Seite 3' }).getAttribute('aria-posinset')).toBe('3');
  });
});
