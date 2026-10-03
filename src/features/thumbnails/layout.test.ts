import { describe, expect, it } from 'vitest';

import type { PageSize } from '../../api/render';
import {
  MAX_THUMBNAIL_ASPECT,
  ThumbnailLayout,
  buildThumbnailMetrics,
  thumbnailMetricsFor,
  type ThumbnailSpacing,
} from './layout';

const SPACING: ThumbnailSpacing = { pad: 4, labelGap: 4, labelHeight: 16, gap: 4 };
/** Everything in a cell that is not the thumbnail: 4 + 4 + 16 + 4. */
const CHROME = 28;
const LETTER: PageSize = [612, 792];

const pages = (count: number, size: PageSize = LETTER): PageSize[] => Array.from({ length: count }, () => size);
const layoutOf = (sizes: readonly PageSize[], width = 200) =>
  new ThumbnailLayout(thumbnailMetricsFor(sizes), width, SPACING);

describe('the metrics', () => {
  it('hold the aspect of every page and the running sum of the aspects the layout stacks', () => {
    const metrics = buildThumbnailMetrics([LETTER, [792, 612], [100, 100]]);
    expect(metrics.count).toBe(3);
    expect([...metrics.aspect]).toEqual([792 / 612, 612 / 792, 1]);
    expect([...metrics.aspectTop]).toEqual([0, 792 / 612, 792 / 612 + 612 / 792, 792 / 612 + 612 / 792 + 1]);
  });

  it('stop a tall page at the maximum aspect in the sum, and keep its own aspect for its width', () => {
    const metrics = buildThumbnailMetrics([[100, 1000], LETTER]);
    expect(metrics.aspect[0]).toBe(10);
    expect(metrics.aspectTop[1]).toBe(MAX_THUMBNAIL_ASPECT);
  });

  it('take US Letter for a size that cannot be one, so a bad page never breaks the arithmetic', () => {
    const metrics = buildThumbnailMetrics([
      [0, 10],
      [Number.NaN, 5],
      [10, -3],
    ]);
    expect([...metrics.aspect]).toEqual([792 / 612, 792 / 612, 792 / 612]);
  });

  it('are made once per list of sizes', () => {
    const sizes = pages(5);
    expect(thumbnailMetricsFor(sizes)).toBe(thumbnailMetricsFor(sizes));
    expect(thumbnailMetricsFor(pages(5))).not.toBe(thumbnailMetricsFor(sizes));
  });
});

describe('the cells', () => {
  it('are as wide as the layout says and as tall as the page is, with a cell around the thumbnail and its number', () => {
    const layout = layoutOf([LETTER, [792, 612]], 200);
    expect(layout.thumbnailSize(0)).toEqual({ width: 200, height: (200 * 792) / 612 });
    expect(layout.thumbnailSize(1)).toEqual({ width: 200, height: (200 * 612) / 792 });
    expect(layout.cellHeight(0)).toBeCloseTo((200 * 792) / 612 + CHROME);
    expect(layout.cellHeight(1)).toBeCloseTo((200 * 612) / 792 + CHROME);
  });

  it('stack with a gap, and the whole list is as tall as the cells and the gaps between them', () => {
    const layout = layoutOf(pages(3), 200);
    const cell = layout.cellHeight(0);
    expect(layout.top(0)).toBe(0);
    expect(layout.top(1)).toBeCloseTo(cell + SPACING.gap);
    expect(layout.top(2)).toBeCloseTo(2 * (cell + SPACING.gap));
    expect(layout.height).toBeCloseTo(3 * cell + 2 * SPACING.gap);
    expect(layout.bottom(2)).toBeCloseTo(layout.height);
  });

  it('follow the width alone: the same page sizes at another width scale the thumbnails and nothing else', () => {
    const sizes = [LETTER, [792, 612] as const, LETTER];
    const narrow = layoutOf(sizes, 100);
    const wide = layoutOf(sizes, 300);
    for (let index = 0; index < 3; index += 1) {
      expect(wide.thumbnailSize(index).height).toBeCloseTo(3 * narrow.thumbnailSize(index).height);
      expect(wide.cellHeight(index) - CHROME).toBeCloseTo(3 * (narrow.cellHeight(index) - CHROME));
    }
    expect(wide.top(2) - 2 * (CHROME + SPACING.gap)).toBeCloseTo(3 * (narrow.top(2) - 2 * (CHROME + SPACING.gap)));
  });

  it('show a page that is too tall at the maximum height and narrower, centered by the cell', () => {
    const layout = layoutOf([[100, 1000], LETTER], 200);
    expect(layout.thumbnailSize(0)).toEqual({ width: 40, height: 400 });
    expect(layout.cellHeight(0)).toBe(400 + CHROME);
    expect(layout.thumbnailSize(1).width).toBe(200);
  });

  it('are empty for a document without pages, and for a width that is not a number', () => {
    const none = layoutOf([], 200);
    expect(none.count).toBe(0);
    expect(none.height).toBe(0);
    expect(none.itemsIn(0, 500)).toBeNull();
    expect(none.indexAt(100)).toBe(0);
    expect(none.reveal(0, 0, 100)).toBeNull();
    expect(none.pageTarget(0, 1, 100)).toBe(0);
    const broken = layoutOf(pages(2), Number.NaN);
    expect(broken.width).toBe(0);
    expect(Number.isFinite(broken.height)).toBe(true);
  });
});

