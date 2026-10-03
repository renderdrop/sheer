import type { PageSize } from '../../api/render';
import { CSS_PX_PER_PT, fitPageZoom, fitWidthZoom } from '../../lib/zoom';

/**
 * The geometry of the scrolling canvas (ADR-002 §5). Pure functions and classes, no DOM, no React: what is where for a zoom, a
 * viewport and a scroll mode, which pages are close enough to the viewport to be mounted, and how a zoom or a change of mode
 * keeps the point the user is looking at where it is.
 *
 * **Coordinates.** A page is `widthPt x heightPt` points; one point is `CSS_PX_PER_PT * zoom` CSS pixels. The *content* is the
 * box inside the scroll region that holds the pages; its origin is the top left of the scroll region's content box (inside the
 * padding), so `scrollTop` is the content y at the top of the viewport. Pages sit between `gap` pixels of space; the content is
 * never smaller than the viewport, and what is smaller than it is centered in it.
 *
 * **Modes.** `continuous` stacks every page in one column. `single` and `spread` are paged: the content is one *row*, a single
 * page or (spread) a pair of pages side by side, the one the current page is in; going to another page shows another row. Rows
 * are the unit throughout: continuous mode has a row per page, spread mode a row per two pages (0 and 1, 2 and 3, ...).
 */

export const SCROLL_MODES = ['continuous', 'single', 'spread'] as const;
export type ScrollMode = (typeof SCROLL_MODES)[number];
export const DEFAULT_SCROLL_MODE: ScrollMode = 'continuous';

/** The most pages mounted at once, visible and near together (ADR-002 §5). */
export const MAX_MOUNTED_PAGES = 24;

/** A size in CSS pixels. */
export interface Viewport {
  width: number;
  height: number;
}

