// @vitest-environment jsdom
import { act, fireEvent, screen } from '@testing-library/react';
import { MotionGlobalConfig } from 'motion/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DocumentInfo } from '../../api/documents';
import { bucketFor } from '../../engine/buckets';
import { CSS_PX_PER_PT } from '../../lib/zoom';
import { setup } from '../../test/render';
import { useDocuments } from '../../stores/documents';
import { useView } from '../../stores/view';
import { VIEWPORT_SETTLE_MS, renderScheduler } from '../../engine/renderScheduler';
import { BUCKET_SETTLE_MS } from './PageView';
import { PageLayout, metricsFor, anchorAt } from './layout';
import { beginOpening, isFresh, resetTransition } from './openTransition';
import { ViewerCanvas } from './ViewerCanvas';
import { resetViewer, showDocument, sizes } from './viewer.testutil';
import { useViewer } from './useViewer';
import { usePages } from '../../stores/pages';

const documentsApi = vi.hoisted(() => ({ openDocumentDialog: vi.fn(), closeDocument: vi.fn() }));
const renderApi = vi.hoisted(() => ({ renderPage: vi.fn(), setViewport: vi.fn(), getPageSizes: vi.fn() }));
vi.mock('../../api/documents', () => documentsApi);
vi.mock('../../api/render', () => renderApi);

const BOOK: DocumentInfo = { id: 1, pageCount: 500, displayName: 'Book.pdf' };
const VIEWPORT = { width: 900, height: 700 };
const GAP = 16;
const LETTER_PX = 792 * CSS_PX_PER_PT;
const STRIDE = LETTER_PX + GAP;

const region = () => screen.getByRole('region', { name: 'Document' });
const mountedPages = () =>
  [...document.querySelectorAll<HTMLElement>('[data-page]')].map((el) => Number(el.dataset.page) - 1);
const scrollTo = (top: number, left = 0) => {
  const scroller = region();
  scroller.scrollTop = top;
  scroller.scrollLeft = left;
  fireEvent.scroll(scroller);
};

beforeEach(() => {
  documentsApi.closeDocument.mockReset().mockResolvedValue(undefined);
  renderApi.renderPage.mockReset().mockImplementation(() => new Promise(() => undefined));
  renderApi.setViewport.mockReset().mockResolvedValue(undefined);
  renderApi.getPageSizes.mockReset().mockResolvedValue([]);
  resetViewer();
  URL.createObjectURL = vi.fn(() => 'blob:page');
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  vi.useRealTimers();
  resetViewer();
  vi.unstubAllGlobals();
});

