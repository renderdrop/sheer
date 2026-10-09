import { describe, expect, it } from 'vitest';

import type { PageSize } from '../../api/render';
import { CSS_PX_PER_PT, FIT_SCROLLBAR_PX, MAX_ZOOM, MIN_ZOOM, floorFit } from '../../lib/zoom';
import {
  EMPTY_WINDOW,
  MAX_MOUNTED_PAGES,
  PageLayout,
  adjacentPages,
  anchorAt,
  buildMetrics,
  centeredScroll,
  centredScrollLeft,
  fitZoomFor,
  isPaged,
  metricsFor,
  pageStep,
  pageTopAnchor,
  pageWindow,
  scrollFor,
  type LayoutInput,
  type ScrollMode,
} from './layout';

const LETTER: PageSize = [612, 792];
const LANDSCAPE: PageSize = [792, 612];
const A5: PageSize = [420, 595];
const GAP = 16;
const VIEWPORT = { width: 900, height: 700 };

const pages = (count: number, size: PageSize = LETTER): PageSize[] => Array.from({ length: count }, () => size);
const layoutOf = (sizes: PageSize[], mode: ScrollMode = 'continuous', overrides: Partial<LayoutInput> = {}) =>
  new PageLayout(buildMetrics(sizes, mode), { zoom: 1, gap: GAP, viewport: VIEWPORT, current: 0, ...overrides });
/** CSS px of `points` at `zoom`. */
const px = (points: number, zoom = 1) => points * CSS_PX_PER_PT * zoom;

describe('modes', () => {
  it('are three, the paged ones are single and spread, and a spread turns two pages', () => {
    expect(isPaged('continuous')).toBe(false);
    expect(isPaged('single')).toBe(true);
    expect(isPaged('spread')).toBe(true);
    expect(pageStep('continuous')).toBe(1);
    expect(pageStep('single')).toBe(1);
    expect(pageStep('spread')).toBe(2);
  });
});

describe('metrics', () => {
  it('have a row per page in continuous mode, with the heights stacked above each row', () => {
    const metrics = buildMetrics([LETTER, LANDSCAPE, A5], 'continuous');
    expect(metrics.rowCount).toBe(3);
    expect([...metrics.rowHeightPt]).toEqual([792, 612, 595]);
    expect([...metrics.rowWidthPt]).toEqual([612, 792, 420]);
    expect([...metrics.rowTopPt]).toEqual([0, 792, 1404, 1999]);
    expect(metrics.widestSinglePt).toBe(792);
    expect(metrics.widestPairPt).toBe(0);
  });

  it('have a row per two pages in spread mode: as wide as both, as tall as the taller', () => {
    const metrics = buildMetrics([LETTER, LANDSCAPE, A5, LETTER, LETTER], 'spread');
    expect(metrics.rowCount).toBe(3);
    expect([...metrics.rowWidthPt]).toEqual([612 + 792, 420 + 612, 612]);
    expect([...metrics.rowHeightPt]).toEqual([792, 792, 792]);
    expect(metrics.widestPairPt).toBe(1404);
    // The last row is one page.
    expect(metrics.widestSinglePt).toBe(612);
  });

  it('are empty for a document without pages', () => {
    const metrics = buildMetrics([], 'continuous');
    expect(metrics.rowCount).toBe(0);
    expect([...metrics.rowTopPt]).toEqual([0]);
  });

  it('are remembered per list of sizes and mode, and not mixed up between them', () => {
    const sizes = pages(3);
    expect(metricsFor(sizes, 'continuous')).toBe(metricsFor(sizes, 'continuous'));
    expect(metricsFor(sizes, 'spread')).not.toBe(metricsFor(sizes, 'continuous'));
    expect(metricsFor(pages(3), 'continuous')).not.toBe(metricsFor(sizes, 'continuous'));
    expect(metricsFor(sizes, 'spread').perRow).toBe(2);
  });
});