describe('finding cells', () => {
  const layout = layoutOf(pages(100), 200);
  const cell = layout.cellHeight(0);
  const stride = cell + SPACING.gap;

  it('finds the cell at a position: the one that contains it, the one above in a gap, the ends outside', () => {
    expect(layout.indexAt(0)).toBe(0);
    expect(layout.indexAt(cell - 1)).toBe(0);
    expect(layout.indexAt(cell + 1)).toBe(0);
    expect(layout.indexAt(stride)).toBe(1);
    expect(layout.indexAt(37 * stride + 5)).toBe(37);
    expect(layout.indexAt(-50)).toBe(0);
    expect(layout.indexAt(layout.height + 1000)).toBe(99);
  });

  it('lists the cells that meet a range, and none for a range in no cell', () => {
    expect(layout.itemsIn(0, 10)).toEqual({ first: 0, last: 0 });
    expect(layout.itemsIn(0, 3 * stride)).toEqual({ first: 0, last: 2 });
    expect(layout.itemsIn(0, 3 * stride + 1)).toEqual({ first: 0, last: 3 });
    expect(layout.itemsIn(2 * stride + 10, 4 * stride + 10)).toEqual({ first: 2, last: 4 });
    // Exactly at the edges: a range that starts where a cell ends does not meet it, one that ends where a cell starts neither.
    expect(layout.itemsIn(cell, stride)).toBeNull();
    expect(layout.itemsIn(cell + 0.5, stride + 1)).toEqual({ first: 1, last: 1 });
    expect(layout.itemsIn(stride - 3, stride)).toBeNull();
    expect(layout.itemsIn(-100, 5)).toEqual({ first: 0, last: 0 });
    expect(layout.itemsIn(layout.height - 1, layout.height + 500)).toEqual({ first: 99, last: 99 });
    expect(layout.itemsIn(layout.height + 1, layout.height + 500)).toBeNull();
    expect(layout.itemsIn(100, 100)).toBeNull();
    expect(layout.itemsIn(100, 50)).toBeNull();
  });

  it('keeps the place at the top of the viewport through a change of width', () => {
    const sizes = [LETTER, [792, 612] as const, [300, 1400] as const, LETTER, LETTER, [792, 612] as const];
    const narrow = layoutOf(sizes, 120);
    const wide = layoutOf(sizes, 330);
    const y = narrow.top(3) + 0.25 * narrow.cellHeight(3);
    const anchor = narrow.anchorAt(y);
    expect(anchor.index).toBe(3);
    expect(anchor.fraction).toBeCloseTo(0.25);
    expect(narrow.positionOf(anchor)).toBeCloseTo(y);
    const moved = wide.positionOf(anchor);
    expect(moved).toBeCloseTo(wide.top(3) + 0.25 * wide.cellHeight(3));
    expect(wide.indexAt(moved)).toBe(3);
  });

  it('clamps an anchor above the list and a gap between two cells', () => {
    expect(layout.anchorAt(-30)).toEqual({ index: 0, fraction: 0 });
    const inGap = layout.anchorAt(cell + 2);
    expect(inGap.index).toBe(0);
    expect(inGap.fraction).toBe(1);
  });
});