/** Where a page sits in the content, in CSS pixels. */
export interface PageBox {
  index: number;
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Whether `mode` shows one row at a time. */
export function isPaged(mode: ScrollMode): boolean {
  return mode !== 'continuous';
}

/** How a mode steps through the pages: a spread turns two at a time. */
export function pageStep(mode: ScrollMode): number {
  return mode === 'spread' ? 2 : 1;
}

/**
 * What a document's page sizes say about its layout in one mode, independent of zoom and viewport: for each row its height, its
 * width and the height of everything above it, all in points. Built once per document and mode (`metricsFor`).
 */
export interface Metrics {
  readonly mode: ScrollMode;
  readonly pageCount: number;
  readonly sizes: readonly PageSize[];
  /** Pages per row: 2 in `spread`, else 1. */
  readonly perRow: 1 | 2;
  readonly rowCount: number;
  /** Height of each row (its tallest page), in points. */
  readonly rowHeightPt: Float64Array;
  /** Width of each row (the sum of its pages), in points. */
  readonly rowWidthPt: Float64Array;
  /** `rowTopPt[r]` is the height of the rows above row `r`; one entry more than there are rows, the last being the total. */
  readonly rowTopPt: Float64Array;
  /** The widest row of one page, and the widest of two (0 if there is none), in points. */
  readonly widestSinglePt: number;
  readonly widestPairPt: number;
}

export function buildMetrics(sizes: readonly PageSize[], mode: ScrollMode): Metrics {
  const perRow = mode === 'spread' ? 2 : 1;
  const pageCount = sizes.length;
  const rowCount = Math.ceil(pageCount / perRow);
  const rowHeightPt = new Float64Array(rowCount);
  const rowWidthPt = new Float64Array(rowCount);
  const rowTopPt = new Float64Array(rowCount + 1);
  let widestSinglePt = 0;
  let widestPairPt = 0;
  for (let row = 0; row < rowCount; row += 1) {
    let width = 0;
    let height = 0;
    const first = row * perRow;
    const last = Math.min(pageCount, first + perRow);
    for (let page = first; page < last; page += 1) {
      const size = sizes[page];
      width += size?.[0] ?? 0;
      height = Math.max(height, size?.[1] ?? 0);
    }
    rowWidthPt[row] = width;
    rowHeightPt[row] = height;
    rowTopPt[row + 1] = (rowTopPt[row] ?? 0) + height;
    if (last - first === 2) widestPairPt = Math.max(widestPairPt, width);
    else widestSinglePt = Math.max(widestSinglePt, width);
  }
  return { mode, pageCount, sizes, perRow, rowCount, rowHeightPt, rowWidthPt, rowTopPt, widestSinglePt, widestPairPt };
}

const metricsCache = new WeakMap<readonly PageSize[], Map<ScrollMode, Metrics>>();

/** `buildMetrics`, remembered per list of sizes (which is never edited, only replaced) and mode. */
export function metricsFor(sizes: readonly PageSize[], mode: ScrollMode): Metrics {
  let byMode = metricsCache.get(sizes);
  if (byMode === undefined) {
    byMode = new Map();
    metricsCache.set(sizes, byMode);
  }
  let metrics = byMode.get(mode);
  if (metrics === undefined) {
    metrics = buildMetrics(sizes, mode);
    byMode.set(mode, metrics);
  }
  return metrics;
}

/** The row page `page` is in. */
export function rowOfPage(metrics: Metrics, page: number): number {
  return Math.floor(page / metrics.perRow);
}

/** The pages of a row, first to last inclusive. */
function pagesOfRow(metrics: Metrics, row: number): { first: number; last: number } {
  const first = row * metrics.perRow;
  return { first, last: Math.min(metrics.pageCount, first + metrics.perRow) - 1 };
}

export interface LayoutInput {
  /** 1 = 100 %. */
  zoom: number;
  /** Space between pages and between the two pages of a spread, in px. */
  gap: number;
  /** The scroll region's content box: what the content is at least as large as. */
  viewport: Viewport;
  /** The current page. Only paged modes look at it: it decides which row is shown. */
  current: number;
}

const finite = (value: number, fallback: number) => (Number.isFinite(value) ? value : fallback);

/**
 * The layout of a document at one zoom in one viewport: the size of the content, and the box of every page that is in it
 * (all of them in continuous mode, the pages of the current row in the paged modes). Immutable; a zoom, a resize or a change of
 * mode makes a new one, which is cheap: nothing here visits every page except through the binary searches.
 */
export class PageLayout {
  /** CSS pixels per point at this zoom. */
  readonly scale: number;
  readonly gap: number;
  readonly viewport: Viewport;
  /** The size of the content in px, never smaller than the viewport. */
  readonly width: number;
  readonly height: number;
  /** The rows that are in the layout, `lastRow < firstRow` if there is none. */
  readonly firstRow: number;
  readonly lastRow: number;
  /** Space above the first row, which centers content that is shorter than the viewport. */
  private readonly offsetY: number;
  private readonly paged: boolean;

  constructor(
    readonly metrics: Metrics,
    input: LayoutInput,
  ) {
    this.scale = Math.max(1e-6, finite(input.zoom, 1)) * CSS_PX_PER_PT;
    this.gap = Math.max(0, finite(input.gap, 0));
    this.viewport = { width: Math.max(0, input.viewport.width), height: Math.max(0, input.viewport.height) };
    this.paged = isPaged(metrics.mode);
    const rows = metrics.rowCount;
    if (rows === 0) {
      this.firstRow = 0;
      this.lastRow = -1;
    } else if (this.paged) {
      const row = rowOfPage(
        metrics,
        Math.min(Math.max(0, Math.trunc(finite(input.current, 0))), metrics.pageCount - 1),
      );
      this.firstRow = row;
      this.lastRow = row;
    } else {
      this.firstRow = 0;
      this.lastRow = rows - 1;
    }
    let contentWidth = 0;
    let contentHeight = 0;
    if (rows > 0) {
      if (this.paged) {
        contentWidth = this.rowWidth(this.firstRow);
        contentHeight = this.rowHeight(this.firstRow);
      } else {
        contentWidth = metrics.widestSinglePt * this.scale;
        contentHeight = (metrics.rowTopPt[rows] ?? 0) * this.scale + (rows - 1) * this.gap;
      }
    }
    this.width = Math.max(contentWidth, this.viewport.width);
    this.height = Math.max(contentHeight, this.viewport.height);
    this.offsetY = (this.height - contentHeight) / 2;
  }