describe('the layout of continuous scrolling', () => {
  it('a page less than a pixel wider than the viewport fits it (no horizontal scrollbar), a wider one overflows', () => {
    const fits = layoutOf([LETTER], 'continuous', { viewport: { width: px(612) - 0.5, height: 700 } });
    expect(fits.width).toBe(fits.viewport.width);
    const wider = layoutOf([LETTER], 'continuous', { viewport: { width: px(612) - 3, height: 700 } });
    expect(wider.width).toBeCloseTo(px(612));
  });

  it('stacks the pages with a gap between them and centers them in the content', () => {
    const layout = layoutOf([LETTER, LANDSCAPE, A5], 'continuous', { viewport: { width: 1200, height: 300 } });
    const [first, second, third] = [0, 1, 2].map((page) => layout.box(page));
    expect(first).toMatchObject({ index: 0, top: 0, width: px(612), height: px(792) });
    expect(second?.top).toBeCloseTo(px(792) + GAP);
    expect(third?.top).toBeCloseTo(px(792) + GAP + px(612) + GAP);
    // The content is as wide as the widest page or the viewport; the pages are centered in it.
    expect(layout.width).toBe(1200);
    for (const box of [first, second, third]) expect((box?.left ?? 0) + (box?.width ?? 0) / 2).toBeCloseTo(600);
    expect(layout.height).toBeCloseTo(px(792 + 612 + 595) + 2 * GAP);
  });

  it('is as wide as the widest page when that is wider than the viewport, and scrolls horizontally', () => {
    const layout = layoutOf([LETTER, LANDSCAPE], 'continuous', { zoom: 2, viewport: { width: 500, height: 500 } });
    expect(layout.width).toBeCloseTo(px(792, 2));
    expect(layout.box(0)?.left).toBeCloseTo((px(792, 2) - px(612, 2)) / 2);
    expect(layout.box(1)?.left).toBe(0);
  });

  it('is never smaller than the viewport, and centers what is shorter than it', () => {
    const layout = layoutOf(pages(1), 'continuous', { zoom: 0.25, viewport: { width: 900, height: 700 } });
    expect(layout.width).toBe(900);
    expect(layout.height).toBe(700);
    const box = layout.box(0);
    expect(box?.top).toBeCloseTo((700 - px(792, 0.25)) / 2);
    expect(box?.left).toBeCloseTo((900 - px(612, 0.25)) / 2);
  });

  it('scales with the zoom, but not the gap', () => {
    const a = layoutOf(pages(3), 'continuous', { zoom: 1 });
    const b = layoutOf(pages(3), 'continuous', { zoom: 2 });
    const step = (layout: PageLayout) => (layout.box(1)?.top ?? 0) - (layout.box(0)?.top ?? 0);
    expect(step(a)).toBeCloseTo(px(792) + GAP);
    expect(step(b)).toBeCloseTo(px(792, 2) + GAP);
  });

  it('puts every page of a long document where its height says, found by a search and not by walking', () => {
    const layout = layoutOf(pages(500), 'continuous');
    expect(layout.pageCount).toBe(500);
    expect(layout.box(499)?.top).toBeCloseTo(499 * (px(792) + GAP));
    expect(layout.height).toBeCloseTo(500 * px(792) + 499 * GAP);
    expect(layout.box(500)).toBeNull();
    expect(layout.box(-1)).toBeNull();
    expect(layout.box(1.5)).toBeNull();
  });

  it('has no box and no rows for a document without pages', () => {
    const layout = layoutOf([]);
    expect(layout.isEmpty).toBe(true);
    expect(layout.box(0)).toBeNull();
    expect(layout.pagesIn(0, 1000)).toBeNull();
    expect(layout.width).toBe(VIEWPORT.width);
    expect(layout.height).toBe(VIEWPORT.height);
    expect(pageWindow(layout, 0, 700)).toBe(EMPTY_WINDOW);
    expect(layout.currentPageAt(0, 700)).toBe(0);
  });

  it('progressAt never steps backwards while the position rises, also over mixed page sizes (F20.6)', () => {
    const layout = layoutOf([LETTER, LANDSCAPE, A5, LANDSCAPE, LETTER, A5]);
    let previous = layout.progressAt(0);
    for (let y = 0; y <= layout.height; y += 3) {
      const progress = layout.progressAt(y);
      expect(progress).toBeGreaterThanOrEqual(previous - 1e-9);
      previous = progress;
    }
    expect(previous).toBeGreaterThan(5);
    expect(layoutOf([]).progressAt(10)).toBe(0);
  });

  it('survives hostile input: a zoom or gap that is not a number, a viewport that is negative', () => {
    const layout = layoutOf(pages(2), 'continuous', {
      zoom: Number.NaN,
      gap: Number.NaN,
      viewport: { width: -5, height: -5 },
    });
    expect(Number.isFinite(layout.width) && Number.isFinite(layout.height)).toBe(true);
    expect(layout.box(1)?.top).toBeCloseTo(px(792));
  });
});

describe('a page that fits the canvas', () => {
  it('is centred in it and needs no horizontal scrolling (page plus 2 x 24 padding fits)', () => {
    const viewport = { width: 1005, height: 700 };
    const layout = layoutOf(pages(3), 'continuous', { viewport });
    const box = layout.box(0);
    expect(layout.width).toBe(viewport.width);
    expect(box?.left).toBeCloseTo((viewport.width - px(612)) / 2, 6);
    expect(scrollFor(layout, { page: 0, xPt: 0, yPt: 0, viewX: 0, viewY: 0 }).left).toBe(0);
    expect(centeredScroll(layout).left).toBe(0);
  });
});

describe('the layout of the paged modes', () => {
  it('shows one page in single mode: the current one, and no box for the others', () => {
    const sizes = [LETTER, LANDSCAPE, A5];
    const layout = layoutOf(sizes, 'single', { current: 1, viewport: { width: 1200, height: 900 } });
    expect(layout.box(0)).toBeNull();
    expect(layout.box(2)).toBeNull();
    expect(layout.box(1)).toMatchObject({ width: px(792), height: px(612) });
    expect(layout.firstRow).toBe(1);
    expect(layout.lastRow).toBe(1);
    // The content is that page, or the viewport if that is larger, and the page is centered in it.
    expect(layout.width).toBe(1200);
    expect(layout.height).toBe(900);
    expect((layout.box(1)?.top ?? 0) + px(612) / 2).toBeCloseTo(450);
    expect((layout.box(1)?.left ?? 0) + px(792) / 2).toBeCloseTo(600);
  });

  it('scrolls a page that is larger than the viewport', () => {
    const layout = layoutOf(pages(3), 'single', { zoom: 2, current: 2 });
    expect(layout.box(2)?.top).toBe(0);
    expect(layout.height).toBeCloseTo(px(792, 2));
    expect(layout.width).toBeCloseTo(Math.max(VIEWPORT.width, px(612, 2)));
  });

  it('puts two pages side by side in spread mode, with the gap between them, centered together', () => {
    const layout = layoutOf([LETTER, LANDSCAPE, A5, A5], 'spread', {
      current: 0,
      viewport: { width: 2200, height: 900 },
    });
    const left = layout.box(0);
    const right = layout.box(1);
    expect(left?.left).toBeCloseTo((2200 - (px(612 + 792) + GAP)) / 2);
    expect(right?.left).toBeCloseTo((left?.left ?? 0) + px(612) + GAP);
    // The shorter page is centered against the taller.
    expect((right?.top ?? 0) + px(612) / 2).toBeCloseTo((left?.top ?? 0) + px(792) / 2);
    // Both belong to the same row; the next two are not in the layout.
    expect(layout.rowOf(0)).toBe(layout.rowOf(1));
    expect(layout.box(2)).toBeNull();
  });

  it('shows the pair that the current page is in, whichever of the two it is', () => {
    const sizes = pages(6);
    expect(layoutOf(sizes, 'spread', { current: 2 }).box(3)).not.toBeNull();
    expect(layoutOf(sizes, 'spread', { current: 3 }).box(2)).not.toBeNull();
    expect(layoutOf(sizes, 'spread', { current: 3 }).box(1)).toBeNull();
    expect(layoutOf(sizes, 'spread', { current: 3 }).firstRow).toBe(1);
  });

  it('shows a last page without a partner on its own, centered', () => {
    const layout = layoutOf(pages(5), 'spread', { current: 4, viewport: { width: 1600, height: 900 } });
    expect(layout.box(4)?.left).toBeCloseTo((1600 - px(612)) / 2);
    expect(layout.box(5)).toBeNull();
  });

  it('keeps the current page inside the document', () => {
    const layout = layoutOf(pages(3), 'single', { current: 99 });
    expect(layout.box(2)).not.toBeNull();
    expect(layoutOf(pages(3), 'single', { current: -4 }).box(0)).not.toBeNull();
    expect(layoutOf(pages(3), 'single', { current: Number.NaN }).box(0)).not.toBeNull();
  });
});