describe('virtualization', () => {
  it('mounts no pages before the canvas has been measured, and the region still stands', () => {
    showDocument(BOOK);
    setup(<ViewerCanvas />);
    expect(region()).not.toBeNull();
    expect(mountedPages()).toEqual([]);
  });

  it('mounts only the pages near the viewport of a 500 page document, at most 24, in a content box as tall as all of them', () => {
    showDocument(BOOK, { viewport: VIEWPORT });
    setup(<ViewerCanvas />);
    const pages = mountedPages();
    expect(pages.length).toBeGreaterThan(0);
    expect(pages.length).toBeLessThanOrEqual(24);
    expect(pages[0]).toBe(0);
    // Page 0 and page 1 are on screen (the viewport is 700 px of a 1056 px page): the visible one, and the near one.
    expect(pages).toEqual([0, 1]);
    const content = region().firstElementChild as HTMLElement;
    expect(Number.parseFloat(content.style.height)).toBeCloseTo(500 * LETTER_PX + 499 * GAP, 3);
    expect(Number.parseFloat(content.style.width)).toBe(VIEWPORT.width);
  });

  it('puts each placeholder where the layout says, from the sizes of the pages', () => {
    const mixed = [...sizes(2), [792, 612] as const, ...sizes(2)];
    showDocument(
      { id: 1, pageCount: 5, displayName: 'Mixed.pdf' },
      { sizes: mixed, viewport: { width: 1400, height: 3000 } },
    );
    setup(<ViewerCanvas />);
    const element = (page: number) => document.querySelector<HTMLElement>(`[data-page="${page + 1}"]`);
    expect(Number.parseFloat(element(2)?.style.width ?? '0')).toBeCloseTo(792 * CSS_PX_PER_PT);
    expect(Number.parseFloat(element(2)?.style.height ?? '0')).toBeCloseTo(612 * CSS_PX_PER_PT);
    expect(Number.parseFloat(element(0)?.style.width ?? '0')).toBeCloseTo(612 * CSS_PX_PER_PT);
    // Centered in a content box as wide as the viewport.
    expect(Number.parseFloat(element(0)?.style.left ?? '0')).toBeCloseTo((1400 - 612 * CSS_PX_PER_PT) / 2);
    expect(Number.parseFloat(element(1)?.style.top ?? '0')).toBeCloseTo(LETTER_PX + GAP);
    expect(Number.parseFloat(element(3)?.style.top ?? '0')).toBeCloseTo(
      2 * (LETTER_PX + GAP) + 612 * CSS_PX_PER_PT + GAP,
    );
  });

  it('lays out placeholders of US Letter until the sizes have arrived, and lays out again when they do', () => {
    showDocument({ id: 1, pageCount: 3, displayName: 'a.pdf' }, { viewport: { width: 1400, height: 3000 } });
    usePages.getState().remove(1);
    setup(<ViewerCanvas />);
    expect(Number.parseFloat(document.querySelector<HTMLElement>('[data-page="1"]')?.style.height ?? '0')).toBeCloseTo(
      LETTER_PX,
    );
    act(() => usePages.getState().set(1, [[300, 300], ...sizes(2)]));
    expect(Number.parseFloat(document.querySelector<HTMLElement>('[data-page="1"]')?.style.height ?? '0')).toBeCloseTo(
      300 * CSS_PX_PER_PT,
    );
  });

  it('mounts the pages around the viewport when it is scrolled, and lets the ones it left go', () => {
    showDocument(BOOK, { viewport: VIEWPORT });
    setup(<ViewerCanvas />);
    scrollTo(250 * STRIDE + 100);
    const pages = mountedPages();
    expect(pages).toContain(250);
    expect(pages.length).toBeLessThanOrEqual(24);
    expect(pages.every((page) => Math.abs(page - 250) <= 2)).toBe(true);
    expect(pages).not.toContain(0);
    scrollTo(0);
    expect(mountedPages()).toEqual([0, 1]);
  });

  it('does not render the pages again for a scroll that leaves the same pages mounted', () => {
    showDocument(BOOK, { viewport: VIEWPORT });
    setup(<ViewerCanvas />);
    const first = document.querySelector('[data-page="1"]');
    scrollTo(20);
    scrollTo(40);
    scrollTo(60);
    expect(document.querySelector('[data-page="1"]')).toBe(first);
  });

  it('is a document without pages: no pages and a message', () => {
    showDocument({ id: 1, pageCount: 0, displayName: 'Empty.pdf' }, { sizes: [], viewport: VIEWPORT });
    setup(<ViewerCanvas />);
    expect(screen.getByText('This document has no pages.')).not.toBeNull();
    expect(mountedPages()).toEqual([]);
  });

  it('shows nothing and asks for nothing when no document is open', () => {
    useViewer.setState({ viewport: VIEWPORT });
    setup(<ViewerCanvas />);
    expect(mountedPages()).toEqual([]);
    expect(renderApi.renderPage).not.toHaveBeenCalled();
  });
});

describe('what the render pipeline is asked for', () => {
  it('asks for the visible pages first and the near ones as such, at the bucket of the zoom on this display', () => {
    vi.stubGlobal('devicePixelRatio', 1);
    showDocument(BOOK, { viewport: VIEWPORT });
    setup(<ViewerCanvas />);
    const requests = renderApi.renderPage.mock.calls.map(([request]) => request);
    expect(requests.map((request) => [request.pageId, request.priority])).toEqual([
      [0, 'visible'],
      [1, 'near'],
    ]);
    for (const request of requests) {
      expect(request).toMatchObject({ docId: 1, bucket: bucketFor(1, 1), tile: null });
    }
  });

  it('tells the backend which pages are on screen and which are close, once the viewport has been still for a moment', () => {
    vi.useFakeTimers();
    showDocument(BOOK, { viewport: VIEWPORT });
    setup(<ViewerCanvas />);
    scrollTo(100 * STRIDE);
    scrollTo(200 * STRIDE);
    expect(renderApi.setViewport).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(VIEWPORT_SETTLE_MS));
    expect(renderApi.setViewport).toHaveBeenCalledTimes(1);
    const [docId, hint] = renderApi.setViewport.mock.calls[0] ?? [];
    expect(docId).toBe(1);
    expect(hint.visible).toContain(200);
    expect(hint.near.length).toBeGreaterThan(0);
    expect(hint.visible.every((page: number) => page >= 199 && page <= 201)).toBe(true);
    expect(hint.generation).toBeGreaterThan(1);
  });

  it('stamps the renders of pages that have just mounted with the generation of the viewport that mounted them, so no older hint can cancel them', () => {
    showDocument(BOOK, { viewport: VIEWPORT });
    setup(<ViewerCanvas />);
    const first = renderApi.renderPage.mock.calls[0]?.[0];
    expect(first?.generation).toBe(renderScheduler.generationOf(1));
    scrollTo(200 * STRIDE);
    const request = renderApi.renderPage.mock.calls.map(([call]) => call).find((call) => call.pageId === 200);
    expect(request?.generation).toBe(renderScheduler.generationOf(1));
    expect(request?.generation).toBeGreaterThan(first?.generation ?? 0);
  });

  it('tells the backend nothing while there is nothing on screen: no size yet, no pages', () => {
    vi.useFakeTimers();
    showDocument(BOOK);
    setup(<ViewerCanvas />);
    act(() => vi.advanceTimersByTime(1000));
    expect(renderApi.setViewport).not.toHaveBeenCalled();
    act(() => useViewer.setState({ viewport: VIEWPORT }));
    act(() => vi.advanceTimersByTime(1000));
    expect(renderApi.setViewport).toHaveBeenCalledTimes(1);
    expect(renderApi.setViewport.mock.calls[0]?.[1]).toMatchObject({ visible: [0], near: [1] });
  });

  it('asks for sharper images when the display has twice the pixels, a zoom more or less, and none when nothing changed', () => {
    vi.useFakeTimers();
    vi.stubGlobal('devicePixelRatio', 1);
    showDocument(BOOK, { viewport: VIEWPORT });
    setup(<ViewerCanvas />);
    const buckets = () => new Set(renderApi.renderPage.mock.calls.map(([request]) => request.bucket));
    expect([...buckets()]).toEqual([bucketFor(1, 1)]);
    // The same zoom again: the pages are not asked for again.
    const calls = renderApi.renderPage.mock.calls.length;
    scrollTo(10);
    expect(renderApi.renderPage.mock.calls.length).toBe(calls);
    act(() => useViewer.getState().zoomStep(1));
    act(() => vi.advanceTimersByTime(200));
    expect(buckets().has(bucketFor(1.1, 1))).toBe(true);
  });
});