  get pageCount(): number {
    return this.metrics.pageCount;
  }

  /** Whether any page is in the layout. */
  get isEmpty(): boolean {
    return this.lastRow < this.firstRow;
  }

  private rowHeight(row: number): number {
    return (this.metrics.rowHeightPt[row] ?? 0) * this.scale;
  }

  private rowWidth(row: number): number {
    const { first, last } = pagesOfRow(this.metrics, row);
    return (this.metrics.rowWidthPt[row] ?? 0) * this.scale + (last > first ? this.gap : 0);
  }

  private rowTop(row: number): number {
    if (this.paged) return this.offsetY;
    return this.offsetY + (this.metrics.rowTopPt[row] ?? 0) * this.scale + row * this.gap;
  }

  /** The top and bottom of a row in the content. */
  rowBounds(row: number): { top: number; bottom: number } {
    const top = this.rowTop(row);
    return { top, bottom: top + this.rowHeight(row) };
  }

  /** The row that `page` is in, whether or not it is in the layout. */
  rowOf(page: number): number {
    return rowOfPage(this.metrics, page);
  }

  /** The box of a page, or `null` if it is not in the layout (a paged mode shows one row). */
  box(page: number): PageBox | null {
    if (!Number.isInteger(page) || page < 0 || page >= this.metrics.pageCount) return null;
    const row = this.rowOf(page);
    if (row < this.firstRow || row > this.lastRow) return null;
    const rowLeft = (this.width - this.rowWidth(row)) / 2;
    const { top: rowTop } = this.rowBounds(row);
    const rowHeight = this.rowHeight(row);
    const { first } = pagesOfRow(this.metrics, row);
    let left = rowLeft;
    for (let at = first; at < page; at += 1) left += (this.metrics.sizes[at]?.[0] ?? 0) * this.scale + this.gap;
    const [widthPt, heightPt] = this.metrics.sizes[page] ?? [0, 0];
    const width = widthPt * this.scale;
    const height = heightPt * this.scale;
    return { index: page, left, top: rowTop + (rowHeight - height) / 2, width, height };
  }

  /** The first row of the layout whose bottom is below `y` (`lastRow + 1` if there is none). */
  private firstRowEndingAfter(y: number): number {
    let low = this.firstRow;
    let high = this.lastRow + 1;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (this.rowBounds(middle).bottom > y) high = middle;
      else low = middle + 1;
    }
    return low;
  }