describe('the pages in a part of the content (the virtual window)', () => {
  const layout = layoutOf(pages(100), 'continuous');
  const stride = px(792) + GAP;

  it('finds the pages that meet a range, by position', () => {
    expect(layout.pagesIn(0, 100)).toEqual({ first: 0, last: 0 });
    // The first page ends at 792 pt and the second starts one stride (a page and a gap) down.
    expect(layout.pagesIn(px(792) - 1, px(792) + 1)).toEqual({ first: 0, last: 0 });
    expect(layout.pagesIn(px(792), px(792) + GAP)).toBeNull();
    expect(layout.pagesIn(px(792) + 1, stride - 0.5)).toBeNull();
    expect(layout.pagesIn(stride - 1, stride + 1)).toEqual({ first: 1, last: 1 });
    expect(layout.pagesIn(stride, stride + 1)).toEqual({ first: 1, last: 1 });
    expect(layout.pagesIn(10 * stride, 13 * stride)).toEqual({ first: 10, last: 12 });
  });

  it('is empty in the gaps, above the content and below it', () => {
    expect(layout.pagesIn(px(792) + 1, px(792) + GAP - 1)).toBeNull();
    expect(layout.pagesIn(-500, -1)).toBeNull();
    expect(layout.pagesIn(layout.height, layout.height + 500)).toBeNull();
    expect(layout.pagesIn(100, 100)).toBeNull();
    expect(layout.pagesIn(200, 100)).toBeNull();
  });

  it('clips to the document', () => {
    expect(layout.pagesIn(-1e6, 1e6)).toEqual({ first: 0, last: 99 });
  });

  it('works for the rows of a spread, naming the pages of every row it touches', () => {
    const spread = layoutOf(pages(10), 'spread', { current: 0 });
    // Paged: one row only, whatever is asked.
    expect(spread.pagesIn(-1e6, 1e6)).toEqual({ first: 0, last: 1 });
  });

  it('finds the nearest row to a position', () => {
    expect(layout.rowAt(-100)).toBe(0);
    expect(layout.rowAt(100)).toBe(0);
    expect(layout.rowAt(px(792) + 1)).toBe(0);
    expect(layout.rowAt(px(792) + GAP - 1)).toBe(1);
    expect(layout.rowAt(5 * stride + 10)).toBe(5);
    expect(layout.rowAt(1e9)).toBe(99);
  });
});