describe('revealing a cell', () => {
  const layout = layoutOf(pages(100), 200);
  const cell = layout.cellHeight(0);
  const stride = cell + SPACING.gap;
  const view = 600;

  it('does nothing for a cell that shows whole', () => {
    expect(layout.reveal(0, 0, view)).toBeNull();
    expect(layout.reveal(1, 0, view)).toBeNull();
    expect(layout.reveal(5, 5 * stride - 10, view)).toBeNull();
  });

  it('brings a cell that is cut off at the bottom in at the bottom edge, leaving the margin', () => {
    // Cell 2 ends below a viewport that starts at 0.
    const target = layout.reveal(2, 0, view, 4);
    expect(target).toBeCloseTo(layout.bottom(2) + 4 - view);
  });

  it('brings a cell that is cut off at the top in at the top edge, leaving the margin', () => {
    const viewTop = layout.top(10) + 30;
    expect(layout.reveal(10, viewTop, view, 4)).toBeCloseTo(layout.top(10) - 4);
  });

  it('brings in a cell that is less than a viewport away at its nearest edge, so a page-by-page follow does not jump', () => {
    const viewTop = 10 * stride;
    const below = layout.reveal(13, viewTop, view, 4);
    expect(below).toBeCloseTo(layout.bottom(13) + 4 - view);
    const above = layout.reveal(8, viewTop, view, 4);
    expect(above).toBeCloseTo(layout.top(8) - 4);
  });

  it('centers a cell that is a viewport or more away', () => {
    const target = layout.reveal(60, 0, view, 4);
    expect(target).toBeCloseTo(layout.top(60) - (view - cell) / 2);
    expect(layout.reveal(60, 0, view, 4)).toBeCloseTo((layout.top(60) + layout.bottom(60) - view) / 2);
  });

  it('shows a cell that is taller than the viewport from its top', () => {
    const tall = layoutOf(pages(5), 600);
    expect(tall.cellHeight(2)).toBeGreaterThan(300);
    expect(tall.reveal(2, 0, 300, 4)).toBeCloseTo(tall.top(2) - 4);
  });

  it('stays inside the list, with the margin the padding of the region leaves', () => {
    expect(layout.reveal(0, 5000, view, 4)).toBe(-4);
    const last = layout.reveal(99, 0, view, 4);
    expect(last).toBeCloseTo(layout.height + 4 - view);
    expect(layout.reveal(99, layout.height + 4 - view, view, 4)).toBeNull();
  });

  it('is nothing for a cell that is not there, or a viewport with no height', () => {
    expect(layout.reveal(-1, 0, view)).toBeNull();
    expect(layout.reveal(100, 0, view)).toBeNull();
    expect(layout.reveal(1.5, 0, view)).toBeNull();
    expect(layout.reveal(50, 0, 0)).toBeNull();
  });
});

describe('page keys', () => {
  const layout = layoutOf(pages(100), 200);
  const stride = layout.cellHeight(0) + SPACING.gap;

  it('move about a viewport on, and always at least one cell', () => {
    expect(layout.pageTarget(0, 1, 3.5 * stride)).toBe(3);
    expect(layout.pageTarget(10, 1, 3.5 * stride)).toBe(13);
    expect(layout.pageTarget(10, -1, 3.5 * stride)).toBe(7);
    expect(layout.pageTarget(10, 1, 5)).toBe(11);
    expect(layout.pageTarget(10, -1, 5)).toBe(9);
    expect(layout.pageTarget(10, 1, 0)).toBe(11);
  });

  it('stop at the ends', () => {
    expect(layout.pageTarget(98, 1, 10 * stride)).toBe(99);
    expect(layout.pageTarget(99, 1, 10 * stride)).toBe(99);
    expect(layout.pageTarget(1, -1, 10 * stride)).toBe(0);
    expect(layout.pageTarget(0, -1, 10 * stride)).toBe(0);
  });
});