describe('a display with another pixel ratio (a window moved to another monitor)', () => {
  /** A matchMedia that a test can fire: it holds the listeners of every `(resolution: Ndppx)` query. */
  function fakeMatchMedia() {
    const listeners = new Set<() => void>();
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: false,
      media: query,
      addEventListener: (_: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
    }));
    return { change: () => [...listeners].forEach((listener) => listener()), listeners };
  }

  it('renders the pages again at the sharpness the new display can show', () => {
    vi.useFakeTimers();
    vi.stubGlobal('devicePixelRatio', 1);
    const media = fakeMatchMedia();
    showDocument(BOOK, { viewport: VIEWPORT });
    setup(<ViewerCanvas />);
    const first = bucketFor(1, 1);
    expect(renderApi.renderPage.mock.calls.every(([request]) => request.bucket === first)).toBe(true);

    vi.stubGlobal('devicePixelRatio', 2);
    act(() => media.change());
    act(() => vi.advanceTimersByTime(200));
    const second = bucketFor(1, 2);
    expect(second).toBe(first + 4);
    expect(renderApi.renderPage.mock.calls.some(([request]) => request.bucket === second)).toBe(true);
  });

  it('stops listening when the canvas goes away', () => {
    const media = fakeMatchMedia();
    const { unmount } = setup(<ViewerCanvas />);
    expect(media.listeners.size).toBe(1);
    unmount();
    expect(media.listeners.size).toBe(0);
  });
});

describe('the current page follows the scroll position', () => {
  it('is the page most of the viewport is on', () => {
    showDocument(BOOK, { viewport: VIEWPORT });
    setup(<ViewerCanvas />);
    expect(useView.getState().byDoc[1]?.pageIndex).toBe(0);
    scrollTo(30 * STRIDE);
    expect(useView.getState().byDoc[1]?.pageIndex).toBe(30);
    scrollTo(30 * STRIDE + LETTER_PX - 100);
    expect(useView.getState().byDoc[1]?.pageIndex).toBe(31);
    scrollTo(0);
    expect(useView.getState().byDoc[1]?.pageIndex).toBe(0);
  });

  it('is reported without scrolling anything: the anchor is left as it is', () => {
    showDocument(BOOK, { viewport: VIEWPORT });
    setup(<ViewerCanvas />);
    scrollTo(5 * STRIDE);
    expect(useView.getState().byDoc[1]?.anchor).toBeNull();
  });
});

describe('the current page at the ends of the document', () => {
  it('is the last page when the document is scrolled to its end, and the first when it is scrolled back', () => {
    showDocument(BOOK, { viewport: VIEWPORT });
    setup(<ViewerCanvas />);
    const content = region().firstElementChild as HTMLElement;
    const end = Number.parseFloat(content.style.height) - VIEWPORT.height;
    scrollTo(end);
    expect(useView.getState().byDoc[1]?.pageIndex).toBe(499);
    scrollTo(end - STRIDE);
    expect(useView.getState().byDoc[1]?.pageIndex).toBe(498);
    scrollTo(0);
    expect(useView.getState().byDoc[1]?.pageIndex).toBe(0);
  });

  it('stays on page 1 for a document of one page, whatever the scroll', () => {
    showDocument({ id: 1, pageCount: 1, displayName: 'One.pdf' }, { viewport: VIEWPORT });
    setup(<ViewerCanvas />);
    for (const top of [0, 300, 5000]) {
      scrollTo(top);
      expect(useView.getState().byDoc[1]?.pageIndex).toBe(0);
    }
  });

  it('is the page that is shown in the paged modes, and does not move with a scroll inside it', () => {
    showDocument({ id: 1, pageCount: 6, displayName: 'Six.pdf' }, { viewport: VIEWPORT });
    setup(<ViewerCanvas />);
    act(() => useViewer.getState().goToPage(3));
    act(() => useViewer.getState().setScrollMode('single'));
    scrollTo(400);
    expect(useView.getState().byDoc[1]?.pageIndex).toBe(3);
    scrollTo(0);
    expect(useView.getState().byDoc[1]?.pageIndex).toBe(3);
  });
});