  /** The rows that meet `[top, bottom)` of the content, first to last inclusive; `null` if none does. */
  rowsIn(top: number, bottom: number): { first: number; last: number } | null {
    if (this.isEmpty || !(bottom > top)) return null;
    const first = this.firstRowEndingAfter(top);
    // Rows are in order, so the ones that start before `bottom` end where the first row starting at or after it begins.
    let low = first;
    let high = this.lastRow + 1;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (this.rowBounds(middle).top < bottom) low = middle + 1;
      else high = middle;
    }
    const last = low - 1;
    return last >= first ? { first, last } : null;
  }

  /** The pages (first to last inclusive) in the rows that meet `[top, bottom)` of the content; `null` if there are none. */
  pagesIn(top: number, bottom: number): { first: number; last: number } | null {
    const rows = this.rowsIn(top, bottom);
    if (rows === null) return null;
    return { first: pagesOfRow(this.metrics, rows.first).first, last: pagesOfRow(this.metrics, rows.last).last };
  }

  /** The row of the layout nearest to content position `y` (the one it is in, or the closer of the two it is between). */
  rowAt(y: number): number {
    if (this.isEmpty) return 0;
    const row = Math.min(this.firstRowEndingAfter(y), this.lastRow);
    if (row > this.firstRow && y < this.rowBounds(row).top) {
      const before = y - this.rowBounds(row - 1).bottom;
      const after = this.rowBounds(row).top - y;
      return before <= after ? row - 1 : row;
    }
    return row;
  }

  /**
   * The page the status bar shows for the viewport at `scrollTop`: the first page of the row that most of the viewport is
   * on (the lower one when two share it equally), the way a reader names where they are. In a paged mode the row that is shown.
   */
  currentPageAt(scrollTop: number, viewportHeight: number): number {
    if (this.isEmpty) return 0;
    if (this.paged) return pagesOfRow(this.metrics, this.firstRow).first;
    const rows = this.rowsIn(scrollTop, scrollTop + Math.max(1, viewportHeight));
    if (rows === null) return pagesOfRow(this.metrics, this.rowAt(scrollTop + viewportHeight / 2)).first;
    let bestRow = rows.first;
    let bestShare = -1;
    for (let row = rows.first; row <= rows.last; row += 1) {
      const { top, bottom } = this.rowBounds(row);
      const share = Math.min(bottom, scrollTop + viewportHeight) - Math.max(top, scrollTop);
      if (share > bestShare) {
        bestShare = share;
        bestRow = row;
      }
    }
    return pagesOfRow(this.metrics, bestRow).first;
  }
}

/** Which pages of the viewport's neighbourhood to mount, as page indices in ascending order. */
export interface PageWindow {
  /** The pages that meet the viewport. */
  visible: readonly number[];
  /** The pages within a viewport's height above and below it, nearest first as far as the mount limit allows. */
  near: readonly number[];
}

export const EMPTY_WINDOW: PageWindow = { visible: [], near: [] };

function range(first: number, last: number): number[] {
  return Array.from({ length: last - first + 1 }, (_, offset) => first + offset);
}

/**
 * The pages to mount for a viewport at `scrollTop` (ADR-002 §5): those that meet it, and those within one viewport height above
 * and below it, at most `MAX_MOUNTED_PAGES` together. If the visible ones are more than that (a page smaller than a thumbnail
 * at a tiny zoom) the first of them are taken. Paged modes mount the shown row and nothing around it: the rows next to it are
 * only prefetched (`adjacentPages`).
 */
export function pageWindow(layout: PageLayout, scrollTop: number, viewportHeight: number): PageWindow {
  const height = Math.max(1, viewportHeight);
  const inView = layout.pagesIn(scrollTop, scrollTop + height);
  if (inView === null) return EMPTY_WINDOW;
  const visible = range(inView.first, Math.min(inView.last, inView.first + MAX_MOUNTED_PAGES - 1));
  const room = MAX_MOUNTED_PAGES - visible.length;
  const around = layout.pagesIn(scrollTop - height, scrollTop + 2 * height);
  if (room <= 0 || around === null) return { visible, near: [] };
  const above = range(around.first, inView.first - 1).reverse();
  const below = inView.last < around.last ? range(inView.last + 1, around.last) : [];
  // Nearest first, alternating above and below, until the limit.
  const near: number[] = [];
  for (let step = 0; near.length < room && (step < above.length || step < below.length); step += 1) {
    const before = above[step];
    if (before !== undefined && near.length < room) near.push(before);
    const after = below[step];
    if (after !== undefined && near.length < room) near.push(after);
  }
  return { visible, near: near.sort((a, b) => a - b) };
}

/** The pages of the rows next to the shown one in a paged mode, to render ahead of a turn of the page. Empty in continuous mode. */
export function adjacentPages(layout: PageLayout): number[] {
  const { metrics } = layout;
  if (!isPaged(metrics.mode) || layout.isEmpty) return [];
  const pages: number[] = [];
  for (const row of [layout.firstRow - 1, layout.firstRow + 1]) {
    if (row < 0 || row >= metrics.rowCount) continue;
    const { first, last } = pagesOfRow(metrics, row);
    pages.push(...range(first, last));
  }
  return pages;
}