describe('the page window to mount', () => {
  const layout = layoutOf(pages(500), 'continuous');
  const stride = px(792) + GAP;

  it('is the pages that meet the viewport, and the ones within a viewport height around it', () => {
    const top = 100 * stride + 10;
    const window = pageWindow(layout, top, VIEWPORT.height);
    // The viewport is 700 px of a 1056 px page.
    expect(window.visible).toEqual([100]);
    // A page counts if any of it is within 700 px above or below (the stride is 1072 px).
    expect(window.near).toEqual([99, 101]);
  });

  it('never mounts more than 24 pages, however tall the viewport', () => {
    for (const height of [700, 3000, 20_000, 200_000]) {
      for (const top of [0, 50 * stride, 400 * stride]) {
        const window = pageWindow(layout, top, height);
        expect(window.visible.length + window.near.length, `${height} at ${top}`).toBeLessThanOrEqual(
          MAX_MOUNTED_PAGES,
        );
      }
    }
    // A viewport that shows more than 24 pages at once mounts the first 24 of them.
    const tall = pageWindow(layout, 0, 40 * stride);
    expect(tall.visible).toHaveLength(MAX_MOUNTED_PAGES);
    expect(tall.visible[0]).toBe(0);
    expect(tall.near).toEqual([]);
  });

  it('fills what is left of the 24 with the nearest pages, alternating above and below, in page order', () => {
    // 1 visible page, a viewport that reaches 10 pages up and down: 23 near pages, 12 below and 11 above or the other way.
    const window = pageWindow(layout, 250 * stride, 1);
    expect(window.visible).toEqual([250]);
    expect(window.near.length).toBeLessThanOrEqual(23);
    expect([...window.near].sort((a, b) => a - b)).toEqual(window.near);
    const tiny = layoutOf(
      pages(500).map(() => [10, 10] as PageSize),
      'continuous',
      { zoom: 0.25 },
    );
    const small = pageWindow(tiny, 300 * (px(10, 0.25) + GAP), 2000);
    expect(small.visible.length + small.near.length).toBe(MAX_MOUNTED_PAGES);
    // Nearest first: the near pages sit on both sides of the visible ones, evenly.
    const above = small.near.filter((page) => page < (small.visible[0] ?? 0));
    const below = small.near.filter((page) => page > (small.visible.at(-1) ?? 0));
    expect(Math.abs(above.length - below.length)).toBeLessThanOrEqual(1);
  });

  it('stays inside the document at its top and its bottom', () => {
    const top = pageWindow(layout, 0, VIEWPORT.height);
    expect(Math.min(...top.visible, ...top.near)).toBe(0);
    const bottom = pageWindow(layout, layout.height - VIEWPORT.height, VIEWPORT.height);
    expect(Math.max(...bottom.visible, ...bottom.near)).toBe(499);
  });

  it('in a paged mode is the shown page and nothing around it', () => {
    const single = layoutOf(pages(10), 'single', { current: 4 });
    expect(pageWindow(single, 0, VIEWPORT.height)).toEqual({ visible: [4], near: [] });
    const spread = layoutOf(pages(10), 'spread', { current: 4 });
    expect(pageWindow(spread, 0, VIEWPORT.height)).toEqual({ visible: [4, 5], near: [] });
    // The rows next to it are prefetched instead.
    expect(adjacentPages(single)).toEqual([3, 5]);
    expect(adjacentPages(spread)).toEqual([2, 3, 6, 7]);
    expect(adjacentPages(layoutOf(pages(10), 'single', { current: 0 }))).toEqual([1]);
    expect(adjacentPages(layoutOf(pages(5), 'spread', { current: 4 }))).toEqual([2, 3]);
    expect(adjacentPages(layout)).toEqual([]);
  });

  it('is cheap for a long document: a layout and a window are built from a few searches', () => {
    const big = layoutOf(pages(50_000), 'continuous');
    const started = performance.now();
    for (let n = 0; n < 2000; n += 1) pageWindow(big, (n * 7919) % big.height, VIEWPORT.height);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe('the current page of the scroll position', () => {
  const layout = layoutOf(pages(20), 'continuous');
  const stride = px(792) + GAP;

  it('is the page most of the viewport is on', () => {
    expect(layout.currentPageAt(0, 700)).toBe(0);
    // Page 3 fills 3/4 of the viewport and page 4 the rest.
    expect(layout.currentPageAt(3 * stride + (px(792) - 525), 700)).toBe(3);
    // Page 3 has 100 px of the viewport left, page 4 the rest.
    expect(layout.currentPageAt(3 * stride + (px(792) - 100), 700)).toBe(4);
  });

  it('prefers the earlier page when two share the viewport equally', () => {
    const half = 3 * stride + px(792) - 300;
    expect(layout.currentPageAt(half, 600 + GAP)).toBe(3);
  });

  it('is the page at the middle of the viewport when the viewport shows only a gap', () => {
    expect(layout.currentPageAt(px(792) + 1, 10)).toBe(0);
  });

  it('is the first page of the pair in a spread, and the shown page in single mode', () => {
    expect(layoutOf(pages(10), 'spread', { current: 5 }).currentPageAt(0, 700)).toBe(4);
    expect(layoutOf(pages(10), 'single', { current: 5 }).currentPageAt(0, 700)).toBe(5);
  });
});

describe('anchoring: the point under the pointer stays put when the zoom changes', () => {
  /** The document point (page, points) that is at viewport position (x, y) when the content is scrolled to `scroll`. */
  const pointAt = (layout: PageLayout, scroll: { left: number; top: number }, x: number, y: number) => {
    const anchor = anchorAt(layout, scroll, x, y);
    return anchor === null ? null : { page: anchor.page, x: anchor.xPt, y: anchor.yPt };
  };

  /**
   * Anchors the point at (`x`, `y`), changes the zoom and says where the point is: `true` if it is at the same viewport position,
   * `false` if the new scroll position had to be clamped to the content and could not keep it (nothing is checked then).
   */
  const keepsThePoint = (
    sizes: PageSize[],
    mode: ScrollMode,
    zoom: { from: number; to: number },
    viewport: { width: number; height: number },
    current: number,
    scroll: { left: number; top: number },
    at: { x: number; y: number },
  ): boolean => {
    const before = layoutOf(sizes, mode, { zoom: zoom.from, viewport, current });
    const anchor = anchorAt(before, scroll, at.x, at.y);
    if (anchor === null) return false;
    const after = layoutOf(sizes, mode, { zoom: zoom.to, viewport, current });
    const target = scrollFor(after, anchor);
    const box = after.box(anchor.page);
    const wantedLeft = (box?.left ?? 0) + anchor.xPt * after.scale - at.x;
    const wantedTop = (box?.top ?? 0) + anchor.yPt * after.scale - at.y;
    if (Math.abs(wantedLeft - target.left) > 1e-6 || Math.abs(wantedTop - target.top) > 1e-6) return false;
    const found = pointAt(after, target, at.x, at.y);
    expect(found?.page).toBe(anchor.page);
    expect(found?.x).toBeCloseTo(anchor.xPt, 5);
    expect(found?.y).toBeCloseTo(anchor.yPt, 5);
    return true;
  };

  it('puts the same document point at the same viewport position after the zoom', () => {
    const sizes = [LETTER, LANDSCAPE, A5, LETTER, LETTER, LANDSCAPE, A5, LETTER, LETTER, LETTER];
    const cases = [
      [1, 1.5, 450, 350, 3000],
      [1, 2, 100, 600, 5200],
      [1, 0.5, 800, 20, 4000],
      [1, 4, 0, 0, 1000],
      [2, 1.1, 899, 699, 7000],
      [1.25, 1.1, 10, 690, 2000],
    ] as const;
    let kept = 0;
    for (const [from, to, x, y, top] of cases) {
      const scroll = { left: 0, top };
      if (keepsThePoint(sizes, 'continuous', { from, to }, VIEWPORT, 0, scroll, { x, y })) kept += 1;
    }
    expect(kept).toBeGreaterThanOrEqual(3);
  });

  it('keeps the point for every pair of zooms, in all three modes, anywhere in the viewport', () => {
    const sizes = [LETTER, LANDSCAPE, A5, LETTER, LETTER, LANDSCAPE, A5, LETTER];
    let seed = 7;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    let checked = 0;
    for (let trial = 0; trial < 400; trial += 1) {
      const mode: ScrollMode = (['continuous', 'single', 'spread'] as const)[trial % 3] ?? 'continuous';
      const from = MIN_ZOOM + random() * (MAX_ZOOM - MIN_ZOOM);
      const to = MIN_ZOOM + random() * (MAX_ZOOM - MIN_ZOOM);
      const viewport = { width: 400 + Math.floor(random() * 800), height: 300 + Math.floor(random() * 600) };
      const current = Math.floor(random() * sizes.length);
      const before = layoutOf(sizes, mode, { zoom: from, viewport, current });
      const scroll = {
        left: random() * Math.max(0, before.width - viewport.width),
        top: random() * Math.max(0, before.height - viewport.height),
      };
      const x = random() * viewport.width;
      const y = random() * viewport.height;
      const anchor = anchorAt(before, scroll, x, y);
      if (anchor === null) continue;
      const after = layoutOf(sizes, mode, { zoom: to, viewport, current });
      const target = scrollFor(after, anchor);
      // A scroll position that had to be clamped to the new content cannot keep the point.
      const wantedLeft = (after.box(anchor.page)?.left ?? 0) + anchor.xPt * after.scale - x;
      const wantedTop = (after.box(anchor.page)?.top ?? 0) + anchor.yPt * after.scale - y;
      const clamped = Math.abs(wantedLeft - target.left) > 1e-6 || Math.abs(wantedTop - target.top) > 1e-6;
      if (clamped) continue;
      const found = pointAt(after, target, x, y);
      expect(found?.page).toBe(anchor.page);
      expect(found?.x).toBeCloseTo(anchor.xPt, 5);
      expect(found?.y).toBeCloseTo(anchor.yPt, 5);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(80);
  });

  it('keeps the middle of the viewport in place for a zoom by buttons', () => {
    const sizes = pages(50);
    const before = layoutOf(sizes, 'continuous', { zoom: 1 });
    const scroll = { left: 0, top: 20_000 };
    const anchor = anchorAt(before, scroll, VIEWPORT.width / 2, VIEWPORT.height / 2);
    const after = layoutOf(sizes, 'continuous', { zoom: 1.25 });
    const target = scrollFor(after, anchor ?? { page: 0, xPt: 0, yPt: 0, viewX: 0, viewY: 0 });
    const found = pointAt(after, target, VIEWPORT.width / 2, VIEWPORT.height / 2);
    expect(found?.page).toBe(anchor?.page);
    expect(found?.y).toBeCloseTo(anchor?.yPt ?? -1, 6);
  });

  it('holds a point in the gap between two pages', () => {
    const before = layoutOf(pages(5), 'continuous');
    const gapY = px(792) + GAP / 2;
    const anchor = anchorAt(before, { left: 0, top: gapY - 300 }, 450, 300);
    // The nearest page is the first (the point is half a gap below it).
    expect(anchor?.page).toBe(0);
    expect(anchor?.yPt).toBeGreaterThan(792);
    const after = layoutOf(pages(5), 'continuous', { zoom: 1.2 });
    const target = scrollFor(after, anchor ?? { page: 0, xPt: 0, yPt: 0, viewX: 0, viewY: 0 });
    // The point is still in the gap, within the gap's own size of where it was: the gap is the one thing that does not scale.
    const y = target.top + 300;
    expect(y).toBeGreaterThan(px(792, 1.2));
    expect(y).toBeLessThan(px(792, 1.2) + GAP * 1.5);
  });

  it('is on the nearer page horizontally in a spread, and outside the page it is beside', () => {
    const layout = layoutOf(pages(4), 'spread', { current: 0, viewport: { width: 1800, height: 900 } });
    const right = layout.box(1);
    const anchor = anchorAt(layout, { left: 0, top: 0 }, (right?.left ?? 0) + 40, 100);
    expect(anchor?.page).toBe(1);
    expect(anchor?.xPt).toBeCloseTo(40 / layout.scale);
    const far = anchorAt(layout, { left: 0, top: 0 }, 5, 100);
    expect(far?.page).toBe(0);
    expect(far?.xPt).toBeLessThan(0);
  });

  it('is nothing for a layout without pages', () => {
    expect(anchorAt(layoutOf([]), { left: 0, top: 0 }, 10, 10)).toBeNull();
  });

  it('is kept inside what can be scrolled', () => {
    const layout = layoutOf(pages(3), 'continuous', { zoom: 1 });
    const far = { page: 2, xPt: 10_000, yPt: 100_000, viewX: 0, viewY: 0 };
    const target = scrollFor(layout, far);
    expect(target.top).toBeCloseTo(layout.height - VIEWPORT.height);
    expect(target.left).toBe(Math.max(0, layout.width - VIEWPORT.width));
    expect(scrollFor(layout, { page: 0, xPt: -500, yPt: -500, viewX: 0, viewY: 0 })).toEqual({ left: 0, top: 0 });
  });

  it('may scroll into the canvas padding the real scroller has around the content', () => {
    const layout = layoutOf(pages(3), 'continuous', { zoom: 1 });
    const far = { page: 2, xPt: 10_000, yPt: 100_000, viewX: 0, viewY: 0 };
    const plain = scrollFor(layout, far);
    const padded = scrollFor(layout, far, 16);
    expect(padded.left).toBe(plain.left + 32);
    expect(padded.top).toBeCloseTo(plain.top + 32);
    // Content that fits the content box but overflows the padded scroller: 17 is reachable, not clamped to 0.
    const fits = layoutOf(pages(1), 'continuous', { zoom: 0.1 });
    const at17 = { page: 0, xPt: 0, yPt: 0, viewX: -(17 - (fits.box(0)?.left ?? 0)), viewY: 0 };
    expect(scrollFor(fits, at17).left).toBe(0);
    expect(scrollFor(fits, at17, 17).left).toBe(17);
  });

  it('goes to the top of the page for an anchor from a page that is not in the layout', () => {
    const layout = layoutOf(pages(4), 'single', { current: 0 });
    expect(scrollFor(layout, { page: 3, xPt: 5, yPt: 5, viewX: 0, viewY: 0 })).toEqual({ left: 0, top: 0 });
  });
});

describe('going to a page and changing the mode', () => {
  it('puts the top of the page at the top of the viewport and leaves the horizontal scroll alone', () => {
    const layout = layoutOf(pages(30), 'continuous', { zoom: 2, viewport: { width: 500, height: 600 } });
    const scroll = { left: 120, top: 0 };
    const anchor = pageTopAnchor(layout, 17, scroll);
    expect(anchor).not.toBeNull();
    if (anchor === null) return;
    const target = scrollFor(layout, anchor);
    expect(target.top).toBeCloseTo(layout.box(17)?.top ?? -1);
    expect(target.left).toBeCloseTo(120);
  });

  it('is nothing for a page that is not in the layout', () => {
    expect(pageTopAnchor(layoutOf(pages(3), 'single', { current: 0 }), 2, { left: 0, top: 0 })).toBeNull();
    expect(pageTopAnchor(layoutOf(pages(3)), 9, { left: 0, top: 0 })).toBeNull();
  });

  it('shows the same page at the top after a change of mode, in any of the three', () => {
    const sizes = pages(12);
    for (const mode of ['continuous', 'single', 'spread'] as const) {
      const layout = layoutOf(sizes, mode, { current: 7, zoom: 1.5 });
      const anchor = pageTopAnchor(layout, 7, { left: 0, top: 0 });
      expect(anchor).not.toBeNull();
      if (anchor === null) continue;
      const target = scrollFor(layout, anchor);
      const box = layout.box(7);
      // The page is at the top, unless the content is shorter than the viewport and it cannot be scrolled to.
      expect(target.top).toBeCloseTo(Math.min(box?.top ?? 0, Math.max(0, layout.height - VIEWPORT.height)));
    }
  });
});

describe('fit zoom', () => {
  const viewport = { width: 816 + FIT_SCROLLBAR_PX, height: 1056 };

  it('fills the width with the current page, less the scrollbar allowance', () => {
    const metrics = buildMetrics([LETTER, LANDSCAPE], 'continuous');
    expect(fitZoomFor('width', metrics, 0, viewport, GAP)).toBeCloseTo(1);
    // The landscape page is wider, so it needs a smaller zoom.
    expect(fitZoomFor('width', metrics, 1, viewport, GAP)).toBeCloseTo(816 / (792 * CSS_PX_PER_PT));
  });

  it('fits the whole page: the smaller of the width and the height', () => {
    const metrics = buildMetrics([LETTER], 'continuous');
    expect(fitZoomFor('page', metrics, 0, { width: 5000, height: 528 }, GAP)).toBeCloseTo(0.5);
    expect(fitZoomFor('page', metrics, 0, { width: 816, height: 5000 }, GAP)).toBeCloseTo(1);
  });

  it('fits both pages and the gap between them in a spread', () => {
    const metrics = buildMetrics(pages(4), 'spread');
    const zoom = fitZoomFor('page', metrics, 1, { width: 2 * 816 + GAP, height: 5000 }, GAP);
    expect(zoom).toBeCloseTo(1);
    const width = fitZoomFor('width', metrics, 2, { width: 2 * 816 + GAP + FIT_SCROLLBAR_PX, height: 5000 }, GAP);
    expect(width).toBeCloseTo(1);
    // A last page without a partner is fitted on its own.
    const odd = buildMetrics(pages(3), 'spread');
    expect(fitZoomFor('page', odd, 2, { width: 816, height: 5000 }, GAP)).toBeCloseTo(1);
  });

  it('is limited to the zoom range, and nothing until the viewport or the page has a size', () => {
    const metrics = buildMetrics([LETTER], 'continuous');
    expect(fitZoomFor('width', metrics, 0, { width: 100_000, height: 100 }, GAP)).toBe(MAX_ZOOM);
    expect(fitZoomFor('width', metrics, 0, { width: 20, height: 100 }, GAP)).toBe(MIN_ZOOM);
    expect(fitZoomFor('width', metrics, 0, { width: 0, height: 0 }, GAP)).toBeNull();
    expect(fitZoomFor('page', metrics, 0, { width: 800, height: 0 }, GAP)).toBeNull();
    expect(fitZoomFor('width', buildMetrics([], 'continuous'), 0, viewport, GAP)).toBeNull();
  });

  it('takes the page the current page number is in, clamped to the document', () => {
    const metrics = buildMetrics([LETTER, LANDSCAPE], 'continuous');
    expect(fitZoomFor('width', metrics, 99, viewport, GAP)).toBe(fitZoomFor('width', metrics, 1, viewport, GAP));
    expect(fitZoomFor('width', metrics, -3, viewport, GAP)).toBe(fitZoomFor('width', metrics, 0, viewport, GAP));
  });
});
describe('a spread of an odd number of pages, and of a single page', () => {
  it('has a row per two pages, the last one alone when the count is odd, and every page is in exactly one row', () => {
    for (let count = 1; count <= 9; count += 1) {
      const metrics = buildMetrics(pages(count), 'spread');
      expect(metrics.rowCount, `${count} pages`).toBe(Math.ceil(count / 2));
      const seen: number[] = [];
      for (let row = 0; row < metrics.rowCount; row += 1) {
        const layout = layoutOf(pages(count), 'spread', {
          current: row * 2,
          viewport: { width: 2400, height: 1200 },
        });
        expect(layout.firstRow).toBe(row);
        const shown = [...Array(count).keys()].filter((page) => layout.box(page) !== null);
        // Two pages, or the one page that has no partner, and only in the last row.
        expect(shown, `${count} pages, row ${row}`).toHaveLength(
          row === metrics.rowCount - 1 && count % 2 === 1 ? 1 : 2,
        );
        seen.push(...shown);
      }
      expect(seen, `${count} pages`).toEqual([...Array(count).keys()]);
    }
  });

  it('shows a document of one page alone and centered, with no partner to wait for', () => {
    const viewport = { width: 1600, height: 900 };
    const layout = layoutOf(pages(1), 'spread', { current: 0, viewport });
    expect(layout.isEmpty).toBe(false);
    expect(layout.box(0)).toMatchObject({
      index: 0,
      width: px(612),
      height: px(792),
    });
    expect((layout.box(0)?.left ?? 0) + px(612) / 2).toBeCloseTo(800);
    expect(layout.box(1)).toBeNull();
    expect(layout.pagesIn(0, 100)).toEqual({ first: 0, last: 0 });
    expect(layout.currentPageAt(0, 900)).toBe(0);
    expect(pageWindow(layout, 0, 900)).toEqual({ visible: [0], near: [] });
    // Nothing to prefetch on either side, and no pair in the metrics.
    expect(adjacentPages(layout)).toEqual([]);
    expect(buildMetrics(pages(1), 'spread')).toMatchObject({
      rowCount: 1,
      widestPairPt: 0,
      widestSinglePt: 612,
    });
    // A current page that is out of range still shows the only page there is.
    expect(layoutOf(pages(1), 'spread', { current: 7 }).box(0)).not.toBeNull();
    expect(layoutOf(pages(1), 'spread', { current: -1 }).box(0)).not.toBeNull();
  });

  it('a document of two pages is one full row, with nothing before or after it', () => {
    const layout = layoutOf(pages(2), 'spread', {
      current: 1,
      viewport: { width: 2400, height: 1200 },
    });
    expect(layout.firstRow).toBe(0);
    expect(layout.box(0)).not.toBeNull();
    expect(layout.box(1)).not.toBeNull();
    expect(adjacentPages(layout)).toEqual([]);
    expect(layout.currentPageAt(0, 1200)).toBe(0);
  });

  it('names the first page of the row as the current one, also for the lone last page of an odd count', () => {
    for (const count of [3, 5, 7]) {
      const last = count - 1;
      const layout = layoutOf(pages(count), 'spread', { current: last });
      expect(layout.currentPageAt(0, VIEWPORT.height)).toBe(last);
    }
    // A pair is named by its left page whichever of the two is current.
    expect(layoutOf(pages(5), 'spread', { current: 3 }).currentPageAt(0, VIEWPORT.height)).toBe(2);
  });

  it('prefetches the lone last page and the pair before it, and nothing past the ends', () => {
    expect(adjacentPages(layoutOf(pages(5), 'spread', { current: 2 }))).toEqual([0, 1, 4]);
    expect(adjacentPages(layoutOf(pages(5), 'spread', { current: 0 }))).toEqual([2, 3]);
    expect(adjacentPages(layoutOf(pages(5), 'spread', { current: 4 }))).toEqual([2, 3]);
  });

  it('is fitted on its own width when it is alone, and as wide as both pages and the gap when it is a pair', () => {
    const one = buildMetrics(pages(1), 'spread');
    const single = buildMetrics(pages(1), 'single');
    const viewport = { width: 816 + FIT_SCROLLBAR_PX, height: 1056 };
    expect(fitZoomFor('width', one, 0, viewport, GAP)).toBeCloseTo(1);
    expect(fitZoomFor('width', one, 0, viewport, GAP)).toBe(fitZoomFor('width', single, 0, viewport, GAP));
    expect(fitZoomFor('page', one, 0, viewport, GAP)).toBe(fitZoomFor('page', single, 0, viewport, GAP));
    // The same viewport holds a pair at a little under half that zoom: two pages and the gap share its width.
    const pair = fitZoomFor('width', buildMetrics(pages(2), 'spread'), 0, viewport, GAP) ?? 0;
    expect(pair).toBeCloseTo((816 - GAP) / (2 * 816));
  });
});

describe('fit width and fit page follow the size of the viewport', () => {
  const mixed = [LETTER, LANDSCAPE, LETTER, LETTER];

  it('width: the zoom is the width that is left after the scrollbar allowance over the width of the row, in every mode', () => {
    for (const mode of ['continuous', 'single', 'spread'] as const) {
      const metrics = buildMetrics(mixed, mode);
      const rowPt = metrics.rowWidthPt[0] ?? 0;
      const gap = mode === 'spread' ? GAP : 0;
      for (const width of [500, 640, 800, 1000, 1280, 1600, 1920]) {
        const zoom = fitZoomFor('width', metrics, 0, { width, height: 900 }, GAP);
        const wanted = (width - gap - FIT_SCROLLBAR_PX) / (rowPt * CSS_PX_PER_PT);
        expect(zoom, `${mode} at ${width}`).toBeCloseTo(floorFit(wanted), 9);
      }
    }
  });

  it('page: the width decides in a narrow window and the height in a wide one, and the change is continuous at the crossover', () => {
    const metrics = buildMetrics([LETTER], 'continuous');
    const height = 800;
    const zoom = height / (792 * CSS_PX_PER_PT);
    const crossover = 612 * CSS_PX_PER_PT * zoom;
    expect(fitZoomFor('page', metrics, 0, { width: crossover - 40, height }, GAP) ?? 0).toBeLessThan(zoom);
    expect(fitZoomFor('page', metrics, 0, { width: crossover, height }, GAP)).toBeCloseTo(zoom, 2);
    expect(fitZoomFor('page', metrics, 0, { width: crossover + 400, height }, GAP)).toBeCloseTo(zoom, 2);
    expect(fitZoomFor('page', metrics, 0, { width: 100_000, height }, GAP)).toBeCloseTo(zoom, 2);
  });

  it('is made again, not kept, when the window is resized to nothing and back', () => {
    const metrics = buildMetrics(mixed, 'continuous');
    const big = fitZoomFor('width', metrics, 0, { width: 1200, height: 800 }, GAP);
    expect(fitZoomFor('width', metrics, 0, { width: 0, height: 0 }, GAP)).toBeNull();
    expect(fitZoomFor('width', metrics, 0, { width: 1200, height: 800 }, GAP)).toBe(big);
  });
});

describe('the point under the pointer stays within 1 px when the browser rounds the scroll position', () => {
  const mixed = [LETTER, LANDSCAPE, A5, LETTER, LETTER, LANDSCAPE, A5, LETTER];

  it('for zooms between the smallest and the largest, in all three modes', () => {
    let seed = 23;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    const randomZoom = () => MIN_ZOOM + random() * (MAX_ZOOM - MIN_ZOOM);
    let checked = 0;
    for (let trial = 0; trial < 600; trial += 1) {
      const mode: ScrollMode = (['continuous', 'single', 'spread'] as const)[trial % 3] ?? 'continuous';
      // Every few trials the zoom jumps from one end of the range to the other.
      let [from, to] = [randomZoom(), randomZoom()];
      if (trial % 10 === 0) [from, to] = [MIN_ZOOM, MAX_ZOOM];
      if (trial % 10 === 5) [from, to] = [MAX_ZOOM, MIN_ZOOM];
      const viewport = {
        width: 320 + Math.floor(random() * 1500),
        height: 240 + Math.floor(random() * 900),
      };
      const current = Math.floor(random() * mixed.length);
      const before = layoutOf(mixed, mode, { zoom: from, viewport, current });
      const scroll = {
        left: Math.round(random() * Math.max(0, before.width - viewport.width)),
        top: Math.round(random() * Math.max(0, before.height - viewport.height)),
      };
      const x = random() * viewport.width;
      const y = random() * viewport.height;
      const anchor = anchorAt(before, scroll, x, y);
      if (anchor === null) continue;
      const after = layoutOf(mixed, mode, { zoom: to, viewport, current });
      const exact = scrollFor(after, anchor);
      // The DOM stores whole pixels: scrollLeft and scrollTop come back rounded.
      const stored = {
        left: Math.round(exact.left),
        top: Math.round(exact.top),
      };
      const box = after.box(anchor.page);
      const pointX = (box?.left ?? 0) + anchor.xPt * after.scale - stored.left;
      const pointY = (box?.top ?? 0) + anchor.yPt * after.scale - stored.top;
      // Only a position that could be kept is checked: one clamped to the ends of the content cannot hold the point.
      const wantedLeft = (box?.left ?? 0) + anchor.xPt * after.scale - x;
      const wantedTop = (box?.top ?? 0) + anchor.yPt * after.scale - y;
      if (Math.abs(wantedLeft - exact.left) > 1e-6 || Math.abs(wantedTop - exact.top) > 1e-6) continue;
      expect(Math.abs(pointX - x), `x, ${mode} ${from} -> ${to}`).toBeLessThanOrEqual(1);
      expect(Math.abs(pointY - y), `y, ${mode} ${from} -> ${to}`).toBeLessThanOrEqual(1);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(100);
  });

  it('at the limits of the zoom range, for points at the corners and the middle of the viewport', () => {
    const long = pages(50);
    for (const [from, to] of [
      [MIN_ZOOM, MAX_ZOOM],
      [MAX_ZOOM, MIN_ZOOM],
      [1, MAX_ZOOM],
      [1, MIN_ZOOM],
    ] as const) {
      for (const [x, y] of [
        [1, 1],
        [VIEWPORT.width - 1, VIEWPORT.height - 1],
        [VIEWPORT.width / 2, VIEWPORT.height / 2],
      ] as const) {
        const before = layoutOf(long, 'continuous', { zoom: from });
        const scroll = {
          left: Math.round(Math.max(0, before.width - VIEWPORT.width) / 2),
          top: Math.round(before.height / 3),
        };
        const anchor = anchorAt(before, scroll, x, y);
        expect(anchor).not.toBeNull();
        if (anchor === null) continue;
        const after = layoutOf(long, 'continuous', { zoom: to });
        const exact = scrollFor(after, anchor);
        const box = after.box(anchor.page);
        const wantedTop = (box?.top ?? 0) + anchor.yPt * after.scale - y;
        // Far from the ends of a 50 page document, the vertical position can always be kept.
        expect(Math.abs(wantedTop - exact.top)).toBeLessThan(1e-6);
        expect(Math.abs((box?.top ?? 0) + anchor.yPt * after.scale - Math.round(exact.top) - y)).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('centredScrollLeft', () => {
  it('centres overflowing content and is 0 without overflow', () => {
    expect(centredScrollLeft(1000, 600)).toBe(200);
    expect(centredScrollLeft(500, 600)).toBe(0);
  });
});