describe('a spread of an odd number of pages, and of one page', () => {
  const WIDE = { width: 2400, height: 1200 };

  it('turns to the last page alone, and from there neither forward nor back to a half pair', () => {
    showDocument({ id: 1, pageCount: 5, displayName: 'Five.pdf' }, { viewport: WIDE });
    setup(<ViewerCanvas />);
    act(() => useViewer.getState().setScrollMode('spread'));
    expect(mountedPages()).toEqual([0, 1]);
    act(() => useViewer.getState().nextPage());
    expect(mountedPages()).toEqual([2, 3]);
    act(() => useViewer.getState().nextPage());
    // The fifth page has no partner: it is shown alone, centered, with the status bar on it.
    expect(mountedPages()).toEqual([4]);
    expect(useView.getState().byDoc[1]?.pageIndex).toBe(4);
    const lone = document.querySelector<HTMLElement>('[data-page="5"]');
    expect(Number.parseFloat(lone?.style.left ?? '0')).toBeCloseTo((WIDE.width - 612 * CSS_PX_PER_PT) / 2);
    act(() => useViewer.getState().nextPage());
    expect(mountedPages()).toEqual([4]);
    expect(useView.getState().byDoc[1]?.pageIndex).toBe(4);
    act(() => useViewer.getState().previousPage());
    expect(mountedPages()).toEqual([2, 3]);
  });

  it('shows the one page of a one page document, and turning goes nowhere', () => {
    showDocument({ id: 1, pageCount: 1, displayName: 'One.pdf' }, { viewport: WIDE });
    setup(<ViewerCanvas />);
    act(() => useViewer.getState().setScrollMode('spread'));
    expect(mountedPages()).toEqual([0]);
    act(() => useViewer.getState().nextPage());
    expect(mountedPages()).toEqual([0]);
    act(() => useViewer.getState().previousPage());
    expect(mountedPages()).toEqual([0]);
    expect(useView.getState().byDoc[1]).toMatchObject({ pageIndex: 0, scrollMode: 'spread' });
    // Nothing is rendered ahead: there is no other page.
    expect(new Set(renderApi.renderPage.mock.calls.map(([request]) => request.pageId))).toEqual(new Set([0]));
  });

  it('fits the lone page on its own width, not as half of a pair', () => {
    showDocument({ id: 1, pageCount: 1, displayName: 'One.pdf' }, { viewport: { width: 816 + 16, height: 5000 } });
    setup(<ViewerCanvas />);
    act(() => useViewer.getState().setScrollMode('spread'));
    act(() => useViewer.getState().fitWidth());
    expect(useView.getState().byDoc[1]?.zoom).toBeCloseTo(1);
  });
});

describe('going to a page', () => {
  it('scrolls the page to the top of the viewport and keeps it the current page, also the last one', () => {
    showDocument(BOOK, { viewport: VIEWPORT });
    setup(<ViewerCanvas />);
    act(() => useViewer.getState().goToPage(120));
    expect(region().scrollTop).toBeCloseTo(120 * STRIDE);
    expect(useView.getState().byDoc[1]?.pageIndex).toBe(120);
    expect(useView.getState().byDoc[1]?.anchor).toBeNull();
    expect(mountedPages()).toContain(120);
    // The last page cannot be scrolled to the top of the viewport; it is still the one the status bar shows.
    act(() => useViewer.getState().goToPage(499));
    expect(useView.getState().byDoc[1]?.pageIndex).toBe(499);
    fireEvent.scroll(region());
    expect(useView.getState().byDoc[1]?.pageIndex).toBe(499);
  });

  it('is the one the user scrolled to only until they scroll away from it', () => {
    showDocument(BOOK, { viewport: VIEWPORT });
    setup(<ViewerCanvas />);
    act(() => useViewer.getState().goToPage(499));
    scrollTo(498 * STRIDE);
    expect(useView.getState().byDoc[1]?.pageIndex).toBe(498);
  });

  it('keeps the horizontal scroll', () => {
    showDocument(BOOK, { viewport: { width: 400, height: 700 } });
    setup(<ViewerCanvas />);
    scrollTo(0, 120);
    act(() => useViewer.getState().goToPage(10));
    expect(region().scrollLeft).toBeCloseTo(120);
  });
});