/**
 * A point of the document and where it is to appear in the viewport: the page it is on, its offset from that page's top left in
 * points (outside the page when the point is in the gap beside it), and its offset from the viewport's top left in px.
 * A zoom, a change of mode and a jump to a page all say "put this point there" and let the canvas do it once it has laid itself out.
 */
export interface ScrollAnchor {
  page: number;
  xPt: number;
  yPt: number;
  viewX: number;
  viewY: number;
}

/** The scroll position of a scroll region. */
export interface ScrollPosition {
  left: number;
  top: number;
}

/**
 * The anchor for the document point at viewport position (`viewX`, `viewY`) when the region is scrolled to `scroll`, in
 * `layout`. `null` if the layout has no pages.
 */
export function anchorAt(
  layout: PageLayout,
  scroll: ScrollPosition,
  viewX: number,
  viewY: number,
): ScrollAnchor | null {
  if (layout.isEmpty) return null;
  const x = scroll.left + viewX;
  const y = scroll.top + viewY;
  const row = layout.rowAt(y);
  const { first, last } = pagesOfRow(layout.metrics, row);
  let nearest: PageBox | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (let page = first; page <= last; page += 1) {
    const box = layout.box(page);
    if (box === null) continue;
    const distance = x < box.left ? box.left - x : x > box.left + box.width ? x - box.left - box.width : 0;
    if (distance < nearestDistance) {
      nearest = box;
      nearestDistance = distance;
    }
  }
  if (nearest === null) return null;
  return {
    page: nearest.index,
    xPt: (x - nearest.left) / layout.scale,
    yPt: (y - nearest.top) / layout.scale,
    viewX,
    viewY,
  };
}

/** Where the region has to be scrolled for `anchor` to appear where it says, in `layout`; kept inside what can be scrolled. */
export function scrollFor(layout: PageLayout, anchor: ScrollAnchor): ScrollPosition {
  const box = layout.box(anchor.page);
  if (box === null) return { left: 0, top: 0 };
  const left = box.left + anchor.xPt * layout.scale - anchor.viewX;
  const top = box.top + anchor.yPt * layout.scale - anchor.viewY;
  return {
    left: Math.min(Math.max(0, layout.width - layout.viewport.width), Math.max(0, left)),
    top: Math.min(Math.max(0, layout.height - layout.viewport.height), Math.max(0, top)),
  };
}

/** The scroll position that shows the middle of content wider than the viewport, from its top: where a page is first shown. */
export function centeredScroll(layout: PageLayout): ScrollPosition {
  return { left: Math.max(0, (layout.width - layout.viewport.width) / 2), top: 0 };
}

/**
 * The anchor that puts the top of `page` at the top of the viewport, keeping the horizontal scroll as it is: what going to a page
 * does. `null` if `page` is not in the layout.
 */
export function pageTopAnchor(layout: PageLayout, page: number, scroll: ScrollPosition): ScrollAnchor | null {
  const box = layout.box(page);
  if (box === null) return null;
  return { page, xPt: (scroll.left - box.left) / layout.scale, yPt: 0, viewX: 0, viewY: 0 };
}

/**
 * The zoom at which the page the user is on fits the viewport's width, or (`page`) the viewport whole; for a spread the two pages
 * and the gap between them. `null` until the viewport has a size.
 */
export function fitZoomFor(
  fit: 'width' | 'page',
  metrics: Metrics,
  current: number,
  viewport: Viewport,
  gap: number,
): number | null {
  if (metrics.rowCount === 0) return null;
  const row = rowOfPage(metrics, Math.min(Math.max(0, current), metrics.pageCount - 1));
  const { first, last } = pagesOfRow(metrics, row);
  const widthPt = metrics.rowWidthPt[row] ?? 0;
  const heightPt = metrics.rowHeightPt[row] ?? 0;
  const width = viewport.width - (last > first ? gap : 0);
  return fit === 'width' ? fitWidthZoom(width, widthPt) : fitPageZoom(width, viewport.height, widthPt, heightPt);
}