describe('zoom keeps the point the user is looking at where it is', () => {
  /** The document point at the middle of the viewport, as page and offset in points. */
  function middle() {
    const view = useView.getState().byDoc[1];
    const sizesOfDoc = usePages.getState().byDoc[1] ?? [];
    const layout = new PageLayout(metricsFor(sizesOfDoc, view?.scrollMode ?? 'continuous'), {
      zoom: view?.zoom ?? 1,
      gap: GAP,
      viewport: VIEWPORT,
      current: view?.pageIndex ?? 0,
    });
    return anchorAt(
      layout,
      { left: region().scrollLeft, top: region().scrollTop },
      VIEWPORT.width / 2,
      VIEWPORT.height / 2,
    );
  }

  it('by the zoom buttons and keys, around the middle of the viewport', () => {
    showDocument(BOOK, { viewport: VIEWPORT });
    setup(<ViewerCanvas />);
    scrollTo(40 * STRIDE + 300);
    const before = middle();
    expect(before?.page).toBe(40);
    for (const direction of [1, 1, 1, -1, -1, -1, -1] as const) {
      act(() => useViewer.getState().zoomStep(direction));
      const after = middle();
      expect(after?.page).toBe(before?.page);
      expect(after?.yPt).toBeCloseTo(before?.yPt ?? -1, 3);
    }
    expect(useView.getState().byDoc[1]?.anchor).toBeNull();
  });

  it('by the wheel, around the pointer', () => {
    showDocument(BOOK, { viewport: VIEWPORT });
    const { container } = setup(<ViewerCanvas />);
    scrollTo(60 * STRIDE + 200);
    const content = container.querySelector('[role="region"] > div') as HTMLElement;
    // The region is at (0, 0) with 24 px of padding; the content moves with the scroll.
    vi.spyOn(content, 'getBoundingClientRect').mockImplementation(
      () => ({ left: 24 - region().scrollLeft, top: 24 - region().scrollTop }) as DOMRect,
    );
    const pointer = { x: 450, y: 120 };
    const layoutBefore = new PageLayout(metricsFor(usePages.getState().byDoc[1] ?? [], 'continuous'), {
      zoom: 1,
      gap: GAP,
      viewport: VIEWPORT,
      current: 0,
    });
    // The pointer is at client (474, 144): (450, 120) in the content box of the region.
    const under = anchorAt(layoutBefore, { left: 0, top: region().scrollTop }, pointer.x, pointer.y);
    act(() => {
      region().dispatchEvent(
        new WheelEvent('wheel', {
          deltaY: -120,
          ctrlKey: true,
          clientX: 474,
          clientY: 144,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    const zoom = useView.getState().byDoc[1]?.zoom ?? 1;
    expect(zoom).toBeGreaterThan(1);
    const layoutAfter = new PageLayout(metricsFor(usePages.getState().byDoc[1] ?? [], 'continuous'), {
      zoom,
      gap: GAP,
      viewport: VIEWPORT,
      current: 0,
    });
    const now = anchorAt(layoutAfter, { left: region().scrollLeft, top: region().scrollTop }, pointer.x, pointer.y);
    expect(now?.page).toBe(under?.page);
    expect(now?.yPt).toBeCloseTo(under?.yPt ?? -1, 2);
    expect(now?.xPt).toBeCloseTo(under?.xPt ?? -1, 2);
  });

  it('after a quick series of zooms before the canvas has laid itself out for the first', () => {
    showDocument(BOOK, { viewport: VIEWPORT });
    setup(<ViewerCanvas />);
    scrollTo(40 * STRIDE + 300);
    const before = middle();
    act(() => {
      useViewer.getState().zoomStep(1);
      useViewer.getState().zoomStep(1);
      useViewer.getState().zoomStep(1);
    });
    const after = middle();
    expect(after?.page).toBe(before?.page);
    expect(after?.yPt).toBeCloseTo(before?.yPt ?? -1, 3);
  });
});

describe('the scroll modes', () => {
  it('single page: one page at a time, the current one, centered; the neighbours are rendered ahead', () => {
    vi.useFakeTimers();
    showDocument(BOOK, { viewport: VIEWPORT });
    setup(<ViewerCanvas />);
    act(() => useViewer.getState().goToPage(10));
    act(() => useViewer.getState().setScrollMode('single'));
    expect(mountedPages()).toEqual([10]);
    const content = region().firstElementChild as HTMLElement;
    expect(Number.parseFloat(content.style.height)).toBeGreaterThanOrEqual(VIEWPORT.height);
    // The pages before and after are asked for, so turning the page shows no blank.
    act(() => vi.advanceTimersByTime(BUCKET_SETTLE_MS));
    const asked = new Set(renderApi.renderPage.mock.calls.map(([request]) => request.pageId));
    expect(asked).toContain(9);
    expect(asked).toContain(11);
  });

  describe('the neighbours ahead of a turn of the page', () => {
    /** The requests for the pages next to page 10, which only the canvas asks for in a paged mode (nothing is mounted for them). */
    const neighbours = () =>
      renderApi.renderPage.mock.calls
        .map(([request]) => request)
        .filter((request) => request.pageId === 9 || request.pageId === 11);

    function singlePageAt10() {
      vi.useFakeTimers();
      vi.stubGlobal('devicePixelRatio', 1);
      showDocument(BOOK, { viewport: VIEWPORT });
      setup(<ViewerCanvas />);
      act(() => useViewer.getState().setScrollMode('single'));
      act(() => useViewer.getState().goToPage(10));
      expect(mountedPages()).toEqual([10]);
    }

    it('are asked for after the settle time a page has, not at once', () => {
      singlePageAt10();
      expect(neighbours()).toEqual([]);
      act(() => vi.advanceTimersByTime(BUCKET_SETTLE_MS - 1));
      expect(neighbours()).toEqual([]);
      act(() => vi.advanceTimersByTime(1));
      expect(neighbours().map((request) => [request.pageId, request.priority])).toEqual([
        [9, 'near'],
        [11, 'near'],
      ]);
    });

    it('are asked for at the bucket a series of quick zoom steps ends at, and at none it only passed through', () => {
      singlePageAt10();
      act(() => vi.advanceTimersByTime(BUCKET_SETTLE_MS));
      renderApi.renderPage.mockClear();

      const buckets = new Set<number>();
      for (let step = 0; step < 6; step += 1) {
        act(() => useViewer.getState().zoomStep(1));
        buckets.add(bucketFor(useView.getState().byDoc[1]?.zoom ?? 1, 1));
        act(() => vi.advanceTimersByTime(BUCKET_SETTLE_MS / 4));
      }
      // The steps went through more than one bucket, and none of them has been asked for yet.
      expect(buckets.size).toBeGreaterThan(1);
      expect(neighbours()).toEqual([]);
      act(() => vi.advanceTimersByTime(BUCKET_SETTLE_MS));
      const last = bucketFor(useView.getState().byDoc[1]?.zoom ?? 1, 1);
      expect(neighbours().map((request) => [request.pageId, request.bucket])).toEqual([
        [9, last],
        [11, last],
      ]);
    });

    it('are not asked for after the page was turned away from them before the time was up', () => {
      singlePageAt10();
      renderApi.renderPage.mockClear();
      act(() => useViewer.getState().goToPage(40));
      act(() => vi.advanceTimersByTime(BUCKET_SETTLE_MS));
      expect(neighbours()).toEqual([]);
      expect(renderApi.renderPage.mock.calls.map(([request]) => request.pageId).sort((a, b) => a - b)).toEqual([
        39, 40, 41,
      ]);
    });
  });

  it('turns the page with next and previous, and at the end of the page with the wheel', () => {
    showDocument(BOOK, { viewport: VIEWPORT });
    setup(<ViewerCanvas />);
    act(() => useViewer.getState().setScrollMode('single'));
    act(() => useViewer.getState().nextPage());
    expect(mountedPages()).toEqual([1]);
    act(() => useViewer.getState().previousPage());
    expect(mountedPages()).toEqual([0]);
    // At the start of the first page there is nowhere to go back to.
    act(() => useViewer.getState().previousPage());
    expect(mountedPages()).toEqual([0]);
    act(() => {
      region().dispatchEvent(new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true }));
    });
    expect(mountedPages()).toEqual([1]);
  });

  it('two pages: the pair side by side, and a turn goes two pages on', () => {
    showDocument(BOOK, { viewport: { width: 2400, height: 1200 } });
    setup(<ViewerCanvas />);
    act(() => useViewer.getState().setScrollMode('spread'));
    expect(mountedPages()).toEqual([0, 1]);
    const left = document.querySelector<HTMLElement>('[data-page="1"]');
    const right = document.querySelector<HTMLElement>('[data-page="2"]');
    expect(Number.parseFloat(right?.style.left ?? '0')).toBeCloseTo(
      Number.parseFloat(left?.style.left ?? '0') + 612 * CSS_PX_PER_PT + GAP,
    );
    expect(left?.style.top).toBe(right?.style.top);
    act(() => useViewer.getState().nextPage());
    expect(mountedPages()).toEqual([2, 3]);
    act(() => useViewer.getState().nextPage());
    expect(mountedPages()).toEqual([4, 5]);
    act(() => useViewer.getState().previousPage());
    expect(mountedPages()).toEqual([2, 3]);
  });

  it('back to continuous scrolling puts the current page at the top again', () => {
    showDocument(BOOK, { viewport: VIEWPORT });
    setup(<ViewerCanvas />);
    act(() => useViewer.getState().goToPage(20));
    act(() => useViewer.getState().setScrollMode('single'));
    expect(mountedPages()).toEqual([20]);
    act(() => useViewer.getState().setScrollMode('continuous'));
    expect(region().scrollTop).toBeCloseTo(20 * STRIDE);
    expect(useView.getState().byDoc[1]?.pageIndex).toBe(20);
    expect(mountedPages()).toContain(20);
    expect(mountedPages().length).toBeGreaterThan(1);
  });

  it('is kept for each document on its own', () => {
    showDocument(BOOK, { viewport: VIEWPORT });
    showDocument({ id: 2, pageCount: 3, displayName: 'b.pdf' }, { viewport: VIEWPORT });
    setup(<ViewerCanvas />);
    act(() => useViewer.getState().setScrollMode('single'));
    expect(useView.getState().byDoc[2]?.scrollMode).toBe('single');
    expect(useView.getState().byDoc[1]?.scrollMode).toBe('continuous');
    act(() => useDocuments.getState().setActive(1));
    expect(mountedPages().length).toBeGreaterThan(1);
  });
});

describe('closing and switching documents', () => {
  it('shows another document from its own place, not from where the last one was scrolled to', () => {
    showDocument(BOOK, { viewport: VIEWPORT });
    setup(<ViewerCanvas />);
    scrollTo(300 * STRIDE);
    expect(useView.getState().byDoc[1]?.pageIndex).toBe(300);
    // A new document opens: it starts at its first page although the region is scrolled far down.
    act(() => showDocument({ id: 2, pageCount: 400, displayName: 'b.pdf' }, { viewport: VIEWPORT }));
    expect(region().scrollTop).toBe(0);
    expect(useView.getState().byDoc[2]?.pageIndex).toBe(0);
    expect(mountedPages()).toEqual([0, 1]);
    // Going back to the first brings it forward at the page it was left at.
    act(() => useDocuments.getState().setActive(1));
    expect(region().scrollTop).toBeCloseTo(300 * STRIDE);
    expect(useView.getState().byDoc[1]?.pageIndex).toBe(300);
    expect(mountedPages()).toContain(300);
  });

  it('drops the pages of a document that is closed, and shows the one that comes forward', () => {
    const tall = { width: 900, height: 3300 };
    showDocument(BOOK, { viewport: tall });
    showDocument({ id: 2, pageCount: 3, displayName: 'b.pdf' }, { viewport: tall });
    setup(<ViewerCanvas />);
    expect(mountedPages()).toEqual([0, 1, 2]);
    act(() => useViewer.getState().close());
    expect(useDocuments.getState().activeId).toBe(1);
    expect(mountedPages().length).toBeGreaterThan(3);
    act(() => useViewer.getState().close());
    expect(mountedPages()).toEqual([]);
  });
});

describe('rendering the pages again', () => {
  it('does not render the pages again when the canvas renders for a reason that leaves them alone, and does when a page changed', () => {
    showDocument(BOOK, { viewport: VIEWPORT });
    setup(<ViewerCanvas />);
    expect(mountedPages()).toEqual([0, 1]);
    // A page reads its image from the cache whenever it renders, so the calls count the pages' renders.
    const reads = vi.spyOn(renderScheduler.cache, 'get');
    try {
      // The canvas renders when the "rendering" flag changes (a frame is on its way, or arrived), which is all the time. The
      // layout objects it builds for the pages are new each time: the pages must not notice.
      act(() => useViewer.setState({ rendering: true }));
      act(() => useViewer.setState({ rendering: false }));
      act(() => useViewer.setState({ rendering: true }));
      expect(reads).not.toHaveBeenCalled();
      // The probe sees renders: a zoom moves and resizes every page.
      act(() => useViewer.getState().zoomStep(1));
      expect(reads).toHaveBeenCalled();
    } finally {
      reads.mockRestore();
    }
  });
});

describe('jumping to a page (MOTION 4.8)', () => {
  const withClientHeight = () =>
    Object.defineProperty(region(), 'clientHeight', { configurable: true, value: VIEWPORT.height });

  it('animates up to two viewports, jumps at once beyond, and a wheel event ends the animation', async () => {
    MotionGlobalConfig.skipAnimations = false;
    try {
      showDocument(BOOK, { viewport: VIEWPORT });
      setup(<ViewerCanvas />);
      withClientHeight();
      // One page is 1072 px away, within two viewports (1400 px): the spring carries it, the scroll has not arrived yet.
      act(() => useViewer.getState().goToPage(1));
      expect(region().scrollTop).toBeLessThan(STRIDE);
      // The user takes over: the animation stops where it is.
      fireEvent.wheel(region());
      const stopped = region().scrollTop;
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 600));
      });
      expect(region().scrollTop).toBe(stopped);
      expect(stopped).toBeLessThan(STRIDE);
      // Twenty pages away is farther than two viewports: at once.
      act(() => useViewer.getState().goToPage(20));
      expect(region().scrollTop).toBeCloseTo(20 * STRIDE);
    } finally {
      MotionGlobalConfig.skipAnimations = true;
    }
  });
});

describe('the opening zoom (MOTION 4.4)', () => {
  it('fits the width of a document that has just opened where that is below 100 %, and leaves 100 % where it is above', () => {
    beginOpening(1);
    showDocument(BOOK, { viewport: { width: 500, height: 700 } });
    setup(<ViewerCanvas />);
    expect(useView.getState().byDoc[1]?.fit).toBe('width');
    expect(isFresh(1)).toBe(false);
    resetTransition();
    resetViewer();
    beginOpening(1);
    showDocument(BOOK, { viewport: { width: 1600, height: 700 } });
    setup(<ViewerCanvas />);
    expect(useView.getState().byDoc[1]?.fit).toBe('none');
    expect(useView.getState().byDoc[1]?.zoom).toBe(1);
  });

  it('settles the opening only after the fit decision, so the readout never shows the pre-fit zoom', () => {
    beginOpening(1);
    showDocument(BOOK, { viewport: { width: 500, height: 700 } });
    useView.getState().open(1, BOOK.pageCount, true);
    const seen: { fit: string; zoom: number; opening: boolean }[] = [];
    const stop = useView.subscribe((state) => {
      const view = state.byDoc[1];
      if (view !== undefined) seen.push({ fit: view.fit, zoom: view.zoom, opening: view.opening });
    });
    setup(<ViewerCanvas />);
    stop();
    // No state is ever settled while it still has the unfitted zoom.
    expect(seen.filter((view) => !view.opening).every((view) => view.fit === 'width')).toBe(true);
    expect(useView.getState().byDoc[1]?.opening).toBe(false);
  });

  it('keeps a background document of a multi-file drop opening until it is activated, then settles it', () => {
    beginOpening(1);
    beginOpening(2);
    showDocument(BOOK, { viewport: { width: 500, height: 700 } });
    showDocument({ id: 2, pageCount: 3, displayName: 'b.pdf' });
    useView.getState().open(1, BOOK.pageCount, true);
    useView.getState().open(2, 3, true);
    setup(<ViewerCanvas />);
    expect(useView.getState().byDoc[2]?.opening).toBe(false);
    expect(useView.getState().byDoc[1]?.opening).toBe(true);
    act(() => useDocuments.getState().setActive(1));
    expect(useView.getState().byDoc[1]?.opening).toBe(false);
  });

  it('opens at fit width where that is below 100 %, and at 100 % with fit none where it is above', () => {
    beginOpening(1);
    showDocument(BOOK, { viewport: { width: 500, height: 700 } });
    setup(<ViewerCanvas />);
    const narrow = useView.getState().byDoc[1];
    expect(narrow?.fit).toBe('width');
    expect(narrow?.zoom).toBeLessThan(1);
    resetTransition();
    resetViewer();
    beginOpening(1);
    showDocument(BOOK, { viewport: { width: 1600, height: 700 } });
    setup(<ViewerCanvas />);
    expect(useView.getState().byDoc[1]).toMatchObject({ fit: 'none', zoom: 1, opening: false });
  });

  it('does not apply the cap to a document that is not opening: a restored zoom stays', () => {
    showDocument(BOOK, { viewport: { width: 1600, height: 700 } });
    useView.getState().setZoom(1, 2.5, null);
    setup(<ViewerCanvas />);
    expect(useView.getState().byDoc[1]?.zoom).toBe(2.5);
  });

  it('is applied only at the opening: a canvas that is resized later does not fit again', () => {
    beginOpening(1);
    showDocument(BOOK, { viewport: { width: 1600, height: 700 } });
    setup(<ViewerCanvas />);
    act(() => useViewer.getState().setViewport({ width: 500, height: 700 }));
    expect(useView.getState().byDoc[1]?.fit).toBe('none');
  });
});

describe('a zoom in flight when the document changes', () => {
  it('is dropped: no commit to the new document, no transform left on the content', async () => {
    showDocument(BOOK, { viewport: VIEWPORT });
    setup(<ViewerCanvas />);
    act(() => useViewer.getState().zoomBy(1.2, { x: 100, y: 100 }));
    const content = document.querySelector<HTMLElement>('[data-canvas-content]');
    expect(content?.style.transform).toContain('scale(');
    act(() => showDocument({ id: 2, pageCount: 3, displayName: 'b.pdf' }, { viewport: VIEWPORT }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    expect(useView.getState().byDoc[2]?.zoom).toBe(1);
    expect(useView.getState().byDoc[1]?.zoom).toBe(1);
    expect(document.querySelector<HTMLElement>('[data-canvas-content]')?.style.transform ?? '').toBe('');
  });
});
